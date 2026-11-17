// Estado do modal "Atualizar / Cadastrar equipamento", fora do componente: a aplicação chama as ações pela ponte
// (frontend/src/aplicacao/pontes.ts). Única escrita: POST /api/equipamento/salvar.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import { lerEstado } from "../../estado-app";
import {
  TEXTO, TIPO_PADRAO, camposDeNovoSerial, camposDoEquipamento, lerResposta, montarPayload, normalizarSerial, seguiuSelecionado,
  type Campos,
} from "./editar-equipamento-puro";

const MODAL = "modal-editar-equipamento";

// Funções da aplicação publicadas em window (frontend/src/aplicacao/app.ts, publish).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
  fecharAutocomplete(): void;
}
const app = window as unknown as AppAntigo;

export interface Estado extends Campos {
  salvando: boolean;
}

// Mesmo conteúdo inicial do diálogo antigo (frontend/partials/modais.html).
let estado: Estado = {
  titulo: TEXTO.tituloInicial,
  badge: "",
  serial: "",
  somenteLeitura: false,
  modelo: "",
  tipo: TIPO_PADRAO,
  apelido: "",
  idCliente: "",
  apelidoOculto: false,
  salvando: false,
};
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

export type CampoEditavel = "serial" | "modelo" | "tipo" | "apelido" | "idCliente";
export function editar(campo: CampoEditavel, valor: string) {
  const parcial: Partial<Estado> = {};
  parcial[campo] = valor;
  mudar(parcial);
}

// O diálogo abre já com os campos desenhados: o foco inicial (#edit-modelo) depende do DOM pronto.
function abrir(campos: Campos) {
  flushSync(() => mudar(campos));
  app.abrirModalAcessivel(MODAL, "#edit-modelo", "fecharModalEditarEquipamento");
}

export function abrirModalEditarEquipamento() {
  const atual = lerEstado("currentEquipamento");
  if (!atual) {
    app.showToast(TEXTO.semEquipamento, "warning");
    return;
  }
  abrir(camposDoEquipamento(atual));
}

// Série nova: a ponte chama com o texto pesquisado na Home (input-serial). Não é publicada em window.
export function cadastrarNovoSerial(serial: string) {
  app.fecharAutocomplete();
  abrir(camposDeNovoSerial(serial));
}

export function fecharModalEditarEquipamento() {
  app.fecharModalAcessivel(MODAL);
}

// Devolve o equipamento gravado para a ponte aplicar no cartão; null se não gravou ou se a seleção mudou no caminho.
export async function salvarDadosEquipamento(): Promise<{ equipamento: unknown } | null> {
  const serial = normalizarSerial(estado.serial);
  if (!serial) {
    app.showToast(TEXTO.serialObrigatorio, "warning");
    document.getElementById("edit-serial")?.focus();
    return null;
  }
  const payload = montarPayload(estado, lerEstado("currentEquipamento"));
  const revisaoAoSalvar = lerEstado("equipamentoSelectionRevision");
  flushSync(() => mudar({ salvando: true }));
  try {
    const dados = await apiFetch<unknown>("/api/equipamento/salvar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      errorMessage: TEXTO.erroApi,
    });
    const resposta = lerResposta(dados, serial);
    const aindaSelecionado = seguiuSelecionado(revisaoAoSalvar, lerEstado("equipamentoSelectionRevision"));
    app.showToast(resposta.mensagem, "success");
    return aindaSelecionado ? { equipamento: resposta.equipamento } : null;
  } catch (erro) {
    console.error("Erro ao salvar:", erro);
    app.showToast(erro instanceof Error ? erro.message : String(erro), "error");
    return null;
  } finally {
    mudar({ salvando: false });
  }
}
