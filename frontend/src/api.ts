// Chamadas à API pelo mesmo apiFetch do código antigo (frontend/src/legado/shared/api-fetch.js), que mantém
// o evento simpress:servidor-offline, o detail do 422 e error.status (409 de versao_importacao).
// Nunca usar fetch cru nos painéis React.

export interface ApiFetchOptions extends RequestInit {
  /** Texto usado quando a resposta de erro não traz detail. */
  errorMessage?: string;
  /** "json" (padrão) devolve o corpo lido; "response" devolve a Response, para downloads. */
  responseType?: "json" | "response";
}

export interface ApiFetchError extends Error {
  status: number;
  detail?: unknown;
  data?: unknown;
}

export function apiFetch<T = unknown>(url: string, options?: ApiFetchOptions & { responseType?: "json" }): Promise<T>;
export function apiFetch(url: string, options: ApiFetchOptions & { responseType: "response" }): Promise<Response>;
export function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<unknown> {
  return window.SimpressApiFetch.apiFetch(url, options);
}

export function isAbortError(error: unknown): boolean {
  return window.SimpressApiFetch.isAbortError(error);
}
