(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressCatalogSearch = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function normalizeSearchText(value) {
    return String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR")
      .trim();
  }

  function matchesCatalogSearch(unit, query) {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return true;
    return ["cidade", "endereco", "cnpj", "cep"].some(field =>
      normalizeSearchText(unit?.[field]).includes(normalizedQuery)
    );
  }

  return { matchesCatalogSearch, normalizeSearchText };
});
