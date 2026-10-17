/** Equipment search: serial autocomplete, the full search dialog, exact lookup, and the selected equipment card. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentSearch(context) {
  "use strict";
  const { app, appState, motion, transferUtils, recentEquipment } = context;
  const { escapeHtml, createTextElement, highlightMatch, pluralize } = context.dom;
  const recentStore = recentEquipment?.createStore(() => window.localStorage) || null;

  let debounceTimer = null;
  const autocompleteRequestGate = transferUtils.createRequestGate();
  const equipmentLookupRequestGate = transferUtils.createRequestGate();
  const searchButtonInitialHtml = document.getElementById("btn-buscar-serial")?.innerHTML || "";
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
      createTextElement("span", "text-slate-300 font-medium", "Pronto para emissão."),
      createTextElement("span", "text-slate-500", " Verifique os dados antes de gerar a planilha oficial Simpress.")
    );
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

  const PESQUISA_COMPLETA_PAGINA = 50;

  let pesquisaCompletaState = { query: "", categoria: "", cidade: "", offset: 0, total: 0, loading: false, requestId: 0 };

  function handleSerialInput(val) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
    const clearBtn = document.getElementById("btn-clear-serial");
    if (val && val.length > 0) {
      clearBtn.classList.remove("hidden");
    } else {
      clearBtn.classList.add("hidden");
    }

    clearTimeout(debounceTimer);
    const term = val.trim();
    if (term.length < 2) {
      app.fecharAutocomplete();
      return;
    }

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

  function conteudoLinhaResultado(item, currentQuery) {
    let tipoIcon = "laptop";
    let tipoBadgeClass = "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30";

    if (item.tipo === "Micro Computador") {
      tipoIcon = "monitor";
      tipoBadgeClass = "bg-blue-500/15 text-blue-300 border border-blue-500/30";
    } else if (item.tipo === "Monitor") {
      tipoIcon = "tv";
      tipoBadgeClass = "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30";
    } else if (item.tipo !== "Notebook") {
      tipoIcon = "box";
      tipoBadgeClass = "bg-purple-500/15 text-purple-300 border border-purple-500/30";
    }

    return `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="serial-badge flex items-center gap-2 px-3 py-1.5 rounded-lg shrink-0">
            <i data-lucide="hash" class="w-4 h-4 text-cyan-400 shrink-0" aria-hidden="true"></i>
            <span class="font-mono font-bold text-white text-sm sm:text-base tracking-widest">${highlightMatch(item.serial, currentQuery)}</span>
          </div>
          <span class="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${tipoBadgeClass} shrink-0">
            <i data-lucide="${tipoIcon}" class="w-3.5 h-3.5 shrink-0" aria-hidden="true"></i>
            <span>${escapeHtml(item.tipo || "Equipamento")}</span>
          </span>
          <div class="min-w-0 flex items-center gap-2 flex-1">
            <span class="text-xs sm:text-sm font-medium text-slate-200 truncate" title="${escapeHtml(item.modelo || "")}">
              ${escapeHtml(item.modelo || "Sem modelo especificado")}
            </span>
            ${item.apelido ? `
              <span class="autocomplete-alias inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-900/90 text-cyan-300 border border-cyan-500/30 shrink-0" title="Apelido / Hostname">
                <i data-lucide="terminal" class="w-2.5 h-2.5 text-cyan-400" aria-hidden="true"></i>
                <span>${escapeHtml(item.apelido)}</span>
              </span>
            ` : ""}
            ${item.invall_alias_status && item.invall_alias_status !== "aplicado" ? `
              <span class="text-[10px] text-amber-200 shrink-0" title="${escapeHtml(item.invall_alias_detail || "Conferir associação com a InvAll")}">Conferir InvAll</span>
            ` : ""}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <div class="flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-lg font-medium" title="Cidade / Unidade Atual">
            <i data-lucide="map-pin" class="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true"></i>
            <span>${escapeHtml(item.retirada_cidade || "PR")}</span>
          </div>
          <div class="hidden sm:flex items-center text-xs text-slate-400 group-hover:text-cyan-300 transition-colors ml-1 font-mono">
            <span class="text-[11px] mr-1 hidden lg:inline opacity-70">Selecionar</span>
            <kbd class="px-1.5 py-0.5 text-[10px] bg-slate-900 border border-slate-700 rounded text-slate-300 shadow-sm">↵</kbd>
          </div>
        </div>
      `;
  }

  function criarLinhaAutocomplete(item, index, currentQuery) {
    const row = document.createElement("div");
    row.id = `autocomplete-option-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.className = "autocomplete-row group px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3";
    row.onclick = () => app.selecionarItemAutocomplete(item);
    row.onmouseenter = () => {
      highlightedAutocompleteIndex = index;
      updateAutocompleteHighlight();
    };
    row.innerHTML = conteudoLinhaResultado(item, currentQuery);
    return row;
  }

  function criarLinhaPesquisaCompleta(item, index, currentQuery) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "autocomplete-row group w-full text-left px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3 rounded-lg";
    row.setAttribute("aria-label", [
      "Selecionar equipamento",
      item.serial,
      item.tipo,
      item.modelo,
      item.apelido,
      item.retirada_cidade,
    ].filter(Boolean).join(", "));
    row.dataset.resultIndex = String(index);
    row.innerHTML = conteudoLinhaResultado(item, currentQuery);
    row.addEventListener("click", () => {
      app.fecharModalPesquisaCompleta();
      app.selecionarItemAutocomplete(item);
    });
    return row;
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
            <div class="w-10 h-10 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-500 mb-1">
              <i data-lucide="search-x" class="w-5 h-5" aria-hidden="true"></i>
            </div>
            <p class="text-sm font-semibold text-slate-200" role="status" aria-live="polite">Nenhum equipamento localizado</p>
            <p class="text-xs text-slate-500 max-w-sm">Nenhum registro com o termo <span class="font-mono text-cyan-400 font-bold">"${escapeHtml(currentQuery)}"</span> foi encontrado no inventário do SEBRAE/PR.</p>
            <button type="button" data-on-click="cadastrarNovoSerialPesquisado" class="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition shadow-lg">
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

    items.forEach((item, index) => list.appendChild(criarLinhaAutocomplete(item, index, currentQuery)));

    box.classList.remove("hidden");
    ajustarAlturaAutocomplete();
    lucide.createIcons({ root: box });
  }

  function abrirPesquisaCompleta() {
    const query = (document.getElementById("input-serial").value || "").trim();
    if (query.length < 2) {
      app.showToast("Digite ao menos 2 caracteres para pesquisar", "warning");
      return;
    }

    const requestId = pesquisaCompletaState.requestId + 1;
    pesquisaCompletaState = { query, categoria: "", cidade: "", offset: 0, total: 0, loading: false, requestId };
    document.getElementById("pesquisa-completa-termo").textContent = query;
    document.getElementById("pesquisa-completa-contagem").textContent = "Buscando...";
    document.getElementById("pesquisa-completa-status").textContent = "Carregando resultados...";
    const resultList = document.getElementById("pesquisa-completa-lista");
    resultList.replaceChildren();
    resultList.scrollTop = 0;
    document.getElementById("btn-carregar-mais-pesquisa").classList.add("hidden");
    document.getElementById("filtro-pesquisa-categoria").value = "";
    document.getElementById("filtro-pesquisa-cidade").value = "";
    document.getElementById("btn-limpar-filtros-pesquisa").classList.add("hidden");

    app.abrirModalAcessivel("modal-pesquisa-completa", "#btn-fechar-pesquisa-completa", "fecharModalPesquisaCompleta");
    app.fecharAutocomplete();
    carregarResultadosPesquisaCompleta(false, requestId);
  }

  function preencherOpcoesFiltroPesquisa(selectId, values, defaultLabel, selectedValue) {
    const select = document.getElementById(selectId);
    select.replaceChildren(new Option(defaultLabel, ""));
    values.forEach(value => select.add(new Option(value, value)));
    select.value = values.includes(selectedValue) ? selectedValue : "";
    return select.value;
  }

  function atualizarOpcoesFiltrosPesquisa(filters = {}) {
    const categorySelect = document.getElementById("filtro-pesquisa-categoria");
    const selectedCategory = pesquisaCompletaState.categoria;
    const categories = filters.categories || [
      { value: "notebook", label: "Notebooks" },
      { value: "macbook", label: "MacBooks" },
      { value: "monitor", label: "Monitores" },
      { value: "fone", label: "Fones" },
    ];
    categorySelect.replaceChildren(new Option("Todas as categorias", ""));
    categories.forEach(({ value, label, count }) => {
      const suffix = Number.isFinite(count) ? ` (${count})` : "";
      categorySelect.add(new Option(`${label}${suffix}`, value));
    });
    categorySelect.value = categories.some(({ value }) => value === selectedCategory) ? selectedCategory : "";
    pesquisaCompletaState.categoria = categorySelect.value;
    pesquisaCompletaState.cidade = preencherOpcoesFiltroPesquisa(
      "filtro-pesquisa-cidade",
      filters.cities || [],
      "Todas as cidades",
      pesquisaCompletaState.cidade,
    );
    document.getElementById("btn-limpar-filtros-pesquisa").classList.toggle(
      "hidden",
      !pesquisaCompletaState.categoria && !pesquisaCompletaState.cidade,
    );
  }

  function alterarFiltrosPesquisaCompleta() {
    if (pesquisaCompletaState.loading) return;
    const categoria = document.getElementById("filtro-pesquisa-categoria").value;
    const cidade = document.getElementById("filtro-pesquisa-cidade").value;
    if (categoria === pesquisaCompletaState.categoria && cidade === pesquisaCompletaState.cidade) return;

    pesquisaCompletaState.categoria = categoria;
    pesquisaCompletaState.cidade = cidade;
    pesquisaCompletaState.offset = 0;
    pesquisaCompletaState.total = 0;
    pesquisaCompletaState.requestId += 1;
    const resultList = document.getElementById("pesquisa-completa-lista");
    resultList.replaceChildren();
    resultList.scrollTop = 0;
    document.getElementById("pesquisa-completa-contagem").textContent = "Buscando...";
    document.getElementById("btn-carregar-mais-pesquisa").classList.add("hidden");
    document.getElementById("btn-limpar-filtros-pesquisa").classList.toggle("hidden", !categoria && !cidade);
    carregarResultadosPesquisaCompleta(false, pesquisaCompletaState.requestId);
  }

  function limparFiltrosPesquisaCompleta() {
    document.getElementById("filtro-pesquisa-categoria").value = "";
    document.getElementById("filtro-pesquisa-cidade").value = "";
    app.alterarFiltrosPesquisaCompleta();
  }

  async function carregarResultadosPesquisaCompleta(carregarMais = false, requestId = pesquisaCompletaState.requestId) {
    if (pesquisaCompletaState.loading || requestId !== pesquisaCompletaState.requestId) return;

    const modal = document.getElementById("modal-pesquisa-completa");
    const list = document.getElementById("pesquisa-completa-lista");
    const status = document.getElementById("pesquisa-completa-status");
    const count = document.getElementById("pesquisa-completa-contagem");
    const moreButton = document.getElementById("btn-carregar-mais-pesquisa");
    const categoryFilter = document.getElementById("filtro-pesquisa-categoria");
    const cityFilter = document.getElementById("filtro-pesquisa-cidade");
    const offset = carregarMais ? pesquisaCompletaState.offset : 0;

    pesquisaCompletaState.loading = true;
    moreButton.disabled = true;
    moreButton.setAttribute("aria-busy", "true");
    categoryFilter.disabled = true;
    cityFilter.disabled = true;
    status.textContent = carregarMais ? "Carregando mais resultados..." : "Carregando resultados...";
    if (!carregarMais) list.replaceChildren();
    const stopLoading = motion?.startLoading(list, "Carregando resultados da pesquisa…") || (() => {});

    try {
      const params = new URLSearchParams({
        q: pesquisaCompletaState.query,
        offset: String(offset),
        limit: String(PESQUISA_COMPLETA_PAGINA),
        include_filters: "true",
      });
      if (pesquisaCompletaState.categoria) params.set("categoria", pesquisaCompletaState.categoria);
      if (pesquisaCompletaState.cidade) params.set("cidade", pesquisaCompletaState.cidade);
      const response = await fetch(`/api/buscar-expandida?${params.toString()}`);
      if (!response.ok) throw new Error("Não foi possível carregar os resultados da pesquisa.");

      const page = await response.json();
      if (requestId !== pesquisaCompletaState.requestId) return;
      stopLoading();

      atualizarOpcoesFiltrosPesquisa(page.filters);
      page.items.forEach((item, index) => {
        list.appendChild(criarLinhaPesquisaCompleta(item, offset + index, pesquisaCompletaState.query));
      });
      pesquisaCompletaState.offset = offset + page.items.length;
      pesquisaCompletaState.total = page.total;
      count.textContent = page.total === 1 ? "1 resultado" : `${page.total} resultados`;

      if (page.total === 0) {
        status.textContent = "Nenhum equipamento encontrado para esse termo.";
      } else if (page.has_more) {
        status.textContent = `Exibindo ${pesquisaCompletaState.offset} de ${page.total} ${pluralize(page.total, "resultado")}.`;
      } else {
        status.textContent = page.total === 1
          ? "O único resultado foi exibido."
          : `Todos os ${page.total} resultados foram exibidos.`;
      }
      moreButton.classList.toggle("hidden", !page.has_more);
      lucide.createIcons({ root: list });
    } catch (error) {
      if (requestId === pesquisaCompletaState.requestId) {
        status.textContent = "Não foi possível carregar a pesquisa. Feche a janela e tente novamente.";
        app.showToast(error.message || "Falha ao carregar resultados", "error");
      }
    } finally {
      stopLoading();
      if (requestId === pesquisaCompletaState.requestId) {
        pesquisaCompletaState.loading = false;
        moreButton.disabled = false;
        moreButton.removeAttribute("aria-busy");
        categoryFilter.disabled = false;
        cityFilter.disabled = false;
      }
    }
  }

  function carregarMaisResultadosPesquisa() {
    carregarResultadosPesquisaCompleta(true);
  }

  function fecharModalPesquisaCompleta() {
    app.fecharModalAcessivel("modal-pesquisa-completa");
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
  }

  // Search Equipment by Serial
  async function buscarSerial(equipmentHint = null) {
    const serialInput = document.getElementById("input-serial");
    const serial = serialInput.value.trim().toUpperCase();

    if (!serial) {
      app.invalidarBuscasEquipamento();
      app.limparSelecaoEquipamento();
      app.showToast("Digite uma série, apelido, modelo ou cidade", "warning");
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
      const res = await fetch(`/api/equipamento/${encodeURIComponent(serial)}`, { signal: request.signal });
      if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        if (res.status === 404 && serial.length >= 2) {
          const searchRes = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=15`, { signal: request.signal });
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          if (searchRes.ok) {
            const searchResults = await searchRes.json();
            if (equipmentLookupRequestGate.isCurrent(request.id) && searchResults.total > 0) {
              renderAutocomplete(searchResults.items, searchResults.total, searchResults.has_more);
              return;
            }
          }
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        }
        throw new Error(errData.detail || "Equipamento não encontrado na base de dados.");
      }

      const data = await res.json();
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
      app.showToast(`Equipamento ${data.serial} localizado com sucesso!`, "success");

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
    const loggedUsers = document.getElementById("card-usuarios-logados");
    loggedUsers.textContent = eq.usuarios_logados ? `Usuários logados: ${eq.usuarios_logados}` : "";
    loggedUsers.classList.toggle("hidden", !loggedUsers.textContent);
    document.getElementById("card-localizacao").textContent = app.formatarLocalAtual(eq);
    document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${eq.retirada_cnpj || 'Não especificado'}`;

    // Type is shown as text in the neutral chip; the icon only changes shape.
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
      createTextElement("span", "text-slate-400", " Selecione a Unidade de Destino e preencha o destinatário.")
    );
  }

  return {
    definirEquipamentoAtual, limparSelecaoEquipamento, invalidarBuscasEquipamento,
    invalidarDadosEquipamentoAposRestauracao, atualizarSelecaoAposSubstituirInventarios, handleSerialInput,
    handleSerialKeydown, selecionarItemAutocomplete, abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta,
    limparFiltrosPesquisaCompleta, carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta, fecharAutocomplete,
    limparSerial, buscarSerial, exibirEquipamento, formatarLocalAtual, abrirPesquisaRecente, limparPesquisasRecentes,
  };
});
