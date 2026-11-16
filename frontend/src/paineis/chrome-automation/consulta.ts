// Chamadas à API da automação e avisos ao usuário. Toda leitura e escrita passa por apiFetch (frontend/src/api.ts).
import { apiFetch, type ApiFetchError, type ApiFetchOptions } from "../../api";
import { interno } from "./estado";
import { AVISO_SERVIDOR_ANTIGO, eServidorDesatualizado } from "./regras-puro";

interface AppAntigo {
  showToast?: (mensagem: string, tipo?: string) => void;
  carregarNovosSebrae?: () => unknown;
}
export const appAntigo = () => window as unknown as AppAntigo;

export interface ErroAutomacao extends Error {
  status?: number;
  servidorDesatualizado?: boolean;
}

// Uma 404 em /api/automacao/* com o corpo padrão do FastAPI é rota inexistente: um servidor antigo respondeu.
export async function consultarAutomacao<T>(url: string, opcoes?: ApiFetchOptions & { responseType?: "json" }): Promise<T> {
  try {
    return await apiFetch<T>(url, opcoes);
  } catch (erro) {
    if (eServidorDesatualizado(erro as ApiFetchError | undefined)) {
      const aviso: ErroAutomacao = new Error(AVISO_SERVIDOR_ANTIGO);
      aviso.status = 404;
      aviso.servidorDesatualizado = true;
      throw aviso;
    }
    throw erro;
  }
}

// O aviso de servidor desatualizado aparece uma vez; as falhas seguintes ficam em silêncio na interface.
export function avisarErro(erro: unknown) {
  const falha = erro as ErroAutomacao;
  if (falha?.servidorDesatualizado) {
    if (interno.avisouServidorAntigo) return;
    interno.avisouServidorAntigo = true;
  }
  appAntigo().showToast?.(falha.message, "error");
}

export const valor = (id: string): string => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || "";
