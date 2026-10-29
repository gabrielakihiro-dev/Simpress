// DOM falso mínimo (sem jsdom): árvore de nós, atributos, eventos e seletores simples
// (tag, .classe, [attr], [attr="v"], combinador de descendente e vírgula) — o bastante para montar a tabela de OS.
const camel = name => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class FakeNode {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.className = "";
    this.hidden = false;
    this.id = "";
    this.ownText = "";
  }

  get textContent() { return this.children.length ? this.children.map(child => child.textContent).join("") : this.ownText; }
  set textContent(value) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.ownText = String(value); }
  get isConnected() { let node = this; while (node.parentNode) node = node.parentNode; return node === this.ownerDocument.root; }

  setAttribute(name, value) { this.attrs.set(name, String(value)); if (name === "id") this.id = String(value); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }

  appendChild(child) { if (child.parentNode) child.remove(); child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === "string" ? this.ownerDocument.createTextNode(node) : node)); }
  replaceChildren(...nodes) { this.textContent = ""; this.append(...nodes); }
  remove() { const siblings = this.parentNode?.children; if (siblings) siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
  after(node) { const siblings = this.parentNode.children; if (node.parentNode) node.remove(); node.parentNode = this.parentNode; siblings.splice(siblings.indexOf(this) + 1, 0, node); }

  addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  dispatchEvent(event) { (this.listeners.get(event.type) || []).forEach(listener => listener(event)); return true; }
  click() { this.dispatchEvent({ type: "click", target: this, preventDefault() {} }); }
  focus() {}

  matches(selector) {
    return selector.split(",").some(part => compound(this, part.trim()));
  }
  closest(selector) { let node = this; while (node && node.tagName) { if (node.matches(selector)) return node; node = node.parentNode; } return null; }
  querySelectorAll(selector) {
    const chain = selector.split(",").map(part => part.trim().split(/\s+/));
    const found = [];
    const walk = node => node.children.forEach(child => {
      if (child.tagName && chain.some(parts => matchesChain(child, parts, this))) found.push(child);
      walk(child);
    });
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function compound(node, selector) {
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!node.className.split(/\s+/).includes(name)) return false;
  for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const actual = name === "id" ? node.id || undefined
      : node.attrs.has(name) ? node.attrs.get(name) : node.dataset[camel(name.replace(/^data-/, ""))];
    if (actual === undefined || (value !== undefined && String(actual) !== value)) return false;
  }
  return true;
}

function matchesChain(node, parts, scope) {
  if (!compound(node, parts[parts.length - 1])) return false;
  let ancestor = node.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && ancestor !== scope.parentNode && !compound(ancestor, parts[index])) ancestor = ancestor.parentNode;
    if (!ancestor || ancestor === scope.parentNode) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

class FakeText extends FakeNode {
  constructor(text, ownerDocument) { super("#text", ownerDocument); this.ownText = String(text); this.tagName = ""; }
}

function createFakeDocument() {
  const doc = {
    createElement: tag => new FakeNode(tag, doc),
    createElementNS: (_, tag) => new FakeNode(tag, doc),
    createTextNode: text => new FakeText(text, doc),
    getElementById: id => doc.root.querySelectorAll(`[id="${id}"]`)[0] || null,
    querySelector: selector => doc.root.querySelector(selector),
    querySelectorAll: selector => doc.root.querySelectorAll(selector),
    addEventListener() {},
    dispatchEvent() { return true; },
  };
  doc.root = new FakeNode("html", doc);
  doc.documentElement = doc.root;
  doc.body = doc.createElement("body");
  doc.root.appendChild(doc.body);
  return doc;
}

module.exports = { createFakeDocument };
