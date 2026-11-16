import { desfazerEventoHistoricoApelidos, excluirRegistroHistorico } from "./estado";
import { acoesEventoHistorico, ultimoRegistroPorCampo } from "./historico-apelidos-puro";

// A interface F7 fica no painel antigo até o BF4; este ponto de montagem publica suas regras e ações.
export function montar(_container: HTMLElement) {
  return {
    acoesEventoHistorico,
    ultimoRegistroPorCampo,
    desfazerEventoHistoricoApelidos,
    excluirRegistroHistorico,
  };
}
