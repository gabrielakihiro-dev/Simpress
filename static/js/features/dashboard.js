/** Home indicators: inventory statistics and the readiness panel that lists which files and functions are available. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).dashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, function createDashboard(context) {
  "use strict";
  const { app, transferUtils, motion } = context;
  const { pluralize } = context.dom;

  const readinessRequestGate = transferUtils.createRequestGate();

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

      const content = document.createDocumentFragment();
      if (writeBlock) adicionarGrupoGravacoesBloqueadas(content, writeBlock);
      adicionarGrupoInventarios(content, report);
      adicionarGrupoAcompanhamentoChamados(content, report);
      if (report.files.modelo_exportacao) adicionarGrupoModeloExportacao(content, report.files.modelo_exportacao);
      if (report.files.nomes_entra) adicionarGrupoNomesEntra(content, report.files.nomes_entra);
      details.replaceChildren(content);
      // Later refreshes after saves update in place; only the first render cascades in.
      if (!details.dataset.revealed) {
        details.dataset.revealed = "true";
        motion?.stagger(details.children);
      }
    } catch (error) {
      if (!readinessRequestGate.isCurrent(request.id)) return;
      panel.dataset.state = "error";
      summary.textContent = "Não foi possível consultar a disponibilidade das funções.";
      definirResumoCurto("Indisponível");
      details.textContent = "Confira se o servidor está em execução e recarregue a página para tentar novamente.";
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

  function adicionarGrupoGravacoesBloqueadas(content, writeBlock) {
    adicionarGrupoProntidao(
      content,
      "Gravações bloqueadas",
      [["gravacao_bloqueada", writeBlock]],
      { gravacao_bloqueada: "Importações e edições" },
      "function",
      {
        description: "A consulta continua disponível; importações, edições e anotações aguardam a conferência.",
        countLabel: "Modo leitura",
        countState: "invalid",
        showItemState: false,
      }
    );
  }

  // Simpress and Endpoint are imported together, so they are reported as one shared item.
  function adicionarGrupoInventarios(content, report) {
    const inventoryFileKeys = ["inventario_equipamentos", "inventario_detalhes_atualizacao", "inventario_endpoint"];
    const missingInventoryFiles = inventoryFileKeys
      .filter(key => report.files[key]?.available !== true);
    const inventoryInvalid = missingInventoryFiles.some(key => report.files[key]?.state === "invalid");
    const sharedInventoryStatus = {
      available: missingInventoryFiles.length === 0,
      state: missingInventoryFiles.length === 0 ? "ready" : inventoryInvalid ? "invalid" : "awaiting_import",
      missing_files: missingInventoryFiles.map(key => INVENTORY_FILE_LABELS[key] || key),
      reason: missingInventoryFiles.map(key => {
        const status = report.files[key];
        const detail = status?.reason || (status?.state === "invalid" ? "arquivo inválido" : "aguardando importação");
        return `${INVENTORY_FILE_LABELS[key] || key}: ${detail}`;
      }).join(" · "),
    };
    adicionarGrupoProntidao(
      content,
      "Inventários",
      [["inventarios_compartilhados", sharedInventoryStatus]],
      { inventarios_compartilhados: "Simpress + Endpoint" },
      "shared_inventory",
      {
        actionOnly: true,
        description: "Par compartilhado pelas quatro ações.",
        countLabel: sharedInventoryStatus.available ? "Disponível" : sharedInventoryStatus.state === "invalid" ? "Inválido" : "Pendente",
        countState: sharedInventoryStatus.state,
        showItemState: false,
        groupAction: {
          label: "Importar",
          ariaLabel: "Importar/atualizar inventários Simpress e Endpoint",
          onClick: app.abrirModalAtualizarPlanilhas,
        },
      }
    );
  }

  function adicionarGrupoAcompanhamentoChamados(content, report) {
    const ticketFileStatus = report.files.historico_chamados || {};
    const ticketFunctionStatus = report.functions.acompanhamento_chamados || {};
    const ticketStatus = {
      ...ticketFileStatus,
      ...ticketFunctionStatus,
      file: ticketFileStatus.file,
      reason: ticketFunctionStatus.available === true
        ? "OK"
        : ticketFileStatus.reason || ticketFunctionStatus.missing_files?.join(", ") || "arquivo indisponível",
    };
    ticketStatus.state ||= ticketStatus.available === true ? "ready" : report.files.historico_chamados?.state || "awaiting_import";

    adicionarGrupoProntidao(
      content,
      "Acompanhamento de chamados",
      [["acompanhamento_chamados", ticketStatus]],
      READINESS_FUNCTION_LABELS,
      "function",
      {
        actionOnly: true,
        description: "Importação própria das planilhas da Simpress e do Oracle.",
        countLabel: ticketStatus.available === true ? "Disponível" : ticketStatus.state === "invalid" ? "Inválido" : "Pendente",
        countState: ticketStatus.state,
        showItemState: false,
        groupAction: {
          label: "Importar",
          ariaLabel: "Importar planilhas para acompanhamento de chamados",
          onClick: () => {
            document.getElementById("painel-dados-acompanhamento-chamados").open = true;
            app.abrirAcompanhamentoChamados(true);
          },
        },
      }
    );
  }

  function adicionarGrupoModeloExportacao(content, exportModelStatus) {
    adicionarGrupoProntidao(
      content,
      "Modelo de exportação",
      [["modelo_exportacao", exportModelStatus]],
      READINESS_FILE_LABELS,
      "file",
      {
        actionOnly: true,
        description: "Planilha usada pela exportação de equipamentos.",
        countLabel: exportModelStatus.available
          ? "Disponível"
          : exportModelStatus.state === "invalid" ? "Inválido" : "Pendente",
        countState: exportModelStatus.state,
        showItemState: false,
        itemActions: {
          modelo_exportacao: {
            label: "Importar",
            ariaLabel: "Importar modelo de exportação",
            onClick: () => app.abrirImportacaoModelo("exportacao"),
          },
        },
        groupAction: {
          label: "Importar",
          ariaLabel: "Importar modelo de exportação",
          onClick: () => app.abrirImportacaoModelo("exportacao"),
        },
      }
    );
  }

  function adicionarGrupoNomesEntra(content, entraStatus) {
    adicionarGrupoProntidao(
      content,
      "Nomes do Microsoft Entra",
      [["nomes_entra", entraStatus]],
      READINESS_FILE_LABELS,
      "file",
      {
        actionOnly: true,
        description: "Nomes exibidos junto ao login do usuário.",
        countLabel: entraStatus.available ? "Disponível" : entraStatus.state === "invalid" ? "Inválido" : "Pendente",
        countState: entraStatus.state,
        showItemState: false,
        groupAction: {
          label: "Importar",
          ariaLabel: "Importar CSV com os nomes do Microsoft Entra",
          onClick: app.abrirModalAtualizarPlanilhas,
        },
      }
    );
  }

  function adicionarGrupoProntidao(parent, title, entries, labels, type, options = {}) {
    const group = document.createElement("section");
    group.className = "readiness-group";
    const headingRow = document.createElement("div");
    headingRow.className = "readiness-group-heading";
    const heading = document.createElement("h3");
    heading.className = "readiness-group-title";
    heading.textContent = title;
    const count = document.createElement("span");
    count.className = "readiness-group-count";
    count.textContent = options.countLabel || `${entries.length} ${entries.length === 1 ? "item" : "itens"}`;
    if (options.countState) count.dataset.state = options.countState;
    headingRow.append(heading, count);

    const description = document.createElement("p");
    description.className = "readiness-group-description";
    description.textContent = options.description || (type === "file"
      ? "Planilhas e dados usados pelas funções."
      : "Ações disponíveis na aplicação.");

    const list = document.createElement("ul");
    list.className = "readiness-list";

    entries.forEach(([key, status]) => {
      const available = status?.available === true;
      const item = document.createElement("li");
      item.className = "readiness-item";
      item.dataset.available = String(available);
      const label = document.createElement("span");
      label.className = "readiness-item-label";
      label.textContent = labels[key] || key;
      const state = document.createElement("span");
      state.className = "readiness-item-state";
      state.textContent = available ? "Disponível" : status.state === "awaiting_import" ? "Aguardando importação"
        : status.state === "invalid" ? "Arquivo inválido" : "Indisponível";

      const availableFileDetail = status?.reason && status.reason !== "OK"
        ? status.reason
        : status?.file;
      const detail = document.createElement("span");
      detail.className = "readiness-item-detail";
      const detailText = options.showItemDetails === false ? "" : type === "shared_inventory"
        ? (!available ? status.reason || (status.missing_files || []).join(", ") : "")
        : type === "file"
        ? (available
            ? availableFileDetail
            : [status.file, status.reason].filter(Boolean).join(" — "))
        : (!available
            ? status.reason && status.reason !== "OK"
              ? [status.file, status.reason].filter(Boolean).join(" — ")
              : (status.missing_files || []).join(", ") || "dependência ausente"
            : "");
      item.appendChild(label);
      if (options.showItemState !== false) item.appendChild(state);
      if (detailText) {
        detail.textContent = `Detalhe: ${detailText}`;
        item.appendChild(detail);
      }
      const action = options.itemActions?.[key];
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "readiness-import";
        button.textContent = action.label;
        button.setAttribute("aria-label", action.ariaLabel || `${action.label} — ${labels[key] || key}`);
        button.addEventListener("click", action.onClick);
        item.appendChild(button);
      }
      list.appendChild(item);
    });

    if (options.actionOnly) group.append(headingRow); else group.append(headingRow, description, list);
    if (options.groupAction) {
      const actions = document.createElement("div");
      actions.className = "readiness-group-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "readiness-import";
      button.textContent = options.groupAction.label;
      button.setAttribute("aria-label", options.groupAction.ariaLabel || options.groupAction.label);
      button.addEventListener("click", options.groupAction.onClick);
      actions.appendChild(button);
      group.appendChild(actions);
    }
    parent.appendChild(group);
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
    const text = card.querySelector(".stale-base-alert-text");
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
    carregarEstatisticas, carregarProntidao, atualizarIndicadoresPosSalvamento,
    inicializarAlertaBaseDesatualizada, renderizarAlertaBaseDesatualizada,
    inicializarAlertasOsDivergencias, renderizarAlertaOsParadas, renderizarAlertaDivergenciasNovas,
  };
});
