import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Dialogo } from "./dialogo";
import { abrirModalEditarApelido, fecharModalEditarApelido, salvarApelido } from "./estado";

// Chamado por frontend/src/main.tsx com o .ck-dialogo do #modal-editar-apelido (data-react-painel="editar-apelido").
// As ações são chamadas pelo código antigo pela ponte (static/js/features/equipment-editor.js).
export function montar(container: HTMLElement) {
  const raiz = createRoot(container);
  // Desenha já: o diálogo acessível procura o título (aria-labelledby) e o campo inicial no DOM.
  flushSync(() => raiz.render(<Dialogo />));
  return { abrirModalEditarApelido, fecharModalEditarApelido, salvarApelido };
}
