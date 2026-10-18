/** Full inventory search dialog, filters and paginated result loading. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).fullEquipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createFullEquipmentSearch(context) {
  "use strict";
  const { app, motion } = context;
  const { pluralize } = context.dom;
  const renderers = context.equipmentSearchRenderer(context);
  const PESQUISA_COMPLETA_PAGINA = 50;
  let pesquisaCompletaState = { query: "", categoria: "", cidade: "", offset: 0, total: 0, loading: false, requestId: 0 };

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
      const page = await app.apiFetch(`/api/buscar-expandida?${params.toString()}`, {
        errorMessage: "Não foi possível carregar os resultados da pesquisa.",
      });
      if (requestId !== pesquisaCompletaState.requestId) return;
      stopLoading();

      atualizarOpcoesFiltrosPesquisa(page.filters);
      page.items.forEach((item, index) => {
        list.appendChild(renderers.criarLinhaPesquisaCompleta(item, offset + index, pesquisaCompletaState.query, () => {
          app.fecharModalPesquisaCompleta();
          app.selecionarItemAutocomplete(item);
        }));
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

  return {
    abrirPesquisaCompleta, alterarFiltrosPesquisaCompleta, limparFiltrosPesquisaCompleta,
    carregarMaisResultadosPesquisa, fecharModalPesquisaCompleta,
  };
});
