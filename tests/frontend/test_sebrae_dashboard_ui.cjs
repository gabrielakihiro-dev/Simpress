const test = require("node:test");
const assert = require("node:assert/strict");
const createSebraeDashboard = require("../../static/js/features/sebrae-dashboard.js");

const { formatarEncerramento, encerramentoParaCampo, payloadAtualizacao, payloadEdicoes, avisoOutraPessoa, avisoNomeDaDescricao, tituloAntigo, dadosAntigo, resumoLeituraAntigos, totalPreenchimentos,
  formatarTamanho, textoResultado, textoPulado, podeFinalizar, candidatosFinalizar, resumoResultado, resumoInicio,
  lerRascunho, gravarRascunho, apagarRascunho, aplicarRascunho, camposFaltando } = createSebraeDashboard.puro;

test("camposFaltando lista A, Status em FINALIZADO, J e a descrição (R é opcional) que faltam para finalizar", () => {
  const completo = { A: "CLIENTE", D: "FINALIZADO", J: "INCIDENTE", R: "2026-10-28T10:10" };
  assert.deepEqual(camposFaltando(completo, "Troquei o teclado."), []);
  assert.deepEqual(camposFaltando({ ...completo, D: "EM ABERTO" }, "ok"), ["Status (D) em FINALIZADO (está EM ABERTO)"]);
  assert.deepEqual(camposFaltando({ ...completo, D: "" }, "ok"), ["Status (D) em FINALIZADO"]);
  assert.deepEqual(camposFaltando({ ...completo, R: "  " }, "ok"), []); // R vazio não bloqueia: o SoftExpert grava o horário
  assert.deepEqual(camposFaltando(completo, "   "), ["Descrição para Finalizar o Chamado"]);
  assert.deepEqual(camposFaltando(undefined, ""), ["Responsável (A)", "Status (D) em FINALIZADO", "Tipo do chamado (J)", "Descrição para Finalizar o Chamado"]);
});

test("converte o campo de data e hora para dd/MM/aaaa HH:mm e ignora valor inválido", () => {
  assert.equal(formatarEncerramento("2026-10-28T14:30"), "28/10/2026 14:30");
  assert.equal(formatarEncerramento(""), "");
  assert.equal(formatarEncerramento("ontem"), "");
});

test("a atualização leva todos os chamados novos, com vazios em branco e a data formatada", () => {
  const formulario = [{ numero: "UTIC-2026-1" }, { numero: "UTIC-2026-2" }, { numero: "UTIC-2026-3" }];
  const valores = {
    "UTIC-2026-1": { A: "CLIENTE", D: "FINALIZADO", J: "INCIDENTE", R: "2026-10-28T09:05", S: "ok" },
    "UTIC-2026-2": { B: "REDE" },
  };
  assert.deepEqual(payloadAtualizacao(formulario, valores), [
    { numero: "UTIC-2026-1", A: "CLIENTE", B: "", D: "FINALIZADO", J: "INCIDENTE", R: "28/10/2026 09:05", S: "ok" },
    { numero: "UTIC-2026-2", A: "", B: "REDE", D: "", J: "", R: "", S: "" },
    { numero: "UTIC-2026-3", A: "", B: "", D: "", J: "", R: "", S: "" },
  ]);
  assert.deepEqual(payloadAtualizacao([], valores), []);
});

test("a data guardada no Dashboard volta para o campo de data e hora", () => {
  assert.equal(encerramentoParaCampo("28/10/2026 14:30"), "2026-10-28T14:30");
  assert.equal(encerramentoParaCampo("28/10/2026"), "2026-10-28T00:00");
  assert.equal(encerramentoParaCampo(""), "");
});

test("a atualização dos antigos leva só os campos mudados e nunca em branco", () => {
  const abertos = [
    { numero: "UTIC-2026-1", valores: { A: "CLIENTE", B: "", D: "EM ABERTO", J: "INCIDENTE", R: "", S: "" } },
    { numero: "UTIC-2026-2", valores: { A: "", B: "", D: "", J: "", R: "", S: "" } },
    { numero: "UTIC-2026-3", valores: { A: "CLIENTE", D: "EM ABERTO", J: "INCIDENTE" } },
  ];
  const edicoes = {
    "UTIC-2026-1": { A: "CLIENTE", B: "REDE", D: "FINALIZADO", R: "2026-10-28T09:05", S: "" },
    "UTIC-2026-2": { A: "", D: "  " },
    "UTIC-2026-3": { A: "CLIENTE" },
  };
  assert.deepEqual(payloadEdicoes(abertos, edicoes), [
    { numero: "UTIC-2026-1", B: "REDE", D: "FINALIZADO", R: "28/10/2026 09:05" },
  ]);
  assert.deepEqual(payloadEdicoes(abertos, {}), []);
});

test("chamado antigo sem UTIC mostra o texto da coluna C e a linha; o botão conta os preenchimentos", () => {
  assert.equal(tituloAntigo({ numero: "linha:27", chamado: "Sem chamado" }), "Sem chamado (linha 27)");
  assert.equal(tituloAntigo({ numero: "linha:28", chamado: "" }), "Sem chamado (linha 28)");
  assert.equal(tituloAntigo({ numero: "UTIC-2026-1", chamado: "27371 / UTIC-2026-1" }), "27371 / UTIC-2026-1");
  assert.equal(tituloAntigo({ numero: "UTIC-2026-2" }), "UTIC-2026-2");
  assert.equal(totalPreenchimentos([{ automaticos_sugeridos: { K: "ABC" } }, { automaticos_sugeridos: {} }, {}]), 1);
  assert.equal(totalPreenchimentos(undefined), 0);
});

test("dadosAntigo: o Dashboard manda; título e solicitante vazios usam a leitura do SoftExpert", () => {
  const leitura = { titulo: " Monitor sem imagem ", solicitante: "Bruna", descricao: "Sem imagem.", atendimento: "", habilitada_em: "20/10/2026 09:15" };
  assert.deepEqual(dadosAntigo({ titulo: "", usuario: "", leitura_softexpert: leitura }),
    { lido: true, titulo: "Monitor sem imagem", solicitante: "Bruna", descricao: "Sem imagem.", atendimento: "", abertura: "20/10/2026 09:15" });
  const comDashboard = dadosAntigo({ titulo: "Do Dashboard", usuario: "Camila", leitura_softexpert: leitura });
  assert.equal(comDashboard.titulo, "Do Dashboard");
  assert.equal(comDashboard.solicitante, "Camila");
  assert.deepEqual(dadosAntigo({ titulo: "T", usuario: "U", leitura_softexpert: null }),
    { lido: false, titulo: "T", solicitante: "U", descricao: "", atendimento: "", abertura: "" });
  // 05/11/2026: sem leitura, a descrição vem da coluna H do Dashboard (item.descricao); com leitura, o Dashboard ainda manda.
  assert.equal(dadosAntigo({ titulo: "T", usuario: "U", descricao: "Falha no teclado.", leitura_softexpert: null }).descricao, "Falha no teclado.");
  assert.equal(dadosAntigo({ titulo: "T", usuario: "U", descricao: "Da planilha.", leitura_softexpert: leitura }).descricao, "Da planilha.");
});

test("resumoLeituraAntigos: andamento com X de Y, resultado completo e interrompido", () => {
  assert.match(resumoLeituraAntigos(null, true), /^Lendo chamados antigos no SoftExpert… Para parar, use Cancelar execução\.$/);
  const parcial = { em: "novo", total: 5, lidos: ["a", "b"], falhas: { c: "x" } };
  assert.match(resumoLeituraAntigos(parcial, true, "", "velho"), /… 3 de 5\./);
  assert.doesNotMatch(resumoLeituraAntigos(parcial, true, "", "novo"), /de 5/); // resultado da execução anterior não é andamento
  const feito = { concluido: true, lidos: ["a"], falhas: {}, sem_utic: 2, ja_lidos: 3 };
  assert.equal(resumoLeituraAntigos(feito, false, "28/10/2026 10:40"),
    "Leitura dos antigos de 28/10/2026 10:40: 1 lido(s), 0 com falha, 3 já lido(s) antes, 2 sem UTIC (não dá para ler).");
  assert.equal(resumoLeituraAntigos({ ...feito, concluido: false, ja_lidos: 0, sem_utic: 0 }, false),
    "Leitura dos antigos interrompida: 1 lido(s), 0 com falha. Ler de novo continua de onde parou.");
  assert.equal(resumoLeituraAntigos(null, false), "");
});

test("avisos de nome: mais de uma pessoa na descrição não preenche; uma só liga pelo nome citado", () => {
  assert.match(avisoOutraPessoa({ outra_pessoa: "Ícaro Gabriel Duarte Campos" }), /mais de uma pessoa \(Ícaro Gabriel Duarte Campos/);
  assert.equal(avisoOutraPessoa({}), "");
  assert.match(avisoNomeDaDescricao({ nome_da_descricao: "Daniel Krugel" }), /nome citado na descrição \(Daniel Krugel\)/);
  assert.equal(avisoNomeDaDescricao({}), "");
});

test("o botão Finalizar no SoftExpert exige descrição, nenhuma rotina rodando e chamado ainda não finalizado", () => {
  assert.equal(podeFinalizar("Troquei o teclado.", null, false), true);
  assert.equal(podeFinalizar("   ", null, false), false);
  assert.equal(podeFinalizar("", null, false), false);
  assert.equal(podeFinalizar("Texto", null, true), false);
  assert.equal(podeFinalizar("Texto", { status: "ok" }, false), false);
  assert.equal(podeFinalizar("Texto", { status: "ja_finalizado" }, false), true); // dado antigo: o backend só bloqueia "ok"
  assert.equal(podeFinalizar("Texto", { status: "nao_encontrado" }, false), true); // pode tentar de novo
  assert.equal(podeFinalizar("Texto", { status: "erro" }, false), true); // erro pode tentar de novo
});

test("Atualizar Dashboard só anuncia o que será finalizado: D virando FINALIZADO, UTIC, com descrição", () => {
  const abertos = [
    { numero: "UTIC-2026-1", valores: { D: "EM ABERTO" } },
    { numero: "UTIC-2026-2", valores: { D: "EM ABERTO" } },
    { numero: "UTIC-2026-3", valores: { D: "FINALIZADO" } },
    { numero: "linha:27", valores: { D: "EM ABERTO" } },
  ];
  const edicoes = { "UTIC-2026-1": { D: "FINALIZADO" }, "UTIC-2026-2": { D: "FINALIZADO" }, "UTIC-2026-3": { D: "FINALIZADO" }, "linha:27": { D: "FINALIZADO" } };
  const soft = { "UTIC-2026-1": { descricao: "Feito." }, "UTIC-2026-2": { descricao: " " }, "UTIC-2026-3": { descricao: "Feito." } };
  assert.deepEqual(candidatosFinalizar(abertos, edicoes, soft), ["UTIC-2026-1"]);
  assert.deepEqual(candidatosFinalizar(abertos, edicoes, {}), []);
  assert.deepEqual(candidatosFinalizar(abertos, {}, soft), []);
});

test("Atualizar Dashboard também anuncia chamados novos com D FINALIZADO, UTIC e descrição", () => {
  const formulario = [{ numero: "UTIC-2026-10" }, { numero: "UTIC-2026-11" }, { numero: "UTIC-2026-12" }];
  const valores = { "UTIC-2026-10": { D: "FINALIZADO" }, "UTIC-2026-11": { D: "FINALIZADO" }, "UTIC-2026-12": { D: "EM ABERTO" } };
  const soft = { "UTIC-2026-10": { descricao: "Feito." }, "UTIC-2026-11": { descricao: " " }, "UTIC-2026-12": { descricao: "Feito." } };
  assert.deepEqual(candidatosFinalizar([], {}, soft, formulario, valores), ["UTIC-2026-10"]);
  assert.deepEqual(candidatosFinalizar([], {}, {}, formulario, valores), []);
});

test("textos de resultado e de chamado pulado ficam em português", () => {
  assert.equal(textoResultado({ status: "ok", encerrado_em: "28/10/2026 10:10" }), "Finalizado no SoftExpert (encerrado em 28/10/2026 10:10)");
  assert.equal(textoResultado({ status: "ja_finalizado" }), "Já estava finalizado no SoftExpert");
  assert.equal(textoResultado({ status: "erro", mensagem: "o formulário não abriu" }), "Erro ao finalizar: o formulário não abriu");
  assert.equal(textoResultado({ status: "sem_descricao" }), "Sem descrição para finalizar");
  assert.equal(textoResultado({ status: "nao_encontrado", mensagem: "UTIC-2026-4 não está na central de tarefas" }),
    "Não encontrado na central de tarefas: UTIC-2026-4 não está na central de tarefas");
  assert.equal(textoResultado({ status: "nao_encontrado" }), "Não encontrado na central de tarefas");
  assert.equal(textoPulado({ numero: "UTIC-2026-9", motivo: "sem_descricao" }), "UTIC-2026-9: não será finalizado no SoftExpert (sem descrição para finalizar).");
  assert.match(textoPulado({ numero: "UTIC-2026-8", motivo: "ja_finalizado" }), /já finalizado no SoftExpert/);
  assert.match(textoPulado({ numero: "linha:3", motivo: "sem_numero" }), /sem número UTIC/);
});

test("resumos do início e do fim da finalização em massa contam cada resultado", () => {
  assert.equal(resumoInicio({ iniciado: true, numeros: ["a", "b"], pulados: [{ numero: "c" }] }), "Finalizando 2 chamado(s) no SoftExpert… 1 pulado(s).");
  assert.equal(resumoInicio({ iniciado: false, motivo: "sem descrição", pulados: [] }), "Nenhum chamado foi finalizado no SoftExpert: sem descrição");
  const resultado = { resultados: [{ status: "ok" }, { status: "ok" }, { status: "ja_finalizado" }, { status: "erro" }, { status: "nao_encontrado" }, { status: "sem_descricao" }] };
  assert.equal(resumoResultado(resultado), "Finalização no SoftExpert terminada: 2 finalizado(s), 1 já finalizado(s), 1 com erro, 1 não encontrado(s), 1 sem descrição.");
  assert.equal(resumoResultado({ resultados: [], cancelado: true }), "Finalização cancelada.");
});

test("tamanho do PDF aparece em B, KB ou MB", () => {
  assert.equal(formatarTamanho(512), "512 B");
  assert.equal(formatarTamanho(2048), "2 KB");
  assert.equal(formatarTamanho(1572864), "1,5 MB");
});

// ---- Rascunho automático das seleções ----

function armazenamentoFalso(inicial = {}) {
  const dados = { ...inicial };
  return { dados, get length() { return Object.keys(dados).length; }, key: i => Object.keys(dados)[i] ?? null, getItem: k => (k in dados ? dados[k] : null), setItem: (k, v) => { dados[k] = String(v); }, removeItem: k => { delete dados[k]; } };
}

test("rascunho mantém UTIC estável após reimportação", () => {
  const disco = armazenamentoFalso();
  const valores = { "UTIC-2026-7": { A: "CLIENTE", J: "INCIDENTE" } };
  const edicoes = { "UTIC-2026-1": { D: "FINALIZADO", R: "2026-10-28T09:05" } };
  assert.equal(gravarRascunho(disco, "2026-10-28T10:00", valores, edicoes), true);
  const lido = lerRascunho(disco, "2026-10-28T10:00");
  assert.deepEqual(lido.valores, valores);
  assert.deepEqual(lido.edicoes, edicoes);
  assert.deepEqual(lerRascunho(disco, "2026-10-29T08:00").valores, valores);
  assert.deepEqual(lerRascunho(disco, "").edicoes, {});
  apagarRascunho(disco);
  assert.deepEqual(lerRascunho(disco, "2026-10-28T10:00").valores, {});
});

test("rascunho não quebra com armazenamento ausente, que lança erro ou com texto corrompido", () => {
  const quebrado = { getItem() { throw new Error("bloqueado"); }, setItem() { throw new Error("cheio"); }, removeItem() { throw new Error("bloqueado"); } };
  assert.equal(gravarRascunho(quebrado, "x", {}, {}), false);
  assert.equal(gravarRascunho(null, "x", {}, {}), false);
  assert.deepEqual(lerRascunho(quebrado, "x").valores, {});
  assert.deepEqual(lerRascunho(null, "x").edicoes, {});
  apagarRascunho(quebrado);
  assert.deepEqual(lerRascunho(armazenamentoFalso({ "simpress:sebrae-rascunho": "{nao e json" }), "x").valores, {});
});

test("rascunho descarta números estranhos, letras desconhecidas e textos longos", () => {
  const disco = armazenamentoFalso({
    "simpress:sebrae-rascunho": JSON.stringify({
      importado_em: "x",
      valores: { "UTIC-2026-7": { A: "CLIENTE", Z: "invasor", B: "x".repeat(81), J: 5 }, "__proto__": { A: "mal" }, "qualquer": { A: "x" } },
      edicoes: { "linha:12": { S: "DISPONIBILIDADE" } },
    }),
  });
  const lido = lerRascunho(disco, "x");
  assert.deepEqual(lido.valores, { "UTIC-2026-7": { A: "CLIENTE" } });
  assert.deepEqual(lido.edicoes, { "linha:12": { S: "DISPONIBILIDADE" } });
  assert.equal({}.A, undefined);
});

test("aplicar o rascunho mantém só chamados que ainda existem e campos de antigos ainda vazios", () => {
  const rascunho = {
    valores: { "UTIC-2026-7": { A: "CLIENTE" }, "UTIC-2026-8": { A: "SIMPRESS" } },
    edicoes: { "UTIC-2026-1": { A: "SIMPRESS", D: "FINALIZADO", S: "DISPONIBILIDADE" }, "UTIC-2026-9": { A: "CLIENTE" } },
    salvoEm: "2026-10-30T10:00:00.000Z",
  };
  const abertos = [{ numero: "UTIC-2026-1", valores: { A: "CLIENTE", D: "EM ABERTO" } }];
  const aplicado = aplicarRascunho(rascunho, [{ numero: "UTIC-2026-7" }], abertos);
  assert.deepEqual(aplicado.valores, { "UTIC-2026-7": { A: "CLIENTE" } }); // o 8 saiu do formulário
  assert.deepEqual(aplicado.edicoes, { "UTIC-2026-1": { S: "DISPONIBILIDADE" } }); // A já preenchido no Dashboard não é sobrescrito; o 9 não está em aberto
  assert.equal(aplicado.restaurado, true);
  assert.equal(aplicarRascunho({ valores: {}, edicoes: {}, salvoEm: "" }, [], abertos).restaurado, false);
});

// ---- Estrutura do cartão pelo DOM falso (redesenho de 01/11/2026): zonas, pendências, selos e ordem dos feedbacks ----

const { createFakeDocument } = require("./support/fake-dom.cjs");

const CARGA_CARTOES = {
  importado: {
    arquivo: "Dashboard.xlsx", importado_em: "2026-10-28T10:00:00-03:00", total: 3, atualizavel: true, saida_pronta: false,
    listas: { A: ["CLIENTE", "SIMPRESS"], B: ["REDE"] },
    abertos: [
      { numero: "UTIC-2026-1200", titulo: "Teclado sem resposta", chamado: "UTIC-2026-1200", usuario: "Camila", automaticos: {}, automaticos_sugeridos: {},
        valores: { A: "SIMPRESS", B: "", D: "EM ABERTO", J: "INCIDENTE", R: "", S: "" }, leitura_softexpert: null, softexpert: { descricao_finalizacao: "", pdf: null, finalizacao: null } },
      { numero: "linha:27", titulo: "Impressora offline", chamado: "Sem UTIC", usuario: "Paulo", automaticos: {}, automaticos_sugeridos: {},
        valores: { A: "", B: "", D: "EM ABERTO", J: "", R: "", S: "" }, leitura_softexpert: null },
    ],
    finalizados: [{ numero: "UTIC-2026-1100", encerrado_em: "27/10/2026 14:05", em: "2026-10-27T14:06:00-03:00", descricao: "Teclado trocado.", pdf: null, ficha: { titulo: "Teclado", solicitante: "Ana", fatos: [["Solicitante", "Ana"]], detalhes: [], manuais: { A: "CLIENTE" } } }],
  },
  novos: {
    lidos_em: "2026-10-28T10:05:00-03:00", ignorados: 1, pendentes: [], erros: {},
    formulario: [{ numero: "UTIC-2026-1378", cruzamento: { status: "unico", candidatos: 1 }, linha: { C: "UTIC-2026-1378", G: "Computador travando", H: "Travando.", I: "Camila", F: "", K: "", L: "", N: "" } }],
  },
};

async function renderizarCartoes(carga = CARGA_CARTOES, armazenamento = null, chamadasOuApiFetch = null, apiFetchOverride = null) {
  const doc = createFakeDocument();
  // O DOM falso não tem classList; só o `toggle` é usado (cor verde do Status FINALIZADO).
  const criar = doc.createElement;
  doc.createElement = tag => {
    const no = criar(tag);
    no.classList = { toggle(nome, forcar) { const outras = no.className.split(/\s+/).filter(c => c && c !== nome); no.className = (forcar ? [...outras, nome] : outras).join(" "); } };
    return no;
  };
  global.document = doc;
  global.window = { setTimeout: () => 0, clearTimeout() {}, localStorage: armazenamento };
  const ids = [["sebrae-novos-lista", "div"], ["sebrae-antigos-lista", "div"], ["sebrae-antigos", "details"], ["sebrae-finalizados-lista", "ul"], ["sebrae-finalizados", "details"], ["sebrae-sharepoint-aviso", "div"],
    ["sebrae-atualizar-status", "p"], ["sebrae-novos-resumo", "p"], ["sebrae-dashboard-status", "p"], ["btn-sebrae-atualizar", "button"],
    ["sebrae-destaques", "details"], ["sebrae-destaques-contagem", "span"], ["sebrae-destaques-resumo", "p"], ["sebrae-destaques-lista", "div"],
    ["sebrae-destaque-anuncio", "p"], ["sebrae-novos-secao", "h3"]];
  const el = {};
  for (const [id, tag] of ids) { el[id] = doc.createElement(tag); el[id].setAttribute("id", id); doc.body.append(el[id]); }
  // como no index.html: as listas ficam dentro dos `details` recolhidos (o foco e o `closest("details")` dependem disso)
  el["sebrae-antigos"].append(el["sebrae-antigos-lista"]);
  el["sebrae-finalizados"].append(el["sebrae-finalizados-lista"]);
  el["sebrae-novos-lista"].setAttribute("aria-busy", "true");
  el["sebrae-destaques"].hidden = true; // como no index.html: a seção nasce escondida
  const chamadas = Array.isArray(chamadasOuApiFetch) ? chamadasOuApiFetch : null;
  const apiFetchPersonalizado = typeof chamadasOuApiFetch === "function" ? chamadasOuApiFetch : apiFetchOverride;
  const apiFetch = apiFetchPersonalizado || (async (url, opcoes = {}) => {
    chamadas?.push({ url, metodo: opcoes.method || "GET", corpo: opcoes.body });
    if (opcoes.method === "PUT" && url.endsWith("/descricao")) { const texto = JSON.parse(opcoes.body).descricao; return { descricao: texto || "Travando.", descricao_editada: texto }; }
    if (opcoes.method === "PUT" && url.endsWith("/destaque")) { const ligado = JSON.parse(opcoes.body).destaque; return { numero: decodeURIComponent(url.split("/")[4]), destaque: ligado, destaque_em: ligado ? "2026-11-05T09:00:00-03:00" : null }; }
    return carga;
  });
  const app = { apiFetch, showToast() {}, confirmarAcao: async () => true };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  const feature = createSebraeDashboard({ app, dom });
  await feature.carregarNovosSebrae();
  return { doc, el, feature, app };
}

test("a OS do cartão é um botão que abre a aba OS (F6) na linha dessa OS, sem escrever nada", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  Object.assign(carga.novos.formulario[0].linha, { K: "BRJ54925BT", E: "7281145" });
  const { el, app } = await renderizarCartoes(carga);
  const aberturas = [];
  app.abrirChamadoDaOs = (...args) => aberturas.push(args);
  const botao = el["sebrae-novos-lista"].querySelector("button.sebrae-chamado__os");
  assert.ok(botao);
  assert.equal(botao.textContent, "7281145");
  botao.click();
  assert.deepEqual(aberturas, [[[], "BRJ54925BT", "7281145"]]);
});

test("ficha legada malformada preserva partes válidas e não interrompe os cartões", async () => {
  for (const detalhes of ["texto bruto", {}, [null, ["incompleto"], ["Descrição", "Válida"]]]) {
    const carga = structuredClone(CARGA_CARTOES);
    const ficha = carga.importado.finalizados[0].ficha;
    ficha.detalhes = detalhes;
    ficha.fatos.push(null, "inválido", ["incompleto"]);
    const original = JSON.stringify(carga);
    const { el } = await renderizarCartoes(carga);
    const finalizado = el["sebrae-finalizados-lista"].querySelector("article.sebrae-chamado--finalizado");
    assert.ok(finalizado);
    assert.match(finalizado.textContent, /Teclado/);
    assert.match(finalizado.textContent, /Ana/);
    if (Array.isArray(detalhes)) assert.match(finalizado.textContent, /Válida/);
    assert.ok(el["sebrae-novos-lista"].querySelector("article.sebrae-chamado--novo"));
    assert.equal(JSON.stringify(carga), original, "dados brutos não são reescritos");
  }
});

test("envio confirmado com limpeza adiada mostra aviso sem oferecer reenvio", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.sharepoint = { falhou: false, limpeza_pendente: true };
  const { el } = await renderizarCartoes(carga);
  const aviso = el["sebrae-sharepoint-aviso"];
  assert.equal(aviso.hidden, false);
  assert.match(aviso.textContent, /enviado ao SharePoint/);
  assert.match(aviso.textContent, /preservadas/);
  assert.equal(aviso.querySelector("button"), null);
});

test("remoção de PDF pendente aparece após reload e retry preserva o PDF atual", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  const soft = carga.importado.abertos[0].softexpert;
  soft.pdf_remocao_pendente = true;
  soft.pdf = { nome: "novo.pdf", tamanho: 16 };
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
    if (opts?.method === "DELETE") { pedidos.push(url); return { pdf: soft.pdf }; }
    return carga;
  });
  const botao = el["sebrae-antigos-lista"].querySelector('[data-sebrae-pdf-remocao="UTIC-2026-1200"]');
  assert.ok(botao);
  assert.equal(botao.hidden, false);
  assert.match(botao.textContent, /Tentar remover novamente/);
  botao.dispatchEvent({ type: "click", currentTarget: botao });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pedidos, ["/api/sebrae/chamados/UTIC-2026-1200/anexo?somente_pendentes=true"]);
  assert.equal(botao.hidden, true);
  assert.match(el["sebrae-antigos-lista"].textContent, /novo.pdf/);
});

test("erro de remoção com estado confirmado atualiza o PDF e oferece retry sem apagar anexo novo", async () => {
  for (const pdfAtual of [null, { nome: "novo.pdf", tamanho: 16 }]) {
    const carga = structuredClone(CARGA_CARTOES);
    const numero = "UTIC-2026-1200";
    carga.importado.abertos[0].softexpert.pdf = pdfAtual || { nome: "antigo.pdf", tamanho: 16 };
    carga.importado.abertos[0].softexpert.pdf_remocao_pendente = Boolean(pdfAtual);
    const pedidos = [];
    const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
      if (opts?.method === "DELETE") {
        pedidos.push(url);
        throw Object.assign(new Error("A remoção do PDF está pendente."), {
          status: 503, data: { numero, pdf: pdfAtual, pdf_remocao_pendente: true },
        });
      }
      return carga;
    });
    const lista = el["sebrae-antigos-lista"];
    const remover = lista.querySelector(`[data-sebrae-pdf-remover="${numero}"]`);
    const retry = lista.querySelector(`[data-sebrae-pdf-remocao="${numero}"]`);
    (pdfAtual ? retry : remover).click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(pedidos, [`/api/sebrae/chamados/${numero}/anexo${pdfAtual ? "?somente_pendentes=true" : ""}`]);
    assert.equal(retry.hidden, false);
    assert.match(retry.textContent, /Tentar remover novamente/);
    assert.equal(remover.hidden, !pdfAtual);
    assert.doesNotMatch(lista.textContent, /antigo.pdf/);
    assert.match(lista.textContent, pdfAtual ? /PDF anexado: novo.pdf/ : /Nenhum PDF anexado/);
    assert.match(lista.textContent, /remoção do PDF está pendente/);
  }
});

test("falha de rede ou erro sem estado de remoção confirmado preserva o PDF exibido", async () => {
  const numero = "UTIC-2026-1200";
  for (const erro of [
    new TypeError("offline"),
    Object.assign(new Error("ocupado"), { status: 503, data: { detail: "ocupado" } }),
    Object.assign(new Error("outro chamado"), { status: 503, data: { numero: "UTIC-2026-9999", pdf: null, pdf_remocao_pendente: true } }),
    Object.assign(new Error("sem confirmação"), { status: 503, data: { numero, pdf: null } }),
  ]) {
    const carga = structuredClone(CARGA_CARTOES);
    carga.importado.abertos[0].softexpert.pdf = { nome: "atual.pdf", tamanho: 16 };
    const { el } = await renderizarCartoes(carga, null, async (_url, opts) => {
      if (opts?.method === "DELETE") throw erro;
      return carga;
    });
    const lista = el["sebrae-antigos-lista"];
    const remover = lista.querySelector(`[data-sebrae-pdf-remover="${numero}"]`);
    remover.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(remover.hidden, false);
    assert.equal(lista.querySelector(`[data-sebrae-pdf-remocao="${numero}"]`).hidden, true);
    assert.match(lista.textContent, /PDF anexado: atual.pdf/);
    assert.match(lista.textContent, /PDF não removido:/);
  }
});

test("envio incerto pede reconciliação manual sem confirmar envio nem oferecer retry", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.sharepoint = { falhou: false, limpeza_pendente: true, incerto: true };
  const { el } = await renderizarCartoes(carga);
  const aviso = el["sebrae-sharepoint-aviso"];
  assert.match(aviso.textContent, /incerto/);
  assert.match(aviso.textContent, /manualmente/);
  assert.doesNotMatch(aviso.textContent, /Dashboard enviado ao SharePoint/);
  assert.equal(aviso.querySelector("button"), null);
});

test("recuperação confirmada após reload só pede limpeza com o mesmo ID", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.sharepoint = { falhou: false, limpeza_pendente: true, incerto: false, envio_id: "a".repeat(32), snapshot_disponivel: true, status: "confirmado" };
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
    if (opts?.method === "POST") { pedidos.push([url, JSON.parse(opts.body)]); return { sharepoint: { ...carga.sharepoint, limpeza_pendente: false, status: "concluido", recuperacao: { acao: "limpar" } } }; }
    return carga;
  });
  el["sebrae-sharepoint-aviso"].querySelector('[data-sebrae-envio-acao="limpar"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pedidos, [["/api/sebrae/dashboard/envio/recuperar", { envio_id: "a".repeat(32), acao: "limpar", confirmacao: "" }]]);
  assert.match(el["sebrae-sharepoint-aviso"].textContent, /concluída/);
});

test("declaração de não enviado exige texto forte e nunca dispara upload automaticamente", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  const envio = "b".repeat(32);
  carga.sharepoint = { falhou: false, limpeza_pendente: true, incerto: true, envio_id: envio, snapshot_disponivel: true, status: "incerto" };
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
    if (opts?.method === "POST") { pedidos.push([url, JSON.parse(opts.body)]); return { sharepoint: { ...carga.sharepoint, incerto: false, limpeza_pendente: false, status: "falhou", recuperacao: { acao: "declarar_nao_enviado" } } }; }
    return carga;
  });
  const aviso = el["sebrae-sharepoint-aviso"];
  const botao = aviso.querySelector('[data-sebrae-envio-acao="declarar_nao_enviado"]');
  const entrada = aviso.querySelector("input");
  assert.equal(botao.disabled, true);
  entrada.value = "sim";
  entrada.dispatchEvent({ type: "input" });
  assert.equal(botao.disabled, true);
  entrada.value = `CONFIRMO NAO APLICADO ${envio}`;
  entrada.dispatchEvent({ type: "input" });
  assert.equal(botao.disabled, false);
  botao.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pedidos, [["/api/sebrae/dashboard/envio/recuperar", { envio_id: envio, acao: "declarar_nao_enviado", confirmacao: `CONFIRMO NAO APLICADO ${envio}` }]]);
  assert.match(aviso.textContent, /Nenhum upload foi disparado/);
  assert.match(aviso.textContent, /declarou/);
});

test("clique separado reenvia ESTA snapshot por ID e hash sem escolher fila", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  const envio = "c".repeat(32), sha = "d".repeat(64);
  carga.sharepoint = { envio_id: envio, sha256: sha, status: "falhou", snapshot_disponivel: true, falhou: false, limpeza_pendente: false, recuperacao: { acao: "declarar_nao_enviado" } };
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => { if (opts?.method === "POST") pedidos.push([url, JSON.parse(opts.body)]); return carga; });
  const botao = el["sebrae-sharepoint-aviso"].querySelector('[data-sebrae-envio-acao="reenviar_snapshot"]');
  assert.match(botao.textContent, /ESTA cópia/);
  assert.equal(pedidos.length, 0);
  botao.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pedidos, [["/api/sebrae/dashboard/envio/reenviar-snapshot", { envio_id: envio, sha256: sha, confirmado: true }]]);
});

test("snapshot já reenviada não reaparece como ausência após reload", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.sharepoint = { envio_id: "c".repeat(32), sha256: "d".repeat(64), status: "concluido", reenvio_confirmado: true, snapshot_disponivel: true, falhou: false, limpeza_pendente: false, recuperacao: { acao: "declarar_nao_enviado" } };
  const { el, feature } = await renderizarCartoes(carga);
  for (let cargaAtual = 0; cargaAtual < 2; cargaAtual++) {
    const aviso = el["sebrae-sharepoint-aviso"];
    assert.equal(Boolean(aviso.querySelector('[data-sebrae-envio-acao="reenviar_snapshot"]')), false);
    assert.match(aviso.textContent, /reenviada ao SharePoint com sucesso/);
    assert.doesNotMatch(aviso.textContent, /não está aplicado|Nenhum upload/);
    await feature.carregarNovosSebrae();
  }
});

test("legado confirmado mostra pasta e só conclui após declaração forte de preservação", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  const envio = "e".repeat(32);
  carga.sharepoint = { envio_id: envio, status: "confirmado", legado: true, snapshot_disponivel: false, limpeza_pendente: true, pasta_pendente: "C:/fixture/pendentes" };
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
    if (opts?.method === "POST") { pedidos.push([url, JSON.parse(opts.body)]); return { sharepoint: { ...carga.sharepoint, status: "concluido", limpeza_pendente: false, recuperacao: { acao: "concluir_legado" } } }; }
    return carga;
  });
  const aviso = el["sebrae-sharepoint-aviso"];
  assert.match(aviso.textContent, /C:\/fixture\/pendentes/);
  const botao = aviso.querySelector('[data-sebrae-envio-acao="concluir_legado"]');
  const entrada = aviso.querySelector("input");
  assert.equal(botao.disabled, true);
  entrada.value = `CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS ${envio}`;
  entrada.dispatchEvent({ type: "input" });
  assert.equal(botao.disabled, false);
  botao.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pedidos[0][1].acao, "concluir_legado");
  assert.match(aviso.textContent, /Conclusão manual/);
});

test("PDF pendente de chamado finalizado também tem retry acessível após reload", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.importado.finalizados[0].pdf_remocao_pendente = true;
  const pedidos = [];
  const { el } = await renderizarCartoes(carga, null, async (url, opts) => {
    if (opts?.method === "DELETE") { pedidos.push(url); return { pdf: null }; }
    return carga;
  });
  const botao = el["sebrae-finalizados-lista"].querySelector('[data-sebrae-pdf-remocao="UTIC-2026-1100"]');
  assert.ok(botao);
  botao.dispatchEvent({ type: "click", currentTarget: botao });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pedidos, ["/api/sebrae/chamados/UTIC-2026-1100/anexo?somente_pendentes=true"]);
});

test("o cartão novo tem as três zonas na ordem, as quatro pendências e o R opcional", async () => {
  const { el } = await renderizarCartoes();
  const cartao = el["sebrae-novos-lista"].querySelector("article.sebrae-chamado--novo");
  assert.ok(cartao, "cartão novo renderizado");
  assert.equal(cartao.querySelector(".sebrae-chamado__selo").textContent, "Novo");
  assert.deepEqual(cartao.querySelectorAll(".sebrae-zona__titulo").map(no => no.textContent), ["Solicitação", "Classificação operacional", "Finalização no SoftExpert"]);
  assert.deepEqual(cartao.querySelectorAll(".sebrae-zona__selo").map(no => no.textContent), ["Somente leitura", "Preenchimento manual", "Irreversível"]);
  assert.match(cartao.querySelector(".sebrae-zona__aviso").textContent, /^Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada\.$/);
  assert.deepEqual(cartao.querySelectorAll("li.sebrae-pend[data-req]").map(no => no.dataset.req), ["A", "D", "J", "DESC"]);
  assert.equal(cartao.querySelector("li.sebrae-pendencias__rotulo").textContent, "Para finalizar:");
  assert.equal(cartao.querySelector("li.sebrae-pend--opcional").textContent, "Encerramento (R): opcional");
  // Cada requisito traz os dois ícones (o CSS mostra um) e o texto para leitor de tela.
  const itemA = cartao.querySelector('li.sebrae-pend[data-req="A"]');
  const icones = itemA.children.filter(no => no.tagName === "SVG").map(no => no.getAttribute("class"));
  assert.equal(icones.filter(classe => /\bsebrae-pend__falta\b/.test(classe)).length, 1);
  assert.equal(icones.filter(classe => /\bsebrae-pend__ok\b/.test(classe)).length, 1);
  assert.deepEqual(itemA.querySelectorAll("span.sebrae-pend__falta, span.sebrae-pend__ok").map(no => no.textContent), [": pendente", ": ok"]);
});

test("a descrição nasce com placeholder vazio, e os dois feedbacks mantêm a ordem descrição, PDF", async () => {
  const { el } = await renderizarCartoes();
  const cartao = el["sebrae-novos-lista"].querySelector("article.sebrae-chamado--novo");
  const descricao = cartao.querySelector("textarea[data-sebrae-descricao]");
  assert.equal(descricao.placeholder, " ", "o CSS usa :placeholder-shown para saber se a descrição está vazia");
  assert.equal(cartao.querySelectorAll(".sebrae-chamado__feedback").length, 2);
  const [primeiro, segundo] = cartao.querySelectorAll(".sebrae-chamado__feedback");
  assert.ok(primeiro.parentNode.querySelector("textarea[data-sebrae-descricao]"), "o primeiro feedback é o da descrição");
  assert.ok(segundo.parentNode.querySelector("[data-sebrae-pdf]"), "o segundo feedback é o do PDF");
});

test("a lista carregada solta o aria-busy e o antigo vira details recolhido com os selos automáticos escondidos pelo CSS", async () => {
  const { el } = await renderizarCartoes();
  assert.equal(el["sebrae-novos-lista"].hasAttribute("aria-busy"), false);
  const itens = el["sebrae-antigos-lista"].querySelectorAll("details.sebrae-antigo");
  assert.equal(itens.length, 2);
  for (const item of itens) {
    assert.equal(item.hasAttribute("open"), false, "nasce recolhido");
    assert.equal(item.children[0].tagName, "SUMMARY");
    assert.equal(item.children[0].className, "sebrae-antigo__resumo");
    assert.equal(item.children[1].tagName, "ARTICLE");
    assert.deepEqual(item.querySelectorAll(".sebrae-selo--auto").map(no => no.textContent), ["D: FINALIZADO", "Pronto para finalizar", "Finalizando…", "Ver resultado", "Falhou"]);
  }
  const [comUtic, semUtic] = itens;
  const seloLeitura = item => item.querySelectorAll(".sebrae-antigo__resumo .sebrae-selo").filter(no => !no.className.includes("sebrae-selo--auto"));
  assert.deepEqual(seloLeitura(comUtic).map(no => no.textContent), ["Não lido"]);
  assert.deepEqual(seloLeitura(semUtic), [], "sem UTIC nada é prometido");
  assert.equal(semUtic.querySelectorAll("li.sebrae-pend[data-req]").length, 0, "sem UTIC não há seção de finalizar");
  assert.equal(comUtic.querySelector(".sebrae-chamado__selo").textContent, "Em aberto");
});

test("o finalizado é só leitura, com a zona Concluída e sem pendências", async () => {
  const { el } = await renderizarCartoes();
  const cartao = el["sebrae-finalizados-lista"].querySelector("article.sebrae-chamado--finalizado");
  assert.ok(cartao);
  assert.equal(cartao.querySelector(".sebrae-chamado__selo").textContent, "Finalizado");
  assert.equal(cartao.querySelector(".sebrae-zona--finalizacao .sebrae-zona__selo").textContent, "Concluída");
  assert.equal(cartao.querySelectorAll("li.sebrae-pend").length, 0);
  assert.equal(cartao.querySelector("textarea").readOnly, true);
  assert.equal(cartao.querySelector("textarea").placeholder, " ");
});

test("a falta de saída pronta avisa em Atualizar Dashboard com data-estado alerta", async () => {
  const { el } = await renderizarCartoes();
  assert.equal(el["sebrae-atualizar-status"].textContent, "Gere o Dashboard atualizado antes de enviar ao SharePoint.");
  assert.equal(el["sebrae-atualizar-status"].dataset.estado, "alerta");
});

const { gravarCampoRascunho } = createSebraeDashboard.puro;
test("campos de duas abas sobrevivem à reimportação e novos migram para antigos", () => {
  const disco = armazenamentoFalso();
  gravarCampoRascunho(disco, "antes", "UTIC-2026-1", "A", "MANUAL", "novo");
  gravarCampoRascunho(disco, "antes", "UTIC-2026-1", "J", "INCIDENTE", "novo");
  gravarCampoRascunho(disco, "antes", "linha:4", "A", "OUTRA LINHA", "antigo");
  const lido = lerRascunho(disco, "depois");
  assert.deepEqual(lido.valores["UTIC-2026-1"], { A: "MANUAL", J: "INCIDENTE" });
  assert.equal(lido.edicoes["linha:4"], undefined);
  const aplicado = aplicarRascunho(lido, [], [{ numero: "UTIC-2026-1", valores: { A: "DA PLANILHA" } }]);
  assert.deepEqual(aplicado.edicoes["UTIC-2026-1"], { J: "INCIDENTE" });
  assert.equal(aplicado.conflitos.length, 1);
  assert.match(aplicado.conflitos[0], /MANUAL.*DA PLANILHA/);
  assert.equal(Object.keys(disco.dados).length, 3); // até a linha sem identidade está preservada
  apagarRascunho(disco);
  assert.equal(Object.keys(disco.dados).length, 0);
});

test("status divergente da nova importação não reaplica FINALIZADO e preserva conflito", () => {
  const rascunho = { valores: {}, edicoes: { "UTIC-2026-1": { D: "FINALIZADO" } }, salvoEm: "" };
  const aplicado = aplicarRascunho(rascunho, [], [{ numero: "UTIC-2026-1", valores: { D: "EM ABERTO" } }]);
  assert.equal(aplicado.edicoes["UTIC-2026-1"], undefined);
  assert.match(aplicado.conflitos[0], /FINALIZADO.*EM ABERTO/);
  assert.equal(rascunho.edicoes["UTIC-2026-1"].D, "FINALIZADO");
});

test("gravar campo após falha remove valor antigo mantido apenas em memória", async () => {
  const disco = armazenamentoFalso();
  const salvar = disco.setItem;
  disco.setItem = () => { throw new Error("quota cheia"); };
  const { el, feature } = await renderizarCartoes(CARGA_CARTOES, disco);
  let campo = el["sebrae-novos-lista"].querySelector('[data-sebrae-campo="A"]');
  campo.value = "FALHOU";
  campo.dispatchEvent({ type: "input", currentTarget: campo });
  disco.setItem = salvar;
  campo.value = "SALVO AGORA";
  campo.dispatchEvent({ type: "input", currentTarget: campo });
  await feature.carregarNovosSebrae();
  campo = el["sebrae-novos-lista"].querySelector('[data-sebrae-campo="A"]');
  assert.equal(campo.value, "SALVO AGORA");
});

test("Status manual continua editável na mesma versão da importação", () => {
  const disco = armazenamentoFalso();
  gravarCampoRascunho(disco, "versao-atual", "UTIC-2026-1", "D", "FINALIZADO", "antigo");
  const original = [{ numero: "UTIC-2026-1", valores: { D: "EM ABERTO" } }];
  const mesma = aplicarRascunho(lerRascunho(disco, "versao-atual"), [], original, "versao-atual");
  assert.equal(mesma.edicoes["UTIC-2026-1"].D, "FINALIZADO");
  assert.equal(mesma.conflitos.length, 0);
  const outra = aplicarRascunho(lerRascunho(disco, "nova-versao"), [], original, "nova-versao");
  assert.equal(outra.edicoes["UTIC-2026-1"], undefined);
  assert.equal(outra.conflitos.length, 1);
});

test("rascunho de antigo migra para novo e divergências entre os dois ficam explícitas", () => {
  const numero = "UTIC-2026-1";
  const rascunho = { valores: {}, edicoes: { [numero]: { A: "MANUAL", J: "INCIDENTE" } }, salvoEm: "" };
  const novo = aplicarRascunho(rascunho, [{ numero }], []);
  assert.deepEqual(novo.valores[numero], { A: "MANUAL", J: "INCIDENTE" });
  assert.equal(novo.pendentes.length, 0);
  rascunho.valores[numero] = { A: "OUTRO" };
  const conflito = aplicarRascunho(rascunho, [{ numero }], []);
  assert.equal(conflito.valores[numero].A, undefined);
  assert.match(conflito.conflitos[0], /MANUAL.*OUTRO/);
  assert.equal(rascunho.edicoes[numero].A, "MANUAL");
  assert.equal(rascunho.valores[numero].A, "OUTRO");
});

// ---- Padrões do API SEBRAE nos chamados novos (03/11/2026) ----

const { ehApiSebrae, padroesManuais } = createSebraeDashboard.puro;
const esvaziarFila = () => new Promise(resolver => setImmediate(resolver));

test("API SEBRAE é reconhecido sem acento, em qualquer caixa e com espaços extras; os padrões são por chamado", () => {
  ["API SEBRAE", "api sebrae", "  Api   Sébrae "].forEach(nome => assert.equal(ehApiSebrae(nome), true, nome));
  ["Camila", "", undefined, "API SEBRAE 2", "SEBRAE"].forEach(nome => assert.equal(ehApiSebrae(nome), false, String(nome)));
  assert.deepEqual({ ...padroesManuais("API SEBRAE") }, { A: "CLIENTE", B: "OUTRO", D: "EM ABERTO", J: "INCIDENTE", S: "DISPONIBILIDADE" });
  assert.deepEqual({ ...padroesManuais({ linha: { I: "api sebrae" } }) }, { A: "CLIENTE", B: "OUTRO", D: "EM ABERTO", J: "INCIDENTE", S: "DISPONIBILIDADE" });
  assert.deepEqual({ ...padroesManuais("Camila") }, { D: "EM ABERTO", S: "DISPONIBILIDADE" });
  assert.deepEqual({ ...padroesManuais(undefined) }, { D: "EM ABERTO", S: "DISPONIBILIDADE" });
});

const softexpertVazio = definida => ({ descricao_finalizacao: "", descricao_definida: definida, pdf: null, finalizacao: null });
const novoDe = (numero, solicitante, softexpert) => ({
  numero, softexpert, cruzamento: { status: "unico", candidatos: 1 },
  linha: { C: numero, G: "Computador travando", H: "Travando.", I: solicitante, F: "", K: "", L: "", N: "" },
});
const cargaCom = formulario => ({ ...CARGA_CARTOES, novos: { ...CARGA_CARTOES.novos, formulario } });
const valorDe = (cartao, letra) => cartao.querySelector(`[data-sebrae-campo="${letra}"]`).value;
const cartaoDe = (el, numero) => el["sebrae-novos-lista"].querySelectorAll("article.sebrae-chamado--novo").find(no => no.querySelector(`[data-sebrae-numero="${numero}"]`));
const puts = chamadas => chamadas.filter(c => c.metodo === "PUT" && c.url.endsWith("/finalizacao"));

test("chamado novo do API SEBRAE nasce com A, B, D, J e S padrão, R vazio e a descrição Revisado. salva; os demais só com D e S", async () => {
  const chamadas = [];
  const carga = cargaCom([
    novoDe("UTIC-2026-1500", "API SEBRAE", softexpertVazio(false)),
    novoDe("UTIC-2026-1501", "Camila", softexpertVazio(false)),
  ]);
  const { el } = await renderizarCartoes(carga, null, chamadas);
  await esvaziarFila();
  const api = cartaoDe(el, "UTIC-2026-1500");
  assert.deepEqual(["A", "B", "D", "J", "R", "S"].map(letra => valorDe(api, letra)), ["CLIENTE", "OUTRO", "EM ABERTO", "INCIDENTE", "", "DISPONIBILIDADE"]);
  assert.equal(api.querySelector("textarea[data-sebrae-descricao]").value, "Revisado.");
  const outro = cartaoDe(el, "UTIC-2026-1501");
  assert.deepEqual(["A", "B", "D", "J", "R", "S"].map(letra => valorDe(outro, letra)), ["", "", "EM ABERTO", "", "", "DISPONIBILIDADE"]);
  assert.equal(outro.querySelector("textarea[data-sebrae-descricao]").value, "");
  // "Revisado." é salvo pelo mesmo PUT do autosave, só no API SEBRAE; nada chama a finalização
  assert.deepEqual(puts(chamadas).map(c => [c.url, JSON.parse(c.corpo)]), [["/api/sebrae/chamados/UTIC-2026-1500/finalizacao", { descricao_finalizacao: "Revisado." }]]);
  assert.equal(chamadas.some(c => c.metodo !== "GET" && c.url.includes("finalizar-softexpert")), false);
});

test("Revisado. não volta depois que a descrição foi guardada, nem se o usuário a apagou", async () => {
  const chamadas = [];
  const carga = cargaCom([
    novoDe("UTIC-2026-1500", "API SEBRAE", softexpertVazio(true)), // apagada: "" guardado
    novoDe("UTIC-2026-1502", "API SEBRAE", { ...softexpertVazio(true), descricao_finalizacao: "Troquei o cabo" }),
  ]);
  const { el } = await renderizarCartoes(carga, null, chamadas);
  await esvaziarFila();
  assert.equal(cartaoDe(el, "UTIC-2026-1500").querySelector("textarea[data-sebrae-descricao]").value, "");
  assert.equal(cartaoDe(el, "UTIC-2026-1502").querySelector("textarea[data-sebrae-descricao]").value, "Troquei o cabo");
  assert.equal(puts(chamadas).length, 0);
  // servidor antigo, sem o campo novo: não presume "ausente"
  const semCampo = cargaCom([novoDe("UTIC-2026-1500", "API SEBRAE", { descricao_finalizacao: "", pdf: null, finalizacao: null })]);
  const outras = [];
  const { el: el2 } = await renderizarCartoes(semCampo, null, outras);
  await esvaziarFila();
  assert.equal(cartaoDe(el2, "UTIC-2026-1500").querySelector("textarea[data-sebrae-descricao]").value, "");
  assert.equal(puts(outras).length, 0);
});

test("o rascunho do usuário vence o padrão do API SEBRAE e campo apagado não é preenchido de novo", async () => {
  const disco = armazenamentoFalso();
  gravarCampoRascunho(disco, "2026-10-28T10:00:00-03:00", "UTIC-2026-1500", "A", "SIMPRESS", "novo");
  gravarCampoRascunho(disco, "2026-10-28T10:00:00-03:00", "UTIC-2026-1500", "B", "", "novo");
  const { el } = await renderizarCartoes(cargaCom([novoDe("UTIC-2026-1500", "API SEBRAE", softexpertVazio(true))]), disco);
  const api = cartaoDe(el, "UTIC-2026-1500");
  assert.deepEqual(["A", "B", "J"].map(letra => valorDe(api, letra)), ["SIMPRESS", "", "INCIDENTE"]);
});

test("o API SEBRAE só com padrões não é tratado como trabalhado e finalizar continua sendo clique do usuário", async () => {
  const chamadas = [];
  const carga = cargaCom([
    novoDe("UTIC-2026-1500", "API SEBRAE", softexpertVazio(false)),
    novoDe("UTIC-2026-1501", "Camila", softexpertVazio(true)),
  ]);
  const { el } = await renderizarCartoes(carga, null, chamadas);
  await esvaziarFila();
  const botao = (cartao) => cartao.querySelector("button[data-sebrae-finalizar]");
  // clicar com D em EM ABERTO só avisa o que falta (nenhuma chamada de finalização)
  botao(cartaoDe(el, "UTIC-2026-1500")).dispatchEvent({ type: "click", currentTarget: botao(cartaoDe(el, "UTIC-2026-1500")) });
  await esvaziarFila();
  assert.equal(chamadas.some(c => c.metodo === "POST" && c.url.includes("finalizar-softexpert")), false);
  // o usuário finaliza o 1501 à mão; o 1500, que só tem os padrões, não vai no corpo
  const outro = cartaoDe(el, "UTIC-2026-1501");
  const editar = (letra, valor) => { const campo = outro.querySelector(`[data-sebrae-campo="${letra}"]`); campo.value = valor; campo.dispatchEvent({ type: "input", currentTarget: campo }); };
  editar("A", "CLIENTE"); editar("J", "INCIDENTE"); editar("D", "FINALIZADO");
  const texto = outro.querySelector("textarea[data-sebrae-descricao]");
  texto.value = "Feito.";
  texto.dispatchEvent({ type: "change", currentTarget: texto });
  await esvaziarFila();
  botao(outro).dispatchEvent({ type: "click", currentTarget: botao(outro) });
  for (let i = 0; i < 20 && !chamadas.some(c => c.metodo === "POST" && c.url.includes("finalizar-softexpert")); i++) await esvaziarFila();
  const envio = chamadas.filter(c => c.metodo === "POST" && c.url.includes("finalizar-softexpert"));
  assert.equal(envio.length, 1);
  const corpo = JSON.parse(envio[0].corpo);
  assert.equal(corpo.numero, "UTIC-2026-1501");
  assert.deepEqual(corpo.chamados.map(c => c.numero), ["UTIC-2026-1501"]);
});

test("API SEBRAE: trocar só D para FINALIZADO e clicar leva A, B, J e S padrão no corpo; recarregar com a descrição guardada não reaplica nem duplica o PUT", async () => {
  const chamadas = [];
  const { el } = await renderizarCartoes(cargaCom([novoDe("UTIC-2026-1500", "API SEBRAE", softexpertVazio(false))]), null, chamadas);
  await esvaziarFila();
  const cartao = cartaoDe(el, "UTIC-2026-1500");
  const d = cartao.querySelector('[data-sebrae-campo="D"]');
  d.value = "FINALIZADO";
  d.dispatchEvent({ type: "input", currentTarget: d });
  const botao = cartao.querySelector("button[data-sebrae-finalizar]");
  botao.dispatchEvent({ type: "click", currentTarget: botao });
  const envios = () => chamadas.filter(c => c.metodo === "POST" && c.url.includes("finalizar-softexpert"));
  for (let i = 0; i < 20 && !envios().length; i++) await esvaziarFila();
  assert.equal(envios().length, 1);
  const corpo = JSON.parse(envios()[0].corpo);
  assert.deepEqual(corpo.chamados, [{ numero: "UTIC-2026-1500", A: "CLIENTE", B: "OUTRO", D: "FINALIZADO", J: "INCIDENTE", R: "", S: "DISPONIBILIDADE" }]);
  assert.equal(puts(chamadas).length, 1); // só o "Revisado." inicial; salvar de novo no clique não repete o mesmo texto
  // nova carga já com "Revisado." guardado no servidor: nada é reaplicado nem reenviado
  const outras = [];
  const { el: el2 } = await renderizarCartoes(cargaCom([novoDe("UTIC-2026-1500", "API SEBRAE", { ...softexpertVazio(true), descricao_finalizacao: "Revisado." })]), null, outras);
  await esvaziarFila();
  assert.equal(cartaoDe(el2, "UTIC-2026-1500").querySelector("textarea[data-sebrae-descricao]").value, "Revisado.");
  assert.equal(puts(outras).length, 0);
});

test("o lápis abre o editor com o texto atual, salva só no site e a restauração volta ao original", async () => {
  const chamadas = [];
  const { el } = await renderizarCartoes(cargaCom([novoDe("UTIC-2026-1500", "Camila", softexpertVazio(false))]), null, chamadas);
  await esvaziarFila();
  const cartao = cartaoDe(el, "UTIC-2026-1500");
  const lapis = cartao.querySelector("button[data-sebrae-editar-descricao]");
  assert.equal(lapis.getAttribute("aria-label"), "Editar descrição de UTIC-2026-1500");
  assert.equal(lapis.getAttribute("aria-expanded"), "false");
  const editor = cartao.querySelector(".sebrae-descricao__editor");
  const selo = cartao.querySelector(".sebrae-descricao__selo");
  const restaurar = cartao.querySelector("button[data-sebrae-restaurar-descricao]");
  assert.equal(editor.hidden, true);
  assert.equal(selo.hidden, true, "sem edição não há selo");
  assert.equal(restaurar.hidden, true, "sem edição não há o que restaurar");
  assert.equal(lapis.parentNode.className, "sebrae-descricao", "botão dentro do summary é nested-interactive no axe");
  lapis.click();
  assert.equal(editor.hidden, false);
  assert.equal(lapis.getAttribute("aria-expanded"), "true");
  const texto = cartao.querySelector("textarea[data-sebrae-descricao-editada]");
  assert.equal(texto.value, "Travando.");
  texto.value = "Travando. Cliente também reclamou do teclado.";
  cartao.querySelector("button[data-sebrae-salvar-descricao]").click();
  await esvaziarFila();
  const descricoes = chamadas.filter(c => c.metodo === "PUT" && c.url.endsWith("/descricao"));
  assert.deepEqual(descricoes.map(c => [c.url, JSON.parse(c.corpo)]), [["/api/sebrae/chamados/UTIC-2026-1500/descricao", { descricao: "Travando. Cliente também reclamou do teclado." }]]);
  assert.equal(editor.hidden, true);
  assert.equal(selo.hidden, false);
  assert.equal(restaurar.hidden, false);
  assert.equal(puts(chamadas).filter(c => c.url.endsWith("/finalizacao")).length, 0, "editar a descrição nunca finaliza nem grava a descrição de finalização");
  restaurar.click();
  await esvaziarFila();
  assert.deepEqual(JSON.parse(chamadas.filter(c => c.url.endsWith("/descricao")).pop().corpo), { descricao: "" });
  assert.equal(selo.hidden, true);
});

test("campo de observação é renderizado na Zona 2 em novos, antigos (com UTIC e linha:N) e finalizados", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.novos.formulario[0].observacao = "Observação de chamado novo.";
  carga.importado.abertos[0].observacao = "Observação de chamado antigo UTIC.";
  carga.importado.abertos[1].observacao = "Observação de antigo linha:27.";
  carga.importado.finalizados[0].observacao = "Observação de chamado finalizado.";

  const { el } = await renderizarCartoes(carga);

  // Novo: na Zona 2 (Classificação operacional)
  const cartaoNovo = el["sebrae-novos-lista"].querySelector("article.sebrae-chamado--novo");
  const zonasNovo = cartaoNovo.querySelectorAll(".sebrae-zona");
  assert.equal(zonasNovo.length, 3, "preserva o layout de exatamente 3 zonas");
  const zona2Novo = zonasNovo[1];
  assert.equal(zona2Novo.querySelector(".sebrae-zona__titulo").textContent, "Classificação operacional");
  const obsNovo = zona2Novo.querySelector('textarea[data-sebrae-observacao="UTIC-2026-1378"]');
  assert.ok(obsNovo);
  assert.equal(obsNovo.value, "Observação de chamado novo.");
  assert.equal(Boolean(obsNovo.readOnly), false);
  const feedbackNovo = zona2Novo.querySelector(".sebrae-obs__feedback");
  assert.ok(feedbackNovo);
  assert.equal(feedbackNovo.textContent, "Salva automaticamente.");

  // Antigo com UTIC:
  const cartaoAntigoUtic = el["sebrae-antigos-lista"].querySelectorAll("details.sebrae-antigo")[0];
  const obsAntigoUtic = cartaoAntigoUtic.querySelector('textarea[data-sebrae-observacao="UTIC-2026-1200"]');
  assert.ok(obsAntigoUtic);
  assert.equal(obsAntigoUtic.value, "Observação de chamado antigo UTIC.");
  assert.equal(Boolean(obsAntigoUtic.readOnly), false);
  const feedbackAntigoUtic = cartaoAntigoUtic.querySelector(".sebrae-obs__feedback");
  assert.ok(feedbackAntigoUtic);

  // Antigo sem UTIC (linha:27):
  const cartaoAntigoLinha = el["sebrae-antigos-lista"].querySelectorAll("details.sebrae-antigo")[1];
  const obsAntigoLinha = cartaoAntigoLinha.querySelector('textarea[data-sebrae-observacao="linha:27"]');
  assert.ok(obsAntigoLinha);
  assert.equal(obsAntigoLinha.value, "Observação de antigo linha:27.");
  assert.equal(Boolean(obsAntigoLinha.readOnly), false);

  // Finalizado: somente leitura
  const cartaoFinalizado = el["sebrae-finalizados-lista"].querySelector("li details.sebrae-finalizado");
  const obsFinalizado = cartaoFinalizado.querySelector('textarea[data-sebrae-observacao="UTIC-2026-1100"]');
  assert.ok(obsFinalizado);
  assert.equal(obsFinalizado.value, "Observação de chamado finalizado.");
  assert.equal(obsFinalizado.readOnly, true);
  assert.equal(cartaoFinalizado.querySelector(".sebrae-obs__feedback"), null, "finalizado não tem feedback interativo");
});

test("autosave de observação dispara PUT com debounce no input e imediato no change/blur", async () => {
  const chamadas = [];
  const { el } = await renderizarCartoes(CARGA_CARTOES, null, chamadas);
  const cartaoNovo = el["sebrae-novos-lista"].querySelector("article.sebrae-chamado--novo");
  const textarea = cartaoNovo.querySelector('textarea[data-sebrae-observacao="UTIC-2026-1378"]');
  const feedback = cartaoNovo.querySelector(".sebrae-obs__feedback");

  // Digitar: muda para pendente
  textarea.value = "Aguardando confirmação do usuário.";
  textarea.dispatchEvent({ type: "input" });
  assert.equal(feedback.textContent, "Alteração ainda não salva…");
  assert.equal(feedback.dataset.estado, "pendente");

  // Disparar blur (imediato)
  textarea.dispatchEvent({ type: "blur" });
  await esvaziarFila();

  const putsObs = chamadas.filter(c => c.metodo === "PUT" && c.url.includes("/observacao"));
  assert.equal(putsObs.length, 1);
  assert.equal(putsObs[0].url, "/api/sebrae/chamados/UTIC-2026-1378/observacao");
  assert.deepEqual(JSON.parse(putsObs[0].corpo), { observacao: "Aguardando confirmação do usuário." });
  assert.equal(feedback.textContent, "Salva.");
  assert.equal(feedback.dataset.estado, "ok");
});

// ---- Destaque manual (botão, selo, seção `Chamados em destaque`) ----

const botoesDestaque = (raiz, numero) => raiz.querySelectorAll("[data-sebrae-destaque]").filter(no => no.dataset.sebraeDestaque === numero);
const artigosDe = numero => global.document.querySelectorAll("article[data-numero]").filter(no => no.dataset.numero === numero);
const seloDe = (raiz, numero) => raiz.querySelectorAll(".sebrae-selo-destaque").filter(no => no.dataset.sebraeDestaqueSelo === numero);
const cartaoDaSecao = (el, numero) => el["sebrae-destaques-lista"].querySelectorAll("[data-sebrae-destaque-cartao]").find(no => no.dataset.sebraeDestaqueCartao === numero);
const putsDestaque = chamadas => chamadas.filter(c => c.metodo === "PUT" && c.url.endsWith("/destaque"));

test("o botão do chamado novo alterna, chama o PUT e acende selo, classe e a seção; o do cartão da seção desfaz tudo", async () => {
  const chamadas = [];
  const { el } = await renderizarCartoes(CARGA_CARTOES, null, chamadas);
  const secao = el["sebrae-destaques"];
  const numero = "UTIC-2026-1378";
  const [botao] = botoesDestaque(el["sebrae-novos-lista"], numero);
  const [artigo] = artigosDe(numero);
  assert.equal(secao.hidden, true, "sem destaque a seção fica escondida");
  assert.equal(botao.textContent, "Marcar destaque");
  assert.equal(botao.getAttribute("aria-pressed"), "false");
  assert.equal(seloDe(artigo, numero)[0].hidden, true);
  assert.ok(!artigo.className.includes("sebrae-chamado--destaque"));

  botao.click();
  await esvaziarFila();
  assert.deepEqual(putsDestaque(chamadas).map(c => [c.url, JSON.parse(c.corpo)]), [[`/api/sebrae/chamados/${numero}/destaque`, { destaque: true }]]);
  assert.equal(botao.textContent, "Tirar destaque");
  assert.equal(botao.getAttribute("aria-pressed"), "true");
  const selo = seloDe(artigo, numero)[0];
  assert.equal(selo.hidden, false);
  assert.equal(selo.textContent, "★Destaque");
  assert.ok(artigo.className.includes("sebrae-chamado--destaque"));
  assert.equal(secao.hidden, false);
  assert.equal(secao.open, true, "a seção nasce aberta quando há itens");
  assert.equal(el["sebrae-destaques-contagem"].textContent, "1");
  const cartao = cartaoDaSecao(el, numero);
  assert.ok(cartao.textContent.includes("Computador travando"));
  assert.ok(cartao.textContent.includes("Em destaque desde"));
  assert.equal(artigosDe(numero).length, 1, "o F5 da Home acha só o artigo original");
  assert.equal(secao.querySelectorAll("article").length, 0);
  assert.equal(secao.querySelectorAll("[id]").length, 0, "a seção não repete ids");

  const [botaoDaSecao] = botoesDestaque(cartao, numero);
  assert.equal(botaoDaSecao.getAttribute("aria-pressed"), "true");
  botaoDaSecao.click();
  await esvaziarFila();
  assert.deepEqual(putsDestaque(chamadas).map(c => JSON.parse(c.corpo)), [{ destaque: true }, { destaque: false }]);
  assert.equal(botao.textContent, "Marcar destaque");
  assert.equal(botao.getAttribute("aria-pressed"), "false");
  assert.equal(seloDe(artigo, numero)[0].hidden, true);
  assert.ok(!artigo.className.includes("sebrae-chamado--destaque"));
  assert.equal(secao.hidden, true, "sem destaque a seção some");
  assert.equal(cartaoDaSecao(el, numero), undefined);
});

test("destaque vindo das listas: antigo UTIC e linha:N mostram selo e classe, entram na seção e usam a URL codificada", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.importado.abertos[0].destaque = true;
  carga.importado.abertos[0].observacao = "Cobrar o fornecedor.";
  const chamadas = [];
  const { el } = await renderizarCartoes(carga, null, chamadas);
  const lista = el["sebrae-antigos-lista"];
  const [artigoUtic] = artigosDe("UTIC-2026-1200");
  assert.ok(artigoUtic.className.includes("sebrae-chamado--destaque"));
  assert.equal(lista.querySelectorAll(".sebrae-antigo__resumo .sebrae-selo-destaque").map(no => no.hidden).join(), "false,true", "só o selo do resumo do UTIC acende");
  assert.equal(el["sebrae-destaques"].hidden, false);
  assert.equal(el["sebrae-destaques-contagem"].textContent, "1");
  assert.ok(cartaoDaSecao(el, "UTIC-2026-1200").textContent.includes("Cobrar o fornecedor."), "a observação fica sempre visível no cartão da seção");
  assert.equal(artigosDe("UTIC-2026-1200").length, 1);

  const [botaoLinha] = botoesDestaque(lista, "linha:27");
  botaoLinha.click();
  await esvaziarFila();
  assert.equal(putsDestaque(chamadas)[0].url, "/api/sebrae/chamados/linha%3A27/destaque");
  assert.equal(el["sebrae-destaques-contagem"].textContent, "2");
  assert.ok(cartaoDaSecao(el, "linha:27").textContent.includes("Impressora offline"));
});

test("chamado finalizado em destaque vai para o topo; o botão funciona com a observação só leitura", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.importado.finalizados.unshift({ ...structuredClone(carga.importado.finalizados[0]), numero: "UTIC-2026-1090", ficha: { titulo: "Mouse", solicitante: "Bia", fatos: [], detalhes: [], manuais: {} } });
  carga.importado.finalizados[1].destaque = true;
  const chamadas = [];
  const { el } = await renderizarCartoes(carga, null, chamadas);
  const ordem = () => el["sebrae-finalizados-lista"].children.map(li => li.dataset.numero);
  assert.deepEqual(ordem(), ["UTIC-2026-1100", "UTIC-2026-1090"], "o destaque sobe, o resto mantém a ordem");
  const detalhe = el["sebrae-finalizados-lista"].children[0].querySelector("details.sebrae-finalizado");
  assert.ok(detalhe.querySelector("article").className.includes("sebrae-chamado--destaque"));
  assert.equal(detalhe.querySelector(".sebrae-finalizado__resumo .sebrae-selo-destaque").hidden, false, "o selo do resumo acende");

  const outro = el["sebrae-finalizados-lista"].children[1];
  const [botao] = botoesDestaque(outro, "UTIC-2026-1090");
  assert.equal(outro.querySelector("textarea[data-sebrae-observacao]").readOnly, true);
  botao.click();
  await esvaziarFila();
  assert.deepEqual(putsDestaque(chamadas).map(c => c.url), ["/api/sebrae/chamados/UTIC-2026-1090/destaque"]);
  assert.deepEqual(ordem(), ["UTIC-2026-1090", "UTIC-2026-1100"], "os dois em destaque seguem a ordem original");
  assert.ok(outro.querySelector("article").className.includes("sebrae-chamado--destaque"));
  assert.equal(el["sebrae-destaques-contagem"].textContent, "2");
  assert.ok(cartaoDaSecao(el, "UTIC-2026-1090").textContent.includes("Mouse"));
});

test("destaque fora das listas vem de GET /api/sebrae/observacoes e aparece como cartão mínimo; chaves inválidas e sem destaque são ignoradas", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.observacoes = {
    "UTIC-2026-0999": { observacao: "Anotação antiga importante.", atualizado_em: "2026-10-01T08:00:00-03:00", destaque: true, destaque_em: "2026-11-01T10:00:00-03:00" },
    "linha:5": { observacao: "Só observação.", atualizado_em: "2026-10-02T08:00:00-03:00", destaque: false, destaque_em: null },
  };
  Object.defineProperty(carga.observacoes, "__proto__", { value: { observacao: "x", destaque: true, destaque_em: "2026-11-01T10:00:00-03:00" }, enumerable: true });
  const chamadas = [];
  const { el } = await renderizarCartoes(carga, null, chamadas);
  await esvaziarFila();
  assert.ok(chamadas.some(c => c.metodo === "GET" && c.url === "/api/sebrae/observacoes"));
  assert.equal(el["sebrae-destaques"].hidden, false);
  assert.equal(el["sebrae-destaques-contagem"].textContent, "1");
  const cartao = cartaoDaSecao(el, "UTIC-2026-0999");
  assert.ok(cartao.textContent.includes("Anotação antiga importante."));
  assert.ok(cartao.textContent.includes("Em destaque desde"));
  assert.equal(cartaoDaSecao(el, "linha:5"), undefined);
  assert.equal(artigosDe("UTIC-2026-0999").length, 0, "não existe cartão original; o mínimo não é article[data-numero]");
  const [botao] = botoesDestaque(cartao, "UTIC-2026-0999");
  assert.equal(botao.getAttribute("aria-pressed"), "true");
  botao.click();
  await esvaziarFila();
  assert.deepEqual(putsDestaque(chamadas).map(c => [c.url, JSON.parse(c.corpo)]), [["/api/sebrae/chamados/UTIC-2026-0999/destaque", { destaque: false }]]);
  assert.equal(el["sebrae-destaques"].hidden, true);
});

test("falha do PUT mostra a mensagem no cartão, mantém o estado e deixa tentar de novo", async () => {
  let falhar = true;
  const apiFetch = async (url, opcoes = {}) => {
    if (opcoes.method === "PUT" && url.endsWith("/destaque")) {
      if (falhar) throw new Error("Servidor fora do ar");
      return { numero: "UTIC-2026-1378", destaque: true, destaque_em: "2026-11-05T09:00:00-03:00" };
    }
    return CARGA_CARTOES;
  };
  const { el } = await renderizarCartoes(CARGA_CARTOES, null, apiFetch);
  const numero = "UTIC-2026-1378";
  const [botao] = botoesDestaque(el["sebrae-novos-lista"], numero);
  const [artigo] = artigosDe(numero);
  botao.click();
  await esvaziarFila();
  const feedback = artigo.querySelector(".sebrae-destaque__feedback");
  assert.equal(feedback.textContent, "Não foi possível salvar o destaque: Servidor fora do ar");
  assert.equal(feedback.dataset.estado, "erro");
  assert.equal(botao.textContent, "Marcar destaque");
  assert.equal(botao.getAttribute("aria-pressed"), "false");
  assert.equal(seloDe(artigo, numero)[0].hidden, true);
  assert.ok(!artigo.className.includes("sebrae-chamado--destaque"));
  assert.equal(el["sebrae-destaques"].hidden, true);

  falhar = false;
  botao.click();
  await esvaziarFila();
  assert.equal(feedback.textContent, "", "o sucesso limpa a mensagem de erro");
  assert.equal(botao.getAttribute("aria-pressed"), "true");
  assert.equal(el["sebrae-destaques"].hidden, false);
});

test("falha do GET de destaques não derruba a tela: os destaques das listas ficam e a seção avisa", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.novos.formulario[0].destaque = true;
  const apiFetch = async url => {
    if (url === "/api/sebrae/observacoes") throw new Error("Sem resposta");
    return carga;
  };
  const { el } = await renderizarCartoes(carga, null, apiFetch);
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, false);
  assert.equal(el["sebrae-destaques-contagem"].textContent, "1");
  assert.equal(el["sebrae-destaques-resumo"].textContent, "Sem resposta");
});

// ---- Destaque: anúncio, foco, corrida de PUT × recarga ----

const adiado = () => { let liberar; const promessa = new Promise(resolver => { liberar = resolver; }); return { promessa, liberar }; };
const respostaDestaque = (url, opcoes) => { const ligado = JSON.parse(opcoes.body).destaque; return { numero: decodeURIComponent(url.split("/")[4]), destaque: ligado, destaque_em: ligado ? "2026-11-05T09:00:00-03:00" : null }; };

test("marcar e tirar o destaque anunciam o resultado na região aria-live, a cada vez com um nó novo", async () => {
  const { el } = await renderizarCartoes(CARGA_CARTOES);
  const anuncio = el["sebrae-destaque-anuncio"];
  const [botao] = botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378");
  assert.equal(anuncio.textContent, "");
  botao.click();
  await esvaziarFila();
  assert.equal(anuncio.textContent, "Destaque marcado.");
  const primeiro = anuncio.children[0];
  botoesDestaque(el["sebrae-destaques-lista"], "UTIC-2026-1378")[0].click();
  await esvaziarFila();
  assert.equal(anuncio.textContent, "Destaque removido.");
  assert.notEqual(anuncio.children[0], primeiro);
});

test("tirar o último destaque pelo cartão da seção leva o foco ao resumo visível do cartão original (details fechado), nunca ao body", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.importado.finalizados[0].destaque = true;
  const { doc, el } = await renderizarCartoes(carga);
  const numero = carga.importado.finalizados[0].numero;
  el["sebrae-finalizados"].open = true;
  const botaoDaSecao = botoesDestaque(el["sebrae-destaques-lista"], numero)[0];
  botaoDaSecao.focus();
  assert.equal(doc.activeElement, botaoDaSecao);
  botaoDaSecao.click();
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  const resumo = el["sebrae-finalizados-lista"].querySelector("summary");
  assert.notEqual(doc.activeElement, doc.body, "o foco não pode cair no body");
  assert.equal(doc.activeElement, resumo, "o cartão original está num details interno fechado: o foco vai ao resumo dele");
});

test("tirar o último destaque sem cartão original (só no servidor) leva o foco ao título da primeira seção", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.observacoes = { "UTIC-2026-0999": { observacao: "Antiga.", atualizado_em: "2026-10-01T08:00:00-03:00", destaque: true, destaque_em: "2026-11-01T10:00:00-03:00" } };
  const { doc, el } = await renderizarCartoes(carga);
  await esvaziarFila();
  const botao = botoesDestaque(el["sebrae-destaques-lista"], "UTIC-2026-0999")[0];
  botao.focus();
  botao.click();
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  assert.equal(doc.activeElement, el["sebrae-novos-secao"]);
  assert.equal(el["sebrae-novos-secao"].getAttribute("tabindex"), "-1", "o título vira alvo de foco programático");
});

test("quem não estava no botão não ganha foco ao tirar o destaque", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.novos.formulario[0].destaque = true;
  const { doc, el } = await renderizarCartoes(carga);
  const outro = doc.createElement("button");
  doc.body.append(outro);
  outro.focus();
  botoesDestaque(el["sebrae-destaques-lista"], "UTIC-2026-1378")[0].click();
  await esvaziarFila();
  assert.equal(doc.activeElement, outro);
});

test("recarregar a lista com o PUT em andamento não apaga o destaque marcado", async () => {
  const put = adiado();
  const apiFetch = async (url, opcoes = {}) => {
    if (opcoes.method === "PUT" && url.endsWith("/destaque")) { await put.promessa; return respostaDestaque(url, opcoes); }
    return url === "/api/sebrae/observacoes" ? { observacoes: {} } : CARGA_CARTOES;
  };
  const { el, feature } = await renderizarCartoes(CARGA_CARTOES, null, apiFetch);
  botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].click();
  await esvaziarFila();
  await feature.carregarNovosSebrae(); // recarga (autosave, importação…) enquanto o PUT não respondeu
  await esvaziarFila();
  put.liberar();
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, false);
  assert.equal(el["sebrae-destaques-contagem"].textContent, "1");
  assert.equal(botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].getAttribute("aria-pressed"), "true");
});

// Servidor falso com estado: o PUT muda o destaque; a lista de novos e as leituras refletem o estado no momento da chamada.
function servidorDestaque({ destaque, adiarPut, adiarLeitura }) {
  const servidor = { destaque, leituras: 0 };
  const apiFetch = async (url, opcoes = {}) => {
    if (opcoes.method === "PUT" && url.endsWith("/destaque")) {
      if (adiarPut) await adiarPut.promessa;
      servidor.destaque = JSON.parse(opcoes.body).destaque;
      return respostaDestaque(url, opcoes);
    }
    const carga = structuredClone(CARGA_CARTOES);
    carga.novos.formulario[0].destaque = servidor.destaque;
    if (url !== "/api/sebrae/observacoes") return carga;
    servidor.leituras += 1;
    const retrato = { "UTIC-2026-1378": { observacao: "", destaque: servidor.destaque, destaque_em: "2026-11-01T10:00:00-03:00" } };
    if (servidor.leituras === adiarLeitura?.numero) await adiarLeitura.promessa; // este retrato fica velho enquanto espera
    return { observacoes: retrato };
  };
  return { servidor, apiFetch };
}

test("GET de destaques lido antes de um PUT que retirou o destaque não o ressuscita, mesmo depois de outra recarga", async () => {
  const antigo = adiado();
  const { apiFetch } = servidorDestaque({ destaque: true, adiarLeitura: { numero: 2, promessa: antigo.promessa } });
  const { el, feature } = await renderizarCartoes(CARGA_CARTOES, null, apiFetch);
  await esvaziarFila();
  await feature.carregarNovosSebrae(); // 2ª leitura de destaques: retrato "com destaque", pendente
  await esvaziarFila();
  botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].click(); // tira o destaque (PUT responde na hora)
  await esvaziarFila();
  await feature.carregarNovosSebrae(); // outra recarga (autosave…) zera os números "mexidos"
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  antigo.liberar();
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true, "a leitura antiga não ressuscita o destaque retirado");
  assert.equal(botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].getAttribute("aria-pressed"), "false");
});

test("recarga com o PUT que retira o destaque em andamento: a leitura que chega depois do PUT não o ressuscita", async () => {
  const put = adiado();
  const leitura = adiado();
  const { apiFetch } = servidorDestaque({ destaque: true, adiarPut: put, adiarLeitura: { numero: 2, promessa: leitura.promessa } });
  const { el, feature } = await renderizarCartoes(CARGA_CARTOES, null, apiFetch);
  await esvaziarFila();
  botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].click(); // PUT pendente
  await esvaziarFila();
  await feature.carregarNovosSebrae(); // recarga durante o PUT: a lista ainda traz o destaque e a leitura (2ª) fica pendente
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, false, "com o PUT em andamento o destaque segue como estava");
  put.liberar();
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  leitura.liberar(); // retrato de antes do PUT
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  assert.equal(botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].getAttribute("aria-pressed"), "false");
});

test("a lista lida antes de um PUT concluído não desfaz o resultado dele", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.novos.formulario[0].destaque = true;
  const lenta = adiado();
  let chamadasNovos = 0;
  const apiFetch = async (url, opcoes = {}) => {
    if (opcoes.method === "PUT" && url.endsWith("/destaque")) return respostaDestaque(url, opcoes);
    if (url === "/api/sebrae/novos") { chamadasNovos += 1; if (chamadasNovos === 2) await lenta.promessa; return carga; } // 2ª lista: ainda com o destaque
    return { observacoes: {} };
  };
  const { el, feature } = await renderizarCartoes(carga, null, apiFetch);
  await esvaziarFila();
  const recarga = feature.carregarNovosSebrae();
  await esvaziarFila();
  botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].click();
  await esvaziarFila();
  lenta.liberar();
  await recarga;
  await esvaziarFila();
  assert.equal(el["sebrae-destaques"].hidden, true);
  assert.equal(botoesDestaque(el["sebrae-novos-lista"], "UTIC-2026-1378")[0].getAttribute("aria-pressed"), "false");
});

test("autosave/recarga da seção mantém o foco no botão do cartão de destaque", async () => {
  const carga = structuredClone(CARGA_CARTOES);
  carga.novos.formulario[0].destaque = true;
  const { doc, el, feature } = await renderizarCartoes(carga);
  await esvaziarFila();
  const antes = botoesDestaque(el["sebrae-destaques-lista"], "UTIC-2026-1378")[0];
  antes.focus();
  await feature.carregarNovosSebrae(); // a seção é refeita por inteiro
  await esvaziarFila();
  const depois = botoesDestaque(el["sebrae-destaques-lista"], "UTIC-2026-1378")[0];
  assert.notEqual(depois, antes, "o cartão foi refeito");
  assert.equal(doc.activeElement, depois, "e o foco acompanha o botão novo");
});
