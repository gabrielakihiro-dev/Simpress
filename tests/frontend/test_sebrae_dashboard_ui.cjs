const test = require("node:test");
const assert = require("node:assert/strict");
const createSebraeDashboard = require("../../static/js/features/sebrae-dashboard.js");

const { formatarEncerramento, encerramentoParaCampo, chamadoPronto, payloadExportacao, payloadEdicoes } = createSebraeDashboard.puro;

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
