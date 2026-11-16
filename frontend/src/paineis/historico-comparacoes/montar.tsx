import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ControlesHistorico } from "./controles";
import {
  abrirModalHistoricoComparacoes, carregarContagemHistoricoComparacoes, carregarHistoricoComparacoes,
  consultarHistoricoComparacao, exportarHistoricoComparacoesExcel, fecharModalHistoricoComparacoes,
  restaurarHistoricoComparacao,
} from "./estado";
import { ListaHistorico } from "./lista";

function PainelHistorico({ lista }: { lista: HTMLElement | null }) {
  return (
    <>
      <ControlesHistorico />
      {lista && <ListaHistorico alvo={lista} />}
    </>
  );
}

// Chamado por frontend/src/main.tsx com o bloco de controles (data-react-painel="historico-comparacoes") do cabeçalho do
// modal Histórico de atualizações de planilhas; a lista de cartões é desenhada por portal em #lista-historico-comparacoes.
// As ações são chamadas pelo código antigo pela ponte (static/js/features/comparison-history.js).
export function montar(container: HTMLElement) {
  const lista = document.getElementById("lista-historico-comparacoes");
  // flushSync: o código antigo chama a contagem na partida (sem esperar) e o seletor de datas precisa existir já.
  flushSync(() => { createRoot(container).render(<PainelHistorico lista={lista} />); });
  return {
    carregarContagemHistoricoComparacoes, abrirModalHistoricoComparacoes, fecharModalHistoricoComparacoes,
    carregarHistoricoComparacoes, exportarHistoricoComparacoesExcel, restaurarHistoricoComparacao,
    consultarHistoricoComparacao,
  };
}
