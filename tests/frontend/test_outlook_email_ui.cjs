const test = require("node:test");
const { assert, fs, path, appHtml, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");

const ULTIMO_MODELO = "simpress.outlook-email.ultimo-modelo";
const MSG_INCERTO = "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.";
const CONTAS = [
  { id: "conta-a", email: "conta@exemplo.test", rotulo: "Conta A", padrao: true },
  { id: "conta-b", email: "outra@exemplo.test", rotulo: "Conta B", padrao: false },
];
const EQUIPAMENTO = { serial: "SERIE-TESTE", nome_pessoa: "Pessoa Teste" };
const CONTATO = { nome: "Pessoa Teste", email: "teste@exemplo.test" };
const esvaziar = () => new Promise(resolve => setImmediate(resolve));
// Objects built inside the vm realm have another prototype; a JSON copy compares by value.
const plano = valor => JSON.parse(JSON.stringify(valor));

const modelo = (id, nome, extra = {}) => ({
  id, nome, conta: "conta-a", para: "", cc: "", assunto: `Assunto ${nome}`, corpo: `Corpo ${nome} {nome} {setor}`,
  atualizado_em: "2026-11-10T10:00:00", ...extra,
});
const erro = (status, detail, codigo) => apiResponse({ detail, codigo }, { status });

// Fake Outlook backend: `rotas` maps "METODO /caminho" (query removed) to a function returning a body or a response.
function preparar({ rotas = {}, modelos, diretorio = { disponivel: true, total: 3 } } = {}) {
  const lista = modelos || [modelo("cabo", "Modelo 1 - Cabo", { para: "teste@exemplo.test" }), modelo("m2", "Modelo 2")];
  const chamadas = [];
  const padrao = { "GET /api/outlook/email/configuracao": () => ({ contas: CONTAS, modelos: lista, diretorio }) };
  const harness = createAppHarness((url, options = {}) => {
    const metodo = options.method || "GET";
    const corpo = options.body ? JSON.parse(options.body) : undefined;
    chamadas.push({ metodo, url, corpo });
    const chave = `${metodo} ${url.split("?")[0]}`;
    let rota = rotas[chave] || padrao[chave];
    const salvar = chave.match(/^PUT \/api\/outlook\/email\/modelos\/([^/]+)$/);
    if (!rota && salvar) rota = () => Object.assign(lista.find(item => item.id === salvar[1]), corpo);
    if (!rota) return Promise.reject(new Error(`rota inesperada: ${chave}`));
    return Promise.resolve(rota(corpo, url)).then(resposta => (
      resposta && typeof resposta.ok === "boolean" ? resposta : apiResponse(JSON.parse(JSON.stringify(resposta ?? {})))
    ));
  });
  // Fake timers: the autosave (800 ms) and the contact search (200 ms) only run when the test says so.
  const timers = new Map();
  let proximo = 0;
  harness.context.fakeSetTimeout = (funcao, ms) => { timers.set(++proximo, { funcao, ms }); return proximo; };
  harness.context.fakeClearTimeout = id => timers.delete(id);
  // The fake document follows focus() in activeElement; the page-leave handlers are kept to be fired by the tests.
  const { document: documento, window: janela } = harness.context;
  const buscarNo = documento.getElementById;
  documento.getElementById = id => {
    const no = buscarNo.call(documento, id);
    if (!no.focoRastreado) {
      no.focoRastreado = true;
      no.focus = function focar() { this.focused = true; documento.activeElement = this; };
    }
    return no;
  };
  const aoSair = [];
  janela.addEventListener = (tipo, ouvinte) => { if (tipo === "beforeunload") aoSair.push(ouvinte); };
  const aberturas = [];
  const fechamentos = [];
  const confirmacoes = [];
  harness.context.aberturas = aberturas;
  harness.context.fechamentos = fechamentos;
  harness.context.confirmacoes = confirmacoes;
  harness.context.respostaConfirmacao = true;
  harness.run(`setTimeout = fakeSetTimeout;
    clearTimeout = fakeClearTimeout;
    abrirModalAcessivel = (...args) => aberturas.push(args);
    fecharModalAcessivel = id => fechamentos.push(id);
    confirmarAcao = async opcoes => { confirmacoes.push(opcoes); return respostaConfirmacao; };`);
  return {
    harness, chamadas, aberturas, fechamentos, confirmacoes, modelos: lista,
    el: id => harness.element(id),
    // Calls of one method to one path (query ignored); an empty path means every path.
    de: (metodo, caminho) => chamadas.filter(item => item.metodo === metodo && (!caminho || item.url.split("?")[0] === `/api/outlook${caminho}`)),
    pendentes: () => [...timers.values()].map(item => item.ms),
    // Fires beforeunload and returns the event: defaultPrevented tells whether the browser would ask to stay.
    sair() {
      const evento = { defaultPrevented: false, returnValue: undefined, preventDefault() { this.defaultPrevented = true; } };
      aoSair.forEach(ouvinte => ouvinte(evento));
      return evento;
    },
    focado: () => documento.activeElement?.id,
    async avancar() {
      const todos = [...timers.values()];
      timers.clear();
      for (const { funcao } of todos) funcao();
      await esvaziar();
    },
    async abrir() {
      harness.selectEquipment(EQUIPAMENTO);
      await harness.run("abrirEmailOutlook()");
    },
    digitar(id, valor) {
      const campo = harness.element(id);
      campo.value = valor;
      campo.dispatchEvent("input");
    },
    tecla(id, key) {
      const evento = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
      for (const ouvinte of harness.element(id).listeners.get("keydown") || []) ouvinte(evento);
      return evento;
    },
    async preencherEnvio({ para = "teste@exemplo.test", cc = "", setor = "TI" } = {}) {
      harness.element("email-para").value = para;
      harness.element("email-cc").value = cc;
      harness.element("email-setor").value = setor;
    },
  };
}

test("Enviar e-mail button follows the selected equipment", () => {
  const app = preparar();
  app.harness.run("definirEquipamentoAtual(null)");
  assert.equal(app.el("btn-enviar-email").disabled, true);
  app.harness.selectEquipment(EQUIPAMENTO);
  assert.equal(app.el("btn-enviar-email").disabled, false);
  app.harness.run("definirEquipamentoAtual(null)");
  assert.equal(app.el("btn-enviar-email").disabled, true);
});

test("opening without a selected equipment does nothing", async () => {
  const app = preparar();
  app.harness.run("definirEquipamentoAtual(null)");
  await app.harness.run("abrirEmailOutlook()");
  assert.equal(app.aberturas.length, 0);
  assert.equal(app.chamadas.length, 0);
});

test("opening loads the models, accounts and prefills Nome da pessoa from the equipment", async () => {
  const app = preparar();
  await app.abrir();
  assert.deepEqual(plano(app.aberturas), [["modal-email-outlook", "#email-modelo", "fecharEmailOutlook"]]);
  assert.deepEqual(app.chamadas.map(item => `${item.metodo} ${item.url}`), ["GET /api/outlook/email/configuracao"]);
  assert.deepEqual(app.el("email-modelo").children.map(item => [item.value, item.textContent]), [["cabo", "Modelo 1 - Cabo"], ["m2", "Modelo 2"]]);
  assert.deepEqual(app.el("email-conta").children.map(item => [item.value, item.textContent]), [
    ["conta-a", "Conta A (conta@exemplo.test)"], ["conta-b", "Conta B (outra@exemplo.test)"],
  ]);
  assert.equal(app.el("email-modelo").value, "cabo");
  assert.equal(app.el("email-modelo-nome").value, "Modelo 1 - Cabo");
  assert.equal(app.el("email-conta").value, "conta-a");
  assert.equal(app.el("email-para").value, "teste@exemplo.test");
  assert.equal(app.el("email-nome-pessoa").value, "Pessoa Teste");
  assert.equal(app.el("email-setor").value, "");
  assert.equal(app.el("email-modelo-restaurar").hidden, false);
  assert.equal(app.el("email-aviso-diretorio").hidden, true);
  for (const id of ["email-para", "email-cc", "email-assunto", "email-corpo", "email-abrir", "email-enviar", "email-copiar"]) {
    assert.equal(app.el(id).disabled, false, id);
  }
  assert.equal(app.el("email-modelo").focused, true);
});

test("opening remembers the last model and reports a load failure from the server", async () => {
  const lembrado = preparar();
  lembrado.harness.localStorage.set(ULTIMO_MODELO, "m2");
  await lembrado.abrir();
  assert.equal(lembrado.el("email-modelo").value, "m2");
  assert.equal(lembrado.el("email-modelo-restaurar").hidden, true);

  const falha = preparar({ rotas: { "GET /api/outlook/email/configuracao": () => erro(503, "O arquivo de modelos de e-mail está ocupado no momento. Tente novamente em instantes.", "modelos_ocupados") } });
  await falha.abrir();
  assert.equal(falha.el("email-status").textContent, "O arquivo de modelos de e-mail está ocupado no momento. Tente novamente em instantes.");
  assert.equal(falha.el("email-status").dataset.tipo, "erro");
  assert.equal(falha.el("email-enviar").disabled, true);
});

test("a configuration that arrives after the modal was closed is ignored", async () => {
  let entregar;
  const app = preparar({ rotas: { "GET /api/outlook/email/configuracao": () => new Promise(resolve => { entregar = resolve; }) } });
  app.harness.selectEquipment(EQUIPAMENTO);
  const abertura = app.harness.run("abrirEmailOutlook()");
  await esvaziar();
  app.harness.run("fecharEmailOutlook()");
  entregar({ contas: CONTAS, modelos: [modelo("cabo", "Modelo 1 - Cabo")], diretorio: { disponivel: true, total: 1 } });
  await abertura;
  assert.equal(app.el("email-modelo").children.length, 0);
  assert.equal(app.el("email-assunto").value, "");
  assert.deepEqual(app.fechamentos, ["modal-email-outlook"]);
});

test("switching the model loads the whole model without saving untouched fields", async () => {
  const app = preparar({ modelos: [modelo("cabo", "Modelo 1 - Cabo", { para: "teste@exemplo.test", cc: "copia@exemplo.test", conta: "conta-b" }), modelo("m2", "Modelo 2", { corpo: "Texto do segundo" })] });
  await app.abrir();
  assert.equal(app.el("email-cc").value, "copia@exemplo.test");
  assert.equal(app.el("email-conta").value, "conta-b");
  await app.harness.run('trocarModeloEmail("m2")');
  assert.equal(app.el("email-modelo").value, "m2");
  assert.equal(app.el("email-modelo-nome").value, "Modelo 2");
  assert.equal(app.el("email-para").value, "");
  assert.equal(app.el("email-cc").value, "");
  assert.equal(app.el("email-conta").value, "conta-a");
  assert.equal(app.el("email-assunto").value, "Assunto Modelo 2");
  assert.equal(app.el("email-corpo").value, "Texto do segundo");
  assert.equal(app.el("email-modelo-restaurar").hidden, true);
  assert.equal(app.harness.localStorage.get(ULTIMO_MODELO), "m2");
  assert.equal(app.de("PUT", "").length, 0);
});

test("typing marks the model as unsaved and saves after 800 ms, only the edited field", async () => {
  const app = preparar();
  await app.abrir();
  app.digitar("email-assunto", "Assunto novo");
  assert.equal(app.el("email-autosave-status").textContent, "Alteração ainda não salva…");
  assert.equal(app.de("PUT", "").length, 0);
  assert.deepEqual(app.pendentes(), [800]);
  await app.avancar();
  const [gravacao] = app.de("PUT", "/email/modelos/cabo");
  assert.deepEqual(gravacao.corpo, { assunto: "Assunto novo" });
  assert.equal(app.el("email-autosave-status").textContent, "Salva.");
  assert.notEqual(app.el("email-autosave-status").dataset.estado, "erro");
});

test("change and blur save at once and cancel the pending timer", async () => {
  const app = preparar();
  await app.abrir();
  app.digitar("email-corpo", "Corpo novo");
  app.el("email-corpo").dispatchEvent("change");
  await esvaziar();
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").map(item => item.corpo), [{ corpo: "Corpo novo" }]);
  assert.deepEqual(app.pendentes(), []);
  app.digitar("email-modelo-nome", "Nome novo");
  app.el("email-modelo-nome").dispatchEvent("blur");
  await esvaziar();
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").at(-1).corpo, { nome: "Nome novo" });
  assert.equal([...app.el("email-modelo").children].find(item => item.value === "cabo").textContent, "Nome novo");
  app.el("email-conta").value = "conta-b";
  app.el("email-conta").dispatchEvent("change");
  await esvaziar();
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").at(-1).corpo, { conta: "conta-b" });
});

test("a pending change is saved before the model switch and a failed save keeps the model", async () => {
  const app = preparar();
  await app.abrir();
  app.digitar("email-assunto", "Assunto pendente");
  await app.harness.run('trocarModeloEmail("m2")');
  const ordem = app.chamadas.map(item => `${item.metodo} ${item.url}`);
  assert.deepEqual(ordem, ["GET /api/outlook/email/configuracao", "PUT /api/outlook/email/modelos/cabo"]);
  assert.equal(app.el("email-modelo").value, "m2");
  assert.equal(app.el("email-assunto").value, "Assunto Modelo 2");

  const recusa = preparar({ rotas: { "PUT /api/outlook/email/modelos/cabo": () => erro(422, "Já existe um modelo com esse nome.", "nome_duplicado") } });
  await recusa.abrir();
  recusa.digitar("email-modelo-nome", "Modelo 2");
  await recusa.harness.run('trocarModeloEmail("m2")');
  assert.equal(recusa.el("email-modelo").value, "cabo");
  assert.equal(recusa.el("email-modelo-nome").value, "Modelo 2");
  assert.equal(recusa.el("email-autosave-status").textContent, "Não foi possível salvar: Já existe um modelo com esse nome.");
  assert.equal(recusa.el("email-autosave-status").dataset.estado, "erro");
});

test("closing saves what is pending and reports a failed save in a toast", async () => {
  const app = preparar();
  await app.abrir();
  app.digitar("email-assunto", "Assunto no fim");
  await app.harness.run("fecharEmailOutlook()");
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").map(item => item.corpo), [{ assunto: "Assunto no fim" }]);
  assert.deepEqual(app.fechamentos, ["modal-email-outlook"]);

  const falha = preparar({ rotas: { "PUT /api/outlook/email/modelos/cabo": () => erro(503, "Não foi possível gravar o modelo de e-mail. Nada foi alterado; tente de novo.", "modelos_gravacao") } });
  await falha.abrir();
  falha.digitar("email-assunto", "Assunto perdido");
  await falha.harness.run("fecharEmailOutlook()");
  assert.deepEqual(plano(falha.harness.effects.toasts), [{
    message: "Não foi possível salvar: Não foi possível gravar o modelo de e-mail. Nada foi alterado; tente de novo.", type: "error",
  }]);
});

test("a rejected field does not lose the others: each dirty field is saved in its own PUT and the failed one stays dirty", async () => {
  const lista = [modelo("cabo", "Modelo 1 - Cabo"), modelo("m2", "Modelo 2")];
  const app = preparar({
    modelos: lista,
    rotas: { "PUT /api/outlook/email/modelos/cabo": corpo => ("nome" in corpo ? erro(422, "Já existe um modelo com esse nome.", "nome_duplicado") : Object.assign(lista[0], corpo)) },
  });
  await app.abrir();
  app.digitar("email-modelo-nome", "Modelo 2");
  app.digitar("email-corpo", "Corpo que não pode se perder");
  await app.harness.run('trocarModeloEmail("m2")');
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").map(item => item.corpo), [{ nome: "Modelo 2" }, { corpo: "Corpo que não pode se perder" }]);
  assert.equal(lista[0].corpo, "Corpo que não pode se perder");
  assert.equal(app.el("email-modelo").value, "cabo");
  assert.equal(app.el("email-autosave-status").textContent, "Não foi possível salvar: Já existe um modelo com esse nome.");
  assert.equal(app.el("email-autosave-status").dataset.estado, "erro");

  // Only the rejected field is sent again; the saved one is not.
  await app.harness.run('trocarModeloEmail("m2")');
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").map(item => item.corpo).slice(2), [{ nome: "Modelo 2" }]);
  assert.equal(await app.harness.run("fecharEmailOutlook()"), false);
});

test("leaving the page warns while a change is unsaved, a save runs or an action runs", async () => {
  const app = preparar();
  await app.abrir();
  assert.equal(app.sair().defaultPrevented, false);
  app.digitar("email-corpo", "Corpo novo");
  const aviso = app.sair();
  assert.equal(aviso.defaultPrevented, true);
  assert.equal(aviso.returnValue, "");
  await app.avancar();
  assert.equal(app.sair().defaultPrevented, false);
  await app.harness.run("fecharEmailOutlook()");
  assert.equal(app.sair().defaultPrevented, false);

  let concluirGravacao;
  const lenta = preparar({ rotas: { "PUT /api/outlook/email/modelos/cabo": () => new Promise(resolve => { concluirGravacao = resolve; }) } });
  await lenta.abrir();
  lenta.digitar("email-corpo", "Corpo em voo");
  await lenta.avancar();
  assert.equal(lenta.de("PUT", "/email/modelos/cabo").length, 1);
  assert.equal(lenta.sair().defaultPrevented, true);
  concluirGravacao({});
  await esvaziar();
  assert.equal(lenta.sair().defaultPrevented, false);

  let concluirEnvio;
  const acao = preparar({ rotas: { "POST /api/outlook/email": () => new Promise(resolve => { concluirEnvio = resolve; }) } });
  await acao.abrir();
  const execucao = acao.harness.run("abrirEmailNoOutlook()");
  await esvaziar();
  assert.equal(acao.de("POST", "/email").length, 1);
  assert.equal(acao.sair().defaultPrevented, true);
  await acao.harness.run("fecharEmailOutlook()"); // Esc during a slow send: a reload could still lose its result
  assert.equal(acao.sair().defaultPrevented, true);
  concluirEnvio({ status: "aberto", conta: "conta@exemplo.test" });
  await execucao;
  assert.equal(acao.sair().defaultPrevented, false);
});

test("a slow action that ends after close and reopen does not take the focus from the new session", async () => {
  let concluir;
  const app = preparar({ rotas: { "POST /api/outlook/email": () => new Promise(resolve => { concluir = resolve; }) } });
  await app.abrir();
  assert.equal(app.focado(), "email-modelo");
  const execucao = app.harness.run("abrirEmailNoOutlook()");
  await esvaziar();
  assert.equal(app.de("POST", "/email").length, 1);
  await app.harness.run("fecharEmailOutlook()");
  await app.abrir();
  app.el("email-corpo").focus();
  concluir({ status: "aberto", conta: "conta@exemplo.test" });
  await execucao;
  assert.equal(app.focado(), "email-corpo");
  // The old result goes to a toast only: the status line of the new session stays clean.
  assert.equal(app.el("email-status").textContent, "");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: "E-mail aberto no Outlook. Revise e envie por lá.", type: "success" });
});

test("Para suggests Entra contacts with keyboard and ARIA support", async () => {
  const app = preparar({ rotas: { "GET /api/outlook/contatos": () => ({ contatos: [CONTATO, { nome: "Pessoa Dois", email: "dois@exemplo.test" }] }) } });
  await app.abrir();
  app.digitar("email-para", "Pes");
  assert.equal(app.de("GET", "/contatos").length, 0);
  await app.avancar();
  const [busca] = app.de("GET", "/contatos");
  assert.equal(busca.url, "/api/outlook/contatos?q=Pes");
  const lista = app.el("email-para-lista");
  assert.equal(lista.hidden, false);
  assert.equal(app.el("email-para").attributes.get("aria-expanded"), "true");
  assert.deepEqual(lista.children.map(item => item.textContent), ["Pessoa Teste <teste@exemplo.test>", "Pessoa Dois <dois@exemplo.test>"]);
  assert.deepEqual(lista.children.map(item => item.attributes.get("role")), ["option", "option"]);
  assert.deepEqual(lista.children.map(item => item.id), ["email-para-opcao-0", "email-para-opcao-1"]);

  assert.equal(app.tecla("email-para", "ArrowDown").prevented, true);
  assert.equal(app.el("email-para").attributes.get("aria-activedescendant"), "email-para-opcao-0");
  assert.deepEqual(lista.children.map(item => item.attributes.get("aria-selected")), ["true", "false"]);
  app.tecla("email-para", "ArrowUp");
  assert.equal(app.el("email-para").attributes.get("aria-activedescendant"), "email-para-opcao-1");
  app.tecla("email-para", "ArrowDown");
  assert.equal(app.el("email-para").attributes.get("aria-activedescendant"), "email-para-opcao-0");
  const enter = app.tecla("email-para", "Enter");
  assert.equal(enter.prevented, true);
  assert.equal(app.el("email-para").value, "Pessoa Teste <teste@exemplo.test>; ");
  assert.equal(lista.hidden, true);
  assert.equal(app.el("email-para").attributes.get("aria-expanded"), "false");
  assert.equal(app.el("email-para").attributes.has("aria-activedescendant"), false);
  await esvaziar();
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").at(-1).corpo, { para: "Pessoa Teste <teste@exemplo.test>; " });
});

test("Enter without an active option is left alone and Esc closes the list before the dialog", async () => {
  const app = preparar({ rotas: { "GET /api/outlook/contatos": () => ({ contatos: [CONTATO] }) } });
  await app.abrir();
  app.digitar("email-cc", "Pess");
  await app.avancar();
  assert.equal(app.el("email-cc-lista").hidden, false);
  assert.equal(app.tecla("email-cc", "Enter").prevented, false);
  const primeiro = app.tecla("email-cc", "Escape");
  assert.deepEqual([primeiro.prevented, primeiro.stopped], [true, true]);
  assert.equal(app.el("email-cc-lista").hidden, true);
  const segundo = app.tecla("email-cc", "Escape");
  assert.deepEqual([segundo.prevented, segundo.stopped], [false, false]);
});

test("the contact search needs two characters, skips e-mail addresses and uses the last name after a semicolon", async () => {
  const app = preparar({ rotas: { "GET /api/outlook/contatos": () => ({ contatos: [] }) } });
  await app.abrir();
  app.digitar("email-para", "P");
  await app.avancar();
  app.digitar("email-para", "teste@exemplo.test");
  await app.avancar();
  assert.equal(app.de("GET", "/contatos").length, 0);
  app.digitar("email-para", "teste@exemplo.test; Pes");
  await app.avancar();
  assert.deepEqual(app.de("GET", "/contatos").map(item => item.url), ["/api/outlook/contatos?q=Pes"]);
  const [vazio] = app.el("email-para-lista").children;
  assert.equal(app.el("email-para-lista").children.length, 1);
  assert.equal(vazio.textContent, "Nenhum contato encontrado no Entra.");
  assert.equal(vazio.attributes.get("aria-disabled"), "true");
  assert.equal(app.tecla("email-para", "Enter").prevented, false);
});

test("an older contact answer never replaces the newer one", async () => {
  const pendentes = {};
  const app = preparar({ rotas: { "GET /api/outlook/contatos": (corpo, url) => (url.endsWith("q=Pe") ? new Promise(resolve => { pendentes.antiga = resolve; }) : { contatos: [CONTATO] }) } });
  await app.abrir();
  app.digitar("email-para", "Pe");
  await app.avancar();
  app.digitar("email-para", "Pess");
  await app.avancar();
  assert.deepEqual(app.el("email-para-lista").children.map(item => item.textContent), ["Pessoa Teste <teste@exemplo.test>"]);
  pendentes.antiga({ contatos: [{ nome: "Pessoa Velha", email: "velha@exemplo.test" }] });
  await esvaziar();
  assert.deepEqual(app.el("email-para-lista").children.map(item => item.textContent), ["Pessoa Teste <teste@exemplo.test>"]);
});

test("leaving Para turns a single Entra match into Name <address> and saves it", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/contatos/resolver": () => ({ resultados: [{ token: "Pessoa Teste", status: "unico", email: "teste@exemplo.test", nome: "Pessoa Teste" }] }) } });
  await app.abrir();
  app.el("email-para").value = "Pessoa Teste; outra@exemplo.test";
  app.el("email-para").dispatchEvent("blur");
  await esvaziar();
  assert.deepEqual(app.de("POST", "/contatos/resolver")[0].corpo, { tokens: ["Pessoa Teste"] });
  assert.equal(app.el("email-para").value, "Pessoa Teste <teste@exemplo.test>; outra@exemplo.test");
  assert.deepEqual(app.de("PUT", "/email/modelos/cabo").at(-1).corpo, { para: "Pessoa Teste <teste@exemplo.test>; outra@exemplo.test" });
});

test("an ambiguous name asks which person and blocks Enviar until chosen", async () => {
  const opcoes = [{ nome: "Pessoa Um", email: "um@exemplo.test" }, { nome: "Pessoa Dois", email: "dois@exemplo.test" }];
  const app = preparar({ rotas: { "POST /api/outlook/contatos/resolver": () => ({ resultados: [{ token: "Pessoa", status: "ambiguo", opcoes }] }) } });
  await app.abrir();
  app.el("email-para").value = "Pessoa";
  app.el("email-para").dispatchEvent("blur");
  await esvaziar();
  const caixa = app.el("email-para-opcoes");
  assert.equal(caixa.hidden, false);
  const [pergunta, botoes] = caixa.children[0].children;
  assert.equal(pergunta.textContent, 'Escolha o destinatário certo para "Pessoa":');
  assert.deepEqual(botoes.children.map(item => item.textContent), ["Pessoa Um <um@exemplo.test>", "Pessoa Dois <dois@exemplo.test>"]);
  assert.equal(app.el("email-para").value, "Pessoa");

  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, "Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.");
  assert.equal(app.de("POST", "/email").length, 0);
  assert.equal(app.confirmacoes.length, 0);

  botoes.children[1].listeners.get("click")[0]();
  assert.equal(app.el("email-para").value, "Pessoa Dois <dois@exemplo.test>");
  assert.equal(caixa.hidden, true);
  assert.equal(caixa.children.length, 0);
});

test("Abrir no Outlook posts without confirmation and reports the approved text", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "aberto", conta: "conta@exemplo.test" }) } });
  await app.abrir();
  app.el("email-setor").value = " TI ";
  await app.harness.run("abrirEmailNoOutlook()");
  assert.equal(app.confirmacoes.length, 0);
  assert.deepEqual(app.de("POST", "/email")[0].corpo, {
    conta: "conta-a", para: "teste@exemplo.test", cc: "", assunto: "Assunto Modelo 1 - Cabo", corpo: "Corpo Modelo 1 - Cabo {nome} {setor}",
    nome: "Pessoa Teste", setor: " TI ", modo: "abrir", confirmado: false,
  });
  assert.equal(app.el("email-status").textContent, "E-mail aberto no Outlook. Revise e envie por lá.");
  assert.equal(app.el("email-status").dataset.tipo, "ok");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: "E-mail aberto no Outlook. Revise e envie por lá.", type: "success" });
  assert.equal(app.el("email-abrir").disabled, false);
});

test("an opened e-mail with a server warning shows only the warning", async () => {
  const aviso = "Alguns destinatários não foram reconhecidos no Outlook. Confira os nomes antes de enviar.";
  const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "aberto", conta: "conta@exemplo.test", aviso }) } });
  await app.abrir();
  await app.harness.run("abrirEmailNoOutlook()");
  assert.equal(app.el("email-status").textContent, aviso);
  assert.equal(app.el("email-status").dataset.tipo, "aviso");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: aviso, type: "warning" });
});

test("Enviar pelo Outlook asks the approved confirmation and sends confirmado true only after yes", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "enviado", conta: "conta@exemplo.test" }) } });
  await app.abrir();
  await app.preencherEnvio();
  app.harness.context.respostaConfirmacao = false;
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.deepEqual(plano(app.confirmacoes), [{
    titulo: "Enviar o e-mail pelo Outlook?",
    mensagem: "O e-mail será enviado de conta@exemplo.test para teste@exemplo.test. Depois de enviado, não há como desfazer.",
    confirmar: "Enviar",
    cancelar: "Cancelar",
  }]);
  assert.equal(app.de("POST", "/email").length, 0);

  app.harness.context.respostaConfirmacao = true;
  await app.harness.run("enviarEmailPeloOutlook()");
  const [envio] = app.de("POST", "/email");
  assert.equal(envio.corpo.modo, "enviar");
  assert.equal(envio.corpo.confirmado, true);
  assert.equal(envio.corpo.setor, "TI");
  assert.equal(app.el("email-status").textContent, "E-mail enviado pelo Outlook.");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: "E-mail enviado pelo Outlook.", type: "success" });
});

test("the send confirmation adds the Cc clause only when Cc has content (user decision, 2026-11-10)", async () => {
  const mensagemCom = async cc => {
    const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "enviado", conta: "conta@exemplo.test" }) } });
    await app.abrir();
    await app.preencherEnvio({ cc });
    app.harness.context.respostaConfirmacao = false;
    await app.harness.run("enviarEmailPeloOutlook()");
    return app.confirmacoes[0].mensagem;
  };
  const base = "O e-mail será enviado de conta@exemplo.test para teste@exemplo.test";
  assert.equal(await mensagemCom(" copia@exemplo.test "), `${base}, com cópia para copia@exemplo.test. Depois de enviado, não há como desfazer.`);
  assert.equal(await mensagemCom(""), `${base}. Depois de enviado, não há como desfazer.`);
  assert.equal(await mensagemCom(" ; ; "), `${base}. Depois de enviado, não há como desfazer.`);
});

test("a lost answer on Enviar shows the uncertain text and never says nothing was sent", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/email": () => Promise.reject(new Error("Failed to fetch")) } });
  await app.abrir();
  await app.preencherEnvio();
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, MSG_INCERTO);
  assert.equal(app.el("email-status").dataset.tipo, "aviso");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: MSG_INCERTO, type: "warning" });
  assert.doesNotMatch(app.el("email-status").textContent, /nada foi enviado/i);
});

test("Enviar checks Para and the name and sector markers before any confirmation", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "enviado", conta: "conta@exemplo.test" }) } });
  await app.abrir();
  await app.preencherEnvio({ para: " ; ", setor: "TI" });
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, "Informe o destinatário no campo Para.");
  await app.preencherEnvio({ setor: "  " });
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, "Preencha o nome da pessoa e o setor antes de enviar.");
  assert.equal(app.confirmacoes.length, 0);
  assert.equal(app.de("POST", "/email").length, 0);
});

test("an uncertain send is never shown as sent, also when the answer is lost", async () => {
  const app = preparar({ rotas: { "POST /api/outlook/email": () => ({ status: "incerto", conta: "conta@exemplo.test", aviso: MSG_INCERTO }) } });
  await app.abrir();
  await app.preencherEnvio();
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, MSG_INCERTO);
  assert.equal(app.el("email-status").dataset.tipo, "aviso");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: MSG_INCERTO, type: "warning" });

  const perdida = preparar({ rotas: { "POST /api/outlook/email": () => Promise.reject(new Error("Failed to fetch")) } });
  await perdida.abrir();
  await perdida.preencherEnvio();
  await perdida.harness.run("enviarEmailPeloOutlook()");
  assert.equal(perdida.el("email-status").textContent, MSG_INCERTO);
  assert.equal(perdida.el("email-status").dataset.tipo, "aviso");
});

test("a server refusal shows the server text and keeps the modal open", async () => {
  const recusa = "O Outlook (classic) não está aberto. Abra o Outlook e tente enviar de novo.";
  const app = preparar({ rotas: { "POST /api/outlook/email": () => erro(503, recusa, "outlook_fechado") } });
  await app.abrir();
  await app.preencherEnvio();
  await app.harness.run("enviarEmailPeloOutlook()");
  assert.equal(app.el("email-status").textContent, recusa);
  assert.equal(app.el("email-status").dataset.tipo, "erro");
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: recusa, type: "error" });
  assert.equal(app.fechamentos.length, 0);
  assert.equal(app.el("email-enviar").disabled, false);
});

test("Excluir keeps the last model and asks the approved confirmation otherwise", async () => {
  const unico = preparar({ modelos: [modelo("cabo", "Modelo 1 - Cabo")] });
  await unico.abrir();
  await unico.harness.run("excluirModeloEmail()");
  assert.equal(unico.el("email-status").textContent, "Mantenha ao menos um modelo.");
  assert.equal(unico.confirmacoes.length, 0);
  assert.equal(unico.de("DELETE", "").length, 0);

  const app = preparar({ rotas: { "DELETE /api/outlook/email/modelos/cabo": () => ({ ok: true }) } });
  await app.abrir();
  app.harness.context.respostaConfirmacao = false;
  await app.harness.run("excluirModeloEmail()");
  assert.deepEqual(plano(app.confirmacoes), [{
    titulo: "Excluir o modelo?",
    mensagem: "O modelo Modelo 1 - Cabo será excluído deste site. Não há como desfazer.",
    confirmar: "Excluir",
    cancelar: "Cancelar",
    destrutiva: true,
  }]);
  assert.equal(app.de("DELETE", "").length, 0);
  app.harness.context.respostaConfirmacao = true;
  await app.harness.run("excluirModeloEmail()");
  assert.equal(app.de("DELETE", "/email/modelos/cabo").length, 1);
  assert.deepEqual(app.el("email-modelo").children.map(item => item.value), ["m2"]);
  assert.equal(app.el("email-modelo").value, "m2");
  assert.equal(app.el("email-modelo-nome").value, "Modelo 2");
});

test("Restaurar padrão only exists for the first model and asks the approved confirmation", async () => {
  const modeloPadrao = modelo("cabo", "Modelo 1 - Cabo", { assunto: "Texto original" });
  const app = preparar({
    modelos: [modeloPadrao, modelo("m2", "Modelo 2")],
    rotas: { "POST /api/outlook/email/modelos/cabo/restaurar": () => ({ ...modeloPadrao, assunto: "Texto original" }) },
  });
  await app.abrir();
  app.digitar("email-assunto", "Texto editado");
  app.harness.context.respostaConfirmacao = false;
  await app.harness.run("restaurarModeloEmail()");
  assert.deepEqual(plano(app.confirmacoes), [{
    titulo: "Restaurar o padrão?",
    mensagem: "Para, Cc, Assunto, Mensagem e conta do Modelo 1 - Cabo voltam ao texto original.",
    confirmar: "Restaurar",
    cancelar: "Cancelar",
    destrutiva: true,
  }]);
  assert.equal(app.de("POST", "/email/modelos").length, 0);
  assert.equal(app.el("email-assunto").value, "Texto editado");

  app.harness.context.respostaConfirmacao = true;
  await app.harness.run("restaurarModeloEmail()");
  assert.equal(app.de("POST", "/email/modelos/cabo/restaurar").length, 1);
  assert.equal(app.el("email-assunto").value, "Texto original");
  assert.equal(app.de("PUT", "").length, 0);

  await app.harness.run('trocarModeloEmail("m2")');
  assert.equal(app.el("email-modelo-restaurar").hidden, true);
  const antes = app.confirmacoes.length;
  await app.harness.run("restaurarModeloEmail()");
  assert.equal(app.confirmacoes.length, antes);
});

test("Novo modelo and Duplicar modelo create on the server and select the new model", async () => {
  const novo = modelo("novo-1", "Novo modelo");
  const copia = modelo("copia-1", "Modelo 1 - Cabo (cópia)", { para: "teste@exemplo.test" });
  const app = preparar({ rotas: { "POST /api/outlook/email/modelos": corpo => (corpo.copiar_de ? copia : novo) } });
  await app.abrir();
  await app.harness.run("novoModeloEmail()");
  assert.deepEqual(app.de("POST", "/email/modelos")[0].corpo, {});
  assert.equal(app.el("email-modelo").value, "novo-1");
  assert.equal(app.el("email-modelo-nome").value, "Novo modelo");
  assert.equal(app.el("email-modelo-nome").focused, true);
  assert.equal(app.el("email-modelo-restaurar").hidden, true);

  await app.harness.run('trocarModeloEmail("cabo")');
  await app.harness.run("duplicarModeloEmail()");
  assert.deepEqual(app.de("POST", "/email/modelos")[1].corpo, { copiar_de: "cabo" });
  assert.equal(app.el("email-modelo").value, "copia-1");
  assert.equal(app.el("email-para").value, "teste@exemplo.test");
  assert.deepEqual(app.el("email-modelo").children.map(item => item.value), ["cabo", "m2", "novo-1", "copia-1"]);
});

test("Copiar Texto fills {nome} and {setor} with the typed values or the visible markers", async () => {
  const app = preparar({ modelos: [modelo("cabo", "Modelo 1 - Cabo", { assunto: "Olá {nome}", corpo: "Setor {setor}, {nome}. {nome}" })] });
  await app.abrir();
  app.el("email-nome-pessoa").value = "  Pessoa Teste ";
  await app.harness.run("copiarTextoEmail()");
  assert.deepEqual(app.harness.effects.clipboardWrites, ["Olá Pessoa Teste\n\nSetor [Setor], Pessoa Teste. Pessoa Teste"]);
  assert.deepEqual(plano(app.harness.effects.toasts.at(-1)), { message: "Texto copiado.", type: "success" });
  app.el("email-nome-pessoa").value = "";
  app.el("email-setor").value = "TI";
  await app.harness.run("copiarTextoEmail()");
  assert.equal(app.harness.effects.clipboardWrites.at(-1), "Olá [Nome da pessoa]\n\nSetor TI, [Nome da pessoa]. [Nome da pessoa]");
  assert.equal(app.de("POST", "/email").length, 0);
});

test("without the Entra base the modal warns, never searches and never resolves names", async () => {
  const app = preparar({ diretorio: { disponivel: false, total: 0 }, rotas: { "POST /api/outlook/email": () => ({ status: "aberto", conta: "conta@exemplo.test" }) } });
  await app.abrir();
  assert.equal(app.el("email-aviso-diretorio").hidden, false);
  app.digitar("email-para", "Pessoa Teste");
  await app.avancar();
  app.el("email-para").dispatchEvent("blur");
  await app.harness.run("abrirEmailNoOutlook()");
  assert.equal(app.de("GET", "/contatos").length, 0);
  assert.equal(app.de("POST", "/contatos/resolver").length, 0);
  assert.equal(app.de("POST", "/email")[0].corpo.para, "Pessoa Teste");
  assert.match(appHtml, /A base do Microsoft Entra não foi importada; digite o e-mail completo\./);
});

test("the Home page keeps the approved labels and no real e-mail domain or name", () => {
  const raiz = path.join(__dirname, "..", "..", "static");
  const js = fs.readFileSync(path.join(raiz, "js", "features", "outlook-email.js"), "utf8");
  const inicio = appHtml.indexOf('id="modal-email-outlook"');
  assert.ok(inicio > 0, "modal-email-outlook missing");
  const fim = appHtml.indexOf('id="modal-confirmar-acao"', inicio);
  assert.ok(fim > inicio, "the modal is expected to end before modal-confirmar-acao");
  const modal = appHtml.slice(inicio, fim);
  assert.match(appHtml, /id="btn-enviar-email"[\s\S]*?Enviar e-mail/);
  assert.match(modal, /E-mail pelo Outlook/);
  for (const rotulo of [
    "Modelo", "Nome do modelo", "Enviar de", "Para", "Cc", "Assunto", "Nome da pessoa", "Setor", "Mensagem",
    "Novo modelo", "Duplicar modelo", "Excluir modelo", "Restaurar padrão", "Abrir no Outlook", "Enviar pelo Outlook", "Copiar Texto", "Cancelar",
  ]) assert.ok(modal.includes(rotulo), rotulo);
  for (const texto of [js, modal]) {
    assert.doesNotMatch(texto, /@simpress\.com\.br|@pr\.sebrae\.com\.br/i);
    assert.doesNotMatch(texto, /Allex|Fabio|Robinson/);
  }
});
