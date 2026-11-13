// Termos de entrega e devolução: funções puras e garantia de que nada é guardado (LGPD).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const test = require("node:test");

const caminhoFonte = path.join(__dirname, "../../static/js/features/termos.js");
const criarTermos = require(caminhoFonte);
const termos = criarTermos({ app: {} });

test("termosFormatarData fatia aaaa-mm-dd sem passar por Date", () => {
  assert.equal(termos.termosFormatarData("2026-11-09"), "09/11/2026");
  assert.equal(termos.termosFormatarData("2026-01-01"), "01/01/2026");
  assert.equal(termos.termosFormatarData(""), "");
  assert.equal(termos.termosFormatarData(null), "");
  assert.equal(termos.termosFormatarData(undefined), "");
});

test("termosNomeArquivo junta série em maiúsculas e nome completo", () => {
  assert.equal(
    termos.termosNomeArquivo("brj54925dn", "Janaina do Rocio Santos Rocha"),
    "BRJ54925DN - Janaina do Rocio Santos Rocha",
  );
  assert.equal(termos.termosNomeArquivo("  brj54925dn  ", "  José   da  Conceição "), "BRJ54925DN - José da Conceição");
});

test("termosNomeArquivo usa só o lado preenchido, sem separador", () => {
  assert.equal(termos.termosNomeArquivo("brj54925dn", ""), "BRJ54925DN");
  assert.equal(termos.termosNomeArquivo("", "Maria Silva"), "Maria Silva");
  assert.equal(termos.termosNomeArquivo("   ", "Maria Silva"), "Maria Silva");
});

test("termosNomeArquivo devolve valor falso quando os dois lados ficam vazios", () => {
  assert.ok(!termos.termosNomeArquivo("", ""));
  assert.ok(!termos.termosNomeArquivo("  ", "\t"));
  assert.ok(!termos.termosNomeArquivo(null, undefined));
  assert.ok(!termos.termosNomeArquivo("/\\:*?\"<>|", "///"));
});

test("termosNomeArquivo remove caracteres proibidos em nome de arquivo", () => {
  const nome = termos.termosNomeArquivo('br/j\\5:4*9?2"5<d>n|', 'Ana/ \\ : * ? " < > | Souza');
  assert.equal(nome, "BRJ54925DN - Ana Souza");
  for (const proibido of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!nome.includes(proibido), `não pode conter ${proibido}`);
  }
});

test("termosLimparParte limita cada parte a 100 caracteres", () => {
  assert.equal(termos.termosLimparParte("a".repeat(150)).length, 100);
  assert.equal(termos.termosLimparParte("x".repeat(150), true), "X".repeat(100));
  const nome = termos.termosNomeArquivo("s".repeat(150), "n".repeat(150));
  assert.equal(nome, `${"S".repeat(100)} - ${"n".repeat(100)}`);
});

test("termos.js não guarda nem envia dados (sem storage, cookie, fetch nem innerHTML; só o GET fixo da assinatura)", () => {
  const codigo = fs.readFileSync(caminhoFonte, "utf8");
  for (const proibido of [
    "localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "innerHTML", "XMLHttpRequest", "sendBeacon",
    "http://", "https://", "new Image", "window.open", "location.", "WebSocket", "EventSource", "import(",
  ]) {
    assert.ok(!codigo.includes(proibido), `termos.js não pode usar ${proibido}`);
  }
  // A única rota citada é a da assinatura do técnico, constante, sem parâmetro nem concatenação.
  assert.deepEqual(codigo.match(/["'`]\/api\/[^"'`]*["'`]/g), ['"/api/assinatura-tecnico"']);
  // E a única URL atribuída (src/href) é essa constante.
  assert.deepEqual(codigo.match(/\.(src|href)\s*=[^=;]*/g), [".src = URL_ASSINATURA"]);
});

test("index.html traz as abas e os botões aprovados e nenhum Imprimir", () => {
  const html = assembledHtml();
  for (const texto of ["Termo Entrega", "Termo Devolução", "Gerar PDF", "Limpar"]) {
    assert.ok(html.includes(`>${texto}</button>`), `falta o botão ${texto}`);
  }
  const botaoMenu = html.match(/<button[^>]*id="btn-lembretes"[^>]*>/);
  assert.ok(botaoMenu, "falta #btn-lembretes no menu Ferramentas");
  assert.ok(!/aria-keyshortcuts/.test(botaoMenu[0]), "Lembretes não tem atalho de teclado");
  assert.ok(!html.includes('ck-menu__rotulo">Termos<'), "a ferramenta Termos saiu do menu");
  assert.ok(!/>Imprimir</.test(html.slice(html.indexOf('data-cockpit-tool-panel="lembretes"'))), "não pode haver botão Imprimir");
});

test("termosPreencherDoEquipamento preenche só nome, modelo, série e Notebook, sem apagar o que foi digitado", () => {
  const criarForm = (nomes) => {
    const campos = Object.fromEntries(nomes.map((n) => [n, { value: "", dataset: {} }]));
    const notebook = { checked: false };
    return {
      campos, notebook, dataset: {},
      querySelector: (sel) => (sel === 'input[name="item-02"][value="sim"]' ? notebook : campos[/name="([^"]+)"/.exec(sel)?.[1]] || null),
    };
  };
  const forms = {
    "termos-form-entrega": criarForm(["nome", "unidade", "modelo_anterior", "modelo_entregue", "serie_entregue"]),
    "termos-form-devolucao": criarForm(["nome", "unidade", "modelo", "serie"]),
  };
  const anterior = globalThis.document;
  globalThis.document = { getElementById: (id) => forms[id] || null };
  try {
    const e = forms["termos-form-entrega"], d = forms["termos-form-devolucao"];
    e.campos.unidade.value = "UTIC";
    termos.termosPreencherDoEquipamento({ serial: "BRJ1", modelo: "HP 640 G11", nome_pessoa: "Maria Teste" });
    assert.equal(e.campos.nome.value, "Maria Teste");
    assert.equal(e.campos.modelo_entregue.value, "HP 640 G11");
    assert.equal(e.campos.serie_entregue.value, "BRJ1");
    assert.equal(e.campos.modelo_anterior.value, "");
    assert.equal(e.campos.unidade.value, "UTIC");
    assert.equal(e.notebook.checked, true);
    assert.equal(d.campos.nome.value, "Maria Teste");
    assert.equal(d.campos.modelo.value, "HP 640 G11");
    assert.equal(d.campos.serie.value, "BRJ1");
    assert.equal(d.notebook.checked, true);

    // Série sem nome: apaga o nome que a Home tinha posto...
    termos.termosPreencherDoEquipamento({ serial: "BRJ2", modelo: "X" });
    assert.equal(e.campos.nome.value, "");
    // ...mas não o que o usuário digitou.
    e.campos.nome.value = "Digitado";
    termos.termosPreencherDoEquipamento({ serial: "BRJ3", modelo: "Y" });
    assert.equal(e.campos.nome.value, "Digitado");
    // A mesma série exibida de novo (salvar edição cadastral) não desfaz o que o usuário mudou.
    e.notebook.checked = false;
    e.campos.modelo_entregue.value = "Editado";
    termos.termosPreencherDoEquipamento({ serial: "BRJ3", modelo: "Y" });
    assert.equal(e.notebook.checked, false);
    assert.equal(e.campos.modelo_entregue.value, "Editado");
    e.campos.modelo_entregue.value = "Y";
    // Sem série, não mexe em nada.
    termos.termosPreencherDoEquipamento({ modelo: "Z" });
    assert.equal(e.campos.modelo_entregue.value, "Y");
  } finally {
    globalThis.document = anterior;
  }
});

// ---- Lembrete do termo: dados salvos, PDF e preenchimento (dados sintéticos) ----

const RESPOSTAS_ENTREGA = ["", "sim", "nao", "", "", "", "", "", "", "", ""];

function salvoEntrega(campos = {}, extra = {}) {
  return {
    campos: {
      nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo_anterior: "Dell 5420", modelo_entregue: "HP 640 G11",
      serie_anterior: "ANTIGA123", serie_entregue: "NOVA456", ...campos,
    },
    itens: RESPOSTAS_ENTREGA,
    obs: "Sem avarias.",
    ...extra,
  };
}

function salvoDevolucao(campos = {}, extra = {}) {
  return {
    campos: { nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo: "HP 640 G10", serie: "BRJ123", ...campos },
    itens: ["sim", "nao", "", "", "", "", "", "", "", "", "sim"],
    obs: "Carregador trocado.",
    ...extra,
  };
}

test("termosDadosDoLembrete devolve o formato de termosLerDados com os 11 rótulos do formulário", () => {
  const dados = termos.termosDadosDoLembrete("entrega", salvoEntrega({ intruso: "x", unidade: 5 }, { itens: ["sim", "talvez", "nao"] }));
  assert.equal(dados.termo, "entrega");
  // Só os campos conhecidos, na ordem do termo; valor que não é texto vira "".
  assert.deepEqual(Object.keys(dados.campos), ["nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"]);
  assert.equal(dados.campos.unidade, "");
  assert.equal(dados.campos.serie_entregue, "NOVA456");
  // Sempre 11 itens: resposta fora de sim/nao e itens que faltam viram "".
  assert.equal(dados.itens.length, 11);
  assert.deepEqual(dados.itens.slice(0, 3).map((i) => i.resposta), ["sim", "", "nao"]);
  assert.ok(dados.itens.slice(3).every((i) => i.resposta === ""));
  assert.equal(dados.itens[0].rotulo, "01 Mochila");
  assert.equal(dados.itens[10].rotulo, "11 Cabo de Segurança");
  assert.equal(dados.obs, "Sem avarias.");

  const devolucao = termos.termosDadosDoLembrete("devolucao", salvoDevolucao());
  assert.deepEqual(Object.keys(devolucao.campos), ["nome", "unidade", "data", "modelo", "serie"]);
  assert.equal(devolucao.itens[0].rotulo, "1 - Mochila");
  assert.equal(devolucao.itens[10].resposta, "sim");
});

test("termosDadosDoLembrete devolve null para formato estranho", () => {
  const ok = salvoEntrega();
  for (const origem of ["lembretes", "__proto__", "constructor", "toString", "", undefined, null]) {
    assert.equal(termos.termosDadosDoLembrete(origem, ok), null, `origem ${String(origem)}`);
  }
  for (const salvo of [null, undefined, "texto", 7, {}, { campos: null, itens: [] }, { campos: "x", itens: [] }, { campos: {}, itens: "sim" }, { campos: {}, itens: { 0: "sim" } }, { campos: {} }, { itens: [] }]) {
    assert.equal(termos.termosDadosDoLembrete("entrega", salvo), null, JSON.stringify(salvo));
    assert.equal(termos.termosSecoesLembrete("entrega", salvo), null);
  }
});

test("termosSecoesLembrete da entrega: 4 seções com os rótulos do formulário e a data formatada", () => {
  const secoes = termos.termosSecoesLembrete("entrega", salvoEntrega());
  assert.deepEqual(secoes.map((s) => s.titulo), [
    "Dados do colaborador", "Identificação do equipamento", "Equipamentos e acessórios entregues", "Observações",
  ]);
  assert.deepEqual(secoes[0].campos, [
    ["Nome do colaborador", "Maria Teste"], ["Unidade / Departamento", "Curitiba"], ["Data da entrega / troca", "12/11/2026"],
  ]);
  assert.deepEqual(secoes[1].campos, [
    ["Modelo do computador, equipamento anterior", "Dell 5420"],
    ["Modelo do computador, equipamento entregue", "HP 640 G11"],
    ["Número de série / Service Tag, equipamento anterior", "ANTIGA123"],
    ["Número de série / Service Tag, equipamento entregue", "NOVA456"],
  ]);
  // Itens: Sim, Não ou — (sem resposta), com o rótulo do formulário.
  assert.equal(secoes[2].campos.length, 11);
  assert.deepEqual(secoes[2].campos.slice(0, 4), [["01 Mochila", "—"], ["02 Notebook", "Sim"], ["03 Teclado", "Não"], ["04 Mouse", "—"]]);
  assert.deepEqual(secoes[3], { titulo: "Observações", texto: "Sem avarias." });
});

test("termosSecoesLembrete da devolução: sem Identificação do equipamento e com modelo e série em Dados do colaborador", () => {
  const secoes = termos.termosSecoesLembrete("devolucao", salvoDevolucao());
  assert.deepEqual(secoes.map((s) => s.titulo), ["Dados do colaborador", "Equipamentos e acessórios devolvidos", "Observações"]);
  assert.deepEqual(secoes[0].campos, [
    ["Nome do colaborador", "Maria Teste"], ["Unidade", "Curitiba"], ["Data", "12/11/2026"],
    ["Modelo do computador", "HP 640 G10"], ["Número de série", "BRJ123"],
  ]);
  assert.deepEqual(secoes[1].campos.slice(0, 3), [["1 - Mochila", "Sim"], ["2 - Notebook", "Não"], ["3 - Teclado", "—"]]);
  assert.equal(secoes[1].campos[10][1], "Sim");
  assert.equal(secoes[2].texto, "Carregador trocado.");
});

test("termosSecoesLembrete troca campo vazio ou só com espaços por —", () => {
  const vazio = { campos: {}, itens: [], obs: "   " };
  for (const origem of ["entrega", "devolucao"]) {
    const secoes = termos.termosSecoesLembrete(origem, vazio);
    for (const secao of secoes.filter((s) => s.campos)) {
      assert.ok(secao.campos.every(([, valor]) => valor === "—"), `${origem}: ${secao.titulo}`);
    }
    assert.deepEqual(secoes[secoes.length - 1], { titulo: "Observações", texto: "—" });
  }
  const parcial = termos.termosSecoesLembrete("entrega", salvoEntrega({ unidade: "  ", modelo_anterior: "", data: "" }, { obs: "" }));
  assert.equal(parcial[0].campos[1][1], "—");
  assert.equal(parcial[0].campos[2][1], "—");
  assert.equal(parcial[1].campos[0][1], "—");
  assert.equal(parcial[0].campos[0][1], "Maria Teste");
});

// Tela falsa mínima: painéis com formulário (campos, 11 itens sim/nao, obs), abas, status e a folha de impressão.
// O fake não traz reset(), classList nem title: ficam definidos aqui. document e window são trocados e restaurados no fim.
function montarTela() {
  const doc = createFakeDocument();
  doc.title = "Cockpit Simpress";
  const classes = new Set();
  doc.documentElement.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) };
  const ouvintes = new Map();
  const win = {
    print() {},
    addEventListener: (tipo, ouvinte) => ouvintes.set(tipo, ouvinte),
    removeEventListener: (tipo, ouvinte) => { if (ouvintes.get(tipo) === ouvinte) ouvintes.delete(tipo); },
  };
  const novo = (tag, id, pai) => {
    const el = doc.createElement(tag);
    if (id) el.setAttribute("id", id);
    (pai || doc.body).append(el);
    return el;
  };
  const tela = { doc, win, classes, ouvintes, forms: {}, abas: {}, paineis: {}, status: {} };
  const nomes = {
    entrega: ["nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"],
    devolucao: ["nome", "unidade", "data", "modelo", "serie"],
    lembretes: [],
  };
  for (const [termo, campos] of Object.entries(nomes)) {
    const aba = novo("button", `termos-aba-${termo}`);
    aba.setAttribute("aria-selected", String(termo === "entrega"));
    const painel = novo("div", `termos-painel-${termo}`);
    painel.hidden = termo !== "entrega";
    tela.abas[termo] = aba;
    tela.paineis[termo] = painel;
    if (!campos.length) continue;
    const form = novo("form", `termos-form-${termo}`, painel);
    tela.status[termo] = novo("p", `termos-status-${termo}`, painel);
    form.campos = {};
    for (const nome of campos) {
      const input = doc.createElement("input");
      input.setAttribute("name", nome);
      input.type = "text";
      input.value = "";
      form.append(input);
      form.campos[nome] = input;
    }
    form.radios = {};
    for (let i = 1; i <= 11; i += 1) {
      for (const valor of ["sim", "nao"]) {
        const nome = `item-${String(i).padStart(2, "0")}`;
        const radio = doc.createElement("input");
        radio.setAttribute("name", nome);
        radio.setAttribute("value", valor);
        radio.type = "radio";
        radio.value = valor;
        radio.checked = false;
        form.append(radio);
        form.radios[`${nome}-${valor}`] = radio;
      }
    }
    form.obs = doc.createElement("textarea");
    form.obs.setAttribute("name", "obs");
    form.obs.value = "";
    form.append(form.obs);
    form.reset = () => form.querySelectorAll("input, textarea").forEach((c) => {
      if (c.type === "radio") c.checked = false;
      else c.value = "";
    });
    tela.forms[termo] = form;
  }
  tela.folha = novo("section", "termos-impressao");
  tela.folha.hidden = true;
  return tela;
}

async function comTela(corpo) {
  const tela = montarTela();
  const anteriores = { document: globalThis.document, window: globalThis.window };
  globalThis.document = tela.doc;
  globalThis.window = tela.win;
  try {
    await corpo(tela);
  } finally {
    for (const [nome, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete globalThis[nome];
      else globalThis[nome] = valor;
    }
  }
}

const respostasMarcadas = (form) => Object.entries(form.radios).filter(([, r]) => r.checked).map(([nome]) => nome);

test("termosGerarPdfDoLembrete imprime os dados salvos, não os do formulário, com título SÉRIE - Nome", async () => {
  await comTela(async (tela) => {
    const impressoes = [];
    tela.win.print = () => impressoes.push({ titulo: tela.doc.title, imprimindo: tela.classes.has("termos-imprimindo"), folha: tela.folha.textContent });
    // O formulário tem outros dados: nada dele pode ir para o PDF nem ser alterado.
    tela.forms.entrega.campos.nome.value = "Outro Nome";
    tela.forms.entrega.campos.serie_entregue.value = "FORM999";
    const t = criarTermos({ app: {} });
    await t.termosGerarPdfDoLembrete("entrega", salvoEntrega());

    assert.equal(impressoes.length, 1);
    assert.equal(impressoes[0].titulo, "NOVA456 - Maria Teste");
    assert.equal(impressoes[0].imprimindo, true);
    for (const esperado of ["Maria Teste", "HP 640 G11", "Dell 5420", "12/11/2026", "02 Notebook", "Sem avarias."]) {
      assert.ok(impressoes[0].folha.includes(esperado), `a folha deve trazer ${esperado}`);
    }
    for (const proibido of ["Outro Nome", "FORM999"]) assert.ok(!impressoes[0].folha.includes(proibido), `a folha não pode trazer ${proibido}`);
    assert.equal(tela.forms.entrega.campos.nome.value, "Outro Nome");
    assert.equal(tela.forms.entrega.campos.serie_entregue.value, "FORM999");

    // Depois da impressão: título, classe e folha voltam ao que eram.
    tela.ouvintes.get("afterprint")();
    assert.equal(tela.doc.title, "Cockpit Simpress");
    assert.equal(tela.classes.has("termos-imprimindo"), false);
    assert.equal(tela.folha.hidden, true);
    assert.equal(tela.folha.children.length, 0);
  });
});

test("termosGerarPdfDoLembrete da devolução usa a série da devolução no título e ignora dados inválidos", async () => {
  await comTela(async (tela) => {
    const titulos = [];
    tela.win.print = () => titulos.push(tela.doc.title);
    const t = criarTermos({ app: {} });
    await t.termosGerarPdfDoLembrete("devolucao", salvoDevolucao({ serie: "brj123" }));
    assert.deepEqual(titulos, ["BRJ123 - Maria Teste"]);
    tela.ouvintes.get("afterprint")();
    await t.termosGerarPdfDoLembrete("entrega", { campos: {} });
    await t.termosGerarPdfDoLembrete("lembretes", salvoEntrega());
    assert.equal(titulos.length, 1);
  });
});

test("termosGerarPdfDoLembrete avisa por toast quando a janela de impressão não abre", async () => {
  await comTela(async (tela) => {
    tela.win.print = () => { throw new Error("sem impressora"); };
    const toasts = [];
    const t = criarTermos({ app: { showToast: (texto, tipo) => toasts.push([texto, tipo]) } });
    await t.termosGerarPdfDoLembrete("entrega", salvoEntrega());
    assert.deepEqual(toasts, [["Não foi possível abrir a janela de impressão.", "error"]]);
    assert.equal(tela.doc.title, "Cockpit Simpress");
    assert.equal(tela.classes.has("termos-imprimindo"), false);
  });
});

test("termosPreencherDoLembrete com o formulário vazio preenche sem confirmar e abre a aba", async () => {
  await comTela(async (tela) => {
    const confirmacoes = [];
    const t = criarTermos({ app: { confirmarAcao: async (opcoes) => { confirmacoes.push(opcoes); return true; } } });
    const form = tela.forms.devolucao;
    // Texto só com espaços não conta como conteúdo; a marca da Home some, a série da Home fica.
    form.campos.unidade.value = "   ";
    form.campos.nome.dataset.preenchidoHome = "1";
    form.dataset.serieHome = "BRJ9";

    assert.equal(await t.termosPreencherDoLembrete("devolucao", salvoDevolucao()), true);
    assert.equal(confirmacoes.length, 0);
    assert.deepEqual(Object.fromEntries(Object.entries(form.campos).map(([n, i]) => [n, i.value])), {
      nome: "Maria Teste", unidade: "Curitiba", data: "2026-11-12", modelo: "HP 640 G10", serie: "BRJ123",
    });
    assert.deepEqual(respostasMarcadas(form), ["item-01-sim", "item-02-nao", "item-11-sim"]);
    assert.equal(form.obs.value, "Carregador trocado.");
    assert.equal(form.campos.nome.dataset.preenchidoHome, undefined);
    assert.equal(form.dataset.serieHome, "BRJ9");
    // Aba da devolução ativa, a da entrega escondida, foco no primeiro campo e aviso aprovado.
    assert.equal(tela.abas.devolucao.getAttribute("aria-selected"), "true");
    assert.equal(tela.abas.entrega.getAttribute("aria-selected"), "false");
    assert.equal(tela.paineis.devolucao.hidden, false);
    assert.equal(tela.paineis.entrega.hidden, true);
    assert.equal(tela.doc.activeElement, form.campos.nome);
    assert.equal(tela.status.devolucao.textContent, "Termo preenchido com os dados do lembrete.");
    assert.equal(tela.status.devolucao.dataset.tipo, undefined);
  });
});

test("termosPreencherDoLembrete com conteúdo pede confirmação; cancelar não muda nada", async () => {
  for (const resposta of [false, null]) {
    await comTela(async (tela) => {
      const form = tela.forms.entrega;
      form.campos.nome.value = "Digitado";
      form.radios["item-05-sim"].checked = true;
      const vistos = [];
      const t = criarTermos({
        app: {
          confirmarAcao: async (opcoes) => {
            vistos.push({ opcoes, nomeNaConfirmacao: form.campos.nome.value });
            return resposta;
          },
        },
      });
      assert.equal(await t.termosPreencherDoLembrete("entrega", salvoEntrega()), false, `resposta ${resposta}`);
      assert.equal(vistos.length, 1);
      assert.deepEqual(vistos[0].opcoes, {
        titulo: "Substituir o termo?",
        mensagem: "Os campos do termo serão trocados pelos dados do lembrete.",
        confirmar: "Substituir",
        cancelar: "Cancelar",
      });
      // Nada muda: nem antes (durante a pergunta) nem depois.
      assert.equal(vistos[0].nomeNaConfirmacao, "Digitado");
      assert.equal(form.campos.nome.value, "Digitado");
      assert.equal(form.campos.unidade.value, "");
      assert.deepEqual(respostasMarcadas(form), ["item-05-sim"]);
      assert.equal(form.obs.value, "");
      assert.equal(tela.status.entrega.textContent, "");
    });
  }
});

test("termosPreencherDoLembrete confirmado troca campos, itens e observações", async () => {
  await comTela(async (tela) => {
    const form = tela.forms.entrega;
    form.radios["item-05-sim"].checked = true;
    form.obs.value = "Obs antiga";
    form.campos.serie_anterior.value = "ANTIGA-DIGITADA";
    const perguntas = [];
    const t = criarTermos({ app: { confirmarAcao: async (opcoes) => { perguntas.push(opcoes.titulo); return true; } } });

    assert.equal(await t.termosPreencherDoLembrete("entrega", salvoEntrega({ serie_anterior: "" })), true);
    assert.deepEqual(perguntas, ["Substituir o termo?"]);
    assert.equal(form.campos.nome.value, "Maria Teste");
    assert.equal(form.campos.modelo_entregue.value, "HP 640 G11");
    // O campo vazio do lembrete também apaga o que estava digitado.
    assert.equal(form.campos.serie_anterior.value, "");
    assert.deepEqual(respostasMarcadas(form), ["item-02-sim", "item-03-nao"]);
    assert.equal(form.obs.value, "Sem avarias.");
    assert.equal(tela.abas.entrega.getAttribute("aria-selected"), "true");
    assert.equal(tela.status.entrega.textContent, "Termo preenchido com os dados do lembrete.");
    // Segue editável: o usuário pode mudar o que veio do lembrete.
    form.campos.nome.value = "Editado";
    assert.equal(form.campos.nome.value, "Editado");
  });
});

test("termosPreencherDoLembrete trata um item marcado, sem nenhum texto, como conteúdo e pede confirmação", async () => {
  await comTela(async (tela) => {
    tela.forms.entrega.radios["item-07-nao"].checked = true;
    const perguntas = [];
    const t = criarTermos({ app: { confirmarAcao: async () => { perguntas.push(1); return false; } } });
    assert.equal(await t.termosPreencherDoLembrete("entrega", salvoEntrega()), false);
    assert.equal(perguntas.length, 1);
    assert.equal(tela.forms.entrega.campos.nome.value, "");
  });
});

test("termosPreencherDoLembrete devolve false e não mexe em nada com dados inválidos", async () => {
  await comTela(async (tela) => {
    let perguntou = 0;
    const t = criarTermos({ app: { confirmarAcao: async () => { perguntou += 1; return true; } } });
    tela.forms.entrega.campos.nome.value = "Digitado";
    assert.equal(await t.termosPreencherDoLembrete("entrega", { campos: {} }), false);
    assert.equal(await t.termosPreencherDoLembrete("lembretes", salvoEntrega()), false);
    assert.equal(await t.termosPreencherDoLembrete("entrega", null), false);
    assert.equal(perguntou, 0);
    assert.equal(tela.forms.entrega.campos.nome.value, "Digitado");
  });
});
