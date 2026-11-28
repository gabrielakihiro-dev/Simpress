import { Fragment, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaDestaques } from "./lojas";

// Avisos dos destaques do F5: o anúncio de marcar/tirar (#sebrae-destaque-anuncio, fora da seção, que pode estar escondida) e o
// resumo da aba Destaques (#sebrae-destaques-resumo, erro do GET de destaques). Os dois parágrafos ficam no partial; o React só
// põe o texto por portal. A key nova a cada chamada troca o nó de texto mesmo com o texto igual, para o leitor de tela repetir.
export interface AlvosDestaques { anuncio: HTMLElement; resumo: HTMLElement }

export function AvisosDestaques({ alvos, loja }: { alvos: AlvosDestaques; loja: LojaDestaques }) {
  const { anuncio, resumo, versaoAnuncio, versaoResumo } = useSyncExternalStore(loja.assinar, loja.ler);
  return (
    <>
      {createPortal(<Fragment key={versaoAnuncio}>{anuncio}</Fragment>, alvos.anuncio)}
      {createPortal(<Fragment key={versaoResumo}>{resumo}</Fragment>, alvos.resumo)}
    </>
  );
}
