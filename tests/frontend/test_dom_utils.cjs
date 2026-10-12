const assert = require("node:assert/strict");
const test = require("node:test");
const createDomUtils = require("../../static/js/shared/dom-utils.js");

function fakeDocument() {
  return {
    createElement: tagName => ({ tagName, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
  };
}

test("external text escapes markup, attributes and empty values", () => {
  const { escapeHtml } = createDomUtils(fakeDocument());
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')"> &`), "&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt; &amp;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
});

test("text elements use textContent and keep independent document instances", () => {
  const first = createDomUtils(fakeDocument()), second = createDomUtils(fakeDocument());
  const value = '<script>alert("external")</script>';
  const element = first.createTextElement("span", "label", value);
  assert.equal(element.tagName, "span");
  assert.equal(element.className, "label");
  assert.equal(element.textContent, value);
  assert.equal(element.innerHTML, undefined);
  assert.notEqual(element, second.createTextElement("span", "label", value));
});

test("icons retain Lucide and CSS contracts", () => {
  const icon = createDomUtils(fakeDocument()).createIcon("search", "w-4 h-4");
  assert.equal(icon.tagName, "i");
  assert.equal(icon.attributes["data-lucide"], "search");
  assert.equal(icon.className, "w-4 h-4");
});

test("highlight queries treat regex metacharacters and external HTML as literal text", () => {
  const { highlightMatch } = createDomUtils(fakeDocument());
  assert.equal(highlightMatch("A[1].*", "[1].*"), 'A<span class="serial-match">[1].*</span>');
  assert.equal(highlightMatch("A+B", "+"), 'A<span class="serial-match">+</span>B');
  assert.equal(highlightMatch("<script>x</script>", "x"), '&lt;script&gt;<span class="serial-match">x</span>&lt;/script&gt;');
  assert.equal(highlightMatch("<tag>", "  "), "&lt;tag&gt;");
});
