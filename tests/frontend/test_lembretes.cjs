// Lembretes (Termo → Lembrete): montarDescricaoTermo é função pura; os dados são sintéticos.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const recursos = path.join(__dirname, "../../static/js/features");
const termos = require(path.join(recursos, "termos.js"))({ app: {} });
// Como no app: a data vem de termosFormatarData, publicada em app pela feature termos.
const { montarDescricaoTermo } = require(path.join(recursos, "lembretes.js"))({
  app: { termosFormatarData: termos.termosFormatarData },
  apiFetch: async () => ({}),
});

const itens = (rotulos, marcados) => rotulos.map((rotulo, i) => ({ rotulo, resposta: marcados[i] ?? "" }));
const ROTULOS = ["01 Mochila", "02 Notebook", "03 Teclado"];

function entrega(campos = {}, extra = {}) {
  return {
    termo: "entrega",
    campos: {
      nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo_anterior: "Dell 5420", modelo_entregue: "HP 640 G11",
      serie_anterior: "ANTIGA123", serie_entregue: "NOVA456", ...campos,
    },
    itens: itens(ROTULOS, ["", "sim", "sim"]),
    obs: "Sem avarias.",
    ...extra,
  };
}

function devolucao(campos = {}, extra = {}) {
  return {
    termo: "devolucao",
    campos: { nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo: "HP 640 G10", serie: "BRJ123", ...campos },
    itens: itens(ROTULOS, ["sim", "nao", "sim"]),
    obs: "Carregador trocado.",
    ...extra,
  };
}

test("entrada: modelo completo, na ordem do texto aprovado", () => {
  assert.equal(
    montarDescricaoTermo("entrega", entrega()),
    "Entrada: Maria Teste (Curitiba) recebeu HP 640 G11, série NOVA456 em 12/11/2026. "
    + "Itens: 02 Notebook, 03 Teclado. Anterior: Dell 5420, série ANTIGA123. Obs.: Sem avarias.",
  );
});

test("saída: modelo completo, sem a parte Anterior", () => {
  assert.equal(
    montarDescricaoTermo("devolucao", devolucao()),
    "Saída: Maria Teste (Curitiba) devolveu HP 640 G10, série BRJ123 em 12/11/2026. "
    + "Itens: 01 Mochila, 03 Teclado. Obs.: Carregador trocado.",
  );
});

test("itens marcados Não ou sem resposta ficam de fora", () => {
  const texto = montarDescricaoTermo("devolucao", devolucao({}, { itens: itens(ROTULOS, ["nao", "", "nao"]) }));
  assert.equal(texto, "Saída: Maria Teste (Curitiba) devolveu HP 640 G10, série BRJ123 em 12/11/2026. Obs.: Carregador trocado.");
});

test("entrada: partes vazias ficam de fora, sem vírgula nem espaço sobrando", () => {
  const vazio = entrega(
    { unidade: "", data: "", modelo_anterior: "", serie_anterior: "", modelo_entregue: "" },
    { itens: itens(ROTULOS, []), obs: "" },
  );
  assert.equal(montarDescricaoTermo("entrega", vazio), "Entrada: Maria Teste recebeu série NOVA456.");

  const soModelo = entrega({ serie_entregue: "", unidade: "", data: "", modelo_anterior: "", serie_anterior: "" }, { itens: itens(ROTULOS, []), obs: "" });
  assert.equal(montarDescricaoTermo("entrega", soModelo), "Entrada: Maria Teste recebeu HP 640 G11.");

  const soSerieAnterior = entrega({ modelo_anterior: "" }, { itens: itens(ROTULOS, []), obs: "" });
  assert.equal(
    montarDescricaoTermo("entrega", soSerieAnterior),
    "Entrada: Maria Teste (Curitiba) recebeu HP 640 G11, série NOVA456 em 12/11/2026. Anterior: série ANTIGA123.",
  );
});

test("saída: partes vazias ficam de fora", () => {
  const vazio = devolucao({ unidade: "", data: "", modelo: "" }, { itens: itens(ROTULOS, []), obs: "" });
  assert.equal(montarDescricaoTermo("devolucao", vazio), "Saída: Maria Teste devolveu série BRJ123.");
});

test("quebra de linha, tab e espaços repetidos viram um espaço só, em qualquer campo", () => {
  const sujo = entrega(
    { nome: "Maria\n  Teste", unidade: "Curitiba\tSul" },
    { obs: "Linha 1\r\nLinha 2\t\tfim  ", itens: itens(["01 Mochila\n(preta)", ...ROTULOS.slice(1)], ["sim"]) },
  );
  const texto = montarDescricaoTermo("entrega", sujo);
  assert.equal(
    texto,
    "Entrada: Maria Teste (Curitiba Sul) recebeu HP 640 G11, série NOVA456 em 12/11/2026. "
    + "Itens: 01 Mochila (preta). Anterior: Dell 5420, série ANTIGA123. Obs.: Linha 1 Linha 2 fim",
  );
  // O backend recusa qualquer caractere de controle (categoria Cc): nenhum pode sobrar.
  assert.ok(!/\p{Cc}/u.test(texto));
  assert.ok(!/ {2}/.test(texto));
});

test("nada é cortado: o texto longo sai inteiro e o limite de 2000 é de quem confirma", () => {
  const obs = "a".repeat(2500);
  const texto = montarDescricaoTermo("devolucao", devolucao({}, { obs }));
  assert.ok(texto.endsWith(`Obs.: ${obs}`));
  assert.ok([...texto].length > 2000);
});

test("sem dados não quebra", () => {
  assert.equal(typeof montarDescricaoTermo("entrega", {}), "string");
  assert.equal(typeof montarDescricaoTermo("devolucao", undefined), "string");
});

test("o módulo não escreve em console nem em storage (a descrição tem dado pessoal)", () => {
  const fs = require("node:fs");
  const fonte = fs.readFileSync(path.join(recursos, "lembretes.js"), "utf8");
  assert.ok(!/console\.(log|info|debug|warn|error)/.test(fonte));
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(fonte));
});
