// Lista de lembretes (vistas Hoje e Em breve, faixa da semana, grupos, itens, edição e Concluídos), com o mesmo DOM do
// painel antigo. A descrição de um lembrete tem dado pessoal: só vira texto na tela, nunca log nem storage.
import { Fragment, memo } from "react";
import { IconeCalendario, IconeFechar, IconeMais, IconeSprite } from "./componentes";
import { ler, mudar, type Estado } from "./estado";
import {
  adicionarNoDia, alternar, alternarConcluidos, aoDigitar, aoMudarData, cancelarEdicao, editar, excluir, gerarPdfTermo, irParaDia, mudarSemana,
  preencherTermo, reagendarAtrasados, removerData, salvarEdicao, selecionarVista, teclaEdicao, teclaVista,
} from "./lembretes-acoes";
import {
  dataDe, dataExibida, DIAS_CURTOS, diaDaSemana, formatarData, horaDe, LIMITE, rotuloAgenda, semanaDe, tamanho, tituloSemana,
  type GrupoVista, type Lembrete, type ListaDerivada,
} from "./lembretes-puro";
import { termosSecoesLembrete } from "./termos-puro";
import { appAntigo, referenciasNoTexto } from "./tipos";

// Cada componente recebe só o pedaço do estado que usa: assim digitar em "Novo lembrete" não redesenha a lista.
interface PropsItens {
  hoje: string;
  editandoId: Estado["editandoId"];
  edicao: Estado["edicao"];
  termosAbertos: string[];
}

// Chamado UTIC-AAAA-N e OS de 7 dígitos no texto viram botão que abre a janela Chamado × OS (só leitura); o resto fica texto puro.
function Referencia({ tipo, numero, texto }: { tipo: string; numero: string; texto: string }) {
  return (
    <button
      type="button"
      className="ck-link-btn ck-mono lembretes__ref"
      aria-haspopup="dialog"
      aria-label={`${tipo === "chamado" ? "Abrir o chamado" : "Abrir a OS"} ${numero} na janela Chamado × OS`}
      // Mesmo valor de antes: ao fechar a janela, o foco volta ao botão equivalente pelo data-args (ferramentas-cockpit/estado.ts).
      data-args={JSON.stringify([{ tipo, numero }, "$this"])}
      onClick={(e) => appAntigo().abrirReferenciaLembrete?.({ tipo, numero }, e.currentTarget)}
    >
      {texto}
    </button>
  );
}

function TextoLembrete({ descricao }: { descricao: string }) {
  return (
    <p className="lembretes__texto">
      {referenciasNoTexto(descricao).map((parte, i) => (
        <Fragment key={i}>
          {parte.tipo && parte.numero ? <Referencia tipo={parte.tipo} numero={parte.numero} texto={parte.texto} /> : parte.texto}
        </Fragment>
      ))}
    </p>
  );
}

// Bloco recolhível com os dados salvos do termo (só lembretes criados de um termo com a cópia gravada).
function BlocoTermo({ l, abertos }: { l: Lembrete; abertos: string[] }) {
  const secoes = l.termo ? termosSecoesLembrete(l.origem, l.termo) : null;
  if (!secoes) return null;
  const id = String(l.id);
  return (
    <details
      className="lembretes__termo"
      open={abertos.includes(id)}
      onToggle={(e) => {
        const aberto = e.currentTarget.open;
        const atuais = ler().termosAbertos;
        if (aberto === atuais.includes(id)) return;
        mudar({ termosAbertos: aberto ? [...atuais, id] : atuais.filter((outro) => outro !== id) });
      }}
    >
      <summary className="lembretes__termo-resumo">Dados do termo</summary>
      {secoes.map((s) => (
        <section className="lembretes__termo-secao" key={s.titulo}>
          <h3 className="lembretes__termo-titulo">{s.titulo}</h3>
          {s.texto !== undefined ? (
            <p className="lembretes__termo-obs">{s.texto}</p>
          ) : (
            <dl className="lembretes__termo-campos">
              {(s.campos ?? []).map(([rotulo, valor]) => (
                <div className="lembretes__termo-linha" key={rotulo}>
                  <dt>{rotulo}</dt>
                  <dd>{valor}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
      <div className="lembretes__termo-acoes">
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" onClick={() => { void gerarPdfTermo(l.id); }}>Gerar PDF</button>
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" onClick={() => { void preencherTermo(l.id); }}>Preencher no Termo</button>
      </div>
    </details>
  );
}

// Campo nativo de data ou de hora com rótulo visível (Data, Hora (opcional)); id e escopo definem qual é.
export function CampoDataHora({ escopo, tipo, rotulo, valor, desligado = false }: {
  escopo: "novo" | "edicao"; tipo: "data" | "hora"; rotulo: string; valor: string; desligado?: boolean;
}) {
  const id = `lembretes-${escopo}-${tipo}`;
  return (
    <div className="lembretes__campo-data">
      <label className="lembretes__rotulo-campo" htmlFor={id}>{rotulo}</label>
      <input
        type={tipo === "data" ? "date" : "time"}
        id={id}
        className="ck-entrada"
        value={valor}
        disabled={desligado}
        max={tipo === "data" ? "9999-12-31" : undefined}
        onChange={(e) => aoMudarData(e.target)}
      />
    </div>
  );
}

export function BotaoRemoverData({ escopo }: { escopo: "novo" | "edicao" }) {
  return (
    <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm lembretes__remover-data" onClick={() => removerData(escopo)}>
      <IconeFechar tamanho={14} />
      Remover data
    </button>
  );
}

// Edição no lugar: campo, erro, data/hora/remover, botões e, por último, a dica das teclas (como no modelo).
function Edicao({ l, edicao }: { l: Lembrete; edicao: Estado["edicao"] }) {
  const n = tamanho(edicao.descricao.trim());
  return (
    <form
      className="lembretes__edicao"
      autoComplete="off"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void salvarEdicao(l.id); }}
      // O Esc vale em qualquer campo da edição (descrição, data ou hora): o evento sobe até o formulário.
      onKeyDown={(e) => teclaEdicao(e)}
    >
      <label className="sr-only" htmlFor="lembretes-edicao-campo">Editar descrição</label>
      <input
        type="text"
        id="lembretes-edicao-campo"
        className="ck-entrada lembretes__campo"
        autoComplete="off"
        aria-describedby="lembretes-edicao-dica lembretes-edicao-erro"
        aria-invalid={n > LIMITE}
        value={edicao.descricao}
        onChange={(e) => aoDigitar(e.target)}
      />
      <p className="lembretes__erro" id="lembretes-edicao-erro" role="alert" hidden={n <= LIMITE}>{`A descrição pode ter até ${LIMITE} caracteres.`}</p>
      <div className="lembretes__edicao-agenda">
        <CampoDataHora escopo="edicao" tipo="data" rotulo="Data" valor={edicao.data} />
        {/* Hora sem data não existe: sem data, o campo da hora fica desligado. */}
        <CampoDataHora escopo="edicao" tipo="hora" rotulo="Hora (opcional)" valor={edicao.hora} desligado={edicao.horaDesligada} />
        <BotaoRemoverData escopo="edicao" />
      </div>
      <div className="lembretes__edicao-acoes">
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" aria-keyshortcuts="Escape" onClick={() => cancelarEdicao(l.id)}>
          Cancelar
          <kbd aria-hidden="true">Esc</kbd>
        </button>
        <button type="submit" className="ck-btn ck-btn--primario ck-btn--sm" aria-keyshortcuts="Enter" disabled={n === 0 || n > LIMITE}>
          Salvar
          <kbd aria-hidden="true">Enter</kbd>
        </button>
      </div>
      {/* Novo layout: as teclas aparecem nos botões; o texto da dica fica só para leitor de tela (aria-describedby do campo). */}
      <p className="lembretes__dica sr-only" id="lembretes-edicao-dica">
        <kbd>Enter</kbd>
        {" salva · "}
        <kbd>Esc</kbd>
        {" cancela"}
      </p>
    </form>
  );
}

function BotaoIcone({ classe, rotulo, icone, aoClicar }: { classe: string; rotulo: string; icone: string; aoClicar: () => void }) {
  return (
    // Sprite do index.html (#i-<nome>): o subconjunto do lucide não traz pencil nem trash.
    <button type="button" className={`lembretes__acao ${classe}`} aria-label={rotulo} title={rotulo} onClick={aoClicar}>
      <IconeSprite nome={icone} />
    </button>
  );
}

const Item = memo(function Item({ l, hoje, editandoId, edicao, termosAbertos }: { l: Lembrete } & PropsItens) {
  const editando = String(l.id) === String(editandoId);
  const classe = ["lembretes__item", l.concluido && "lembretes__item--feito", editando && "lembretes__item--editando"].filter(Boolean).join(" ");
  if (editando) {
    return (
      <li className={classe} data-lembrete-id={String(l.id)}>
        {/* Anel só visual: o item segue no lugar, como no modelo; concluir fica para depois de salvar ou cancelar. */}
        <span className="lembretes__marcar lembretes__marcar--fixo" aria-hidden="true" />
        <Edicao l={l} edicao={edicao} />
      </li>
    );
  }
  const dia = dataDe(l);
  // span e não <time>: o único <time> do item é o de Criado/Alterado em.
  const classeAgenda = dia && (!l.concluido && dia < hoje ? " lembretes__agenda--atrasada" : dia === hoje ? " lembretes__agenda--hoje" : "");
  return (
    <li className={classe} data-lembrete-id={String(l.id)}>
      <button
        type="button"
        className="lembretes__marcar"
        aria-label={`${l.concluido ? "Desmarcar" : "Concluir"}: ${l.descricao}`}
        onClick={() => { void alternar(l.id); }}
      />
      <div className="lembretes__corpo">
        <TextoLembrete descricao={l.descricao} />
        {dia && (
          <span className={`lembretes__agenda${classeAgenda}`}>
            <IconeCalendario tamanho={12} />
            {rotuloAgenda(dia, horaDe(l), hoje)}
          </span>
        )}
        <time className={l.alterado_em ? "lembretes__data lembretes__data--alterado" : "lembretes__data"} dateTime={dataExibida(l)}>
          {`${l.alterado_em ? "Alterado" : "Criado"} em ${formatarData(dataExibida(l))}`}
        </time>
        <BlocoTermo l={l} abertos={termosAbertos} />
      </div>
      <div className="lembretes__acoes">
        <BotaoIcone classe="lembretes__editar" rotulo="Editar lembrete" icone="pencil" aoClicar={() => editar(l.id)} />
        <BotaoIcone classe="lembretes__excluir" rotulo="Excluir lembrete" icone="trash" aoClicar={() => excluir(l.id)} />
      </div>
    </li>
  );
});

// Um grupo da vista: título, contagem, Reagendar (só em Atrasada), itens e + Adicionar lembrete (só nos dias).
const Grupo = memo(function Grupo({ grupo, ...itens }: { grupo: GrupoVista } & PropsItens) {
  const idTitulo = `lembretes-grupo-${grupo.chave}`;
  return (
    <section className="lembretes__grupo" data-grupo={grupo.chave} aria-labelledby={idTitulo}>
      <div className="lembretes__grupo-topo">
        <h3 className="lembretes__grupo-titulo" id={idTitulo} tabIndex={-1}>{grupo.titulo}</h3>
        {grupo.n !== undefined && <span className="lembretes__grupo-n">{String(grupo.n)}</span>}
        {grupo.reagendar && (
          <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm lembretes__reagendar" onClick={() => { void reagendarAtrasados(); }}>
            Reagendar para hoje
          </button>
        )}
        {grupo.adicionar && (
          <button
            type="button"
            className="lembretes__adicionar-dia"
            aria-label={`Adicionar lembrete em ${grupo.titulo}`}
            onClick={() => adicionarNoDia(grupo.data as string)}
          >
            <IconeMais tamanho={14} />
            Adicionar lembrete
          </button>
        )}
      </div>
      {grupo.itens.length > 0 && (
        <ul className="lembretes__lista lembretes__itens">
          {grupo.itens.map((l) => <Item key={l.id} l={l} {...itens} />)}
        </ul>
      )}
    </section>
  );
});

export const Grupos = memo(function Grupos({ lista, vista, ...itens }: { lista: ListaDerivada; vista: Estado["vista"] } & PropsItens) {
  return (
    <div className="lembretes__grupos" id="lembretes-lista" role="tabpanel" aria-labelledby={`lembretes-aba-${vista}`}>
      {lista.grupos.map((grupo) => <Grupo key={grupo.chave} grupo={grupo} {...itens} />)}
    </div>
  );
});

export const Concluidos = memo(function Concluidos({ lista, concluidosAbertos, ...itens }: { lista: ListaDerivada; concluidosAbertos: boolean } & PropsItens) {
  const total = lista.concluidos.length;
  return (
    <div className="lembretes__concluidos" id="lembretes-concluidos" hidden={total === 0}>
      <button
        type="button"
        className="lembretes__recolher"
        id="lembretes-concluidos-botao"
        aria-expanded={concluidosAbertos}
        aria-controls="lembretes-concluidos-lista"
        onClick={alternarConcluidos}
      >
        <IconeSprite nome="chevron-right" classe="ck-ico lembretes__seta" />
        <span id="lembretes-concluidos-rotulo">{`Concluídos (${total})`}</span>
      </button>
      <ul className="lembretes__lista" id="lembretes-concluidos-lista" aria-label="Lembretes concluídos" hidden={!concluidosAbertos}>
        {lista.concluidos.map((l) => <Item key={l.id} l={l} {...itens} />)}
      </ul>
    </div>
  );
});

// Pílulas Hoje <n> / Em breve e a navegação ‹ Hoje › (só em Em breve).
export const Vistas = memo(function Vistas({ lista, hoje, vista }: { lista: ListaDerivada; hoje: string; vista: Estado["vista"] }) {
  const contagemHoje = lista.agrupado.atrasados.length + (lista.agrupado.porDia.get(hoje)?.length ?? 0);
  const embreve = vista === "embreve";
  return (
    <div className="lembretes__barra">
      <div className="ck-pilulas lembretes__vistas" role="tablist" aria-label="Vistas de lembretes" onKeyDown={(e) => teclaVista(e)}>
        <button
          type="button"
          className="ck-pilula"
          role="tab"
          id="lembretes-aba-hoje"
          aria-selected={!embreve}
          tabIndex={embreve ? -1 : 0}
          aria-controls="lembretes-lista"
          onClick={() => selecionarVista("hoje")}
        >
          Hoje{" "}
          <span className="ck-pilula__n" id="lembretes-hoje-n">{String(contagemHoje)}</span>
        </button>
        <button
          type="button"
          className="ck-pilula"
          role="tab"
          id="lembretes-aba-embreve"
          aria-selected={embreve}
          tabIndex={embreve ? 0 : -1}
          aria-controls="lembretes-lista"
          onClick={() => selecionarVista("embreve")}
        >
          Em breve
        </button>
      </div>
    </div>
  );
});

// ‹ Hoje › da semana (só em Em breve); no Novo layout fica ao lado do mês, dentro de Semana.
function NavegarSemana({ vista, semanaAtual }: { vista: Estado["vista"]; semanaAtual: number }) {
  return (
    <div className="lembretes__navegar" id="lembretes-navegar" hidden={vista !== "embreve"}>
      <button
        type="button"
        className="lembretes__nav lembretes__nav--anterior"
        id="lembretes-semana-anterior"
        aria-label="Semana anterior"
        disabled={semanaAtual === 0}
        onClick={() => mudarSemana(-1)}
      >
        <IconeSprite nome="chevron-right" />
      </button>
      <button type="button" className="lembretes__nav lembretes__nav--hoje" onClick={() => mudarSemana(0)}>Hoje</button>
      <button type="button" className="lembretes__nav" id="lembretes-semana-proxima" aria-label="Próxima semana" onClick={() => mudarSemana(1)}>
        <IconeSprite nome="chevron-right" />
      </button>
    </div>
  );
}

// Um dia da faixa da semana (Em breve): sem item possível antes de hoje, então o botão fica desligado.
function Dia({ data, hoje }: { data: string; hoje: string }) {
  return (
    <button
      type="button"
      className="lembretes__dia"
      data-dia={data}
      aria-current={data === hoje ? "date" : undefined}
      disabled={data < hoje}
      onClick={() => irParaDia(data)}
    >
      <span className="lembretes__dia-nome">{DIAS_CURTOS[diaDaSemana(data)]}</span>
      <span className="lembretes__dia-num">{String(Number(data.slice(8)))}</span>
    </button>
  );
}

export const Semana = memo(function Semana({ hoje, vista, semanaAtual }: { hoje: string; vista: Estado["vista"]; semanaAtual: number }) {
  const dias = semanaDe(hoje, semanaAtual);
  return (
    <div className="lembretes__semana" id="lembretes-semana" hidden={vista !== "embreve"}>
      <div className="lembretes__semana-cab">
        <p className="lembretes__mes" id="lembretes-mes" aria-live="polite">{vista === "embreve" ? tituloSemana(dias) : ""}</p>
        <NavegarSemana vista={vista} semanaAtual={semanaAtual} />
      </div>
      <div className="lembretes__faixa" id="lembretes-faixa" role="group" aria-label="Dias da semana">
        {vista === "embreve" && dias.map((d) => <Dia key={d} data={d} hoje={hoje} />)}
      </div>
    </div>
  );
});
