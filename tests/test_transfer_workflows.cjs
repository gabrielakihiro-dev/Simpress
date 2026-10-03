const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createRequestGate,
  formatBrazilPhone,
  isCurrentQuery,
  serialForTransfer,
} = require("../static/transfer-utils.js");

test("formats fixed and mobile Brazilian phone numbers with country prefixes", () => {
  const cases = [
    ["4133334444", "(41) 3333-4444"],
    ["+55 41 3333-4444", "(41) 3333-4444"],
    ["00554133334444", "(41) 3333-4444"],
    ["554133334444", "(41) 3333-4444"],
    ["41999998888", "(41) 99999-8888"],
    ["+55 41 99999-8888", "(41) 99999-8888"],
    ["005541999998888", "(41) 99999-8888"],
    ["(41) 3333-4444 ramal 27", "(41) 3333-4444 Ramal: 27"],
  ];

  for (const [phone, expected] of cases) assert.equal(formatBrazilPhone(phone), expected);
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
