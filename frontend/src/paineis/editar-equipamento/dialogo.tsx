import { useSyncExternalStore } from "react";
import { IconeLucide } from "../../componentes/icone-lucide";
import { InfoTip } from "../../componentes/info-tip";
import { TEXTO, TIPOS } from "./editar-equipamento-puro";
import { assinar, editar, ler } from "./estado";

// Conteúdo de .ck-dialogo do #modal-editar-equipamento (frontend/partials/modais.html). Mesmos IDs, classes e ARIA do
// diálogo antigo. Botões mantêm só data-on-click: o despachante do código antigo chama as ações pela ponte
// (window.salvarDadosEquipamento etc.), como no dossiê.
export function Dialogo() {
  const { titulo, badge, serial, somenteLeitura, modelo, tipo, apelido, idCliente, apelidoOculto, salvando } = useSyncExternalStore(assinar, ler);
  return (
    <>
      <div className="flex items-center justify-between pb-4 border-b border-line-quiet shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-brand-500/10 border border-brand-500/30 flex items-center justify-center text-brand-400">
            <IconeLucide nome="edit" className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <span id="modal-edit-titulo">{titulo}</span>
              <span id="modal-edit-serial-badge" className="px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-brand-500/20 text-brand-300 border border-brand-500/30">{badge}</span>
              <InfoTip rotulo="Sobre Atualizar Dados do Equipamento" idDica="tip-editar-equipamento">
                As alterações serão salvas no site e gravadas diretamente na planilha oficial Excel. Grava no arquivo Excel físico e atualiza a tela na hora. Endereço, cidade, UF, CEP e CNPJ são carregados automaticamente da planilha da Simpress ao atualizar as planilhas.
              </InfoTip>
            </h3>
          </div>
        </div>
        <button type="button" data-on-click="fecharModalEditarEquipamento" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" aria-label="Fechar edição do equipamento">
          <IconeLucide nome="x" className="w-5 h-5" />
        </button>
      </div>

      <div className="py-4 overflow-y-auto flex-1 space-y-4 pr-1">
        <div className="bg-surface/60 p-4 rounded-xl border border-line-quiet/80 space-y-3">
          <h4 className="text-xs font-bold text-brand-400 uppercase tracking-wider flex items-center gap-1.5">
            <IconeLucide nome="cpu" className="w-3.5 h-3.5" />
            <span>Identificação do Equipamento</span>
          </h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label htmlFor="edit-serial" className="block text-fg-tertiary font-semibold mb-1">Número de Série:</label>
              <input type="text" id="edit-serial" value={serial} readOnly={somenteLeitura}
                onChange={evento => editar("serial", evento.currentTarget.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-white font-mono uppercase font-bold focus:outline-none" />
            </div>
            <div>
              <label htmlFor="edit-tipo" className="block text-fg-tertiary font-semibold mb-1">Tipo de Equipamento:</label>
              <select id="edit-tipo" value={tipo} onChange={evento => editar("tipo", evento.currentTarget.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-white focus:outline-none">
                {TIPOS.map(opcao => <option key={opcao} value={opcao}>{opcao}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="edit-modelo" className="block text-fg-tertiary font-semibold mb-1">Modelo do Hardware:</label>
              <input type="text" id="edit-modelo" placeholder="Ex: HP EB 6 G1I" value={modelo}
                onChange={evento => editar("modelo", evento.currentTarget.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-fg-secondary focus:outline-none" />
            </div>
            <div id="edit-apelido-field" className={apelidoOculto ? "hidden" : undefined}>
              <div className="flex items-center gap-1 mb-1">
                <label htmlFor="edit-apelido" className="block text-fg-tertiary font-semibold">Apelido / Hostname:</label>
                <InfoTip rotulo="Sobre Apelido / Hostname" idDica="tip-editar-apelido-campo" fim>
                  Para equipamentos existentes, altere o apelido pelo botão próprio no cartão.
                </InfoTip>
              </div>
              <input type="text" id="edit-apelido" placeholder="Ex: PRNOTEDIREX007" value={apelido}
                onChange={evento => editar("apelido", evento.currentTarget.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-fg-secondary font-mono focus:outline-none" />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="edit-id-cliente" className="block text-fg-tertiary font-semibold mb-1">Id Cliente / Observação de Uso:</label>
              <input type="text" id="edit-id-cliente" placeholder="Ex: Note diretoria Tipo 2" value={idCliente}
                onChange={evento => editar("idCliente", evento.currentTarget.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-fg-secondary focus:outline-none" />
            </div>
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-line-quiet flex justify-end items-center shrink-0">
        <div className="flex space-x-2">
          <button type="button" data-on-click="fecharModalEditarEquipamento"
            className="px-4 py-2 rounded-lg bg-surface-control hover:bg-surface-control-hover text-fg-tertiary text-xs transition">
            Cancelar
          </button>
          <button type="button" id="btn-salvar-equipamento" data-on-click="salvarDadosEquipamento"
            disabled={salvando} aria-busy={salvando ? "true" : undefined}
            className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs flex items-center space-x-1.5 shadow-glow-emerald transition">
            <IconeLucide nome={salvando ? "loader-2" : "check"} className={salvando ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
            <span>{salvando ? TEXTO.salvando : TEXTO.salvar}</span>
          </button>
        </div>
      </div>
    </>
  );
}
