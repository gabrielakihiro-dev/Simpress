const test = require("node:test");
const { assert, createAppHarness, apiResponse, appHtml } = require("./support/inventory-harness.cjs");

const AVISO = "O comando foi inserido no prompt, mas NÃO foi executado. Revise e aperte Enter no terminal do Chrome.";

function preencher(h, { comando = "Get-Service", modo = "sistema", hostname = "", usuario = "" } = {}) {
  h.element("input-powershell-comando").value = comando;
  h.element("select-powershell-modo").value = modo;
  h.element("input-powershell-hostname").value = hostname;
  h.element("input-powershell-usuario").value = usuario;
}

test("Home: o formulário do PowerShell tem IDs, ARIA e ação declarativa, sem parâmetro de Enter", () => {
  assert.match(appHtml, /<form[^>]*data-on-submit="abrirPowerShellEndpoint"/);
  assert.match(appHtml, /id="input-powershell-comando"/);
  assert.match(appHtml, /id="select-powershell-modo"[^>]*data-on-change="alternarModoPowerShellEndpoint"/);
  assert.match(appHtml, /<option value="sistema">SYSTEM<\/option>\s*<option value="usuario">Usuário logado<\/option>/);
  assert.match(appHtml, /id="input-powershell-hostname"[^>]*placeholder="PRNOTEUMU005"/);
  assert.match(appHtml, /id="input-powershell-usuario"[^>]*placeholder="ex\.: gananias"/);
  assert.match(appHtml, /id="btn-powershell-endpoint"[\s\S]*?<span>Inserir no PowerShell<\/span>/);
  assert.match(appHtml, /id="endpoint-powershell-result"[^>]*role="status"/);
  assert.doesNotMatch(appHtml, /id="[^"]*powershell[^"]*enter/i);
});

test("PowerShell: quebra de linha é bloqueada no cliente, sem confirmar nem chamar a API", async () => {
  let fetched = 0;
  const h = createAppHarness(() => { fetched += 1; return apiResponse({}); });
  for (const comando of ["a\nb", "a\r\nb", "a\rb"]) {
    preencher(h, { comando });
    await h.run("abrirPowerShellEndpoint()");
    assert.equal(h.element("endpoint-powershell-result").textContent, "O comando não pode ter quebra de linha.");
    assert.equal(h.element("input-powershell-comando").value, comando); // nunca remove em silêncio
  }
  assert.equal(fetched, 0);
  assert.deepEqual(h.effects.confirmations, []);
});

test("PowerShell: modo SYSTEM envia só modo e comando; hostname só quando preenchido", async () => {
  const bodies = [];
  const h = createAppHarness((url, options) => {
    assert.equal(url, "/api/endpoint/powershell");
    assert.equal(options.method, "POST");
    bodies.push(JSON.parse(options.body));
    return apiResponse({ status: "inserido", hostname: "PRNOTEUMU005", modo: "sistema" });
  });
  preencher(h, { comando: "ipconfig", usuario: "ignorado" });
  await h.run("abrirPowerShellEndpoint()");
  preencher(h, { comando: "ipconfig", hostname: "PRNOTEXYZ001" });
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(bodies, [{ modo: "sistema", comando: "ipconfig" }, { modo: "sistema", comando: "ipconfig", hostname: "PRNOTEXYZ001" }]);
});

test("PowerShell: modo Usuário logado envia o usuário e o campo aparece só nesse modo", async () => {
  let body;
  const h = createAppHarness((url, options) => { body = JSON.parse(options.body); return apiResponse({ status: "inserido", hostname: "PC1", modo: "usuario", usuario: "gananias" }); });
  h.element("select-powershell-modo").value = "usuario";
  h.run("alternarModoPowerShellEndpoint()");
  assert.equal(h.element("campo-powershell-usuario").classList.contains("hidden"), false);
  h.element("select-powershell-modo").value = "sistema";
  h.run("alternarModoPowerShellEndpoint()");
  assert.equal(h.element("campo-powershell-usuario").classList.contains("hidden"), true);
  preencher(h, { comando: "whoami", modo: "usuario", hostname: "PC1", usuario: " gananias " });
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(body, { modo: "usuario", comando: "whoami", hostname: "PC1", usuario: "gananias" });
  preencher(h, { comando: "whoami", modo: "usuario" });
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(body, { modo: "usuario", comando: "whoami" });
});

test("PowerShell: a confirmação vem antes do fetch; cancelar não chama a API", async () => {
  let fetched = 0;
  const h = createAppHarness(() => { fetched += 1; return apiResponse({ status: "inserido", hostname: "PRNOTEUMU005", modo: "sistema" }); }, { confirmResult: false });
  preencher(h, { comando: "Get-Process" });
  await h.run("abrirPowerShellEndpoint()");
  assert.equal(fetched, 0);
  assert.equal(h.effects.confirmations.length, 1);
  assert.match(h.effects.confirmations[0], /Get-Process/);
  assert.match(h.effects.confirmations[0], /NÃO será executado/);
  assert.equal(h.element("btn-powershell-endpoint").disabled, false);
});

test("PowerShell: sucesso mostra o aviso exato de que NÃO foi executado", async () => {
  const h = createAppHarness(() => apiResponse({ status: "inserido", hostname: "PRNOTEUMU005", modo: "sistema", inserido: true, enter_enviado: false }));
  preencher(h, { comando: "Get-Service" });
  await h.run("abrirPowerShellEndpoint()");
  const texto = h.element("endpoint-powershell-result").textContent;
  assert.ok(texto.startsWith(AVISO), texto);
  assert.equal(h.element("btn-powershell-endpoint").disabled, false);
});

for (const [resposta, trecho] of [
  [{ status: "not_found", hostname: "PC1" }, /não encontrado.*Nada foi inserido/s],
  [{ status: "sem_host_online" }, /Nada foi inserido/],
  [{ status: "erro_terminal", mensagem: "Terminal não abriu." }, /^Terminal não abriu\.$/],
  [{ status: "sem_usuario", hostname: "PC1", usuarios: [] }, /Nada foi inserido/],
  [{ status: "usuario_ambiguo", hostname: "PC1", usuarios: ["a", "b"] }, /Nada foi inserido/],
]) {
  test(`PowerShell: status ${resposta.status} nunca diz que inseriu`, async () => {
    const h = createAppHarness(() => apiResponse(resposta));
    preencher(h, { comando: "ls" });
    await h.run("abrirPowerShellEndpoint()");
    const texto = h.element("endpoint-powershell-result").textContent;
    assert.match(texto, trecho);
    assert.ok(!texto.includes("foi inserido no prompt"), texto);
  });
}

for (const [status, detail] of [[409, "Chrome ocupado"], [503, "Falha geral"], [422, "Comando inválido"]]) {
  test(`PowerShell: HTTP ${status} mostra o erro e reabilita o botão`, async () => {
    const h = createAppHarness(() => apiResponse({ detail }, { status }));
    preencher(h, { comando: "ls" });
    await h.run("abrirPowerShellEndpoint()");
    assert.match(h.element("endpoint-powershell-result").textContent, new RegExp(detail));
    assert.equal(h.element("btn-powershell-endpoint").disabled, false);
  });
}
