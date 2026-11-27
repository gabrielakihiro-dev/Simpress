// Único auxiliar de requisição JSON (painéis React e aplicação em frontend/src/aplicacao): aceita corpo vazio, transforma o `detail`
// do FastAPI (texto ou lista 422 do Pydantic) em Error legível, mantém o evento simpress:servidor-offline,
// o detail do 422 e error.status (409 de versao_importacao) e soma o X-Simpress-Sessao. Nunca usar fetch cru nos painéis React.
import { format as formatarDetalhe } from "./comum/api-errors.ts";
import type { Rotas } from "./api-tipos.gerado";

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

// Sessão local (security/sessao_local.py): o /bootstrap redireciona para /#sessao=<hex>; o valor vai para o localStorage
// (por origem, porta incluída, então outro servidor em 127.0.0.1 não o vê) e segue em X-Simpress-Sessao junto do cookie.
const CHAVE_SESSAO = "simpress_sessao";
const FORMATO_SESSAO = /^[0-9a-f]{64}$/;
let sessaoReserva = "";

function guardarSessaoDoEndereco() {
  if (typeof location === "undefined") return;
  const valor = location.hash.startsWith("#sessao=") ? location.hash.slice("#sessao=".length) : "";
  if (!FORMATO_SESSAO.test(valor)) return;
  sessaoReserva = valor;
  try { localStorage.setItem(CHAVE_SESSAO, valor); } catch { /* sem armazenamento: vale a reserva desta aba */ }
  try { history.replaceState(null, "", location.pathname + location.search); } catch { /* sem history: o valor fica na barra */ }
}
guardarSessaoDoEndereco();

// Lido a cada pedido (não no carregamento): um novo /bootstrap em outra aba vale para todas.
function sessaoAtual(): string {
  try {
    const salvo = localStorage.getItem(CHAVE_SESSAO) || "";
    if (FORMATO_SESSAO.test(salvo)) return salvo;
  } catch { /* sem armazenamento */ }
  return sessaoReserva;
}

function mesmaOrigem(url: string): boolean {
  try {
    return typeof location !== "undefined" && new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

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
  const sessao = mesmaOrigem(url) ? sessaoAtual() : "";
  if (sessao) {
    // Headers não define Content-Type: o FormData continua com o boundary do navegador.
    const headers = new Headers(init.headers);
    headers.set("X-Simpress-Sessao", sessao);
    init.headers = headers;
  }
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

// "{lembrete_id}" de "PATCH /api/lembretes/{lembrete_id}" vira o parâmetro obrigatório lembrete_id.
type ParametrosCaminho<R extends string> = R extends `${string}{${infer P}}${infer Resto}` ? P | ParametrosCaminho<Resto> : never;

export type OpcoesRota<R extends keyof Rotas> = Omit<ApiFetchOptions, "method" | "body" | "headers" | "responseType">
  & ([ParametrosCaminho<R>] extends [never] ? { caminho?: never } : { caminho: Record<ParametrosCaminho<R>, string | number> })
  & ([Rotas[R]["corpo"]] extends [never] ? { corpo?: never } : { corpo: Rotas[R]["corpo"] });

/** apiFetch tipado pela rota de api-tipos.gerado.d.ts: método e URL saem da chave, o corpo vai como JSON e a resposta
 * tem o tipo que o servidor declara. Ex.: apiRota("PATCH /api/lembretes/{lembrete_id}", { caminho: { lembrete_id: id }, corpo: { concluido: true } }).
 * Com responseType "response" devolve a Response 2xx crua, para quem trata corpo vazio ou ilegível (Cobertura). */
export function apiRota<R extends keyof Rotas>(rota: R, opcoes: OpcoesRota<R> & { responseType: "response" }): Promise<Response>;
export function apiRota<R extends keyof Rotas>(rota: R, opcoes: OpcoesRota<R>): Promise<Rotas[R]["resposta"]>;
export function apiRota(rota: keyof Rotas, opcoes: object): Promise<unknown> {
  const { caminho, corpo, responseType, ...resto } = opcoes as ApiFetchOptions & { caminho?: Record<string, string | number>; corpo?: unknown };
  const [method, molde = ""] = rota.split(" ");
  const url = molde.replace(/\{(\w+)\}/g, (_trecho, nome: string) => encodeURIComponent(String(caminho?.[nome])));
  const json = corpo === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) };
  const init = { ...resto, method, ...json };
  return responseType === "response" ? apiFetch(url, { ...init, responseType }) : apiFetch(url, init);
}

// Publicação em window, lida por frontend/src/aplicacao/app.ts (context.apiFetch).
if (typeof window !== "undefined") window.SimpressApiFetch = { apiFetch, isAbortError };
