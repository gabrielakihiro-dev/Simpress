const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_RETRY_DELAYS_MS,
  isRetryableError,
  requestWithRetries,
} = require("../static/history-annotation-autosave.js");

const successResponse = { ok: true, status: 200, json: async () => ({ sucesso: true }) };
const errorResponse = status => ({
  ok: false,
  status,
  json: async () => ({ detail: `HTTP ${status}` }),
});

test("retries network failures and waits with bounded backoff", async () => {
  let calls = 0;
  const waits = [];
  const result = await requestWithRetries(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError("network error");
    return successResponse;
  }, {
    sleep: async delay => waits.push(delay),
    onRetry: () => {},
  });

  assert.equal(result.response, successResponse);
  assert.equal(calls, 3);
  assert.deepEqual(waits, DEFAULT_RETRY_DELAYS_MS.slice(0, 2));
});

test("retries temporary HTTP failures including rate limits", async () => {
  let calls = 0;
  const waits = [];
  const result = await requestWithRetries(async () => {
    calls += 1;
    return calls === 1 ? errorResponse(503) : calls === 2 ? errorResponse(429) : successResponse;
  }, { sleep: async delay => waits.push(delay) });

  assert.equal(result.stale, false);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test("does not retry permanent client errors or aborted requests", async () => {
  let calls = 0;
  await assert.rejects(requestWithRetries(async () => {
    calls += 1;
    return errorResponse(400);
  }, { sleep: async () => {} }), /HTTP 400/);
  assert.equal(calls, 1);

  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  assert.equal(isRetryableError(aborted), false);
});

test("stops after the configured maximum number of retries", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(requestWithRetries(async () => {
    calls += 1;
    return errorResponse(503);
  }, { sleep: async delay => waits.push(delay) }), /HTTP 503/);

  assert.equal(calls, DEFAULT_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(waits, [...DEFAULT_RETRY_DELAYS_MS]);
});

test("abandons a stale annotation instead of retrying its old text", async () => {
  let calls = 0;
  let current = true;
  const result = await requestWithRetries(async () => {
    calls += 1;
    return errorResponse(503);
  }, {
    isCurrent: () => current,
    sleep: async () => { current = false; },
  });

  assert.deepEqual(result, { stale: true });
  assert.equal(calls, 1);
});

test("does not retry a value that became stale while a request was in flight", async () => {
  let calls = 0;
  let current = true;
  const result = await requestWithRetries(async () => {
    calls += 1;
    current = false;
    return successResponse;
  }, { isCurrent: () => current, sleep: async () => {} });

  assert.deepEqual(result, { stale: true });
  assert.equal(calls, 1);
});
