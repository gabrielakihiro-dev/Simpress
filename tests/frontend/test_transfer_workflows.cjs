const assert = require("node:assert/strict");
const test = require("node:test");
const phoneFormatCases = require("../fixtures/phone_format_cases.json");
const {
  createRequestGate,
  formatBrazilPhone,
  isCurrentQuery,
  refreshSelectionAfterInventoryReplacement,
  serialForTransfer,
} = require("../../static/js/shared/transfer-utils.js");

test("formats fixed and mobile Brazilian phone numbers with country prefixes", () => {
  for (const [phone, expected] of phoneFormatCases) {
    assert.equal(formatBrazilPhone(phone), expected);
  }
});

test("a partial typed query cannot become a transfer serial", () => {
  const selected = { serial: "SERIE-ABC-001" };
  assert.equal(serialForTransfer(selected, "ABC"), "");
  assert.equal(serialForTransfer(selected, "SERIE-ABC-001"), "SERIE-ABC-001");
  assert.equal(serialForTransfer(selected, " serie-abc-001 "), "SERIE-ABC-001");
  assert.equal(serialForTransfer(null, "SERIE-ABC-001"), "");
});

test("a response is ignored after the user changes the search text", () => {
  const gate = createRequestGate();
  const request = gate.begin();

  assert.equal(isCurrentQuery(gate, request.id, "MODELO NOVO", "MODELO ANTIGO"), false);
  assert.equal(isCurrentQuery(gate, request.id, " modelo antigo ", "MODELO ANTIGO"), true);

  gate.invalidate();
  assert.equal(isCurrentQuery(gate, request.id, "MODELO ANTIGO", "MODELO ANTIGO"), false);
});

test("out-of-order searches only apply the latest response", async () => {
  const gate = createRequestGate();
  const first = gate.begin();
  let resolveFirst;
  const firstResult = new Promise(resolve => { resolveFirst = resolve; });
  const applied = [];
  const applyFirst = firstResult.then(result => {
    if (gate.isCurrent(first.id)) applied.push(result);
  });

  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  if (gate.isCurrent(second.id)) applied.push("resposta atual");
  resolveFirst("resposta antiga");
  await applyFirst;

  assert.deepEqual(applied, ["resposta atual"]);
});

test("clearing a field invalidates and aborts an in-flight search", () => {
  const gate = createRequestGate();
  const pending = gate.begin();

  gate.invalidate();

  assert.equal(pending.signal.aborted, true);
  assert.equal(gate.isCurrent(pending.id), false);
});

test("replacing inventories clears a removed selection and blocks transfer validation", async () => {
  const equipmentGate = createRequestGate();
  const autocompleteGate = createRequestGate();
  const oldSearch = equipmentGate.begin();
  const oldAutocomplete = autocompleteGate.begin();
  let resolveOldSearch;
  const oldSearchResult = new Promise(resolve => { resolveOldSearch = resolve; });
  const appliedSearchResults = [];
  const oldSearchApply = oldSearchResult.then(equipment => {
    if (equipmentGate.isCurrent(oldSearch.id)) appliedSearchResults.push(equipment);
  });
  const state = {
    equipment: { serial: "SERIE-REMOVIDA", modelo: "Modelo antigo" },
    serialInput: "SERIE-REMOVIDA",
    originCity: "Maringá",
    originAddress: "Rua antiga",
    preview: "Resumo antigo",
  };

  const result = await refreshSelectionAfterInventoryReplacement({
    requestGate: equipmentGate,
    serial: state.equipment.serial,
    invalidateSearches: () => {
      equipmentGate.invalidate();
      autocompleteGate.invalidate();
    },
    clearSelection: clearSerial => {
      state.equipment = null;
      state.originCity = "";
      state.originAddress = "";
      state.preview = "";
      if (clearSerial) state.serialInput = "";
    },
    fetchEquipment: async (serial, options) => {
      assert.equal(serial, "SERIE-REMOVIDA");
      assert.equal(options.signal.aborted, false);
      return { ok: false, status: 404 };
    },
    applyEquipment: equipment => { state.equipment = equipment; },
  });

  resolveOldSearch({ serial: "SERIE-REMOVIDA", modelo: "Resultado antigo" });
  await oldSearchApply;
  assert.equal(result, "missing");
  assert.equal(oldSearch.signal.aborted, true);
  assert.equal(oldAutocomplete.signal.aborted, true);
  assert.deepEqual(appliedSearchResults, []);
  assert.equal(state.equipment, null);
  assert.equal(state.serialInput, "");
  assert.equal(state.originCity, "");
  assert.equal(state.originAddress, "");
  assert.equal(state.preview, "");
  assert.equal(serialForTransfer(state.equipment, state.serialInput), "");
});

test("inventory replacement refreshes a still-existing selection with current equipment", async () => {
  const requestGate = createRequestGate();
  const state = { equipment: { serial: "SERIE-ATUALIZADA", modelo: "Modelo antigo" }, origin: "Origem antiga" };
  const refreshedEquipment = { serial: "SERIE-ATUALIZADA", modelo: "Modelo novo", retirada_cidade: "Curitiba" };
  let clears = 0;

  const result = await refreshSelectionAfterInventoryReplacement({
    requestGate,
    serial: state.equipment.serial,
    invalidateSearches: () => requestGate.invalidate(),
    clearSelection: () => {
      clears += 1;
      state.equipment = null;
      state.origin = "";
    },
    fetchEquipment: async () => ({ ok: true, status: 200, json: async () => refreshedEquipment }),
    applyEquipment: equipment => {
      state.equipment = equipment;
      state.origin = equipment.retirada_cidade;
    },
  });

  assert.equal(result, "updated");
  assert.equal(clears, 1);
  assert.equal(state.equipment, refreshedEquipment);
  assert.equal(state.origin, "Curitiba");
  assert.equal(serialForTransfer(state.equipment, "SERIE-ATUALIZADA"), "SERIE-ATUALIZADA");
});

test("a late inventory refresh cannot overwrite a newer equipment search", async () => {
  const requestGate = createRequestGate();
  const state = { equipment: { serial: "SERIE-ANTIGA" } };
  let resolveRefresh;
  let applied = 0;
  const refresh = refreshSelectionAfterInventoryReplacement({
    requestGate,
    serial: state.equipment.serial,
    invalidateSearches: () => requestGate.invalidate(),
    clearSelection: () => { state.equipment = null; },
    fetchEquipment: () => new Promise(resolve => { resolveRefresh = resolve; }),
    applyEquipment: equipment => {
      applied += 1;
      state.equipment = equipment;
    },
  });

  const newerSearch = requestGate.begin();
  state.equipment = { serial: "SERIE-NOVA", modelo: "Resultado novo" };
  resolveRefresh({
    ok: true,
    status: 200,
    json: async () => ({ serial: "SERIE-ANTIGA", modelo: "Resposta atrasada" }),
  });

  assert.equal(await refresh, "stale");
  assert.equal(newerSearch.signal.aborted, false);
  assert.equal(applied, 0);
  assert.equal(state.equipment.serial, "SERIE-NOVA");
});
