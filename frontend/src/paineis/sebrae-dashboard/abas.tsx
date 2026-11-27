import { Fragment, useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaAbas } from "./lojas";

// Contagens das sub-abas do F5 e resultado do filtro: o React escreve o número de cada aba e o texto do filtro por portal,
// e põe aria-label, data-zero e o selo âmbar de Destaques por efeito. aria-selected e tabindex (a aba escolhida) seguem
// em aplicarVisao (estado.ts).
export interface AlvosAbas { abas: Record<string, { botao: HTMLElement; contagem: HTMLElement }>; resultado: HTMLElement }

export function ContagensAbas({ alvos, loja }: { alvos: AlvosAbas; loja: LojaAbas }) {
  const { abas, resultado, versao } = useSyncExternalStore(loja.assinar, loja.ler);
  useLayoutEffect(() => {
    if (!abas) return;
    for (const [aba, { botao }] of Object.entries(alvos.abas)) {
      if (!abas[aba]) continue; // aba sem número na loja: o botão fica como estava
      const { n, rotulo } = abas[aba];
      botao.setAttribute("aria-label", rotulo);
      if (n) botao.removeAttribute("data-zero");
      else botao.setAttribute("data-zero", "");
    }
    // selo âmbar segue o número exibido na aba (com filtro, o que bateu), como no artefato aprovado
    const destaques = alvos.abas.destaques.contagem;
    if ((abas.destaques?.n ?? 0) > 0) destaques.setAttribute("data-status", "alerta");
    else destaques.removeAttribute("data-status");
  }, [alvos, abas]);
  return (
    <>
      {Object.entries(alvos.abas).map(([aba, { contagem }]) => createPortal(String(abas?.[aba]?.n ?? 0), contagem, aba))}
      {/* key nova a cada aplicarVisao: o texto da região role=status é trocado mesmo igual, como o textContent fazia */}
      {createPortal(<Fragment key={versao}>{resultado}</Fragment>, alvos.resultado)}
    </>
  );
}
