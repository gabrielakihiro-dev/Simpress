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

// ---------- Links de chamado e OS no texto do lembrete (DOM falso mínimo; dados sintéticos) ----------

const modeloChamadosOs = require(path.join(__dirname, "../../static/js/shared/chamados-os-model.js"));

class No {
  constructor(tag) { this.tag = tag; this.filhos = []; this.attrs = {}; this.dataset = {}; this.className = ""; this.texto = ""; this.classList = { add: classe => { this.className = `${this.className} ${classe}`.trim(); } }; }
  get textContent() { return this.texto + this.filhos.map(filho => filho.textContent).join(""); }
  set textContent(valor) { this.texto = String(valor); this.filhos = []; }
  append(...nos) { this.filhos.push(...nos); }
  replaceChildren(...nos) { this.filhos = nos; }
  setAttribute(nome, valor) { this.attrs[nome] = String(valor); }
  getAttribute(nome) { return this.attrs[nome] ?? null; }
}
const noTexto = texto => Object.assign(new No("#texto"), { texto });
const buscar = (no, teste, achados = []) => { if (teste(no)) achados.push(no); no.filhos.forEach(filho => buscar(filho, teste, achados)); return achados; };
const temClasse = (no, classe) => String(no.className).split(" ").includes(classe);

// Renderiza lembretes sintéticos pelo próprio carregarLembretes; devolve as duas listas e a feature.
async function renderizarLembretes(descricoes, { comModelo = true } = {}) {
  const ids = ["lembretes-lista", "lembretes-concluidos-lista", "lembretes-vazio", "lembretes-concluidos", "lembretes-concluidos-rotulo", "lembretes-pendentes", "lembretes-concluidos-botao"];
  const elementos = new Map(ids.map(id => [id, new No(id)]));
  global.document = {
    getElementById: id => elementos.get(id) ?? null,
    createElement: tag => new No(tag),
    createElementNS: (_ns, tag) => new No(tag),
    createTextNode: noTexto,
    querySelectorAll: () => [],
    activeElement: null,
  };
  const lista = descricoes.map(([descricao, concluido = false], i) => ({ id: i + 1, descricao, concluido, criado_em: "2026-11-12T10:00:00-03:00", alterado_em: null }));
  const feature = require(path.join(recursos, "lembretes.js"))({
    app: { showToast() {} },
    apiFetch: async () => ({ lembretes: lista }),
    ...(comModelo ? { chamadosOsModel: modeloChamadosOs } : {}),
  });
  await feature.carregarLembretes();
  return { feature, pendentes: elementos.get("lembretes-lista"), concluidos: elementos.get("lembretes-concluidos-lista") };
}

const textoDe = li => buscar(li, no => temClasse(no, "lembretes__texto"))[0];
const linksDe = li => buscar(li, no => temClasse(no, "lembretes__ref"));

test("lembrete: chamado e OS no texto viram botões e o resto continua texto, na mesma ordem", async () => {
  const descricao = "Ver UTIC-2026-0833 e a OS 1234567 hoje.";
  try {
    const { pendentes } = await renderizarLembretes([[descricao]]);
    const texto = textoDe(pendentes.filhos[0]);
    assert.equal(texto.textContent, descricao, "o texto visível não muda");
    assert.deepEqual(texto.filhos.map(no => no.tag), ["#texto", "button", "#texto", "button", "#texto"]);
    const [chamado, os] = linksDe(pendentes.filhos[0]);
    assert.equal(chamado.textContent, "UTIC-2026-0833");
    assert.equal(chamado.type, "button");
    assert.equal(chamado.getAttribute("aria-haspopup"), "dialog");
    assert.equal(chamado.getAttribute("aria-label"), "Abrir o chamado UTIC-2026-0833 na janela Chamado × OS");
    assert.equal(chamado.getAttribute("data-on-click"), "abrirReferenciaLembrete");
    assert.deepEqual(JSON.parse(chamado.getAttribute("data-args")), [{ tipo: "chamado", numero: "UTIC-2026-0833" }, "$this"]);
    assert.equal(os.textContent, "1234567");
    assert.equal(os.getAttribute("aria-label"), "Abrir a OS 1234567 na janela Chamado × OS");
    assert.deepEqual(JSON.parse(os.getAttribute("data-args")), [{ tipo: "os", numero: "1234567" }, "$this"]);
    assert.ok(temClasse(chamado, "ck-link-btn") && temClasse(chamado, "ck-mono"));
  } finally { delete global.document; }
});

test("lembrete: data, telefone, valor e número colado a letra, hífen ou barra não viram link", async () => {
  const descricao = "Ligar 41 99999-1234 em 12/11/2026, pagar 1.234.567,89 (ref 1234567/2, X1234567, UTIC-2026-0833X).";
  try {
    const { pendentes } = await renderizarLembretes([[descricao]]);
    assert.deepEqual(linksDe(pendentes.filhos[0]), []);
    assert.equal(textoDe(pendentes.filhos[0]).textContent, descricao);
  } finally { delete global.document; }
});

test("lembrete concluído (riscado) mantém o link; sem o modelo no contexto o texto fica puro", async () => {
  try {
    const feito = await renderizarLembretes([["Fechar UTIC-2026-7", true]]);
    assert.equal(linksDe(feito.concluidos.filhos[0]).length, 1);
    assert.ok(temClasse(feito.concluidos.filhos[0], "lembretes__item--feito"));
    const puro = await renderizarLembretes([["Fechar UTIC-2026-7"]], { comModelo: false });
    assert.deepEqual(linksDe(puro.pendentes.filhos[0]), []);
    assert.equal(textoDe(puro.pendentes.filhos[0]).textContent, "Fechar UTIC-2026-7");
  } finally { delete global.document; }
});

test("lembrete: na edição o texto vira o campo (sem links) e o botão de concluir continua à parte do link", async () => {
  try {
    const { feature, pendentes } = await renderizarLembretes([["Ver UTIC-2026-0833"]]);
    const li = pendentes.filhos[0];
    assert.ok(buscar(li, no => temClasse(no, "lembretes__marcar")).length === 1 && linksDe(li).length === 1);
    assert.ok(!linksDe(li)[0].getAttribute("data-on-click")?.startsWith("lembretes"), "o link não aciona concluir nem editar");
    feature.lembretesEditar(1);
    assert.deepEqual(linksDe(pendentes.filhos[0]), []);
  } finally { delete global.document; }
});

test("lembrete: o módulo monta os links sem innerHTML", () => {
  const fs = require("node:fs");
  const fonte = fs.readFileSync(path.join(recursos, "lembretes.js"), "utf8");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(fonte));
});
