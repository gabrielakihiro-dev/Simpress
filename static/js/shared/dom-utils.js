// @ts-check
/** Safe text and DOM helpers. The document is injected for isolated tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  if (root) root.SimpressDomUtils = factory;
})(typeof window === "undefined" ? globalThis : window, /** @param {Document} document */
function createDomUtils(document) {
  "use strict";
  /** @param {unknown} str @returns {string} */
  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /** @param {string} tagName @param {string | undefined} className @param {unknown} value @returns {HTMLElement} */
  function createTextElement(tagName, className, value) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(value ?? "");
    return element;
  }

  /** @param {string} name @param {string} className @returns {HTMLElement} */
  function createIcon(name, className) {
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", name);
    icon.className = className;
    return icon;
  }

  // Portuguese counts: only exactly one is singular ("1 dia", "0 dias", "2 dias").
  /** @param {unknown} count @param {string} singular @param {string} [plural] @returns {string} */
  function pluralize(count, singular, plural = `${singular}s`) {
    return Number(count) === 1 ? singular : plural;
  }

  /** @param {unknown} text @param {string} [query] @returns {string} */
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

  let infoTipCount = 0;
  // Markup do ⓘ (.info-tip de ux-refinements.css) com id único por documento; rótulo e texto escapados.
  // `id` fixo (constante do código) só para o ⓘ redesenhado várias vezes, que não pode mudar de id a cada redesenho.
  // `bloco`: o balão ancora no pai com .info-tip-ancora e não passa da largura dele (ux-refinements.css).
  /** @param {unknown} rotulo @param {unknown} texto @param {{ fim?: boolean, bloco?: boolean, id?: string }} [opcoes] @returns {string} */
  function infoTipHtml(rotulo, texto, { fim = false, bloco = false, id: idFixo = "" } = {}) {
    const id = idFixo || `tip-auto-${++infoTipCount}`;
    return `<span class="info-tip${fim ? " info-tip--end" : ""}${bloco ? " info-tip--bloco" : ""}"><button type="button" class="info-tip-trigger" aria-label="Sobre ${escapeHtml(rotulo)}" aria-describedby="${id}">`
      + '<svg class="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info"></use></svg>'
      + `</button><span id="${id}" role="tooltip" class="info-tip-text">${escapeHtml(texto)}</span></span>`;
  }

  return { escapeHtml, createTextElement, createIcon, highlightMatch, pluralize, infoTipHtml };
});
