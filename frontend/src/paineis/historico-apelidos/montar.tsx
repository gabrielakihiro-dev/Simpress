import { desfazerEventoHistoricoApelidos, excluirRegistroHistorico } from "./estado";
import { acoesEventoHistorico, ultimoRegistroPorCampo } from "./historico-apelidos-puro";

// A interface F7 vive no painel ferramentas-cockpit (BF4); este ponto de montagem publica as regras e ações dos registros.
export function montar(_container: HTMLElement) {
  return {
    acoesEventoHistorico,
    ultimoRegistroPorCampo,
    desfazerEventoHistoricoApelidos,
    excluirRegistroHistorico,
  };
}
