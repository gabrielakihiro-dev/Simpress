const assert = require("node:assert/strict");
const test = require("node:test");
const panels = require("../../static/js/ui/data-panels.js");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const report = {
  chamados: [
    { serie: "SN-CONF", relacao: "conferida", simpress: { ordens_servico: ["9001"] }, oracle: [{ solicitacao: "R1", ordem_servico: "9001", descricao: "Troca de bateria." }] },
    { serie: "SN-SOR", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: [{ solicitacao: "R2", ordem_servico: "9002", descricao: "Tela quebrada." }] },
    { serie: "SN-SEMOS", relacao: "sem_os", simpress: { ordens_servico: [] }, oracle: [] },
  ],
};

// install() é de módulo único (install.done): uma instalação serve a todos os testes deste arquivo.
const doc = createFakeDocument();
const requests = [];
const win = {
  document: doc,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  getComputedStyle: () => ({ display: "" }),
  console: { warn() {} },
  fetch: async (url, options = {}) => {
    requests.push([options.method || "GET", url]);
    const json = url === "/api/operacoes/chamados" ? report
      : url === "/api/operacoes/chamados/vinculos-os" ? { vinculos: [] }
      : url === "/api/equipamentos/usuarios-logados" ? { usuarios: {} }
      : null;
    return { ok: json !== null, json: async () => json || {} };
  },
};
panels.install(win);

const settle = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(condition) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) await settle();
  assert.ok(condition(), "condição não atendida a tempo");
}

function novoHost() {
  const host = doc.createElement("div");
  doc.body.append(host);
  return host;
}

async function montar(opcoes) {
  const host = novoHost();
  const carregados = [];
  const section = panels.montarTabelaOs(host, { aoCarregar: dados => carregados.push(dados), ...opcoes });
  const status = section.querySelector(".ticket-summary-status");
  await waitFor(() => /OS ·/.test(status.textContent));
  return { host, section, status, carregados };
}

// A tabela ordena por OS (mais nova primeiro); os testes comparam o conjunto de séries.
const visiveis = section => section.querySelectorAll("tbody tr[data-serial]").filter(row => !row.hidden).map(row => row.dataset.serial).sort();

test("antes do install a API pública é inerte", async () => {
  const modulePath = require.resolve("../../static/js/ui/data-panels.js");
  delete require.cache[modulePath];
  const fresh = require(modulePath);
  assert.equal(fresh.montarTabelaOs({}, {}), null);
  assert.equal(fresh.filtrarTabelaOs({ busca: "x" }), undefined);
  assert.equal(await fresh.atualizarTabelaOs(true), undefined);
  delete require.cache[modulePath];
});

test("a tabela não duplica no mesmo host e entrega o relatório a aoCarregar", async () => {
  const { host, section, carregados } = await montar({ semBusca: true });
  assert.equal(panels.montarTabelaOs(host, {}), section, "segunda montagem no mesmo host devolve a existente");
  assert.equal(host.querySelectorAll(".ck-os").length, 1);
  assert.equal(carregados.length, 1, "aoCarregar recebe o relatório uma vez");
  assert.equal(carregados[0], report);
});

test("série sem OS (nem na Simpress nem no Oracle) nunca aparece, mesmo com incluirSemOs", async () => {
  const { section, status } = await montar({ semBusca: true, incluirSemOs: true });
  assert.equal(status.textContent, "2 OS · 2 séries");
  assert.equal(section.querySelectorAll("tbody tr[data-sem-os]").length, 0);
  assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);
  assert.equal(section.textContent.includes("SN-SEMOS"), false);
  assert.equal(section.textContent.includes("Sem OS"), false);
});

test("filtrarTabelaOs combina busca e relação e atualiza a contagem", async () => {
  const { section, status } = await montar({ semBusca: true });
  assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);

  panels.filtrarTabelaOs({ relacao: "somente_oracle" });
  assert.deepEqual(visiveis(section), ["SN-SOR"]);
  assert.equal(status.textContent, "1 de 2 OS · 1 série");

  panels.filtrarTabelaOs({ relacao: "sem_os" });
  assert.deepEqual(visiveis(section), []);
  assert.equal(status.textContent, "0 de 2 OS · 0 séries");

  panels.filtrarTabelaOs({ relacao: "todos", busca: "9001" });
  assert.deepEqual(visiveis(section), ["SN-CONF"]);
  panels.filtrarTabelaOs({ relacao: "todos", busca: "sn-conf" });
  assert.deepEqual(visiveis(section), ["SN-CONF"], "busca ignora caixa e vale sobre a linha inteira");

  panels.filtrarTabelaOs({ busca: "REL", relacao: "conferida" });
  assert.deepEqual(visiveis(section), [], "busca sem acerto esconde tudo");
  panels.filtrarTabelaOs({ busca: "SN-", relacao: "conferida" });
  assert.deepEqual(visiveis(section), ["SN-CONF"], "busca e relação se combinam");

  panels.filtrarTabelaOs({ busca: "", relacao: "" });
  assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);
  assert.equal(status.textContent, "2 OS · 2 séries");
});

test("com busca própria a tabela sincroniza o campo e filtra ao digitar", async () => {
  const { section } = await montar({});
  const campo = section.querySelector(".ck-os__busca input");
  assert.ok(campo, "sem semBusca a tabela cria a própria busca");
  panels.filtrarTabelaOs({ busca: "9002" });
  assert.equal(campo.value, "9002");
  assert.deepEqual(visiveis(section), ["SN-SOR"]);
  campo.value = "SN-CONF";
  campo.dispatchEvent({ type: "input" });
  assert.deepEqual(visiveis(section), ["SN-CONF"]);
});

test("Andamento expande uma linha por série, esconde com o filtro e recolhe", async () => {
  const chamadas = [];
  const { section } = await montar({ semBusca: true, aoExpandirSerie: (serie, celula) => chamadas.push([serie, celula]) });
  const botao = serie => section.querySelectorAll(".ck-os__andamento-btn").find(item => item.dataset.serie === serie);
  assert.equal(section.querySelectorAll(".ck-os__andamento-btn").length, 2, "um botão por série");
  assert.equal(section.querySelectorAll("tr[data-andamento]").length, 0);
  assert.equal(chamadas.length, 0, "nada é pedido antes de expandir");

  botao("SN-SOR").click();
  assert.equal(botao("SN-SOR").getAttribute("aria-expanded"), "true");
  const detalhe = section.querySelector('tr[data-andamento="SN-SOR"]');
  assert.ok(detalhe);
  assert.equal(botao("SN-SOR").getAttribute("aria-controls"), detalhe.id);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0][0], "SN-SOR");
  assert.equal(chamadas[0][1], detalhe.children[0], "o conteúdo é preenchido na célula da linha");
  assert.equal(detalhe.children[0].colSpan, 7);

  panels.filtrarTabelaOs({ relacao: "conferida" });
  assert.equal(detalhe.hidden, true, "a linha de Andamento acompanha o filtro da série");
  panels.filtrarTabelaOs({ relacao: "todos" });
  assert.equal(detalhe.hidden, false);

  botao("SN-SOR").click();
  assert.equal(botao("SN-SOR").getAttribute("aria-expanded"), "false");
  assert.equal(section.querySelectorAll("tr[data-andamento]").length, 0);
  assert.equal(botao("SN-SOR").hasAttribute("aria-controls"), false);
  assert.equal(chamadas.length, 1);
});

test("sem aoExpandirSerie não há botão de Andamento", async () => {
  const { section } = await montar({ semBusca: true });
  assert.equal(section.querySelectorAll(".ck-os__andamento-btn").length, 0);
});

test("atualizarTabelaOs(true) recarrega as tabelas montadas, uma requisição de relatório por carga", async () => {
  const { status } = await montar({ semBusca: true });
  const antes = requests.filter(([, url]) => url === "/api/operacoes/chamados").length;
  await panels.atualizarTabelaOs(true);
  await waitFor(() => requests.filter(([, url]) => url === "/api/operacoes/chamados").length > antes);
  await settle();
  const depois = requests.filter(([, url]) => url === "/api/operacoes/chamados").length;
  assert.ok(depois >= antes + 1);
  assert.match(status.textContent, /OS ·/);
});

test("triagem e atenção usam o grupo da série (grupoSerie) e combinam com a relação", async () => {
  const grupos = { "SN-CONF": "em_dia", "SN-SOR": "atrasados" };
  const { section } = await montar({ semBusca: true, grupoSerie: ticket => grupos[ticket.serie] });
  panels.filtrarTabelaOs({ relacao: "", busca: "", triagem: "ativos" });
  assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"], "ativos = qualquer série com chamado aberto");
  panels.filtrarTabelaOs({ triagem: "atrasados" });
  assert.deepEqual(visiveis(section), ["SN-SOR"]);
  panels.filtrarTabelaOs({ triagem: "em_dia" });
  assert.deepEqual(visiveis(section), ["SN-CONF"]);
  panels.filtrarTabelaOs({ triagem: "", atencao: true });
  assert.deepEqual(visiveis(section), ["SN-SOR"], "atenção = 3+ dias ou sem data");
  panels.filtrarTabelaOs({ triagem: "ativos", atencao: true, relacao: "conferida" });
  assert.deepEqual(visiveis(section), [], "triagem, atenção e relação se combinam");
  panels.filtrarTabelaOs({ triagem: "", atencao: false, relacao: "" });
  assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);
});
