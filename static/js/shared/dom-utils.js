/** Safe text and DOM helpers. The document is injected for isolated tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  if (root) root.SimpressDomUtils = factory;
})(typeof window === "undefined" ? globalThis : window, function createDomUtils(document) {
  "use strict";
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function createTextElement(tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(value ?? "");
    return element;
  }

  function createIcon(name, className) {
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", name);
    icon.className = className;
    return icon;
  }

  function highlightMatch(text, query) {
    if (!text) return "";
    if (!query) return escapeHtml(text);
    const q = query.trim();
    if (!q) return escapeHtml(text);
    const safeText = escapeHtml(text);
    const safeQuery = escapeHtml(q);
    const regex = new RegExp(`(${safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
    return safeText.replace(regex, `<span class="serial-match">$1</span>`);
  }

  return { escapeHtml, createTextElement, createIcon, highlightMatch };
});
