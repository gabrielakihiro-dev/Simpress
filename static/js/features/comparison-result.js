/** Histórico de Planilhas dialog controller: annotations, filters, and manual alias decisions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).comparisonResult = factory;
})(typeof window !== "undefined" ? window : globalThis, function createComparisonResult(context) {
  "use strict";
  const { app, appState, motion } = context;
  const { escapeHtml } = context.dom;
  const renderer = context.comparisonResultRenderer(context);
  const { formatarNomeFonteHistorico, formatarHorarioHistorico, classesMetricaHistorico } = context.historyFormat;

  let comparisonAnnotationSyncObservers = [];

  function abrirModalComparacaoPlanilhas(comparison, navigationTarget = null) {
    const listas = renderer.listasComparacao(comparison);
    const colunas = renderer.criarColunasAnotacao(comparison);
    const arquivo = comparison.arquivos_enviados || {};
    document.getElementById("comparacao-planilhas-fontes").textContent =
      `no endpoint: ${formatarNomeFonteHistorico(arquivo.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivo.detalhes || "—")}${comparison.horario_comparacao ? ` · ${formatarHorarioHistorico(comparison.horario_comparacao)}` : ""}`;

    const exportButton = document.getElementById("btn-exportar-resultado-comparacao");
    const historyDate = String(comparison.horario_comparacao || "").slice(0, 10);
    const exportable = /^\d{4}-\d{2}-\d{2}$/.test(historyDate);
    if (exportButton) {
      exportButton.dataset.historyDate = exportable ? historyDate : "";
      exportButton.disabled = !exportable;
    }

    desconectarObservadoresAnotacoes();
    const content = document.getElementById("comparacao-planilhas-conteudo");
    content.innerHTML = comparison.somente_anotacoes_sincronizadas
      ? renderer.conteudoAnotacoesSincronizadas(comparison, colunas)
      : renderer.conteudoResultadoComparacao(comparison, listas, colunas);
    const navigationHeading = navigationTarget?.section
      ? encontrarTituloSecaoComparacao(content, navigationTarget.section)
      : null;
    if (navigationHeading) {
      navigationHeading.setAttribute("data-comparison-navigation-heading", "");
      if (!navigationHeading.hasAttribute("tabindex")) navigationHeading.setAttribute("tabindex", "-1");
    }
    conectarAcoesApelidosManuais(comparison, listas.divergenciasApelidosManuais);
    conectarRemocaoHostnames();
    conectarDecisoesPendenciasUsuario();
    // Logged user under each hostname, with the Home rule.
    context.loggedUserMarkers.conectar(content);
    conectarAnotacoesComparacao(comparison);
    conectarFiltrosHistoricoComparacao(content);
    conectarCartoesResumoComparacao();
    app.abrirModalAcessivel(
      "modal-comparacao-planilhas",
      navigationHeading ? "[data-comparison-navigation-heading]" : '[aria-label="Fechar resultado"]',
      "fecharModalComparacaoPlanilhas",
      comparison.contexto_historico === true ? "btn-historico-comparacoes" : "btn-atualizar-planilhas",
    );
    if (navigationTarget) requestAnimationFrame(() => navegarParaLinhaComparacao(navigationTarget));
  }

  function conectarAcoesApelidosManuais(comparison, divergenciasApelidosManuais) {
    document.querySelectorAll("[data-manual-alias-action]").forEach(button => {
      button.addEventListener("click", () => {
        const item = divergenciasApelidosManuais[Number(button.dataset.manualAliasIndex)];
        if (item) resolverDivergenciaApelidoManual(comparison, item, button.dataset.manualAliasAction, button);
      });
    });
  }

  const chaveHostname = (serie, hostname) =>
    `${String(serie || "").replace(/[^A-Z0-9]/gi, "").toUpperCase()}|${String(hostname || "").replace(/[^A-Z0-9]/gi, "").toUpperCase()}`;

  // The same hostname can be listed in the desktop table and in its mobile card; every copy is kept in step.
  function mostrarEstadoHostname(chave, removido) {
    document.querySelectorAll("#comparacao-planilhas-conteudo [data-hostname-item]").forEach(item => {
      if (chaveHostname(item.dataset.hostnameSerie, item.dataset.hostnameNome) !== chave) return;
      const remover = item.querySelector("[data-hostname-remove]");
      const aviso = item.querySelector("[data-hostname-removed]");
      const restaurar = item.querySelector("[data-hostname-restore]");
      if (remover) remover.hidden = removido;
      if (aviso) aviso.hidden = !removido;
      if (restaurar) restaurar.hidden = !removido;
      item.classList.toggle("opacity-60", removido);
    });
  }

  // Discards the oldest duplicated Endpoint hostname (or undoes it). Only the local list of discarded
  // pairs changes; the remaining hostname is the one the alias base and the next exports use.
  function conectarRemocaoHostnames() {
    const botoes = document.querySelectorAll(
      "#comparacao-planilhas-conteudo [data-hostname-remove], #comparacao-planilhas-conteudo [data-hostname-restore]"
    );
    if (!botoes.length) return;
    const alterar = async (botao, restaurar) => {
      const item = botao.closest("[data-hostname-item]");
      const serie = item?.dataset.hostnameSerie || "";
      const hostname = item?.dataset.hostnameNome || "";
      if (!restaurar && !(await app.confirmarAcao({
        titulo: "Remover hostname mais antigo?",
        mensagem: `Remover ${hostname} (série ${serie || "sem série"})? A planilha do Endpoint não é alterada; o outro hostname passa a valer na base e nas próximas exportações. Dá para desfazer.`,
        confirmar: "Remover hostname",
      }))) return;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        const data = await app.apiFetch(
          `/api/endpoint/hostnames-removidos${restaurar ? "/restaurar" : ""}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serie, hostname }),
            errorMessage: restaurar ? "Não foi possível desfazer a remoção." : "Não foi possível remover o hostname.",
          }
        );
        mostrarEstadoHostname(chaveHostname(serie, hostname), !restaurar);
        app.atualizarIndicadoresPosSalvamento();
        app.showToast(data.mensagem || (restaurar ? "Hostname restaurado." : "Hostname removido."), "success");
      } catch (error) {
        console.error("Erro ao alterar hostname duplicado do Endpoint:", error);
        app.showToast(error.message || "Não foi possível concluir a operação.", "error");
      } finally {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
      }
    };
    botoes.forEach(botao => botao.addEventListener("click", () => alterar(botao, botao.hasAttribute("data-hostname-restore"))));
    // Rows removed earlier open already marked, so a second click is never offered.
    app.apiFetch("/api/endpoint/hostnames-removidos", { errorMessage: "Não foi possível consultar os hostnames removidos." })
      .then(data => (data?.removidos || []).forEach(entry => mostrarEstadoHostname(chaveHostname(entry.serie, entry.hostname), true)))
      .catch(error => console.error("Erro ao consultar hostnames removidos:", error));
  }

  const TEXTOS_DECISAO_PENDENCIA = {
    permitir: { titulo: "Permitir a substituição?", mensagem: "O usuário do Endpoint passa a valer e o usuário manual é arquivado no histórico de alterações (dá para desfazer lá).", confirmar: "Permitir substituição", resultado: "Substituição permitida" },
    recusar: { titulo: "Manter o usuário manual?", mensagem: "O usuário manual continua valendo e este usuário do Endpoint não será perguntado de novo. Se o Endpoint informar outro usuário, você será avisado.", confirmar: "Manter usuário manual", resultado: "Usuário manual mantido", destrutiva: false },
    remover: { titulo: "Confirmar a remoção do usuário?", mensagem: "Confirma que o usuário realmente deixou de existir? Ele deixa de aparecer na base; um usuário manual arquivado antes volta a valer, se houver.", confirmar: "Confirmar remoção", resultado: "Usuário removido" },
    manter: { titulo: "Manter o usuário?", mensagem: "O usuário continua valendo mesmo sem constar no Endpoint e não será perguntado de novo enquanto o Endpoint não informar outro.", confirmar: "Manter usuário", resultado: "Usuário mantido", destrutiva: false },
  };

  function mostrarEstadoPendenciaUsuario(id, resultado) {
    document.querySelectorAll("#comparacao-planilhas-conteudo [data-user-hold]").forEach(bloco => {
      if (bloco.dataset.userHold !== id) return;
      bloco.querySelectorAll("[data-user-hold-action]").forEach(botao => { botao.hidden = true; });
      const status = bloco.querySelector("[data-user-hold-status]");
      if (status) {
        status.textContent = resultado;
        status.hidden = false;
      }
    });
  }

  // Decides a pending logged-user hold. Nothing changed until now: the current user kept applying.
  function conectarDecisoesPendenciasUsuario() {
    const botoes = document.querySelectorAll("#comparacao-planilhas-conteudo [data-user-hold-action]");
    if (!botoes.length) return;
    botoes.forEach(botao => botao.addEventListener("click", async () => {
      const id = botao.closest("[data-user-hold]")?.dataset.userHold || "";
      const decisao = botao.dataset.userHoldAction;
      const texto = TEXTOS_DECISAO_PENDENCIA[decisao];
      if (!id || !texto) return;
      if (!(await app.confirmarAcao({
        titulo: texto.titulo, mensagem: texto.mensagem, confirmar: texto.confirmar, destrutiva: texto.destrutiva !== false,
      }))) return;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        const data = await app.apiFetch(`/api/usuarios/pendencias/${encodeURIComponent(id)}/decidir`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisao }),
          errorMessage: "Não foi possível registrar a decisão.",
        });
        mostrarEstadoPendenciaUsuario(id, texto.resultado);
        app.atualizarIndicadoresPosSalvamento();
        app.showToast(data.mensagem || `${texto.resultado}.`, "success");
      } catch (error) {
        console.error("Erro ao decidir pendência de usuário:", error);
        app.showToast(error.message || "Não foi possível concluir a operação.", "error");
      } finally {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
      }
    }));
    // Holds decided earlier (here or in another window) open already answered.
    app.apiFetch("/api/usuarios/pendencias", { errorMessage: "Não foi possível consultar as pendências de usuário." })
      .then(data => {
        const aguardando = new Set((data?.pendencias || []).filter(item => item.estado === "pendente").map(item => item.id));
        document.querySelectorAll("#comparacao-planilhas-conteudo [data-user-hold]").forEach(bloco => {
          if (!aguardando.has(bloco.dataset.userHold)) mostrarEstadoPendenciaUsuario(bloco.dataset.userHold, "Decisão já registrada");
        });
      })
      .catch(error => console.error("Erro ao consultar pendências de usuário:", error));
  }

  // Autosaves every annotation field; a row listed in more than one section keeps its copies in sync.
  function conectarAnotacoesComparacao(comparison) {
    const annotationsById = new Map();
    document.querySelectorAll("[data-comparison-annotation]").forEach(textarea => {
      const itemId = textarea.dataset.annotationId;
      const status = textarea.parentElement.querySelector("[data-annotation-status]");
      const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
      window.HistoryAnnotationAutosave.attachAnnotationAutosave({
        textarea,
        status,
        retryButton,
        eventId: comparison.evento_id,
        itemId,
        send: ({ eventId, itemId: reviewItemId, annotation, revisionId, baseRevisions, resolveConflict }) => fetch(
          "/api/historico-comparacoes/"
            + encodeURIComponent(eventId)
            + "/anotacoes/"
            + encodeURIComponent(reviewItemId),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }),
          }
        ),
      });
      if (itemId) {
        if (!annotationsById.has(itemId)) annotationsById.set(itemId, []);
        annotationsById.get(itemId).push(textarea);
      }
    });
    annotationsById.forEach(textareas => sincronizarCopiasAnotacao(textareas));
  }

  function sincronizarCopiasAnotacao(textareas) {
    const syncState = (source, target) => {
      if (target.value !== source.value) target.value = source.value;
      if (target.dataset.annotationVersion !== source.dataset.annotationVersion) {
        target.dataset.annotationVersion = source.dataset.annotationVersion;
        target.dispatchEvent(new Event("annotationversionchange"));
      }
      const sourceStatus = source.parentElement.querySelector("[data-annotation-status]");
      const targetStatus = target.parentElement.querySelector("[data-annotation-status]");
      if (sourceStatus && targetStatus) {
        if (targetStatus.textContent !== sourceStatus.textContent) targetStatus.textContent = sourceStatus.textContent;
        if (targetStatus.className !== sourceStatus.className) targetStatus.className = sourceStatus.className;
      }
      const sourceRetry = source.parentElement.querySelector("[data-annotation-retry]");
      const targetRetry = target.parentElement.querySelector("[data-annotation-retry]");
      if (sourceRetry && targetRetry) {
        targetRetry.hidden = sourceRetry.hidden;
        targetRetry.disabled = sourceRetry.disabled;
      }
    };

    textareas.forEach(source => {
      source.addEventListener("input", () => {
        textareas.forEach(target => {
          if (target !== source) syncState(source, target);
        });
      });
      const status = source.parentElement.querySelector("[data-annotation-status]");
      if (status && textareas.length > 1) {
        const observer = new MutationObserver(() => {
          textareas.forEach(target => {
            if (target !== source) syncState(source, target);
          });
        });
        observer.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
        comparisonAnnotationSyncObservers.push(observer);
      }
    });
  }

  function desconectarObservadoresAnotacoes() {
    comparisonAnnotationSyncObservers.forEach(observer => observer.disconnect());
    comparisonAnnotationSyncObservers = [];
  }

  function normalizarCategoriaFiltroHistorico(category) {
    if (category === "registros_ambiguos") return "correspondencias_ambiguas";
    return category;
  }

  function conectarFiltrosHistoricoComparacao(content) {
    const filterBar = content?.querySelector("[data-history-filter-bar]");
    if (!filterBar) return;

    const categoryLabels = {
      apelidos_sem_atualizacao: "Linhas mantidas para conferência",
      sem_acesso_7_dias: "Sem acesso há 7 dias ou mais",
      ausentes_no_endpoint: "Sem correspondência — Endpoint",
      ausentes_em_detalhes: "Sem correspondência — Simpress",
      divergencias_local: "Localidade divergente",
      correspondencias_ambiguas: "Duplicidades e correspondências ambíguas",
      divergencias_apelidos_manuais: "Apelidos manuais divergentes",
      series_sem_mapeamento: "Séries sem local definido",
      mudancas_usuarios: "Mudanças de usuário logado",
    };
    const searchInput = filterBar.querySelector("[data-history-filter-search]");
    const categorySelect = filterBar.querySelector("[data-history-filter-category]");
    const annotatedOnly = filterBar.querySelector("[data-history-filter-annotated]");
    const status = filterBar.querySelector("[data-history-filter-count]");
    const canonicalize = value => normalizarCategoriaFiltroHistorico(String(value || ""));
    const normalizeText = value => String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR");
    const setHidden = (element, hidden) => {
      element.hidden = hidden;
      element.classList.toggle("hidden", hidden);
    };
    const rows = [...content.querySelectorAll("tr[data-comparison-category]")];
    const categories = [...new Set(rows.map(row => canonicalize(row.dataset.comparisonCategory)).filter(Boolean))]
      .sort((left, right) => (categoryLabels[left] || left).localeCompare(categoryLabels[right] || right, "pt-BR"));
    categorySelect.replaceChildren(new Option("Todos os tipos", ""));
    categories.forEach(category => categorySelect.add(new Option(categoryLabels[category] || category, category)));

    const hasAnnotation = row => [...row.querySelectorAll("[data-comparison-annotation]")].some(textarea => {
      if (textarea.value.trim()) return true;
      try {
        const version = JSON.parse(textarea.dataset.annotationVersion || "null");
        return Boolean(version?.anotacao_conflito || version?.anotacao_integridade_invalida);
      } catch (error) {
        return false;
      }
    });

    const updateFilters = () => {
      const query = normalizeText(searchInput.value.trim());
      const selectedCategory = canonicalize(categorySelect.value);
      const onlyAnnotated = annotatedOnly.checked;
      const filtersActive = Boolean(query || selectedCategory || onlyAnnotated);
      const allRows = [...content.querySelectorAll("tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]")];

      allRows.forEach(row => {
        const category = canonicalize(row.dataset.comparisonCategory);
        const annotationPresent = hasAnnotation(row);
        const annotationText = [...row.querySelectorAll("[data-comparison-annotation]")]
          .map(textarea => textarea.value)
          .join(" ");
        const searchable = normalizeText(`${row.textContent} ${annotationText} ${categoryLabels[category] || category}`);
        const matches = (!selectedCategory || selectedCategory === category)
          && (!query || searchable.includes(query))
          && (!onlyAnnotated || annotationPresent);
        setHidden(row, !matches);
        row.classList.toggle("history-row-annotated", annotationPresent);
      });

      content.querySelectorAll("[data-history-filter-group]").forEach(group => {
        const groupRows = [...group.querySelectorAll("tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]")];
        const hasVisibleRow = groupRows.some(row => !row.hidden);
        setHidden(group, filtersActive && (groupRows.length === 0 || !hasVisibleRow));
      });

      content.querySelectorAll("[data-history-filter-section]").forEach(section => {
        const groups = [...section.querySelectorAll(":scope > [data-history-filter-group]")];
        setHidden(section, filtersActive && (!groups.length || groups.every(group => group.hidden)));
      });

      const visibleRows = rows.filter(row => !row.hidden && !row.closest("[data-history-filter-group]")?.hidden
        && !row.closest("[data-history-filter-section]")?.hidden);
      status.textContent = visibleRows.length
        ? `${visibleRows.length.toLocaleString("pt-BR")} ${visibleRows.length === 1 ? "linha" : "linhas"} ${filtersActive ? "correspondem aos filtros" : "para conferência neste resultado"}.`
        : filtersActive ? "Nenhuma linha corresponde aos filtros." : "Nenhuma linha de divergência neste resultado.";
    };

    searchInput.addEventListener("input", updateFilters);
    categorySelect.addEventListener("change", updateFilters);
    annotatedOnly.addEventListener("change", updateFilters);
    content.querySelectorAll("[data-comparison-annotation]").forEach(textarea => {
      textarea.addEventListener("input", updateFilters);
      textarea.addEventListener("annotationversionchange", updateFilters);
    });
    const annotationVersionObserver = new MutationObserver(updateFilters);
    annotationVersionObserver.observe(content, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-annotation-version"],
    });
    comparisonAnnotationSyncObservers.push(annotationVersionObserver);
    updateFilters();
  }

  function normalizarIdentificadorLinhaComparacao(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  }

  function encontrarGrupoSecaoComparacao(content, sectionKey) {
    const target = String(sectionKey || "").trim();
    const normalizedTarget = normalizarIdentificadorLinhaComparacao(target);
    return [...content.querySelectorAll("[data-history-filter-group]")].find(candidate => {
      if (!candidate.getClientRects().length) return false;
      if (candidate.dataset.historyFilterGroup === target) return true;
      const section = candidate.closest("[data-history-filter-section]");
      const headings = [candidate.querySelector("h5"), section?.querySelector("h4")]
        .filter(Boolean)
        .map(heading => normalizarIdentificadorLinhaComparacao(heading.textContent));
      return headings.includes(normalizedTarget);
    });
  }

  function encontrarTituloSecaoComparacao(content, sectionKey) {
    const group = encontrarGrupoSecaoComparacao(content, sectionKey);
    if (!group) return null;
    const section = group.closest("[data-history-filter-section]");
    return group.querySelector("h5") || section?.querySelector("h4") || group.querySelector("h4");
  }

  function navegarParaLinhaComparacao(target) {
    const content = document.getElementById("comparacao-planilhas-conteudo");
    if (!content) return;
    if (target?.section) {
      const group = encontrarGrupoSecaoComparacao(content, target.section);
      if (!group) return;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      // Include the section title when the section holds only this group, and stop well below the sticky filter bar.
      const section = group.closest("[data-history-filter-section]");
      const anchor = section && section.querySelectorAll("[data-history-filter-group]").length === 1 ? section : group;
      const bar = content.querySelector("[data-history-filter-bar]");
      anchor.style.scrollMarginTop = `${(bar ? bar.offsetHeight : 0) + 32}px`;
      anchor.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      const heading = (section || group.closest("[data-history-filter-section]") || group).querySelector("h4");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
      motion?.reveal(group);
      return;
    }
    if (!target?.category) return;
    const visibleRows = [...content.querySelectorAll("tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]")]
      .filter(row => row.getClientRects().length > 0 && row.dataset.comparisonCategory === target.category);
    let row = target.itemId
      ? visibleRows.find(candidate => candidate.dataset.comparisonItemId === target.itemId)
      : null;
    if (!row) {
      const serial = normalizarIdentificadorLinhaComparacao(target.serial);
      const hostname = normalizarIdentificadorLinhaComparacao(target.hostname);
      row = visibleRows.find(candidate => {
        const sameSerial = serial && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonSerial) === serial;
        const sameHostname = hostname && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonHostname) === hostname;
        return sameSerial ? (!hostname || sameHostname) : (!serial && sameHostname);
      });
    }
    if (!row) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    motion?.reveal(row);
  }

  async function resolverDivergenciaApelidoManual(comparison, item, acao, botao) {
    if (!comparison.evento_id || !item.serie) {
      app.showToast("Este registro não permite resolver a divergência.", "error");
      return;
    }
    if (acao === "excluir" && !(await app.confirmarAcao({
      titulo: "Remover alteração manual?",
      mensagem: `Remover a alteração manual da série ${item.serie}? O apelido voltará ao hostname da fonte no endpoint, se preenchido, ou ao valor cadastrado na Simpress.`,
      confirmar: "Remover alteração",
    }))) return;

    const row = botao.closest("[data-manual-alias-row]");
    const rowIndex = row?.dataset.manualAliasRow;
    const matchingRows = rowIndex === undefined
      ? [row].filter(Boolean)
      : [...document.querySelectorAll("#comparacao-planilhas-conteudo [data-manual-alias-row]")]
        .filter(candidate => candidate.dataset.manualAliasRow === rowIndex);
    const actionAreas = matchingRows
      .map(candidate => candidate.querySelector("[data-manual-alias-actions]"))
      .filter(Boolean);
    const buttons = actionAreas.length
      ? actionAreas.flatMap(actionArea => [...actionArea.querySelectorAll("button")])
      : [botao];
    buttons.forEach(button => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    });
    try {
      const data = await app.apiFetch(
        `/api/historico-comparacoes/${encodeURIComponent(comparison.evento_id)}/apelido-manual/${encodeURIComponent(item.serie)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acao }),
          errorMessage: "Não foi possível resolver a divergência.",
        }
      );

      item.resolucao = data.resolucao;
      const pendingCounter = document.getElementById("comparacao-divergencias-manuais-pendentes");
      if (pendingCounter) {
        const pendentes = (comparison.divergencias_apelidos_manuais || []).filter(
          divergence => !divergence.resolucao || divergence.resolucao === "pendente"
        ).length;
        const classes = classesMetricaHistorico(pendentes, "rose");
        pendingCounter.textContent = pendentes;
        pendingCounter.className = `text-xl font-bold mt-1 ${classes.numero}`;
        const card = pendingCounter.closest("[data-metric-tone]");
        if (card) card.className = `${card.classList.contains("comparison-metric-link") ? "comparison-metric-link " : ""}rounded-xl p-3 ${classes.cartao}`;
      }
      matchingRows.forEach(candidate => {
        const status = candidate.querySelector("[data-manual-alias-status]");
        if (status) status.textContent = acao === "manter" ? "Alteração manual mantida" : "Alteração manual removida";
      });
      actionAreas.forEach(actionArea => {
        const concluido = document.createElement("span");
        concluido.className = "text-xs text-fg-muted";
        concluido.textContent = "Concluído";
        actionArea.replaceWith(concluido);
      });

      const equipment = data.equipamento;
      const currentSerial = String(appState.currentEquipamento?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const changedSerial = String(equipment?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (equipment && currentSerial && currentSerial === changedSerial) {
        app.definirEquipamentoAtual(equipment);
        app.exibirEquipamento(equipment);
      }
      app.atualizarIndicadoresPosSalvamento();
      app.showToast(data.mensagem || "Divergência registrada no histórico.", "success");
    } catch (error) {
      console.error("Erro ao resolver divergência de apelido manual:", error);
      app.showToast(error.message || "Não foi possível resolver a divergência.", "error");
      buttons.forEach(button => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      });
    }
  }

  function conectarCartoesResumoComparacao() {
    document.querySelectorAll("#comparacao-planilhas-conteudo [data-comparison-section-target]").forEach(button => {
      button.addEventListener("click", () => irParaSecaoComparacao(button.dataset.comparisonSectionTarget));
    });
    document.querySelectorAll("#comparacao-planilhas-conteudo [data-user-change-details]").forEach(details => {
      const rotulo = details.querySelector("[data-user-change-toggle-label]");
      details.addEventListener("toggle", () => {
        if (rotulo) rotulo.textContent = details.open ? "Minimizar lista de usuários alterados" : "Expandir lista de usuários alterados";
      });
    });
  }

  // Scrolls the result dialog to a section title and focuses it. A section hidden by the history
  // filters can only be reached by clearing them, so every filter is reset in that case.
  function irParaSecaoComparacao(sectionId) {
    const content = document.getElementById("comparacao-planilhas-conteudo");
    const heading = sectionId ? document.getElementById(sectionId) : null;
    if (!content || !heading || !content.contains(heading)) return false;
    const oculta = () => Boolean(heading.closest("[hidden]"));
    if (oculta()) limparFiltrosHistoricoComparacao(content);
    if (oculta()) return false;
    const recolhida = heading.closest("section")?.querySelector("details[data-user-change-details]:not([open])");
    if (recolhida) recolhida.open = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const bar = content.querySelector("[data-history-filter-bar]");
    heading.style.scrollMarginTop = `${(bar ? bar.offsetHeight : 0) + 16}px`;
    // Focus without scrolling; scrollIntoView then places the title just below the sticky filter bar.
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    return true;
  }

  function limparFiltrosHistoricoComparacao(content) {
    const searchInput = content.querySelector("[data-history-filter-search]");
    const categorySelect = content.querySelector("[data-history-filter-category]");
    const annotatedOnly = content.querySelector("[data-history-filter-annotated]");
    if (searchInput) searchInput.value = "";
    if (categorySelect) categorySelect.value = "";
    if (annotatedOnly) annotatedOnly.checked = false;
    // conectarFiltrosHistoricoComparacao recomputes visibility on these events.
    searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fecharModalComparacaoPlanilhas() {
    desconectarObservadoresAnotacoes();
    app.fecharModalAcessivel("modal-comparacao-planilhas");
  }

  function atributosVersaoAnotacao(item) {
    const version = {
      anotacao_revisoes: item.anotacao_revisoes || [],
      anotacao_conflito: Boolean(item.anotacao_conflito),
      anotacao_conflitos: item.anotacao_conflitos || [],
      anotacao_bases_ausentes: item.anotacao_bases_ausentes || [],
      anotacao_integridade_invalida: Boolean(item.anotacao_integridade_invalida),
    };
    return `data-annotation-version="${escapeHtml(JSON.stringify(version))}"`;
  }

  function renderizarAnotacaoOperacional(item, contexto) {
    const itemId = String(item?.anotacao_id || "");
    if (!itemId) return "";
    return `<label class="block min-w-[220px] text-xs text-fg-subtle">Anotação sobre ${escapeHtml(contexto)}
        <textarea data-operational-annotation ${app.atributosVersaoAnotacao(item)} data-annotation-id="${escapeHtml(itemId)}" rows="2" maxlength="2000" class="annotation-field mt-1 w-full" placeholder="Escreva uma anotação...">${escapeHtml(item.anotacao || "")}</textarea>
        <span class="annotation-status mt-1${item.anotacao ? " is-saved" : ""}" data-annotation-status aria-live="polite">${item.anotacao ? "Salvo automaticamente" : ""}</span>
        <button type="button" class="annotation-retry mt-1" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button>
      </label>`;
  }

  function conectarAnotacoesOperacionais(root, fallbackEventId) {
    root.querySelectorAll("[data-operational-annotation]").forEach(textarea => {
      const eventId = textarea.dataset.eventId || fallbackEventId;
      const itemId = textarea.dataset.annotationId;
      const status = textarea.parentElement.querySelector("[data-annotation-status]");
      const retryButton = textarea.parentElement.querySelector("[data-annotation-retry]");
      window.HistoryAnnotationAutosave.attachAnnotationAutosave({
        textarea,
        status,
        retryButton,
        eventId,
        itemId,
        send: ({ eventId: targetEventId, itemId: targetItemId, annotation, revisionId, baseRevisions, resolveConflict }) => fetch(
          `/api/historico-comparacoes/${encodeURIComponent(targetEventId)}/anotacoes/${encodeURIComponent(targetItemId)}`,
          { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }) }
        ),
      });
    });
  }

  return {
    abrirModalComparacaoPlanilhas, irParaSecaoComparacao, fecharModalComparacaoPlanilhas, atributosVersaoAnotacao,
    renderizarAnotacaoOperacional, conectarAnotacoesOperacionais,
  };
});
