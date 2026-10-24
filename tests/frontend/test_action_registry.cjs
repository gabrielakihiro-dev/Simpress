const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const dispatcher = require("../../static/js/ui/action-dispatcher.js");
const { staticDir } = require("./support/app-sources.cjs");
const { bootPage } = require("./support/boot-page.cjs");

function element(attrs) {
  return {
    nodeType: 1, parentElement: null,
    getAttribute: name => (name in attrs ? attrs[name] : null),
    hasAttribute: name => name in attrs,
  };
}

function click(attrs) {
  return { type: "click", target: element(attrs), cancelBubble: false, preventDefault() {} };
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

// Every action name the page can ask for: index.html, rendered templates and setAttribute calls.
function declaredActions() {
  const files = [path.join(staticDir, "index.html"), ...jsFiles(path.join(staticDir, "js"))]
    .filter(file => !file.endsWith("action-dispatcher.js"));
  const names = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /data-on-[a-z]+=\\?["']?\$\{/, `${file} builds a data-on-* name dynamically`);
    for (const match of source.matchAll(/data-on-[a-z]+=\\?["']([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
    for (const match of source.matchAll(/setAttribute\(\s*["']data-on-[a-z]+["'],\s*["']([A-Za-z_$][\w$]*)["']/g)) names.add(match[1]);
  }
  return names;
}

test("every data-on-* action in the page and in templates is on the closed list", () => {
  bootPage({ SimpressActionDispatcher: dispatcher });
  const declared = declaredActions();
  assert.ok(declared.size > 90, "the page should still declare its actions");
  const calls = new Set();
  const scope = new Proxy({}, { get: (_target, name) => () => calls.add(name) });
  for (const name of declared) dispatcher.dispatch(click({ "data-on-click": name }), scope);
  // Registered by transfer-history.js, which loads after app.js and is not a feature.
  const history = fs.readFileSync(path.join(staticDir, "js/ui/transfer-history.js"), "utf8");
  const fromHistory = [...history.match(/\.allow\(\[([^\]]*)\]\)/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  const unregistered = [...declared].filter(name => !calls.has(name) && !fromHistory.includes(name));
  assert.deepEqual(unregistered, []);
});

test("names outside the closed list are never executed, even when the scope has them", () => {
  const spy = () => { throw new Error("handler outside the closed list ran"); };
  const scope = { alert: spy, fetch: spy, constructor: spy, toString: spy, hasOwnProperty: spy, console: { warn() {} } };
  Object.defineProperty(scope, "__proto__", { value: spy, enumerable: true });
  for (const name of ["alert", "fetch", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.doesNotThrow(() => dispatcher.dispatch(click({ "data-on-click": name }), scope), name);
  }
});
