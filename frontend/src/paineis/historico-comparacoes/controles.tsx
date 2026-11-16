import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { assinar, escolherData, ler } from "./estado";
import { rotuloDataExportacao } from "./historico-puro";

// Conteúdo do botão Exportar. Fica fora do JSX porque lucide.createIcons troca cada <i data-lucide> por um <svg>:
// o React não pode atualizar nem remover esses nós depois da troca (ver relatorio-mensal/formulario.tsx).
const CONTEUDO_EXPORTAR = '<i data-lucide="download" class="w-4 h-4" aria-hidden="true"></i><span class="hidden sm:inline">Exportar Excel</span>';
const CONTEUDO_EXPORTANDO = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin" aria-hidden="true"></i><span class="hidden sm:inline">Exportando...</span>';

function BotaoExportar() {
  const { exportando, dataEscolhida } = useSyncExternalStore(assinar, ler);
  const botao = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!botao.current) return;
    botao.current.innerHTML = exportando ? CONTEUDO_EXPORTANDO : CONTEUDO_EXPORTAR;
    window.lucide?.createIcons({ root: botao.current });
  }, [exportando]);
  return (
    <button
      ref={botao}
      type="button"
      id="btn-exportar-historico-comparacoes"
      data-on-click="exportarHistoricoComparacoesExcel"
      className="btn btn-secondary gap-2 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
      aria-label="Exportar o histórico da data selecionada para Excel"
      title="Baixar os registros e as anotações da data selecionada"
      disabled={exportando || !dataEscolhida}
      aria-busy={exportando || undefined}
    />
  );
}

function SeletorData() {
  const { datas, dataEscolhida, mensagemDatas } = useSyncExternalStore(assinar, ler);
  return (
    <div className="flex flex-col gap-1 shrink-0">
      <label htmlFor="data-exportar-historico-comparacoes" className="text-xs text-fg-tertiary">
        Data para exportar
        <select
          id="data-exportar-historico-comparacoes"
          aria-label="Selecionar a data do histórico para exportar"
          className="mt-1 block min-w-36 rounded-lg border border-line-control bg-surface px-3 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          disabled={mensagemDatas !== null}
          value={mensagemDatas !== null ? "" : dataEscolhida}
          onChange={evento => escolherData(evento.target.value)}
        >
          {mensagemDatas !== null
            ? <option value="">{mensagemDatas}</option>
            : datas.map(data => <option key={data} value={data}>{rotuloDataExportacao(data)}</option>)}
        </select>
      </label>
    </div>
  );
}

// Mesmo HTML do bloco de controles do cabeçalho do diálogo antigo; o título e o contador ficam no partial.
export function ControlesHistorico() {
  return (
    <>
      <SeletorData />
      <div className="flex items-center gap-2">
        <BotaoExportar />
        <button
          type="button"
          data-on-click="fecharModalHistoricoComparacoes"
          className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm"
          aria-label="Fechar histórico de planilhas"
        >
          <i data-lucide="x" className="w-5 h-5"></i>
        </button>
      </div>
    </>
  );
}
