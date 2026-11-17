import { criarRegrasChamados } from "./regras";

// Chamado por frontend/src/main.tsx com o contêiner oculto [data-react-painel="regras-chamados"]. Não desenha nada:
// só publica as 20 regras de chamado em window.SimpressReact["regras-chamados"]. A aplicação
// (frontend/src/aplicacao/ticket-rules.ts) chama cada uma pela ponte síncrona, sempre depois de simpress:react-pronto.
export function montar(_container: HTMLElement) {
  return criarRegrasChamados(window.SimpressDomUtils(document));
}
