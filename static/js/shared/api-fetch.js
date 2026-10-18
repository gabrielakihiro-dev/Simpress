// @ts-check
/**
 * Single JSON request helper for the features: reads the body tolerating empty or non-JSON
 * responses and turns FastAPI `detail` (text or Pydantic 422 list) into a readable Error.
 *
 * @typedef {RequestInit & { errorMessage?: string, responseType?: "json" | "response" }} ApiFetchOptions
 * @typedef {Error & { status?: number, detail?: unknown, data?: unknown }} ApiFetchError
 */

(function (root, factory) {
  // @ts-ignore Node supplies these wrapper variables for the CommonJS test path.
  const isCommonJs = typeof module === "object" && module.exports;
  // @ts-ignore require only exists on the CommonJS test path.
  const api = factory(root, isCommonJs ? require("./api-errors.js") : null);
  // @ts-ignore Node supplies this wrapper variable for the CommonJS test path.
  if (isCommonJs) module.exports = api;
  else root.SimpressApiFetch = api;
})(typeof window !== "undefined" ? window : globalThis, function createApiFetch(root, bundledApiErrors) {
  "use strict";

  const DEFAULT_ERROR_MESSAGE = "Não foi possível concluir a solicitação.";

  /** @param {unknown} detail @param {string} fallback */
  function formatDetail(detail, fallback) {
    const apiErrors = bundledApiErrors || /** @type {any} */ (root).SimpressApiErrors;
    return apiErrors.format(detail, fallback);
  }

  /** @param {unknown} error */
  function isAbortError(error) {
    return Boolean(error) && /** @type {{ name?: unknown }} */ (error).name === "AbortError";
  }

  // An empty or non-JSON body becomes {}; cancelling while the body is read still rejects.
  /** @param {Response} response */
  async function readJson(response) {
    if (typeof response?.json !== "function") return {};
    try {
      const data = await response.json();
      return data ?? {};
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {};
    }
  }

  /**
   * @param {string} url
   * @param {ApiFetchOptions} [options] fetch options plus `errorMessage` (fallback text) and
   *   `responseType` ("json" returns the parsed body; "response" returns the Response for downloads).
   */
  async function apiFetch(url, options = {}) {
    const { errorMessage = DEFAULT_ERROR_MESSAGE, responseType = "json", ...init } = options;
    // Resolved per call so tests and harnesses can replace the global fetch.
    const response = await globalThis.fetch(url, init);
    if (!response.ok) {
      const data = await readJson(response);
      const detail = data && typeof data === "object" ? /** @type {{ detail?: unknown }} */ (data).detail : undefined;
      const error = /** @type {ApiFetchError} */ (new Error(formatDetail(detail, errorMessage)));
      error.status = response.status;
      error.detail = detail;
      error.data = data;
      throw error;
    }
    return responseType === "response" ? response : readJson(response);
  }

  return { apiFetch, isAbortError };
});
