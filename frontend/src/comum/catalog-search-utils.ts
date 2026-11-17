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

// Publicação em window, lida por frontend/src/aplicacao/app.ts e por paineis/paineis-dados/chamados-os.ts.
if (typeof window !== "undefined") window.SimpressCatalogSearch = { matchesCatalogSearch, normalizeSearchText };
