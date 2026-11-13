(function (root, factory) {
  const modelo = typeof module === "object" && module.exports ? require("../shared/chamados-os-model.js") : root.SimpressChamadosOsModel;
  const api = factory(modelo);
  if (typeof module === "object" && module.exports) module.exports = api;
  else {
    root.SimpressDataPanels = api;
    if (root.document) api.install(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function createDataPanels(modelo) {
  "use strict";

  const ENDPOINT = "/api/painel";
  const DENSITY_KEY = "simpress:table-density";
  const REFRESH_MIN_MS = 15000;
  const DIVERGENCE_FIELDS = Object.freeze(["divergencias_local", "divergencias_apelidos_manuais"]);

  // ---------- sorting helpers (pure) ----------
  const DATE_BR = /^(\d{2})\/(\d{2})\/(\d{4})(?:\D+(\d{2}):(\d{2}))?/;
  const NUMBER = /^-?\d+(?:[.,]\d+)?$/;

  function sortKey(text) {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!value || value === "—" || value === "-") return { kind: "empty", value: "" };
    const date = DATE_BR.exec(value);
    if (date) {
      const [, day, month, year, hour = "0", minute = "0"] = date;
      return { kind: "number", value: Date.UTC(+year, +month - 1, +day, +hour, +minute) };
    }
    if (NUMBER.test(value)) return { kind: "number", value: parseFloat(value.replace(",", ".")) };
    return { kind: "text", value };
  }

  function compareValues(a, b) {
    const left = sortKey(a);
    const right = sortKey(b);
    if (left.kind === "empty" || right.kind === "empty") {
      return left.kind === right.kind ? 0 : left.kind === "empty" ? 1 : -1;
    }
    if (left.kind === "number" && right.kind === "number") return left.value - right.value;
    if (left.kind !== right.kind) return left.kind === "number" ? -1 : 1;
    return left.value.localeCompare(right.value, "pt-BR", { numeric: true, sensitivity: "base" });
  }

  // Cycle: none -> ascending -> descending -> none.
  function nextDirection(current) {
    return current === "ascending" ? "descending" : current === "descending" ? "none" : "ascending";
  }

  // Returns the original indexes in display order; ties keep the original order (stable).
  function sortedOrder(texts, direction) {
    const indexes = texts.map((_, index) => index);
    if (direction !== "ascending" && direction !== "descending") return indexes;
    const sign = direction === "ascending" ? 1 : -1;
    return indexes.sort((a, b) => {
      const left = sortKey(texts[a]);
      const right = sortKey(texts[b]);
      // Empty values always stay last, whatever the direction.
      if (left.kind === "empty" || right.kind === "empty") {
        return left.kind === right.kind ? a - b : left.kind === "empty" ? 1 : -1;
      }
      return sign * compareValues(texts[a], texts[b]) || a - b;
    });
  }

  function toTsv(headers, rows) {
    const clean = value => String(value ?? "").replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    return [headers, ...rows].map(row => row.map(clean).join("\t")).join("\n");
  }

  // ---------- dashboard helpers (pure) ----------
  function divergenceTotal(latest) {
    const items = Array.isArray(latest?.atencao) ? latest.atencao : [];
    return items
      .filter(item => DIVERGENCE_FIELDS.includes(item?.campo))
      .reduce((sum, item) => sum + (Number(item.total) || 0), 0);
  }

  function barPercentages(entries) {
    const max = Math.max(0, ...entries.map(entry => Number(entry.total) || 0));
    return entries.map(entry => (max ? Math.max(4, Math.round(((Number(entry.total) || 0) / max) * 100)) : 0));
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("pt-BR");
  }

  function pluralize(count, singular, plural) {
    return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
  }

  // ---------- browser behaviour ----------
  function install(win) {
    const doc = win.document;
    if (!doc || install.done) return;
    install.done = true;

    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const safeStorage = {
      get(key) { try { return win.localStorage.getItem(key); } catch (_) { return null; } },
      set(key, value) { try { win.localStorage.setItem(key, value); } catch (_) { /* optional convenience */ } },
    };
    const toast = (message, type) => {
      if (typeof win.showToast === "function") win.showToast(message, type);
    };

    // ----- density -----
    function applyDensity(density) {
      if (density === "compact") doc.documentElement.setAttribute("data-ux-density", "compact");
      else doc.documentElement.removeAttribute("data-ux-density");
      doc.querySelectorAll("[data-ux-density-toggle]").forEach(button => {
        button.setAttribute("aria-pressed", String(density === "compact"));
      });
    }
    applyDensity(safeStorage.get(DENSITY_KEY) === "compact" ? "compact" : "comfortable");

    // ----- sortable / copyable tables -----
    function isActionColumn(rows, column) {
      const cells = rows.map(row => row.cells[column]).filter(Boolean);
      return cells.length > 0 && cells.every(cell => cell.querySelector("textarea, input, select, button"));
    }

    function cellText(cell) {
      if (!cell) return "";
      const field = cell.querySelector("textarea, input");
      return field ? field.value : cell.textContent;
    }

    function visibleRows(tbody) {
      return Array.from(tbody.rows).filter(row => !row.hidden && win.getComputedStyle(row).display !== "none");
    }

    function enhanceTable(table) {
      if (table.dataset.uxTable) return;
      const tbody = table.tBodies[0];
      const headRow = table.tHead?.rows[0];
      if (!tbody || !headRow || !tbody.rows.length) return;
      table.dataset.uxTable = "ready";
      const originalOrder = Array.from(tbody.rows);
      const headers = Array.from(headRow.cells);

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

      const wrap = table.closest(".comparison-desktop-table");
      if (wrap && !wrap.previousElementSibling?.classList?.contains("ux-table-tools")) {
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
        wrap.parentNode.insertBefore(tools, wrap);
      }
    }

    function announceSort(label, direction) {
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

    async function copyTable(table, button) {
      const headRow = table.tHead.rows[0];
      const headers = Array.from(headRow.cells).map(cell => cell.textContent);
      const rows = visibleRows(table.tBodies[0]).map(row => Array.from(row.cells).map(cellText));
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

    // ----- tabela de OS (montada em Chamados via montarTabelaOs) -----
    let lastFetch = 0;
    let requestSerial = 0;
    let ticketSummaryRequestSerial = 0;
    const textoOs = value => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

    // Estado por seção montada via montarTabelaOs; o filtro externo só esconde linhas já renderizadas.
    const osExternas = new Map();
    const osSerie = new WeakMap();
    let osExternaSeq = 0;
    const idLivre = (node, id) => { if (!doc.getElementById(id)) node.id = id; };

    // Triagem (grupo da série, de opcoes.grupoSerie): "ativos" aceita qualquer grupo; atencao = atrasados ou sem data.
    function correspondeTriagemOs(st, grupo) {
      if (st.atencao && grupo !== "atrasados" && grupo !== "sem_data") return false;
      if (!st.triagem) return true;
      return st.triagem === "ativos" ? Boolean(grupo) : grupo === st.triagem;
    }

    // Sem termo de busca a lista mostra 25 OS por vez ("Carregar mais", como a aba Chamados/F5); com termo, mostra todas as que casam.
    const OS_POR_PAGINA = 25;
    // data-busca: série, OS, usuário, hostname, modelo, UTIC salvo e "técnico" (OS com envio técnico), já sem acento; rótulos de botões ficam de fora.
    // data-busca-descricao: descrição da Oracle, sem acento; casa só por início de palavra ("ana" não acha "Mariana").
    // Equipamentos casam palavra inteira (com plural) na descrição e no data-busca; mac e macbook são sinônimos ("imac" e "macaco" ficam de fora).
    const EQUIPAMENTOS_OS = new Map([["mac", "mac(book)?s?"], ["macbook", "mac(book)?s?"], ["teclado", "teclados?"], ["mouse", "mouses?"], ["zbook", "zbooks?"], ["monitor", "monitor(es)?"]]);
    const escaparRegex = texto => texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regexesBusca = new Map();
    // Cada palavra do termo vira um teste; nome completo exige todas as palavras (AND).
    function testesBuscaOs(termo) {
      if (!regexesBusca.has(termo)) {
        if (regexesBusca.size > 50) regexesBusca.clear();
        regexesBusca.set(termo, termo.split(/\s+/).filter(Boolean).map(palavra => {
          const equipamento = EQUIPAMENTOS_OS.get(palavra);
          const regex = new RegExp("(^|[^a-z0-9])(" + (equipamento || escaparRegex(palavra)) + ")" + (equipamento ? "(?![a-z0-9])" : ""));
          return equipamento
            ? (busca, descricao) => regex.test(busca) || regex.test(descricao)
            : (busca, descricao) => busca.includes(palavra) || regex.test(descricao);
        }));
      }
      return regexesBusca.get(termo);
    }
    function casaTermoOs(termo, item) {
      const busca = item.dataset.busca || "";
      if (!termo) return true;
      // Termo inteiro dentro do data-busca: comportamento anterior (série, OS, hostname, modelo...); termo com equipamento não usa o atalho ("mac" não casa "PRMAC01").
      if (busca.includes(termo) && !termo.split(/\s+/).some(palavra => EQUIPAMENTOS_OS.has(palavra))) return true;
      const descricao = item.dataset.buscaDescricao || "";
      return testesBuscaOs(termo).every(teste => teste(busca, descricao));
    }
    // Busca, Relação, Atenção e Triagem valem nas duas sub-abas (Abertas e Finalizadas); a sub-aba é só mais uma dimensão do filtro.
    const casaFiltrosOs = (st, termo, item) => casaTermoOs(termo, item)
      && (!st.relacao || st.relacao === "todos" || item.dataset.relacao === st.relacao)
      && correspondeTriagemOs(st, item.dataset.triagem || "");
    // st.situacao vazio = sem sub-aba (janela Chamado × OS): todas as linhas.
    const naSituacaoOs = (st, item) => !st.situacao || (item.dataset.finalizada === "true") === (st.situacao === "finalizadas");
    const casaOs = (st, termo, item) => casaFiltrosOs(st, termo, item) && naSituacaoOs(st, item);
    const statusOs = section => osExternas.get(section)?.status || section.querySelector(".ticket-summary-status");
    // OS finalizada = marca ativa para a série+OS (a mesma regra do selo "Chamado finalizado"); marcas null (leitura falhou) = tudo em Abertas.
    const osFinalizada = (marcas, serie, os) => Boolean(marcas?.get(osObsKey(serie, os))?.some(marca => marca?.ativa));

    // Leituras opcionais que falharam: a tabela segue montada e o status diz o que faltou.
    function sufixoFalhasOs(st) {
      const falhas = [st.falhaUsuarios && "usuário e hostname indisponíveis", st.falhaMarcas && "marcas de OS finalizada indisponíveis"].filter(Boolean);
      return falhas.length ? "; " + falhas.join("; ") + "." : "";
    }

    // Números das abas (opcoes.aoContarAbas): só avisa o host quando mudam.
    function avisarAbasOs(st, porAba) {
      if (!st.aoContarAbas || st.soOs || (st.abas?.abertas === porAba.abertas && st.abas?.finalizadas === porAba.finalizadas)) return;
      st.abas = { ...porAba };
      st.aoContarAbas({ ...porAba });
    }

    // KPIs e triagem do host contam só a sub-aba Abertas e não mudam ao trocar de sub-aba: o host recebe as OS abertas e, dos chamados do relatório,
    // só as séries com pelo menos uma OS aberta.
    function avisarSituacaoOs(st, records, report, marcas) {
      const comAberta = new Set();
      let os = 0;
      records.forEach(record => record.ordens.forEach(order => {
        if (osFinalizada(marcas, record.serie, order.os)) return;
        os += 1;
        comAberta.add(serialKey(record.serie));
      }));
      const chamados = (Array.isArray(report?.chamados) ? report.chamados : []).filter(ticket => comAberta.has(serialKey(ticket?.serie)));
      st.aoContarSituacao({ os, chamados });
    }

    function filtrarSecaoOs(section) {
      const st = osExternas.get(section);
      if (!st) return;
      const termo = textoOs(st.busca.trim());
      const itens = [...section.querySelectorAll("tbody tr[data-serial]")];
      const series = new Set();
      const mostradas = new Set();
      // Linhas que passam nos filtros em cada sub-aba, sem o limite da página: são os números das abas.
      const porAba = { abertas: 0, finalizadas: 0 };
      let visiveis = 0;
      let total = 0;
      itens.forEach(item => {
        const daSituacao = naSituacaoOs(st, item);
        if (daSituacao) total += 1;
        const passa = casaFiltrosOs(st, termo, item);
        if (passa) porAba[item.dataset.finalizada === "true" ? "finalizadas" : "abertas"] += 1;
        const ok = passa && daSituacao;
        item.hidden = !ok || (!termo && visiveis >= st.limite);
        if (!ok) return;
        series.add(item.dataset.serial);
        if (!item.hidden) mostradas.add(item.dataset.serial);
        visiveis += 1;
      });
      section.querySelectorAll("tbody tr[data-andamento]").forEach(row => { row.hidden = !mostradas.has(row.dataset.andamento); });
      const mais = section.querySelector("[data-os-mais]");
      if (mais) {
        mais.hidden = Boolean(termo) || visiveis <= st.limite;
        mais.querySelector(".sebrae-mais__n").textContent = mais.hidden ? ""
          : "Mostrando " + formatNumber(st.limite) + " de " + formatNumber(visiveis);
      }
      if (!st.renderizada) return;
      avisarAbasOs(st, porAba);
      const status = statusOs(section);
      const texto = (visiveis === total ? formatNumber(visiveis) : formatNumber(visiveis) + " de " + formatNumber(total)) + " OS · "
        + pluralize(series.size, "série", "séries") + sufixoFalhasOs(st);
      // role=status: reescrever o mesmo texto (ex.: "Carregar mais") faria o leitor de tela anunciar de novo.
      if (status.textContent !== texto) status.textContent = texto;
    }

    // Abrir uma OS escondida só pela página (não pelo filtro): amplia a página até ela. Devolve se a linha ficou visível.
    function revelarLinhaOs(row) {
      const section = row?.closest?.(".ck-os");
      const st = osExternas.get(section);
      if (!st || !row.hidden) return Boolean(row && !row.hidden);
      const termo = textoOs(st.busca.trim());
      // A OS está na outra sub-aba: vai para ela (se passar nos filtros), volta à primeira página e avisa o host para atualizar as abas.
      if (!naSituacaoOs(st, row)) {
        if (!casaFiltrosOs(st, termo, row)) return false;
        st.situacao = row.dataset.finalizada === "true" ? "finalizadas" : "abertas";
        st.limite = OS_POR_PAGINA;
        st.aoMudarSituacao?.(st.situacao);
        filtrarSecaoOs(section);
        if (!row.hidden) return true;
      }
      const casam = [...section.querySelectorAll("tbody tr[data-serial]")].filter(item => casaOs(st, termo, item));
      const posicao = casam.indexOf(row);
      if (posicao < 0) return false;
      st.limite = Math.max(st.limite, Math.ceil((posicao + 1) / OS_POR_PAGINA) * OS_POR_PAGINA);
      filtrarSecaoOs(section);
      return !row.hidden;
    }

    // Séries de todas as OS que passam no filtro atual, em todas as páginas (o "Exportar Excel" sai igual à tela).
    // null = nenhuma tabela carregada (quem chama mantém o caminho antigo); tabela carregada sem OS devolve [].
    function seriesFiltradasOs() {
      let carregada = false;
      const series = new Set();
      osExternas.forEach((st, section) => {
        if (st.soOs || !section.isConnected || !(st.renderizada || section.dataset.estado === "vazio")) return;
        carregada = true;
        const termo = textoOs(st.busca.trim());
        section.querySelectorAll("tbody tr[data-serial]").forEach(item => { if (casaOs(st, termo, item)) series.add(item.dataset.serial); });
      });
      return carregada ? [...series] : null;
    }

    function filtrarTabelaOs(filtro = {}) {
      osExternas.forEach((st, section) => {
        if (st.soOs) return; // janela Chamado × OS: mostra só a OS pedida, sem filtro da F6
        const antes = [st.busca, st.relacao, st.triagem, st.atencao, st.situacao].join("|");
        if ("busca" in filtro) {
          st.busca = String(filtro.busca || "");
          const campo = section.querySelector(".ck-os__busca input");
          if (campo) campo.value = st.busca;
        }
        if ("relacao" in filtro) st.relacao = String(filtro.relacao || "");
        if ("triagem" in filtro) st.triagem = String(filtro.triagem || "");
        if ("atencao" in filtro) st.atencao = Boolean(filtro.atencao);
        if ("situacao" in filtro) st.situacao = filtro.situacao === "finalizadas" ? "finalizadas" : "abertas";
        // Só filtro novo (ou outra sub-aba) volta à primeira página; recriar a tabela (vínculo salvo) mantém o que já estava aberto.
        if (antes !== [st.busca, st.relacao, st.triagem, st.atencao, st.situacao].join("|")) st.limite = OS_POR_PAGINA;
        filtrarSecaoOs(section);
      });
    }

    function montarTabelaOs(host, opcoes = {}) {
      if (!host) return null;
      osExternas.forEach((_, s) => { if (!s.isConnected) osExternas.delete(s); });
      const existente = [...osExternas.keys()].find(s => s.parentNode === host);
      if (existente) return existente;
      const section = el("section", "ck-cartao ck-os");
      const tituloId = "ck-os-titulo-" + (++osExternaSeq);
      section.setAttribute("aria-labelledby", tituloId);
      const title = el("h2", "ck-cartao__titulo", opcoes.titulo || "OS por equipamento");
      title.id = tituloId;
      const status = el("p", "ck-cartao__meta ticket-summary-status", "Carregando OS…");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      // opcoes.semBusca: o host já tem a própria busca (filtrarTabelaOs). aoExpandirSerie(serie, celula) preenche o "Andamento";
      // grupoSerie(chamado) devolve o grupo de triagem da série (data-triagem); aoCarregar(relatorio) recebe o GET /api/operacoes/chamados que a tabela já faz (evita segunda requisição).
      // soOs { serie, os, chamado? }: só essa OS (janela Chamado × OS), fora dos filtros da F6; somenteLeitura: sem edição nem autosave
      // e, das marcas de finalização, só o selo das ativas (do chamado pedido, quando houver).
      // Sub-abas da F6 (só no host sem soOs/somenteLeitura): a tabela abre em "abertas"; filtrarTabelaOs({ situacao }) troca. O host recebe
      // aoContarSituacao({ os, chamados }) com as OS da sub-aba Abertas (KPIs e triagem), aoContarAbas({ abertas, finalizadas }) com os números das abas
      // (filtros aplicados, sem o limite da página), aoMudarSituacao(situacao) quando revelarLinhaOs troca de sub-aba e aoFocarAba() quando o foco
      // se perde porque a linha mudou de sub-aba. statusEm: elemento do host onde o status ("N OS · N séries") fica, em vez do cabeçalho.
      const st = {
        busca: "", relacao: "", triagem: "", atencao: false, limite: OS_POR_PAGINA, grupoSerie: opcoes.grupoSerie, renderizada: false, falhaUsuarios: false, falhaMarcas: false, carregada: false,
        aoExpandirSerie: opcoes.aoExpandirSerie, aoCarregar: opcoes.aoCarregar, abertas: new Set(),
        soOs: opcoes.soOs || null, somenteLeitura: Boolean(opcoes.somenteLeitura),
        situacao: opcoes.soOs || opcoes.somenteLeitura ? "" : "abertas", status,
        aoContarSituacao: opcoes.aoContarSituacao, aoContarAbas: opcoes.aoContarAbas, aoMudarSituacao: opcoes.aoMudarSituacao, aoFocarAba: opcoes.aoFocarAba, abas: null,
      };
      const head = el("div", "ck-cartao__cab");
      if (opcoes.statusEm && !st.soOs) {
        head.append(title);
        opcoes.statusEm.replaceChildren(status);
      } else head.append(title, status);
      if (!opcoes.semBusca) {
        const busca = el("label", "ck-os__busca");
        busca.append(el("span", "ck-sr", "Buscar série, OS ou usuário"));
        const campo = el("input", "ck-entrada ck-entrada--sm");
        campo.type = "search";
        campo.placeholder = "Série, OS ou usuário";
        campo.addEventListener("input", () => { st.busca = campo.value; st.limite = OS_POR_PAGINA; filtrarSecaoOs(section); });
        busca.append(campo);
        head.append(el("span", "ck-espaco"), busca);
        idLivre(campo, "ck-os-busca");
      }
      section.append(head);
      osExternas.set(section, st);
      host.append(section);
      if (!st.soOs) idLivre(status, "ck-os-contagem");
      refreshTicketSummary(false);
      return section;
    }

    function osSummaryRequest(url, options) {
      return win.fetch(url, { headers: { Accept: "application/json", ...(options?.headers || {}) }, ...options })
        .then(async response => {
          let data = {};
          try { data = await response.json(); } catch (_) { /* handled as an HTTP error below */ }
          if (!response.ok) throw new Error(data.detail || `Falha ${response.status}`);
          return data;
        });
    }

    function serialKey(value) {
      return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    function orderKey(value) {
      return String(value || "").replace(/\s+/g, "").toUpperCase();
    }

    // Janela Chamado × OS (mesmo critério de chamados-os-model.js): MacBook, a outra grafia só sem a série exata;
    // sem série (ou série fora do relatório), pela OS só se ela está em uma única série. seriesRelatorio: chaves de todas as séries do relatório.
    function soEssaOs(records, { serie, os }, seriesRelatorio) {
      const alvo = orderKey(os);
      const chave = serialKey(serie);
      const outra = chave.startsWith("S") ? chave.slice(1) : `S${chave}`;
      const achada = !chave ? "" : seriesRelatorio.has(chave) ? chave : seriesRelatorio.has(outra) ? outra : "";
      let registro = achada ? records.find(record => serialKey(record.serie) === achada) : null;
      if (!achada) {
        const comOs = records.filter(record => record.ordens.some(order => orderKey(order.os) === alvo));
        if (new Set(comOs.map(record => serialKey(record.serie))).size === 1) registro = comOs[0];
      }
      const ordens = registro ? registro.ordens.filter(order => orderKey(order.os) === alvo) : [];
      return ordens.length ? [{ ...registro, ordens }] : [];
    }

    function ticketOsLinkKey(record) {
      return JSON.stringify([record.fonte, serialKey(record.serie), orderKey(record.os)]);
    }

    // Observação do andamento por série+OS (igual à do F5). Fica fora da tabela: recriar a tabela não perde o que ainda não foi salvo.
    const osObs = new Map();
    let osObsSeq = 0;
    const osObsKey = (serie, os) => JSON.stringify([serialKey(serie), orderKey(os)]);
    const feedbackOs = (node, texto, situacao = "") => { node.textContent = texto; node.dataset.estado = situacao; };

    // ----- marca de OS finalizada (GET/PUT /api/operacoes/chamados/marcas-finalizacao) -----
    // Só apresentação e o PUT local do backend: nada vai ao SoftExpert, SharePoint, Excel ou Oracle, e desfazer nunca reabre o chamado.
    const MARCA_ROTA = "/api/operacoes/chamados/marcas-finalizacao";
    const CONFIRMA_MARCA = Object.freeze({
      desfazer: { titulo: "Desfazer a marca de finalização?", confirmar: "Desfazer",
        mensagem: chamado => `A marca some desta OS. O chamado ${chamado} não é reaberto no SoftExpert.` },
      refazer: { titulo: "Refazer a marca de finalização?", confirmar: "Refazer",
        mensagem: chamado => `A marca volta a aparecer nesta OS. Nada é gravado no SoftExpert (chamado ${chamado}).` },
    });
    const chamadoIgual = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();

    async function alterarMarcaOs(marca, acao, { bloco, status, section }) {
      const confirma = CONFIRMA_MARCA[acao];
      // Sem o diálogo de confirmação (win.confirmarAcao ausente) nada é alterado.
      if (confirma && !(await win.confirmarAcao?.({
        titulo: confirma.titulo, mensagem: confirma.mensagem(marca.chamado), confirmar: confirma.confirmar, cancelar: "Cancelar", destrutiva: false,
      }))) return;
      const botoes = [...bloco.querySelectorAll("button")];
      botoes.forEach(botao => { botao.disabled = true; botao.setAttribute("aria-busy", "true"); });
      try {
        await osSummaryRequest(MARCA_ROTA, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serie: marca.serie, os: marca.os, chamado: marca.chamado, acao }),
        });
        await refreshTicketSummary(true);
        doc.dispatchEvent(new win.CustomEvent("simpress:atualizar-notificacoes"));
        // A tabela foi recriada: devolve o foco ao primeiro botão da mesma marca.
        const id = bloco.dataset.marca;
        const novo = [...section.querySelectorAll(".ck-os-marca")].find(item => item.dataset.marca === id);
        // Desfazer/Refazer muda a OS de sub-aba: a linha nova fica escondida e o foco vai para a aba ativa (se o host tiver uma).
        if (novo && !novo.closest("tr")?.hidden) novo.querySelector("button")?.focus();
        else osExternas.get(section)?.aoFocarAba?.();
      } catch (error) {
        status.textContent = error.message || "Não foi possível atualizar a marca.";
        botoes.forEach(botao => { botao.disabled = false; botao.removeAttribute("aria-busy"); });
        botoes[0]?.focus();
      }
    }

    // Bloco de uma marca na célula Chamado: selo (só se ativa), motivo, botões e histórico. Textos do servidor entram só por textContent.
    // chamadoExibido: chamado que a célula já mostra como link (não repete o texto na marca); comData: "Finalizado em DD/MM/AAAA" na marca ativa (sub-aba Finalizadas).
    function renderMarcaOs(marca, { somenteLeitura, status, section, chamadoExibido = "", comData = false }) {
      const info = modelo.descreverMarca(marca);
      const bloco = el("div", "ck-os-marca");
      bloco.dataset.marca = JSON.stringify([modelo.chaveMarca(marca.serie, marca.os), String(marca.chamado || "")]);
      bloco.dataset.ativa = String(info.ativa);
      bloco.dataset.origem = String(marca.origem || "");
      const topo = el("div", "ck-os-marca__topo");
      if (info.selo) {
        const selo = el("span", "ck-badge ck-os-marca__selo", info.selo);
        selo.dataset.status = marca.origem === "outro_tecnico" ? "alerta" : "ok";
        topo.append(selo);
      }
      if (comData && info.ativa && marca.finalizado_em) topo.append(el("span", "os-finalizado-em", `Finalizado em ${modelo.formatarData(marca.finalizado_em)}`));
      if (marca.chamado && !(chamadoExibido && chamadoIgual(marca.chamado, chamadoExibido))) topo.append(el("span", "ck-os-marca__chamado ck-mono", String(marca.chamado)));
      if (info.dica) topo.append(el("span", "ck-os-marca__dica", info.dica));
      bloco.append(topo);
      if (info.motivo) bloco.append(el("p", "ck-os-marca__motivo", info.motivo));
      if (somenteLeitura) return bloco;
      const acoes = el("div", "ck-os-marca__acoes");
      const botao = (acao, texto, classe) => {
        const button = el("button", `ck-btn ${classe} ck-btn--sm ck-os-marca__botao`, texto);
        button.type = "button";
        button.dataset.acao = acao;
        button.setAttribute("aria-label", `${texto}, chamado ${marca.chamado}`);
        button.addEventListener("click", () => alterarMarcaOs(marca, acao, { bloco, status, section }));
        acoes.append(button);
      };
      if (info.podeConferir) botao("conferir", "Conferido", "ck-btn--secundario");
      if (info.podeDesfazer) botao("desfazer", "Desfazer", "ck-btn--fantasma");
      if (info.podeRefazer) botao("refazer", "Refazer", "ck-btn--secundario");
      bloco.append(acoes);
      if (info.historico.length) {
        const detalhes = el("details", "ck-os-marca__historico");
        detalhes.append(el("summary", "", "Histórico da marca"));
        const lista = el("ul", "ck-os-marca__lista");
        info.historico.forEach(linha => lista.append(el("li", "", linha)));
        detalhes.append(lista);
        bloco.append(detalhes);
      }
      return bloco;
    }

    // notas: { itens: Map(chave → texto salvo), seq } ou null quando a leitura falhou (caixa só leitura).
    function renderOsObservacao(serie, os, notas, somenteLeitura = false) {
      const textarea = el("textarea", "ck-entrada");
      textarea.rows = 2;
      textarea.maxLength = 4000;
      textarea.setAttribute("aria-label", "Observação do andamento");
      const key = osObsKey(serie, os);
      let reg = osObs.get(key);
      // Só leitura (janela Chamado × OS): não entra em osObs, para não tomar a caixa da F6 nem salvar nada.
      if (somenteLeitura) {
        textarea.readOnly = true;
        textarea.value = notas?.itens.get(key) ?? reg?.enviado ?? "";
        return [textarea];
      }
      if (notas) {
        const salvo = notas.itens.get(key) || "";
        if (!reg) osObs.set(key, reg = { texto: salvo, enviado: salvo, seq: 0, emVoo: 0, timer: 0, fila: null });
        // Só troca pelo servidor sem rascunho nem envio posterior à leitura.
        else if (reg.texto === reg.enviado && !reg.emVoo && reg.seq <= notas.seq) reg.texto = reg.enviado = salvo;
      }
      textarea.value = reg ? reg.texto : "";
      if (!notas) {
        textarea.readOnly = true;
        return [textarea];
      }
      const pendente = reg.texto !== reg.enviado;
      const feedback = el("p", "ck-campo__ajuda sebrae-obs__feedback", pendente ? "Alteração ainda não salva…" : "Salva automaticamente.");
      feedback.setAttribute("role", "status");
      feedback.dataset.estado = pendente ? "pendente" : "";
      Object.assign(reg, { serie, os, textarea, feedback });
      textarea.addEventListener("input", () => {
        reg.texto = textarea.value;
        clearTimeout(reg.timer);
        reg.timer = setTimeout(() => salvarOsObservacao(reg), 800);
        feedbackOs(feedback, "Alteração ainda não salva…", "pendente");
      });
      textarea.addEventListener("change", () => salvarOsObservacao(reg));
      textarea.addEventListener("blur", () => salvarOsObservacao(reg));
      return [textarea, feedback];
    }

    function salvarOsObservacao(reg) {
      clearTimeout(reg.timer);
      reg.fila = (reg.fila || Promise.resolve(true)).then(() => enviarOsObservacao(reg));
      return reg.fila;
    }

    async function enviarOsObservacao(reg) {
      const texto = reg.texto;
      if (texto === reg.enviado) {
        if (reg.feedback.dataset.estado === "pendente") feedbackOs(reg.feedback, "Salva automaticamente.");
        return true;
      }
      feedbackOs(reg.feedback, "Salvando…", "salvando");
      reg.seq = ++osObsSeq;
      reg.emVoo += 1;
      try {
        const dados = await osSummaryRequest("/api/operacoes/chamados/observacoes", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serie: reg.serie, os: reg.os, observacao: texto }),
        });
        reg.enviado = typeof dados.observacao === "string" ? dados.observacao : texto;
        if (reg.texto === texto) {
          reg.texto = reg.enviado;
          if (reg.textarea.value === texto) reg.textarea.value = reg.enviado;
        }
        feedbackOs(reg.feedback, "Salva.", "ok");
        return true;
      } catch (error) {
        feedbackOs(reg.feedback, `Não foi possível salvar: ${error.message}`, "erro");
        return false;
      } finally {
        reg.emVoo -= 1;
      }
    }

    function ticketSummarySourceLabel(sources) {
      const selected = Array.isArray(sources) ? sources : [sources];
      const labels = [];
      if (selected.includes("oracle")) labels.push("Oracle");
      if (selected.includes("simpress")) labels.push("Simpress");
      return labels.join(" + ") || "Fonte não informada";
    }

    function renderTicketSummaryOrderButton(record, label = record.os) {
      const button = el("button", "ticket-summary-order ticket-summary-order-link", label);
      const sources = Array.isArray(record.fontes) ? record.fontes : [record.fonte];
      button.type = "button";
      button.setAttribute("aria-label", "Abrir andamento em Chamados: " + ticketSummarySourceLabel(sources)
        + ", série " + record.serie + ", OS " + record.os);
      button.setAttribute("data-on-click", "abrirChamadoDaOs");
      button.setAttribute("data-args", JSON.stringify([sources, record.serie, record.os]));
      return button;
    }

    function collectTicketOsRows(report) {
      const rows = [];
      (Array.isArray(report?.chamados) ? report.chamados : []).forEach(ticket => {
        const serie = String(ticket?.serie || "").trim();
        if (!serie) return;
        const simpress = ticket?.simpress || {};
        const seenSimpressOrders = new Set();
        // Etapa atual "Pedido entregue" com data completa (DD/MM/AAAA) vira o selo verde; sem data, sem selo.
        const etapa = simpress.etapa_atual;
        const entregue = etapa?.chave === "entregue" && /^\d{2}\/\d{2}\/\d{4}$/.test(String(etapa.data || "").trim()) ? String(etapa.data).trim() : "";
        (Array.isArray(simpress.ordens_servico) ? simpress.ordens_servico : []).forEach(value => {
          const os = String(value || "").trim();
          const key = orderKey(os);
          if (!key || seenSimpressOrders.has(key)) return;
          seenSimpressOrders.add(key);
          rows.push({ fonte: "simpress", serie, os, descricao: "", entregue });
        });

        const oracleByOrder = new Map();
        (Array.isArray(ticket?.oracle) ? ticket.oracle : []).forEach(request => {
          const os = String(request?.ordem_servico || "").trim();
          const key = orderKey(os);
          if (!key) return;
          if (!oracleByOrder.has(key)) oracleByOrder.set(key, { fonte: "oracle", serie, os, solicitacoes: [], envioTecnico: false, diasAberta: null });
          const group = oracleByOrder.get(key);
          if (request?.envio_tecnico === true) group.envioTecnico = true;
          const dias = request?.dias_aberta;
          if (Number.isFinite(dias) && (group.diasAberta === null || dias > group.diasAberta)) group.diasAberta = dias;
          const solicitacao = String(request?.solicitacao || "").trim();
          const descricao = String(request?.descricao || "").trim();
          if (solicitacao || descricao) group.solicitacoes.push({ solicitacao, descricao });
        });
        oracleByOrder.forEach(record => {
          record.descricao = record.solicitacoes.length
            ? record.solicitacoes.map(item => `${item.solicitacao ? `Solicitação ${item.solicitacao}: ` : ""}${item.descricao || "Descrição não informada"}`).join("\n")
            : "";
          // Só o texto cru das descrições, para a busca: sem "Solicitação N:" nem o rótulo "Descrição não informada".
          record.descricaoBusca = record.solicitacoes.map(item => item.descricao).filter(Boolean).join(" ");
          rows.push(record);
        });
      });
      const compareOrder = (left, right) => {
        const numeric = value => /[A-Za-z]/.test(value) ? null : value.replace(/\D/g, "");
        const leftDigits = numeric(left.os);
        const rightDigits = numeric(right.os);
        if (leftDigits && rightDigits) {
          const a = BigInt(leftDigits);
          const b = BigInt(rightDigits);
          if (a !== b) return a > b ? -1 : 1;
        } else if (leftDigits && !rightDigits) return -1;
        else if (!leftDigits && rightDigits) return 1;
        return right.os.localeCompare(left.os, "pt-BR", { numeric: true, sensitivity: "base" })
          || left.fonte.localeCompare(right.fonte, "pt-BR");
      };
      return rows.sort(compareOrder);
    }

    function groupTicketOsRows(rows) {
      const groups = new Map();
      rows.forEach(record => {
        const key = serialKey(record.serie) || String(record.serie).trim().toUpperCase();
        if (!groups.has(key)) groups.set(key, { serie: record.serie, ordens: [] });
        const group = groups.get(key);
        let order = group.ordens.find(item => orderKey(item.os) === orderKey(record.os));
        if (!order) {
          order = { serie: record.serie, os: record.os, fontes: [], descricao: "", descricaoBusca: "", envioTecnico: false, diasAberta: null, entregue: "" };
          group.ordens.push(order);
        }
        if (!order.fontes.includes(record.fonte)) order.fontes.push(record.fonte);
        if (record.fonte === "simpress" && record.entregue) order.entregue = record.entregue;
        if (record.fonte === "oracle") {
          if (record.envioTecnico) order.envioTecnico = true;
          if (Number.isFinite(record.diasAberta) && (order.diasAberta === null || record.diasAberta > order.diasAberta)) order.diasAberta = record.diasAberta;
        }
        if (record.fonte === "oracle" && record.descricao) {
          const descriptions = order.descricao ? order.descricao.split("\n") : [];
          if (!descriptions.includes(record.descricao)) descriptions.push(record.descricao);
          order.descricao = descriptions.join("\n");
        }
        if (record.descricaoBusca) order.descricaoBusca = [order.descricaoBusca, record.descricaoBusca].filter(Boolean).join(" ");
      });
      const result = [...groups.values()];
      result.forEach(group => {
        group.ordens.forEach(order => {
          order.fontes = ["oracle", "simpress"].filter(source => order.fontes.includes(source));
        });
        group.fontes = ["oracle", "simpress"].filter(source =>
          group.ordens.some(order => order.fontes.includes(source)));
      });
      return result;
    }

    function ticketUserLabel(user) {
      if (!user) return "Não informado";
      const candidates = Array.isArray(user.candidatos) ? user.candidatos.filter(Boolean) : [];
      if (candidates.length) return `Ambíguo: ${candidates.join(" / ")}`;
      return String(user.usuario || "Não informado");
    }

    function ticketHostnameLabel(user) {
      if (!user) return "Não informado";
      const candidates = Array.isArray(user.hostname_candidatos) ? user.hostname_candidatos.filter(Boolean) : [];
      if (user.hostname_ambiguo) return candidates.length ? `Ambíguo: ${candidates.join(" / ")}` : "Ambíguo no cadastro";
      return String(user.hostname || "Não informado");
    }

    let ticketDescriptionSeq = 0;
    // Uma linha por OS (fontes unidas): só a Oracle traz descrição.
    function renderTicketSummaryDescription(order, source) {
      const item = el("div", "ck-descricao ticket-summary-description-entry");
      const text = (source === "oracle" && order.descricao) || "Descrição não informada";
      item.append(el("p", "ck-descricao__texto ticket-summary-description", text));
      if (text.length > 90 || text.includes("\n")) {
        item.id = "resumo-os-descricao-" + (++ticketDescriptionSeq);
        const more = el("button", "ck-link-btn", "Ver mais");
        more.type = "button";
        more.setAttribute("data-expandir", item.id);
        more.setAttribute("aria-expanded", "false");
        item.append(more);
      }
      return item;
    }

    function renderTicketOsLinkEditor(record, saved, canSave, statusMessage) {
      const editor = el("div", "ticket-os-link-editor");
      if (saved?.origem) editor.dataset.origem = String(saved.origem);
      if (!canSave) {
        editor.append(el("span", "ticket-os-link-value", saved?.chamado || "Não informado"));
        return editor;
      }
      const form = el("form", "ticket-os-link-form");
      const year = Number(saved?.ano) || new Date().getFullYear();
      const label = el("label", "ck-sr ticket-os-link-label", "Número do chamado UTIC");
      const controls = el("div", "ck-utic ticket-os-link-controls");
      // Vínculo salvo: o prefixo vira botão que abre a janela Chamado × OS (chamado da F5 + esta OS); o campo continua editável.
      const prefix = el(saved?.numero ? "button" : "span", "ticket-os-link-prefix", `UTIC-${year}-`);
      if (saved?.numero) {
        const chamado = `UTIC-${year}-${saved.numero}`;
        prefix.className = "ck-link-btn ticket-os-link-prefix ticket-os-link-goto";
        prefix.type = "button";
        prefix.setAttribute("aria-label", `Abrir o chamado ${chamado} e a OS ${record.os} na janela Chamado × OS`);
        prefix.setAttribute("aria-haspopup", "dialog");
        prefix.setAttribute("data-on-click", "abrirJanelaChamadoOs");
        prefix.setAttribute("data-args", JSON.stringify([{ chamado, serie: record.serie, os: record.os }, "$this"]));
      }
      const input = el("input", "ck-entrada ck-entrada--sm ticket-os-link-input");
      input.type = "text";
      input.inputMode = "numeric";
      input.pattern = "[0-9]*";
      input.maxLength = 24;
      input.autocomplete = "off";
      input.value = saved?.numero || "";
      input.placeholder = "0000";
      input.setAttribute("aria-label", "Número do chamado para OS " + record.os
        + ", série " + record.serie + ", fonte " + ticketSummarySourceLabel([record.fonte]));
      const save = el("button", "ck-btn ck-btn--secundario ck-btn--sm ticket-os-link-save", saved ? "Atualizar" : "Salvar");
      save.type = "submit";
      controls.append(prefix, input, save);
      if (saved) {
        const remove = el("button", "ck-btn ck-btn--fantasma ck-btn--sm ticket-os-link-remove", "Remover vínculo");
        remove.type = "button";
        remove.addEventListener("click", () => persistTicketOsLink(record, year, "", input, save, remove, statusMessage));
        controls.append(remove);
      }
      form.append(label, controls);
      input.addEventListener("input", () => input.removeAttribute("aria-invalid"));
      form.addEventListener("submit", event => {
        event.preventDefault();
        const numero = input.value.trim();
        if (!/^\d{1,24}$/.test(numero)) {
          statusMessage.textContent = "Digite os números depois do prefixo UTIC.";
          input.setAttribute("aria-invalid", "true");
          input.focus();
          return;
        }
        persistTicketOsLink(record, year, numero, input, save, null, statusMessage);
      });
      editor.append(form);
      return editor;
    }

    // ----- célula Chamado das sub-abas da F6 (Abertas e Finalizadas) -----
    // Mesma ordem do servidor para a mesma chave: o vínculo manual (sem origem) vale sobre o da finalização, e este sobre o do Dashboard.
    const prioridadeVinculo = saved => (saved.origem === "dashboard" ? 2 : saved.origem === "finalizacao" ? 1 : 0);
    const chamadoDoVinculo = saved => saved?.chamado || (saved?.numero ? `UTIC-${saved.ano}-${saved.numero}` : "");
    const SVG_NS = "http://www.w3.org/2000/svg";
    const ICONE_CORRENTE = ["M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7", "M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"];

    function iconeCorrente() {
      const svg = doc.createElementNS(SVG_NS, "svg");
      Object.entries({ "aria-hidden": "true", width: "12", height: "12", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        "stroke-width": "2.4", "stroke-linecap": "round", "stroke-linejoin": "round" }).forEach(([nome, valor]) => svg.setAttribute(nome, valor));
      ICONE_CORRENTE.forEach(d => {
        const path = doc.createElementNS(SVG_NS, "path");
        path.setAttribute("d", d);
        svg.append(path);
      });
      return svg;
    }

    // Abertas: só o vínculo do Dashboard vira link com o selo "Do Dashboard"; o da finalização nunca preenche o campo manual.
    // Finalizadas: o vínculo da finalização vira link com o selo "Vinculado automaticamente" (o manual, se houver, tem prioridade e segue no editor).
    function renderChamadoSubaba(sourceRecord, saved, finalizada, status) {
      const origem = saved?.origem;
      const chamado = chamadoDoVinculo(saved);
      const automatico = (origem === "finalizacao" && finalizada) || origem === "dashboard";
      if (!automatico || !chamado) return renderTicketOsLinkEditor(sourceRecord, origem === "finalizacao" ? null : saved, true, status);
      const bloco = el("div", "os-chamado");
      bloco.dataset.origem = origem;
      bloco.dataset.chamado = chamado;
      const link = el("button", "ck-link-btn ck-mono os-chamado__link", chamado);
      link.type = "button";
      link.setAttribute("aria-label", `Abrir o chamado ${chamado} e a OS ${sourceRecord.os} na janela Chamado × OS`);
      link.setAttribute("aria-haspopup", "dialog");
      link.setAttribute("data-on-click", "abrirJanelaChamadoOs");
      link.setAttribute("data-args", JSON.stringify([{ chamado, serie: sourceRecord.serie, os: sourceRecord.os }, "$this"]));
      const selo = el("span", `ck-badge os-selo os-selo--${origem === "finalizacao" ? "auto" : "dashboard"}`);
      if (origem === "finalizacao") selo.append(iconeCorrente());
      selo.append(el("span", "", origem === "finalizacao" ? "Vinculado automaticamente" : "Do Dashboard"));
      bloco.append(link, selo);
      return bloco;
    }

    async function persistTicketOsLink(record, year, numero, input, save, remove, statusMessage) {
      const buttons = [save, remove].filter(Boolean);
      buttons.forEach(button => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
      statusMessage.textContent = "Salvando vínculo…";
      try {
        await osSummaryRequest("/api/operacoes/chamados/vinculos-os", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...record, ano: year, numero }),
        });
        await refreshTicketSummary(true);
        statusMessage.textContent = numero ? `Vínculo salvo: UTIC-${year}-${numero}.` : "Vínculo removido.";
      } catch (error) {
        statusMessage.textContent = error.message || "Não foi possível salvar o vínculo.";
        buttons.forEach(button => { button.disabled = false; button.removeAttribute("aria-busy"); });
        input?.focus();
      }
    }

    function renderTicketSummary(section, records, users, links, canSave, userFailure, relacoes = new Map(), grupos = new Map(), modelos = new Map(), notas = null, marcas = new Map()) {
      const status = statusOs(section);
      const content = el("div", "ck-os__corpo ticket-summary-content");
      const externa = osExternas.get(section);
      // Sub-abas (só o host da F6): a célula Chamado e a marca dependem da situação da própria OS.
      const subabas = Boolean(externa?.situacao);
      // marcas: Map(chave série+OS → marcas) ou null quando a leitura falhou (a tabela segue sem elas).
      if (externa) { externa.renderizada = records.length > 0; externa.falhaUsuarios = Boolean(userFailure); externa.falhaMarcas = marcas === null; }
      if (!records.length) {
        // Janela Chamado × OS: sem série pedida (link de lembrete) o que faltou foi a OS, não a série.
        status.textContent = !externa?.soOs ? "Nenhuma OS vinculada por série na importação atual."
          : externa.soOs.serie || !externa.soOs.lembrete ? "Série não encontrada na importação atual." : "OS não encontrada na importação atual.";
        if (externa) avisarAbasOs(externa, { abertas: 0, finalizadas: 0 });
        section.setAttribute("aria-busy", "false");
        section.dataset.estado = "vazio";
        section.querySelector(".ticket-summary-content")?.remove();
        section.append(content);
        return;
      }
      const orderCount = records.reduce((total, record) => total + record.ordens.length, 0);
      status.textContent = userFailure
        ? formatNumber(orderCount) + " OS agrupadas por série; dados de usuário e hostname estão indisponíveis."
        : formatNumber(orderCount) + " OS · " + pluralize(records.length, "série", "séries");
      const table = el("table", "ck-tabela ck-tabela--cards ticket-summary-table");
      const cols = el("colgroup");
      ["fonte", "serie", "os", "usuario", "host", "chamado", "", "obs"].forEach(name => cols.append(el("col", name ? "ck-col-" + name : "")));
      table.append(cols);
      table.append(el("caption", "ck-sr", "Ordens de serviço associadas a equipamentos"));
      const header = doc.createElement("thead");
      const headRow = doc.createElement("tr");
      ["Fonte", "Série", "OS", "Usuário", "Hostname", "Chamado", "Descrição", "Observação do andamento"].forEach(title => {
        const cell = el("th", "", title);
        cell.scope = "col";
        headRow.append(cell);
      });
      header.append(headRow);
      table.append(header);
      const body = doc.createElement("tbody");
      records.forEach(record => {
        const user = users[record.serie];
        const userText = userFailure ? "Indisponível" : ticketUserLabel(user);
        const hostText = userFailure ? "Indisponível" : ticketHostnameLabel(user);
        record.ordens.forEach((order, orderIndex) => {
          const row = doc.createElement("tr");
          row.dataset.serial = record.serie;
          row.dataset.osCount = "1";
          row.dataset.os = String(order.os);
          row.dataset.relacao = relacoes.get(serialKey(record.serie)) || "";
          row.dataset.triagem = grupos.get(serialKey(record.serie)) || "";
          const utics = order.fontes.map(fonte => links.get(ticketOsLinkKey({ fonte, serie: record.serie, os: order.os })))
            .filter(saved => saved?.numero).map(saved => `UTIC-${saved.ano}-${saved.numero} ${saved.numero}`);
          // Valores crus: "Não informado" e "Ambíguo" são rótulos e não entram na busca.
          const pessoa = userFailure ? {} : user || {};
          row.dataset.busca = textoOs([record.serie, order.os, pessoa.usuario, ...(pessoa.candidatos || []), pessoa.hostname,
            ...(pessoa.hostname_candidatos || []), modelos.get(serialKey(record.serie)) || "", ...utics,
            // Exceção aos rótulos: o selo "Técnico" entra na busca para filtrar as OS com envio técnico digitando "técnico".
            order.envioTecnico && "Técnico"].filter(Boolean).join(" "));
          // Só a descrição crua da Oracle; rótulos ("Solicitação N:", "Descrição não informada") não entram.
          row.dataset.buscaDescricao = textoOs(order.descricaoBusca);
          const cell = (label, className) => {
            const td = el("td", className || "");
            td.setAttribute("data-label", label);
            row.append(td);
            return td;
          };
          // OS presente nas duas fontes: uma linha, com um selo e um editor de chamado por fonte (a chave do vínculo inclui a fonte).
          const sourceCell = cell("Fonte", "ck-os-fontes");
          const serieCell = cell("Série", "ck-mono");
          serieCell.textContent = record.serie;
          // Um botão por série (na primeira OS) abre a linha extra com o andamento.
          if (externa?.aoExpandirSerie && orderIndex === 0) serieCell.append(renderAndamentoToggle(externa, record.serie));
          const osCell = cell("OS", "ck-mono");
          if (externa?.somenteLeitura) osCell.append(el("span", "ck-mono ticket-summary-order-link", order.os));
          else {
            const osButton = renderTicketSummaryOrderButton({ serie: record.serie, os: order.os, fontes: order.fontes });
            osButton.className = "ck-link-btn ck-mono ticket-summary-order-link";
            osCell.append(osButton);
          }
          // Selos só da Oracle: record.diasAberta e record.envioTecnico vêm de order (fontes unidas); da Simpress vem só o selo Entregue.
          const dias = order.diasAberta;
          const temDias = dias !== null && dias !== undefined;
          // Peça entregue: o "Aberta há N dias" sai do selo cinza e vira sufixo do selo Entregue.
          if (temDias && !order.entregue) {
            osCell.append(el("span", "ck-os__selo ck-os__selo--dias",
              dias === 0 ? "Aberta hoje" : dias === 1 ? "Aberta há 1 dia" : `Aberta há ${dias.toLocaleString("pt-BR")} dias`));
          }
          if (order.envioTecnico) {
            osCell.append(el("span", "ck-os__selo ck-os__selo--tecnico", "Técnico"));
          }
          // Selo da Simpress: etapa atual "Pedido entregue" com data completa.
          if (order.entregue) {
            const sufixo = !temDias ? "" : dias === 1 ? " · 1 dia" : ` · ${dias.toLocaleString("pt-BR")} dias`;
            osCell.append(el("span", "ck-os__selo ck-os__selo--entregue", `Entregue · ${order.entregue}${sufixo}`));
          }
          cell("Usuário").textContent = userText;
          cell("Hostname", "ck-mono").textContent = hostText;
          const linkCell = cell("Chamado", "ck-td--largo ck-os-fontes");
          // OS finalizada = marca ativa; a sub-aba filtra por este atributo (a janela Chamado × OS não usa).
          const marcasDaOs = marcas?.get(osObsKey(record.serie, order.os)) || [];
          const finalizada = marcasDaOs.some(marca => marca?.ativa);
          row.dataset.finalizada = String(finalizada);
          // Um único editor UTIC por linha: a fonte que já tem vínculo salvo, senão a primeira (nas sub-abas, a de maior prioridade).
          const salvoDe = source => links.get(ticketOsLinkKey({ fonte: source, serie: record.serie, os: order.os }));
          const comVinculo = order.fontes.filter(salvoDe);
          const linkSource = (subabas ? comVinculo.sort((a, b) => prioridadeVinculo(salvoDe(a)) - prioridadeVinculo(salvoDe(b))) : comVinculo)[0] || order.fontes[0];
          let chamadoExibido = "";
          order.fontes.forEach(source => {
            const tagSlot = el("div", "ck-os-fonte");
            tagSlot.append(el("span", "ck-tag", ticketSummarySourceLabel([source])));
            sourceCell.append(tagSlot);
            const sourceRecord = { fonte: source, serie: record.serie, os: order.os };
            if (source !== linkSource) return;
            const slot = el("div", "ck-os-fonte");
            const conteudo = subabas ? renderChamadoSubaba(sourceRecord, salvoDe(source), finalizada, status)
              : renderTicketOsLinkEditor(sourceRecord, salvoDe(source), canSave, status);
            chamadoExibido = conteudo.dataset.chamado || "";
            slot.append(conteudo);
            linkCell.append(slot);
          });
          // Marca(s) da OS, uma por chamado. A janela Chamado × OS (somente leitura) só mostra o selo das ativas do chamado pedido.
          marcasDaOs
            .filter(marca => !externa?.somenteLeitura || (marca.ativa && (!externa.soOs?.chamado || chamadoIgual(marca.chamado, externa.soOs.chamado))))
            .forEach(marca => linkCell.append(renderMarcaOs(marca, { somenteLeitura: Boolean(externa?.somenteLeitura), status, section, chamadoExibido, comData: subabas })));
          const descCell = cell("Descrição", "ck-td--largo");
          descCell.append(renderTicketSummaryDescription(order, order.fontes.includes("oracle") ? "oracle" : "simpress"));
          cell("Observação do andamento", "ck-td--largo").append(...renderOsObservacao(record.serie, order.os, notas, externa?.somenteLeitura));
          body.append(row);
        });
      });
      table.append(body);
      content.append(table);
      if (externa && !externa.soOs) {
        const mais = el("div", "sebrae-mais ck-os__mais");
        mais.dataset.osMais = "";
        mais.hidden = true;
        const botao = el("button", "ck-btn ck-btn--secundario ck-btn--sm sebrae-mais__botao", "Carregar mais");
        botao.type = "button";
        botao.addEventListener("click", () => {
          const linhas = [...body.querySelectorAll("tr[data-serial]")];
          const antes = linhas.filter(item => !item.hidden).length;
          externa.limite += OS_POR_PAGINA;
          filtrarSecaoOs(section);
          // Sem mais páginas o botão some: o foco vai para a primeira OS nova.
          if (mais.hidden) linhas.filter(item => !item.hidden)[antes]?.querySelector(".ticket-summary-order-link")?.focus();
        });
        mais.append(botao, el("span", "sebrae-mais__n"));
        content.append(mais);
      }
      section.querySelector(".ticket-summary-content")?.remove();
      section.append(content);
      section.setAttribute("aria-busy", "false");
      section.dataset.estado = "pronto";
      if (!externa?.soOs) idLivre(table, "ck-os-tabela");
      // Salvar um vínculo recria a tabela: reabre as linhas de andamento que estavam abertas.
      externa?.abertas.forEach(serie => {
        const toggle = [...table.querySelectorAll(".ck-os__andamento-btn")].find(btn => btn.dataset.serie === serie);
        if (toggle) alternarAndamento(toggle, externa, serie, true);
        else externa.abertas.delete(serie);
      });
      filtrarSecaoOs(section);
    }

    let andamentoSeq = 0;
    function renderAndamentoToggle(st, serie) {
      const button = el("button", "ck-link-btn ck-os__andamento-btn", "Andamento");
      button.type = "button";
      button.dataset.serie = serie;
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Andamento registrado da série " + serie);
      button.addEventListener("click", () => alternarAndamento(button, st, serie));
      return button;
    }

    function alternarAndamento(button, st, serie, abrir = button.getAttribute("aria-expanded") !== "true") {
      doc.getElementById(button.getAttribute("aria-controls") || "")?.remove();
      button.removeAttribute("aria-controls");
      button.setAttribute("aria-expanded", String(abrir));
      if (!abrir) { st.abertas.delete(serie); return; }
      st.abertas.add(serie);
      const body = button.closest("tbody");
      const rows = [...body.querySelectorAll("tr[data-serial]")].filter(item => item.dataset.serial === serie);
      const detail = doc.createElement("tr");
      detail.id = "ck-os-andamento-" + (++andamentoSeq);
      detail.dataset.andamento = serie;
      const cell = el("td", "ck-td--largo ck-td--sem-rotulo");
      cell.colSpan = 8;
      cell.setAttribute("role", "region");
      cell.setAttribute("aria-label", "Andamento registrado da série " + serie);
      detail.append(cell);
      rows[rows.length - 1].after(detail);
      button.setAttribute("aria-controls", detail.id);
      st.aoExpandirSerie(serie, cell);
    }

    async function refreshTicketSummary(force) {
      const alvos = [];
      osExternas.forEach((st, s) => {
        if (!s.isConnected) osExternas.delete(s);
        else if (force || !st.carregada) alvos.push(s);
      });
      if (!alvos.length) return;
      const serial = ++ticketSummaryRequestSerial;
      // Cada seção só aceita o resultado da última carga que a incluiu.
      const vivos = () => alvos.filter(s => s.isConnected && osSerie.get(s) === serial);
      alvos.forEach(section => {
        osSerie.set(section, serial);
        section.setAttribute("aria-busy", "true");
        section.dataset.estado = "carregando";
        statusOs(section).textContent = "Carregando OS…";
      });
      try {
        const notasSeq = osObsSeq;
        const [report, linksData, notasData, marcasData] = await Promise.all([
          osSummaryRequest("/api/operacoes/chamados"),
          osSummaryRequest("/api/operacoes/chamados/vinculos-os"),
          // Falha nas observações não derruba a tabela: a caixa fica só leitura.
          osSummaryRequest("/api/operacoes/chamados/observacoes").catch(() => null),
          // Falha nas marcas também não derruba a tabela: o status avisa que elas estão indisponíveis.
          osSummaryRequest(MARCA_ROTA).catch(() => null),
        ]);
        const marcas = Array.isArray(marcasData?.marcas) ? modelo.marcasPorOs(marcasData.marcas) : null;
        const notas = Array.isArray(notasData?.observacoes) ? {
          seq: notasSeq,
          itens: new Map(notasData.observacoes.map(item => [osObsKey(item.serie, item.os), String(item.observacao || "")])),
        } : null;
        const records = groupTicketOsRows(collectTicketOsRows(report));
        const relacoes = new Map((Array.isArray(report?.chamados) ? report.chamados : [])
          .map(ticket => [serialKey(ticket?.serie), String(ticket?.relacao || "")]));
        const modelos = new Map((Array.isArray(report?.chamados) ? report.chamados : [])
          .map(ticket => [serialKey(ticket?.serie), (Array.isArray(ticket?.simpress?.modelos) ? ticket.simpress.modelos : []).join(" ")]));
        // Registros de cada seção: a da janela Chamado × OS fica só com a OS pedida.
        const proprios = new Map(alvos.map(section => {
          const st = osExternas.get(section);
          return [section, st?.soOs ? soEssaOs(records, st.soOs, relacoes) : records];
        }));
        // Só janelas na carga: o usuário logado é pedido só para as séries delas.
        const pedidas = [...new Set([...proprios.values()].flat().map(item => item.serie))];
        let users = {};
        let userFailure = false;
        if (pedidas.length) {
          try {
            const userData = await osSummaryRequest("/api/equipamentos/usuarios-logados", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ series: pedidas }),
            });
            users = userData.usuarios || {};
          } catch (_) {
            userFailure = true;
          }
        }
        const linkItems = Array.isArray(linksData.vinculos) ? linksData.vinculos : [];
        const links = new Map(linkItems.map(item => [ticketOsLinkKey({ fonte: item.fonte, serie: item.serie, os: item.os }), item]));
        vivos().forEach(section => {
          const st = osExternas.get(section);
          if (st) st.carregada = true;
          st?.aoCarregar?.(report);
          const grupos = new Map(st?.grupoSerie ? (Array.isArray(report?.chamados) ? report.chamados : [])
            .map(ticket => [serialKey(ticket?.serie), st.grupoSerie(ticket) || ""]) : []);
          renderTicketSummary(section, proprios.get(section) || records, users, links, !st?.somenteLeitura, userFailure, relacoes, grupos, modelos, notas, marcas);
          if (st?.aoContarSituacao && !st.soOs) avisarSituacaoOs(st, proprios.get(section) || records, report, marcas);
        });
      } catch (error) {
        vivos().forEach(section => {
          section.querySelector(".ticket-summary-content")?.remove();
          section.setAttribute("aria-busy", "false");
          section.dataset.estado = "erro";
          const st = osExternas.get(section);
          if (st) st.renderizada = false;
          statusOs(section).textContent = error.message === "Failed to fetch"
            ? "Não foi possível carregar as OS. Tente novamente."
            : error.message || "Não foi possível carregar as OS.";
        });
      }
    }

    // ----- sidebar divergence badge -----
    // The group summary carries only this alert count; the summary's aria-label replaces its content, so it repeats the count.
    const SUMMARY_LABEL = "Abrir históricos e análises";
    function renderBadge(total) {
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

    function atualizarResumoNotificacoes(text) {
      if (notificationSummary && notificationSummary.textContent !== text) notificationSummary.textContent = text;
    }

    function renderizarNotificacoes(data) {
      const osParadas = data?.os_paradas;
      const divergenciasNovas = data?.divergencias_novas;
      const semAcesso60 = data?.sem_acesso_60_dias;
      const semAcesso60Ativo = (semAcesso60?.estado === "passou_60" && Number(semAcesso60.total_passou) > 0)
        || (semAcesso60?.estado === "limite_55" && Number(semAcesso60.total_limite) > 0);
      const outroTecnico = data?.chamados_outro_tecnico;
      const outroTecnicoAtivo = !outroTecnico?.indisponivel && Number(outroTecnico?.total) > 0;
      const total = Number(osParadas?.estado === "paradas" && Number(osParadas.total) > 0)
        + Number(divergenciasNovas?.estado === "novas" && Number(divergenciasNovas.total) > 0)
        + Number(semAcesso60Ativo) + Number(outroTecnicoAtivo);
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

      notificationPanel.addEventListener("click", event => {
        if (!event.target?.closest?.(".ck-aviso__acao, .stale-base-alert-action")) return;
        fecharCentralNotificacoes();
        notificationButton.focus();
      });

      doc.addEventListener("click", event => {
        if (notificationPanel.hidden || notificationPanel.contains(event.target) || notificationButton.contains(event.target)) return;
        fecharCentralNotificacoes();
      });

      doc.addEventListener("keydown", event => {
        if (event.key !== "Escape" || notificationPanel.hidden) return;
        event.preventDefault();
        fecharCentralNotificacoes();
        notificationButton.focus();
      });
    }

    async function refresh(force) {
      if (!force && Date.now() - lastFetch < REFRESH_MIN_MS) return;
      lastFetch = Date.now();
      const serial = ++requestSerial;
      try {
        const response = await win.fetch(ENDPOINT, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json();
        if (serial !== requestSerial) return;
        renderBadge(divergenceTotal(data.ultima_comparacao));
        renderizarNotificacoes(data);
        // Other Home cards (usage in the last 30 days) render from the same response.
        doc.dispatchEvent(new win.CustomEvent("simpress:painel-atualizado", { detail: data }));
      } catch (error) {
        // The dashboard is optional; never disturb the main flow.
        if (serial === requestSerial) {
          renderBadge(0);
          renderizarFalhaNotificacoes();
        }
        win.console?.warn?.("Painel indisponível:", error?.message || error);
      }
    }

    doc.addEventListener("simpress:atualizar-notificacoes", () => refresh(true));

    // Quem monta uma tabela .comparison-desktop-table dispara este evento (comparison-result.js, transfer-history.js).
    doc.addEventListener("simpress:tabelas-renderizadas", scanTables);
    scanTables();

    // A change of the history counter means an update/restore/delete happened: refresh both the panel and the badge.
    const counter = doc.getElementById("total-historico-comparacoes");
    if (counter) new win.MutationObserver(() => refresh(true)).observe(counter, { childList: true, characterData: true, subtree: true });
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

    osApi = { montar: montarTabelaOs, atualizar: refreshTicketSummary, filtrar: filtrarTabelaOs, revelar: revelarLinhaOs, series: seriesFiltradasOs };
    refresh(true);
  }

  // Ponte para a instalação ativa: permite window.SimpressDataPanels.montarTabelaOs(...) após o install.
  let osApi = { montar: () => null, atualizar: async () => {}, filtrar: () => {}, revelar: () => false, series: () => null };
  const montarTabelaOs = (host, opcoes) => osApi.montar(host, opcoes);
  const atualizarTabelaOs = force => osApi.atualizar(Boolean(force));
  const filtrarTabelaOs = filtro => osApi.filtrar(filtro);
  const revelarLinhaOs = row => osApi.revelar(row);
  const seriesFiltradasOs = () => osApi.series();

  return Object.freeze({
    ENDPOINT, DENSITY_KEY, sortKey, compareValues, nextDirection, sortedOrder, toTsv,
    divergenceTotal, barPercentages, formatNumber, pluralize, install,
    montarTabelaOs, atualizarTabelaOs, filtrarTabelaOs, revelarLinhaOs, seriesFiltradasOs,
  });
});
