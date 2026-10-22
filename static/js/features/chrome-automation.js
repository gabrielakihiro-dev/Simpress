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
    sebrae: "Sincronizar chamados Sebrae",
  });
  const STATUS = Object.freeze({
    em_andamento: "Em andamento",
    concluido: "Concluído",
    falha: "Falha",
    cancelado: "Cancelado",
    ocupada: "Ocupada",
    interrompido: "Interrompido",
  });
  // Situação gravada pelo script em sebrae_chamados_estado.json; valores desconhecidos aparecem como vêm.
  const SITUACAO_SEBRAE = Object.freeze({
    concluido: "Concluída",
    parcial: "Concluída com pendências",
    falha: "Falha",
    cancelado: "Cancelada",
    interrompido: "Interrompida",
    login_necessario: "Login necessário",
    em_andamento: "Em andamento",
  });
  const MOTIVO_SEBRAE = Object.freeze({
    sem_indicios_de_tipo: "Sem indícios de incidente ou de solicitação.",
    indicios_conflitantes: "Indícios de incidente e de solicitação ao mesmo tempo.",
    sem_iniciador: "Chamado sem Iniciador.",
    sem_data_de_abertura: "Chamado sem data de abertura (Habilitada em).",
    data_de_abertura_invalida: "Data de abertura (Habilitada em) inválida.",
    sem_descricao_nem_titulo: "Chamado sem descrição nem título.",
    numero_invalido: "Número de chamado inválido.",
  });
  const SEBRAE_ATUALIZAR_MS = 60000;
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
    rotinaAtiva: "",
    // Cartão Sincronizar chamados Sebrae: último resumo da API (null até a primeira resposta).
    sebrae: { resumo: null, consulta: 0, consultadoEm: 0, ocupado: false, chavePendencias: null, ultimaId: null },
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
    // O cancelamento do cartão Sebrae só vale quando a rotina em andamento é a dele.
    const cancelarSebrae = document.getElementById("btn-sebrae-cancelar");
    if (cancelarSebrae) cancelarSebrae.disabled = !estado.emAndamento || estado.rotinaAtiva !== "sebrae" || estado.ocupado;
    const agendamento = document.getElementById("btn-sebrae-agendamento");
    if (agendamento) agendamento.disabled = estado.sebrae.ocupado;
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

  // ---------------------------------------------------------------- Sincronizar chamados Sebrae

  function formatarDiaHora(iso) {
    const data = iso ? new Date(iso) : null;
    if (!data || Number.isNaN(data.getTime())) return "";
    return data.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function contarChamados(total) {
    return `${total} ${total === 1 ? "chamado" : "chamados"}`;
  }

  function chaveDasPendencias(resumo) {
    const lista = Array.isArray(resumo?.pendencias) ? resumo.pendencias : [];
    return lista.map(item => `${item.numero}|${item.motivo}`).sort().join(";");
  }

  /**
   * Avisos da tela entre dois resumos consecutivos: só o que mudou (chamados incluídos por uma execução nova,
   * conjunto de pendências diferente, login que passou a ser necessário, falha diferente). Sem resumo anterior
   * (primeira consulta) ou sem mudança, devolve lista vazia. Espelha deve_avisar de domains/sebrae_chamados.py.
   */
  function avisosSincronizacaoSebrae(anterior, atual) {
    if (!anterior || !atual) return [];
    const avisos = [];
    const antes = anterior.ultima_execucao || null;
    const agora = atual.ultima_execucao || null;
    const execucaoNova = Boolean(agora) && (!antes || agora.inicio !== antes.inicio || agora.fim !== antes.fim);
    const incluidos = Number(agora?.incluidos) || 0;
    if (execucaoNova && incluidos > 0) {
      avisos.push({ tipo: "success", mensagem: `Sebrae: ${contarChamados(incluidos)} ${incluidos === 1 ? "incluído" : "incluídos"} no Dashboard.` });
    }
    const pendencias = Array.isArray(atual.pendencias) ? atual.pendencias.length : 0;
    if (pendencias && chaveDasPendencias(anterior) !== chaveDasPendencias(atual)) {
      avisos.push({ tipo: "warning", mensagem: `Sebrae: ${pendencias === 1 ? "1 pendência" : `${pendencias} pendências`} para conferir.` });
    }
    if (atual.login_necessario && !anterior.login_necessario) {
      avisos.push({ tipo: "warning", mensagem: "Sebrae: login necessário no Chrome de automação." });
    }
    if (execucaoNova && agora.situacao === "falha"
        && (antes?.situacao !== "falha" || JSON.stringify(antes?.detalhes ?? null) !== JSON.stringify(agora.detalhes ?? null))) {
      avisos.push({ tipo: "error", mensagem: "Sebrae: a última sincronização falhou. Veja o motivo em Últimas execuções." });
    }
    return avisos;
  }

  function definirTexto(id, texto) {
    const elemento = document.getElementById(id);
    if (elemento && elemento.textContent !== texto) elemento.textContent = texto;
  }

  function descreverSituacaoSebrae(resumo) {
    const agendamento = resumo.agendamento || {};
    if (estado.emAndamento && estado.rotinaAtiva === "sebrae") {
      return { estado: "em_andamento", titulo: "Sincronizando", detalhe: "A sincronização está em andamento; acompanhe em Andamento." };
    }
    if (estado.emAndamento) {
      return {
        estado: "aguardando", titulo: "Aguardando",
        detalhe: `${ROTINAS[estado.rotinaAtiva] || "Outra rotina"} em andamento; a sincronização não roda ao mesmo tempo.`,
      };
    }
    if (agendamento.ativo) {
      const proxima = formatarDiaHora(agendamento.proxima_execucao);
      return { estado: "livre", titulo: "Agendamento ativo", detalhe: proxima ? `Próxima execução: ${proxima}.` : "Aguardando o próximo horário." };
    }
    return {
      estado: "pausado", titulo: "Agendamento pausado",
      detalhe: "Nenhuma execução automática programada.",
    };
  }

  function descreverUltimaExecucaoSebrae(ultima) {
    if (!ultima) return "Nenhuma execução registrada.";
    const quando = formatarHora(ultima.fim || ultima.inicio);
    const situacao = SITUACAO_SEBRAE[ultima.situacao] || ultima.situacao || "Sem situação";
    const detalhe = typeof ultima.detalhes === "string" && ultima.detalhes.trim() ? ` — ${ultima.detalhes.trim()}` : "";
    return `${situacao}${quando ? ` em ${quando}` : ""}${detalhe}`;
  }

  function renderizarPendenciasSebrae(pendencias) {
    const host = document.getElementById("sebrae-pendencias");
    if (!host) return;
    if (!pendencias.length) {
      host.replaceChildren(dom.createTextElement("p", "ux-home-note", "Nenhuma pendência."));
      return;
    }
    const tabela = document.createElement("table");
    tabela.className = "automation-history-table sebrae-pendencias-tabela";
    tabela.setAttribute("aria-labelledby", "sebrae-pendencias-titulo");
    const cabecalho = document.createElement("thead");
    const linhaCabecalho = document.createElement("tr");
    ["Chamado", "Motivo"].forEach(texto => {
      const th = dom.createTextElement("th", "", texto);
      th.scope = "col";
      linhaCabecalho.appendChild(th);
    });
    cabecalho.appendChild(linhaCabecalho);
    const corpo = document.createElement("tbody");
    pendencias.forEach(item => {
      const linha = document.createElement("tr");
      const numero = dom.createTextElement("span", "sebrae-pendencia-numero", item.numero);
      linha.append(celula("Chamado", numero), celula("Motivo", MOTIVO_SEBRAE[item.motivo] || item.motivo));
      corpo.appendChild(linha);
    });
    tabela.append(cabecalho, corpo);
    host.replaceChildren(tabela);
  }

  function renderizarSebrae() {
    const resumo = estado.sebrae.resumo;
    if (!resumo) return;
    const agendamento = resumo.agendamento || {};
    const ultima = resumo.ultima_execucao || null;
    const pendencias = Array.isArray(resumo.pendencias) ? resumo.pendencias : [];

    const situacao = descreverSituacaoSebrae(resumo);
    const caixa = document.getElementById("sebrae-estado");
    if (caixa && caixa.dataset.state !== situacao.estado) caixa.dataset.state = situacao.estado;
    definirTexto("sebrae-estado-titulo", situacao.titulo);
    definirTexto("sebrae-estado-detalhe", situacao.detalhe);

    definirTexto("sebrae-agendamento", agendamento.ativo ? "Ativo" : "Pausado");
    definirTexto("sebrae-ultima", descreverUltimaExecucaoSebrae(ultima));
    definirTexto("sebrae-proxima", agendamento.ativo ? (formatarDiaHora(agendamento.proxima_execucao) || "—") : "—");
    definirTexto("sebrae-incluidos", ultima ? String(Number(ultima.incluidos) || 0) : "—");
    definirTexto("sebrae-ignorados", ultima ? String(Number(ultima.ignorados) || 0) : "—");
    definirTexto("sebrae-pendentes", ultima ? String(Number(ultima.pendentes ?? pendencias.length) || 0) : String(pendencias.length || "—"));

    const login = document.getElementById("sebrae-login-aviso");
    if (login && login.hidden === Boolean(resumo.login_necessario)) login.hidden = !resumo.login_necessario;

    const botao = document.getElementById("btn-sebrae-agendamento");
    if (botao) {
      const rotulo = agendamento.ativo ? "Pausar agendamento" : "Ativar agendamento";
      const texto = botao.querySelector("span");
      if (texto && texto.textContent !== rotulo) texto.textContent = rotulo;
    }

    const avisos = [];
    if (agendamento.pronta === false) {
      avisos.push("O agendamento ainda não pode ser ativado: ele só é liberado depois da execução controlada (leitura do SoftExpert e gravação no Dashboard conferidas). Até lá, use Executar agora.");
    }
    const disparo = agendamento.ultimo_disparo;
    if (agendamento.ativo && disparo && disparo.resultado && disparo.resultado !== "iniciada") {
      avisos.push(`Último horário agendado (${formatarHora(disparo.horario)}): ${disparo.resultado}.`);
    }
    const aviso = document.getElementById("sebrae-agendamento-aviso");
    if (aviso) {
      definirTexto("sebrae-agendamento-aviso", avisos.join(" "));
      aviso.hidden = !avisos.length;
    }

    const chave = chaveDasPendencias(resumo);
    if (chave !== estado.sebrae.chavePendencias) {
      estado.sebrae.chavePendencias = chave;
      renderizarPendenciasSebrae(pendencias);
    }
    atualizarBotoes();
  }

  function aplicarResumoSebrae(resumo) {
    const anterior = estado.sebrae.resumo;
    estado.sebrae.resumo = resumo;
    estado.sebrae.consultadoEm = Date.now();
    renderizarSebrae();
    avisosSincronizacaoSebrae(anterior, resumo).forEach(aviso => app.showToast(aviso.mensagem, aviso.tipo));
  }

  async function carregarResumoSebrae() {
    const consulta = ++estado.sebrae.consulta;
    estado.sebrae.consultadoEm = Date.now();
    try {
      const resumo = await consultarAutomacao("/api/automacao/sebrae/resumo", {
        errorMessage: "Não foi possível consultar a sincronização dos chamados Sebrae.",
      });
      if (consulta !== estado.sebrae.consulta) return;
      aplicarResumoSebrae(resumo);
    } catch (err) {
      if (consulta !== estado.sebrae.consulta) return;
      console.error("Erro ao consultar a sincronização Sebrae:", err);
      if (err?.servidorDesatualizado) avisarErro(err);
      definirTexto("sebrae-estado-detalhe", err.message);
    }
  }

  async function alternarAgendamentoSebrae() {
    if (estado.sebrae.ocupado) return;
    const ativar = !estado.sebrae.resumo?.agendamento?.ativo;
    estado.sebrae.ocupado = true;
    atualizarBotoes();
    const botao = document.getElementById("btn-sebrae-agendamento");
    botao?.setAttribute("aria-busy", "true");
    try {
      const resumo = await consultarAutomacao("/api/automacao/sebrae/agendamento", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: ativar }),
        errorMessage: ativar ? "Não foi possível ativar o agendamento." : "Não foi possível pausar o agendamento.",
      });
      ++estado.sebrae.consulta;
      aplicarResumoSebrae(resumo);
      app.showToast(resumo.agendamento?.ativo ? "Agendamento ativado: de segunda a sexta, a cada 30 minutos." : "Agendamento pausado.", "success");
    } catch (err) {
      console.error("Erro ao alterar o agendamento Sebrae:", err);
      // 409: a rotina ainda não está completa (ROTINA_PRONTA); é um aviso esperado, não uma falha.
      if (err?.status === 409) app.showToast(err.message, "warning");
      else avisarErro(err);
      carregarResumoSebrae();
    } finally {
      estado.sebrae.ocupado = false;
      botao?.removeAttribute("aria-busy");
      atualizarBotoes();
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
    estado.rotinaAtiva = estado.emAndamento ? (dados.rotina || "") : "";
    mostrarEstado(dados);
    acrescentarLinhas(dados.log);
    atualizarBotoes();
    const ultimaId = dados.ultima?.id || "";
    if (ultimaId !== estado.ultimaExecucaoId || estavaAtivo !== estado.emAndamento) {
      estado.ultimaExecucaoId = ultimaId;
      carregarHistoricoAutomacao();
    }
    const sebrae = estado.sebrae;
    if (!sebrae.resumo || ultimaId !== sebrae.ultimaId || estavaAtivo !== estado.emAndamento
        || Date.now() - sebrae.consultadoEm > SEBRAE_ATUALIZAR_MS) {
      sebrae.ultimaId = ultimaId;
      carregarResumoSebrae();
    } else {
      renderizarSebrae();
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
    alternarAgendamentoSebrae, avisosSincronizacaoSebrae, carregarResumoSebrae,
    atualizarEstadoAutomacao,
    carregarHistoricoAutomacao,
    filtrarHistoricoAutomacao, limparFiltrosAutomacao, mudarPaginaHistoricoAutomacao,
    carregarExecucoesLogAutomacao, mudarPaginaLogAutomacao, selecionarLogAutomacao,
    abrirLogExecucaoAutomacao, voltarAoVivoAutomacao, alterarLimiteLogAutomacao,
    recolherPainelAutomacao, ampliarPainelAutomacao,
  };
});
