// Corpo do modal Configuração local (#cfg-local-corpo). Cabeçalho e rodapé ficam no partial (frontend/partials/modais.html).
// Os botões mantêm os data-on-* do HTML antigo: o action-dispatcher chama a ação em window, que passa pela ponte.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ALTURA_MINIMA_MM, AVISO_NOME_LONGO, ehEstiloTexto, erroDoNome, medirAssinatura, normalizarNome, type EstiloTexto, type MedidaAssinatura } from "../../componentes/assinatura-medida";
import { AssinaturaTexto } from "../../componentes/assinatura-texto";
import { CHAVES_IA, ESTILOS_ASSINATURA } from "./acoes";
import { assinar, ler, type ConfigAssinatura, type Conta, type EstadoChave, type Link, type Secao, type Status } from "./estado";

const classeSecao = (visivel: boolean) => (visivel ? "ckp-secao" : "ckp-secao hidden");

function StatusSecao({ secao, status }: { secao: Secao; status: Status }) {
  return (
    <p id={`cfg-local-status-${secao}`} className="ckp-secao__status" role={status.tipo === "erro" ? "alert" : "status"}
      aria-live="polite" aria-atomic="true" data-status={status.tipo || undefined}>{status.texto}</p>
  );
}

interface PropsCampo {
  id: string;
  rotulo: string;
  ajuda?: string;
  valor?: string;
  placeholder?: string;
  somenteLeitura?: boolean;
  invalido?: boolean;
  children?: React.ReactNode;
}

// Campo de texto com rótulo, ajuda e, quando a variável de ambiente manda, aviso de somente leitura.
function CampoTexto({ id, rotulo, ajuda, valor, placeholder, somenteLeitura, invalido, children }: PropsCampo) {
  const descricoes = [ajuda ? `${id}-ajuda` : "", somenteLeitura ? `${id}-ambiente` : ""].filter(Boolean);
  return (
    <div className="ck-campo">
      <label className="ck-campo__rotulo" htmlFor={id}>{rotulo}</label>
      <input className="ck-entrada" id={id} type="text" autoComplete="off" spellCheck="false" defaultValue={valor || ""}
        placeholder={placeholder || ""} readOnly={Boolean(somenteLeitura)} aria-invalid={invalido ? "true" : undefined}
        aria-describedby={descricoes.length ? descricoes.join(" ") : undefined} />
      {ajuda ? <span className="ckp-meta" id={`${id}-ajuda`}>{ajuda}</span> : null}
      {somenteLeitura ? <span className="ckp-meta" id={`${id}-ambiente`}>Definido por variável de ambiente</span> : null}
      {children}
    </div>
  );
}

function CampoConta({ conta }: { conta: Conta }) {
  return (
    <CampoTexto id={`cfg-local-conta-${conta.id}`} rotulo={conta.rotulo} ajuda={conta.ajuda} valor={conta.valor}
      placeholder={conta.placeholder} somenteLeitura={conta.somente_leitura} invalido={conta.valido === false}>
      {typeof conta.usar_no_outlook === "boolean" ? (
        <div className="ckp-campo__extra">
          <label className="ckp-alternar">
            <input type="checkbox" id={`cfg-local-outlook-${conta.id}`} defaultChecked={conta.usar_no_outlook}
              disabled={Boolean(conta.somente_leitura)} />
            <span>Usar também no Outlook</span>
          </label>
        </div>
      ) : null}
    </CampoTexto>
  );
}

function CampoLink({ link }: { link: Link }) {
  return (
    <CampoTexto id={`cfg-local-link-${link.chave}`} rotulo={link.rotulo} ajuda={link.ajuda} valor={link.valor}
      placeholder={link.placeholder} somenteLeitura={link.somente_leitura} invalido={link.valido === false} />
  );
}

// A chave nunca volta do servidor: o campo nasce vazio e mostra só o final como placeholder.
function CampoChave({ id, nome, ajuda, estado }: { id: string; nome: string; ajuda: string; estado: EstadoChave }) {
  const inputId = `cfg-local-chave-${id}`;
  const doAmbiente = estado.fonte === "ambiente";
  const situacao = doAmbiente
    ? "Definida por variável de ambiente. Não dá para trocar por aqui."
    : estado.configurada ? "Chave configurada." : "Sem chave configurada.";
  return (
    <div className="ck-campo">
      <label className="ck-campo__rotulo" htmlFor={inputId}>{`Chave do ${nome}`}</label>
      <div className="ck-campo__linha">
        <input className="ck-entrada" id={inputId} type="password" autoComplete="new-password" spellCheck="false" defaultValue=""
          placeholder={estado.configurada ? estado.final || "Configurada" : "Não configurada"} readOnly={doAmbiente}
          aria-describedby={`${inputId}-ajuda`} />
        {estado.configurada && !doAmbiente ? (
          <button className="ck-btn ck-btn--perigo ck-btn--sm" type="button" aria-label={`Remover chave do ${nome}`}
            data-on-click="removerChaveAssistenteConfiguracaoLocal" data-args={JSON.stringify([id])}>Remover chave</button>
        ) : null}
      </div>
      <span className="ckp-meta" id={`${inputId}-ajuda`}>{`${situacao} ${ajuda}`}</span>
    </div>
  );
}

// Campos fixos do cliente: o valor volta ao do servidor a cada leitura ou gravação, sem recriar o campo (o foco fica).
function CamposCliente() {
  const { cliente, revisao } = useSyncExternalStore(assinar, ler);
  const contrato = useRef<HTMLInputElement>(null);
  const cnpj = useRef<HTMLInputElement>(null);
  const series = useRef<HTMLTextAreaElement>(null);
  const dados = cliente || {};
  const fontes = dados.cliente_fontes || {};
  useLayoutEffect(() => {
    const atual = ler().cliente || {};
    if (contrato.current) contrato.current.value = typeof atual.contrato === "string" ? atual.contrato : "";
    if (cnpj.current) cnpj.current.value = typeof atual.cnpj_faturamento === "string" ? atual.cnpj_faturamento : "";
    if (series.current) series.current.value = Array.isArray(atual.series_sebrae_fora) ? atual.series_sebrae_fora.join("\n") : "";
  }, [revisao.cliente]);
  return (
    <>
      <div className="ckp-campos">
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="cfg-local-contrato">Contrato</label>
          <input ref={contrato} type="text" id="cfg-local-contrato" className="ck-entrada" maxLength={12} inputMode="numeric"
            autoComplete="off" placeholder="Somente números" readOnly={fontes.contrato === "ambiente"} />
        </div>
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="cfg-local-cnpj">CNPJ de faturamento</label>
          <input ref={cnpj} type="text" id="cfg-local-cnpj" className="ck-entrada" maxLength={18} inputMode="numeric"
            autoComplete="off" placeholder="00.000.000/0000-00" readOnly={fontes.cnpj_faturamento === "ambiente"} />
        </div>
        <div className="ck-campo ckp-span">
          <label className="ck-campo__rotulo" htmlFor="cfg-local-series">Séries dos notebooks do próprio cliente (uma por linha, opcional)</label>
          <textarea ref={series} id="cfg-local-series" className="ck-entrada" rows={3} autoComplete="off" spellCheck="false"
            aria-describedby="cfg-local-series-ajuda" readOnly={fontes.series_sebrae_fora === "ambiente"} />
          <span id="cfg-local-series-ajuda" className="ckp-meta">Ficam fora das comparações de inventário. Só letras e números, até 32 caracteres cada.</span>
        </div>
      </div>
      <p id="cfg-local-cliente-ambiente" className="ckp-meta" hidden={!Object.values(fontes).includes("ambiente")}>Campos bloqueados: definidos por variável de ambiente.</p>
    </>
  );
}

const ROTULO_FOLHA = "Assinatura do técnico responsável";
const ESTILOS_TEXTO = ESTILOS_ASSINATURA.filter(item => ehEstiloTexto(item.valor));
type Medidas = Partial<Record<EstiloTexto, MedidaAssinatura | null>>;

// Mini-folha: a mesma estrutura do bloco do técnico no Termo (SVG sobre a linha, rótulo embaixo). Sem medida, só linha e rótulo.
function FolhaAssinatura({ nome, estilo, medida }: { nome: string; estilo: EstiloTexto; medida: MedidaAssinatura | null | undefined }) {
  return (
    <div className="cfg-assin-previa__area">
      <div className="cfg-assin-previa__bloco">
        {medida ? <AssinaturaTexto nome={nome} estilo={estilo} medida={medida} /> : null}
        {ROTULO_FOLHA}
      </div>
    </div>
  );
}

function useAtraso<T>(valor: T, ms: number): T {
  const [atrasado, setAtrasado] = useState(valor);
  useEffect(() => {
    const id = setTimeout(() => setAtrasado(valor), ms);
    return () => clearTimeout(id);
  }, [valor, ms]);
  return atrasado;
}

// Mede o nome nos 6 estilos de uma vez (a fonte já carregada vem do cache do navegador). O resultado traz o nome medido:
// só vale enquanto for o nome atual.
function useMedidas(nome: string): Medidas {
  const [resultado, setResultado] = useState<{ nome: string; medidas: Medidas }>({ nome: "", medidas: {} });
  useEffect(() => {
    if (!nome) return;
    let atual = true;
    Promise.all(ESTILOS_TEXTO.map(async ({ valor }) => [valor, await medirAssinatura(nome, valor as EstiloTexto).catch(() => null)] as const))
      .then(pares => atual && setResultado({ nome, medidas: Object.fromEntries(pares) }));
    return () => { atual = false; };
  }, [nome]);
  return resultado.nome === nome ? resultado.medidas : {};
}

// Grupo de rádios (setas entre as opções, nativas): cada cartão é uma mini-folha com o nome naquele estilo.
function EstilosAssinatura({ nome, estilo, medidas, aoEscolher, ocupado }: { ocupado: boolean; nome: string; estilo: string; medidas: Medidas; aoEscolher: (valor: string) => void }) {
  return (
    <fieldset className="cfg-assin-estilos">
      <legend className="ck-campo__rotulo">Estilo da assinatura</legend>
      <div className="cfg-assin-grade">
        {ESTILOS_ASSINATURA.map(({ valor, rotulo }) => (
          <label key={valor} className="cfg-assin-opcao" data-estilo={valor}>
            <input type="radio" className="cfg-assin-opcao__radio" name="cfg-local-assinatura-estilo" value={valor}
              checked={estilo === valor} disabled={ocupado} onChange={() => aoEscolher(valor)} />
            <span className="cfg-assin-opcao__nome">{rotulo}</span>
            {ehEstiloTexto(valor)
              ? <span className="cfg-assin-opcao__folha"><FolhaAssinatura nome={nome} estilo={valor} medida={medidas[valor]} /></span>
              : <span className="cfg-assin-opcao__texto">O desenho atual aparece no PDF; não há prévia dele aqui.</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Campos da assinatura: o rascunho vive aqui (as prévias precisam dele); a ação lê os valores do DOM ao salvar. A chave
// do componente muda a cada leitura ou gravação, e o rascunho volta ao valor do servidor.
function CamposAssinatura({ inicial, ocupado }: { inicial: ConfigAssinatura | null; ocupado: boolean }) {
  const [nome, setNome] = useState(inicial?.nome ?? "");
  const [estilo, setEstilo] = useState(inicial?.estilo ?? "desenho");
  const normalizado = useAtraso(normalizarNome(nome), 150);
  const erro = erroDoNome(normalizado);
  const valido = Boolean(normalizado) && !erro;
  const medidas = useMedidas(valido ? normalizado : "");
  const escolhida = ehEstiloTexto(estilo) ? medidas[estilo] : undefined;
  const aviso = estilo === "desenho" ? ""
    : erro || (!normalizado ? "Digite o nome para ver as prévias." : escolhida === null ? "Não foi possível carregar a fonte desta assinatura."
      : escolhida && escolhida.altura < ALTURA_MINIMA_MM ? AVISO_NOME_LONGO : "");
  return (
    <div className="ckp-campos">
      <div className="ck-campo ckp-span">
        <label className="ck-campo__rotulo" htmlFor="cfg-local-assinatura-nome">Nome do técnico</label>
        <input className="ck-entrada" id="cfg-local-assinatura-nome" type="text" disabled={ocupado} autoComplete="off"
          spellCheck="false" value={nome} onChange={evento => setNome(evento.target.value)} aria-describedby="cfg-local-assinatura-nome-ajuda" />
        <span className="ckp-meta" id="cfg-local-assinatura-nome-ajuda">Só letras, espaço, ponto, apóstrofo e hífen. Vale para os dois termos.</span>
      </div>
      <div className="ck-campo ckp-span">
        <EstilosAssinatura ocupado={ocupado} nome={valido ? normalizado : ""} estilo={estilo} medidas={medidas} aoEscolher={setEstilo} />
        <span className="ckp-meta" id="cfg-local-assinatura-previa-aviso" role="status" aria-live="polite">{aviso}</span>
      </div>
      {ehEstiloTexto(estilo) ? (
        <div className="ck-campo ckp-span">
          <span className="ck-campo__rotulo" id="cfg-local-assinatura-previa-rotulo">Prévia no PDF</span>
          <div className="cfg-assin-previa" role="group" aria-labelledby="cfg-local-assinatura-previa-rotulo" data-estado={valido && escolhida ? "pronta" : "vazia"}>
            <FolhaAssinatura nome={valido ? normalizado : ""} estilo={estilo} medida={valido ? escolhida : null} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BotaoSalvar({ secao, rotulo, ocupado }: { secao: Secao; rotulo: string; ocupado: boolean }) {
  return (
    <button type="submit" id={`cfg-local-salvar-${secao}`} className="ck-btn ck-btn--primario ck-btn--sm" aria-label={rotulo}
      disabled={ocupado}>Salvar</button>
  );
}

function Cabecalho({ secao, titulo, desc, opcional }: { secao: string; titulo: string; desc: string; opcional?: boolean }) {
  return (
    <div className="ckp-secao__cab"><div className="ckp-secao__textos">
      <h3 className="ckp-secao__titulo" id={`cfg-local-titulo-${secao}`}>{titulo}{opcional ? <>{" "}<span className="ckp-opcional">· opcional</span></> : null}</h3>
      <p className="ckp-secao__desc">{desc}</p>
    </div></div>
  );
}

export function CorpoConfiguracao() {
  const estado = useSyncExternalStore(assinar, ler);
  const { leitura, aberto, ocupado, status, revisao } = estado;
  const assistente = leitura?.assistente || {};
  return (
    <>
      <p id="cfg-local-carga" className="ckp-secao__desc" role={estado.cargaErro ? "alert" : "status"} aria-live="polite"
        aria-atomic="true" hidden={!estado.carga}>{estado.carga}</p>

      <form id="cfg-local-secao-contas" className={classeSecao(aberto)} data-on-submit="salvarContasConfiguracaoLocal"
        aria-labelledby="cfg-local-titulo-contas" noValidate>
        <Cabecalho secao="contas" titulo="Contas das automações" desc="Cada conta é pedida uma vez e vale para todas as automações que a usam." />
        <div className="ckp-secao__corpo">
          <div id="cfg-local-contas" className="ckp-campos" key={revisao.contas}>
            {leitura?.contas.map(conta => <CampoConta key={conta.id} conta={conta} />)}
          </div>
          <div className="ckp-linha">
            <StatusSecao secao="contas" status={status.contas} />
            <BotaoSalvar secao="contas" rotulo="Salvar contas das automações" ocupado={ocupado} />
          </div>
        </div>
      </form>

      <form id="cfg-local-secao-links" className={classeSecao(aberto)} data-on-submit="salvarLinksConfiguracaoLocal"
        aria-labelledby="cfg-local-titulo-links" noValidate>
        <Cabecalho secao="links" titulo="Links internos" desc="Endereços que as automações abrem. Precisam começar com https://." />
        <div className="ckp-secao__corpo">
          <div id="cfg-local-links" className="ckp-campos" key={revisao.links}>
            {leitura?.links.map(link => <CampoLink key={link.chave} link={link} />)}
          </div>
          <div className="ckp-linha">
            <StatusSecao secao="links" status={status.links} />
            <BotaoSalvar secao="links" rotulo="Salvar links internos" ocupado={ocupado} />
          </div>
        </div>
      </form>

      <form id="cfg-local-secao-cliente" className={classeSecao(aberto)} data-on-submit="salvarClienteConfiguracaoLocal"
        aria-labelledby="cfg-local-titulo-cliente" noValidate>
        <Cabecalho secao="cliente" titulo="Dados do cliente" desc="Contrato e CNPJ de faturamento usados nas transferências, nos chamados do UX e nas rotinas do Chrome." />
        <div className="ckp-secao__corpo">
          <CamposCliente />
          <div className="ckp-linha">
            <StatusSecao secao="cliente" status={status.cliente} />
            <BotaoSalvar secao="cliente" rotulo="Salvar dados do cliente" ocupado={ocupado} />
          </div>
        </div>
      </form>

      <form id="cfg-local-secao-assinatura" className={classeSecao(aberto)} data-on-submit="salvarAssinaturaConfiguracaoLocal"
        aria-labelledby="cfg-local-titulo-assinatura" noValidate>
        <Cabecalho secao="assinatura" titulo="Assinatura do técnico" opcional
          desc="Como a assinatura sai nos PDFs do Termo de Entrega e do Termo de Devolução: o desenho atual, digitada ou uma de cinco cursivas." />
        <div className="ckp-secao__corpo">
          <CamposAssinatura key={revisao.assinatura} inicial={estado.assinatura} ocupado={ocupado} />
          <div className="ckp-linha">
            <StatusSecao secao="assinatura" status={status.assinatura} />
            <BotaoSalvar secao="assinatura" rotulo="Salvar assinatura do técnico" ocupado={ocupado} />
          </div>
        </div>
      </form>

      <form id="cfg-local-secao-assistente" className={classeSecao(aberto)} data-on-submit="salvarAssistenteConfiguracaoLocal"
        aria-labelledby="cfg-local-titulo-assistente" noValidate>
        <Cabecalho secao="assistente" titulo="Assistente com IA" opcional
          desc="A chave nunca volta para a tela: só o final aparece. Deixar o campo vazio mantém a chave atual." />
        <div className="ckp-secao__corpo">
          <div id="cfg-local-chaves" className="ckp-campos" key={revisao.chaves}>
            {CHAVES_IA.map(chave => <CampoChave key={chave.id} {...chave} estado={assistente[chave.id] || {}} />)}
          </div>
          <div className="ckp-linha">
            <StatusSecao secao="assistente" status={status.assistente} />
            <BotaoSalvar secao="assistente" rotulo="Salvar chaves do assistente com IA" ocupado={ocupado} />
          </div>
        </div>
      </form>

      <section id="cfg-local-secao-atalhos" className={classeSecao(aberto && estado.atalhos)} aria-labelledby="cfg-local-titulo-atalhos">
        <Cabecalho secao="atalhos" titulo="Outros formulários" desc="Já têm formulário próprio. O atalho abre o formulário por cima desta janela." />
        <div className="ckp-secao__corpo">
          <div className="ckp-linha">
            <button type="button" id="cfg-local-abrir-contato" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="abrirConfiguracaoContatoOrigem"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-external"></use></svg>Contato de origem da transferência</button>
          </div>
        </div>
      </section>
    </>
  );
}
