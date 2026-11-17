const assert = require("node:assert/strict");
const test = require("node:test");
const apiErrors = require("../../frontend/src/legado/shared/api-errors.js");
const { apiFetch } = require("../../frontend/src/legado/shared/api-fetch.js");

test("API error formatter extracts readable Pydantic validation messages", () => {
  const error = apiErrors.create([
    { type: "string_pattern_mismatch", loc: ["body", "cep"], msg: "String should match pattern" },
    { type: "value_error", loc: ["body", "cnpj"], msg: "Invalid CNPJ" },
  ], "Request failed");
  assert.equal(error.message, "String should match pattern; Invalid CNPJ");
});

test("API error formatter uses a safe fallback for opaque details", () => {
  assert.equal(apiErrors.create({ code: "invalid" }, "Request failed").message, "Request failed");
});

// O caso "unit save surfaces a readable validation message" foi para tests/e2e/react-g2.spec.cjs
// (salvarUnidadeForm agora é React: frontend/src/paineis/unidades/acoes.ts).
