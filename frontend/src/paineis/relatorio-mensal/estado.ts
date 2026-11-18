// Estado do diálogo Relatório mensal (docs/operacao/relatorio-mensal.md), fora do componente: a aplicação chama
// as ações pela ponte (frontend/src/aplicacao/pontes.ts) e cockpit-tool-panels.ts lê #status-relatorio-mensal logo
// depois de await exportarRelatorioMensal(). Por isso toda mudança de estado vai por flushSync: o DOM já está final
// quando a ação devolve a promessa.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import { mesAtual, mesValido, nomeArquivoRelatorio } from "./relatorio-puro";

interface Estado {
  status: string;
  erro: boolean | null; // null até o primeiro mostrarStatus: o HTML antigo só ganha data-state depois dele
  ocupado: boolean; // exportação em andamento: bloqueia fechar e um segundo envio
}

// Ações da aplicação publicadas em window por frontend/src/aplicacao/app.ts (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string, botaoSidebar: string): void;
  fecharModalAcessivel(modalId: string): void;
  showToast(mensagem: string, tipo: string): void;
}
const app = () => window as unknown as AppAntigo;

let estado: Estado = { status: "", erro: null, ocupado: false };
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  flushSync(() => { ouvintes.forEach(ouvinte => ouvinte()); });
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

const mostrarStatus = (status: string, erro = false) => mudar({ status, erro });

// O campo do mês fica não controlado: a exportação lê o valor direto do DOM (cockpit-tool-panels.js também o grava).
function campoMes(): HTMLInputElement {
  const campo = document.getElementById("relatorio-mensal-mes");
  if (!(campo instanceof HTMLInputElement)) throw new Error("O campo #relatorio-mensal-mes não está no DOM.");
  return campo;
}

export function abrirRelatorioMensal() {
  if (estado.ocupado) return;
  const input = campoMes();
  const atual = mesAtual();
  input.max = atual;
  if (!mesValido(input.value)) input.value = atual;
  mostrarStatus("");
  app().abrirModalAcessivel("modal-relatorio-mensal", "#relatorio-mensal-mes", "fecharRelatorioMensal", "btn-relatorio-mensal");
}

export function fecharRelatorioMensal() {
  if (!estado.ocupado) app().fecharModalAcessivel("modal-relatorio-mensal");
}

function baixarArquivo(blob: Blob, nome: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

export async function exportarRelatorioMensal() {
  if (estado.ocupado) return;
  const input = campoMes();
  const mes = input.value;
  if (!mesValido(mes)) {
    mostrarStatus("Selecione o mês atual ou um mês anterior.", true);
    input.focus();
    return;
  }
  const form = document.getElementById("form-relatorio-mensal");
  mudar({ ocupado: true, status: "Gerando relatório...", erro: false });
  form?.setAttribute("aria-busy", "true");
  try {
    const res = await apiFetch(`/api/relatorio-mensal?mes=${encodeURIComponent(mes)}`, {
      responseType: "response",
      errorMessage: "Falha ao gerar o relatório mensal.",
    });
    baixarArquivo(await res.blob(), nomeArquivoRelatorio(res.headers.get("Content-Disposition") || "", mes));
    mostrarStatus("");
    app().showToast("Planilha Exportada com Sucesso!", "success");
  } catch (erro) {
    console.error("Erro ao exportar o relatório mensal:", erro);
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    mostrarStatus(mensagem, true);
    app().showToast(mensagem, "error");
  } finally {
    mudar({ ocupado: false });
    form?.removeAttribute("aria-busy");
  }
}
