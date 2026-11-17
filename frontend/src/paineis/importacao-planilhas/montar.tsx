import { apiFetch } from "../../api";
import { criarImportacaoPlanilhas, type ContextoImportacaoPlanilhas } from "./estado";

// Chamado por frontend/src/main.tsx com o contêiner oculto [data-react-painel="importacao-planilhas"]. O modal e os
// botões continuam no HTML (partials); aqui só nascem as ações que frontend/src/legado/features/inventory-upload.js chama pela
// ponte. As duas inicializações (preferência do histórico e limpeza da prévia) saem pela ponte assíncrona, porque
// frontend/src/legado/app.js as chama antes de simpress:react-pronto.
export function montar(_container: HTMLElement) {
  return criarImportacaoPlanilhas({
    app: window as unknown as ContextoImportacaoPlanilhas["app"],
    appState: window.SimpressApp.state as ContextoImportacaoPlanilhas["appState"],
    apiFetch,
  });
}
