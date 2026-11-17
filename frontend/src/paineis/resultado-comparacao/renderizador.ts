/** Builds comparison data lists and the detailed history result markup. */
// Port 1:1 do antigo comparison-result-renderer.js (global SimpressComparisonResultRenderer, removido): mesmo HTML, texto e ordem. Os tipos abaixo só documentam
// o formato que a fábrica lê (campos opcionais, sem validar nada em tempo de execução). Só sintaxe apagável
// (sem enum/namespace): os testes carregam este .ts direto no Node.
interface Anotacao {
  anotacao_id?: string;
  anotacao?: string;
  anotacao_conflito?: unknown;
}
interface ItemBase extends Anotacao {
  anotacoes_associadas?: Anotacao[];
  serie?: string;
  computador?: string;
  hostname?: string;
  apelido?: string;
}
interface ItemAusente extends ItemBase {
  local_previsto?: string;
  ausente_em?: string[] | string;
  fonte_ausente?: string;
}
interface ItemLocalidade extends ItemBase {
  local_previsto?: string;
  local_detalhes?: string;
}
interface ItemSemAcesso extends ItemBase {
  dias_sem_verificacao?: number | string;
  hostname_sumiu_endpoint?: boolean;
  hostname_origem?: string;
  ultima_verificacao?: string;
  linha_endpoint?: unknown;
}
interface ItemSemAcesso60 extends ItemBase {
  situacao?: string;
  dias?: number | string;
}
interface ItemApelidoAtualizado {
  serie?: string;
  apelido_anterior?: string;
  apelido_novo?: string;
  horario?: string;
  arquivos_origem?: Record<string, string>;
}
interface ItemApelidoConferencia extends ItemBase {
  motivo?: string;
}
interface ItemApelidoManual extends ItemBase {
  resolucao?: string;
  apelido_manual?: string;
  apelido_equipamentos_detalhes?: string;
  detalhes_encontrado?: boolean;
  apelido_invall?: string;
  invall_encontrado?: boolean;
}
interface ItemMudancaUsuario extends ItemBase {
  tipo?: string;
  usuario_anterior?: string;
  usuario_novo?: string;
  origem_anterior?: string;
  origem_nova?: string;
  nome_pessoa_anterior?: string;
  nome_pessoa_novo?: string;
  usuario_manual_arquivado?: string;
  motivo?: string;
  pendencia_tipo?: string;
  pendencia_id?: string;
}
interface ItemSerieSemMapa extends ItemBase {
  quantidade?: number;
  exemplos?: string[];
}
interface RegistroEndpoint {
  serie?: string;
  computador?: string;
  ultima_verificacao?: string;
  mais_antigo?: boolean;
}
interface ItemAmbiguidade extends ItemBase {
  tipo?: string;
  chave?: string;
  fontes?: { fonte?: string; quantidade?: number; serie?: string }[];
  mensagem?: string;
  registros_endpoint?: RegistroEndpoint[];
  ultima_verificacao?: string;
}
interface ItemRegistroAmbiguo extends ItemBase {
  fontes?: Record<string, string>;
  motivo?: string;
  registros_endpoint?: RegistroEndpoint[];
  ultima_verificacao?: string;
}
interface ItemSincronizado extends ItemBase {
  categoria?: string;
  motivo?: string;
}
interface ItemSemUsuario {
  apelido?: string;
  computador?: string;
  serial?: string;
  retirada_cidade?: string;
  modelo?: string;
}
// `items` fica unknown[] como em SemUsuario do estado.ts do painel; o renderizador lê cada linha como ItemSemUsuario.
export interface SemUsuarioRenderizador {
  estado: string;
  items: unknown[];
  total?: number;
}
export interface ComparacaoRenderizada {
  evento_id?: string | number;
  contexto_historico?: boolean;
  historico_salvo?: boolean;
  somente_anotacoes_sincronizadas?: boolean;
  aviso_historico?: string;
  horario_comparacao?: string;
  total_endpoint?: number;
  anotacoes_herdadas_enfileiradas?: number;
  ausentes_no_endpoint?: ItemAusente[];
  ausentes_em_detalhes?: ItemAusente[];
  divergencias_local?: ItemLocalidade[];
  series_sem_mapeamento?: ItemSerieSemMapa[];
  sem_acesso_7_dias?: ItemSemAcesso[];
  sem_acesso_60_dias?: ItemSemAcesso60[];
  correspondencias_ambiguas?: ItemAmbiguidade[];
  registros_ambiguos?: ItemRegistroAmbiguo[];
  apelidos_atualizados?: ItemApelidoAtualizado[];
  apelidos_sem_atualizacao?: ItemApelidoConferencia[];
  divergencias_apelidos_manuais?: ItemApelidoManual[];
  mudancas_usuarios?: ItemMudancaUsuario[];
  anotacoes_sincronizadas?: ItemSincronizado[];
}
export interface ListasComparacao {
  ausentesEndpoint: ItemAusente[];
  ausentesDetalhes: ItemAusente[];
  divergenciasLocal: ItemLocalidade[];
  seriesSemMapa: ItemSerieSemMapa[];
  semAcesso7DiasOrdenados: ItemSemAcesso[];
  ambiguidades: ItemAmbiguidade[];
  registrosAmbiguos: ItemRegistroAmbiguo[];
  apelidosAtualizados: ItemApelidoAtualizado[];
  apelidosSemAtualizacao: ItemApelidoConferencia[];
  divergenciasApelidosManuais: ItemApelidoManual[];
  mudancasUsuarios: ItemMudancaUsuario[];
  // Só vem do controlador, que lê o cadastro atual; sem ele a seção "Sem usuário" fica de fora.
  semUsuario?: SemUsuarioRenderizador | null;
}
interface SecaoResumo {
  id: string;
  titulo: string;
}
export interface ColunasAnotacao {
  permitirAnotacoes: boolean;
  renderizarCampoAnotacao(item: ItemBase, contexto: string): string;
  annotationHeaders: string[];
  aliasReviewHeaders: string[];
}
export interface ContextoRenderizador {
  app: { atributosVersaoAnotacao(anotacao: Anotacao): string };
  dom: {
    escapeHtml(valor: unknown): string;
    pluralize(quantidade: number, singular: string, plural?: string): string;
    infoTipHtml(rotulo: string, texto: string, opcoes?: { fim?: boolean; bloco?: boolean; id?: string }): string;
  };
  historyFormat: {
    formatarNomeFonteHistorico(valor: unknown): string;
    formatarHorarioHistorico(valor: unknown): string;
  };
  loggedUserMarkers: { marcador(serie: unknown, opcoes?: { sugestao?: unknown }): string };
}

export function criarRenderizadorResultado(context: ContextoRenderizador) {
  "use strict";
  const { app } = context;
  const { escapeHtml, pluralize, infoTipHtml } = context.dom;
  const { formatarNomeFonteHistorico, formatarHorarioHistorico } = context.historyFormat;

  const CATEGORIAS_ANOTACOES_SINCRONIZADAS: Record<string, string | undefined> = {
    sem_acesso_7_dias: "Sem acesso há 7 dias ou mais",
    sem_acesso_60_dias: "Passou de 60 dias sem acesso",
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
  const TIPOS_MUDANCA_USUARIO: Record<string, { rotulo: string; classe: string } | undefined> = {
    substituicao_pendente: { rotulo: "Substituição do usuário manual — aguardando decisão", classe: "text-amber-300" },
    ausente_pendente: { rotulo: "Usuário sumiu do Endpoint — aguardando confirmação", classe: "text-amber-300" },
    novo_endpoint: { rotulo: "Usuário novo no Endpoint", classe: "text-emerald-300" },
    alterado_endpoint: { rotulo: "Usuário alterado no Endpoint", classe: "text-cyan-300" },
    removido_endpoint: { rotulo: "Usuário removido do Endpoint", classe: "text-amber-300" },
    manual_voltou: { rotulo: "Manual voltou a valer", classe: "text-rose-300" },
  };
  const formatarMotivoRevisao = (motivo: unknown) => formatarNomeFonteHistorico(motivo || "Conferir associação.")
    .replace(/\bno endpoint\b/gi, "no Endpoint");
  const formatarFonteAusencia = (fonte: unknown) => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint")
    .replace(/\bna Simpress\b/gi, "Simpress");
  const formatarFonteAmbigua = (fonte: unknown) => formatarNomeFonteHistorico(fonte)
    .replace(/\bno endpoint\b/gi, "Endpoint");
  const atributosLinhaComparacao = (categoria: string | undefined, item: ItemBase | undefined) => `data-comparison-category="${escapeHtml(categoria)}" data-comparison-item-id="${escapeHtml(item?.anotacao_id || "")}" data-comparison-serial="${escapeHtml(item?.serie || "")}" data-comparison-hostname="${escapeHtml(item?.computador || item?.hostname || item?.apelido || "")}"`;

  // Placeholder filled after rendering with the logged user of the serial (Endpoint, or manual when empty).
  const marcadorUsuarioLogado = context.loggedUserMarkers.marcador;

  function renderizarTabelaComparacao(headers: string[], rows: string[], emptyMessage: string, filterCategory = "") {
    const wrapFilterGroup = (markup: string) => filterCategory
      ? `<div class="history-filter-group space-y-2" data-history-filter-group="${escapeHtml(filterCategory)}">${markup}</div>`
      : markup;
    if (!rows.length) {
      return wrapFilterGroup(`<p class="text-sm text-fg-subtle text-center py-5" role="status" aria-live="polite">${escapeHtml(emptyMessage)}</p>`);
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
      const manualAliasRow = sourceRow!.hasAttribute("data-manual-alias-row")
        ? ` data-manual-alias-row="${escapeHtml(sourceRow!.dataset.manualAliasRow)}"`
        : "";
      const comparisonTargetAttributes = [
        "data-comparison-category",
        "data-comparison-item-id",
        "data-comparison-serial",
        "data-comparison-hostname",
      ].map(attribute => {
        const value = sourceRow!.getAttribute(attribute);
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
          <div class="comparison-mobile-card" role="listitem"${manualAliasRow}${comparisonTargetAttributes}>
            <h5 class="comparison-mobile-card-title"><span class="sr-only">${escapeHtml(titleLabel)}: </span>${titleContent}</h5>
            ${fields ? `<dl class="comparison-mobile-card-fields">${fields}</dl>` : ""}
          </div>`;
    }).join("");
    return wrapFilterGroup(`
        <div class="accessible-table-wrap comparison-desktop-table rounded-lg border border-line-quiet" role="region" aria-label="${escapeHtml(tableLabel)}" tabindex="0">
          <table class="min-w-full text-left text-sm" aria-label="${escapeHtml(tableLabel)}">
            <thead class="bg-surface text-fg-tertiary"><tr>${headers.map(header => `<th scope="col" class="px-3 py-2.5 font-semibold whitespace-nowrap">${escapeHtml(header)}</th>`).join("")}</tr></thead>
            <tbody class="divide-y divide-line-quiet">${rows.join("")}</tbody>
          </table>
        </div>
        <div class="comparison-mobile-list" role="list" aria-label="${escapeHtml(`${tableLabel} em cartões`)}">${mobileCards}</div>`);
  }

  // The backend (comparison_history_for_display) already removed SEBRAE's own series from the missing lists.
  function listasComparacao(comparison: ComparacaoRenderizada) {
    const diasSemVerificacao = (item: ItemSemAcesso | undefined) => {
      const dias = Number(item?.dias_sem_verificacao);
      return Number.isFinite(dias) ? dias : 0;
    };
    return {
      ausentesEndpoint: comparison.ausentes_no_endpoint || [],
      ausentesDetalhes: comparison.ausentes_em_detalhes || [],
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

  // Annotation columns exist only for results saved in the history, where every row keeps its own annotation id.
  function criarColunasAnotacao(comparison: ComparacaoRenderizada) {
    const permitirAnotacoes = Boolean(comparison.evento_id)
      && (comparison.contexto_historico === true || comparison.historico_salvo === true);
    const renderizarCampoAnotacao = (item: ItemBase, contexto: string) => {
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
            <div class="${index ? "mt-2 border-t border-line-control pt-2" : ""}">
              ${index ? '<p class="mb-1 text-xs text-fg-subtle">Anotação anterior</p>' : ""}
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

  function barraFiltrosHistorico(comparison: ComparacaoRenderizada) {
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
  function linhasAusentes(items: ItemAusente[], categoria: string, { renderizarCampoAnotacao }: ColunasAnotacao) {
    return items.map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao(categoria, item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto || "—")}</td>
          <td class="px-3 py-2 text-amber-300">${escapeHtml((Array.isArray(item.ausente_em) ? item.ausente_em : [item.ausente_em || item.fonte_ausente]).filter(Boolean).map(formatarFonteAusencia).join(", "))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);
  }

  function linhasLocalidadeDivergente(divergenciasLocal: ItemLocalidade[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return divergenciasLocal.map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao("divergencias_local", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador)}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_previsto)}</td>
          <td class="px-3 py-2">${escapeHtml(item.local_detalhes || "—")}</td>
          ${renderizarCampoAnotacao(item, `o computador ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  function linhasSemAcesso(semAcesso7DiasOrdenados: ItemSemAcesso[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return semAcesso7DiasOrdenados.map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao("sem_acesso_7_dias", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}${item.hostname_sumiu_endpoint ? `
            <span class="block font-sans text-xs text-amber-300 whitespace-normal" data-hostname-sumiu="true">Hostname sumiu do Endpoint${item.hostname_origem === "endpoint_anterior" ? " (hostname do Endpoint anterior)" : item.hostname_origem === "simpress" ? " (hostname mantido da Simpress)" : ""}</span>` : ""}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.ultima_verificacao ? formatarHorarioHistorico(item.ultima_verificacao) : "—")}</td>
          <td class="px-3 py-2">${Number(item.dias_sem_verificacao || 0).toLocaleString("pt-BR")}</td>
          <td class="px-3 py-2">${escapeHtml(String(item.linha_endpoint || "—"))}</td>
          ${renderizarCampoAnotacao(item, `o hostname ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  // Built by the server from older updates; "saiu_endpoint" days are an estimate (shown with "~").
  function linhasSemAcesso60(itens: ItemSemAcesso60[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return itens.map(item => {
      const estimado = item.situacao === "saiu_endpoint";
      return `
        <tr class="text-fg-tertiary" data-sem-acesso-60-situacao="${escapeHtml(item.situacao || "")}" ${atributosLinhaComparacao("sem_acesso_60_dias", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2">${estimado ? "~" : ""}${Number(item.dias || 0).toLocaleString("pt-BR")}</td>
          <td class="px-3 py-2">${estimado ? "Saiu para Ausentes no Endpoint" : "Ainda em Sem acesso há 7 dias ou mais"}</td>
          ${renderizarCampoAnotacao(item, `o hostname ${item.computador || "sem hostname"}, série ${item.serie || "vazia"}`)}
        </tr>`;
    });
  }

  function linhasApelidosAtualizados(apelidosAtualizados: ItemApelidoAtualizado[]) {
    return apelidosAtualizados.map(item => `
        <tr class="text-fg-tertiary">
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.apelido_anterior || "(vazio)")}</td>
          <td class="px-3 py-2 font-mono text-emerald-200">${escapeHtml(item.apelido_novo || "(vazio)")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(item.horario ? formatarHorarioHistorico(item.horario) : "—")}</td>
          <td class="px-3 py-2 text-xs">${escapeHtml(formatarNomeFonteHistorico(Object.values(item.arquivos_origem || {}).join(" · ") || "—"))}</td>
        </tr>`);
  }

  function linhasApelidosConferencia(apelidosSemAtualizacao: ItemApelidoConferencia[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return apelidosSemAtualizacao.map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao("apelidos_sem_atualizacao", item)}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "(vazia)")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}${marcadorUsuarioLogado(item.serie)}</td>
          <td class="px-3 py-2 text-fg-tertiary">${escapeHtml(formatarMotivoRevisao(item.motivo))}</td>
          ${renderizarCampoAnotacao(item, (item.computador ? `o hostname ${item.computador}, série ` : "a série ") + (item.serie || "vazia"))}
        </tr>`);
  }

  function linhasApelidosManuais(divergenciasApelidosManuais: ItemApelidoManual[], comparison: ComparacaoRenderizada) {
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
        : `<span class="text-xs text-fg-muted">${resolvida ? "Concluído" : "Histórico indisponível"}</span>`;
      return `
          <tr class="text-fg-tertiary" data-manual-alias-row="${index}" ${atributosLinhaComparacao("divergencias_apelidos_manuais", item)}>
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
  const ACOES_PENDENCIA_USUARIO: Record<string, { decisao: string; rotulo: string; classe: string }[] | undefined> = {
    substituicao_manual: [
      { decisao: "permitir", rotulo: "Permitir substituição", classe: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25 text-emerald-200" },
      { decisao: "recusar", rotulo: "Manter usuário manual", classe: "bg-fg-weak/10 hover:bg-fg-weak/20 border-fg-weak/25 text-fg-secondary" },
    ],
    usuario_ausente: [
      { decisao: "remover", rotulo: "Confirmar remoção", classe: "bg-rose-500/10 hover:bg-rose-500/20 border-rose-500/25 text-rose-200" },
      { decisao: "manter", rotulo: "Manter usuário", classe: "bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/25 text-emerald-200" },
    ],
  };

  function acoesPendenciaUsuario(item: ItemMudancaUsuario) {
    const acoes = ACOES_PENDENCIA_USUARIO[item.pendencia_tipo!];
    if (!acoes || !item.pendencia_id) return "";
    const classeBotao = "px-2 py-1 rounded-md border text-xs font-semibold";
    return `<div class="mt-2 flex flex-wrap items-center gap-1.5" data-user-hold="${escapeHtml(item.pendencia_id)}">
            ${acoes.map(acao => `<button type="button" data-user-hold-action="${acao.decisao}" class="${classeBotao} ${acao.classe}" aria-label="${escapeHtml(`${acao.rotulo}: série ${item.serie || "sem série"}`)}">${escapeHtml(acao.rotulo)}</button>`).join("")}
            <span hidden data-user-hold-status role="status" class="text-xs text-emerald-300"></span>
          </div>`;
  }

  function linhasMudancasUsuarios(mudancasUsuarios: ItemMudancaUsuario[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    const usuario = (nome: string | undefined, origem: string | undefined, pessoa: string | undefined) => nome
      ? `${escapeHtml(nome)}${origem === "manual" ? " (M)" : ""}${pessoa ? `<span class="block text-xs text-fg-subtle" data-person-name>${escapeHtml(pessoa)}</span>` : ""}`
      : '<span class="text-fg-muted">(vazio)</span>';
    return mudancasUsuarios.map(item => {
      const tipo = TIPOS_MUDANCA_USUARIO[item.tipo!] || { rotulo: "Mudança de usuário", classe: "text-fg-tertiary" };
      return `
        <tr class="text-fg-tertiary" data-user-change="${escapeHtml(item.tipo || "")}" ${atributosLinhaComparacao("mudancas_usuarios", item)}>
          <td class="px-3 py-2 font-semibold ${tipo.classe}">${escapeHtml(tipo.rotulo)}</td>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.serie || "—")}${marcadorUsuarioLogado(item.serie, { sugestao: item.usuario_manual_arquivado })}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.computador || "—")}</td>
          <td class="px-3 py-2">${usuario(item.usuario_anterior, item.origem_anterior, item.nome_pessoa_anterior)}</td>
          <td class="px-3 py-2">${usuario(item.usuario_novo, item.origem_nova, item.nome_pessoa_novo)}</td>
          <td class="px-3 py-2 text-fg-tertiary">${escapeHtml(String(item.motivo || "").replace(/\bno endpoint\b/gi, "no Endpoint"))}${acoesPendenciaUsuario(item)}</td>
          ${renderizarCampoAnotacao(item, `${tipo.rotulo}, série ${item.serie || "vazia"}`)}
        </tr>`;
    });
  }

  function linhasSeriesSemMapa(seriesSemMapa: ItemSerieSemMapa[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return seriesSemMapa.map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao("series_sem_mapeamento", item)}>
          <td class="px-3 py-2 font-mono text-white">${escapeHtml(item.serie)}</td>
          <td class="px-3 py-2">${Number(item.quantidade || 0)}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml((item.exemplos || []).join(", "))}</td>
          ${renderizarCampoAnotacao(item, `a série ${item.serie || "vazia"}`)}
        </tr>`);
  }

  // With several Endpoint rows for one serial, lists each hostname with its last successful check.
  // The oldest one gets a button that discards it so the remaining hostname is the one exported.
  function celulaVerificacaoAmbigua(item: { registros_endpoint?: RegistroEndpoint[]; ultima_verificacao?: string }, permitirRemocao: boolean) {
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
            <button type="button" hidden data-hostname-restore class="${classeBotao} bg-fg-weak/10 hover:bg-fg-weak/20 border-fg-weak/25 text-fg-secondary" aria-label="${escapeHtml(`Desfazer a remoção do hostname ${hostname}`)}">Desfazer</button>`
        : "";
      return `<li class="flex flex-col gap-1" data-hostname-item data-hostname-serie="${escapeHtml(registro.serie || "")}" data-hostname-nome="${escapeHtml(hostname)}">
          <span class="font-mono text-fg-secondary break-all">${escapeHtml(hostname || "—")}</span>
          <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="whitespace-nowrap text-fg-subtle">${escapeHtml(horario)}</span>
            ${acoes}
          </span>
        </li>`;
    }).join("")}</ul>`;
  }

  function linhasAmbiguidades(ambiguidades: ItemAmbiguidade[], registrosAmbiguos: ItemRegistroAmbiguo[], { renderizarCampoAnotacao, permitirAnotacoes }: ColunasAnotacao) {
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
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao(item.__categoriaPendencia, item)}>
          <td class="px-3 py-2 text-fg-tertiary">${escapeHtml(item.tipo || "Ambiguidade")}</td>
          <td class="px-3 py-2 font-mono">${escapeHtml(item.chave || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.fontes || "—")}</td>
          <td class="px-3 py-2 ${Array.isArray(item.registros_endpoint) && item.registros_endpoint.length > 1 ? "" : "whitespace-nowrap"}">${celulaVerificacaoAmbigua(item, permitirAnotacoes === true)}</td>
          <td class="px-3 py-2">${escapeHtml(item.mensagem || "")}</td>
          ${renderizarCampoAnotacao(item, `${item.tipo || "ambiguidade"}: ${item.chave || "sem identificador"}`)}
        </tr>`);
  }

  function linhasAnotacoesSincronizadas(items: ItemSincronizado[], { renderizarCampoAnotacao }: ColunasAnotacao) {
    return items.map(item => {
      const motivo = item.motivo ? formatarNomeFonteHistorico(item.motivo) : "";
      const identificador = [item.computador, item.serie && `série ${item.serie}`, motivo]
        .filter(Boolean)
        .join(" · ") || "Linha sem identificador";
      return `
          <tr class="text-fg-tertiary" ${atributosLinhaComparacao(item.categoria, item)}>
            <td class="px-3 py-2 text-fg-tertiary">${escapeHtml(CATEGORIAS_ANOTACOES_SINCRONIZADAS[item.categoria!] || "Histórico de planilhas")}</td>
            <td class="px-3 py-2">${escapeHtml(identificador)}</td>
            ${renderizarCampoAnotacao(item, `${CATEGORIAS_ANOTACOES_SINCRONIZADAS[item.categoria!] || "a linha"}, ${identificador}`)}
          </tr>`;
    });
  }

  const PONTOS_SECAO: Record<string, string> = { amber: "bg-amber-400", rose: "bg-rose-400", emerald: "bg-emerald-400", neutro: "bg-fg-weak" };

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
    sem_usuario: { id: "comparacao-secao-sem-usuario", titulo: "Sem usuário" },
  };

  // `descricao` (texto puro) vai para o ⓘ ao lado do título; o id e o tabindex ficam no h4, que é o alvo do foco.
  function tituloSecaoComparacao(titulo: string, tom: string, idSecao = "", descricao = "") {
    const alvo = idSecao ? ` id="${idSecao}" tabindex="-1"` : "";
    const h4 = `<h4${alvo} class="flex items-center gap-2 text-sm font-bold text-white"><span class="h-2 w-2 shrink-0 rounded-full ${PONTOS_SECAO[tom]}" aria-hidden="true"></span>${escapeHtml(titulo)}</h4>`;
    // Balão preso à linha do título: escondido, ele não pode alargar o painel (rolagem horizontal a 641-700px).
    return descricao ? `<div class="info-tip-ancora flex items-center gap-1">${h4}${infoTipHtml(titulo, descricao, { bloco: true })}</div>` : h4;
  }

  // Visão geral em bento (docs/ui-motion/contrato-bento.md). Os números saem prontos no HTML; bento.js
  // anima do zero até eles e aplica as larguras de data-bento-largura (CSP: nada de style= no HTML).
  const ICONES_BENTO: Record<string, string> = {
    notebook: '<rect x="4" y="5" width="16" height="11" rx="2"></rect><path d="M2 20h20"></path>',
    link: '<path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 4 8M8 12h4M3 3l18 18"></path>',
    predio: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M8 7h4M8 11h4M8 15h4M2 21h20"></path>',
    local: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"></path><circle cx="12" cy="10" r="2.5"></circle>',
    copia: '<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>',
    etiqueta: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"></path><path d="M7.5 7.5h.01"></path>',
  };
  const svgBento = (corpo: string) => `<svg class="ck-bento-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${corpo}</svg>`;

  function cartaoBento({ rotulo, valor, tom, icone, chaveSecao = "", extra = "", grande = false }: { rotulo: string; valor: unknown; tom: string; icone: string; chaveSecao?: string; extra?: string; grande?: boolean }) {
    const numero = Number(valor || 0);
    const texto = numero.toLocaleString("pt-BR");
    const secao = (SECOES_CARTOES_RESUMO as Record<string, SecaoResumo | undefined>)[chaveSecao];
    const abrir = secao && numero > 0
      ? `<button type="button" class="ck-bento-abrir" data-comparison-section-target="${secao.id}" aria-label="${escapeHtml(`${rotulo}: ${texto}. Ir para ${secao.titulo}`)}">${svgBento('<path d="M7 17 17 7M9 7h8v8"></path>')}</button>`
      : "";
    return `<article class="ck-bento-cartao${grande ? " ck-bento-cartao--grande" : ""}" data-tom="${tom}" data-bento-cartao>
          <div class="ck-bento-face">
            <div class="ck-bento-cab"><span class="ck-bento-icone">${svgBento(ICONES_BENTO[icone])}</span><h4 class="ck-bento-titulo">${escapeHtml(rotulo)}</h4>${abrir}</div>
            ${grande ? extra.replace("%NUM%", `<p class="ck-bento-num" data-bento-contar="${numero}">${texto}</p>`) : `<p class="ck-bento-num" data-bento-contar="${numero}">${texto}</p>${extra}`}
          </div>
        </article>`;
  }

  function cartoesBentoVisao(comparison: ComparacaoRenderizada, contagens: { endpoint: number; simpress: number; local: number; duplicidades: number; series: number }) {
    const comparados = Math.max(0, Number(comparison.total_endpoint || 0));
    const { endpoint, simpress, local, duplicidades, series } = contagens;
    const maximo = Math.max(endpoint, simpress, local, duplicidades, series, 1);
    const traco = (valor: number) => `<div class="ck-bento-traco" aria-hidden="true"><i data-bento-largura="${((valor / maximo) * 100).toFixed(1)}"></i></div>`;
    // Decisão de 14/11/2026: anel = (total_endpoint − "Sem correspondência — na Simpress") / total_endpoint.
    const fracao = comparados > 0 ? Math.min(1, Math.max(0, (comparados - simpress) / comparados)) : 0;
    const pct = Math.floor(fracao * 100); // floor: 998 de 1000 não vira "100%"
    const anel = `<div class="ck-bento-anelbox">%NUM%<span class="ck-bento-espaco"></span><div class="ck-bento-anel"><svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle class="ck-bento-anel__trilho" cx="60" cy="60" r="52" fill="none" stroke-width="10"></circle><circle class="ck-bento-anel__cheio" cx="60" cy="60" r="52" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="326.73" data-bento-anel="${fracao.toFixed(4)}"></circle></svg><span data-bento-contar="${pct}" data-bento-sufixo="%">${pct}%</span></div></div><p class="ck-bento-legenda">com correspondência nas duas bases</p>`;
    return `<div class="ck-bento" role="group" aria-label="Contadores de Visão geral">
        ${cartaoBento({ rotulo: "Notebooks comparados", valor: comparados, tom: "indigo", icone: "notebook", extra: anel, grande: true })}
        ${cartaoBento({ rotulo: "Sem correspondência — no endpoint", valor: endpoint, tom: "ciano", icone: "link", chaveSecao: "ausentes_no_endpoint", extra: traco(endpoint) })}
        ${cartaoBento({ rotulo: "Sem correspondência — na Simpress", valor: simpress, tom: "fucsia", icone: "predio", chaveSecao: "ausentes_em_detalhes", extra: traco(simpress) })}
        ${cartaoBento({ rotulo: "Divergências de local", valor: local, tom: "ambar", icone: "local", chaveSecao: "divergencias_local", extra: traco(local) })}
        ${cartaoBento({ rotulo: "Duplicidades e ambiguidades", valor: duplicidades, tom: "esmeralda", icone: "copia", chaveSecao: "correspondencias_ambiguas", extra: traco(duplicidades) })}
        ${cartaoBento({ rotulo: "Séries sem mapeamento", valor: series, tom: "indigo", icone: "etiqueta", chaveSecao: "series_sem_mapeamento", extra: traco(series) })}
      </div>`;
  }

  // Bloco 2 do bento (docs/ui-motion/contrato-bento.md): contadores pequenos e cartões de seção das sub-abas.
  // O atraso de entrada é a classe ck-bento-dN (N x 80 ms); a cor é o data-tom do Bloco 1 (índigo = padrão).
  const atrasoBento = (n: unknown) => `ck-bento-d${Math.min(Math.max(Number(n) || 0, 0), 5)}`;

  // Contador pequeno do topo da sub-aba. Com contagem acima de zero e seção correspondente vira botão que rola até ela;
  // senão fica estático. `bento`: { cor, icone, traco (largura em %), atraso }.
  function cartaoMetricaComparacao(rotulo: string, valor: unknown, tom: string | null, idNumero = "", chaveSecao = "", bento: { cor?: string; icone?: string; traco?: number | null; atraso?: number } = {}) {
    const { cor = "indigo", icone = "", traco = null, atraso = 0 } = bento;
    const numero = Number(valor || 0);
    const texto = numero.toLocaleString("pt-BR");
    const icon = icone ? `<span class="ck-bento-icone">${svgBento(ICONES_BENTO[icone])}</span>` : "";
    const barra = traco === null ? "" : `<div class="ck-bento-traco" aria-hidden="true"><i data-bento-largura="${Number(traco).toFixed(1)}"></i></div>`;
    const conteudo = `<p class="text-xs uppercase tracking-wide text-fg-subtle">${escapeHtml(rotulo)}</p><p${idNumero ? ` id="${idNumero}"` : ""} class="ck-bento-num" data-bento-contar="${numero}">${texto}</p>${icon}${barra}`;
    const secao = (SECOES_CARTOES_RESUMO as Record<string, SecaoResumo | undefined>)[chaveSecao];
    const face = !secao || numero <= 0
      ? `<div class="ck-bento-face" data-metric-tone="${tom || ""}">${conteudo}</div>`
      : `<button type="button" class="comparison-metric-link ck-bento-face" data-metric-tone="${tom || ""}" data-comparison-section-target="${secao.id}" aria-label="${escapeHtml(`${rotulo}: ${texto}. Ir para ${secao.titulo}`)}">${conteudo}</button>`;
    return `<div class="ck-bento-cartao ck-bento-cartao--mini ${atrasoBento(atraso)}" data-tom="${cor}" data-bento-cartao>${face}</div>`;
  }

  // Cabeçalho de seção: título (alvo do foco), ⓘ e, quando há lista, a contagem em pílula.
  function cabecalhoSecaoBento(titulo: string, idSecao = "", descricao = "", contagem: number | null = null) {
    const alvo = idSecao ? ` id="${idSecao}" tabindex="-1"` : "";
    const h4 = `<h4${alvo} class="ck-bento-h2">${escapeHtml(titulo)}</h4>`;
    const titulado = descricao ? `<div class="info-tip-ancora ck-bento-ancora">${h4}${infoTipHtml(titulo, descricao, { bloco: true })}</div>` : h4;
    const pilula = contagem === null ? "" : `<span class="ck-bento-qt">${Number(contagem).toLocaleString("pt-BR")}</span>`;
    return `<div class="ck-bento-sech">${titulado}${pilula}</div>`;
  }

  // Cartão de seção. `atributos` carrega os data-* que o controlador e os testes procuram (data-user-change-summary etc.).
  function cartaoSecaoBento(cor: string, atraso: number, cabecalho: string, corpo: string, atributos = "") {
    return `<section class="ck-bento-cartao ck-bento-secao ${atrasoBento(atraso)}" data-tom="${cor}" data-bento-cartao data-history-filter-section${atributos}>
          <div class="ck-bento-face">${cabecalho}${corpo}</div>
        </section>`;
  }

  function conteudoAnotacoesSincronizadas(comparison: ComparacaoRenderizada, colunas: ColunasAnotacao) {
    const barra = barraFiltrosHistorico(comparison);
    const anotacoesSincronizadasRows = linhasAnotacoesSincronizadas(comparison.anotacoes_sincronizadas || [], colunas);
    return `
          ${barra}
          <p class="notice notice-info">Este clone contém as anotações sincronizadas. O resultado original e os arquivos da comparação não estão armazenados neste dispositivo.</p>
          <section class="space-y-2" data-history-filter-section>
            <div>${tituloSecaoComparacao("Anotações sincronizadas", "neutro", "", "Anotações feitas nas linhas desta atualização, com a seção e a linha a que pertencem.")}</div>
            ${renderizarTabelaComparacao(["Seção", "Linha", "Anotações"], anotacoesSincronizadasRows, "Nenhuma anotação sincronizada neste resultado.", "anotacoes_sincronizadas")}
          </section>`;
  }

  // "Sem usuário" is not saved in the history events: the controller reads it from the current inventory
  // (same rule as the Home chip), so the same rows appear whichever event is open. There is no per-event row id,
  // hence no annotation column.
  function linhasSemUsuario(items: ItemSemUsuario[]) {
    return [...items]
      .sort((a, b) => String(a.apelido || a.computador || "").localeCompare(String(b.apelido || b.computador || ""), "pt-BR")
        || String(a.serial || "").localeCompare(String(b.serial || ""), "pt-BR"))
      .map(item => `
        <tr class="text-fg-tertiary" ${atributosLinhaComparacao("sem_usuario", { serie: item.serial, computador: item.apelido || item.computador })}>
          <td class="px-3 py-2 font-mono text-white whitespace-nowrap">${escapeHtml(item.apelido || item.computador || "—")}</td>
          <td class="px-3 py-2 font-mono whitespace-nowrap">${escapeHtml(item.serial || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.retirada_cidade || "—")}</td>
          <td class="px-3 py-2">${escapeHtml(item.modelo || "—")}</td>
        </tr>`);
  }

  function secaoSemUsuario(semUsuario: SemUsuarioRenderizador) {
    const idSecao = SECOES_CARTOES_RESUMO.sem_usuario.id;
    if (semUsuario.estado !== "ok" && semUsuario.estado !== "limite") {
      return cartaoSecaoBento("ambar", 3, cabecalhoSecaoBento("Sem usuário", idSecao),
        '<p class="text-xs text-fg-muted" role="status">Não foi possível consultar os notebooks sem usuário agora. Abra o Resumo de novo para tentar outra vez.</p>',
        ' data-sem-usuario-section="erro"');
    }
    const items = (Array.isArray(semUsuario.items) ? semUsuario.items : []) as ItemSemUsuario[];
    const limite = semUsuario.estado === "limite";
    const aviso = limite
      ? `<p class="text-xs text-fg-muted" role="status">Mostrando os primeiros ${items.length.toLocaleString("pt-BR")}${Number.isSafeInteger(semUsuario.total) ? ` de ${semUsuario.total!.toLocaleString("pt-BR")}` : ""} notebooks sem usuário; há mais no cadastro. Use o filtro "Sem usuário" da Home para ver todos.</p>`
      : "";
    return cartaoSecaoBento("ambar", 3,
      cabecalhoSecaoBento("Sem usuário", idSecao, "Notebooks do cadastro atual sem usuário logado, do Endpoint ou manual. A lista vem do cadastro de agora, não do arquivo desta atualização; por isso é a mesma em qualquer resultado aberto.", limite ? null : items.length),
      `${aviso}${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local", "Modelo"], linhasSemUsuario(items), "Todos os notebooks do cadastro têm usuário.", "sem_usuario")}`,
      ` data-sem-usuario-section="${limite ? "limite" : "ok"}"`);
  }

  // Resumo (F3) sub-tabs: one tabpanel per subject. The controller in comparison-result.js owns state, counts and filters;
  // everything below is pure so tests can pin the texts and rules.
  const RESUMO_ABAS = [
    { chave: "visao", rotulo: "Visão geral" },
    { chave: "divergencias", rotulo: "Divergências" },
    { chave: "apelidos", rotulo: "Apelidos" },
    { chave: "usuarios", rotulo: "Usuários" },
    { chave: "sem-acesso", rotulo: "Sem acesso" },
    // Fica fora de CATEGORIAS_POR_ABA e TEXTO_VAZIO_ABA: não é lista de linhas da comparação; quem o desenha é o painel React (frontend/src/paineis/backups-regionais/); frontend/src/legado/features/backups-regionais.js só pede o painel a cada 5 min.
    { chave: "backups", rotulo: "Backups" },
  ];
  const ROTULOS_CATEGORIA_RESUMO: Record<string, string | undefined> = {
    apelidos_sem_atualizacao: "Linhas mantidas para conferência",
    sem_acesso_7_dias: "Sem acesso há 7 dias ou mais",
    sem_acesso_60_dias: "Passou de 60 dias sem acesso",
    ausentes_no_endpoint: "Sem correspondência — Endpoint",
    ausentes_em_detalhes: "Sem correspondência — Simpress",
    divergencias_local: "Localidade divergente",
    correspondencias_ambiguas: "Duplicidades e correspondências ambíguas",
    divergencias_apelidos_manuais: "Apelidos manuais divergentes",
    series_sem_mapeamento: "Séries sem local definido",
    mudancas_usuarios: "Mudanças de usuário logado",
    sem_usuario: "Sem usuário",
  };
  const CATEGORIAS_POR_ABA = {
    divergencias: ["ausentes_no_endpoint", "ausentes_em_detalhes", "divergencias_local", "correspondencias_ambiguas", "series_sem_mapeamento"],
    apelidos: ["apelidos_sem_atualizacao", "divergencias_apelidos_manuais"],
    usuarios: ["mudancas_usuarios", "sem_usuario"],
    "sem-acesso": ["sem_acesso_7_dias", "sem_acesso_60_dias"],
  };
  // The Divergências tab groups the two "sem correspondência" lists into one type.
  const TIPOS_DIVERGENCIAS = [
    { valor: "sem_correspondencia", rotulo: "Sem correspondência", categorias: ["ausentes_no_endpoint", "ausentes_em_detalhes"] },
    { valor: "divergencias_local", rotulo: "Localidade divergente", categorias: ["divergencias_local"] },
    { valor: "correspondencias_ambiguas", rotulo: "Duplicidade ou ambiguidade", categorias: ["correspondencias_ambiguas"] },
    { valor: "series_sem_mapeamento", rotulo: "Série sem local definido", categorias: ["series_sem_mapeamento"] },
  ];
  const TEXTO_VAZIO_ABA: Record<string, string | undefined> = {
    divergencias: "Nenhuma divergência neste resultado.",
    apelidos: "Nenhum apelido pendente neste resultado.",
    usuarios: "Nenhuma mudança de usuário neste resultado.",
    "sem-acesso": "Nenhum equipamento sem acesso neste resultado.",
  };
  const TEXTO_LISTA_AUSENTE = "Este resultado não traz esta lista. Escolha uma comparação mais recente no campo Comparação.";

  function canonicalizarCategoriaResumo(categoria: string | undefined) {
    return categoria === "registros_ambiguos" ? "correspondencias_ambiguas" : String(categoria || "");
  }
  function abaDaCategoria(categoria: string | undefined) {
    const canonica = canonicalizarCategoriaResumo(categoria);
    return Object.keys(CATEGORIAS_POR_ABA).find(chave => (CATEGORIAS_POR_ABA as Record<string, string[]>)[chave].includes(canonica)) || "";
  }
  function rotuloAba(chave: string) {
    return RESUMO_ABAS.find(aba => aba.chave === chave)?.rotulo || chave;
  }
  function textoLinhas(total: unknown, encontradas = false) {
    const n = Number(total) || 0;
    return `${n.toLocaleString("pt-BR")} ${n === 1 ? "linha" : "linhas"}${encontradas ? (n === 1 ? " encontrada" : " encontradas") : ""}`;
  }
  // aria-label of a tab badge; total null = the list does not exist in this result (Usuários).
  function rotuloContagemAba(chave: string, total: number | null | undefined, filtrando = false) {
    const rotulo = rotuloAba(chave);
    if (chave === "visao") return rotulo;
    if (chave === "backups") {
      if (total === undefined) return `${rotulo}: aguardando dados`;  // painel ainda não chegou
      if (total === null) return `${rotulo}: dados indisponíveis`;
      const n = Number(total) || 0;
      return `${rotulo}: ${n.toLocaleString("pt-BR")} ${n === 1 ? "regional pendente" : "regionais pendentes"}`;
    }
    if (total === null) return `${rotulo}: lista indisponível neste resultado`;
    return `${rotulo}: ${textoLinhas(total, filtrando)}`;
  }
  function textoContadorResumo(total: unknown, filtrando = false) {
    const n = Number(total) || 0;
    return filtrando
      ? `${textoLinhas(n, true)} neste resultado.`
      : `${textoLinhas(n)} para conferência neste resultado.`;
  }
  function textoSemResultado(termo: unknown) {
    const t = String(termo || "").trim();
    return t ? `Nenhuma linha encontrada para “${t}”.` : "Nenhuma linha encontrada com os filtros atuais.";
  }
  // Options of the "Tipo de divergência" select; categoriasPresentes feeds every tab except Divergências.
  function tiposDaAba(chave: string, categoriasPresentes: string[] = []) {
    if (chave === "divergencias") return TIPOS_DIVERGENCIAS.map(({ valor, rotulo }) => ({ valor, rotulo }));
    const permitidas = (CATEGORIAS_POR_ABA as Record<string, string[] | undefined>)[chave] || [];
    return [...new Set(categoriasPresentes.map(canonicalizarCategoriaResumo))]
      .filter(categoria => permitidas.includes(categoria))
      .map(valor => ({ valor, rotulo: ROTULOS_CATEGORIA_RESUMO[valor] || valor }))
      .sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));
  }
  // A type chosen on one tab falls back to "Todos" when the new tab does not offer it.
  function resolverTipo(chave: string, tipo: string, categoriasPresentes: string[] = []) {
    return tiposDaAba(chave, categoriasPresentes).some(opcao => opcao.valor === tipo) ? tipo : "";
  }
  function categoriasDoTipo(chave: string, tipo: string) {
    if (!tipo) return null;
    if (chave === "divergencias") return TIPOS_DIVERGENCIAS.find(opcao => opcao.valor === tipo)?.categorias || [];
    return [tipo];
  }
  // Banner above the tabs (#comparacao-planilhas-avisos); a failed history save is an alert.
  function avisoHistoricoComparacao(comparison: ComparacaoRenderizada) {
    if (comparison.historico_salvo === false) {
      return `<p class="notice notice-warn" role="alert">${escapeHtml(comparison.aviso_historico || "Não foi possível salvar este resultado no histórico de comparações.")}</p>`;
    }
    return comparison.historico_salvo === true ? '<p class="notice notice-info">Resultado registrado no Histórico de planilhas.</p>' : "";
  }

  // One tabpanel per Resumo tab; only the selected one is visible. The controller shows data-resumo-vazio when the tab has no rows.
  // `cartoes` (the tab's compact counters) stays above the empty-state notice.
  function painelResumo(chave: string, conteudo: string, selecionado = false, cartoes: string[] = []) {
    const vazio = TEXTO_VAZIO_ABA[chave];
    const faixa = cartoes.filter(Boolean).join("");
    return `<div role="tabpanel" id="resumo-painel-${chave}" aria-labelledby="resumo-aba-${chave}" class="resumo-painel" data-resumo-painel="${chave}"${selecionado ? "" : " hidden"}>
        ${faixa ? `<div class="resumo-cartoes" role="group" aria-label="Contadores de ${RESUMO_ABAS.find(aba => aba.chave === chave)!.rotulo}">${faixa}</div>` : ""}
        ${vazio ? `<p class="text-xs text-fg-muted" data-resumo-vazio role="status" hidden>${vazio}</p>` : ""}
        ${conteudo}
      </div>`;
  }

  function conteudoResultadoComparacao(comparison: ComparacaoRenderizada, listas: ListasComparacao, colunas: ColunasAnotacao) {
    const {
      ausentesEndpoint, ausentesDetalhes, divergenciasLocal, seriesSemMapa, semAcesso7DiasOrdenados, ambiguidades,
      registrosAmbiguos, apelidosAtualizados, apelidosSemAtualizacao, divergenciasApelidosManuais, mudancasUsuarios,
      semUsuario,
    } = listas;
    // Only when the controller supplies the inventory read; without it the section is left out.
    const exibirSemUsuario = Boolean(semUsuario) && typeof semUsuario === "object";
    const { permitirAnotacoes, annotationHeaders, aliasReviewHeaders } = colunas;
    const barra = barraFiltrosHistorico(comparison);
    const aliasUpdateRows = linhasApelidosAtualizados(apelidosAtualizados);
    const aliasReviewRows = linhasApelidosConferencia(apelidosSemAtualizacao, colunas);
    const manualAliasRows = linhasApelidosManuais(divergenciasApelidosManuais, comparison);
    const semAcessoRows = linhasSemAcesso(semAcesso7DiasOrdenados, colunas);
    const semAcesso60 = Array.isArray(comparison.sem_acesso_60_dias) ? comparison.sem_acesso_60_dias : null;
    const locationRows = linhasLocalidadeDivergente(divergenciasLocal, colunas);
    const ambiguityRows = linhasAmbiguidades(ambiguidades, registrosAmbiguos, colunas);
    const unmappedRows = linhasSeriesSemMapa(seriesSemMapa, colunas);
    const userChangeRows = linhasMudancasUsuarios(mudancasUsuarios, colunas);
    const contarMudancas = (tipo: string) => mudancasUsuarios.filter(item => item.tipo === tipo).length;
    // Results saved before the user summary existed have no list; the section is shown only when it exists.
    const secaoMudancasUsuarios = Array.isArray(comparison.mudancas_usuarios) ? cartaoSecaoBento("fucsia", 2,
      cabecalhoSecaoBento("Mudanças de usuário logado", SECOES_CARTOES_RESUMO.mudancas_usuarios.id, "Usuários logados que mudaram nesta atualização, comparando o Endpoint anterior com o novo. Quando o Endpoint passa a informar um usuário onde há um usuário manual (M), ou deixa de informar um usuário que já existia, nada muda sozinho: o usuário atual continua valendo até você decidir. Troca de um usuário do Endpoint por outro é aplicada automaticamente.", mudancasUsuarios.length),
      `<p class="ck-bento-nota" data-user-change-counts>${[
        ["Novos no Endpoint", contarMudancas("novo_endpoint")],
        ["Alterados", contarMudancas("alterado_endpoint")],
        ["Removidos do Endpoint", contarMudancas("removido_endpoint")],
        ["Manuais que voltaram a valer", contarMudancas("manual_voltou")],
      ].map(([rotulo, total]) => `${rotulo}: ${(total as number).toLocaleString("pt-BR")}`).join(" · ")}</p>
          <details open class="ck-bento-detalhes" data-user-change-details>
            <summary class="ck-bento-minimizar">
              <span data-user-change-toggle-label>Minimizar lista de usuários alterados</span>
            </summary>
            ${renderizarTabelaComparacao(["Mudança", "Série", "Hostname/Apelido", "Usuário anterior", "Usuário novo", "Motivo", ...annotationHeaders], userChangeRows, "Nenhum usuário logado mudou nesta atualização.", "mudancas_usuarios")}
          </details>`,
      " data-user-change-summary") : "";
    // Traço dos contadores de Divergências: mesma regra da Visão geral (anel = comparados menos "na Simpress" sobre comparados).
    const comparados = Math.max(0, Number(comparison.total_endpoint || 0));
    const maximoDivergencias = Math.max(ausentesEndpoint.length, ausentesDetalhes.length, divergenciasLocal.length, ambiguityRows.length, seriesSemMapa.length, 1);
    const tracoDivergencia = (valor: number) => (valor / maximoDivergencias) * 100;
    const tracoComparados = comparados > 0 ? Math.min(1, Math.max(0, (comparados - ausentesDetalhes.length) / comparados)) * 100 : 0;
    const avisoListaAusente = `<p class="notice notice-info" data-resumo-lista-ausente role="status">${TEXTO_LISTA_AUSENTE}</p>`;
    return `
        ${barra}
        ${painelResumo("visao", `
        ${Number(comparison.anotacoes_herdadas_enfileiradas || 0) > 0
        ? `<p class="notice notice-warn">${Number(comparison.anotacoes_herdadas_enfileiradas).toLocaleString("pt-BR")} anotações herdadas foram gravadas junto com o resultado. A sincronização com a pasta compartilhada será tentada automaticamente.</p>`
        : ""}
        ${cartoesBentoVisao(comparison, {
          endpoint: ausentesEndpoint.length, simpress: ausentesDetalhes.length, local: divergenciasLocal.length,
          duplicidades: ambiguityRows.length, series: seriesSemMapa.length,
        })}
        `, true)}
        ${painelResumo("divergencias", `
        ${cartaoSecaoBento("ciano", 2,
          cabecalhoSecaoBento("Equipamentos sem correspondência por fonte", "", "Equipamentos que não foram encontrados de forma segura em uma das fontes: Endpoint ou Simpress. Cada lista indica a fonte onde falta o registro."),
          `<div class="history-filter-group ck-bento-grupo" data-history-filter-group="ausentes_no_endpoint">
            <h5 id="${SECOES_CARTOES_RESUMO.ausentes_no_endpoint.id}" tabindex="-1" class="ck-bento-h5">Sem correspondência — Endpoint (${ausentesEndpoint.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesEndpoint, "ausentes_no_endpoint", colunas), "Todos os equipamentos têm correspondência segura com Endpoint.")}
          </div>
          <div class="history-filter-group ck-bento-grupo" data-history-filter-group="ausentes_em_detalhes">
            <h5 id="${SECOES_CARTOES_RESUMO.ausentes_em_detalhes.id}" tabindex="-1" class="ck-bento-h5">Sem correspondência — Simpress (${ausentesDetalhes.length})</h5>
            ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Local previsto", "Sem correspondência em", ...annotationHeaders], linhasAusentes(ausentesDetalhes, "ausentes_em_detalhes", colunas), "Todos os equipamentos têm correspondência segura com Simpress.")}
          </div>`)}
        ${cartaoSecaoBento("ambar", 3,
          cabecalhoSecaoBento("Localidade divergente", SECOES_CARTOES_RESUMO.divergencias_local.id, "Equipamentos cujo local cadastrado na Simpress é diferente do local previsto pelo prefixo da série.", divergenciasLocal.length),
          renderizarTabelaComparacao(["Computador", "Série", "Local previsto", "Local na Simpress", ...annotationHeaders], locationRows, "Nenhuma divergência de localidade encontrada.", "divergencias_local"))}
        ${cartaoSecaoBento("esmeralda", 4,
          cabecalhoSecaoBento("Duplicidades e correspondências ambíguas", SECOES_CARTOES_RESUMO.correspondencias_ambiguas.id, "Séries ou hostnames repetidos, ou que não identificam um único equipamento.", ambiguityRows.length),
          renderizarTabelaComparacao(["Ocorrência", "Série ou hostname/Apelido", "Fontes", "Última verificação com êxito", "Tratamento", ...annotationHeaders], ambiguityRows, "Nenhuma duplicidade ou correspondência ambígua encontrada.", "correspondencias_ambiguas"))}
        ${cartaoSecaoBento("indigo", 5,
          cabecalhoSecaoBento("Séries sem local definido", SECOES_CARTOES_RESUMO.series_sem_mapeamento.id, "Prefixos de série sem local cadastrado, com a quantidade de equipamentos e exemplos.", seriesSemMapa.length),
          renderizarTabelaComparacao(["Série", "Quantidade", "Exemplos", ...annotationHeaders], unmappedRows, "Todas as séries têm mapeamento de localidade.", "series_sem_mapeamento"))}
        `, false, [
          cartaoMetricaComparacao("Notebooks comparados", comparison.total_endpoint, null, "", "", { cor: "indigo", icone: "notebook", traco: tracoComparados, atraso: 0 }),
          cartaoMetricaComparacao("Sem correspondência — no endpoint", ausentesEndpoint.length, "amber", "", "ausentes_no_endpoint", { cor: "ciano", icone: "link", traco: tracoDivergencia(ausentesEndpoint.length), atraso: 1 }),
          cartaoMetricaComparacao("Sem correspondência — na Simpress", ausentesDetalhes.length, "amber", "", "ausentes_em_detalhes", { cor: "fucsia", icone: "predio", traco: tracoDivergencia(ausentesDetalhes.length), atraso: 2 }),
          cartaoMetricaComparacao("Divergências de local", divergenciasLocal.length, "amber", "", "divergencias_local", { cor: "ambar", icone: "local", traco: tracoDivergencia(divergenciasLocal.length), atraso: 3 }),
          cartaoMetricaComparacao("Duplicidades e ambiguidades", ambiguityRows.length, "rose", "", "correspondencias_ambiguas", { cor: "esmeralda", icone: "copia", traco: tracoDivergencia(ambiguityRows.length), atraso: 4 }),
          cartaoMetricaComparacao("Séries sem mapeamento", seriesSemMapa.length, "amber", "", "series_sem_mapeamento", { cor: "indigo", icone: "etiqueta", traco: tracoDivergencia(seriesSemMapa.length), atraso: 5 }),
        ])}
        ${painelResumo("apelidos", `
        ${cartaoSecaoBento("indigo", 3,
          cabecalhoSecaoBento("Linhas mantidas para conferência", SECOES_CARTOES_RESUMO.apelidos_sem_atualizacao.id, `Série(s) vazia(s) não é escolhida automaticamente; o apelido atual fica preservado.${permitirAnotacoes ? " As anotações continuam vinculadas a esta linha e atualização. Em novas atualizações, são reaplicadas somente quando os dados correspondem exatamente na mesma seção e a anotação mais recente não está vazia ou em conflito." : ""}`, apelidosSemAtualizacao.length),
          renderizarTabelaComparacao(aliasReviewHeaders, aliasReviewRows, "Nenhuma linha de apelido precisa de conferência.", "apelidos_sem_atualizacao"))}
        ${cartaoSecaoBento("ambar", 4,
          cabecalhoSecaoBento("Divergências com apelidos alterados manualmente", SECOES_CARTOES_RESUMO.divergencias_apelidos_manuais.id, "Apelidos marcados com (M), definidos manualmente, que constam nas planilhas enviadas. O apelido (M) continua valendo sobre as planilhas até você decidir. Escolha “Manter manual” para confirmar a identificação (M) ou “Excluir manual” para voltar ao valor das planilhas."),
          renderizarTabelaComparacao(["Série", "Apelido manual", "na Simpress", "no endpoint", "Situação", "Ação"], manualAliasRows, "Nenhuma divergência entre apelidos manuais e as planilhas enviadas.", "divergencias_apelidos_manuais"))}
        ${cartaoSecaoBento("ciano", 5,
          cabecalhoSecaoBento("Apelidos/hostnames atualizados — no endpoint", SECOES_CARTOES_RESUMO.apelidos_atualizados.id, "Equipamentos cujo apelido ou hostname mudou nesta atualização, com o valor anterior e o novo, identificados pela série. Informativo: não entra na contagem da aba."),
          renderizarTabelaComparacao(["Série", "Apelido anterior", "Novo apelido / hostname", "Horário", "Arquivos de origem"], aliasUpdateRows, "Nenhum apelido ou hostname mudou nesta atualização."),
          " data-resumo-informativo")}
        `, false, [
          cartaoMetricaComparacao("Apelidos para conferência", apelidosSemAtualizacao.length, "amber", "", "apelidos_sem_atualizacao", { cor: "indigo", atraso: 0 }),
          cartaoMetricaComparacao("Divergências manuais pendentes", divergenciasApelidosManuais.filter(item => !item.resolucao || item.resolucao === "pendente").length, "rose", "comparacao-divergencias-manuais-pendentes", "divergencias_apelidos_manuais", { cor: "ambar", atraso: 1 }),
          cartaoMetricaComparacao("Apelidos/hostnames atualizados", apelidosAtualizados.length, "emerald", "", "apelidos_atualizados", { cor: "ciano", atraso: 2 }),
        ])}
        ${painelResumo("usuarios", `
        ${secaoMudancasUsuarios || avisoListaAusente}
        ${exibirSemUsuario ? secaoSemUsuario(semUsuario!) : ""}
        `, false, [
          secaoMudancasUsuarios ? cartaoMetricaComparacao("Mudanças de usuário", mudancasUsuarios.length, "emerald", "", "mudancas_usuarios", { cor: "fucsia", atraso: 0 }) : "",
          exibirSemUsuario && semUsuario!.estado === "ok" ? cartaoMetricaComparacao("Sem usuário", (semUsuario!.items || []).length, "amber", "", "sem_usuario", { cor: "ambar", atraso: 1 }) : "",
        ])}
        ${painelResumo("sem-acesso", `
        ${cartaoSecaoBento("ambar", 0,
          cabecalhoSecaoBento("Sem acesso há 7 dias ou mais", "comparacao-secao-sem-acesso-7", "Notebooks cuja última verificação com êxito ocorreu há 7 dias ou mais, contados a partir desta atualização.", semAcessoRows.length),
          `<p class="ck-bento-nota">Para remover computadores com hostname duplicado (o mais antigo) ou sem uso há muito tempo, acesse o <a href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/agent/som/computers" target="_blank" rel="noopener noreferrer" data-endpoint-computers-link class="text-sky-400 underline hover:text-sky-300">Endpoint Central (Computadores)</a>.</p><p class="ck-bento-nota">Atualização usada como referência: ${comparison.horario_comparacao ? `<time datetime="${escapeHtml(comparison.horario_comparacao)}">${escapeHtml(formatarHorarioHistorico(comparison.horario_comparacao))}</time>` : "data e hora indisponíveis"}.</p>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Última verificação com êxito", "Dias sem verificação", "Linha no endpoint", ...annotationHeaders], semAcessoRows, "Nenhum notebook está há 7 dias ou mais sem verificação com êxito.", "sem_acesso_7_dias")}`)}
        ${semAcesso60 ? cartaoSecaoBento("fucsia", 1,
          cabecalhoSecaoBento(`Passou de 60 dias sem acesso (${semAcesso60.length})`, "comparacao-secao-sem-acesso-60", "Notebooks com 60 dias ou mais sem verificação com êxito nesta atualização, incluindo os que saíram de “Sem acesso há 7 dias ou mais” e foram para Ausentes no Endpoint. Para esses, os dias são estimados (~) pela última atualização em que ainda apareciam."),
          `<p class="ck-bento-nota">Os hostnames que somem do Endpoint ficam em <a href="https://centralendpoint.pr.sebrae.com.br/webclient#/uems/agent/som/staged-computers" target="_blank" rel="noopener noreferrer" data-endpoint-staged-link class="text-sky-400 underline hover:text-sky-300">Endpoint Central (Staged computers)</a>.</p>
          ${renderizarTabelaComparacao(["Hostname/Apelido", "Série", "Dias sem acesso", "Situação", ...annotationHeaders], linhasSemAcesso60(semAcesso60, colunas), "Nenhum notebook passou de 60 dias sem acesso nesta atualização.", "sem_acesso_60_dias")}`,
          " data-sem-acesso-60-secao") : avisoListaAusente}
        `)}
      `;
  }



  return {
    listasComparacao, criarColunasAnotacao, conteudoAnotacoesSincronizadas, conteudoResultadoComparacao, secaoSemUsuario, SECOES_CARTOES_RESUMO,
    RESUMO_ABAS, ROTULOS_CATEGORIA_RESUMO, CATEGORIAS_POR_ABA, TIPOS_DIVERGENCIAS, TEXTO_VAZIO_ABA, TEXTO_LISTA_AUSENTE,
    canonicalizarCategoriaResumo, abaDaCategoria, rotuloAba, textoLinhas, rotuloContagemAba, textoContadorResumo, textoSemResultado,
    tiposDaAba, resolverTipo, categoriasDoTipo, avisoHistoricoComparacao,
  };
}

export type RendererResultado = ReturnType<typeof criarRenderizadorResultado>;
