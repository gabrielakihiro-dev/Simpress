import { useSyncExternalStore } from "react";
import { IconeLucide } from "../../componentes/icone-lucide";
import { InfoTip } from "../../componentes/info-tip";
import { TEXTO } from "./editar-apelido-puro";
import { assinar, editar, ler } from "./estado";

// Conteúdo de .ck-dialogo do #modal-editar-apelido (frontend/partials/modais.html). Mesmos IDs, classes e ARIA do
// diálogo antigo. Botões mantêm só data-on-click: o despachante de ações (frontend/src/ui/action-dispatcher.ts) chama as ações pela ponte
// (window.salvarApelido etc.), como no dossiê.
export function Dialogo() {
  const { apelido, contexto, salvando } = useSyncExternalStore(assinar, ler);
  return (
    <>
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h3 className="text-base font-bold text-white">Editar apelido <InfoTip rotulo="Sobre Editar apelido" idDica="tip-editar-apelido">O apelido manual prevalece nas próximas exportações do Excel.</InfoTip></h3>
        </div>
        <button type="button" data-on-click="fecharModalEditarApelido" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" aria-label="Fechar">
          <IconeLucide nome="x" className="w-5 h-5" />
        </button>
      </div>
      <label htmlFor="edit-apelido-isolado" className="block text-xs text-fg-tertiary font-semibold mb-1">Novo apelido / hostname</label>
      <input type="text" id="edit-apelido-isolado" value={apelido} onChange={evento => editar(evento.currentTarget.value)}
        className="w-full px-3 py-2.5 rounded-lg glass-input text-white font-mono focus:outline-none" autoComplete="off" />
      <p id="apelido-serial-contexto" className="text-xs text-fg-muted font-mono mt-2">{contexto}</p>
      <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-line-quiet">
        <button type="button" data-on-click="fecharModalEditarApelido" className="ck-btn ck-btn--secundario">Cancelar</button>
        <button type="button" id="btn-salvar-apelido" data-on-click="salvarApelido" disabled={salvando}
          aria-busy={salvando ? "true" : undefined} className="ck-btn ck-btn--primario">
          {salvando ? TEXTO.salvando : TEXTO.salvar}
        </button>
      </div>
    </>
  );
}
