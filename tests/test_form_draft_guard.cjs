const assert = require("node:assert/strict");
const test = require("node:test");
const { createDraftTracker } = require("../static/form-draft-guard.js");

test("does not mark default values as edits", () => {
  const tracker = createDraftTracker();
  tracker.capture("contact", "Contato padrão");
  tracker.update("contact", "Contato padrão");

  assert.equal(tracker.isDirty(), false);
});

test("detects edits and clears dirty state when the original value is restored", () => {
  const tracker = createDraftTracker();
  tracker.capture("notes", "Observação original");
  tracker.update("notes", "Observação alterada");

  assert.equal(tracker.isDirty(), true);

  tracker.update("notes", "Observação original");
  assert.equal(tracker.isDirty(), false);
});

test("captures values across fields and resets after an accepted discard", () => {
  const tracker = createDraftTracker();
  tracker.capture("contact", "Contato");
  tracker.update("contact", "Outro contato");
  tracker.capture("notes", "");
  tracker.update("notes", "Equipamento para substituição");

  assert.equal(tracker.isDirty(), true);
  tracker.reset();
  assert.equal(tracker.isDirty(), false);
});
