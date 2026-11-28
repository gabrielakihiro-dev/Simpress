import { Fragment, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { LojaMestre, SeloMestre } from "./lojas";

// Itens da lista mestre de cada sub-aba do F5 (#sebrae-<aba>-mestre): o <ul> fica no partial e o React põe os <li> por portal,
// a partir dos dados que atualizarMestre (estado.ts) grava. Clique, Voltar e foco seguem em estado.ts (instalarMestre).
// As props seguem a ordem em que o código antigo punha os atributos, para o DOM sair igual. A key nova a cada chamada recria os
// nós, como o replaceChildren fazia.

function Selo({ selo }: { selo: SeloMestre }) {
  if (selo.estrela) return <span className="sebrae-mestre__estrela" role="img" aria-label="Destaque" data-status={selo.status || undefined} title={selo.title || undefined}>★</span>;
  return <span className={selo.classe} data-status={selo.status || undefined} title={selo.title || undefined} data-nl-tom={selo.tom || undefined}>{selo.texto}</span>;
}

export function ListasMestre({ alvos, loja }: { alvos: Record<string, HTMLElement>; loja: LojaMestre }) {
  const { listas, versao } = useSyncExternalStore(loja.assinar, loja.ler);
  return Object.entries(alvos).map(([aba, alvo]) => createPortal(
    <Fragment key={versao}>
      {(listas[aba] || []).map(({ numero, titulo, quem, selos, selecionado, tom, quando, achado, osDecidir }, i) => (
        <li key={i} className="sebrae-mestre__item">
          <button type="button" className="sebrae-mestre__botao" data-sebrae-mestre={numero} aria-current={selecionado ? "true" : undefined} data-tom={tom || undefined} data-os-decidir={osDecidir || undefined}>
            <span className="sebrae-mestre__num">{numero}</span>
            <span className="sebrae-mestre__selos">{selos.map((selo, j) => <Selo key={j} selo={selo} />)}</span>
            <span className="sebrae-mestre__titulo">{titulo}</span>
            <span className="sebrae-mestre__quem">{quem}</span>
            {quando ? <span className="sebrae-mestre__quando">{quando}</span> : null}
            {achado ? <span className="sebrae-mestre__achado">{achado}</span> : null}
          </button>
        </li>
      ))}
    </Fragment>,
    alvo,
    aba,
  ));
}
