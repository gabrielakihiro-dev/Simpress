const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const panels = require("../../static/js/ui/data-panels.js");
const ux = require("../../static/js/ui/ux-enhancements.js");
const history = require("../../static/js/ui/transfer-history.js");

const staticDir = path.join(__dirname, "..", "..", "static");
const appHtml = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const { appSource } = require("./support/app-sources.cjs");
const appScript = appSource();

test("sorting compares numbers, dates and text naturally and keeps empties last", () => {
  assert.ok(panels.compareValues("2", "10") < 0);
  assert.ok(panels.compareValues("02/01/2026 10:00", "10/01/2025 09:00") > 0);
  assert.ok(panels.compareValues("Ávila", "Beta") < 0);
  assert.ok(panels.compareValues("nota 2", "nota 10") < 0);
  const texts = ["b", "", "a", "c"];
  assert.deepEqual(panels.sortedOrder(texts, "ascending"), [2, 0, 3, 1]);
  assert.deepEqual(panels.sortedOrder(texts, "descending"), [3, 0, 2, 1]);
  assert.deepEqual(panels.sortedOrder(texts, "none"), [0, 1, 2, 3]);
});

test("sorting is stable for equal values and cycles asc, desc, original", () => {
  assert.deepEqual(panels.sortedOrder(["x", "x", "x"], "descending"), [0, 1, 2]);
  assert.equal(panels.nextDirection("none"), "ascending");
  assert.equal(panels.nextDirection("ascending"), "descending");
  assert.equal(panels.nextDirection("descending"), "none");
});

test("toTsv flattens tabs and line breaks", () => {
  assert.equal(panels.toTsv(["A", "B"], [["1\t2", "x\ny"]]), "A\tB\n1 2\tx y");
});

test("divergence badge counts only divergence categories", () => {
  const latest = { atencao: [
    { campo: "divergencias_local", total: 3 },
    { campo: "divergencias_apelidos_manuais", total: 2 },
    { campo: "sem_acesso_7_dias", total: 40 },
  ] };
  assert.equal(panels.divergenceTotal(latest), 5);
  assert.equal(panels.divergenceTotal(null), 0);
});

test("bar widths scale to the largest city", () => {
  assert.deepEqual(panels.barPercentages([{ total: 10 }, { total: 5 }, { total: 0 }]), [100, 50, 4]);
  assert.deepEqual(panels.barPercentages([]), []);
});

test("dashboard module is loaded, offline and touches only the allowed endpoint", () => {
  assert.match(appHtml, /<script src="\/static\/js\/ui\/data-panels\.js"><\/script>/);
  const source = fs.readFileSync(path.join(staticDir, "js", "ui", "data-panels.js"), "utf8");
  assert.doesNotMatch(source, /https?:\/\//);
  assert.doesNotMatch(source, /innerHTML/);
  assert.equal(panels.ENDPOINT, "/api/painel");
});

test("phone helpers accept DDD + number and leave other formats alone", () => {
  assert.equal(ux.phoneProblem(""), null);
  assert.equal(ux.phoneProblem("(41) 99999-1234"), null);
  assert.equal(ux.phoneProblem("(41) 3333-1234"), null);
  assert.notEqual(ux.phoneProblem("12345"), null);
  assert.equal(ux.formatPhone("41999991234"), "(41) 99999-1234");
  assert.equal(ux.formatPhone("4133331234"), "(41) 3333-1234");
  assert.equal(ux.formatPhone("+55 41 99999-1234"), "+55 41 99999-1234");
});

test("keyboard shortcuts ignore typing, modals and composition", () => {
  const press = (event, state) => ux.shortcutAction({ key: "", ...event }, state);
  assert.equal(press({ key: "/" }, {}), "search");
  assert.equal(press({ key: "/" }, { typing: true }), null);
  assert.equal(press({ key: "k", ctrlKey: true }, { typing: true }), "search");
  assert.equal(press({ key: "k", ctrlKey: true }, { modalOpen: true }), null);
  assert.equal(press({ key: "Enter", ctrlKey: true }, { transferVisible: true }), "generate");
  assert.equal(press({ key: "Enter", ctrlKey: true }, { transferVisible: false }), null);
  assert.equal(press({ key: "/", isComposing: true }, {}), null);
});

test("recent lists keep the newest first, deduplicated and bounded", () => {
  assert.deepEqual(ux.pushRecent(["a", "b"], "b"), ["b", "a"]);
  assert.deepEqual(ux.pushRecent(["a"], "  "), ["a"]);
  assert.equal(ux.pushRecent(["1", "2", "3", "4", "5", "6"], "7").length, 5);
});

test("transfer history exposes the duplicate fields and the dedicated endpoint", () => {
  assert.equal(history.ENDPOINT, "/api/historico-transferencias");
  const values = Object.fromEntries(history.duplicateValues({ entrega_contato: "Ana", entrega_obs: "Obs" }));
  assert.equal(values["entrega-contato"], "Ana");
  assert.equal(values["entrega-obs"], "Obs");
  assert.equal(values["entrega-email"], "");
  assert.doesNotMatch(appScript, /\/api\/transferencias/);
});

test("history button, history modal and confirmation modal exist with accessible hooks", () => {
  for (const id of ["btn-historico-transferencias", "modal-historico-transferencias", "filtro-historico-transferencias",
    "lista-historico-transferencias", "modal-confirmar-acao", "btn-confirmar-acao-ok", "btn-confirmar-acao-cancelar"]) {
    assert.match(appHtml, new RegExp(`id="${id}"`), id);
  }
});
