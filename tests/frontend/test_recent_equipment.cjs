const assert = require("node:assert/strict");
const test = require("node:test");
const recent = require("../../static/js/shared/recent-equipment.js");

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

const equipment = (serial, extra = {}) => ({ serial, apelido: `AP-${serial}`, retirada_cidade: "Curitiba", ...extra });

test("keeps only series, alias and city, newest first", () => {
  const list = recent.pushRecentEquipment([], equipment(" abc123 ", { apelido: "AP-abc123", modelo: "HP", retirada_cnpj: "1" }));
  assert.deepEqual(list, [{ serial: "ABC123", apelido: "AP-abc123", cidade: "Curitiba" }]);
  const next = recent.pushRecentEquipment(list, equipment("XYZ"));
  assert.deepEqual(next.map(item => item.serial), ["XYZ", "ABC123"]);
});

test("a repeated series moves to the top with its newest data and no duplicate", () => {
  let list = ["A", "B", "C"].reduce((acc, serial) => recent.pushRecentEquipment(acc, equipment(serial)), []);
  list = recent.pushRecentEquipment(list, equipment("a", { apelido: "NOVO", retirada_cidade: "Londrina" }));
  assert.deepEqual(list.map(item => item.serial), ["A", "C", "B"]);
  assert.deepEqual(list[0], { serial: "A", apelido: "NOVO", cidade: "Londrina" });
});

test("never keeps more than five entries", () => {
  const list = ["1", "2", "3", "4", "5", "6", "7"].reduce((acc, serial) => recent.pushRecentEquipment(acc, equipment(serial)), []);
  assert.equal(recent.LIMIT, 5);
  assert.deepEqual(list.map(item => item.serial), ["7", "6", "5", "4", "3"]);
});

test("ignores entries without a series and cleans corrupted stored lists", () => {
  assert.deepEqual(recent.pushRecentEquipment([{ serial: "A" }], { serial: "  " }), [{ serial: "A", apelido: "", cidade: "" }]);
  const storage = memoryStorage({ [recent.STORAGE_KEY]: JSON.stringify([null, 3, { serial: "b" }, { serial: "B" }, "x"]) });
  assert.deepEqual(recent.createStore(() => storage).read(), [{ serial: "B", apelido: "", cidade: "" }]);
  storage.setItem(recent.STORAGE_KEY, "{não é json");
  assert.deepEqual(recent.createStore(() => storage).read(), []);
});

test("store persists in localStorage and clear removes the key", () => {
  const storage = memoryStorage();
  const store = recent.createStore(() => storage);
  store.add(equipment("A"));
  store.add(equipment("B"));
  store.add(equipment("A"));
  assert.deepEqual(JSON.parse(storage.getItem(recent.STORAGE_KEY)).map(item => item.serial), ["A", "B"]);
  assert.deepEqual(recent.createStore(() => storage).read().map(item => item.serial), ["A", "B"]);
  assert.deepEqual(store.clear(), []);
  assert.equal(storage.getItem(recent.STORAGE_KEY), null);
  assert.deepEqual(store.read(), []);
});

test("works in memory when storage is missing or throws", () => {
  for (const getStorage of [
    () => null,
    () => { throw new Error("SecurityError"); },
    () => ({ getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } }),
  ]) {
    const store = recent.createStore(getStorage);
    assert.deepEqual(store.read(), []);
    assert.deepEqual(store.add(equipment("A")).map(item => item.serial), ["A"]);
    assert.deepEqual(store.add(equipment("B")).map(item => item.serial), ["B", "A"]);
    assert.deepEqual(store.read().map(item => item.serial), ["B", "A"]);
    assert.deepEqual(store.clear(), []);
    assert.deepEqual(store.read(), []);
  }
});

test("accessible name starts with the visible series and names alias and city", () => {
  assert.equal(
    recent.describeEntry({ serial: "LENTO", apelido: "DEMO-001", cidade: "Curitiba" }),
    "LENTO, apelido DEMO-001, cidade Curitiba. Abrir resultado",
  );
  assert.equal(recent.describeEntry({ serial: "X", apelido: "", cidade: "" }), "X, sem apelido, cidade não informada. Abrir resultado");
});
