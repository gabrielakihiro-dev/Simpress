/** Histórico de Planilhas result dialog: renders each comparison section, its filters and per-row annotations, and manual alias decisions. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).comparisonResult = factory;
})(typeof window !== "undefined" ? window : globalThis, function createComparisonResult(context) {
  "use strict";
  const { app, appState, motion } = context;
  const { escapeHtml, pluralize } = context.dom;
  const { formatarNomeFonteHistorico, formatarHorarioHistorico, classesMetricaHistorico } = context.historyFormat;

  let comparisonAnnotationSyncObservers = [];

  // SEBRAE's own equipment, hidden from results saved before the update filters existed.
  const SERIES_SEBRAE = new Set([
    "BRJ135P5XS",
    "BRJ142QKBQ",
    "BRJ9435VMR",
    "BRJ9435VMF",
    "BRJ149SCJG",
  ]);
  const CATEGORIAS_ANOTACOES_SINCRONIZADAS = {
    sem_acesso_7_dias: "Sem acesso há 7 dias ou mais",
    ausentes_no_endpoint: "Sem correspondência — Endpoint",
    ausentes_em_detalhes: "Sem correspondência — Simpress",
    divergencias_local: "Localidade divergente",
    correspondencias_ambiguas: "Duplicidades e correspondências ambíguas",
    registros_ambiguos: "Duplicidades e correspondências ambíguas",
    series_sem_mapeamento: "Séries sem local definido",
    apelidos_sem_atualizacao: "Linhas mantidas para conferência",
    divergencias_apelidos_manuais: "Apelidos manuais divergentes",
  };
  const formatarMotivoRevisao = motivo => formatarNomeFonteHistorico(motivo || "Conferir associação.")
    .replace(/\bno endpoint\b/gi, "no Endpoint");
  const formatarFonteAusencia = fonte => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint")
    .replace(/\bna Simpress\b/gi, "Simpress");
  const formatarFonteAmbigua = fonte => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint");
  const atributosLinhaComparacao = (categoria, item) => `data-comparison-category="${escapeHtml(categoria)}" data-comparison-item-id="${escapeHtml(item?.anotacao_id || "")}" data-comparison-serial="${escapeHtml(item?.serie || "")}" data-comparison-hostname="${escapeHtml(item?.computador || item?.hostname || item?.apelido || "")}"`;

  function renderizarTabelaComparacao(headers, rows, emptyMessage, filterCategory = "") {
    const wrapFilterGroup = markup => filterCategory
      ? `<div class="history-filter-group space-y-2" data-history-filter-group="${escapeHtml(filterCategory)}">${markup}</div>`
      : markup;
    if (!rows.length) {
      return wrapFilterGroup(`<p class="text-sm text-slate-400 text-center py-5" role="status" aria-live="polite">${escapeHtml(emptyMessage)}</p>`);
    }
    const tableLabel = `Tabela de ${headers.join(", ")}`;
    const mobileCards = rows.map((row, index) => {
      const template = document.createElement("template");
      template.innerHTML = row.trim();
      const sourceRow = template.content.querySelector("tr");
      const cells = Array.from(sourceRow?.cells || []);
      if (!cells.length) return "";

      const titleLabel = headers[0] || "Registro";
      const titleText = cells[0].textContent.trim() || `Registro ${index + 1}`;
      const titleContent = cells[0].innerHTML || escapeHtml(titleText);
      const manualAliasRow = sourceRow.hasAttribute("data-manual-alias-row")
        ? ` data-manual-alias-row="${escapeHtml(sourceRow.dataset.manualAliasRow)}"`
        : "";
      const comparisonTargetAttributes = [
        "data-comparison-category",
        "data-comparison-item-id",
        "data-comparison-serial",
        "data-comparison-hostname",
      ].map(attribute => {
        const value = sourceRow.getAttribute(attribute);
        return value === null ? "" : ` ${attribute}="${escapeHtml(value)}"`;
      }).join("");
      const fields = cells.slice(1).map((cell, cellIndex) => {
        const label = headers[cellIndex + 1] || `Campo ${cellIndex + 2}`;
        const annotationClass = cell.querySelector("[data-comparison-annotation]")
          ? " comparison-mobile-card-field--annotation"
          : "";
        const manualAliasStatus = cell.hasAttribute("data-manual-alias-status")
          ? " data-manual-alias-status"
          : "";
        return `
            <div class="comparison-mobile-card-field${annotationClass}">
              <dt>${escapeHtml(label)}</dt>
              <dd${manualAliasStatus}>${cell.innerHTML}</dd>
            </div>`;
      }).join("");

      return `
          <article class="comparison-mobile-card" role="listitem"${manualAliasRow}${comparisonTargetAttributes}>
            <h5 class="comparison-mobile-card-title"><span class="sr-only">${escapeHtml(titleLabel)}: </span>${titleContent}</h5>
            ${fields ? `<dl class="comparison-mobile-card-fields">${fields}</dl>` : ""}
          </article>`;
    }).join("");
    return wrapFilterGroup(`
        <div class="accessible-table-wrap comparison-desktop-table rounded-lg border border-slate-800" role="region" aria-label="${escapeHtml(tableLabel)}" tabindex="0">
          <p class="comparison-table-scroll-hint px-3 pt-2">Role a tabela horizontalmente para consultar todas as colunas.</p>
          <table class="min-w-full text-left text-sm" aria-label="${escapeHtml(tableLabel)}">
            <thead class="bg-slate-950 text-slate-300"><tr>${headers.map(header => `<th scope="col" class="px-3 py-2.5 font-semibold whitespace-nowrap">${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody class="divide-y divide-slate-800">${rows.join("")}</tbody>
          </table>
        </div>
        <div class="comparison-mobile-list" role="list" aria-label="${escapeHtml(`${tableLabel} em cartões`)}">${mobileCards}</div>`);
  }

  function abrirModalComparacaoPlanilhas(comparison, navigationTarget = null) {
    const listas = listasComparacao(comparison);
    const colunas = criarColunasAnotacao(comparison);
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
      ? conteudoAnotacoesSincronizadas(comparison, colunas)
      : conteudoResultadoComparacao(comparison, listas, colunas);
    conectarAcoesApelidosManuais(comparison, listas.divergenciasApelidosManuais);
    conectarAnotacoesComparacao(comparison);
    conectarFiltrosHistoricoComparacao(content);
    app.abrirModalAcessivel(
      "modal-comparacao-planilhas",
      '[aria-label="Fechar resultado"]',
      "fecharModalComparacaoPlanilhas",
      comparison.contexto_historico === true ? "btn-historico-comparacoes" : "btn-atualizar-planilhas",
    );
    if (navigationTarget) requestAnimationFrame(() => navegarParaLinhaComparacao(navigationTarget));
  }

  function listasComparacao(comparison) {
    const filtrosAtualizacaoAplicados = comparison.filtros_atualizacao_aplicados === true;
    const diasSemVerificacao = item => {
      const dias = Number(item?.dias_sem_verificacao);
      return Number.isFinite(dias) ? dias : 0;
    };
    return {
      ausentesEndpoint: filtrosAtualizacaoAplicados
        ? (comparison.ausentes_no_endpoint || [])
        : filtrarSeriesSebrae(comparison.ausentes_no_endpoint),
      ausentesDetalhes: filtrosAtualizacaoAplicados
        ? (comparison.ausentes_em_detalhes || [])
        : filtrarSeriesSebrae(comparison.ausentes_em_detalhes),
      divergenciasLocal: comparison.divergencias_local || [],
      seriesSemMapa: comparison.series_sem_mapeamento || [],
      semAcesso7DiasOrdenados: [...(comparison.sem_acesso_7_dias || [])].sort((a, b) =>
        diasSemVerificacao(b) - diasSemVerificacao(a)
        || String(a.computador || "").localeCompare(String(b.computador || ""), "pt-BR")
      ),
      ambiguidades: comparison.correspondencias_ambiguas || [],
      registrosAmbiguos: comparison.registros_ambiguos || [],
      apelidosAtualizados: comparison.apelidos_atualizados || [],
      apelidosSemAtualizacao: comparison.apelidos_sem_atualizacao || [],
      divergenciasApelidosManuais: comparison.divergencias_apelidos_manuais || [],
    };
  }

  function filtrarSeriesSebrae(items) {
    return (items || []).filter(item => {
      const serie = String(item.serie || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      return !SERIES_SEBRAE.has(serie);
    });
  }

  // Annotation columns exist only for results saved in the history, where every row keeps its own annotation id.
  function criarColunasAnotacao(comparison) {
    const permitirAnotacoes = Boolean(comparison.evento_id)
      && (comparison.contexto_historico === true || comparison.historico_salvo === true);
    const renderizarCampoAnotacao = (item, contexto) => {
      if (!permitirAnotacoes) return "";
      const anotacoes = [
        item,
        ...(Array.isArray(item.anotacoes_associadas)
          ? item.anotacoes_associadas.filter(anotacao => (typeof anotacao?.anotacao === "string" && anotacao.anotacao) || anotacao?.anotacao_conflito)
          : []),
      ];
      return `
        <td class="px-3 py-2 min-w-[240px] align-top">
          ${anotacoes.map((anotacao, index) => `
            <div class="${index ? "mt-2 border-t border-slate-700 pt-2" : ""}">
              ${index ? '<p class="mb-1 text-[10px] text-slate-400">Anotação anterior</p>' : ""}
              <textarea data-comparison-annotation ${app.atributosVersaoAnotacao(anotacao)} data-annotation-id="${escapeHtml(anotacao.anotacao_id || "")}" rows="2" maxlength="2000" class="annotation-field w-full min-w-[220px]" aria-label="${index ? "Anotação anterior para" : "Anotações para"} ${escapeHtml(contexto)}, neste resultado" placeholder="Escreva uma anotação...">${escapeHtml(anotacao.anotacao || "")}</textarea>
              <div class="mt-1">
                <p class="annotation-status${anotacao.anotacao ? " is-saved" : ""}" data-annotation-status aria-live="polite">${anotacao.anotacao ? "Salvo automaticamente" : ""}</p>
                <button type="button" class="annotation-retry mt-1" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button>
              </div>
            </div>`).join("")}
        </td>`;
    };
    return {
      permitirAnotacoes,
      renderizarCampoAnotacao,
      annotationHeaders: permitirAnotacoes ? ["Anotações"] : [],
      aliasReviewHeaders: ["Série", "Hostname no Endpoint", "Motivo", ...(permitirAnotacoes ? ["Anotações"] : [])],
    };
  }

  function barraFiltrosHistorico(comparison) {
    const mostrarFiltrosHistorico = comparison.historico_salvo === true
      || comparison.contexto_historico === true
      || comparison.somente_anotacoes_sincronizadas === true;
    return mostrarFiltrosHistorico ? `
        <div class="history-filter-bar" data-history-filter-bar>
          <div class="history-filter-controls">
            <label class="history-filter-search-label">Pesquisar nas divergências
              <input type="search" data-history-filter-search placeholder="Série, hostname, local ou anotação…" autocomplete="off">
            </label>
            <label class="history-filter-category-label">Tipo de divergência
              <select data-history-filter-category aria-label="Filtrar por tipo de divergência">
                <option value="">Todos os tipos</option>
              </select>
            </label>
          </div>
          <div class="history-filter-footer">
            <label class="history-filter-annotated"><input type="checkbox" data-history-filter-annotated> Somente linhas com anotação</label>
            <p data-history-filter-count role="status" aria-live="polite" aria-atomic="true"></p>
          </div>
        </div>` : "";
  }

  // Row builders: one <tr> per item; renderizarTabelaComparacao derives the mobile cards from them.
  function linhasAusentes(items, categoria, { renderizarCampoAnotacao }) {
    return items.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao(categoria, item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto || "—")}</td>
          <td class="px-3 py-2 text-amber-300">${escapeHtml((Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em || item.fonte_ausente]).filter(Boolean).map(formatarFonteAusencia).join(", "))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);
  }

  function linhasLocalidadeDivergente(divergenciasLocal, { renderizarCampoAnotacao }) {
    return divergenciasLocal.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("divergencias_local", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto)}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_detalhes || "—")}</td>
          ${renderizarCampoAnotacao(item, `o computador ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  function linhasSemAcesso(semAcesso7DiasOrdenados, { renderizarCampoAnotacao }) {
    return semAcesso7DiasOrdenados.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("sem_acesso_7_dias", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.ultima_verificacao ? formatarHorarioHistorico(item.ultima_verificacao) : "—")}</td>
          <td class="px-3 py-2">${Number(item.dias_sem_verificacao || 0).toLocaleString("pt-BR")}</td>
          <td class="px-3 py-2">${escapeHtml(String(item.linha_endpoint || "—"))}</td>
          ${renderizarCampoAnotacao(item, `o hostname ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  function linhasApelidosAtualizados(apelidosAtualizados) {
    return apelidosAtualizados.map(item => `
        <tr class="text-slate-300">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_anterior || "(vazio)")}</td>
          <td class="px-3 py-2 font-mono text-emerald-200">${escapeHtml(item.apelido_novo || "(vazio)")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.horario ? formatarHorarioHistorico(item.horario) : "—")}</td>
          <td class="px-3 py-2 text-[10px]">${escapeHtml(formatarNomeFonteHistorico(Object.values(item.arquivos_origem || {}).join(" · ") || "—"))}</td>
        </tr>`);
  }

  function linhasApelidosConferencia(apelidosSemAtualizacao, { renderizarCampoAnotacao }) {
    return apelidosSemAtualizacao.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("apelidos_sem_atualizacao", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "(vazia)")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 text-slate-300">${escapeHtml(formatarMotivoRevisao(item.motivo))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);
  }

  function linhasApelidosManuais(divergenciasApelidosManuais, comparison) {
    return divergenciasApelidosManuais.map((item, index) => {
      const resolvida = item.resolucao && item.resolucao !== "pendente";
      const status = item.resolucao === "manter"
        ? "Alteração manual mantida"
        : item.resolucao === "excluir"
          ? "Alteração manual removida"
          : item.resolucao === "substituida"
            ? "Atualizada por nova planilha"
            : "Pendente";
      const actions = !resolvida && comparison.evento_id
        ? `<div class="flex flex-wrap gap-1.5" data-manual-alias-actions>
              <button type="button" data-manual-alias-action="manter" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-200 text-[10px] font-semibold">Manter manual</button>
              <button type="button" data-manual-alias-action="excluir" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-200 text-[10px] font-semibold">Excluir manual</button>
            </div>`
        : `<span class="text-[10px] text-slate-500">${resolvida ? "Concluído" : "Histórico indisponível"}</span>`;
      return `
          <tr class="text-slate-300" data-manual-alias-row="${index}" ${atributosLinhaComparacao("divergencias_apelidos_manuais", item)}>
            <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
            <td class="px-3 py-2 font-mono text-cyan-200">${escapeHtml(item.apelido_manual || "(vazio)")}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_equipamentos_detalhes || (item.detalhes_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_invall || (item.invall_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 text-[10px]" data-manual-alias-status>${escapeHtml(status)}</td>
            <td class="px-3 py-2">${actions}</td>
          </tr>`;
    });
  }

  function linhasSeriesSemMapa(seriesSemMapa, { renderizarCampoAnotacao }) {
    return seriesSemMapa.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("series_sem_mapeamento", item)}>
          <td class="px-3 py-2 font-mono text-white">${escapeHtml(item.serie)}</td>
          <td class="px-3 py-2">${Number(item.quantidade || 0)}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml((item.exemplos || []).join(", "))}</td>
          ${renderizarCampoAnotacao(item, `a série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  function linhasAmbiguidades(ambiguidades, registrosAmbiguos, { renderizarCampoAnotacao }) {
    return [
      ...ambiguidades.map(item => ({
        ...item,
        __categoriaPendencia: "correspondencias_ambiguas",
        tipo: item.tipo,
        chave: item.chave,
        fontes: (item.fontes || []).map(source =>
          `${formatarFonteAmbigua(source.fonte)}${source.quantidade ? ` (${source.quantidade} ${pluralize(source.quantidade, "registro")})` : source.serie ? ` — série ${source.serie}` : ""}`
        ).join(" · "),
        mensagem: formatarFonteAmbigua(item.mensagem || ""),
      })),
      ...registrosAmbiguos.map(item => ({
        ...item,
        __categoriaPendencia: "registros_ambiguos",
        tipo: "Presença ambígua",
        chave: `${item.computador || "Sem hostname"} · ${item.serie || "Sem série"}`,
        fontes: Object.entries(item.fontes || {}).filter(([, status]) => status === "ambíguo").map(([source]) => formatarFonteAmbigua(source)).join(" · "),
        mensagem: formatarFonteAmbigua(item.motivo || ""),
      })),
    ].map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao(item.__categoriaPendencia, item)}>
          <td class="px-3 py-2 text-slate-300">${escapeHtml(item.tipo || "Ambiguidade")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.chave || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.fontes || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.mensagem || "")}</td>
          ${renderizarCampoAnotacao(item, `${item.tipo || "ambiguidade"}: ${item.chave || "sem identificador"}`)}
        </tr>`);
  }

  function linhasAnotacoesSincronizadas(items, { renderizarCampoAnotacao }) {
    return items.map(item => {
      const motivo = item.motivo ? formatarNomeFonteHistorico(item.motivo) : "";
      const identificador = [item.computador, item.serie && `série ${item.serie}`, motivo]
        .filter(Boolean)
        .join(" · ") || "Linha sem identificador";
      return `
          <tr class="text-slate-300" ${atributosLinhaComparacao(item.categoria, item)}>
            <td class="px-3 py-2 text-slate-300">${escapeHtml(CATEGORIAS_ANOTACOES_SINCRONIZADAS[item.categoria] || "Histórico de planilhas")}</td>
            <td class="px-3 py-2">${escapeHtml(identificador)}</td>
            ${renderizarCampoAnotacao(item, `${CATEGORIAS_ANOTACOES_SINCRONIZADAS[item.categoria] || "a linha"}, ${identificador}`)}
          </tr>`;
    });
  }

  const PONTOS_SECAO = { amber: "bg-amber-400", rose: "bg-rose-400", emerald: "bg-emerald-400", neutro: "bg-slate-500" };

  function tituloSecaoComparacao(titulo, tom) {
    return `<h4 class="flex items-center gap-2 text-sm font-bold text-white"><span class="h-2 w-2 shrink-0 rounded-full ${PONTOS_SECAO[tom]}" aria-hidden="true"></span>${escapeHtml(titulo)}</h4>`;
  }

  function cartaoMetricaComparacao(rotulo, valor, tom, idNumero = "") {
    const classes = classesMetricaHistorico(valor, tom);
    return `<div class="rounded-xl p-3 ${classes.cartao}" data-metric-tone="${tom || ""}"><p class="text-[10px] uppercase tracking-wide text-slate-400">${escapeHtml(rotulo)}</p><p${idNumero ? ` id="${idNumero}"` : ""} class="text-xl font-bold mt-1 ${classes.numero}">${Number(valor || 0).toLocaleString("pt-BR")}</p></div>`;
  }

  function conteudoAnotacoesSincronizadas(comparison, colunas) {
    const barra = barraFiltrosHistorico(comparison);
    const anotacoesSincronizadasRows = linhasAnotacoesSincronizadas(comparison.anotacoes_sincronizadas || [], colunas);
    return `
          ${barra}
          <p class="notice notice-info">Este clone contém as anotações sincronizadas. O resultado original e os arquivos da comparação não estão armazenados neste dispositivo.</p>
          <section class="space-y-2" data-history-filter-section>
            <div>${tituloSecaoComparacao("Anotações sincronizadas", "neutro")}<p class="text-[11px] text-slate-500">Anotações feitas nas linhas desta atualização, com a seção e a linha a que pertencem.</p></div>
            ${renderizarTabelaComparacao(["Seção", "Linha", "Anotações"], anotacoesSincronizadasRows, "Nenhuma anotação sincronizada neste resultado.", "anotacoes_sincronizadas")}
          </section>`;
  }

  function conteudoResultadoComparacao(comparison, listas, colunas) {
    const {
      ausentesEndpoint, ausentesDetalhes, divergenciasLocal, seriesSemMapa, semAcesso7DiasOrdenados, ambiguidades,
      registrosAmbiguos, apelidosAtualizados, apelidosSemAtualizacao, divergenciasApelidosManuais,
    } = listas;
    const { permitirAnotacoes, annotationHeaders, aliasReviewHeaders } = colunas;
    const barra = barraFiltrosHistorico(comparison);
    const aliasUpdateRows = linhasApelidosAtualizados(apelidosAtualizados);
    const aliasReviewRows = linhasApelidosConferencia(apelidosSemAtualizacao, colunas);
    const manualAliasRows = linhasApelidosManuais(divergenciasApelidosManuais, comparison);
    const semAcessoRows = linhasSemAcesso(semAcesso7DiasOrdenados, colunas);
    const locationRows = linhasLocalidadeDivergente(divergenciasLocal, colunas);
    const ambiguityRows = linhasAmbiguidades(ambiguidades, registrosAmbiguos, colunas);
    const unmappedRows = linhasSeriesSemMapa(seriesSemMapa, colunas);
    return `
        ${barra}
        ${comparison.historico_salvo === false
        ? `<p class="notice notice-warn">${escapeHtml(comparison.aviso_historico || "Não foi possível salvar este resultado no histórico de comparações.")}</p>`
        : comparison.historico_salvo === true
          ? '<p class="notice notice-info">Resultado registrado no Histórico de planilhas.</p>'
          : ""}
        ${Number(comparison.anotacoes_herdadas_enfileiradas || 0) > 0
        ? `<p class="notice notice-warn">${Number(comparison.anotacoes_herdadas_enfileiradas).toLocaleString("pt-BR")} anotações herdadas foram gravadas junto com o resultado. A sincronização com a pasta compartilhada será tentada automaticamente.</p>`
        : ""}
        <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          ${cartaoMetricaComparacao("Notebooks comparados", comparison.total_endpoint, null)}
          ${cartaoMetricaComparacao("Sem correspondência — no endpoint", ausentesEndpoint.length, "amber")}
          ${cartaoMetricaComparacao("Sem correspondência — na Simpress", ausentesDetalhes.length, "amber")}
          ${cartaoMetricaComparacao("Divergências de local", divergenciasLocal.length, "amber")}
          ${cartaoMetricaComparacao("Duplicidades e ambiguidades", ambiguityRows.length, "rose")}
          ${cartaoMetricaComparacao("Séries sem mapeamento", seriesSemMapa.length, "amber")}
          ${cartaoMetricaComparacao("Apelidos/hostnames atualizados", apelidosAtualizados.length, "emerald")}
          ${cartaoMetricaComparacao("Apelidos para conferência", apelidosSemAtualizacao.length, "amber")}
          ${cartaoMetricaComparacao("Divergências manuais pendentes", divergenciasApelidosManuais.filter(item => !item.resolucao || item.resolucao === "pendente").length, "rose", "comparacao-divergencias-manuais-pendentes")}
        </div>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Apelidos/hostnames atualizados — no endpoint", "emerald")}<p class="text-[11px] text-slate-500">Equipamentos cujo apelido ou hostname mudou nesta atualização, com o valor anterior e o novo, identificados pela série.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido anterior", "Novo apelido / hostname", "Horário", "Arquivos de origem"], aliasUpdateRows, "Nenhum apelido ou hostname mudou nesta atualização.")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Linhas mantidas para conferência", "amber")}<p class="text-[11px] text-slate-500">Série(s) vazia(s) não é escolhida automaticamente; o apelido atual fica preservado.${permitirAnotacoes ? " As anotações continuam vinculadas a esta linha e atualização. Em novas atualizações, são reaplicadas somente quando os dados correspondem exatamente na mesma seção e a anotação mais recente não está vazia ou em conflito." : ""}</p></div>
          ${renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma linha de apelido precisa de conferência.", "apelidos_sem_atualizacao")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Divergências com apelidos alterados manualmente", "rose")}<p class="text-[11px] text-slate-500">Apelidos marcados com (M), definidos manualmente, que constam nas planilhas enviadas. O apelido (M) continua valendo sobre as planilhas até você decidir. Escolha “Manter manual” para confirmar a identificação (M) ou “Excluir manual” para voltar ao valor das planilhas.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido manual", "na Simpress", "no endpoint", "Situação", "Ação"], manualAliasRows, "Nenhuma divergência entre apelidos manuais e as planilhas enviadas.", "divergencias_apelidos_manuais")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Sem acesso há 7 dias ou mais", "amber")}<p class="text-[11px] text-slate-500">Notebooks cuja última verificação com êxito ocorreu há 7 dias ou mais, contados a partir desta atualização.</p><p class="text-[11px] text-slate-400">Atualização usada como referência: ${comparison.horario_comparacao ? `<time datetime="${escapeHtml(comparison.horario_comparacao)}">${escapeHtml(formatarHorarioHistorico(comparison.horario_comparacao))}</time>` : "data e hora indisponíveis"}.</p></div>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Última verificação com êxito", "Dias sem verificação", "Linha no endpoint", ...annotationHeaders], semAcessoRows, "Nenhum notebook está há 7 dias ou mais sem verificação com êxito.", "sem_acesso_7_dias")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Equipamentos sem correspondência por fonte", "amber")}<p class="text-[11px] text-slate-500">Equipamentos que não foram encontrados de forma segura em uma das fontes: Endpoint ou Simpress. Cada lista indica a fonte onde falta o registro.</p></div>
          <div class="history-filter-group space-y-2" data-history-filter-group="ausentes_no_endpoint">
            <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — Endpoint (${ausentesEndpoint.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesEndpoint, "ausentes_no_endpoint", colunas), "Todos os equipamentos têm correspondência segura com Endpoint.")}
          </div>
          <div class="history-filter-group space-y-2" data-history-filter-group="ausentes_em_detalhes">
            <h5 class="text-xs font-semibold text-slate-300">Sem correspondência — Simpress (${ausentesDetalhes.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesDetalhes, "ausentes_em_detalhes", colunas), "Todos os equipamentos têm correspondência segura com Simpress.")}
          </div>
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Localidade divergente", "amber")}<p class="text-[11px] text-slate-500">Equipamentos cujo local cadastrado na Simpress é diferente do local previsto pelo prefixo da série.</p></div>
          ${renderizarTabelaComparacao(["Computador", "Série", "Local previsto", "Local na Simpress", ...annotationHeaders], locationRows, "Nenhuma divergência de localidade encontrada.", "divergencias_local")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Duplicidades e correspondências ambíguas", "rose")}<p class="text-[11px] text-slate-500">Séries ou hostnames repetidos, ou que não identificam um único equipamento.</p></div>
          ${renderizarTabelaComparacao(["Ocorrência", "Série ou hostname/Apelido", "Fontes", "Tratamento", ...annotationHeaders], ambiguityRows, "Nenhuma duplicidade ou correspondência ambígua encontrada.", "correspondencias_ambiguas")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Séries sem local definido", "amber")}<p class="text-[11px] text-slate-500">Prefixos de série sem local cadastrado, com a quantidade de equipamentos e exemplos.</p></div>
          ${renderizarTabelaComparacao(["Série", "Quantidade", "Exemplos", ...annotationHeaders], unmappedRows, "Todas as séries têm mapeamento de localidade.", "series_sem_mapeamento")}
        </section>
        <p class="text-[11px] text-slate-400">Equipamentos carregados na Simpress: ${Number(comparison.total_equipamentos_carregados || 0).toLocaleString("pt-BR")}. Backup das versões anteriores: <span class="font-mono">planilhas_entrada/${escapeHtml(comparison.backup_diretorio || "_backups")}</span>.</p>
      `;
  }

  function conectarAcoesApelidosManuais(comparison, divergenciasApelidosManuais) {
    document.querySelectorAll("[data-manual-alias-action]").forEach(button => {
      button.addEventListener("click", () => {
        const item = divergenciasApelidosManuais[Number(button.dataset.manualAliasIndex)];
        if (item) resolverDivergenciaApelidoManual(comparison, item, button.dataset.manualAliasAction, button);
      });
    });
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

  function navegarParaLinhaComparacao(target) {
    const content = document.getElementById("comparacao-planilhas-conteudo");
    if (!content) return;
    if (target?.section) {
      const group = [...content.querySelectorAll("[data-history-filter-group]")]
        .find(candidate => candidate.dataset.historyFilterGroup === target.section && candidate.getClientRects().length > 0);
      if (!group) return;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      // Include the section title when the section holds only this group, and stop well below the sticky filter bar.
      const section = group.closest("[data-history-filter-section]");
      const anchor = section && section.querySelectorAll("[data-history-filter-group]").length === 1 ? section : group;
      const bar = content.querySelector("[data-history-filter-bar]");
      anchor.style.scrollMarginTop = `${(bar ? bar.offsetHeight : 0) + 32}px`;
      anchor.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
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
      const response = await fetch(
        `/api/historico-comparacoes/${encodeURIComponent(comparison.evento_id)}/apelido-manual/${encodeURIComponent(item.serie)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acao }),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível resolver a divergência.");

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
        if (card) card.className = `rounded-xl p-3 ${classes.cartao}`;
      }
      matchingRows.forEach(candidate => {
        const status = candidate.querySelector("[data-manual-alias-status]");
        if (status) status.textContent = acao === "manter" ? "Alteração manual mantida" : "Alteração manual removida";
      });
      actionAreas.forEach(actionArea => {
        const concluido = document.createElement("span");
        concluido.className = "text-[10px] text-slate-500";
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

  function irParaSecaoComparacao(sectionId) {
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    return `<label class="block min-w-[220px] text-[10px] text-slate-400">Anotação sobre ${escapeHtml(contexto)}
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
