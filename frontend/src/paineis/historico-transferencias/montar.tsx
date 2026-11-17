import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DialogoHistorico } from "./dialogo";
import { abrirModalHistoricoTransferencias, fecharModalHistoricoTransferencias } from "./estado";
import { registrarOuvinteTransferencia } from "./vinculo";

// Chamado por frontend/src/main.tsx com o .ck-dialogo (data-react-painel="historico-transferencias") de
// #modal-historico-transferencias. A planilha gerada vira histórico e vínculo com a Cobertura (vinculo.ts), com ou sem
// o diálogo aberto; a Cobertura importa pendenciaSemVinculo e tentarVincularDeNovo do mesmo arquivo.
// No topo do módulo (roda na importação): o ouvinte de simpress:transfer-generated não pode depender do diálogo nem de
// o elemento [data-react-painel] existir, senão a planilha gerada não entra no histórico.
registrarOuvinteTransferencia();

export function montar(container: HTMLElement) {
  // data-on-click chama window[nome] na hora do clique; o botão #btn-historico-transferencias (Transporte) também.
  // Publicadas antes do render, como no legado: um erro ao desenhar não deixa o botão sem ação.
  Object.assign(window, { abrirModalHistoricoTransferencias, fecharModalHistoricoTransferencias });
  // These actions are not feature actions, so data-on-* needs them on the dispatcher's closed list.
  window.SimpressActionDispatcher?.allow(["abrirModalHistoricoTransferencias", "fecharModalHistoricoTransferencias"]);
  flushSync(() => { createRoot(container).render(<DialogoHistorico />); });
  return { abrirModalHistoricoTransferencias, fecharModalHistoricoTransferencias };
}
