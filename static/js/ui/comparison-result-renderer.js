/** Builds comparison data lists and the detailed history result markup. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressComparisonResultRenderer = factory;
})(typeof window !== "undefined" ? window : globalThis, function createComparisonResultRenderer(context) {
  "use strict";
  const { app } = context;
  const { escapeHtml, pluralize } = context.dom;
  const { formatarNomeFonteHistorico, formatarHorarioHistorico, classesMetricaHistorico } = context.historyFormat;

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
    mudancas_usuarios: "Mudanças de usuário logado",
  };
  // Kind of logged-user change in the update summary -> visible label and text color.
  const TIPOS_MUDANCA_USUARIO = {
    substituicao_pendente: { rotulo: "Substituição do usuário manual — aguardando decisão", classe: "text-amber-300" },
    ausente_pendente: { rotulo: "Usuário sumiu do Endpoint — aguardando confirmação", classe: "text-amber-300" },
    novo_endpoint: { rotulo: "Usuário novo no Endpoint", classe: "text-emerald-300" },
    alterado_endpoint: { rotulo: "Usuário alterado no Endpoint", classe: "text-cyan-300" },
    removido_endpoint: { rotulo: "Usuário removido do Endpoint", classe: "text-amber-300" },
    manual_voltou: { rotulo: "Manual voltou a valer", classe: "text-rose-300" },
  };
  const formatarMotivoRevisao = motivo => formatarNomeFonteHistorico(motivo || "Conferir associação.")
    .replace(/\bno endpoint\b/gi, "no Endpoint");
  const formatarFonteAusencia = fonte => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint")
    .replace(/\bna Simpress\b/gi, "Simpress");
  const formatarFonteAmbigua = fonte => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint");
  const atributosLinhaComparacao = (categoria, item) => `data-comparison-category="${escapeHtml(categoria)}" data-comparison-item-id="${escapeHtml(item?.anotacao_id || "")}" data-comparison-serial="${escapeHtml(item?.serie || "")}" data-comparison-hostname="${escapeHtml(item?.computador || item?.hostname || item?.apelido || "")}"`;

  // Placeholder filled after rendering with the logged user of the serial (Endpoint, or manual when empty).
  const marcadorUsuarioLogado = context.loggedUserMarkers.marcador;

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
      mudancasUsuarios: comparison.mudancas_usuarios || [],
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
              ${index ? '<p class="mb-1 text-xs text-slate-400">Anotação anterior</p>' : ""}
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
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto || "—")}</td>
          <td class="px-3 py-2 text-amber-300">${escapeHtml((Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em || item.fonte_ausente]).filter(Boolean).map(formatarFonteAusencia).join(", "))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);
  }

  function linhasLocalidadeDivergente(divergenciasLocal, { renderizarCampoAnotacao }) {
    return divergenciasLocal.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("divergencias_local", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto)}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_detalhes || "—")}</td>
          ${renderizarCampoAnotacao(item, `o computador ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  function linhasSemAcesso(semAcesso7DiasOrdenados, { renderizarCampoAnotacao }) {
    return semAcesso7DiasOrdenados.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("sem_acesso_7_dias", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}${item.hostname_sumiu_endpoint ? `
            <span class="block font-sans text-xs text-amber-300 whitespace-normal" data-hostname-sumiu="true">Hostname sumiu do Endpoint${item.hostname_origem === "endpoint_anterior" ? " (hostname do Endpoint anterior)" : item.hostname_origem === "simpress" ? " (hostname mantido da Simpress)" : ""}</span>` : ""}${marcadorUsuarioLogado(item.serie)}</td>
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
          <td class="px-3 py-2 text-xs">${escapeHtml(formatarNomeFonteHistorico(Object.values(item.arquivos_origem || {}).join(" · ") || "—"))}</td>
        </tr>`);
  }

  function linhasApelidosConferencia(apelidosSemAtualizacao, { renderizarCampoAnotacao }) {
    return apelidosSemAtualizacao.map(item => `
        <tr class="text-slate-300" ${atributosLinhaComparacao("apelidos_sem_atualizacao", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "(vazia)")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}${marcadorUsuarioLogado(item.serie)}</td>
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
              <button type="button" data-manual-alias-action="manter" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/25 text-emerald-200 text-xs font-semibold">Manter manual</button>
              <button type="button" data-manual-alias-action="excluir" data-manual-alias-index="${index}" class="px-2 py-1 rounded-md bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-200 text-xs font-semibold">Excluir manual</button>
            </div>`
        : `<span class="text-xs text-slate-500">${resolvida ? "Concluído" : "Histórico indisponível"}</span>`;
      return `
          <tr class="text-slate-300" data-manual-alias-row="${index}" ${atributosLinhaComparacao("divergencias_apelidos_manuais", item)}>
            <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
            <td class="px-3 py-2 font-mono text-cyan-200">${escapeHtml(item.apelido_manual || "(vazio)")}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_equipamentos_detalhes || (item.detalhes_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_invall || (item.invall_encontrado ? "(vazio)" : "Série ausente"))}</td>
            <td class="px-3 py-2 text-xs" data-manual-alias-status>${escapeHtml(status)}</td>
            <td class="px-3 py-2">${actions}</td>
          </tr>`;
    });
  }

  // Decisions that leave the current user in place until the person answers; the labels follow the hold type.
  const ACOES_PENDENCIA_USUARIO = {
    substituicao_manual: [
      { decisao: "permitir", rotulo: "Permitir substituição", classe: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25 text-emerald-200" },
      { decisao: "recusar", rotulo: "Manter usuário manual", classe: "bg-slate-500/10 hover:bg-slate-500/20 border-slate-500/25 text-slate-200" },
    ],
    usuario_ausente: [
      { decisao: "remover", rotulo: "Confirmar remoção", classe: "bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/25 text-rose-200" },
      { decisao: "manter", rotulo: "Manter usuário", classe: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25 text-emerald-200" },
    ],
  };

  function acoesPendenciaUsuario(item) {
    const acoes = ACOES_PENDENCIA_USUARIO[item.pendencia_tipo];
    if (!acoes || !item.pendencia_id) return "";
    const classeBotao = "px-2 py-1 rounded-md border text-xs font-semibold";
    return `<div class="mt-2 flex flex-wrap items-center gap-1.5" data-user-hold="${escapeHtml(item.pendencia_id)}">
            ${acoes.map(acao => `<button type="button" data-user-hold-action="${acao.decisao}" class="${classeBotao} ${acao.classe}" aria-label="${escapeHtml(`${acao.rotulo}: série ${item.serie || "sem série"}`)}">${escapeHtml(acao.rotulo)}</button>`).join("")}
            <span hidden data-user-hold-status role="status" class="text-xs text-emerald-300"></span>
          </div>`;
  }

  function linhasMudancasUsuarios(mudancasUsuarios, { renderizarCampoAnotacao }) {
    const usuario = (nome, origem, pessoa) => nome
      ? `${escapeHtml(nome)}${origem === "manual" ? " (M)" : ""}${pessoa ? `<span class="block text-xs text-slate-400" data-person-name>${escapeHtml(pessoa)}</span>` : ""}`
      : '<span class="text-slate-500">(vazio)</span>';
    return mudancasUsuarios.map(item => {
      const tipo = TIPOS_MUDANCA_USUARIO[item.tipo] || { rotulo: "Mudança de usuário", classe: "text-slate-300" };
      return `
        <tr class="text-slate-300" data-user-change="${escapeHtml(item.tipo || "")}" ${atributosLinhaComparacao("mudancas_usuarios", item)}>
          <td class="px-3 py-2 font-semibold ${tipo.classe}">${escapeHtml(tipo.rotulo)}</td>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}${marcadorUsuarioLogado(item.serie, { sugestao: item.usuario_manual_arquivado })}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2">${usuario(item.usuario_anterior, item.origem_anterior, item.nome_pessoa_anterior)}</td>
          <td class="px-3 py-2">${usuario(item.usuario_novo, item.origem_nova, item.nome_pessoa_novo)}</td>
          <td class="px-3 py-2 text-slate-300">${escapeHtml(String(item.motivo || "").replace(/\bno endpoint\b/gi, "no Endpoint"))}${acoesPendenciaUsuario(item)}</td>
          ${renderizarCampoAnotacao(item, `${tipo.rotulo}, série ${item.serie || "vazia"}`)}
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

  // With several Endpoint rows for one serial, lists each hostname with its last successful check.
  // The oldest one gets a button that discards it so the remaining hostname is the one exported.
  function celulaVerificacaoAmbigua(item, permitirRemocao) {
    const registros = Array.isArray(item.registros_endpoint) ? item.registros_endpoint : [];
    if (registros.length < 2) {
      return escapeHtml(item.ultima_verificacao ? formatarHorarioHistorico(item.ultima_verificacao) : "—");
    }
    const classeBotao = "px-2 py-1 rounded-md border text-xs font-semibold";
    return `<ul class="space-y-3 min-w-[15rem]">${registros.map(registro => {
      const hostname = registro.computador || "";
      const horario = registro.ultima_verificacao ? formatarHorarioHistorico(registro.ultima_verificacao) : "—";
      const acoes = permitirRemocao && registro.mais_antigo === true
        ? `<button type="button" data-hostname-remove class="${classeBotao} bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/25 text-rose-200" aria-label="${escapeHtml(`Remover o hostname mais antigo ${hostname}, série ${registro.serie || "sem série"}`)}">Remover mais antigo</button>
            <span hidden data-hostname-removed class="text-xs text-emerald-300">Removido; vale o outro hostname</span>
            <button type="button" hidden data-hostname-restore class="${classeBotao} bg-slate-500/10 hover:bg-slate-500/20 border-slate-500/25 text-slate-200" aria-label="${escapeHtml(`Desfazer a remoção do hostname ${hostname}`)}">Desfazer</button>`
        : "";
      return `<li class="flex flex-col gap-1" data-hostname-item data-hostname-serie="${escapeHtml(registro.serie || "")}" data-hostname-nome="${escapeHtml(hostname)}">
          <span class="font-mono text-slate-200 break-all">${escapeHtml(hostname || "—")}</span>
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="whitespace-nowrap text-slate-400">${escapeHtml(horario)}</span>
            ${acoes}
          </span>
        </li>`;
    }).join("")}</ul>`;
  }

  function linhasAmbiguidades(ambiguidades, registrosAmbiguos, { renderizarCampoAnotacao, permitirAnotacoes }) {
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
          <td class="px-3 py-2 ${Array.isArray(item.registros_endpoint) && item.registros_endpoint.length > 1 ? "" : "whitespace-nowrap"}">${celulaVerificacaoAmbigua(item, permitirAnotacoes === true)}</td>
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

  // Summary card -> section title it jumps to. The title id is stable because only one result is open at a time.
  const SECOES_CARTOES_RESUMO = {
    ausentes_no_endpoint: { id: "comparacao-secao-ausentes-endpoint", titulo: "Sem correspondência — Endpoint" },
    ausentes_em_detalhes: { id: "comparacao-secao-ausentes-simpress", titulo: "Sem correspondência — Simpress" },
    divergencias_local: { id: "comparacao-secao-localidade-divergente", titulo: "Localidade divergente" },
    correspondencias_ambiguas: { id: "comparacao-secao-ambiguidades", titulo: "Duplicidades e correspondências ambíguas" },
    series_sem_mapeamento: { id: "comparacao-secao-series-sem-local", titulo: "Séries sem local definido" },
    apelidos_atualizados: { id: "comparacao-secao-apelidos-atualizados", titulo: "Apelidos/hostnames atualizados — no endpoint" },
    apelidos_sem_atualizacao: { id: "comparacao-secao-linhas-conferencia", titulo: "Linhas mantidas para conferência" },
    divergencias_apelidos_manuais: { id: "comparacao-secao-apelidos-manuais", titulo: "Divergências com apelidos alterados manualmente" },
    mudancas_usuarios: { id: "comparacao-secao-mudancas-usuarios", titulo: "Mudanças de usuário logado" },
  };

  function tituloSecaoComparacao(titulo, tom, idSecao = "") {
    const alvo = idSecao ? ` id="${idSecao}" tabindex="-1"` : "";
    return `<h4${alvo} class="flex items-center gap-2 text-sm font-bold text-white"><span class="h-2 w-2 shrink-0 rounded-full ${PONTOS_SECAO[tom]}" aria-hidden="true"></span>${escapeHtml(titulo)}</h4>`;
  }

  // Cards with a count above zero and a matching section become buttons that scroll to it; the rest stay static.
  function cartaoMetricaComparacao(rotulo, valor, tom, idNumero = "", chaveSecao = "") {
    const classes = classesMetricaHistorico(valor, tom);
    const numero = Number(valor || 0);
    const conteudo = `<p class="text-xs uppercase tracking-wide text-slate-400">${escapeHtml(rotulo)}</p><p${idNumero ? ` id="${idNumero}"` : ""} class="text-xl font-bold mt-1 ${classes.numero}">${numero.toLocaleString("pt-BR")}</p>`;
    const secao = SECOES_CARTOES_RESUMO[chaveSecao];
    if (!secao || numero <= 0) {
      return `<div class="rounded-xl p-3 ${classes.cartao}" data-metric-tone="${tom || ""}">${conteudo}</div>`;
    }
    return `<button type="button" class="comparison-metric-link rounded-xl p-3 ${classes.cartao}" data-metric-tone="${tom || ""}" data-comparison-section-target="${secao.id}" aria-label="${escapeHtml(`${rotulo}: ${numero.toLocaleString("pt-BR")}. Ir para ${secao.titulo}`)}">${conteudo}</button>`;
  }

  function conteudoAnotacoesSincronizadas(comparison, colunas) {
    const barra = barraFiltrosHistorico(comparison);
    const anotacoesSincronizadasRows = linhasAnotacoesSincronizadas(comparison.anotacoes_sincronizadas || [], colunas);
    return `
          ${barra}
          <p class="notice notice-info">Este clone contém as anotações sincronizadas. O resultado original e os arquivos da comparação não estão armazenados neste dispositivo.</p>
          <section class="space-y-2" data-history-filter-section>
            <div>${tituloSecaoComparacao("Anotações sincronizadas", "neutro")}<p class="text-xs text-slate-500">Anotações feitas nas linhas desta atualização, com a seção e a linha a que pertencem.</p></div>
            ${renderizarTabelaComparacao(["Seção", "Linha", "Anotações"], anotacoesSincronizadasRows, "Nenhuma anotação sincronizada neste resultado.", "anotacoes_sincronizadas")}
          </section>`;
  }

  function conteudoResultadoComparacao(comparison, listas, colunas) {
    const {
      ausentesEndpoint, ausentesDetalhes, divergenciasLocal, seriesSemMapa, semAcesso7DiasOrdenados, ambiguidades,
      registrosAmbiguos, apelidosAtualizados, apelidosSemAtualizacao, divergenciasApelidosManuais, mudancasUsuarios,
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
    const userChangeRows = linhasMudancasUsuarios(mudancasUsuarios, colunas);
    const contarMudancas = tipo => mudancasUsuarios.filter(item => item.tipo === tipo).length;
    // Results saved before the user summary existed have no list; the section is shown only when it exists.
    const secaoMudancasUsuarios = Array.isArray(comparison.mudancas_usuarios) ? `
        <section class="space-y-2" data-history-filter-section data-user-change-summary>
          <div>${tituloSecaoComparacao("Mudanças de usuário logado", "emerald", SECOES_CARTOES_RESUMO.mudancas_usuarios.id)}<p class="text-xs text-slate-500">Usuários logados que mudaram nesta atualização, comparando o Endpoint anterior com o novo. Quando o Endpoint passa a informar um usuário onde há um usuário manual (M), ou deixa de informar um usuário que já existia, nada muda sozinho: o usuário atual continua valendo até você decidir. Troca de um usuário do Endpoint por outro é aplicada automaticamente.</p>
            <p class="text-xs text-slate-400" data-user-change-counts>${[
              ["Novos no Endpoint", contarMudancas("novo_endpoint")],
              ["Alterados", contarMudancas("alterado_endpoint")],
              ["Removidos do Endpoint", contarMudancas("removido_endpoint")],
              ["Manuais que voltaram a valer", contarMudancas("manual_voltou")],
            ].map(([rotulo, total]) => `${rotulo}: ${total.toLocaleString("pt-BR")}`).join(" · ")}</p></div>
          <details open class="space-y-2" data-user-change-details>
            <summary class="cursor-pointer select-none text-xs font-semibold text-slate-300 hover:text-white">
              <span data-user-change-toggle-label>Minimizar lista de usuários alterados</span>
            </summary>
            ${renderizarTabelaComparacao(["Mudança", "Série", "Hostname/Apelido", "Usuário anterior", "Usuário novo", "Motivo", ...annotationHeaders], userChangeRows, "Nenhum usuário logado mudou nesta atualização.", "mudancas_usuarios")}
          </details>
        </section>` : "";
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
          ${cartaoMetricaComparacao("Sem correspondência — no endpoint", ausentesEndpoint.length, "amber", "", "ausentes_no_endpoint")}
          ${cartaoMetricaComparacao("Sem correspondência — na Simpress", ausentesDetalhes.length, "amber", "", "ausentes_em_detalhes")}
          ${cartaoMetricaComparacao("Divergências de local", divergenciasLocal.length, "amber", "", "divergencias_local")}
          ${cartaoMetricaComparacao("Duplicidades e ambiguidades", ambiguityRows.length, "rose", "", "correspondencias_ambiguas")}
          ${cartaoMetricaComparacao("Séries sem mapeamento", seriesSemMapa.length, "amber", "", "series_sem_mapeamento")}
          ${cartaoMetricaComparacao("Apelidos/hostnames atualizados", apelidosAtualizados.length, "emerald", "", "apelidos_atualizados")}
          ${cartaoMetricaComparacao("Apelidos para conferência", apelidosSemAtualizacao.length, "amber", "", "apelidos_sem_atualizacao")}
          ${cartaoMetricaComparacao("Divergências manuais pendentes", divergenciasApelidosManuais.filter(item => !item.resolucao || item.resolucao === "pendente").length, "rose", "comparacao-divergencias-manuais-pendentes", "divergencias_apelidos_manuais")}
          ${secaoMudancasUsuarios ? cartaoMetricaComparacao("Mudanças de usuário", mudancasUsuarios.length, "emerald", "", "mudancas_usuarios") : ""}
        </div>
        ${secaoMudancasUsuarios}
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Apelidos/hostnames atualizados — no endpoint", "emerald", SECOES_CARTOES_RESUMO.apelidos_atualizados.id)}<p class="text-xs text-slate-500">Equipamentos cujo apelido ou hostname mudou nesta atualização, com o valor anterior e o novo, identificados pela série.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido anterior", "Novo apelido / hostname", "Horário", "Arquivos de origem"], aliasUpdateRows, "Nenhum apelido ou hostname mudou nesta atualização.")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Linhas mantidas para conferência", "amber", SECOES_CARTOES_RESUMO.apelidos_sem_atualizacao.id)}<p class="text-xs text-slate-500">Série(s) vazia(s) não é escolhida automaticamente; o apelido atual fica preservado.${permitirAnotacoes ? " As anotações continuam vinculadas a esta linha e atualização. Em novas atualizações, são reaplicadas somente quando os dados correspondem exatamente na mesma seção e a anotação mais recente não está vazia ou em conflito." : ""}</p></div>
          ${renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma linha de apelido precisa de conferência.", "apelidos_sem_atualizacao")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Divergências com apelidos alterados manualmente", "rose", SECOES_CARTOES_RESUMO.divergencias_apelidos_manuais.id)}<p class="text-xs text-slate-500">Apelidos marcados com (M), definidos manualmente, que constam nas planilhas enviadas. O apelido (M) continua valendo sobre as planilhas até você decidir. Escolha “Manter manual” para confirmar a identificação (M) ou “Excluir manual” para voltar ao valor das planilhas.</p></div>
          ${renderizarTabelaComparacao(["Série", "Apelido manual", "na Simpress", "no endpoint", "Situação", "Ação"], manualAliasRows, "Nenhuma divergência entre apelidos manuais e as planilhas enviadas.", "divergencias_apelidos_manuais")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Sem acesso há 7 dias ou mais", "amber")}<p class="text-xs text-slate-500">Notebooks cuja última verificação com êxito ocorreu há 7 dias ou mais, contados a partir desta atualização.</p><p class="text-xs text-slate-500">Para remover computadores com hostname duplicado (o mais antigo) ou sem uso há muito tempo, acesse o <a href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/agent/som/computers" target="_blank" rel="noopener noreferrer" data-endpoint-computers-link class="text-sky-400 underline hover:text-sky-300">Endpoint Central (Computadores)</a>.</p><p class="text-xs text-slate-400">Atualização usada como referência: ${comparison.horario_comparacao ? `<time datetime="${escapeHtml(comparison.horario_comparacao)}">${escapeHtml(formatarHorarioHistorico(comparison.horario_comparacao))}</time>` : "data e hora indisponíveis"}.</p></div>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Última verificação com êxito", "Dias sem verificação", "Linha no endpoint", ...annotationHeaders], semAcessoRows, "Nenhum notebook está há 7 dias ou mais sem verificação com êxito.", "sem_acesso_7_dias")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Equipamentos sem correspondência por fonte", "amber")}<p class="text-xs text-slate-500">Equipamentos que não foram encontrados de forma segura em uma das fontes: Endpoint ou Simpress. Cada lista indica a fonte onde falta o registro.</p></div>
          <div class="history-filter-group space-y-2" data-history-filter-group="ausentes_no_endpoint">
            <h5 id="${SECOES_CARTOES_RESUMO.ausentes_no_endpoint.id}" tabindex="-1" class="text-xs font-semibold text-slate-300">Sem correspondência — Endpoint (${ausentesEndpoint.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesEndpoint, "ausentes_no_endpoint", colunas), "Todos os equipamentos têm correspondência segura com Endpoint.")}
          </div>
          <div class="history-filter-group space-y-2" data-history-filter-group="ausentes_em_detalhes">
            <h5 id="${SECOES_CARTOES_RESUMO.ausentes_em_detalhes.id}" tabindex="-1" class="text-xs font-semibold text-slate-300">Sem correspondência — Simpress (${ausentesDetalhes.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesDetalhes, "ausentes_em_detalhes", colunas), "Todos os equipamentos têm correspondência segura com Simpress.")}
          </div>
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Localidade divergente", "amber", SECOES_CARTOES_RESUMO.divergencias_local.id)}<p class="text-xs text-slate-500">Equipamentos cujo local cadastrado na Simpress é diferente do local previsto pelo prefixo da série.</p></div>
          ${renderizarTabelaComparacao(["Computador", "Série", "Local previsto", "Local na Simpress", ...annotationHeaders], locationRows, "Nenhuma divergência de localidade encontrada.", "divergencias_local")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Duplicidades e correspondências ambíguas", "rose", SECOES_CARTOES_RESUMO.correspondencias_ambiguas.id)}<p class="text-xs text-slate-500">Séries ou hostnames repetidos, ou que não identificam um único equipamento.</p></div>
          ${renderizarTabelaComparacao(["Ocorrência", "Série ou hostname/Apelido", "Fontes", "Última verificação com êxito", "Tratamento", ...annotationHeaders], ambiguityRows, "Nenhuma duplicidade ou correspondência ambígua encontrada.", "correspondencias_ambiguas")}
        </section>
        <section class="space-y-2" data-history-filter-section>
          <div>${tituloSecaoComparacao("Séries sem local definido", "amber", SECOES_CARTOES_RESUMO.series_sem_mapeamento.id)}<p class="text-xs text-slate-500">Prefixos de série sem local cadastrado, com a quantidade de equipamentos e exemplos.</p></div>
          ${renderizarTabelaComparacao(["Série", "Quantidade", "Exemplos", ...annotationHeaders], unmappedRows, "Todas as séries têm mapeamento de localidade.", "series_sem_mapeamento")}
        </section>
        <p class="text-xs text-slate-400">Equipamentos carregados na Simpress: ${Number(comparison.total_equipamentos_carregados || 0).toLocaleString("pt-BR")}. Backup das versões anteriores: <span class="font-mono">data/planilhas_entrada/${escapeHtml(comparison.backup_diretorio || "_backups")}</span>.</p>
      `;
  }



  return { listasComparacao, criarColunasAnotacao, conteudoAnotacoesSincronizadas, conteudoResultadoComparacao, SECOES_CARTOES_RESUMO };
});
