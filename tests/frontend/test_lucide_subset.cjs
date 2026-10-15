const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { DYNAMIC_ICON_NAMES, collectIconNames } = require("../../scripts/build/lucide-subset.cjs");

const root = path.resolve(__dirname, "..", "..");
const staticDir = path.join(root, "static");
const { devDependencies } = require("../../package.json");
const subsetFile = path.join(staticDir, "vendor", `lucide-${devDependencies.lucide}-subset.js`);

function fakeNode(tag, parent = null) {
  return {
    tagName: tag, attrs: {}, children: [], parentNode: parent,
    get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    appendChild(child) { this.children.push(child); },
    replaceChild(next, previous) { this.children[this.children.indexOf(previous)] = next; },
  };
}

function loadSubset() {
  const document = { createElementNS: (_namespace, tag) => fakeNode(tag) };
  const window = { document, console: { warn() {} } };
  vm.runInNewContext(fs.readFileSync(subsetFile, "utf8"), { window, Object, Array, String });
  return window.lucide;
}

test("the generated subset contains every icon name used in static/", () => {
  const { icons } = loadSubset();
  const missing = collectIconNames(staticDir).filter(name => !icons[name]);
  assert.deepEqual(missing, [], "run `npm run build:ui` after adding icons");
});

test("runtime icon names listed for the build still exist in the sources", () => {
  const sources = ["static/app.js", "static/js/ui/ui-notifications.js"]
    .map(file => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const name of DYNAMIC_ICON_NAMES) assert.match(sources, new RegExp(`["']${name}["']`), name);
});

test("createIcons swaps placeholders for SVG and keeps classes and accessibility", () => {
  const lucide = loadSubset();
  const container = fakeNode("div");
  const decorative = fakeNode("i", container);
  decorative.setAttribute("data-lucide", "search");
  decorative.setAttribute("class", "w-4 h-4");
  const labelled = fakeNode("i", container);
  labelled.setAttribute("data-lucide", "x");
  labelled.setAttribute("aria-label", "Fechar");
  container.children.push(decorative, labelled);
  container.querySelectorAll = () => [decorative, labelled];

  lucide.createIcons({ root: container });

  const [searchSvg, closeSvg] = container.children;
  assert.equal(searchSvg.tagName, "svg");
  assert.equal(searchSvg.attrs.class, "lucide lucide-search w-4 h-4");
  assert.equal(searchSvg.attrs["aria-hidden"], "true");
  assert.equal(searchSvg.attrs.stroke, "currentColor");
  assert.ok(searchSvg.children.length > 0);
  assert.equal(closeSvg.attrs["aria-label"], "Fechar");
  assert.equal(closeSvg.attrs["aria-hidden"], undefined);
});
