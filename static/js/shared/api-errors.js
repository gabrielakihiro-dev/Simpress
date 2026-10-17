// @ts-check
/** @typedef {Record<string, unknown> & { msg?: unknown, message?: unknown, detail?: unknown }} ApiErrorItem */

(function (root, factory) {
  const api = factory();
  // @ts-ignore Node supplies this wrapper variable for the CommonJS test path.
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressApiErrors = api;
})(typeof window !== "undefined" ? window : globalThis, function createApiErrors() {
  "use strict";

  /** @param {unknown} value */
  function readableMessage(value) {
    if (typeof value === "string" || typeof value === "number") return String(value).trim();
    if (!value || typeof value !== "object") return "";

    const candidate = /** @type {ApiErrorItem} */ (value);
    for (const key of ["msg", "message", "detail"]) {
      const message = candidate[key];
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    return "";
  }

  /** @param {unknown} detail @param {string} fallback */
  function format(detail, fallback) {
    const entries = Array.isArray(detail) ? detail : [detail];
    const messages = entries.map(readableMessage).filter(Boolean);
    return messages.length ? [...new Set(messages)].join("; ") : fallback;
  }

  /** @param {unknown} detail @param {string} fallback */
  function create(detail, fallback) {
    return new Error(format(detail, fallback));
  }

  return { create, format };
});
