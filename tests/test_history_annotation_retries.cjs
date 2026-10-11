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

test("annotation autosave defaults to the module root when no window object is supplied", () => {
  class Control extends EventTarget {
    constructor() {
      super();
      this.value = "";
      this.dataset = {};
      this.textContent = "";
      this.className = "";
      this.hidden = true;
      this.disabled = false;
    }
  }

  const controller = attachAnnotationAutosave({
    textarea: new Control(),
    status: new Control(),
    retryButton: new Control(),
    eventId: "module-root-event",
    itemId: "module-root-item",
    send: async () => successResponse,
  });
  assert.doesNotThrow(() => controller.dispose());
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

function createAutosaveHarness(send, options = {}) {
  const timers = new Map();
  let nextTimerId = 0;
  const windowObject = new EventTarget();
  const delays = [];
  windowObject.setTimeout = (callback, delay) => {
    delays.push(delay);
    const id = ++nextTimerId;
    timers.set(id, callback);
    return id;
  };
  windowObject.clearTimeout = id => timers.delete(id);
  const storageValues = options.storageValues || new Map();
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
  if (options.version) textarea.dataset.annotationVersion = JSON.stringify(options.version);
  const status = new Control();
  const retryButton = new Control();
  const controller = attachAnnotationAutosave({
    textarea,
    status,
    retryButton,
    eventId: options.eventId || "event-" + String(Math.random()),
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
    timers,
    delays,
    async flushTimers() {
      let flushed = 0;
      while (timers.size) {
        assert.ok(++flushed < 50, "autosave must not loop indefinitely");
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

for (const outcome of ["network failure", "success"]) test(`A -> B -> A requires a current acknowledgement after stale ${outcome}`, async () => {
  const requests = [];
  const harness = createAutosaveHarness(() => new Promise((resolve, reject) => { requests.push({ resolve, reject }); }));
  harness.textarea.value = "Texto que voltou ao original";
  harness.textarea.dispatchEvent(new Event("input"));
  await harness.flushTimers();

  harness.textarea.value = "Texto temporariamente diferente";
  harness.textarea.dispatchEvent(new Event("input"));
  harness.textarea.value = "Texto que voltou ao original";
  harness.textarea.dispatchEvent(new Event("input"));
  // Let the debounce expire while the original request is still in flight.
  await harness.flushTimers();
  if (outcome === "network failure") requests[0].reject(new TypeError("offline"));
  else requests[0].resolve(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.textarea.dataset.annotationPending, "true");
  assert.equal([...harness.storageValues.values()][0], "Texto que voltou ao original");
  assert.doesNotMatch(harness.status.textContent, /Salvo/);
  await harness.flushTimers();
  assert.equal(requests.length, 2);
  assert.equal(harness.storageValues.size, 1);
  requests[1].resolve(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.textarea.dataset.annotationPending, "false");
  assert.equal(harness.storageValues.size, 0);
  assert.equal(harness.status.textContent, "Salvo automaticamente");
  harness.controller.dispose();
});

test("an edit during acknowledgement parsing survives and is sent next", async () => {
  let finishBody;
  const sent = [];
  const h = createAutosaveHarness(async payload => {
    sent.push(payload.annotation);
    return sent.length === 1
      ? { ok: true, json: () => new Promise(resolve => { finishBody = resolve; }) }
      : successResponse;
  });
  h.textarea.value = "A";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  h.textarea.value = "B";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  finishBody({ sucesso: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...h.storageValues.values()][0], "B");
  assert.equal(h.textarea.dataset.annotationPending, "true");
  await h.flushTimers();
  assert.deepEqual(sent, ["A", "B"]);
  assert.equal(h.storageValues.size, 0);
  h.controller.dispose();
});

test("input debounces for 500 ms and blur flushes the current edit immediately", async () => {
  let calls = 0;
  const h = createAutosaveHarness(async () => { calls++; return successResponse; });
  h.textarea.value = "A";
  h.textarea.dispatchEvent(new Event("input"));
  h.textarea.value = "B";
  h.textarea.dispatchEvent(new Event("input"));
  assert.equal(calls, 0);
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.delays, [500, 500]);
  h.textarea.dispatchEvent(new Event("blur"));
  assert.equal(h.delays.at(-1), 0);
  assert.equal(h.timers.size, 1);
  await h.flushTimers();
  assert.equal(calls, 1);
  assert.equal(h.storageValues.size, 0);
  h.controller.dispose();
});

test("a stale successful revision becomes a base, never a confirmation of A -> B -> A", async () => {
  const requests = [];
  const h = createAutosaveHarness(payload => new Promise(resolve => { requests.push({ payload, resolve }); }), {
    version: { anotacao_revisoes: ["a".repeat(32)] },
  });
  h.textarea.value = "A";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  h.textarea.value = "B";
  h.textarea.dispatchEvent(new Event("input"));
  h.textarea.value = "A";
  h.textarea.dispatchEvent(new Event("input"));
  requests[0].resolve({ ok: true, json: async () => ({ anotacao_revisoes: [requests[0].payload.revisionId] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.textarea.dataset.annotationPending, "true");
  await h.flushTimers();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].payload.baseRevisions, [requests[0].payload.revisionId]);
  assert.notEqual(requests[1].payload.revisionId, requests[0].payload.revisionId);
  assert.equal(JSON.parse([...h.storageValues.values()][0]).text, "A");
  requests[1].resolve({ ok: true, json: async () => ({ anotacao_revisoes: [requests[1].payload.revisionId] }) });
  await new Promise(resolve => setImmediate(resolve));
  await h.flushTimers();
  assert.equal(requests.length, 2);
  assert.equal(h.storageValues.size, 0);
  h.controller.dispose();
});

test("an older field cannot clear a newer pending draft or its navigation guard", async () => {
  const options = { eventId: "shared-pending", storageValues: new Map() };
  let finishOld, finishNew;
  const first = createAutosaveHarness(() => new Promise(resolve => { finishOld = resolve; }), options);
  const second = createAutosaveHarness(() => new Promise(resolve => { finishNew = resolve; }), options);
  first.textarea.value = "A";
  first.textarea.dispatchEvent(new Event("input"));
  await first.flushTimers();
  second.textarea.value = "B";
  second.textarea.dispatchEvent(new Event("input"));
  await second.flushTimers();
  finishOld(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...second.storageValues.values()][0], "B");
  assert.equal(second.textarea.dataset.annotationPending, "true");
  const blocked = new Event("beforeunload", { cancelable: true });
  second.windowObject.dispatchEvent(blocked);
  assert.equal(blocked.defaultPrevented, true);
  finishNew(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.storageValues.size, 0);
  const allowed = new Event("beforeunload", { cancelable: true });
  second.windowObject.dispatchEvent(allowed);
  assert.equal(allowed.defaultPrevented, false);
  first.controller.dispose();
  second.controller.dispose();
});

test("HTTP 409 preserves the draft with no automatic resend loop and permits a manual retry", async () => {
  let calls = 0;
  const h = createAutosaveHarness(async () => ++calls === 1 ? errorResponse(409) : successResponse);
  h.textarea.value = "Preservar";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  assert.equal(calls, 1);
  assert.equal(h.status.textContent, "HTTP 409");
  assert.equal(h.storageValues.size, 1);
  assert.equal(h.retryButton.hidden, false);
  assert.equal(h.timers.size, 0);
  h.retryButton.dispatchEvent(new Event("click"));
  await h.flushTimers();
  assert.equal(calls, 2);
  assert.equal(h.storageValues.size, 0);
  h.controller.dispose();
});

for (const invalid of ["malformed JSON", "empty acknowledgement", "explicit failure", "wrong revision", "conflict without revisions"]) {
  test(`${invalid} never confirms a versioned save and retries remain bounded`, async () => {
    const sent = [];
    let recovered = false;
    const h = createAutosaveHarness(async payload => {
      sent.push(payload);
      return {
        ok: true,
        json: async () => {
          if (recovered) return { anotacao_revisoes: [payload.revisionId] };
          if (invalid === "malformed JSON") throw new SyntaxError("invalid JSON");
          if (invalid === "explicit failure") return { sucesso: false, anotacao_revisoes: [payload.revisionId] };
          if (invalid === "wrong revision") return { sucesso: true, anotacao_revisoes: ["f".repeat(32)] };
          if (invalid === "conflict without revisions") return { sucesso: true, anotacao_conflito: true };
          return {};
        },
      };
    }, { version: { anotacao_revisoes: [] } });
    h.textarea.value = "Preservar";
    h.textarea.dispatchEvent(new Event("input"));
    await h.flushTimers();
    assert.equal(sent.length, 4);
    assert.equal(new Set(sent.map(p => p.revisionId)).size, 1);
    assert.equal(h.textarea.dataset.annotationPending, "true");
    assert.equal(h.storageValues.size, 1);
    assert.equal(h.retryButton.hidden, false);
    assert.equal(h.timers.size, 0);
    recovered = true;
    h.retryButton.dispatchEvent(new Event("click"));
    await h.flushTimers();
    assert.equal(sent.length, 5);
    assert.equal(new Set(sent.map(p => p.revisionId)).size, 1);
    assert.equal(h.storageValues.size, 0);
    h.controller.dispose();
  });
}

test("an invalid stale acknowledgement cannot become a causal base for the latest edit", async () => {
  let finish;
  const sent = [];
  const h = createAutosaveHarness(payload => {
    sent.push(payload);
    return sent.length === 1
      ? new Promise(resolve => { finish = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ anotacao_revisoes: [payload.revisionId] }) });
  }, { version: { anotacao_revisoes: ["a".repeat(32)] } });
  h.textarea.value = "A";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  h.textarea.value = "B";
  h.textarea.dispatchEvent(new Event("input"));
  finish({ ok: true, json: async () => ({ sucesso: false, anotacao_revisoes: ["f".repeat(32)] }) });
  await new Promise(resolve => setImmediate(resolve));
  await h.flushTimers();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].baseRevisions, ["a".repeat(32)]);
  assert.equal(h.storageValues.size, 0);
  h.controller.dispose();
});

for (const outcome of ["success", "failure"]) test(`a late ${outcome} from another field cannot overwrite the current field`, async () => {
  const options = { eventId: "shared-" + outcome, storageValues: new Map(), version: { anotacao_revisoes: [] } };
  let finishOld;
  let finishNew;
  const first = createAutosaveHarness(() => new Promise((resolve, reject) => { finishOld = { resolve, reject }; }), options);
  first.textarea.value = "A";
  first.textarea.dispatchEvent(new Event("input"));
  await first.flushTimers();
  const second = createAutosaveHarness(payload => new Promise(resolve => {
    finishNew = () => resolve({ ok: true, json: async () => ({ anotacao_revisoes: [payload.revisionId] }) });
  }), options);
  second.textarea.value = "B";
  second.textarea.dispatchEvent(new Event("input"));
  await second.flushTimers();
  finishNew();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.storageValues.size, 0);
  const oldStatus = first.status.textContent;
  if (outcome === "success") {
    const data = { anotacao_conflito: true, anotacao_revisoes: ["a".repeat(32)] };
    finishOld.resolve({ ok: true, json: async () => data, clone: () => ({ json: async () => data }) });
  } else finishOld.reject(new TypeError("offline"));
  await new Promise(resolve => setImmediate(resolve));
  await first.flushTimers();
  assert.equal(first.status.textContent, oldStatus);
  assert.deepEqual(JSON.parse(first.textarea.dataset.annotationVersion), { anotacao_revisoes: [] });
  assert.equal(second.status.textContent, "Salvo automaticamente");
  assert.equal(second.textarea.dataset.annotationPending, "false");
  assert.equal(second.storageValues.size, 0);
  first.controller.dispose();
  second.controller.dispose();
});

for (const detached of [false, true]) test(`late responses cannot mutate a ${detached ? "detached" : "disposed"} component`, async () => {
  let finish;
  const options = { eventId: "unmounted-" + detached, storageValues: new Map() };
  const h = createAutosaveHarness(() => new Promise(resolve => { finish = resolve; }), options);
  h.textarea.value = "Rascunho";
  h.textarea.dispatchEvent(new Event("input"));
  await h.flushTimers();
  const oldStatus = h.status.textContent;
  if (detached) h.textarea.isConnected = false;
  else h.controller.dispose();
  finish(successResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.status.textContent, oldStatus);
  assert.equal(h.storageValues.size, 1);
  assert.equal(h.timers.size, 0);
  h.controller.dispose();
  const reopened = createAutosaveHarness(async () => successResponse, options);
  await reopened.flushTimers();
  assert.equal(reopened.storageValues.size, 0);
  reopened.controller.dispose();
});

test("distinguishes a locally saved annotation that is still waiting to synchronize", async () => {
  let calls = 0;
  const harness = createAutosaveHarness(async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        sucesso: true,
        sincronizacao: calls === 1 ? "pendente" : "sincronizada",
      }),
    };
  });
  harness.textarea.value = "Anotação preservada localmente";
  harness.textarea.dispatchEvent(new Event("input"));
  await harness.flushTimers();

  assert.equal(calls, 1);
  assert.equal(harness.status.textContent, "Salvo neste dispositivo; sincronização pendente");
  assert.equal(harness.retryButton.hidden, false);
  assert.equal(harness.textarea.dataset.annotationPending, "false");
  assert.equal(harness.storageValues.size, 0);

  const allowedExit = new Event("beforeunload", { cancelable: true });
  harness.windowObject.dispatchEvent(allowedExit);
  assert.equal(allowedExit.defaultPrevented, false);

  harness.retryButton.dispatchEvent(new Event("click"));
  await harness.flushTimers();
  assert.equal(calls, 2);
  assert.equal(harness.status.textContent, "Salvo automaticamente");
  assert.equal(harness.retryButton.hidden, true);
  assert.equal(harness.textarea.dataset.annotationPending, "false");
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
