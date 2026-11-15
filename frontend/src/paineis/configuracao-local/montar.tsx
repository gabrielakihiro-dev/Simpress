import { createRoot } from "react-dom/client";
import {
  abrirConfiguracaoLocal, fecharConfiguracaoLocal, removerChaveAssistenteConfiguracaoLocal, salvarAssistenteConfiguracaoLocal,
  salvarClienteConfiguracaoLocal, salvarContasConfiguracaoLocal, salvarLinksConfiguracaoLocal,
} from "./acoes";
import { CorpoConfiguracao } from "./corpo";

export function montar(container: HTMLElement) {
  createRoot(container).render(<CorpoConfiguracao />);
  return {
    abrirConfiguracaoLocal, fecharConfiguracaoLocal,
    salvarContasConfiguracaoLocal, salvarLinksConfiguracaoLocal,
    salvarClienteConfiguracaoLocal, salvarAssistenteConfiguracaoLocal,
    removerChaveAssistenteConfiguracaoLocal,
  };
}
