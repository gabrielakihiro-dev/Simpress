// Único auxiliar de requisição JSON (painéis React e código antigo): aceita corpo vazio, transforma o `detail`
// do FastAPI (texto ou lista 422 do Pydantic) em Error legível, mantém o evento simpress:servidor-offline,
// o detail do 422 e error.status (409 de versao_importacao). Nunca usar fetch cru nos painéis React.
import { format as formatarDetalhe } from "./comum/api-errors.ts";

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

const DEFAULT_ERROR_MESSAGE = "Não foi possível concluir a solicitação.";
// No navegador é a janela; no teste em Node, o globalThis (sem dispatchEvent, o evento offline não sai).
const root: any = typeof window !== "undefined" ? window : globalThis; // eslint-disable-line @typescript-eslint/no-explicit-any

export function isAbortError(error: unknown): boolean {
  return Boolean(error) && (error as { name?: unknown }).name === "AbortError";
}

// Corpo vazio é aceito; corpo de sucesso malformado não pode parecer sucesso.
async function readJson(response: Response, tolerateInvalid: boolean, errorMessage: string): Promise<unknown> {
  if (typeof response?.json !== "function") return {};
  if (typeof response.text === "function") {
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (isAbortError(error) || !tolerateInvalid) throw error;
      return {};
    }
    if (!body.trim()) return {};
    try {
      return JSON.parse(body) ?? {};
    } catch (error) {
      if (tolerateInvalid) return {};
      throw new Error(errorMessage);
    }
  }
  try {
    const data = await response.json();
    return data ?? {};
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (tolerateInvalid) return {};
    throw error;
  }
}

export function apiFetch<T = unknown>(url: string, options?: ApiFetchOptions & { responseType?: "json" }): Promise<T>;
export function apiFetch(url: string, options: ApiFetchOptions & { responseType: "response" }): Promise<Response>;
export async function apiFetch(url: string, options: ApiFetchOptions = {}): Promise<unknown> {
  const { errorMessage = DEFAULT_ERROR_MESSAGE, responseType = "json", ...init } = options;
  // Resolvido a cada chamada para testes e harnesses poderem trocar o fetch global.
  let response: Response;
  try {
    response = await globalThis.fetch(url, init);
  } catch (networkError) {
    if (!isAbortError(networkError) && typeof root?.dispatchEvent === "function" && typeof root.CustomEvent === "function") {
      root.dispatchEvent(new root.CustomEvent("simpress:servidor-offline", { detail: { url, error: networkError } }));
    }
    throw networkError;
  }
  if (!response.ok) {
    const data = await readJson(response, true, errorMessage);
    const detail = data && typeof data === "object" ? (data as { detail?: unknown }).detail : undefined;
    const error = new Error(formatarDetalhe(detail, errorMessage)) as ApiFetchError;
    error.status = response.status;
    error.detail = detail;
    error.data = data;
    throw error;
  }
  return responseType === "response" ? response : readJson(response, false, errorMessage);
}

// Ponte temporária: sai na react-final-3, quando app.js virar TS.
if (typeof window !== "undefined") window.SimpressApiFetch = { apiFetch, isAbortError };
