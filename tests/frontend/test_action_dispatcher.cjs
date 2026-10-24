const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { allow, dispatch } = require("../../static/js/ui/action-dispatcher.js");
const { appScriptFiles } = require("./support/app-sources.cjs");

allow(["ativarAba", "filtrar", "teclas", "carregar", "buscar", "fechar", "salvar", "inner", "outer"]);

function element(attrs = {}, parentElement = null) {
  return {
    nodeType: 1, parentElement, value: attrs.value,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    hasAttribute: name => name in attrs,
  };
}

function event(type, target) {
  return {
    type, target, cancelBubble: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; },
  };
}

test("click calls the named global with resolved JSON arguments", () => {
  const calls = [];
  const button = element({ "data-on-click": "ativarAba", "data-args": '["home", 2, false, "$this"]' });
  dispatch(event("click", button), { ativarAba: (...args) => calls.push(args) });
  assert.deepEqual(calls, [["home", 2, false, button]]);
});

test("input and keydown pass the element value and the event", () => {
  const calls = [];
  const input = element({ "data-on-input": "filtrar", "data-args": '["$value"]', value: "curitiba" });
  dispatch(event("input", input), { filtrar: value => calls.push(value) });
  const keydown = event("keydown", element({ "data-on-keydown": "teclas", "data-args": '["$event"]' }));
  dispatch(keydown, { teclas: received => calls.push(received) });
  assert.deepEqual(calls, ["curitiba", keydown]);
});

test("non-bubbling toggle runs only on its own details element", () => {
  const calls = [];
  const outer = element({ "data-on-toggle": "carregar", "data-args": '["outer"]' });
  const inner = element({ "data-on-toggle": "carregar", "data-args": '["inner"]' }, outer);
  dispatch(event("toggle", inner), { carregar: name => calls.push(name) });
  assert.deepEqual(calls, ["inner"]);
});

test("submit always prevents the native navigation", () => {
  let searched = false;
  const submit = event("submit", element({ "data-on-submit": "buscar" }));
  dispatch(submit, { buscar: () => { searched = true; } });
  assert.equal(searched, true);
  assert.equal(submit.defaultPrevented, true);
});

test("handlers bubble outwards and self-only handlers ignore inner clicks", () => {
  const calls = [];
  const overlay = element({ "data-on-click": "fechar", "data-on-self-only": "" });
  const button = element({ "data-on-click": "salvar" }, overlay);
  const scope = { fechar: () => calls.push("fechar"), salvar: () => calls.push("salvar") };
  dispatch(event("click", button), scope);
  dispatch(event("click", overlay), scope);
  assert.deepEqual(calls, ["salvar", "fechar"]);
});

test("stopPropagation inside a handler stops outer handlers", () => {
  const calls = [];
  const outer = element({ "data-on-click": "outer" });
  const inner = element({ "data-on-click": "inner" }, outer);
  const click = event("click", inner);
  dispatch(click, { inner: () => { calls.push("inner"); click.stopPropagation(); }, outer: () => calls.push("outer") });
  assert.deepEqual(calls, ["inner"]);
});

test("click targets forward to another element and unknown actions only warn", () => {
  let forwarded = 0;
  const warnings = [];
  const scope = {
    document: { getElementById: id => (id === "arquivo" ? { click: () => { forwarded += 1; } } : null) },
    console: { warn: message => warnings.push(message) },
  };
  dispatch(event("click", element({ "data-click-target": "arquivo" })), scope);
  dispatch(event("click", element({ "data-on-click": "naoExiste" })), scope);
  assert.equal(forwarded, 1);
  assert.equal(warnings.length, 1);
});

test("pages no longer use inline event handler attributes", () => {
  const root = path.resolve(__dirname, "..", "..", "static");
  for (const file of ["index.html", ...appScriptFiles()]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /\son[a-z]+\s*=\s*["']/, file);
  }
});
