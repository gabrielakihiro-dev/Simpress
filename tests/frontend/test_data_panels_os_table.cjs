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
// Ajustáveis por teste: vínculos devolvidos por /vinculos-os e falha de rede.
let vinculos = [];
let usuarios = {};
let falhar = false;
// Observações da aba OS: null faz o GET falhar (caixa só leitura); os PUTs ficam em putsObs.
let observacoes = null;
const putsObs = [];
// Corpos do POST de usuários logados: a janela Chamado × OS pede só as séries dela.
const corposUsuarios = [];
// Marcas de OS finalizada: [] por padrão; null faz o GET falhar; o PUT guarda o corpo em putsMarcas e, com falhaMarca, responde esse erro.
let marcas = [];
let falhaMarca = null;
const putsMarcas = [];
// Confirmação: confirmarAcao devolve `confirmar` e registra o que foi mostrado.
let confirmar = true;
const confirmacoes = [];
const eventos = [];
const win = {
  document: doc,
  MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type) { this.type = type; } },
  confirmarAcao: async opcoes => { confirmacoes.push(opcoes); return confirmar; },
  getComputedStyle: () => ({ display: "" }),
  console: { warn() {} },
  fetch: async (url, options = {}) => {
    requests.push([options.method || "GET", url]);
    if (url === "/api/equipamentos/usuarios-logados") corposUsuarios.push(JSON.parse(options.body));
    if (falhar) throw new Error("Failed to fetch");
    if (url === "/api/operacoes/chamados/observacoes") {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        putsObs.push(body);
        return { ok: true, json: async () => ({ ...body, observacao: body.observacao.trim(), atualizado_em: "2026-11-07T10:00:00-03:00" }) };
      }
      return { ok: observacoes !== null, json: async () => (observacoes ? { observacoes } : { detail: "Falha" }) };
    }
    if (url === "/api/operacoes/chamados/marcas-finalizacao") {
      if (options.method === "PUT") {
        const body = JSON.parse(options.body);
        putsMarcas.push(body);
        if (falhaMarca) return { ok: false, status: falhaMarca.status, json: async () => ({ detail: falhaMarca.detail }) };
        return { ok: true, json: async () => ({ marca: body }) };
      }
      return { ok: marcas !== null, json: async () => (marcas ? { marcas } : { detail: "Falha" }) };
    }
    const json = url === "/api/operacoes/chamados" ? report
      : url === "/api/operacoes/chamados/vinculos-os" ? { vinculos }
      : url === "/api/equipamentos/usuarios-logados" ? { usuarios }
      : null;
    return { ok: json !== null, json: async () => json || {} };
  },
};
doc.dispatchEvent = evento => { eventos.push(evento.type); return true; };
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
  assert.equal(detalhe.children[0].colSpan, 8);

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

test("o cartão grava data-estado (carregando, pronto, vazio, erro) para o CSS da aba OS", async () => {
  const { section } = await montar({ semBusca: true });
  assert.equal(section.dataset.estado, "pronto");
  const chamados = report.chamados;
  try {
    const recarga = panels.atualizarTabelaOs(true);
    assert.equal(section.dataset.estado, "carregando");
    await recarga;
    await waitFor(() => section.dataset.estado === "pronto");
    report.chamados = [];
    await panels.atualizarTabelaOs(true);
    await waitFor(() => section.dataset.estado === "vazio");
    report.chamados = chamados;
    falhar = true;
    await panels.atualizarTabelaOs(true);
    await waitFor(() => section.dataset.estado === "erro");
  } finally { report.chamados = chamados; falhar = false; }
  await panels.atualizarTabelaOs(true);
  await waitFor(() => section.dataset.estado === "pronto");
});

test("data-origem marca o vínculo do Dashboard e aria-invalid o número inválido do campo UTIC", async () => {
  vinculos = [{ fonte: "oracle", serie: "SN-SOR", os: "9002", ano: 2026, numero: "3290", origem: "dashboard" }];
  try {
    const { section, status } = await montar({ semBusca: true });
    const linha = serie => section.querySelector(`tbody tr[data-serial="${serie}"]`);
    assert.equal(linha("SN-SOR").querySelector(".ticket-os-link-editor").dataset.origem, "dashboard");
    assert.equal(linha("SN-CONF").querySelector(".ticket-os-link-editor").dataset.origem, undefined, "sem vínculo, sem origem");

    const janela = linha("SN-SOR").querySelector("button.ticket-os-link-goto");
    assert.equal(janela.getAttribute("data-on-click"), "abrirJanelaChamadoOs");
    assert.deepEqual(JSON.parse(janela.getAttribute("data-args")), [{ chamado: "UTIC-2026-3290", serie: "SN-SOR", os: "9002" }, "$this"]);
    assert.equal(janela.getAttribute("aria-haspopup"), "dialog");
    assert.equal(linha("SN-CONF").querySelector(".ticket-os-link-goto"), null, "sem vínculo, o prefixo não é link");

    const input = linha("SN-CONF").querySelector(".ticket-os-link-input");
    input.value = "";
    linha("SN-CONF").querySelector(".ticket-os-link-form").dispatchEvent({ type: "submit", preventDefault() {} });
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(status.textContent, "Digite os números depois do prefixo UTIC.", "a mensagem continua no status do cabeçalho");
    input.dispatchEvent({ type: "input" });
    assert.equal(input.hasAttribute("aria-invalid"), false, "digitar limpa a marca de erro");
  } finally { vinculos = []; }
});

test("a busca usa série, OS, modelo e UTIC salvo, sem casar rótulos de botões", async () => {
  vinculos = [{ fonte: "oracle", serie: "SN-SOR", os: "9002", ano: 2026, numero: "3290", origem: "dashboard" }];
  const modelo = report.chamados[0].simpress.modelos;
  report.chamados[0].simpress.modelos = ["Latitude 5440"];
  try {
    const { section } = await montar({ semBusca: true, aoExpandirSerie: () => {} });
    panels.filtrarTabelaOs({ busca: "latitude", relacao: "" });
    assert.deepEqual(visiveis(section), ["SN-CONF"], "modelo da Simpress");
    panels.filtrarTabelaOs({ busca: "UTIC-2026-3290" });
    assert.deepEqual(visiveis(section), ["SN-SOR"], "UTIC completo");
    panels.filtrarTabelaOs({ busca: "3290" });
    assert.deepEqual(visiveis(section), ["SN-SOR"], "só o número do UTIC");
    // "solicitacao" e "informado" vêm de rótulos da descrição ("Solicitação R1:", "Descrição não informada"): ficam fora.
    for (const termo of ["salvar", "andamento", "remover", "solicitacao", "informado", "ambiguo"]) {
      panels.filtrarTabelaOs({ busca: termo });
      assert.deepEqual(visiveis(section), [], `"${termo}" não casa`);
    }
    usuarios = { "SN-CONF": { usuario: "maria.souza", hostname: "PR-NB-0101" },
      "SN-SOR": { candidatos: ["joao.lima", "ana.reis"], hostname_ambiguo: true, hostname_candidatos: ["PR-NB-0202"] } };
    const { section: comUsuarios } = await montar({ semBusca: true, aoExpandirSerie: () => {} });
    for (const [termo, esperado] of [["souza", ["SN-CONF"]], ["pr-nb-0101", ["SN-CONF"]], ["ana.reis", ["SN-SOR"]], ["PR-NB-0202", ["SN-SOR"]], ["ambiguo", []]]) {
      panels.filtrarTabelaOs({ busca: termo });
      assert.deepEqual(visiveis(comUsuarios), esperado, `usuário/hostname: "${termo}"`);
    }
  } finally { vinculos = []; usuarios = {}; report.chamados[0].simpress.modelos = modelo; panels.filtrarTabelaOs({ busca: "" }); }
});

test("sem busca a lista mostra 25 OS por vez com Carregar mais; filtro novo volta à primeira página", async () => {
  const chamados = report.chamados;
  report.chamados = Array.from({ length: 60 }, (_, i) => ({
    serie: `SN-P${String(i).padStart(2, "0")}`, relacao: "somente_oracle", simpress: { ordens_servico: [] },
    oracle: [{ solicitacao: `R${i}`, ordem_servico: String(1000 + i), descricao: "" }],
  }));
  try {
    const { section, status } = await montar({ semBusca: true });
    const mais = section.querySelector("[data-os-mais]");
    const botao = mais.querySelector("button");
    assert.equal(botao.textContent, "Carregar mais");
    assert.equal(visiveis(section).length, 25);
    assert.equal(mais.hidden, false);
    assert.equal(mais.querySelector(".sebrae-mais__n").textContent, "Mostrando 25 de 60");
    assert.equal(status.textContent, "60 OS · 60 séries", "a contagem é do total, não da página");

    botao.click();
    assert.equal(visiveis(section).length, 50);
    assert.equal(mais.querySelector(".sebrae-mais__n").textContent, "Mostrando 50 de 60");
    botao.click();
    assert.equal(visiveis(section).length, 60);
    assert.equal(mais.hidden, true, "sem mais páginas o botão some");

    panels.filtrarTabelaOs({ busca: "SN-P" });
    assert.equal(visiveis(section).length, 60, "com busca mostra todas as que casam");
    assert.equal(mais.hidden, true);
    panels.filtrarTabelaOs({ busca: "" });
    assert.equal(visiveis(section).length, 25, "filtro novo volta à primeira página");

    const linha40 = section.querySelectorAll("tbody tr[data-serial]")[40];
    assert.equal(linha40.hidden, true);
    assert.equal(panels.revelarLinhaOs(linha40), true, "abrir uma OS escondida pela página amplia a página");
    assert.equal(linha40.hidden, false);
    assert.equal(visiveis(section).length, 50);
    panels.filtrarTabelaOs({ relacao: "conferida" });
    assert.equal(panels.revelarLinhaOs(linha40), false, "linha escondida pelo filtro não é revelada");
  } finally { report.chamados = chamados; panels.filtrarTabelaOs({ busca: "", relacao: "" }); }
});

test("contagens grandes usam separador de milhar", async () => {
  const chamados = report.chamados;
  report.chamados = Array.from({ length: 1000 }, (_, i) => ({
    serie: `SN-M${i}`, relacao: "somente_oracle", simpress: { ordens_servico: [] },
    oracle: [{ solicitacao: `R${i}`, ordem_servico: String(5000 + i), descricao: "" }],
  }));
  try {
    const { section, status } = await montar({ semBusca: true });
    assert.equal(status.textContent, "1.000 OS · 1.000 séries");
    assert.equal(section.querySelector("[data-os-mais] .sebrae-mais__n").textContent, "Mostrando 25 de 1.000");
  } finally { report.chamados = chamados; }
});

test("seriesFiltradasOs devolve as séries de todas as páginas que passam no filtro e null antes de carregar", async () => {
  [...doc.body.children].forEach(node => node.remove());
  assert.equal(panels.seriesFiltradasOs(), null, "sem tabela montada");
  const chamados = report.chamados;
  report.chamados = Array.from({ length: 60 }, (_, i) => ({
    serie: `SN-X${String(i).padStart(2, "0")}`, relacao: i % 2 ? "conferida" : "somente_oracle",
    simpress: { ordens_servico: i === 0 ? ["7000"] : [] },
    oracle: [{ solicitacao: `R${i}`, ordem_servico: String(2000 + i), descricao: "" }],
  }));
  try {
    const host = novoHost();
    const section = panels.montarTabelaOs(host, { semBusca: true, grupoSerie: ticket => (Number(ticket.serie.slice(-2)) < 10 ? "atrasados" : "em_dia") });
    assert.equal(panels.seriesFiltradasOs(), null, "tabela ainda carregando");
    await waitFor(() => /OS ·/.test(section.querySelector(".ticket-summary-status").textContent));
    panels.filtrarTabelaOs({ busca: "", relacao: "", triagem: "", atencao: false });
    assert.equal(visiveis(section).length, 25, "a tela mostra só a primeira página");
    const todas = panels.seriesFiltradasOs();
    assert.equal(todas.length, 60, "todas as páginas, uma vez por série (SN-X00 tem duas OS)");
    assert.equal(new Set(todas).size, 60);

    panels.filtrarTabelaOs({ busca: "sn-x1" });
    assert.deepEqual(panels.seriesFiltradasOs().sort(), Array.from({ length: 10 }, (_, i) => `SN-X1${i}`));
    panels.filtrarTabelaOs({ busca: "", relacao: "conferida" });
    assert.equal(panels.seriesFiltradasOs().length, 30);
    panels.filtrarTabelaOs({ relacao: "conferida", triagem: "atrasados" });
    assert.deepEqual(panels.seriesFiltradasOs().sort(), ["SN-X01", "SN-X03", "SN-X05", "SN-X07", "SN-X09"]);
    panels.filtrarTabelaOs({ relacao: "", triagem: "", busca: "nada-casa" });
    assert.deepEqual(panels.seriesFiltradasOs(), [], "filtro sem resultado devolve lista vazia, não null");
  } finally { report.chamados = chamados; panels.filtrarTabelaOs({ busca: "", relacao: "", triagem: "" }); }
});

test("Observação do andamento: carrega por série+OS, salva, sobrevive à recriação e não entra na busca", async () => {
  observacoes = [{ serie: "sn conf", os: " 9001 ", observacao: "Peça pedida", atualizado_em: "" }];
  try {
    const { section } = await montar({ semBusca: true });
    const caixa = serie => section.querySelector(`tbody tr[data-serial="${serie}"]`).children.at(-1).querySelector("textarea");
    assert.equal(section.querySelectorAll("thead th").at(-1).textContent, "Observação do andamento");
    assert.equal(caixa("SN-CONF").value, "Peça pedida", "a chave normaliza série e OS como o servidor");
    assert.equal(caixa("SN-CONF").getAttribute("aria-label"), "Observação do andamento");
    assert.equal(caixa("SN-CONF").parentNode.getAttribute("data-label"), "Observação do andamento");
    assert.equal(caixa("SN-CONF").readOnly, undefined);
    assert.equal(caixa("SN-SOR").value, "");

    // Busca e contagem não mudam com a observação.
    panels.filtrarTabelaOs({ busca: "peca", relacao: "" });
    assert.deepEqual(visiveis(section), []);
    panels.filtrarTabelaOs({ busca: "" });

    // Digitar e recriar a tabela antes de salvar preserva o texto e o aviso de pendência.
    caixa("SN-SOR").value = "Ligar amanhã ";
    caixa("SN-SOR").dispatchEvent({ type: "input" });
    await panels.atualizarTabelaOs(true);
    await waitFor(() => section.dataset.estado === "pronto");
    assert.equal(caixa("SN-SOR").value, "Ligar amanhã ");
    const feedback = () => section.querySelector('tbody tr[data-serial="SN-SOR"] .sebrae-obs__feedback');
    assert.equal(feedback().textContent, "Alteração ainda não salva…");
    assert.equal(putsObs.length, 0);

    caixa("SN-SOR").dispatchEvent({ type: "blur" });
    await waitFor(() => feedback().textContent === "Salva.");
    assert.deepEqual(putsObs, [{ serie: "SN-SOR", os: "9002", observacao: "Ligar amanhã " }]);
    assert.equal(caixa("SN-SOR").value, "Ligar amanhã", "a caixa mostra o texto devolvido pelo servidor");
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(putsObs.length, 1, "o envio adiado não repete o que já foi salvo");
  } finally { observacoes = null; putsObs.length = 0; }
});

test("Observação do andamento fica só leitura quando a leitura falha, sem derrubar a tabela", async () => {
  const { section, status } = await montar({ semBusca: true });
  assert.equal(status.textContent, "2 OS · 2 séries");
  const caixa = section.querySelector('tbody tr[data-serial="SN-SOR"]').children.at(-1).querySelector("textarea");
  assert.equal(caixa.readOnly, true);
  assert.equal(section.querySelector(".sebrae-obs__feedback"), null);
});

test("soOs mostra só a OS pedida, fora dos filtros da F6, e pede o usuário só dessa série", async () => {
  corposUsuarios.length = 0;
  const { section, status } = await montar({ semBusca: true, soOs: { serie: "sn conf", os: "9001" } });
  assert.deepEqual(visiveis(section), ["SN-CONF"]);
  assert.equal(section.querySelectorAll("tbody tr[data-serial]").length, 1);
  assert.equal(status.textContent, "1 OS · 1 série");
  assert.equal(section.querySelector("[data-os-mais]"), null, "sem Carregar mais");
  assert.equal(status.id || "", "", "não toma o id da contagem da F6");
  assert.deepEqual(corposUsuarios, [{ series: ["SN-CONF"] }]);

  panels.filtrarTabelaOs({ busca: "9002", relacao: "" });
  assert.deepEqual(visiveis(section), ["SN-CONF"], "filtrarTabelaOs ignora a janela");
  assert.equal(panels.seriesFiltradasOs().includes("SN-CONF"), false, "seriesFiltradasOs ignora a janela");
  panels.filtrarTabelaOs({ busca: "" });
});

test("soOs sem a OS no relatório avisa que a série não foi encontrada", async () => {
  const host = novoHost();
  const section = panels.montarTabelaOs(host, { semBusca: true, soOs: { serie: "SN-CONF", os: "9002" } });
  const status = section.querySelector(".ticket-summary-status");
  await waitFor(() => status.textContent === "Série não encontrada na importação atual.");
  assert.equal(section.querySelectorAll("tbody tr[data-serial]").length, 0);
});

test("somenteLeitura: OS em texto, observação só leitura e nada é gravado", async () => {
  observacoes = [{ serie: "SN-SOR", os: "9002", observacao: "Peça pedida" }];
  const putsAntes = requests.filter(([method]) => method === "PUT").length;
  try {
    const { section } = await montar({ semBusca: true, soOs: { serie: "", os: "9002" }, somenteLeitura: true });
    const linha = section.querySelector('tbody tr[data-serial="SN-SOR"]');
    assert.ok(linha, "sem série, liga pela OS única");
    assert.equal(linha.querySelector("button.ticket-summary-order-link"), null);
    assert.equal(linha.querySelector("span.ticket-summary-order-link").textContent, "9002");
    assert.equal(section.querySelectorAll("button").length, 0, "nenhum botão de edição");
    const caixa = linha.children.at(-1).querySelector("textarea");
    assert.equal(caixa.readOnly, true);
    assert.equal(caixa.value, "Peça pedida");
    assert.equal(section.querySelector(".sebrae-obs__feedback"), null);
    caixa.value = "Outro texto";
    caixa.dispatchEvent({ type: "input" });
    caixa.dispatchEvent({ type: "blur" });
    await new Promise(resolve => setTimeout(resolve, 850));
    assert.equal(putsObs.length, 0, "a janela não salva observação");
    assert.equal(requests.filter(([method]) => method === "PUT").length, putsAntes);
  } finally { observacoes = null; putsObs.length = 0; }
});

// ----- marca de OS finalizada -----
const novaMarca = (extra = {}) => ({
  serie: "SN-CONF", os: "9001", chamado: "UTIC-2026-1", origem: "site", motivo: "", finalizado_em: "2026-11-08T10:30:00-03:00",
  ativa: true, conferido_em: "", historico: [{ acao: "marcada", origem: "auto", em: "2026-11-08T10:30:00-03:00" }], ...extra,
});
const blocosMarca = (section, serie) => section.querySelectorAll(`tbody tr[data-serial="${serie}"] .ck-os-marca`);
const botoesMarca = bloco => bloco.querySelectorAll("button").map(botao => botao.textContent);
const restaurarMarcas = () => {
  marcas = []; falhaMarca = null; confirmar = true;
  putsMarcas.length = 0; confirmacoes.length = 0; eventos.length = 0;
};

test("Marca de OS finalizada: selo, botões e histórico por chamado; a chave normaliza série e OS", async () => {
  marcas = [
    novaMarca({ serie: "sn conf", os: " 9001 " }),
    novaMarca({ chamado: "UTIC-2026-7", origem: "outro_tecnico", motivo: "nao_encontrado_softexpert", historico: [] }),
    novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-2", origem: "outro_tecnico", motivo: "saiu_do_dashboard",
      conferido_em: "2026-11-08T11:00:00-03:00", historico: [{ acao: "marcada", origem: "auto", em: "2026-11-08T10:30:00-03:00" },
        { acao: "conferida", origem: "manual", em: "2026-11-08T11:00:00-03:00" }] }),
  ];
  try {
    const { section } = await montar({ semBusca: true });
    const [site, outro] = blocosMarca(section, "SN-CONF");
    assert.equal(blocosMarca(section, "SN-CONF").length, 2, "uma marca por chamado na mesma OS");
    assert.equal(site.querySelector(".ck-badge").textContent, "Chamado finalizado");
    assert.equal(site.querySelector(".ck-badge").dataset.status, "ok");
    assert.equal(site.querySelector(".ck-os-marca__chamado").textContent, "UTIC-2026-1");
    assert.deepEqual(botoesMarca(site), ["Desfazer"]);
    assert.equal(site.querySelector(".ck-os-marca__dica"), null);
    assert.equal(site.querySelector("summary").textContent, "Histórico da marca");
    assert.deepEqual(site.querySelectorAll("li").map(item => item.textContent), ["08/11/2026 às 10:30 · Marcada (automática)"]);

    assert.equal(outro.querySelector(".ck-badge").textContent, "Finalizado por outro técnico");
    assert.equal(outro.querySelector(".ck-badge").dataset.status, "alerta");
    assert.equal(outro.querySelector(".ck-os-marca__dica").textContent, "Conferir no SoftExpert");
    assert.equal(outro.querySelector(".ck-os-marca__motivo").textContent, "Não encontrado no SoftExpert na última leitura.");
    assert.deepEqual(botoesMarca(outro), ["Conferido", "Desfazer"]);
    assert.equal(outro.querySelector("details"), null, "sem histórico não há bloco de histórico");

    const [conferida] = blocosMarca(section, "SN-SOR");
    assert.equal(conferida.querySelector(".ck-badge").textContent, "Finalizado por outro técnico");
    assert.equal(conferida.querySelector(".ck-os-marca__dica"), null, "conferida: sem dica");
    assert.equal(conferida.querySelector(".ck-os-marca__motivo").textContent, "Saiu da lista de abertos do Dashboard sem finalização pelo site.");
    assert.deepEqual(botoesMarca(conferida), ["Desfazer"]);
    assert.deepEqual(conferida.querySelectorAll("li").map(item => item.textContent),
      ["08/11/2026 às 10:30 · Marcada (automática)", "08/11/2026 às 11:00 · Conferida (manual)"]);
  } finally { restaurarMarcas(); }
});

test("Marca desfeita: sem selo, com Refazer e histórico; texto do servidor entra como texto", async () => {
  marcas = [novaMarca({ chamado: "<img src=x onerror=1>", ativa: false, historico: [
    { acao: "marcada", origem: "auto", em: "2026-11-08T10:30:00-03:00" }, { acao: "desfeita", origem: "manual", em: "2026-11-08T12:00:00-03:00" }] })];
  try {
    const { section } = await montar({ semBusca: true });
    const [bloco] = blocosMarca(section, "SN-CONF");
    assert.equal(bloco.querySelector(".ck-badge"), null, "desfeita não mostra selo");
    assert.deepEqual(botoesMarca(bloco), ["Refazer"]);
    assert.equal(bloco.querySelectorAll("li").length, 2);
    assert.equal(bloco.querySelector(".ck-os-marca__chamado").textContent, "<img src=x onerror=1>");
    assert.equal(section.querySelectorAll("img").length, 0);
  } finally { restaurarMarcas(); }
});

test("Marca fora da busca, dos filtros, da contagem e da lista exportada da F6", async () => {
  marcas = [novaMarca(), novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-2", origem: "outro_tecnico", motivo: "saiu_do_dashboard" })];
  try {
    const { section, status } = await montar({ semBusca: true });
    assert.equal(status.textContent, "2 OS · 2 séries");
    for (const termo of ["finalizado", "UTIC-2026-1", "outro técnico", "SoftExpert", "Histórico"]) {
      panels.filtrarTabelaOs({ busca: termo, relacao: "" });
      assert.deepEqual(visiveis(section), [], `a busca "${termo}" não casa com a marca`);
    }
    panels.filtrarTabelaOs({ busca: "", relacao: "" });
    assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);
    assert.deepEqual(panels.seriesFiltradasOs().sort(), ["SN-CONF", "SN-SOR"]);
    assert.equal(status.textContent, "2 OS · 2 séries");
  } finally { restaurarMarcas(); }
});

test("Desfazer pede confirmação, envia a marca ao PUT, recria a tabela e avisa o sino", async () => {
  marcas = [novaMarca()];
  try {
    const { section } = await montar({ semBusca: true });
    const pedidosAntes = requests.filter(([method]) => method === "PUT").length;

    confirmar = false;
    blocosMarca(section, "SN-CONF")[0].querySelector("button").dispatchEvent({ type: "click" });
    await waitFor(() => confirmacoes.length === 1);
    assert.equal(confirmacoes[0].titulo, "Desfazer a marca de finalização?");
    assert.match(confirmacoes[0].mensagem, /não é reaberto no SoftExpert/);
    await settle();
    assert.equal(putsMarcas.length, 0, "cancelar a confirmação não grava");
    assert.equal(blocosMarca(section, "SN-CONF")[0].querySelector("button").disabled, undefined);

    confirmar = true;
    marcas = [novaMarca({ ativa: false, historico: [{ acao: "marcada", origem: "auto", em: "2026-11-08T10:30:00-03:00" },
      { acao: "desfeita", origem: "manual", em: "2026-11-08T12:00:00-03:00" }] })];
    blocosMarca(section, "SN-CONF")[0].querySelector("button").dispatchEvent({ type: "click" });
    await waitFor(() => eventos.includes("simpress:atualizar-notificacoes"));
    assert.deepEqual(putsMarcas, [{ serie: "SN-CONF", os: "9001", chamado: "UTIC-2026-1", acao: "desfazer" }]);
    assert.equal(requests.filter(([method]) => method === "PUT").length, pedidosAntes + 1, "só o PUT da marca; nada em outro endpoint");
    const [depois] = blocosMarca(section, "SN-CONF");
    assert.equal(depois.querySelector(".ck-badge"), null, "a tabela mostra o estado devolvido pelo servidor");
    assert.deepEqual(botoesMarca(depois), ["Refazer"]);
    assert.equal(doc.activeElement.textContent, "Refazer", "o foco volta ao botão da mesma marca");
  } finally { restaurarMarcas(); }
});

test("Refazer confirma; Conferido grava sem confirmação", async () => {
  marcas = [novaMarca({ ativa: false }), novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-2", origem: "outro_tecnico", motivo: "saiu_do_dashboard" })];
  try {
    const { section } = await montar({ semBusca: true });
    blocosMarca(section, "SN-CONF")[0].querySelector("button").dispatchEvent({ type: "click" });
    await waitFor(() => putsMarcas.length === 1);
    assert.equal(confirmacoes[0].titulo, "Refazer a marca de finalização?");
    assert.equal(putsMarcas[0].acao, "refazer");

    confirmacoes.length = 0;
    const conferido = blocosMarca(section, "SN-SOR")[0].querySelectorAll("button").find(botao => botao.textContent === "Conferido");
    conferido.dispatchEvent({ type: "click" });
    await waitFor(() => putsMarcas.length === 2);
    assert.deepEqual(putsMarcas[1], { serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-2", acao: "conferir" });
    assert.equal(confirmacoes.length, 0, "Conferido não pede confirmação");
    // O aviso ao sino sai depois do refresh; espera para não vazar para o próximo teste.
    await waitFor(() => eventos.length === 2);
  } finally { restaurarMarcas(); }
});

test("Erro 422 ou 503 no PUT da marca aparece no status e a tabela segue de pé", async () => {
  marcas = [novaMarca()];
  try {
    const { section, status } = await montar({ semBusca: true });
    for (const falha of [{ status: 422, detail: "Marca inexistente ou ação inválida." }, { status: 503, detail: "Arquivo de marcas indisponível." }]) {
      falhaMarca = falha;
      const botao = blocosMarca(section, "SN-CONF")[0].querySelector("button");
      botao.dispatchEvent({ type: "click" });
      await waitFor(() => status.textContent === falha.detail);
      assert.equal(botao.disabled, false, "o botão volta a valer");
      assert.equal(botao.getAttribute("aria-busy"), null);
      assert.equal(visiveis(section).length, 2, "a tabela não é recriada nem quebra");
      assert.equal(eventos.length, 0, "falha não avisa o sino");
    }
    assert.equal(putsMarcas.length, 2);
  } finally { restaurarMarcas(); }
});

test("Falha ao ler as marcas não derruba a tabela e o status avisa", async () => {
  marcas = null;
  try {
    const { section, status } = await montar({ semBusca: true });
    assert.equal(status.textContent, "2 OS · 2 séries; marcas de OS finalizada indisponíveis.");
    assert.equal(section.querySelectorAll(".ck-os-marca").length, 0);
    assert.deepEqual(visiveis(section), ["SN-CONF", "SN-SOR"]);
  } finally { restaurarMarcas(); }
});

test("Janela somente leitura: só o selo das marcas ativas do chamado pedido, sem botões nem histórico", async () => {
  marcas = [
    novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-2", origem: "outro_tecnico", motivo: "saiu_do_dashboard" }),
    novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-3" }),
    novaMarca({ serie: "SN-SOR", os: "9002", chamado: "UTIC-2026-4", ativa: false }),
  ];
  try {
    const { section } = await montar({ semBusca: true, soOs: { serie: "", os: "9002", chamado: " utic-2026-2 " }, somenteLeitura: true });
    const blocos = blocosMarca(section, "SN-SOR");
    assert.equal(blocos.length, 1, "só a marca ativa do chamado pedido");
    assert.equal(blocos[0].querySelector(".ck-badge").textContent, "Finalizado por outro técnico");
    assert.equal(section.querySelectorAll("button").length, 0, "nenhum botão");
    assert.equal(section.querySelectorAll("details").length, 0, "sem histórico");

    const outra = await montar({ semBusca: true, soOs: { serie: "", os: "9002" }, somenteLeitura: true });
    assert.equal(blocosMarca(outra.section, "SN-SOR").length, 2, "sem chamado pedido, todas as ativas");
  } finally { restaurarMarcas(); }
});

test("Selos Técnico e Aberta há N dias: só no Oracle, só com os campos do servidor, sempre por textContent", async () => {
  const original = report.chamados;
  const oracle = (os, extra) => [{ solicitacao: `R${os}`, ordem_servico: os, descricao: "Texto livre.", ...extra }];
  report.chamados = [
    { serie: "SN-TEC", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9101", { envio_tecnico: true, dias_aberta: 6 }) },
    { serie: "SN-HOJE", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9102", { envio_tecnico: false, dias_aberta: 0 }) },
    { serie: "SN-UM", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9103", { dias_aberta: 1 }) },
    { serie: "SN-NULO", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9104", { envio_tecnico: false, dias_aberta: null }) },
    { serie: "SN-MIL", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9105", { dias_aberta: 1200 }) },
    { serie: "SN-XSS", relacao: "somente_oracle", simpress: { ordens_servico: [] }, oracle: oracle("9106", { envio_tecnico: "true", dias_aberta: "<img src=x onerror=alert(1)>" }) },
    { serie: "SN-SIMP", relacao: "somente_simpress", simpress: { ordens_servico: ["9107"] }, oracle: [] },
    {
      serie: "SN-DUAS", relacao: "somente_oracle", simpress: { ordens_servico: [] },
      oracle: [
        { solicitacao: "R1", ordem_servico: "9108", descricao: "a", envio_tecnico: false, dias_aberta: 2 },
        { solicitacao: "R2", ordem_servico: "9108", descricao: "b", envio_tecnico: true, dias_aberta: 9 },
      ],
    },
  ];
  try {
    const { section } = await montar({ semBusca: true });
    const selos = (serie, classe) => section.querySelectorAll(`tbody tr[data-serial="${serie}"] .${classe}`).map(selo => selo.textContent);

    assert.deepEqual(selos("SN-TEC", "ck-os__selo--tecnico"), ["Técnico"]);
    assert.deepEqual(selos("SN-TEC", "ck-os__selo--dias"), ["Aberta há 6 dias"]);

    assert.deepEqual(selos("SN-HOJE", "ck-os__selo--dias"), ["Aberta hoje"]);
    assert.deepEqual(selos("SN-HOJE", "ck-os__selo--tecnico"), [], "sem envio_tecnico verdadeiro, sem selo");
    assert.deepEqual(selos("SN-UM", "ck-os__selo--dias"), ["Aberta há 1 dia"]);
    assert.deepEqual(selos("SN-MIL", "ck-os__selo--dias"), [`Aberta há ${(1200).toLocaleString("pt-BR")} dias`]);

    assert.deepEqual(selos("SN-NULO", "ck-os__selo"), [], "dias_aberta nulo: nenhum selo");
    assert.deepEqual(selos("SN-SIMP", "ck-os__selo"), [], "OS só da Simpress não ganha selos");

    assert.deepEqual(selos("SN-DUAS", "ck-os__selo--dias"), ["Aberta há 9 dias"], "várias solicitações: vale o maior número de dias");
    assert.deepEqual(selos("SN-DUAS", "ck-os__selo--tecnico"), ["Técnico"], "basta uma solicitação pedir técnico");

    assert.deepEqual(selos("SN-XSS", "ck-os__selo"), [], "só boolean true e número finito viram selo");
    assert.equal(section.querySelectorAll("img").length, 0);

    panels.filtrarTabelaOs({ busca: "Técnico", relacao: "todos" });
    assert.deepEqual(visiveis(section), ["SN-DUAS", "SN-TEC"], "buscar \"técnico\" mostra só as OS com o selo");
    panels.filtrarTabelaOs({ busca: "tecnico" });
    assert.deepEqual(visiveis(section), ["SN-DUAS", "SN-TEC"], "sem acento também casa");
  } finally { panels.filtrarTabelaOs({ busca: "", relacao: "" }); report.chamados = original; }
});

// Nomes fictícios (LGPD): nenhuma pessoa real nos testes.
test("busca por nome na descrição (primeiro nome ou completo) e termos de equipamento com limite de palavra", async () => {
  const original = report.chamados;
  const modelo = report.chamados[0].simpress.modelos;
  const oracle = (serie, os, descricao) => ({ serie, relacao: "somente_oracle", simpress: { ordens_servico: [] },
    oracle: [{ solicitacao: `R${os}`, ordem_servico: os, descricao }] });
  report.chamados = [
    oracle("SN-N1", "9201", "Usuário João Fictício Teste sem acesso ao teclado."),
    oracle("SN-N2", "9202", "Atender João Outro na recepção; trocar mouse."),
    oracle("SN-N3", "9203", "Mariana Exemplo pediu monitores novos."),
    oracle("SN-N4", "9204", "Mac da diretoria não liga."),
    oracle("SN-N5", "9205", "Entregar MacBook Air para Ana Exemplo."),
    oracle("SN-N6", "9206", "Macaco hidráulico e iMac antigo no depósito."),
    oracle("SN-N7", "9207", "ZBook com tela piscando."),
    { serie: "SN-N8", relacao: "somente_simpress", simpress: { ordens_servico: ["9208"], modelos: ["HP ZBook Firefly"] }, oracle: [] },
  ];
  try {
    const { section } = await montar({ semBusca: true });
    const busca = (termo, esperado, msg) => {
      panels.filtrarTabelaOs({ busca: termo, relacao: "todos" });
      assert.deepEqual(visiveis(section), esperado, msg || `"${termo}"`);
    };
    busca("joão", ["SN-N1", "SN-N2"], "primeiro nome acha as duas OS");
    busca("JOAO", ["SN-N1", "SN-N2"], "maiúscula e sem acento");
    busca("João Fictício Teste", ["SN-N1"], "nome completo exclui o homônimo");
    busca("joao outro", ["SN-N2"]);
    busca("joao inexistente", [], "nome completo com sobrenome que não existe");
    busca("ana", ["SN-N5"], "início de palavra: \"ana\" não acha \"Mariana\"");
    busca("mariana", ["SN-N3"]);

    busca("teclado", ["SN-N1"]);
    busca("mouse", ["SN-N2"]);
    busca("monitor", ["SN-N3"], "plural \"monitores\" casa");
    busca("zbook", ["SN-N7", "SN-N8"], "descrição e modelo");
    busca("mac", ["SN-N4", "SN-N5"], "mac casa Mac e MacBook, não macaco nem iMac");
    busca("MacBook", ["SN-N4", "SN-N5"], "macbook é sinônimo de mac");

    busca("9204", ["SN-N4"], "número da OS segue como antes");
    busca("n8", ["SN-N8"], "trecho de série segue como antes");
  } finally { panels.filtrarTabelaOs({ busca: "", relacao: "" }); report.chamados = original; report.chamados[0].simpress.modelos = modelo; }
});

test("Selo Entregue: só com etapa atual Pedido entregue e data DD/MM/AAAA, por textContent", async () => {
  const original = report.chamados;
  const simp = (serie, os, etapa) => ({ serie, relacao: "somente_simpress", simpress: { ordens_servico: [os], etapa_atual: etapa }, oracle: [] });
  report.chamados = [
    simp("BRJ551265R", "7303022", { chave: "entregue", rotulo: "Pedido entregue", data: "27/10/2026" }),
    simp("SN-SEMDATA", "7303023", { chave: "entregue", rotulo: "Pedido entregue", data: "" }),
    simp("SN-PARCIAL", "7303024", { chave: "entregue", rotulo: "Pedido entregue", data: "10/2026" }),
    simp("SN-CAMINHO", "7303025", { chave: "a_caminho", rotulo: "A caminho", data: "26/10/2026" }),
    simp("SN-XSS", "7303026", { chave: "entregue", rotulo: "Pedido entregue", data: "<img src=x onerror=alert(1)>" }),
    simp("SN-NULO", "7303027", null),
  ];
  try {
    const { section } = await montar({ semBusca: true });
    const selos = serie => section.querySelectorAll(`tbody tr[data-serial="${serie}"] .ck-os__selo--entregue`).map(selo => selo.textContent);
    assert.deepEqual(selos("BRJ551265R"), ["Entregue · 27/10/2026"]);
    ["SN-SEMDATA", "SN-PARCIAL", "SN-CAMINHO", "SN-XSS", "SN-NULO"].forEach(serie => assert.deepEqual(selos(serie), [], serie));
    assert.equal(section.querySelectorAll("img").length, 0);
  } finally { report.chamados = original; }
});
