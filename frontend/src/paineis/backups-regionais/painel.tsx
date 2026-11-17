// Resumo (F3), sub-aba Backups: o mesmo HTML que o módulo frontend/src/aplicacao/backups-regionais.ts desenhava até o Dia 2.
// Só o campo `backups_regionais` do /api/painel. O apelido pode ser nome de pessoa: aparece só nesta tela local,
// nunca em toast, console ou aria-live. O React escapa todo texto; nada aqui usa dangerouslySetInnerHTML.
import { Fragment, type ReactNode } from "react";

// Formato vindo do servidor, conferido campo a campo (lista, texto, inteiro).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Item = Record<string, any>;

const STATUS: Record<string, { rotulo: string; tom: string }> = {
  ok: { rotulo: "Backup disponível", tom: "ok" },
  conferir: { rotulo: "Conferir possível backup", tom: "alerta" },
  sem_backup: { rotulo: "Sem backup disponível", tom: "erro" },
  dados_insuficientes: { rotulo: "Dados insuficientes", tom: "info" },
};
const MOTIVOS: Record<string, string> = {
  // Candidatos (por que ainda não contam como backup).
  fonte_endpoint_indisponivel: "Endpoint indisponível: a verificação não foi possível",
  ausente_no_endpoint: "Não aparece no Endpoint",
  sem_verificacao_7_dias: "Sem verificação nos últimos 7 dias",
  encontrado_sem_usuario: "Verificada nos últimos 7 dias e sem usuário, mas o apelido não tem a marca de backup",
  // Conferência (o cadastro e o apelido não batem).
  serie_duplicada: "Série duplicada no cadastro ou no Endpoint",
  leitura_ambigua: "O apelido indica mais de uma cidade",
  cidade_divergente: "A cidade do apelido difere da cidade do cadastro",
  cidade_ausente: "Cadastro sem cidade; o apelido indica esta regional",
  // Excluídos (fora do cálculo).
  usuario_vigente: "Com usuário vigente",
  "bloqueio:reserva_ativa": "Reserva ativa",
  "bloqueio:reserva_vencida_em_revisao": "Reserva vencida em revisão",
  "bloqueio:reserva_em_espera": "Reserva em espera",
  "bloqueio:movimentacao_aberta": "Movimentação aberta",
  "bloqueio:devolucao_pendente": "Devolução pendente",
  "bloqueio:manutencao": "Em manutenção",
  "bloqueio:em_manutencao": "Em manutenção",
  "bloqueio:indisponivel": "Marcada como indisponível",
};
const MOTIVOS_CONFIRMACAO: Record<string, string> = {
  expirada: "a confirmação anterior expirou",
  cidade_mudou: "a confirmação anterior era de outra cidade",
  usuario_vigente: "a confirmação anterior perdeu o efeito: usuário vigente",
  bloqueio: "a confirmação anterior perdeu o efeito: máquina bloqueada",
};
const ORIGENS: Record<string, string> = { marca: "Marca no apelido", confirmacao: "Confirmado manualmente" };
const TITULO_TABELA = "Backups por regional prioritária";

export const lista = (valor: unknown): Item[] => (Array.isArray(valor) ? valor.filter(item => item && typeof item === "object") : []);
const texto = (valor: unknown) => (valor === null || valor === undefined ? "" : String(valor));
const inteiro = (valor: unknown) => (Number.isFinite(Number(valor)) ? Math.trunc(Number(valor)) : 0);
// Código desconhecido aparece cru, nunca some.
const traduzir = (mapa: Record<string, string>, codigo: unknown) => (Object.hasOwn(mapa, String(codigo)) ? mapa[String(codigo)] : texto(codigo));
const plural = (n: number, singular: string, pluralTexto: string) => (n === 1 ? singular : pluralTexto);
const data = (valor: unknown) => {
  const formatar = window.SimpressHistoryFormat?.formatarHorarioHistorico;
  return texto(formatar ? formatar(valor) : valor);
};
const detalhes = (partes: string[]) => partes.filter(Boolean).join(" · ");

function NotaConfirmacaoAnterior({ confirmacao }: { confirmacao: Item | null | undefined }) {
  if (!confirmacao || confirmacao.estado !== "invalidada") return null;
  return <span className="ck-backups__nota">Antes: {traduzir(MOTIVOS_CONFIRMACAO, confirmacao.motivo)}</span>;
}

// Sem `disabled` nem `aria-busy` aqui: o clique (montar.tsx) os põe e tira direto no DOM, como antes.
function Botao({ acao, serie, cidade }: { acao: "confirmar" | "desfazer"; serie: string; cidade: string }) {
  const confirmar = acao === "confirmar";
  const rotulo = confirmar ? "Confirmar disponível por 7 dias" : "Desfazer confirmação";
  return (
    <button type="button" className={`ck-btn ck-btn--sm ${confirmar ? "ck-btn--secundario" : "ck-btn--fantasma"}`} data-backup-acao={acao} data-serie={serie} data-cidade={cidade} aria-label={`${rotulo}: série ${serie}, ${cidade}`}>
      {rotulo}
    </button>
  );
}

function Identificacao({ item }: { item: Item }) {
  const apelido = texto(item.apelido);
  return <><code className="ck-backups__serie">{texto(item.serie)}</code>{apelido ? <>{" "}<span className="ck-backups__apelido">{apelido}</span></> : null}</>;
}

function Itens({ linhas }: { linhas: { chave: string; conteudo: ReactNode }[] }) {
  if (!linhas.length) return <span className="ck-backups__vazio">Nenhum</span>;
  return <ul className="ck-backups__lista">{linhas.map(linha => <li key={linha.chave} className="ck-backups__item">{linha.conteudo}</li>)}</ul>;
}

// Chave de item: série + posição (série repetida no cadastro não pode quebrar a lista).
const chave = (item: Item, indice: number) => `${texto(item.serie)}|${indice}`;

function ItemBackup({ backup, cidade }: { backup: Item; cidade: string }) {
  const texto_ = detalhes([
    traduzir(ORIGENS, backup.origem),
    backup.ultima_verificacao ? `verificado em ${data(backup.ultima_verificacao)}` : "",
    backup.confirmado_ate ? `confirmado até ${data(backup.confirmado_ate)}` : "",
  ]);
  // Contado pela marca, mas com confirmação vigente (`confirmado_ate`): o Desfazer continua disponível.
  const desfazer = backup.origem === "confirmacao" || backup.confirmado_ate;
  return <><Identificacao item={backup} /><span className="ck-backups__detalhe">{texto_}</span>{desfazer ? <Botao acao="desfazer" serie={texto(backup.serie)} cidade={cidade} /> : null}</>;
}

function ItemCandidato({ candidato, cidade }: { candidato: Item; cidade: string }) {
  const dias = candidato.dias_sem_verificacao === null || candidato.dias_sem_verificacao === undefined ? null : inteiro(candidato.dias_sem_verificacao);
  const texto_ = detalhes([
    traduzir(MOTIVOS, candidato.motivo),
    dias === null ? "" : `${dias} ${plural(dias, "dia", "dias")} sem verificação`,
    candidato.ultima_verificacao ? `última verificação em ${data(candidato.ultima_verificacao)}` : "",
  ]);
  return <><Identificacao item={candidato} /><span className="ck-backups__detalhe">{texto_}</span><NotaConfirmacaoAnterior confirmacao={candidato.confirmacao} /><Botao acao="confirmar" serie={texto(candidato.serie)} cidade={cidade} /></>;
}

// Confirmação vigente de série que caiu na conferência: não conta, mas pode ser desfeita.
function ItemConferencia({ item, cidade }: { item: Item; cidade: string }) {
  return (
    <><Identificacao item={item} /><span className="ck-backups__detalhe">{traduzir(MOTIVOS, item.motivo)}</span><NotaConfirmacaoAnterior confirmacao={item.confirmacao} />
      {item.confirmacao?.estado === "vigente" ? <Botao acao="desfazer" serie={texto(item.serie)} cidade={cidade} /> : null}</>
  );
}

function ItemExcluido({ item }: { item: Item }) {
  return <><Identificacao item={item} /><span className="ck-backups__detalhe">{traduzir(MOTIVOS, item.motivo)}</span><NotaConfirmacaoAnterior confirmacao={item.confirmacao} /></>;
}

// <details> não controlado: o React não mexe no `open`, que continua aberto entre um redesenho e outro.
function CelulaExcluidos({ excluidos, cidade }: { excluidos: Item[]; cidade: string }) {
  if (!excluidos.length) return <Itens linhas={[]} />;
  const n = excluidos.length;
  return (
    <details className="ck-backups__excluidos" data-cidade={cidade}>
      <summary>{n} {plural(n, "excluído", "excluídos")}</summary>
      <Itens linhas={excluidos.map((item, indice) => ({ chave: chave(item, indice), conteudo: <ItemExcluido item={item} /> }))} />
    </details>
  );
}

function LinhaRegional({ regional }: { regional: Item }) {
  const cidade = texto(regional.cidade);
  const status = Object.hasOwn(STATUS, String(regional.status)) ? STATUS[String(regional.status)] : { rotulo: texto(regional.status), tom: "info" };
  const excedente = inteiro(regional.excedente);
  return (
    <tr data-status={texto(regional.status)}>
      <td className="ck-td--largo ck-td--sem-rotulo"><strong className="ck-backups__cidade">{cidade}</strong></td>
      <td className="ck-td--largo" data-label="Situação">
        <span className="ck-backups__contagem">{`${inteiro(regional.contados)}/${inteiro(regional.minimo)}`}</span>{" "}<span className="ck-badge" data-status={status.tom}>{status.rotulo}</span>
        {excedente > 0 ? <>{" "}<span className="ck-backups__nota">+{excedente} além do mínimo</span></> : null}
      </td>
      <td className="ck-td--largo" data-label="Backups"><Itens linhas={lista(regional.backups).map((backup, indice) => ({ chave: chave(backup, indice), conteudo: <ItemBackup backup={backup} cidade={cidade} /> }))} /></td>
      <td className="ck-td--largo" data-label="Candidatos"><Itens linhas={lista(regional.candidatos).map((candidato, indice) => ({ chave: chave(candidato, indice), conteudo: <ItemCandidato candidato={candidato} cidade={cidade} /> }))} /></td>
      <td className="ck-td--largo" data-label="Conferência"><Itens linhas={lista(regional.conferencia).map((item, indice) => ({ chave: chave(item, indice), conteudo: <ItemConferencia item={item} cidade={cidade} /> }))} /></td>
      <td className="ck-td--largo" data-label="Excluídos"><CelulaExcluidos excluidos={lista(regional.excluidos)} cidade={cidade} /></td>
    </tr>
  );
}

// Cartão do Bloco 2: `tom` e `atraso` (n × 80 ms) seguem o desenho aprovado.
function CartaoBento({ tom, atraso, extra = "", cabecalho, children }: { tom: string; atraso: number; extra?: string; cabecalho: ReactNode; children: ReactNode }) {
  return (
    <section className={`ck-bento-cartao ck-bento-secao${extra} ck-bento-d${atraso}`} data-tom={tom} data-bento-cartao="">
      <div className="ck-bento-face">{cabecalho}{children}</div>
    </section>
  );
}

// O h3 fica como antes (os testes e o leitor de tela dependem dele).
function Secao({ titulo, tom, atraso, modificador, children }: { titulo: string; tom: string; atraso: number; modificador: string; children: ReactNode }) {
  return (
    <CartaoBento tom={tom} atraso={atraso} extra={` ck-backups__secao ck-backups__secao--${modificador}`} cabecalho={<div className="ck-bento-sech"><h3 className="ck-cartao__titulo">{titulo}</h3></div>}>
      <div className="ck-backups__corpo">{children}</div>
    </CartaoBento>
  );
}

function Limitacoes({ dados }: { dados: Item }) {
  const textos = (Array.isArray(dados.limitacoes) ? dados.limitacoes : []).map(texto).filter(Boolean);
  if (!textos.length) return null;
  return (
    <CartaoBento tom="ambar" atraso={3} extra=" ck-backups__secao ck-backups__secao--limitacoes" cabecalho={<div className="ck-bento-sech"><h3 className="ck-cartao__titulo">Limitações dos dados</h3></div>}>
      <ul className="ck-backups__limites">{textos.map((item, indice) => <li key={indice}>{item}</li>)}</ul>
    </CartaoBento>
  );
}

function Tabela({ regionais }: { regionais: Item[] }) {
  return (
    <table className="ck-tabela ck-tabela--cards">
      <caption className="ui-sr-only">{TITULO_TABELA}</caption>
      <thead><tr><th scope="col">Regional</th><th scope="col">Situação</th><th scope="col">Backups</th><th scope="col">Candidatos</th><th scope="col">Conferência</th><th scope="col">Excluídos</th></tr></thead>
      {/* Linha por cidade: o React reaproveita a linha (e o <details> aberto) entre um redesenho e outro. */}
      <tbody>{regionais.map((regional, indice) => <LinhaRegional key={`${texto(regional.cidade)}|${indice}`} regional={regional} />)}</tbody>
    </table>
  );
}

function ItemSobra({ item, cidade }: { item: Item; cidade: string }) {
  const texto_ = detalhes([traduzir(ORIGENS, item.origem), item.confirmado_ate ? `confirmado até ${data(item.confirmado_ate)}` : ""]);
  const desfazer = item.origem === "confirmacao" || item.confirmado_ate;
  return <><code className="ck-backups__serie">{texto(item.serie)}</code>{texto_ ? <span className="ck-backups__detalhe">{texto_}</span> : null}{desfazer ? <Botao acao="desfazer" serie={texto(item.serie)} cidade={cidade} /> : null}</>;
}

function SecaoSobras({ sobras }: { sobras: Item[] }) {
  if (!sobras.length) return null;
  const linhas = sobras.map((sobra, indice) => {
    const n = inteiro(sobra.quantidade);
    const cidade = texto(sobra.cidade);
    // Fora das prioritárias, cada série mostra a origem e o Desfazer; nas prioritárias o Desfazer já está na tabela.
    const series = !sobra.prioritaria && Array.isArray(sobra.itens)
      ? <Itens linhas={lista(sobra.itens).map((item, i) => ({ chave: chave(item, i), conteudo: <ItemSobra item={item} cidade={cidade} /> }))} />
      : (Array.isArray(sobra.series) ? sobra.series : []).map((serie: unknown, i: number) => <Fragment key={i}>{i ? " " : ""}<code className="ck-backups__serie">{texto(serie)}</code></Fragment>);
    const motivo = sobra.prioritaria ? "além do mínimo" : "em regional fora das prioritárias";
    return { chave: `${cidade}|${indice}`, conteudo: <><strong className="ck-backups__cidade">{cidade}</strong>{" "}<span className="ck-backups__detalhe">{`${n} ${plural(n, "backup", "backups")} ${motivo}`}</span>{" "}{series}</> };
  });
  return <Secao titulo="Sobras" tom="ciano" atraso={1} modificador="sobras"><Itens linhas={linhas} /></Secao>;
}

function SecaoOutrasCandidatos({ outras }: { outras: Item[] }) {
  const grupos = outras.filter(grupo => lista(grupo.candidatos).length);
  if (!grupos.length) return null;
  return (
    <Secao titulo="Candidatos nas demais regionais" tom="indigo" atraso={2} modificador="candidatos">
      {grupos.map((grupo, indice) => {
        const cidade = texto(grupo.cidade);
        return (
          <div key={`${cidade}|${indice}`} className="ck-backups__grupo">
            <strong className="ck-backups__cidade">{cidade}</strong>
            <Itens linhas={lista(grupo.candidatos).map((candidato, i) => ({ chave: chave(candidato, i), conteudo: <ItemCandidato candidato={candidato} cidade={cidade} /> }))} />
          </div>
        );
      })}
    </Secao>
  );
}

// Mesmo markup de dom.infoTipHtml (frontend/src/comum/dom-utils.ts), com o id fixo de antes.
function DicaMinimo({ minimo }: { minimo: number }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-trigger" aria-label="Sobre os backups regionais" aria-describedby="resumo-backups-minimo">
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info"></use></svg>
      </button>
      <span id="resumo-backups-minimo" role="tooltip" className="info-tip-text">{`Mínimo: ${minimo} ${plural(minimo, "backup", "backups")} por regional prioritária.`}</span>
    </span>
  );
}

const Estado = ({ mensagem }: { mensagem: string }) => <p className="ck-backups__estado">{mensagem}</p>;

function Trio({ children }: { children: ReactNode[] }) {
  // Sem nenhum cartão, a grade de três não aparece (como antes).
  if (!children.some(Boolean)) return null;
  return <div className="ck-bento-tres">{children}</div>;
}

/** `dados`: undefined (sem painel ainda), null (serviço desligado) ou o `backups_regionais` do /api/painel. */
export function PainelBackups({ dados }: { dados: unknown }) {
  let meta: string | null = null;
  let minimo = 0;
  let miolo: ReactNode;
  let abaixo: ReactNode = null;
  if (dados === undefined) miolo = <Estado mensagem="Aguardando os dados do painel local…" />;
  else if (dados === null || typeof dados !== "object") miolo = <Estado mensagem="O cálculo de backups regionais está desligado neste servidor." />;
  else {
    const lido = dados as Item;
    const limitacoes = (Array.isArray(lido.limitacoes) ? lido.limitacoes : []).map(texto).some(Boolean) ? <Limitacoes key="l" dados={lido} /> : null;
    if (lido.indisponivel) {
      miolo = <Estado mensagem="Não foi possível calcular os backups regionais agora." />;
      abaixo = <Trio>{[limitacoes]}</Trio>;
    } else {
      const regionais = lista(lido.prioritarias);
      minimo = inteiro(lido.minimo);
      meta = lido.gerado_em ? `Atualizado em ${data(lido.gerado_em)}.` : "";
      miolo = regionais.length ? <Tabela regionais={regionais} /> : <Estado mensagem="Os dados recebidos não trazem regionais prioritárias." />;
      const outras = lista(lido.outras_candidatos);
      abaixo = (
        <Trio>{[
          lista(lido.sobras).length ? <SecaoSobras key="s" sobras={lista(lido.sobras)} /> : null,
          outras.some(grupo => lista(grupo.candidatos).length) ? <SecaoOutrasCandidatos key="c" outras={outras} /> : null,
          limitacoes,
        ]}</Trio>
      );
    }
  }
  // Cartão esmeralda da tabela: título, ⓘ e "Atualizado em" na mesma linha (a ordem no DOM é meta, ⓘ; o CSS põe o meta à direita).
  return (
    <>
      <CartaoBento tom="esmeralda" atraso={0} extra=" ck-backups__tabela" cabecalho={
        <div className="ck-bento-sech">
          <h2 className="ck-bento-h2">{TITULO_TABELA}</h2>
          {meta === null ? null : <><p className="ck-backups__meta">{meta}</p><DicaMinimo minimo={minimo} /></>}
        </div>
      }>
        {miolo}
      </CartaoBento>
      {abaixo}
    </>
  );
}
