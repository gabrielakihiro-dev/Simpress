/** Shared HTML and row builders for autocomplete and full equipment search. */
(function (root, factory) {
  const api = factory;
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressEquipmentSearchRenderers = api;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentSearchRenderers(context) {
  "use strict";
  const { escapeHtml, highlightMatch } = context.dom;
  // Read when rendering: app.js sets context.loggedUserMarkers after this module loads.
  const tituloManual = informadoEm => context.loggedUserMarkers?.tituloManual?.(informadoEm) || "Usuário logado informado manualmente";
  const textoAmbiguo = candidatos => context.loggedUserMarkers?.textoAmbiguo?.(candidatos) || "";

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
            <span class="text-xs sm:text-sm font-medium text-fg-secondary truncate" title="${escapeHtml(item.modelo || "")}">
              ${escapeHtml(item.modelo || "Sem modelo especificado")}
            </span>
            ${item.apelido ? `
              <span class="autocomplete-alias inline-flex items-center gap-1 text-xs font-mono px-2 py-0.5 rounded-md bg-surface-overlay/90 text-cyan-300 border border-cyan-500/30 shrink-0" title="Apelido / Hostname">
                <i data-lucide="terminal" class="w-2.5 h-2.5 text-cyan-400" aria-hidden="true"></i>
                <span>${escapeHtml(item.apelido)}</span>
              </span>
            ` : ""}
            ${String(item.usuarios_logados || "").trim() ? `
              <span class="autocomplete-user inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-overlay/90 text-fg-secondary border border-line-firm/60 shrink-0" title="${escapeHtml(item.usuarios_logados_origem === "manual" ? tituloManual(item.usuarios_logados_informado_em) : "Usuário logado no Endpoint")}">
                <i data-lucide="user" class="w-2.5 h-2.5 text-fg-subtle" aria-hidden="true"></i>
                <span>${highlightMatch(String(item.usuarios_logados).trim(), currentQuery)}${item.usuarios_logados_origem === "manual" ? " (M)" : ""}</span>
                ${item.usuarios_logados_pendencia ? '<span class="text-amber-300" data-user-pending>· aguardando decisão</span>' : ""}
              </span>
            ` : ""}
            ${String(item.nome_pessoa || "").trim() ? `
              <span class="autocomplete-user inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-surface-overlay/90 text-fg-secondary border border-line-firm/60 min-w-0" title="Nome da pessoa${item.nome_pessoa_origem === "manual" ? " informado manualmente" : " no Entra"}">
                <span class="truncate">${highlightMatch(String(item.nome_pessoa).trim(), currentQuery)}${item.nome_pessoa_origem === "manual" ? " (manual)" : ""}</span>
              </span>
            ` : ""}
            ${textoAmbiguo(item.usuarios_logados_candidatos) ? `
              <span class="autocomplete-user autocomplete-user-ambiguous inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md text-amber-300 bg-amber-500/10 border border-amber-500/25 shrink-0" title="${escapeHtml(context.loggedUserMarkers?.TITULO_AMBIGUO || "")}">
                <i data-lucide="alert-triangle" class="w-2.5 h-2.5 text-amber-400" aria-hidden="true"></i>
                <span>${highlightMatch(textoAmbiguo(item.usuarios_logados_candidatos), currentQuery)}</span>
              </span>
            ` : ""}
            ${item.invall_alias_status && item.invall_alias_status !== "aplicado" ? `
              <span class="text-xs text-amber-200 shrink-0" title="${escapeHtml(item.invall_alias_detail || "Conferir associação com a InvAll")}">Conferir InvAll</span>
            ` : ""}
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0 ml-2">
          <div class="flex items-center gap-1 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 px-2.5 py-1 rounded-lg font-medium" title="Cidade / Unidade Atual">
            <i data-lucide="map-pin" class="w-3.5 h-3.5 text-amber-400 shrink-0" aria-hidden="true"></i>
            <span>${escapeHtml(item.retirada_cidade || "PR")}</span>
          </div>
          <div class="hidden sm:flex items-center text-xs text-fg-subtle group-hover:text-cyan-300 transition-colors ml-1 font-mono">
            <span class="text-xs mr-1 hidden lg:inline opacity-70">Selecionar</span>
            <kbd class="px-1.5 py-0.5 text-xs bg-surface-overlay border border-line-control rounded text-fg-tertiary shadow-sm">↵</kbd>
          </div>
        </div>
      `;
  }

  function conteudoLinhaAutocomplete(item, currentQuery) {
    const serial = String(item.serial || "").trim();
    const usuario = String(item.usuarios_logados || "").trim();
    const usuarioTexto = usuario
      ? `${usuario}${item.usuarios_logados_origem === "manual" ? " (M)" : ""}`
      : textoAmbiguo(item.usuarios_logados_candidatos);
    const detalhe = [item.modelo, usuarioTexto].filter(Boolean).join(" · ");
    const dotClass = usuario ? "autocomplete-dot--ok" : "autocomplete-dot--warn";
    return `
        <span class="autocomplete-dot ${dotClass}" aria-hidden="true"></span>
        <div class="autocomplete-row-main">
          <span class="autocomplete-row-serial">${highlightMatch(serial, currentQuery)}</span>
          <span class="autocomplete-row-detail" title="${escapeHtml(detalhe)}">${escapeHtml(detalhe)}</span>
        </div>
        <span class="autocomplete-row-city">${escapeHtml(item.retirada_cidade || "PR")}</span>
      `;
  }

  function criarLinhaAutocomplete(item, index, currentQuery, { onSelect, onHighlight }) {
    const row = document.createElement("div");
    row.id = `autocomplete-option-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.className = "autocomplete-row cockpit-autocomplete-row";
    row.onclick = onSelect;
    row.onmouseenter = onHighlight;
    row.innerHTML = conteudoLinhaAutocomplete(item, currentQuery);
    return row;
  }

  function criarLinhaPesquisaCompleta(item, index, currentQuery, onSelect) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "autocomplete-row group w-full text-left px-4 py-2.5 cursor-pointer flex items-center justify-between gap-3 rounded-lg";
    row.setAttribute("aria-label", [
      "Selecionar equipamento",
      item.serial,
      item.tipo,
      item.modelo,
      item.apelido,
      item.usuarios_logados ? `usuário ${String(item.usuarios_logados).trim()}` : "",
      item.nome_pessoa ? `nome ${String(item.nome_pessoa).trim()}` : "",
      textoAmbiguo(item.usuarios_logados_candidatos),
      item.retirada_cidade,
    ].filter(Boolean).join(", "));
    row.dataset.resultIndex = String(index);
    row.innerHTML = conteudoLinhaResultado(item, currentQuery);
    row.addEventListener("click", onSelect);
    return row;
  }

  return { criarLinhaAutocomplete, criarLinhaPesquisaCompleta };
});
