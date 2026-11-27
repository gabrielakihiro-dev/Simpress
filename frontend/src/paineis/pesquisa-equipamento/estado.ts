import type { EstadoApp } from "../../estado-app";
import type { BuscaChamadosOsResposta } from "../../api-tipos.gerado";
import type { ApiFetchError, ApiFetchOptions } from "../../api";
import { ENDPOINT, painelCompartilhado } from "../paineis-dados/utilitarios.ts";

interface EquipamentoPesquisa extends Record<string, unknown> {
  serial: string;
  apelido?: string;
  modelo?: string;
  tipo?: string;
  retirada_cidade?: string;
  retirada_endereco?: string;
  retirada_cep?: string;
  retirada_cnpj?: string;
  retirada_cnpj_instalacao?: string;
  descricao_sugerida?: string;
  usuarios_logados?: string;
  usuarios_logados_origem?: string;
  nome_pessoa?: string;
  nome_pessoa_origem?: string;
  invall_alias_status?: string;
  invall_alias_detail?: string;
  idCliente?: string;
}
interface EstadoPesquisa extends Omit<EstadoApp, "currentEquipamento"> {
  currentEquipamento: EquipamentoPesquisa | null;
}
interface ElementoPesquisa extends HTMLElement {
  value: string;
  disabled: boolean;
  checked: boolean;
  selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
  querySelector<T extends Element = HTMLElement>(selectors: string): T | null;
  querySelectorAll<T extends Element = HTMLElement>(selectors: string): NodeListOf<T>;
}
interface ItemLista extends EquipamentoPesquisa {
  serial: string;
}
interface RespostaBusca {
  items: ItemLista[];
  total: number;
  has_more: boolean;
  sugestao?: string;
  filters?: Record<string, unknown>;
}
type ApiErro = ApiFetchError;
interface PortaoBusca {
  begin(): { id: number; signal: AbortSignal };
  invalidate(): number;
  isCurrent(id: number): boolean;
}
interface TransferUtilsBusca {
  createRequestGate(): PortaoBusca;
  isCurrentQuery(gate: PortaoBusca, id: number, atual: string, esperado: string): boolean;
  serialForTransfer(equipment: unknown, campo: string): string;
  refreshSelectionAfterInventoryReplacement(opcoes: Record<string, unknown>): Promise<unknown>;
}
interface RecentEntry extends Record<string, unknown> { serial: string; apelido?: string; cidade?: string; }
interface RecentStore {
  read(): RecentEntry[];
  add(equipment: EquipamentoPesquisa): RecentEntry[];
  clear(): RecentEntry[];
}
interface RecentEquipment {
  createStore(storage: () => Storage): RecentStore;
  describeEntry(entry: RecentEntry): string;
}
interface RenderersPesquisa {
  criarLinhaAutocomplete(item: ItemLista, index: number, query: string, callbacks: { onSelect(): unknown; onHighlight(): void }): HTMLElement;
  criarLinhaChamado(item: BuscaChamadosOsResposta["chamados"][number], index: number, query: string, callbacks: { onSelect(): unknown; onHighlight(): void }): HTMLElement;
  criarLinhaOs(item: BuscaChamadosOsResposta["os"][number], index: number, query: string, callbacks: { onSelect(): unknown; onHighlight(): void }): HTMLElement;
}
interface MotionPesquisa {
  reveal(elemento: HTMLElement, efeito?: string): void;
  startLoading(elemento: HTMLElement | null, mensagem: string, opcoes?: { rows: number }): () => void;
}
interface CodigoPowerShell { id?: string; titulo: string; modo: "usuario" | "sistema"; comando: string; }
interface LinhaCodigoPowerShell {
  id?: string;
  titulo: HTMLInputElement;
  modo: HTMLSelectElement;
  comando: HTMLTextAreaElement;
  el: HTMLDivElement;
}
interface RespostaCodigosPowerShell { codigos: CodigoPowerShell[]; }
interface RespostaEndpoint {
  status: string;
  hostname?: string;
  ultimo_logon?: string;
  origem?: string;
  usuario?: string;
  modo?: string;
  usuarios?: string[];
  mensagem?: string;
}
interface DadosPainel { ultima_comparacao?: { id?: string }; }
interface RespostaHistoricoComparacao { evento?: { comparacao?: ComparacaoHome }; }
interface ComparacaoHome extends Record<string, unknown> { sem_acesso_7_dias?: unknown[]; }
interface StatusHome { stale?: boolean; days?: number | null; divergent?: boolean; divergentCategory?: string; }
interface StatusItemHome {
  tone: string;
  icon: string;
  label: string;
  destino?: string;
  categoria?: string;
}
type FiltroHome = "todos" | "sem-usuario" | "7-dias" | "divergentes";
interface FiltrosListaHome extends Record<string, unknown> { users?: { sem?: number | string }; }
interface OpcoesCarregarLista { query?: string; reset?: boolean; }
interface RespostaListaHome extends RespostaBusca {
  total: number;
  has_more: boolean;
  offset?: number;
  limit?: number;
  filters?: FiltrosListaHome;
}
interface AppPesquisa {
  showToast(mensagem: string, tipo: string): void;
  apiFetch<T = Record<string, unknown>>(url: string, options?: ApiFetchOptions): Promise<T>;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; cancelar: string; destrutiva?: boolean }): Promise<boolean>;
  createTextElement(tag: string, classe: string, texto: string): HTMLElement;
  pluralize(total: number, singular: string, plural?: string): string;
  definirEquipamentoAtual(equipment: EquipamentoPesquisa | null): void;
  limparSelecaoEquipamento(): void;
  invalidarBuscasEquipamento(): void;
  fecharAutocomplete(): void;
  selecionarItemAutocomplete(item: ItemLista): unknown;
  buscarSerial(item?: ItemLista): unknown;
  exibirEquipamento(equipment: EquipamentoPesquisa): void;
  formatarLocalAtual(equipment: EquipamentoPesquisa): string;
  atualizarResumoSerieTransferencia(equipment: EquipamentoPesquisa | null): void;
  atualizarEmailOutlook?(equipment: EquipamentoPesquisa | null): void;
  atualizarDossieEquipamento?(equipment: EquipamentoPesquisa | null): void;
  atualizarChamadosAbertosHome(serial: string): unknown;
  atualizarPreviaTransporteCockpit?(): unknown;
  atualizarUsuarioLogadoCard(equipment: EquipamentoPesquisa): void;
  atualizarIndicadoresPosSalvamento?(): unknown;
  ativarAbaTransferencia?(aba: string): unknown;
  abrirAbaTransporteDoEquipamento(): unknown;
  abrirPesquisaCompleta(): unknown;
  abrirPesquisaRecente(serial: string): unknown;
  fecharChamadoUX?(): unknown;
  invalidarSemUsuarioResumo?(): unknown;
  preencherRepresentanteRegional(tipo: "retirada" | "entrega", cidade: string): unknown;
  recolherVisualizacoesModelosChamado(): unknown;
  termosPreencherDoEquipamento?(equipment: EquipamentoPesquisa): unknown;
  abrirComparacaoDaSerie(serial: string, categoria: string): unknown;
  abrirChamadoSebraeNoF5?(numero: string): Promise<boolean>;
  abrirChamadoDaOs?(fontes: unknown[], serie: string, os: string): Promise<boolean>;
  destacarLinhaCockpit?(linha: HTMLElement): void;
}
const SEM_CHAMADOS_OS: BuscaChamadosOsResposta = { chamados: [], os: [] };
export interface ContextoPesquisaEquipamento {
  app: AppPesquisa;
  appState: EstadoPesquisa;
  motion: MotionPesquisa | null;
  transferUtils: TransferUtilsBusca;
  recentEquipment: RecentEquipment | null;
  dom: {
    createTextElement(tag: string, classe: string, texto: string): HTMLElement;
    escapeHtml(texto: string): string;
  };
  equipmentSearchRenderer(context: ContextoPesquisaEquipamento): RenderersPesquisa;
  apiFetch(url: string, options: ApiFetchOptions & { responseType: "response" }): Promise<Response>;
  apiFetch<T = unknown>(url: string, options?: ApiFetchOptions & { responseType?: "json" }): Promise<T>;
}
const elemento = <T extends HTMLElement = ElementoPesquisa>(id: string): T => document.getElementById(id) as T;
const mensagemErro = (erro: unknown, padrao: string): string => erro instanceof Error ? erro.message : padrao;
const ehErroApi = (erro: unknown): erro is ApiErro => erro instanceof Error
  && "status" in erro && typeof erro.status === "number";
export function criarPesquisaEquipamento(context: ContextoPesquisaEquipamento) {
  "use strict";
  const { app, appState, motion, transferUtils, recentEquipment } = context;
  const { createTextElement, escapeHtml } = context.dom;
  const renderers = context.equipmentSearchRenderer(context);
  const recentStore = recentEquipment?.createStore(() => window.localStorage) || null;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Só a digitação zera este: Enter ou escolher uma sugestão não pode cancelar a recarga da lista.
  let homeListTimer: ReturnType<typeof setTimeout> | undefined;
  const autocompleteRequestGate = transferUtils.createRequestGate();
  const equipmentLookupRequestGate = transferUtils.createRequestGate();
  const homeListRequestGate = transferUtils.createRequestGate();
  const endpointRequestGate = transferUtils.createRequestGate();
  const searchButtonInitialHtml = elemento("btn-buscar-serial")?.innerHTML || "";
  const HOME_LIST_PAGE_SIZE = 50;
  const HOME_COMPARISON_FILTERS = Object.freeze({
    "7-dias": ["sem_acesso_7_dias"],
    divergentes: ["ausentes_no_endpoint", "divergencias_local", "correspondencias_ambiguas", "registros_ambiguos"],
  } as const);
  let homeListFilter: FiltroHome = "todos";
  let homeListOffset = 0;
  let homeListHasMore = false;
  let homeListTotal = 0;
  let homeListQuery = "";
  let homeListActiveSerial = "";
  let homeListSerials = new Map<string, StatusHome>();
  // Items of the rendered list by serial, so the actions bar (which only knows the serial) can tell "Sem usuário" apart.
  let homeListItems = new Map<string, ItemLista>();
  // Divergence keys in the order the Resumo lists them; registros_ambiguos rows sit under correspondencias_ambiguas.
  const HOME_DIVERGENCE_CATEGORIES = Object.freeze([
    ["divergencias_local", "divergencias_local"],
    ["ausentes_no_endpoint", "ausentes_no_endpoint"],
    ["correspondencias_ambiguas", "correspondencias_ambiguas"],
    ["registros_ambiguos", "correspondencias_ambiguas"],
  ] as const);
  const HOME_NOTEBOOK_CATEGORIES = Object.freeze(["notebook", "macbook"]);
  let homeComparisonFilters: Record<"7-dias" | "divergentes", Set<string> | null> = { "7-dias": null, divergentes: null };
  let homeCountsLoaded = false;
  let finishEquipmentLoading: () => void = () => {};
  let finishHomeListLoading: () => void = () => {};

  function definirEquipamentoAtual(equipment: EquipamentoPesquisa | null) {
    endpointRequestGate.invalidate();
    app.fecharChamadoUX?.();
    appState.currentEquipamento = equipment;
    appState.equipamentoSelectionRevision += 1;
    app.atualizarResumoSerieTransferencia(equipment);
    const copySerialButton = elemento("btn-copiar-serie");
    const hasSerial = Boolean(String(equipment?.serial || "").trim());
    const endpointButton = elemento("btn-consultar-endpoint");
    if (endpointButton) {
      endpointButton.disabled = !hasSerial;
      endpointButton.removeAttribute("aria-busy");
    }
    const remoteButton = elemento("btn-controle-remoto-endpoint");
    if (remoteButton) {
      remoteButton.disabled = !hasSerial;
      remoteButton.removeAttribute("aria-busy");
    }
    app.atualizarEmailOutlook?.(equipment);
    app.atualizarDossieEquipamento?.(equipment);
    const endpointResult = elemento("endpoint-lookup-result");
    if (endpointResult) endpointResult.textContent = "";
    const powershellHost = elemento("input-powershell-hostname");
    // O hostname do PowerShell acompanha o equipamento aberto na Home.
    if (powershellHost) powershellHost.value = String(equipment?.apelido || "").trim();
    if (copySerialButton) {
      copySerialButton.disabled = !hasSerial;
      copySerialButton.setAttribute("aria-disabled", String(!hasSerial));
    }
  }

  async function consultarEndpoint() {
    const serial = String(appState.currentEquipamento?.serial || "").trim();
    const button = elemento("btn-consultar-endpoint");
    const result = elemento("endpoint-lookup-result");
    if (!serial || button?.disabled) return;
    const revision = appState.equipamentoSelectionRevision;
    const request = endpointRequestGate.begin();
    const current = () => endpointRequestGate.isCurrent(request.id)
      && appState.equipamentoSelectionRevision === revision;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Consultando no Endpoint… Se o Endpoint pedir login, entre na janela do Chrome de automação.";
    try {
      const data = await context.apiFetch<RespostaEndpoint>("/api/endpoint/consultar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }), signal: request.signal,
        errorMessage: "Não foi possível consultar o Endpoint.",
      });
      if (!current()) return;
      if (data.status === "found") {
        result.textContent = data.ultimo_logon
          ? `Usuário do último logon: ${data.ultimo_logon}`
          : "Equipamento encontrado no Endpoint, sem usuário do último logon informado.";
      } else if (data.status === "not_found") {
        result.textContent = "Equipamento não encontrado no Endpoint";
      } else if (data.status === "ambiguous") {
        if (data.origem === "base_local") {
          result.textContent = "A série alternativa do MacBook é ambígua na base local. Nenhum usuário foi associado.";
        } else if (data.origem === "correspondencia_mac") {
          result.textContent = "Não foi possível confirmar a correspondência única do MacBook no Endpoint. Nenhum usuário foi associado.";
        } else {
          result.textContent = "Mais de um equipamento encontrado no Endpoint para esta série. Confira as duplicidades.";
        }
      } else {
        throw new Error("Não foi possível confirmar o resultado do Endpoint.");
      }
    } catch (error) {
      if (current() && !(error instanceof Error && error.name === "AbortError")) {
        result.textContent = mensagemErro(error, "Não foi possível consultar o Endpoint.");
      }
    } finally {
      if (current()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  async function controleRemotoEndpoint() {
    const serial = String(appState.currentEquipamento?.serial || "").trim();
    const button = elemento("btn-controle-remoto-endpoint");
    const result = elemento("endpoint-lookup-result");
    if (!serial || button?.disabled) return;
    const revision = appState.equipamentoSelectionRevision;
    const request = endpointRequestGate.begin();
    const current = () => endpointRequestGate.isCurrent(request.id)
      && appState.equipamentoSelectionRevision === revision;
    // Identifica o pedido: se a seleção mudar enquanto o servidor espera o login, o servidor não conecta.
    const pedido = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let finalizado = false;
    request.signal.addEventListener("abort", () => {
      if (!finalizado) context.apiFetch("/api/endpoint/controle-remoto/cancelar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido }), errorMessage: "",
      }).catch(() => {});
    });
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Abrindo o controle remoto no Endpoint… Se o Endpoint pedir login, entre na janela do Chrome de automação.";
    try {
      const data = await context.apiFetch<RespostaEndpoint>("/api/endpoint/controle-remoto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, pedido }), signal: request.signal,
        errorMessage: "Não foi possível abrir o controle remoto.",
      });
      if (!current()) return;
      if (data.status === "connected") {
        result.textContent = `Controle remoto solicitado${data.hostname ? ` para ${data.hostname}` : ""}. Continue a conexão no Chrome de automação.`;
      } else if (data.status === "offline") {
        result.textContent = "O computador está offline no Endpoint.";
        await app.confirmarAcao({
          titulo: "Computador offline",
          mensagem: `O computador${data.hostname ? ` ${data.hostname}` : ""} está offline. O controle remoto não está disponível.`,
          confirmar: "OK", cancelar: "Fechar", destrutiva: false,
        });
      } else if (data.status === "not_found") {
        result.textContent = "Equipamento não encontrado no Endpoint";
      } else if (data.status === "ambiguous") {
        result.textContent = "Não foi possível identificar um único equipamento no Endpoint para esta série. O controle remoto não foi aberto.";
      } else {
        throw new Error("Não foi possível confirmar o resultado do Endpoint.");
      }
    } catch (error) {
      if (current() && !(error instanceof Error && error.name === "AbortError")) {
        result.textContent = mensagemErro(error, "Não foi possível abrir o controle remoto.");
      }
    } finally {
      finalizado = true;
      if (current()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  const powershellRequestGate = transferUtils.createRequestGate();
  const POWERSHELL_AVISO_NAO_EXECUTADO = "O comando foi inserido no prompt, mas NÃO foi executado. Revise e aperte Enter no terminal do Chrome.";

  // Códigos prontos: lista guardada no servidor local (comando fixo + modo). Carrega na primeira seleção de equipamento (e de novo nas seguintes se a carga falhar).
  const POWERSHELL_CODIGOS_URL = "/api/endpoint/powershell/codigos";
  // Impressora de rede (Add-Printer -ConnectionName, aceito abreviado até -Con) só é instalada no perfil do usuário logado.
  const POWERSHELL_IMPRESSORA_REDE = /^\s*Add-Printer\b.*\s-Con/i;
  const POWERSHELL_AVISO_IMPRESSORA_SYSTEM = "Adicionar impressora de rede só funciona no modo Usuário logado.";
  let codigosPowerShell: CodigoPowerShell[] | null = null; // null = ainda não carregada; por isso o editor nunca abre (e não sobrescreve a lista) após falha de carga
  let cargaCodigosPowerShell: Promise<boolean> | null = null;
  let linhasCodigosPowerShell: LinhaCodigoPowerShell[] = [];

  function codigosDaResposta(data: unknown): CodigoPowerShell[] {
    if (!data || typeof data !== "object" || !("codigos" in data) || !Array.isArray(data.codigos)) {
      throw new Error("Não foi possível ler a lista de códigos.");
    }
    return data.codigos as CodigoPowerShell[];
  }

  // Dado armazenado: só textContent/value, nunca innerHTML.
  function popularSelectCodigosPowerShell() {
    const select = elemento("select-powershell-codigo");
    const vazio = document.createElement("option");
    vazio.value = "";
    vazio.textContent = "Escolher código…";
    const grupos = ([["usuario", "Usuário logado"], ["sistema", "SYSTEM"]] as const).map(([modo, rotulo]) => {
      const itens = (codigosPowerShell || []).filter(item => item.modo === modo);
      if (!itens.length) return null;
      const grupo = document.createElement("optgroup");
      grupo.label = rotulo;
      itens.forEach(item => {
        const opcao = document.createElement("option");
        opcao.value = item.id || "";
        opcao.textContent = item.titulo;
        grupo.appendChild(opcao);
      });
      return grupo;
    }).filter((grupo): grupo is HTMLOptGroupElement => grupo !== null);
    select.replaceChildren(vazio, ...grupos);
  }

  function definirCodigosPowerShell(lista: CodigoPowerShell[]) {
    codigosPowerShell = lista;
    popularSelectCodigosPowerShell();
  }

  // Resolve true quando a lista veio do servidor; `recarregar` ignora a lista já em memória.
  async function carregarCodigosPowerShell(recarregar = false) {
    if (codigosPowerShell && !recarregar && !cargaCodigosPowerShell) return true;
    const select = elemento("select-powershell-codigo");
    if (!cargaCodigosPowerShell) {
      select.setAttribute("aria-busy", "true");
      cargaCodigosPowerShell = context.apiFetch<RespostaCodigosPowerShell>(POWERSHELL_CODIGOS_URL, { errorMessage: "Não foi possível carregar os códigos prontos." })
        .then((data: unknown) => {
          definirCodigosPowerShell(codigosDaResposta(data));
          // Limpa só o erro de uma carga anterior, nunca outro status.
          const status = elemento("endpoint-powershell-result");
          if (status.dataset.erroCodigos && status.textContent === status.dataset.erroCodigos) status.textContent = "";
          delete status.dataset.erroCodigos;
          return true;
        })
        .catch((error: unknown) => {
          const status = elemento("endpoint-powershell-result");
          status.textContent = mensagemErro(error, "Não foi possível carregar os códigos prontos.");
          status.dataset.erroCodigos = status.textContent;
          return false;
        })
        .finally(() => { cargaCodigosPowerShell = null; select.removeAttribute("aria-busy"); });
    }
    return cargaCodigosPowerShell;
  }

  function aplicarCodigoProntoPowerShell() {
    const item = (codigosPowerShell || []).find(codigo => codigo.id === elemento("select-powershell-codigo").value);
    if (!item) return;
    elemento("input-powershell-comando").value = item.comando;
    elemento("select-powershell-modo").value = item.modo === "sistema" ? "sistema" : "usuario";
    elemento("endpoint-powershell-result").textContent = "";
  }

  function criarLinhaCodigoPowerShell(item: Partial<CodigoPowerShell> = {}): LinhaCodigoPowerShell {
    const campo = (rotulo: string, controle: HTMLElement, nome: string, classe: string) => {
      controle.dataset.powershellCodigoCampo = nome;
      const label = document.createElement("label");
      label.className = `ck-campo ${classe}`;
      label.append(app.createTextElement("span", "ck-campo__rotulo", rotulo), controle);
      return label;
    };
    const titulo = document.createElement("input");
    titulo.type = "text";
    titulo.className = "ck-entrada";
    titulo.maxLength = 80;
    titulo.value = item.titulo || "";
    const modo = document.createElement("select");
    modo.className = "ck-entrada";
    const modos: Array<[CodigoPowerShell["modo"], string]> = [["usuario", "Usuário logado"], ["sistema", "SYSTEM"]];
    modos.forEach(([valor, rotulo]) => {
      const opcao = document.createElement("option");
      opcao.value = valor;
      opcao.textContent = rotulo;
      modo.appendChild(opcao);
    });
    modo.value = item.modo === "sistema" ? "sistema" : "usuario";
    const comando = document.createElement("textarea");
    comando.className = "ck-entrada";
    comando.rows = 2;
    comando.maxLength = 2000;
    comando.spellcheck = false;
    comando.value = item.comando || "";
    const remover = app.createTextElement("button", "ck-btn ck-btn--perigo", "Remover") as HTMLButtonElement;
    remover.type = "button";
    remover.dataset.powershellCodigoCampo = "remover";
    const el = document.createElement("div");
    el.className = "ck-ps-codigos__item";
    el.setAttribute("role", "group");
    el.append(
      campo("Título", titulo, "titulo", "ck-ps-codigos__titulo"),
      campo("Modo", modo, "modo", "ck-ps-codigos__modo"),
      campo("Comando (uma linha)", comando, "comando", "ck-ps-codigos__comando"),
      remover,
    );
    const linha = { id: item.id, titulo, modo, comando, el };
    remover.addEventListener("click", () => {
      linhasCodigosPowerShell = linhasCodigosPowerShell.filter(outra => outra !== linha);
      renderizarLinhasCodigosPowerShell();
    });
    return linha;
  }

  function renderizarLinhasCodigosPowerShell() {
    linhasCodigosPowerShell.forEach((linha, indice) => linha.el.setAttribute("aria-label", `Código ${indice + 1}`));
    elemento("powershell-codigos-lista").replaceChildren(...linhasCodigosPowerShell.map(linha => linha.el));
  }

  function fecharEditorCodigosPowerShell() {
    elemento("powershell-codigos-editor").classList.add("hidden");
    elemento("btn-powershell-codigos-gerenciar").setAttribute("aria-expanded", "false");
    elemento("powershell-codigos-status").textContent = "";
    linhasCodigosPowerShell = [];
    renderizarLinhasCodigosPowerShell();
  }

  // Abre (relendo a lista salva, que outra aba pode ter mudado) ou fecha descartando as edições; serve ao botão Gerenciar códigos e ao Cancelar.
  async function alternarEditorCodigosPowerShell() {
    const painel = elemento("powershell-codigos-editor");
    if (!painel.classList.contains("hidden")) return fecharEditorCodigosPowerShell();
    if (!(await carregarCodigosPowerShell(true))) return; // a falha já foi mostrada em #endpoint-powershell-result
    linhasCodigosPowerShell = (codigosPowerShell || []).map(criarLinhaCodigoPowerShell);
    renderizarLinhasCodigosPowerShell();
    painel.classList.remove("hidden");
    elemento("btn-powershell-codigos-gerenciar").setAttribute("aria-expanded", "true");
    linhasCodigosPowerShell[0]?.titulo.focus();
  }

  function adicionarCodigoPowerShell() {
    const linha = criarLinhaCodigoPowerShell();
    linhasCodigosPowerShell.push(linha);
    renderizarLinhasCodigosPowerShell();
    linha.titulo.focus();
  }

  async function salvarCodigosPowerShell() {
    const botao = elemento("btn-powershell-codigos-salvar");
    const status = elemento("powershell-codigos-status");
    if (botao.disabled) return;
    const codigos = linhasCodigosPowerShell.map(linha => {
      const item: CodigoPowerShell = {
        titulo: linha.titulo.value.trim(),
        modo: linha.modo.value === "sistema" ? "sistema" : "usuario",
        comando: linha.comando.value,
      };
      if (linha.id) item.id = linha.id;
      return item;
    });
    const erro = codigos.some(item => !item.titulo) ? "Informe o título de cada código."
      : codigos.some(item => /[\r\n]/.test(item.comando)) ? "O comando não pode ter quebra de linha."
      : codigos.some(item => !item.comando.trim()) ? "Informe o comando de cada código."
      : codigos.some(item => item.modo === "sistema" && POWERSHELL_IMPRESSORA_REDE.test(item.comando)) ? `${POWERSHELL_AVISO_IMPRESSORA_SYSTEM} Ajuste o modo do código.` : "";
    if (erro) {
      status.textContent = erro;
      return;
    }
    // Trava antes da confirmação: um segundo clique não abre outra confirmação nem manda outro PUT.
    botao.disabled = true;
    try {
      const removidos = (codigosPowerShell || []).filter(item => !linhasCodigosPowerShell.some(linha => linha.id === item.id)).length;
      const confirmado = await app.confirmarAcao({
        titulo: "Salvar lista de códigos",
        mensagem: `A lista de códigos prontos será substituída por ${codigos.length} ${app.pluralize(codigos.length, "código", "códigos")}.${removidos ? ` ${removidos} ${app.pluralize(removidos, "código será removido", "códigos serão removidos")} da lista.` : ""}`,
        confirmar: "Salvar lista", cancelar: "Cancelar", destrutiva: false,
      });
      if (!confirmado) return;
      botao.setAttribute("aria-busy", "true");
      status.textContent = "Salvando…";
    const data = await context.apiFetch<RespostaCodigosPowerShell>(POWERSHELL_CODIGOS_URL, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigos }), errorMessage: "Não foi possível salvar a lista de códigos.",
      });
      definirCodigosPowerShell(codigosDaResposta(data));
      fecharEditorCodigosPowerShell();
      elemento("endpoint-powershell-result").textContent = "Lista de códigos salva.";
    } catch (error) {
      status.textContent = mensagemErro(error, "Não foi possível salvar a lista de códigos.");
    } finally {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
    }
  }

  function mensagemPowerShellEndpoint(data: RespostaEndpoint, hostname: string) {
    const host = data.hostname || hostname;
    const usuarios = Array.isArray(data.usuarios) ? data.usuarios.join(", ") : "";
    if (data.status === "inserido") {
      return `${POWERSHELL_AVISO_NAO_EXECUTADO} Computador: ${host}; conectado como ${data.usuario || data.modo}.`;
    }
    if (data.status === "not_found") return `Computador ${host} não encontrado no Endpoint. Nada foi inserido.`;
    if (data.status === "sem_usuario") return `Usuário não encontrado em ${host}.${usuarios ? ` Usuários disponíveis: ${usuarios}.` : " Nenhum usuário logado disponível."} Nada foi inserido.`;
    if (data.status === "usuario_ambiguo") return `Há mais de um usuário logado em ${host}: ${usuarios}. Nada foi inserido.`;
    if (data.status === "offline") return `O notebook ${host} está offline no Endpoint. Nada foi inserido.`;
    if (data.status === "erro_terminal") return data.mensagem || `Não foi possível abrir o PowerShell em ${host}. Nada foi inserido.`;
    throw new Error("Não foi possível confirmar o resultado do Endpoint.");
  }

  async function abrirPowerShellEndpoint() {
    const button = elemento("btn-powershell-endpoint");
    const result = elemento("endpoint-powershell-result");
    if (button.disabled) return;
    const comando = elemento("input-powershell-comando").value;
    if (/[\r\n]/.test(comando)) {
      result.textContent = "O comando não pode ter quebra de linha.";
      return;
    }
    if (!comando.trim()) {
      result.textContent = "Informe o comando.";
      return;
    }
    const modo = elemento("select-powershell-modo").value === "usuario" ? "usuario" : "sistema";
    if (modo === "sistema" && POWERSHELL_IMPRESSORA_REDE.test(comando)) {
      result.textContent = `${POWERSHELL_AVISO_IMPRESSORA_SYSTEM} Troque o modo e tente de novo.`;
      return;
    }
    // Sem hostname digitado vale o do equipamento aberto; nunca cai num computador padrão alheio.
    const hostname = elemento("input-powershell-hostname").value.trim()
      || String(appState.currentEquipamento?.apelido || "").trim();
    if (!hostname) {
      result.textContent = "Informe o hostname.";
      return;
    }
    const payload = { modo, comando, hostname };
    const confirmado = await app.confirmarAcao({
      titulo: "Inserir comando no PowerShell",
      mensagem: `Vai abrir o PowerShell do Endpoint em ${hostname}, modo ${modo === "usuario" ? "usuário logado" : "SYSTEM"}, e inserir este comando no prompt:\n\n${comando}\n\nO comando será apenas inserido; NÃO será executado. O Enter é seu, no terminal do Chrome.`,
      confirmar: "Inserir no PowerShell", cancelar: "Cancelar", destrutiva: false,
    });
    if (!confirmado) return;
    const request = powershellRequestGate.begin();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Abrindo o PowerShell no Endpoint…";
    try {
      const data = await context.apiFetch<RespostaEndpoint>("/api/endpoint/powershell", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: request.signal,
        errorMessage: "Não foi possível abrir o PowerShell.",
      });
      result.textContent = mensagemPowerShellEndpoint(data, hostname);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        result.textContent = mensagemErro(error, "Não foi possível abrir o PowerShell.");
      }
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function limparSelecaoEquipamento() {
    app.definirEquipamentoAtual(null);
    highlightHomeListItem(null);
    appState.retiradaCidadeSelecionada = "";
    elemento("card-equipamento")?.classList.add("hidden");
    elemento("home-detail-empty")?.classList.remove("hidden");
    elemento("retirada-cnpj").value = "";
    elemento("retirada-endereco").value = "";
    elemento("retirada-obs").value = "";
    ["textarea-resumo-preview", "textarea-texto-transporte"].forEach(id => {
      const field = elemento(id);
      if (field) field.value = "";
    });
    app.preencherRepresentanteRegional("retirada", "");
    const indicator = elemento("status-indicator");
    if (indicator) indicator.dataset.state = "ready";
    const summary = elemento("status-summary");
    if (summary) summary.replaceChildren(
      createTextElement("span", "ck-acoes-pronto", "Pronto para emissão.")
    );
    summary?.firstElementChild?.setAttribute("data-ux-ready-status", "");
  }

  function invalidarBuscasEquipamento() {
    finishEquipmentLoading();
    clearTimeout(debounceTimer);
    autocompleteRequestGate.invalidate();
    equipmentLookupRequestGate.invalidate();
    const autocomplete = elemento("autocomplete-box");
    autocomplete?.setAttribute("aria-busy", "false");
    elemento("input-serial")?.removeAttribute("aria-busy");
    const button = elemento("btn-buscar-serial");
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = searchButtonInitialHtml;
      lucide.createIcons({ root: button });
    }
  }

  function invalidarDadosEquipamentoAposRestauracao() {
    app.invalidarSemUsuarioResumo?.();
    const serialInput = elemento("input-serial");
    if (serialInput) serialInput.value = "";
    elemento("btn-clear-serial")?.classList.add("hidden");
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
  }

  async function atualizarSelecaoAposSubstituirInventarios(serialSelecionada: string | null) {
    app.invalidarSemUsuarioResumo?.();
    app.fecharAutocomplete();
    return transferUtils.refreshSelectionAfterInventoryReplacement({
      requestGate: equipmentLookupRequestGate,
      serial: serialSelecionada,
      invalidateSearches: app.invalidarBuscasEquipamento,
      clearSelection: (clearSerial: boolean) => {
        app.limparSelecaoEquipamento();
        if (!serialSelecionada || clearSerial) {
          const serialInput = elemento("input-serial");
          if (serialInput) serialInput.value = "";
          elemento("btn-clear-serial")?.classList.add("hidden");
        }
      },
      fetchEquipment: (serial: string, options: RequestInit) => context.apiFetch(
        `/api/equipamento/${encodeURIComponent(serial)}`,
        { ...options, responseType: "response" },
      ),
      applyEquipment: (equipment: EquipamentoPesquisa) => {
        app.definirEquipamentoAtual(equipment);
        app.exibirEquipamento(equipment);
      },
    });
  }

  const inputSerialInicial = elemento("input-serial");

  if (inputSerialInicial && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    inputSerialInicial.focus({ preventScroll: true });
  }

  // Autocomplete & Debounce for Serial Input
  let autocompleteItemsList: ItemLista[] = [];

  let highlightedAutocompleteIndex = -1;
  // Chamados e OS vêm depois dos equipamentos na lista e no índice de navegação (cabeçalhos de grupo não contam).
  let autocompleteExtras: BuscaChamadosOsResposta = SEM_CHAMADOS_OS;
  const totalAutocomplete = () => autocompleteItemsList.length + autocompleteExtras.chamados.length + autocompleteExtras.os.length;

  function handleSerialInput(val: string) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
    const clearBtn = elemento("btn-clear-serial");
    if (val && val.length > 0) {
      clearBtn?.classList.remove("hidden");
    } else {
      clearBtn?.classList.add("hidden");
    }

    clearTimeout(debounceTimer);
    clearTimeout(homeListTimer);
    const term = val.trim();
    if (term.length < 2) {
      app.fecharAutocomplete();
      void carregarListaHome({ query: term, reset: true });
      return;
    }

    // A lista espera a mesma pausa de 200 ms do autocompletar: um pedido por pausa na digitação, não por tecla.
    homeListTimer = setTimeout(() => void carregarListaHome({ query: term, reset: true }), 200);
    elemento("autocomplete-box").setAttribute("aria-busy", "true");
    debounceTimer = setTimeout(async () => {
      const request = autocompleteRequestGate.begin();
      try {
        // Falha da busca de chamados e OS é silenciosa: os equipamentos aparecem do mesmo jeito.
        const pedidoExtras = context.apiFetch<BuscaChamadosOsResposta>(`/api/buscar/chamados-os?q=${encodeURIComponent(term)}`, {
          signal: request.signal,
          errorMessage: "Não foi possível consultar chamados e OS.",
        }).then((extras): BuscaChamadosOsResposta => ({ chamados: extras?.chamados ?? [], os: extras?.os ?? [] }))
          .catch((): BuscaChamadosOsResposta => SEM_CHAMADOS_OS);
        const results = await context.apiFetch<RespostaBusca>(`/api/buscar-expandida?q=${encodeURIComponent(term)}&limit=15`, {
          signal: request.signal,
          errorMessage: "Não foi possível consultar os equipamentos.",
        });
        const atual = () => autocompleteRequestGate.isCurrent(request.id) && transferUtils.isCurrentQuery(
          autocompleteRequestGate, request.id, elemento("input-serial").value, term
        );
        if (!atual()) return;
        // Com equipamentos, desenha já; sem eles, espera a rota nova para não piscar "nenhum equipamento" antes dos chamados/OS.
        const comEquipamentos = results.items.length > 0;
        if (comEquipamentos) renderAutocomplete(results.items, results.total, results.has_more, results.sugestao);
        const extras = await pedidoExtras;
        if (!atual()) return;
        if (!comEquipamentos || extras.chamados.length + extras.os.length > 0) {
          // Equipamentos vêm primeiro no índice: o destaque de antes continua valendo ao anexar os grupos.
          const destaque = highlightedAutocompleteIndex;
          renderAutocomplete(results.items, results.total, results.has_more, results.sugestao, extras);
          if (destaque >= 0) { highlightedAutocompleteIndex = destaque; updateAutocompleteHighlight(); }
        }
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === "AbortError") && autocompleteRequestGate.isCurrent(request.id)) {
          console.warn("Erro no autocomplete:", err);
          app.showToast(ehErroApi(err)
            ? "Não foi possível consultar os equipamentos. Tente novamente."
            : "Falha de conexão ao consultar os equipamentos.", "error");
        }
      } finally {
        if (transferUtils.isCurrentQuery(
          autocompleteRequestGate, request.id, elemento("input-serial").value, term
        )) {
          elemento("autocomplete-box").setAttribute("aria-busy", "false");
        }
      }
    }, 200);
  }

  function handleSerialKeydown(e: KeyboardEvent) {
    const box = elemento("autocomplete-box");
    const isBoxOpen = box && !box.classList.contains("hidden") && totalAutocomplete() > 0;

    if (e.key === "ArrowDown") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex + 1) % totalAutocomplete();
        updateAutocompleteHighlight();
      }
    } else if (e.key === "ArrowUp") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex - 1 + totalAutocomplete()) % totalAutocomplete();
        updateAutocompleteHighlight();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Pesquisar sempre leva ao Home (F1), mesmo vindo de outra aba ou de um painel F5-F9.
      app.ativarAbaTransferencia?.("home");
      if (isBoxOpen && highlightedAutocompleteIndex >= 0) {
        selecionarPorIndice(highlightedAutocompleteIndex);
      } else if (isBoxOpen && (totalAutocomplete() === 1 || autocompleteItemsList.length <= 1)) {
        // Um só equipamento (mesmo com chamados/OS ao lado) ou, sem equipamentos, o primeiro chamado/OS: a pesquisa completa é só de equipamentos.
        selecionarPorIndice(0);
      } else if (isBoxOpen) {
        app.abrirPesquisaCompleta();
      } else {
        app.buscarSerial();
      }
    } else if (e.key === "Escape") {
      app.fecharAutocomplete();
    }
  }

  function selecionarPorIndice(index: number) {
    const equipamentos = autocompleteItemsList.length;
    if (index < equipamentos) return app.selecionarItemAutocomplete(autocompleteItemsList[index]);
    const { chamados, os } = autocompleteExtras;
    return index - equipamentos < chamados.length
      ? selecionarChamado(chamados[index - equipamentos].numero)
      : selecionarOs(os[index - equipamentos - chamados.length]);
  }

  async function selecionarChamado(numero: string) {
    app.fecharAutocomplete();
    if (!await app.abrirChamadoSebraeNoF5?.(numero)) app.showToast(`Chamado ${numero} não está na lista do F5.`, "warning");
  }

  // Abre a F6 na sub-aba da OS, limpa os filtros que a escondem e a destaca; depois a busca da F6 passa a mostrar só ela.
  async function selecionarOs({ os, serie }: BuscaChamadosOsResposta["os"][number]) {
    app.fecharAutocomplete();
    if (!await app.abrirChamadoDaOs?.([], serie, os)) return app.showToast(`OS ${os} não apareceu na aba OS (F6).`, "warning");
    const busca = elemento<HTMLInputElement>("cockpit-tickets-search");
    busca.value = os;
    busca.dispatchEvent(new Event("input", { bubbles: true }));
    // O filtro da F6 espera 150 ms: espera a linha da OS aparecer visível (até ~1 s).
    const procurar = () => [...document.querySelectorAll<HTMLElement>("#cockpit-tickets-os tbody tr[data-os]")].find(item => item.dataset.os === os && !item.hidden);
    let linha = procurar();
    for (let tentativa = 0; !linha && tentativa < 10; tentativa += 1) {
      await new Promise(resolver => setTimeout(resolver, 100));
      linha = procurar();
    }
    if (!linha) return;
    linha.scrollIntoView?.({ block: "center", behavior: "auto" });
    app.destacarLinhaCockpit?.(linha);
  }

  function updateAutocompleteHighlight() {
    const list = elemento("autocomplete-list");
    if (!list) return;
    const rows = list.querySelectorAll(".autocomplete-row");
    rows.forEach((row, idx) => {
      const selected = idx === highlightedAutocompleteIndex;
      row.setAttribute("aria-selected", String(selected));
      if (selected) {
        row.classList.add("active");
        elemento("input-serial").setAttribute("aria-activedescendant", row.id);
        row.scrollIntoView({ block: "nearest", behavior: "auto" });
      } else {
        row.classList.remove("active");
      }
    });
    if (highlightedAutocompleteIndex < 0) elemento("input-serial").removeAttribute("aria-activedescendant");
  }

  function selecionarItemAutocomplete(item: ItemLista) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    elemento("input-serial").value = item.serial;
    elemento("btn-clear-serial").classList.remove("hidden");
    app.fecharAutocomplete();
    return app.buscarSerial(item);
  }

  function ajustarAlturaAutocomplete() {
    const box = elemento("autocomplete-box");
    if (!box || box.classList.contains("hidden")) return;

    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const availableHeight = Math.max(0, Math.floor(viewportBottom - box.getBoundingClientRect().top - 12));
    box.style.setProperty("--autocomplete-available-height", `${availableHeight}px`);
  }

  // "Você quis dizer": o servidor sugere o usuário mais próximo quando a busca não acha nada.
  function aplicarSugestaoBusca(button: HTMLButtonElement) {
    const suggestion = button?.dataset?.sugestao || "";
    if (!suggestion) return;
    const input = elemento("input-serial");
    input.value = suggestion;
    input.focus();
    handleSerialInput(suggestion);
  }

  function renderAutocomplete(items: ItemLista[], total = items.length, hasMore = false, suggestion = "", extras: BuscaChamadosOsResposta = SEM_CHAMADOS_OS) {
    const box = elemento("autocomplete-box");
    const list = elemento("autocomplete-list");
    const emptyState = elemento("autocomplete-empty-state");
    const countEl = elemento("autocomplete-count");
    const moreResults = elemento("autocomplete-more-results");
    const moreResultsLabel = moreResults.querySelector<HTMLElement>("[data-autocomplete-more-label]")!;
    const currentQuery = (elemento("input-serial").value || "").trim();

    const temExtras = extras.chamados.length + extras.os.length > 0;
    const semEquipamentos = !items || items.length === 0;
    if (semEquipamentos) {
      list.replaceChildren();
      list.classList.toggle("hidden", !temExtras);
      emptyState.classList.remove("hidden");
      moreResults.classList.add("hidden");
      emptyState.innerHTML = `
          <div class="ck-ac__vazio">
            <svg class="ck-ico ck-ico--lg" aria-hidden="true" focusable="false"><use href="#i-search"></use></svg>
            ${temExtras ? "" : `<p class="ck-ac__vazio-titulo" role="status" aria-live="polite">Nenhum equipamento localizado</p>`}
            ${temExtras ? "" : `<p class="ck-ac__vazio-texto">Nenhum registro com o termo <strong class="ck-ac__vazio-termo">"${escapeHtml(currentQuery)}"</strong> foi encontrado no inventário do SEBRAE/PR.</p>`}
            ${suggestion ? `<p class="ck-ac__vazio-sugestao">Você quis dizer <button type="button" class="ck-ac__vazio-sugestao-botao" data-on-click="aplicarSugestaoBusca" data-args='["$this"]' data-sugestao="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>?</p>` : ""}
            <button type="button" data-on-click="cadastrarNovoSerialPesquisado" class="ck-btn ck-btn--primario ck-btn--sm">
              <svg class="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-plus"></use></svg>
              <span>Cadastrar "${escapeHtml(currentQuery)}" como Novo Equipamento</span>
            </button>
          </div>
        `;
      countEl.innerHTML = "<strong>Equipamentos</strong> · 0";
      moreResultsLabel.textContent = "Mostrar mais";
      moreResults.querySelector("button")?.removeAttribute("aria-label");
      autocompleteItemsList = [];
      autocompleteExtras = SEM_CHAMADOS_OS;
      highlightedAutocompleteIndex = -1;
      elemento("input-serial").setAttribute("aria-expanded", "true");
      elemento("input-serial").removeAttribute("aria-activedescendant");
      box.classList.remove("hidden");
      ajustarAlturaAutocomplete();
      lucide.createIcons({ root: box });
      // Sem equipamentos mas com chamados/OS: o estado vazio (cadastro e sugestão) fica junto dos grupos.
      if (!temExtras) return;
    }

    autocompleteItemsList = items || [];
    autocompleteExtras = extras;
    highlightedAutocompleteIndex = -1;
    list.innerHTML = "";
    list.classList.remove("hidden");
    emptyState.classList.toggle("hidden", !semEquipamentos);
    countEl.innerHTML = hasMore
      ? `<strong>Equipamentos</strong> · ${items.length} de ${total}`
      : `<strong>Equipamentos</strong> · ${total}`;
    moreResults.classList.toggle("hidden", !hasMore);
    const remainingResults = Math.max(0, Number(total) - items.length);
    moreResultsLabel.textContent = `Mostrar mais (${remainingResults})`;
    moreResults.querySelector("button")?.setAttribute(
      "aria-label",
      `Mostrar mais ${remainingResults} ${remainingResults === 1 ? "resultado" : "resultados"}`,
    );
    elemento("input-serial").setAttribute("aria-expanded", "true");
    elemento("input-serial").removeAttribute("aria-activedescendant");

    // Cabeçalhos só existem com chamados ou OS; sem eles a lista fica como sempre foi (linhas direto no listbox).
    const grupo = (id: string, titulo: string, linhas: HTMLElement[]) => {
      if (linhas.length === 0) return;
      if (!temExtras) return list.append(...linhas);
      const rotulo = createTextElement("span", "", titulo);
      rotulo.id = `autocomplete-grupo-${id}`;
      const cabecalho = createTextElement("div", "ck-ac__grupo-cab", "");
      cabecalho.append(rotulo, createTextElement("span", "ck-ac__grupo-n", String(linhas.length)));
      const wrapper = createTextElement("div", "ck-ac__grupo", "");
      wrapper.setAttribute("role", "group");
      wrapper.setAttribute("aria-labelledby", rotulo.id);
      wrapper.append(cabecalho, ...linhas);
      list.append(wrapper);
    };
    const callbacks = (index: number) => ({
      onSelect: () => selecionarPorIndice(index),
      onHighlight: () => {
        highlightedAutocompleteIndex = index;
        updateAutocompleteHighlight();
      },
    });
    const base = autocompleteItemsList.length;
    grupo("equipamentos", "Equipamentos", autocompleteItemsList.map((item, index) => renderers.criarLinhaAutocomplete(item, index, currentQuery, callbacks(index))));
    grupo("chamados", "Chamados", extras.chamados.map((item, index) => renderers.criarLinhaChamado(item, base + index, currentQuery, callbacks(base + index))));
    grupo("os", "OS", extras.os.map((item, index) => renderers.criarLinhaOs(item, base + extras.chamados.length + index, currentQuery, callbacks(base + extras.chamados.length + index))));

    box.classList.remove("hidden");
    ajustarAlturaAutocomplete();
    lucide.createIcons({ root: box });
  }

  function fecharAutocomplete() {
    const box = elemento("autocomplete-box");
    if (box) box.classList.add("hidden");
    if (box) box.setAttribute("aria-busy", "false");
    const input = elemento("input-serial");
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    autocompleteItemsList = [];
    autocompleteExtras = SEM_CHAMADOS_OS;
    highlightedAutocompleteIndex = -1;
  }

  // Close autocomplete on click outside
  document.addEventListener("click", (e: MouseEvent) => {
    const box = elemento("autocomplete-box");
    const input = elemento("input-serial");
    const target = e.target instanceof Node ? e.target : null;
    if (box && !box.contains(target) && target !== input) {
      app.fecharAutocomplete();
    }
  });

  window.addEventListener("resize", ajustarAlturaAutocomplete);

  window.visualViewport?.addEventListener("resize", ajustarAlturaAutocomplete);

  document.addEventListener("scroll", ajustarAlturaAutocomplete, { capture: true, passive: true });

  function limparSerial() {
    const input = elemento("input-serial");
    input.value = "";
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    elemento("btn-clear-serial").classList.add("hidden");
    app.fecharAutocomplete();
    input.focus();
    clearTimeout(homeListTimer);
    void carregarListaHome({ query: "", reset: true });
  }

  // Search Equipment by Serial
  async function buscarSerial(equipmentHint: ItemLista | null = null) {
    app.ativarAbaTransferencia?.("home");
    const serialInput = elemento("input-serial");
    const serial = serialInput.value.trim().toUpperCase();

    if (!serial) {
      app.invalidarBuscasEquipamento();
      app.limparSelecaoEquipamento();
      app.showToast("Digite uma série, apelido, modelo, cidade ou nome do usuário", "warning");
      serialInput.focus();
      return;
    }

    clearTimeout(debounceTimer);
    autocompleteRequestGate.invalidate();
    elemento("autocomplete-box").setAttribute("aria-busy", "false");
    app.fecharAutocomplete();
    app.limparSelecaoEquipamento();
    const request = equipmentLookupRequestGate.begin();

    const btn = elemento("btn-buscar-serial");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    serialInput.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Localizando...</span>`;
    lucide.createIcons({ root: btn });
    const stopLoading = motion?.startLoading(elemento("equipment-loading"), "Localizando equipamento…", { rows: 1 }) || (() => {});
    finishEquipmentLoading = stopLoading;

    try {
      let data: EquipamentoPesquisa;
      try {
        data = await context.apiFetch<EquipamentoPesquisa>(`/api/equipamento/${encodeURIComponent(serial)}`, {
          signal: request.signal,
          errorMessage: "Equipamento não encontrado na base de dados.",
        });
      } catch (lookupError: unknown) {
        // Only HTTP failures carry a status; network errors and cancellation propagate unchanged.
        if (!ehErroApi(lookupError)) throw lookupError;
        if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        if (lookupError.status === 404 && serial.length >= 2) {
          let searchResults: RespostaBusca | null = null;
          try {
            searchResults = await context.apiFetch<RespostaBusca>(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=15`, {
              signal: request.signal,
              errorMessage: "Não foi possível consultar os equipamentos.",
            });
          } catch (searchError: unknown) {
            if (!ehErroApi(searchError)) throw searchError;
          }
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          if (searchResults && equipmentLookupRequestGate.isCurrent(request.id) && searchResults.total > 0) {
            renderAutocomplete(searchResults.items, searchResults.total, searchResults.has_more, searchResults.sugestao);
            void carregarListaHome({ query: serialInput.value.trim(), reset: true });
            return;
          }
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        }
        throw lookupError;
      }
      if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
      if (!transferUtils.isCurrentQuery(equipmentLookupRequestGate, request.id, serialInput.value, serial)) return;
      if (transferUtils.serialForTransfer(data, serial) !== serial) {
        throw new Error("A busca não retornou uma correspondência exata. Escolha um equipamento na lista.");
      }
      const hintedSerial = String(equipmentHint?.serial || "").trim().toUpperCase();
      const hintedCnpj = String(equipmentHint?.retirada_cnpj || "").trim();
      if (
        hintedSerial === serial
        && hintedCnpj
        && !String(data.retirada_cnpj || "").trim()
      ) {
        data.retirada_cnpj = hintedCnpj;
      }
      app.definirEquipamentoAtual(data);
      app.exibirEquipamento(data);
      if (recentStore) renderizarPesquisasRecentes(recentStore.add(data));
      app.showToast(`Equipamento ${data.serial} localizado.`, "success");

    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === "AbortError") && equipmentLookupRequestGate.isCurrent(request.id)) {
        console.error(err);
        app.limparSelecaoEquipamento();
        app.showToast(mensagemErro(err, "Não foi possível localizar o equipamento."), "error");
      }
    } finally {
      stopLoading();
      if (equipmentLookupRequestGate.isCurrent(request.id)) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        serialInput.removeAttribute("aria-busy");
        btn.innerHTML = originalText;
        lucide.createIcons({ root: btn });
      }
    }
  }

  // Recent lookups below the search card. Hidden while empty; each row repeats the normal search.
  function renderizarPesquisasRecentes(entries: RecentEntry[] = recentStore?.read() || []) {
    const section = elemento("home-recentes");
    const list = elemento("home-recentes-lista");
    if (!section || !list) return;
    list.replaceChildren(...entries.map(entry => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ck-recente";
      button.dataset.serial = entry.serial;
      button.setAttribute("aria-label", recentEquipment?.describeEntry(entry) || entry.serial);
      button.append(
        createTextElement("span", "ck-recente__serie", entry.serial),
        createTextElement("span", "ck-recente__extra", entry.apelido || "Sem apelido"),
        createTextElement("span", "ck-recente__extra", entry.cidade || "Cidade não informada"),
      );
      button.addEventListener("click", () => app.abrirPesquisaRecente(entry.serial));
      item.append(button);
      return item;
    }));
    section.hidden = entries.length === 0;
  }

  function abrirPesquisaRecente(serial: string) {
    const entry = (recentStore?.read() || []).find(item => item.serial === serial) || { serial };
    window.scrollTo?.({ top: 0, behavior: "smooth" });
    return app.selecionarItemAutocomplete(entry);
  }

  function limparPesquisasRecentes() {
    renderizarPesquisasRecentes(recentStore?.clear() || []);
    elemento("input-serial")?.focus({ preventScroll: true });
  }

  if (recentStore) renderizarPesquisasRecentes();

  // City plus the street part of the address; no dangling " - " when one is missing.
  function formatarLocalAtual(eq: EquipamentoPesquisa) {
    const cidade = String(eq?.retirada_cidade || "").trim();
    const endereco = String(eq?.retirada_endereco || "").split("-")[0].trim();
    return [cidade, endereco].filter(Boolean).join(" - ") || "Não especificado";
  }

  // Render Equipment Card & Populate Retirada Section
  function exibirEquipamento(eq: EquipamentoPesquisa) {
    appState.retiradaCidadeSelecionada = String(eq.retirada_cidade || "").trim();
    const card = elemento("card-equipamento");
    const emptyState = elemento("home-detail-empty");
    if (emptyState) emptyState.classList.add("hidden");
    card.classList.remove("hidden");
    motion?.reveal(card);

    elemento("card-serial").textContent = eq.serial;
    elemento("ticket-templates-serial").textContent = eq.serial || "—";
    app.recolherVisualizacoesModelosChamado();
    elemento("card-modelo").textContent = eq.modelo || "Equipamento";
    elemento("badge-tipo").textContent = eq.tipo || "Geral";
    elemento("badge-apelido").textContent = eq.apelido || "Sem Apelido";
    // O apelido é o hostname no Endpoint; sem ele, o campo fica vazio e vale o computador padrão.
    elemento("input-powershell-hostname").value = eq.apelido || "";
    void carregarCodigosPowerShell(); // o formulário fica sempre visível; o cache evita novo GET nas próximas seleções
    const aliasStatus = elemento("badge-apelido-status");
    aliasStatus.textContent = eq.invall_alias_status && eq.invall_alias_status !== "aplicado"
      ? (eq.invall_alias_detail || "Conferir associação com a InvAll.")
      : "";
    aliasStatus.classList.toggle("hidden", !aliasStatus.textContent);
    elemento("card-id-cliente").textContent = eq.idCliente ? `Id Cliente: ${eq.idCliente}` : "";
    app.atualizarUsuarioLogadoCard(eq);
    app.termosPreencherDoEquipamento?.(eq);
    app.atualizarChamadosAbertosHome(eq.serial);
    elemento("card-localizacao").textContent = app.formatarLocalAtual(eq);
    elemento("card-cnpj-atual").textContent = `CNPJ: ${eq.retirada_cnpj || 'Não especificado'}`;

    // Grade de detalhe (split-view)
    const gridSerial = elemento("grid-serial");
    if (gridSerial) gridSerial.textContent = eq.serial || "—";
    const gridApelido = elemento("grid-apelido");
    if (gridApelido) gridApelido.textContent = eq.apelido || "—";
    const gridCep = elemento("grid-cep");
    if (gridCep) gridCep.textContent = eq.retirada_cep || "—";
    const gridCnpjFat = elemento("grid-cnpj-fat");
    if (gridCnpjFat) gridCnpjFat.textContent = eq.retirada_cnpj || "—";
    const gridCnpjInst = elemento("grid-cnpj-inst");
    if (gridCnpjInst) gridCnpjInst.textContent = eq.retirada_cnpj_instalacao || eq.retirada_cnpj || "—";

    // Type is shown as text in the chip; the icon only changes shape.
    const iconBox = elemento("equip-icon-box");
    const icon = elemento("equip-icon");
    // Literal setAttribute calls keep each icon in the generated Lucide subset.
    if (eq.tipo === "Notebook") icon.setAttribute("data-lucide", "laptop");
    else if (eq.tipo === "Micro Computador") icon.setAttribute("data-lucide", "monitor");
    else icon.setAttribute("data-lucide", "headphones");
    lucide.createIcons({ root: iconBox });

    // Automatically fill RETIRADA (Origem) section!
    elemento("retirada-cnpj").value = eq.retirada_cnpj || "";
    elemento("retirada-endereco").value = eq.retirada_endereco || "";
    elemento("retirada-obs").value = eq.descricao_sugerida || "";
    app.preencherRepresentanteRegional("retirada", eq.retirada_cidade || "");

    // Update status footer
    elemento("status-indicator").dataset.state = "loaded";
    const statusSummary = elemento("status-summary");
    statusSummary.replaceChildren(
      createTextElement("span", "ck-acoes-carregado", "Equipamento " + String(eq.serial ?? "") + " (" + String(eq.modelo ?? "") + ") carregado."),
      createTextElement("span", "ck-acoes-pronto", " Selecione a Unidade de Destino e preencha o destinatário.")
    );

    // Highlight na lista lateral
    highlightHomeListItem(eq.serial);
    app.atualizarPreviaTransporteCockpit?.();
  }

  function highlightHomeListItem(serial: string | null | undefined) {
    const list = elemento("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    list.querySelectorAll('.ck-item[aria-selected="true"]').forEach(el => {
      el.setAttribute("aria-selected", "false");
    });
    const target = serial ? list.querySelector(`[data-serial="${CSS.escape(String(serial).toUpperCase())}"]`) : null;
    if (target) {
      target.setAttribute("aria-selected", "true");
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
    const active = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.id === list.getAttribute("aria-activedescendant"));
    atualizarAcoesListaHome(active?.dataset.serial || (target ? String(serial || "") : ""));
  }

  function serialDeComparacao(item: unknown) {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return String(row?.serie || row?.serial || row?.numero_serie || "").trim().toUpperCase();
  }

  function seriesDaComparacao(comparison: ComparacaoHome | null, keys: readonly string[], requiredKeys: readonly string[] = keys) {
    const values = [];
    for (const key of keys) {
      const rows = comparison?.[key];
      if (!Array.isArray(rows)) {
        if (requiredKeys.includes(key)) return null;
        continue;
      }
      for (const row of rows) {
        const serial = serialDeComparacao(row);
        if (!serial) return null;
        values.push(serial);
      }
    }
    return new Set(values);
  }

  function atualizarContagemFiltro(id: string, total: number | null | undefined, disponivel = true) {
    const value = elemento(id);
    const button = value?.closest("button");
    if (value) value.textContent = typeof total === "number" && Number.isSafeInteger(total) && total >= 0
      ? total.toLocaleString("pt-BR")
      : "—";
    if (button) button.disabled = !disponivel;
  }

  async function carregarFiltrosComparacaoHome() {
    const filters = homeComparisonFilters;
    try {
      const dashboard = await painelCompartilhado(() => context.apiFetch<DadosPainel>(ENDPOINT, {
        cache: "no-store", errorMessage: "Resumo do painel indisponível.",
      }));
      const eventId = String(dashboard?.ultima_comparacao?.id || "").trim();
      if (!eventId) throw new Error("Ainda não há comparação de inventários.");

      const result = await context.apiFetch<RespostaHistoricoComparacao>(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, {
        cache: "no-store", errorMessage: "Detalhes da última comparação indisponíveis.",
      });
      const comparison = result?.evento?.comparacao;
      if (!comparison || typeof comparison !== "object") throw new Error("A última comparação não contém detalhes.");

      const stale = seriesDaComparacao(comparison, HOME_COMPARISON_FILTERS["7-dias"]);
      const divergent = seriesDaComparacao(
        comparison,
        HOME_COMPARISON_FILTERS.divergentes,
        ["ausentes_no_endpoint", "divergencias_local"],
      );
      filters["7-dias"] = stale;
      filters.divergentes = divergent;
      atualizarContagemFiltro("home-filter-7-dias", stale?.size, stale !== null);
      atualizarContagemFiltro("home-filter-divergentes", divergent?.size, divergent !== null);
      atualizarMapaSeriesComparacao(comparison);
      if (!homeListQuery && homeListFilter === "todos") {
        await carregarListaHome({ query: "", reset: true });
      }
    } catch (error: unknown) {
      filters["7-dias"] = null;
      filters.divergentes = null;
      atualizarContagemFiltro("home-filter-7-dias", null, false);
      atualizarContagemFiltro("home-filter-divergentes", null, false);
      // The Home inventory remains usable even when comparison history is unavailable.
      console.info("Filtros de comparação da Home indisponíveis:", mensagemErro(error, "Erro desconhecido."));
    }
  }

  function atualizarMapaSeriesComparacao(comparison: ComparacaoHome) {
    homeListSerials = new Map();
    const staleRows = Array.isArray(comparison?.sem_acesso_7_dias) ? comparison.sem_acesso_7_dias : [];
    for (const row of staleRows) {
      const serial = serialDeComparacao(row);
      if (!serial) continue;
      const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
      const days = Number(record.dias_sem_acesso ?? record.dias ?? record.dias_desde_ultimo_acesso);
      homeListSerials.set(serial, { stale: true, days: Number.isFinite(days) && days > 0 ? days : null });
    }
    // First listed key wins, so the chip lands on the section the Resumo shows first for that serial.
    for (const [key, category] of HOME_DIVERGENCE_CATEGORIES) {
      const rows = Array.isArray(comparison?.[key]) ? comparison[key] : [];
      for (const row of rows) {
        const serial = serialDeComparacao(row);
        if (!serial) continue;
        const previous = homeListSerials.get(serial);
        homeListSerials.set(serial, { ...previous, divergent: true, divergentCategory: previous?.divergentCategory || category });
      }
    }
  }

  function atualizarContagensHome(filters: FiltrosListaHome | undefined, total: number) {
    if (homeCountsLoaded || homeListQuery || homeListFilter !== "todos") return;
    homeCountsLoaded = true;
    const totalCount = Number(total);
    const withoutUser = Number(filters?.users?.sem);
    atualizarContagemFiltro("home-filter-total", totalCount);
    atualizarContagemFiltro("home-filter-sem-usuario", withoutUser);
  }

  function limparListaHome(message: string) {
    homeListItems = new Map();
    atualizarAcoesListaHome("");
    const list = elemento("home-equipment-list");
    if (list) {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      list.removeAttribute("aria-activedescendant");
      list.dataset.estado = "vazio";
    }
    const empty = elemento("home-list-empty");
    if (empty) {
      empty.textContent = message;
      empty.hidden = false;
    }
    const count = elemento("home-list-count");
    if (count) count.textContent = message;
    const more = elemento("btn-home-list-more");
    if (more) more.hidden = true;
  }

  function statusDaLinhaHome(item: EquipamentoPesquisa): StatusItemHome[] {
    const serial = String(item?.serial || "").trim().toUpperCase();
    const comparison = homeListSerials.get(serial);
    const statuses: StatusItemHome[] = [];
    if (comparison?.stale) {
      statuses.push({
        tone: "alerta",
        icon: "i-alerta",
        label: comparison.days ? `Sem acesso ${comparison.days} d` : "Sem acesso 7+ d",
        destino: "comparacao",
        categoria: "sem_acesso_7_dias",
      });
    }
    if (comparison?.divergent) {
      statuses.push({ tone: "erro", icon: "i-erro", label: "Divergente", destino: "comparacao", categoria: comparison.divergentCategory || "divergencias_local" });
    }
    if (!String(item?.usuarios_logados || "").trim()) {
      // The Resumo lists only notebooks/MacBooks without a user (the Home "Sem usuário" filter rule); other types get no link.
      const linkable = HOME_NOTEBOOK_CATEGORIES.includes(String(item?.categoria || "").toLowerCase());
      statuses.push({ tone: "info", icon: "i-user", label: "Sem usuário", ...(linkable ? { destino: "comparacao", categoria: "sem_usuario" } : {}) });
    }
    return statuses.length ? statuses : [{ tone: "ok", icon: "i-ok", label: "Sincronizado" }];
  }

  function criarStatusListaHome(status: StatusItemHome, serial: string, interativo = false) {
    const el = document.createElement(interativo ? "button" : "span");
    el.className = interativo ? "ck-status ck-status--link" : "ck-status";
    el.dataset.status = status.tone;
    el.append(status.label);
    const svgNs = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNs, "svg");
    icon.setAttribute("class", "ck-ico ck-ico--xs");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const use = document.createElementNS(svgNs, "use");
    use.setAttribute("href", `#${status.icon}`);
    icon.append(use);
    el.prepend(icon);
    if (interativo) {
      (el as HTMLButtonElement).type = "button";
      el.dataset.destino = status.destino;
      el.dataset.categoria = status.categoria;
      el.title = "Abrir no Resumo";
      el.setAttribute("aria-label", `${status.label}: abrir ${serial} no Resumo (F3)`);
      el.addEventListener("click", (event: Event) => {
        event.stopPropagation();
        void abrirDestinoStatusHome(status.categoria || "", serial);
      });
      el.addEventListener("keydown", event => event.stopPropagation());
    }
    return el;
  }

  function atualizarAcoesListaHome(serial: string) {
    homeListActiveSerial = String(serial || "").trim();
    const actions = elemento("home-equipment-actions");
    if (!actions) return;
    // Serial outside the rendered list: unknown user, so no "Sem usuário" chip (the placeholder user keeps it out).
    const activeItem = homeListItems.get(homeListActiveSerial.toUpperCase()) || { serial: homeListActiveSerial, usuarios_logados: "—" };
    const statuses = homeListActiveSerial ? statusDaLinhaHome(activeItem).filter(status => status.destino) : [];
    const signature = JSON.stringify([homeListActiveSerial, statuses]);
    if (actions.dataset.signature === signature) return;
    const focused = document.activeElement;
    const focusedDestination = focused instanceof HTMLElement
      && actions.dataset.serial === homeListActiveSerial && actions.contains(focused) ? focused.dataset.categoria : "";
    actions.dataset.signature = signature;
    actions.dataset.serial = homeListActiveSerial;
    actions.hidden = !statuses.length;
    actions.replaceChildren();
    if (!statuses.length) return;
    actions.setAttribute("aria-label", `Ações de ${homeListActiveSerial}`);
    actions.append(
      createTextElement("span", "ck-lista__info", `Ações de ${homeListActiveSerial}`),
      ...statuses.map(status => criarStatusListaHome(status, homeListActiveSerial, true)),
    );
    if (focusedDestination) actions.querySelector(`[data-categoria="${CSS.escape(focusedDestination)}"]`)?.focus({ preventScroll: true });
  }

  // Opens the Resumo (F3) on the serial's row in the section of the chip's category.
  async function abrirDestinoStatusHome(categoria: string, serial: string) {
    await app.abrirComparacaoDaSerie?.(serial, categoria);
  }

  function criarPilhaStatusHome(statuses: StatusItemHome[], serial: string) {
    const pilha = document.createElement("span");
    pilha.className = "ck-item__status";
    pilha.append(...statuses.map(status => criarStatusListaHome(status, serial)));
    return pilha;
  }

  function criarOpcaoListaHome(item: ItemLista, index: number) {
    const li = document.createElement("li");
    const serial = String(item?.serial || "").trim();
    const city = String(item?.retirada_cidade || "").trim();
    const user = String(item?.usuarios_logados || item?.nome_pessoa || "").trim();
    const statuses = statusDaLinhaHome(item);
    li.className = "ck-item";
    li.id = `home-equipment-option-${index}`;
    li.dataset.serial = serial.toUpperCase();
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(String(appState.currentEquipamento?.serial || "").toUpperCase() === serial.toUpperCase()));
    li.tabIndex = -1;
    const detail = [item?.modelo, user].filter(Boolean).join(" · ");
    li.title = [serial, detail, city, ...statuses.map((status) => status.label)].filter(Boolean).join(" · ");
    li.append(
      createTextElement("span", "ck-item__serie", serial || "Série não informada"),
      createTextElement("span", "ck-item__local", city || "Sem cidade"),
      createTextElement("span", "ck-item__sub", detail || "Sem modelo ou usuário"),
      criarPilhaStatusHome(statuses, serial),
    );
    li.addEventListener("click", () => {
      const list = elemento("home-equipment-list");
      list.setAttribute("aria-activedescendant", li.id);
      list.querySelectorAll('[role="option"]').forEach(option => option.classList.toggle("is-focused", option === li));
      atualizarAcoesListaHome(serial);
      app.selecionarItemAutocomplete(item);
    });
    return li;
  }

  function renderHomeList(items: ItemLista[], append = false) {
    const list = elemento("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    if (!append) {
      list.replaceChildren();
      list.removeAttribute("aria-activedescendant");
      homeListItems = new Map();
    }
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const serial = String(item?.serial || "").trim().toUpperCase();
      if (serial && list.querySelector(`[data-serial="${CSS.escape(serial)}"]`)) return;
      if (serial) homeListItems.set(serial, item);
      list.appendChild(criarOpcaoListaHome(item, homeListOffset + index));
    });
    const selected = String(appState.currentEquipamento?.serial || "").trim();
    if (selected) highlightHomeListItem(selected);
    else if (homeListActiveSerial && !list.querySelector(`[data-serial="${CSS.escape(homeListActiveSerial.toUpperCase())}"]`)) atualizarAcoesListaHome("");
  }

  async function carregarListaHome({ query = homeListQuery, reset = true }: OpcoesCarregarLista = {}) {
    const list = elemento("home-equipment-list");
    if (!list) return;
    homeListQuery = String(query || "").trim();
    finishHomeListLoading();
    finishHomeListLoading = () => {};
    if (homeListQuery.length === 1) {
      homeListRequestGate.invalidate();
      homeListHasMore = false;
      limparListaHome("Digite ao menos 2 caracteres para filtrar a lista.");
      return;
    }
    const request = homeListRequestGate.begin();
    const offset = reset ? 0 : homeListOffset;
    if (reset) {
      atualizarAcoesListaHome("");
      homeListOffset = 0;
      homeListTotal = 0;
      homeListHasMore = false;
      list.replaceChildren();
      list.setAttribute("aria-busy", "true");
      list.dataset.estado = "carregando";
      list.removeAttribute("aria-activedescendant");
      finishHomeListLoading = motion?.startLoading(elemento("equipment-loading"), "Carregando equipamentos…") || (() => {});
      const count = elemento("home-list-count");
      if (count) count.textContent = "Carregando equipamentos…";
      const empty = elemento("home-list-empty");
      if (empty) empty.hidden = true;
    }

    const params = new URLSearchParams({
      listar_todos: "true",
      offset: String(offset),
      limit: String(HOME_LIST_PAGE_SIZE),
      include_filters: "true",
    });
    if (homeListQuery.length >= 2) params.set("q", homeListQuery);
    if (homeListFilter === "sem-usuario") params.set("usuario", "sem");
    if (homeListFilter === "7-dias" || homeListFilter === "divergentes") {
      const series = homeComparisonFilters[homeListFilter];
      if (!series) {
        finishHomeListLoading();
        limparListaHome("O filtro depende de uma comparação de inventários disponível.");
        return;
      }
      series.forEach(serial => params.append("serie", serial));
    }

    try {
      const result = await context.apiFetch<RespostaListaHome>(`/api/buscar-expandida?${params.toString()}`, {
        signal: request.signal,
        errorMessage: "Não foi possível carregar a lista de equipamentos.",
      });
      if (!homeListRequestGate.isCurrent(request.id)) return;
      finishHomeListLoading();

      homeListTotal = Number(result.total) || 0;
      homeListOffset = offset + (Array.isArray(result.items) ? result.items.length : 0);
      homeListHasMore = result.has_more === true;
      if (!homeListQuery && homeListFilter === "todos") {
        atualizarContagensHome(result.filters, homeListTotal);
      }
      renderHomeList(result.items, !reset);
      const empty = elemento("home-list-empty");
      const hasItems = list.children.length > 0;
      list.dataset.estado = hasItems ? "pronto" : "vazio";
      if (empty) {
        empty.textContent = homeListQuery
          ? "Nenhum equipamento corresponde à pesquisa."
          : "Nenhum equipamento encontrado para este filtro.";
        empty.hidden = hasItems;
      }
      const count = elemento("home-list-count");
      if (count) {
        const shown = list.children.length;
        count.textContent = homeListHasMore
          ? `Mostrando ${shown.toLocaleString("pt-BR")} de ${homeListTotal.toLocaleString("pt-BR")}`
          : `${homeListTotal.toLocaleString("pt-BR")} ${homeListTotal === 1 ? "equipamento" : "equipamentos"}`;
      }
      const more = elemento("btn-home-list-more");
      if (more) more.hidden = !homeListHasMore;
      list.setAttribute("aria-busy", "false");
    } catch (error: unknown) {
      if ((error instanceof Error && error.name === "AbortError") || !homeListRequestGate.isCurrent(request.id)) return;
      finishHomeListLoading();
      list.setAttribute("aria-busy", "false");
      const message = ehErroApi(error) && error.status === 409
        ? "A base está sendo atualizada. Tente novamente em instantes."
        : mensagemErro(error, "Não foi possível carregar os equipamentos.");
      if (!reset) {
        // "Carregar mais" falhou: mantém o que já está na tela e o botão para tentar de novo.
        const count = elemento("home-list-count");
        if (count) count.textContent = message;
        return;
      }
      limparListaHome(message);
      list.dataset.estado = "erro";
    }
  }

  function filtrarListaHome(filter: FiltroHome) {
    if (!["todos", "sem-usuario", "7-dias", "divergentes"].includes(filter)) return;
    if ((filter === "7-dias" || filter === "divergentes") && !homeComparisonFilters[filter]) return;
    homeListFilter = filter;
    document.querySelectorAll<HTMLElement>(".ck-filtro[data-filter]").forEach(button => {
      const active = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(active));
    });
    void carregarListaHome({ query: elemento("input-serial")?.value || "", reset: true });
  }

  function carregarMaisItensHome() {
    if (!homeListHasMore) return;
    return carregarListaHome({ query: homeListQuery, reset: false });
  }

  function ativarNavegacaoListaHome() {
    const list = elemento("home-equipment-list");
    if (!list || list.dataset.keyboardReady) return;
    list.dataset.keyboardReady = "true";
    list.addEventListener("keydown", event => {
      const options = [...list.querySelectorAll('[role="option"]')];
      if (!options.length) return;
      let index = options.findIndex(option => option.id === list.getAttribute("aria-activedescendant"));
      if (event.key === "ArrowDown") index = Math.min(index + 1, options.length - 1);
      else if (event.key === "ArrowUp") index = Math.max(index <= 0 ? 0 : index - 1, 0);
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = options.length - 1;
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        options[index].click();
        return;
      } else return;
      event.preventDefault();
      list.setAttribute("aria-activedescendant", options[index].id);
      atualizarAcoesListaHome(options[index].dataset.serial || "");
      options.forEach((option, optionIndex) => option.classList.toggle("is-focused", optionIndex === index));
      options[index].scrollIntoView({ block: "nearest", behavior: "auto" });
    });
  }

  function inicializarListaHome() {
    ativarNavegacaoListaHome();
    void carregarFiltrosComparacaoHome();
    void carregarListaHome({ query: "", reset: true });
  }

  return {
    consultarEndpoint,
    controleRemotoEndpoint, abrirPowerShellEndpoint, aplicarCodigoProntoPowerShell,
    carregarCodigosPowerShell, alternarEditorCodigosPowerShell, adicionarCodigoPowerShell, salvarCodigosPowerShell,
    definirEquipamentoAtual, limparSelecaoEquipamento, invalidarBuscasEquipamento,
    invalidarDadosEquipamentoAposRestauracao, atualizarSelecaoAposSubstituirInventarios, handleSerialInput,
    handleSerialKeydown, selecionarItemAutocomplete, aplicarSugestaoBusca, fecharAutocomplete,
    limparSerial, buscarSerial, exibirEquipamento, formatarLocalAtual, abrirPesquisaRecente, limparPesquisasRecentes,
    renderHomeList, highlightHomeListItem, filtrarListaHome, carregarMaisItensHome, carregarListaHome, inicializarListaHome,
  };
}


