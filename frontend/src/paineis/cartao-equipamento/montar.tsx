import { criarAcoesCartaoEquipamento, type ContextoCartaoEquipamento } from "./estado";

// editar-equipamento e editar-apelido são painéis sob demanda (frontend/src/paineis.ts): não estão em window.SimpressReact
// até o primeiro uso, então a ponte baixa e monta pelo SimpressReactSobDemanda. Painel já publicado roda no mesmo turno.
function ponteReact(painel: string, nomes: string[]) {
  return Object.fromEntries(nomes.map(nome => [nome, async (...argumentos: string[]) => {
    const acoes = window.SimpressReact?.[painel] ?? await window.SimpressReactSobDemanda?.[painel]?.().catch(() => undefined);
    const acao = acoes?.[nome];
    if (typeof acao !== "function") throw new Error(`O painel React "${painel}" não carregou.`);
    return acao(...argumentos);
  }]));
}

export function montar(_container: HTMLElement) {
  const app = window as unknown as ContextoCartaoEquipamento["app"];
  const appState = window.SimpressApp.state as ContextoCartaoEquipamento["appState"];
  const contexto = { app, appState, dom: window.SimpressDomUtils(document) };
  return criarAcoesCartaoEquipamento({
    app,
    appState,
    ponteReact,
    loggedUserMarkers: window.SimpressLoggedUserMarkers(contexto),
  });
}
