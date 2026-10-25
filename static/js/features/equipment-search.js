/** Equipment lookup, serial autocomplete, recent searches, and the selected equipment card. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentSearch(context) {
  "use strict";
  const { app, appState, motion, transferUtils, recentEquipment } = context;
  const { createTextElement } = context.dom;
  const renderers = context.equipmentSearchRenderer(context);
  const recentStore = recentEquipment?.createStore(() => window.localStorage) || null;

  let debounceTimer = null;
  const autocompleteRequestGate = transferUtils.createRequestGate();
  const equipmentLookupRequestGate = transferUtils.createRequestGate();
  const homeListRequestGate = transferUtils.createRequestGate();
  const searchButtonInitialHtml = document.getElementById("btn-buscar-serial")?.innerHTML || "";
  const HOME_LIST_PAGE_SIZE = 50;
  const HOME_COMPARISON_FILTERS = Object.freeze({
    "7-dias": ["sem_acesso_7_dias"],
    divergentes: ["ausentes_no_endpoint", "divergencias_local", "correspondencias_ambiguas", "registros_ambiguos"],
  });
  let homeListFilter = "todos";
  let homeListOffset = 0;
  let homeListHasMore = false;
  let homeListTotal = 0;
  let homeListQuery = "";
  let homeListSerials = new Map();
  let homeComparisonFilters = { "7-dias": null, divergentes: null };
  let homeCountsLoaded = false;
  let finishEquipmentLoading = () => {};

  function definirEquipamentoAtual(equipment) {
    appState.currentEquipamento = equipment;
    appState.equipamentoSelectionRevision += 1;
    app.atualizarResumoSerieTransferencia(equipment);
    const copySerialButton = document.getElementById("btn-copiar-serie");
    const hasSerial = Boolean(String(equipment?.serial || "").trim());
    if (copySerialButton) {
      copySerialButton.disabled = !hasSerial;
      copySerialButton.setAttribute("aria-disabled", String(!hasSerial));
    }
  }

  function limparSelecaoEquipamento() {
    app.definirEquipamentoAtual(null);
    appState.retiradaCidadeSelecionada = "";
    document.getElementById("card-equipamento")?.classList.add("hidden");
    document.getElementById("home-detail-empty")?.classList.remove("hidden");
    document.getElementById("retirada-cnpj").value = "";
    document.getElementById("retirada-endereco").value = "";
    document.getElementById("retirada-obs").value = "";
    ["textarea-resumo-preview", "textarea-texto-transporte"].forEach(id => {
      const field = document.getElementById(id);
      if (field) field.value = "";
    });
    app.preencherRepresentanteRegional("retirada", "");
    const indicator = document.getElementById("status-indicator");
    if (indicator) indicator.className = "w-2.5 h-2.5 rounded-full bg-brand-400";
    const summary = document.getElementById("status-summary");
    if (summary) summary.replaceChildren(
      createTextElement("span", "text-fg-tertiary font-medium", "Pronto para emissão.")
    );
    summary?.firstElementChild?.setAttribute("data-ux-ready-status", "");
  }

  function invalidarBuscasEquipamento() {
    finishEquipmentLoading();
    clearTimeout(debounceTimer);
    autocompleteRequestGate.invalidate();
    equipmentLookupRequestGate.invalidate();
    const autocomplete = document.getElementById("autocomplete-box");
    autocomplete?.setAttribute("aria-busy", "false");
    document.getElementById("input-serial")?.removeAttribute("aria-busy");
    const button = document.getElementById("btn-buscar-serial");
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = searchButtonInitialHtml;
      lucide.createIcons({ root: button });
    }
  }

  function invalidarDadosEquipamentoAposRestauracao() {
    const serialInput = document.getElementById("input-serial");
    if (serialInput) serialInput.value = "";
    document.getElementById("btn-clear-serial")?.classList.add("hidden");
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
  }

  async function atualizarSelecaoAposSubstituirInventarios(serialSelecionada) {
    app.fecharAutocomplete();
    return transferUtils.refreshSelectionAfterInventoryReplacement({
      requestGate: equipmentLookupRequestGate,
      serial: serialSelecionada,
      invalidateSearches: app.invalidarBuscasEquipamento,
      clearSelection: clearSerial => {
        app.limparSelecaoEquipamento();
        if (!serialSelecionada || clearSerial) {
          const serialInput = document.getElementById("input-serial");
          if (serialInput) serialInput.value = "";
          document.getElementById("btn-clear-serial")?.classList.add("hidden");
        }
      },
      fetchEquipment: (serial, options) => fetch(
        `/api/equipamento/${encodeURIComponent(serial)}`,
        options,
      ),
      applyEquipment: equipment => {
        app.definirEquipamentoAtual(equipment);
        app.exibirEquipamento(equipment);
      },
    });
  }

  const inputSerialInicial = document.getElementById("input-serial");

  if (inputSerialInicial && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    inputSerialInicial.focus({ preventScroll: true });
  }

  // Autocomplete & Debounce for Serial Input
  let autocompleteItemsList = [];

  let highlightedAutocompleteIndex = -1;

  function handleSerialInput(val) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
    const clearBtn = document.getElementById("btn-clear-serial");
    if (val && val.length > 0) {
      clearBtn?.classList.remove("hidden");
    } else {
      clearBtn?.classList.add("hidden");
    }

    clearTimeout(debounceTimer);
    const term = val.trim();
    if (term.length < 2) {
      app.fecharAutocomplete();
      if (!term) void carregarListaHome({ query: "", reset: true });
      else limparListaHome("Digite ao menos 2 caracteres para filtrar a lista.");
      return;
    }

    void carregarListaHome({ query: term, reset: true });
    document.getElementById("autocomplete-box").setAttribute("aria-busy", "true");
    debounceTimer = setTimeout(async () => {
      const request = autocompleteRequestGate.begin();
      try {
        const res = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(term)}&limit=15`, { signal: request.signal });
        if (!autocompleteRequestGate.isCurrent(request.id)) return;
        if (res.ok) {
          const results = await res.json();
          if (transferUtils.isCurrentQuery(
            autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
          )) {
            renderAutocomplete(results.items, results.total, results.has_more);
          }
        } else if (autocompleteRequestGate.isCurrent(request.id)) {
          app.showToast("Não foi possível consultar os equipamentos. Tente novamente.", "error");
        }
      } catch (err) {
        if (err.name !== "AbortError" && autocompleteRequestGate.isCurrent(request.id)) {
          console.warn("Erro no autocomplete:", err);
          app.showToast("Falha de conexão ao consultar os equipamentos.", "error");
        }
      } finally {
        if (transferUtils.isCurrentQuery(
          autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
        )) {
          document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
        }
      }
    }, 200);
  }

  function handleSerialKeydown(e) {
    const box = document.getElementById("autocomplete-box");
    const isBoxOpen = box && !box.classList.contains("hidden") && autocompleteItemsList.length > 0;

    if (e.key === "ArrowDown") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex + 1) % autocompleteItemsList.length;
        updateAutocompleteHighlight();
      }
    } else if (e.key === "ArrowUp") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex - 1 + autocompleteItemsList.length) % autocompleteItemsList.length;
        updateAutocompleteHighlight();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isBoxOpen && highlightedAutocompleteIndex >= 0 && autocompleteItemsList[highlightedAutocompleteIndex]) {
        app.selecionarItemAutocomplete(autocompleteItemsList[highlightedAutocompleteIndex]);
      } else if (isBoxOpen && autocompleteItemsList.length === 1) {
        app.selecionarItemAutocomplete(autocompleteItemsList[0]);
      } else if (isBoxOpen) {
        app.abrirPesquisaCompleta();
      } else {
        app.buscarSerial();
      }
    } else if (e.key === "Escape") {
      app.fecharAutocomplete();
    }
  }

  function updateAutocompleteHighlight() {
    const list = document.getElementById("autocomplete-list");
    if (!list) return;
    const rows = list.querySelectorAll(".autocomplete-row");
    rows.forEach((row, idx) => {
      const selected = idx === highlightedAutocompleteIndex;
      row.setAttribute("aria-selected", String(selected));
      if (selected) {
        row.classList.add("active");
        document.getElementById("input-serial").setAttribute("aria-activedescendant", row.id);
        row.scrollIntoView({ block: "nearest", behavior: "auto" });
      } else {
        row.classList.remove("active");
      }
    });
    if (highlightedAutocompleteIndex < 0) document.getElementById("input-serial").removeAttribute("aria-activedescendant");
  }

  function selecionarItemAutocomplete(item) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    document.getElementById("input-serial").value = item.serial;
    document.getElementById("btn-clear-serial").classList.remove("hidden");
    app.fecharAutocomplete();
    return app.buscarSerial(item);
  }

  function ajustarAlturaAutocomplete() {
    const box = document.getElementById("autocomplete-box");
    if (!box || box.classList.contains("hidden")) return;

    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const availableHeight = Math.max(0, Math.floor(viewportBottom - box.getBoundingClientRect().top - 12));
    box.style.setProperty("--autocomplete-available-height", `${availableHeight}px`);
  }

  function renderAutocomplete(items, total = items?.length || 0, hasMore = false) {
    const box = document.getElementById("autocomplete-box");
    const list = document.getElementById("autocomplete-list");
    const emptyState = document.getElementById("autocomplete-empty-state");
    const countEl = document.getElementById("autocomplete-count");
    const moreResults = document.getElementById("autocomplete-more-results");
    const moreResultsLabel = moreResults.querySelector("[data-autocomplete-more-label]");
    const currentQuery = (document.getElementById("input-serial").value || "").trim();

    if (!items || items.length === 0) {
      list.replaceChildren();
      list.classList.add("hidden");
      emptyState.classList.remove("hidden");
      moreResults.classList.add("hidden");
      emptyState.innerHTML = `
          <div class="px-6 py-8 text-center flex flex-col items-center justify-center space-y-2 select-none">
            <div class="w-10 h-10 rounded-xl bg-surface-overlay border border-line-quiet flex items-center justify-center text-fg-muted mb-1">
              <i data-lucide="search-x" class="w-5 h-5" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-semibold text-fg-secondary" role="status" aria-live="polite">Nenhum equipamento localizado</p>
            <p class="text-xs text-fg-muted max-w-sm">Nenhum registro com o termo <span class="font-mono text-cyan-400 font-bold">"${escapeHtml(currentQuery)}"</span> foi encontrado no inventário do SEBRAE/PR.</p>
            <button type="button" data-on-click="cadastrarNovoSerialPesquisado" class="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold transition shadow-lg">
              <i data-lucide="plus-circle" class="w-3.5 h-3.5" aria-hidden="true"></i>
              <span>Cadastrar "${escapeHtml(currentQuery)}" como Novo Equipamento</span>
            </button>
          </div>
        `;
      countEl.textContent = "0 encontrados";
      moreResultsLabel.textContent = "Mostrar mais";
      moreResults.querySelector("button")?.removeAttribute("aria-label");
      autocompleteItemsList = [];
      highlightedAutocompleteIndex = -1;
      document.getElementById("input-serial").setAttribute("aria-expanded", "true");
      document.getElementById("input-serial").removeAttribute("aria-activedescendant");
      box.classList.remove("hidden");
      ajustarAlturaAutocomplete();
      lucide.createIcons({ root: box });
      return;
    }

    autocompleteItemsList = items;
    highlightedAutocompleteIndex = -1;
    list.innerHTML = "";
    list.classList.remove("hidden");
    emptyState.classList.add("hidden");
    countEl.textContent = hasMore
      ? `${items.length} de ${total}`
      : `${total} ${total === 1 ? "item" : "itens"}`;
    moreResults.classList.toggle("hidden", !hasMore);
    const remainingResults = Math.max(0, Number(total) - items.length);
    moreResultsLabel.textContent = `Mostrar mais (${remainingResults})`;
    moreResults.querySelector("button")?.setAttribute(
      "aria-label",
      `Mostrar mais ${remainingResults} ${remainingResults === 1 ? "resultado" : "resultados"}`,
    );
    document.getElementById("input-serial").setAttribute("aria-expanded", "true");
    document.getElementById("input-serial").removeAttribute("aria-activedescendant");

    items.forEach((item, index) => list.appendChild(renderers.criarLinhaAutocomplete(item, index, currentQuery, {
      onSelect: () => app.selecionarItemAutocomplete(item),
      onHighlight: () => {
        highlightedAutocompleteIndex = index;
        updateAutocompleteHighlight();
      },
    })));

    box.classList.remove("hidden");
    ajustarAlturaAutocomplete();
    lucide.createIcons({ root: box });
  }

  function fecharAutocomplete() {
    const box = document.getElementById("autocomplete-box");
    if (box) box.classList.add("hidden");
    if (box) box.setAttribute("aria-busy", "false");
    const input = document.getElementById("input-serial");
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    autocompleteItemsList = [];
    highlightedAutocompleteIndex = -1;
  }

  // Close autocomplete on click outside
  document.addEventListener("click", (e) => {
    const box = document.getElementById("autocomplete-box");
    const input = document.getElementById("input-serial");
    if (box && !box.contains(e.target) && e.target !== input) {
      app.fecharAutocomplete();
    }
  });

  window.addEventListener("resize", ajustarAlturaAutocomplete);

  window.visualViewport?.addEventListener("resize", ajustarAlturaAutocomplete);

  document.addEventListener("scroll", ajustarAlturaAutocomplete, { capture: true, passive: true });

  function limparSerial() {
    const input = document.getElementById("input-serial");
    input.value = "";
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    document.getElementById("btn-clear-serial").classList.add("hidden");
    app.fecharAutocomplete();
    input.focus();
    void carregarListaHome({ query: "", reset: true });
  }

  // Search Equipment by Serial
  async function buscarSerial(equipmentHint = null) {
    const serialInput = document.getElementById("input-serial");
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
    document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
    app.fecharAutocomplete();
    app.limparSelecaoEquipamento();
    const request = equipmentLookupRequestGate.begin();

    const btn = document.getElementById("btn-buscar-serial");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    serialInput.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Localizando...</span>`;
    lucide.createIcons({ root: btn });
    const stopLoading = motion?.startLoading(document.getElementById("equipment-loading"), "Localizando equipamento…", { rows: 1 }) || (() => {});
    finishEquipmentLoading = stopLoading;

    try {
      let data;
      try {
        data = await app.apiFetch(`/api/equipamento/${encodeURIComponent(serial)}`, {
          signal: request.signal,
          errorMessage: "Equipamento não encontrado na base de dados.",
        });
      } catch (lookupError) {
        // Only HTTP failures carry a status; network errors and cancellation propagate unchanged.
        if (lookupError.status === undefined) throw lookupError;
        if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        if (lookupError.status === 404 && serial.length >= 2) {
          const searchRes = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=15`, { signal: request.signal });
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          if (searchRes.ok) {
            const searchResults = await searchRes.json();
            if (equipmentLookupRequestGate.isCurrent(request.id) && searchResults.total > 0) {
              renderAutocomplete(searchResults.items, searchResults.total, searchResults.has_more);
              void carregarListaHome({ query: serialInput.value.trim(), reset: true });
              return;
            }
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

    } catch (err) {
      if (err.name !== "AbortError" && equipmentLookupRequestGate.isCurrent(request.id)) {
        console.error(err);
        app.limparSelecaoEquipamento();
        app.showToast(err.message, "error");
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
  function renderizarPesquisasRecentes(entries = recentStore?.read() || []) {
    const section = document.getElementById("home-recentes");
    const list = document.getElementById("home-recentes-lista");
    if (!section || !list) return;
    list.replaceChildren(...entries.map(entry => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "home-recent-item";
      button.dataset.serial = entry.serial;
      button.setAttribute("aria-label", recentEquipment.describeEntry(entry));
      button.append(
        createTextElement("span", "home-recent-serial", entry.serial),
        createTextElement("span", "home-recent-alias", entry.apelido || "Sem apelido"),
        createTextElement("span", "home-recent-city", entry.cidade || "Cidade não informada"),
      );
      button.addEventListener("click", () => app.abrirPesquisaRecente(entry.serial));
      item.append(button);
      return item;
    }));
    section.hidden = entries.length === 0;
  }

  function abrirPesquisaRecente(serial) {
    const entry = (recentStore?.read() || []).find(item => item.serial === serial) || { serial };
    window.scrollTo?.({ top: 0, behavior: "smooth" });
    return app.selecionarItemAutocomplete(entry);
  }

  function limparPesquisasRecentes() {
    renderizarPesquisasRecentes(recentStore?.clear() || []);
    document.getElementById("input-serial")?.focus({ preventScroll: true });
  }

  if (recentStore) renderizarPesquisasRecentes();

  // City plus the street part of the address; no dangling " - " when one is missing.
  function formatarLocalAtual(eq) {
    const cidade = String(eq?.retirada_cidade || "").trim();
    const endereco = String(eq?.retirada_endereco || "").split("-")[0].trim();
    return [cidade, endereco].filter(Boolean).join(" - ") || "Não especificado";
  }

  // Render Equipment Card & Populate Retirada Section
  function exibirEquipamento(eq) {
    appState.retiradaCidadeSelecionada = String(eq.retirada_cidade || "").trim();
    const card = document.getElementById("card-equipamento");
    const emptyState = document.getElementById("home-detail-empty");
    if (emptyState) emptyState.classList.add("hidden");
    card.classList.remove("hidden");
    motion?.reveal(card);

    document.getElementById("card-serial").textContent = eq.serial;
    document.getElementById("ticket-templates-serial").textContent = eq.serial || "—";
    app.recolherVisualizacoesModelosChamado();
    document.getElementById("card-modelo").textContent = eq.modelo || "Equipamento";
    document.getElementById("badge-tipo").textContent = eq.tipo || "Geral";
    document.getElementById("badge-apelido").textContent = eq.apelido || "Sem Apelido";
    const aliasStatus = document.getElementById("badge-apelido-status");
    aliasStatus.textContent = eq.invall_alias_status && eq.invall_alias_status !== "aplicado"
      ? (eq.invall_alias_detail || "Conferir associação com a InvAll.")
      : "";
    aliasStatus.classList.toggle("hidden", !aliasStatus.textContent);
    document.getElementById("card-id-cliente").textContent = eq.idCliente ? `Id Cliente: ${eq.idCliente}` : "";
    app.atualizarUsuarioLogadoCard(eq);
    document.getElementById("card-localizacao").textContent = app.formatarLocalAtual(eq);
    document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${eq.retirada_cnpj || 'Não especificado'}`;

    // Grade de detalhe (split-view)
    const gridSerial = document.getElementById("grid-serial");
    if (gridSerial) gridSerial.textContent = eq.serial || "—";
    const gridApelido = document.getElementById("grid-apelido");
    if (gridApelido) gridApelido.textContent = eq.apelido || "—";
    const gridCep = document.getElementById("grid-cep");
    if (gridCep) gridCep.textContent = eq.retirada_cep || "—";
    const gridCnpjFat = document.getElementById("grid-cnpj-fat");
    if (gridCnpjFat) gridCnpjFat.textContent = eq.retirada_cnpj || "—";
    const gridCnpjInst = document.getElementById("grid-cnpj-inst");
    if (gridCnpjInst) gridCnpjInst.textContent = eq.retirada_cnpj_instalacao || eq.retirada_cnpj || "—";

    // Type is shown as text in the chip; the icon only changes shape.
    const iconBox = document.getElementById("equip-icon-box");
    const icon = document.getElementById("equip-icon");
    // Literal setAttribute calls keep each icon in the generated Lucide subset.
    if (eq.tipo === "Notebook") icon.setAttribute("data-lucide", "laptop");
    else if (eq.tipo === "Micro Computador") icon.setAttribute("data-lucide", "monitor");
    else icon.setAttribute("data-lucide", "headphones");
    lucide.createIcons({ root: iconBox });

    // Automatically fill RETIRADA (Origem) section!
    document.getElementById("retirada-cnpj").value = eq.retirada_cnpj || "";
    document.getElementById("retirada-endereco").value = eq.retirada_endereco || "";
    document.getElementById("retirada-obs").value = eq.descricao_sugerida || "";
    app.preencherRepresentanteRegional("retirada", eq.retirada_cidade || "");

    // Update status footer
    document.getElementById("status-indicator").className = "w-2.5 h-2.5 rounded-full bg-emerald-400";
    const statusSummary = document.getElementById("status-summary");
    statusSummary.replaceChildren(
      createTextElement("span", "text-emerald-300 font-medium", "Equipamento " + String(eq.serial ?? "") + " (" + String(eq.modelo ?? "") + ") carregado."),
      createTextElement("span", "text-fg-subtle", " Selecione a Unidade de Destino e preencha o destinatário.")
    );

    // Highlight na lista lateral
    highlightHomeListItem(eq.serial);
    app.atualizarPreviaTransporteCockpit?.();
  }

  function highlightHomeListItem(serial) {
    const list = document.getElementById("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    list.querySelectorAll(".cockpit-home-item.is-selected").forEach(el => {
      el.classList.remove("is-selected");
      el.setAttribute("aria-selected", "false");
    });
    if (!serial) return;
    const target = list.querySelector(`[data-serial="${CSS.escape(String(serial).toUpperCase())}"]`);
    if (target) {
      target.classList.add("is-selected");
      target.setAttribute("aria-selected", "true");
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }

  function serialDeComparacao(item) {
    return String(item?.serie || item?.serial || item?.numero_serie || "").trim().toUpperCase();
  }

  function seriesDaComparacao(comparison, keys, requiredKeys = keys) {
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

  function atualizarContagemFiltro(id, total, disponivel = true) {
    const value = document.getElementById(id);
    const button = value?.closest("button");
    if (value) value.textContent = Number.isSafeInteger(total) && total >= 0
      ? total.toLocaleString("pt-BR")
      : "—";
    if (button) button.disabled = !disponivel;
  }

  async function carregarFiltrosComparacaoHome() {
    const filters = homeComparisonFilters;
    try {
      const dashboardResponse = await fetch("/api/painel", { cache: "no-store" });
      if (!dashboardResponse.ok) throw new Error("Resumo do painel indisponível.");
      const dashboard = await dashboardResponse.json();
      const eventId = String(dashboard?.ultima_comparacao?.id || "").trim();
      if (!eventId) throw new Error("Ainda não há comparação de inventários.");

      const comparisonResponse = await fetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { cache: "no-store" });
      if (!comparisonResponse.ok) throw new Error("Detalhes da última comparação indisponíveis.");
      const result = await comparisonResponse.json();
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
    } catch (error) {
      filters["7-dias"] = null;
      filters.divergentes = null;
      atualizarContagemFiltro("home-filter-7-dias", null, false);
      atualizarContagemFiltro("home-filter-divergentes", null, false);
      // The Home inventory remains usable even when comparison history is unavailable.
      console.info("Filtros de comparação da Home indisponíveis:", error.message);
    }
  }

  function atualizarMapaSeriesComparacao(comparison) {
    homeListSerials = new Map();
    const staleRows = Array.isArray(comparison?.sem_acesso_7_dias) ? comparison.sem_acesso_7_dias : [];
    for (const row of staleRows) {
      const serial = serialDeComparacao(row);
      if (!serial) continue;
      const days = Number(row?.dias_sem_acesso ?? row?.dias ?? row?.dias_desde_ultimo_acesso);
      homeListSerials.set(serial, { status: "warning", days: Number.isFinite(days) && days > 0 ? days : null });
    }
    for (const key of HOME_COMPARISON_FILTERS.divergentes) {
      const rows = Array.isArray(comparison?.[key]) ? comparison[key] : [];
      for (const row of rows) {
        const serial = serialDeComparacao(row);
        if (serial && !homeListSerials.has(serial)) homeListSerials.set(serial, { status: "error" });
      }
    }
  }

  function atualizarContagensHome(filters, total) {
    if (homeCountsLoaded || homeListQuery || homeListFilter !== "todos") return;
    homeCountsLoaded = true;
    const totalCount = Number(total);
    const withoutUser = Number(filters?.users?.sem);
    atualizarContagemFiltro("home-filter-total", totalCount);
    atualizarContagemFiltro("home-filter-sem-usuario", withoutUser);
  }

  function limparListaHome(message) {
    const list = document.getElementById("home-equipment-list");
    if (list) {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      list.removeAttribute("aria-activedescendant");
    }
    const empty = document.getElementById("home-list-empty");
    if (empty) {
      empty.textContent = message;
      empty.hidden = false;
    }
    const count = document.getElementById("home-list-count");
    if (count) count.textContent = message;
    const more = document.getElementById("btn-home-list-more");
    if (more) more.hidden = true;
  }

  function statusDaLinhaHome(item) {
    const serial = String(item?.serial || "").trim().toUpperCase();
    const comparison = homeListSerials.get(serial);
    if (comparison?.status === "warning") {
      return {
        dot: "cockpit-home-item-dot--warn",
        status: "cockpit-home-item-status--warn",
        label: comparison.days ? `Sem acesso ${comparison.days} d` : "Sem acesso 7+ d",
      };
    }
    if (comparison?.status === "error") {
      return { dot: "cockpit-home-item-dot--err", status: "cockpit-home-item-status--err", label: "Divergente" };
    }
    if (!String(item?.usuarios_logados || "").trim()) {
      return { dot: "cockpit-home-item-dot--warn", status: "cockpit-home-item-status--warn", label: "Sem usuário" };
    }
    return { dot: "cockpit-home-item-dot--ok", status: "cockpit-home-item-status--ok", label: "Sincronizado" };
  }

  function criarOpcaoListaHome(item, index) {
    const li = document.createElement("li");
    const serial = String(item?.serial || "").trim();
    const city = String(item?.retirada_cidade || "").trim();
    const user = String(item?.usuarios_logados || item?.nome_pessoa || "").trim();
    const status = statusDaLinhaHome(item);
    li.className = "cockpit-home-item";
    li.id = `home-equipment-option-${index}`;
    li.dataset.serial = serial.toUpperCase();
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(String(appState.currentEquipamento?.serial || "").toUpperCase() === serial.toUpperCase()));
    li.tabIndex = -1;
    const detail = [item?.modelo, user].filter(Boolean).join(" · ");
    li.title = [serial, detail, city, status.label].filter(Boolean).join(" · ");
    li.append(
      createTextElement("span", `cockpit-home-item-dot ${status.dot}`, ""),
      createTextElement("span", "cockpit-home-item-serial", serial || "Série não informada"),
      createTextElement("span", "cockpit-home-item-info", detail || "Sem modelo ou usuário"),
      createTextElement("span", "cockpit-home-item-city", city || "Sem cidade"),
      createTextElement("span", `cockpit-home-item-status ${status.status}`, status.label),
    );
    li.addEventListener("click", () => app.selecionarItemAutocomplete(item));
    return li;
  }

  function renderHomeList(items, append = false) {
    const list = document.getElementById("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    if (!append) {
      list.replaceChildren();
      list.removeAttribute("aria-activedescendant");
    }
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const serial = String(item?.serial || "").trim().toUpperCase();
      if (serial && list.querySelector(`[data-serial="${CSS.escape(serial)}"]`)) return;
      list.appendChild(criarOpcaoListaHome(item, homeListOffset + index));
    });
    const selected = String(appState.currentEquipamento?.serial || "").trim();
    if (selected) highlightHomeListItem(selected);
  }

  async function carregarListaHome({ query = homeListQuery, reset = true } = {}) {
    const list = document.getElementById("home-equipment-list");
    if (!list) return;
    homeListQuery = String(query || "").trim();
    if (homeListQuery.length === 1) {
      limparListaHome("Digite ao menos 2 caracteres para filtrar a lista.");
      return;
    }
    const request = homeListRequestGate.begin();
    const offset = reset ? 0 : homeListOffset;
    if (reset) {
      homeListOffset = 0;
      homeListTotal = 0;
      homeListHasMore = false;
      list.replaceChildren();
      list.setAttribute("aria-busy", "true");
      list.removeAttribute("aria-activedescendant");
      const count = document.getElementById("home-list-count");
      if (count) count.textContent = "Carregando equipamentos…";
      const empty = document.getElementById("home-list-empty");
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
        limparListaHome("O filtro depende de uma comparação de inventários disponível.");
        return;
      }
      series.forEach(serial => params.append("serie", serial));
    }

    try {
      const response = await fetch(`/api/buscar-expandida?${params.toString()}`, { signal: request.signal });
      if (!homeListRequestGate.isCurrent(request.id)) return;
      if (response.status === 409) throw new Error("A base está sendo atualizada. Tente novamente em instantes.");
      if (!response.ok) throw new Error("Não foi possível carregar a lista de equipamentos.");
      const result = await response.json();
      if (!homeListRequestGate.isCurrent(request.id)) return;

      homeListTotal = Number(result.total) || 0;
      homeListOffset = offset + (Array.isArray(result.items) ? result.items.length : 0);
      homeListHasMore = result.has_more === true;
      if (!homeListQuery && homeListFilter === "todos") {
        atualizarContagensHome(result.filters, homeListTotal);
      }
      renderHomeList(result.items, !reset);
      const empty = document.getElementById("home-list-empty");
      const hasItems = list.children.length > 0;
      if (empty) {
        empty.textContent = homeListQuery
          ? "Nenhum equipamento corresponde à pesquisa."
          : "Nenhum equipamento encontrado para este filtro.";
        empty.hidden = hasItems;
      }
      const count = document.getElementById("home-list-count");
      if (count) {
        const shown = list.children.length;
        count.textContent = homeListHasMore
          ? `Mostrando ${shown.toLocaleString("pt-BR")} de ${homeListTotal.toLocaleString("pt-BR")}`
          : `${homeListTotal.toLocaleString("pt-BR")} ${homeListTotal === 1 ? "equipamento" : "equipamentos"}`;
      }
      const more = document.getElementById("btn-home-list-more");
      if (more) more.hidden = !homeListHasMore;
      list.setAttribute("aria-busy", "false");
    } catch (error) {
      if (error.name === "AbortError" || !homeListRequestGate.isCurrent(request.id)) return;
      list.setAttribute("aria-busy", "false");
      limparListaHome(error.message || "Não foi possível carregar os equipamentos.");
    }
  }

  function filtrarListaHome(filter) {
    if (!["todos", "sem-usuario", "7-dias", "divergentes"].includes(filter)) return;
    if ((filter === "7-dias" || filter === "divergentes") && !homeComparisonFilters[filter]) return;
    homeListFilter = filter;
    document.querySelectorAll(".cockpit-home-pill[data-filter]").forEach(button => {
      const active = button.dataset.filter === filter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    void carregarListaHome({ query: document.getElementById("input-serial")?.value || "", reset: true });
  }

  function carregarMaisItensHome() {
    if (!homeListHasMore) return;
    return carregarListaHome({ query: homeListQuery, reset: false });
  }

  function ativarNavegacaoListaHome() {
    const list = document.getElementById("home-equipment-list");
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
    definirEquipamentoAtual, limparSelecaoEquipamento, invalidarBuscasEquipamento,
    invalidarDadosEquipamentoAposRestauracao, atualizarSelecaoAposSubstituirInventarios, handleSerialInput,
    handleSerialKeydown, selecionarItemAutocomplete, fecharAutocomplete,
    limparSerial, buscarSerial, exibirEquipamento, formatarLocalAtual, abrirPesquisaRecente, limparPesquisasRecentes,
    renderHomeList, highlightHomeListItem, filtrarListaHome, carregarMaisItensHome, carregarListaHome, inicializarListaHome,
  };
});
