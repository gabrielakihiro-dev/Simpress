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
  const MAX_LINHAS = 500;

  const estado = {
    offset: 0,
    arquivo: "",
    emAndamento: false,
    ocupado: false,
    timer: 0,
    // null until the first state arrives, so the history loads once even with no runs.
    ultimaExecucaoId: null,
    acompanharFim: false,
    linhasAoVivo: [], logHistorico: null, execucaoSelecionada: "",
    consultaLog: 0, consultaHistorico: 0, consultaOpcoes: 0,
    pagina: 1, paginas: 1, limite: 5, filtros: {},
    logPagina: 1, logPaginas: 1, ampliado: "",
    avisouServidorAntigo: false,
  };

  const AVISO_SERVIDOR_ANTIGO = "Servidor desatualizado: reinicie o Simpress (feche a janela do servidor e abra iniciar_servidor.bat).";

  // A 404 on /api/automacao/* with FastAPI's default body means the route is missing: an old server answered.
  async function consultarAutomacao(url, opcoes) {
    try {
      return await app.apiFetch(url, opcoes);
    } catch (err) {
      if (err && err.status === 404 && (err.detail === undefined || err.detail === "Not Found")) {
        const aviso = new Error(AVISO_SERVIDOR_ANTIGO);
        aviso.status = 404;
        aviso.servidorDesatualizado = true;
        throw aviso;
      }
      throw err;
    }
  }

  // The outdated-server notice is shown once; repeated failures stay silent in the UI.
  function avisarErro(err) {
    if (err?.servidorDesatualizado) {
      if (estado.avisouServidorAntigo) return;
      estado.avisouServidorAntigo = true;
    }
    app.showToast(err.message, "error");
  }

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
    if (!area || !log) return;
    if (log.reiniciado || log.arquivo !== estado.arquivo) estado.linhasAoVivo = [];
    estado.arquivo = log.arquivo || "";
    estado.offset = Number(log.offset) || 0;
    const linhas = Array.isArray(log.linhas) ? log.linhas : [];
    estado.linhasAoVivo = estado.linhasAoVivo.concat(linhas).slice(-MAX_LINHAS);
    if (!estado.execucaoSelecionada) mostrarLogAutomacao();
  }

  function valor(id) { return document.getElementById(id)?.value || ""; }

  function mostrarLogAutomacao() {
    const area = document.getElementById("automacao-log");
    if (!area) return;
    const historico = Boolean(estado.execucaoSelecionada);
    const limite = Number(valor("automacao-log-limite")) || 200;
    const dados = estado.logHistorico;
    const linhas = historico ? (dados?.linhas || []) : estado.linhasAoVivo;
    const arquivo = historico ? (dados?.arquivo || "") : estado.arquivo;
    const noFim = area.scrollHeight - area.scrollTop - area.clientHeight < 24;
    const texto = linhas.slice(-limite).join("\n");
    area.setAttribute("aria-live", historico ? "off" : "polite");
    if (area.textContent !== texto) area.textContent = texto;
    if (!historico && noFim) area.scrollTop = area.scrollHeight;
    const arquivoElemento = document.getElementById("automacao-log-arquivo");
    const arquivoTexto = arquivo ? `Arquivo: ${arquivo}` : "Nenhum log disponível.";
    if (arquivoElemento.textContent !== arquivoTexto) arquivoElemento.textContent = arquivoTexto;
    const resumo = dados?.execucao;
    const modoTexto = historico
      ? `Histórico · ${resumo ? `${ROTINAS[resumo.rotina] || resumo.rotina} · ${formatarHora(resumo.inicio)}` : "Consultando execução"} · últimas ${Math.min(limite, linhas.length)} linhas${dados?.limitado ? " (trecho final)" : ""}`
      : `Ao vivo · últimas ${Math.min(limite, linhas.length)} linhas`;
    const modo = document.getElementById("automacao-log-modo");
    // Do not announce the same status again on every polling response.
    if (modo.textContent !== modoTexto) modo.textContent = modoTexto;
    document.getElementById("automacao-log-ao-vivo").hidden = !historico;
  }

  function alterarLimiteLogAutomacao() { mostrarLogAutomacao(); }

  async function selecionarLogAutomacao(id) {
    if (!id) return;
    const consulta = ++estado.consultaLog;
    estado.execucaoSelecionada = id;
    estado.logHistorico = null;
    mostrarLogAutomacao();
    try {
      const dados = await consultarAutomacao(`/api/automacao/execucoes/${encodeURIComponent(id)}/log?linhas=500`, {errorMessage: "Não foi possível abrir o log selecionado."});
      if (consulta !== estado.consultaLog) return;
      estado.logHistorico = dados;
      mostrarLogAutomacao();
    } catch (err) {
      if (consulta !== estado.consultaLog) return;
      document.getElementById("automacao-log").textContent = err.message;
      document.getElementById("automacao-log-modo").textContent = "Histórico · erro ao consultar";
    }
  }

  function voltarAoVivoAutomacao() {
    ++estado.consultaLog;
    estado.execucaoSelecionada = "";
    estado.logHistorico = null;
    document.getElementById("automacao-log-execucao").value = "";
    mostrarLogAutomacao();
    atualizarEstadoAutomacao();
  }

  async function consultarExecucoesLog() {
    const consulta = ++estado.consultaOpcoes;
    const select = document.getElementById("automacao-log-execucao");
    const data = valor("automacao-log-data");
    select.replaceChildren(new Option(data ? "Carregando execuções…" : "Selecione uma data", ""));
    select.disabled = true;
    document.getElementById("automacao-log-paginas").hidden = true;
    if (!data) return;
    try {
      const params = new URLSearchParams({limite: "20", pagina: String(estado.logPagina), data_inicio: data, data_fim: data});
      const dados = await consultarAutomacao(`/api/automacao/historico?${params}`, {errorMessage: "Não foi possível listar as execuções desta data."});
      if (consulta !== estado.consultaOpcoes) return;
      const execucoes = dados.execucoes || [];
      select.replaceChildren(new Option(execucoes.length ? "Selecione uma execução" : "Nenhuma execução nesta data", ""));
      execucoes.forEach(item => select.add(new Option(`${formatarHora(item.inicio)} · ${ROTINAS[item.rotina] || item.rotina} · ${STATUS[item.status] || item.status}`, item.id)));
      select.disabled = !execucoes.length;
      if (execucoes.some(item => item.id === estado.execucaoSelecionada)) select.value = estado.execucaoSelecionada;
      estado.logPagina = dados.pagina || 1;
      estado.logPaginas = dados.paginas || 1;
      document.getElementById("automacao-log-paginas").hidden = estado.logPaginas <= 1;
      document.getElementById("automacao-log-pagina").textContent = `${estado.logPagina} de ${estado.logPaginas}`;
      document.getElementById("automacao-log-anterior").disabled = estado.logPagina >= estado.logPaginas;
      document.getElementById("automacao-log-proxima").disabled = estado.logPagina <= 1;
    } catch (err) {
      if (consulta !== estado.consultaOpcoes) return;
      select.replaceChildren(new Option(err.message, ""));
    }
  }

  function carregarExecucoesLogAutomacao() { estado.logPagina = 1; return consultarExecucoesLog(); }
  function mudarPaginaLogAutomacao(direcao) {
    estado.logPagina = Math.max(1, Math.min(estado.logPaginas, estado.logPagina - Number(direcao)));
    return consultarExecucoesLog();
  }

  async function abrirLogExecucaoAutomacao(id, inicio) {
    const data = new Date(inicio);
    if (!Number.isNaN(data.getTime())) document.getElementById("automacao-log-data").value = `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
    if (document.getElementById("automacao-andamento-conteudo").hidden) recolherPainelAutomacao("andamento");
    document.getElementById("automacao-log-filtros").open = true;
    await Promise.all([selecionarLogAutomacao(id), carregarExecucoesLogAutomacao()]);
    document.getElementById("automacao-andamento-painel").scrollIntoView({block: "start"});
    document.getElementById("automacao-log").focus({preventScroll: true});
  }

  function recolherPainelAutomacao(nome) {
    if (!["andamento", "historico"].includes(nome)) return;
    const conteudo = document.getElementById(`automacao-${nome}-conteudo`);
    const botao = document.querySelector(`[aria-controls="${conteudo.id}"]`);
    if (estado.ampliado === nome) ampliarPainelAutomacao(nome);
    conteudo.hidden = !conteudo.hidden;
    botao.setAttribute("aria-expanded", String(!conteudo.hidden));
    botao.textContent = conteudo.hidden ? "Expandir" : "Recolher";
    botao.setAttribute("aria-label", `${conteudo.hidden ? "Expandir" : "Recolher"} ${nome === "andamento" ? "Andamento" : "Últimas execuções"}`);
  }

  function ampliarPainelAutomacao(nome) {
    if (!["andamento", "historico"].includes(nome)) return;
    const estavaAmpliado = estado.ampliado === nome;
    if (estado.ampliado) {
      const anterior = document.getElementById(`automacao-${estado.ampliado}-painel`);
      anterior.classList.remove("automation-card--expanded");
      const botao = anterior.querySelector('[aria-pressed]');
      botao.setAttribute("aria-pressed", "false");
      botao.textContent = "Ampliar";
      botao.setAttribute("aria-label", `Ampliar ${estado.ampliado === "andamento" ? "Andamento" : "Últimas execuções"}`);
      estado.ampliado = "";
    }
    if (estavaAmpliado) return;
    if (document.getElementById(`automacao-${nome}-conteudo`).hidden) recolherPainelAutomacao(nome);
    const card = document.getElementById(`automacao-${nome}-painel`);
    card.classList.add("automation-card--expanded");
    const botao = card.querySelector('[aria-pressed]');
    botao.setAttribute("aria-pressed", "true");
    botao.textContent = "Restaurar";
    botao.setAttribute("aria-label", `Restaurar ${nome === "andamento" ? "Andamento" : "Últimas execuções"}`);
    estado.ampliado = nome;
    card.scrollIntoView({block: "start"});
  }

  function celula(rotulo, conteudo) {
    const td = document.createElement("td");
    td.dataset.label = rotulo;
    if (conteudo instanceof Node) td.appendChild(conteudo);
    else td.textContent = String(conteudo ?? "");
    return td;
  }

  function descricaoCaptura(execucao) {
    const rotina = ROTINAS[execucao.rotina] || execucao.rotina || "Automação";
    const hora = formatarHora(execucao.inicio);
    const base = `Captura de tela da falha em ${rotina}${hora ? ` às ${hora}` : ""}`;
    return execucao.mensagem ? `${base}: ${execucao.mensagem}` : base;
  }

  function criarCapturaHistorico(execucao, captura) {
    const descricao = descricaoCaptura(execucao);
    const item = document.createElement("span");
    item.className = "automation-capture";
    const miniatura = document.createElement("button");
    miniatura.type = "button";
    miniatura.className = "automation-capture-thumb";
    miniatura.setAttribute("aria-haspopup", "dialog");
    miniatura.setAttribute("aria-label", `Ampliar captura ${captura.nome}`);
    const imagem = document.createElement("img");
    imagem.src = captura.url;
    imagem.alt = descricao;
    imagem.loading = "lazy";
    imagem.decoding = "async";
    imagem.addEventListener("error", () => {
      miniatura.replaceChildren(dom.createTextElement("span", "automation-capture-missing", "Captura indisponível"));
      miniatura.disabled = true;
    }, { once: true });
    miniatura.appendChild(imagem);
    miniatura.addEventListener("click", () => abrirCapturaAutomacao(captura, descricao, execucao.mensagem, miniatura));
    const link = dom.createTextElement("a", "automation-history-link", captura.nome);
    link.href = captura.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    item.append(miniatura, link);
    return item;
  }

  function abrirCapturaAutomacao(captura, descricao, mensagem, origem) {
    let dialogo = document.getElementById("automacao-captura-dialogo");
    if (!dialogo) {
      dialogo = document.createElement("dialog");
      dialogo.id = "automacao-captura-dialogo";
      dialogo.className = "automation-capture-dialog";
      dialogo.setAttribute("aria-labelledby", "automacao-captura-titulo");
      const titulo = dom.createTextElement("h3", "automation-capture-title", "");
      titulo.id = "automacao-captura-titulo";
      const fechar = dom.createTextElement("button", "btn btn-secondary", "Fechar");
      fechar.type = "button";
      fechar.id = "automacao-captura-fechar";
      fechar.addEventListener("click", () => dialogo.close());
      const cabecalho = document.createElement("div");
      cabecalho.className = "automation-capture-header";
      cabecalho.append(titulo, fechar);
      const imagem = document.createElement("img");
      imagem.id = "automacao-captura-imagem";
      imagem.className = "automation-capture-full";
      const mensagemEl = dom.createTextElement("p", "automation-capture-message", "");
      mensagemEl.id = "automacao-captura-mensagem";
      dialogo.append(cabecalho, imagem, mensagemEl);
      // Clicking the backdrop (the dialog element itself) closes it, like Escape.
      dialogo.addEventListener("click", event => { if (event.target === dialogo) dialogo.close(); });
      dialogo.addEventListener("close", () => {
        const anterior = dialogo._origem;
        dialogo._origem = null;
        if (anterior && anterior.isConnected) anterior.focus();
      });
      document.body.appendChild(dialogo);
    }
    dialogo._origem = origem || null;
    document.getElementById("automacao-captura-titulo").textContent = captura.nome;
    const imagem = document.getElementById("automacao-captura-imagem");
    imagem.src = captura.url;
    imagem.alt = descricao;
    const mensagemEl = document.getElementById("automacao-captura-mensagem");
    mensagemEl.textContent = mensagem || "";
    mensagemEl.hidden = !mensagem;
    if (typeof dialogo.showModal === "function") dialogo.showModal();
    else dialogo.setAttribute("open", "");
    document.getElementById("automacao-captura-fechar").focus();
  }

  function renderizarHistorico(execucoes) {
    const host = document.getElementById("automacao-historico");
    if (!host) return;
    if (!execucoes.length) {
      host.replaceChildren(dom.createTextElement("p", "ux-home-note", "Nenhuma execução encontrada para os filtros selecionados."));
      return;
    }
    const tabela = document.createElement("table");
    tabela.className = "automation-history-table";
    const cabecalho = document.createElement("thead");
    const linhaCabecalho = document.createElement("tr");
    ["Rotina", "Início", "Duração", "Status", "Lotes", "Capturas", "Log"].forEach(texto => {
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
      (execucao.capturas || []).forEach(captura => capturas.appendChild(criarCapturaHistorico(execucao, captura)));
      if (!capturas.childNodes.length) capturas.textContent = "—";
      const verLog = dom.createTextElement("button", "btn btn-secondary", "Ver log");
      verLog.type = "button";
      verLog.dataset.onClick = "abrirLogExecucaoAutomacao";
      verLog.dataset.args = JSON.stringify([execucao.id, execucao.inicio]);
      verLog.setAttribute("aria-label", `Ver log de ${ROTINAS[execucao.rotina] || execucao.rotina} em ${formatarHora(execucao.inicio)}`);
      linha.append(
        celula("Rotina", rotina),
        celula("Início", formatarHora(execucao.inicio) || "—"),
        celula("Duração", execucao.status === "em_andamento" ? "—" : formatarDuracao(execucao.inicio, execucao.fim)),
        celula("Status", statusBloco),
        celula("Lotes", lotes),
        celula("Capturas", capturas),
        celula("Log", verLog),
      );
      corpo.appendChild(linha);
    });
    tabela.append(cabecalho, corpo);
    host.replaceChildren(tabela);
  }

  async function carregarHistoricoAutomacao() {
    const consulta = ++estado.consultaHistorico;
    try {
      const params = new URLSearchParams({limite: String(estado.limite), pagina: String(estado.pagina), ...estado.filtros});
      const dados = await consultarAutomacao(`/api/automacao/historico?${params}`, {
        errorMessage: "Não foi possível carregar o histórico da automação.",
      });
      if (consulta !== estado.consultaHistorico) return;
      renderizarHistorico(Array.isArray(dados.execucoes) ? dados.execucoes : []);
      estado.pagina = dados.pagina || 1;
      estado.paginas = dados.paginas || 1;
      document.getElementById("automacao-historico-pagina").textContent = `Página ${estado.pagina} de ${estado.paginas}`;
      document.getElementById("automacao-historico-anterior").disabled = estado.pagina <= 1;
      document.getElementById("automacao-historico-proxima").disabled = estado.pagina >= estado.paginas;
      const filtros = estado.filtros;
      const resumo = [`${dados.total ?? dados.execucoes?.length ?? 0} execuções`];
      if (filtros.data_inicio) resumo.push(`de ${filtros.data_inicio.split("-").reverse().join("/")}`);
      if (filtros.data_fim) resumo.push(`até ${filtros.data_fim.split("-").reverse().join("/")}`);
      if (filtros.rotina) resumo.push(ROTINAS[filtros.rotina]);
      if (filtros.status) resumo.push(STATUS[filtros.status]);
      document.getElementById("automacao-historico-resumo").textContent = resumo.join(" · ");
    } catch (err) {
      if (consulta !== estado.consultaHistorico) return;
      console.error("Erro ao carregar o histórico da automação:", err);
      const host = document.getElementById("automacao-historico");
      if (host) host.replaceChildren(dom.createTextElement("p", "ux-home-note", err.message));
      document.getElementById("automacao-historico-resumo").textContent = "Não foi possível atualizar a consulta.";
      document.getElementById("automacao-historico-anterior").disabled = true;
      document.getElementById("automacao-historico-proxima").disabled = true;
    }
  }

  function filtrarHistoricoAutomacao() {
    const inicio = valor("automacao-historico-inicio");
    const fim = valor("automacao-historico-fim");
    if (inicio && fim && inicio > fim) {
      document.getElementById("automacao-historico-resumo").textContent = "A data inicial deve ser anterior ou igual à data final.";
      document.getElementById("automacao-historico-fim").focus();
      return;
    }
    estado.filtros = Object.fromEntries(Object.entries({data_inicio: inicio, data_fim: fim,
      rotina: valor("automacao-historico-rotina"), status: valor("automacao-historico-status")}).filter(([, v]) => v));
    estado.limite = Number(valor("automacao-historico-limite")) || 5;
    estado.pagina = 1;
    return carregarHistoricoAutomacao();
  }

  function limparFiltrosAutomacao() {
    ["inicio", "fim", "rotina", "status"].forEach(campo => { document.getElementById(`automacao-historico-${campo}`).value = ""; });
    return filtrarHistoricoAutomacao();
  }

  function mudarPaginaHistoricoAutomacao(direcao) {
    estado.pagina = Math.max(1, Math.min(estado.paginas, estado.pagina + Number(direcao)));
    return carregarHistoricoAutomacao();
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
      const dados = await consultarAutomacao(`/api/automacao/estado?${params}`, {
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
      const dados = await consultarAutomacao("/api/automacao/executar", {
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
      avisarErro(err);
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
      const dados = await consultarAutomacao("/api/automacao/cancelar", {
        method: "POST",
        errorMessage: "Não foi possível cancelar a rotina.",
      });
      app.showToast(dados.mensagem || "Cancelamento pedido.", "success");
      if (dados.estado) aplicarEstado(dados.estado);
    } catch (err) {
      console.error("Erro ao cancelar a automação:", err);
      avisarErro(err);
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
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !estado.ampliado || !painelVisivel()) return;
      if (document.querySelector("dialog[open]")) return; // The capture viewer closes first.
      const card = document.getElementById(`automacao-${estado.ampliado}-painel`);
      ampliarPainelAutomacao(estado.ampliado);
      card.querySelector('[aria-pressed]').focus();
    });
    if (painelVisivel()) atualizarEstadoAutomacao();
  }

  return {
    inicializarAutomacao,
    iniciarRotinaAutomacao,
    cancelarRotinaAutomacao,
    atualizarEstadoAutomacao,
    carregarHistoricoAutomacao,
    filtrarHistoricoAutomacao, limparFiltrosAutomacao, mudarPaginaHistoricoAutomacao,
    carregarExecucoesLogAutomacao, mudarPaginaLogAutomacao, selecionarLogAutomacao,
    abrirLogExecucaoAutomacao, voltarAoVivoAutomacao, alterarLimiteLogAutomacao,
    recolherPainelAutomacao, ampliarPainelAutomacao,
  };
});
