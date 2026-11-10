/** Equipment lookup, serial autocomplete, recent searches, and the selected equipment card. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).equipmentSearch = factory;
})(typeof window !== "undefined" ? window : globalThis, function createEquipmentSearch(context) {
  "use strict";
  const { app, appState, motion, transferUtils, recentEquipment } = context;
  const { createTextElement } = context.dom;
  const renderers = context.equipmentSearchRenderer(context);
  const recentStore = recentEquipment?.createStore(() => window.localStorage) || null;

  let debounceTimer = null;
  const autocompleteRequestGate = transferUtils.createRequestGate();
  const equipmentLookupRequestGate = transferUtils.createRequestGate();
  const homeListRequestGate = transferUtils.createRequestGate();
  const endpointRequestGate = transferUtils.createRequestGate();
  const searchButtonInitialHtml = document.getElementById("btn-buscar-serial")?.innerHTML || "";
  const HOME_LIST_PAGE_SIZE = 50;
  const HOME_COMPARISON_FILTERS = Object.freeze({
    "7-dias": ["sem_acesso_7_dias"],
    divergentes: ["ausentes_no_endpoint", "divergencias_local", "correspondencias_ambiguas", "registros_ambiguos"],
  });
  let homeListFilter = "todos";
  let homeListOffset = 0;
  let homeListHasMore = false;
  let homeListTotal = 0;
  let homeListQuery = "";
  let homeListActiveSerial = "";
  let homeListSerials = new Map();
  // Items of the rendered list by serial, so the actions bar (which only knows the serial) can tell "Sem usuário" apart.
  let homeListItems = new Map();
  // Divergence keys in the order the Resumo lists them; registros_ambiguos rows sit under correspondencias_ambiguas.
  const HOME_DIVERGENCE_CATEGORIES = Object.freeze([
    ["divergencias_local", "divergencias_local"],
    ["ausentes_no_endpoint", "ausentes_no_endpoint"],
    ["correspondencias_ambiguas", "correspondencias_ambiguas"],
    ["registros_ambiguos", "correspondencias_ambiguas"],
  ]);
  const HOME_NOTEBOOK_CATEGORIES = Object.freeze(["notebook", "macbook"]);
  let homeComparisonFilters = { "7-dias": null, divergentes: null };
  let homeCountsLoaded = false;
  let finishEquipmentLoading = () => {};
  let finishHomeListLoading = () => {};

  function definirEquipamentoAtual(equipment) {
    endpointRequestGate.invalidate();
    app.fecharChamadoUX?.();
    appState.currentEquipamento = equipment;
    appState.equipamentoSelectionRevision += 1;
    app.atualizarResumoSerieTransferencia(equipment);
    const copySerialButton = document.getElementById("btn-copiar-serie");
    const hasSerial = Boolean(String(equipment?.serial || "").trim());
    const endpointButton = document.getElementById("btn-consultar-endpoint");
    if (endpointButton) {
      endpointButton.disabled = !hasSerial;
      endpointButton.removeAttribute("aria-busy");
    }
    const remoteButton = document.getElementById("btn-controle-remoto-endpoint");
    if (remoteButton) {
      remoteButton.disabled = !hasSerial;
      remoteButton.removeAttribute("aria-busy");
    }
    const endpointResult = document.getElementById("endpoint-lookup-result");
    if (endpointResult) endpointResult.textContent = "";
    if (copySerialButton) {
      copySerialButton.disabled = !hasSerial;
      copySerialButton.setAttribute("aria-disabled", String(!hasSerial));
    }
  }

  async function consultarEndpoint() {
    const serial = String(appState.currentEquipamento?.serial || "").trim();
    const button = document.getElementById("btn-consultar-endpoint");
    const result = document.getElementById("endpoint-lookup-result");
    if (!serial || button?.disabled) return;
    const revision = appState.equipamentoSelectionRevision;
    const request = endpointRequestGate.begin();
    const current = () => endpointRequestGate.isCurrent(request.id)
      && appState.equipamentoSelectionRevision === revision;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Consultando no Endpoint… Se o Endpoint pedir login, entre na janela do Chrome de automação.";
    try {
      const data = await app.apiFetch("/api/endpoint/consultar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial }), signal: request.signal,
        errorMessage: "Não foi possível consultar o Endpoint.",
      });
      if (!current()) return;
      if (data.status === "found") {
        result.textContent = data.ultimo_logon
          ? `Usuário do último logon: ${data.ultimo_logon}`
          : "Equipamento encontrado no Endpoint, sem usuário do último logon informado.";
      } else if (data.status === "not_found") {
        result.textContent = "Equipamento não encontrado no Endpoint";
      } else if (data.status === "ambiguous") {
        if (data.origem === "base_local") {
          result.textContent = "A série alternativa do MacBook é ambígua na base local. Nenhum usuário foi associado.";
        } else if (data.origem === "correspondencia_mac") {
          result.textContent = "Não foi possível confirmar a correspondência única do MacBook no Endpoint. Nenhum usuário foi associado.";
        } else {
          result.textContent = "Mais de um equipamento encontrado no Endpoint para esta série. Confira as duplicidades.";
        }
      } else {
        throw new Error("Não foi possível confirmar o resultado do Endpoint.");
      }
    } catch (error) {
      if (current() && error.name !== "AbortError") result.textContent = error.message || "Não foi possível consultar o Endpoint.";
    } finally {
      if (current()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  async function controleRemotoEndpoint() {
    const serial = String(appState.currentEquipamento?.serial || "").trim();
    const button = document.getElementById("btn-controle-remoto-endpoint");
    const result = document.getElementById("endpoint-lookup-result");
    if (!serial || button?.disabled) return;
    const revision = appState.equipamentoSelectionRevision;
    const request = endpointRequestGate.begin();
    const current = () => endpointRequestGate.isCurrent(request.id)
      && appState.equipamentoSelectionRevision === revision;
    // Identifica o pedido: se a seleção mudar enquanto o servidor espera o login, o servidor não conecta.
    const pedido = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let finalizado = false;
    request.signal.addEventListener("abort", () => {
      if (!finalizado) app.apiFetch("/api/endpoint/controle-remoto/cancelar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pedido }), errorMessage: "",
      }).catch(() => {});
    });
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Abrindo o controle remoto no Endpoint… Se o Endpoint pedir login, entre na janela do Chrome de automação.";
    try {
      const data = await app.apiFetch("/api/endpoint/controle-remoto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, pedido }), signal: request.signal,
        errorMessage: "Não foi possível abrir o controle remoto.",
      });
      if (!current()) return;
      if (data.status === "connected") {
        result.textContent = `Controle remoto solicitado${data.hostname ? ` para ${data.hostname}` : ""}. Continue a conexão no Chrome de automação.`;
      } else if (data.status === "offline") {
        result.textContent = "O computador está offline no Endpoint.";
        await app.confirmarAcao({
          titulo: "Computador offline",
          mensagem: `O computador${data.hostname ? ` ${data.hostname}` : ""} está offline. O controle remoto não está disponível.`,
          confirmar: "OK", cancelar: "Fechar", destrutiva: false,
        });
      } else if (data.status === "not_found") {
        result.textContent = "Equipamento não encontrado no Endpoint";
      } else if (data.status === "ambiguous") {
        result.textContent = "Não foi possível identificar um único equipamento no Endpoint para esta série. O controle remoto não foi aberto.";
      } else {
        throw new Error("Não foi possível confirmar o resultado do Endpoint.");
      }
    } catch (error) {
      if (current() && error.name !== "AbortError") result.textContent = error.message || "Não foi possível abrir o controle remoto.";
    } finally {
      finalizado = true;
      if (current()) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  const powershellRequestGate = transferUtils.createRequestGate();
  const POWERSHELL_HOST_PADRAO = "PRNOTEUMU005";
  const POWERSHELL_AVISO_NAO_EXECUTADO = "O comando foi inserido no prompt, mas NÃO foi executado. Revise e aperte Enter no terminal do Chrome.";

  // Códigos prontos: lista guardada no servidor local (comando fixo + modo). Só carrega na primeira abertura do card.
  const POWERSHELL_CODIGOS_URL = "/api/endpoint/powershell/codigos";
  // Impressora de rede (Add-Printer -ConnectionName, aceito abreviado até -Con) só é instalada no perfil do usuário logado.
  const POWERSHELL_IMPRESSORA_REDE = /^\s*Add-Printer\b.*\s-Con/i;
  const POWERSHELL_AVISO_IMPRESSORA_SYSTEM = "Adicionar impressora de rede só funciona no modo Usuário logado.";
  let codigosPowerShell = null; // null = ainda não carregada; por isso o editor nunca abre (e não sobrescreve a lista) após falha de carga
  let cargaCodigosPowerShell = null;
  let linhasCodigosPowerShell = [];

  function codigosDaResposta(data) {
    if (!Array.isArray(data?.codigos)) throw new Error("Não foi possível ler a lista de códigos.");
    return data.codigos;
  }

  // Dado armazenado: só textContent/value, nunca innerHTML.
  function popularSelectCodigosPowerShell() {
    const select = document.getElementById("select-powershell-codigo");
    const vazio = document.createElement("option");
    vazio.value = "";
    vazio.textContent = "Escolher código…";
    const grupos = [["usuario", "Usuário logado"], ["sistema", "SYSTEM"]].map(([modo, rotulo]) => {
      const itens = codigosPowerShell.filter(item => item.modo === modo);
      if (!itens.length) return null;
      const grupo = document.createElement("optgroup");
      grupo.label = rotulo;
      itens.forEach(item => {
        const opcao = document.createElement("option");
        opcao.value = item.id;
        opcao.textContent = item.titulo;
        grupo.appendChild(opcao);
      });
      return grupo;
    }).filter(Boolean);
    select.replaceChildren(vazio, ...grupos);
  }

  function definirCodigosPowerShell(lista) {
    codigosPowerShell = lista;
    popularSelectCodigosPowerShell();
  }

  // Resolve true quando a lista veio do servidor; `recarregar` ignora a lista já em memória.
  async function carregarCodigosPowerShell(recarregar = false) {
    if (codigosPowerShell && !recarregar && !cargaCodigosPowerShell) return true;
    const select = document.getElementById("select-powershell-codigo");
    if (!cargaCodigosPowerShell) {
      select.setAttribute("aria-busy", "true");
      cargaCodigosPowerShell = app.apiFetch(POWERSHELL_CODIGOS_URL, { errorMessage: "Não foi possível carregar os códigos prontos." })
        .then(data => { definirCodigosPowerShell(codigosDaResposta(data)); return true; })
        .catch(error => { document.getElementById("endpoint-powershell-result").textContent = error.message || "Não foi possível carregar os códigos prontos."; return false; })
        .finally(() => { cargaCodigosPowerShell = null; select.removeAttribute("aria-busy"); });
    }
    return cargaCodigosPowerShell;
  }

  // O toggle do <details> não borbulha; o dispatcher o captura no próprio elemento (data-on-toggle).
  function aoAbrirPowerShellEndpoint() {
    if (document.getElementById("endpoint-powershell").open) void carregarCodigosPowerShell();
  }

  function aplicarCodigoProntoPowerShell() {
    const item = (codigosPowerShell || []).find(codigo => codigo.id === document.getElementById("select-powershell-codigo").value);
    if (!item) return;
    document.getElementById("input-powershell-comando").value = item.comando;
    document.getElementById("select-powershell-modo").value = item.modo === "sistema" ? "sistema" : "usuario";
    document.getElementById("endpoint-powershell-result").textContent = "";
  }

  function criarLinhaCodigoPowerShell(item = {}) {
    const campo = (rotulo, controle, nome, classe) => {
      controle.dataset.powershellCodigoCampo = nome;
      const label = document.createElement("label");
      label.className = `ck-campo ${classe}`;
      label.append(app.createTextElement("span", "ck-campo__rotulo", rotulo), controle);
      return label;
    };
    const titulo = document.createElement("input");
    titulo.type = "text";
    titulo.className = "ck-entrada";
    titulo.maxLength = 80;
    titulo.value = item.titulo || "";
    const modo = document.createElement("select");
    modo.className = "ck-entrada";
    [["usuario", "Usuário logado"], ["sistema", "SYSTEM"]].forEach(([valor, rotulo]) => {
      const opcao = document.createElement("option");
      opcao.value = valor;
      opcao.textContent = rotulo;
      modo.appendChild(opcao);
    });
    modo.value = item.modo === "sistema" ? "sistema" : "usuario";
    const comando = document.createElement("textarea");
    comando.className = "ck-entrada";
    comando.rows = 2;
    comando.maxLength = 2000;
    comando.spellcheck = false;
    comando.value = item.comando || "";
    const remover = app.createTextElement("button", "ck-btn ck-btn--perigo", "Remover");
    remover.type = "button";
    remover.dataset.powershellCodigoCampo = "remover";
    const el = document.createElement("div");
    el.className = "ck-ps-codigos__item";
    el.setAttribute("role", "group");
    el.append(
      campo("Título", titulo, "titulo", "ck-ps-codigos__titulo"),
      campo("Modo", modo, "modo", "ck-ps-codigos__modo"),
      campo("Comando (uma linha)", comando, "comando", "ck-ps-codigos__comando"),
      remover,
    );
    const linha = { id: item.id, titulo, modo, comando, el };
    remover.addEventListener("click", () => {
      linhasCodigosPowerShell = linhasCodigosPowerShell.filter(outra => outra !== linha);
      renderizarLinhasCodigosPowerShell();
    });
    return linha;
  }

  function renderizarLinhasCodigosPowerShell() {
    linhasCodigosPowerShell.forEach((linha, indice) => linha.el.setAttribute("aria-label", `Código ${indice + 1}`));
    document.getElementById("powershell-codigos-lista").replaceChildren(...linhasCodigosPowerShell.map(linha => linha.el));
  }

  function fecharEditorCodigosPowerShell() {
    document.getElementById("powershell-codigos-editor").classList.add("hidden");
    document.getElementById("btn-powershell-codigos-gerenciar").setAttribute("aria-expanded", "false");
    document.getElementById("powershell-codigos-status").textContent = "";
    linhasCodigosPowerShell = [];
    renderizarLinhasCodigosPowerShell();
  }

  // Abre (relendo a lista salva, que outra aba pode ter mudado) ou fecha descartando as edições; serve ao botão Gerenciar códigos e ao Cancelar.
  async function alternarEditorCodigosPowerShell() {
    const painel = document.getElementById("powershell-codigos-editor");
    if (!painel.classList.contains("hidden")) return fecharEditorCodigosPowerShell();
    if (!(await carregarCodigosPowerShell(true))) return; // a falha já foi mostrada em #endpoint-powershell-result
    linhasCodigosPowerShell = codigosPowerShell.map(criarLinhaCodigoPowerShell);
    renderizarLinhasCodigosPowerShell();
    painel.classList.remove("hidden");
    document.getElementById("btn-powershell-codigos-gerenciar").setAttribute("aria-expanded", "true");
    linhasCodigosPowerShell[0]?.titulo.focus();
  }

  function adicionarCodigoPowerShell() {
    const linha = criarLinhaCodigoPowerShell();
    linhasCodigosPowerShell.push(linha);
    renderizarLinhasCodigosPowerShell();
    linha.titulo.focus();
  }

  async function salvarCodigosPowerShell() {
    const botao = document.getElementById("btn-powershell-codigos-salvar");
    const status = document.getElementById("powershell-codigos-status");
    if (botao.disabled) return;
    const codigos = linhasCodigosPowerShell.map(linha => {
      const item = { titulo: linha.titulo.value.trim(), modo: linha.modo.value, comando: linha.comando.value };
      if (linha.id) item.id = linha.id;
      return item;
    });
    const erro = codigos.some(item => !item.titulo) ? "Informe o título de cada código."
      : codigos.some(item => /[\r\n]/.test(item.comando)) ? "O comando não pode ter quebra de linha."
      : codigos.some(item => !item.comando.trim()) ? "Informe o comando de cada código."
      : codigos.some(item => item.modo === "sistema" && POWERSHELL_IMPRESSORA_REDE.test(item.comando)) ? `${POWERSHELL_AVISO_IMPRESSORA_SYSTEM} Ajuste o modo do código.` : "";
    if (erro) {
      status.textContent = erro;
      return;
    }
    // Trava antes da confirmação: um segundo clique não abre outra confirmação nem manda outro PUT.
    botao.disabled = true;
    try {
      const removidos = codigosPowerShell.filter(item => !linhasCodigosPowerShell.some(linha => linha.id === item.id)).length;
      const confirmado = await app.confirmarAcao({
        titulo: "Salvar lista de códigos",
        mensagem: `A lista de códigos prontos será substituída por ${codigos.length} ${app.pluralize(codigos.length, "código", "códigos")}.${removidos ? ` ${removidos} ${app.pluralize(removidos, "código será removido", "códigos serão removidos")} da lista.` : ""}`,
        confirmar: "Salvar lista", cancelar: "Cancelar", destrutiva: false,
      });
      if (!confirmado) return;
      botao.setAttribute("aria-busy", "true");
      status.textContent = "Salvando…";
      const data = await app.apiFetch(POWERSHELL_CODIGOS_URL, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigos }), errorMessage: "Não foi possível salvar a lista de códigos.",
      });
      definirCodigosPowerShell(codigosDaResposta(data));
      fecharEditorCodigosPowerShell();
      document.getElementById("endpoint-powershell-result").textContent = "Lista de códigos salva.";
    } catch (error) {
      status.textContent = error.message || "Não foi possível salvar a lista de códigos.";
    } finally {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
    }
  }

  function mensagemPowerShellEndpoint(data, hostname) {
    const host = data.hostname || hostname;
    const usuarios = Array.isArray(data.usuarios) ? data.usuarios.join(", ") : "";
    if (data.status === "inserido") {
      const offline = data.hostname_padrao_offline ? ` O computador padrão ${POWERSHELL_HOST_PADRAO} estava offline; foi usado ${host}.` : "";
      return `${POWERSHELL_AVISO_NAO_EXECUTADO} Computador: ${host}; conectado como ${data.usuario || data.modo}.${offline}`;
    }
    if (data.status === "not_found") return `Computador ${host} não encontrado no Endpoint. Nada foi inserido.`;
    if (data.status === "sem_host_online") return `O computador padrão ${host} está offline e nenhum outro computador online foi encontrado. Nada foi inserido.`;
    if (data.status === "sem_usuario") return `Usuário não encontrado em ${host}.${usuarios ? ` Usuários disponíveis: ${usuarios}.` : " Nenhum usuário logado disponível."} Nada foi inserido.`;
    if (data.status === "usuario_ambiguo") return `Há mais de um usuário logado em ${host}: ${usuarios}. Nada foi inserido.`;
    if (data.status === "erro_terminal") return data.mensagem || `Não foi possível abrir o PowerShell em ${host}. Nada foi inserido.`;
    throw new Error("Não foi possível confirmar o resultado do Endpoint.");
  }

  async function abrirPowerShellEndpoint() {
    const button = document.getElementById("btn-powershell-endpoint");
    const result = document.getElementById("endpoint-powershell-result");
    if (button.disabled) return;
    const comando = document.getElementById("input-powershell-comando").value;
    if (/[\r\n]/.test(comando)) {
      result.textContent = "O comando não pode ter quebra de linha.";
      return;
    }
    if (!comando.trim()) {
      result.textContent = "Informe o comando.";
      return;
    }
    const modo = document.getElementById("select-powershell-modo").value === "usuario" ? "usuario" : "sistema";
    if (modo === "sistema" && POWERSHELL_IMPRESSORA_REDE.test(comando)) {
      result.textContent = `${POWERSHELL_AVISO_IMPRESSORA_SYSTEM} Troque o modo e tente de novo.`;
      return;
    }
    const hostname = document.getElementById("input-powershell-hostname").value.trim();
    const payload = { modo, comando };
    if (hostname) payload.hostname = hostname;
    const confirmado = await app.confirmarAcao({
      titulo: "Inserir comando no PowerShell",
      mensagem: `Vai abrir o PowerShell do Endpoint em ${hostname || `${POWERSHELL_HOST_PADRAO} (padrão)`}, modo ${modo === "usuario" ? "usuário logado" : "SYSTEM"}, e inserir este comando no prompt:\n\n${comando}\n\nO comando será apenas inserido; NÃO será executado. O Enter é seu, no terminal do Chrome.`,
      confirmar: "Inserir no PowerShell", cancelar: "Cancelar", destrutiva: false,
    });
    if (!confirmado) return;
    const request = powershellRequestGate.begin();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    result.textContent = "Abrindo o PowerShell no Endpoint…";
    try {
      const data = await app.apiFetch("/api/endpoint/powershell", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: request.signal,
        errorMessage: "Não foi possível abrir o PowerShell.",
      });
      result.textContent = mensagemPowerShellEndpoint(data, hostname || POWERSHELL_HOST_PADRAO);
    } catch (error) {
      if (error.name !== "AbortError") result.textContent = error.message || "Não foi possível abrir o PowerShell.";
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function limparSelecaoEquipamento() {
    app.definirEquipamentoAtual(null);
    highlightHomeListItem(null);
    appState.retiradaCidadeSelecionada = "";
    document.getElementById("card-equipamento")?.classList.add("hidden");
    document.getElementById("home-detail-empty")?.classList.remove("hidden");
    document.getElementById("retirada-cnpj").value = "";
    document.getElementById("retirada-endereco").value = "";
    document.getElementById("retirada-obs").value = "";
    ["textarea-resumo-preview", "textarea-texto-transporte"].forEach(id => {
      const field = document.getElementById(id);
      if (field) field.value = "";
    });
    app.preencherRepresentanteRegional("retirada", "");
    const indicator = document.getElementById("status-indicator");
    if (indicator) indicator.dataset.state = "ready";
    const summary = document.getElementById("status-summary");
    if (summary) summary.replaceChildren(
      createTextElement("span", "ck-acoes-pronto", "Pronto para emissão.")
    );
    summary?.firstElementChild?.setAttribute("data-ux-ready-status", "");
  }

  function invalidarBuscasEquipamento() {
    finishEquipmentLoading();
    clearTimeout(debounceTimer);
    autocompleteRequestGate.invalidate();
    equipmentLookupRequestGate.invalidate();
    const autocomplete = document.getElementById("autocomplete-box");
    autocomplete?.setAttribute("aria-busy", "false");
    document.getElementById("input-serial")?.removeAttribute("aria-busy");
    const button = document.getElementById("btn-buscar-serial");
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.innerHTML = searchButtonInitialHtml;
      lucide.createIcons({ root: button });
    }
  }

  function invalidarDadosEquipamentoAposRestauracao() {
    app.invalidarSemUsuarioResumo?.();
    const serialInput = document.getElementById("input-serial");
    if (serialInput) serialInput.value = "";
    document.getElementById("btn-clear-serial")?.classList.add("hidden");
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
  }

  async function atualizarSelecaoAposSubstituirInventarios(serialSelecionada) {
    app.invalidarSemUsuarioResumo?.();
    app.fecharAutocomplete();
    return transferUtils.refreshSelectionAfterInventoryReplacement({
      requestGate: equipmentLookupRequestGate,
      serial: serialSelecionada,
      invalidateSearches: app.invalidarBuscasEquipamento,
      clearSelection: clearSerial => {
        app.limparSelecaoEquipamento();
        if (!serialSelecionada || clearSerial) {
          const serialInput = document.getElementById("input-serial");
          if (serialInput) serialInput.value = "";
          document.getElementById("btn-clear-serial")?.classList.add("hidden");
        }
      },
      fetchEquipment: (serial, options) => fetch(
        `/api/equipamento/${encodeURIComponent(serial)}`,
        options,
      ),
      applyEquipment: equipment => {
        app.definirEquipamentoAtual(equipment);
        app.exibirEquipamento(equipment);
      },
    });
  }

  const inputSerialInicial = document.getElementById("input-serial");

  if (inputSerialInicial && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    inputSerialInicial.focus({ preventScroll: true });
  }

  // Autocomplete & Debounce for Serial Input
  let autocompleteItemsList = [];

  let highlightedAutocompleteIndex = -1;

  function handleSerialInput(val) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    app.fecharAutocomplete();
    const clearBtn = document.getElementById("btn-clear-serial");
    if (val && val.length > 0) {
      clearBtn?.classList.remove("hidden");
    } else {
      clearBtn?.classList.add("hidden");
    }

    clearTimeout(debounceTimer);
    const term = val.trim();
    if (term.length < 2) {
      app.fecharAutocomplete();
      void carregarListaHome({ query: term, reset: true });
      return;
    }

    void carregarListaHome({ query: term, reset: true });
    document.getElementById("autocomplete-box").setAttribute("aria-busy", "true");
    debounceTimer = setTimeout(async () => {
      const request = autocompleteRequestGate.begin();
      try {
        const res = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(term)}&limit=15`, { signal: request.signal });
        if (!autocompleteRequestGate.isCurrent(request.id)) return;
        if (res.ok) {
          const results = await res.json();
          if (transferUtils.isCurrentQuery(
            autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
          )) {
            renderAutocomplete(results.items, results.total, results.has_more, results.sugestao);
          }
        } else if (autocompleteRequestGate.isCurrent(request.id)) {
          app.showToast("Não foi possível consultar os equipamentos. Tente novamente.", "error");
        }
      } catch (err) {
        if (err.name !== "AbortError" && autocompleteRequestGate.isCurrent(request.id)) {
          console.warn("Erro no autocomplete:", err);
          app.showToast("Falha de conexão ao consultar os equipamentos.", "error");
        }
      } finally {
        if (transferUtils.isCurrentQuery(
          autocompleteRequestGate, request.id, document.getElementById("input-serial").value, term
        )) {
          document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
        }
      }
    }, 200);
  }

  function handleSerialKeydown(e) {
    const box = document.getElementById("autocomplete-box");
    const isBoxOpen = box && !box.classList.contains("hidden") && autocompleteItemsList.length > 0;

    if (e.key === "ArrowDown") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex + 1) % autocompleteItemsList.length;
        updateAutocompleteHighlight();
      }
    } else if (e.key === "ArrowUp") {
      if (isBoxOpen) {
        e.preventDefault();
        highlightedAutocompleteIndex = (highlightedAutocompleteIndex - 1 + autocompleteItemsList.length) % autocompleteItemsList.length;
        updateAutocompleteHighlight();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Pesquisar sempre leva ao Home (F1), mesmo vindo de outra aba ou de um painel F5-F9.
      app.ativarAbaTransferencia?.("home");
      if (isBoxOpen && highlightedAutocompleteIndex >= 0 && autocompleteItemsList[highlightedAutocompleteIndex]) {
        app.selecionarItemAutocomplete(autocompleteItemsList[highlightedAutocompleteIndex]);
      } else if (isBoxOpen && autocompleteItemsList.length === 1) {
        app.selecionarItemAutocomplete(autocompleteItemsList[0]);
      } else if (isBoxOpen) {
        app.abrirPesquisaCompleta();
      } else {
        app.buscarSerial();
      }
    } else if (e.key === "Escape") {
      app.fecharAutocomplete();
    }
  }

  function updateAutocompleteHighlight() {
    const list = document.getElementById("autocomplete-list");
    if (!list) return;
    const rows = list.querySelectorAll(".autocomplete-row");
    rows.forEach((row, idx) => {
      const selected = idx === highlightedAutocompleteIndex;
      row.setAttribute("aria-selected", String(selected));
      if (selected) {
        row.classList.add("active");
        document.getElementById("input-serial").setAttribute("aria-activedescendant", row.id);
        row.scrollIntoView({ block: "nearest", behavior: "auto" });
      } else {
        row.classList.remove("active");
      }
    });
    if (highlightedAutocompleteIndex < 0) document.getElementById("input-serial").removeAttribute("aria-activedescendant");
  }

  function selecionarItemAutocomplete(item) {
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    document.getElementById("input-serial").value = item.serial;
    document.getElementById("btn-clear-serial").classList.remove("hidden");
    app.fecharAutocomplete();
    return app.buscarSerial(item);
  }

  function ajustarAlturaAutocomplete() {
    const box = document.getElementById("autocomplete-box");
    if (!box || box.classList.contains("hidden")) return;

    const viewport = window.visualViewport;
    const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const availableHeight = Math.max(0, Math.floor(viewportBottom - box.getBoundingClientRect().top - 12));
    box.style.setProperty("--autocomplete-available-height", `${availableHeight}px`);
  }

  // "Você quis dizer": o servidor sugere o usuário mais próximo quando a busca não acha nada.
  function aplicarSugestaoBusca(button) {
    const suggestion = button?.dataset?.sugestao || "";
    if (!suggestion) return;
    const input = document.getElementById("input-serial");
    input.value = suggestion;
    input.focus();
    handleSerialInput(suggestion);
  }

  function renderAutocomplete(items, total = items?.length || 0, hasMore = false, suggestion = "") {
    const box = document.getElementById("autocomplete-box");
    const list = document.getElementById("autocomplete-list");
    const emptyState = document.getElementById("autocomplete-empty-state");
    const countEl = document.getElementById("autocomplete-count");
    const moreResults = document.getElementById("autocomplete-more-results");
    const moreResultsLabel = moreResults.querySelector("[data-autocomplete-more-label]");
    const currentQuery = (document.getElementById("input-serial").value || "").trim();

    if (!items || items.length === 0) {
      list.replaceChildren();
      list.classList.add("hidden");
      emptyState.classList.remove("hidden");
      moreResults.classList.add("hidden");
      emptyState.innerHTML = `
          <div class="ck-ac__vazio">
            <svg class="ck-ico ck-ico--lg" aria-hidden="true" focusable="false"><use href="#i-search"></use></svg>
            <p class="ck-ac__vazio-titulo" role="status" aria-live="polite">Nenhum equipamento localizado</p>
            <p class="ck-ac__vazio-texto">Nenhum registro com o termo <strong class="ck-ac__vazio-termo">"${escapeHtml(currentQuery)}"</strong> foi encontrado no inventário do SEBRAE/PR.</p>
            ${suggestion ? `<p class="ck-ac__vazio-sugestao">Você quis dizer <button type="button" class="ck-ac__vazio-sugestao-botao" data-on-click="aplicarSugestaoBusca" data-args='["$this"]' data-sugestao="${escapeHtml(suggestion)}">${escapeHtml(suggestion)}</button>?</p>` : ""}
            <button type="button" data-on-click="cadastrarNovoSerialPesquisado" class="ck-btn ck-btn--primario ck-btn--sm">
              <svg class="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-plus"></use></svg>
              <span>Cadastrar "${escapeHtml(currentQuery)}" como Novo Equipamento</span>
            </button>
          </div>
        `;
      countEl.innerHTML = "<strong>Equipamentos</strong> · 0";
      moreResultsLabel.textContent = "Mostrar mais";
      moreResults.querySelector("button")?.removeAttribute("aria-label");
      autocompleteItemsList = [];
      highlightedAutocompleteIndex = -1;
      document.getElementById("input-serial").setAttribute("aria-expanded", "true");
      document.getElementById("input-serial").removeAttribute("aria-activedescendant");
      box.classList.remove("hidden");
      ajustarAlturaAutocomplete();
      lucide.createIcons({ root: box });
      return;
    }

    autocompleteItemsList = items;
    highlightedAutocompleteIndex = -1;
    list.innerHTML = "";
    list.classList.remove("hidden");
    emptyState.classList.add("hidden");
    countEl.innerHTML = hasMore
      ? `<strong>Equipamentos</strong> · ${items.length} de ${total}`
      : `<strong>Equipamentos</strong> · ${total}`;
    moreResults.classList.toggle("hidden", !hasMore);
    const remainingResults = Math.max(0, Number(total) - items.length);
    moreResultsLabel.textContent = `Mostrar mais (${remainingResults})`;
    moreResults.querySelector("button")?.setAttribute(
      "aria-label",
      `Mostrar mais ${remainingResults} ${remainingResults === 1 ? "resultado" : "resultados"}`,
    );
    document.getElementById("input-serial").setAttribute("aria-expanded", "true");
    document.getElementById("input-serial").removeAttribute("aria-activedescendant");

    items.forEach((item, index) => list.appendChild(renderers.criarLinhaAutocomplete(item, index, currentQuery, {
      onSelect: () => app.selecionarItemAutocomplete(item),
      onHighlight: () => {
        highlightedAutocompleteIndex = index;
        updateAutocompleteHighlight();
      },
    })));

    box.classList.remove("hidden");
    ajustarAlturaAutocomplete();
    lucide.createIcons({ root: box });
  }

  function fecharAutocomplete() {
    const box = document.getElementById("autocomplete-box");
    if (box) box.classList.add("hidden");
    if (box) box.setAttribute("aria-busy", "false");
    const input = document.getElementById("input-serial");
    if (input) {
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    autocompleteItemsList = [];
    highlightedAutocompleteIndex = -1;
  }

  // Close autocomplete on click outside
  document.addEventListener("click", (e) => {
    const box = document.getElementById("autocomplete-box");
    const input = document.getElementById("input-serial");
    if (box && !box.contains(e.target) && e.target !== input) {
      app.fecharAutocomplete();
    }
  });

  window.addEventListener("resize", ajustarAlturaAutocomplete);

  window.visualViewport?.addEventListener("resize", ajustarAlturaAutocomplete);

  document.addEventListener("scroll", ajustarAlturaAutocomplete, { capture: true, passive: true });

  function limparSerial() {
    const input = document.getElementById("input-serial");
    input.value = "";
    app.invalidarBuscasEquipamento();
    app.limparSelecaoEquipamento();
    document.getElementById("btn-clear-serial").classList.add("hidden");
    app.fecharAutocomplete();
    input.focus();
    void carregarListaHome({ query: "", reset: true });
  }

  // Search Equipment by Serial
  async function buscarSerial(equipmentHint = null) {
    app.ativarAbaTransferencia?.("home");
    const serialInput = document.getElementById("input-serial");
    const serial = serialInput.value.trim().toUpperCase();

    if (!serial) {
      app.invalidarBuscasEquipamento();
      app.limparSelecaoEquipamento();
      app.showToast("Digite uma série, apelido, modelo, cidade ou nome do usuário", "warning");
      serialInput.focus();
      return;
    }

    clearTimeout(debounceTimer);
    autocompleteRequestGate.invalidate();
    document.getElementById("autocomplete-box").setAttribute("aria-busy", "false");
    app.fecharAutocomplete();
    app.limparSelecaoEquipamento();
    const request = equipmentLookupRequestGate.begin();

    const btn = document.getElementById("btn-buscar-serial");
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    serialInput.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Localizando...</span>`;
    lucide.createIcons({ root: btn });
    const stopLoading = motion?.startLoading(document.getElementById("equipment-loading"), "Localizando equipamento…", { rows: 1 }) || (() => {});
    finishEquipmentLoading = stopLoading;

    try {
      let data;
      try {
        data = await app.apiFetch(`/api/equipamento/${encodeURIComponent(serial)}`, {
          signal: request.signal,
          errorMessage: "Equipamento não encontrado na base de dados.",
        });
      } catch (lookupError) {
        // Only HTTP failures carry a status; network errors and cancellation propagate unchanged.
        if (lookupError.status === undefined) throw lookupError;
        if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        if (lookupError.status === 404 && serial.length >= 2) {
          const searchRes = await fetch(`/api/buscar-expandida?q=${encodeURIComponent(serial)}&limit=15`, { signal: request.signal });
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
          if (searchRes.ok) {
            const searchResults = await searchRes.json();
            if (equipmentLookupRequestGate.isCurrent(request.id) && searchResults.total > 0) {
              renderAutocomplete(searchResults.items, searchResults.total, searchResults.has_more, searchResults.sugestao);
              void carregarListaHome({ query: serialInput.value.trim(), reset: true });
              return;
            }
          }
          if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
        }
        throw lookupError;
      }
      if (!equipmentLookupRequestGate.isCurrent(request.id)) return;
      if (!transferUtils.isCurrentQuery(equipmentLookupRequestGate, request.id, serialInput.value, serial)) return;
      if (transferUtils.serialForTransfer(data, serial) !== serial) {
        throw new Error("A busca não retornou uma correspondência exata. Escolha um equipamento na lista.");
      }
      const hintedSerial = String(equipmentHint?.serial || "").trim().toUpperCase();
      const hintedCnpj = String(equipmentHint?.retirada_cnpj || "").trim();
      if (
        hintedSerial === serial
        && hintedCnpj
        && !String(data.retirada_cnpj || "").trim()
      ) {
        data.retirada_cnpj = hintedCnpj;
      }
      app.definirEquipamentoAtual(data);
      app.exibirEquipamento(data);
      if (recentStore) renderizarPesquisasRecentes(recentStore.add(data));
      app.showToast(`Equipamento ${data.serial} localizado.`, "success");

    } catch (err) {
      if (err.name !== "AbortError" && equipmentLookupRequestGate.isCurrent(request.id)) {
        console.error(err);
        app.limparSelecaoEquipamento();
        app.showToast(err.message, "error");
      }
    } finally {
      stopLoading();
      if (equipmentLookupRequestGate.isCurrent(request.id)) {
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        serialInput.removeAttribute("aria-busy");
        btn.innerHTML = originalText;
        lucide.createIcons({ root: btn });
      }
    }
  }

  // Recent lookups below the search card. Hidden while empty; each row repeats the normal search.
  function renderizarPesquisasRecentes(entries = recentStore?.read() || []) {
    const section = document.getElementById("home-recentes");
    const list = document.getElementById("home-recentes-lista");
    if (!section || !list) return;
    list.replaceChildren(...entries.map(entry => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ck-recente";
      button.dataset.serial = entry.serial;
      button.setAttribute("aria-label", recentEquipment.describeEntry(entry));
      button.append(
        createTextElement("span", "ck-recente__serie", entry.serial),
        createTextElement("span", "ck-recente__extra", entry.apelido || "Sem apelido"),
        createTextElement("span", "ck-recente__extra", entry.cidade || "Cidade não informada"),
      );
      button.addEventListener("click", () => app.abrirPesquisaRecente(entry.serial));
      item.append(button);
      return item;
    }));
    section.hidden = entries.length === 0;
  }

  function abrirPesquisaRecente(serial) {
    const entry = (recentStore?.read() || []).find(item => item.serial === serial) || { serial };
    window.scrollTo?.({ top: 0, behavior: "smooth" });
    return app.selecionarItemAutocomplete(entry);
  }

  function limparPesquisasRecentes() {
    renderizarPesquisasRecentes(recentStore?.clear() || []);
    document.getElementById("input-serial")?.focus({ preventScroll: true });
  }

  if (recentStore) renderizarPesquisasRecentes();

  // City plus the street part of the address; no dangling " - " when one is missing.
  function formatarLocalAtual(eq) {
    const cidade = String(eq?.retirada_cidade || "").trim();
    const endereco = String(eq?.retirada_endereco || "").split("-")[0].trim();
    return [cidade, endereco].filter(Boolean).join(" - ") || "Não especificado";
  }

  // Render Equipment Card & Populate Retirada Section
  function exibirEquipamento(eq) {
    appState.retiradaCidadeSelecionada = String(eq.retirada_cidade || "").trim();
    const card = document.getElementById("card-equipamento");
    const emptyState = document.getElementById("home-detail-empty");
    if (emptyState) emptyState.classList.add("hidden");
    card.classList.remove("hidden");
    motion?.reveal(card);

    document.getElementById("card-serial").textContent = eq.serial;
    document.getElementById("ticket-templates-serial").textContent = eq.serial || "—";
    app.recolherVisualizacoesModelosChamado();
    document.getElementById("card-modelo").textContent = eq.modelo || "Equipamento";
    document.getElementById("badge-tipo").textContent = eq.tipo || "Geral";
    document.getElementById("badge-apelido").textContent = eq.apelido || "Sem Apelido";
    // O apelido é o hostname no Endpoint; sem ele, o campo fica vazio e vale o computador padrão.
    document.getElementById("input-powershell-hostname").value = eq.apelido || "";
    const aliasStatus = document.getElementById("badge-apelido-status");
    aliasStatus.textContent = eq.invall_alias_status && eq.invall_alias_status !== "aplicado"
      ? (eq.invall_alias_detail || "Conferir associação com a InvAll.")
      : "";
    aliasStatus.classList.toggle("hidden", !aliasStatus.textContent);
    document.getElementById("card-id-cliente").textContent = eq.idCliente ? `Id Cliente: ${eq.idCliente}` : "";
    app.atualizarUsuarioLogadoCard(eq);
    app.termosPreencherDoEquipamento?.(eq);
    app.atualizarChamadosAbertosHome(eq.serial);
    document.getElementById("card-localizacao").textContent = app.formatarLocalAtual(eq);
    document.getElementById("card-cnpj-atual").textContent = `CNPJ: ${eq.retirada_cnpj || 'Não especificado'}`;

    // Grade de detalhe (split-view)
    const gridSerial = document.getElementById("grid-serial");
    if (gridSerial) gridSerial.textContent = eq.serial || "—";
    const gridApelido = document.getElementById("grid-apelido");
    if (gridApelido) gridApelido.textContent = eq.apelido || "—";
    const gridCep = document.getElementById("grid-cep");
    if (gridCep) gridCep.textContent = eq.retirada_cep || "—";
    const gridCnpjFat = document.getElementById("grid-cnpj-fat");
    if (gridCnpjFat) gridCnpjFat.textContent = eq.retirada_cnpj || "—";
    const gridCnpjInst = document.getElementById("grid-cnpj-inst");
    if (gridCnpjInst) gridCnpjInst.textContent = eq.retirada_cnpj_instalacao || eq.retirada_cnpj || "—";

    // Type is shown as text in the chip; the icon only changes shape.
    const iconBox = document.getElementById("equip-icon-box");
    const icon = document.getElementById("equip-icon");
    // Literal setAttribute calls keep each icon in the generated Lucide subset.
    if (eq.tipo === "Notebook") icon.setAttribute("data-lucide", "laptop");
    else if (eq.tipo === "Micro Computador") icon.setAttribute("data-lucide", "monitor");
    else icon.setAttribute("data-lucide", "headphones");
    lucide.createIcons({ root: iconBox });

    // Automatically fill RETIRADA (Origem) section!
    document.getElementById("retirada-cnpj").value = eq.retirada_cnpj || "";
    document.getElementById("retirada-endereco").value = eq.retirada_endereco || "";
    document.getElementById("retirada-obs").value = eq.descricao_sugerida || "";
    app.preencherRepresentanteRegional("retirada", eq.retirada_cidade || "");

    // Update status footer
    document.getElementById("status-indicator").dataset.state = "loaded";
    const statusSummary = document.getElementById("status-summary");
    statusSummary.replaceChildren(
      createTextElement("span", "ck-acoes-carregado", "Equipamento " + String(eq.serial ?? "") + " (" + String(eq.modelo ?? "") + ") carregado."),
      createTextElement("span", "ck-acoes-pronto", " Selecione a Unidade de Destino e preencha o destinatário.")
    );

    // Highlight na lista lateral
    highlightHomeListItem(eq.serial);
    app.atualizarPreviaTransporteCockpit?.();
  }

  function highlightHomeListItem(serial) {
    const list = document.getElementById("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    list.querySelectorAll('.ck-item[aria-selected="true"]').forEach(el => {
      el.setAttribute("aria-selected", "false");
    });
    const target = serial ? list.querySelector(`[data-serial="${CSS.escape(String(serial).toUpperCase())}"]`) : null;
    if (target) {
      target.setAttribute("aria-selected", "true");
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
    const active = [...list.querySelectorAll('[role="option"]')].find(option => option.id === list.getAttribute("aria-activedescendant"));
    atualizarAcoesListaHome(active?.dataset.serial || (target ? serial : ""));
  }

  function serialDeComparacao(item) {
    return String(item?.serie || item?.serial || item?.numero_serie || "").trim().toUpperCase();
  }

  function seriesDaComparacao(comparison, keys, requiredKeys = keys) {
    const values = [];
    for (const key of keys) {
      const rows = comparison?.[key];
      if (!Array.isArray(rows)) {
        if (requiredKeys.includes(key)) return null;
        continue;
      }
      for (const row of rows) {
        const serial = serialDeComparacao(row);
        if (!serial) return null;
        values.push(serial);
      }
    }
    return new Set(values);
  }

  function atualizarContagemFiltro(id, total, disponivel = true) {
    const value = document.getElementById(id);
    const button = value?.closest("button");
    if (value) value.textContent = Number.isSafeInteger(total) && total >= 0
      ? total.toLocaleString("pt-BR")
      : "—";
    if (button) button.disabled = !disponivel;
  }

  async function carregarFiltrosComparacaoHome() {
    const filters = homeComparisonFilters;
    try {
      const dashboardResponse = await fetch("/api/painel", { cache: "no-store" });
      if (!dashboardResponse.ok) throw new Error("Resumo do painel indisponível.");
      const dashboard = await dashboardResponse.json();
      const eventId = String(dashboard?.ultima_comparacao?.id || "").trim();
      if (!eventId) throw new Error("Ainda não há comparação de inventários.");

      const comparisonResponse = await fetch(`/api/historico-comparacoes/${encodeURIComponent(eventId)}`, { cache: "no-store" });
      if (!comparisonResponse.ok) throw new Error("Detalhes da última comparação indisponíveis.");
      const result = await comparisonResponse.json();
      const comparison = result?.evento?.comparacao;
      if (!comparison || typeof comparison !== "object") throw new Error("A última comparação não contém detalhes.");

      const stale = seriesDaComparacao(comparison, HOME_COMPARISON_FILTERS["7-dias"]);
      const divergent = seriesDaComparacao(
        comparison,
        HOME_COMPARISON_FILTERS.divergentes,
        ["ausentes_no_endpoint", "divergencias_local"],
      );
      filters["7-dias"] = stale;
      filters.divergentes = divergent;
      atualizarContagemFiltro("home-filter-7-dias", stale?.size, stale !== null);
      atualizarContagemFiltro("home-filter-divergentes", divergent?.size, divergent !== null);
      atualizarMapaSeriesComparacao(comparison);
      if (!homeListQuery && homeListFilter === "todos") {
        await carregarListaHome({ query: "", reset: true });
      }
    } catch (error) {
      filters["7-dias"] = null;
      filters.divergentes = null;
      atualizarContagemFiltro("home-filter-7-dias", null, false);
      atualizarContagemFiltro("home-filter-divergentes", null, false);
      // The Home inventory remains usable even when comparison history is unavailable.
      console.info("Filtros de comparação da Home indisponíveis:", error.message);
    }
  }

  function atualizarMapaSeriesComparacao(comparison) {
    homeListSerials = new Map();
    const staleRows = Array.isArray(comparison?.sem_acesso_7_dias) ? comparison.sem_acesso_7_dias : [];
    for (const row of staleRows) {
      const serial = serialDeComparacao(row);
      if (!serial) continue;
      const days = Number(row?.dias_sem_acesso ?? row?.dias ?? row?.dias_desde_ultimo_acesso);
      homeListSerials.set(serial, { stale: true, days: Number.isFinite(days) && days > 0 ? days : null });
    }
    // First listed key wins, so the chip lands on the section the Resumo shows first for that serial.
    for (const [key, category] of HOME_DIVERGENCE_CATEGORIES) {
      const rows = Array.isArray(comparison?.[key]) ? comparison[key] : [];
      for (const row of rows) {
        const serial = serialDeComparacao(row);
        if (!serial) continue;
        const previous = homeListSerials.get(serial);
        homeListSerials.set(serial, { ...previous, divergent: true, divergentCategory: previous?.divergentCategory || category });
      }
    }
  }

  function atualizarContagensHome(filters, total) {
    if (homeCountsLoaded || homeListQuery || homeListFilter !== "todos") return;
    homeCountsLoaded = true;
    const totalCount = Number(total);
    const withoutUser = Number(filters?.users?.sem);
    atualizarContagemFiltro("home-filter-total", totalCount);
    atualizarContagemFiltro("home-filter-sem-usuario", withoutUser);
  }

  function limparListaHome(message) {
    homeListItems = new Map();
    atualizarAcoesListaHome("");
    const list = document.getElementById("home-equipment-list");
    if (list) {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      list.removeAttribute("aria-activedescendant");
      list.dataset.estado = "vazio";
    }
    const empty = document.getElementById("home-list-empty");
    if (empty) {
      empty.textContent = message;
      empty.hidden = false;
    }
    const count = document.getElementById("home-list-count");
    if (count) count.textContent = message;
    const more = document.getElementById("btn-home-list-more");
    if (more) more.hidden = true;
  }

  function statusDaLinhaHome(item) {
    const serial = String(item?.serial || "").trim().toUpperCase();
    const comparison = homeListSerials.get(serial);
    const statuses = [];
    if (comparison?.stale) {
      statuses.push({
        tone: "alerta",
        icon: "i-alerta",
        label: comparison.days ? `Sem acesso ${comparison.days} d` : "Sem acesso 7+ d",
        destino: "comparacao",
        categoria: "sem_acesso_7_dias",
      });
    }
    if (comparison?.divergent) {
      statuses.push({ tone: "erro", icon: "i-erro", label: "Divergente", destino: "comparacao", categoria: comparison.divergentCategory || "divergencias_local" });
    }
    if (!String(item?.usuarios_logados || "").trim()) {
      // The Resumo lists only notebooks/MacBooks without a user (the Home "Sem usuário" filter rule); other types get no link.
      const linkable = HOME_NOTEBOOK_CATEGORIES.includes(String(item?.categoria || "").toLowerCase());
      statuses.push({ tone: "info", icon: "i-user", label: "Sem usuário", ...(linkable ? { destino: "comparacao", categoria: "sem_usuario" } : {}) });
    }
    return statuses.length ? statuses : [{ tone: "ok", icon: "i-ok", label: "Sincronizado" }];
  }

  function criarStatusListaHome(status, serial, interativo = false) {
    const el = document.createElement(interativo ? "button" : "span");
    el.className = interativo ? "ck-status ck-status--link" : "ck-status";
    el.dataset.status = status.tone;
    el.append(status.label);
    const svgNs = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNs, "svg");
    icon.setAttribute("class", "ck-ico ck-ico--xs");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const use = document.createElementNS(svgNs, "use");
    use.setAttribute("href", `#${status.icon}`);
    icon.append(use);
    el.prepend(icon);
    if (interativo) {
      el.type = "button";
      el.dataset.destino = status.destino;
      el.dataset.categoria = status.categoria;
      el.title = "Abrir no Resumo";
      el.setAttribute("aria-label", `${status.label}: abrir ${serial} no Resumo (F3)`);
      el.addEventListener("click", event => {
        event.stopPropagation();
        void abrirDestinoStatusHome(status.categoria, serial);
      });
      el.addEventListener("keydown", event => event.stopPropagation());
    }
    return el;
  }

  function atualizarAcoesListaHome(serial) {
    homeListActiveSerial = String(serial || "").trim();
    const actions = document.getElementById("home-equipment-actions");
    if (!actions) return;
    // Serial outside the rendered list: unknown user, so no "Sem usuário" chip (the placeholder user keeps it out).
    const activeItem = homeListItems.get(homeListActiveSerial.toUpperCase()) || { serial: homeListActiveSerial, usuarios_logados: "—" };
    const statuses = homeListActiveSerial ? statusDaLinhaHome(activeItem).filter(status => status.destino) : [];
    const signature = JSON.stringify([homeListActiveSerial, statuses]);
    if (actions.dataset.signature === signature) return;
    const focused = document.activeElement;
    const focusedDestination = actions.dataset.serial === homeListActiveSerial && actions.contains?.(focused) ? focused.dataset.categoria : "";
    actions.dataset.signature = signature;
    actions.dataset.serial = homeListActiveSerial;
    actions.hidden = !statuses.length;
    actions.replaceChildren();
    if (!statuses.length) return;
    actions.setAttribute("aria-label", `Ações de ${homeListActiveSerial}`);
    actions.append(
      createTextElement("span", "ck-lista__info", `Ações de ${homeListActiveSerial}`),
      ...statuses.map(status => criarStatusListaHome(status, homeListActiveSerial, true)),
    );
    if (focusedDestination) actions.querySelector(`[data-categoria="${CSS.escape(focusedDestination)}"]`)?.focus({ preventScroll: true });
  }

  // Opens the Resumo (F3) on the serial's row in the section of the chip's category.
  async function abrirDestinoStatusHome(categoria, serial) {
    await app.abrirComparacaoDaSerie?.(serial, categoria);
  }

  function criarPilhaStatusHome(statuses, serial) {
    const pilha = document.createElement("span");
    pilha.className = "ck-item__status";
    pilha.append(...statuses.map(status => criarStatusListaHome(status, serial)));
    return pilha;
  }

  function criarOpcaoListaHome(item, index) {
    const li = document.createElement("li");
    const serial = String(item?.serial || "").trim();
    const city = String(item?.retirada_cidade || "").trim();
    const user = String(item?.usuarios_logados || item?.nome_pessoa || "").trim();
    const statuses = statusDaLinhaHome(item);
    li.className = "ck-item";
    li.id = `home-equipment-option-${index}`;
    li.dataset.serial = serial.toUpperCase();
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(String(appState.currentEquipamento?.serial || "").toUpperCase() === serial.toUpperCase()));
    li.tabIndex = -1;
    const detail = [item?.modelo, user].filter(Boolean).join(" · ");
    li.title = [serial, detail, city, ...statuses.map((status) => status.label)].filter(Boolean).join(" · ");
    li.append(
      createTextElement("span", "ck-item__serie", serial || "Série não informada"),
      createTextElement("span", "ck-item__local", city || "Sem cidade"),
      createTextElement("span", "ck-item__sub", detail || "Sem modelo ou usuário"),
      criarPilhaStatusHome(statuses, serial),
    );
    li.addEventListener("click", () => {
      const list = document.getElementById("home-equipment-list");
      list.setAttribute("aria-activedescendant", li.id);
      list.querySelectorAll('[role="option"]').forEach(option => option.classList.toggle("is-focused", option === li));
      atualizarAcoesListaHome(serial);
      app.selecionarItemAutocomplete(item);
    });
    return li;
  }

  function renderHomeList(items, append = false) {
    const list = document.getElementById("home-equipment-list");
    if (!list || typeof list.querySelectorAll !== "function") return;
    if (!append) {
      list.replaceChildren();
      list.removeAttribute("aria-activedescendant");
      homeListItems = new Map();
    }
    (Array.isArray(items) ? items : []).forEach((item, index) => {
      const serial = String(item?.serial || "").trim().toUpperCase();
      if (serial && list.querySelector(`[data-serial="${CSS.escape(serial)}"]`)) return;
      if (serial) homeListItems.set(serial, item);
      list.appendChild(criarOpcaoListaHome(item, homeListOffset + index));
    });
    const selected = String(appState.currentEquipamento?.serial || "").trim();
    if (selected) highlightHomeListItem(selected);
    else if (homeListActiveSerial && !list.querySelector(`[data-serial="${CSS.escape(homeListActiveSerial.toUpperCase())}"]`)) atualizarAcoesListaHome("");
  }

  async function carregarListaHome({ query = homeListQuery, reset = true } = {}) {
    const list = document.getElementById("home-equipment-list");
    if (!list) return;
    homeListQuery = String(query || "").trim();
    finishHomeListLoading();
    finishHomeListLoading = () => {};
    if (homeListQuery.length === 1) {
      homeListRequestGate.invalidate();
      homeListHasMore = false;
      limparListaHome("Digite ao menos 2 caracteres para filtrar a lista.");
      return;
    }
    const request = homeListRequestGate.begin();
    const offset = reset ? 0 : homeListOffset;
    if (reset) {
      atualizarAcoesListaHome("");
      homeListOffset = 0;
      homeListTotal = 0;
      homeListHasMore = false;
      list.replaceChildren();
      list.setAttribute("aria-busy", "true");
      list.dataset.estado = "carregando";
      list.removeAttribute("aria-activedescendant");
      finishHomeListLoading = motion?.startLoading(document.getElementById("equipment-loading"), "Carregando equipamentos…") || (() => {});
      const count = document.getElementById("home-list-count");
      if (count) count.textContent = "Carregando equipamentos…";
      const empty = document.getElementById("home-list-empty");
      if (empty) empty.hidden = true;
    }

    const params = new URLSearchParams({
      listar_todos: "true",
      offset: String(offset),
      limit: String(HOME_LIST_PAGE_SIZE),
      include_filters: "true",
    });
    if (homeListQuery.length >= 2) params.set("q", homeListQuery);
    if (homeListFilter === "sem-usuario") params.set("usuario", "sem");
    if (homeListFilter === "7-dias" || homeListFilter === "divergentes") {
      const series = homeComparisonFilters[homeListFilter];
      if (!series) {
        finishHomeListLoading();
        limparListaHome("O filtro depende de uma comparação de inventários disponível.");
        return;
      }
      series.forEach(serial => params.append("serie", serial));
    }

    try {
      const response = await fetch(`/api/buscar-expandida?${params.toString()}`, { signal: request.signal });
      if (!homeListRequestGate.isCurrent(request.id)) return;
      if (response.status === 409) throw new Error("A base está sendo atualizada. Tente novamente em instantes.");
      if (!response.ok) throw new Error("Não foi possível carregar a lista de equipamentos.");
      const result = await response.json();
      if (!homeListRequestGate.isCurrent(request.id)) return;
      finishHomeListLoading();

      homeListTotal = Number(result.total) || 0;
      homeListOffset = offset + (Array.isArray(result.items) ? result.items.length : 0);
      homeListHasMore = result.has_more === true;
      if (!homeListQuery && homeListFilter === "todos") {
        atualizarContagensHome(result.filters, homeListTotal);
      }
      renderHomeList(result.items, !reset);
      const empty = document.getElementById("home-list-empty");
      const hasItems = list.children.length > 0;
      list.dataset.estado = hasItems ? "pronto" : "vazio";
      if (empty) {
        empty.textContent = homeListQuery
          ? "Nenhum equipamento corresponde à pesquisa."
          : "Nenhum equipamento encontrado para este filtro.";
        empty.hidden = hasItems;
      }
      const count = document.getElementById("home-list-count");
      if (count) {
        const shown = list.children.length;
        count.textContent = homeListHasMore
          ? `Mostrando ${shown.toLocaleString("pt-BR")} de ${homeListTotal.toLocaleString("pt-BR")}`
          : `${homeListTotal.toLocaleString("pt-BR")} ${homeListTotal === 1 ? "equipamento" : "equipamentos"}`;
      }
      const more = document.getElementById("btn-home-list-more");
      if (more) more.hidden = !homeListHasMore;
      list.setAttribute("aria-busy", "false");
    } catch (error) {
      if (error.name === "AbortError" || !homeListRequestGate.isCurrent(request.id)) return;
      finishHomeListLoading();
      list.setAttribute("aria-busy", "false");
      limparListaHome(error.message || "Não foi possível carregar os equipamentos.");
      list.dataset.estado = "erro";
    }
  }

  function filtrarListaHome(filter) {
    if (!["todos", "sem-usuario", "7-dias", "divergentes"].includes(filter)) return;
    if ((filter === "7-dias" || filter === "divergentes") && !homeComparisonFilters[filter]) return;
    homeListFilter = filter;
    document.querySelectorAll(".ck-filtro[data-filter]").forEach(button => {
      const active = button.dataset.filter === filter;
      button.setAttribute("aria-pressed", String(active));
    });
    void carregarListaHome({ query: document.getElementById("input-serial")?.value || "", reset: true });
  }

  function carregarMaisItensHome() {
    if (!homeListHasMore) return;
    return carregarListaHome({ query: homeListQuery, reset: false });
  }

  function ativarNavegacaoListaHome() {
    const list = document.getElementById("home-equipment-list");
    if (!list || list.dataset.keyboardReady) return;
    list.dataset.keyboardReady = "true";
    list.addEventListener("keydown", event => {
      const options = [...list.querySelectorAll('[role="option"]')];
      if (!options.length) return;
      let index = options.findIndex(option => option.id === list.getAttribute("aria-activedescendant"));
      if (event.key === "ArrowDown") index = Math.min(index + 1, options.length - 1);
      else if (event.key === "ArrowUp") index = Math.max(index <= 0 ? 0 : index - 1, 0);
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = options.length - 1;
      else if ((event.key === "Enter" || event.key === " ") && index >= 0) {
        event.preventDefault();
        options[index].click();
        return;
      } else return;
      event.preventDefault();
      list.setAttribute("aria-activedescendant", options[index].id);
      atualizarAcoesListaHome(options[index].dataset.serial);
      options.forEach((option, optionIndex) => option.classList.toggle("is-focused", optionIndex === index));
      options[index].scrollIntoView({ block: "nearest", behavior: "auto" });
    });
  }

  function inicializarListaHome() {
    ativarNavegacaoListaHome();
    void carregarFiltrosComparacaoHome();
    void carregarListaHome({ query: "", reset: true });
  }

  return {
    consultarEndpoint,
    controleRemotoEndpoint, abrirPowerShellEndpoint, aplicarCodigoProntoPowerShell,
    aoAbrirPowerShellEndpoint, alternarEditorCodigosPowerShell, adicionarCodigoPowerShell, salvarCodigosPowerShell,
    definirEquipamentoAtual, limparSelecaoEquipamento, invalidarBuscasEquipamento,
    invalidarDadosEquipamentoAposRestauracao, atualizarSelecaoAposSubstituirInventarios, handleSerialInput,
    handleSerialKeydown, selecionarItemAutocomplete, aplicarSugestaoBusca, fecharAutocomplete,
    limparSerial, buscarSerial, exibirEquipamento, formatarLocalAtual, abrirPesquisaRecente, limparPesquisasRecentes,
    renderHomeList, highlightHomeListItem, filtrarListaHome, carregarMaisItensHome, carregarListaHome, inicializarListaHome,
  };
});
