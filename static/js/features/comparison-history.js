/** Histórico de Planilhas list: saved updates, Excel export by date, restore/delete, and the evolution between two updates. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).comparisonHistory = factory;
})(typeof window !== "undefined" ? window : globalThis, function createComparisonHistory(context) {
  "use strict";
  const { app, motion, inventoryOperationKey } = context;
  const { escapeHtml, pluralize } = context.dom;
  const { formatarNomeFonteHistorico, formatarHorarioHistorico } = context.historyFormat;

  const inventoryRestoreAttempts = new Map();

  function definirTotalHistoricoComparacoes(total) {
    const valor = Number(total || 0);
    document.getElementById("badge-total-historico-comparacoes").textContent = valor;
    document.getElementById("total-historico-comparacoes").textContent = `${valor} ${valor === 1 ? "registro" : "registros"}`;
  }

  function definirEstadoDatasExportacaoHistorico(mensagem) {
    const select = document.getElementById("data-exportar-historico-comparacoes");
    const button = document.getElementById("btn-exportar-historico-comparacoes");
    if (select) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = mensagem;
      select.replaceChildren(option);
      select.value = "";
      select.disabled = true;
      select.removeAttribute("aria-busy");
    }
    if (button) button.disabled = true;
  }

  function atualizarDatasExportacaoHistorico(eventos) {
    const select = document.getElementById("data-exportar-historico-comparacoes");
    const button = document.getElementById("btn-exportar-historico-comparacoes");
    if (!select) return;

    const datas = [...new Set((Array.isArray(eventos) ? eventos : [])
      .filter(evento => evento && !evento.somente_anotacoes_sincronizadas)
      .map(evento => String(evento.horario || "").slice(0, 10))
      .filter(data => /^\d{4}-\d{2}-\d{2}$/.test(data)))];
    const dataSelecionada = select.value;
    select.replaceChildren();

    if (datas.length === 0) {
      definirEstadoDatasExportacaoHistorico("Sem datas disponíveis");
      return;
    }

    datas.forEach(data => {
      const [ano, mes, dia] = data.split("-");
      const option = document.createElement("option");
      option.value = data;
      option.textContent = `${dia}/${mes}/${ano}`;
      select.appendChild(option);
    });

    select.value = datas.includes(dataSelecionada) ? dataSelecionada : datas[0];
    select.disabled = false;
    select.removeAttribute("aria-busy");
    if (button) button.disabled = false;
  }

  async function carregarContagemHistoricoComparacoes() {
    try {
      const res = await fetch("/api/historico-comparacoes");
      if (!res.ok) throw new Error("Não foi possível carregar as datas do histórico.");
      const data = await res.json();
      definirTotalHistoricoComparacoes(data.total);
      atualizarDatasExportacaoHistorico(data.eventos);
    } catch (err) {
      console.warn("Não foi possível carregar a contagem do histórico de planilhas:", err);
      const select = document.getElementById("data-exportar-historico-comparacoes");
      if (!select?.value) definirEstadoDatasExportacaoHistorico("Datas indisponíveis");
    }
  }

  function fecharEvolucaoAtualizacoes() { app.fecharModalAcessivel("modal-evolucao-atualizacoes"); }

  function renderizarEvolucaoAtualizacoes(data) {
    const target = document.getElementById("resultado-evolucao-atualizacoes");
    const labels = { novos: "Novos", continuam: "Continuam", resolvidos: "Deixaram de aparecer" };
    const colors = {
      novos: "border-rose-500/20 bg-rose-500/5 text-rose-300",
      continuam: "border-amber-500/20 bg-amber-500/5 text-amber-300",
      resolvidos: "border-emerald-500/20 bg-emerald-500/5 text-emerald-300",
    };
    const rows = data.mudancas || {};
    target.innerHTML = `<p class="text-xs text-slate-400">De ${escapeHtml(formatarHorarioHistorico(data.anterior?.horario))} para ${escapeHtml(formatarHorarioHistorico(data.atual?.horario))}</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">${Object.keys(labels).map(key => `<div class="rounded-lg border ${colors[key]} p-3"><p class="text-xs">${labels[key]}</p><p class="mt-1 text-xl font-bold text-white">${Number(data.contagens?.[key] || 0)}</p></div>`).join("")}</div>
        ${Object.keys(labels).map(key => `<section><h4 class="mb-2 text-sm font-semibold text-slate-200">${labels[key]}</h4>${(rows[key] || []).length ? `<ul class="space-y-1">${rows[key].map(row => {
        const item = row.item || {}; const identity = item.computador || item.hostname || item.serie || item.chave || "Linha sem identificador";
        const serial = item.serie ? ` · ${item.serie}` : "";
        return `<li class="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-200"><span class="font-medium">${escapeHtml(row.secao)}</span> · ${escapeHtml(identity + serial)}${row.evento_id ? ` <button type="button" data-evolution-event="${escapeHtml(row.evento_id)}" class="ml-2 text-cyan-300 underline">Abrir resultado</button>` : ""}${app.renderizarAnotacaoOperacional(item, `${identity}${serial}`)}</li>`;
      }).join("")}</ul>` : `<p class="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-500">Nenhum caso nesta categoria.</p>`}</section>`).join("")}`;
    const rowsWithEvents = [...target.querySelectorAll("[data-evolution-event]")];
    rowsWithEvents.forEach(button => button.addEventListener("click", async () => {
      const eventId = button.dataset.evolutionEvent;
      app.fecharEvolucaoAtualizacoes();
      await consultarHistoricoComparacao(eventId, button);
    }));
    target.querySelectorAll("[data-operational-annotation]").forEach(textarea => {
      const parent = textarea.closest("li");
      const eventId = parent?.querySelector("[data-evolution-event]")?.dataset.evolutionEvent;
      if (eventId) textarea.dataset.eventId = eventId;
    });
    app.conectarAnotacoesOperacionais(target, "");
  }

  async function compararEvolucaoSelecionada() {
    const previous = document.getElementById("evolucao-anterior").value;
    const current = document.getElementById("evolucao-atual").value;
    const target = document.getElementById("resultado-evolucao-atualizacoes");
    target.textContent = "Comparando atualizações…";
    try {
      const query = new URLSearchParams({ anterior: previous, atual: current });
      const response = await fetch(`/api/operacoes/evolucao?${query.toString()}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível comparar as atualizações.");
      renderizarEvolucaoAtualizacoes(data);
    } catch (error) { target.textContent = error.message || "Não foi possível comparar as atualizações."; }
  }

  async function abrirEvolucaoAtualizacoes() {
    app.abrirModalAcessivel("modal-evolucao-atualizacoes", '[aria-label="Fechar evolução das atualizações"]', "fecharEvolucaoAtualizacoes", "btn-evolucao-atualizacoes");
    const target = document.getElementById("resultado-evolucao-atualizacoes");
    target.textContent = "Carregando atualizações…";
    try {
      const response = await fetch("/api/historico-comparacoes");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível carregar o histórico.");
      const events = (data.eventos || []).filter(event => event.tipo !== "restauracao" && !event.somente_anotacoes_sincronizadas);
      const previous = document.getElementById("evolucao-anterior");
      const current = document.getElementById("evolucao-atual");
      [previous, current].forEach(select => {
        select.replaceChildren();
        events.forEach(event => { const option = document.createElement("option"); option.value = event.id; option.textContent = formatarHorarioHistorico(event.horario); select.appendChild(option); });
      });
      if (events.length < 2) { target.textContent = "São necessárias pelo menos duas atualizações completas para comparar a evolução."; return; }
      current.value = events[0].id; previous.value = events[1].id;
      if (!previous.dataset.bound) {
        document.getElementById("form-evolucao-atualizacoes").addEventListener("submit", event => { event.preventDefault(); compararEvolucaoSelecionada(); });
        previous.dataset.bound = "true";
      }
      await compararEvolucaoSelecionada();
    } catch (error) { target.textContent = error.message || "Não foi possível carregar as atualizações."; }
  }

  async function abrirModalHistoricoComparacoes() {
    app.abrirModalAcessivel("modal-historico-comparacoes", '[aria-label="Fechar histórico de planilhas"]', "fecharModalHistoricoComparacoes", "btn-historico-comparacoes");
    await app.carregarHistoricoComparacoes();
  }

  function fecharModalHistoricoComparacoes() {
    app.fecharModalAcessivel("modal-historico-comparacoes");
  }

  async function carregarHistoricoComparacoes() {
    const lista = document.getElementById("lista-historico-comparacoes");
    lista.setAttribute("aria-busy", "true");
    lista.innerHTML = '<p class="text-sm text-slate-400 text-center py-8" role="status" aria-live="polite">Carregando histórico...</p>';
    const stopLoading = motion?.startLoading(lista, "Carregando histórico…") || (() => {});

    try {
      const res = await fetch("/api/historico-comparacoes");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível carregar o histórico de planilhas.");

      const eventos = Array.isArray(data.eventos) ? data.eventos : [];
      definirTotalHistoricoComparacoes(data.total ?? eventos.length);
      atualizarDatasExportacaoHistorico(eventos);
      lista.replaceChildren();
      if (eventos.length === 0) {
        const vazio = document.createElement("p");
        vazio.className = "text-sm text-slate-400 text-center py-8";
        vazio.setAttribute("role", "status");
        vazio.setAttribute("aria-live", "polite");
        vazio.textContent = "Nenhuma atualização de planilhas registrada no histórico.";
        lista.appendChild(vazio);
        return;
      }

      eventos.forEach(evento => lista.appendChild(criarCartaoHistoricoComparacao(evento)));
      motion?.stagger(lista.children);
    } catch (err) {
      console.error("Erro ao carregar histórico de planilhas:", err);
      const select = document.getElementById("data-exportar-historico-comparacoes");
      if (!select?.value) definirEstadoDatasExportacaoHistorico("Datas indisponíveis");
      lista.replaceChildren();
      const erro = document.createElement("p");
      erro.className = "text-sm text-rose-300 text-center py-8";
      erro.setAttribute("role", "alert");
      erro.setAttribute("aria-live", "assertive");
      erro.textContent = err.message || "Não foi possível carregar o histórico de planilhas.";
      lista.appendChild(erro);
    } finally {
      stopLoading();
      lista.removeAttribute("aria-busy");
    }
  }

  function criarCartaoHistoricoComparacao(evento) {
    const card = document.createElement("article");
    card.className = "flex flex-col md:flex-row md:items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/70 p-4";
    card.append(criarResumoHistoricoComparacao(evento), criarAcoesHistoricoComparacao(evento));
    return card;
  }

  function criarResumoHistoricoComparacao(evento) {
    const resumo = evento.resumo || {};
    const restauracao = evento.tipo === "restauracao";
    const arquivos = restauracao ? (evento.arquivos_restaurados || {}) : (evento.arquivos_enviados || {});

    const info = document.createElement("div");
    info.className = "min-w-0 space-y-1";
    const dataHora = document.createElement("p");
    dataHora.className = "text-sm font-semibold text-white";
    dataHora.textContent = formatarHorarioHistorico(evento.horario);
    info.appendChild(dataHora);

    const fontes = document.createElement("p");
    fontes.className = "text-xs text-slate-400 break-words";
    fontes.textContent = restauracao
      ? `Inventários restaurados — no endpoint: ${formatarNomeFonteHistorico(arquivos.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivos.detalhes || "—")}`
      : `no endpoint: ${formatarNomeFonteHistorico(arquivos.endpoint || "—")} · na Simpress: ${formatarNomeFonteHistorico(arquivos.detalhes || "—")}`;
    info.appendChild(fontes);

    const contagens = document.createElement("p");
    contagens.className = "text-[11px] text-slate-500";
    if (evento.somente_anotacoes_sincronizadas) {
      contagens.textContent = "As anotações podem ser consultadas e editadas neste notebook.";
    } else if (restauracao) {
      const restauracaoDe = evento.restauracao_de || {};
      contagens.textContent = `Restauração do conjunto anterior a ${formatarHorarioHistorico(restauracaoDe.horario)} · registros restaurados: no endpoint ${Number(resumo.total_endpoint_restaurado || 0).toLocaleString("pt-BR")}, na Simpress ${Number(resumo.total_detalhes_restaurado || 0).toLocaleString("pt-BR")}`;
    } else {
      contagens.textContent = `Apelidos/hostnames atualizados: ${Number(resumo.apelidos_atualizados || 0)} · sem acesso há 7+ dias: ${Number(resumo.sem_acesso_7_dias || 0)} · divergências manuais pendentes: ${Number(resumo.divergencias_apelidos_manuais || 0)} · equipamentos sem correspondência — no endpoint: ${Number(resumo.ausentes_no_endpoint || 0)} · na Simpress: ${Number(resumo.ausentes_em_detalhes || 0)} · divergências de local: ${Number(resumo.divergencias_local || 0)} · ambiguidades: ${Number(resumo.correspondencias_ambiguas || 0)}`;
    }
    info.appendChild(contagens);
    return info;
  }

  function criarAcoesHistoricoComparacao(evento) {
    const restauracao = evento.tipo === "restauracao";
    const acoes = document.createElement("div");
    acoes.className = "flex flex-wrap items-center gap-2";

    if (!restauracao) {
      const consultar = document.createElement("button");
      consultar.type = "button";
      consultar.className = "shrink-0 px-3 py-2 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 border border-cyan-500/25 text-xs font-semibold transition";
      consultar.textContent = evento.somente_anotacoes_sincronizadas ? "Consultar anotações" : "Consultar resultado";
      consultar.addEventListener("click", () => consultarHistoricoComparacao(evento.id, consultar));
      acoes.appendChild(consultar);
    }

    if (evento.restauravel) {
      const restaurar = document.createElement("button");
      restaurar.type = "button";
      restaurar.className = "shrink-0 px-3 py-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 border border-amber-500/25 text-xs font-semibold transition";
      restaurar.textContent = restauracao ? "Desfazer restauração" : "Restaurar versão anterior";
      restaurar.setAttribute("aria-label", `${restauracao ? "Desfazer restauração de" : "Restaurar versões anteriores à atualização de"} ${formatarHorarioHistorico(evento.horario)}`);
      restaurar.addEventListener("click", () => app.restaurarHistoricoComparacao(evento, restaurar));
      acoes.appendChild(restaurar);
    }

    if (!evento.somente_anotacoes_sincronizadas) {
      const excluir = document.createElement("button");
      excluir.type = "button";
      excluir.className = "shrink-0 px-3 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-200 border border-rose-500/25 text-xs font-semibold transition";
      excluir.textContent = "Excluir";
      excluir.setAttribute("aria-label", `Excluir atualização de ${formatarHorarioHistorico(evento.horario)}`);
      excluir.addEventListener("click", () => excluirHistoricoComparacao(evento, excluir));
      acoes.appendChild(excluir);
    }

    return acoes;
  }

  async function baixarHistoricoComparacoesExcel(data) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ""))) {
      throw new Error("A data do histórico da atualização não está disponível.");
    }

    const res = await fetch(`/api/historico-comparacoes/exportar/excel?data=${encodeURIComponent(data)}`);
    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.detail || "Não foi possível exportar o histórico selecionado.");
    }

    const disposition = res.headers.get("Content-Disposition") || "";
    const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
    const filename = match && match[1]
      ? match[1].replace(/['"]/g, "")
      : `Historico_Planilhas_${data.replace(/-/g, "")}.xlsx`;
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    return filename;
  }

  async function exportarHistoricoComparacoesExcel() {
    const select = document.getElementById("data-exportar-historico-comparacoes");
    const button = document.getElementById("btn-exportar-historico-comparacoes");
    const data = select?.value || "";
    if (!data) {
      app.showToast("Não há uma data do histórico disponível para exportar.", "warning");
      return;
    }

    const htmlOriginal = button?.innerHTML || "";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin" aria-hidden="true"></i><span class="hidden sm:inline">Exportando...</span>';
      lucide.createIcons({ root: button });
    }

    try {
      await app.baixarHistoricoComparacoesExcel(data);
      app.showToast("Histórico exportado com sucesso!", "success");
    } catch (err) {
      console.error("Erro ao exportar histórico de planilhas:", err);
      app.showToast(err.message || "Não foi possível exportar o histórico selecionado.", "error");
    } finally {
      if (button) {
        button.disabled = !select || !select.value;
        button.removeAttribute("aria-busy");
        button.innerHTML = htmlOriginal;
        lucide.createIcons({ root: button });
      }
    }
  }

  async function restaurarHistoricoComparacao(evento, botao) {
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    botao.textContent = "Preparando...";

    try {
      const previewResponse = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restauracao`);
      const preview = await previewResponse.json().catch(() => ({}));
      if (!previewResponse.ok) throw new Error(preview.detail || "Não foi possível validar o backup selecionado.");

      const backup = preview.arquivos_backup || {};
      const endpointBackup = backup.endpoint || {};
      const simpressBackup = backup.detalhes || {};
      const arquivosAtuais = preview.arquivos_atuais || {};
      const describeBackup = (label, item) => {
        const modified = item.modificado_em ? `; arquivo datado ${formatarHorarioHistorico(item.modificado_em)}` : "";
        return `${label}: ${formatarNomeFonteHistorico(item.nome || "—")} (${Number(item.registros || 0).toLocaleString("pt-BR")} registros${modified})`;
      };
      const describeCurrent = (label, item) => {
        if (!item?.presente) return `${label}: arquivo ausente`;
        const modified = item.modificado_em ? ` · modificado ${formatarHorarioHistorico(item.modificado_em)}` : "";
        return `${label}: ${formatarNomeFonteHistorico(item.nome || "—")}${modified}`;
      };
      const restauracao = preview.tipo_evento === "restauracao";
      const acao = restauracao ? "Desfazer a restauração" : "Reverter a atualização";
      const confirmation = [
        `${acao} registrada em ${formatarHorarioHistorico(preview.evento_horario || evento.horario)}?`,
        "",
        "Conjunto que será restaurado:",
        describeBackup("no endpoint", endpointBackup),
        describeBackup("na Simpress", simpressBackup),
        "",
        "Conjunto ativo, que será guardado como backup:",
        describeCurrent("no endpoint", arquivosAtuais.endpoint),
        describeCurrent("na Simpress", arquivosAtuais.detalhes),
        "",
        "Os dois inventários serão substituídos juntos e a ação ficará registrada no histórico. Continuar?",
      ].join("\n");
      if (!(await app.confirmarAcao({
        titulo: "Restaurar inventários?",
        mensagem: confirmation,
        confirmar: "Restaurar",
        destrutiva: false,
      }))) return;

      botao.textContent = "Restaurando...";
      if (!inventoryRestoreAttempts.has(evento.id)) {
        inventoryRestoreAttempts.set(evento.id, { token: preview.preview_token, key: inventoryOperationKey() });
      }
      const restoreAttempt = inventoryRestoreAttempts.get(evento.id);
      const response = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}/restaurar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": restoreAttempt.key },
        body: JSON.stringify({ preview_token: restoreAttempt.token }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok || (response.status === 409 && /prévia|estado mudou/i.test(String(data.detail || "")))) {
        inventoryRestoreAttempts.delete(evento.id);
      }
      if (!response.ok) throw new Error(data.detail || "Não foi possível restaurar o conjunto selecionado.");

      app.invalidarDadosEquipamentoAposRestauracao();
      await Promise.allSettled([
        app.carregarEstatisticas(),
        app.carregarUnidades(),
        app.carregarHistoricoComparacoes(),
        app.carregarContagemHistoricoComparacoes(),
      ]);
      document.querySelector('#modal-historico-comparacoes [aria-label="Fechar histórico de planilhas"]')
        ?.focus({ preventScroll: true });
      const total = Number(data.evento?.total_equipamentos_carregados || 0).toLocaleString("pt-BR");
      const reversao = data.evento?.desfazer_disponivel
        ? "A restauração pode ser desfeita pelo histórico."
        : "O backup do conjunto substituído está incompleto ou inválido; não é possível desfazer pelo histórico.";
      app.showToast(`Inventários restaurados. ${total} ${pluralize(total, "equipamento carregado", "equipamentos carregados")}. ${reversao}`, "success");
    } catch (err) {
      console.error("Erro ao restaurar o conjunto de planilhas:", err);
      app.showToast(err.message || "Não foi possível restaurar o conjunto selecionado.", "error");
    } finally {
      if (botao.isConnected) {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
        botao.textContent = textoOriginal;
      }
    }
  }

  async function consultarHistoricoComparacao(eventoId, botao, navigationTarget = null) {
    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    botao.textContent = "Carregando...";
    try {
      const res = await fetch(`/api/historico-comparacoes/${encodeURIComponent(eventoId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível abrir este resultado.");

      const evento = data.evento || {};
      app.fecharModalHistoricoComparacoes();
      app.abrirModalComparacaoPlanilhas({
        ...(evento.comparacao || {}),
        evento_id: evento.id,
        horario_comparacao: evento.horario || evento.comparacao?.horario_comparacao,
        historico_salvo: true,
        contexto_historico: true,
      }, navigationTarget);
    } catch (err) {
      console.error("Erro ao abrir comparação salva:", err);
      app.showToast(err.message || "Não foi possível abrir este resultado.", "error");
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      botao.textContent = textoOriginal;
    }
  }

  async function excluirHistoricoComparacao(evento, botao) {
    const dataHora = formatarHorarioHistorico(evento.horario);
    if (!(await app.confirmarAcao({
      titulo: "Excluir atualização?",
      mensagem: `Tem certeza de que deseja excluir esta atualização de ${dataHora}? Essa ação não poderá ser desfeita.`,
      confirmar: "Excluir",
    }))) return;

    const textoOriginal = botao.textContent;
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    botao.textContent = "Excluindo...";
    try {
      const res = await fetch(`/api/historico-comparacoes/${encodeURIComponent(evento.id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Não foi possível excluir esta atualização.");

      await app.carregarHistoricoComparacoes();
      app.showToast("Atualização excluída do histórico.", "success");
    } catch (err) {
      console.error("Erro ao excluir atualização do histórico:", err);
      app.showToast(err.message || "Não foi possível excluir esta atualização.", "error");
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      botao.textContent = textoOriginal;
    }
  }

  return {
    carregarContagemHistoricoComparacoes, fecharEvolucaoAtualizacoes, abrirEvolucaoAtualizacoes,
    abrirModalHistoricoComparacoes, fecharModalHistoricoComparacoes, carregarHistoricoComparacoes,
    baixarHistoricoComparacoesExcel, exportarHistoricoComparacoesExcel, restaurarHistoricoComparacao,
  };
});
