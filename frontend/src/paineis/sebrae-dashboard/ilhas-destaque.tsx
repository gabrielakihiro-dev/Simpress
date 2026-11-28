import { Fragment, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { IlhasDestaque, LojaCartoesDestaque } from "./lojas";

// Destaque manual do F5 em React: (1) ilhas dentro dos hosts que estado.ts cria nos cartões imperativos (o `hidden` do host é só de
// estado.ts) e (2) os cartões da aba Destaques (#sebrae-destaques-lista). Uma raiz só; um portal por host, com key estável.
// O cartão da aba nunca recebe `hidden`, `open` nem `data-sebrae-aberto`: aplicarVisao e definirAberta mexem neles.
type Definir = (texto: string, situacao: string) => void;

function Estrela() {
  return <><span className="sebrae-selo-destaque__estrela" aria-hidden="true">★</span>Destaque</>;
}

function Bloco({ numero, ligado, ilhas }: { numero: string; ligado: boolean; ilhas: IlhasDestaque }) {
  const [feedback, setFeedback] = useState({ texto: "", situacao: "" });
  const definir: Definir = (texto, situacao) => setFeedback({ texto, situacao });
  return (
    <>
      <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm sebrae-destaque__botao" data-sebrae-destaque={numero} aria-pressed={ligado}
        onClick={evento => ilhas.aoAlternar(numero, evento.currentTarget, definir)}>{ligado ? "Tirar destaque" : "Marcar destaque"}</button>
      <p className="ck-campo__ajuda sebrae-destaque__feedback" role="status" data-estado={feedback.situacao}>{feedback.texto}</p>
    </>
  );
}

// Cada host registrado ganha um id estável (WeakMap) para a key do portal não recriar o nó a cada desenho.
const ids = new WeakMap<HTMLElement, number>();
let proximo = 0;
const idDe = (host: HTMLElement) => { if (!ids.has(host)) ids.set(host, ++proximo); return ids.get(host); };

export function DestaquesReact({ ilhas, cartoes: lojaCartoes, lista }: { ilhas: IlhasDestaque; cartoes: LojaCartoesDestaque; lista: HTMLElement }) {
  const { hosts, ligados } = useSyncExternalStore(ilhas.loja.assinar, ilhas.loja.ler);
  const { cartoes, versao } = useSyncExternalStore(lojaCartoes.assinar, lojaCartoes.ler);
  return (
    <>
      {hosts.map(({ host, tipo, numero }) => createPortal(
        tipo === "selo" ? <Estrela /> : <Bloco numero={numero} ligado={Boolean(ligados[numero])} ilhas={ilhas} />,
        host,
        String(idDe(host)),
      ))}
      {createPortal(
        <Fragment key={versao}>
          {cartoes.map(({ numero, titulo, fatos, observacao }) => (
            <div key={numero} className="sebrae-chamado sebrae-chamado--resumo sebrae-chamado--destaque" data-sebrae-destaque-cartao={numero}>
              <header className="sebrae-chamado__cab">
                <h3 className="sebrae-chamado__titulo">{numero}{titulo ? <>{" · "}<span className="sebrae-chamado__assunto">{titulo}</span></> : null}</h3>
                <span className="ck-badge sebrae-selo-destaque" data-status="alerta" data-sebrae-destaque-selo={numero}><Estrela /></span>
              </header>
              <div className="sebrae-destaque__corpo">
                {fatos.length ? <dl className="ck-fatos sebrae-chamado__auto">{fatos.map(([rotulo, valor]) => <div key={rotulo}><dt>{rotulo}</dt><dd>{valor}</dd></div>)}</dl> : null}
                <div className="sebrae-destaque__observacao">
                  <span className="ck-campo__rotulo">Observação do andamento</span>
                  <p className="sebrae-destaque__texto">{observacao || "—"}</p>
                </div>
                <div className="sebrae-destaque__acao"><Bloco numero={numero} ligado={Boolean(ligados[numero])} ilhas={ilhas} /></div>
              </div>
            </div>
          ))}
        </Fragment>,
        lista,
        "lista",
      )}
    </>
  );
}
