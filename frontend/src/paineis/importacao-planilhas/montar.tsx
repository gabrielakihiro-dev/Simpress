import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { apiFetch } from "../../api";
import { DialogosImportacao } from "./dialogos";
import { criarImportacaoPlanilhas, type ContextoImportacaoPlanilhas } from "./estado";

// Chamado por frontend/src/main.tsx com o contêiner oculto [data-react-painel="importacao-planilhas"]. Os dois overlays
// (#modal-atualizar-planilhas e #modal-importar-modelo) continuam no partial como cascas; o conteúdo dos modais nasce
// por portal em dialogos.tsx. As ações saem pela ponte de frontend/src/aplicacao/pontes.ts; as duas inicializações
// (preferência do histórico e limpeza da prévia) saem pela ponte assíncrona, porque frontend/src/aplicacao/app.ts as
// chama antes de simpress:react-pronto.
export function montar(container: HTMLElement) {
  const cascaAtualizar = document.getElementById("modal-atualizar-planilhas");
  const cascaModelo = document.getElementById("modal-importar-modelo");
  if (!cascaAtualizar || !cascaModelo) throw new Error("Faltam #modal-atualizar-planilhas e #modal-importar-modelo no HTML.");
  const acoes = criarImportacaoPlanilhas({
    app: window as unknown as ContextoImportacaoPlanilhas["app"],
    appState: window.SimpressApp.state as ContextoImportacaoPlanilhas["appState"],
    apiFetch,
  });
  // flushSync: as ações da ponte e abrirModalAcessivel (que lê o primeiro filho do overlay) rodam logo depois e acham o DOM pronto.
  flushSync(() => {
    createRoot(container).render(
      <DialogosImportacao cascaAtualizar={cascaAtualizar} cascaModelo={cascaModelo} limparPrevia={() => acoes.limparPreviaUploadPlanilhas()} />,
    );
  });
  return acoes;
}
