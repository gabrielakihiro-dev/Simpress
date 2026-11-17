import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { apiFetch } from "../../api";
import {
  chipsSinais, corpoAceitar, corpoRecusar, explicacaoCaixa, notaAceita, notaRecusada, notaTroca, rotuloAceitar, rotuloRecusar,
  seloOs, textoOuIndisponivel, tituloCaixa, URL_VINCULOS_OS, urlOsRecusada,
} from "./sugestao-os-modelo";
import type { DecisaoOs, OsNova, SugestaoOsPainel, TextosOs } from "./tipos";

// "OS nova sugerida" no cartão aberto de um chamado antigo do F5 (visual aprovado em 17/11/2026; CSS em static/styles/ck-cockpit.css,
// classes `.sebrae-osnova*`). O código imperativo de estado.ts só cria o host `<div data-sugestao-os>` e chama `montar`; nunca
// escreve dentro dele. Aceitar grava o vínculo manual (PUT vinculos-os); Recusar e Manter gravam o par chamado + OS em
// `sebrae_os_recusadas.json`. Depois da gravação o F5 recarrega pelo `recarregar` que estado.ts entrega, e o resultado fica guardado
// aqui para a nota aparecer no host novo mesmo com `os_nova` já vazio.

const raizes = new Map<string, { raiz: Root; host: HTMLElement }>();
const decisoes = new Map<string, DecisaoOs>();

const CABECALHO_JSON = { "Content-Type": "application/json" };

function Icone({ ok }: { ok: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={ok ? "M20 6 9 17l-5-5" : "M6 12h12"} />
    </svg>
  );
}

function CartaoOs({ texto, selo, destaque, serie }: { texto: TextosOs; selo: string; destaque: boolean; serie?: string }) {
  return (
    <div className={`sebrae-osnova__os${destaque ? " sebrae-osnova__os--nova" : ""}`}>
      <div className="sebrae-osnova__os-cab">
        <strong className="sebrae-osnova__os-num">{texto.os}</strong>
        <span className="sebrae-osnova__os-selo">{selo}</span>
      </div>
      <dl className="sebrae-osnova__os-dados">
        {serie ? <div><dt>Série da OS</dt><dd className="ck-num">{serie}</dd></div> : null}
        <div><dt>Assunto</dt><dd>{textoOuIndisponivel(texto.assunto)}</dd></div>
        <div><dt>Descrição</dt><dd>{textoOuIndisponivel(texto.descricao)}</dd></div>
      </dl>
    </div>
  );
}

/** `foco`: só a nota que acabou de nascer de um clique leva o foco (os botões que o tinham somem). */
function Nota({ tipo, texto, foco = false }: { tipo: "ok" | "neutro"; texto: string; foco?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (foco) ref.current?.focus(); }, [foco]);
  return (
    <p ref={ref} className="sebrae-osnova__nota" data-tipo={tipo} data-nota-os="" tabIndex={-1} role="status">
      <Icone ok={tipo === "ok"} />
      <span>{texto}</span>
    </p>
  );
}

interface Propriedades { numero: string; osNova: OsNova | null; recarregar: () => unknown }

function SugestaoOs({ numero, osNova, recarregar }: Propriedades) {
  const [decisao, setDecisao] = useState<DecisaoOs | null>(() => decisoes.get(numero) || null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [foco, setFoco] = useState(false);
  const emEnvio = useRef(false); // o estado só vale no próximo desenho: dois cliques seguidos não podem gravar duas vezes

  if (decisao) return <Nota tipo={decisao.acao === "aceita" ? "ok" : "neutro"} texto={decisao.acao === "aceita" ? notaAceita(decisao.os) : notaRecusada(decisao.os)} foco={foco} />;
  if (!osNova) return null;
  if (osNova.tipo === "troca") return <Nota tipo="ok" texto={notaTroca(osNova.nova.os)} />;

  async function decidir(acao: DecisaoOs["acao"]) {
    if (!osNova || emEnvio.current) return;
    emEnvio.current = true;
    setEnviando(true);
    setErro("");
    try {
      if (acao === "aceita") {
        await apiFetch(URL_VINCULOS_OS, { method: "PUT", headers: CABECALHO_JSON, body: JSON.stringify(corpoAceitar(osNova)), errorMessage: "Não foi possível aceitar a OS." });
      } else {
        await apiFetch(urlOsRecusada(numero), { method: "PUT", headers: CABECALHO_JSON, body: JSON.stringify(corpoRecusar(osNova)), errorMessage: "Não foi possível recusar a OS." });
      }
    } catch (falha) {
      // Sem repetir sozinho: os botões voltam e a pessoa decide se clica de novo.
      emEnvio.current = false;
      setEnviando(false);
      setErro((falha as Error).message || "Não foi possível gravar a escolha.");
      return;
    }
    const gravada = { acao, os: osNova.nova.os };
    decisoes.set(numero, gravada);
    emEnvio.current = false;
    setEnviando(false);
    setFoco(true);
    setDecisao(gravada);
    void recarregar();
  }

  const doisCartoes = osNova.tipo === "sugestao" && osNova.atual;
  return (
    <section className="sebrae-osnova" aria-labelledby={`sebrae-osnova-${numero}`} aria-busy={enviando || undefined}>
      <div className="sebrae-osnova__texto">
        <h4 className="sebrae-osnova__titulo" id={`sebrae-osnova-${numero}`}>{tituloCaixa(osNova)}</h4>
        <p className="sebrae-osnova__explica">{explicacaoCaixa(osNova)}</p>
      </div>
      <div className="sebrae-osnova__chips">
        {chipsSinais(osNova).map(chip => (
          <span key={chip.texto} className="sebrae-osnova__chip" data-ok={chip.ok ? "sim" : "nao"}><Icone ok={chip.ok} />{chip.texto}</span>
        ))}
      </div>
      <div className="sebrae-osnova__cartoes" data-cartoes={doisCartoes ? "2" : "1"}>
        {osNova.atual && osNova.tipo === "sugestao" ? <CartaoOs texto={osNova.atual} selo={seloOs("atual", osNova.atual)} destaque={false} /> : null}
        <CartaoOs
          texto={osNova.nova}
          selo={seloOs(osNova.tipo === "sem_os" ? "encontrada" : "mais nova", osNova.nova)}
          destaque
          serie={osNova.tipo === "sem_os" ? osNova.nova.serie : undefined}
        />
      </div>
      <div className="sebrae-osnova__acoes">
        <button type="button" className="ck-btn ck-btn--primario" disabled={enviando} onClick={() => decidir("aceita")}>{rotuloAceitar(osNova)}</button>
        <button type="button" className="ck-btn ck-btn--secundario" disabled={enviando} onClick={() => decidir("recusada")}>{rotuloRecusar(osNova)}</button>
      </div>
      {erro ? <p className="sebrae-osnova__erro" role="alert">{erro}</p> : null}
    </section>
  );
}

/** Desenha (ou redesenha) a caixa no host. flushSync: o cartão já nasce pronto quando estado.ts devolve a linha. */
function montar(host: HTMLElement, { numero, osNova, recarregar }: { numero: string; osNova: OsNova | null; recarregar: () => unknown }) {
  const anterior = raizes.get(numero);
  if (anterior && anterior.host !== host) anterior.raiz.unmount();
  // Outra OS sugerida para o mesmo chamado: a decisão antiga não vale para ela.
  if (osNova && decisoes.get(numero) && decisoes.get(numero)?.os !== osNova.nova.os) decisoes.delete(numero);
  const raiz = anterior && anterior.host === host ? anterior.raiz : createRoot(host);
  raizes.set(numero, { raiz, host });
  flushSync(() => raiz.render(<SugestaoOs numero={numero} osNova={osNova} recarregar={recarregar} />));
}

function limparOrfas() {
  raizes.forEach(({ raiz, host }, numero) => {
    if (host.isConnected) return;
    raiz.unmount();
    raizes.delete(numero);
    decisoes.delete(numero);
  });
}

export const sugestaoOsPainel: SugestaoOsPainel = {
  montar,
  temDecisao: numero => decisoes.has(numero),
  limparOrfas,
};
