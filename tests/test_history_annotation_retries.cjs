const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_RETRY_DELAYS_MS,
  attachAnnotationAutosave,
  getErrorMessage,
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

test("formats structured API validation details as readable text", () => {
  assert.equal(
    getErrorMessage([
      { msg: "E-mail inválido." },
      { msg: "Telefone inválido." },
    ]),
    "E-mail inválido. Telefone inválido."
  );
  assert.equal(getErrorMessage("Não autorizado."), "Não autorizado.");
  assert.equal(getErrorMessage([]), "Não foi possível salvar a anotação.");
});

function createAutosaveHarness(send) {
  const timers = new Map();
  let nextTimerId = 0;
  const windowObject = new EventTarget();
  windowObject.setTimeout = callback => {
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  };
  windowObject.clearTimeout = id => timers.delete(id);
  const storageValues = new Map();
  const storage = {
    getItem: key => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: (key, value) => storageValues.set(key, value),
    removeItem: key => storageValues.delete(key),
  };
  class Control extends EventTarget {
    constructor() {
      super();
      this.value = "";
      this.textContent = "";
      this.className = "";
      this.hidden = true;
      this.disabled = false;
      this.dataset = {};
    }
  }
  const textarea = new Control();
  const status = new Control();
  const retryButton = new Control();
  const controller = attachAnnotationAutosave({
    textarea,
    status,
    retryButton,
    eventId: "event-" + String(Math.random()),
    itemId: "review-item",
    send,
    retryOptions: { sleep: async () => {} },
    storage,
    windowObject,
  });
  return {
    controller,
    retryButton,
    status,
    storageValues,
    textarea,
    windowObject,
    async flushTimers() {
      while (timers.size) {
        const [id, callback] = timers.entries().next().value;
        timers.delete(id);
        callback();
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  };
}

test("keeps a failed annotation, warns before leaving, and exposes a retry button", async () => {
  let calls = 0;
  const harness = createAutosaveHarness(async () => {
    calls += 1;
    return calls < 5 ? errorResponse(503) : successResponse;
  });
  harness.textarea.value = "Anotação que precisa ser salva";
  harness.textarea.dispatchEvent(new Event("input"));
  await harness.flushTimers();

  assert.equal(calls, DEFAULT_RETRY_DELAYS_MS.length + 1);
  assert.equal(harness.retryButton.hidden, false);
  assert.equal(harness.textarea.dataset.annotationPending, "true");
  assert.equal(harness.storageValues.size, 1);
  const blockedExit = new Event("beforeunload", { cancelable: true });
  harness.windowObject.dispatchEvent(blockedExit);
  assert.equal(blockedExit.defaultPrevented, true);

  harness.retryButton.dispatchEvent(new Event("click"));
  await harness.flushTimers();
  assert.equal(calls, DEFAULT_RETRY_DELAYS_MS.length + 2);
  assert.equal(harness.retryButton.hidden, true);
  assert.equal(harness.textarea.dataset.annotationPending, "false");
  assert.equal(harness.storageValues.size, 0);
  const allowedExit = new Event("beforeunload", { cancelable: true });
  harness.windowObject.dispatchEvent(allowedExit);
  assert.equal(allowedExit.defaultPrevented, false);
  harness.controller.dispose();
});

test("clears pending state when an in-flight annotation finishes on its original text", async () => {
  let resolveSend;
  const harness = createAutosaveHarness(() => new Promise(resolve => { resolveSend = resolve; }));
  harness.textarea.value = "Texto que voltou ao original";
  harness.textarea.dispatchEvent(new Event("input"));
  await harness.flushTimers();

  harness.textarea.value = "Texto temporariamente diferente";
  harness.textarea.dispatchEvent(new Event("input"));
  harness.textarea.value = "Texto que voltou ao original";
  harness.textarea.dispatchEvent(new Event("input"));
  resolveSend(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  await harness.flushTimers();

  assert.equal(harness.textarea.dataset.annotationPending, "false");
  assert.equal(harness.storageValues.size, 0);
  assert.equal(harness.status.textContent, "Salvo automaticamente");
  harness.controller.dispose();
});

test("recovers a saved local draft when the comparison is opened again", async () => {
  const storageValues = new Map();
  let calls = 0;
  const setup = send => {
    const timers = new Map();
    const windowObject = new EventTarget();
    let timerId = 0;
    windowObject.setTimeout = callback => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    };
    windowObject.clearTimeout = id => timers.delete(id);
    class Control extends EventTarget {
      constructor() { super(); this.value = ""; this.dataset = {}; this.textContent = ""; this.className = ""; this.hidden = true; this.disabled = false; }
    }
    const storage = {
      getItem: key => storageValues.has(key) ? storageValues.get(key) : null,
      setItem: (key, value) => storageValues.set(key, value),
      removeItem: key => storageValues.delete(key),
    };
    const textarea = new Control();
    const status = new Control();
    const retryButton = new Control();
    const controller = attachAnnotationAutosave({
      textarea,
      status,
      retryButton,
      eventId: "reopened-event",
      itemId: "reopened-item",
      send,
      retryOptions: { sleep: async () => {} },
      storage,
      windowObject,
    });
    return { controller, textarea, status, timers };
  };

  const failed = setup(async () => errorResponse(503));
  failed.textarea.value = "Rascunho local recuperável";
  failed.textarea.dispatchEvent(new Event("input"));
  while (failed.timers.size) {
    const [id, callback] = failed.timers.entries().next().value;
    failed.timers.delete(id);
    callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  failed.controller.dispose();

  const restored = setup(async () => {
    calls += 1;
    return successResponse;
  });
  assert.equal(restored.textarea.value, "Rascunho local recuperável");
  assert.equal(restored.textarea.dataset.annotationPending, "true");
  assert.match(restored.status.textContent, /Rascunho recuperado/);
  while (restored.timers.size) {
    const [id, callback] = restored.timers.entries().next().value;
    restored.timers.delete(id);
    callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(calls, 1);
  assert.equal(restored.textarea.dataset.annotationPending, "false");
  assert.equal(storageValues.size, 0);
  restored.controller.dispose();
});
