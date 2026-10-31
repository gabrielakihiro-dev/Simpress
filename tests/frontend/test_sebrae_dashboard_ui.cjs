const test = require("node:test");
const assert = require("node:assert/strict");
const createSebraeDashboard = require("../../static/js/features/sebrae-dashboard.js");

const { formatarEncerramento, encerramentoParaCampo, chamadoPronto, payloadExportacao, payloadAtualizacao, payloadEdicoes, avisoOutraPessoa, avisoNomeDaDescricao, tituloAntigo, totalPreenchimentos,
  formatarTamanho, textoResultado, textoPulado, podeFinalizar, candidatosFinalizar, resumoResultado, resumoInicio,
  lerRascunho, gravarRascunho, apagarRascunho, aplicarRascunho } = createSebraeDashboard.puro;

test("converte o campo de data e hora para dd/MM/aaaa HH:mm e ignora valor inválido", () => {
  assert.equal(formatarEncerramento("2026-10-28T14:30"), "28/10/2026 14:30");
  assert.equal(formatarEncerramento(""), "");
  assert.equal(formatarEncerramento("ontem"), "");
});

test("chamado só está pronto com Responsável, Status e Tipo", () => {
  assert.equal(chamadoPronto({ A: "CLIENTE", D: "EM ABERTO", J: "INCIDENTE" }), true);
  assert.equal(chamadoPronto({ A: "CLIENTE", D: "EM ABERTO", J: "" }), false);
  assert.equal(chamadoPronto({ A: "  ", D: "EM ABERTO", J: "INCIDENTE" }), false);
  assert.equal(chamadoPronto(undefined), false);
});

test("a exportação leva só os prontos, com a data de encerramento formatada", () => {
  const formulario = [{ numero: "UTIC-2026-1" }, { numero: "UTIC-2026-2" }];
  const valores = {
    "UTIC-2026-1": { A: "CLIENTE", D: "FINALIZADO", J: "INCIDENTE", R: "2026-10-28T09:05", B: "OUTRO" },
    "UTIC-2026-2": { A: "CLIENTE" },
  };
  assert.deepEqual(payloadExportacao(formulario, valores), [
    { numero: "UTIC-2026-1", A: "CLIENTE", B: "OUTRO", D: "FINALIZADO", J: "INCIDENTE", R: "28/10/2026 09:05", S: "" },
  ]);
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
  // Exportar continua exigindo A, D e J.
  assert.deepEqual(payloadExportacao(formulario, valores).map(l => l.numero), ["UTIC-2026-1"]);
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
