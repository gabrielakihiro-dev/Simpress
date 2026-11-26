const test = require("node:test");
const { assert, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");
const { assembledHtml } = require("./support/assembled-html.cjs");

const item = serial => ({ serial, modelo: "Modelo sintético", cidade: "Curitiba" });

test("Home: falha no Carregar mais mantém a lista e o botão mais", async () => {
  let falhar = false;
  const harness = createAppHarness(async () => falhar
    ? apiResponse({ detail: "erro" }, { status: 500 })
    : apiResponse({ items: [item("SINT-001"), item("SINT-002")], total: 4, has_more: true }));
  // O DOM falso não tem querySelectorAll; sem ele renderHomeList não desenha a lista.
  harness.element("home-equipment-list").querySelectorAll = () => [];

  await harness.run('carregarListaHome({ query: "", reset: true })');
  const list = harness.element("home-equipment-list");
  assert.equal(list.children.length, 2);
  assert.equal(harness.element("btn-home-list-more").hidden, false);

  falhar = true;
  await harness.run("carregarMaisItensHome()");

  assert.equal(list.children.length, 2);
  assert.equal(harness.element("btn-home-list-more").hidden, false);
  assert.notEqual(harness.element("home-list-count").textContent, "");
  assert.doesNotMatch(harness.element("home-list-count").textContent, /^Mostrar/);
  assert.equal(list.attributes.get("aria-busy"), "false");
});

test("Home: digitação rápida gera um único pedido da lista", async () => {
  const listUrls = [];
  const harness = createAppHarness(async url => {
    if (String(url).includes("listar_todos=true")) listUrls.push(String(url));
    return apiResponse({ items: [], total: 0, has_more: false });
  });
  for (const value of ["LE", "LEX", "LEXM", "LEXMA"]) harness.run(`handleSerialInput(${JSON.stringify(value)})`);
  assert.equal(listUrls.length, 0);
  await new Promise(resolve => setTimeout(resolve, 260));

  assert.equal(listUrls.length, 1);
  assert.match(listUrls[0], /q=LEXMA/);
});

test("Home: Enter logo depois de digitar não cancela a recarga da lista", async () => {
  const listUrls = [];
  const harness = createAppHarness(async url => {
    if (String(url).includes("listar_todos=true")) listUrls.push(String(url));
    return apiResponse({ items: [], total: 0, has_more: false });
  });
  harness.run('handleSerialInput("BRJ00")');
  harness.run("invalidarBuscasEquipamento()");
  await new Promise(resolve => setTimeout(resolve, 260));

  assert.equal(listUrls.length, 1);
  assert.match(listUrls[0], /q=BRJ00/);
});

test("Home: Limpar pesquisa logo depois de digitar não recarrega o termo antigo", async () => {
  const listUrls = [];
  const harness = createAppHarness(async url => {
    if (String(url).includes("listar_todos=true")) listUrls.push(String(url));
    return apiResponse({ items: [], total: 0, has_more: false });
  });
  harness.run('handleSerialInput("BRJ00")');
  harness.run("limparSerial()");
  await new Promise(resolve => setTimeout(resolve, 260));

  assert.equal(listUrls.length, 1);
  assert.doesNotMatch(listUrls[0], /q=/);
});

test("Home: aria-controls da busca aponta para o listbox das sugestões", () => {
  const html = assembledHtml();
  const input = html.match(/<input[^>]*id="input-serial"[^>]*>/)[0];
  const controls = input.match(/aria-controls="([^"]+)"/)[1];
  const alvo = html.match(new RegExp(`<[a-z]+[^>]*id="${controls}"[^>]*>`))[0];
  assert.match(alvo, /role="listbox"/);
  assert.match(alvo, /aria-label="[^"]+"/);
  assert.doesNotMatch(html.match(/<div[^>]*id="autocomplete-box"[^>]*>/)[0], /role=/);
});
