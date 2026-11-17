import { memo, useSyncExternalStore } from "react";
import { IconeLucide } from "../../componentes/icone-lucide";
import { InfoTip } from "../../componentes/info-tip";
import {
  ID_FILTRO, ID_LISTA, agendarBusca, assinar, copySerial, duplicateDestination, ler, type Estado,
} from "./estado";
import { formatDateTime, routeLabel, type ItemHistorico } from "./historico-transferencias-puro";

const COLUNAS = ["Data e hora", "Série", "Origem → Destino", "Destinatário", "Observações", "Ações"];

function Acoes({ item, classe }: { item: ItemHistorico; classe: string }) {
  return (
    <div className={classe}>
      <button type="button" className="ticket-template-view" data-copy-field="serie" onClick={() => { void copySerial(item); }}>
        Copiar série
      </button>
      <button type="button" className="ticket-template-view" onClick={() => duplicateDestination(item)}>
        Duplicar destino
      </button>
    </div>
  );
}

// A tabela e os cartões só se redesenham numa busca nova (muda `itens`): data-panels.js troca o texto dos cabeçalhos
// por botões de ordenação e reordena as linhas por fora do React, então um redesenho a mais desfaria isso.
const Tabela = memo(function Tabela({ itens, carga }: { itens: ItemHistorico[]; carga: number }) {
  return (
    <>
      <div
        key={`tabela-${carga}`}
        className="accessible-table-wrap comparison-desktop-table rounded-lg border border-line-quiet"
        role="region"
        aria-label="Tabela de transferências geradas"
        tabIndex={0}
      >
        <table className="min-w-full text-left text-sm" aria-label="Transferências geradas">
          <thead className="bg-surface text-fg-tertiary">
            <tr>
              {COLUNAS.map(nome => (
                <th key={nome} scope="col" className="px-3 py-2.5 font-semibold whitespace-nowrap">{nome}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-quiet">
            {itens.map((item, indice) => (
              <tr key={indice}>
                <td className="px-3 py-2">{formatDateTime(item.criado_em)}</td>
                <td className="px-3 py-2 font-mono whitespace-nowrap">
                  {item.serial}
                  {item.nome_pessoa ? <span className="block font-sans text-xs text-fg-subtle">{item.nome_pessoa}</span> : null}
                </td>
                <td className="px-3 py-2">{routeLabel(item)}</td>
                <td className="px-3 py-2">{item.entrega_contato || "—"}</td>
                <td className="px-3 py-2">{item.entrega_obs || "—"}</td>
                <td className="px-3 py-2"><Acoes item={item} classe="flex flex-wrap gap-2" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div key={`cartoes-${carga}`} className="comparison-mobile-list" role="list" aria-label="Transferências geradas em cartões">
        {itens.map((item, indice) => (
          <article key={indice} className="comparison-mobile-card" role="listitem">
            <h5 className="comparison-mobile-card-title">{`${item.serial} · ${formatDateTime(item.criado_em)}`}</h5>
            <dl className="comparison-mobile-card-fields">
              <div className="comparison-mobile-card-field"><dt>Origem → Destino</dt><dd>{routeLabel(item)}</dd></div>
              <div className="comparison-mobile-card-field"><dt>Destinatário</dt><dd>{item.entrega_contato || "—"}</dd></div>
              <div className="comparison-mobile-card-field"><dt>Observações</dt><dd>{item.entrega_obs || "—"}</dd></div>
              {item.nome_pessoa ? <div className="comparison-mobile-card-field"><dt>Pessoa</dt><dd>{item.nome_pessoa}</dd></div> : null}
            </dl>
            <Acoes item={item} classe="flex flex-wrap gap-2 mt-3" />
          </article>
        ))}
      </div>
    </>
  );
});

function Conteudo({ estado }: { estado: Estado }) {
  const { fase, carga, mensagem, itens } = estado;
  if (fase === "carregando") {
    return <p key={`carregando-${carga}`} className="text-sm text-center py-8 text-fg-subtle" role="status">Carregando histórico…</p>;
  }
  if (fase === "mensagem") {
    const alerta = mensagem.papel === "alert";
    return (
      <p key={`mensagem-${carga}`} className={`text-sm text-center py-8 ${alerta ? "text-rose-300" : "text-fg-subtle"}`} role={mensagem.papel}>
        {mensagem.texto}
      </p>
    );
  }
  if (fase === "lista") return <Tabela itens={itens} carga={carga} />;
  return null;
}

// Conteúdo de .ck-dialogo dentro de #modal-historico-transferencias (o veu continua no partial modais.html).
// O id do título (modal-historico-transferencias-titulo) e os atributos do diálogo vêm de abrirModalAcessivel.
export function DialogoHistorico() {
  const estado = useSyncExternalStore(assinar, ler);
  return (
    <>
      <div className="flex items-center justify-between pb-4 border-b border-line-quiet">
        <div className="flex items-center space-x-2.5">
          <IconeLucide nome="history" className="w-5 h-5 text-brand-400" />
          <h3 className="text-base font-bold text-white">
            {"Transferências geradas "}
            <InfoTip rotulo="Sobre Transferências geradas" idDica="tip-transferencias-geradas">
              {"Guardado somente neste computador. \"Duplicar destino\" não altera o equipamento selecionado."}
            </InfoTip>
          </h3>
        </div>
        <button
          type="button"
          data-on-click="fecharModalHistoricoTransferencias"
          className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm"
          aria-label="Fechar transferências geradas"
        >
          <IconeLucide nome="x" className="w-5 h-5" />
        </button>
      </div>
      <div className="pt-4 shrink-0">
        <label htmlFor={ID_FILTRO} className="block text-xs font-semibold text-fg-tertiary mb-1">
          Buscar por série, cidade, destinatário ou observação
        </label>
        <input
          type="search"
          id={ID_FILTRO}
          autoComplete="off"
          className="w-full px-3.5 py-2.5 rounded-lg glass-input text-sm text-fg-emphasis focus:outline-none"
          placeholder="Ex.: BRJ5512FGD ou Londrina"
          onInput={agendarBusca}
        />
        <p id="historico-transferencias-status" className="text-xs text-fg-subtle mt-2" role="status" aria-live="polite">{estado.status}</p>
      </div>
      <div id={ID_LISTA} className="overflow-y-auto flex-1 min-h-0 py-3" aria-label="Transferências geradas">
        <Conteudo estado={estado} />
      </div>
      <div className="pt-3 border-t border-line-quiet flex items-center justify-end gap-3 shrink-0">
        <button type="button" data-on-click="fecharModalHistoricoTransferencias" className="ck-btn ck-btn--secundario">Fechar</button>
      </div>
    </>
  );
}
