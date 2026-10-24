const test = require("node:test");
const {
  assert,
  FakeElement,
  createAppHarness,
  apiResponse,
  pendingTicketResponse,
  ticketSelectionHarness,
} = require("./support/inventory-harness.cjs");

test("latest ticket snapshot wins when responses arrive out of order", async () => {
  const old = pendingTicketResponse(), latest = pendingTicketResponse();
  const requests = [];
  const harness = ticketSelectionHarness((url, options) => {
    requests.push(options);
    return url.endsWith("/old") ? old.promise : latest.promise;
  });
  harness.element("versao-acompanhamento-chamados").value = "old";
  const first = harness.run("selecionarVersaoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "latest";
  const second = harness.run("selecionarVersaoChamados()");
  latest.resolve(apiResponse({})); await second;
  old.resolve(apiResponse({})); await first;
  assert.equal(harness.run("SimpressApp.state.acompanhamentoChamadosAtual.snapshot_id"), "latest");
  assert.equal(harness.element("lista-acompanhamento-chamados").innerHTML, "latest");
  assert.equal(requests[0].signal.aborted, true);
});

test("stale ticket errors cannot replace a newer successful snapshot", async () => {
  const old = pendingTicketResponse();
  const harness = ticketSelectionHarness(url => url.endsWith("/old") ? old.promise : Promise.resolve(apiResponse({})));
  harness.element("versao-acompanhamento-chamados").value = "old";
  const first = harness.run("selecionarVersaoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "latest";
  await harness.run("selecionarVersaoChamados()");
  old.reject(new Error("falha antiga")); await first;
  assert.equal(harness.element("lista-acompanhamento-chamados").innerHTML, "latest");
});

test("choosing no ticket import cancels a pending snapshot and clears the selected report", async () => {
  const old = pendingTicketResponse();
  const requests = [];
  const harness = ticketSelectionHarness((url, options) => {
    requests.push(options);
    return old.promise;
  });
  harness.run('SimpressApp.state.acompanhamentoChamadosAtual = { snapshot_id: "previous" }');
  harness.element("versao-acompanhamento-chamados").value = "previous";
  const pending = harness.run("selecionarVersaoChamados()");

  harness.element("versao-acompanhamento-chamados").value = "";
  await harness.run("selecionarVersaoChamados()");
  old.resolve(apiResponse({}));
  await pending;

  assert.equal(requests[0].signal.aborted, true);
  assert.equal(harness.run("SimpressApp.state.acompanhamentoChamadosAtual"), null);
  assert.match(harness.element("lista-acompanhamento-chamados").innerHTML, /Importe as duas planilhas/);
});

test("a late initial ticket load cannot overwrite a selected historical snapshot", async () => {
  const initial = pendingTicketResponse();
  const harness = ticketSelectionHarness(url => url.endsWith("/chamados") ? initial.promise : Promise.resolve(apiResponse({})));
  const first = harness.run("carregarAcompanhamentoChamados()");
  harness.element("versao-acompanhamento-chamados").value = "historical";
  await harness.run("selecionarVersaoChamados()");
  initial.resolve(apiResponse({ snapshot_id: "current", historico: [] })); await first;
  assert.equal(harness.run("SimpressApp.state.acompanhamentoChamadosAtual.snapshot_id"), "historical");
});

test("closing ticket tracking cancels reads and ignores their late completion", async () => {
  const response = pendingTicketResponse();
  const harness = ticketSelectionHarness(() => response.promise);
  harness.run("fecharModalAcessivel = () => {}");
  harness.element("versao-acompanhamento-chamados").value = "old";
  const pending = harness.run("selecionarVersaoChamados()");
  harness.run("fecharAcompanhamentoChamados()");
  response.resolve(apiResponse({})); await pending;
  assert.equal(harness.run("SimpressApp.state.acompanhamentoChamadosAtual"), null);
});

test("rebuilding ticket cards aborts timeline reads tied to the old cards", async () => {
  const response = pendingTicketResponse();
  let options;
  const harness = createAppHarness((_url, requestOptions) => {
    options = requestOptions;
    return response.promise;
  });
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");

  await harness.run("renderizarAcompanhamentoChamados()");

  assert.equal(options.signal.aborted, true);
  response.resolve(apiResponse({ eventos: [] }));
  await pending;
  assert.equal(details.dataset.ticketTimelineLoaded, undefined);
  assert.match(body.innerHTML, /Carregando histórico/);
});

test("ticket evolution ignores a stale error after a newer comparison succeeds", async () => {
  const old = pendingTicketResponse();
  const harness = createAppHarness(url => url.includes("atual=one") ? old.promise : Promise.resolve(apiResponse({ marker: "latest" })));
  harness.run(`
    SimpressApp.state.historicoAcompanhamentoChamados = [{ id: "two" }, { id: "one" }, { id: "zero" }];
    renderizarEvolucaoChamados = data => document.getElementById("evolucao-acompanhamento-chamados").textContent = data.marker;
  `);
  const first = harness.run('carregarEvolucaoChamados("one")');
  await harness.run('carregarEvolucaoChamados("two")');
  old.reject(new Error("falha antiga")); await first;
  assert.equal(harness.element("evolucao-acompanhamento-chamados").textContent, "latest");
});

test("detached ticket timelines never install annotation editors after loading", async () => {
  const response = pendingTicketResponse();
  const harness = createAppHarness(() => response.promise);
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.dataset.timelineSerial = "SN-SYNTHETIC";
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  harness.run('conectarAnotacoesLinhaDoTempo = () => { throw new Error("editor should not attach"); }');
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  details.isConnected = false;
  response.resolve(apiResponse({ eventos: [] })); await pending;
  assert.equal(details.dataset.ticketTimelineLoaded, undefined);
  assert.doesNotMatch(body.innerHTML, /editor should not attach/);
});

test("timeline reads deduplicate while pending and allow retry after a network error", async () => {
  const first = pendingTicketResponse();
  let requests = 0;
  const harness = createAppHarness(() => {
    requests += 1;
    return requests === 1 ? first.promise : Promise.resolve(apiResponse({ eventos: [] }));
  });
  const details = new FakeElement("timeline"), body = new FakeElement("timeline-body");
  details.open = true;
  details.querySelector = () => body;
  harness.context.testTimeline = details;
  harness.run("conectarAnotacoesLinhaDoTempo = () => {}");
  const pending = harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  await harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  assert.equal(requests, 1);
  first.reject(new Error("rede indisponível")); await pending;
  assert.match(body.innerHTML, /rede indisponível/);
  await harness.run("carregarLinhaDoTempoChamado(testTimeline)");
  assert.equal(requests, 2);
  assert.equal(details.dataset.ticketTimelineLoaded, "true");
});
