import { apiFetch } from "../../api";
import { criarContatosRegionais, type ContextoContatosRegionais } from "./estado";

export function montar(_container: HTMLElement) {
  const acoes = criarContatosRegionais({
    app: window as unknown as ContextoContatosRegionais["app"],
    transferUtils: window.SimpressTransferUtils,
    apiFetch,
  });
  void acoes.carregarConfiguracaoTransferencia();
  acoes.popularSeletoresRepresentantesRegionais();
  void acoes.carregarRepresentantesRegionais();
  acoes.inicializarMascarasTelefone();
  const almocoEntrega = document.getElementById("entrega-almoco");
  almocoEntrega?.addEventListener("input", acoes.atualizarObrigatoriedadeDuracaoPausaEntrega);
  almocoEntrega?.addEventListener("change", acoes.atualizarObrigatoriedadeDuracaoPausaEntrega);
  acoes.atualizarObrigatoriedadeDuracaoPausaEntrega();
  return acoes;
}
