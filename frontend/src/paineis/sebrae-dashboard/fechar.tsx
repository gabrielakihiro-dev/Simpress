import { Fragment, useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaFechar } from "./lojas";

// Resultado do Atualizar/Fechar do F5 (#sebrae-fechar): o esqueleto fica no partial; o React preenche por portal o status e
// a lista, e põe hidden e aria-busy por efeito, na mesma ordem em que renderizarFechar os punha.
export interface AlvosFechar { bloco: HTMLElement; status: HTMLElement; lista: HTMLElement }

export function ResultadoFechar({ alvos, loja }: { alvos: AlvosFechar; loja: LojaFechar }) {
  const { status, ocupado, itens, versao } = useSyncExternalStore(loja.assinar, loja.ler);
  useLayoutEffect(() => {
    if (!versao) return; // nunca desenhado: o partial fica como veio (sem aria-busy)
    // Só o estado final de várias chamadas seguidas é aplicado. A ordem hidden/aria-busy fica igual à de antes porque nenhum
    // caminho de estado.ts chama com status preenchido e depois vazio no mesmo turno; quem fizer isso muda a ordem dos atributos.
    alvos.bloco.hidden = !status;
    alvos.bloco.setAttribute("aria-busy", ocupado ? "true" : "false");
  }, [alvos, status, ocupado, versao]);
  return (
    <>
      {/* key nova a cada chamada: o texto da região role=status é reescrito mesmo igual, como o textContent fazia */}
      {createPortal(<Fragment key={versao}>{status}</Fragment>, alvos.status)}
      {createPortal(itens.map((item, i) => <li key={i} className="sebrae-fechar__item" data-status={item.status}>{item.texto}</li>), alvos.lista)}
    </>
  );
}
