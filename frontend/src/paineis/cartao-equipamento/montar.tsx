import { criarAcoesCartaoEquipamento, type ContextoCartaoEquipamento } from "./estado";

function ponteReact(painel: string, nomes: string[]) {
  return Object.fromEntries(nomes.map(nome => [nome, (...argumentos: string[]) => {
    const acao = window.SimpressReact?.[painel]?.[nome];
    if (typeof acao !== "function") return Promise.reject(new Error(`O painel React "${painel}" não carregou.`));
    return Promise.resolve(acao(...argumentos));
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
