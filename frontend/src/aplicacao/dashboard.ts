/** Home indicators: inventory statistics and the readiness panel that lists which files and functions are available. The rules and actions live in frontend/src/paineis/indicadores-home/. */
import { registrarRejeicoes } from "./pontes.ts";
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createDashboard(context: ContextoApp): Acoes {
  // app.ts starts the page before react-entry.js mounts the panel, so the boot actions wait for it (ponteReact).
  const ponte = context.ponteReact("indicadores-home", [
    "carregarEstatisticas", "carregarProntidao", "inicializarProntidao",
    "inicializarAlertaBaseDesatualizada", "inicializarAlertasOsDivergencias",
  ]);
  // Same-turn actions: atualizarIndicadoresPosSalvamento is called by other panels; the renderers keep the legacy names.
  const ponteSincrona = context.ponteReactSincrona("indicadores-home", [
    "atualizarIndicadoresPosSalvamento", "renderizarAlertaBaseDesatualizada", "renderizarAlertaOsParadas",
    "renderizarAlertaDivergenciasNovas", "renderizarAlertaSemAcesso60", "renderizarAlertaChamadosOutroTecnico",
    "renderizarAlertaFalhasFinalizacao", "renderizarAlertaBackupsRegionais",
  ]);
  // Without the panel the Home keeps working, only without live indicators: the error goes to the console.
  const ponteRegistrada = registrarRejeicoes(ponte);
  // paineis-dados fires painel-atualizado on import; if react-entry.js loads later, the panel replays the last detail on init.
  let ultimoPainel: Qualquer;
  if (typeof document !== "undefined") document.addEventListener("simpress:painel-atualizado", (evento: Qualquer) => { ultimoPainel = evento.detail; });
  const lerUltimoPainel = () => ultimoPainel;
  return {
    ...ponteRegistrada, ...ponteSincrona,
    inicializarAlertaBaseDesatualizada: () => ponteRegistrada.inicializarAlertaBaseDesatualizada(lerUltimoPainel),
    inicializarAlertasOsDivergencias: () => ponteRegistrada.inicializarAlertasOsDivergencias(lerUltimoPainel),
  };
}
