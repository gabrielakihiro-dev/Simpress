/** Home indicators: inventory statistics and the readiness panel that lists which files and functions are available. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).dashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, function createDashboard(context) {
  "use strict";
  const { app, transferUtils, motion } = context;
  const { pluralize } = context.dom;

  const readinessRequestGate = transferUtils.createRequestGate();
  let ultimoRelatorioProntidao = null;
  let totalRegionais = null;

  const READINESS_FUNCTION_LABELS = {
    consulta_equipamentos: "Consulta de equipamentos",
    geracao_transferencia: "Geração de transferência",
    comparacao_atualizacao_inventarios: "Comparação e atualização de inventários",
    exportacao_equipamentos: "Exportação de equipamentos",
    acompanhamento_chamados: "Acompanhamento de Chamados",
  };
  const READINESS_FILE_LABELS = {
    template_transferencia: "Modelo de transferência",
    inventario_equipamentos: "Inventário ativo de equipamentos",
    inventario_detalhes_atualizacao: "Inventário EquipamentosDetalhes para atualização",
    inventario_endpoint: "Inventário Endpoint",
    modelo_exportacao: "Modelo de exportação",
    catalogos_locais: "Catálogos e históricos locais",
    historico_chamados: "Histórico do acompanhamento de chamados",
    nomes_entra: "Nomes do Microsoft Entra",
  };
  const INVENTORY_FILE_LABELS = {
    inventario_equipamentos: "Base ativa",
    inventario_detalhes_atualizacao: "Simpress",
    inventario_endpoint: "Endpoint",
  };

  function formatarContagemEstatistica(value) {
    const count = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return "Indisponível";
    return count.toLocaleString("pt-BR");
  }

  function definirEstatistica(elementId, value) {
    const element = document.getElementById(elementId);
    if (element) element.textContent = formatarContagemEstatistica(value);
  }

  // Green dot only while the base holds equipment; amber when it is empty or unreadable.
  function definirEstadoBase(total) {
    const dot = document.getElementById("stat-base-dot");
    if (dot) dot.dataset.state = Number(total) > 0 ? "ready" : "empty";
  }

  // Load statistics from API
  async function carregarEstatisticas() {
    try {
      const res = await fetch("/api/stats");
      // 409: an import holds the files; keep the last numbers until the next poll.
      if (res.status === 409) return;
      if (!res.ok) throw new Error("Falha ao consultar as estatísticas locais.");
      const stats = await res.json();
      definirEstatistica("stat-equipamentos", stats.total_equipamentos);
      definirEstadoBase(stats.total_equipamentos);
      const rotuloEquipamentos = document.getElementById("stat-equipamentos-rotulo");
      if (rotuloEquipamentos) rotuloEquipamentos.textContent = pluralize(stats.total_equipamentos, "equipamento");
      definirEstatistica("stat-unidades", stats.total_unidades);
      totalRegionais = Number.isSafeInteger(stats.total_unidades) && stats.total_unidades >= 0 ? stats.total_unidades : null;
      renderizarItensProntidao();
      const exportButton = document.getElementById("btn-exportar-equipamentos");
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
      console.warn("Não foi possível carregar estatísticas:", err);
      definirEstatistica("stat-equipamentos", null);
      definirEstadoBase(null);
      definirEstatistica("stat-unidades", null);
    }
  }

  async function carregarProntidao() {
    const panel = document.getElementById("readiness-panel");
    const summary = document.getElementById("readiness-summary");
    const details = document.getElementById("readiness-details-content");
    if (!panel || !summary || !details) return;

    const request = readinessRequestGate.begin();
    panel.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/prontidao", { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error("Falha ao consultar a disponibilidade local.");
      const report = await response.json();
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
  function contarArquivosProntidao(report) {
    const readinessFileKeys = [
      "inventario_equipamentos",
      "inventario_detalhes_atualizacao",
      "inventario_endpoint",
      "modelo_exportacao",
      "historico_chamados",
    ];
    // Older servers and mocked reports have no Entra entry; it only counts when reported.
    if (report.files.nomes_entra) readinessFileKeys.push("nomes_entra");
    const readinessFiles = readinessFileKeys.map(key => report.files[key]).filter(Boolean);
    const availableCount = readinessFiles.filter(status => status.available === true).length;
    const totalCount = readinessFileKeys.length;
    return { availableCount, totalCount, allAvailable: totalCount > 0 && availableCount === totalCount };
  }

  // Compact summary shown while the panel is closed; the full sentence stays the live status.
  function definirResumoCurto(text) {
    const shortSummary = document.getElementById("readiness-summary-short");
    if (shortSummary) shortSummary.textContent = text;
    const popoverTitle = document.getElementById("readiness-popover-titulo");
    if (popoverTitle) popoverTitle.textContent = text;
  }

  function resumoCurtoProntidao({ availableCount, totalCount, allAvailable }, writeBlock) {
    if (writeBlock) return "Modo leitura";
    if (allAvailable) return "Tudo disponível";
    if (totalCount === 0) return "Verificação indisponível";
    const pending = totalCount - availableCount;
    // Fits beside the title at 360px; the full sentence names the files.
    return pending === 1 ? "1 pendente" : `${pending} pendentes`;
  }

  function resumoProntidao({ availableCount, totalCount, allAvailable }, writeBlock) {
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

  const PRONTIDAO_ESTADOS = { ok: "Disponível", pendente: "Pendente", invalido: "Inválido" };

  function estadoProntidao(status) {
    if (status?.available === true) return "ok";
    return status?.state === "invalid" ? "invalido" : "pendente";
  }

  function criarIconeProntidao(icone) {
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
  function detalheProntidao(status) {
    if (!status) return "";
    const faltando = Array.isArray(status.missing_files) ? status.missing_files.join(", ") : "";
    return status.reason || faltando;
  }

  function adicionarItemProntidao(list, { id, icone, titulo, descricao, detalhe, estado, acao }) {
    const item = document.createElement("li");
    item.className = "ck-pront__item";
    item.dataset.status = estado;
    if (id) item.id = id;

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
    item.append(ico, textos);

    if (acao) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ck-btn ck-btn--secundario ck-btn--sm ck-pront__acao";
      button.append(criarIconeProntidao(acao.icone || "i-upload"), acao.label);
      button.setAttribute("aria-label", acao.ariaLabel || `${acao.label} — ${titulo}`);
      button.addEventListener("click", acao.onClick);
      item.appendChild(button);
    }
    list.appendChild(item);
  }

  // Simpress and Endpoint are imported together, so they are reported as one shared item.
  function statusInventarios(report) {
    const inventoryFileKeys = ["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint"];
    const missing = inventoryFileKeys.filter(key => report.files[key]?.available !== true);
    const invalid = missing.some(key => report.files[key]?.state === "invalid");
    return { available: missing.length === 0, state: invalid ? "invalid" : "awaiting_import" };
  }

  function statusChamados(report) {
    const fileStatus = report.files.historico_chamados || {};
    const functionStatus = report.functions.acompanhamento_chamados || {};
    const status = { ...fileStatus, ...functionStatus };
    status.state ||= fileStatus.state || "awaiting_import";
    return status;
  }

  function renderizarItensProntidao() {
    const details = document.getElementById("readiness-details-content");
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
      icone: "i-sheet",
      titulo: "Inventários",
      descricao: "Planilha de equipamentos da Simpress",
      detalhe: detalheProntidao(report.files.inventario_equipamentos),
      estado: estadoProntidao(statusInventarios(report)),
      acao: { label: "Importar", ariaLabel: "Importar/atualizar inventários Simpress e Endpoint", onClick: app.abrirModalAtualizarPlanilhas },
    });
    adicionarItemProntidao(list, {
      id: "readiness-chamados",
      icone: "i-clock",
      titulo: "Acompanhamento de chamados",
      descricao: "Exportação de chamados Oracle",
      detalhe: detalheProntidao(statusChamados(report)),
      estado: estadoProntidao(statusChamados(report)),
      acao: {
        label: "Importar",
        ariaLabel: "Importar planilhas para acompanhamento de chamados",
        onClick: () => {
          document.getElementById("painel-dados-acompanhamento-chamados").open = true;
          app.abrirAcompanhamentoChamados(true);
        },
      },
    });
    if (report.files.modelo_exportacao) {
      adicionarItemProntidao(list, {
        id: "readiness-modelo-exportacao",
        icone: "i-download",
        titulo: "Modelo de exportação",
        descricao: "Planilha-modelo usada nas exportações",
        detalhe: detalheProntidao(report.files.modelo_exportacao),
        estado: estadoProntidao(report.files.modelo_exportacao),
        acao: { label: "Importar", ariaLabel: "Importar modelo de exportação", onClick: () => app.abrirImportacaoModelo("exportacao") },
      });
    }
    if (report.files.nomes_entra) {
      adicionarItemProntidao(list, {
        id: "readiness-entra",
        icone: "i-users",
        titulo: "Microsoft Entra",
        descricao: "Usuários e logins do diretório",
        detalhe: detalheProntidao(report.files.nomes_entra),
        estado: estadoProntidao(report.files.nomes_entra),
        acao: { label: "Importar", ariaLabel: "Importar CSV com os nomes do Microsoft Entra", onClick: app.abrirModalAtualizarPlanilhas },
      });
    }
    // Regionais are not part of the "N pendentes" count; the row only appears once the count is known.
    if (totalRegionais !== null) {
      adicionarItemProntidao(list, {
        id: "readiness-regionais-item",
        icone: "i-pin",
        titulo: "Regionais",
        descricao: totalRegionais > 0
          ? `${totalRegionais} ${pluralize(totalRegionais, "regional cadastrada", "regionais cadastradas")}`
          : "Nenhuma regional cadastrada",
        estado: totalRegionais > 0 ? "ok" : "pendente",
        acao: { label: "Cadastrar", icone: "i-arrow-right", ariaLabel: "Cadastrar regionais", onClick: app.abrirModalGerenciarUnidades },
      });
    }
    details.replaceChildren(list);
    // Later refreshes after saves update in place; only the first render cascades in.
    if (!details.dataset.revealed) {
      details.dataset.revealed = "true";
      motion?.stagger(details.children);
    }
  }

  function inicializarProntidao() {
    document.getElementById("readiness-fechar")?.addEventListener("click", () => {
      const panel = document.getElementById("readiness-panel");
      if (!panel) return;
      panel.open = false;
      panel.querySelector("summary")?.focus();
    });
  }

  // ---------- Alerta de base desatualizada (docs/operacao/alerta-base-desatualizada.md) ----------
  function formatarDataHora(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
    return match ? `${match[3]}/${match[2]}/${match[1]} às ${match[4]}:${match[5]}` : "";
  }

  function textoBaseDesatualizada(info) {
    const limit = Number(info.limite_dias);
    const days = Number(info.dias_sem_atualizacao);
    const when = formatarDataHora(info.ultima_atualizacao);
    // Below one more full day than the limit, the floor count would read as "7 dias" for a base past the limit.
    const dias = count => `${count} ${pluralize(count, "dia")}`;
    const age = days > limit ? `há ${dias(days)}` : `há mais de ${dias(limit)}`;
    const since = when ? `em ${when}, ${age}` : age;
    return `A base na Simpress foi atualizada pela última vez ${since}. O limite é de ${dias(limit)}.`;
  }

  function renderizarAlertaBaseDesatualizada(info) {
    const card = document.getElementById("alerta-base-desatualizada");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "desatualizada" && state !== "sem_base") {
      card.hidden = true;
      card.dataset.state = state || "hidden";
      return;
    }
    const missing = state === "sem_base";
    const title = document.getElementById("alerta-base-desatualizada-titulo");
    const text = document.getElementById("alerta-base-desatualizada-texto");
    const button = document.getElementById("btn-alerta-base-atualizar");
    if (title) title.textContent = missing ? "Base não encontrada" : "Base desatualizada";
    if (text) {
      text.textContent = missing
        ? "Nenhuma base na Simpress foi importada. Importe as planilhas para consultar e comparar equipamentos."
        : textoBaseDesatualizada(info);
    }
    if (button) button.textContent = missing ? "Importar base" : "Atualizar base";
    card.dataset.state = state;
    if (card.hidden) {
      card.hidden = false;
      card.dataset.enter = "true";
    }
  }

  function inicializarAlertaBaseDesatualizada() {
    document.addEventListener("simpress:painel-atualizado", event => renderizarAlertaBaseDesatualizada(event.detail?.base_desatualizada));
    document.getElementById("alerta-base-desatualizada")?.addEventListener("animationend", event => {
      delete event.currentTarget.dataset.enter;
    });
  }

  // ---------- Alertas de OS paradas e divergências novas (docs/operacao/alertas-os-divergencias.md) ----------
  function mostrarAlertaPainel(card, state, message) {
    const text = card.querySelector(".ck-aviso__texto, .stale-base-alert-text");
    if (text) text.textContent = message;
    card.dataset.state = state;
    if (card.hidden) {
      card.hidden = false;
      card.dataset.enter = "true";
    }
  }

  function ocultarAlertaPainel(card, state) {
    card.hidden = true;
    card.dataset.state = state || "hidden";
  }

  function textoOsParadas(info) {
    const total = Number(info.total);
    const limit = Number(info.limite_dias);
    const oldest = Number(info.maior_dias_sem_atualizacao);
    const subject = total === 1 ? "1 chamado aberto está" : `${total} chamados abertos estão`;
    const age = Number.isFinite(oldest) && oldest > 0
      ? ` O mais antigo está parado há ${oldest} ${pluralize(oldest, "dia")}.`
      : "";
    return `${subject} sem atualização há ${limit} ${pluralize(limit, "dia")} ou mais.${age}`;
  }

  function renderizarAlertaOsParadas(info) {
    const card = document.getElementById("alerta-os-paradas");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "paradas" || !(Number(info.total) > 0)) {
      ocultarAlertaPainel(card, state);
      return;
    }
    mostrarAlertaPainel(card, state, textoOsParadas(info));
  }

  function juntarLista(items) {
    return items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}` : items.join("");
  }

  function textoDivergenciasNovas(info) {
    const total = Number(info.total);
    const current = formatarDataHora(info.atual?.horario);
    const previous = formatarDataHora(info.anterior?.horario);
    const sections = (Array.isArray(info.por_secao) ? info.por_secao : [])
      .filter(item => Number(item?.total) > 0)
      .map(item => `${Number(item.total)} em ${item.secao}`);
    const rows = total === 1
      ? "1 linha de divergência que não estava"
      : `${total} linhas de divergência que não estavam`;
    const detail = sections.length ? `: ${juntarLista(sections)}` : "";
    const comparison = current ? `de ${current}` : "mais recente";
    const before = previous ? `de ${previous}` : "anterior";
    return `A comparação ${comparison} trouxe ${rows} na ${before}${detail}.`;
  }

  function renderizarAlertaDivergenciasNovas(info) {
    const card = document.getElementById("alerta-divergencias-novas");
    if (!card) return;
    const state = info && typeof info === "object" ? info.estado : null;
    if (state !== "novas" || !(Number(info.total) > 0)) {
      ocultarAlertaPainel(card, state);
      return;
    }
    mostrarAlertaPainel(card, state, textoDivergenciasNovas(info));
  }

  function inicializarAlertasOsDivergencias() {
    document.addEventListener("simpress:painel-atualizado", event => {
      renderizarAlertaOsParadas(event.detail?.os_paradas);
      renderizarAlertaDivergenciasNovas(event.detail?.divergencias_novas);
    });
    ["alerta-os-paradas", "alerta-divergencias-novas"].forEach(id => {
      document.getElementById(id)?.addEventListener("animationend", event => {
        delete event.currentTarget.dataset.enter;
      });
    });
  }

  function atualizarIndicadoresPosSalvamento() {
    // Atualiza os indicadores sem atrasar o fechamento do formulário após salvar.
    void Promise.allSettled([
      app.carregarEstatisticas(),
      app.carregarContagemHistoricoApelidos()
    ]);
  }

  return {
    carregarEstatisticas, carregarProntidao, inicializarProntidao, atualizarIndicadoresPosSalvamento,
    inicializarAlertaBaseDesatualizada, renderizarAlertaBaseDesatualizada,
    inicializarAlertasOsDivergencias, renderizarAlertaOsParadas, renderizarAlertaDivergenciasNovas,
  };
});
