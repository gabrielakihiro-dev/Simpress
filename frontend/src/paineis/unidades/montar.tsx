import { createRoot } from "react-dom/client";
import {
  abrirModalGerenciarUnidades, carregarUnidades, copiarDadoUnidade, editarUnidade, recarregarUnidadesCockpit,
  salvarUnidadeForm, toggleFormNovaUnidade,
} from "./acoes";
import { CorpoUnidades } from "./corpo";

export function montar(container: HTMLElement) {
  createRoot(container).render(<CorpoUnidades />);
  return {
    carregarUnidades, abrirModalGerenciarUnidades, copiarDadoUnidade, editarUnidade,
    toggleFormNovaUnidade, salvarUnidadeForm, recarregarUnidadesCockpit,
  };
}
