// Termos de entrega e devolução: regras puras (frontend/src/paineis/lembretes/termos-puro.ts, carregado direto pelo
// require do Node) e garantia de que nada é guardado (LGPD). Desde o Grupo 6 (React) o painel Lembretes e Termos
// vive em frontend/src/paineis/lembretes/; formulário, PDF, preenchimento e abas são testados no navegador
// (tests/e2e/termos.spec.cjs e tests/e2e/react-g6.spec.cjs). Dados sintéticos.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const pasta = path.join(root, "frontend/src/paineis/lembretes");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");
const {
  termosFormatarData, termosLimparParte, termosNomeArquivo, termosDadosDoLembrete, termosSecoesLembrete,
} = require(path.join(pasta, "termos-puro.ts"));
const criarTermos = require(path.join(root, "frontend/src/aplicacao/registro.ts")).fabricas.termos;

// Todo código do painel (TypeScript e TSX) mais a tabela de pontes (aplicacao/pontes.ts): é onde a privacidade dos termos precisa valer.
const arquivosDoPainel = fs.readdirSync(pasta).filter((nome) => /.tsx?$/.test(nome)).map((nome) => path.join(pasta, nome));
const fonteDoPainel = arquivosDoPainel.map((arquivo) => fs.readFileSync(arquivo, "utf8"));
const pontes = [fs.readFileSync(path.join(root, "frontend/src/aplicacao/pontes.ts"), "utf8")];
// Mais o renderizador e a medida da assinatura por nome (frontend/src/componentes/): também sem storage, fetch nem rede.
const componentes = ["assinatura-medida.ts", "assinatura-texto.tsx"].map((nome) => fs.readFileSync(path.join(root, "frontend/src/componentes", nome), "utf8"));
const codigos = [...fonteDoPainel, ...pontes, ...componentes];

test("termosFormatarData fatia aaaa-mm-dd sem passar por Date", () => {
  assert.equal(termosFormatarData("2026-11-09"), "09/11/2026");
  assert.equal(termosFormatarData("2026-01-01"), "01/01/2026");
  assert.equal(termosFormatarData(""), "");
  assert.equal(termosFormatarData(null), "");
  assert.equal(termosFormatarData(undefined), "");
});

test("termosNomeArquivo junta série em maiúsculas e nome completo", () => {
  assert.equal(
    termosNomeArquivo("brj54925dn", "Janaina do Rocio Santos Rocha"),
    "BRJ54925DN - Janaina do Rocio Santos Rocha",
  );
  assert.equal(termosNomeArquivo("  brj54925dn  ", "  José   da  Conceição "), "BRJ54925DN - José da Conceição");
});

test("termosNomeArquivo usa só o lado preenchido, sem separador", () => {
  assert.equal(termosNomeArquivo("brj54925dn", ""), "BRJ54925DN");
  assert.equal(termosNomeArquivo("", "Maria Silva"), "Maria Silva");
  assert.equal(termosNomeArquivo("   ", "Maria Silva"), "Maria Silva");
});

test("termosNomeArquivo devolve valor falso quando os dois lados ficam vazios", () => {
  assert.ok(!termosNomeArquivo("", ""));
  assert.ok(!termosNomeArquivo("  ", "\t"));
  assert.ok(!termosNomeArquivo(null, undefined));
  assert.ok(!termosNomeArquivo("/\\:*?\"<>|", "///"));
});

test("termosNomeArquivo remove caracteres proibidos em nome de arquivo", () => {
  const nome = termosNomeArquivo('br/j\\5:4*9?2"5<d>n|', 'Ana/ \\ : * ? " < > | Souza');
  assert.equal(nome, "BRJ54925DN - Ana Souza");
  for (const proibido of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!nome.includes(proibido), `não pode conter ${proibido}`);
  }
});

test("termosLimparParte limita cada parte a 100 caracteres", () => {
  assert.equal(termosLimparParte("a".repeat(150)).length, 100);
  assert.equal(termosLimparParte("x".repeat(150), true), "X".repeat(100));
  const nome = termosNomeArquivo("s".repeat(150), "n".repeat(150));
  assert.equal(nome, `${"S".repeat(100)} - ${"n".repeat(100)}`);
});

const NOMES_PONTE_TERMOS = [
  "termosSelecionarAba", "termosTeclaAba", "termosGerarPdf", "termosLimpar", "termosPreencherDoEquipamento",
  "termosGerarPdfDoLembrete", "termosPreencherDoLembrete",
];

function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return Object.fromEntries(nomes.map((nome) => [nome, (...args) => acao(nome, ...args)]));
    },
  };
  return { chamadas, feature: criarTermos(context) };
}

test("registro: a ponte do painel React lembretes (aplicacao/registro.ts) continua no arranque e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.termos, "function");
  assert.match(appSource, /"termos",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
});

test("ponte: cada ação dos termos repassa ao painel React lembretes, com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome === "termosPreencherDoLembrete"; });
  assert.deepEqual(chamadas, [["lembretes", NOMES_PONTE_TERMOS]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PONTE_TERMOS);
  await feature.termosSelecionarAba("devolucao");
  assert.equal(await feature.termosPreencherDoLembrete("entrega", { campos: {} }), true);
  assert.deepEqual(chamadasReact, [["termosSelecionarAba", ["devolucao"]], ["termosPreencherDoLembrete", ["entrega", { campos: {} }]]]);
});

test("ponte: se o React não carregou, a ação não rejeita nem escreve no console (o erro pode ter dado pessoal)", async () => {
  const erros = [];
  const original = console.error;
  console.error = (erro) => erros.push(erro.message);
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "lembretes" não carregou.')));
    assert.equal(await feature.termosPreencherDoEquipamento({ serial: "BRJ1" }), undefined);
  } finally {
    console.error = original;
  }
  assert.deepEqual(erros, []);
});

test("termos: nada é guardado nem enviado (sem storage, cookie, fetch nem innerHTML; só os GET fixos da assinatura)", () => {
  for (const proibido of [
    "localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "innerHTML", "XMLHttpRequest", "sendBeacon",
    "http://", "https://", "new Image", "window.open", "location.", "WebSocket", "EventSource", "import(",
  ]) {
    codigos.forEach((codigo, i) => assert.ok(!codigo.includes(proibido), `${i < fonteDoPainel.length ? path.basename(arquivosDoPainel[i]) : "ponte"} não pode usar ${proibido}`));
  }
  // Nos arquivos dos termos, as únicas rotas citadas são a configuração da assinatura do técnico (GET sem corpo) e, só no
  // estilo "desenho", o SVG dela: constantes, sem parâmetro nem concatenação; a única URL atribuída (src/href) é a do SVG. A API dos lembretes fica em lembretes-acoes.ts.
  const dosTermos = ["termos-puro.ts", "termos-acoes.ts", "termos-forms.tsx", "folha.tsx"].map((nome) => fs.readFileSync(path.join(pasta, nome), "utf8"));
  dosTermos.push(pontes[0]);
  const todos = dosTermos.join("\n");
  assert.deepEqual(todos.match(/["'`]\/api\/[^"'`]*["'`]/g), ['"/api/assinatura-tecnico"', '"/api/assinatura-tecnico/config"']);
  const acoes = fs.readFileSync(path.join(pasta, "termos-acoes.ts"), "utf8");
  assert.equal(acoes.match(/apiFetch[<(]/g).length, 1, "um único GET por apiFetch: a configuração, sem corpo nem método");
  assert.ok(!/method\s*:|body\s*:/.test(acoes));
  assert.deepEqual(todos.match(/\.(src|href)\s*=[^=;]*/g), [".src = URL_ASSINATURA"]);
});

test("painel Lembretes e Termos: abas e botões aprovados no código React, nenhum Imprimir e nenhum atalho novo", () => {
  const fonte = fonteDoPainel.join("\n");
  for (const texto of ["Termo Entrega", "Termo Devolução", "Gerar PDF", "Limpar"]) {
    assert.ok(fonte.includes(texto), `falta o texto ${texto}`);
  }
  assert.ok(!/>\s*Imprimir\s*</.test(fonte), "não pode haver botão Imprimir");
  const botaoMenu = html.match(/<button[^>]*id="btn-lembretes"[^>]*>/);
  assert.ok(botaoMenu, "falta #btn-lembretes no menu Ferramentas");
  assert.ok(!/aria-keyshortcuts/.test(botaoMenu[0]), "Lembretes não tem atalho de teclado");
  assert.ok(!html.includes('ck-menu__rotulo">Termos<'), "a ferramenta Termos saiu do menu");
});

test("index.html: a seção lembretes fica vazia (o React desenha o painel) e a folha de impressão continua no HTML", () => {
  const secao = html.match(/<section[^>]*data-cockpit-tool-panel="lembretes"[\s\S]*?<\/section>/)[0];
  assert.match(secao, /data-react-painel="lembretes"/);
  assert.match(secao, /aria-labelledby="lembretes-heading"/);
  assert.match(secao, /class="ck-ferr-painel termos lembretes"/);
  assert.match(secao, /\shidden>/);
  assert.ok(!/<(h2|div|form|button|input)/.test(secao), "o React desenha tudo dentro da seção");
  assert.ok(html.includes('<div id="termos-impressao" hidden></div>'));
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
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

test("termosDadosDoLembrete devolve o formato dos dados do formulário com os 11 rótulos", () => {
  const dados = termosDadosDoLembrete("entrega", salvoEntrega({ intruso: "x", unidade: 5 }, { itens: ["sim", "talvez", "nao"] }));
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

  const devolucao = termosDadosDoLembrete("devolucao", salvoDevolucao());
  assert.deepEqual(Object.keys(devolucao.campos), ["nome", "unidade", "data", "modelo", "serie"]);
  assert.equal(devolucao.itens[0].rotulo, "1 - Mochila");
  assert.equal(devolucao.itens[10].resposta, "sim");
});

test("termosDadosDoLembrete devolve null para formato estranho", () => {
  const ok = salvoEntrega();
  for (const origem of ["lembretes", "__proto__", "constructor", "toString", "", undefined, null]) {
    assert.equal(termosDadosDoLembrete(origem, ok), null, `origem ${String(origem)}`);
  }
  for (const salvo of [null, undefined, "texto", 7, {}, { campos: null, itens: [] }, { campos: "x", itens: [] }, { campos: {}, itens: "sim" }, { campos: {}, itens: { 0: "sim" } }, { campos: {} }, { itens: [] }]) {
    assert.equal(termosDadosDoLembrete("entrega", salvo), null, JSON.stringify(salvo));
    assert.equal(termosSecoesLembrete("entrega", salvo), null);
  }
});

test("termosSecoesLembrete da entrega: 4 seções com os rótulos do formulário e a data formatada", () => {
  const secoes = termosSecoesLembrete("entrega", salvoEntrega());
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
  const secoes = termosSecoesLembrete("devolucao", salvoDevolucao());
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
    const secoes = termosSecoesLembrete(origem, vazio);
    for (const secao of secoes.filter((s) => s.campos)) {
      assert.ok(secao.campos.every(([, valor]) => valor === "—"), `${origem}: ${secao.titulo}`);
    }
    assert.deepEqual(secoes[secoes.length - 1], { titulo: "Observações", texto: "—" });
  }
  const parcial = termosSecoesLembrete("entrega", salvoEntrega({ unidade: "  ", modelo_anterior: "", data: "" }, { obs: "" }));
  assert.equal(parcial[0].campos[1][1], "—");
  assert.equal(parcial[0].campos[2][1], "—");
  assert.equal(parcial[1].campos[0][1], "—");
  assert.equal(parcial[0].campos[0][1], "Maria Teste");
});

test("rádios Sim e Não não são controlados pelo React: a marca vive no DOM e as ações leem de lá", () => {
  const formularios = fs.readFileSync(path.join(pasta, "termos-forms.tsx"), "utf8");
  const acoes = fs.readFileSync(path.join(pasta, "termos-acoes.ts"), "utf8");
  const radios = formularios.match(/<input type="radio"[\s\S]*?\/>/g) ?? [];
  assert.equal(radios.length, 2, "um rádio Sim e um Não por item");
  for (const radio of radios) assert.doesNotMatch(radio, /\bchecked=|defaultChecked/, "marca controlada pelo React sobrescreve o DOM");
  assert.match(acoes, /export function lerItens\(/);
  assert.match(acoes, /const itens = lerItens\(termo\);[\s\S]*resposta: itens\[i\]/, "lerDados lê as marcas do DOM");
});
