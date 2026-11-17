// Lembretes (Termo → Lembrete): regras puras (descrição do termo, datas agendadas, agrupamento, vistas, campos editados)
// em frontend/src/paineis/lembretes/*.ts, carregadas direto pelo require do Node. Desde o Grupo 6 (React) o painel
// vive em frontend/src/paineis/lembretes/ e o comportamento de tela é testado no navegador (tests/e2e/lembretes.spec.cjs
// e tests/e2e/react-g6.spec.cjs). Aqui ficam as regras puras, o registro, a ponte do código antigo, o HTML montado e a
// privacidade (a descrição tem dado pessoal). Dados sintéticos.
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
const { montarDescricaoTermo } = require(path.join(pasta, "termos-puro.ts"));
const {
  hojeEm, agruparLembretes, montarVista, camposEditados, rotuloAgenda, tituloGrupoDia, tituloSemana,
  proximaSegunda, semanaDe, dataValida, somarDias, textoTermo,
} = require(path.join(pasta, "lembretes-puro.ts"));

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

// Data agendada: quinta 12/11/2026 é "hoje"; os cálculos são texto AAAA-MM-DD e valem com TZ=UTC e com TZ=America/Sao_Paulo.
const HOJE = "2026-11-12";
const lembrete = (id, data, hora, criado = "2026-11-01T10:00:00-03:00") => ({
  id, descricao: `Lembrete sintético ${id}`, criado_em: criado, alterado_em: null, concluido: false, data_agendada: data, hora_agendada: hora,
});
const ids = (itensDoGrupo) => itensDoGrupo.map((l) => l.id);

test("hojeEm: a virada do dia é a de America/Sao_Paulo (UTC-3), não a do relógio do navegador", () => {
  assert.equal(hojeEm(Date.UTC(2026, 10, 13, 2, 59, 59)), "2026-11-12");
  assert.equal(hojeEm(Date.UTC(2026, 10, 13, 3, 0, 0)), "2026-11-13");
  assert.equal(hojeEm(Date.UTC(2026, 10, 12, 12, 0, 0)), "2026-11-12");
  assert.equal(hojeEm(Date.UTC(2027, 0, 1, 2, 59, 59)), "2026-12-31");
  assert.match(hojeEm(), /^\d{4}-\d{2}-\d{2}$/);
});

test("dataValida: só data real no formato estrito; somarDias não depende do fuso", () => {
  assert.equal(dataValida("2026-11-12"), true);
  assert.equal(dataValida("2028-02-29"), true);
  assert.equal(dataValida("0001-01-01"), true);
  assert.equal(dataValida("2026-02-30"), false);
  assert.equal(dataValida("2027-02-29"), false);
  assert.equal(dataValida("0000-01-01"), false);
  assert.equal(dataValida("20261113"), false);
  assert.equal(dataValida("2026-11-12T10:00"), false);
  assert.equal(dataValida(null), false);
  assert.equal(somarDias("2026-11-30", 1), "2026-12-01");
  assert.equal(somarDias("2026-12-31", 1), "2027-01-01");
  assert.equal(somarDias("2026-11-12", -12), "2026-10-31");
});

test("proximaSegunda: de qualquer dia vai à segunda seguinte; numa segunda, +7", () => {
  assert.equal(proximaSegunda("2026-11-12"), "2026-11-16"); // quinta
  assert.equal(proximaSegunda("2026-11-13"), "2026-11-16"); // sexta
  assert.equal(proximaSegunda("2026-11-14"), "2026-11-16"); // sábado
  assert.equal(proximaSegunda("2026-11-15"), "2026-11-16"); // domingo
  assert.equal(proximaSegunda("2026-11-16"), "2026-11-23"); // segunda
  assert.equal(proximaSegunda("2026-11-17"), "2026-11-23"); // terça
  assert.equal(proximaSegunda("2026-12-30"), "2027-01-04"); // vira o ano
});

test("semanaDe: domingo a sábado, deslocada em semanas", () => {
  assert.deepEqual(semanaDe(HOJE, 0), ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"]);
  assert.equal(semanaDe(HOJE, 1)[0], "2026-11-15");
  assert.equal(semanaDe(HOJE, 1)[6], "2026-11-21");
  assert.equal(semanaDe("2026-11-15", 0)[0], "2026-11-15"); // domingo abre a própria semana
  assert.equal(semanaDe("2026-11-14", 0)[6], "2026-11-14"); // sábado fecha a própria semana
  assert.equal(semanaDe(HOJE).length, 7);
});

test("rótulos: Hoje, Amanhã, dia e mês, e o ano só quando muda", () => {
  assert.equal(rotuloAgenda(HOJE, "14:00", HOJE), "Hoje · 14:00");
  assert.equal(rotuloAgenda("2026-11-13", null, HOJE), "Amanhã");
  assert.equal(rotuloAgenda("2026-11-13", "09:00", HOJE), "Amanhã · 09:00");
  assert.equal(rotuloAgenda("2026-11-10", "17:00", HOJE), "10 nov · 17:00");
  assert.equal(rotuloAgenda("2026-12-01", "", HOJE), "1 dez");
  assert.equal(rotuloAgenda("2027-11-13", null, HOJE), "13 nov 2027");
  assert.equal(rotuloAgenda("2026-11-10", "25:99", HOJE), "10 nov");
  assert.equal(tituloGrupoDia(HOJE, HOJE), "12 nov · Hoje · quinta-feira");
  assert.equal(tituloGrupoDia("2026-11-13", HOJE), "13 nov · Amanhã · sexta-feira");
  assert.equal(tituloGrupoDia("2026-11-14", HOJE), "14 nov · sábado");
  assert.equal(tituloGrupoDia("2027-01-05", HOJE), "5 jan 2027 · terça-feira");
});

test("tituloSemana: um mês, dois meses e dois anos", () => {
  assert.equal(tituloSemana(semanaDe(HOJE, 0)), "Novembro 2026");
  assert.equal(tituloSemana(semanaDe("2026-11-30", 0)), "Novembro – Dezembro 2026");
  assert.equal(tituloSemana(semanaDe("2026-12-30", 0)), "Dezembro 2026 – Janeiro 2027");
});

test("agruparLembretes: atrasados, um grupo por dia de hoje em diante e sem data", () => {
  const pendentes = [
    lembrete("sem", null, null),
    lembrete("ontem", "2026-11-11", "08:00"),
    lembrete("hoje-sem-hora", HOJE, null),
    lembrete("hoje-15h", HOJE, "15:00"),
    lembrete("hoje-09h", HOJE, "09:00"),
    lembrete("amanha", "2026-11-13", null),
    lembrete("anteontem", "2026-11-10", null),
    lembrete("lixo", "2026-02-30", "10:00"),
    lembrete("hora-solta", null, "10:00"),
  ];
  const g = agruparLembretes(pendentes, HOJE);
  assert.deepEqual(ids(g.atrasados), ["anteontem", "ontem"]);
  assert.deepEqual([...g.porDia.keys()], [HOJE, "2026-11-13"]);
  assert.deepEqual(ids(g.porDia.get(HOJE)), ["hoje-09h", "hoje-15h", "hoje-sem-hora"]);
  assert.deepEqual(ids(g.porDia.get("2026-11-13")), ["amanha"]);
  // Data fora do formato e hora sem data contam como sem data; entre eles, o mais recente (o último do arquivo) fica no topo.
  assert.deepEqual(ids(g.semData).sort(), ["hora-solta", "lixo", "sem"]);
  assert.deepEqual(agruparLembretes([], HOJE), { atrasados: [], porDia: new Map(), semData: [] });
});

test("agruparLembretes: na virada do dia em UTC-3 o mesmo lembrete passa de hoje a atrasado", () => {
  const item = lembrete("a", "2026-11-12", "23:00");
  const antes = hojeEm(Date.UTC(2026, 10, 13, 2, 59, 59)); // 23:59 de 12/11 em São Paulo
  const depois = hojeEm(Date.UTC(2026, 10, 13, 3, 0, 0)); // 00:00 de 13/11 em São Paulo
  assert.deepEqual(ids(agruparLembretes([item], antes).porDia.get("2026-11-12")), ["a"]);
  assert.equal(agruparLembretes([item], antes).atrasados.length, 0);
  assert.deepEqual(ids(agruparLembretes([item], depois).atrasados), ["a"]);
  assert.equal(agruparLembretes([item], depois).porDia.size, 0);
});

test("montarVista: Hoje mostra Atrasada, o dia de hoje e Sem data; Em breve mostra a semana", () => {
  const g = agruparLembretes([lembrete("ontem", "2026-11-11", null), lembrete("sem", null, null), lembrete("sex", "2026-11-13", "10:00")], HOJE);

  const hoje = montarVista(g, HOJE, "hoje");
  assert.deepEqual(hoje.map((x) => x.chave), ["atrasada", HOJE, "sem-data"]);
  assert.equal(hoje[0].titulo, "Atrasada");
  assert.equal(hoje[0].reagendar, true);
  assert.equal(hoje[0].n, 1);
  assert.equal(hoje[1].titulo, "12 nov · Hoje · quinta-feira");
  assert.deepEqual(hoje[1].itens, []);
  assert.equal(hoje[1].adicionar, true);
  assert.equal(hoje[2].titulo, "Sem data");

  // Semana atual: Atrasada, depois de hoje até sábado (nunca os dias já passados), Sem data no fim.
  const semana0 = montarVista(g, HOJE, "embreve", 0);
  assert.deepEqual(semana0.map((x) => x.chave), ["atrasada", HOJE, "2026-11-13", "2026-11-14", "sem-data"]);
  assert.deepEqual(ids(semana0[2].itens), ["sex"]);

  // Próxima semana: sete dias, sem Atrasada.
  const semana1 = montarVista(g, HOJE, "embreve", 1);
  assert.equal(semana1.filter((x) => x.data).length, 7);
  assert.equal(semana1[0].chave, "2026-11-15");
  assert.ok(!semana1.some((x) => x.chave === "atrasada"));
  assert.equal(semana1[semana1.length - 1].chave, "sem-data");

  // Sem atrasados nem sem data, só os dias.
  const limpo = montarVista(agruparLembretes([], HOJE), HOJE, "hoje");
  assert.deepEqual(limpo.map((x) => x.chave), [HOJE]);
});

test("camposEditados: só o que mudou; nada mudou, nada a enviar", () => {
  const l = lembrete("a", "2026-11-12", "14:00");
  const igual = { descricao: l.descricao, data: "2026-11-12", hora: "14:00" };
  assert.deepEqual(camposEditados(l, igual), {});
  assert.deepEqual(camposEditados(l, { ...igual, descricao: "Outro texto" }), { descricao: "Outro texto" });
  // Só a data muda: a hora não vai no PATCH (o backend mantém).
  assert.deepEqual(camposEditados(l, { ...igual, data: "2026-11-20" }), { data_agendada: "2026-11-20" });
  assert.deepEqual(camposEditados(l, { ...igual, hora: "16:30" }), { hora_agendada: "16:30" });
  assert.deepEqual(camposEditados(l, { ...igual, hora: "" }), { hora_agendada: null });
  // Remover a data: o backend limpa a hora junto, então só data_agendada: null vai.
  assert.deepEqual(camposEditados(l, { ...igual, data: "", hora: "" }), { data_agendada: null });
  assert.deepEqual(camposEditados(l, { ...igual, data: "", hora: "14:00" }), { data_agendada: null });

  const semData = lembrete("b", null, null);
  const base = { descricao: semData.descricao, data: "", hora: "" };
  assert.deepEqual(camposEditados(semData, base), {});
  assert.deepEqual(camposEditados(semData, { ...base, data: "2026-11-13", hora: "09:00" }), { data_agendada: "2026-11-13", hora_agendada: "09:00" });
  // Sem data, a hora digitada é ignorada.
  assert.deepEqual(camposEditados(semData, { ...base, hora: "09:00" }), {});
  // Data guardada fora do formato conta como sem data: salvar sem mexer não gera PATCH.
  const lixo = lembrete("c", "2026-02-30", "10:00");
  assert.deepEqual(camposEditados(lixo, { descricao: lixo.descricao, data: "", hora: "" }), {});
});

test("textoTermo: corta no limite por caractere, troca controle por espaço e mantém só os permitidos", () => {
  const nome = textoTermo("Maria\x0bTeste" + "x".repeat(300), 200);
  assert.equal([...nome].length, 200);
  assert.ok(nome.startsWith("Maria Teste"));
  const obs = textoTermo("Linha 1\r\nLinha\t2\x0b\u0085fim" + "y".repeat(2500), 2000, "\n\r\t");
  assert.equal([...obs].length, 2000);
  assert.ok(obs.startsWith("Linha 1\r\nLinha\t2  fim"));
  // Substituto solto (meio de um par) sai; o emoji inteiro conta como um caractere só.
  assert.equal(textoTermo("a\ud83dz", 10), "az");
  assert.equal([...textoTermo("\u{1F600}".repeat(5), 3)].length, 3);
  assert.equal(textoTermo(null, 10), "");
});

// ---- Ponte do código antigo (frontend/src/aplicacao/pontes.ts) ----

const criarLembretes = require(path.join(root, "frontend/src/aplicacao/registro.ts")).fabricas.lembretes;
const NOMES_PONTE_LEMBRETES = [
  "carregarLembretes", "lembretesAdicionar", "lembretesAoDigitar", "lembretesAlternar", "lembretesEditar",
  "lembretesCancelarEdicao", "lembretesTeclaEdicao", "lembretesSalvarEdicao", "lembretesAlternarConcluidos",
  "lembretesExcluir", "lembretesCancelarExclusao", "lembretesConfirmarExclusao",
  "lembretesCriarDoTermo", "lembretesCancelarCriar", "lembretesConfirmarCriar", "lembretesVerLembretes",
  "lembretesSelecionarVista", "lembretesTeclaVista", "lembretesMudarSemana", "lembretesIrParaDia", "lembretesAdicionarNoDia",
  "lembretesReagendarAtrasados", "lembretesAlternarPainelData", "lembretesTeclaPainelData", "lembretesAtalhoData",
  "lembretesAoMudarData", "lembretesRemoverData", "lembretesGerarPdfTermo", "lembretesPreencherTermo",
];

function ponteFalsa(acao) {
  const chamadas = [];
  const context = {
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return Object.fromEntries(nomes.map((nome) => [nome, (...args) => acao(nome, ...args)]));
    },
  };
  return { chamadas, feature: criarLembretes(context) };
}

test("registro: a ponte do painel React lembretes (aplicacao/registro.ts) continua no arranque e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.lembretes, "function");
  assert.match(appSource, /"lembretes",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
});

test("ponte: cada ação dos lembretes repassa ao painel React lembretes, com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome; });
  assert.deepEqual(chamadas, [["lembretes", NOMES_PONTE_LEMBRETES]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PONTE_LEMBRETES);
  assert.equal(await feature.carregarLembretes(), "carregarLembretes");
  await feature.lembretesMudarSemana(1);
  await feature.lembretesAtalhoData("amanha");
  assert.deepEqual(chamadasReact, [["carregarLembretes", []], ["lembretesMudarSemana", [1]], ["lembretesAtalhoData", ["amanha"]]]);
});

test("ponte: se o React não carregou, a ação não rejeita e não escreve nada no console (a descrição tem dado pessoal)", async () => {
  const escritas = [];
  const original = {};
  for (const metodo of ["log", "info", "debug", "warn", "error"]) {
    original[metodo] = console[metodo];
    console[metodo] = (...args) => escritas.push(args);
  }
  try {
    const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "lembretes" não carregou.')));
    assert.equal(await feature.carregarLembretes(), undefined);
    assert.equal(await feature.lembretesConfirmarCriar(), undefined);
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(escritas, []);
});

test("o fechamento por Esc dos diálogos (data-close-function, definido ao abrir) aponta para ações publicadas pela ponte", () => {
  const acoes = fs.readFileSync(path.join(pasta, "lembretes-acoes.ts"), "utf8");
  const nomes = [...acoes.matchAll(/abrirModalAcessivel\?\.\("[^"]+", "[^"]+", "([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(nomes.sort(), ["lembretesCancelarCriar", "lembretesCancelarExclusao"]);
  nomes.forEach((nome) => assert.ok(NOMES_PONTE_LEMBRETES.includes(nome), `${nome} falta na ponte`));
});

test("index.html: a seção lembretes é só o ponto de montagem do React e os diálogos saem do HTML", () => {
  const secao = html.match(/<section[^>]*data-cockpit-tool-panel="lembretes"[\s\S]*?<\/section>/)[0];
  assert.match(secao, /data-react-painel="lembretes"/);
  assert.ok(!/<(h2|div|form|button|input|textarea)/.test(secao), "o React desenha tudo dentro da seção");
  for (const id of ["lembretes-confirmar", "lembretes-criar", "lembretes-form-novo"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 0, `${id} é desenhado pelo React, não pelo HTML`);
  }
});

test("referência a Chamado/OS na lista: botão com data-args e abrirReferenciaLembrete, como no painel antigo", () => {
  const lista = fs.readFileSync(path.join(pasta, "lembretes-lista.tsx"), "utf8");
  assert.match(lista, /data-args=\{JSON\.stringify\(\[\{ tipo, numero \}, "\$this"\]\)\}/);
  assert.match(lista, /abrirReferenciaLembrete\?\.\(\{ tipo, numero \}, e\.currentTarget\)/);
  assert.match(lista, /Abrir o chamado/);
  assert.match(lista, /Abrir a OS/);
});

test("lembretes: sem console, innerHTML nem storage em nenhum arquivo do painel nem na ponte (a descrição tem dado pessoal)", () => {
  const arquivos = fs.readdirSync(pasta).filter((nome) => /\.tsx?$/.test(nome)).map((nome) => path.join(pasta, nome));
  assert.ok(arquivos.length >= 10);
  // As pontes dos Lembretes e dos Termos são as duas últimas entradas de aplicacao/pontes.ts, silenciosas; as outras podem registrar no console.
  const pontes = fs.readFileSync(path.join(root, "frontend/src/aplicacao/pontes.ts"), "utf8");
  const pontesSilenciosas = pontes.slice(pontes.indexOf("  // Lembretes (Ferramentas)"), pontes.indexOf("export type NomePonte"));
  assert.match(pontesSilenciosas, /lembretes: \{[\s\S]*termos: \{/);
  const fontes = [...arquivos.map((arquivo) => [path.basename(arquivo), fs.readFileSync(arquivo, "utf8")]), ["pontes.ts (lembretes e termos)", pontesSilenciosas]];
  for (const [nome, codigo] of fontes) {
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(codigo), `${nome} não pode escrever no console`);
    assert.ok(!/innerHTML|insertAdjacentHTML/.test(codigo), `${nome} não pode montar HTML por texto`);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(codigo), `${nome} não pode guardar dado no navegador`);
  }
});
