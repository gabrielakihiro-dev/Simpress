const assert = require("node:assert/strict");
const test = require("node:test");
const { apiFetch } = require("../../static/js/shared/api-fetch.js");

function jsonResponse(body, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(t, implementation) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return implementation(...args);
  };
  t.after(() => { global.fetch = original; });
  return calls;
}

test("returns the parsed JSON body and forwards the fetch options", async t => {
  const calls = mockFetch(t, async () => jsonResponse({ total: 3 }));
  const headers = { "Content-Type": "application/json", "Idempotency-Key": "chave-1" };
  const data = await apiFetch("/api/exemplo", { method: "POST", headers, body: "{}", errorMessage: "Falhou." });
  assert.deepEqual(data, { total: 3 });
  assert.equal(calls[0][0], "/api/exemplo");
  assert.deepEqual(calls[0][1], { method: "POST", headers, body: "{}" });
});

test("text detail becomes the error message with status and raw detail", async t => {
  mockFetch(t, async () => jsonResponse({ detail: "Unidade já cadastrada." }, 409));
  await assert.rejects(apiFetch("/api/unidade/salvar", { errorMessage: "Erro ao salvar unidade." }), error => {
    assert.equal(error.message, "Unidade já cadastrada.");
    assert.equal(error.status, 409);
    assert.equal(error.detail, "Unidade já cadastrada.");
    return true;
  });
});

test("Pydantic 422 list becomes a readable message instead of [object Object]", async t => {
  const detail = [
    { type: "string_pattern_mismatch", loc: ["body", "cep"], msg: "CEP deve conter 8 dígitos." },
    { type: "value_error", loc: ["body", "cnpj"], msg: "CNPJ inválido." },
  ];
  mockFetch(t, async () => jsonResponse({ detail }, 422));
  await assert.rejects(apiFetch("/api/unidade/salvar", { errorMessage: "Erro ao salvar unidade." }), error => {
    assert.equal(error.message, "CEP deve conter 8 dígitos.; CNPJ inválido.");
    assert.doesNotMatch(error.message, /\[object Object\]/);
    assert.equal(error.status, 422);
    assert.deepEqual(error.detail, detail);
    return true;
  });
});

test("empty or non-JSON error bodies fall back to the given message", async t => {
  const bodies = [null, "", "<html>Internal Server Error</html>"];
  for (const body of bodies) {
    mockFetch(t, async () => new Response(body, { status: 500 }));
    await assert.rejects(apiFetch("/api/stats", { errorMessage: "Falha ao consultar." }), error => {
      assert.equal(error.message, "Falha ao consultar.");
      assert.equal(error.status, 500);
      assert.equal(error.detail, undefined);
      return true;
    });
  }
});

test("empty successful body resolves to an empty object", async t => {
  mockFetch(t, async () => new Response(null, { status: 204 }));
  assert.deepEqual(await apiFetch("/api/historico-comparacoes/1", { method: "DELETE" }), {});
});

test("uses a default message when the caller gives none", async t => {
  mockFetch(t, async () => new Response("", { status: 503 }));
  await assert.rejects(apiFetch("/api/stats"), { message: "Não foi possível concluir a solicitação.", status: 503 });
});

test("responseType response returns the unread Response for downloads", async t => {
  mockFetch(t, async () => new Response("xlsx", {
    status: 200,
    headers: { "Content-Disposition": 'attachment; filename="arquivo.xlsx"' },
  }));
  const response = await apiFetch("/api/exportar-equipamentos", { responseType: "response" });
  assert.equal(response.headers.get("Content-Disposition"), 'attachment; filename="arquivo.xlsx"');
  assert.equal(await (await response.blob()).text(), "xlsx");
});

test("responseType response still turns HTTP failures into readable errors", async t => {
  mockFetch(t, async () => jsonResponse({ detail: [{ msg: "Data inválida." }] }, 422));
  await assert.rejects(
    apiFetch("/api/historico-comparacoes/exportar/excel", { responseType: "response", errorMessage: "Falhou." }),
    { message: "Data inválida.", status: 422 },
  );
});

test("AbortSignal is forwarded and cancellation rejects with AbortError", async t => {
  const calls = mockFetch(t, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = apiFetch("/api/buscar-expandida?q=ABC", { signal: controller.signal, errorMessage: "Falhou." });
  controller.abort();
  await assert.rejects(pending, error => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.status, undefined);
    return true;
  });
  assert.equal(calls[0][1].signal, controller.signal);
  assert.equal("errorMessage" in calls[0][1], false);
});

test("cancellation while reading the body is not swallowed as an empty body", async t => {
  mockFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new DOMException("The operation was aborted.", "AbortError"); },
  }));
  await assert.rejects(apiFetch("/api/operacoes/chamados"), { name: "AbortError" });
});

test("network failures propagate unchanged without an HTTP status", async t => {
  mockFetch(t, async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(apiFetch("/api/unidades"), error => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.status, undefined);
    return true;
  });
});
