// Nós de fora da aba que a automação atualiza por função, como o módulo antigo: o chip "Chrome livre/ocupado" do
// cabeçalho e os botões [data-automacao-rotina] de outras telas (Sebrae). Os botões da própria aba são React.
import type { EstadoAutomacao } from "./estado";
import { botaoBloqueado, type DescricaoEstado } from "./regras-puro";

export function mostrarChip(descricao: DescricaoEstado) {
  const chip = document.getElementById("cockpit-automation-shell-status");
  const titulo = document.getElementById("cockpit-automation-shell-title");
  if (!chip || !titulo) return;
  chip.dataset.state = descricao.chipState;
  // Pulso de "Chrome livre" só depois de um estado real vindo da API (ck-bento.css).
  chip.dataset.confirmado = "";
  titulo.textContent = descricao.chipTitulo;
  chip.title = descricao.chipDica;
}

// Sem consulta viva, o pulso de "Chrome livre" para (ck-bento.css: só com estado real).
export const semEstadoReal = () => { delete document.getElementById("cockpit-automation-shell-status")?.dataset?.confirmado; };

function botoesExternos(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-automacao-rotina]")].filter(botao => !botao.closest("[data-automacao-regiao]"));
}

export const botaoExterno = (rotina: string): HTMLButtonElement | null => botoesExternos().find(botao => botao.dataset.automacaoRotina === rotina) || null;

// data-sem-saida: "Enviar ao SharePoint" sem arquivo gerado por Atualizar Dashboard (definido em sebrae-dashboard.js).
export function atualizarBotoesExternos(estado: Pick<EstadoAutomacao, "ocupado" | "emAndamento">) {
  botoesExternos().forEach(botao => {
    const bloqueado = botaoBloqueado({ ocupado: estado.ocupado, emAndamento: estado.emAndamento, acompanhar: false, semSaida: botao.dataset.semSaida === "true" });
    botao.disabled = bloqueado;
    botao.setAttribute("aria-disabled", String(bloqueado));
  });
}
