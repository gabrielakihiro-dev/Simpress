export function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

export function matchesCatalogSearch(unit: Record<string, unknown> | null | undefined, query: unknown): boolean {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;
  return ["cidade", "endereco", "cnpj", "cep"].some(field =>
    normalizeSearchText(unit?.[field]).includes(normalizedQuery)
  );
}

// Ponte temporária: sai na react-final-3, quando app.js virar TS.
if (typeof window !== "undefined") window.SimpressCatalogSearch = { matchesCatalogSearch, normalizeSearchText };
