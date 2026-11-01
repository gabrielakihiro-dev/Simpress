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
  return { dados, getItem: k => (k in dados ? dados[k] : null), setItem: (k, v) => { dados[k] = String(v); }, removeItem: k => { delete dados[k]; } };
}

test("rascunho grava e lê só para o mesmo Dashboard importado", () => {
  const disco = armazenamentoFalso();
  const valores = { "UTIC-2026-7": { A: "CLIENTE", J: "INCIDENTE" } };
  const edicoes = { "UTIC-2026-1": { D: "FINALIZADO", R: "2026-10-28T09:05" } };
  assert.equal(gravarRascunho(disco, "2026-10-28T10:00", valores, edicoes), true);
  const lido = lerRascunho(disco, "2026-10-28T10:00");
  assert.deepEqual(lido.valores, valores);
  assert.deepEqual(lido.edicoes, edicoes);
  assert.deepEqual(lerRascunho(disco, "2026-10-29T08:00").valores, {}); // outro Dashboard importado: rascunho velho não vale
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
  assert.deepEqual(aplicado.edicoes, { "UTIC-2026-1": { D: "FINALIZADO", S: "DISPONIBILIDADE" } }); // A já preenchido no Dashboard não é sobrescrito; o 9 não está em aberto
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

async function renderizarCartoes(carga = CARGA_CARTOES) {
  const doc = createFakeDocument();
  // O DOM falso não tem classList; só o `toggle` é usado (cor verde do Status FINALIZADO).
  const criar = doc.createElement;
  doc.createElement = tag => {
    const no = criar(tag);
    no.classList = { toggle(nome, forcar) { const outras = no.className.split(/\s+/).filter(c => c && c !== nome); no.className = (forcar ? [...outras, nome] : outras).join(" "); } };
    return no;
  };
  global.document = doc;
  global.window = { setTimeout: () => 0, clearTimeout() {}, localStorage: null };
  const ids = [["sebrae-novos-lista", "div"], ["sebrae-antigos-lista", "div"], ["sebrae-antigos", "details"], ["sebrae-finalizados-lista", "ul"], ["sebrae-finalizados", "details"],
    ["sebrae-atualizar-status", "p"], ["sebrae-novos-resumo", "p"], ["sebrae-dashboard-status", "p"], ["btn-sebrae-atualizar", "button"]];
  const el = {};
  for (const [id, tag] of ids) { el[id] = doc.createElement(tag); el[id].setAttribute("id", id); doc.body.append(el[id]); }
  el["sebrae-novos-lista"].setAttribute("aria-busy", "true");
  const app = { apiFetch: async () => carga, showToast() {}, confirmarAcao: async () => true };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  await createSebraeDashboard({ app, dom }).carregarNovosSebrae();
  return { doc, el };
}

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
