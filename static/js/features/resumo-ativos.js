/** Resumo (painel de ferramenta "comparacao"): ativos por regional, com filtro por categoria, só com a API local (/api/painel). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).resumoAtivos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createResumoAtivos(context) {
  "use strict";
  const { motion } = context;
  const VISIBLE_REGIONS = 8;
  let dashboard = null;
  let filter = "todos";
  let expanded = true; // por padrão mostra todas as regionais; "Ver menos" recolhe para o top 8

  function list(value) { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : []; }
  function number(value) {
    if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  const format = value => value.toLocaleString("pt-BR");
  const byTotal = (left, right) => right.total - left.total || left.name.localeCompare(right.name, "pt-BR");

  function categories() {
    return list(dashboard?.por_categoria)
      .map(item => ({ value: String(item.value || ""), label: String(item.label || ""), total: number(item.total) ?? 0 }))
      .filter(item => item.value && item.label);
  }

  function regions() {
    const source = filter === "todos" ? dashboard?.cidades_principais : dashboard?.cidades_por_categoria?.[filter];
    return list(source)
      .map(item => ({ name: String(item.cidade || "Sem cidade"), total: number(item.total) ?? 0 }))
      .sort(byTotal);
  }

  function renderFilters() {
    const target = document.getElementById("resumo-regionais-filtros");
    if (!target) return;
    const options = [{ value: "todos", label: "Todos", total: number(dashboard?.total_equipamentos) ?? 0 }, ...categories()];
    // Filtro que sumiu ou ficou sem ativos volta para "Todos" (a pílula dele fica desabilitada).
    if (!options.some(option => option.value === filter && (option.value === "todos" || option.total > 0))) filter = "todos";
    target.replaceChildren(...options.map(option => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "ck-pilula";
      pill.dataset.categoria = option.value;
      pill.setAttribute("aria-pressed", String(option.value === filter));
      pill.disabled = option.value !== "todos" && option.total === 0;
      const count = document.createElement("span");
      count.className = "ck-pilula__n";
      count.textContent = format(option.total);
      pill.append(option.label, " ", count);
      pill.addEventListener("click", () => {
        filter = option.value;
        expanded = true;
        renderRegions();
        // As pílulas são recriadas: devolve o foco à escolhida para quem usa teclado.
        [...target.children].find(item => item.dataset.categoria === filter)?.focus?.();
      });
      return pill;
    }));
  }

  function renderRegions() {
    const target = document.getElementById("resumo-regionais");
    const meta = document.getElementById("resumo-regionais-contagem");
    const more = document.getElementById("resumo-regionais-mais");
    if (!target) return;
    renderFilters();
    const cities = regions();
    const label = categories().find(item => item.value === filter)?.label;
    if (meta) {
      const sum = cities.reduce((total, city) => total + city.total, 0);
      meta.textContent = cities.length ? `${format(sum)} ${sum === 1 ? "ativo" : "ativos"} em ${format(cities.length)} ${cities.length === 1 ? "regional" : "regionais"}` : "";
    }
    if (more) more.hidden = cities.length <= VISIBLE_REGIONS;
    if (!cities.length) {
      target.removeAttribute("style");
      target.textContent = label ? `Nenhum ativo de ${label} na base local.` : "A distribuição por cidade não está disponível.";
      return;
    }
    const shown = expanded ? cities : cities.slice(0, VISIBLE_REGIONS);
    if (more) {
      more.textContent = expanded ? "Ver menos" : `Ver todas as ${format(cities.length)} regionais`;
      more.setAttribute("aria-expanded", String(expanded));
    }
    // Duas colunas no desktop, preenchidas de cima para baixo (a ordem do ranking continua na leitura).
    target.style.setProperty("--linhas", String(Math.ceil(shown.length / 2)));
    const maximum = Math.max(...shown.map(item => item.total), 1);
    target.replaceChildren(...shown.map(city => {
      const row = document.createElement("div");
      row.className = "ck-barra";
      const name = document.createElement("span");
      name.className = "ck-barra__nome";
      name.textContent = city.name;
      name.title = city.name;
      const track = document.createElement("span");
      track.className = "ck-barra__trilho";
      track.setAttribute("aria-hidden", "true");
      const bar = document.createElement("span");
      bar.className = "ck-barra__cheio";
      bar.style.width = `${Math.max(2, (city.total / maximum) * 100)}%`;
      track.appendChild(bar);
      const count = document.createElement("span");
      count.className = "ck-barra__valor";
      count.textContent = format(city.total);
      row.append(name, track, count);
      return row;
    }));
  }

  async function carregarRegionaisResumo() {
    const target = document.getElementById("resumo-regionais");
    if (!target) return;
    target.dataset.estado = "carregando";
    const stopLoading = motion?.startLoading(target, "Carregando dados da base local…") || (() => {});
    try {
      const response = await fetch("/api/painel", { cache: "no-store" });
      if (!response.ok) throw new Error("Não foi possível consultar o painel local.");
      dashboard = await response.json();
      target.dataset.estado = "pronto";
      stopLoading();
      renderRegions();
    } catch {
      dashboard = null;
      target.dataset.estado = "erro";
      stopLoading();
      document.getElementById("resumo-regionais-filtros")?.replaceChildren();
      const meta = document.getElementById("resumo-regionais-contagem");
      if (meta) meta.textContent = "";
      const more = document.getElementById("resumo-regionais-mais");
      if (more) more.hidden = true;
      target.textContent = "A distribuição por regional está indisponível enquanto o servidor local não responde.";
    } finally {
      stopLoading();
      target.setAttribute("aria-busy", "false");
    }
  }

  // Chamado ao abrir o painel: recarrega o painel local e mantém o filtro escolhido.
  function carregarResumoAtivos() { return carregarRegionaisResumo(); }

  document.getElementById("resumo-regionais-mais")?.addEventListener("click", () => { expanded = !expanded; renderRegions(); });

  return { carregarResumoAtivos };
});
