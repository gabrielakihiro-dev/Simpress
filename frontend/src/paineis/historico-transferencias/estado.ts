// Estado do diálogo "Transferências geradas", fora do componente: o código antigo chama as ações pela janela
// (data-on-click e a aba Transporte), às vezes antes de o React desenhar o diálogo. Toda mudança de estado vai por
// flushSync: o DOM já está final quando o evento simpress:tabelas-renderizadas sai (data-panels.js lê a tabela nele).
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchError } from "../../api";
import {
  ENDPOINT, describeFailure, duplicateValues, findUnitOption, type ItemHistorico,
} from "./historico-transferencias-puro";

const MODAL_ID = "modal-historico-transferencias";
export const ID_FILTRO = "filtro-historico-transferencias";
export const ID_LISTA = "lista-historico-transferencias";
const LIST_LIMIT = 50;
const SEARCH_DELAY_MS = 250;

export interface Estado {
  fase: "ocioso" | "carregando" | "mensagem" | "lista";
  carga: number; // número da busca: recria as chaves, porque data-panels.js e ux-enhancements.js mudam o DOM por fora
  status: string;
  mensagem: { texto: string; papel: "status" | "alert" };
  itens: ItemHistorico[];
}

// Funções do código antigo publicadas em window por frontend/src/legado/app.js (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast?: (mensagem: string, tipo?: string) => void;
  copiarTextoParaAreaTransferencia(texto: unknown): Promise<unknown>;
  ativarAbaTransferencia?: (aba: string) => void;
}
const app = () => window as unknown as AppAntigo;

let estado: Estado = { fase: "ocioso", carga: 0, status: "", mensagem: { texto: "", papel: "status" }, itens: [] };
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  // "Copiar tabela" e "Modo compacto" (data-panels.js) são inseridos dentro da lista, fora do React: saem antes de
  // a lista nova entrar, senão a ferramenta da busca anterior ficaria sobre a tabela da seguinte.
  if (parcial.fase !== undefined) {
    document.getElementById(ID_LISTA)?.querySelectorAll(":scope > .ux-table-tools").forEach(no => no.remove());
  }
  estado = { ...estado, ...parcial };
  flushSync(() => { ouvintes.forEach(ouvinte => ouvinte()); });
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

let searchTimer: ReturnType<typeof setTimeout> | undefined;
let requestSerial = 0;

function notify(message: string, type = "success") {
  const { showToast } = app();
  if (typeof showToast === "function") showToast(message, type);
}

const campo = (id: string) => document.getElementById(id) as HTMLInputElement | null;

export async function copySerial(item: ItemHistorico) {
  try {
    await app().copiarTextoParaAreaTransferencia(item.serial);
    notify(`Série ${item.serial} copiada para a área de transferência.`);
  } catch {
    notify("Não foi possível copiar a série.", "error");
  }
}

export function duplicateDestination(item: ItemHistorico) {
  const payload = item.payload || {};
  fecharModalHistoricoTransferencias();
  const { ativarAbaTransferencia } = app();
  if (typeof ativarAbaTransferencia === "function") ativarAbaTransferencia("transferencia");
  const select = document.getElementById("select-unidade-destino") as HTMLSelectElement | null;
  const option = select && findUnitOption(
    Array.from(select.options).map(entry => ({ value: entry.value, text: entry.textContent })), payload);
  if (select && option) {
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // Representative auto-fill runs on change; restore the saved contact data afterwards.
  setTimeout(() => {
    duplicateValues(payload).forEach(([fieldId, value]) => {
      const field = campo(fieldId);
      if (!field) return;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    notify(option
      ? "Destino e contato duplicados. Pesquise o equipamento na aba Home."
      : "Contato duplicado, mas o destino não está mais no catálogo. Selecione a unidade.", option ? "info" : "warning");
    campo("entrega-contato")?.focus();
  }, 0);
}

function mostrarMensagem(texto: string, papel: "status" | "alert", status: string) {
  mudar({ status, fase: "mensagem", mensagem: { texto, papel } });
}

async function carregar() {
  const ticket = ++requestSerial;
  const term = String(campo(ID_FILTRO)?.value || "").trim();
  mudar({ fase: "carregando", carga: ticket });
  // Indicador de carregamento (ux-enhancements.js) entra antes da busca.
  document.dispatchEvent(new CustomEvent("simpress:carregando-exibido"));
  mudar({ status: "Carregando histórico…" });
  try {
    const resposta = await apiFetch(`${ENDPOINT}?limite=${LIST_LIMIT}&busca=${encodeURIComponent(term)}`, { responseType: "response" });
    if (ticket !== requestSerial) return;
    const data = JSON.parse(await resposta.text());
    if (ticket !== requestSerial) return;
    const itens: ItemHistorico[] = Array.isArray(data.itens) ? data.itens : [];
    if (!itens.length) {
      mostrarMensagem(
        term ? "Nenhuma transferência corresponde à busca." : "Nenhuma planilha de transferência foi gerada ainda.",
        "status",
        term ? "Nenhum resultado." : "Nenhuma transferência registrada.",
      );
      return;
    }
    mudar({
      fase: "lista",
      itens,
      status: data.total > itens.length
        ? `Mostrando as ${itens.length} mais recentes de ${data.total}.`
        : `${itens.length} ${itens.length === 1 ? "transferência" : "transferências"}.`,
    });
    // Ordenação e "Copiar tabela" (data-panels.js) entram na tabela recém-montada.
    document.dispatchEvent(new CustomEvent("simpress:tabelas-renderizadas"));
  } catch (erro) {
    if (ticket !== requestSerial) return;
    const { status } = erro as Partial<ApiFetchError>;
    mostrarMensagem(describeFailure(typeof status === "number" ? status : 0), "alert", "");
  }
}

export function agendarBusca() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { void carregar(); }, SEARCH_DELAY_MS);
}

export function abrirModalHistoricoTransferencias() {
  const filtro = campo(ID_FILTRO);
  if (filtro) filtro.value = "";
  app().abrirModalAcessivel(MODAL_ID, `#${ID_FILTRO}`, "fecharModalHistoricoTransferencias");
  void carregar();
}

export function fecharModalHistoricoTransferencias() {
  clearTimeout(searchTimer);
  requestSerial += 1;
  app().fecharModalAcessivel(MODAL_ID);
}
