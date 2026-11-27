// Arquivos e imagens de /api/* por fetch: só o apiFetch leva o X-Simpress-Sessao (security/sessao_local.py), que um
// <a href>, um <img src> ou uma navegação não mandam. A falha sobe como Error para a tela mostrar o aviso.
import { apiFetch } from "../api.ts";

/** Endereço blob: da resposta, para <img src>; quem chama revoga com URL.revokeObjectURL. */
export async function urlDeBlobDaApi(url: string, signal?: AbortSignal): Promise<string> {
  const resposta = await apiFetch(url, { responseType: "response", signal });
  return URL.createObjectURL(await resposta.blob());
}

/** Baixa sem navegar; o nome vem do Content-Disposition (sem ele, nomePadrao). */
export async function baixarDaApi(url: string, nomePadrao: string, errorMessage?: string): Promise<void> {
  const resposta = await apiFetch(url, { responseType: "response", errorMessage });
  const achado = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(resposta.headers.get("Content-Disposition") || "");
  const endereco = URL.createObjectURL(await resposta.blob());
  const link = document.createElement("a");
  link.href = endereco;
  link.download = achado?.[1]?.replace(/["']/g, "") || nomePadrao;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(endereco), 1000);
}
