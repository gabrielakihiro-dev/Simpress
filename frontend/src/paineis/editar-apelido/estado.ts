// Estado do modal "Editar apelido", fora do componente: a aplicação chama as ações pela ponte
// (frontend/src/aplicacao/pontes.ts). Única escrita: POST /api/equipamento/atualizar-apelido.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import { lerEstado } from "../../estado-app";
import { TEXTO, camposDoApelido, lerEquipamento, montarPayload, seguiuSelecionado, serialDo } from "./editar-apelido-puro";

const MODAL = "modal-editar-apelido";

// Funções da aplicação publicadas em window (frontend/src/aplicacao/app.ts, publish).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
}
const app = window as unknown as AppAntigo;

export interface Estado {
  apelido: string; // valor do campo
  contexto: string; // linha "Série: ..." abaixo do campo
  salvando: boolean;
}

// Mesmo conteúdo inicial do diálogo antigo (frontend/partials/modais.html).
let estado: Estado = { apelido: "", contexto: "", salvando: false };
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

export const editar = (apelido: string) => mudar({ apelido });

export function abrirModalEditarApelido() {
  const atual = lerEstado("currentEquipamento");
  if (!atual) {
    app.showToast(TEXTO.semEquipamento, "warning");
    return;
  }
  // O diálogo abre já com o apelido desenhado: o foco inicial e a seleção do texto dependem do DOM pronto.
  flushSync(() => mudar(camposDoApelido(atual)));
  app.abrirModalAcessivel(MODAL, "#edit-apelido-isolado", "fecharModalEditarApelido");
  document.querySelector<HTMLInputElement>("#edit-apelido-isolado")?.select();
}

export function fecharModalEditarApelido() {
  app.fecharModalAcessivel(MODAL);
}

// Devolve o equipamento com o apelido gravado para a ponte aplicar no cartão; null se não gravou ou se a seleção
// mudou no caminho (o aviso de sucesso aparece nos dois casos, o diálogo só fecha no primeiro).
export async function salvarApelido(): Promise<{ equipamento: unknown } | null> {
  const atual = lerEstado("currentEquipamento");
  if (!atual) {
    app.showToast(TEXTO.semEquipamento, "warning");
    fecharModalEditarApelido();
    return null;
  }
  const serial = serialDo(atual);
  const revisaoAoSalvar = lerEstado("equipamentoSelectionRevision");
  const payload = montarPayload(serial, estado.apelido);
  flushSync(() => mudar({ salvando: true }));
  try {
    const dados = await apiFetch<unknown>("/api/equipamento/atualizar-apelido", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      errorMessage: TEXTO.erroApi,
    });
    const aindaSelecionado = seguiuSelecionado(revisaoAoSalvar, lerEstado("equipamentoSelectionRevision"), serial, lerEstado("currentEquipamento"));
    app.showToast(TEXTO.sucesso, "success");
    return aindaSelecionado ? { equipamento: lerEquipamento(dados) } : null;
  } catch (erro) {
    console.error("Erro ao salvar apelido:", erro);
    app.showToast((erro instanceof Error && erro.message) || TEXTO.erroApi, "error");
    return null;
  } finally {
    mudar({ salvando: false });
  }
}
