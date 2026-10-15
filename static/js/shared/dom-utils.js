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

  // Portuguese counts: only exactly one is singular ("1 dia", "0 dias", "2 dias").
  function pluralize(count, singular, plural = `${singular}s`) {
    return Number(count) === 1 ? singular : plural;
  }

  function highlightMatch(text, query) {
    if (!text) return "";
    if (!query) return escapeHtml(text);
    const q = query.trim();
    if (!q) return escapeHtml(text);
    const value = String(text);
    const pattern = q.split("").map(character =>
      "^$.*+?()[]{}|\\".includes(character) ? "\\" + character : character
    ).join("");
    const regex = new RegExp(pattern, "gi");
    let result = "";
    let cursor = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
      result += escapeHtml(value.slice(cursor, match.index));
      result += '<span class="serial-match">' + escapeHtml(match[0]) + "</span>";
      cursor = match.index + match[0].length;
    }
    return result + escapeHtml(value.slice(cursor));
  }

  return { escapeHtml, createTextElement, createIcon, highlightMatch, pluralize };
});
