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

test("highlighting text around HTML entities preserves the original visible value", () => {
  const { highlightMatch } = createDomUtils(fakeDocument());
  assert.equal(
    highlightMatch("A'039x &amp", "039"),
    "A&#039;<span class=\"serial-match\">039</span>x &amp;amp",
  );
});

test("pluralize keeps the singular only for exactly one item", () => {
  const { pluralize } = createDomUtils(fakeDocument());
  assert.equal(pluralize(1, "equipamento"), "equipamento");
  assert.equal(pluralize(0, "equipamento"), "equipamentos");
  assert.equal(pluralize(10101, "equipamento"), "equipamentos");
  assert.equal(pluralize("1", "filial catalogada", "filiais catalogadas"), "filial catalogada");
  assert.equal(pluralize(2, "filial catalogada", "filiais catalogadas"), "filiais catalogadas");
});

test("infoTipHtml escapa rótulo e texto, gera ids únicos e liga o botão ao balão", () => {
  const { infoTipHtml } = createDomUtils(fakeDocument());
  const primeiro = infoTipHtml('<b>"OS"</b>', "<img src=x onerror=alert(1)> & mais");
  const segundo = infoTipHtml("Versão", "Texto", { fim: true });
  const id = html => html.match(/<span id="(tip-auto-\d+)" role="tooltip" class="info-tip-text">/)[1];
  assert.notEqual(id(primeiro), id(segundo));
  assert.match(primeiro, new RegExp(`aria-describedby="${id(primeiro)}"`));
  assert.match(primeiro, /aria-label="Sobre &lt;b&gt;&quot;OS&quot;&lt;\/b&gt;"/);
  assert.match(primeiro, /class="info-tip-text">&lt;img src=x onerror=alert\(1\)&gt; &amp; mais<\/span>/);
  assert.doesNotMatch(primeiro, /<img|<b>/);
  assert.match(primeiro, /^<span class="info-tip"><button type="button" class="info-tip-trigger"/);
  assert.match(segundo, /^<span class="info-tip info-tip--end">/);
  assert.match(infoTipHtml("Seção", "Texto", { bloco: true }), /^<span class="info-tip info-tip--bloco">/);
});

test("infoTipHtml com id fixo repete o mesmo markup a cada chamada", () => {
  const { infoTipHtml } = createDomUtils(fakeDocument());
  const a = infoTipHtml("Backups", "Texto", { id: "dica-fixa" });
  assert.equal(a, infoTipHtml("Backups", "Texto", { id: "dica-fixa" }));
  assert.match(a, /aria-describedby="dica-fixa"/);
  assert.match(a, /<span id="dica-fixa" role="tooltip" class="info-tip-text">Texto<\/span>/);
});
