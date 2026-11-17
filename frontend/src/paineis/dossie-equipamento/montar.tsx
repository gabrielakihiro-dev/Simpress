import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Dialogo } from "./dialogo";
import { abrirDossieEquipamento, atualizarDossieEquipamento, fecharDossieEquipamento } from "./estado";

// Chamado por frontend/src/main.tsx com o .ck-dialogo do #modal-dossie-equipamento (data-react-painel="dossie-equipamento").
// As três ações são chamadas pela aplicação pela ponte (frontend/src/aplicacao/equipment-dossier.ts).
export function montar(container: HTMLElement) {
  const raiz = createRoot(container);
  // Desenha já: o diálogo acessível procura o título (aria-labelledby) e o botão Fechar no DOM.
  flushSync(() => raiz.render(<Dialogo />));
  return { abrirDossieEquipamento, fecharDossieEquipamento, atualizarDossieEquipamento };
}
