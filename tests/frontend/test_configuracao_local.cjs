const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const createConfiguracaoLocal = require("../../static/js/features/configuracao-local.js");

// Chave só para o teste: precisa nunca aparecer em tela, aviso nem toast depois de enviada.
const CHAVE_DIGITADA = "chave-ficticia-para-teste";

const ESTADO_VAZIO = { configurada: false, final: "", fonte: "" };

const leituraPadrao = () => ({
  status: { state: "pending", faltando: ["Conta Sebrae (e-mail)"], reason: "Falta: Conta Sebrae (e-mail)", assistente_ia: true },
  contas: [
    {
      id: "conta_simpress", rotulo: "Conta Simpress (e-mail)", placeholder: "nome@exemplo.invalid", usado_para: "Dashboard",
      ajuda: "Usada para: Dashboard", tipo: "email", valor: "", fonte: "", somente_leitura: false, usar_no_outlook: true, valido: true,
    },
    {
      id: "conta_sebrae", rotulo: "Conta Sebrae (e-mail)", placeholder: "nome@exemplo.invalid", usado_para: "SoftExpert",
      ajuda: "Usada para: SoftExpert", tipo: "email", valor: "", fonte: "", somente_leitura: false, usar_no_outlook: false, valido: true,
    },
    {
      id: "usuario_endpoint", rotulo: "Usuário do Endpoint", placeholder: "nome.usuario", usado_para: "Endpoint Central",
      ajuda: "Usada para: Endpoint Central", tipo: "usuario", valor: "usuario.exemplo", fonte: "ambiente", somente_leitura: true,
      usar_no_outlook: null, valido: true,
    },
  ],
  links: [
    {
      chave: "dashboard_pasta_url", rotulo: "Pasta do Dashboard", placeholder: "https://exemplo.invalid/pasta", usado_para: "Dashboard",
      ajuda: "Usado para: Dashboard", obrigatorio: true, valor: "", fonte: "", somente_leitura: false, valido: true,
    },
  ],
  contas_arquivo_invalido: false,
  cliente: { configurado: true, arquivo_invalido: false, valido: true },
  assistente: { openrouter: { configurada: true, final: "…wxyz", fonte: "arquivo" }, deepseek: { ...ESTADO_VAZIO } },
});

const clientePadrao = () => ({
  contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["SERIE001", "SERIE002"],
  cliente_fontes: {}, cliente_configurada: true,
});

const oculto = (no) => no.className.split(/\s+/).includes("hidden");

// Monta a página mínima (ids do modal em frontend/partials/modais.html) e o `app` com apiFetch gravando cada chamada.
// `respostas` troca a resposta de "METODO /rota" (valor ou função, pode devolver uma promessa).
function preparar({ leitura = leituraPadrao(), cliente = clientePadrao(), respostas = {}, comAtalho = true, appExtra = {} } = {}) {
  const doc = createFakeDocument();
  const nos = {};
  const adicionar = (tag, id, className = "") => {
    const no = doc.createElement(tag);
    no.setAttribute("id", id);
    no.className = className;
    doc.body.append(no);
    nos[id] = no;
    return no;
  };
  adicionar("button", "btn-configuracao-local");
  adicionar("div", "modal-configuracao-local");
  const carga = adicionar("p", "cfg-local-carga");
  carga.hidden = true;
  ["contas", "links", "cliente", "assistente", "atalhos"].forEach((secao) => {
    adicionar("section", `cfg-local-secao-${secao}`, "ckp-secao hidden");
    adicionar("p", `cfg-local-status-${secao}`);
    if (secao !== "atalhos") adicionar("button", `cfg-local-salvar-${secao}`);
  });
  ["cfg-local-contas", "cfg-local-links", "cfg-local-chaves"].forEach((id) => adicionar("div", id));
  ["cfg-local-contrato", "cfg-local-cnpj", "cfg-local-series"].forEach((id) => adicionar("input", id));
  adicionar("p", "cfg-local-cliente-ambiente").hidden = true;

  const chamadas = [];
  const toasts = [];
  const modais = [];
  const contagem = { prontidao: 0, transferencia: 0, contatoOrigem: 0 };
  const padroes = {
    "GET /api/config/local": () => leitura,
    "GET /api/config/cliente": () => cliente,
    "PUT /api/config/local/contas": () => leitura,
    "PUT /api/config/cliente": (corpo) => ({ ...cliente, ...corpo, series_sebrae_fora: corpo.series_sebrae_fora ?? cliente.series_sebrae_fora }),
    "PUT /api/config/local/assistente": () => ({ ...leitura.assistente, openrouter: { configurada: true, final: "…novo", fonte: "arquivo" } }),
    "DELETE /api/config/local/assistente/openrouter": () => ({ openrouter: { ...ESTADO_VAZIO }, deepseek: { ...ESTADO_VAZIO } }),
  };
  const app = {
    apiFetch: async (url, opcoes = {}) => {
      const metodo = opcoes.method || "GET";
      const corpo = opcoes.body ? JSON.parse(opcoes.body) : undefined;
      chamadas.push({ metodo, url, corpo });
      const resposta = respostas[`${metodo} ${url}`] ?? padroes[`${metodo} ${url}`];
      if (resposta === undefined) throw new Error(`rota sem resposta no teste: ${metodo} ${url}`);
      return typeof resposta === "function" ? resposta(corpo) : resposta;
    },
    abrirModalAcessivel: (id, foco, fechar) => modais.push({ acao: "abrir", id, foco, fechar }),
    fecharModalAcessivel: (id) => modais.push({ acao: "fechar", id }),
    showToast: (mensagem, tipo) => toasts.push([mensagem, tipo]),
    confirmarAcao: async () => true,
    carregarProntidao: () => { contagem.prontidao += 1; },
    carregarConfiguracaoTransferencia: () => { contagem.transferencia += 1; },
    ...appExtra,
  };
  if (comAtalho) app.abrirConfiguracaoContatoOrigem = () => { contagem.contatoOrigem += 1; };
  const feature = createConfiguracaoLocal({ app });
  Object.assign(app, feature);

  const anterior = { document: global.document, raf: globalThis.requestAnimationFrame };
  global.document = doc;
  globalThis.requestAnimationFrame = (fn) => fn();
  const restaurar = () => { global.document = anterior.document; globalThis.requestAnimationFrame = anterior.raf; };
  const por = (id) => doc.getElementById(id);
  const ultima = (metodo, url) => chamadas.filter((c) => c.metodo === metodo && c.url === url).at(-1);
  return { doc, app, feature, chamadas, toasts, modais, contagem, por, ultima, restaurar, nos };
}

test("abrir monta contas, links, chaves e cliente a partir da API e foca o primeiro campo editável", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  assert.deepEqual(env.chamadas.map((c) => `${c.metodo} ${c.url}`).sort(), ["GET /api/config/cliente", "GET /api/config/local"]);
  assert.deepEqual(env.modais, [{ acao: "abrir", id: "modal-configuracao-local", foco: "#cfg-local-conta-conta_simpress", fechar: "fecharConfiguracaoLocal" }]);

  const simpress = env.por("cfg-local-conta-conta_simpress");
  assert.equal(simpress.placeholder, "nome@exemplo.invalid");
  assert.equal(simpress.getAttribute("aria-describedby"), "cfg-local-conta-conta_simpress-ajuda");
  assert.equal(env.por("cfg-local-conta-conta_simpress-ajuda").textContent, "Usada para: Dashboard");
  assert.equal(env.por("cfg-local-contas").querySelectorAll("label")[0].textContent, "Conta Simpress (e-mail)");
  assert.equal(env.por("cfg-local-outlook-conta_simpress").checked, true);
  assert.equal(env.por("cfg-local-outlook-conta_sebrae").checked, false);

  const endpoint = env.por("cfg-local-conta-usuario_endpoint");
  assert.equal(endpoint.readOnly, true);
  assert.equal(endpoint.value, "usuario.exemplo");
  assert.equal(env.por("cfg-local-conta-usuario_endpoint-ambiente").textContent, "Definido por variável de ambiente");
  assert.equal(env.por("cfg-local-outlook-usuario_endpoint"), null);

  const link = env.por("cfg-local-link-dashboard_pasta_url");
  assert.equal(link.placeholder, "https://exemplo.invalid/pasta");
  assert.equal(env.por("cfg-local-link-dashboard_pasta_url-ajuda").textContent, "Usado para: Dashboard");

  assert.equal(env.por("cfg-local-contrato").value, "10101");
  assert.equal(env.por("cfg-local-cnpj").value, "11.222.333/0001-81");
  assert.equal(env.por("cfg-local-series").value, "SERIE001\nSERIE002");
  assert.equal(env.por("cfg-local-cliente-ambiente").hidden, true);

  ["contas", "links", "cliente", "assistente", "atalhos"].forEach((secao) => assert.equal(oculto(env.por(`cfg-local-secao-${secao}`)), false, secao));
});

test("chaves de IA nascem vazias, mostram só o final e o botão Remover só aparece com chave própria", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  const openrouter = env.por("cfg-local-chave-openrouter");
  assert.equal(openrouter.value, "");
  assert.equal(openrouter.placeholder, "…wxyz");
  assert.equal(openrouter.getAttribute("type"), "password");
  assert.equal(openrouter.getAttribute("autocomplete"), "new-password");
  assert.equal(env.por("cfg-local-chave-deepseek").placeholder, "Não configurada");

  const botoes = env.por("cfg-local-chaves").querySelectorAll("button");
  assert.equal(botoes.length, 1);
  assert.equal(botoes[0].textContent, "Remover chave");
  assert.equal(botoes[0].getAttribute("data-on-click"), "removerChaveAssistenteConfiguracaoLocal");
  assert.equal(botoes[0].getAttribute("data-args"), '["openrouter"]');
});

test("chave definida por variável de ambiente fica somente leitura e sem botão Remover", async (t) => {
  const leitura = leituraPadrao();
  leitura.assistente.deepseek = { configurada: true, final: "…amb1", fonte: "ambiente" };
  const env = preparar({ leitura });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  assert.equal(env.por("cfg-local-chave-deepseek").readOnly, true);
  assert.match(env.por("cfg-local-chave-deepseek-ajuda").textContent, /variável de ambiente/);
  assert.equal(env.por("cfg-local-chaves").querySelectorAll("button").length, 1);
});

test("sem a função de contato de origem, a seção de atalhos fica escondida", async (t) => {
  const env = preparar({ comAtalho: false });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  assert.equal(oculto(env.por("cfg-local-secao-atalhos")), true);
  assert.equal(oculto(env.por("cfg-local-secao-contas")), false);
});

test("falha ao ler esconde as seções, mostra o erro em alerta e ainda abre o modal", async (t) => {
  const env = preparar({ respostas: { "GET /api/config/local": () => { throw new Error("Servidor fora do ar."); } } });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  const carga = env.por("cfg-local-carga");
  assert.equal(carga.textContent, "Servidor fora do ar.");
  assert.equal(carga.hidden, false);
  assert.equal(carga.getAttribute("role"), "alert");
  ["contas", "links", "cliente", "assistente", "atalhos"].forEach((secao) => assert.equal(oculto(env.por(`cfg-local-secao-${secao}`)), true, secao));
  assert.equal(env.modais[0].foco, ".ckp-cab__acoes .ck-btn");

  // Salvar sem leitura nunca dispara requisição.
  await env.feature.salvarContasConfiguracaoLocal();
  assert.equal(env.chamadas.filter((c) => c.metodo === "PUT").length, 0);
});

test("salvar contas envia só as contas, mantém o somente leitura em branco e recarrega a prontidão", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  env.por("cfg-local-conta-conta_simpress").value = "  pessoa@exemplo.invalid ";
  env.por("cfg-local-link-dashboard_pasta_url").value = "https://exemplo.invalid/nao-enviar";
  env.por("cfg-local-outlook-conta_sebrae").checked = true;
  await env.feature.salvarContasConfiguracaoLocal();

  assert.deepEqual(env.ultima("PUT", "/api/config/local/contas").corpo, {
    conta_simpress: "pessoa@exemplo.invalid",
    usar_no_outlook_simpress: true,
    conta_sebrae: "",
    usar_no_outlook_sebrae: true,
    usuario_endpoint: "",
    links: {},
  });
  assert.deepEqual(env.toasts, [["Contas salvas.", "success"]]);
  assert.equal(env.contagem.prontidao, 1);
  assert.equal(env.por("cfg-local-status-contas").textContent, "Contas salvas.");
  assert.equal(env.por("cfg-local-status-contas").getAttribute("role"), "status");
});

test("salvar links envia só os links e deixa as contas em branco", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  env.por("cfg-local-conta-conta_simpress").value = "pessoa@exemplo.invalid";
  env.por("cfg-local-link-dashboard_pasta_url").value = " https://exemplo.invalid/pasta-nova ";
  await env.feature.salvarLinksConfiguracaoLocal();

  const corpo = env.ultima("PUT", "/api/config/local/contas").corpo;
  assert.equal(corpo.conta_simpress, "");
  assert.equal(corpo.conta_sebrae, "");
  assert.deepEqual(corpo.links, { dashboard_pasta_url: "https://exemplo.invalid/pasta-nova" });
  assert.deepEqual(env.toasts, [["Links salvos.", "success"]]);
  // O texto da conta que ainda não foi salvo continua no campo.
  assert.equal(env.por("cfg-local-conta-conta_simpress").value, "pessoa@exemplo.invalid");
});

test("erro 422 do servidor aparece na seção, em alerta, sem toast de sucesso nem recarga", async (t) => {
  const erro = Object.assign(new Error('"Conta Simpress (e-mail)" não é um e-mail válido.'), { status: 422 });
  const env = preparar({ respostas: { "PUT /api/config/local/contas": () => { throw erro; } } });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  await env.feature.salvarContasConfiguracaoLocal();

  const status = env.por("cfg-local-status-contas");
  assert.equal(status.textContent, erro.message);
  assert.equal(status.getAttribute("role"), "alert");
  assert.equal(env.toasts.length, 0);
  assert.equal(env.contagem.prontidao, 0);
  assert.equal(env.por("cfg-local-salvar-contas").disabled, false);
});

test("cliente recusa contrato e CNPJ fora do formato antes de enviar e foca o campo errado", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  env.por("cfg-local-contrato").value = "12a";
  await env.feature.salvarClienteConfiguracaoLocal();
  assert.equal(env.por("cfg-local-status-cliente").textContent, 'Informe o "Contrato" só com números (até 12 dígitos).');
  assert.equal(env.doc.activeElement, env.por("cfg-local-contrato"));

  env.por("cfg-local-contrato").value = "10101";
  env.por("cfg-local-cnpj").value = "11222333000181";
  await env.feature.salvarClienteConfiguracaoLocal();
  assert.equal(env.por("cfg-local-status-cliente").textContent, 'Informe o "CNPJ de faturamento" no formato 00.000.000/0000-00.');
  assert.equal(env.doc.activeElement, env.por("cfg-local-cnpj"));

  assert.equal(env.chamadas.filter((c) => c.metodo === "PUT").length, 0);
  assert.equal(env.toasts.length, 0);
});

test("salvar cliente envia contrato, CNPJ e séries (uma por linha) e atualiza o formulário de transferência", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  env.por("cfg-local-contrato").value = " 20202 ";
  env.por("cfg-local-cnpj").value = "11.222.333/0001-81";
  env.por("cfg-local-series").value = "SERIE001\nSERIE003, SERIE004;\n\n";
  await env.feature.salvarClienteConfiguracaoLocal();

  assert.deepEqual(env.ultima("PUT", "/api/config/cliente").corpo, {
    contrato: "20202", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: ["SERIE001", "SERIE003", "SERIE004"],
  });
  assert.deepEqual(env.toasts, [["Dados do cliente salvos.", "success"]]);
  assert.equal(env.contagem.transferencia, 1);
  assert.equal(env.contagem.prontidao, 1);
  assert.equal(env.por("cfg-local-series").value, "SERIE001\nSERIE003\nSERIE004");
});

test("cliente vindo do ambiente fica somente leitura e vai em branco ou null para o servidor manter", async (t) => {
  const cliente = clientePadrao();
  cliente.cliente_fontes = { contrato: "ambiente", series_sebrae_fora: "ambiente" };
  const env = preparar({ cliente });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  assert.equal(env.por("cfg-local-contrato").readOnly, true);
  assert.equal(env.por("cfg-local-series").readOnly, true);
  assert.equal(env.por("cfg-local-cnpj").readOnly, false);
  assert.equal(env.por("cfg-local-cliente-ambiente").hidden, false);

  await env.feature.salvarClienteConfiguracaoLocal();
  assert.deepEqual(env.ultima("PUT", "/api/config/cliente").corpo, {
    contrato: "", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: null,
  });
});

test("salvar assistente sem chave digitada não faz requisição e avisa que manteve as atuais", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  await env.feature.salvarAssistenteConfiguracaoLocal();

  assert.equal(env.chamadas.filter((c) => c.url.includes("/assistente")).length, 0);
  assert.equal(env.por("cfg-local-status-assistente").textContent, "Nenhuma chave nova digitada. As chaves atuais foram mantidas.");
});

test("a chave enviada sai do campo e nunca aparece em tela nem em toast, com sucesso ou com erro", async (t) => {
  const falha = Object.assign(new Error("Não foi possível salvar a chave."), { status: 500 });
  let falhar = false;
  const env = preparar({
    respostas: {
      "PUT /api/config/local/assistente": () => {
        if (falhar) throw falha;
        return { openrouter: { configurada: true, final: "…novo", fonte: "arquivo" }, deepseek: { ...ESTADO_VAZIO } };
      },
    },
  });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  env.por("cfg-local-chave-openrouter").value = `  ${CHAVE_DIGITADA} `;
  await env.feature.salvarAssistenteConfiguracaoLocal();
  assert.deepEqual(env.ultima("PUT", "/api/config/local/assistente").corpo, { openrouter_api_key: CHAVE_DIGITADA });
  assert.equal(env.por("cfg-local-chave-openrouter").value, "");
  assert.equal(env.por("cfg-local-chave-openrouter").placeholder, "…novo");
  assert.deepEqual(env.toasts, [["Chave salva.", "success"]]);

  falhar = true;
  env.por("cfg-local-chave-deepseek").value = CHAVE_DIGITADA;
  await env.feature.salvarAssistenteConfiguracaoLocal();
  assert.equal(env.por("cfg-local-chave-deepseek").value, "");
  assert.equal(env.por("cfg-local-status-assistente").textContent, falha.message);

  const telas = [env.por("cfg-local-status-assistente"), env.por("cfg-local-chaves")].map((no) => no.textContent);
  [...telas, JSON.stringify(env.toasts)].forEach((texto) => assert.ok(!texto.includes(CHAVE_DIGITADA)));
});

test("remover chave pede confirmação e só chama DELETE se o usuário confirmar", async (t) => {
  let confirmar = false;
  const env = preparar({ appExtra: { confirmarAcao: async (opcoes) => { env.pedido = opcoes; return confirmar; } } });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  await env.feature.removerChaveAssistenteConfiguracaoLocal("openrouter");
  assert.equal(env.pedido.titulo, "Remover chave?");
  assert.equal(env.pedido.confirmar, "Remover chave");
  assert.equal(env.chamadas.filter((c) => c.metodo === "DELETE").length, 0);

  confirmar = true;
  await env.feature.removerChaveAssistenteConfiguracaoLocal("openrouter");
  assert.equal(env.chamadas.filter((c) => c.metodo === "DELETE").length, 1);
  assert.equal(env.ultima("DELETE", "/api/config/local/assistente/openrouter").url, "/api/config/local/assistente/openrouter");
  assert.deepEqual(env.toasts, [["Chave do OpenRouter removida.", "success"]]);
  assert.equal(env.por("cfg-local-chave-openrouter").placeholder, "Não configurada");
  assert.equal(env.por("cfg-local-chaves").querySelectorAll("button").length, 0);
  assert.equal(env.doc.activeElement, env.por("cfg-local-chave-openrouter"));
});

test("remover aceita só identificadores conhecidos", async (t) => {
  const env = preparar();
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  await env.feature.removerChaveAssistenteConfiguracaoLocal("../contas");
  assert.equal(env.chamadas.filter((c) => c.metodo === "DELETE").length, 0);
});

test("fechar devolve o foco ao botão Configurar e é ignorado enquanto salva", async (t) => {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const env = preparar({ respostas: { "PUT /api/config/local/contas": async () => { await espera; return leituraPadrao(); } } });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();

  const salvando = env.feature.salvarContasConfiguracaoLocal();
  const segundo = env.feature.salvarContasConfiguracaoLocal();
  assert.equal(env.por("modal-configuracao-local").getAttribute("aria-busy"), "true");
  ["contas", "links", "cliente", "assistente"].forEach((secao) => assert.equal(env.por(`cfg-local-salvar-${secao}`).disabled, true, secao));
  env.feature.fecharConfiguracaoLocal();
  assert.equal(env.modais.filter((m) => m.acao === "fechar").length, 0);

  liberar();
  await Promise.all([salvando, segundo]);
  assert.equal(env.chamadas.filter((c) => c.metodo === "PUT").length, 1);
  assert.equal(env.por("modal-configuracao-local").getAttribute("aria-busy"), null);
  ["contas", "links", "cliente", "assistente"].forEach((secao) => assert.equal(env.por(`cfg-local-salvar-${secao}`).disabled, false, secao));

  env.feature.fecharConfiguracaoLocal();
  assert.deepEqual(env.modais.filter((m) => m.acao === "fechar"), [{ acao: "fechar", id: "modal-configuracao-local" }]);
  assert.equal(env.doc.activeElement, env.por("btn-configuracao-local"));
});

test("arquivo de contas inválido avisa na seção de contas ao abrir", async (t) => {
  const leitura = leituraPadrao();
  leitura.contas_arquivo_invalido = true;
  const env = preparar({ leitura });
  t.after(env.restaurar);
  await env.feature.abrirConfiguracaoLocal();
  assert.equal(env.por("cfg-local-status-contas").textContent, "O arquivo de contas está inválido. Ao salvar, ele é regravado.");
  assert.equal(env.por("cfg-local-status-contas").getAttribute("role"), "alert");
});
