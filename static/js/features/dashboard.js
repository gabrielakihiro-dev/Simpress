/** Home indicators: inventory statistics and the readiness panel that lists which files and functions are available. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).dashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, function createDashboard(context) {
  "use strict";
  const { app, transferUtils } = context;
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

  // Load statistics from API
  async function carregarEstatisticas() {
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error("Falha ao consultar as estatísticas locais.");
      const stats = await res.json();
      definirEstatistica("stat-equipamentos", stats.total_equipamentos);
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
        panel.open = !counts.allAvailable || Boolean(writeBlock);
        panel.dataset.initialized = "true";
      }
      summary.textContent = resumoProntidao(counts, writeBlock);

      const content = document.createDocumentFragment();
      if (writeBlock) adicionarGrupoGravacoesBloqueadas(content, writeBlock);
      adicionarGrupoInventarios(content, report);
      adicionarGrupoAcompanhamentoChamados(content, report);
      if (report.files.modelo_exportacao) adicionarGrupoModeloExportacao(content, report.files.modelo_exportacao);
      details.replaceChildren(content);
    } catch (error) {
      if (!readinessRequestGate.isCurrent(request.id)) return;
      panel.dataset.state = "error";
      summary.textContent = "Não foi possível consultar a disponibilidade das funções.";
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
    const readinessFiles = readinessFileKeys.map(key => report.files[key]).filter(Boolean);
    const availableCount = readinessFiles.filter(status => status.available === true).length;
    const totalCount = readinessFileKeys.length;
    return { availableCount, totalCount, allAvailable: totalCount > 0 && availableCount === totalCount };
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

  function atualizarIndicadoresPosSalvamento() {
    // Atualiza os indicadores sem atrasar o fechamento do formulário após salvar.
    void Promise.allSettled([
      app.carregarEstatisticas(),
      app.carregarContagemHistoricoApelidos()
    ]);
  }

  return {
    carregarEstatisticas, carregarProntidao, atualizarIndicadoresPosSalvamento,
  };
});
