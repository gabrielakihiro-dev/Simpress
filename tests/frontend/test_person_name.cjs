const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const historyFormat = require("../../static/js/shared/history-format.js");
const createComparisonResultRenderer = require("../../static/js/ui/comparison-result-renderer.js");
const createEquipmentSearchRenderers = require("../../static/js/ui/equipment-search-renderers.js");
const createLoggedUserMarkers = require("../../static/js/ui/logged-user-markers.js");
const createEquipmentEditor = require("../../static/js/features/equipment-editor.js");
const createEntraUsers = require("../../static/js/features/entra-users.js");

const dom = createDomUtils({ createElement: () => ({ setAttribute() {} }) });
// nome_pessoa vem de um CSV externo: precisa chegar escapado em todo innerHTML.
const HOSTIL = "<img src=x onerror=alert(1)>";

function assertEscapado(html) {
  assert.ok(html.includes("&lt;img"), html);
  assert.ok(!html.includes("<img"), html);
}

function renderizarMudancas(mudanca) {
  const renderer = createComparisonResultRenderer({
    app: { atributosVersaoAnotacao: () => "" },
    dom,
    historyFormat,
    loggedUserMarkers: createLoggedUserMarkers({ dom }),
  });
  const comparison = { evento_id: "evt", historico_salvo: true, mudancas_usuarios: [mudanca] };
  globalThis.document = { createElement: () => ({ content: { querySelector: () => null } }) };
  try {
    return renderer.conteudoResultadoComparacao(comparison, renderer.listasComparacao(comparison), renderer.criarColunasAnotacao(comparison));
  } finally {
    delete globalThis.document;
  }
}

test("o resumo de mudanças de usuário escapa o nome da pessoa e omite o span quando vazio", () => {
  const base = { tipo: "alterado_endpoint", serie: "SN-2", usuario_anterior: "ana", usuario_novo: "bia", motivo: "x", anotacao_id: "a2" };
  const html = renderizarMudancas({ ...base, nome_pessoa_anterior: HOSTIL, nome_pessoa_novo: "Bia Souza" });
  assertEscapado(html);
  assert.match(html, /data-person-name>Bia Souza<\/span>/);
  assert.equal((html.match(/data-person-name/g) || []).length, 2);
  const vazio = renderizarMudancas({ ...base, nome_pessoa_anterior: "", nome_pessoa_novo: "" });
  assert.doesNotMatch(vazio, /data-person-name/);
});

function marcadorFalso(serie) {
  const item = {
    dataset: { loggedUserSerie: serie },
    innerHTML: "",
    textContent: "",
    querySelector: () => null,
    insertAdjacentHTML(_posicao, html) { this.innerHTML += html; },
  };
  return item;
}

async function mostrarMarcador(info) {
  const item = marcadorFalso("A");
  const markers = createLoggedUserMarkers({
    app: { apiFetch: async () => ({ usuarios: { A: info } }), showToast() {} },
    appState: {},
    dom,
  });
  markers.conectar({ querySelectorAll: () => [item] });
  await new Promise(resolve => setImmediate(resolve));
  return item.innerHTML;
}

test("o marcador de usuário logado escapa o nome, mostra (manual) e omite a linha sem nome", async () => {
  const hostil = await mostrarMarcador({ usuario: "ana", origem: "endpoint", nome_pessoa: HOSTIL });
  assertEscapado(hostil);
  assert.match(hostil, /data-person-name>Nome: &lt;img/);
  const manual = await mostrarMarcador({ usuario: "ana", origem: "endpoint", nome_pessoa: "Ana Lima", nome_pessoa_origem: "manual" });
  assert.match(manual, /data-person-name>Nome: Ana Lima \(manual\)<\/span>/);
  const entra = await mostrarMarcador({ usuario: "ana", origem: "endpoint", nome_pessoa: "Ana Lima", nome_pessoa_origem: "entra" });
  assert.doesNotMatch(entra, /\(manual\)/);
  const vazio = await mostrarMarcador({ usuario: "ana", origem: "endpoint", nome_pessoa: "   " });
  assert.doesNotMatch(vazio, /data-person-name/);
});

test("a busca escapa o nome da pessoa (com e sem consulta), marca (manual) e omite o chip sem nome", () => {
  const renderers = createEquipmentSearchRenderers({ dom });
  globalThis.document = { createElement: () => ({ attributes: {}, dataset: {}, addEventListener() {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
  try {
    const base = { serial: "SN1", tipo: "Notebook", modelo: "X", apelido: "HOST-1", usuarios_logados: "ana", usuarios_logados_origem: "endpoint" };
    assertEscapado(renderers.criarLinhaPesquisaCompleta({ ...base, nome_pessoa: HOSTIL }, 0, "", () => {}).innerHTML);
    // With a query the match is wrapped in a span, so "&lt;" and "img" are no longer adjacent; the tag still must not exist.
    const destacado = renderers.criarLinhaPesquisaCompleta({ ...base, nome_pessoa: HOSTIL }, 0, "img", () => {}).innerHTML;
    assert.ok(destacado.includes('&lt;<span class="serial-match">img</span> src=x'), destacado);
    assert.ok(!destacado.includes("<img"), destacado);
    const manual = renderers.criarLinhaPesquisaCompleta({ ...base, nome_pessoa: "Ana Lima", nome_pessoa_origem: "manual" }, 1, "", () => {}).innerHTML;
    assert.match(manual, /Ana Lima \(manual\)<\/span>/);
    assert.match(manual, /informado manualmente/);
    const entra = renderers.criarLinhaPesquisaCompleta({ ...base, nome_pessoa: "Ana Lima", nome_pessoa_origem: "entra" }, 2, "", () => {}).innerHTML;
    assert.doesNotMatch(entra, /\(manual\)/);
    const vazio = renderers.criarLinhaPesquisaCompleta({ ...base, nome_pessoa: "  " }, 3, "", () => {}).innerHTML;
    assert.doesNotMatch(vazio, /Nome da pessoa/);
  } finally {
    delete globalThis.document;
  }
});

function elementoFalso() {
  const classes = new Set();
  return {
    value: "", textContent: "", disabled: false, attrs: {},
    classList: {
      toggle(nome, force) {
        const ativo = force === undefined ? !classes.has(nome) : Boolean(force);
        if (ativo) classes.add(nome);
        else classes.delete(nome);
      },
      add(nome) { classes.add(nome); },
      remove(nome) { classes.delete(nome); },
      contains(nome) { return classes.has(nome); },
    },
    focus() { this.focused = true; },
    setAttribute(nome, valor) { this.attrs[nome] = valor; },
    removeAttribute(nome) { delete this.attrs[nome]; },
  };
}

function instalarDocumento() {
  const elementos = new Map();
  const eventos = [];
  globalThis.document = {
    getElementById: id => {
      if (!elementos.has(id)) elementos.set(id, elementoFalso());
      return elementos.get(id);
    },
    dispatchEvent: evento => eventos.push(evento.type),
  };
  return { elementos, eventos };
}

test("resumoNomesEntra avisa dos logins ignorados por nomes conflitantes ou dados inválidos", async () => {
  const { elementos } = instalarDocumento();
  try {
    const respostas = [{ updated_at: "2026-01-01", users: 1200, logins_ignorados: 0 }, { updated_at: "2026-01-01", users: 1200, logins_ignorados: 3 }];
    const entra = createEntraUsers({ app: { apiFetch: async () => respostas.shift() }, appState: {} });
    const status = document.getElementById("entra-import-status");
    await entra.carregarEstadoEntra();
    assert.equal(status.textContent, "1.200 nomes PR importados.");
    await entra.carregarEstadoEntra();
    assert.equal(status.textContent, "1.200 nomes PR importados. 3 login(s) ignorado(s) por nomes conflitantes ou dados inválidos.");
    assert.equal(elementos.get("btn-exportar-nomes-entra").disabled, false);
  } finally {
    delete globalThis.document;
  }
});

async function importarEntraSimulado({ apiFetch, equipamento }) {
  const { elementos, eventos } = instalarDocumento();
  const input = document.getElementById("entra-csv-file");
  input.files = [{ name: "usuarios-ficticios.csv" }];
  input.value = "usuarios-ficticios.csv";
  input.dispatchEvent = evento => eventos.push(evento.type);
  document.getElementById("btn-exportar-nomes-entra").disabled = true;
  const toasts = [];
  const aplicados = [];
  const atualizados = [];
  const appState = { currentEquipamento: equipamento };
  const app = {
    apiFetch,
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    definirEquipamentoAtual: atual => { appState.currentEquipamento = atual; aplicados.push(atual); },
    atualizarUsuarioLogadoCard: atual => atualizados.push(atual),
    carregarProntidao: () => atualizados.push("prontidao"),
  };
  const feature = createEntraUsers({ app, appState });
  const promise = feature.importarNomesEntra({ preventDefault() {} });
  const button = document.getElementById("btn-importar-nomes-entra");
  const occupied = button.disabled && button.attrs["aria-busy"] === "true";
  await promise;
  return { appState, button, elementos, eventos, toasts, aplicados, atualizados, occupied };
}

test("importa nomes Entra mesmo quando falha a consulta complementar do equipamento selecionado", async () => {
  const equipamento = { serial: "SERIE-FICTICIA" };
  const chamadas = [];
  const falha = await importarEntraSimulado({
    equipamento,
    apiFetch: async (url, options) => {
      chamadas.push(url);
      if (options?.method === "POST") return { users: 2, logins_ignorados: 0 };
      throw new Error("consulta complementar indisponível");
    },
  });

  assert.deepEqual(chamadas, ["/api/usuarios-entra/importar", "/api/equipamento/SERIE-FICTICIA"]);
  assert.equal(falha.elementos.get("entra-import-status").textContent, "2 nomes PR importados. Não foi possível atualizar o equipamento selecionado: consulta complementar indisponível");
  assert.deepEqual(falha.toasts, [["Nomes do Entra importados, mas não foi possível atualizar o equipamento selecionado.", "warning"]]);
  assert.equal(falha.appState.currentEquipamento, equipamento);
  assert.deepEqual(falha.aplicados, []);
  assert.deepEqual(falha.atualizados, ["prontidao"]);
  assert.equal(falha.elementos.get("entra-csv-file").value, "");
  assert.deepEqual(falha.eventos, ["change"]);
  assert.equal(falha.elementos.get("btn-exportar-nomes-entra").disabled, false);
  assert.equal(falha.occupied, true);
  assert.equal(falha.button.disabled, false);
  assert.equal(falha.button.attrs["aria-busy"], undefined);
});

test("importa nomes Entra e atualiza o equipamento selecionado quando ambas as consultas têm sucesso", async () => {
  const equipamento = { serial: "SERIE-FICTICIA-2" };
  const atualizado = { serial: equipamento.serial, nome_pessoa: "Nome Fictício" };
  const chamadas = [];
  const sucesso = await importarEntraSimulado({
    equipamento,
    apiFetch: async (url, options) => {
      chamadas.push(url);
      if (options?.method === "POST") return { users: 1, logins_ignorados: 0 };
      return atualizado;
    },
  });

  assert.deepEqual(chamadas, ["/api/usuarios-entra/importar", "/api/equipamento/SERIE-FICTICIA-2"]);
  assert.equal(sucesso.elementos.get("entra-import-status").textContent, "1 nomes PR importados.");
  assert.deepEqual(sucesso.toasts, [["Nomes do Entra atualizados.", "success"]]);
  assert.equal(sucesso.appState.currentEquipamento, atualizado);
  assert.deepEqual(sucesso.aplicados, [atualizado]);
  assert.deepEqual(sucesso.atualizados, [atualizado, "prontidao"]);
  assert.equal(sucesso.elementos.get("entra-csv-file").value, "");
  assert.deepEqual(sucesso.eventos, ["change"]);
  assert.equal(sucesso.elementos.get("btn-exportar-nomes-entra").disabled, false);
  assert.equal(sucesso.button.disabled, false);
  assert.equal(sucesso.button.attrs["aria-busy"], undefined);
});

test("falha na importação Entra preserva o CSV, a seleção e o aviso de erro existente", async () => {
  const equipamento = { serial: "SERIE-FICTICIA-3" };
  const chamadas = [];
  const falha = await importarEntraSimulado({
    equipamento,
    apiFetch: async url => {
      chamadas.push(url);
      throw new Error("CSV inválido");
    },
  });

  assert.deepEqual(chamadas, ["/api/usuarios-entra/importar"]);
  assert.equal(falha.elementos.get("entra-import-status").textContent, "CSV inválido");
  assert.deepEqual(falha.toasts, [["CSV inválido", "error"]]);
  assert.equal(falha.appState.currentEquipamento, equipamento);
  assert.deepEqual(falha.aplicados, []);
  assert.deepEqual(falha.atualizados, []);
  assert.equal(falha.elementos.get("entra-csv-file").value, "usuarios-ficticios.csv");
  assert.deepEqual(falha.eventos, []);
  assert.equal(falha.elementos.get("btn-exportar-nomes-entra").disabled, true);
  assert.equal(falha.button.disabled, false);
  assert.equal(falha.button.attrs["aria-busy"], undefined);
});

test("ignora a consulta Entra atrasada quando a revisão da seleção muda e mantém a mesma série", async () => {
  const { elementos } = instalarDocumento();
  const equipamentoInicial = { serial: "SERIE-FICTICIA-4", nome_pessoa: "Nome anterior" };
  const equipamentoMaisNovo = { serial: equipamentoInicial.serial, nome_pessoa: "Nome mais novo" };
  const aplicados = [];
  const atualizados = [];
  const toasts = [];
  const appState = { currentEquipamento: equipamentoInicial, equipamentoSelectionRevision: 1 };
  let concluirConsulta;
  let marcarConsultaIniciada;
  const consultaIniciada = new Promise(resolve => { marcarConsultaIniciada = resolve; });
  const app = {
    apiFetch: async url => {
      if (url === "/api/usuarios-entra/importar") return { users: 1, logins_ignorados: 0 };
      marcarConsultaIniciada();
      return new Promise(resolve => { concluirConsulta = resolve; });
    },
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    definirEquipamentoAtual: equipamento => { appState.currentEquipamento = equipamento; aplicados.push(equipamento); },
    atualizarUsuarioLogadoCard: equipamento => atualizados.push(equipamento),
    carregarProntidao: () => atualizados.push("prontidao"),
  };
  const input = document.getElementById("entra-csv-file");
  input.files = [{ name: "usuarios-ficticios.csv" }];
  input.value = "usuarios-ficticios.csv";
  input.dispatchEvent = () => {};

  try {
    const feature = createEntraUsers({ app, appState });
    const importacao = feature.importarNomesEntra({ preventDefault() {} });
    await consultaIniciada;
    appState.currentEquipamento = equipamentoMaisNovo;
    appState.equipamentoSelectionRevision += 1;
    concluirConsulta({ serial: equipamentoInicial.serial, nome_pessoa: "Nome Entra antigo" });
    await importacao;

    assert.equal(appState.currentEquipamento, equipamentoMaisNovo);
    assert.deepEqual(aplicados, []);
    assert.deepEqual(atualizados, ["prontidao"]);
    assert.deepEqual(toasts, [["Nomes do Entra atualizados.", "success"]]);
  } finally {
    delete globalThis.document;
  }
});

async function salvarNome({ apiFetch, atual }) {
  const { elementos, eventos } = instalarDocumento();
  const toasts = [];
  const aplicados = [];
  const appState = { currentEquipamento: atual };
  const app = {
    apiFetch,
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    definirEquipamentoAtual: equipamento => aplicados.push(equipamento),
  };
  document.getElementById("input-nome-pessoa").value = "  Ana Lima ";
  const editor = createEquipmentEditor({ app, appState });
  const botao = document.getElementById("btn-salvar-nome-pessoa");
  const chamada = editor.salvarNomePessoa();
  const ocupado = botao.disabled;
  await chamada;
  return { botao, ocupado, toasts, aplicados, eventos, elementos };
}

test("o campo de nome fica oculto quando já existe nome e pode ser aberto para edição manual", () => {
  try {
    const { elementos } = instalarDocumento();
    const equipamento = {
      serial: "AAA111", usuarios_logados: "ana.lima", nome_pessoa: "Ana Lima",
      nome_pessoa_origem: "manual", nome_pessoa_editavel: true,
    };
    const editor = createEquipmentEditor({ app: {}, appState: { currentEquipamento: equipamento } });
    const formulario = document.getElementById("form-nome-pessoa");
    const editar = document.getElementById("btn-editar-nome-pessoa");
    const campo = document.getElementById("input-nome-pessoa");

    editor.atualizarUsuarioLogadoCard(equipamento);
    assert.equal(formulario.classList.contains("hidden"), true);
    assert.equal(editar.classList.contains("hidden"), false);

    editor.editarNomePessoa();
    assert.equal(formulario.classList.contains("hidden"), false);
    assert.equal(editar.textContent, "Cancelar edição");
    assert.equal(editar.attrs["aria-expanded"], "true");
    assert.equal(campo.focused, true);

    campo.value = "Outro nome";
    editor.editarNomePessoa();
    assert.equal(formulario.classList.contains("hidden"), true);
    assert.equal(editar.textContent, "Editar nome");
    assert.equal(campo.value, "Ana Lima");

    editor.atualizarUsuarioLogadoCard({ ...equipamento, nome_pessoa: "" });
    assert.equal(formulario.classList.contains("hidden"), false);
    assert.equal(editar.classList.contains("hidden"), true);

    editor.atualizarUsuarioLogadoCard({ ...equipamento, nome_pessoa_origem: "entra", nome_pessoa_editavel: false });
    assert.equal(formulario.classList.contains("hidden"), true);
    assert.equal(editar.classList.contains("hidden"), true);
  } finally {
    delete globalThis.document;
  }
});

test("salvarNomePessoa aplica o equipamento devolvido e avisa quando a base ainda não recarregou", async () => {
  const atual = { serial: "AAA111", usuarios_logados: "ana.lima" };
  try {
    const corpos = [];
    const devolvido = { serial: "AAA111", nome_pessoa: "Ana Lima", nome_pessoa_origem: "manual", nome_pessoa_editavel: true };
    const ok = await salvarNome({ atual, apiFetch: async (url, opcoes) => { corpos.push(JSON.parse(opcoes.body)); return { equipamento: devolvido, base_atualizada: true }; } });
    assert.deepEqual(corpos, [{ serial: "AAA111", login_atual: "ana.lima", nome: "Ana Lima" }]);
    assert.equal(ok.ocupado, true);
    assert.equal(ok.botao.disabled, false);
    assert.deepEqual(ok.aplicados, [devolvido]);
    assert.deepEqual(ok.toasts, [["Nome da pessoa salvo.", "success"]]);
    assert.deepEqual(ok.eventos, ["simpress:usuarios-equipamento-atualizados"]);
    assert.equal(ok.elementos.get("card-nome-pessoa").textContent, "Ana Lima (manual)");

    const adiado = await salvarNome({ atual, apiFetch: async () => ({ equipamento: devolvido, base_atualizada: false }) });
    assert.deepEqual(adiado.aplicados, [devolvido]);
    assert.deepEqual(adiado.toasts, [["Nome salvo; a base será atualizada na próxima carga.", "warning"]]);
  } finally {
    delete globalThis.document;
  }
});

test("salvarNomePessoa mostra o erro em toast e reabilita o botão sem alterar o equipamento", async () => {
  try {
    const falha = await salvarNome({
      atual: { serial: "AAA111", usuarios_logados: "ana.lima" },
      apiFetch: async () => { throw new Error("O usuário logado mudou."); },
    });
    assert.deepEqual(falha.toasts, [["O usuário logado mudou.", "error"]]);
    assert.deepEqual(falha.aplicados, []);
    assert.deepEqual(falha.eventos, []);
    assert.equal(falha.botao.disabled, false);
    assert.equal(falha.botao.attrs["aria-busy"], undefined);
  } finally {
    delete globalThis.document;
  }
});
