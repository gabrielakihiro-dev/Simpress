// Relatório mensal (F8, Novo layout): gráfico semanal "Movimento do mês" e nomes de mês.
// frontend/src/paineis/relatorio-mensal/grafico-semanal.ts e mes-extenso.ts: o Node carrega .ts direto (só sintaxe apagável),
// sem importações; o DOM só entra em montarMovimento, que aqui roda sobre um document mínimo. Dados sintéticos.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const pasta = path.resolve(__dirname, "../../frontend/src/paineis/relatorio-mensal");
const grafico = require(path.join(pasta, "grafico-semanal.ts"));
const meses = require(path.join(pasta, "mes-extenso.ts"));

const ABERTA = "Aberta no mês";
const CONCLUIDA = "Concluída no mês";

test("mesPorExtenso: usa o rótulo do servidor e nunca devolve AAAA-MM", () => {
  assert.equal(meses.mesPorExtenso("2026-11", "novembro de 2026"), "novembro de 2026");
  assert.equal(meses.mesPorExtenso("2026-11", "2026-11"), "novembro de 2026");
  assert.equal(meses.mesPorExtenso("2026-03", ""), "março de 2026");
  assert.equal(meses.mesPorExtenso("", ""), "mês selecionado");
  assert.equal(meses.mesPorExtenso("2026-13", undefined), "mês selecionado");
});

test("nomeDoMes e capitalizar", () => {
  assert.equal(meses.nomeDoMes("2026-01"), "janeiro");
  assert.equal(meses.nomeDoMes("2026-12"), "dezembro");
  assert.equal(meses.nomeDoMes("2026-00"), "");
  assert.equal(meses.capitalizar("março"), "Março");
  assert.equal(meses.capitalizar(""), "");
});

test("diasDoMes: fevereiro de ano bissexto e chave inválida", () => {
  assert.equal(grafico.diasDoMes("2026-02"), 28);
  assert.equal(grafico.diasDoMes("2028-02"), 29);
  assert.equal(grafico.diasDoMes("2026-11"), 30);
  assert.equal(grafico.diasDoMes("2026-12"), 31);
  assert.equal(grafico.diasDoMes("2026-13"), 0);
  assert.equal(grafico.diasDoMes(""), 0);
});

test("semanasDoMes: mês fechado em blocos de 7 dias; o último, mais curto, não é parcial", () => {
  const semanas = grafico.semanasDoMes("2026-11");
  assert.deepEqual(semanas.map(s => [s.inicio, s.fim]), [[1, 7], [8, 14], [15, 21], [22, 28], [29, 30]]);
  assert.equal(semanas[0].rotulo, "01 a 07/11");
  assert.equal(semanas[4].rotulo, "29 e 30/11");
  assert.equal(semanas[4].parcial, false);
  assert.equal(semanas[4].titulo, "29 e 30/11");
  assert.ok(semanas.every(s => !s.parcial));
});

test("semanasDoMes: mês parcial termina na data de corte; corte de outro mês é ignorado", () => {
  const ate17 = grafico.semanasDoMes("2026-11", "2026-11-17", true);
  assert.deepEqual(ate17.map(s => [s.inicio, s.fim]), [[1, 7], [8, 14], [15, 17]]);
  assert.equal(ate17[2].parcial, true);
  assert.equal(ate17[2].rotulo, "15 a 17/11");
  const foraDoMes = grafico.semanasDoMes("2026-10", "2026-11-17", true);
  assert.equal(foraDoMes.length, 5);
  assert.equal(foraDoMes[4].fim, 31);
  assert.deepEqual(grafico.semanasDoMes("2026-13"), []);
});

test("contarPorSemana: abertas, concluídas e encerradas caem na semana certa e filtram por fonte", () => {
  const semanas = grafico.semanasDoMes("2026-11");
  const linhas = [
    { fonte: "Oracle", situacao: [ABERTA], criacao: "2026-11-02" },
    { fonte: "Oracle", situacao: [ABERTA, CONCLUIDA], criacao: "2026-11-09T08:00:00", conclusao: "2026-11-20" },
    { fonte: "Simpress", situacao: [CONCLUIDA], criacao: "2026-10-30", conclusao: "2026-11-05" },
    { fonte: "Simpress", situacao: [], criacao: "2026-11-30", encerrada: true },
    { fonte: "Simpress", situacao: [ABERTA], criacao: "" },
    { fonte: "Oracle", situacao: [ABERTA], criacao: "2026-10-31" },
  ];
  const ambas = grafico.contarPorSemana(linhas, semanas, "2026-11", "ambas");
  assert.deepEqual(ambas.map(s => s.abertas), [1, 1, 0, 0, 0]);
  assert.deepEqual(ambas.map(s => s.concluidas), [1, 0, 1, 0, 0]);
  assert.deepEqual(ambas.map(s => s.encerradas), [0, 0, 0, 0, 1]);
  const oracle = grafico.contarPorSemana(linhas, semanas, "2026-11", "oracle");
  assert.deepEqual(oracle.map(s => s.abertas), [1, 1, 0, 0, 0]);
  assert.deepEqual(oracle.map(s => s.concluidas), [0, 0, 1, 0, 0]);
  const simpress = grafico.contarPorSemana(linhas, semanas, "2026-11", "simpress");
  assert.deepEqual(simpress.map(s => s.concluidas), [1, 0, 0, 0, 0]);
  assert.deepEqual(simpress.map(s => s.encerradas), [0, 0, 0, 0, 1]);
});

test("contarPorSemana: encerrada com data de conclusão não conta como encerrada; entrada inválida vira zeros", () => {
  const semanas = grafico.semanasDoMes("2026-11");
  const comData = [{ fonte: "oracle", situacao: [], criacao: "2026-11-02", conclusao: "2026-11-03", encerrada: true }];
  assert.equal(grafico.contarPorSemana(comData, semanas, "2026-11", "ambas")[0].encerradas, 0);
  const vazio = grafico.contarPorSemana(null, semanas, "2026-11", "ambas");
  assert.equal(vazio.length, semanas.length);
  assert.ok(vazio.every(s => s.abertas === 0 && s.concluidas === 0 && s.encerradas === 0));
});

test("eixoY: topo é o máximo e as marcas usam passos redondos com no máximo 4 intervalos", () => {
  assert.deepEqual({ ...grafico.eixoY(0) }, { topo: 1, marcas: [0, 1] });
  assert.deepEqual({ ...grafico.eixoY(4) }, { topo: 4, marcas: [0, 1, 2, 3, 4] });
  assert.deepEqual({ ...grafico.eixoY(15) }, { topo: 15, marcas: [0, 5, 10, 15] });
  assert.deepEqual({ ...grafico.eixoY(40) }, { topo: 40, marcas: [0, 10, 20, 30, 40] });
  assert.deepEqual({ ...grafico.eixoY(7) }, { topo: 7, marcas: [0, 2, 4, 6] });
  for (const maximo of [0, 1, 3, 9, 16, 23, 99, 150, 801]) {
    const { marcas } = grafico.eixoY(maximo);
    assert.ok(marcas.length - 1 <= 4 + 1, `marcas demais para ${maximo}`);
  }
});

// document mínimo: só o que montarMovimento usa (createElement, createTextNode, append, setAttribute, dataset, style, replaceWith).
function criarDocumentoFalso() {
  class No {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.className = "";
      this.title = "";
      this.textContent = "";
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this.listeners = {};
      this.parent = null;
      const props = {};
      this.style = {
        setProperty: (nome, valor) => { props[nome] = valor; },
        getPropertyValue: nome => props[nome],
      };
    }
    append(...filhos) { filhos.forEach(f => { f.parent = this; this.children.push(f); }); }
    setAttribute(nome, valor) { this.attrs[nome] = String(valor); }
    getAttribute(nome) { return this.attrs[nome]; }
    addEventListener(nome, fn) { this.listeners[nome] = fn; }
    click() { this.listeners.click?.(); }
    replaceWith(novo) { const i = this.parent.children.indexOf(this); novo.parent = this.parent; this.parent.children[i] = novo; }
    todos(filtro, saida = []) { this.children.forEach(f => { if (filtro(f)) saida.push(f); f.todos?.(filtro, saida); }); return saida; }
    porClasse(classe) { return this.todos(n => String(n.className).split(" ").includes(classe)); }
  }
  return { createElement: tag => new No(tag), createTextNode: texto => ({ textContent: String(texto), children: [] }), No };
}

test("montarMovimento: segmentado Fonte, legenda com totais, barras com title e atraso de 40 ms", () => {
  const doc = criarDocumentoFalso();
  global.document = doc;
  try {
    const os = {
      oracle: { abertas: 2, concluidas: 1, encerradas_sem_data: 0 },
      simpress: { abertas: 1, concluidas: 0, encerradas_sem_data: 1 },
      linhas: [
        { fonte: "Oracle", situacao: [ABERTA], criacao: "2026-11-02" },
        { fonte: "Oracle", situacao: [ABERTA], criacao: "2026-11-10" },
        { fonte: "Oracle", situacao: [CONCLUIDA], conclusao: "2026-11-03" },
        { fonte: "Simpress", situacao: [ABERTA], criacao: "2026-11-04" },
        { fonte: "Simpress", situacao: [], criacao: "2026-11-05", encerrada: true },
      ],
    };
    const mes = { key: "2026-11", parcial: true, data_corte: "2026-11-17" };
    const escolhidas = [];
    const { seletor, grafico: g } = grafico.montarMovimento(os, mes, "ambas", fonte => escolhidas.push(fonte));
    const cartao = new doc.No("div"); // o painel põe o gráfico no cartão; trocar a fonte o substitui ali
    cartao.append(g);

    assert.equal(seletor.getAttribute("role"), "group");
    assert.equal(seletor.getAttribute("aria-label"), "Fonte");
    assert.deepEqual(seletor.children.map(b => b.textContent), ["Ambas", "Oracle", "Simpress"]);
    assert.deepEqual(seletor.children.map(b => b.getAttribute("aria-pressed")), ["true", "false", "false"]);

    const legenda = g.porClasse("nf8-leg")[0];
    assert.deepEqual(legenda.children.map(item => item.children[1].textContent + item.children[2].textContent), ["Abertas3", "Concluídas1", "Encerradas1"]);

    const plot = g.porClasse("nf8-plot")[0];
    assert.equal(plot.getAttribute("role"), "img");
    assert.match(plot.getAttribute("aria-label"), /^Movimento do mês por semana, Oracle e Simpress: 01 a 07\/11: Abertas 2/);

    const barras = g.porClasse("nf8-b");
    assert.equal(barras.length, 9); // 3 semanas (até 17/11) x 3 séries
    assert.equal(barras[0].title, "01 a 07/11 · Abertas: 2");
    assert.equal(barras[0].style.height, "100%");
    assert.deepEqual(barras.slice(0, 4).map(b => b.style.animationDelay), ["0ms", "40ms", "80ms", "120ms"]);
    assert.ok(barras.every(b => parseInt(b.style.animationDelay, 10) <= 400));
    assert.equal(g.porClasse("nf8-xs")[0].children[2].children[0].textContent, "parcial");

    seletor.children[1].click();
    assert.deepEqual(escolhidas, ["oracle"]);
    assert.deepEqual(seletor.children.map(b => b.getAttribute("aria-pressed")), ["false", "true", "false"]);
    assert.equal(cartao.children.length, 1);
    assert.notEqual(cartao.children[0], g);
    assert.equal(cartao.children[0].dataset.fonte, "oracle");
    assert.equal(cartao.children[0].porClasse("nf8-leg")[0].children[0].children[2].textContent, "2");
    seletor.children[1].click();
    assert.deepEqual(escolhidas, ["oracle"]); // clicar na fonte já ativa não redesenha
  } finally {
    delete global.document;
  }
});

test("montarMovimento: mês sem semanas mostra o aviso vazio e fonte inválida cai em Ambas", () => {
  const doc = criarDocumentoFalso();
  global.document = doc;
  try {
    const { seletor, grafico: g } = grafico.montarMovimento({ linhas: [] }, { key: "" }, "xyz");
    assert.deepEqual(seletor.children.map(b => b.getAttribute("aria-pressed")), ["true", "false", "false"]);
    assert.equal(g.children[0].className, "ck-lista__vazio");
    assert.equal(g.children[0].textContent, "Sem dados semanais para este mês.");
  } finally {
    delete global.document;
  }
});
