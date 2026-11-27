import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaPlanilhas } from "./planilhas-loja";

// Sub-aba Planilhas: o esqueleto fica no partial (o fallback sem bundle escreve em #cockpit-sheets-kpis e
// #cockpit-sheets-status); o React só preenche os pontos dinâmicos por portal, com o mesmo DOM que estado.ts criava antes.
export interface AlvosPlanilhas {
  status: HTMLElement; kpis: HTMLElement; corpo: HTMLElement; titulo: HTMLElement; sub: HTMLElement; selo: HTMLElement;
}

const Selo = ({ ok, children }: { ok: boolean; children: string }) => <span className="ck-badge" data-status={ok ? "ok" : "alerta"}>{children}</span>;

export function PainelPlanilhas({ alvos, loja }: { alvos: AlvosPlanilhas; loja: LojaPlanilhas }) {
  const s = useSyncExternalStore(loja.assinar, loja.ler);
  const linhas = s.linhas ?? [];
  const atual = linhas.find(linha => linha.key === s.selecionada);
  const selecionar = (key: string) => loja.atualizar({ selecionada: key });
  let corpo = null;
  if (s.mensagemLista !== null) corpo = <tr><td className="ck-lista__vazio" colSpan={5}>{s.mensagemLista}</td></tr>;
  else if (s.linhas) {
    corpo = linhas.length === 0
      ? <tr><td className="ck-lista__vazio" colSpan={5}>Nenhuma atualização no histórico local.</td></tr>
      : linhas.map(linha => (
        <tr
          key={linha.key}
          tabIndex={0}
          aria-selected={linha.key === s.selecionada}
          onClick={() => selecionar(linha.key)}
          onKeyDown={event => {
            if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            selecionar(linha.key);
          }}
        >
          <td data-label="Planilha">{linha.label}</td>
          <td data-label="Arquivo atual">{linha.file || "—"}</td>
          <td className="ck-td--dir" data-label="Linhas">{linha.total}</td>
          <td data-label="Atualizado">{linha.atualizado}</td>
          <td data-label="Situação"><Selo ok={Boolean(linha.file)}>{linha.situacao}</Selo></td>
        </tr>
      ));
  }
  return (
    <>
      {createPortal(s.status, alvos.status)}
      {createPortal(s.kpis.map(([rotulo, valor]) => (
        <div className="ck-kpi" key={rotulo}><span className="ck-kpi__rotulo">{rotulo}</span><strong className="ck-kpi__valor">{valor}</strong></div>
      )), alvos.kpis)}
      {createPortal(corpo, alvos.corpo)}
      {createPortal(atual ? atual.label : "—", alvos.titulo)}
      {createPortal(atual ? (atual.file || "Arquivo não informado") : "Selecione uma planilha.", alvos.sub)}
      {createPortal(atual ? <Selo ok={Boolean(atual.file)}>{atual.situacao}</Selo> : null, alvos.selo)}
    </>
  );
}
