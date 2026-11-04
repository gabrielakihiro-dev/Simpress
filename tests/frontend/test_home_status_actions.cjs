const test = require("node:test");
const { assert, createAppHarness, apiResponse, FakeElement } = require("./support/inventory-harness.cjs");

async function createStatusHarness(equipmentFetch, listItems = [{ serial: "S1", usuarios_logados: "Usuário" }, { serial: "S2", usuarios_logados: "Usuário" }]) {
  FakeElement.prototype.prepend = function (...children) { this.children.unshift(...children); };
  const harness = createAppHarness(url => url.startsWith("/api/equipamento/") && equipmentFetch ? equipmentFetch(url) : Promise.resolve(apiResponse(url === "/api/painel" ? { ultima_comparacao: { id: "latest" } }
    : url.startsWith("/api/historico-comparacoes/") ? { evento: { comparacao: {
      sem_acesso_7_dias: [{ serie: "S1", dias_sem_acesso: 9 }],
      ausentes_no_endpoint: [], divergencias_local: [{ serie: "S1" }],
    } } }
    : { items: listItems, total: listItems.length, has_more: true })));
  const list = harness.element("home-equipment-list");
  list.getAttribute = name => list.attributes.get(name);
  list.querySelectorAll = selector => list.children.filter(item => selector === '[role="option"]'
    ? item.attributes.get("role") === "option" : item.attributes.get("aria-selected") === "true");
  list.querySelector = selector => list.children.find(item => selector.includes(`"${item.dataset.serial}"`));
  harness.context.document.createElementNS = (_namespace, tag) => new FakeElement(tag);
  harness.context.CSS = { escape: value => value };
  harness.run('workflowEffects.comparacoes = []; abrirComparacaoDaSerie = async (serial, categoria) => { workflowEffects.comparacoes.push([serial, categoria]); }; inicializarListaHome()');
  // Drain the list and comparison fetches, including the comparison-triggered list refresh.
  await new Promise(resolve => setImmediate(resolve));
  const keydown = list.listeners.get("keydown")[0];
  const press = key => keydown({ key, preventDefault() {} });
  return { harness, list, press, actions: harness.element("home-equipment-actions") };
}

test("Home keeps focusable status actions outside options and updates their series with keyboard navigation", async () => {
  const { harness, list, press, actions } = await createStatusHarness();
  const [first] = list.children;
  const descendants = item => item.children.flatMap(child => typeof child === "object" ? [child, ...descendants(child)] : []);
  assert.equal(descendants(first).filter(child => child.type === "button").length, 0, "options must contain no interactive descendants");
  press("Home");
  assert.equal(actions.attributes.get("aria-label"), "Ações de S1");
  assert.equal(actions.hidden, false);
  const buttons = descendants(actions).filter(child => child.type === "button");
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.notEqual(button.tabIndex, -1, "native buttons stay in the sequential Tab order");
    for (const click of button.listeners.get("click")) click({ stopPropagation() {} });
  }
  assert.deepEqual(buttons.map(button => button.dataset.categoria), ["sem_acesso_7_dias", "divergencias_local"]);
  assert.deepEqual(buttons.map(button => button.attributes.get("aria-label")), [
    "Sem acesso 9 d: abrir S1 no Resumo (F3)",
    "Divergente: abrir S1 no Resumo (F3)",
  ]);
  assert.deepEqual(buttons.map(button => button.title), ["Abrir no Resumo", "Abrir no Resumo"]);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.effects.comparacoes)), [["S1", "sem_acesso_7_dias"], ["S1", "divergencias_local"]]);
  press("End");
  assert.equal(actions.hidden, true, "a series without these statuses has no actions");
  press("ArrowUp");
  assert.equal(actions.hidden, false);
  assert.equal(actions.attributes.get("aria-label"), "Ações de S1");
  press("End");
  harness.run('highlightHomeListItem("S1")');
  assert.equal(first.attributes.get("aria-selected"), "true");
  assert.equal(actions.hidden, true, "the active S2 still controls actions when S1 becomes selected");
});

test("Home pagination preserves actions for active B while A remains selected", async () => {
  const { harness, list, press, actions } = await createStatusHarness();
  harness.selectEquipment({ serial: "S2" });
  harness.run('highlightHomeListItem("S2")');
  press("Home");
  const activeId = list.attributes.get("aria-activedescendant");
  await harness.run('carregarMaisItensHome()');
  assert.equal(list.attributes.get("aria-activedescendant"), activeId);
  assert.equal(actions.hidden, false);
  assert.equal(actions.attributes.get("aria-label"), "Ações de S1");
  assert.equal(list.children[1].attributes.get("aria-selected"), "true");
  assert.equal(list.children[0].attributes.get("aria-selected"), "false");
});

test("Home late selection of A preserves actions for active B and clicking an option updates the active descendant", async () => {
  let finish;
  const { harness, list, press, actions } = await createStatusHarness(() => new Promise(resolve => { finish = resolve; }));
  harness.run('exibirEquipamento = eq => highlightHomeListItem(eq.serial)');
  const pending = harness.run('selecionarItemAutocomplete({ serial: "S2" })');
  press("Home");
  const activeId = list.attributes.get("aria-activedescendant");
  finish(apiResponse({ serial: "S2" }));
  await pending;
  assert.equal(list.attributes.get("aria-activedescendant"), activeId);
  assert.equal(actions.hidden, false);
  assert.equal(actions.attributes.get("aria-label"), "Ações de S1");
  assert.equal(list.children[1].attributes.get("aria-selected"), "true");
  assert.equal(list.children[0].attributes.get("aria-selected"), "false");

  harness.run('selecionarItemAutocomplete = () => {}');
  list.children[1].dispatchEvent("click");
  assert.equal(list.attributes.get("aria-activedescendant"), list.children[1].id);
  assert.equal(actions.hidden, true);
});

for (const stage of ["loading", "failed"]) {
  test(`Home clears selected A while B is ${stage}, preserving active B and its actions`, async () => {
    let fail;
    const { harness, list, actions } = await createStatusHarness(() => new Promise((_resolve, reject) => { fail = reject; }));
    harness.selectEquipment({ serial: "S2" });
    harness.run('highlightHomeListItem("S2")');
    assert.equal(list.children[1].attributes.get("aria-selected"), "true");

    list.children[0].dispatchEvent("click");
    if (stage === "failed") {
      fail(new Error("Falha ao consultar B"));
      await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(harness.run('SimpressApp.state.currentEquipamento'), null);
    assert.equal(list.querySelectorAll('.ck-item[aria-selected="true"]').length, 0);
    assert.equal(list.attributes.get("aria-activedescendant"), list.children[0].id);
    assert.equal(actions.hidden, false);
    assert.equal(actions.attributes.get("aria-label"), "Ações de S1");
  });
}

for (const completion of ["pagination", "late selection"]) {
  test(`Home preserves the focused action button when ${completion} completes without changing its actions`, async () => {
    let finish;
    const { harness, list, press, actions } = await createStatusHarness(() => new Promise(resolve => { finish = resolve; }));
    const document = harness.context.document;
    actions.contains = element => actions.children.includes(element);
    actions.replaceChildren = function (...children) {
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      FakeElement.prototype.replaceChildren.call(this, ...children);
    };
    harness.run('exibirEquipamento = eq => highlightHomeListItem(eq.serial)');
    let pending;
    if (completion === "late selection") pending = harness.run('selecionarItemAutocomplete({ serial: "S2" })');
    else {
      harness.selectEquipment({ serial: "S2" });
      harness.run('highlightHomeListItem("S2")');
    }
    press("Home");
    const button = actions.children.find(child => child.dataset.categoria === "sem_acesso_7_dias");
    button.focus = () => { document.activeElement = button; };
    button.focus();
    if (completion === "late selection") {
      finish(apiResponse({ serial: "S2" }));
      await pending;
    } else await harness.run('carregarMaisItensHome()');

    assert.equal(list.attributes.get("aria-activedescendant"), list.children[0].id);
    assert.equal(document.activeElement, button, "the focused button must remain connected and focused");
    assert.ok(actions.children.includes(button), "unchanged actions keep the original button tree");
  });
}

test("Home chip Sem usuário opens the Resumo on the notebook row; other types and users have no link", async () => {
  const { harness, list, press, actions } = await createStatusHarness(undefined, [
    { serial: "N1", categoria: "notebook", usuarios_logados: "" },
    { serial: "M1", categoria: "macbook", usuarios_logados: "  " },
    { serial: "D1", categoria: "monitor", usuarios_logados: "" },
    { serial: "N2", categoria: "notebook", usuarios_logados: "Usuário" },
  ]);
  const descendants = item => item.children.flatMap(child => typeof child === "object" ? [child, ...descendants(child)] : []);
  const actionButtons = () => descendants(actions).filter(child => child.type === "button");
  press("Home");
  assert.equal(actions.attributes.get("aria-label"), "Ações de N1");
  let [button] = actionButtons();
  assert.equal(actionButtons().length, 1);
  assert.equal(button.dataset.destino, "comparacao");
  assert.equal(button.dataset.categoria, "sem_usuario");
  assert.equal(button.attributes.get("aria-label"), "Sem usuário: abrir N1 no Resumo (F3)");
  assert.equal(button.title, "Abrir no Resumo");
  for (const click of button.listeners.get("click")) click({ stopPropagation() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(harness.effects.comparacoes)), [["N1", "sem_usuario"]]);

  press("ArrowDown");
  [button] = actionButtons();
  assert.equal(actions.attributes.get("aria-label"), "Ações de M1");
  assert.equal(button.dataset.categoria, "sem_usuario");

  press("ArrowDown");
  assert.equal(actions.hidden, true, "a monitor is not in the Resumo list, so its Sem usuário chip is not a link");
  press("ArrowDown");
  assert.equal(actions.hidden, true, "a series with a user has no Sem usuário action");
  const pills = descendants(list.children[0]).filter(child => child.dataset?.status === "info");
  assert.equal(pills.length, 1, "the list keeps the non-interactive Sem usuário badge");
  assert.equal(pills[0].type, undefined);
});
