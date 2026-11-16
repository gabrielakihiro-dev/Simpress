// Modal "Atualizar / Cadastrar equipamento" (Home F1): regras puras de
// frontend/src/paineis/editar-equipamento/editar-equipamento-puro.ts, carregado direto pelo require do Node.
// O diálogo (tela, POST, resposta tardia) é testado no navegador: tests/e2e/react-g10.spec.cjs. Dados sintéticos.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const arquivo = path.join(__dirname, "../../frontend/src/paineis/editar-equipamento/editar-equipamento-puro.ts");
const puro = require(arquivo);

test("o arquivo puro não importa nada e não usa any (o Node o carrega sem build)", () => {
  const fonte = fs.readFileSync(arquivo, "utf8");
  assert.doesNotMatch(fonte, /^\s*import\s/m);
  assert.doesNotMatch(fonte, /:\s*any\b|\bas any\b|<any>/);
});

test("editar o selecionado trava a série, esconde o apelido e começa com os dados do equipamento", () => {
  const campos = puro.camposDoEquipamento({ serial: "AAA111", modelo: "Modelo X", tipo: "Monitor", apelido: "NB-01", idCliente: "C-9" });
  assert.deepEqual(campos, {
    titulo: "Atualizar Cadastro do Equipamento", badge: "AAA111", serial: "AAA111", somenteLeitura: true,
    modelo: "Modelo X", tipo: "Monitor", apelido: "NB-01", idCliente: "C-9", apelidoOculto: true,
  });
  assert.equal(puro.camposDoEquipamento({ serial: "AAA111" }).tipo, "Notebook", "sem tipo vale o padrão");
  assert.equal(puro.camposDoEquipamento(null).serial, "");
});

test("cadastrar série nova começa vazio, com o texto pesquisado em maiúsculas", () => {
  const novo = puro.camposDeNovoSerial("abc-12");
  assert.deepEqual(novo, {
    titulo: "Cadastrar Novo Equipamento", badge: "ABC-12", serial: "ABC-12", somenteLeitura: false,
    modelo: "", tipo: "Notebook", apelido: "", idCliente: "", apelidoOculto: false,
  });
  const vazio = puro.camposDeNovoSerial("");
  assert.equal(vazio.badge, "NOVO");
  assert.equal(vazio.serial, "");
});

test("montarPayload mantém a ordem de chaves e apara os campos de texto", () => {
  const campos = { serial: "  aaa111 ", somenteLeitura: true, modelo: "  Modelo X ", tipo: "Monitor", apelido: " ignorado ", idCliente: " C-9 " };
  const payload = puro.montarPayload(campos, { serial: "AAA111", apelido: "NB-01" });
  assert.deepEqual(Object.keys(payload), ["serial", "novo", "modelo", "tipo", "apelido", "idCliente"]);
  assert.deepEqual(payload, { serial: "AAA111", novo: false, modelo: "Modelo X", tipo: "Monitor", apelido: "NB-01", idCliente: "C-9" });
});

test("o apelido do equipamento selecionado prevalece sobre o campo, também ao cadastrar a mesma série", () => {
  const campos = { serial: "AAA111", somenteLeitura: false, modelo: "M", tipo: "Outro", apelido: "digitado", idCliente: "" };
  assert.equal(puro.montarPayload(campos, { serial: "AAA111", apelido: "DO-EQUIPAMENTO" }).apelido, "DO-EQUIPAMENTO");
  assert.equal(puro.montarPayload(campos, { serial: "AAA111" }).apelido, "", "equipamento sem apelido vale vazio, não o campo");
  assert.equal(puro.montarPayload(campos, { serial: "BBB222", apelido: "OUTRO" }).apelido, "digitado");
  assert.equal(puro.montarPayload({ ...campos, apelido: "  novo  " }, null).apelido, "novo");
  assert.equal(puro.montarPayload(campos, null).novo, true);
});

test("resposta tardia: só mexe no cartão se a revisão da seleção não mudou", () => {
  assert.equal(puro.seguiuSelecionado(4, 4), true);
  assert.equal(puro.seguiuSelecionado(4, 5), false);
});

test("lerResposta usa a mensagem do servidor ou a padrão com a série", () => {
  assert.deepEqual(puro.lerResposta({ mensagem: "Salvo", equipamento: { serial: "A" } }, "A"), { mensagem: "Salvo", equipamento: { serial: "A" } });
  assert.equal(puro.lerResposta({ equipamento: {} }, "AAA111").mensagem, "Equipamento AAA111 salvo com sucesso!");
  assert.equal(puro.lerResposta(null, "AAA111").equipamento, undefined);
});

test("textos aprovados e lista de tipos não mudam", () => {
  assert.equal(puro.TEXTO.salvar, "Salvar no Site e na Planilha");
  assert.equal(puro.TEXTO.salvando, "Salvando no Excel...");
  assert.equal(puro.TEXTO.serialObrigatorio, "O número de série é obrigatório.");
  assert.equal(puro.TEXTO.semEquipamento, "Pesquise um equipamento antes de editar.");
  assert.deepEqual([...puro.TIPOS], ["Notebook", "Micro Computador", "Headsets", "Monitor", "Impressora", "Outro"]);
  assert.equal(puro.normalizarSerial("  ab-1 "), "AB-1");
});
