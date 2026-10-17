const assert = require("node:assert/strict");
const test = require("node:test");
const apiErrors = require("../../static/js/shared/api-errors.js");
const createUnitsCatalog = require("../../static/js/features/units-catalog.js");

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

test("unit save surfaces a readable validation message instead of [object Object]", async t => {
  const originals = { document: global.document, fetch: global.fetch, consoleError: console.error };
  t.after(() => {
    global.document = originals.document;
    global.fetch = originals.fetch;
    console.error = originals.consoleError;
  });

  const values = {
    "form-unidade-cidade": "Curitiba",
    "form-unidade-endereco": "Rua Exemplo, 10",
    "form-unidade-cep": "00000",
    "form-unidade-cnpj": "123",
    "form-unidade-id": "",
  };
  global.document = { getElementById: id => ({ value: values[id] || "" }) };
  global.fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ detail: [{ loc: ["body", "cep"], msg: "CEP deve conter 8 dígitos." }] }),
  });
  console.error = () => {};

  const messages = [];
  const app = {
    createApiError: apiErrors.create,
    showToast: (message, level) => messages.push({ message, level }),
  };
  const feature = createUnitsCatalog({
    app,
    appState: { unidadesList: [] },
    catalogSearch: {},
    dom: { escapeHtml: String, pluralize: () => "unidades" },
  });
  await feature.salvarUnidadeForm();
  assert.deepEqual(messages, [{ message: "CEP deve conter 8 dígitos.", level: "error" }]);
});
