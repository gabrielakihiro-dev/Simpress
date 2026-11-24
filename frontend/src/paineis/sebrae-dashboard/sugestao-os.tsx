import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { apiFetch } from "../../api";
import {
  chipsSinais, CHIPS_SEM_RELACAO, corpoAceitar, corpoRecusar, corpoSemRelacao, ERRO_MANTER, ERRO_REMOVER, EXPLICACAO_SEM_RELACAO,
  explicacaoCaixa, notaAceita, notaMantida, notaRecusada, notaRemovida, notaTroca, rotuloAceitar, rotuloManter, rotuloRecusar,
  rotuloRemover, seloOs, textoOuIndisponivel, tituloCaixa, tituloSemRelacao, URL_VINCULOS_OS, urlOsRecusada, urlSemRelacao,
  type ChipSinal,
} from "./sugestao-os-modelo";
import type { DecisaoOs, DecisaoSemRelacao, OsNova, OsSemRelacao, SugestaoOsPainel, TextosOs } from "./tipos";

// "OS nova sugerida" no cartão aberto de um chamado antigo do F5 (visual aprovado em 17/11/2026; CSS em static/styles/ck-cockpit.css,
// classes `.sebrae-osnova*`). O código imperativo de estado.ts só cria o host `<div data-sugestao-os>` e chama `montar`; nunca
// escreve dentro dele. Aceitar grava o vínculo manual (PUT vinculos-os); Recusar e Manter gravam o par chamado + OS em
// `sebrae_os_recusadas.json`. Depois da gravação o F5 recarrega pelo `recarregar` que estado.ts entrega, e o resultado fica guardado
// aqui para a nota aparecer no host novo mesmo com `os_nova` já vazio.
// O aviso "OS sem relação" (`os_sem_relacao`, 18/11/2026) usa a mesma caixa e o mesmo host, mas é outro componente (`AvisoSemRelacao`):
// a OS que ele mostra é a da coluna E (`atual`), não existe `nova`, e Manter e Remover gravam em rotas próprias (os-manter e os-remover).

const raizes = new Map<string, { raiz: Root; host: HTMLElement }>();
const decisoes = new Map<string, DecisaoOs>();
const decisoesSemRelacao = new Map<string, DecisaoSemRelacao>();

const CABECALHO_JSON = { "Content-Type": "application/json" };

function Icone({ ok, alerta = false }: { ok: boolean; alerta?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={alerta ? "M12 3 2 21h20zM12 10v4M12 18h.01" : ok ? "M20 6 9 17l-5-5" : "M6 12h12"} />
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

function Chips({ chips }: { chips: readonly ChipSinal[] }) {
  return (
    <div className="sebrae-osnova__chips">
      {chips.map(chip => (
        <span key={chip.texto} className="sebrae-osnova__chip" data-ok={chip.alerta ? "alerta" : chip.ok ? "sim" : "nao"}><Icone ok={chip.ok} alerta={chip.alerta} />{chip.texto}</span>
      ))}
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
      <Chips chips={chipsSinais(osNova)} />
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

interface PropriedadesSemRelacao { numero: string; aviso: OsSemRelacao | null; recarregar: () => unknown }

/** Aviso "OS da coluna E sem relação com este chamado": Manter e Remover gravam só no registro local de recusas (os-manter e os-remover). */
function AvisoSemRelacao({ numero, aviso, recarregar }: PropriedadesSemRelacao) {
  const [decisao, setDecisao] = useState<DecisaoSemRelacao | null>(() => decisoesSemRelacao.get(numero) || null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [foco, setFoco] = useState(false);
  const emEnvio = useRef(false); // mesmo motivo de SugestaoOs: dois cliques seguidos não podem gravar duas vezes

  if (decisao) return <Nota tipo={decisao.acao === "removida" ? "ok" : "neutro"} texto={decisao.acao === "mantida" ? notaMantida(decisao.os) : notaRemovida(decisao.os)} foco={foco} />;
  if (!aviso) return null;

  async function decidir(acao: DecisaoSemRelacao["acao"]) {
    if (!aviso || emEnvio.current) return;
    const mensagemErro = acao === "mantida" ? ERRO_MANTER : ERRO_REMOVER;
    emEnvio.current = true;
    setEnviando(true);
    setErro("");
    try {
      await apiFetch(urlSemRelacao(acao, numero), { method: "PUT", headers: CABECALHO_JSON, body: JSON.stringify(corpoSemRelacao(aviso)), errorMessage: mensagemErro });
    } catch (falha) {
      // Sem repetir sozinho: os botões voltam e a pessoa decide se clica de novo.
      emEnvio.current = false;
      setEnviando(false);
      setErro((falha as Error).message || mensagemErro);
      return;
    }
    const gravada = { acao, os: aviso.atual.os };
    decisoesSemRelacao.set(numero, gravada);
    emEnvio.current = false;
    setEnviando(false);
    setFoco(true);
    setDecisao(gravada);
    void recarregar();
  }

  return (
    <section className="sebrae-osnova" data-tipo="sem-relacao" aria-labelledby={`sebrae-osnova-${numero}`} aria-busy={enviando || undefined}>
      <div className="sebrae-osnova__texto">
        <h4 className="sebrae-osnova__titulo" id={`sebrae-osnova-${numero}`}>{tituloSemRelacao(aviso)}</h4>
        <p className="sebrae-osnova__explica">{EXPLICACAO_SEM_RELACAO}</p>
      </div>
      <Chips chips={CHIPS_SEM_RELACAO} />
      <div className="sebrae-osnova__cartoes" data-cartoes="1">
        <CartaoOs texto={aviso.atual} selo={seloOs("atual", aviso.atual)} destaque={false} />
      </div>
      <div className="sebrae-osnova__acoes">
        <button type="button" className="ck-btn ck-btn--secundario" disabled={enviando} onClick={() => decidir("mantida")}>{rotuloManter(aviso)}</button>
        <button type="button" className="ck-btn ck-btn--secundario" disabled={enviando} onClick={() => decidir("removida")}>{rotuloRemover(aviso)}</button>
      </div>
      {erro ? <p className="sebrae-osnova__erro" role="alert">{erro}</p> : null}
    </section>
  );
}

interface Chamado { numero: string; osNova: OsNova | null; osSemRelacao: OsSemRelacao | null; recarregar: () => unknown }

/** Desenha (ou redesenha) a caixa no host. flushSync: o cartão já nasce pronto quando estado.ts devolve a linha. */
function montar(host: HTMLElement, { numero, osNova, osSemRelacao, recarregar }: Chamado) {
  const anterior = raizes.get(numero);
  if (anterior && anterior.host !== host) anterior.raiz.unmount();
  // Outra OS sugerida para o mesmo chamado: a decisão antiga não vale para ela.
  if (osNova && decisoes.get(numero) && decisoes.get(numero)?.os !== osNova.nova.os) decisoes.delete(numero);
  // Só o aviso, sem sugestão: a decisão da OS nova (ex.: Recusar) não vale para ele, que ainda espera Manter ou Remover (cartão rosa, 23/11/2026).
  if (!osNova && osSemRelacao) decisoes.delete(numero);
  // Uma sugestão nova encerra a nota do aviso (o selo "OS nova?" some enquanto `temDecisao`); outra OS na E também: a decisão antiga não vale para ela.
  if (osNova || (osSemRelacao && decisoesSemRelacao.get(numero)?.os !== osSemRelacao.atual.os)) decisoesSemRelacao.delete(numero);
  const raiz = anterior && anterior.host === host ? anterior.raiz : createRoot(host);
  raizes.set(numero, { raiz, host });
  const comAviso = !osNova && Boolean(osSemRelacao || decisoesSemRelacao.has(numero));
  flushSync(() => raiz.render(comAviso
    ? <AvisoSemRelacao numero={numero} aviso={osSemRelacao} recarregar={recarregar} />
    : <SugestaoOs numero={numero} osNova={osNova} recarregar={recarregar} />));
}

function limparOrfas() {
  raizes.forEach(({ raiz, host }, numero) => {
    if (host.isConnected) return;
    raiz.unmount();
    raizes.delete(numero);
    decisoes.delete(numero);
    decisoesSemRelacao.delete(numero);
  });
}

export const sugestaoOsPainel: SugestaoOsPainel = {
  montar,
  temDecisao: numero => decisoes.has(numero) || decisoesSemRelacao.has(numero),
  limparOrfas,
};
