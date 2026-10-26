const test = require("node:test");
const { assert, createAppHarness, apiResponse } = require("./support/inventory-harness.cjs");

const texts = element => element.children.flatMap(child => [child.textContent, ...texts(child)]).filter(Boolean);

test("Home lists only open Oracle tickets of the selected series, newest order first", async () => {
  const calls = [];
  const harness = createAppHarness(url => {
    calls.push(url);
    return Promise.resolve(apiResponse({
      chamados: [
        { serie: "OUTRA", oracle: [{ solicitacao: "SR-OUTRA", ordem_servico: "9", status: "Em atendimento" }] },
        { serie: "5cg6051bvn", oracle: [
          { solicitacao: "SR-1", ordem_servico: "100", status: "Em atendimento", fila: "Deslocamento", cidade: "Curitiba" },
          { solicitacao: "SR-2", ordem_servico: "200", status: "Aguardando", sub_status: "Laudo pendente" },
          { solicitacao: "SR-3", ordem_servico: "300", status: "Concluído" },
        ] },
      ],
    }));
  });

  await harness.run('atualizarChamadosAbertosHome("5CG6051BVN")');
  await harness.run('atualizarChamadosAbertosHome("5CG6051BVN")');

  const body = harness.element("home-open-tickets-body");
  const shown = texts(body);
  assert.deepEqual(calls, ["/api/operacoes/chamados"], "the latest import is read once and reused");
  assert.ok(shown.indexOf("SR-2") < shown.indexOf("SR-1"), "higher service order comes first");
  assert.ok(!shown.includes("SR-3"), "closed tickets stay out");
  assert.ok(!shown.includes("SR-OUTRA"), "other series stay out");
  assert.ok(shown.includes("Aguardando · Laudo pendente"));
  assert.equal(harness.element("home-open-tickets-count").textContent, "2 abertos");
  assert.equal(body.attributes.get("aria-busy"), "false");
});

test("Home shows the empty message for a series without open tickets", async () => {
  const harness = createAppHarness(() => Promise.resolve(apiResponse({ chamados: [] })));
  await harness.run('atualizarChamadosAbertosHome("SEM-CHAMADO")');
  assert.deepEqual(texts(harness.element("home-open-tickets-body")), ["Nenhum chamado aberto para esta série."]);
  assert.equal(harness.element("home-open-tickets-count").textContent, "");
});

test("Home reports a ticket load failure as an alert", async () => {
  const harness = createAppHarness(() => Promise.reject(new Error("Servidor indisponível")));
  await harness.run('atualizarChamadosAbertosHome("5CG6051BVN")');
  const [message] = harness.element("home-open-tickets-body").children;
  assert.equal(message.textContent, "Servidor indisponível");
  assert.equal(message.attributes.get("role"), "alert");
});
