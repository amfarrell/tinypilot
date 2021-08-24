function getCsrfToken(doc = document) {
  return getCsrfTokenElement(doc).getAttribute("content");
}

function getCsrfTokenElement(doc) {
  return doc.querySelector("meta[name='csrf-token']");
}

function setCsrfToken(tokenValue) {
  return getCsrfTokenElement(document).setAttribute("content", tokenValue);
}

class ControllerError extends Error {
  /**
   * @param details string with the original error message.
   * @param code (optional) string with the error code, or `undefined` for
   *             non-application or unknown errors.
   */
  constructor(details, code) {
    super(details);
    this.code = code;
  }
}

/**
 * Adds retry functionality to the Fetch API.
 * If the HTTP request fails due to a stale CSRF token, then refresh the CSRF
 * token and retry the original request once more.
 * @param {string} resource The path to the resource you want to fetch. See the
 *                          Request object constructor for more information.
 * @param {Object} [init] An options object containing any custom settings that
 *                        you want to apply to the request. See the Request
 *                        object constructor for more information.
 * @returns {Promise}
 */
async function fetchWithRetry(resource, init) {
  let response = await fetch(resource, init);
  // Only retry a request when the original request has a CSRF token header.
  // This is to avoid programmers from getting lazy and never including a CSRF
  // token header in their requests.
  let csrfTokenHeader = init?.headers?.["X-CSRFToken"] || null;
  if (!csrfTokenHeader || response.status != 403) {
    return response;
  }

  if (getCsrfToken() !== "_REFRESH_IN_PROGRESS_") {
    // Only obtain a fresh token if there is no refresh in progress currently.
    await refreshCsrfToken();
  } else {
    // Otherwise we wait until the current refresh is done. Obtaining a fresh
    // CSRF token is one round trip to the server that we have to wait out, so
    // we delay the retry to give a bit of time for that to happen.
    await delayWhile(() => getCsrfToken() === "_REFRESH_IN_PROGRESS_", 20)
  }

  init.headers["X-CSRFToken"] = getCsrfToken();
  return fetch(resource, init);
}

/**
 * Periodically checks a predicate and eventually resolves once the condition
 * is false.
 */
async function delayWhile(predicate, intervalMs) {
  return await new Promise(resolve => {
    setTimeout(async () => {
      if (predicate()) {
        await delayWhile(predicate);
      }
      resolve();
    }, intervalMs)
  });
}

/**
 * Processes response from the backend API.
 * @param response An object as returned by `fetch`
 * @returns {Promise<Object>}
 *    Success case: a JSON response with status 2xx. Promise resolves with
 *                  data from response body.
 *    Error case:   anything else, e.g. non-JSON or status 4xx/5xx. Promise
 *                  rejects with a `ControllerError`.
 *
 */
async function processJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const status = `${response.status} ${response.statusText}`;
    const bodyText = await response.text();
    throw new ControllerError(
      "Malformed API response, content type must be JSON.\n" +
        `Response status: ${status}\n\n${bodyText}`
    );
  }

  let jsonBody;
  try {
    jsonBody = await response.json();
  } catch (jsonParseError) {
    throw new ControllerError(
      "Malformed API response, JSON body cannot be parsed.\n" + jsonParseError
    );
  }

  // Resolve on 2xx response:
  if (response.status >= 200 && response.status < 300) {
    return jsonBody;
  }
  // Reject otherwise:
  throw new ControllerError(
    jsonBody.message || "Unknown error: " + JSON.stringify(jsonBody),
    jsonBody.code
  );
}

export async function refreshCsrfToken() {
  setCsrfToken("_REFRESH_IN_PROGRESS_"); // “Lock” token refresh
  return fetch("/")
    .then(function (response) {
      return response.text();
    })
    .then(function (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const csrfToken = getCsrfToken(doc);
      setCsrfToken(csrfToken);
      return Promise.resolve();
    })
    .catch(function (error) {
      setCsrfToken(""); // Release “lock”
      return Promise.reject("Failed to refresh CSRF token: " + error);
    });
}

export async function getLatestRelease() {
  let route = "/api/latestRelease";
  return fetch(route, {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((versionResponse) => {
      if (!versionResponse.hasOwnProperty("version")) {
        throw new ControllerError("Missing expected version field");
      }
      return versionResponse.version;
    });
}

export async function getVersion() {
  let route = "/api/version";
  return fetch(route, {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((versionResponse) => {
      if (!versionResponse.hasOwnProperty("version")) {
        throw new ControllerError("Missing expected version field");
      }
      return versionResponse.version;
    });
}

export async function shutdown(restart) {
  let route = "/api/shutdown";
  if (restart) {
    route = "/api/restart";
  }
  return fetchWithRetry(route, {
    method: "POST",
    headers: {
      "X-CSRFToken": getCsrfToken(),
    },
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then((httpResponse) => {
      // A 502 usually means that nginx shutdown before it could process the
      // response. Treat this as success.
      if (httpResponse.status === 502) {
        return;
      }
      return processJsonResponse(httpResponse);
    })
    .catch((error) => {
      // Depending on timing, the server may not respond to the shutdown
      // request because it's shutting down. If we get a NetworkError, assume
      // the shutdown succeeded.
      if (error.message.indexOf("NetworkError") >= 0) {
        return;
      }
      throw error;
    });
}

export async function update() {
  let route = "/api/update";
  return fetchWithRetry(route, {
    method: "PUT",
    headers: {
      "X-CSRFToken": getCsrfToken(),
    },
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  }).then(processJsonResponse);
}

export async function getUpdateStatus() {
  let route = "/api/update";
  return fetch(route, {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("status")) {
        throw new ControllerError("Missing expected status field");
      }
      if (!data.hasOwnProperty("updateError")) {
        throw new ControllerError("Missing expected updateError field");
      }
      return { status: data.status, updateError: data.updateError };
    });
}

export async function determineHostname() {
  const route = "/api/hostname";
  return fetch(route, {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((hostnameResponse) => {
      if (!hostnameResponse.hasOwnProperty("hostname")) {
        throw new ControllerError("Missing expected hostname field");
      }
      return hostnameResponse.hostname;
    });
}

export async function changeHostname(newHostname) {
  const route = "/api/hostname";
  return fetchWithRetry(route, {
    method: "PUT",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCsrfToken(),
    },
    body: JSON.stringify({ hostname: newHostname }),
  })
    .then(processJsonResponse)
    .then(() => newHostname);
}

export async function checkStatus(baseURL = "") {
  const route = "/api/status";
  return fetch(baseURL + route, {
    method: "GET",
    mode: "cors",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then(() => true);
}

export async function getDebugLogs() {
  return fetch("/api/debugLogs", {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then((response) => {
      if (!response.ok) {
        throw new ControllerError(response.statusText);
      }
      return response;
    })
    .then((response) => response.text());
}

export async function textToShareableUrl(text) {
  const baseUrl = "https://logs.tinypilotkvm.com";
  return fetch(baseUrl + "/", {
    method: "PUT",
    mode: "cors",
    cache: "no-cache",
    redirect: "error",
    body: text,
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("id")) {
        throw new ControllerError("Missing expected id field");
      }
      return data;
    })
    .then((data) => baseUrl + `/${data.id}`);
}

export async function getVideoFps() {
  return fetch("/api/settings/video/fps", {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("videoFps")) {
        throw new ControllerError("Missing expected videoFps field");
      }
      return data.videoFps;
    });
}

export async function setVideoFps(videoFps) {
  return fetchWithRetry("/api/settings/video/fps", {
    method: "PUT",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCsrfToken(),
    },
    body: JSON.stringify({ videoFps }),
  }).then(processJsonResponse);
}

export async function getDefaultVideoFps() {
  return fetch("/api/settings/video/fps/default", {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("videoFps")) {
        throw new ControllerError("Missing expected videoFps field");
      }
      return data.videoFps;
    });
}

export async function getVideoJpegQuality() {
  return fetch("/api/settings/video/jpeg_quality", {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("videoJpegQuality")) {
        throw new ControllerError("Missing expected videoJpegQuality field");
      }
      return data.videoJpegQuality;
    });
}

export async function setVideoJpegQuality(videoJpegQuality) {
  return fetchWithRetry("/api/settings/video/jpeg_quality", {
    method: "PUT",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-CSRFToken": getCsrfToken(),
    },
    body: JSON.stringify({ videoJpegQuality }),
  }).then(processJsonResponse);
}

export async function getDefaultVideoJpegQuality() {
  return fetch("/api/settings/video/jpeg_quality/default", {
    method: "GET",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
  })
    .then(processJsonResponse)
    .then((data) => {
      if (!data.hasOwnProperty("videoJpegQuality")) {
        throw new ControllerError("Missing expected videoJpegQuality field");
      }
      return data.videoJpegQuality;
    });
}

export async function applyVideoSettings() {
  return fetchWithRetry("/api/settings/video/apply", {
    method: "POST",
    mode: "same-origin",
    cache: "no-cache",
    redirect: "error",
    headers: {
      "X-CSRFToken": getCsrfToken(),
    },
  }).then(processJsonResponse);
}
