const assert = require("node:assert/strict");
const test = require("node:test");
const { matchesCatalogSearch, normalizeSearchText } = require("../../static/js/shared/catalog-search-utils.js");

test("normalizes accents and case for unit catalog search", () => {
  assert.equal(normalizeSearchText("Maringá"), "maringa");
  assert.equal(matchesCatalogSearch({ cidade: "Maringá" }, "maringa"), true);
});

test("matches normalized address, CNPJ and postal-code fields", () => {
  const unit = {
    endereco: "AV Bento Munhoz da Rocha Netto",
    cnpj: "75.110.585/0007-97",
    cep: "87030-010",
  };

  assert.equal(matchesCatalogSearch(unit, "bento munhoz"), true);
  assert.equal(matchesCatalogSearch(unit, "75.110"), true);
  assert.equal(matchesCatalogSearch(unit, "87030"), true);
  assert.equal(matchesCatalogSearch(unit, "londrina"), false);
});

test("an empty catalog query matches every unit", () => {
  assert.equal(matchesCatalogSearch({ cidade: "Maringá" }, " "), true);
});
