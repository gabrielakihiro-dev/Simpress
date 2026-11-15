// Configuração local (Prontidão da base): contas, links, dados do cliente e chaves de IA, em um modal com uma seção por
// grupo. Contrato da API e regras: docs/cockpit-prompts/19-configuracao-local.md.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).configuracaoLocal = factory;
})(typeof window !== "undefined" ? window : globalThis, function createConfiguracaoLocal(context) {
  "use strict";

  const { app } = context;

  const MODAL_ID = "modal-configuracao-local";
  const BOTAO_ID = "btn-configuracao-local";
  const SECOES = ["contas", "links", "cliente", "assistente", "atalhos"];
  const SECOES_COM_SALVAR = ["contas", "links", "cliente", "assistente"];
  const FORMATO_CNPJ = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
  const CABECALHO_JSON = { "Content-Type": "application/json" };
  // As chaves não vêm da API como lista: o servidor só devolve o estado de cada uma pelo identificador.
  const CHAVES_IA = [
    { id: "openrouter", nome: "OpenRouter", ajuda: "Usada pelo Assistente quando não há chave do DeepSeek." },
    { id: "deepseek", nome: "DeepSeek", ajuda: "Se preenchida, vale no lugar do OpenRouter." },
  ];

  let leitura = null;
  let clienteAtual = null;
  let ocupado = false;
  let abrindo = false;

  const el = (id) => document.getElementById(id);

  function criar(tag, className, texto) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (texto !== undefined) node.textContent = texto;
    return node;
  }

  // className em vez de classList: o mesmo código roda no DOM falso dos testes.
  function definirOculto(node, oculto) {
    if (!node) return;
    const classes = String(node.className || "").split(/\s+/).filter((nome) => nome && nome !== "hidden");
    if (oculto) classes.push("hidden");
    node.className = classes.join(" ");
  }

  function mostrarStatus(secao, texto, tipo) {
    const status = el(`cfg-local-status-${secao}`);
    if (!status) return;
    status.textContent = texto || "";
    status.setAttribute("role", tipo === "erro" ? "alert" : "status");
    if (tipo) status.setAttribute("data-status", tipo);
    else status.removeAttribute("data-status");
  }

  function mostrarCarga(texto, erro) {
    const carga = el("cfg-local-carga");
    if (!carga) return;
    carga.textContent = texto || "";
    carga.hidden = !texto;
    carga.setAttribute("role", erro ? "alert" : "status");
  }

  function ligarAjuda(input, ids) {
    input.setAttribute("aria-describedby", ids.join(" "));
  }

  // Campo de texto com rótulo, ajuda e, quando a variável de ambiente manda, aviso de somente leitura.
  function montarCampo({ id, rotulo, ajuda, valor, placeholder, somenteLeitura, invalido }) {
    const campo = criar("div", "ck-campo");
    const label = criar("label", "ck-campo__rotulo", rotulo);
    label.setAttribute("for", id);
    const input = criar("input", "ck-entrada");
    input.setAttribute("id", id);
    input.setAttribute("type", "text");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    input.value = valor || "";
    input.placeholder = placeholder || "";
    input.readOnly = Boolean(somenteLeitura);
    if (invalido) input.setAttribute("aria-invalid", "true");
    campo.append(label, input);
    const descricoes = [];
    if (ajuda) {
      const meta = criar("span", "ckp-meta", ajuda);
      meta.setAttribute("id", `${id}-ajuda`);
      descricoes.push(`${id}-ajuda`);
      campo.append(meta);
    }
    if (somenteLeitura) {
      const aviso = criar("span", "ckp-meta", "Definido por variável de ambiente");
      aviso.setAttribute("id", `${id}-ambiente`);
      descricoes.push(`${id}-ambiente`);
      campo.append(aviso);
    }
    if (descricoes.length) ligarAjuda(input, descricoes);
    return { campo, input };
  }

  function montarCampoConta(conta) {
    const id = `cfg-local-conta-${conta.id}`;
    const { campo } = montarCampo({
      id, rotulo: conta.rotulo, ajuda: conta.ajuda, valor: conta.valor, placeholder: conta.placeholder,
      somenteLeitura: conta.somente_leitura, invalido: conta.valido === false,
    });
    if (typeof conta.usar_no_outlook === "boolean") {
      const extra = criar("div", "ckp-campo__extra");
      const alternar = criar("label", "ckp-alternar");
      const caixa = criar("input");
      caixa.setAttribute("type", "checkbox");
      caixa.setAttribute("id", `cfg-local-outlook-${conta.id}`);
      caixa.checked = conta.usar_no_outlook;
      caixa.disabled = Boolean(conta.somente_leitura);
      alternar.append(caixa, criar("span", "", "Usar também no Outlook"));
      extra.append(alternar);
      campo.append(extra);
    }
    return campo;
  }

  function montarCampoLink(link) {
    return montarCampo({
      id: `cfg-local-link-${link.chave}`, rotulo: link.rotulo, ajuda: link.ajuda, valor: link.valor,
      placeholder: link.placeholder, somenteLeitura: link.somente_leitura, invalido: link.valido === false,
    }).campo;
  }

  // A chave nunca volta do servidor: o campo nasce vazio e mostra só o final como placeholder.
  function montarCampoChave({ id, nome, ajuda }, estado) {
    const inputId = `cfg-local-chave-${id}`;
    const doAmbiente = estado.fonte === "ambiente";
    const campo = criar("div", "ck-campo");
    const label = criar("label", "ck-campo__rotulo", `Chave do ${nome}`);
    label.setAttribute("for", inputId);
    const linha = criar("div", "ck-campo__linha");
    const input = criar("input", "ck-entrada");
    input.setAttribute("id", inputId);
    input.setAttribute("type", "password");
    input.setAttribute("autocomplete", "new-password");
    input.setAttribute("spellcheck", "false");
    input.value = "";
    input.placeholder = estado.configurada ? estado.final || "Configurada" : "Não configurada";
    input.readOnly = doAmbiente;
    linha.append(input);
    if (estado.configurada && !doAmbiente) {
      const remover = criar("button", "ck-btn ck-btn--perigo ck-btn--sm", "Remover chave");
      remover.setAttribute("type", "button");
      remover.setAttribute("aria-label", `Remover chave do ${nome}`);
      remover.setAttribute("data-on-click", "removerChaveAssistenteConfiguracaoLocal");
      remover.setAttribute("data-args", JSON.stringify([id]));
      linha.append(remover);
    }
    const situacao = doAmbiente
      ? "Definida por variável de ambiente. Não dá para trocar por aqui."
      : estado.configurada ? "Chave configurada." : "Sem chave configurada.";
    const meta = criar("span", "ckp-meta", `${situacao} ${ajuda}`);
    meta.setAttribute("id", `${inputId}-ajuda`);
    ligarAjuda(input, [`${inputId}-ajuda`]);
    campo.append(label, linha, meta);
    return campo;
  }

  function renderizarContas() {
    el("cfg-local-contas").replaceChildren(...leitura.contas.map(montarCampoConta));
    mostrarStatus("contas", leitura.contas_arquivo_invalido
      ? "O arquivo de contas está inválido. Ao salvar, ele é regravado." : "", leitura.contas_arquivo_invalido ? "erro" : "");
  }

  function renderizarLinks() {
    el("cfg-local-links").replaceChildren(...leitura.links.map(montarCampoLink));
  }

  function renderizarChaves() {
    const assistente = leitura.assistente || {};
    el("cfg-local-chaves").replaceChildren(...CHAVES_IA.map((chave) => montarCampoChave(chave, assistente[chave.id] || {})));
  }

  function renderizarCliente() {
    const dados = clienteAtual || {};
    const fontes = dados.cliente_fontes || {};
    [["cfg-local-contrato", "contrato"], ["cfg-local-cnpj", "cnpj_faturamento"]].forEach(([id, chave]) => {
      const input = el(id);
      input.value = typeof dados[chave] === "string" ? dados[chave] : "";
      input.readOnly = fontes[chave] === "ambiente";
    });
    const series = el("cfg-local-series");
    series.value = Array.isArray(dados.series_sebrae_fora) ? dados.series_sebrae_fora.join("\n") : "";
    series.readOnly = fontes.series_sebrae_fora === "ambiente";
    el("cfg-local-cliente-ambiente").hidden = !Object.values(fontes).includes("ambiente");
    if (!clienteAtual) mostrarStatus("cliente", "Não foi possível ler os dados atuais. Preencha os campos e salve.", "erro");
    else if (leitura.cliente?.arquivo_invalido) mostrarStatus("cliente", "O arquivo do cliente está inválido. Ao salvar, ele é regravado.", "erro");
    else mostrarStatus("cliente", "");
  }

  function renderizarTudo() {
    renderizarContas();
    renderizarLinks();
    renderizarCliente();
    renderizarChaves();
    // Contas e cliente definem o próprio aviso ao se desenhar; as outras seções começam sem recado antigo.
    ["links", "assistente"].forEach((secao) => mostrarStatus(secao, ""));
    SECOES.forEach((secao) => definirOculto(el(`cfg-local-secao-${secao}`), false));
    definirOculto(el("cfg-local-secao-atalhos"), typeof app.abrirConfiguracaoContatoOrigem !== "function");
  }

  async function carregar() {
    const [local, cliente] = await Promise.all([
      app.apiFetch("/api/config/local", { errorMessage: "Não foi possível ler a configuração local." }),
      app.apiFetch("/api/config/cliente").catch(() => null),
    ]);
    leitura = local;
    clienteAtual = cliente;
  }

  function alvoDoFoco() {
    const conta = leitura?.contas.find((item) => !item.somente_leitura);
    if (conta) return `#cfg-local-conta-${conta.id}`;
    const link = leitura?.links.find((item) => !item.somente_leitura);
    if (link) return `#cfg-local-link-${link.chave}`;
    return leitura ? "#cfg-local-contrato" : ".ckp-cab__acoes .ck-btn";
  }

  async function abrirConfiguracaoLocal() {
    if (abrindo || ocupado) return;
    abrindo = true;
    try {
      try {
        await carregar();
        mostrarCarga("");
        renderizarTudo();
      } catch (error) {
        leitura = null;
        SECOES.forEach((secao) => definirOculto(el(`cfg-local-secao-${secao}`), true));
        mostrarCarga(error.message || "Não foi possível ler a configuração local.", true);
      }
      app.abrirModalAcessivel(MODAL_ID, alvoDoFoco(), "fecharConfiguracaoLocal");
    } finally {
      abrindo = false;
    }
  }

  function fecharConfiguracaoLocal() {
    if (ocupado) return;
    app.fecharModalAcessivel(MODAL_ID);
    // O painel de prontidão se redesenha (foco da janela, 45 s, salvamento) e pode ter trocado o botão.
    globalThis.requestAnimationFrame(() => el(BOTAO_ID)?.focus());
  }

  function erroDeCampo(input, mensagem) {
    const erro = new Error(mensagem);
    erro.campo = input;
    return erro;
  }

  // Uma gravação por vez; o botão da seção e os das outras seções ficam desligados enquanto espera.
  async function salvarSecao(secao, tarefa) {
    if (ocupado || !leitura) return;
    ocupado = true;
    const modal = el(MODAL_ID);
    SECOES_COM_SALVAR.forEach((nome) => { const botao = el(`cfg-local-salvar-${nome}`); if (botao) botao.disabled = true; });
    modal?.setAttribute("aria-busy", "true");
    mostrarStatus(secao, "Salvando…");
    try {
      const mensagem = await tarefa();
      mostrarStatus(secao, mensagem, "ok");
      app.showToast(mensagem, "success");
      app.carregarProntidao?.();
    } catch (error) {
      mostrarStatus(secao, error.message || "Não foi possível salvar.", "erro");
      error.campo?.focus();
    } finally {
      ocupado = false;
      SECOES_COM_SALVAR.forEach((nome) => { const botao = el(`cfg-local-salvar-${nome}`); if (botao) botao.disabled = false; });
      modal?.removeAttribute("aria-busy");
    }
  }

  // Os dois grupos (contas e links) vão no mesmo PUT; o grupo que não está sendo salvo vai em branco e fica como está.
  function corpoContas({ contas, links }) {
    const corpo = { links: {} };
    leitura.contas.forEach((conta) => {
      const input = el(`cfg-local-conta-${conta.id}`);
      corpo[conta.id] = contas && input && !input.readOnly ? input.value.trim() : "";
      if (typeof conta.usar_no_outlook === "boolean") {
        corpo[conta.id.replace("conta_", "usar_no_outlook_")] = Boolean(el(`cfg-local-outlook-${conta.id}`)?.checked);
      }
    });
    if (links) {
      leitura.links.forEach((link) => {
        const input = el(`cfg-local-link-${link.chave}`);
        if (input && !input.readOnly) corpo.links[link.chave] = input.value.trim();
      });
    }
    return corpo;
  }

  async function gravarContasELinks(grupos, mensagem, renderizar) {
    leitura = await app.apiFetch("/api/config/local/contas", {
      method: "PUT",
      headers: CABECALHO_JSON,
      body: JSON.stringify(corpoContas(grupos)),
      errorMessage: "Não foi possível salvar a configuração local.",
    });
    renderizar();
    return mensagem;
  }

  function salvarContasConfiguracaoLocal() {
    return salvarSecao("contas", () => gravarContasELinks({ contas: true }, "Contas salvas.", renderizarContas));
  }

  function salvarLinksConfiguracaoLocal() {
    return salvarSecao("links", () => gravarContasELinks({ links: true }, "Links salvos.", renderizarLinks));
  }

  function salvarClienteConfiguracaoLocal() {
    return salvarSecao("cliente", async () => {
      const contrato = el("cfg-local-contrato");
      const cnpj = el("cfg-local-cnpj");
      const series = el("cfg-local-series");
      // Valor vindo do ambiente fica fora do arquivo local: o servidor mantém o do ambiente na frente.
      if (!contrato.readOnly && !/^\d{1,12}$/.test(contrato.value.trim())) {
        throw erroDeCampo(contrato, 'Informe o "Contrato" só com números (até 12 dígitos).');
      }
      if (!cnpj.readOnly && !FORMATO_CNPJ.test(cnpj.value.trim())) {
        throw erroDeCampo(cnpj, 'Informe o "CNPJ de faturamento" no formato 00.000.000/0000-00.');
      }
      clienteAtual = await app.apiFetch("/api/config/cliente", {
        method: "PUT",
        headers: CABECALHO_JSON,
        body: JSON.stringify({
          contrato: contrato.readOnly ? "" : contrato.value.trim(),
          cnpj_faturamento: cnpj.readOnly ? "" : cnpj.value.trim(),
          // null mantém a lista guardada (também quando o ambiente a fornece).
          series_sebrae_fora: series.readOnly ? null : series.value.split(/[\s,;]+/).filter(Boolean),
        }),
        errorMessage: "Não foi possível salvar os dados do cliente.",
      });
      renderizarCliente();
      app.carregarConfiguracaoTransferencia?.();
      return "Dados do cliente salvos.";
    });
  }

  // A chave digitada sai do campo em qualquer desfecho: depois de enviada, ela não fica na tela.
  function limparCamposDeChave() {
    CHAVES_IA.forEach(({ id }) => {
      const input = el(`cfg-local-chave-${id}`);
      if (input) input.value = "";
    });
  }

  function salvarAssistenteConfiguracaoLocal() {
    return salvarSecao("assistente", async () => {
      const corpo = {};
      CHAVES_IA.forEach(({ id }) => {
        const input = el(`cfg-local-chave-${id}`);
        const valor = input && !input.readOnly ? input.value.trim() : "";
        if (valor) corpo[`${id}_api_key`] = valor;
      });
      if (!Object.keys(corpo).length) return "Nenhuma chave nova digitada. As chaves atuais foram mantidas.";
      try {
        leitura.assistente = await app.apiFetch("/api/config/local/assistente", {
          method: "PUT",
          headers: CABECALHO_JSON,
          body: JSON.stringify(corpo),
          errorMessage: "Não foi possível salvar a chave.",
        });
      } finally {
        limparCamposDeChave();
      }
      renderizarChaves();
      return "Chave salva.";
    });
  }

  async function removerChaveAssistenteConfiguracaoLocal(id) {
    const chave = CHAVES_IA.find((item) => item.id === id);
    if (!chave || ocupado) return;
    const confirmou = await app.confirmarAcao({
      titulo: "Remover chave?",
      mensagem: `Remover a chave do ${chave.nome}? O Assistente com IA pode parar de responder até você informar outra chave.`,
      confirmar: "Remover chave",
    });
    if (!confirmou) return;
    await salvarSecao("assistente", async () => {
      leitura.assistente = await app.apiFetch(`/api/config/local/assistente/${chave.id}`, {
        method: "DELETE",
        errorMessage: "Não foi possível remover a chave.",
      });
      renderizarChaves();
      el(`cfg-local-chave-${chave.id}`)?.focus();
      return `Chave do ${chave.nome} removida.`;
    });
  }

  return {
    abrirConfiguracaoLocal, fecharConfiguracaoLocal,
    salvarContasConfiguracaoLocal, salvarLinksConfiguracaoLocal,
    salvarClienteConfiguracaoLocal, salvarAssistenteConfiguracaoLocal,
    removerChaveAssistenteConfiguracaoLocal,
  };
});
