// "Transferências geradas" (painel React historico-transferencias): regras puras, ids do diálogo, ações liberadas
// no despachante e eventos que o código antigo escuta. O vínculo com a Cobertura fica em test_cobertura_transporte.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { appSource } = require("./support/app-sources.cjs");
const { assembledHtml } = require("./support/assembled-html.cjs");

const PAINEL = path.resolve(__dirname, "../../frontend/src/paineis/historico-transferencias");
const lerPainel = nome => fs.readFileSync(path.join(PAINEL, nome), "utf8");
const puro = require("../../frontend/src/paineis/historico-transferencias/historico-transferencias-puro.ts");

test("transfer history exposes the duplicate fields and the dedicated endpoint", () => {
  assert.equal(puro.ENDPOINT, "/api/historico-transferencias");
  const values = Object.fromEntries(puro.duplicateValues({ entrega_contato: "Ana", entrega_obs: "Obs" }));
  assert.equal(values["entrega-contato"], "Ana");
  assert.equal(values["entrega-obs"], "Obs");
  assert.equal(values["entrega-email"], "");
  assert.doesNotMatch(appSource(), /\/api\/transferencias/);
  assert.doesNotMatch(lerPainel("estado.ts"), /\/api\/transferencias/);
});

test("duplicar destino restaura só os sete campos de entrega, nunca a série", () => {
  assert.deepEqual(puro.DUPLICATE_FIELDS.map(([campo]) => campo), [
    "entrega-contato", "entrega-email", "entrega-telefone", "entrega-horario", "entrega-almoco",
    "entrega-pausa-duracao", "entrega-obs",
  ]);
  assert.equal(puro.DUPLICATE_FIELDS.some(([campo, chave]) => /serial|serie/.test(campo + chave)), false);
  assert.deepEqual(puro.duplicateValues(null).map(([, valor]) => valor), Array(7).fill(""));
});

test("data e rota têm texto de reserva quando o item vem incompleto", () => {
  assert.equal(puro.formatDateTime("não é data"), "não é data");
  assert.equal(puro.formatDateTime(""), "—");
  assert.match(puro.formatDateTime("2026-11-17T09:30:00"), /^\d{2}\/\d{2}\/\d{4}[,\s]+\d{2}:\d{2}$/);
  assert.equal(puro.routeLabel({}), "Origem não informada → Destino não informado");
  assert.equal(puro.routeLabel({ retirada_cidade: "Curitiba", entrega_cidade: "Maringá" }), "Curitiba → Maringá");
});

test("a unidade do destino sai do CNPJ e a rua desempata unidades com o mesmo CNPJ", () => {
  const opcoes = [
    { value: "", text: "Selecione" },
    { value: "1", text: "Maringá - Centro (00.000.000/0001-91)" },
    { value: "2", text: "Maringá - Zona 7 (00.000.000/0001-91)" },
    { value: "3", text: "Londrina (00.000.000/0002-72)" },
  ];
  assert.equal(puro.findUnitOption(opcoes, { entrega_cnpj: "00.000.000/0002-72" }).value, "3");
  assert.equal(puro.findUnitOption(opcoes, { entrega_cnpj: "00.000.000/0001-91", entrega_endereco: "Zona 7 - Maringá" }).value, "2");
  assert.equal(puro.findUnitOption(opcoes, { entrega_cnpj: "00.000.000/0001-91" }).value, "1");
  assert.equal(puro.findUnitOption(opcoes, { entrega_cnpj: "99.999.999/0001-99" }), null);
  assert.equal(puro.findUnitOption(opcoes, {}), null);
  assert.equal(puro.findUnitOption(opcoes, null), null);
});

test("mensagens de falha seguem o status do servidor", () => {
  assert.match(puro.describeFailure(501), /não está disponível neste modo de armazenamento/);
  assert.match(puro.describeFailure(503), /ilegível; os dados foram preservados.*historico_transferencias\.json/);
  assert.equal(puro.describeFailure(0), "Não foi possível carregar o histórico de transferências.");
  assert.equal(puro.describeFailure(500), "Não foi possível carregar o histórico de transferências.");
});

test("o diálogo é do React: o partial traz só o véu e o ponto de montagem, e busca e lista têm os ids exatos", () => {
  // Os ids do botão, do modal e da confirmação continuam em test_data_panels.cjs.
  assert.match(assembledHtml(), /data-react-painel="historico-transferencias"/);
  // Busca e lista: ids exatos que o Playwright, o ux-enhancements e o data-panels procuram.
  const estado = lerPainel("estado.ts");
  assert.match(estado, /export const ID_FILTRO = "filtro-historico-transferencias";/);
  assert.match(estado, /export const ID_LISTA = "lista-historico-transferencias";/);
  const dialogo = lerPainel("dialogo.tsx");
  assert.match(dialogo, /id=\{ID_FILTRO\}/);
  assert.match(dialogo, /id=\{ID_LISTA\}/);
  assert.match(dialogo, /htmlFor=\{ID_FILTRO\}/);
});

test("as duas ações do diálogo são publicadas na janela e liberadas no despachante", () => {
  const montar = lerPainel("montar.tsx");
  assert.match(montar, /Object\.assign\(window, \{ abrirModalHistoricoTransferencias, fecharModalHistoricoTransferencias \}\)/);
  assert.match(montar, /\.allow\(\["abrirModalHistoricoTransferencias", "fecharModalHistoricoTransferencias"\]\)/);
  // O ouvinte de simpress:transfer-generated roda no topo do módulo, fora de montar(): não depende do container.
  const registro = montar.search(/^registrarOuvinteTransferencia\(\);$/m);
  assert.ok(registro > -1 && registro < montar.indexOf("export function montar("));
  // As ações vão para a janela antes do render: erro ao desenhar não deixa o botão sem ação.
  assert.ok(montar.indexOf("Object.assign(window") < montar.indexOf("createRoot("));
});

test("a lista avisa o código antigo: carregando-exibido antes da busca, tabelas-renderizadas depois da lista", () => {
  const estado = lerPainel("estado.ts");
  assert.match(estado, /dispatchEvent\(new CustomEvent\("simpress:carregando-exibido"\)\)/);
  assert.match(estado, /dispatchEvent\(new CustomEvent\("simpress:tabelas-renderizadas"\)\)/);
  // O cabeçalho do arquivo cita os eventos em comentário: a ordem vale para o dispatchEvent real.
  const carregando = estado.indexOf('dispatchEvent(new CustomEvent("simpress:carregando-exibido"))');
  const busca = estado.indexOf("apiFetch(`");
  const lista = estado.indexOf('fase: "lista"');
  const tabelas = estado.indexOf('dispatchEvent(new CustomEvent("simpress:tabelas-renderizadas"))');
  assert.ok(carregando > 0 && carregando < busca, "carregando-exibido sai antes da busca");
  assert.ok(lista > busca && tabelas > lista, "tabelas-renderizadas sai depois da busca e da lista");
});
