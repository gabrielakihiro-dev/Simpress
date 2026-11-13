// Lembretes (Termo → Lembrete): montarDescricaoTermo é função pura; os dados são sintéticos.
const assert = require("node:assert/strict");
const path = require("node:path");
const { createFakeDocument } = require("./support/fake-dom.cjs");
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

// ---- Lembrete criado de um termo: cópia dos dados, bloco "Dados do termo" e ações (dados sintéticos) ----

const criarLembretes = require(path.join(recursos, "lembretes.js"));

// Dados que termosLerValidado devolveria; o teste muda este objeto para provar que o POST leva uma cópia.
const doFormulario = (termo) => (termo === "entrega" ? entrega() : devolucao());

// Respostas como o backend devolve: origem e termo sempre presentes (null quando não vieram no POST).
function respostaServidor(id, corpo, criadoEm = "2026-11-12T10:00:00-03:00") {
  return { id, descricao: corpo.descricao, criado_em: criadoEm, alterado_em: null, concluido: false, concluido_em: null, origem: corpo.origem ?? null, termo: corpo.termo ?? null };
}

// Cena com a lista, o diálogo Criar lembrete e o campo de adicionar. O fake não traz classList: cada nó recebe um add().
// document é trocado e restaurado no fim; app e apiFetch são espiões.
async function comCena(corpo, { armazenados = [], formulario = doFormulario } = {}) {
  const doc = createFakeDocument();
  const criarNo = doc.createElement;
  doc.createElement = (tag) => {
    const no = criarNo(tag);
    no.classList = { add: (classe) => { no.className = `${no.className} ${classe}`.trim(); } };
    return no;
  };
  const novo = (tag, id) => {
    const el = doc.createElement(tag);
    el.setAttribute("id", id);
    doc.body.append(el);
    return el;
  };
  for (const id of ["lembretes-lista", "lembretes-concluidos-lista", "lembretes-vazio", "lembretes-concluidos", "lembretes-concluidos-rotulo", "lembretes-pendentes", "termos-status-entrega"]) novo("div", id);
  novo("button", "lembretes-concluidos-botao");
  novo("button", "lembretes-adicionar");
  novo("button", "lembretes-criar-ok");
  novo("p", "lembretes-criar-erro");
  for (const id of ["lembretes-criar-descricao", "lembretes-novo-descricao"]) Object.assign(novo("input", id), { value: "" });

  const cena = { doc, armazenados, requisicoes: [], posts: [], falhar: 0, pdf: [], preencher: [], dialogos: [], toasts: [] };
  const apiFetch = async (url, opcoes = {}) => {
    const metodo = opcoes.method || "GET";
    cena.requisicoes.push({ url, metodo });
    if (metodo === "GET") return { lembretes: cena.armazenados };
    if (metodo !== "POST") return {};
    const enviado = JSON.parse(opcoes.body);
    cena.posts.push(enviado);
    if (cena.falhar > 0) {
      cena.falhar -= 1;
      throw Object.assign(new Error("Falha de teste."), { status: 500 });
    }
    return respostaServidor(`id${cena.posts.length}`, enviado);
  };
  const app = {
    termosFormatarData: termos.termosFormatarData,
    termosSecoesLembrete: termos.termosSecoesLembrete,
    termosLerValidado: (termo) => formulario(termo),
    termosGerarPdfDoLembrete: (...args) => { cena.pdf.push(args); },
    termosPreencherDoLembrete: (...args) => { cena.preencher.push(args); },
    abrirModalAcessivel: (id) => cena.dialogos.push(["abrir", id]),
    fecharModalAcessivel: (id) => cena.dialogos.push(["fechar", id]),
    showToast: (texto, tipo) => cena.toasts.push([texto, tipo]),
  };
  cena.api = criarLembretes({ app, apiFetch });
  cena.porId = (id) => doc.getElementById(id);
  cena.itens = () => cena.porId("lembretes-lista").children;
  cena.item = (id) => cena.itens().find((li) => li.dataset.lembreteId === id);
  const anterior = globalThis.document;
  globalThis.document = doc;
  try {
    await corpo(cena);
  } finally {
    if (anterior === undefined) delete globalThis.document;
    else globalThis.document = anterior;
  }
}

// Dados salvos como o backend grava: respostas dos itens (sem rótulo), na ordem do termo.
const termoSalvo = (origem = "entrega") => ({
  campos: origem === "entrega"
    ? { nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo_anterior: "Dell 5420", modelo_entregue: "HP 640 G11", serie_anterior: "ANTIGA123", serie_entregue: "NOVA456" }
    : { nome: "Joao Teste", unidade: "Londrina", data: "2026-11-10", modelo: "HP 640 G10", serie: "BRJ123" },
  itens: ["", "sim", "nao", "", "", "", "", "", "", "", ""],
  obs: "Sem avarias.",
});

const lembreteSalvo = (id, extra = {}) => ({
  id, descricao: `Descrição ${id}`, criado_em: "2026-11-12T10:00:00-03:00", alterado_em: null, concluido: false, concluido_em: null, origem: null, termo: null, ...extra,
});

// Cria o lembrete pelo diálogo: abre com o termo da tela, o usuário revisa o texto e confirma.
async function criarDoTermo(cena, termo, texto) {
  cena.api.lembretesCriarDoTermo(termo);
  if (texto !== undefined) cena.porId("lembretes-criar-descricao").value = texto;
  await cena.api.lembretesConfirmarCriar();
}

test("criar de um termo envia termo {campos, itens só com as respostas, obs} junto de descricao e origem", async () => {
  await comCena(async (cena) => {
    await criarDoTermo(cena, "entrega", "Texto revisado pelo usuário.");
    assert.equal(cena.posts.length, 1);
    assert.deepEqual(cena.posts[0], {
      descricao: "Texto revisado pelo usuário.",
      origem: "entrega",
      termo: {
        campos: entrega().campos,
        itens: ["", "sim", "sim"],
        obs: "Sem avarias.",
      },
    });
    assert.deepEqual(cena.dialogos, [["abrir", "lembretes-criar"], ["fechar", "lembretes-criar"]]);

    await criarDoTermo(cena, "devolucao");
    assert.equal(cena.posts[1].origem, "devolucao");
    assert.deepEqual(cena.posts[1].termo, { campos: devolucao().campos, itens: ["sim", "nao", "sim"], obs: "Carregador trocado." });
  });
});

test("criar de um termo envia uma cópia tirada ao abrir o diálogo: mudar o termo depois não altera o POST", async () => {
  const dados = entrega();
  await comCena(async (cena) => {
    cena.api.lembretesCriarDoTermo("entrega");
    dados.campos.nome = "Mudou Depois";
    dados.itens[0].resposta = "sim";
    dados.obs = "Mudou depois";
    await cena.api.lembretesConfirmarCriar();
    assert.equal(cena.posts[0].termo.campos.nome, "Maria Teste");
    assert.deepEqual(cena.posts[0].termo.itens, ["", "sim", "sim"]);
    assert.equal(cena.posts[0].termo.obs, "Sem avarias.");
  }, { formulario: () => dados });
});

test("a cópia do termo segue os limites do backend: controle vira espaço e texto longo é cortado", async () => {
  const dados = entrega();
  dados.campos.nome = `Maria\x0bTeste${"x".repeat(300)}`;
  dados.obs = `Linha 1\r\nLinha\t2\x0b\u0085fim${"y".repeat(2500)}`;
  await comCena(async (cena) => {
    await criarDoTermo(cena, "entrega", "Descrição curta.");
    const { campos, obs } = cena.posts[0].termo;
    assert.equal([...campos.nome].length, 200);
    assert.ok(campos.nome.startsWith("Maria Teste"));
    assert.equal([...obs].length, 2000);
    assert.ok(obs.startsWith("Linha 1\r\nLinha\t2  fim"));
  }, { formulario: () => dados });
});

test("cancelar o diálogo zera a cópia: nada é enviado e o próximo POST não leva o termo antigo", async () => {
  await comCena(async (cena) => {
    cena.api.lembretesCriarDoTermo("entrega");
    cena.api.lembretesCancelarCriar();
    // Confirmar depois de cancelar não envia nada.
    await cena.api.lembretesConfirmarCriar();
    assert.equal(cena.posts.length, 0);

    // Um novo diálogo pega os dados da hora, não os de antes.
    cena.api.lembretesCriarDoTermo("devolucao");
    await cena.api.lembretesConfirmarCriar();
    assert.equal(cena.posts.length, 1);
    assert.equal(cena.posts[0].origem, "devolucao");
    assert.equal(cena.posts[0].termo.campos.modelo, "HP 640 G10");
    assert.equal("modelo_entregue" in cena.posts[0].termo.campos, false);

    // Depois de criar, a cópia também zera: o adicionar manual envia só a descrição.
    cena.porId("lembretes-novo-descricao").value = "Lembrete manual";
    await cena.api.lembretesAdicionar();
    assert.equal(cena.posts.length, 2);
    assert.deepEqual(cena.posts[1], { descricao: "Lembrete manual" });
  });
});

test("erro no POST mantém o diálogo e a cópia: tentar de novo envia o mesmo termo", async () => {
  await comCena(async (cena) => {
    cena.falhar = 1;
    await criarDoTermo(cena, "entrega", "Descrição revisada");
    assert.equal(cena.toasts.length, 1);
    assert.equal(cena.dialogos.some(([acao]) => acao === "fechar"), false);
    await cena.api.lembretesConfirmarCriar();
    assert.equal(cena.posts.length, 2);
    assert.deepEqual(cena.posts[1], cena.posts[0]);
    assert.equal(cena.posts[1].termo.campos.serie_entregue, "NOVA456");
    assert.equal(cena.itens().length, 1);
  });
});

test("lembrete com termo mostra o bloco Dados do termo com as seções e os dois botões", async () => {
  const armazenados = [lembreteSalvo("a1", { origem: "entrega", termo: termoSalvo("entrega") })];
  await comCena(async (cena) => {
    await cena.api.carregarLembretes();
    const item = cena.item("a1");
    const blocos = item.querySelectorAll("details.lembretes__termo");
    assert.equal(blocos.length, 1);
    const bloco = blocos[0];
    assert.equal(bloco.open, undefined);
    assert.equal(bloco.querySelector("summary.lembretes__termo-resumo").textContent, "Dados do termo");

    const titulos = bloco.querySelectorAll("h3.lembretes__termo-titulo").map((h) => h.textContent);
    assert.deepEqual(titulos, ["Dados do colaborador", "Identificação do equipamento", "Equipamentos e acessórios entregues", "Observações"]);
    const linhas = Object.fromEntries(bloco.querySelectorAll(".lembretes__termo-linha").map((l) => [l.querySelector("dt").textContent, l.querySelector("dd").textContent]));
    assert.equal(linhas["Nome do colaborador"], "Maria Teste");
    assert.equal(linhas["Data da entrega / troca"], "12/11/2026");
    assert.equal(linhas["Modelo do computador, equipamento entregue"], "HP 640 G11");
    assert.equal(linhas["Número de série / Service Tag, equipamento anterior"], "ANTIGA123");
    assert.equal(linhas["01 Mochila"], "—");
    assert.equal(linhas["02 Notebook"], "Sim");
    assert.equal(linhas["03 Teclado"], "Não");
    assert.equal(bloco.querySelectorAll(".lembretes__termo-linha").length, 4 + 3 + 11);
    assert.equal(bloco.querySelector("p.lembretes__termo-obs").textContent, "Sem avarias.");

    const botoes = bloco.querySelectorAll(".lembretes__termo-acoes button");
    assert.deepEqual(botoes.map((b) => b.textContent), ["Gerar PDF", "Preencher no Termo"]);
    assert.deepEqual(botoes.map((b) => b.getAttribute("data-on-click")), ["lembretesGerarPdfTermo", "lembretesPreencherTermo"]);
    assert.ok(botoes.every((b) => b.type === "button" && b.getAttribute("data-args") === '["a1"]'));
  }, { armazenados });
});

test("lembrete da devolução mostra só as seções da devolução", async () => {
  const armazenados = [lembreteSalvo("d1", { origem: "devolucao", termo: termoSalvo("devolucao") })];
  await comCena(async (cena) => {
    await cena.api.carregarLembretes();
    const bloco = cena.item("d1").querySelector("details.lembretes__termo");
    const titulos = bloco.querySelectorAll("h3.lembretes__termo-titulo").map((h) => h.textContent);
    assert.deepEqual(titulos, ["Dados do colaborador", "Equipamentos e acessórios devolvidos", "Observações"]);
    assert.ok(!titulos.includes("Identificação do equipamento"));
  }, { armazenados });
});

test("lembrete sem termo, com termo estranho ou com origem desconhecida não mostra o bloco", async () => {
  const armazenados = [
    lembreteSalvo("m1"),
    lembreteSalvo("o1", { origem: "entrega" }),
    lembreteSalvo("e1", { origem: "entrega", termo: "texto" }),
    lembreteSalvo("e2", { origem: "entrega", termo: { campos: {} } }),
    lembreteSalvo("x1", { origem: "inventada", termo: termoSalvo("entrega") }),
  ];
  await comCena(async (cena) => {
    await cena.api.carregarLembretes();
    assert.equal(cena.itens().length, 5);
    assert.equal(cena.doc.querySelectorAll("details.lembretes__termo").length, 0);
    // O texto e os botões de editar e excluir seguem normais.
    assert.equal(cena.item("m1").querySelector("p.lembretes__texto").textContent, "Descrição m1");
    assert.equal(cena.item("m1").querySelectorAll(".lembretes__acoes button").length, 2);
  }, { armazenados });
});

test("o bloco aberto continua aberto quando a lista é redesenhada; o fechado continua fechado", async () => {
  const armazenados = [
    lembreteSalvo("a1", { origem: "entrega", termo: termoSalvo("entrega"), criado_em: "2026-11-12T10:00:00-03:00" }),
    lembreteSalvo("d1", { origem: "devolucao", termo: termoSalvo("devolucao"), criado_em: "2026-11-12T11:00:00-03:00" }),
  ];
  await comCena(async (cena) => {
    await cena.api.carregarLembretes();
    const antes = cena.item("a1").querySelector("details.lembretes__termo");
    antes.open = true;

    // Adicionar um lembrete refaz a lista inteira.
    cena.porId("lembretes-novo-descricao").value = "Outro lembrete";
    await cena.api.lembretesAdicionar();
    assert.equal(cena.itens().length, 3);
    const depois = cena.item("a1").querySelector("details.lembretes__termo");
    assert.notEqual(depois, antes, "o item foi recriado");
    assert.equal(depois.open, true);
    assert.equal(cena.item("d1").querySelector("details.lembretes__termo").open, undefined);

    // Fechado pelo usuário, volta fechado no redesenho seguinte.
    depois.open = false;
    cena.porId("lembretes-novo-descricao").value = "Mais um";
    await cena.api.lembretesAdicionar();
    assert.notEqual(cena.item("a1").querySelector("details.lembretes__termo").open, true);
  }, { armazenados });
});

test("Gerar PDF e Preencher no Termo chamam o termos com a origem e os dados salvos do lembrete", async () => {
  const entregaSalva = termoSalvo("entrega");
  const devolucaoSalva = termoSalvo("devolucao");
  const armazenados = [
    lembreteSalvo("a1", { origem: "entrega", termo: entregaSalva }),
    lembreteSalvo("d1", { origem: "devolucao", termo: devolucaoSalva }),
    lembreteSalvo("m1"),
  ];
  await comCena(async (cena) => {
    await cena.api.carregarLembretes();
    cena.api.lembretesGerarPdfTermo("a1");
    cena.api.lembretesPreencherTermo("d1");
    cena.api.lembretesGerarPdfTermo("d1");
    cena.api.lembretesPreencherTermo("a1");
    assert.deepEqual(cena.pdf, [["entrega", entregaSalva], ["devolucao", devolucaoSalva]]);
    assert.deepEqual(cena.preencher, [["devolucao", devolucaoSalva], ["entrega", entregaSalva]]);
    assert.equal(cena.pdf[0][1], entregaSalva, "os dados são os do lembrete, sem passar pelo formulário");

    // Sem termo, id desconhecido: nada é chamado.
    cena.api.lembretesGerarPdfTermo("m1");
    cena.api.lembretesPreencherTermo("m1");
    cena.api.lembretesGerarPdfTermo("nao-existe");
    cena.api.lembretesPreencherTermo("nao-existe");
    assert.equal(cena.pdf.length, 2);
    assert.equal(cena.preencher.length, 2);
  }, { armazenados });
});
