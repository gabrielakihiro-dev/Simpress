/** Automação tab: starts the Chrome routines and shows state, live log and history (docs/operacao/automacao-chrome.md). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).chromeAutomation = factory;
})(typeof window !== "undefined" ? window : globalThis, function createChromeAutomation(context) {
  "use strict";
  const { app, dom } = context;
  const ROTINAS = Object.freeze({
    os: "Rotina de OS",
    inventarios: "Inventários",
    ambas: "Ambas as rotinas",
    login: "Abrir Chrome para login",
  });
  const STATUS = Object.freeze({
    em_andamento: "Em andamento",
    concluido: "Concluído",
    falha: "Falha",
    cancelado: "Cancelado",
    ocupada: "Ocupada",
    interrompido: "Interrompido",
  });
  const POLL_ATIVO_MS = 1500;
  const POLL_LIVRE_MS = 5000;
  const MAX_LINHAS = 2000;

  const estado = {
    offset: 0,
    arquivo: "",
    emAndamento: false,
    ocupado: false,
    timer: 0,
    // null until the first state arrives, so the history loads once even with no runs.
    ultimaExecucaoId: null,
    acompanharFim: false,
  };

  function painel() {
    return document.getElementById("tab-panel-automacao");
  }

  function painelVisivel() {
    const elemento = painel();
    return Boolean(elemento && !elemento.hidden && document.visibilityState !== "hidden");
  }

  function formatarHora(iso) {
    const data = iso ? new Date(iso) : null;
    if (!data || Number.isNaN(data.getTime())) return "";
    return data.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function formatarDuracao(inicio, fim) {
    const comeco = new Date(inicio).getTime();
    const termino = new Date(fim).getTime();
    if (!Number.isFinite(comeco) || !Number.isFinite(termino) || termino < comeco) return "—";
    const segundos = Math.round((termino - comeco) / 1000);
    if (segundos < 60) return `${segundos} s`;
    const minutos = Math.floor(segundos / 60);
    return minutos < 60 ? `${minutos} min ${segundos % 60} s` : `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
  }

  function atualizarBotoes() {
    const bloqueado = estado.emAndamento || estado.ocupado;
    document.querySelectorAll("[data-automacao-rotina]").forEach(botao => {
      botao.disabled = bloqueado;
      botao.setAttribute("aria-disabled", String(bloqueado));
    });
    const cancelar = document.getElementById("btn-automacao-cancelar");
    if (cancelar) cancelar.disabled = !estado.emAndamento || estado.ocupado;
  }

  function mostrarEstado(dados) {
    const caixa = document.getElementById("automacao-estado");
    const titulo = document.getElementById("automacao-estado-titulo");
    const detalhe = document.getElementById("automacao-estado-detalhe");
    if (!caixa || !titulo || !detalhe) return;
    const ativo = dados.estado === "em_andamento";
    caixa.dataset.state = ativo ? (dados.cancelamento_pedido ? "cancelando" : "em_andamento") : "livre";
    if (ativo) {
      const rotina = ROTINAS[dados.rotina] || dados.rotina || "Rotina";
      const origem = dados.origem === "externo" ? "fora do site" : "pelo site";
      const inicio = formatarHora(dados.inicio);
      titulo.textContent = dados.cancelamento_pedido ? "Cancelamento pedido…" : "Em andamento";
      detalhe.textContent = `${rotina}${inicio ? `, desde ${inicio}` : ""} (${origem}).`;
    } else {
      titulo.textContent = "Livre";
      const ultima = dados.ultima;
      detalhe.textContent = ultima
        ? `Última execução: ${ROTINAS[ultima.rotina] || ultima.rotina}, ${STATUS[ultima.status] || ultima.status} em ${formatarHora(ultima.fim || ultima.inicio)}.`
        : "Nenhuma rotina em andamento.";
    }

    const aviso = document.getElementById("automacao-aviso-login");
    const avisoTexto = document.getElementById("automacao-aviso-login-texto");
    if (aviso && avisoTexto) {
      const esperando = ativo && Boolean(dados.aguardando_login);
      const sistema = dados.login_origem ? ` (${dados.login_origem})` : "";
      avisoTexto.textContent = `Faça o login no Chrome de automação${sistema}. A rotina continua sozinha depois do login.`;
      if (aviso.hidden === esperando) aviso.hidden = !esperando;
    }
  }

  function acrescentarLinhas(log) {
    const area = document.getElementById("automacao-log");
    const arquivo = document.getElementById("automacao-log-arquivo");
    if (!area || !log) return;
    if (log.reiniciado || log.arquivo !== estado.arquivo) area.textContent = "";
    estado.arquivo = log.arquivo || "";
    estado.offset = Number(log.offset) || 0;
    if (arquivo) arquivo.textContent = estado.arquivo ? `Arquivo: ${estado.arquivo}` : "Nenhuma execução registrada ainda.";
    const linhas = Array.isArray(log.linhas) ? log.linhas : [];
    if (!linhas.length) return;
    const noFim = area.scrollHeight - area.scrollTop - area.clientHeight < 24;
    const atual = area.textContent ? area.textContent.split("\n") : [];
    const todas = atual.concat(linhas).slice(-MAX_LINHAS);
    area.textContent = todas.join("\n");
    if (noFim) area.scrollTop = area.scrollHeight;
  }

  function celula(rotulo, conteudo) {
    const td = document.createElement("td");
    td.dataset.label = rotulo;
    if (conteudo instanceof Node) td.appendChild(conteudo);
    else td.textContent = String(conteudo ?? "");
    return td;
  }

  function renderizarHistorico(execucoes) {
    const host = document.getElementById("automacao-historico");
    if (!host) return;
    if (!execucoes.length) {
      host.replaceChildren(dom.createTextElement("p", "ux-home-note", "Nenhuma execução registrada ainda."));
      return;
    }
    const tabela = document.createElement("table");
    tabela.className = "automation-history-table";
    const cabecalho = document.createElement("thead");
    const linhaCabecalho = document.createElement("tr");
    ["Rotina", "Início", "Duração", "Status", "Lotes", "Capturas"].forEach(texto => {
      const th = dom.createTextElement("th", "", texto);
      th.scope = "col";
      linhaCabecalho.appendChild(th);
    });
    cabecalho.appendChild(linhaCabecalho);
    const corpo = document.createElement("tbody");
    execucoes.forEach(execucao => {
      const linha = document.createElement("tr");
      const rotina = dom.createTextElement("span", "", ROTINAS[execucao.rotina] || execucao.rotina);
      if (execucao.origem === "externo") rotina.appendChild(dom.createTextElement("small", "automation-history-origin", " fora do site"));
      const status = dom.createTextElement("span", "automation-status-badge", STATUS[execucao.status] || execucao.status || "—");
      status.dataset.status = execucao.status || "";
      if (execucao.mensagem) status.title = execucao.mensagem;
      const statusBloco = document.createElement("span");
      statusBloco.className = "automation-history-status";
      statusBloco.appendChild(status);
      if (execucao.mensagem && execucao.status !== "concluido") {
        statusBloco.appendChild(dom.createTextElement("small", "automation-history-message", execucao.mensagem));
      }
      const lotes = (execucao.lotes || []).map(lote => `${lote.id}${lote.status ? ` (${lote.status})` : ""}`).join(", ") || "—";
      const capturas = document.createElement("span");
      capturas.className = "automation-history-captures";
      (execucao.capturas || []).forEach(captura => {
        const link = dom.createTextElement("a", "automation-history-link", captura.nome);
        link.href = captura.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        capturas.appendChild(link);
      });
      if (!capturas.childNodes.length) capturas.textContent = "—";
      linha.append(
        celula("Rotina", rotina),
        celula("Início", formatarHora(execucao.inicio) || "—"),
        celula("Duração", execucao.status === "em_andamento" ? "—" : formatarDuracao(execucao.inicio, execucao.fim)),
        celula("Status", statusBloco),
        celula("Lotes", lotes),
        celula("Capturas", capturas),
      );
      corpo.appendChild(linha);
    });
    tabela.append(cabecalho, corpo);
    host.replaceChildren(tabela);
  }

  async function carregarHistoricoAutomacao() {
    try {
      const dados = await app.apiFetch("/api/automacao/historico?limite=15", {
        errorMessage: "Não foi possível carregar o histórico da automação.",
      });
      renderizarHistorico(Array.isArray(dados.execucoes) ? dados.execucoes : []);
    } catch (err) {
      console.error("Erro ao carregar o histórico da automação:", err);
      const host = document.getElementById("automacao-historico");
      if (host) host.replaceChildren(dom.createTextElement("p", "ux-home-note", err.message));
    }
  }

  function agendar() {
    window.clearTimeout(estado.timer);
    if (!painelVisivel() && !estado.acompanharFim) return;
    estado.timer = window.setTimeout(atualizarEstadoAutomacao, estado.emAndamento ? POLL_ATIVO_MS : POLL_LIVRE_MS);
  }

  function aplicarEstado(dados) {
    const estavaAtivo = estado.emAndamento;
    estado.emAndamento = dados.estado === "em_andamento";
    mostrarEstado(dados);
    acrescentarLinhas(dados.log);
    atualizarBotoes();
    const ultimaId = dados.ultima?.id || "";
    if (ultimaId !== estado.ultimaExecucaoId || estavaAtivo !== estado.emAndamento) {
      estado.ultimaExecucaoId = ultimaId;
      carregarHistoricoAutomacao();
    }
    if (estavaAtivo && !estado.emAndamento && estado.acompanharFim) {
      estado.acompanharFim = false;
      const ultima = dados.ultima;
      if (ultima) {
        const tipo = ultima.status === "concluido" ? "success" : "error";
        app.showToast(`${ROTINAS[ultima.rotina] || ultima.rotina}: ${STATUS[ultima.status] || ultima.status}.`, tipo);
      }
    }
  }

  async function atualizarEstadoAutomacao() {
    window.clearTimeout(estado.timer);
    try {
      const params = new URLSearchParams({ offset: String(estado.offset), arquivo: estado.arquivo });
      const dados = await app.apiFetch(`/api/automacao/estado?${params}`, {
        errorMessage: "Não foi possível consultar a automação.",
      });
      aplicarEstado(dados);
    } catch (err) {
      console.error("Erro ao consultar a automação:", err);
    } finally {
      agendar();
    }
  }

  async function iniciarRotinaAutomacao(rotina) {
    if (!ROTINAS[rotina] || estado.ocupado || estado.emAndamento) return;
    estado.ocupado = true;
    atualizarBotoes();
    const botao = document.querySelector(`[data-automacao-rotina="${rotina}"]`);
    botao?.setAttribute("aria-busy", "true");
    try {
      const dados = await app.apiFetch("/api/automacao/executar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotina }),
        errorMessage: "Não foi possível iniciar a rotina.",
      });
      estado.acompanharFim = true;
      app.showToast(`${ROTINAS[rotina]} iniciada.`, "success");
      aplicarEstado(dados);
    } catch (err) {
      console.error("Erro ao iniciar a automação:", err);
      app.showToast(err.message, "error");
    } finally {
      estado.ocupado = false;
      botao?.removeAttribute("aria-busy");
      atualizarBotoes();
      atualizarEstadoAutomacao();
    }
  }

  async function cancelarRotinaAutomacao() {
    if (estado.ocupado || !estado.emAndamento) return;
    estado.ocupado = true;
    atualizarBotoes();
    try {
      const dados = await app.apiFetch("/api/automacao/cancelar", {
        method: "POST",
        errorMessage: "Não foi possível cancelar a rotina.",
      });
      app.showToast(dados.mensagem || "Cancelamento pedido.", "success");
      if (dados.estado) aplicarEstado(dados.estado);
    } catch (err) {
      console.error("Erro ao cancelar a automação:", err);
      app.showToast(err.message, "error");
    } finally {
      estado.ocupado = false;
      atualizarBotoes();
      atualizarEstadoAutomacao();
    }
  }

  function inicializarAutomacao() {
    const elemento = painel();
    if (!elemento || typeof MutationObserver !== "function") return;
    // The tab switch only toggles [hidden]; polling follows the panel's visibility.
    new MutationObserver(() => {
      if (painelVisivel()) atualizarEstadoAutomacao();
      else agendar();
    }).observe(elemento, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", () => {
      if (painelVisivel()) atualizarEstadoAutomacao();
    });
    if (painelVisivel()) atualizarEstadoAutomacao();
  }

  return {
    inicializarAutomacao,
    iniciarRotinaAutomacao,
    cancelarRotinaAutomacao,
    atualizarEstadoAutomacao,
    carregarHistoricoAutomacao,
  };
});
