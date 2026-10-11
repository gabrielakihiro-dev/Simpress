const assert = require("node:assert/strict");
const test = require("node:test");
const { attachAnnotationAutosave } = require("../static/history-annotation-autosave.js");

class Element extends EventTarget {
  constructor() {
    super();
    this.dataset = {};
    this.children = [];
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.hidden = true;
  }
  append(...children) {
    children.forEach(child => { child.parentElement = this; this.children.push(child); });
  }
  setAttribute() {}
  focus() {}
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
}

let harnessId = 0;
function harness(version, send, savedDraft) {
  const textarea = new Element();
  const status = new Element();
  const retryButton = new Element();
  const parent = new Element();
  parent.append(textarea, status, retryButton);
  textarea.ownerDocument = { createElement: () => new Element() };
  textarea.dataset.annotationVersion = JSON.stringify(version);
  const timers = new Map();
  let timerId = 0;
  const windowObject = new EventTarget();
  windowObject.setTimeout = callback => { const id = ++timerId; timers.set(id, callback); return id; };
  windowObject.clearTimeout = id => timers.delete(id);
  const drafts = new Map();
  const itemId = String(++harnessId);
  if (savedDraft !== undefined) drafts.set("simpress:historico-anotacao:event:" + itemId, savedDraft);
  const controller = attachAnnotationAutosave({
    textarea, status, retryButton, eventId: "event", itemId, send,
    storage: { setItem: (k, v) => drafts.set(k, v), getItem: k => drafts.get(k), removeItem: k => drafts.delete(k) },
    retryOptions: { retryDelays: [], sleep: async () => {} }, windowObject,
  });
  return {
    textarea, status, parent, retryButton, drafts, controller,
    async flush() {
      const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback());
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const response = data => ({ ok: true, json: async () => data });
const conflict = {
  anotacao_conflito: true, anotacao_revisoes: ["a".repeat(32), "b".repeat(32)],
  anotacao_conflitos: [
    { revisao_id: "a".repeat(32), anotacao: "<img src=x onerror=alert(1)>" },
    { revisao_id: "b".repeat(32), anotacao: "" },
  ],
};

test("conflict alternatives use text nodes and require explicit resolution, including an empty note", async () => {
  const sent = [];
  const h = harness(conflict, async payload => {
    sent.push(payload);
    return response({ anotacao_revisoes: [payload.revisionId], anotacao_conflito: false });
  });
  try {
    assert.equal(h.textarea.readOnly, true);
    assert.match(h.status.textContent, /Conflito/);
    const panel = h.parent.children.at(-1);
    assert.equal(panel.children[1].textContent, "<img src=x onerror=alert(1)>");
    const choose = panel.children.filter(e => e.textContent === "Usar esta versão");
    choose[1].click();
    await h.flush();
    assert.equal(sent.length, 0);
    panel.children.find(e => e.textContent === "Resolver conflito com este texto").click();
    await h.flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].annotation, "");
    assert.deepEqual(sent[0].baseRevisions, conflict.anotacao_revisoes);
    assert.equal(sent[0].resolveConflict, true);
    assert.match(sent[0].revisionId, /^[a-f0-9]{32}$/);
    assert.equal(h.textarea.readOnly, false);
    assert.equal(h.textarea.dataset.annotationPending, "false");
  } finally { h.controller.dispose(); }
});

test("a conflict discovered after saving preserves the draft and does not show saved success", async () => {
  const h = harness({ anotacao_revisoes: [] }, async () => response(conflict));
  try {
    h.textarea.value = "Minha edição";
    h.textarea.dispatchEvent(new Event("input"));
    await h.flush();
    assert.equal(h.textarea.readOnly, true);
    assert.match(h.status.textContent, /Conflito/);
    assert.equal(h.textarea.dataset.annotationPending, "true");
    assert.equal(JSON.parse([...h.drafts.values()][0]).text, "Minha edição");
  } finally { h.controller.dispose(); }
});

test("recovered drafts retain observed bases and the revision ID after a lost acknowledgement", async () => {
  const first = harness({ anotacao_revisoes: ["a".repeat(32)] }, async () => { throw new TypeError("offline"); });
  let saved;
  try {
    first.textarea.value = "Rascunho antigo";
    first.textarea.dispatchEvent(new Event("input"));
    await first.flush();
    saved = [...first.drafts.values()][0];
  } finally { first.controller.dispose(); }
  const sent = [];
  const second = harness({ anotacao_revisoes: ["b".repeat(32)] }, async payload => {
    sent.push(payload);
    return response(conflict);
  }, saved);
  try {
    await second.flush();
    assert.equal(sent[0].annotation, "Rascunho antigo");
    assert.deepEqual(sent[0].baseRevisions, ["a".repeat(32)]);
    assert.equal(sent[0].revisionId, JSON.parse(saved).attempt.id);
    assert.match(second.status.textContent, /Conflito/);
  } finally { second.controller.dispose(); }
});

test("a plain legacy draft does not claim to supersede a revision it never observed", async () => {
  const sent = [];
  const h = harness({ anotacao_revisoes: ["b".repeat(32)] }, async payload => {
    sent.push(payload);
    return response(conflict);
  }, "Rascunho legado");
  try {
    await h.flush();
    assert.deepEqual(sent[0].baseRevisions, []);
    assert.equal(sent[0].annotation, "Rascunho legado");
  } finally { h.controller.dispose(); }
});

test("missing bases disable resolution while keeping alternatives accessible", async () => {
  const h = harness({ ...conflict, anotacao_bases_ausentes: ["d".repeat(32)] }, async () => { throw Error("must not send"); });
  try {
    const panel = h.parent.children.at(-1);
    const button = panel.children.find(e => e.textContent === "Resolver conflito com este texto");
    assert.equal(button.disabled, true);
    button.click();
    await h.flush();
    assert.equal(h.textarea.readOnly, true);
  } finally { h.controller.dispose(); }
});

test("manual network retry reuses the same immutable revision identifier", async () => {
  const sent = [];
  const h = harness({ anotacao_revisoes: ["a".repeat(32)] }, async payload => {
    sent.push(payload);
    if (sent.length === 1) throw new TypeError("offline");
    return response({ anotacao_revisoes: [payload.revisionId], anotacao_conflito: false });
  });
  try {
    h.textarea.value = "Nova anotação";
    h.textarea.dispatchEvent(new Event("input"));
    await h.flush();
    h.retryButton.click();
    await h.flush();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].revisionId, sent[1].revisionId);
    assert.deepEqual(sent[0].baseRevisions, sent[1].baseRevisions);
    assert.equal(h.textarea.dataset.annotationPending, "false");
  } finally { h.controller.dispose(); }
});
