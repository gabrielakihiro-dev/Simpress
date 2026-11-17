// @ts-check
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressCatalogSearch = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  /** @param {unknown} value @returns {string} */
  function normalizeSearchText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .trim();
  }

  /** @param {Record<string, unknown> | null | undefined} unit @param {unknown} query @returns {boolean} */
  function matchesCatalogSearch(unit, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return true;
    return ["cidade", "endereco", "cnpj", "cep"].some(field =>
      normalizeSearchText(unit?.[field]).includes(normalizedQuery)
    );
  }

  return { matchesCatalogSearch, normalizeSearchText };
});
