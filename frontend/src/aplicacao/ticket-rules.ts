/** Regras de chamado: a lógica vive em frontend/src/paineis/regras-chamados/regras.ts; aqui só encaminhamos as chamadas. */
import type { Qualquer } from "./tipos.ts";

const nomes = [
  "formatarListaChamados", "compararOrdensServicoDecrescente", "obterOrdemServicoPrincipalChamado",
  "compararChamadosPorOrdemServicoDecrescente", "formatarOrdensServico", "etapasProcessoPedido", "formatarDataEtapa",
  "renderizarResumoProcessoPedido", "renderizarLinhaProcessoPedido", "resumirDescricaoChamado", "normalizarFiltroChamados",
  "chamadosClienteInformados", "valoresChamado", "dataAtualizacaoChamado", "classificarAtencaoChamado", "cidadesDoChamado",
  "atendimentosDoChamado", "idadeAtualizacaoChamado", "grupoTriagemChamado", "correspondeTriagemChamado",
];

// Todas síncronas: os chamadores (renderizadores, ordenação, filtros) usam o retorno na hora e só rodam depois do
// evento simpress:react-pronto. Antes disso o painel ainda não existe: registra o erro e devolve undefined.
// context.ponteReactSincrona ainda não existe quando esta fábrica roda (ela entra no literal de context em app.ts),
// por isso o encaminhamento lê window.SimpressReact direto, a cada chamada.
export function createTicketRules(): Record<string, (...argumentos: Qualquer[]) => Qualquer> {
  return Object.fromEntries(nomes.map(nome => [nome, (...argumentos: Qualquer[]) => {
    const raiz: Qualquer = typeof window !== "undefined" ? window : globalThis;
    const acao = raiz.SimpressReact?.["regras-chamados"]?.[nome];
    if (typeof acao !== "function") {
      console.error(new Error('O painel React "regras-chamados" não carregou.'));
      return;
    }
    return acao(...argumentos);
  }]));
}
