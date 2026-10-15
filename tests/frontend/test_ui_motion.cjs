const assert = require("node:assert/strict");
const test = require("node:test");
const createMotion = require("../../static/js/ui/ui-motion.js");

class Element {
  constructor() {
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.classes = new Set(["hidden"]);
    this.classList = { remove: name => this.classes.delete(name), add: name => this.classes.add(name) };
    this.animations = [];
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  animate(frames, options) {
    let resolve, reject;
    const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    const animation = { frames, options, finished, end: resolve, cancelled: false,
      cancel() { this.cancelled = true; reject(new Error("cancelled")); } };
    this.animations.push(animation);
    return animation;
  }
}

function harness(reduced = false) {
  const timers = new Map();
  const events = new Map();
  let timerId = 0, preferenceChanged;
  const preference = { matches: reduced, addEventListener: (_, fn) => { preferenceChanged = fn; } };
  const env = {
    matchMedia: () => preference,
    document: { createElement: () => new Element(), addEventListener: (name, fn) => events.set(name, fn) },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const motion = createMotion(env);
  return { motion, timers, events,
    flushTimers() { const current = [...timers.values()]; timers.clear(); current.forEach(fn => fn()); },
    reduce() { preference.matches = true; preferenceChanged(); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function overlay() { const result = new Element(); result.firstElementChild = new Element(); return result; }

test("a reopened overlay cannot be hidden by an old exit animation", async () => {
  const { motion } = harness();
  const modal = overlay();
  let closed = 0;
  motion.openOverlay(modal);
  motion.closeOverlay(modal, () => { closed++; modal.classList.add("hidden"); });
  const oldExit = modal.animations.at(-1);
  motion.openOverlay(modal);
  oldExit.end();
  await settle();
  assert.equal(closed, 0);
  assert.equal(modal.classes.has("hidden"), false);
  assert.equal(modal.inert, false);
  assert.equal(modal.getAttribute("aria-hidden"), null);
  assert.equal(modal.dataset.motionClosing, undefined);
});

test("closing disables interaction immediately, completes once and releases animation effects", async () => {
  const { motion } = harness();
  const modal = overlay();
  let closed = 0;
  motion.openOverlay(modal);
  motion.closeOverlay(modal, () => closed++);
  motion.closeOverlay(modal, () => closed++);
  assert.equal(modal.inert, true);
  assert.equal(modal.getAttribute("aria-hidden"), "true");
  const exit = modal.animations.at(-1);
  exit.end();
  await settle();
  assert.equal(closed, 1);
  assert.equal(exit.cancelled, true);
  assert.equal(modal.dataset.motionClosing, undefined);
});

test("changing reduced-motion preference finishes pending closes", async () => {
  const fixture = harness();
  const modal = overlay();
  let closed = 0;
  fixture.motion.closeOverlay(modal, () => closed++);
  fixture.reduce();
  await settle();
  assert.equal(closed, 1);
  assert.equal(modal.animations[0].cancelled, true);
});

test("reduced motion skips entrances and completes exits synchronously", () => {
  const { motion } = harness(true);
  const modal = overlay();
  let closed = 0;
  motion.openOverlay(modal);
  motion.closeOverlay(modal, () => closed++);
  assert.equal(closed, 1);
  assert.equal(modal.animations.length, 0);
});

test("unsupported Web Animations still closes and removes notifications", () => {
  const { motion } = harness();
  const modal = overlay();
  modal.animate = modal.firstElementChild.animate = undefined;
  let completed = 0;
  motion.closeOverlay(modal, () => completed++);
  motion.dismiss(modal, () => completed++);
  assert.equal(completed, 2);
});

test("rapid route switches cancel previous entrances and use only transform and opacity", async () => {
  const { motion } = harness();
  const panel = new Element();
  motion.reveal(panel, "page");
  motion.reveal(panel, "page");
  assert.equal(panel.animations[0].cancelled, true);
  const latest = panel.animations[1];
  assert.ok(latest.options.duration >= 150 && latest.options.duration <= 300);
  latest.frames.forEach(frame => assert.deepEqual(Object.keys(frame).sort(), ["opacity", "transform"]));
  latest.end();
  await settle();
  assert.equal(latest.cancelled, true);
});

test("stagger cascades a capped delay and skips motion when reduced", () => {
  const { motion } = harness();
  const items = Array.from({ length: 8 }, () => new Element());
  motion.stagger(items, "content", { step: 30, max: 6 });
  assert.deepEqual(items.map(item => item.animations[0].options.delay), [0, 30, 60, 90, 120, 150, 150, 150]);
  items[0].animations[0].frames.forEach(frame => assert.deepEqual(Object.keys(frame).sort(), ["opacity", "transform"]));

  const reduced = harness(true);
  const still = [new Element(), new Element()];
  reduced.motion.stagger(still);
  assert.deepEqual(still.map(item => item.animations.length), [0, 0]);
});

test("drawer uses a horizontal transform preset", () => {
  const { motion } = harness();
  const drawer = overlay();
  drawer.dataset.motion = "drawer";
  motion.openOverlay(drawer);
  assert.equal(drawer.firstElementChild.animations[0].frames[0].transform, "translateX(24px)");
});

test("fast requests never flash skeletons and restore prior busy state", () => {
  const fixture = harness();
  const list = new Element();
  const stop = fixture.motion.startLoading(list);
  assert.equal(list.getAttribute("aria-busy"), "true");
  stop();
  fixture.flushTimers();
  assert.equal(list.children.length, 0);
  assert.equal(list.getAttribute("aria-busy"), null);
});

test("slow requests show bounded accessible skeletons without removing pagination results", () => {
  const fixture = harness();
  const list = new Element();
  const result = new Element();
  list.appendChild(result);
  const stop = fixture.motion.startLoading(list, "Carregando pesquisa…", { rows: 99 });
  fixture.flushTimers();
  const skeleton = list.children[1];
  assert.equal(skeleton.children.length, 6);
  assert.equal(skeleton.children[0].textContent, "Carregando pesquisa…");
  assert.equal(skeleton.children[1].getAttribute("aria-hidden"), "true");
  stop();
  assert.deepEqual(list.children, [result]);
});

test("a stale request cannot clear a newer loader or its busy state", () => {
  const fixture = harness();
  const list = new Element();
  const oldStop = fixture.motion.startLoading(list);
  fixture.flushTimers();
  const newStop = fixture.motion.startLoading(list);
  fixture.flushTimers();
  oldStop();
  assert.equal(list.children.length, 1);
  assert.equal(list.getAttribute("aria-busy"), "true");
  newStop();
  assert.equal(list.children.length, 0);
  assert.equal(list.getAttribute("aria-busy"), null);
});

test("finishing after result replacement preserves new content", () => {
  const fixture = harness();
  const list = new Element();
  const stop = fixture.motion.startLoading(list);
  fixture.flushTimers();
  const result = new Element();
  list.children = [result];
  stop();
  stop();
  assert.deepEqual(list.children, [result]);
});

test("validation feedback clears only after a field becomes valid", () => {
  const fixture = harness(true);
  fixture.motion.installFeedback();
  const field = new Element();
  field.matches = () => true;
  field.validity = { valid: false };
  fixture.events.get("invalid")({ target: field });
  fixture.events.get("input")({ target: field });
  assert.equal(field.getAttribute("aria-invalid"), "true");
  field.validity.valid = true;
  fixture.events.get("input")({ target: field });
  assert.equal(field.getAttribute("aria-invalid"), null);
});
