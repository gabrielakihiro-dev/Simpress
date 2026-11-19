// Cartões, itens e folhas da Cobertura (necessidades, disponíveis, reservas, em movimento, devoluções).
// Regra de vaga, kit e ações vem de ./modelo; aqui só desenho.
import { useRef, useState, type ReactNode } from "react";
import { CartaoBento } from "../../componentes/cartao-bento";
import { TabelaNl } from "../../componentes/tabela-nl";
import {
  acaoDevolucao, alterarKit, cancelarDevolucao, cancelarEReabrirVaga, cancelarMovimentacao, cancelarNecessidade, cancelarReserva,
  disponibilidade, entregarSemTransporte, mudarEstado, prepararTransporte, renovarReserva, resolverDivergencia, vincularHistorico,
} from "./acoes";
import { Botao, Campo, Grupo, Selo } from "./componentes";
import * as modelo from "./modelo";
import { casos, type Aba, type Dados, type Registro } from "./tipos";

/* ---------- Filtro por tipo de equipamento: o único trecho que liga um item ao perfil da necessidade ---------- */
// shortcut: os dados não têm campo de modelo/tipo; o tipo sai do texto livre "perfil" da necessidade ligada ao item.
// Item sem perfil conhecido só aparece em "Todos". Trocar só este bloco quando houver um campo próprio.
export type Tipo = "todos" | "notebook" | "desktop";
export const OPCOES_TIPO: readonly { valor: Tipo; rotulo: string }[] = [
  { valor: "todos", rotulo: "Todos" }, { valor: "notebook", rotulo: "Notebook" }, { valor: "desktop", rotulo: "Desktop" },
];

const tipoDoPerfil = (perfil: unknown): Tipo | null => {
  const texto = modelo.dobrar(perfil);
  return texto.includes("notebook") ? "notebook" : texto.includes("desktop") ? "desktop" : null;
};

export interface Ligacao { acao: Registro; vaga: Registro }

// Cada item chega ao perfil por um caminho: a vaga tem o perfil; disponível, reserva, movimentação e devolução o herdam da necessidade ligada.
function perfisPorItem(dados: Dados | null, porSerie: Map<string, Ligacao>) {
  const demandas = casos(dados, "demandas");
  const reservas = casos(dados, "reservas");
  const perfilDaDemanda = (id: unknown) => demandas[String(id)]?.perfil;
  const perfilDaSerie = new Map<string, unknown>(modelo.reservasAbertas(dados).map(r => [modelo.chaveSerie(r.serie), perfilDaDemanda(r.demanda_id)]));
  const perfilDaDevolucao = new Map<unknown, unknown>((dados?.vagas || []).filter(v => v.devolucao_id).map(v => [v.devolucao_id, v.perfil]));
  return {
    vaga: (vaga: Registro) => vaga.perfil,
    disponivel: (reg: Registro) => porSerie.get(modelo.chaveSerie(reg.serie))?.vaga.perfil ?? perfilDaSerie.get(modelo.chaveSerie(reg.serie)),
    reserva: (reserva: Registro) => perfilDaDemanda(reserva.demanda_id),
    movimento: (mov: Registro) => perfilDaDemanda(mov.demanda_id ?? reservas[String(mov.reserva_id)]?.demanda_id),
    devolucao: (dev: Registro) => perfilDaDevolucao.get(dev.id),
  };
}
const tipoPassa = (tipo: Tipo, perfil: unknown) => tipo === "todos" || tipoDoPerfil(perfil) === tipo;
/* ---------- fim do filtro por tipo ---------- */

export type Folha = { tipo: "necessidade" } | { tipo: "reservas" | "movimento" | "devolucoes"; id: string };

export interface Contexto {
  escrita: boolean; // false com o servidor bloqueado (503): nenhum botão que grava
  abrir: (folha: Folha) => void;
  aoReservar: (acao: Registro, vaga: Registro) => Promise<unknown>;
}

export interface Visao {
  vagas: Registro[];
  disponiveis: Registro[];
  lista: Registro[]; // tabela "Lista de disponíveis": só a busca filtra
  reservas: Registro[];
  movimentos: Registro[];
  devolucoes: Registro[];
  demandas: Record<string, Registro>;
  disponibilidades: Record<string, Registro>;
  porSerie: Map<string, Ligacao>;
  nota: (reg: Registro) => string;
}

export function montarVisao(dados: Dados | null, textoBusca: string, tipo: Tipo): Visao {
  const busca = modelo.dobrar(textoBusca);
  const demandas = casos(dados, "demandas");
  const disponibilidades = casos(dados, "disponibilidade");
  const porSerie = new Map<string, Ligacao>();
  for (const vaga of dados?.vagas || []) {
    const acao = modelo.acaoDaVaga(vaga);
    const chave = modelo.chaveSerie(vaga.serie);
    if (acao?.tipo === "reservar" && !porSerie.has(chave)) porSerie.set(chave, { acao, vaga });
  }
  const perfis = perfisPorItem(dados, porSerie);
  const achaBusca = (...textos: unknown[]) => !busca || textos.some(t => modelo.dobrar(t).includes(busca));
  const bloqueios = new Map<string, string>((dados?.bloqueios || []).map(b => [modelo.chaveSerie(b.serie), b.motivo]));
  const sinais = new Map<string, string>((dados?.sinais || []).map(s => [modelo.chaveSerie(s.serie), s.sinal]));
  const porSerieAlfa = (a: Registro, b: Registro) => String(a.serie).localeCompare(String(b.serie));
  // A cidade da vaga também conta: quem busca pela cidade da vaga não pode perder o botão Reservar.
  const lista = Object.values(disponibilidades)
    .filter(reg => achaBusca(reg.serie, reg.cidade, porSerie.get(modelo.chaveSerie(reg.serie))?.vaga.cidade))
    .sort(porSerieAlfa);
  return {
    vagas: (dados?.vagas || []).filter(vaga => tipoPassa(tipo, perfis.vaga(vaga)) && achaBusca(vaga.serie, vaga.cidade)),
    // Quem já tem vaga para reservar vem primeiro.
    disponiveis: lista.filter(reg => tipoPassa(tipo, perfis.disponivel(reg)))
      .sort((a, b) => Number(porSerie.has(modelo.chaveSerie(b.serie))) - Number(porSerie.has(modelo.chaveSerie(a.serie))) || porSerieAlfa(a, b)),
    lista,
    reservas: modelo.reservasAbertas(dados).filter(r => tipoPassa(tipo, perfis.reserva(r)) && achaBusca(r.serie, demandas[r.demanda_id]?.cidade)),
    movimentos: modelo.movimentacoesAbertas(dados)
      .filter(m => tipoPassa(tipo, perfis.movimento(m)) && achaBusca(m.serie, m.destino_cidade))
      .sort((a, b) => String(a.criada_em).localeCompare(String(b.criada_em))),
    devolucoes: modelo.devolucoesAbertas(dados).filter(d => tipoPassa(tipo, perfis.devolucao(d)) && achaBusca(d.serie, d.cidade)),
    demandas,
    disponibilidades,
    porSerie,
    nota: reg => {
      const chave = modelo.chaveSerie(reg.serie);
      return [bloqueios.has(chave) ? modelo.textoBloqueio(bloqueios.get(chave)) : "", sinais.get(chave) || ""].filter(Boolean).join(" · ");
    },
  };
}

/* ---------- Cartões ---------- */

const EM_BRANCO = (texto: unknown) => (texto === undefined || texto === null || texto === "" ? "—" : String(texto));

export function Cab({ titulo, icone, n, aba }: { titulo: string; icone: ReactNode; n?: number; aba?: Aba }) {
  return (
    <div className="ck-bento-cab">
      <span className="ck-bento-icone" aria-hidden="true">{icone}</span>
      <h3 className="ck-bento-titulo">{titulo}</h3>
      {n === undefined ? null : <span className="cob__n" data-cobertura-n={aba}>{String(n)}</span>}
    </div>
  );
}

// Mostra só os primeiros itens; "Ver todos" abre o resto no próprio cartão.
function Lista({ id, itens, limite, ocupado, vazio }: { id: string; itens: ReactNode[]; limite: number; ocupado: boolean; vazio: string }) {
  const [aberta, setAberta] = useState(false);
  return (
    <>
      <ul id={id} className="cob__lista" aria-busy={ocupado ? "true" : undefined}>
        {itens.length ? (aberta ? itens : itens.slice(0, limite)) : vazio ? <li className="cob__vazio">{vazio}</li> : null}
      </ul>
      {itens.length > limite ? (
        <button type="button" className="cob__mais" aria-expanded={aberta} aria-controls={id} onClick={() => setAberta(valor => !valor)}>
          {aberta ? "Mostrar menos" : `Ver todos os ${itens.length} →`}
        </button>
      ) : null}
    </>
  );
}

const Abrir = ({ rotulo, serie, ctx, folha }: { rotulo: string; serie: string; ctx: Contexto; folha: Folha }) => (
  ctx.escrita
    ? <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" aria-label={`${rotulo} — ${serie}`} onClick={() => ctx.abrir(folha)}>{rotulo}</button>
    : null
);

function ItemNecessidade({ vaga, visao, ctx }: { vaga: Registro; visao: Visao; ctx: Contexto }) {
  const demanda = visao.demandas[vaga.demanda_id] || {};
  const acao = modelo.acaoDaVaga(vaga);
  const espera = acao?.tipo === "reservar_espera" ? acao : null;
  const cancelavel = vaga.indice === 1 && demanda.estado === "aberta";
  return (
    <li className="cob__item">
      <div className="cob__lin"><strong className="cob__tit">{vaga.cidade}</strong><span className="cob__k">{`${vaga.indice}/${demanda.quantidade || vaga.indice}`}</span></div>
      <span className="cob__k">{`${modelo.formatarData(vaga.data)} · ${vaga.perfil || "—"}${vaga.monitor ? " + monitor" : ""}`}</span>
      <Grupo classe="cob__selos">
        {modelo.selosDaVaga(vaga).map((selo: { texto: string; status: string }, n: number) => <Selo key={n} {...selo} />)}
        {vaga.motivo ? <span className="cob__nota">{vaga.motivo}</span> : null}
      </Grupo>
      {vaga.serie ? <span className="cob__k">Série <span className="cob__serie">{vaga.serie}</span></span> : null}
      {ctx.escrita && (espera || cancelavel) ? (
        <Grupo classe="cob__acoes">
          {espera ? <Botao rotulo={espera.rotulo} variante="secundario" aoClicar={() => ctx.aoReservar(espera, vaga)} rotuloAcessivel={`${espera.rotulo} — ${vaga.serie || ""} para ${vaga.cidade}`} /> : null}
          {cancelavel ? <Botao rotulo="Cancelar necessidade" variante="perigo" aoClicar={() => cancelarNecessidade(demanda)} rotuloAcessivel={`Cancelar necessidade de ${demanda.cidade}`} /> : null}
        </Grupo>
      ) : null}
    </li>
  );
}

export function ListaNecessidades({ visao, ctx, ocupado, carregado }: { visao: Visao; ctx: Contexto; ocupado: boolean; carregado: boolean }) {
  const itens = visao.vagas.map(vaga => <ItemNecessidade key={`${vaga.demanda_id}-${vaga.indice}`} vaga={vaga} visao={visao} ctx={ctx} />);
  return <Lista id="cobertura-lista-necessidades" itens={itens} limite={6} ocupado={ocupado} vazio={carregado ? "Nenhuma necessidade" : ""} />;
}

function ItemDisponivel({ reg, visao, ctx }: { reg: Registro; visao: Visao; ctx: Contexto }) {
  const estado = reg.estado_efetivo || reg.estado;
  const ligacao = visao.porSerie.get(modelo.chaveSerie(reg.serie));
  const nota = visao.nota(reg);
  return (
    <li className="cob__item">
      <div className="cob__lin">
        <span className="cob__serie">{reg.serie}</span>
        <Selo texto={modelo.DISPONIBILIDADE[estado] || estado} status={estado === "disponivel" ? "ok" : estado === "a_confirmar" ? "alerta" : "erro"} />
      </div>
      <span className="cob__k">{reg.cidade || "—"}</span>
      {nota ? <span className="cob__nota">{nota}</span> : null}
      {ctx.escrita && ligacao ? (
        <Grupo classe="cob__acoes">
          <Botao rotulo="Reservar" variante="primario" aoClicar={() => ctx.aoReservar(ligacao.acao, ligacao.vaga)} rotuloAcessivel={`Reservar — ${reg.serie} para ${ligacao.vaga.cidade}`} />
        </Grupo>
      ) : null}
    </li>
  );
}

const SelosReserva = ({ reserva }: { reserva: Registro }) => (
  <Grupo classe="cob__selos">
    <Selo texto={modelo.ESTADO_RESERVA[reserva.estado] || reserva.estado} status={reserva.estado === "ativa" ? "ok" : "alerta"} />
    {reserva.kit_pronto ? <Selo texto="Kit pronto" status="ok" /> : null}
    {reserva.vencida ? <Selo texto="Reserva vencida" status="alerta" /> : null}
  </Grupo>
);

const tipoDivergencia = (mov: Registro): string =>
  mov.divergencia ? (modelo.TIPOS_DIVERGENCIA.find(([v]) => v === mov.divergencia.tipo) || [])[1] || mov.divergencia.tipo : "";

const SelosMovimento = ({ mov }: { mov: Registro }) => (
  <Grupo classe="cob__selos">
    <Selo texto={modelo.ESTADO_MOVIMENTACAO[mov.estado] || mov.estado} status={mov.estado === "recebida_com_divergencia" ? "erro" : "info"} />
    {mov.tipo === "local" ? <Selo texto="Sem Transporte" status="info" /> : null}
    {mov.divergencia ? <span className="cob__nota">{[tipoDivergencia(mov), mov.divergencia.descricao, mov.divergencia.serie_recebida].filter(Boolean).join(" · ")}</span> : null}
  </Grupo>
);

const situacaoDaDevolucao = (dev: Registro): string => dev.situacao || dev.estado;
const SeloDevolucao = ({ dev }: { dev: Registro }) => (
  <Selo texto={modelo.SITUACAO_DEVOLUCAO[situacaoDaDevolucao(dev)] || situacaoDaDevolucao(dev)} status={situacaoDaDevolucao(dev) === "atrasada" ? "erro" : "info"} />
);

function ItemReserva({ reserva, visao, ctx }: { reserva: Registro; visao: Visao; ctx: Contexto }) {
  const demanda = visao.demandas[reserva.demanda_id] || {};
  return (
    <li className="cob__item">
      <div className="cob__lin"><span className="cob__serie">{reserva.serie}</span><span className="cob__k">{`até ${modelo.formatarData(reserva.valida_ate) || "—"}`}</span></div>
      <span className="cob__k">{`${demanda.cidade || "—"} · ${modelo.formatarData(demanda.data) || "—"}`}</span>
      <SelosReserva reserva={reserva} />
      <Abrir rotulo="Abrir" serie={reserva.serie} ctx={ctx} folha={{ tipo: "reservas", id: reserva.id }} />
    </li>
  );
}

function ItemMovimento({ mov, ctx }: { mov: Registro; ctx: Contexto }) {
  return (
    <li className="cob__item">
      <div className="cob__lin"><span className="cob__serie">{mov.serie}</span></div>
      <span className="cob__k">{mov.destino_cidade || "—"}</span>
      <SelosMovimento mov={mov} />
      <Abrir rotulo="Acompanhar" serie={mov.serie} ctx={ctx} folha={{ tipo: "movimento", id: mov.id }} />
    </li>
  );
}

function ItemDevolucao({ dev, ctx }: { dev: Registro; ctx: Contexto }) {
  return (
    <li className="cob__item">
      <div className="cob__lin"><span className="cob__serie">{dev.serie}</span><SeloDevolucao dev={dev} /></div>
      <span className="cob__k">{`${dev.cidade || "—"} · ${modelo.formatarData(dev.data_prevista) || "—"}`}</span>
      <Abrir rotulo="Receber" serie={dev.serie} ctx={ctx} folha={{ tipo: "devolucoes", id: dev.id }} />
    </li>
  );
}

const Desenho = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
// Ícones do desenho: check, calendário, caminhão e seta de volta.
export const ICONES = {
  disponiveis: <Desenho><path d="M20 6 9 17l-5-5" /></Desenho>,
  reservas: <Desenho><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></Desenho>,
  movimento: <Desenho><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></Desenho>,
  devolucoes: <Desenho><path d="M19 12H5M11 6l-6 6 6 6" /></Desenho>,
} as const;

interface CartoesProps { visao: Visao; ctx: Contexto; ocupado: boolean; carregado: boolean; chip: Aba }

// Os quatro cartões do bento. No celular só o do chip ativo aparece (CSS: .cob__oculto-cel).
export function Cartoes({ visao, ctx, ocupado, carregado, chip }: CartoesProps) {
  const oculto = (aba: Aba) => (chip === aba ? "" : " cob__oculto-cel");
  const vazio = (texto: string) => (carregado ? texto : "");
  return (
    <>
      <CartaoBento tom="esmeralda" atraso={0} className={`cob__cartao${oculto("disponiveis")}`}>
        <Cab titulo="Disponíveis" icone={ICONES.disponiveis} n={visao.disponiveis.length} aba="disponiveis" />
        <Lista id="cobertura-lista-disponiveis" limite={4} ocupado={ocupado} vazio={vazio("Nenhum disponível")}
          itens={visao.disponiveis.map(reg => <ItemDisponivel key={reg.serie} reg={reg} visao={visao} ctx={ctx} />)} />
      </CartaoBento>
      <CartaoBento tom="ciano" atraso={1} className={`cob__cartao cob__cartao--indigo${oculto("reservas")}`}>
        <Cab titulo="Reservas" icone={ICONES.reservas} n={visao.reservas.length} aba="reservas" />
        <Lista id="cobertura-lista-reservas" limite={4} ocupado={ocupado} vazio={vazio("Nenhuma reserva")}
          itens={visao.reservas.map(reserva => <ItemReserva key={reserva.id} reserva={reserva} visao={visao} ctx={ctx} />)} />
      </CartaoBento>
      <CartaoBento tom="ciano" atraso={2} className={`cob__cartao${oculto("movimento")}`}>
        <Cab titulo="Em movimento" icone={ICONES.movimento} n={visao.movimentos.length} aba="movimento" />
        <Lista id="cobertura-lista-movimento" limite={4} ocupado={ocupado} vazio={vazio("Nada em movimento")}
          itens={visao.movimentos.map(mov => <ItemMovimento key={mov.id} mov={mov} ctx={ctx} />)} />
      </CartaoBento>
      <CartaoBento tom="ambar" atraso={3} className={`cob__cartao${oculto("devolucoes")}`}>
        <Cab titulo="Devoluções" icone={ICONES.devolucoes} n={visao.devolucoes.length} aba="devolucoes" />
        <Lista id="cobertura-lista-devolucoes" limite={4} ocupado={ocupado} vazio={vazio("Nenhuma devolução")}
          itens={visao.devolucoes.map(dev => <ItemDevolucao key={dev.id} dev={dev} ctx={ctx} />)} />
      </CartaoBento>
    </>
  );
}

// Tabela no desktop, cartões no celular (TabelaNl).
export function ListaDisponiveis({ visao, ctx, carregado }: { visao: Visao; ctx: Contexto; carregado: boolean }) {
  return (
    <TabelaNl<Registro>
      legenda="Lista de disponíveis"
      linhas={visao.lista}
      chaveLinha={reg => String(reg.serie)}
      vazio={carregado ? "Nenhuma máquina registrada." : ""}
      colunas={[
        { chave: "serie", rotulo: "Série", render: reg => <span className="cob__serie">{reg.serie}</span> },
        { chave: "cidade", rotulo: "Cidade", render: reg => EM_BRANCO(reg.cidade) },
        {
          chave: "situacao",
          rotulo: "Situação",
          render: reg => {
            const estado = reg.estado_efetivo || reg.estado;
            return <Selo texto={modelo.DISPONIBILIDADE[estado] || estado} status={estado === "disponivel" ? "ok" : estado === "a_confirmar" ? "alerta" : "erro"} />;
          },
        },
        { chave: "valida", rotulo: "Válida até", render: reg => EM_BRANCO(modelo.formatarData(reg.valida_ate)) },
        { chave: "obs", rotulo: "Observação", render: reg => EM_BRANCO(visao.nota(reg)) },
        {
          chave: "acoes",
          rotulo: "Ações",
          render: reg => (ctx.escrita ? (
            <Grupo classe="cob__acoes">
              <Botao rotulo="Confirmar disponível" variante="secundario" aoClicar={() => disponibilidade(reg.serie, "disponivel", reg.rev)} rotuloAcessivel={`Confirmar disponível — ${reg.serie}`} />
              <Botao rotulo="Marcar manutenção" variante="fantasma" aoClicar={() => disponibilidade(reg.serie, "em_manutencao", reg.rev)} rotuloAcessivel={`Marcar manutenção — ${reg.serie}`} />
              <Botao rotulo="Marcar indisponível" variante="fantasma" aoClicar={() => disponibilidade(reg.serie, "indisponivel", reg.rev)} rotuloAcessivel={`Marcar indisponível — ${reg.serie}`} />
            </Grupo>
          ) : null),
        },
      ]}
    />
  );
}

/* ---------- Folhas (reserva, movimentação e devolução) ---------- */

// O kit inteiro espera a releitura: outro clique antes dela iria com o rev velho e voltaria 409.
// Não controlado: a caixa marca na hora e a gravação que falha desfaz a marca. A folha continua montada depois da releitura, então a trava sai em qualquer resultado.
// A trava é um ref (não `disabled`): desabilitar a caixa focada derrubaria o foco para o body; clique durante a gravação é ignorado e a marca volta.
// O aria-busy só informa (leitor de tela e testes) que o kit está gravando; quem trava é o ref, que vale já no primeiro clique.
function Kit({ reserva }: { reserva: Registro }) {
  const travado = useRef(false);
  const [gravando, setGravando] = useState(false);
  return (
    <fieldset className="cob__kit" aria-busy={gravando || undefined}>
      <legend className="sr-only">{`Kit da série ${reserva.serie}`}</legend>
      {modelo.itensKit(reserva).map(({ item, rotulo, marcado }: { item: string; rotulo: string; marcado: boolean }) => (
        <label key={item} className="cob__check">
          <input
            className="ck-entrada"
            type="checkbox"
            defaultChecked={marcado}
            onChange={async event => {
              const caixa = event.currentTarget;
              const novo = caixa.checked;
              if (travado.current) { caixa.checked = !novo; return; }
              travado.current = true;
              setGravando(true);
              try {
                const ok = await alterarKit(reserva, item, novo);
                if (!ok && caixa.isConnected) caixa.checked = !novo;
              } finally {
                travado.current = false;
                setGravando(false);
              }
            }}
          />
          <span>{rotulo}</span>
        </label>
      ))}
    </fieldset>
  );
}

function ConteudoReserva({ reserva, visao, fechar }: { reserva: Registro; visao: Visao; fechar: () => void }) {
  const demanda = visao.demandas[reserva.demanda_id] || {};
  const acoes: string[] = modelo.acoesDaReserva(reserva, demanda, visao.disponibilidades[modelo.chaveSerie(reserva.serie)]);
  return (
    <>
      <p className="cob__id"><span className="cob__serie">{reserva.serie}</span>{` · ${demanda.cidade || "—"} · ${modelo.formatarData(demanda.data) || "—"}`}</p>
      <SelosReserva reserva={reserva} />
      <span className="cob__k">{`Válida até ${modelo.formatarData(reserva.valida_ate) || "—"}`}</span>
      <Kit reserva={reserva} />
      <Grupo classe="cob__acoes">
        {acoes.map(acao => {
          if (acao === "renovar") return <Botao key={acao} rotulo="Renovar reserva" variante="secundario" aoClicar={() => renovarReserva(reserva)} rotuloAcessivel={`Renovar reserva — ${reserva.serie}`} />;
          if (acao === "cancelar") return <Botao key={acao} rotulo="Cancelar reserva" variante="perigo" aoClicar={() => cancelarReserva(reserva)} rotuloAcessivel={`Cancelar reserva — ${reserva.serie}`} />;
          // Fecha a folha só quando o Transporte abriu (prepararTransporte devolve a movimentação); se falhou, a folha fica com o aviso.
          if (acao === "preparar") return <Botao key={acao} rotulo="Preparar Transporte" variante="primario" aoClicar={async () => { if (await prepararTransporte(reserva, demanda)) fechar(); }} rotuloAcessivel={`Preparar Transporte — ${reserva.serie}`} />;
          if (acao === "local") return <Botao key={acao} rotulo="Entregar sem Transporte" variante="secundario" aoClicar={() => entregarSemTransporte(reserva)} rotuloAcessivel={`Entregar sem Transporte — ${reserva.serie}`} />;
          return null;
        })}
      </Grupo>
    </>
  );
}

function Vincular({ mov }: { mov: Registro }) {
  const [aberto, setAberto] = useState(false);
  const candidatos: Registro[] = Array.isArray(mov.candidatos_historico) ? mov.candidatos_historico : [];
  return (
    <>
      <Botao rotulo="Vincular transferência já gerada" variante="secundario" aoClicar={() => setAberto(true)} rotuloAcessivel={`Vincular transferência já gerada — ${mov.serie}`} />
      <div className="cob__sub">
        {!aberto ? null : !candidatos.length
          ? <p className="cob__nota">Nenhuma planilha gerada para esta série e destino depois da preparação. Gere a planilha de novo no Transporte.</p>
          : candidatos.map(c => {
            const quando = new Date(String(c.criado_em));
            const texto = `${Number.isNaN(quando.getTime()) ? c.criado_em : quando.toLocaleString("pt-BR")} · ${c.retirada_cidade || "—"} → ${c.entrega_cidade || "—"}`;
            return (
              <Grupo key={c.id} classe="cob__candidato">
                <span>{texto}</span>
                <Botao rotulo="Vincular esta planilha" variante="primario" aoClicar={() => vincularHistorico(mov, c.id)} rotuloAcessivel={`Vincular esta planilha — ${texto}`} />
              </Grupo>
            );
          })}
      </div>
    </>
  );
}

function Recebimento({ mov, hoje }: { mov: Registro; hoje?: string }) {
  const caixa = useRef<HTMLDivElement>(null);
  const campo = (nome: string) => caixa.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${nome}"]`)?.value ?? "";
  const recebimento = () => ({ recebido_por: campo("recebido_por").trim(), data: campo("data"), comprovante: campo("comprovante").trim() || null });
  return (
    <div ref={caixa} className="cob__sub cob__receber">
      <Campo rotulo="Recebido por"><input className="ck-entrada" type="text" name="recebido_por" maxLength={120} autoComplete="off" required /></Campo>
      <Campo rotulo="Data do recebimento"><input className="ck-entrada" type="date" name="data" defaultValue={hoje || ""} required /></Campo>
      <Campo rotulo="Comprovante (opcional)"><input className="ck-entrada" type="text" name="comprovante" maxLength={500} autoComplete="off" /></Campo>
      <Botao rotulo="Confirmar recebimento" variante="primario" aoClicar={() => mudarEstado(mov, "recebida", recebimento(), "Recebimento registrado.")} rotuloAcessivel={`Confirmar recebimento — ${mov.serie}`} />
      <Campo rotulo="Tipo da divergência">
        <select className="ck-entrada" name="tipo">
          {modelo.TIPOS_DIVERGENCIA.map(([valor, rotulo]: [string, string]) => <option key={valor} value={valor}>{rotulo}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Descrição"><input className="ck-entrada" type="text" name="descricao" maxLength={500} autoComplete="off" /></Campo>
      <Campo rotulo="Série recebida"><input className="ck-entrada" type="text" name="serie_recebida" maxLength={60} autoComplete="off" /></Campo>
      <Botao
        rotulo="Registrar divergência"
        variante="secundario"
        aoClicar={() => mudarEstado(mov, "recebida_com_divergencia", {
          ...recebimento(),
          divergencia: { tipo: campo("tipo"), descricao: campo("descricao").trim(), serie_recebida: campo("serie_recebida").trim() || null },
        }, "Divergência registrada.")}
        rotuloAcessivel={`Registrar divergência — ${mov.serie}`}
      />
    </div>
  );
}

function Resolver({ mov }: { mov: Registro }) {
  const serie = useRef<HTMLInputElement>(null);
  return (
    <>
      <Campo rotulo="Série recebida">
        <input ref={serie} className="ck-entrada" type="text" name="serie_recebida" maxLength={60} autoComplete="off" defaultValue={mov.divergencia?.serie_recebida || ""} />
      </Campo>
      <Botao rotulo="Aceitar e encerrar" variante="primario" aoClicar={() => resolverDivergencia(mov, { resolucao: "aceitar" }, "Divergência aceita.")} rotuloAcessivel={`Aceitar e encerrar — ${mov.serie}`} />
      <Botao
        rotulo="Corrigir série recebida"
        variante="secundario"
        aoClicar={() => resolverDivergencia(mov, { resolucao: "corrigir", serie_recebida: (serie.current?.value ?? "").trim() }, "Série recebida corrigida.")}
        rotuloAcessivel={`Corrigir série recebida — ${mov.serie}`}
      />
      <Botao rotulo="Cancelar e reabrir vaga" variante="perigo" aoClicar={() => cancelarEReabrirVaga(mov)} rotuloAcessivel={`Cancelar e reabrir vaga — ${mov.serie}`} />
    </>
  );
}

function ConteudoMovimento({ mov, hoje }: { mov: Registro; hoje?: string }) {
  const acoes: string[] = modelo.acoesDaMovimentacao(mov);
  return (
    <>
      <p className="cob__id"><span className="cob__serie">{mov.serie}</span>{` · ${mov.destino_cidade || "—"}`}</p>
      <SelosMovimento mov={mov} />
      <Grupo classe="cob__acoes">
        {acoes.map(acao => {
          if (acao === "vincular") return <Vincular key={acao} mov={mov} />;
          if (acao === "coletada") return <Botao key={acao} rotulo="Marcar coletada" variante="secundario" aoClicar={() => mudarEstado(mov, "coletada", {}, "Movimentação coletada.")} rotuloAcessivel={`Marcar coletada — ${mov.serie}`} />;
          if (acao === "em_transito") return <Botao key={acao} rotulo="Marcar em trânsito" variante="secundario" aoClicar={() => mudarEstado(mov, "em_transito", {}, "Movimentação em trânsito.")} rotuloAcessivel={`Marcar em trânsito — ${mov.serie}`} />;
          if (acao === "receber") return <Recebimento key={acao} mov={mov} hoje={hoje} />;
          if (acao === "cancelar") return <Botao key={acao} rotulo="Cancelar movimentação" variante="perigo" aoClicar={() => cancelarMovimentacao(mov)} rotuloAcessivel={`Cancelar movimentação — ${mov.serie}`} />;
          if (acao === "resolver") return <Resolver key={acao} mov={mov} />;
          return null;
        })}
      </Grupo>
    </>
  );
}

function ConteudoDevolucao({ dev }: { dev: Registro }) {
  const novaData = useRef<HTMLInputElement>(null);
  return (
    <>
      <p className="cob__id"><span className="cob__serie">{dev.serie}</span>{` · ${dev.cidade || "—"} · ${modelo.formatarData(dev.data_prevista) || "—"}`}</p>
      <SeloDevolucao dev={dev} />
      <Grupo classe="cob__acoes">
        <Botao rotulo="Receber devolução" variante="primario" aoClicar={() => acaoDevolucao(dev, "receber", {}, "Devolução recebida.")} rotuloAcessivel={`Receber devolução — ${dev.serie}`} />
        <Botao rotulo="Cancelar devolução" variante="perigo" aoClicar={() => cancelarDevolucao(dev)} rotuloAcessivel={`Cancelar devolução — ${dev.serie}`} />
        <Campo rotulo="Nova data prevista">
          <input ref={novaData} className="ck-entrada" type="date" name="data_prevista" defaultValue={dev.data_prevista || ""} />
        </Campo>
        <Botao rotulo="Reprogramar devolução" variante="secundario" aoClicar={() => acaoDevolucao(dev, "reprogramar", { data_prevista: novaData.current?.value ?? "" }, "Devolução reprogramada.")} rotuloAcessivel={`Reprogramar devolução — ${dev.serie}`} />
      </Grupo>
    </>
  );
}

const TITULO_FOLHA = { necessidade: "Registrar necessidade", reservas: "Reservas", movimento: "Em movimento", devolucoes: "Devoluções" } as const;
export const tituloDaFolha = (folha: Folha) => TITULO_FOLHA[folha.tipo];

// Conteúdo da folha lido dos dados atuais; null quando o item saiu da lista (a folha então fecha).
export function conteudoDaFolha(folha: Folha, dados: Dados | null, visao: Visao, fechar: () => void): ReactNode | null {
  if (folha.tipo === "reservas") {
    const reserva = modelo.reservasAbertas(dados).find(r => r.id === folha.id);
    return reserva ? <ConteudoReserva reserva={reserva} visao={visao} fechar={fechar} /> : null;
  }
  if (folha.tipo === "movimento") {
    const mov = modelo.movimentacoesAbertas(dados).find(m => m.id === folha.id);
    return mov ? <ConteudoMovimento mov={mov} hoje={dados?.hoje} /> : null;
  }
  if (folha.tipo === "devolucoes") {
    const dev = modelo.devolucoesAbertas(dados).find(d => d.id === folha.id);
    return dev ? <ConteudoDevolucao dev={dev} /> : null;
  }
  return null;
}
