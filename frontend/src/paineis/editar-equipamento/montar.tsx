import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Dialogo } from "./dialogo";
import { abrirModalEditarEquipamento, cadastrarNovoSerial, fecharModalEditarEquipamento, salvarDadosEquipamento } from "./estado";

// Chamado por frontend/src/main.tsx com o .ck-dialogo do #modal-editar-equipamento (data-react-painel="editar-equipamento").
// As ações são chamadas pelo código antigo pela ponte (frontend/src/legado/features/equipment-editor.js); cadastrarNovoSerial
// só a ponte usa (cadastrarNovoSerialPesquisado) e não vira função global.
export function montar(container: HTMLElement) {
  const raiz = createRoot(container);
  // Desenha já: o diálogo acessível procura o título (aria-labelledby) e o campo inicial no DOM.
  flushSync(() => raiz.render(<Dialogo />));
  return { abrirModalEditarEquipamento, cadastrarNovoSerial, fecharModalEditarEquipamento, salvarDadosEquipamento };
}
