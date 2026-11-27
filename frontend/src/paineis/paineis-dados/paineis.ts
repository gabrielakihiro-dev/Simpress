import { apiFetch } from "../../api.ts";
import type { Janela, Qualquer } from "./tipos";
import { criarTabelaOs } from "./tabela-os.ts";
import { DENSITY_KEY, ENDPOINT, barPercentages, contagemLembretesAgendados, compareValues, divergenceTotal, formatNumber, nextDirection, painelCompartilhado, pluralize, sortKey, sortedOrder, toTsv } from "./utilitarios.ts";

const REFRESH_MIN_MS = 15000;

// Painéis de dados do Cockpit: densidade das tabelas, ordenação e "Copiar tabela", tabela de OS, selo de divergências
// e central de notificações. Porta fiel do antigo data-panels.js. Todo o estado vive dentro da fábrica;
// o módulo exporta uma instância (paineisDados) e os testes criam outra quando precisam de um estado limpo.
export function criarPaineisDados() {
  let instalada = false;
  // Ponte para a instalação ativa: permite paineisDados.montarTabelaOs(...) após o install.
  let osApi: { montar: (host?: Qualquer, opcoes?: Qualquer) => Qualquer; atualizar: (force?: boolean) => Promise<Qualquer>; filtrar: (filtro?: Qualquer) => Qualquer; revelar: (row?: Qualquer) => boolean; series: () => Qualquer } = {
    montar: () => null, atualizar: async () => {}, filtrar: () => {}, revelar: () => false, series: () => null,
  };
  const montarTabelaOs = (host?: Qualquer, opcoes?: Qualquer) => osApi.montar(host, opcoes);
  const atualizarTabelaOs = (force?: boolean) => osApi.atualizar(Boolean(force));
  const filtrarTabelaOs = (filtro?: Qualquer) => osApi.filtrar(filtro);
  const revelarLinhaOs = (row?: Qualquer) => osApi.revelar(row);
  const seriesFiltradasOs = () => osApi.series();

  // ---------- browser behaviour ----------
  function install(win: Janela) {
    const doc: Qualquer = win.document;
    if (!doc || instalada) return;
    instalada = true;

    const el = (tag: string, className?: string, text?: string): Qualquer => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const safeStorage = {
      get(key: Qualquer) { try { return win.localStorage.getItem(key); } catch (_) { return null; } },
      set(key: Qualquer, value: Qualquer) { try { win.localStorage.setItem(key, value); } catch (_) { /* optional convenience */ } },
    };
    const toast = (message: Qualquer, type: Qualquer) => {
      if (typeof win.showToast === "function") win.showToast(message, type);
    };

    // ----- density -----
    function applyDensity(density: Qualquer) {
      if (density === "compact") doc.documentElement.setAttribute("data-ux-density", "compact");
      else doc.documentElement.removeAttribute("data-ux-density");
      doc.querySelectorAll("[data-ux-density-toggle]").forEach((button: Qualquer) => {
        button.setAttribute("aria-pressed", String(density === "compact"));
      });
    }
    applyDensity(safeStorage.get(DENSITY_KEY) === "compact" ? "compact" : "comfortable");

    // ----- sortable / copyable tables -----
    function isActionColumn(rows: Qualquer, column: Qualquer) {
      const cells = rows.map((row: Qualquer) => row.cells[column]).filter(Boolean);
      return cells.length > 0 && cells.every((cell: Qualquer) => cell.querySelector("textarea, input, select, button"));
    }

    function cellText(cell: Qualquer) {
      if (!cell) return "";
      const field = cell.querySelector("textarea, input");
      return field ? field.value : cell.textContent;
    }

    function visibleRows(tbody: Qualquer) {
      return Array.from<Qualquer>(tbody.rows).filter(row => !row.hidden && win.getComputedStyle(row).display !== "none");
    }

    function enhanceTable(table: Qualquer) {
      if (table.dataset.uxTable) return;
      const tbody = table.tBodies[0];
      const headRow = table.tHead?.rows[0];
      if (!tbody || !headRow || !tbody.rows.length) return;
      table.dataset.uxTable = "ready";
      const originalOrder = Array.from<Qualquer>(tbody.rows);
      const headers = Array.from<Qualquer>(headRow.cells);

      headers.forEach((th, column) => {
        if (isActionColumn(originalOrder, column)) return;
        const label = th.textContent.trim();
        const button = el("button", "ux-sort-button");
        button.type = "button";
        button.setAttribute("aria-label", `Ordenar por ${label}`);
        button.append(el("span", "", label), el("span", "ux-sort-icon"));
        button.lastChild.setAttribute("aria-hidden", "true");
        th.replaceChildren(button);
        th.setAttribute("aria-sort", "none");
        button.addEventListener("click", () => {
          const direction = nextDirection(th.getAttribute("aria-sort"));
          headers.forEach(other => { if (other.hasAttribute("aria-sort")) other.setAttribute("aria-sort", "none"); });
          th.setAttribute("aria-sort", direction);
          // Rows are moved, never recreated, so annotation fields keep their values and listeners.
          const current = originalOrder.slice();
          const texts = current.map(row => cellText(row.cells[column]));
          const order = sortedOrder(texts, direction);
          const fragment = doc.createDocumentFragment();
          order.forEach(index => fragment.appendChild(current[index]));
          tbody.appendChild(fragment);
          announceSort(label, direction);
        });
      });

      // Resumo F3 (Novo layout): tabela marcada com data-sem-ferramentas fica sem "Copiar tabela" e sem "Modo compacto".
      const wrap = table.closest(".comparison-desktop-table:not([data-sem-ferramentas])");
      const host = wrap && tableToolsHost(wrap);
      if (wrap && (host || !wrap.previousElementSibling?.classList?.contains("ux-table-tools"))) {
        const tools = el("div", "ux-table-tools");
        const copy = el("button", "ux-table-tool", "Copiar tabela");
        copy.type = "button";
        copy.addEventListener("click", () => copyTable(table, copy));
        const density = el("button", "ux-table-tool", "Modo compacto");
        density.type = "button";
        density.setAttribute("data-ux-density-toggle", "");
        density.setAttribute("aria-pressed", String(doc.documentElement.getAttribute("data-ux-density") === "compact"));
        density.addEventListener("click", () => {
          const next = doc.documentElement.getAttribute("data-ux-density") === "compact" ? "comfortable" : "compact";
          safeStorage.set(DENSITY_KEY, next);
          applyDensity(next);
        });
        tools.append(copy, density);
        if (host) {
          // A barra antiga copiaria a tabela anterior: troca pela nova.
          Array.from<Qualquer>(host.children).filter(child => child.classList?.contains("ux-table-tools")).forEach(child => child.remove());
          host.classList.add("ux-table-tools-host");
          host.appendChild(tools);
        } else {
          wrap.parentNode.insertBefore(tools, wrap);
        }
      }
    }

    // Botões na linha do título da tabela (Resumo F3), sem linha própria entre o título e a tabela.
    function tableToolsHost(wrap: Qualquer) {
      const prev = wrap.previousElementSibling;
      if (prev?.classList?.contains("ux-table-tools-host")) return prev;
      if (prev?.tagName === "H5") {
        // Os botões não entram no h5: o nome do título ficaria com o texto deles.
        const row = el("div", "ux-table-tools-host");
        wrap.parentNode.insertBefore(row, prev);
        row.appendChild(prev);
        return row;
      }
      const group = wrap.parentNode;
      if (!group?.classList?.contains("history-filter-group") || group.children[0] !== wrap) return null;
      const header = group.previousElementSibling;
      // O h4 pode vir dentro de um div com o ícone de ajuda (ⓘ) ao lado.
      const temH4 = (node: Qualquer) => node.tagName === "H4" || Array.from<Qualquer>(node.children || []).some(filho => filho.tagName === "H4");
      return header?.tagName === "DIV" && Array.from(header.children).some(temH4) ? header : null;
    }

    function announceSort(label: Qualquer, direction: Qualquer) {
      const text = direction === "none"
        ? "Ordem original restaurada."
        : `Ordenado por ${label}, ${direction === "ascending" ? "crescente" : "decrescente"}.`;
      let region = doc.getElementById("ux-sort-status");
      if (!region) {
        region = el("div", "sr-only");
        region.id = "ux-sort-status";
        region.setAttribute("role", "status");
        region.setAttribute("aria-live", "polite");
        doc.body.appendChild(region);
      }
      region.textContent = text;
    }

    async function copyTable(table: Qualquer, button: Qualquer) {
      const headRow = table.tHead.rows[0];
      const headers = Array.from<Qualquer>(headRow.cells).map(cell => cell.textContent);
      const rows = visibleRows(table.tBodies[0]).map(row => Array.from<Qualquer>(row.cells).map(cellText));
      const text = toTsv(headers, rows);
      try {
        if (typeof win.copiarTextoParaAreaTransferencia === "function") await win.copiarTextoParaAreaTransferencia(text);
        else await win.navigator.clipboard.writeText(text);
        toast(`Tabela copiada (${pluralize(rows.length, "linha", "linhas")}).`, "success");
      } catch (_) {
        toast("Não foi possível copiar a tabela.", "error");
      }
    }

    function scanTables() {
      doc.querySelectorAll(".comparison-desktop-table table:not([data-ux-table])").forEach(enhanceTable);
    }

    let lastFetch = 0;
    let requestSerial = 0;
    let painelOk = false; // a última resposta do painel chegou e foi desenhada
    const tabelaOs = criarTabelaOs(win, doc, el);
    const { refreshTicketSummary } = tabelaOs;


    // ----- sidebar divergence badge -----
    // The group summary carries only this alert count; the summary's aria-label replaces its content, so it repeats the count.
    const SUMMARY_LABEL = "Abrir históricos e análises";
    function renderBadge(total: Qualquer) {
      const summary = doc.querySelector('.header-action-group[data-action-group="analysis"] > summary');
      const anchor = summary?.querySelector(".header-action-group-chevron");
      if (!anchor) return;
      let badge = doc.getElementById("badge-divergencias-ux");
      if (!total) {
        badge?.remove();
        summary.setAttribute("aria-label", SUMMARY_LABEL);
        return;
      }
      if (!badge) {
        badge = el("span", "ux-divergence-badge");
        badge.id = "badge-divergencias-ux";
        anchor.insertAdjacentElement("beforebegin", badge);
      }
      const label = `${pluralize(total, "divergência", "divergências")} na última atualização`;
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.setAttribute("aria-label", label);
      badge.title = label;
      summary.setAttribute("aria-label", `${SUMMARY_LABEL}, ${label}`);
    }

    // ----- header notification center -----
    const notificationButton = doc.getElementById("btn-notificacoes");
    const notificationBadge = doc.getElementById("badge-notificacoes");
    const notificationPanel = doc.getElementById("notification-center-panel");
    const notificationSummary = doc.getElementById("notification-center-summary");
    const notificationTitle = doc.getElementById("notification-center-title");
    let hasNotificationData = false;

    function atualizarResumoNotificacoes(text: Qualquer) {
      if (notificationSummary && notificationSummary.textContent !== text) notificationSummary.textContent = text;
    }

    function renderizarNotificacoes(data: Qualquer) {
      const osParadas = data?.os_paradas;
      const divergenciasNovas = data?.divergencias_novas;
      const semAcesso60 = data?.sem_acesso_60_dias;
      const semAcesso60Ativo = (semAcesso60?.estado === "passou_60" && Number(semAcesso60.total_passou) > 0)
        || (semAcesso60?.estado === "limite_55" && Number(semAcesso60.total_limite) > 0);
      const outroTecnico = data?.chamados_outro_tecnico;
      const outroTecnicoAtivo = !outroTecnico?.indisponivel && Number(outroTecnico?.total) > 0;
      // Mesma regra do cartão #alerta-finalizacao-softexpert: leitura sem falha, total > 0 e ao menos um item.
      const falhasFinalizacao = data?.falhas_finalizacao_softexpert;
      const falhasFinalizacaoAtivo = !falhasFinalizacao?.indisponivel && Number(falhasFinalizacao?.total) > 0
        && Array.isArray(falhasFinalizacao?.itens) && falhasFinalizacao.itens.some((item: Qualquer) => item && typeof item === "object");
      // Mesma regra do cartão #alerta-backups-regionais (frontend/src/paineis/indicadores-home/estado.ts): serviço ligado, sem falha e com regional pendente.
      const backups = data?.backups_regionais;
      const temRegional = (lista: Qualquer) => Array.isArray(lista) && lista.some(cidade => String(cidade ?? "").trim());
      const backupsAtivo = Boolean(backups) && typeof backups === "object" && !backups.indisponivel
        && (temRegional(backups.pendencias?.sem_backup) || temRegional(backups.pendencias?.conferir));
      // Mesma regra do cartão #alerta-lembretes-agendados (contagemLembretesAgendados): disponível e com atrasados ou hoje; conta 1 aviso, não a quantidade de lembretes.
      const lembretesAtivo = contagemLembretesAgendados(data?.lembretes_agendados) !== null;
      const total = Number(osParadas?.estado === "paradas" && Number(osParadas.total) > 0)
        + Number(divergenciasNovas?.estado === "novas" && Number(divergenciasNovas.total) > 0)
        + Number(semAcesso60Ativo) + Number(outroTecnicoAtivo) + Number(falhasFinalizacaoAtivo) + Number(backupsAtivo) + Number(lembretesAtivo);
      const label = total
        ? `Notificações, ${pluralize(total, "aviso ativo", "avisos ativos")}`
        : "Notificações, nenhum aviso ativo";

      if (notificationBadge) {
        notificationBadge.textContent = String(total);
        notificationBadge.hidden = total === 0;
      }
      if (notificationTitle) notificationTitle.textContent = `Pendências · ${total}`;
      if (notificationButton) {
        notificationButton.setAttribute("aria-label", label);
        notificationButton.title = label;
      }
      if (notificationPanel) {
        notificationPanel.dataset.state = "ready";
        notificationPanel.setAttribute("aria-busy", "false");
      }
      atualizarResumoNotificacoes(total ? `${pluralize(total, "aviso ativo", "avisos ativos")}.` : "Nenhum aviso ativo.");
      hasNotificationData = true;
    }

    function renderizarFalhaNotificacoes() {
      if (notificationPanel) {
        notificationPanel.dataset.state = "error";
        notificationPanel.setAttribute("aria-busy", "false");
      }
      if (!hasNotificationData) {
        if (notificationBadge) notificationBadge.hidden = true;
        notificationButton?.setAttribute("aria-label", "Notificações, atualização indisponível");
        if (notificationButton) notificationButton.title = "Notificações, atualização indisponível";
        atualizarResumoNotificacoes("Não foi possível atualizar os avisos. Tente novamente.");
        return;
      }
      atualizarResumoNotificacoes("Atualização indisponível; exibindo os últimos avisos recebidos.");
    }

    function fecharCentralNotificacoes() {
      if (!notificationPanel || !notificationButton) return;
      notificationPanel.hidden = true;
      notificationButton.setAttribute("aria-expanded", "false");
    }

    if (notificationButton && notificationPanel) {
      notificationButton.addEventListener("click", () => {
        const abrir = notificationPanel.hidden;
        notificationPanel.hidden = !abrir;
        notificationButton.setAttribute("aria-expanded", String(abrir));
        if (!abrir) return;
        notificationPanel.dataset.state = "loading";
        notificationPanel.setAttribute("aria-busy", "true");
        doc.dispatchEvent(new win.Event("simpress:atualizar-notificacoes"));
      });

      notificationPanel.addEventListener("click", (event: Qualquer) => {
        if (!event.target?.closest?.(".ck-aviso__acao, .stale-base-alert-action")) return;
        fecharCentralNotificacoes();
        notificationButton.focus();
      });

      doc.addEventListener("click", (event: Qualquer) => {
        if (notificationPanel.hidden || notificationPanel.contains(event.target) || notificationButton.contains(event.target)) return;
        fecharCentralNotificacoes();
      });

      doc.addEventListener("keydown", (event: Qualquer) => {
        if (event.key !== "Escape" || notificationPanel.hidden) return;
        event.preventDefault();
        fecharCentralNotificacoes();
        notificationButton.focus();
      });
    }

    async function refresh(force: Qualquer, depoisDeMudanca = false) {
      if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return;
      lastFetch = Date.now();
      const serial = ++requestSerial;
      try {
        const data = await painelCompartilhado<Qualquer>(() => apiFetch(ENDPOINT, { headers: { Accept: "application/json" } }), { novo: depoisDeMudanca });
        if (serial !== requestSerial) return;
        painelOk = true;
        renderBadge(divergenceTotal(data.ultima_comparacao));
        renderizarNotificacoes(data);
        // Other Home cards (usage in the last 30 days) render from the same response.
        doc.dispatchEvent(new win.CustomEvent("simpress:painel-atualizado", { detail: data }));
      } catch (error: Qualquer) {
        // The dashboard is optional; never disturb the main flow.
        if (serial === requestSerial) {
          painelOk = false;
          renderBadge(0);
          renderizarFalhaNotificacoes();
          // Quem espera o painel (Backups, F3) troca "aguardando" por "indisponível"; sem detalhe, nada pessoal.
          doc.dispatchEvent(new win.CustomEvent("simpress:painel-indisponivel"));
        }
        win.console?.warn?.("Painel indisponível:", error?.message || error);
      }
    }

    doc.addEventListener("simpress:atualizar-notificacoes", (evento: Qualquer) => refresh(true, (evento as CustomEvent)?.detail?.depoisDeMudanca === true));

    // Quem monta uma tabela .comparison-desktop-table dispara este evento (comparison-result.js, transfer-history.js).
    doc.addEventListener("simpress:tabelas-renderizadas", scanTables);
    scanTables();

    // A change of the history counter means an update/restore/delete happened: refresh both the panel and the badge.
    const counter = doc.getElementById("total-historico-comparacoes");
    // A contagem da partida (historico-comparacoes/estado.ts marca data-contagem-partida) não é uma atualização: se o painel
    // pedido na instalação já chegou, ela não pede de novo (se ainda está a caminho, o pedido é dividido; se falhou, tenta de novo).
    if (counter) new win.MutationObserver(() => {
      const daPartida = counter.hasAttribute("data-contagem-partida");
      counter.removeAttribute("data-contagem-partida");
      if (daPartida && painelOk) return;
      refresh(true);
    }).observe(counter, { childList: true, characterData: true, subtree: true });
    // Home and Transporte keep refreshing the sidebar divergence badge.
    const abasComDados = ["tab-home", "tab-retirada-entrega"].map(id => doc.getElementById(id)).filter(Boolean);
    const abaComDadosAtiva = () => abasComDados.some(tab => tab.getAttribute("aria-selected") === "true");
    // Se o painel ainda não foi preenchido (ex.: falha anterior), abrir a aba tenta de novo sem esperar o intervalo mínimo.
    const abasObserver = new win.MutationObserver(() => {
      if (abaComDadosAtiva()) refresh(false);
    });
    abasComDados.forEach(tab => abasObserver.observe(tab, { attributes: true, attributeFilter: ["aria-selected"] }));

    doc.addEventListener("simpress:chamados-atualizados", () => refreshTicketSummary(true));
    doc.addEventListener("simpress:usuarios-equipamento-atualizados", () => refreshTicketSummary(true));

    osApi = { montar: tabelaOs.montarTabelaOs, atualizar: refreshTicketSummary, filtrar: tabelaOs.filtrarTabelaOs, revelar: tabelaOs.revelarLinhaOs, series: tabelaOs.seriesFiltradasOs };
    refresh(true);
  }

  return Object.freeze({
    ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv,
    divergenceTotal, barPercentages, formatNumber, pluralize, install,
    montarTabelaOs, atualizarTabelaOs, filtrarTabelaOs, revelarLinhaOs, seriesFiltradasOs,
  });
}

// Instância usada pelo app (montar.tsx chama install) e pelos consumidores; os testes criam outra com criarPaineisDados().
export const paineisDados = criarPaineisDados();
export const { install, montarTabelaOs, atualizarTabelaOs, filtrarTabelaOs, revelarLinhaOs, seriesFiltradasOs } = paineisDados;
export { ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv, divergenceTotal, barPercentages, formatNumber, pluralize } from "./utilitarios.ts";
