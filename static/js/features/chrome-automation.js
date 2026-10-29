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
    usuarios: "Verificar usuários",
    ambas: "Ambas as rotinas",
    login: "Abrir Chrome para login",
    sebrae: "Chamados novos Sebrae",
    dashboard: "Dashboard + chamados novos Sebrae",
    enviar: "Enviar Dashboard atualizado ao SharePoint",
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
  const MAX_EVENTOS = 200;

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
    consultaLog: 0, consultaHistorico: 0, consultaOpcoes: 0, consultaUltimas: 0,
    ultimasPorRotina: {},
    pagina: 1, paginas: 1, limite: 5, filtros: {},
    logPagina: 1, logPaginas: 1,
    avisouServidorAntigo: false,
    rotinaAtiva: "",
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
    const minutos = Math.floor(segundos / 60);
    return minutos < 60 ? `${minutos}m ${segundos % 60}s` : `${Math.floor(minutos / 60)}h ${minutos % 60}m`;
  }

  function formatarHoraCurta(iso) {
    const data = iso ? new Date(iso) : null;
    if (!data || Number.isNaN(data.getTime())) return "";
    return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // "08:30" (hoje), "ontem 17:45" ou "22/10 16:20"; `dia` é 0 para hoje e 1 para ontem.
  function descreverQuando(iso) {
    const data = iso ? new Date(iso) : null;
    if (!data || Number.isNaN(data.getTime())) return { dia: -1, texto: "" };
    const meiaNoite = valorData => new Date(valorData.getFullYear(), valorData.getMonth(), valorData.getDate()).getTime();
    const dia = Math.round((meiaNoite(new Date()) - meiaNoite(data)) / 86400000);
    const hora = formatarHoraCurta(iso);
    if (dia === 0) return { dia, texto: hora };
    if (dia === 1) return { dia, texto: `ontem ${hora}` };
    return { dia, texto: `${data.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora}` };
  }

  function rotuloInicio(iso) {
    const { dia, texto } = descreverQuando(iso);
    if (dia === 0) return `Hoje ${texto}`;
    return texto ? texto.charAt(0).toLocaleUpperCase("pt-BR") + texto.slice(1) : "—";
  }

  function criarIcone(nome, girando = false) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `ck-ico ck-ico--xs${girando ? " ck-girando" : ""}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "use")).setAttribute("href", `#${nome}`);
    return svg;
  }

  function definirIcone(elemento, nome, girando = false) {
    const svg = elemento?.querySelector("svg");
    if (!svg) return;
    svg.querySelector("use")?.setAttribute("href", `#${nome}`);
    svg.classList.toggle("ck-girando", girando);
  }

  const ICONE_STATUS = Object.freeze({ ok: "i-ok", erro: "i-erro", alerta: "i-alerta", info: "i-loader", "": "i-neutro" });
  const STATUS_VISUAL = Object.freeze({
    concluido: "ok", falha: "erro", cancelado: "", interrompido: "alerta", ocupada: "alerta", em_andamento: "info",
  });

  // Selo da última execução de cada rotina (cartões e linha "Verificar usuários"); estado.ultimasPorRotina vem do histórico.
  function renderizarBadgesRotinas() {
    document.querySelectorAll("[data-rotina-badge]").forEach(badge => {
      const rotina = badge.dataset.rotinaBadge;
      const ativo = estado.emAndamento && estado.rotinaAtiva === rotina;
      const ultima = estado.ultimasPorRotina[rotina];
      const quando = descreverQuando(ultima?.fim || ultima?.inicio);
      let status = "";
      let texto = "Sem execuções";
      if (ativo) {
        status = "info";
        texto = "Em andamento";
      } else if (ultima && ultima.status === "concluido" && quando.dia === 0) {
        status = "ok";
        texto = `Concluído ${quando.texto}`;
      } else if (ultima && ultima.status === "concluido") {
        texto = quando.texto.charAt(0).toLocaleUpperCase("pt-BR") + quando.texto.slice(1);
      } else if (ultima) {
        status = STATUS_VISUAL[ultima.status] || "";
        texto = `${STATUS[ultima.status] || ultima.status} ${quando.texto}`.trim();
      }
      if (badge.dataset.status !== status) badge.dataset.status = status;
      definirIcone(badge, ativo ? "i-loader" : (status ? ICONE_STATUS[status] : "i-clock"), ativo);
      const rotulo = badge.querySelector("span");
      if (rotulo && rotulo.textContent !== texto) rotulo.textContent = texto;
      const cartao = badge.closest("[data-rotina]");
      const situacao = ativo ? "em-andamento" : (status === "ok" ? "concluido" : "ocioso");
      if (cartao && cartao.dataset.estado !== undefined && cartao.dataset.estado !== situacao) cartao.dataset.estado = situacao;
    });
  }

  async function carregarUltimasPorRotina() {
    const consulta = ++estado.consultaUltimas;
    await Promise.all(["os", "inventarios", "ambas", "usuarios"].map(async rotina => {
      try {
        const params = new URLSearchParams({ limite: "1", pagina: "1", rotina });
        const dados = await consultarAutomacao(`/api/automacao/historico?${params}`, { errorMessage: "Não foi possível consultar a última execução." });
        if (consulta === estado.consultaUltimas) estado.ultimasPorRotina[rotina] = dados.execucoes?.[0] || null;
      } catch (err) {
        if (consulta === estado.consultaUltimas) estado.ultimasPorRotina[rotina] = null;
      }
    }));
    if (consulta === estado.consultaUltimas) renderizarBadgesRotinas();
  }

  function atualizarBotoes() {
    document.querySelectorAll("[data-automacao-rotina]").forEach(botao => {
      const cartao = botao.closest("[data-rotina]");
      // A rotina em andamento vira "Acompanhar": o botão fica livre e leva ao console.
      const acompanhar = Boolean(cartao) && estado.emAndamento && botao.dataset.automacaoRotina === estado.rotinaAtiva;
      const bloqueado = estado.ocupado || (estado.emAndamento && !acompanhar);
      botao.disabled = bloqueado;
      botao.setAttribute("aria-disabled", String(bloqueado));
      if (!cartao) return;
      const repetir = estado.ultimasPorRotina[botao.dataset.automacaoRotina]?.status === "falha";
      const rotulo = acompanhar ? "Acompanhar" : (repetir ? "Tentar de novo" : "Executar");
      const texto = botao.querySelector("span");
      if (texto && texto.textContent !== rotulo) texto.textContent = rotulo;
      botao.classList.toggle("ck-btn--primario", acompanhar);
      botao.classList.toggle("ck-btn--secundario", !acompanhar);
      definirIcone(botao, acompanhar ? "i-text" : (repetir ? "i-refresh" : "i-play"));
    });
    renderizarBadgesRotinas();
    const cancelar = document.getElementById("btn-automacao-cancelar");
    if (cancelar) cancelar.disabled = !estado.emAndamento || estado.ocupado;
  }

  function mostrarEstado(dados) {
    const caixa = document.getElementById("automacao-estado");
    const titulo = document.getElementById("automacao-estado-titulo");
    const detalhe = document.getElementById("automacao-estado-detalhe");
    if (!caixa || !titulo || !detalhe) return;
    const ativo = dados.estado === "em_andamento";
    const estadoShell = document.getElementById("cockpit-automation-shell-status");
    const tituloShell = document.getElementById("cockpit-automation-shell-title");
    if (estadoShell && tituloShell) {
      estadoShell.dataset.state = ativo ? "occupied" : "idle";
      tituloShell.textContent = ativo ? "Chrome ocupado" : "Chrome livre";
      estadoShell.title = ativo ? `${ROTINAS[dados.rotina] || dados.rotina || "Rotina"} em andamento.` : "Chrome livre para uma nova rotina.";
    }
    const aoVivo = document.getElementById("cockpit-automation-live");
    if (aoVivo) aoVivo.hidden = !ativo || Boolean(estado.execucaoSelecionada);
    caixa.dataset.state = ativo ? (dados.cancelamento_pedido ? "cancelando" : "em_andamento") : "livre";
    const selo = caixa.querySelector(".ck-badge");
    const visual = ativo ? (dados.cancelamento_pedido ? "alerta" : "info") : "ok";
    if (selo) selo.dataset.status = visual;
    definirIcone(selo, ICONE_STATUS[visual], visual === "info");
    if (ativo) {
      const rotina = ROTINAS[dados.rotina] || dados.rotina || "Rotina";
      const inicio = formatarHoraCurta(dados.inicio);
      titulo.textContent = dados.cancelamento_pedido ? "Cancelando…" : "Ocupado";
      detalhe.textContent = `${rotina} em andamento${inicio ? ` desde ${inicio}` : ""}`;
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

  function classificarEventoAutomacao(mensagem) {
    const texto = mensagem.toLocaleLowerCase("pt-BR");
    const percentual = texto.match(/(?:^|\s)(\d{1,3}%)(?=\s|$)/)?.[1];
    if (/\b(falha|falhou|erro|error|exception|não conclu[ií]d[oa]|nao conclu[ií]d[oa])\b/.test(texto)) {
      return { estado: "error", icone: "✕", status: "Falha" };
    }
    if (/ação necessária|acao necessaria|aguardando|pendente|login necessário|login necessario/.test(texto)) {
      return { estado: "waiting", icone: "◌", status: "Aguardando" };
    }
    if (percentual || /exportando|importando|comparando|em andamento|processando|carregando/.test(texto)) {
      return { estado: "active", icone: "◌", status: percentual || "Em andamento" };
    }
    if (/conclu[ií]d[oa]|finalizad[oa]|válid[oa]|valid[oa]|confirmad[oa]|iniciad[oa]|\bok\b/.test(texto)) {
      return { estado: "success", icone: "✓", status: "OK" };
    }
    return { estado: "info", icone: "·", status: "Info" };
  }

  function criarEventoAutomacao(horario, origem, mensagem, classificacao) {
    const item = document.createElement("li");
    item.className = "ck-log__linha";
    item.dataset.state = classificacao.estado;
    const campos = [["ck-log__hora", horario], ["ck-log__origem", origem], ["ck-log__msg", mensagem]];
    campos.forEach(([classe, texto]) => {
      const campo = document.createElement("span");
      campo.className = classe;
      campo.textContent = texto;
      item.append(campo);
    });
    const nivel = document.createElement("span");
    nivel.className = "ck-nivel";
    nivel.dataset.status = {error: "erro", waiting: "alerta", active: "info", success: "ok"}[classificacao.estado] || "info";
    nivel.textContent = classificacao.status;
    item.append(nivel);
    return item;
  }

  function renderizarEventosAutomacao() {
    const lista = document.getElementById("cockpit-automation-events");
    const area = document.getElementById("automacao-log");
    if (!lista || !area) return;

    const aoVivo = document.getElementById("cockpit-automation-live");
    if (aoVivo) aoVivo.hidden = !estado.emAndamento || Boolean(estado.execucaoSelecionada);
    const linhas = area.textContent.split(/\r?\n/).filter(linha => linha.trim()).slice(-MAX_EVENTOS);
    const fragmento = document.createDocumentFragment();
    if (!linhas.length) {
      fragmento.append(criarEventoAutomacao("—", "", "Aguardando atividade do Chrome.", {estado: "waiting", status: "Aguardando"}));
    } else {
      linhas.forEach(linha => {
        const partes = linha.match(/^\s*(?:\[(\d{2}:\d{2}:\d{2})\]\s*)?(?:\[([^\]\r\n]+)\]\s*)?(.*)$/);
        const mensagem = partes?.[3] || linha;
        fragmento.append(criarEventoAutomacao(partes?.[1] || "—", partes?.[2] || "", mensagem, classificarEventoAutomacao(mensagem)));
      });
    }
    lista.replaceChildren(fragmento);
  }

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
    renderizarEventosAutomacao();
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
      renderizarEventosAutomacao();
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
    await Promise.all([selecionarLogAutomacao(id), carregarExecucoesLogAutomacao()]);
    document.getElementById("automacao-andamento-painel").scrollIntoView({block: "start"});
    document.getElementById("cockpit-automation-events").focus({preventScroll: true});
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
      host.replaceChildren(dom.createTextElement("p", "ck-lista__vazio", "Nenhuma execução encontrada para os filtros selecionados."));
      return;
    }
    const tabela = document.createElement("table");
    tabela.className = "ck-tabela ck-tabela--cards";
    const cabecalho = document.createElement("thead");
    const linhaCabecalho = document.createElement("tr");
    ["Rotina", "Início", "Duração", "Status"].forEach(texto => {
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
      const lotes = (execucao.lotes || []).map(lote => `${lote.id}${lote.status ? ` (${lote.status})` : ""}`).join(", ");
      if (lotes) rotina.title = `Lotes: ${lotes}`;
      const visual = STATUS_VISUAL[execucao.status] || "";
      const status = document.createElement("span");
      status.className = "ck-status";
      status.dataset.status = visual;
      status.append(criarIcone(ICONE_STATUS[visual], visual === "info"), STATUS[execucao.status] || execucao.status || "—");
      if (execucao.mensagem) status.title = execucao.mensagem;
      const statusBloco = document.createElement("span");
      statusBloco.className = "automation-history-status";
      statusBloco.appendChild(status);
      if (execucao.mensagem && execucao.status !== "concluido") {
        statusBloco.appendChild(dom.createTextElement("small", "automation-history-message", execucao.mensagem));
      }
      const capturas = document.createElement("span");
      capturas.className = "automation-history-captures";
      (execucao.capturas || []).forEach(captura => capturas.appendChild(criarCapturaHistorico(execucao, captura)));
      const verLog = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm", "Ver log");
      verLog.className = "ck-btn ck-btn--fantasma ck-btn--sm";
      verLog.type = "button";
      verLog.dataset.onClick = "abrirLogExecucaoAutomacao";
      verLog.dataset.args = JSON.stringify([execucao.id, execucao.inicio]);
      verLog.setAttribute("aria-label", `Ver log de ${ROTINAS[execucao.rotina] || execucao.rotina} em ${formatarHora(execucao.inicio)}`);
      statusBloco.append(verLog);
      if (capturas.childNodes.length) statusBloco.append(capturas);
      linha.dataset.status = (execucao.status || "").replace("_", "-");
      linha.append(
        celula("Rotina", rotina),
        celula("Início", rotuloInicio(execucao.inicio)),
        celula("Duração", execucao.status === "em_andamento" ? "—" : formatarDuracao(execucao.inicio, execucao.fim)),
        celula("Status", statusBloco),
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
      document.getElementById("automacao-historico-pagina").textContent = `${estado.pagina} de ${estado.paginas}`;
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
      if (host) host.replaceChildren(dom.createTextElement("p", "ck-lista__vazio", err.message));
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
    const rotinaAnterior = estado.rotinaAtiva;
    estado.emAndamento = dados.estado === "em_andamento";
    estado.rotinaAtiva = estado.emAndamento ? (dados.rotina || "") : "";
    mostrarEstado(dados);
    acrescentarLinhas(dados.log);
    atualizarBotoes();
    // A leitura dos chamados novos acabou: a lista da tela já pode mostrar o resultado.
    if (estavaAtivo && !estado.emAndamento && (rotinaAnterior === "sebrae" || rotinaAnterior === "dashboard")) app.carregarNovosSebrae?.();
    const ultimaId = dados.ultima?.id || "";
    if (ultimaId !== estado.ultimaExecucaoId || estavaAtivo !== estado.emAndamento) {
      estado.ultimaExecucaoId = ultimaId;
      carregarHistoricoAutomacao();
      carregarUltimasPorRotina();
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

  function acompanharRotinaAutomacao() {
    const eventos = document.getElementById("cockpit-automation-events");
    eventos?.scrollIntoView({ block: "nearest" });
    eventos?.focus({ preventScroll: true });
  }

  async function iniciarRotinaAutomacao(rotina) {
    if (!ROTINAS[rotina] || estado.ocupado) return;
    if (estado.emAndamento) {
      if (estado.rotinaAtiva === rotina) acompanharRotinaAutomacao();
      return;
    }
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
  };
});
