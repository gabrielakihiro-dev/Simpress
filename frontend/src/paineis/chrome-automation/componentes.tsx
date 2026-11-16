// Regiões da aba Automação (F5). Cada uma é a raiz React de uma <section> do index.html (atributo data-automacao-regiao)
// e lê o mesmo store (estado.ts). Os nós mantêm data-on-*/data-args: o despachante de eventos do app.js chama as ações
// pela ponte; só a miniatura da captura (que não existia como data-on-*) usa onClick do React.
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { abrirCapturaAutomacao } from "./captura";
import { assinar, ler } from "./estado";
import {
  botaoBloqueado, descricaoDaCaptura, dicaDosLotes, formatarDuracao, formatarHora, ICONE_STATUS, iconeDoBotao, iconeDoSelo,
  rotuloDaExecucao, rotuloDoBotao, rotuloInicio, ROTINAS, situacaoDoCartao, situacaoDoSelo, STATUS, STATUS_VISUAL, visaoDoLog,
  type Execucao,
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

export function Rotinas() {
  const e = useAutomacao();
  return (
    <>
      <h2 className="ck-sr" id="ck-rotinas-titulo">Rotinas principais</h2>
      <div className="ck-rotinas" role="group" aria-label="Rotinas principais">
        {CARTOES.map(cartao => {
          const ativo = e.emAndamento && e.rotinaAtiva === cartao.id;
          const selo = situacaoDoSelo(ativo, e.ultimasPorRotina[cartao.id]);
          // A rotina em andamento vira "Acompanhar": o botão fica livre e leva ao console.
          const repetir = e.ultimasPorRotina[cartao.id]?.status === "falha";
          const rotulo = rotuloDoBotao(ativo, repetir);
          const bloqueado = botaoBloqueado({ ocupado: e.ocupado, emAndamento: e.emAndamento, acompanhar: ativo, semSaida: false });
          return (
            <article key={cartao.id} className="ck-cartao ck-rotina" data-rotina={cartao.id} data-estado={e.botoesProntos ? situacaoDoCartao(ativo, selo.status) : "ocioso"}>
              <span className="ck-rotina__icone" aria-hidden="true"><Icone nome={cartao.icone} /></span>
              <div className="ck-rotina__corpo">
                <div className="ck-rotina__cab">
                  <h3 className="ck-rotina__titulo" id={cartao.idTitulo}>{cartao.nome}</h3>
                  <Dica rotulo={`Sobre ${cartao.nome}`} idDica={cartao.idDica} fim={cartao.fim}>{cartao.dica}</Dica>
                </div>
                <span className="ck-badge" data-rotina-badge={cartao.id} data-status={e.botoesProntos ? selo.status : undefined}>
                  <Icone
                    nome={e.botoesProntos ? iconeDoSelo(ativo, selo.status) : "i-clock"}
                    classe={e.botoesProntos && ativo ? "ck-ico ck-ico--xs ck-girando" : "ck-ico ck-ico--xs"}
                  />
                  <span>{e.botoesProntos ? selo.texto : "—"}</span>
                </span>
              </div>
              <button
                type="button" id={`btn-automacao-${cartao.id}`} data-automacao-rotina={cartao.id}
                className={`ck-btn ${e.botoesProntos && ativo ? "ck-btn--primario" : "ck-btn--secundario"} ck-btn--sm ck-btn--icone`}
                aria-label={e.botoesProntos ? `${rotulo} ${cartao.nome}` : `Executar ${cartao.nome}`}
                title={e.botoesProntos ? rotulo : "Executar"} aria-describedby={cartao.idTitulo}
                data-on-click="iniciarRotinaAutomacao" data-args={args(cartao.id)}
                disabled={e.botoesProntos ? bloqueado : undefined} aria-disabled={e.botoesProntos ? bloqueado : undefined}
                aria-busy={e.iniciando === cartao.id ? "true" : undefined}
              >
                <Icone nome={e.botoesProntos ? iconeDoBotao(ativo, repetir) : "i-play"} />
                <span className="ck-sr">{e.botoesProntos ? rotulo : "Executar"}</span>
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}

function Captura({ execucao, captura }: { execucao: Execucao; captura: { nome: string; url: string } }) {
  const [falhou, setFalhou] = useState(false);
  const descricao = descricaoDaCaptura(execucao);
  return (
    <span className="automation-capture">
      <button
        type="button" className="automation-capture-thumb" aria-haspopup="dialog" aria-label={`Ampliar captura ${captura.nome}`} disabled={falhou}
        onClick={evento => abrirCapturaAutomacao(captura, descricao, execucao.mensagem, evento.currentTarget)}
      >
        {falhou
          ? <span className="automation-capture-missing">Captura indisponível</span>
          : <img src={captura.url} alt={descricao} loading="lazy" decoding="async" onError={() => setFalhou(true)} />}
      </button>
      <a className="automation-history-link" href={captura.url} target="_blank" rel="noopener noreferrer">{captura.nome}</a>
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
          <span className="ck-status" data-status={visual} title={execucao.mensagem || undefined}>
            <Icone nome={ICONE_STATUS[visual]} classe={visual === "info" ? "ck-ico ck-ico--xs ck-girando" : "ck-ico ck-ico--xs"} />
            {STATUS[execucao.status] || execucao.status || "—"}
          </span>
          {execucao.mensagem && execucao.status !== "concluido" && <small className="automation-history-message">{execucao.mensagem}</small>}
          <button
            type="button" className="ck-btn ck-btn--fantasma ck-btn--sm" data-on-click="abrirLogExecucaoAutomacao"
            data-args={args(execucao.id, execucao.inicio)} aria-label={`Ver log de ${nome} em ${formatarHora(execucao.inicio)}`}
          >Ver log</button>
          {capturas.length > 0 && (
            <span className="automation-history-captures">
              {capturas.map((captura, indice) => <Captura key={`${captura.url}-${indice}`} execucao={execucao} captura={captura} />)}
            </span>
          )}
        </span>
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
      <thead><tr>{["Rotina", "Início", "Duração", "Status"].map(titulo => <th key={titulo} scope="col">{titulo}</th>)}</tr></thead>
      <tbody>{historico.execucoes.map(execucao => <LinhaHistorico key={execucao.id} execucao={execucao} />)}</tbody>
    </table>
  );
}

export function Historico() {
  const e = useAutomacao();
  return (
    <>
      <div className="ck-cartao__cab"><h2 className="ck-cartao__titulo" id="automacao-historico-titulo">Últimas execuções</h2><span className="ck-cartao__meta" id="automacao-historico-resumo" role="status">{e.resumoHist}</span></div>
      <div className="ck-filtros-linha" id="automacao-historico-filtros" role="group" aria-label="Filtros de execuções">
        <label className="ck-campo"><span className="ck-campo__rotulo">De</span><input className="ck-entrada ck-entrada--sm" type="date" id="automacao-historico-inicio" /></label>
        <label className="ck-campo"><span className="ck-campo__rotulo">Até</span><input className="ck-entrada ck-entrada--sm" type="date" id="automacao-historico-fim" /></label>
        <label className="ck-campo">
          <span className="ck-campo__rotulo">Rotina</span>
          <select className="ck-entrada ck-entrada--sm" id="automacao-historico-rotina">
            <option value="">Todas</option>
            {ROTINAS_DO_FILTRO.map(rotina => <option key={rotina} value={rotina}>{ROTINAS[rotina]}</option>)}
          </select>
        </label>
        <label className="ck-campo">
          <span className="ck-campo__rotulo">Status</span>
          <select className="ck-entrada ck-entrada--sm" id="automacao-historico-status">
            <option value="">Todos</option>
            {STATUS_DO_FILTRO.map(status => <option key={status} value={status}>{STATUS[status]}</option>)}
          </select>
        </label>
        <button type="button" className="ck-btn ck-btn--primario ck-btn--sm" data-on-click="filtrarHistoricoAutomacao">Aplicar</button>
        <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm" data-on-click="limparFiltrosAutomacao">Limpar</button>
      </div>
      <div className="ck-cartao__corpo" id="automacao-historico"><ListaHistorico /></div>
      <nav className="ck-paginacao" aria-label="Páginas das execuções">
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
        <h2 className="ck-console__titulo" id="automacao-andamento-titulo">Console de atividades</h2>
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
      <ol id="cockpit-automation-events" className="ck-log" role="list" aria-live="polite" aria-relevant="additions text" aria-label="Eventos da execução" tabIndex={0}>
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
    <section className="ck-dialogo" role="dialog" aria-modal="true" aria-labelledby="ck-dialogo-log-titulo">
      <header className="ck-dialogo__cab"><h2 className="ck-dialogo__titulo" id="ck-dialogo-log-titulo">Log completo</h2><span id="automacao-log-arquivo" className="ck-cartao__meta">{visao.arquivoTexto}</span><button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm" data-fechar="ck-dialogo-log" aria-label="Fechar">Fechar</button></header>
      <pre ref={area} id="automacao-log" className="ck-log-bruto" role="log" aria-live={visao.historico ? "off" : "polite"} aria-labelledby="automacao-andamento-titulo" tabIndex={0}>{visao.texto}</pre>
    </section>
  );
}
