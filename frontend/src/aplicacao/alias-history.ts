/** The F7 history screen remains legacy; all record rules and actions are owned by the React panel. */
import { registrarRejeicoes } from "./pontes.ts";
import type { Acoes, ContextoApp } from "./tipos.ts";

export function createAliasHistory(context: ContextoApp): Acoes {
  const ponteSinc = context.ponteReactSincrona("historico-apelidos", [
    "acoesEventoHistorico", "ultimoRegistroPorCampo",
  ]);
  const ponte = context.ponteReact("historico-apelidos", [
    "desfazerEventoHistoricoApelidos", "excluirRegistroHistorico",
  ]);
  const ponteRegistrada = registrarRejeicoes(ponte);
  // Sem o painel, a F7 continua listando o histórico, só sem Restaurar/Excluir.
  return {
    acoesEventoHistorico: (...argumentos: unknown[]) => ponteSinc.acoesEventoHistorico(...argumentos) ?? {},
    ultimoRegistroPorCampo: (...argumentos: unknown[]) => ponteSinc.ultimoRegistroPorCampo(...argumentos) ?? new Map(),
    ...ponteRegistrada,
  };
}
