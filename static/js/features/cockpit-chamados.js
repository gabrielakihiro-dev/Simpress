/** Cockpit Chamados: importação das planilhas, versões, comparação, exclusão de importações antigas e exportação (bloco "Importação e versões"), mais os chamados abertos da Home. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).cockpitChamados = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCockpitChamados(context) {
  "use strict";
  const { app, transferUtils } = context;
  const { createTextElement } = context.dom;
  const { formatarHorarioHistorico } = context.historyFormat;
  const { compararOrdensServicoDecrescente, idadeAtualizacaoChamado, normalizarFiltroChamados } = context.ticketRules;

  const homeTicketsRequestGate = transferUtils.createRequestGate();
  // shortcut: atualizado só por importação feita nesta aba ou ao abrir a aba Chamados; importação pela pasta pede recarregar a página.
  let chamadosRecentesHome = null;
  const evolutionGate = transferUtils.createRequestGate();
  let history = [];
  let selectedVersion = "";
  let evolutionKey = "";
  let bound = false;

  const byId = id => document.getElementById(id);

  function formatImportLabel(event) {
    const sources = event.fontes || {};
    const simpressName = typeof sources.simpress === "string" ? sources.simpress : sources.simpress?.arquivo;
    const oracleName = typeof sources.oracle === "string" ? sources.oracle : sources.oracle?.arquivo;
    const files = [simpressName, oracleName].filter(Boolean).join(" + ");
    return `${formatarHorarioHistorico(event.atualizado_em)}${files ? ` · ${files}` : ""}`;
  }

  function renderVersions() {
    const selector = byId("cockpit-tickets-version");
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Nenhuma importação";
    const options = history.map(event => {
      const option = document.createElement("option");
      option.value = event.id || "";
      option.textContent = formatImportLabel(event);
      return option;
    });
    selector.replaceChildren(empty, ...options);
    selector.value = selectedVersion;
    selector.disabled = history.length === 0;
  }

  function renderButtons() {
    byId("cockpit-tickets-delete-old").disabled = history.length <= 1;
    byId("cockpit-tickets-export").disabled = !selectedVersion;
  }

  function renderEvolution(data) {
    const target = byId("cockpit-tickets-evolution");
    const counts = data.contagens || {};
    const changes = data.mudancas || {};
    const changed = Array.isArray(changes.alterados) ? changes.alterados : [];
    const added = Array.isArray(changes.novos) ? changes.novos : [];
    const absent = Array.isArray(changes.ausentes_arquivo) ? changes.ausentes_arquivo : [];
    const rows = [
      ...added.slice(0, 5).map(serial => ["Nova série:", serial]),
      ...changed.slice(0, 8).map(row => [`${row.serie}:`, (row.campos || []).map(field => field.campo).join(", ")]),
      ...absent.slice(0, 5).map(serial => ["Não consta na planilha atual:", serial]),
    ];
    const summary = createTextElement("p", "ck-chamados-evolucao__resumo",
      `Comparação com a versão anterior · ${Number(counts.novos) || 0} novas · ${Number(counts.alterados) || 0} alteradas · ${Number(counts.iguais) || 0} sem mudança · ${Number(counts.ausentes_arquivo) || 0} ausentes`);
    const warning = createTextElement("p", "", data.aviso_ausentes || "Ausência na planilha não confirma resolução.");
    const nodes = [summary, warning];
    if (rows.length) {
      const list = document.createElement("ul");
      list.className = "ck-chamados-evolucao__lista";
      rows.forEach(([label, value]) => {
        const item = document.createElement("li");
        item.append(createTextElement("strong", "", label), ` ${value}`);
        list.append(item);
      });
      nodes.push(list);
    }
    target.replaceChildren(...nodes);
  }

  async function loadEvolution(snapshotId) {
    const request = evolutionGate.begin();
    const target = byId("cockpit-tickets-evolution");
    if (!snapshotId) {
      target.textContent = "Nenhuma importação selecionada.";
      return;
    }
    const index = history.findIndex(event => event.id === snapshotId);
    const older = index >= 0 ? history[index + 1] : null;
    if (!older) {
      target.textContent = history.length > 1
        ? "Esta é a importação mais antiga disponível. Selecione uma versão mais recente para comparar."
        : "A primeira importação ficará registrada aqui para comparação com as próximas planilhas.";
      return;
    }
    target.textContent = "Comparando esta versão com a anterior…";
    try {
      const query = new URLSearchParams({ anterior: older.id, atual: snapshotId });
      const data = await app.apiFetch(`/api/operacoes/chamados/evolucao?${query.toString()}`, { signal: request.signal, errorMessage: "Não foi possível comparar as versões dos chamados." });
      if (evolutionGate.isCurrent(request.id)) renderEvolution(data);
    } catch (error) {
      if (evolutionGate.isCurrent(request.id)) target.textContent = error.message || "Não foi possível comparar as versões dos chamados.";
    }
  }

  // Chamado pela tabela de OS a cada carga de /api/operacoes/chamados (e logo após importar): mantém versões, fontes e Home em dia.
  function sincronizarGestaoChamadosCockpit(report) {
    if (!byId("cockpit-tickets-version")) return;
    ligarGestao();
    history = Array.isArray(report?.historico) ? report.historico : [];
    if (!history.some(event => event.id === selectedVersion)) selectedVersion = report?.snapshot_id || history[0]?.id || "";
    renderVersions();
    renderButtons();
    byId("cockpit-tickets-manage-version").textContent = report?.atualizado_em
      ? `Atualizado ${formatarHorarioHistorico(report.atualizado_em)}` : "Nenhuma importação";
    const sources = report?.fontes || {};
    byId("cockpit-tickets-sources").textContent =
      `Simpress: ${sources.simpress?.arquivo || "aguardando importação"} · Oracle: ${sources.oracle?.arquivo || "aguardando importação"}`;
    if (report?.snapshot_id) chamadosRecentesHome = report;
    const key = `${selectedVersion}|${history[0]?.id || ""}|${history.length}`;
    if (key !== evolutionKey) {
      evolutionKey = key;
      loadEvolution(selectedVersion);
    }
  }

  function selecionarVersaoChamadosCockpit() {
    selectedVersion = byId("cockpit-tickets-version").value;
    evolutionKey = "";
    renderButtons();
    loadEvolution(selectedVersion);
  }

  // A tabela e os indicadores escutam este evento e recarregam a importação mais recente.
  function atualizarTabelaChamados() {
    const EventConstructor = document.defaultView?.CustomEvent;
    if (EventConstructor) document.dispatchEvent(new EventConstructor("simpress:chamados-atualizados", { detail: { snapshot_id: selectedVersion } }));
  }

  async function importarPlanilhas(event) {
    event.preventDefault();
    const form = byId("cockpit-tickets-form");
    const simpressInput = byId("cockpit-tickets-file-simpress");
    const oracleInput = byId("cockpit-tickets-file-oracle");
    const button = byId("cockpit-tickets-import");
    const status = byId("cockpit-tickets-import-status");
    if (!simpressInput.files?.[0] || !oracleInput.files?.[0]) {
      status.textContent = "Selecione as duas planilhas para importar.";
      return;
    }
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Importando…";
    form.setAttribute("aria-busy", "true");
    status.textContent = "Lendo as planilhas e relacionando as séries…";
    try {
      const payload = new FormData();
      payload.append("simpress_file", simpressInput.files[0]);
      payload.append("oracle_file", oracleInput.files[0]);
      const data = await app.apiFetch("/api/operacoes/chamados/importar", { method: "POST", body: payload, errorMessage: "Não foi possível importar as planilhas." });
      selectedVersion = "";
      evolutionKey = "";
      sincronizarGestaoChamadosCockpit(data);
      [simpressInput, oracleInput].forEach(input => {
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      status.textContent = "Planilhas importadas. As OS foram relacionadas pela série.";
      byId("cockpit-tickets-manage-panel").open = false;
      atualizarTabelaChamados();
      await app.carregarProntidao?.();
      app.showToast("Acompanhamento de chamados atualizado.", "success");
    } catch (error) {
      status.textContent = error.message || "Não foi possível importar as planilhas.";
    } finally {
      button.disabled = false;
      button.textContent = originalText;
      form.removeAttribute("aria-busy");
    }
  }

  async function excluirImportacoesAntigasChamadosCockpit() {
    const button = byId("cockpit-tickets-delete-old");
    const olderCount = Math.max(0, history.length - 1);
    const olderLabel = olderCount === 1 ? "1 importação antiga" : `${olderCount} importações antigas`;
    if (!olderCount || !(await app.confirmarAcao({
      titulo: "Excluir importações antigas?",
      mensagem: `Excluir ${olderLabel} e manter somente a mais recente? Esta ação não poderá ser desfeita.`,
      confirmar: "Excluir",
    }))) return;
    button.disabled = true;
    button.textContent = "Excluindo…";
    try {
      const data = await app.apiFetch("/api/operacoes/chamados/historico/antigas", { method: "DELETE", errorMessage: "Não foi possível excluir as importações antigas." });
      selectedVersion = "";
      atualizarTabelaChamados();
      const removedCount = Number(data.removidas) || 0;
      const removedLabel = removedCount === 1 ? "1 importação antiga removida" : `${removedCount} importações antigas removidas`;
      app.showToast(`${removedLabel}. A importação mais recente foi mantida.`, "success");
    } catch (error) {
      app.showToast(error.message || "Não foi possível excluir as importações antigas.", "error");
    } finally {
      button.textContent = "Excluir importações antigas";
      button.disabled = history.length <= 1;
    }
  }

  async function exportarChamadosCockpit() {
    const button = byId("cockpit-tickets-export");
    if (!selectedVersion) {
      app.showToast("Selecione e aguarde o carregamento de uma versão válida antes de exportar.", "error");
      return;
    }
    const originalText = button.textContent;
    const params = new URLSearchParams({ snapshot_id: selectedVersion, stale_days: "3" });
    const search = byId("cockpit-tickets-search").value.trim();
    if (search) params.set("search", search);
    if (byId("cockpit-tickets-attention").checked) params.set("attention_only", "true");
    button.disabled = true;
    button.textContent = "Preparando Excel…";
    try {
      const response = await app.apiFetch(`/api/operacoes/chamados/exportar?${params.toString()}`, {
        responseType: "response",
        errorMessage: "Não foi possível exportar os chamados filtrados.",
      });
      const disposition = response.headers?.get("Content-Disposition") || "";
      const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
      const filename = match?.[1]?.replace(/["']/g, "") || "Acompanhamento_de_Chamados.xlsx";
      const url = window.URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      app.showToast("Planilha Exportada com Sucesso!", "success");
    } catch (error) {
      app.showToast(error.message || "Não foi possível exportar os chamados filtrados.", "error");
    } finally {
      button.textContent = originalText;
      renderButtons();
    }
  }

  function ligarGestao() {
    if (bound) return;
    bound = true;
    byId("cockpit-tickets-form").addEventListener("submit", importarPlanilhas);
  }

  function abrirGestaoChamadosCockpit() {
    ligarGestao();
    const panel = byId("cockpit-tickets-manage-panel");
    panel.open = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.scrollIntoView?.({ block: "start", behavior: reduced ? "auto" : "smooth" });
    byId("cockpit-tickets-file-simpress").focus({ preventScroll: true });
  }

  function renderizarChamadosAbertosHome(abertos) {
    const body = document.getElementById("home-open-tickets-body");
    const count = document.getElementById("home-open-tickets-count");
    body.setAttribute("aria-busy", "false");
    count.textContent = abertos.length ? `${abertos.length} ${abertos.length === 1 ? "aberto" : "abertos"}` : "";
    if (!abertos.length) {
      body.replaceChildren(createTextElement("p", "ck-abertos__vazio", "Nenhum chamado aberto para esta série."));
      return;
    }
    const list = document.createElement("ul");
    list.className = "ck-abertos";
    abertos.forEach(ticket => {
      const item = document.createElement("li");
      item.className = "ck-aberto";
      item.append(
        createTextElement("strong", "ck-aberto__numero", ticket.solicitacao || "Sem solicitação"),
        createTextElement("span", "ck-badge", [ticket.status, ticket.sub_status].filter(Boolean).join(" · ") || "Status não informado"),
        createTextElement("p", "ck-aberto__titulo", ticket.fila || "Fila não informada"),
        createTextElement("p", "ck-aberto__meta", ticket.nome_filial || ticket.cidade || "Unidade não informada"),
        createTextElement("p", "ck-aberto__meta", idadeAtualizacaoChamado(ticket).rotulo),
      );
      list.append(item);
    });
    body.replaceChildren(list);
  }

  // Home: chamados Oracle ainda abertos da série selecionada, sempre da importação mais recente (mesma API da aba Chamados).
  async function atualizarChamadosAbertosHome(serial) {
    const body = document.getElementById("home-open-tickets-body");
    if (!body) return;
    const request = homeTicketsRequestGate.begin();
    body.setAttribute("aria-busy", "true");
    body.replaceChildren(createTextElement("p", "ck-abertos__vazio", "Carregando chamados…"));
    document.getElementById("home-open-tickets-count").textContent = "";
    try {
      if (!chamadosRecentesHome) {
        const data = await app.apiFetch("/api/operacoes/chamados", { signal: request.signal, errorMessage: "Não foi possível carregar os chamados." });
        if (!homeTicketsRequestGate.isCurrent(request.id)) return;
        chamadosRecentesHome = data;
      }
      if (!homeTicketsRequestGate.isCurrent(request.id)) return;
      const chamados = Array.isArray(chamadosRecentesHome.chamados) ? chamadosRecentesHome.chamados : [];
      const record = chamados.find(item => normalizarFiltroChamados(item.serie) === normalizarFiltroChamados(serial));
      const abertos = (record?.oracle || []).filter(ticket => !idadeAtualizacaoChamado(ticket).encerrado)
        .sort((left, right) => compararOrdensServicoDecrescente(left.ordem_servico, right.ordem_servico));
      renderizarChamadosAbertosHome(abertos);
    } catch (error) {
      if (!homeTicketsRequestGate.isCurrent(request.id)) return;
      body.setAttribute("aria-busy", "false");
      const message = createTextElement("p", "ck-abertos__vazio", error.message || "Não foi possível carregar os chamados.");
      message.setAttribute("role", "alert");
      body.replaceChildren(message);
    }
  }

  return {
    sincronizarGestaoChamadosCockpit, selecionarVersaoChamadosCockpit, excluirImportacoesAntigasChamadosCockpit,
    exportarChamadosCockpit, abrirGestaoChamadosCockpit, atualizarChamadosAbertosHome,
  };
});
