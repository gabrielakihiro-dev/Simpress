import { useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaAvisos, LojaRascunho } from "./lojas";

// Avisos dos novos (#sebrae-novos-avisos, vazio no partial): o React é dono do conteúdo inteiro, com o mesmo DOM de antes.
export function AvisosNovos({ alvo, loja }: { alvo: HTMLElement; loja: LojaAvisos }) {
  const { itens } = useSyncExternalStore(loja.assinar, loja.ler);
  return createPortal(itens.length ? (
    <>
      <p className="ck-campo__ajuda">Sem formulário (veja os motivos):</p>
      <ul className="sebrae-avisos">{itens.map((texto, i) => <li key={i} className="ck-cartao__meta">{texto}</li>)}</ul>
    </>
  ) : null, alvo);
}

// Rascunho (#sebrae-rascunho): o esqueleto fica no partial; o React preenche por portal o status, o "Ver detalhes (N)" e
// os itens, e põe hidden, data-estado e o recolher da lista por efeito, na mesma ordem em que mostrarRascunho os punha.
export interface AlvosRascunho { bloco: HTMLElement; status: HTMLElement; caixa: HTMLDetailsElement; resumo: HTMLElement; itens: HTMLElement }

export function Rascunho({ alvos, loja }: { alvos: AlvosRascunho; loja: LojaRascunho }) {
  const { texto, situacao, detalhes, versao } = useSyncExternalStore(loja.assinar, loja.ler);
  useLayoutEffect(() => {
    if (!versao) return; // nunca mostrado: o partial fica como veio (sem data-estado)
    alvos.bloco.hidden = !texto;
    alvos.bloco.dataset.estado = situacao;
    alvos.caixa.hidden = !detalhes.length;
  }, [alvos, texto, situacao, detalhes, versao]);
  // Lista recolhida: cada mostrarRascunho a fecha de novo, mesmo com o mesmo conteúdo.
  useLayoutEffect(() => { if (versao) alvos.caixa.open = false; }, [alvos, versao]);
  return (
    <>
      {createPortal(texto, alvos.status)}
      {createPortal(versao ? `Ver detalhes (${detalhes.length})` : "", alvos.resumo)}
      {createPortal(detalhes.map((item, i) => (typeof item === "string"
        ? <li key={i}>{item}</li>
        : <li key={i}><b>{item.numero}</b>{item.campos.map(([letra, valor], j) => <span key={j}>{`${letra} ${valor}`}</span>)}</li>)), alvos.itens)}
    </>
  );
}
