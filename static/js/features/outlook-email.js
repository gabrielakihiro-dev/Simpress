/** Home e-mail by template: modal "E-mail pelo Outlook" (models with autosave, Entra contacts, open or send through the local backend). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).outlookEmail = factory;
})(typeof window !== "undefined" ? window : globalThis, function createOutlookEmail(context) {
  "use strict";
  const { app, appState } = context;
  const MODAL = "modal-email-outlook";
  const API = "/api/outlook";
  const ULTIMO_MODELO = "simpress.outlook-email.ultimo-modelo";
  const ID_CABO = "cabo";
  const ATRASO_SALVAR = 800;
  const ATRASO_BUSCA = 200;
  // Same limits as domains/outlook_mail.py (resolver endpoint).
  const MAX_TOKENS = 50;
  const MAX_TOKEN = 200;
  const MARCADOR = { nome: "[Nome da pessoa]", setor: "[Setor]" };
  const JSON_HEADERS = { "Content-Type": "application/json" };
  // Approved texts (docs/planos/email-outlook-modelos.md); the ones marked "mirror" repeat what the server answers.
  const TEXTO = {
    pendente: "Alteração ainda não salva…",
    salvando: "Salvando…",
    salva: "Salva.",
    falhaSalvar: "Não foi possível salvar: ",
    aberto: "E-mail aberto no Outlook. Revise e envie por lá.",
    enviado: "E-mail enviado pelo Outlook.",
    copiado: "Texto copiado.",
    incerto: "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.",
    ultimoModelo: "Mantenha ao menos um modelo.",
    semContato: "Nenhum contato encontrado no Entra.",
    ambiguo: "Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.",
    marcador: "Preencha o nome da pessoa e o setor antes de enviar.", // mirror
    semPara: "Informe o destinatário no campo Para.", // mirror
    // Approved text (10/11/2026): generic fallback for a failure the server did not explain.
    falha: "Não foi possível concluir a operação do e-mail. Tente de novo.",
  };
  const CAMPOS = {
    nome: "email-modelo-nome", conta: "email-conta", para: "email-para", cc: "email-cc",
    assunto: "email-assunto", corpo: "email-corpo",
  };
  const COMBOS = {
    para: { entrada: "email-para", lista: "email-para-lista", opcoes: "email-para-opcoes" },
    cc: { entrada: "email-cc", lista: "email-cc-lista", opcoes: "email-cc-opcoes" },
  };
  // Free fields stay editable while an action runs; the action controls do not.
  const CAMPOS_LIVRES = [
    "email-modelo-nome", "email-conta", "email-para", "email-cc", "email-assunto", "email-corpo",
    "email-nome-pessoa", "email-setor",
  ];
  const CONTROLES = [
    "email-modelo", "email-modelo-novo", "email-modelo-duplicar", "email-modelo-excluir", "email-modelo-restaurar",
    "email-copiar", "email-abrir", "email-enviar",
  ];

  const byId = id => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const lerCampo = campo => byId(CAMPOS[campo]).value;
  const dividir = texto => String(texto).split(";").map(pedaco => pedaco.trim()).filter(Boolean);
  const tokenFinal = texto => String(texto).slice(String(texto).lastIndexOf(";") + 1).trim();
  const rotuloContato = contato => (contato.nome ? `${contato.nome} <${contato.email}>` : contato.email);

  let config = null; // { contas, modelos, diretorio } from the last GET /email/configuracao
  let modeloId = null;
  let aberto = false;
  let geracao = 0; // bumps on every open and close: late answers from an older session are dropped
  let ocupado = false;
  let ligado = false;
  let timerSalvar = null;
  let cadeia = Promise.resolve(true); // PUTs run one after the other; resolves to "last save worked"
  const sujo = new Set(); // model fields edited since the last save
  let gravando = 0; // PUTs queued or in flight
  const combos = {};

  function chamar(caminho, { metodo = "GET", dados, erro = TEXTO.falha } = {}) {
    const opcoes = { method: metodo, errorMessage: erro };
    if (dados !== undefined) Object.assign(opcoes, { headers: JSON_HEADERS, body: JSON.stringify(dados) });
    return app.apiFetch(API + caminho, opcoes);
  }

  // ---------------------------------------------------------------- messages

  function mostrarAutosave(texto, erro = false) {
    const alvo = byId("email-autosave-status");
    alvo.textContent = texto;
    alvo.dataset.estado = erro ? "erro" : "";
  }

  function mostrarStatus(texto, tipo = "aviso") {
    const alvo = byId("email-status");
    alvo.textContent = texto;
    alvo.dataset.tipo = texto ? tipo : "";
    alvo.hidden = !texto;
  }

  // The server's text for an HTTP error; a lost connection has no status and only a browser message, so it gets the fallback.
  const mensagemDe = erro => (erro?.status && erro.message) || TEXTO.falha;

  // Result of an action: the status line in the modal plus a toast (the line alone was easy to miss).
  // linha = false: a result from a modal session already closed goes to the toast only.
  function avisar(texto, tipo, linha = true) {
    if (linha) mostrarStatus(texto, tipo);
    app.showToast(texto, tipo === "ok" ? "success" : tipo === "erro" ? "error" : "warning");
  }

  // ---------------------------------------------------------------- state of the controls

  function aplicarEstado() {
    const pronto = Boolean(config);
    for (const id of CAMPOS_LIVRES) byId(id).disabled = !pronto;
    for (const id of CONTROLES) byId(id).disabled = !pronto || ocupado;
  }

  // One slow action at a time (Outlook call, model change). Focus returns to where it was once the controls are back.
  async function exclusivo(passo) {
    if (ocupado || !aberto || !config) return undefined;
    const foco = document.activeElement;
    const minha = geracao;
    ocupado = true;
    aplicarEstado();
    try {
      return await passo();
    } finally {
      ocupado = false;
      aplicarEstado();
      if (aberto && geracao === minha) foco?.focus?.();
    }
  }

  const diretorioDisponivel = () => Boolean(config?.diretorio?.disponivel);

  // ---------------------------------------------------------------- models and autosave

  function lembrarModelo(id) {
    try { window.localStorage.setItem(ULTIMO_MODELO, id); } catch (erro) { /* only a convenience */ }
  }

  function ultimoModelo() {
    try { return window.localStorage.getItem(ULTIMO_MODELO); } catch (erro) { return null; }
  }

  function montarContas() {
    byId("email-conta").replaceChildren(...config.contas.map(conta => {
      const opcao = el("option", "", `${conta.rotulo} (${conta.email})`);
      opcao.value = conta.id;
      return opcao;
    }));
  }

  function montarModelos() {
    byId("email-modelo").replaceChildren(...config.modelos.map(modelo => {
      const opcao = el("option", "", modelo.nome);
      opcao.value = modelo.id;
      return opcao;
    }));
  }

  function selecionarModelo(id) {
    const modelo = config.modelos.find(item => item.id === id) || config.modelos[0];
    modeloId = modelo.id;
    limparTimer();
    sujo.clear();
    const conta = config.contas.some(item => item.id === modelo.conta)
      ? modelo.conta
      : (config.contas.find(item => item.padrao) || config.contas[0]).id;
    byId("email-modelo").value = modelo.id;
    byId(CAMPOS.nome).value = modelo.nome;
    byId(CAMPOS.conta).value = conta;
    for (const campo of ["para", "cc", "assunto", "corpo"]) byId(CAMPOS[campo]).value = modelo[campo] || "";
    byId("email-modelo-restaurar").hidden = modelo.id !== ID_CABO;
    for (const combo of Object.values(combos)) reiniciarCombo(combo);
    mostrarAutosave("");
    mostrarStatus("");
    lembrarModelo(modelo.id);
  }

  function guardarModelo(modelo) {
    if (!config || !modelo?.id) return;
    const indice = config.modelos.findIndex(item => item.id === modelo.id);
    if (indice < 0) return;
    config.modelos[indice] = modelo;
    const opcao = [...byId("email-modelo").children].find(item => item.value === modelo.id);
    if (opcao) opcao.textContent = modelo.nome;
  }

  function limparTimer() {
    clearTimeout(timerSalvar);
    timerSalvar = null;
  }

  function marcarSujo(campo) {
    sujo.add(campo);
    mostrarAutosave(TEXTO.pendente);
  }

  function agendarSalvar(campo) {
    if (!modeloId) return;
    marcarSujo(campo);
    limparTimer();
    timerSalvar = setTimeout(() => void salvarPendente(), ATRASO_SALVAR);
  }

  async function gravar(id, dados, campos) {
    try {
      guardarModelo(await chamar(`/email/modelos/${encodeURIComponent(id)}`, { metodo: "PUT", dados }));
      if (modeloId === id && !sujo.size && !timerSalvar && gravando === 1) mostrarAutosave(TEXTO.salva);
      return true;
    } catch (erro) {
      const atual = modeloId === id;
      if (atual) campos.forEach(campo => sujo.add(campo)); // the next flush tries again
      const mensagem = TEXTO.falhaSalvar + mensagemDe(erro);
      mostrarAutosave(mensagem, true);
      if (!aberto || !atual) app.showToast(mensagem, "error");
      return false;
    } finally {
      gravando -= 1;
    }
  }

  // Writes what is pending now, one PUT per field: a field the server refuses does not take the others down.
  // Resolves to true when nothing is left unsaved.
  function salvarPendente() {
    limparTimer();
    const id = modeloId;
    if (!id || !sujo.size) return cadeia.then(() => sujo.size === 0);
    const campos = [...sujo];
    sujo.clear();
    const valores = Object.fromEntries(campos.map(campo => [campo, lerCampo(campo)]));
    mostrarAutosave(TEXTO.salvando);
    gravando += campos.length;
    const resultados = campos.map(campo => cadeia = cadeia.then(() => gravar(id, { [campo]: valores[campo] }, [campo])));
    return Promise.all(resultados).then(feitos => feitos.every(Boolean));
  }

  async function garantirSalvo() {
    let salvo = await salvarPendente();
    while (salvo && sujo.size) salvo = await salvarPendente(); // typed while the save was running
    return salvo;
  }

  async function descartarPendente() {
    limparTimer();
    sujo.clear();
    mostrarAutosave("");
    await cadeia;
  }

  // ---------------------------------------------------------------- contacts: autocomplete and resolution

  function criarCombo(campo) {
    const ids = COMBOS[campo];
    return {
      campo, input: byId(ids.entrada), lista: byId(ids.lista), opcoes: byId(ids.opcoes),
      itens: [], ativo: -1, timer: null, pedido: 0, resolucao: 0, ambiguos: [],
    };
  }

  function fecharLista(combo) {
    combo.lista.hidden = true;
    combo.itens = [];
    combo.ativo = -1;
    combo.input.setAttribute("aria-expanded", "false");
    combo.input.removeAttribute("aria-activedescendant");
  }

  function reiniciarCombo(combo) {
    clearTimeout(combo.timer);
    combo.pedido += 1;
    combo.resolucao += 1;
    combo.ambiguos = [];
    combo.lista.replaceChildren();
    fecharLista(combo);
    mostrarOpcoes(combo);
  }

  function marcarAtivo(combo) {
    [...combo.lista.children].forEach((item, indice) => item.setAttribute("aria-selected", String(indice === combo.ativo)));
    const ativo = combo.lista.children[combo.ativo];
    if (ativo) {
      combo.input.setAttribute("aria-activedescendant", ativo.id);
      ativo.scrollIntoView?.({ block: "nearest" });
    } else {
      combo.input.removeAttribute("aria-activedescendant");
    }
  }

  function mover(combo, passo) {
    const total = combo.itens.length;
    if (!total) return;
    combo.ativo = combo.ativo < 0 ? (passo > 0 ? 0 : total - 1) : (combo.ativo + passo + total) % total;
    marcarAtivo(combo);
  }

  // Replaces the text after the last ";" with "Name <address>; ".
  function inserir(combo, contato) {
    const valor = combo.input.value;
    const corte = valor.lastIndexOf(";");
    combo.input.value = `${valor.slice(0, corte + 1)}${corte >= 0 ? " " : ""}${rotuloContato(contato)}; `;
    clearTimeout(combo.timer);
    combo.pedido += 1;
    fecharLista(combo);
    marcarSujo(combo.campo);
    void salvarPendente();
    combo.input.focus();
  }

  function abrirLista(combo, contatos) {
    combo.itens = contatos;
    combo.ativo = -1;
    const itens = contatos.map((contato, indice) => {
      const item = el("li", "email-outlook__opcao", rotuloContato(contato));
      item.id = `email-${combo.campo}-opcao-${indice}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", "false");
      // Keeps the focus in the field, so the click is not preceded by a blur.
      item.addEventListener("mousedown", evento => evento.preventDefault?.());
      item.addEventListener("click", () => inserir(combo, contato));
      return item;
    });
    if (!itens.length) {
      const vazio = el("li", "email-outlook__opcao", TEXTO.semContato);
      vazio.setAttribute("role", "option");
      vazio.setAttribute("aria-disabled", "true");
      itens.push(vazio);
    }
    combo.lista.replaceChildren(...itens);
    combo.lista.hidden = false;
    combo.input.setAttribute("aria-expanded", "true");
    combo.input.removeAttribute("aria-activedescendant");
  }

  async function buscar(combo, termo) {
    const minha = geracao;
    const pedido = ++combo.pedido;
    const vigente = () => aberto && geracao === minha && pedido === combo.pedido && tokenFinal(combo.input.value) === termo;
    try {
      const dados = await chamar(`/contatos?q=${encodeURIComponent(termo)}`);
      if (vigente()) abrirLista(combo, Array.isArray(dados.contatos) ? dados.contatos : []);
    } catch (erro) {
      if (vigente()) fecharLista(combo);
    }
  }

  function agendarBusca(combo) {
    clearTimeout(combo.timer);
    const termo = tokenFinal(combo.input.value);
    if (!diretorioDisponivel() || termo.length < 2 || termo.includes("@")) {
      combo.pedido += 1;
      fecharLista(combo);
      return;
    }
    combo.timer = setTimeout(() => void buscar(combo, termo), ATRASO_BUSCA);
  }

  function teclaCombo(combo, evento) {
    if (combo.lista.hidden) return;
    if (evento.key === "Escape") {
      // Closes the list only; a second Esc (list already closed) reaches the dialog.
      evento.preventDefault();
      evento.stopPropagation();
      fecharLista(combo);
    } else if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
      evento.preventDefault();
      mover(combo, evento.key === "ArrowDown" ? 1 : -1);
    } else if (evento.key === "Enter" && combo.itens[combo.ativo]) {
      evento.preventDefault();
      inserir(combo, combo.itens[combo.ativo]);
    } else if (evento.key === "Tab") {
      fecharLista(combo);
    }
  }

  // "Which person?" box for names the Entra base answers with more than one match.
  function mostrarOpcoes(combo) {
    const presentes = dividir(combo.input.value);
    combo.ambiguos = combo.ambiguos.filter(item => presentes.includes(item.token));
    combo.opcoes.replaceChildren(...combo.ambiguos.map(item => {
      const bloco = el("div", "email-outlook__pergunta");
      const botoes = el("div", "email-outlook__botoes");
      for (const contato of item.opcoes) {
        const botao = el("button", "ck-btn ck-btn--secundario ck-btn--sm", rotuloContato(contato));
        botao.type = "button";
        botao.addEventListener("click", () => escolherOpcao(combo, item.token, contato));
        botoes.appendChild(botao);
      }
      bloco.append(el("p", "", `Escolha o destinatário certo para "${item.token}":`), botoes);
      return bloco;
    }));
    combo.opcoes.hidden = !combo.ambiguos.length;
  }

  // Swaps each token in the map for its resolved text, keeping the separators and spaces around it.
  function substituirTokens(combo, mapa) {
    let mudou = false;
    const pedacos = combo.input.value.split(";").map(pedaco => {
      const rotulo = mapa.get(pedaco.trim());
      if (!rotulo) return pedaco;
      mudou = true;
      return pedaco.replace(pedaco.trim(), () => rotulo);
    });
    if (!mudou) return;
    combo.input.value = pedacos.join(";");
    marcarSujo(combo.campo);
    void salvarPendente();
  }

  function escolherOpcao(combo, token, contato) {
    substituirTokens(combo, new Map([[token, rotuloContato(contato)]]));
    combo.ambiguos = combo.ambiguos.filter(item => item.token !== token);
    mostrarOpcoes(combo);
  }

  // Names without "@" go to the Entra base: one match is written in the field, several ask the user, none stays
  // as typed for Outlook to resolve (people outside the Entra base).
  async function resolverCampo(combo) {
    if (!aberto || !diretorioDisponivel()) return;
    const minha = geracao;
    const ordem = ++combo.resolucao;
    const tokens = [...new Set(dividir(combo.input.value).filter(token => !token.includes("@") && token.length <= MAX_TOKEN))].slice(0, MAX_TOKENS);
    if (!tokens.length) {
      combo.ambiguos = [];
      mostrarOpcoes(combo);
      return;
    }
    try {
      const dados = await chamar("/contatos/resolver", { metodo: "POST", dados: { tokens } });
      if (!aberto || geracao !== minha || ordem !== combo.resolucao) return;
      const resultados = Array.isArray(dados.resultados) ? dados.resultados : [];
      combo.ambiguos = resultados
        .filter(item => item.status === "ambiguo" && Array.isArray(item.opcoes) && item.opcoes.length)
        .map(item => ({ token: item.token, opcoes: item.opcoes }));
      substituirTokens(combo, new Map(resultados.filter(item => item.status === "unico" && item.email).map(item => [item.token, rotuloContato(item)])));
      mostrarOpcoes(combo);
    } catch (erro) {
      // The names stay as typed; Outlook still tries to resolve them.
    }
  }

  const temAmbiguidade = () => Object.values(combos).some(combo => {
    mostrarOpcoes(combo);
    return combo.ambiguos.length > 0;
  });

  // ---------------------------------------------------------------- text of the e-mail

  function substituir(texto) {
    const valores = {
      nome: byId("email-nome-pessoa").value.trim() || MARCADOR.nome,
      setor: byId("email-setor").value.trim() || MARCADOR.setor,
    };
    return texto.replace(/\{(nome|setor)\}/g, (_, chave) => valores[chave]);
  }

  const marcadorPendente = () => ["assunto", "corpo"].some(campo => {
    const texto = substituir(lerCampo(campo));
    return texto.includes(MARCADOR.nome) || texto.includes(MARCADOR.setor);
  });

  const emailDaConta = () => config.contas.find(conta => conta.id === lerCampo("conta"))?.email || lerCampo("conta");

  // ---------------------------------------------------------------- listeners (bound once, on the first open)

  function ligarEventos() {
    if (ligado) return;
    ligado = true;
    // Same pattern as history-annotation-autosave.js: the browser asks before leaving with unsaved or running work.
    // No "aberto" check: a send or the closing save keeps running after Esc, and a reload then could lose its result.
    window.addEventListener("beforeunload", evento => {
      if (!(sujo.size || timerSalvar || gravando || ocupado)) return;
      evento.preventDefault();
      evento.returnValue = "";
    });
    for (const campo of ["nome", "assunto", "corpo"]) {
      const entrada = byId(CAMPOS[campo]);
      entrada.addEventListener("input", () => agendarSalvar(campo));
      entrada.addEventListener("change", () => void salvarPendente());
      entrada.addEventListener("blur", () => void salvarPendente());
    }
    byId(CAMPOS.conta).addEventListener("change", () => {
      marcarSujo("conta");
      void salvarPendente();
    });
    for (const campo of Object.keys(COMBOS)) {
      const combo = combos[campo] = criarCombo(campo);
      combo.input.addEventListener("input", () => {
        agendarSalvar(campo);
        mostrarOpcoes(combo);
        agendarBusca(combo);
      });
      combo.input.addEventListener("keydown", evento => teclaCombo(combo, evento));
      combo.input.addEventListener("change", () => void salvarPendente());
      combo.input.addEventListener("blur", () => {
        // Busca agendada ou em voo não pode reabrir a lista com o campo sem foco.
        clearTimeout(combo.timer);
        combo.pedido += 1;
        fecharLista(combo);
        void salvarPendente();
        void resolverCampo(combo);
      });
    }
  }

  // ---------------------------------------------------------------- actions

  function atualizarEmailOutlook(equipamento) {
    const botao = byId("btn-enviar-email");
    if (botao) botao.disabled = !equipamento;
  }

  async function abrirEmailOutlook() {
    const equipamento = appState.currentEquipamento;
    if (!equipamento || aberto) return;
    ligarEventos();
    aberto = true;
    const minha = ++geracao;
    config = null;
    modeloId = null;
    byId("email-modelo").replaceChildren();
    for (const campo of Object.keys(CAMPOS)) byId(CAMPOS[campo]).value = "";
    byId("email-nome-pessoa").value = String(equipamento.nome_pessoa || "").trim();
    byId("email-setor").value = "";
    byId("email-aviso-diretorio").hidden = true;
    byId("email-modelo-restaurar").hidden = true;
    for (const combo of Object.values(combos)) reiniciarCombo(combo);
    mostrarAutosave("");
    mostrarStatus("");
    aplicarEstado();
    app.abrirModalAcessivel(MODAL, "#email-modelo", "fecharEmailOutlook");
    try {
      await cadeia; // a save from the previous session must land before the models are read again
      const dados = await chamar("/email/configuracao");
      if (!aberto || geracao !== minha) return;
      if (!Array.isArray(dados?.contas) || !dados.contas.length || !Array.isArray(dados.modelos) || !dados.modelos.length) {
        throw new Error(TEXTO.falha);
      }
      config = dados;
      montarContas();
      montarModelos();
      byId("email-aviso-diretorio").hidden = diretorioDisponivel();
      selecionarModelo(ultimoModelo());
      aplicarEstado();
      byId("email-modelo").focus();
    } catch (erro) {
      if (aberto && geracao === minha) avisar(mensagemDe(erro), "erro");
    }
  }

  // Esc and Cancelar. Anything still unsaved is written first; a failure is reported in a toast (the modal is gone).
  function fecharEmailOutlook() {
    if (!aberto) return undefined;
    const salvando = salvarPendente();
    aberto = false;
    geracao += 1;
    for (const combo of Object.values(combos)) reiniciarCombo(combo);
    app.fecharModalAcessivel(MODAL);
    return salvando;
  }

  function trocarModeloEmail(id) {
    return exclusivo(async () => {
      const minha = geracao;
      if (!id || id === modeloId) return;
      const salvo = await garantirSalvo();
      if (salvo && aberto && geracao === minha) selecionarModelo(id);
      else if (aberto && geracao === minha) byId("email-modelo").value = modeloId; // stays; the autosave line says why
    });
  }

  function criarModelo(copiarDe) {
    return exclusivo(async () => {
      const minha = geracao;
      if (!(await garantirSalvo()) || geracao !== minha) return;
      try {
        const novo = await chamar("/email/modelos", { metodo: "POST", dados: copiarDe ? { copiar_de: copiarDe } : {} });
        if (!aberto || geracao !== minha) return;
        config.modelos.push(novo);
        montarModelos();
        selecionarModelo(novo.id);
        byId(CAMPOS.nome).focus();
        byId(CAMPOS.nome).select?.();
      } catch (erro) {
        if (aberto && geracao === minha) avisar(mensagemDe(erro), "erro");
      }
    });
  }

  const novoModeloEmail = () => criarModelo(null);
  const duplicarModeloEmail = () => criarModelo(modeloId);

  function excluirModeloEmail() {
    return exclusivo(async () => {
      const minha = geracao;
      if (config.modelos.length <= 1) {
        mostrarStatus(TEXTO.ultimoModelo, "aviso");
        return;
      }
      const modelo = config.modelos.find(item => item.id === modeloId);
      const confirmou = await app.confirmarAcao({
        titulo: "Excluir o modelo?",
        mensagem: `O modelo ${modelo.nome} será excluído deste site. Não há como desfazer.`,
        confirmar: "Excluir",
        cancelar: "Cancelar",
        destrutiva: true,
      });
      if (!confirmou || !aberto || geracao !== minha) return;
      try {
        await descartarPendente();
        await chamar(`/email/modelos/${encodeURIComponent(modelo.id)}`, { metodo: "DELETE" });
        if (!aberto || geracao !== minha) return;
        const indice = config.modelos.findIndex(item => item.id === modelo.id);
        config.modelos.splice(indice, 1);
        montarModelos();
        selecionarModelo(config.modelos[Math.min(indice, config.modelos.length - 1)].id);
      } catch (erro) {
        if (aberto && geracao === minha) avisar(mensagemDe(erro), "erro");
      }
    });
  }

  function restaurarModeloEmail() {
    return exclusivo(async () => {
      const minha = geracao;
      if (modeloId !== ID_CABO) return;
      const confirmou = await app.confirmarAcao({
        titulo: "Restaurar o padrão?",
        mensagem: "Para, Cc, Assunto, Mensagem e conta do Modelo 1 - Cabo voltam ao texto original.",
        confirmar: "Restaurar",
        cancelar: "Cancelar",
        destrutiva: true,
      });
      if (!confirmou || !aberto || geracao !== minha) return;
      try {
        await descartarPendente();
        guardarModelo(await chamar(`/email/modelos/${ID_CABO}/restaurar`, { metodo: "POST" }));
        if (!aberto || geracao !== minha) return;
        selecionarModelo(ID_CABO);
      } catch (erro) {
        if (aberto && geracao === minha) avisar(mensagemDe(erro), "erro");
      }
    });
  }

  async function copiarTextoEmail() {
    if (!aberto || !config) return;
    const texto = [substituir(lerCampo("assunto")), substituir(lerCampo("corpo"))].filter(Boolean).join("\n\n");
    try {
      await app.copiarTextoParaAreaTransferencia(texto);
      app.showToast(TEXTO.copiado, "success");
    } catch (erro) {
      app.showToast(erro.message || TEXTO.falha, "error");
    }
  }

  function informarResultado(resposta, modo, linha) {
    const { status, aviso } = resposta || {};
    const sucesso = status === "enviado" ? TEXTO.enviado : status === "aberto" ? TEXTO.aberto : "";
    // A send whose outcome the server could not prove is never reported as sent, nor as a plain failure.
    if (status === "incerto" || (!sucesso && modo === "enviar")) return avisar(aviso || TEXTO.incerto, "aviso", linha);
    if (!sucesso) return avisar(TEXTO.falha, "erro", linha);
    if (!aviso) return avisar(sucesso, "ok", linha);
    return avisar(status === "enviado" ? `${sucesso} ${aviso}` : aviso, "aviso", linha);
  }

  function executarEmail(modo) {
    return exclusivo(async () => {
      const minha = geracao;
      const vigente = () => aberto && geracao === minha;
      await Promise.all(Object.values(combos).map(resolverCampo));
      if (!vigente()) return;
      mostrarStatus("");
      if (modo === "enviar") {
        if (temAmbiguidade()) return mostrarStatus(TEXTO.ambiguo, "aviso");
        if (!lerCampo("para").replace(/;/g, "").trim()) {
          mostrarStatus(TEXTO.semPara, "erro");
          byId(CAMPOS.para).focus();
          return;
        }
        if (marcadorPendente()) return mostrarStatus(TEXTO.marcador, "erro");
        const cc = lerCampo("cc").trim();
        const comCopia = cc.replace(/;/g, "").trim() ? `, com cópia para ${cc}` : "";
        const confirmou = await app.confirmarAcao({
          titulo: "Enviar o e-mail pelo Outlook?",
          mensagem: `O e-mail será enviado de ${emailDaConta()} para ${lerCampo("para").trim()}${comCopia}. Depois de enviado, não há como desfazer.`,
          confirmar: "Enviar",
          cancelar: "Cancelar",
        });
        if (!confirmou || !vigente()) return;
      }
      try {
        const resposta = await chamar("/email", {
          metodo: "POST",
          dados: {
            conta: lerCampo("conta"), para: lerCampo("para"), cc: lerCampo("cc"),
            assunto: lerCampo("assunto"), corpo: lerCampo("corpo"),
            nome: byId("email-nome-pessoa").value, setor: byId("email-setor").value,
            modo, confirmado: modo === "enviar",
          },
        });
        informarResultado(resposta, modo, vigente());
      } catch (erro) {
        // No HTTP status: the answer was lost, so a real send may or may not have gone out.
        if (modo === "enviar" && !erro.status) avisar(TEXTO.incerto, "aviso", vigente());
        else avisar(mensagemDe(erro), "erro", vigente());
      }
    });
  }

  const abrirEmailNoOutlook = () => executarEmail("abrir");
  const enviarEmailPeloOutlook = () => executarEmail("enviar");

  return {
    abrirEmailOutlook, fecharEmailOutlook, atualizarEmailOutlook, trocarModeloEmail, novoModeloEmail,
    duplicarModeloEmail, excluirModeloEmail, restaurarModeloEmail, copiarTextoEmail, abrirEmailNoOutlook,
    enviarEmailPeloOutlook,
  };
});
