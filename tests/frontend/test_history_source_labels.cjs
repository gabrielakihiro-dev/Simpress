const assert = require("node:assert/strict");
const test = require("node:test");
const historyFormat = require("../../static/js/shared/history-format.js");

const PREPOSITIONS = ["de", "da", "do", "das", "dos", "na", "no", "pela", "pelo", "em"];
const SOURCE_CASES = PREPOSITIONS.flatMap(preposition => [
  [`Dados ${preposition} Simpress`, `Dados ${preposition} Simpress`],
  [`Dados ${preposition} Endpoint`, `Dados ${preposition} ${preposition === "no" ? "endpoint" : "Endpoint"}`],
]);

const LABEL_CASES = [
  ["InvAll e EquipamentosDetalhes", "no endpoint e na Simpress"],
  ["Série duplicada no InvAll", "Série duplicada no endpoint"],
  ["Série não encontrada na InvAll", "Série não encontrada no endpoint"],
  ["Dados de EquipamentosDetalhes", "Dados na Simpress"],
  ["EM InvAll; DA EquipamentosDetalhes", "no endpoint; na Simpress"],
  ["NO ENDPOINT e NA SIMPRESS", "NO endpoint e NA Simpress"],
  ["EquipamentosDetalhes_atual.xlsx", "Simpress_atual.xlsx"],
  ["InvAllComputersSummary_atual.xlsx", "EndpointComputersSummary_atual.xlsx"],
  ["EquipamentosDetalhes (1).xlsx", "Simpress (1).xlsx"],
  ["InvAllComputersSummary (2).xlsx", "EndpointComputersSummary (2).xlsx"],
  ["Simpress.xlsx", "Simpress.xlsx"],
  ["Endpoint.xlsx", "Endpoint.xlsx"],
  ["historico_EquipamentosDetalhes_atual.xlsx", "historico_Simpress_atual.xlsx"],
  ["Arquivo InvAll-20261017.xlsx", "Arquivo Endpoint-20261017.xlsx"],
  ["Conferir Simpress.", "Conferir na Simpress."],
  ["Conferir Endpoint.", "Conferir no endpoint."],
  ["PRNOTE-ENDPOINT e PRNOTE-SIMPRESS", "PRNOTE-ENDPOINT e PRNOTE-SIMPRESS"],
  ["id_InvAll_event_EquipamentosDetalhes_20261017", "id_InvAll_event_EquipamentosDetalhes_20261017"],
  ["Planilha Simpress EquipamentosDetalhes_atual.xlsx", "Planilha na Simpress Simpress_atual.xlsx"],
  ["Dados DA SIMPRESS e PELO ENDPOINT", "Dados DA Simpress e PELO Endpoint"],
];

test("frontend source labels match approved source and preposition wording", () => {
  for (const [input, expected] of [...SOURCE_CASES, ...LABEL_CASES]) {
    assert.equal(historyFormat.formatarNomeFonteHistorico(input), expected, input);
  }
});

test("normalizing backend and frontend labels is idempotent", () => {
  for (const [input, expected] of [...SOURCE_CASES, ...LABEL_CASES]) {
    assert.equal(historyFormat.formatarNomeFonteHistorico(expected), expected, input);
    assert.equal(historyFormat.formatarNomeFonteHistorico(historyFormat.formatarNomeFonteHistorico(input)), expected, input);
  }
});
