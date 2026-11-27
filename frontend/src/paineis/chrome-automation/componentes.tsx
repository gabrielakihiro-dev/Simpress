// Regiões da aba Automação (F5). Cada uma é a raiz React de uma <section> do index.html (atributo data-automacao-regiao)
// e lê o mesmo store (estado.ts). Os nós mantêm data-on-*/data-args: o despachante de ações (frontend/src/ui/action-dispatcher.ts) chama as ações
// pela ponte; só a miniatura da captura (que não existia como data-on-*) usa onClick do React.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { urlDeBlobDaApi } from "../../comum/baixar-api";
import { abrirCapturaAutomacao } from "./captura";
import { assinar, ler, mudar } from "./estado";
import {
  ABAS_ROTINA, abaDaRotina, botaoBloqueado, descricaoDaCaptura, dicaDosLotes, execucaoMaisRecente, formatarDuracao, formatarHora, ICONE_STATUS,
  iconeDoBotao, iconeDoSelo, percentualDaRotina, ROTINAS_DOS_CARTOES, rotuloDaExecucao, rotuloDoBotao, rotuloInicio, ROTINAS, situacaoDaEtapa,
  situacaoDoCartao, situacaoDoSelo, STATUS, STATUS_VISUAL, visaoDoLog, type Execucao, type Selo,
} from "./regras-puro";

const useAutomacao = () => useSyncExternalStore(assinar, ler);
const args = (...valores: unknown[]) => JSON.stringify(valores);

function Icone({ nome, classe = "ck-ico" }: { nome: string; classe?: string }) {
  return <svg className={classe} aria-hidden="true" focusable="false"><use href={`#${nome}`} /></svg>;
}

const CARTOES = [
  { id: "os", icone: "i-clipboard", nome: "Rotina de OS", idTitulo: "ck-rotina-os-titulo", idDica: "tip-rotina-os", fim: false, dica: "Oracle Service Cloud + UX Simpress (Acompanhamento de pedidos)." },
  { id: "inventarios", icone: "i-laptop", nome: "Inventários", idTitulo: "ck-rotina-inventarios-titulo", idDica: "tip-rotina-inventarios", fim: false, dica: "UX Simpress (Meus equipamentos) + Endpoint Central." },
  { id: "usuarios", icone: "i-users", nome: "Verificar usuários", idTitulo: "ck-verificacao-titulo", idDica: "tip-verificar-usuarios", fim: false, dica: "Verificação manual · confere no Endpoint Central as pendências de usuário logado." },
  { id: "ambas", icone: "i-layers", nome: "Rotina Completa", idTitulo: "ck-rotina-ambas-titulo", idDica: "tip-rotina-ambas", fim: true, dica: "Rotina de OS e, em seguida, a de inventários." },
] as const;

const ROTINAS_DO_FILTRO = ["os", "inventarios", "usuarios", "ambas", "login", "sebrae", "antigos", "dashboard"] as const;
const STATUS_DO_FILTRO = ["concluido", "falha", "cancelado", "em_andamento", "ocupada", "interrompido"] as const;

export function Aviso({ host }: { host: HTMLElement }) {
  const e = useAutomacao();
  const esperando = Boolean(e.descricao?.esperandoLogin);
  // O atributo hidden fica no próprio <section> (fora do React), como no HTML antigo.
  useLayoutEffect(() => { host.hidden = !esperando; }, [host, esperando]);
  return (
    <>
      <Icone nome="i-user-check" />
      <div>
        <h2 id="automacao-aviso-login-titulo" className="ck-secao-titulo">Login necessário no Chrome</h2>
        <p id="automacao-aviso-login-texto" className="ck-cartao__meta">{e.descricao?.avisoLogin ?? ""}</p>
      </div>
    </>
  );
}

export function AvisoDashboard({ host }: { host: HTMLElement }) {
  const e = useAutomacao();
  const esperando = Boolean(e.descricao?.esperandoDashboard);
  useLayoutEffect(() => { host.hidden = !esperando; }, [host, esperando]);
  return (
    <>
      <Icone nome="i-alerta" />
      <div>
        <h2 id="automacao-aviso-dashboard-titulo" className="ck-secao-titulo">Dashboard aberto no Excel</h2>
        <p id="automacao-aviso-dashboard-texto" className="ck-cartao__meta">O Dashboard está aberto no Excel, por você ou por outra pessoa. Feche-o: a rotina continua sozinha quando ele for liberado. Se não for você, use Cancelar execução.</p>
        <button type="button" className="ck-btn ck-btn--perigo ck-btn--sm" id="btn-automacao-cancelar-dashboard" aria-describedby="automacao-aviso-dashboard-texto" data-on-click="cancelarRotinaAutomacao" title="Para a rotina em andamento; o Chrome continua aberto" disabled={!e.emAndamento || e.ocupado}><Icone nome="i-stop" classe="ck-ico ck-ico--xs" />Cancelar execução</button>
      </div>
    </>
  );
}

export function Chrome() {
  const e = useAutomacao();
  const d = e.descricao;
  const seloStatus = d?.seloStatus ?? "ok";
  const loginBloqueado = botaoBloqueado({ ocupado: e.ocupado, emAndamento: e.emAndamento, acompanhar: false, semSaida: false });
  return (
    <>
      <h2 className="ck-chrome__nome" id="automacao-titulo"><Icone nome="i-monitor" classe="ck-ico ck-ico--lg" />Chrome · porta 9333</h2>
      <div id="automacao-estado" role="status" aria-live="polite" aria-atomic="true" data-state={d?.dataState ?? "livre"}>
        <span className="ck-badge" data-status={seloStatus}>
          <Icone nome={ICONE_STATUS[seloStatus]} classe={seloStatus === "info" ? "ck-ico ck-ico--xs ck-girando" : "ck-ico ck-ico--xs"} />
          <strong id="automacao-estado-titulo">{d?.titulo ?? "Livre"}</strong>
        </span>
      </div>
      {/* A barra corta o detalhe com reticências; o title mostra o texto inteiro. */}
      <span className="ck-chrome__det" id="automacao-estado-detalhe" title={d?.detalhe}>{d?.detalhe ?? "Verificando…"}</span>
      <span className="ck-espaco"></span>
      <button type="button" id="automacao-ver-backups" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="abrirPainelCockpit" data-args={args("comparacao", "backups")} hidden={!e.verBackups}>Ver backups no Resumo</button>
      <button
        type="button" className="ck-btn ck-btn--fantasma ck-btn--sm" id="btn-automacao-login" data-automacao-rotina="login"
        data-on-click="iniciarRotinaAutomacao" data-args={args("login")}
        disabled={e.botoesProntos ? loginBloqueado : undefined} aria-disabled={e.botoesProntos ? loginBloqueado : undefined}
        aria-busy={e.iniciando === "login" ? "true" : undefined}
      >
        <Icone nome="i-user-check" classe="ck-ico ck-ico--sm" />Abrir Chrome para login
      </button>
    </>
  );
}

function Dica({ rotulo, idDica, fim, children }: { rotulo: string; idDica: string; fim: boolean; children: string }) {
  return (
    <span className={fim ? "info-tip info-tip--end" : "info-tip"}>
      <button type="button" className="info-tip-trigger" aria-label={rotulo} aria-describedby={idDica}><Icone nome="i-info" classe="ck-ico ck-ico--sm" /></button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}

// Ícone do selo e da bolinha da trilha por status; sem status a bolinha mostra o número da etapa.
const ICONE_ETAPA: Readonly<Record<string, string>> = { ok: "i-check", erro: "i-x", alerta: "i-alerta", info: "i-loader" };

function SeloRotina({ selo, ativo, pronto, rotina }: { selo: Selo; ativo: boolean; pronto: boolean; rotina?: string }) {
  return (
    <span className="nl-f4-selo" data-rotina-badge={rotina} data-status={pronto ? selo.status : undefined}>
      <Icone nome={pronto ? iconeDoSelo(ativo, selo.status) : "i-clock"} classe={pronto && ativo ? "ck-ico ck-ico--xs ck-girando" : "ck-ico ck-ico--xs"} />
      <span>{pronto ? selo.texto : "—"}</span>
    </span>
  );
}

type Cartao = (typeof CARTOES)[number];
const cartaoDe = (id: string): Cartao => CARTOES.find(item => item.id === id) as Cartao;

function BotaoRotina({ cartao, primario = false }: { cartao: Cartao; primario?: boolean }) {
  const e = useAutomacao();
  const ativo = e.emAndamento && e.rotinaAtiva === cartao.id;
  // A rotina em andamento vira "Acompanhar": o botão fica livre e leva ao console.
  const repetir = e.ultimasPorRotina[cartao.id]?.status === "falha";
  const rotulo = rotuloDoBotao(ativo, repetir);
  const bloqueado = botaoBloqueado({ ocupado: e.ocupado, emAndamento: e.emAndamento, acompanhar: ativo, semSaida: false });
  return (
    <button
      type="button" id={`btn-automacao-${cartao.id}`} data-automacao-rotina={cartao.id}
      className={`ck-btn ${primario || (e.botoesProntos && ativo) ? "ck-btn--primario" : "ck-btn--secundario"} ck-btn--sm nl-f4-btn`}
      aria-label={e.botoesProntos ? `${rotulo} ${cartao.nome}` : `Executar ${cartao.nome}`}
      title={e.botoesProntos ? rotulo : "Executar"} aria-describedby={cartao.idTitulo}
      data-on-click="iniciarRotinaAutomacao" data-args={args(cartao.id)}
      disabled={e.botoesProntos ? bloqueado : undefined} aria-disabled={e.botoesProntos ? bloqueado : undefined}
      aria-busy={e.iniciando === cartao.id ? "true" : undefined}
    >
      <Icone nome={e.botoesProntos ? iconeDoBotao(ativo, repetir) : "i-play"} classe="ck-ico ck-ico--xs" />
      <span>{e.botoesProntos ? rotulo : "Executar"}</span>
    </button>
  );
}

function ItemRotina({ cartao }: { cartao: Cartao }) {
  const e = useAutomacao();
  const ativo = e.emAndamento && e.rotinaAtiva === cartao.id;
  const selo = situacaoDoSelo(ativo, e.ultimasPorRotina[cartao.id]);
  return (
    <li className="nl-f4-item" data-rotina={cartao.id} data-estado={e.botoesProntos ? situacaoDoCartao(ativo, selo.status) : "ocioso"}>
      <span className="nl-f4-item__nome">
        <span className="nl-f4-item__titulo" id={cartao.idTitulo}>{cartao.nome}</span>
        <Dica rotulo={`Sobre ${cartao.nome}`} idDica={cartao.idDica} fim={false}>{cartao.dica}</Dica>
      </span>
      <SeloRotina selo={selo} ativo={ativo} pronto={e.botoesProntos} rotina={cartao.id} />
      <BotaoRotina cartao={cartao} />
    </li>
  );
}

// Etapas do inventário: cada uma ocupa um terço da barra; o percentual vem do log ao vivo (percentualDaRotina).
const ETAPAS_INVENTARIOS = [
  { n: "01", nome: "Abrir Endpoint", detalhe: "Endpoint Central" },
  { n: "02", nome: "Ler inventário", detalhe: "UX e Endpoint" },
  { n: "03", nome: "Gravar planilha", detalhe: "Base local" },
] as const;

function PainelRotina({ id, icone, titulo, idTitulo, selo, children }: { id: string; icone: string; titulo: string; idTitulo?: string; selo: ReactNode; children: ReactNode }) {
  const e = useAutomacao();
  return (
    <section className="ck-cartao nl-f4-painel" id={`painel-rotina-${id}`} role="tabpanel" aria-labelledby={`tab-rotina-${id}`} hidden={e.abaRotina !== id}>
      <header className="nl-f4-painel__cab">
        <span className="nl-f4-ico" aria-hidden="true"><Icone nome={icone} /></span>
        <h3 className="nl-f4-painel__titulo" id={idTitulo}>{titulo}</h3>
        <span className="nl-f4-painel__selo">{selo}</span>
      </header>
      <div className="nl-f4-painel__corpo">{children}</div>
    </section>
  );
}

function teclarNaAba(evento: KeyboardEvent<HTMLButtonElement>, indice: number) {
  const total = ABAS_ROTINA.length;
  const destino = ({ ArrowRight: (indice + 1) % total, ArrowLeft: (indice - 1 + total) % total, Home: 0, End: total - 1 } as Record<string, number>)[evento.key];
  if (destino === undefined) return;
  evento.preventDefault();
  mudar({ abaRotina: ABAS_ROTINA[destino].id });
  document.getElementById(`tab-rotina-${ABAS_ROTINA[destino].id}`)?.focus();
}

export function Rotinas() {
  const e = useAutomacao();
  const { abaRotina, botoesProntos, emAndamento, rotinaAtiva, ultimasPorRotina: ultimas } = e;
  const ativa = (...rotinas: string[]) => emAndamento && rotinas.includes(rotinaAtiva);
  // O cartão do SoftExpert é HTML estático (fora do React): o seletor só o mostra ou esconde.
  useLayoutEffect(() => {
    const painel = document.getElementById("sebrae-novos-painel");
    if (painel) painel.hidden = abaRotina !== "softexpert";
  }, [abaRotina]);
  // Rotina que começa leva o seletor para a aba dela (login e "antigos" não têm aba).
  useEffect(() => {
    const aba = emAndamento ? abaDaRotina(rotinaAtiva) : "";
    if (aba) mudar({ abaRotina: aba });
  }, [emAndamento, rotinaAtiva]);
  const etapas = [
    { aba: "sharepoint", nome: "SharePoint", selo: situacaoDaEtapa(ativa("dashboard"), ultimas.dashboard) },
    { aba: "softexpert", nome: "SoftExpert", selo: situacaoDaEtapa(ativa("sebrae", "dashboard"), execucaoMaisRecente(ultimas.sebrae, ultimas.dashboard)) },
    { aba: "completa", nome: "Rotina Completa", selo: situacaoDaEtapa(ativa("ambas"), ultimas.ambas) },
  ];
  const inventarios = cartaoDe("inventarios");
  const ativoInventarios = ativa("inventarios");
  const seloInventarios = situacaoDoSelo(ativoInventarios, ultimas.inventarios);
  const percentual = percentualDaRotina(ativoInventarios, ultimas.inventarios, e.linhasAoVivo);
  const seloDashboard = situacaoDoSelo(ativa("dashboard"), ultimas.dashboard);
  const completa = cartaoDe("ambas");
  const seloCompleta = situacaoDoSelo(ativa("ambas"), ultimas.ambas);
  return (
    <>
      <h2 className="ck-sr" id="ck-rotinas-titulo">Rotinas principais</h2>
      <ol className="nl-f4-trilha" aria-label="Etapas das rotinas">
        {etapas.map((etapa, indice) => {
          const status = botoesProntos ? etapa.selo.status : "";
          const nome = `${etapa.nome}: ${botoesProntos ? etapa.selo.texto : "carregando"}`;
          return (
            <li key={etapa.aba} className="nl-f4-passo" data-ok={status === "ok" ? "" : undefined}>
              <button
                type="button" className="nl-f4-bolinha" data-status={status || undefined} data-sel={abaRotina === etapa.aba ? "" : undefined}
                aria-label={nome} title={nome} aria-current={abaRotina === etapa.aba ? "step" : undefined} onClick={() => mudar({ abaRotina: etapa.aba })}
              >
                {ICONE_ETAPA[status]
                  ? <Icone nome={ICONE_ETAPA[status]} classe={status === "info" ? "ck-ico ck-ico--sm ck-girando" : "ck-ico ck-ico--sm"} />
                  : <span aria-hidden="true">{indice + 1}</span>}
              </button>
            </li>
          );
        })}
      </ol>
      <div className="nl-f4-abas" role="tablist" aria-label="Rotinas">
        {ABAS_ROTINA.map((aba, indice) => {
          const selecionada = abaRotina === aba.id;
          return (
            <button
              key={aba.id} type="button" role="tab" id={`tab-rotina-${aba.id}`} className="nl-f4-aba" aria-selected={selecionada}
              aria-controls={aba.id === "softexpert" ? "sebrae-novos-painel" : `painel-rotina-${aba.id}`} tabIndex={selecionada ? 0 : -1}
              onClick={() => mudar({ abaRotina: aba.id })} onKeyDown={evento => teclarNaAba(evento, indice)}
            >{aba.nome}</button>
          );
        })}
      </div>
      <PainelRotina id="sharepoint" icone="i-download" titulo="SharePoint" selo={<SeloRotina selo={seloDashboard} ativo={ativa("dashboard")} pronto={botoesProntos} />}>
        <ul className="nl-f4-itens" aria-label="Etapas do SharePoint">
          <li className="nl-f4-item"><span className="nl-f4-item__nome"><Icone nome="i-download" classe="ck-ico ck-ico--sm" /><span className="nl-f4-item__titulo">Baixar Dashboard</span></span></li>
          <li className="nl-f4-item"><span className="nl-f4-item__nome"><Icone nome="i-upload" classe="ck-ico ck-ico--sm" /><span className="nl-f4-item__titulo">Importar aba CHAMADOS</span></span></li>
        </ul>
        <div className="nl-f4-acoes">
          <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm nl-f4-btn" onClick={() => mudar({ abaRotina: "softexpert" })}>
            <Icone nome="i-arrow-right" classe="ck-ico ck-ico--xs" /><span>Ir para SoftExpert</span>
          </button>
        </div>
      </PainelRotina>
      <PainelRotina
        id="completa" icone="i-layers" titulo="Rotina Completa" idTitulo={completa.idTitulo}
        selo={<><SeloRotina selo={seloCompleta} ativo={ativa("ambas")} pronto={botoesProntos} rotina="ambas" /><Dica rotulo={`Sobre ${completa.nome}`} idDica={completa.idDica} fim>{completa.dica}</Dica></>}
      >
        <ul className="nl-f4-itens" aria-label="Rotinas incluídas">
          <ItemRotina cartao={cartaoDe("os")} />
          <ItemRotina cartao={cartaoDe("usuarios")} />
        </ul>
        <div className="nl-f4-acoes"><BotaoRotina cartao={completa} primario /></div>
      </PainelRotina>
      <PainelRotina
        id="inventarios" icone="i-laptop" titulo="Inventários" idTitulo={inventarios.idTitulo}
        selo={<><SeloRotina selo={seloInventarios} ativo={ativoInventarios} pronto={botoesProntos} rotina="inventarios" /><Dica rotulo={`Sobre ${inventarios.nome}`} idDica={inventarios.idDica} fim>{inventarios.dica}</Dica></>}
      >
        <ol className="nl-f4-etapas" aria-label="Etapas do inventário">
          {ETAPAS_INVENTARIOS.map((etapa, indice) => {
            const preenchida = Math.max(0, Math.min(1, (percentual - (indice * 100) / 3) / (100 / 3)));
            return (
              <li key={etapa.n} className="nl-f4-etapa" data-acesa={preenchida > 0 ? "" : undefined}>
                <span className="nl-f4-etapa__n">{etapa.n}</span>
                <strong>{etapa.nome}</strong>
                <span className="nl-f4-fio" aria-hidden="true"><i style={{ transform: `scaleX(${preenchida})` }} /></span>
                <span className="nl-f4-etapa__k">{etapa.detalhe}</span>
              </li>
            );
          })}
        </ol>
        <div className="nl-f4-andamento">
          <span className="nl-f4-pct">{botoesProntos ? `${percentual}%` : "—"}</span>
          <p className="nl-f4-msg" role="status" aria-live="polite">{botoesProntos ? seloInventarios.texto : "Consultando…"}</p>
        </div>
        <div className="nl-f4-acoes"><BotaoRotina cartao={inventarios} primario /></div>
      </PainelRotina>
    </>
  );
}

function Captura({ execucao, captura }: { execucao: Execucao; captura: { nome: string; url: string } }) {
  const [falhou, setFalhou] = useState(false);
  const [endereco, setEndereco] = useState("");
  const descricao = descricaoDaCaptura(execucao);
  // Um <img src>/<a href> em /api/... não leva o X-Simpress-Sessao: a captura vem como blob: (miniatura, link e
  // ampliação usam o mesmo), revogado ao sair da tela. shortcut: sem loading="lazy", todas as capturas da lista
  // baixam ao abrir o histórico; se a lista crescer, carregar só as visíveis (IntersectionObserver).
  useEffect(() => {
    const controle = new AbortController();
    let criado = "";
    urlDeBlobDaApi(captura.url, controle.signal).then(
      url => { criado = url; if (controle.signal.aborted) URL.revokeObjectURL(url); else setEndereco(url); },
      () => { if (!controle.signal.aborted) setFalhou(true); },
    );
    return () => { controle.abort(); if (criado) URL.revokeObjectURL(criado); };
  }, [captura.url]);
  return (
    <span className="automation-capture">
      <button
        type="button" className="automation-capture-thumb" aria-haspopup="dialog" aria-label={`Ampliar captura ${captura.nome}`} disabled={falhou || !endereco}
        onClick={evento => abrirCapturaAutomacao({ ...captura, url: endereco }, descricao, execucao.mensagem, evento.currentTarget)}
      >
        {falhou
          ? <span className="automation-capture-missing">Captura indisponível</span>
          : endereco ? <img src={endereco} alt={descricao} decoding="async" onError={() => setFalhou(true)} /> : null}
      </button>
      {/* Sem noopener: o Chrome pode recusar abrir blob: (PNG da mesma origem) numa aba sem opener. Recarregar essa aba
          depois que a linha some do histórico não volta: o blob já foi revogado. */}
      <a className="automation-history-link" href={endereco || undefined} target="_blank">{captura.nome}</a>
    </span>
  );
}

function LinhaHistorico({ execucao }: { execucao: Execucao }) {
  const nome = ROTINAS[execucao.rotina] || execucao.rotina;
  const lotes = dicaDosLotes(execucao);
  const visual = STATUS_VISUAL[execucao.status] || "";
  const capturas = execucao.capturas || [];
  return (
    <tr data-status={(execucao.status || "").replace("_", "-")}>
      <td data-label="Rotina">
        <span title={lotes || undefined}>{nome}{execucao.origem === "externo" && <small className="automation-history-origin"> fora do site</small>}</span>
      </td>
      <td data-label="Início">{rotuloInicio(execucao.inicio)}</td>
      <td data-label="Duração">{execucao.status === "em_andamento" ? "—" : formatarDuracao(execucao.inicio, execucao.fim)}</td>
      <td data-label="Status">
        <span className="automation-history-status">
          <span className="ck-status nl-f4-selo" data-status={visual} title={execucao.mensagem || undefined}>
            <Icone nome={ICONE_STATUS[visual]} classe={visual === "info" ? "ck-ico ck-ico--xs ck-girando" : "ck-ico ck-ico--xs"} />
            {STATUS[execucao.status] || execucao.status || "—"}
          </span>
          {execucao.mensagem && execucao.status !== "concluido" && <small className="automation-history-message">{execucao.mensagem}</small>}
          {capturas.length > 0 && (
            <span className="automation-history-captures">
              {capturas.map((captura, indice) => <Captura key={`${captura.url}-${indice}`} execucao={execucao} captura={captura} />)}
            </span>
          )}
        </span>
      </td>
      <td className="ck-td--sem-rotulo ck-td--largo nl-f4-td-log" data-label="Log">
        <button
          type="button" className="nl-f4-ver" data-on-click="abrirLogExecucaoAutomacao"
          data-args={args(execucao.id, execucao.inicio)} aria-label={`Ver log de ${nome} em ${formatarHora(execucao.inicio)}`}
        >Ver log<Icone nome="i-arrow-right" classe="ck-ico ck-ico--xs" /></button>
      </td>
    </tr>
  );
}

function ListaHistorico() {
  const { historico } = useAutomacao();
  if (historico.tipo === "carregando") return <p className="ck-lista__vazio">Carregando…</p>;
  if (historico.tipo === "erro") return <p className="ck-lista__vazio">{historico.mensagem}</p>;
  if (!historico.execucoes.length) return <p className="ck-lista__vazio">Nenhuma execução encontrada para os filtros selecionados.</p>;
  return (
    <table className="ck-tabela ck-tabela--cards">
      <thead><tr>{["Rotina", "Início", "Duração", "Status"].map(titulo => <th key={titulo} scope="col">{titulo}</th>)}<th scope="col"><span className="ck-sr">Log</span></th></tr></thead>
      <tbody>{historico.execucoes.map(execucao => <LinhaHistorico key={execucao.id} execucao={execucao} />)}</tbody>
    </table>
  );
}

// Chip com a lista de um filtro (Rotina ou Status); mudar a escolha já aplica o filtro.
function FiltroChip({ id, rotulo, todas, children }: { id: string; rotulo: string; todas: string; children: ReactNode }) {
  return (
    <label className="nl-f4-chip">
      <span className="nl-f4-chip__rotulo">{rotulo}:</span>
      <select id={id} aria-label={rotulo} data-on-change="filtrarHistoricoAutomacao">
        <option value="">{todas}</option>
        {children}
      </select>
      <Icone nome="i-chevron-down" classe="ck-ico ck-ico--xs" />
    </label>
  );
}

export function Historico() {
  const e = useAutomacao();
  const periodo = useRef<HTMLDetailsElement>(null);
  const fecharPeriodo = (devolverFoco = false) => {
    if (!periodo.current) return;
    periodo.current.open = false;
    if (devolverFoco) periodo.current.querySelector("summary")?.focus();
  };
  // Aplicar fecha o Período; se a data é inválida, o foco vai para um campo da caixa e ela fica aberta para corrigir.
  const aplicarPeriodo = () => setTimeout(() => {
    const foco = document.activeElement;
    if (!(foco instanceof HTMLInputElement && periodo.current?.contains(foco))) fecharPeriodo();
  });
  return (
    <>
      <div className="nl-f4-cab">
        <h2 className="nl-f4-cab__titulo" id="automacao-historico-titulo">Últimas execuções</h2>
        <span className="nl-f4-cab__meta" id="automacao-historico-resumo" role="status">{e.resumoHist}</span>
      </div>
      <div className="nl-f4-filtros" id="automacao-historico-filtros" role="group" aria-label="Filtros de execuções">
        <FiltroChip id="automacao-historico-rotina" rotulo="Rotina" todas="Todas">
          {ROTINAS_DO_FILTRO.map(rotina => <option key={rotina} value={rotina}>{ROTINAS[rotina]}</option>)}
        </FiltroChip>
        <FiltroChip id="automacao-historico-status" rotulo="Status" todas="Todos">
          {STATUS_DO_FILTRO.map(status => <option key={status} value={status}>{STATUS[status]}</option>)}
        </FiltroChip>
        <details className="nl-f4-periodo" ref={periodo} onKeyDown={evento => { if (evento.key === "Escape") fecharPeriodo(true); }}>
          <summary className="nl-f4-chip"><span className="nl-f4-chip__rotulo">Período</span><Icone nome="i-chevron-down" classe="ck-ico ck-ico--xs" /></summary>
          <div className="nl-f4-periodo__caixa">
            <label className="nl-f4-campo"><span>De</span><input type="date" id="automacao-historico-inicio" /></label>
            <label className="nl-f4-campo"><span>Até</span><input type="date" id="automacao-historico-fim" /></label>
            <div className="nl-f4-acoes">
              <button type="button" className="ck-btn ck-btn--primario ck-btn--sm nl-f4-btn" data-on-click="filtrarHistoricoAutomacao" onClick={aplicarPeriodo}>Aplicar</button>
              <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm nl-f4-btn" data-on-click="limparFiltrosAutomacao" onClick={() => fecharPeriodo()}>Limpar</button>
            </div>
          </div>
        </details>
      </div>
      <div className="nl-f4-corpo" id="automacao-historico"><ListaHistorico /></div>
      <nav className="ck-paginacao nl-f4-pag" aria-label="Páginas das execuções">
        <label className="ck-paginacao__grupo">Execuções por página<select className="ck-entrada ck-entrada--sm" id="automacao-historico-limite" data-on-change="filtrarHistoricoAutomacao" defaultValue="5"><option value="5">5</option><option value="10">10</option><option value="20">20</option></select></label>
        <div className="ck-paginacao__grupo">
          <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="automacao-historico-anterior" data-on-click="mudarPaginaHistoricoAutomacao" data-args={args(-1)} disabled={e.anteriorDesabilitado}>Anterior</button>
          <span id="automacao-historico-pagina">{e.paginaTexto}</span>
          <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="automacao-historico-proxima" data-on-click="mudarPaginaHistoricoAutomacao" data-args={args(1)} disabled={e.proximaDesabilitado}>Próxima</button>
        </div>
      </nav>
    </>
  );
}

export function Console() {
  const e = useAutomacao();
  const visao = visaoDoLog(e);
  const { opcoes } = e;
  const selecionavel = opcoes.itens.some(item => item.id === e.execucaoSelecionada);
  const seletorDesabilitado = opcoes.tipo === "lista" ? !opcoes.itens.length : opcoes.tipo !== "inicial";
  return (
    <>
      <div className="ck-console__cab">
        <h2 className="ck-console__titulo" id="automacao-andamento-titulo">Console</h2>
        <span className="ck-ao-vivo" id="cockpit-automation-live" hidden={!e.emAndamento || visao.historico}><span className="ck-ao-vivo__ponto" aria-hidden="true"></span>ao vivo</span>
        <span className="ck-espaco"></span>
        <span className="ck-console__exec" id="automacao-log-modo" role="status">{visao.modo}</span>
      </div>
      <div className="ck-console__ferramentas" id="automacao-log-filtros">
        <fieldset className="ck-consulta">
          <legend>Consultar execuções por data</legend>
          <div className="ck-consulta__campos">
            <label><span className="ck-sr">Data do log</span><input className="ck-entrada ck-entrada--sm" type="date" id="automacao-log-data" data-on-change="carregarExecucoesLogAutomacao" /></label>
            <label>
              <span className="ck-sr">Execução</span>
              {/* key: a lista nova recria o select, que volta à execução escolhida (se estiver na lista) ou ao texto inicial. */}
              <select
                key={e.versaoOpcoes} className="ck-entrada ck-entrada--sm" id="automacao-log-execucao" data-on-change="selecionarLogAutomacao"
                data-args={args("$value")} disabled={seletorDesabilitado} defaultValue={selecionavel ? e.execucaoSelecionada : ""}
              >
                <option value="">{opcoes.texto}</option>
                {opcoes.itens.map(item => <option key={item.id} value={item.id}>{rotuloDaExecucao(item)}</option>)}
              </select>
            </label>
          </div>
          <div className="ck-paginacao__grupo" id="automacao-log-paginas" hidden={!e.logPaginasVisivel}>
            <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="automacao-log-anterior" data-on-click="mudarPaginaLogAutomacao" data-args={args(-1)} disabled={e.logAnteriorDesabilitado}>Execuções anteriores</button>
            <span className="ck-cartao__meta" id="automacao-log-pagina">{e.logPaginaTexto}</span>
            <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="automacao-log-proxima" data-on-click="mudarPaginaLogAutomacao" data-args={args(1)} disabled={e.logProximaDesabilitado}>Próximas execuções</button>
          </div>
        </fieldset>
        <label className="ck-campo ck-console__linhas"><span className="ck-campo__rotulo">Linhas do log</span><select className="ck-entrada ck-entrada--sm" id="automacao-log-limite" data-on-change="alterarLimiteLogAutomacao" defaultValue="200"><option value="100">100</option><option value="200">200</option><option value="500">500</option></select></label>
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="automacao-log-ao-vivo" data-on-click="voltarAoVivoAutomacao" hidden={!visao.historico}>Voltar ao vivo</button>
      </div>
      <ol id="cockpit-automation-events" className="ck-log" role="list" aria-live="off" aria-label="Eventos da execução" tabIndex={0}>
        {visao.eventos.map((evento, indice) => (
          <li key={indice} className="ck-log__linha" data-state={evento.estado}>
            <span className="ck-log__hora">{evento.hora}</span><span className="ck-log__origem">{evento.origem}</span><span className="ck-log__msg">{evento.mensagem}</span><span className="ck-nivel" data-status={evento.nivel}>{evento.status}</span>
          </li>
        ))}
      </ol>
      <div className="ck-console__rodape" id="automacao-andamento-conteudo">
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="btn-log-completo" data-dialogo="ck-dialogo-log" aria-haspopup="dialog"><Icone nome="i-text" classe="ck-ico ck-ico--sm" />Log completo</button>
        <span className="ck-espaco"></span>
        <button type="button" className="ck-btn ck-btn--perigo ck-btn--sm" id="btn-automacao-cancelar" data-on-click="cancelarRotinaAutomacao" title="Para a rotina em andamento; o Chrome continua aberto" disabled={!e.emAndamento || e.ocupado}><Icone nome="i-stop" classe="ck-ico ck-ico--xs" />Cancelar execução</button>
      </div>
    </>
  );
}

export function DialogoLog() {
  const e = useAutomacao();
  const visao = visaoDoLog(e);
  const area = useRef<HTMLPreElement>(null);
  // Ao vivo, o log acompanha o fim; quem rolou para cima fica onde está. A posição é lida antes de o texto novo entrar.
  const noFim = useRef(true);
  const elemento = area.current;
  if (elemento) noFim.current = elemento.scrollHeight - elemento.scrollTop - elemento.clientHeight < 24;
  useLayoutEffect(() => {
    if (area.current && !visao.historico && noFim.current) area.current.scrollTop = area.current.scrollHeight;
  }, [visao.texto, visao.historico]);
  return (
    <section className="ck-dialogo nl-f4-dlg" role="dialog" aria-modal="true" aria-labelledby="ck-dialogo-log-titulo">
      <header className="ck-dialogo__cab"><span className="nl-f4-ico" aria-hidden="true"><Icone nome="i-text" /></span><h2 className="ck-dialogo__titulo" id="ck-dialogo-log-titulo">Log completo</h2><span id="automacao-log-arquivo" className="ck-cartao__meta">{visao.arquivoTexto}</span><button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm" data-fechar="ck-dialogo-log" aria-label="Fechar">Fechar</button></header>
      <pre ref={area} id="automacao-log" className="ck-log-bruto" role="log" aria-live={visao.historico ? "off" : "polite"} aria-labelledby="automacao-andamento-titulo" tabIndex={0}>{visao.texto}</pre>
    </section>
  );
}
