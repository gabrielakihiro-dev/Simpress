const assert = require("node:assert/strict");
const test = require("node:test");
const phoneFormatCases = require("./fixtures/phone_format_cases.json");
const {
  createRequestGate,
  formatBrazilPhone,
  isCurrentQuery,
  serialForTransfer,
} = require("../static/transfer-utils.js");

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
