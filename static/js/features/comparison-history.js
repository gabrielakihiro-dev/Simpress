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

      lista.append(...criarGruposHistoricoComparacao(eventos));
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

  const CLASSE_BOTAO_HISTORICO = "w-full sm:w-auto h-9 inline-flex items-center justify-center px-3 rounded-lg border text-xs font-semibold transition";

  function chaveDiaHistorico(horario) {
    const data = String(horario || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : "";
  }

  function rotuloDiaHistorico(chave, hoje = new Date()) {
    if (!chave) return "Sem data";
    const doisDigitos = valor => String(valor).padStart(2, "0");
    const chaveLocal = data => `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;
    const ontem = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 1);
    if (chave === chaveLocal(hoje)) return "Hoje";
    if (chave === chaveLocal(ontem)) return "Ontem";
    const [ano, mes, dia] = chave.split("-");
    return `${dia}/${mes}/${ano}`;
  }

  function criarGruposHistoricoComparacao(eventos) {
    const grupos = new Map();
    eventos.forEach(evento => {
      const chave = chaveDiaHistorico(evento.horario);
      if (!grupos.has(chave)) grupos.set(chave, []);
      grupos.get(chave).push(evento);
    });

    return [...grupos].map(([chave, eventosDoDia]) => {
      const grupo = document.createElement("section");
      grupo.className = "space-y-2";
      const titulo = document.createElement("h4");
      titulo.className = "flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400";
      titulo.textContent = rotuloDiaHistorico(chave);
      const quantidade = document.createElement("span");
      quantidade.className = "font-normal normal-case tracking-normal text-slate-500";
      quantidade.textContent = `· ${eventosDoDia.length} ${eventosDoDia.length === 1 ? "registro" : "registros"}`;
      titulo.appendChild(quantidade);
      grupo.setAttribute("aria-label", `Atualizações de ${titulo.firstChild.textContent}`);
      grupo.appendChild(titulo);
      eventosDoDia.forEach(evento => grupo.appendChild(criarCartaoHistoricoComparacao(evento)));
      return grupo;
    });
  }

  function criarCartaoHistoricoComparacao(evento) {
    const card = document.createElement("article");
    card.className = "rounded-xl border border-slate-800 bg-slate-950/70 p-4 space-y-3";
    card.append(...criarResumoHistoricoComparacao(evento), criarAcoesHistoricoComparacao(evento));
    return card;
  }

  function criarCabecalhoHistoricoComparacao(evento) {
    const restauracao = evento.tipo === "restauracao";
    const [tipo, cores] = evento.somente_anotacoes_sincronizadas
      ? ["Anotações sincronizadas", "border-slate-600/60 bg-slate-800/60 text-slate-300"]
      : restauracao
        ? ["Restauração", "border-amber-500/30 bg-amber-500/10 text-amber-200"]
        : ["Atualização", "border-cyan-500/30 bg-cyan-500/10 text-cyan-200"];

    const cabecalho = document.createElement("header");
    cabecalho.className = "flex flex-wrap items-center justify-between gap-2";
    const dataHora = document.createElement("p");
    dataHora.className = "text-sm font-semibold text-white";
    dataHora.textContent = formatarHorarioHistorico(evento.horario);
    const selo = document.createElement("span");
    selo.className = `shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cores}`;
    selo.textContent = tipo;
    cabecalho.append(dataHora, selo);
    return cabecalho;
  }

  function criarArquivosHistoricoComparacao(evento) {
    const restauracao = evento.tipo === "restauracao";
    const arquivos = restauracao ? (evento.arquivos_restaurados || {}) : (evento.arquivos_enviados || {});
    const lista = document.createElement("dl");
    lista.className = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs";
    lista.setAttribute("aria-label", restauracao ? "Inventários restaurados" : "Arquivos enviados");
    [["Endpoint", arquivos.endpoint], ["Simpress", arquivos.detalhes]].forEach(([fonte, arquivo]) => {
      const nome = formatarNomeFonteHistorico(arquivo || "—");
      const rotulo = document.createElement("dt");
      rotulo.className = "text-slate-500";
      rotulo.textContent = fonte;
      const valor = document.createElement("dd");
      valor.className = "min-w-0 truncate text-slate-300";
      valor.textContent = nome;
      valor.title = nome;
      lista.append(rotulo, valor);
    });
    return lista;
  }

  function criarMetricasHistoricoComparacao(metricas) {
    const grade = document.createElement("dl");
    grade.className = "grid grid-cols-2 sm:grid-cols-4 gap-2";
    metricas.forEach(({ rotulo, valor, alerta = "amber" }) => {
      const numero = Number(valor || 0);
      const destaque = numero > 0 && alerta
        ? (alerta === "rose" ? "border-rose-500/25 bg-rose-500/5 text-rose-200" : "border-amber-500/25 bg-amber-500/5 text-amber-200")
        : "border-slate-800 bg-slate-900/40 text-slate-500";
      const chip = document.createElement("div");
      chip.className = `flex flex-col-reverse rounded-lg border px-3 py-2 ${destaque}`;
      const nome = document.createElement("dt");
      nome.className = "text-[11px] leading-tight";
      nome.textContent = rotulo;
      const quantidade = document.createElement("dd");
      quantidade.className = `text-base font-semibold ${numero > 0 ? "text-white" : ""}`;
      quantidade.textContent = numero.toLocaleString("pt-BR");
      chip.append(nome, quantidade);
      grade.appendChild(chip);
    });
    return grade;
  }

  function criarResumoHistoricoComparacao(evento) {
    const resumo = evento.resumo || {};
    const partes = [criarCabecalhoHistoricoComparacao(evento), criarArquivosHistoricoComparacao(evento)];

    if (evento.somente_anotacoes_sincronizadas) {
      const aviso = document.createElement("p");
      aviso.className = "text-xs text-slate-400";
      aviso.textContent = "As anotações podem ser consultadas e editadas neste notebook.";
      partes.push(aviso);
    } else if (evento.tipo === "restauracao") {
      const restauracaoDe = evento.restauracao_de || {};
      const origem = document.createElement("p");
      origem.className = "text-xs text-slate-400";
      origem.textContent = `Restauração do conjunto anterior a ${formatarHorarioHistorico(restauracaoDe.horario)}`;
      partes.push(origem, criarMetricasHistoricoComparacao([
        { rotulo: "Restaurados – Endpoint", valor: resumo.total_endpoint_restaurado, alerta: null },
        { rotulo: "Restaurados – Simpress", valor: resumo.total_detalhes_restaurado, alerta: null },
      ]));
    } else {
      partes.push(criarMetricasHistoricoComparacao([
        { rotulo: "Apelidos atualizados", valor: resumo.apelidos_atualizados },
        { rotulo: "Sem acesso 7+ dias", valor: resumo.sem_acesso_7_dias },
        { rotulo: "Divergências manuais", valor: resumo.divergencias_apelidos_manuais, alerta: "rose" },
        { rotulo: "Sem correspondência – Endpoint", valor: resumo.ausentes_no_endpoint },
        { rotulo: "Sem correspondência – Simpress", valor: resumo.ausentes_em_detalhes },
        { rotulo: "Divergências de local", valor: resumo.divergencias_local },
        { rotulo: "Ambiguidades", valor: resumo.correspondencias_ambiguas, alerta: "rose" },
      ]));
    }
    return partes;
  }

  function criarAcoesHistoricoComparacao(evento) {
    const restauracao = evento.tipo === "restauracao";
    const acoes = document.createElement("div");
    acoes.className = "flex flex-col sm:flex-row sm:flex-wrap sm:justify-end gap-2 border-t border-slate-800/80 pt-3";

    if (!restauracao) {
      const consultar = document.createElement("button");
      consultar.type = "button";
      consultar.className = `${CLASSE_BOTAO_HISTORICO} bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 border-cyan-500/25`;
      consultar.textContent = evento.somente_anotacoes_sincronizadas ? "Consultar anotações" : "Consultar resultado";
      consultar.addEventListener("click", () => consultarHistoricoComparacao(evento.id, consultar));
      acoes.appendChild(consultar);
    }

    if (evento.restauravel) {
      const restaurar = document.createElement("button");
      restaurar.type = "button";
      restaurar.className = `${CLASSE_BOTAO_HISTORICO} bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 border-amber-500/25`;
      restaurar.textContent = restauracao ? "Desfazer restauração" : "Restaurar versão anterior";
      restaurar.setAttribute("aria-label", `${restauracao ? "Desfazer restauração de" : "Restaurar versões anteriores à atualização de"} ${formatarHorarioHistorico(evento.horario)}`);
      restaurar.addEventListener("click", () => app.restaurarHistoricoComparacao(evento, restaurar));
      acoes.appendChild(restaurar);
    }

    if (!evento.somente_anotacoes_sincronizadas) {
      const excluir = document.createElement("button");
      excluir.type = "button";
      excluir.className = `${CLASSE_BOTAO_HISTORICO} bg-transparent hover:bg-rose-500/10 text-rose-300 border-rose-500/30`;
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

  async function exportarResultadoComparacaoPlanilhas() {
    const button = document.getElementById("btn-exportar-resultado-comparacao");
    const data = button?.dataset.historyDate || "";
    if (!data) {
      app.showToast("Este resultado não tem uma data de histórico para exportar.", "warning");
      return;
    }

    const htmlOriginal = button.innerHTML;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML = '<i data-lucide="loader-2" class="w-5 h-5 animate-spin" aria-hidden="true"></i>';
    lucide.createIcons({ root: button });

    try {
      await app.baixarHistoricoComparacoesExcel(data);
      app.showToast("Resultado exportado com sucesso!", "success");
    } catch (err) {
      console.error("Erro ao exportar resultado da atualização das planilhas:", err);
      app.showToast(err.message || "Não foi possível exportar o resultado.", "error");
    } finally {
      button.disabled = !button.dataset.historyDate;
      button.removeAttribute("aria-busy");
      button.innerHTML = htmlOriginal;
      lucide.createIcons({ root: button });
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
    const conteudoOriginal = [...botao.childNodes];
    const restaurarBotao = () => {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      botao.replaceChildren(...conteudoOriginal);
    };
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
      restaurarBotao();
    } catch (err) {
      console.error("Erro ao abrir comparação salva:", err);
      app.showToast(err.message || "Não foi possível abrir este resultado.", "error");
      restaurarBotao();
    }
  }

  // Home dashboard shortcut: opens the saved result and scrolls to the section named by `secao`.
  function abrirResultadoHistoricoComparacao(eventoId, secao, botao) {
    return consultarHistoricoComparacao(eventoId, botao, { section: secao });
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
    baixarHistoricoComparacoesExcel, exportarHistoricoComparacoesExcel, exportarResultadoComparacaoPlanilhas,
    restaurarHistoricoComparacao,
    abrirResultadoHistoricoComparacao,
  };
});
