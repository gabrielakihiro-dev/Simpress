import type { ApiFetchError, ApiFetchOptions } from "../../api";

// Indicadores da Home: estatísticas do inventário, painel de disponibilidade (readiness) e os cartões de
// alerta do sino. Só sintaxe apagável (sem enum/namespace): os testes carregam este .ts direto no Node.
interface PortaoRequisicao {
  begin(): { id: number; signal: AbortSignal };
  isCurrent(id: number): boolean;
}
interface TransferUtilsIndicadores {
  createRequestGate(): PortaoRequisicao;
}
interface MotionIndicadores {
  stagger(elementos: HTMLCollection): void;
}
interface AppIndicadores {
  abrirModalAtualizarPlanilhas(evento?: Event): unknown;
  abrirPainelCockpit(painel: string): unknown;
  abrirGestaoChamadosCockpit?(): unknown;
  abrirImportacaoModelo(tipo: string): unknown;
  abrirModalGerenciarUnidades(evento?: Event): unknown;
  abrirConfiguracaoLocal(): unknown;
  carregarEstatisticas(): unknown;
}
interface StatusProntidao {
  available?: boolean;
  state?: string;
  reason?: string;
  missing_files?: string[];
}
interface ConfiguracaoLocal {
  state?: string;
  reason?: string;
  assistente_ia?: boolean;
}
interface RelatorioProntidao {
  functions: Record<string, StatusProntidao | undefined>;
  files: Record<string, StatusProntidao | undefined>;
  gravacao_bloqueada?: { available?: boolean };
  configuracao_local?: ConfiguracaoLocal;
}
interface Estatisticas {
  total_equipamentos?: unknown;
  total_unidades?: unknown;
  exportacao_disponivel?: boolean;
  total_alteracoes_exportaveis?: unknown;
  exportacao_motivo?: string;
}
interface ContagemProntidao {
  availableCount: number;
  totalCount: number;
  allAvailable: boolean;
}
type EstadoItemProntidao = "ok" | "pendente" | "invalido";
interface AcaoProntidao {
  id?: string;
  label: string;
  labelOk?: string;
  icone?: string;
  ariaLabel?: string;
  onClick: (evento: Event) => unknown;
}
interface ItemProntidao {
  id?: string;
  pendencia?: string;
  icone: string;
  titulo: string;
  descricao: string;
  detalhe?: string;
  secundario?: string;
  estado: EstadoItemProntidao;
  acao?: AcaoProntidao;
}
interface DadosAlerta {
  estado?: string;
  total?: unknown;
  limite_dias?: unknown;
  dias_sem_atualizacao?: unknown;
  ultima_atualizacao?: unknown;
  maior_dias_sem_atualizacao?: unknown;
  limite_aviso_dias?: unknown;
  total_passou?: unknown;
  total_limite?: unknown;
  total_saiu_endpoint?: unknown;
  equipamentos?: unknown;
  atual?: { horario?: unknown };
  anterior?: { horario?: unknown };
  por_secao?: unknown;
  indisponivel?: unknown;
  pendencias?: { sem_backup?: unknown; conferir?: unknown };
  itens?: unknown;
}
interface FalhaFinalizacao {
  numero?: unknown;
  motivo?: unknown;
}
interface DadosPainelHome {
  base_desatualizada?: DadosAlerta;
  sem_acesso_60_dias?: DadosAlerta;
  os_paradas?: DadosAlerta;
  divergencias_novas?: DadosAlerta;
  chamados_outro_tecnico?: DadosAlerta;
  falhas_finalizacao_softexpert?: DadosAlerta;
  backups_regionais?: DadosAlerta;
}
interface ItemSemAcesso {
  serie?: string;
  computador?: string;
  dias?: unknown;
  situacao?: string;
}
type Pluralizar = (total: number, singular: string, plural?: string) => string;
export interface ContextoIndicadoresHome {
  app: AppIndicadores;
  transferUtils: TransferUtilsIndicadores;
  motion: MotionIndicadores | null | undefined;
  dom: { pluralize: Pluralizar };
  apiFetch<T = unknown>(url: string, options?: ApiFetchOptions): Promise<T>;
}

const elemento = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const ehErroApi = (erro: unknown): erro is ApiFetchError => erro instanceof Error
  && "status" in erro && typeof erro.status === "number";
const PRONTIDAO_ESTADOS: Record<EstadoItemProntidao, string> = { ok: "Em dia", pendente: "Pendente", invalido: "Inválido" };
// Chamados que saíram do Dashboard ou do SoftExpert sem finalização pelo site: o texto é fixo, o card some com total 0 ou leitura indisponível.
const TEXTO_OUTRO_TECNICO = "Confira no SoftExpert e marque Conferido na aba OS (F6).";
const MAX_SEM_ACESSO_60_LISTADOS = 5;
const ALERTAS_DO_SINO = ["alerta-sem-acesso-60", "alerta-os-paradas", "alerta-divergencias-novas", "alerta-chamados-outro-tecnico", "alerta-finalizacao-softexpert", "alerta-backups-regionais"];

export function criarIndicadoresHome(context: ContextoIndicadoresHome) {
  "use strict";
  const { app, transferUtils, motion } = context;
  const { pluralize } = context.dom;

  const readinessRequestGate = transferUtils.createRequestGate();
  const statsRequestGate = transferUtils.createRequestGate();
  let ultimoRelatorioProntidao: { report: RelatorioProntidao; writeBlock: { available?: boolean } | null } | null = null;
  let totalRegionais: number | null = null;

  function formatarContagemEstatistica(value: unknown): string {
    const count = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return "Indisponível";
    return count.toLocaleString("pt-BR");
  }

  function definirEstatistica(elementId: string, value: unknown): void {
    const element = elemento(elementId);
    if (element) element.textContent = formatarContagemEstatistica(value);
  }

  // Green dot only while the base holds equipment; amber when it is empty or unreadable.
  function definirEstadoBase(total: unknown): void {
    const dot = elemento("stat-base-dot");
    if (dot) dot.dataset.state = Number(total) > 0 ? "ready" : "empty";
  }

  // Load statistics from API
  async function carregarEstatisticas(): Promise<void> {
    const request = statsRequestGate.begin();
    try {
      const stats = await context.apiFetch<Estatisticas>("/api/stats", {
        signal: request.signal,
        errorMessage: "Falha ao consultar as estatísticas locais.",
      });
      if (!statsRequestGate.isCurrent(request.id)) return;
      definirEstatistica("stat-equipamentos", stats.total_equipamentos);
      definirEstadoBase(stats.total_equipamentos);
      const rotuloEquipamentos = elemento("stat-equipamentos-rotulo");
      if (rotuloEquipamentos) rotuloEquipamentos.textContent = pluralize(stats.total_equipamentos as number, "equipamento");
      definirEstatistica("stat-unidades", stats.total_unidades);
      totalRegionais = Number.isSafeInteger(stats.total_unidades) && (stats.total_unidades as number) >= 0 ? stats.total_unidades as number : null;
      renderizarItensProntidao();
      const exportButton = elemento("btn-exportar-equipamentos");
      if (exportButton) {
        const exportAvailable = stats.exportacao_disponivel === true;
        const exportCount = Number(stats.total_alteracoes_exportaveis);
        exportButton.classList.toggle(
          "hidden",
          exportAvailable && Number.isSafeInteger(exportCount) && exportCount === 0
        );
        exportButton.title = exportAvailable
          ? "Baixar a planilha com apelidos e IdCliente atualizados"
          : `Contagem indisponível: ${stats.exportacao_motivo || "clique para verificar a exportação"}`;
      }
    } catch (err) {
      // 409: an import holds the files; keep the last numbers until the next poll.
      if (ehErroApi(err) && err.status === 409) return;
      if (!statsRequestGate.isCurrent(request.id)) return;
      console.warn("Não foi possível carregar estatísticas:", err);
      definirEstatistica("stat-equipamentos", null);
      definirEstadoBase(null);
      definirEstatistica("stat-unidades", null);
    }
  }

  async function carregarProntidao(): Promise<void> {
    const panel = elemento<HTMLDetailsElement>("readiness-panel");
    const summary = elemento("readiness-summary");
    const details = elemento("readiness-details-content");
    if (!panel || !summary || !details) return;

    const request = readinessRequestGate.begin();
    panel.setAttribute("aria-busy", "true");
    try {
      const report = await context.apiFetch<RelatorioProntidao | null>("/api/prontidao", {
        cache: "no-store",
        signal: request.signal,
        errorMessage: "Falha ao consultar a disponibilidade local.",
      });
      if (!readinessRequestGate.isCurrent(request.id)) return;
      if (!report?.functions || !report?.files) throw new Error("Resposta de disponibilidade inválida.");

      const counts = contarArquivosProntidao(report);
      const writeBlock = report.gravacao_bloqueada?.available === false ? report.gravacao_bloqueada : null;
      panel.dataset.state = counts.allAvailable && !writeBlock ? "ready" : "warning";
      if (!panel.dataset.initialized) {
        // Start with a compact summary on every screen; keep later user toggles across refreshes.
        panel.open = false;
        panel.dataset.initialized = "true";
      }
      summary.textContent = resumoProntidao(counts, writeBlock);
      definirResumoCurto(resumoCurtoProntidao(counts, writeBlock));

      ultimoRelatorioProntidao = { report, writeBlock };
      renderizarItensProntidao();
    } catch (error) {
      if (!readinessRequestGate.isCurrent(request.id)) return;
      panel.dataset.state = "error";
      summary.textContent = "Não foi possível consultar a disponibilidade das funções.";
      definirResumoCurto("Indisponível");
      ultimoRelatorioProntidao = null;
      const aviso = document.createElement("li");
      aviso.className = "ck-pront__vazio";
      aviso.textContent = "Confira se o servidor está em execução e recarregue a página para tentar novamente.";
      details.replaceChildren(aviso);
    } finally {
      if (readinessRequestGate.isCurrent(request.id)) panel.setAttribute("aria-busy", "false");
    }
  }

  // With local files, only the files the application reads count towards "all available".
  function contarArquivosProntidao(report: RelatorioProntidao): ContagemProntidao {
    const readinessFileKeys = [
      "inventario_equipamentos",
      "inventario_detalhes_atualizacao",
      "inventario_endpoint",
      "modelo_exportacao",
      "historico_chamados",
    ];
    // Entra is an optional section inside Inventários, never a pending source.
    const readinessFiles = readinessFileKeys.map(key => report.files[key]).filter(Boolean) as StatusProntidao[];
    const availableCount = readinessFiles.filter(status => status.available === true).length;
    const totalCount = readinessFileKeys.length;
    return { availableCount, totalCount, allAvailable: totalCount > 0 && availableCount === totalCount };
  }

  // Compact summary shown while the panel is closed; the full sentence stays the live status.
  function definirResumoCurto(text: string): void {
    const shortSummary = elemento("readiness-summary-short");
    if (shortSummary) shortSummary.textContent = text;
    // O texto fica só para leitores de tela (.ck-sr); quem usa mouse vê pelo title do gatilho.
    if (shortSummary && shortSummary.parentElement) shortSummary.parentElement.title = text;
    const popoverTitle = elemento("readiness-popover-titulo");
    if (popoverTitle) popoverTitle.textContent = text;
  }

  function resumoCurtoProntidao({ availableCount, totalCount, allAvailable }: ContagemProntidao, writeBlock: unknown): string {
    if (writeBlock) return "Modo leitura";
    if (allAvailable) return "Tudo disponível";
    if (totalCount === 0) return "Verificação indisponível";
    const pending = totalCount - availableCount;
    // Fits beside the title at 360px; the full sentence names the files.
    return pending === 1 ? "1 pendente" : `${pending} pendentes`;
  }

  function resumoProntidao({ availableCount, totalCount, allAvailable }: ContagemProntidao, writeBlock: unknown): string {
    return writeBlock
      ? "Modo leitura: uma gravação interrompida precisa de conferência. Confira os detalhes abaixo."
      : allAvailable
      ? totalCount === 1 ? "O arquivo está disponível." : `Todos os ${totalCount} arquivos estão disponíveis.`
      : totalCount === 0
        ? "Não foi possível identificar os arquivos para verificar a disponibilidade."
        : availableCount === 0
          ? `Nenhum dos ${totalCount} arquivos está disponível. Confira os detalhes abaixo.`
          : `${availableCount} de ${totalCount} arquivos disponíveis. Confira os detalhes abaixo.`;
  }

  function estadoProntidao(status: StatusProntidao | undefined): EstadoItemProntidao {
    if (status?.available === true) return "ok";
    return status?.state === "invalid" ? "invalido" : "pendente";
  }

  function criarIconeProntidao(icone: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ck-ico ck-ico--sm");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${icone}`);
    svg.appendChild(use);
    return svg;
  }

  // Why a source is not available: server reason, else the missing files (text only, never HTML).
  function detalheProntidao(status: StatusProntidao | undefined): string {
    if (!status) return "";
    const faltando = Array.isArray(status.missing_files) ? status.missing_files.join(", ") : "";
    return status.reason || faltando;
  }

  function adicionarItemProntidao(list: DocumentFragment, { id, pendencia, icone, titulo, descricao, detalhe, secundario, estado, acao }: ItemProntidao): void {
    const item = document.createElement("li");
    item.className = "ck-pront__item";
    item.dataset.status = estado;
    if (id) item.id = id;
    if (pendencia) item.dataset.pendencia = pendencia;

    const ico = document.createElement("span");
    ico.className = "ck-pront__ico";
    ico.appendChild(criarIconeProntidao(icone));

    const textos = document.createElement("span");
    textos.className = "ck-pront__textos";
    const nome = document.createElement("span");
    nome.className = "ck-pront__titulo";
    nome.textContent = titulo;
    const meta = document.createElement("span");
    meta.className = "ck-pront__meta";
    meta.title = detalhe ? `${descricao} — ${detalhe}` : descricao;
    const rotuloEstado = document.createElement("span");
    rotuloEstado.className = "ck-pront__estado";
    rotuloEstado.textContent = PRONTIDAO_ESTADOS[estado];
    meta.append(rotuloEstado, ` · ${estado === "invalido" && detalhe ? detalhe : descricao}`);
    textos.append(nome, meta);
    if (secundario) {
      const complemento = document.createElement("span");
      complemento.className = "ck-pront__secundario";
      complemento.textContent = secundario;
      textos.appendChild(complemento);
    }
    item.append(ico, textos);

    if (acao) {
      const button = document.createElement("button");
      button.type = "button";
      if (acao.id) button.id = acao.id;
      // Em dia: ação discreta (Atualizar/Abrir/Editar); pendente: ação em destaque.
      const rotulo = estado === "ok" && acao.labelOk ? acao.labelOk : acao.label;
      button.className = `ck-btn ${estado === "ok" ? "ck-btn--fantasma" : "ck-btn--secundario"} ck-btn--sm ck-pront__acao`;
      button.append(criarIconeProntidao(acao.icone || "i-upload"), rotulo);
      button.setAttribute("aria-label", acao.ariaLabel || `${rotulo} — ${titulo}`);
      button.addEventListener("click", acao.onClick);
      item.appendChild(button);
    }
    list.appendChild(item);
  }

  // Simpress and Endpoint are imported together, so they are reported as one shared item.
  function statusInventarios(report: RelatorioProntidao): StatusProntidao {
    const inventoryFileKeys = ["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint"];
    const missing = inventoryFileKeys.filter(key => report.files[key]?.available !== true);
    const invalid = missing.some(key => report.files[key]?.state === "invalid");
    return { available: missing.length === 0, state: invalid ? "invalid" : "awaiting_import" };
  }

  function statusChamados(report: RelatorioProntidao): StatusProntidao {
    const fileStatus = report.files.historico_chamados || {};
    const functionStatus = report.functions.acompanhamento_chamados || {};
    const status: StatusProntidao = { ...fileStatus, ...functionStatus };
    status.state ||= fileStatus.state || "awaiting_import";
    return status;
  }

  // Barra "X de N fontes em dia", derivada dos itens [data-pendencia] já renderizados.
  function atualizarProgressoProntidao(details: HTMLElement): void {
    const itens = [...details.querySelectorAll<HTMLElement>("[data-pendencia]")];
    const prontos = itens.filter(item => item.dataset.status === "ok").length;
    const cheio = elemento("ckp-progresso-cheio");
    const texto = elemento("ckp-progresso-texto");
    if (cheio) cheio.style.width = itens.length ? `${(prontos / itens.length) * 100}%` : "0%";
    if (texto) texto.textContent = `${prontos} de ${itens.length}`;
  }

  function renderizarItensProntidao(): void {
    const details = elemento("readiness-details-content");
    if (!details || !ultimoRelatorioProntidao) return;
    const { report, writeBlock } = ultimoRelatorioProntidao;
    const list = document.createDocumentFragment();

    if (writeBlock) {
      adicionarItemProntidao(list, {
        id: "readiness-gravacao-bloqueada",
        icone: "i-alerta",
        titulo: "Gravações bloqueadas",
        descricao: "Importações e edições aguardam a conferência; a consulta continua disponível.",
        estado: "invalido",
      });
    }
    adicionarItemProntidao(list, {
      id: "readiness-inventario",
      pendencia: "inventario",
      icone: "i-sheet",
      titulo: "Inventários",
      descricao: "Planilha de equipamentos da Simpress",
      detalhe: detalheProntidao(report.files.inventario_equipamentos),
      estado: estadoProntidao(statusInventarios(report)),
      acao: { label: "Importar", labelOk: "Atualizar", ariaLabel: "Importar/atualizar inventários Simpress e Endpoint", onClick: app.abrirModalAtualizarPlanilhas },
    });
    adicionarItemProntidao(list, {
      id: "readiness-chamados",
      pendencia: "chamados",
      icone: "i-clock",
      titulo: "OS",
      descricao: "Exportação de OS Oracle",
      detalhe: detalheProntidao(statusChamados(report)),
      estado: estadoProntidao(statusChamados(report)),
      acao: {
        label: "Importar",
        labelOk: "Abrir",
        ariaLabel: "Importar planilhas na aba OS",
        onClick: async () => {
          await app.abrirPainelCockpit("chamados");
          app.abrirGestaoChamadosCockpit?.();
        },
      },
    });
    adicionarItemProntidao(list, {
      id: "readiness-modelo-exportacao",
      pendencia: "modelo",
      icone: "i-download",
      titulo: "Modelo de exportação",
      descricao: "Planilha-modelo usada nas exportações",
      detalhe: detalheProntidao(report.files.modelo_exportacao),
      estado: estadoProntidao(report.files.modelo_exportacao),
      acao: { label: "Importar", labelOk: "Atualizar", ariaLabel: "Importar modelo de exportação", onClick: () => app.abrirImportacaoModelo("exportacao") },
    });
    // Regionais are not part of the "N pendentes" count; the row only appears once the count is known.
    if (totalRegionais !== null) {
      adicionarItemProntidao(list, {
        id: "readiness-regionais-item",
        pendencia: "regionais",
        icone: "i-pin",
        titulo: "Regionais",
        descricao: totalRegionais > 0
          ? `${totalRegionais} ${pluralize(totalRegionais, "regional cadastrada", "regionais cadastradas")}`
          : "Nenhuma regional cadastrada",
        estado: totalRegionais > 0 ? "ok" : "pendente",
        acao: { label: "Cadastrar", labelOk: "Editar", icone: "i-arrow-right", ariaLabel: "Cadastrar regionais", onClick: app.abrirModalGerenciarUnidades },
      });
    }
    // Older servers do not send the key; the card only appears when the report carries it.
    if (report.configuracao_local && typeof report.configuracao_local === "object") {
      const config = report.configuracao_local;
      const estadoConfig = estadoProntidao({ available: config.state === "ready", state: config.state });
      adicionarItemProntidao(list, {
        id: "readiness-configuracao-local",
        pendencia: "configuracao",
        icone: "i-pencil",
        titulo: "Configuração local",
        descricao: estadoConfig === "ok"
          ? "Contas, links e dados do cliente configurados"
          : config.reason || "Contas, links e dados do cliente",
        detalhe: estadoConfig === "invalido" ? config.reason || "" : "",
        secundario: config.assistente_ia === false ? "Assistente sem IA" : "",
        estado: estadoConfig,
        acao: { id: "btn-configuracao-local", label: "Configurar", icone: "i-arrow-right", ariaLabel: "Configurar contas, links e dados do cliente", onClick: () => app.abrirConfiguracaoLocal() },
      });
    }
    details.replaceChildren(list);
    atualizarProgressoProntidao(details);
    // Later refreshes after saves update in place; only the first render cascades in.
    if (!details.dataset.revealed) {
      details.dataset.revealed = "true";
      motion?.stagger(details.children);
    }
  }

  function marcarServidorOffline(): void {
    const panel = elemento("readiness-panel");
    const summary = elemento("readiness-summary");
    const dot = elemento("stat-base-dot");
    if (!panel) return;
    panel.dataset.state = "error";
    if (dot) dot.dataset.state = "empty";
    if (summary) summary.textContent = "Servidor desconectado. Abra iniciar_servidor.bat para continuar.";
    definirResumoCurto("Offline");
    const trigger = panel.querySelector("summary");
    if (trigger) trigger.title = "Servidor desconectado. Verifique se iniciar_servidor.bat está em execução.";
  }

  function inicializarProntidao(): void {
    elemento("readiness-fechar")?.addEventListener("click", () => {
      const panel = elemento<HTMLDetailsElement>("readiness-panel");
      if (!panel) return;
      panel.open = false;
      panel.querySelector("summary")?.focus();
    });

    if (typeof window !== "undefined") {
      window.addEventListener("focus", () => {
        carregarProntidao();
      });
      window.addEventListener("simpress:servidor-offline", () => {
        marcarServidorOffline();
      });
      if (typeof window.setInterval === "function") {
        window.setInterval(() => {
          if (!document.hidden) carregarProntidao();
        }, 45000);
      }
    }
  }

  // ---------- Alerta de base desatualizada (docs/operacao/alerta-base-desatualizada.md) ----------
  function formatarDataHora(iso: unknown): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
    return match ? `${match[3]}/${match[2]}/${match[1]} às ${match[4]}:${match[5]}` : "";
  }

  function textoBaseDesatualizada(info: DadosAlerta): string {
    const limit = Number(info.limite_dias);
    const days = Number(info.dias_sem_atualizacao);
    const when = formatarDataHora(info.ultima_atualizacao);
    // Below one more full day than the limit, the floor count would read as "7 dias" for a base past the limit.
    const dias = (count: number) => `${count} ${pluralize(count, "dia")}`;
    const age = days > limit ? `há ${dias(days)}` : `há mais de ${dias(limit)}`;
    const since = when ? `em ${when}, ${age}` : age;
    return `A base na Simpress foi atualizada pela última vez ${since}. O limite é de ${dias(limit)}.`;
  }

  function renderizarAlertaBaseDesatualizada(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-base-desatualizada");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "desatualizada" && state !== "sem_base") {
      card.hidden = true;
      card.dataset.state = state || "hidden";
      return;
    }
    const dados = info as DadosAlerta;
    const missing = state === "sem_base";
    const title = elemento("alerta-base-desatualizada-titulo");
    const text = elemento("alerta-base-desatualizada-texto");
    const button = elemento("btn-alerta-base-atualizar");
    if (title) title.textContent = missing ? "Base não encontrada" : "Base desatualizada";
    if (text) {
      text.textContent = missing
        ? "Nenhuma base na Simpress foi importada. Importe as planilhas para consultar e comparar equipamentos."
        : textoBaseDesatualizada(dados);
    }
    if (button) button.textContent = missing ? "Importar base" : "Atualizar base";
    card.dataset.state = state;
    if (card.hidden) {
      card.hidden = false;
      card.dataset.enter = "true";
    }
  }

  // lerUltimoPainel: the bridge's copy of a painel-atualizado fired before this panel mounted (dashboard.js).
  function inicializarAlertaBaseDesatualizada(lerUltimoPainel?: () => DadosPainelHome | undefined): void {
    document.addEventListener("simpress:painel-atualizado", evento => renderizarAlertaBaseDesatualizada((evento as CustomEvent<DadosPainelHome | undefined>).detail?.base_desatualizada));
    const anterior = lerUltimoPainel?.();
    if (anterior) renderizarAlertaBaseDesatualizada(anterior.base_desatualizada);
    elemento("alerta-base-desatualizada")?.addEventListener("animationend", evento => {
      delete (evento.currentTarget as HTMLElement).dataset.enter;
    });
  }

  // ---------- Alertas de OS paradas e divergências novas (docs/operacao/alertas-os-divergencias.md) ----------
  function mostrarAlertaPainel(card: HTMLElement, state: string, message: string): void {
    const text = card.querySelector(".ck-aviso__texto, .stale-base-alert-text");
    if (text) text.textContent = message;
    card.dataset.state = state;
    if (card.hidden) {
      card.hidden = false;
      card.dataset.enter = "true";
    }
  }

  function ocultarAlertaPainel(card: HTMLElement, state: string | null | undefined): void {
    card.hidden = true;
    card.dataset.state = state || "hidden";
  }

  function textoOsParadas(info: DadosAlerta): string {
    const total = Number(info.total);
    const limit = Number(info.limite_dias);
    const oldest = Number(info.maior_dias_sem_atualizacao);
    const subject = total === 1 ? "1 chamado aberto está" : `${total} chamados abertos estão`;
    const age = Number.isFinite(oldest) && oldest > 0
      ? ` O mais antigo está parado há ${oldest} ${pluralize(oldest, "dia")}.`
      : "";
    return `${subject} sem atualização há ${limit} ${pluralize(limit, "dia")} ou mais.${age}`;
  }

  function renderizarAlertaOsParadas(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-os-paradas");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "paradas" || !(Number((info as DadosAlerta).total) > 0)) {
      ocultarAlertaPainel(card, state);
      return;
    }
    mostrarAlertaPainel(card, state, textoOsParadas(info as DadosAlerta));
  }

  function juntarLista(items: string[]): string {
    return items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}` : items.join("");
  }

  function textoDivergenciasNovas(info: DadosAlerta): string {
    const total = Number(info.total);
    const current = formatarDataHora(info.atual?.horario);
    const previous = formatarDataHora(info.anterior?.horario);
    const sections = (Array.isArray(info.por_secao) ? info.por_secao as Array<{ total?: unknown; secao?: string } | null> : [])
      .filter(item => Number(item?.total) > 0)
      .map(item => `${Number(item?.total)} em ${item?.secao}`);
    const rows = total === 1
      ? "1 linha de divergência que não estava"
      : `${total} linhas de divergência que não estavam`;
    const detail = sections.length ? `: ${juntarLista(sections)}` : "";
    const comparison = current ? `de ${current}` : "mais recente";
    const before = previous ? `de ${previous}` : "anterior";
    return `A comparação ${comparison} trouxe ${rows} na ${before}${detail}.`;
  }

  function renderizarAlertaDivergenciasNovas(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-divergencias-novas");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "novas" || !(Number((info as DadosAlerta).total) > 0)) {
      ocultarAlertaPainel(card, state);
      return;
    }
    mostrarAlertaPainel(card, state, textoDivergenciasNovas(info as DadosAlerta));
  }

  function renderizarAlertaChamadosOutroTecnico(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-chamados-outro-tecnico");
    if (!card) return;
    if (!info || typeof info !== "object" || info.indisponivel || !(Number(info.total) > 0)) {
      ocultarAlertaPainel(card, info?.indisponivel ? "indisponivel" : "vazio");
      return;
    }
    mostrarAlertaPainel(card, "outro_tecnico", TEXTO_OUTRO_TECNICO);
  }

  // Falhas da última finalização no SoftExpert (/api/painel): só número UTIC e código fixo, nunca a mensagem da rotina.
  const MOTIVOS_FALHA_FINALIZACAO: Record<string, string> = { tempo_esgotado: "tempo esgotado", sessao_expirada: "sessão expirada" };

  function textoFalhasFinalizacao(itens: FalhaFinalizacao[]): string {
    const erros = itens.filter(item => !["interrompida", "sharepoint", "planilha", "incerto", "registro_local"].includes(String(item.motivo)));
    const semRegistro = itens.filter(item => item.motivo === "registro_local" && item.numero).map(item => String(item.numero));
    const semR = itens.filter(item => item.motivo === "planilha");
    const incertos = itens.filter(item => item.motivo === "incerto");
    const partes: string[] = [];
    if (erros.length) {
      const numeros = erros.filter(item => item.numero).map(item => {
        const motivo = MOTIVOS_FALHA_FINALIZACAO[String(item.motivo)];
        return motivo ? `${String(item.numero)} (${motivo})` : String(item.numero);
      });
      const sujeito = erros.length === 1 ? "1 chamado não foi finalizado" : `${erros.length} chamados não foram finalizados`;
      partes.push(`${sujeito} no SoftExpert${numeros.length ? `: ${numeros.join(", ")}` : ""}.`);
    }
    if (incertos.length) {
      // Finalizar foi clicado e não se sabe se terminou: nunca "não foi finalizado"
      const numeros = incertos.filter(item => item.numero).map(item => String(item.numero));
      partes.push(`${numeros.length ? `${numeros.join(", ")}: o` : "O"} Finalizar foi clicado, mas o resultado não foi confirmado.`);
    }
    if (semRegistro.length) partes.push(`${semRegistro.join(", ")}: finalizado no SoftExpert, mas o registro local falhou.`);
    if (semR.length) {
      // o chamado foi finalizado, mas a coluna R não: só o número UTIC, nunca a mensagem da rotina
      const numeros = semR.filter(item => item.numero).map(item => String(item.numero));
      partes.push(`${numeros.length ? `${numeros.join(", ")}: a` : "A"} DT ENCERRAMENTO não foi gravada no Dashboard.`);
    }
    if (itens.some(item => item.motivo === "interrompida")) partes.push("A finalização parou no meio (tempo esgotado ou rotina encerrada).");
    if (itens.some(item => item.motivo === "sharepoint")) partes.push("O envio do Dashboard ao SharePoint falhou ou ficou incerto.");
    // o erro pode ter vindo depois do clique irreversível em Finalizar: nunca mande só "tentar de novo"
    partes.push("Confira no SoftExpert se o chamado já foi finalizado antes de tentar de novo.");
    return partes.join(" ");
  }

  function renderizarAlertaFalhasFinalizacao(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-finalizacao-softexpert");
    if (!card) return;
    const itens = info && typeof info === "object" && !info.indisponivel && Array.isArray(info.itens)
      ? (info.itens as unknown[]).filter((item): item is FalhaFinalizacao => Boolean(item) && typeof item === "object")
      : [];
    if (!(Number(info?.total) > 0) || !itens.length) {
      ocultarAlertaPainel(card, info?.indisponivel ? "indisponivel" : "vazio");
      return;
    }
    mostrarAlertaPainel(card, "falhou", textoFalhasFinalizacao(itens));
  }

  function textoSemAcesso60(info: DadosAlerta): string {
    const limit = Number(info.limite_dias);
    const warning = Number(info.limite_aviso_dias);
    const passed = Number(info.total_passou) || 0;
    const nearLimit = Number(info.total_limite) || 0;
    const left = Number(info.total_saiu_endpoint) || 0;
    const parts: string[] = [];
    if (passed > 0) {
      const subject = passed === 1 ? "1 notebook/MacBook passou" : `${passed} notebooks/MacBooks passaram`;
      const leftNote = left > 0
        ? ` ${left === 1 ? "1 já saiu" : `${left} já saíram`} da lista e ${left === 1 ? "foi" : "foram"} para Ausentes no Endpoint.`
        : "";
      parts.push(`${subject} de ${limit} ${pluralize(limit, "dia")} sem acesso.${leftNote}`);
    }
    if (nearLimit > 0) {
      const subject = nearLimit === 1 ? "1 notebook/MacBook está" : `${nearLimit} notebooks/MacBooks estão`;
      parts.push(`${subject} no limite, com mais de ${warning} ${pluralize(warning, "dia")} sem acesso.`);
    }
    return parts.join(" ");
  }

  function linhaSemAcesso60(item: ItemSemAcesso): string {
    const name = [item.serie, item.computador].filter(Boolean).join(" · ") || "Sem identificação";
    const days = Number(item.dias);
    const age = Number.isFinite(days) ? `${item.situacao === "saiu_endpoint" ? "~" : ""}${days} ${pluralize(days, "dia")}` : "";
    const note = item.situacao === "saiu_endpoint" ? " (saiu para Ausentes no Endpoint)" : "";
    return `${name}${age ? ` — ${age}` : ""}${note}`;
  }

  function renderizarListaSemAcesso60(info: DadosAlerta): void {
    const list = elemento("alerta-sem-acesso-60-lista");
    if (!list) return;
    const items = (Array.isArray(info.equipamentos) ? info.equipamentos as unknown[] : [])
      .filter((item): item is ItemSemAcesso => Boolean(item) && typeof item === "object");
    const lines = items.slice(0, MAX_SEM_ACESSO_60_LISTADOS).map(linhaSemAcesso60);
    if (items.length > lines.length) lines.push(`e mais ${items.length - lines.length}`);
    list.replaceChildren(...lines.map(line => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }));
    list.hidden = lines.length === 0;
  }

  function renderizarAlertaSemAcesso60(info: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-sem-acesso-60");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "passou_60" && state !== "limite_55") {
      ocultarAlertaPainel(card, state);
      return;
    }
    const dados = info as DadosAlerta;
    const passed = state === "passou_60";
    card.dataset.gravidade = passed ? "urgente" : "atencao";
    const badge = elemento("alerta-sem-acesso-60-selo");
    if (badge) {
      badge.dataset.status = passed ? "erro" : "alerta";
      badge.textContent = passed ? "Urgente" : "Atenção";
    }
    const title = elemento("alerta-sem-acesso-60-titulo");
    if (title) title.textContent = passed ? "Passou de 60 dias sem acesso" : "Perto de 60 dias sem acesso";
    mostrarAlertaPainel(card, state, textoSemAcesso60(dados));
    renderizarListaSemAcesso60(dados);
  }

  // Backups regionais (/api/painel): só dado já calculado pelo servidor. A lista traz cidade e situação, nunca apelido nem série.
  const nomesRegionais = (valor: unknown): string[] => (Array.isArray(valor) ? valor.map(item => String(item ?? "").trim()).filter(Boolean) : []);

  function renderizarAlertaBackupsRegionais(dados: DadosAlerta | null | undefined): void {
    const card = elemento("alerta-backups-regionais");
    if (!card) return;
    const semBackup = dados && typeof dados === "object" && !dados.indisponivel ? nomesRegionais(dados.pendencias?.sem_backup) : [];
    const conferir = dados && typeof dados === "object" && !dados.indisponivel ? nomesRegionais(dados.pendencias?.conferir) : [];
    if (!semBackup.length && !conferir.length) {
      ocultarAlertaPainel(card, dados?.indisponivel ? "indisponivel" : "vazio");
      return;
    }
    const urgente = semBackup.length > 0;
    card.dataset.gravidade = urgente ? "urgente" : "atencao";
    const selo = elemento("alerta-backups-regionais-selo");
    if (selo) {
      selo.dataset.status = urgente ? "erro" : "alerta";
      selo.textContent = urgente ? "Urgente" : "Atenção";
    }
    const titulo = elemento("alerta-backups-regionais-titulo");
    if (titulo) titulo.textContent = urgente ? "Sem backup disponível" : "Conferir possível backup";
    const partes: string[] = [];
    if (semBackup.length) partes.push(`${semBackup.length} ${semBackup.length === 1 ? "regional está" : "regionais estão"} sem backup disponível.`);
    if (conferir.length) partes.push(`${conferir.length} ${conferir.length === 1 ? "regional tem" : "regionais têm"} possível backup para conferir.`);
    mostrarAlertaPainel(card, urgente ? "sem_backup" : "conferir", partes.join(" "));
    const lista = elemento("alerta-backups-regionais-lista");
    if (!lista) return;
    const linhas = [...semBackup.map(cidade => `${cidade} — sem backup disponível`), ...conferir.map(cidade => `${cidade} — conferir possível backup`)];
    lista.replaceChildren(...linhas.map(linha => {
      const li = document.createElement("li");
      li.textContent = linha;
      return li;
    }));
    lista.hidden = false;
  }

  function inicializarAlertasOsDivergencias(lerUltimoPainel?: () => DadosPainelHome | undefined): void {
    const renderizar = (detalhe: DadosPainelHome | undefined) => {
      renderizarAlertaSemAcesso60(detalhe?.sem_acesso_60_dias);
      renderizarAlertaOsParadas(detalhe?.os_paradas);
      renderizarAlertaDivergenciasNovas(detalhe?.divergencias_novas);
      renderizarAlertaChamadosOutroTecnico(detalhe?.chamados_outro_tecnico);
      renderizarAlertaFalhasFinalizacao(detalhe?.falhas_finalizacao_softexpert);
      renderizarAlertaBackupsRegionais(detalhe?.backups_regionais);
    };
    document.addEventListener("simpress:painel-atualizado", evento => renderizar((evento as CustomEvent<DadosPainelHome | undefined>).detail));
    const anterior = lerUltimoPainel?.();
    if (anterior) renderizar(anterior);
    ALERTAS_DO_SINO.forEach(id => {
      elemento(id)?.addEventListener("animationend", evento => {
        delete (evento.currentTarget as HTMLElement).dataset.enter;
      });
    });
  }

  function atualizarIndicadoresPosSalvamento(): void {
    // Atualiza os indicadores sem atrasar o fechamento do formulário após salvar.
    void Promise.allSettled([app.carregarEstatisticas()]);
  }

  return {
    carregarEstatisticas, carregarProntidao, inicializarProntidao, atualizarIndicadoresPosSalvamento,
    inicializarAlertaBaseDesatualizada, renderizarAlertaBaseDesatualizada,
    inicializarAlertasOsDivergencias, renderizarAlertaOsParadas, renderizarAlertaDivergenciasNovas,
    renderizarAlertaSemAcesso60, renderizarAlertaChamadosOutroTecnico, renderizarAlertaFalhasFinalizacao, renderizarAlertaBackupsRegionais,
  };
}
