// Corpo do modal Saúde local (#saude-local-corpo). Cabeçalho e rodapé ficam no partial (frontend/partials/modais.html).
// Desktop: tabelas; abaixo de 768 px a TabelaNl vira cartões com os mesmos dados.
import { useSyncExternalStore, type ReactNode } from "react";
import { TabelaNl, type ColunaNl } from "../../componentes/tabela-nl";
import { assinar, ler, formatarBytes, plural, type Area, type ArquivoEstado, type Aviso, type ChaveArea, type ItemLimpeza, type SituacaoJson } from "./estado";

type Tom = "ok" | "alerta" | "erro" | "info" | "";
const Selo = ({ tom = "", children }: { tom?: Tom; children: ReactNode }) => <span className="ck-badge" data-status={tom || undefined}>{children}</span>;

const NOME_AREA: Record<ChaveArea, string> = {
  backups_planilhas: "Backups das planilhas", logs: "Logs", lotes_processados: "Lotes processados", pacotes_locais: "Pacotes locais", quarentena: "Quarentena",
};
const SITUACAO: Record<SituacaoJson, { rotulo: string; tom: Tom }> = {
  integro: { rotulo: "Íntegro", tom: "ok" }, invalido: { rotulo: "Inválido", tom: "erro" }, vazio: { rotulo: "Vazio", tom: "alerta" },
  ilegivel: { rotulo: "Ilegível", tom: "alerta" }, grande_demais: { rotulo: "Grande demais para validar", tom: "" },
};

function Secao({ id, titulo, selo, acoes, children }: { id: string; titulo: string; selo?: ReactNode; acoes?: ReactNode; children: ReactNode }) {
  return (
    <section className="ckp-secao sl-secao" aria-labelledby={`saude-local-titulo-${id}`}>
      <div className="ckp-secao__cab sl-secao__cab">
        <h3 className="ckp-secao__titulo" id={`saude-local-titulo-${id}`}>{titulo}</h3>
        {selo}
        <span className="ck-espaco" />
        {acoes}
      </div>
      <div className="ckp-secao__corpo">{children}</div>
    </section>
  );
}

function AvisoCaixa({ aviso }: { aviso: Aviso | null }) {
  // Região viva sempre presente: o texto novo é anunciado ao entrar.
  return (
    <div aria-live="polite" aria-atomic="true">
      {aviso ? <div className="sl-aviso" data-tipo={aviso.tipo}><strong>{aviso.titulo}</strong>{aviso.detalhe ? <span>{aviso.detalhe}</span> : null}</div> : null}
    </div>
  );
}

function ListasDoPacote({ sim, nao, tituloSim, tituloNao }: { sim: ReactNode[]; nao: ReactNode[]; tituloSim: string; tituloNao: string }) {
  const lista = (itens: ReactNode[], tipo: string) => <ul className="sl-lista" data-tipo={tipo}>{itens.map((item, i) => <li key={i}>{item}</li>)}</ul>;
  return (
    <div className="sl-duas">
      <div><h4 className="sl-sub">{tituloSim}</h4>{lista(sim, "sim")}</div>
      <div><h4 className="sl-sub">{tituloNao}</h4>{lista(nao, "nao")}</div>
    </div>
  );
}

function Disco({ disco }: { disco: { livre_bytes: number; total_bytes: number } | null }) {
  if (!disco || !(disco.total_bytes > 0)) return <p className="ckp-secao__desc">Não foi possível medir o espaço em disco.</p>;
  const usado = Math.min(100, Math.max(0, Math.round((1 - disco.livre_bytes / disco.total_bytes) * 100)));
  return (
    <div className="sl-disco">
      <div>
        <p className="sl-disco__num">{formatarBytes(disco.livre_bytes)} livres</p>
        <p className="ckp-meta">de {formatarBytes(disco.total_bytes)} no disco da pasta data</p>
      </div>
      <div className="sl-trilho" role="img" aria-label={`${usado}% usado`}><span style={{ "--sl-p": usado / 100 } as React.CSSProperties} /></div>
    </div>
  );
}

const BotaoAtualizar = ({ ocupado }: { ocupado: boolean }) => (
  <button type="button" id="saude-local-atualizar" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="atualizarSaudeLocal" disabled={ocupado}>Atualizar</button>
);

function UsoPorArea({ areas }: { areas: Area[] }) {
  const maior = Math.max(1, ...areas.map(area => area.bytes));
  const colunas: ColunaNl<Area>[] = [
    {
      chave: "area", rotulo: "Área", render: area => (
        <>
          <span className="sl-nome">{NOME_AREA[area.chave]}</span>
          <span className="sl-barra" aria-hidden="true"><span style={{ "--sl-p": area.bytes / maior } as React.CSSProperties} /></span>
          {area.chave === "quarentena" ? <span className="ckp-meta sl-bloco">temporários em quarentena e cópias de arquivo corrompido</span> : null}
        </>
      ),
    },
    { chave: "arquivos", rotulo: "Arquivos", render: area => (area.existe && area.arquivos ? area.arquivos : "Nenhum arquivo") },
    { chave: "bytes", rotulo: "Tamanho", render: area => formatarBytes(area.bytes) },
  ];
  return <TabelaNl legenda="Uso por área" colunas={colunas} linhas={areas} chaveLinha={area => area.chave} />;
}

function ArquivosEstado({ json }: { json: { arquivos: ArquivoEstado[]; outros: number; copias_corrompidas: number } }) {
  const { arquivos, outros, copias_corrompidas: copias } = json;
  const integros = arquivos.filter(a => a.situacao === "integro").length;
  const invalidos = arquivos.filter(a => a.situacao === "invalido").length;
  const tom: Tom = invalidos ? "erro" : integros === arquivos.length ? "ok" : "alerta";
  const textoSelo = invalidos ? plural(invalidos, "inválido", "inválidos") : `${integros} de ${arquivos.length} íntegros`;
  const colunas: ColunaNl<ArquivoEstado>[] = [
    { chave: "nome", rotulo: "Arquivo", render: a => <span className="sl-mono">{a.nome}</span> },
    { chave: "bytes", rotulo: "Tamanho", render: a => formatarBytes(a.bytes) },
    {
      chave: "situacao", rotulo: "Situação", render: a => (
        <><Selo tom={SITUACAO[a.situacao].tom}>{SITUACAO[a.situacao].rotulo}</Selo>{a.erro ? <span className="ckp-meta sl-mono"> {a.erro}</span> : null}</>
      ),
    },
  ];
  return (
    <Secao id="estado" titulo="Arquivos de estado" selo={<Selo tom={tom}>{textoSelo}</Selo>}>
      <p className="ckp-secao__desc">Os JSONs conhecidos de <span className="sl-mono">data/state</span> são abertos e validados; o conteúdo não aparece. Acima de 16 MB não são abertos.</p>
      <details className="sl-detalhes" open={integros !== arquivos.length}>
        <summary>Ver os {arquivos.length} arquivos</summary>
        <TabelaNl legenda="Arquivos de estado" colunas={colunas} linhas={arquivos} chaveLinha={a => a.nome} />
      </details>
      {outros ? <p className="ckp-meta">Outros arquivos: {outros} (não validados)</p> : null}
      {copias ? <p className="ckp-meta">Cópias de arquivo corrompido: {copias}</p> : null}
      {integros !== arquivos.length ? <p className="ckp-meta">Esta tela só aponta o problema; não corrige nem apaga o arquivo.</p> : null}
    </Secao>
  );
}

const ACAO = { remover: { rotulo: "Remover", tom: "erro" }, quarentena: { rotulo: "Mover para a quarentena", tom: "alerta" } } as const;

function Limpeza() {
  const { previa, resultado, avisoLimpeza, ocupado } = useSyncExternalStore(assinar, ler);
  const colunas: ColunaNl<ItemLimpeza>[] = [
    { chave: "caminho", rotulo: "Arquivo", render: i => <span className="sl-mono">{i.area}/{i.caminho}</span> },
    { chave: "acao", rotulo: "O que acontece", render: i => <Selo tom={ACAO[i.acao].tom}>{ACAO[i.acao].rotulo}</Selo> },
    { chave: "bytes", rotulo: "Tamanho", render: i => formatarBytes(i.bytes) },
  ];
  const totais = previa?.totais;
  const vazio = previa && previa.itens.length === 0;
  return (
    <Secao id="limpeza" titulo="Limpeza de temporários"
      selo={previa && !vazio ? <Selo>Prévia — nada foi alterado</Selo> : undefined}
      acoes={
        <>
          <button type="button" id="saude-local-previa" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="previaLimpezaSaudeLocal" disabled={ocupado}>{previa ? "Ver prévia de novo" : "Ver prévia"}</button>
          {previa && !vazio ? <button type="button" className="ck-btn ck-btn--perigo ck-btn--sm" data-on-click="limparSaudeLocal" disabled={ocupado}>Limpar temporários</button> : null}
        </>
      }>
      <AvisoCaixa aviso={avisoLimpeza} />
      <div aria-live="polite" aria-atomic="true">
        {resultado ? (
          <div className="sl-aviso" data-tipo="ok" id="saude-local-resultado" tabIndex={-1}>
            <strong>Limpeza concluída.</strong>
            <span>{resultado.totais.remover_arquivos} removidos ({formatarBytes(resultado.totais.remover_bytes)}) · {resultado.totais.quarentena_arquivos} na quarentena ({formatarBytes(resultado.totais.quarentena_bytes)}) · {resultado.totais.preservados} preservados.</span>
          </div>
        ) : vazio ? (
          <div className="sl-aviso" data-tipo="ok">
            <strong>Nenhum temporário para limpar.</strong>
            <span>{plural(totais!.preservados, "preservado", "preservados")} (recentes, em uso ou sem cópia).</span>
          </div>
        ) : null}
      </div>
      {previa && !vazio ? (
        <>
          <TabelaNl legenda="Temporários da prévia" colunas={colunas} linhas={previa.itens} chaveLinha={i => `${i.area}/${i.caminho}`} />
          <p className="sl-totais">
            <span>Remover: <strong>{plural(totais!.remover_arquivos, "arquivo", "arquivos")} · {formatarBytes(totais!.remover_bytes)}</strong></span>
            <span>Quarentena: <strong>{plural(totais!.quarentena_arquivos, "arquivo", "arquivos")} · {formatarBytes(totais!.quarentena_bytes)}</strong></span>
            <span>Preservados: <strong>{totais!.preservados}</strong> (recentes, em uso ou sem cópia)</span>
          </p>
        </>
      ) : null}
      {!previa && !resultado ? (
        <>
          <p className="ckp-secao__desc">Remove só arquivos <span className="sl-mono">.tmp</span> deixados por gravações antigas (mais de 24 h) que são cópia exata do arquivo salvo ou de um backup. Os diferentes, com mais de 7 dias, vão para a quarentena em vez de serem apagados.</p>
          <ListasDoPacote tituloSim="Pode remover ou mover para a quarentena" tituloNao="Nunca toca"
            sim={[<>Temporários <span className="sl-mono">.tmp</span> de gravação em <span className="sl-mono">planilhas_entrada</span>, <span className="sl-mono">state</span> e <span className="sl-mono">modelos</span></>]}
            nao={["Planilhas ativas e backups", <>Arquivos de estado (<span className="sl-mono">data/state</span>) e históricos</>, <span className="sl-mono">.transactions</span>, "Pacotes locais, logs e lotes", "Temporários com menos de 24 h ou em uso"]} />
        </>
      ) : null}
    </Secao>
  );
}

function Diagnostico() {
  const { avisoDiagnostico, ocupado } = useSyncExternalStore(assinar, ler);
  return (
    <Secao id="diagnostico" titulo="Pacote de diagnóstico"
      acoes={<button type="button" id="saude-local-baixar" className="ck-btn ck-btn--primario ck-btn--sm" data-on-click="baixarDiagnosticoSaudeLocal" disabled={ocupado}>Baixar pacote de diagnóstico</button>}>
      <p className="ckp-secao__desc">Um arquivo JSON para enviar ao suporte. É gerado na hora e baixado pelo navegador; não fica guardado no servidor.</p>
      <AvisoCaixa aviso={avisoDiagnostico} />
      <ListasDoPacote tituloSim="Vai no pacote" tituloNao="Nunca vai"
        sim={["Versão do Simpress, do Python e do sistema", "Situação de cada fonte da Prontidão", "Tamanho e quantidade por área; espaço livre", "Situação dos arquivos de estado e tipo de erro", "Situação das transações (limpo/pendente e quantidade)"]}
        nao={["Nomes, e-mails, CPF, telefones", "Séries, hostnames, chamados", "Conteúdo de planilha, JSON ou log", "Caminhos de pasta e nome do usuário do Windows", "Senhas e chaves"]} />
    </Secao>
  );
}

export function CorpoSaudeLocal() {
  const { carga, cargaErro, saude, ocupado } = useSyncExternalStore(assinar, ler);
  const disco = saude?.disco && saude.disco.total_bytes > 0 ? saude.disco : null;
  const pouco = disco ? disco.livre_bytes / disco.total_bytes < 0.1 : false;
  return (
    <div className="sl-corpo">
      <div aria-live="polite" aria-atomic="true">
        {carga ? (
          <p className={cargaErro ? "sl-aviso" : "ckp-secao__desc"} data-tipo={cargaErro ? "erro" : undefined}>
            {cargaErro ? <><strong>{carga}</strong><span>Verifique se o servidor local está aberto e tente de novo.</span></> : carga}
          </p>
        ) : null}
      </div>
      {saude ? (
        <>
          <Secao id="disco" titulo="Espaço em disco" selo={disco ? <Selo tom={pouco ? "alerta" : "ok"}>{pouco ? "Pouco espaço" : "Folga"}</Selo> : undefined}>
            <Disco disco={disco} />
          </Secao>
          <Secao id="areas" titulo="Uso por área"
            acoes={<BotaoAtualizar ocupado={ocupado} />}>
            <UsoPorArea areas={saude.areas} />
            <p className="ckp-meta">Só mede tamanho e quantidade; o conteúdo dos arquivos não é lido. Área que não existe aparece como “Nenhum arquivo”.</p>
          </Secao>
          <ArquivosEstado json={saude.estado_json} />
          <Secao id="transacoes" titulo="Transações" selo={<Selo tom={saude.transacoes.situacao === "limpo" ? "ok" : "alerta"}>{saude.transacoes.situacao === "limpo" ? "Limpo" : "Pendente"}</Selo>}>
            <p className="ckp-secao__desc">
              {saude.transacoes.situacao === "limpo"
                ? "Nenhuma gravação interrompida aguardando recuperação."
                : `${saude.transacoes.quantidade === 1 ? "1 gravação interrompida aguarda" : `${saude.transacoes.quantidade} gravações interrompidas aguardam`} recuperação. Reinicie o servidor local para recuperá-las; enquanto isso, a limpeza fica bloqueada.`}
            </p>
          </Secao>
          <Limpeza />
          <Diagnostico />
        </>
      ) : cargaErro ? (
        // Sem a primeira leitura, o diálogo ainda oferece reler e baixar o diagnóstico (que não depende dela).
        <>
          <div className="sl-secao__cab"><span className="ck-espaco" /><BotaoAtualizar ocupado={ocupado} /></div>
          <Diagnostico />
        </>
      ) : null}
    </div>
  );
}
