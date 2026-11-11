const test = require("node:test");
const { assert, createAppHarness, apiResponse, appHtml } = require("./support/inventory-harness.cjs");

const AVISO = "O comando foi inserido no prompt, mas NÃO foi executado. Revise e aperte Enter no terminal do Chrome.";

function preencher(h, { comando = "Get-Service", modo = "sistema", hostname = "PRNOTEUMU005" } = {}) {
  h.element("input-powershell-comando").value = comando;
  h.element("select-powershell-modo").value = modo;
  h.element("input-powershell-hostname").value = hostname;
}

test("Home: o formulário do PowerShell tem IDs, ARIA e ação declarativa, sem parâmetro de Enter", () => {
  assert.match(appHtml, /<form[^>]*data-on-submit="abrirPowerShellEndpoint"/);
  assert.match(appHtml, /id="input-powershell-comando"/);
  assert.match(appHtml, /id="select-powershell-modo"/);
  assert.match(appHtml, /<option value="sistema">SYSTEM<\/option>\s*<option value="usuario">Usuário logado<\/option>/);
  assert.match(appHtml, /id="input-powershell-hostname"[^>]*placeholder="Hostname do equipamento"/);
  assert.doesNotMatch(appHtml, /powershell-usuario|Usuário \(opcional\)/);
  assert.match(appHtml, /id="btn-powershell-endpoint"[\s\S]*?<span>Inserir no PowerShell<\/span>/);
  assert.match(appHtml, /id="endpoint-powershell-result"[^>]*role="status"/);
  assert.doesNotMatch(appHtml, /id="[^"]*powershell[^"]*enter/i);
});

test("Home: selecionar uma série preenche o hostname do PowerShell com o apelido; sem apelido, limpa", () => {
  const h = createAppHarness(() => apiResponse({}), { stubDisplay: false });
  h.element("input-powershell-hostname").value = "DIGITADO";
  h.run('exibirEquipamento({ serial: "BRJ00000AA", apelido: "PRNOTETST001" })');
  assert.equal(h.element("input-powershell-hostname").value, "PRNOTETST001");
  h.run('exibirEquipamento({ serial: "BRJ00000BB" })');
  assert.equal(h.element("input-powershell-hostname").value, "");
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

test("PowerShell: sem hostname não chama a API nem usa computador padrão", async () => {
  let fetched = 0;
  const h = createAppHarness(() => { fetched += 1; return apiResponse({}); });
  preencher(h, { comando: "ipconfig", hostname: "" });
  await h.run("abrirPowerShellEndpoint()");
  assert.equal(h.element("endpoint-powershell-result").textContent, "Informe o hostname.");
  assert.equal(fetched, 0);
  assert.deepEqual(h.effects.confirmations, []);
});

test("PowerShell: o hostname acompanha o equipamento aberto na Home", async () => {
  const bodies = [];
  const h = createAppHarness((url, options) => { bodies.push(JSON.parse(options.body)); return apiResponse({ status: "inserido", hostname: "PRNOTEXYZ049", modo: "sistema" }); });
  h.run('definirEquipamentoAtual({ serial: "BRJ0000001", apelido: "PRNOTEXYZ049" })');
  assert.equal(h.element("input-powershell-hostname").value, "PRNOTEXYZ049");
  h.element("input-powershell-comando").value = "ipconfig";
  await h.run("abrirPowerShellEndpoint()");
  h.run('definirEquipamentoAtual({ serial: "BRJ0000002", apelido: "PRNOTEABC001" })');
  assert.equal(h.element("input-powershell-hostname").value, "PRNOTEABC001");
  h.run('definirEquipamentoAtual({ serial: "BRJ0000003" })');
  assert.equal(h.element("input-powershell-hostname").value, "");
  assert.deepEqual(bodies, [{ modo: "sistema", comando: "ipconfig", hostname: "PRNOTEXYZ049" }]);
});

test("PowerShell: modo SYSTEM envia modo, comando e hostname", async () => {
  const bodies = [];
  const h = createAppHarness((url, options) => {
    assert.equal(url, "/api/endpoint/powershell");
    assert.equal(options.method, "POST");
    bodies.push(JSON.parse(options.body));
    return apiResponse({ status: "inserido", hostname: "PRNOTEXYZ001", modo: "sistema" });
  });
  preencher(h, { comando: "ipconfig", hostname: "PRNOTEXYZ001" });
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(bodies, [{ modo: "sistema", comando: "ipconfig", hostname: "PRNOTEXYZ001" }]);
});

test("PowerShell: modo Usuário logado nunca envia usuário, só modo, comando e hostname", async () => {
  let body;
  const h = createAppHarness((url, options) => { body = JSON.parse(options.body); return apiResponse({ status: "inserido", hostname: "PC1", modo: "usuario", usuario: "gananias" }); });
  preencher(h, { comando: "whoami", modo: "usuario", hostname: "PC1" });
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(body, { modo: "usuario", comando: "whoami", hostname: "PC1" });
});

const CODIGOS = [
  { id: "vp_cic", titulo: "CIC", modo: "usuario", comando: 'Add-Printer -ConnectionName "\\\\prsrvvm-imp\\VP_CIC"' },
  { id: "svc", titulo: "Reiniciar <b>spooler</b>", modo: "sistema", comando: "Restart-Service Spooler" },
  { id: "vp_umuarama", titulo: "Umuarama", modo: "usuario", comando: 'Add-Printer -ConnectionName "\\\\prsrvvm-imp\\VP_UMUARAMA"' },
];
const URL_CODIGOS = "/api/endpoint/powershell/codigos";

// Harness com o endpoint de códigos; `chamadas` guarda toda URL buscada (método e corpo).
function criarHarnessCodigos({ get = () => apiResponse({ codigos: CODIGOS }), put, confirmResult = true } = {}) {
  const chamadas = [];
  const h = createAppHarness((url, options = {}) => {
    const corpo = options.body ? JSON.parse(options.body) : undefined;
    chamadas.push({ url, metodo: options.method || "GET", corpo });
    if (url !== URL_CODIGOS) return apiResponse({ status: "inserido", hostname: "PRNOTEUMU005", modo: "sistema" });
    if (options.method === "PUT") return put ? put(corpo) : apiResponse({ codigos: corpo.codigos.map((item, i) => ({ id: `novo${i}`, ...item })) });
    return get();
  }, { confirmResult });
  h.element("powershell-codigos-editor").classList.add("hidden"); // o harness não aplica as classes do HTML
  return { h, chamadas };
}

const aguardar = () => new Promise(resolve => setImmediate(resolve));

async function abrirCard(h) {
  h.element("endpoint-powershell").open = true;
  h.run("aoAbrirPowerShellEndpoint()");
  await aguardar();
}

function achar(no, campo) {
  if (no.dataset?.powershellCodigoCampo === campo) return no;
  for (const filho of no.children || []) {
    const achado = achar(filho, campo);
    if (achado) return achado;
  }
  return null;
}

const linhasEditor = h => h.element("powershell-codigos-lista").children;
const painelAberto = h => !h.element("powershell-codigos-editor").classList.contains("hidden");

async function abrirEditor(h) {
  await abrirCard(h);
  await h.run("alternarEditorCodigosPowerShell()");
}

test("Home: o select de códigos é dinâmico e o editor fica fora do formulário de envio", () => {
  assert.match(appHtml, /id="select-powershell-codigo"[^>]*data-on-change="aplicarCodigoProntoPowerShell"/);
  assert.doesNotMatch(appHtml, /<option value="VP_/);
  assert.match(appHtml, /<details[^>]*id="endpoint-powershell"[^>]*data-on-toggle="aoAbrirPowerShellEndpoint"/);
  assert.match(appHtml, /id="btn-powershell-codigos-gerenciar"[^>]*aria-expanded="false" aria-controls="powershell-codigos-editor"/);
  assert.match(appHtml, /id="powershell-codigos-editor" class="[^"]*\bhidden\b/);
  for (const [id, acao] of [["btn-powershell-codigo-adicionar", "adicionarCodigoPowerShell"], ["btn-powershell-codigos-salvar", "salvarCodigosPowerShell"], ["btn-powershell-codigos-cancelar", "alternarEditorCodigosPowerShell"]]) {
    assert.match(appHtml, new RegExp(`<button type="button" id="${id}"[^>]*data-on-click="${acao}"`));
  }
  // Enter num campo do editor não pode enviar o formulário do PowerShell.
  const formAberto = appHtml.indexOf('<form class="ck-ps-endpoint__form"');
  assert.ok(formAberto > 0 && appHtml.indexOf("</form>", formAberto) < appHtml.indexOf('id="powershell-codigos-editor"'));
});

test("PowerShell: os códigos só são buscados na primeira abertura do card, em optgroups por modo, sem innerHTML", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  assert.deepEqual(chamadas, []);
  h.run("aoAbrirPowerShellEndpoint()"); // toggle de fechamento: details.open continua falso
  await aguardar();
  assert.deepEqual(chamadas, []);
  await abrirCard(h);
  assert.deepEqual(chamadas, [{ url: URL_CODIGOS, metodo: "GET", corpo: undefined }]);
  await abrirCard(h);
  assert.equal(chamadas.length, 1);
  const [vazio, usuario, sistema, ...resto] = h.element("select-powershell-codigo").children;
  assert.equal(resto.length, 0);
  assert.equal(vazio.value, "");
  assert.equal(usuario.label, "Usuário logado");
  assert.deepEqual(usuario.children.map(o => [o.value, o.textContent]), [["vp_cic", "CIC"], ["vp_umuarama", "Umuarama"]]);
  assert.equal(sistema.label, "SYSTEM");
  const [opcao] = sistema.children;
  assert.equal(opcao.value, "svc");
  assert.equal(opcao.textContent, "Reiniciar <b>spooler</b>"); // texto puro, nunca vira elemento
  assert.equal(opcao.children.length, 0);
  assert.equal(opcao.innerHTML, "");
});

test("PowerShell: só aparece o optgroup do modo que tem itens", async () => {
  const { h } = criarHarnessCodigos({ get: () => apiResponse({ codigos: [CODIGOS[1]] }) });
  await abrirCard(h);
  assert.deepEqual(h.element("select-powershell-codigo").children.map(o => o.label ?? ""), ["", "SYSTEM"]);
});

test("PowerShell: escolher um código preenche comando e modo (SYSTEM ou Usuário logado)", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  await abrirCard(h);
  preencher(h, { comando: "", modo: "usuario" });
  h.element("select-powershell-codigo").value = "svc";
  h.run("aplicarCodigoProntoPowerShell()");
  assert.equal(h.element("input-powershell-comando").value, "Restart-Service Spooler");
  assert.equal(h.element("select-powershell-modo").value, "sistema");
  h.element("select-powershell-codigo").value = "vp_umuarama";
  h.run("aplicarCodigoProntoPowerShell()");
  assert.equal(h.element("input-powershell-comando").value, 'Add-Printer -ConnectionName "\\\\prsrvvm-imp\\VP_UMUARAMA"');
  assert.equal(h.element("select-powershell-modo").value, "usuario");
  await h.run("abrirPowerShellEndpoint()");
  assert.deepEqual(chamadas.at(-1).corpo, { modo: "usuario", comando: 'Add-Printer -ConnectionName "\\\\prsrvvm-imp\\VP_UMUARAMA"', hostname: "PRNOTEUMU005" });
});

test("PowerShell: falha ao carregar os códigos mostra o erro, deixa o select vazio e tenta de novo na próxima abertura", async () => {
  let falhar = true;
  const { h, chamadas } = criarHarnessCodigos({ get: () => (falhar ? apiResponse({ detail: "Arquivo de códigos ocupado." }, { status: 503 }) : apiResponse({ codigos: CODIGOS })) });
  await abrirCard(h);
  assert.match(h.element("endpoint-powershell-result").textContent, /Arquivo de códigos ocupado\./);
  assert.equal(h.element("select-powershell-codigo").children.length, 0); // segue só com a opção vazia do HTML
  await h.run("alternarEditorCodigosPowerShell()"); // sem lista carregada o editor não abre (não sobrescreve a lista salva)
  assert.equal(painelAberto(h), false);
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 0);
  falhar = false;
  await abrirCard(h);
  assert.equal(h.element("select-powershell-codigo").children.length, 3);
});

test("PowerShell: o editor lista os códigos e o PUT leva o que foi adicionado, editado e removido", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  await abrirEditor(h);
  assert.equal(painelAberto(h), true);
  assert.equal(h.element("btn-powershell-codigos-gerenciar").attributes.get("aria-expanded"), "true");
  assert.equal(linhasEditor(h).length, 3);
  assert.equal(achar(linhasEditor(h)[1], "titulo").value, "Reiniciar <b>spooler</b>");
  assert.equal(achar(linhasEditor(h)[1], "modo").value, "sistema");
  assert.equal(achar(linhasEditor(h)[1], "titulo").maxLength, 80);
  assert.equal(achar(linhasEditor(h)[1], "comando").maxLength, 2000);
  achar(linhasEditor(h)[0], "titulo").value = " CIC Novo ";
  achar(linhasEditor(h)[1], "remover").dispatchEvent("click");
  assert.equal(linhasEditor(h).length, 2);
  h.run("adicionarCodigoPowerShell()");
  assert.equal(linhasEditor(h).length, 3);
  const nova = linhasEditor(h)[2];
  assert.equal(achar(nova, "modo").value, "usuario");
  achar(nova, "titulo").value = "Data";
  achar(nova, "modo").value = "sistema";
  achar(nova, "comando").value = "Get-Date";
  await h.run("salvarCodigosPowerShell()");
  assert.equal(h.effects.confirmations.length, 1);
  assert.match(h.effects.confirmations[0], /3 códigos/);
  assert.match(h.effects.confirmations[0], /1 código será removido/);
  const put = chamadas.find(c => c.metodo === "PUT");
  assert.deepEqual(put.corpo, { codigos: [
    { id: "vp_cic", titulo: "CIC Novo", modo: "usuario", comando: CODIGOS[0].comando },
    { id: "vp_umuarama", titulo: "Umuarama", modo: "usuario", comando: CODIGOS[2].comando },
    { titulo: "Data", modo: "sistema", comando: "Get-Date" }, // novo: sem id
  ] });
  assert.equal(painelAberto(h), false);
  assert.equal(h.element("btn-powershell-codigos-gerenciar").attributes.get("aria-expanded"), "false");
  assert.equal(h.element("endpoint-powershell-result").textContent, "Lista de códigos salva.");
  assert.equal(h.element("btn-powershell-codigos-salvar").disabled, false);
  const [, usuario, sistema] = h.element("select-powershell-codigo").children; // select refeito com a resposta do servidor
  assert.deepEqual(usuario.children.map(o => o.textContent), ["CIC Novo", "Umuarama"]);
  assert.deepEqual(sistema.children.map(o => [o.value, o.textContent]), [["novo2", "Data"]]);
});

test("PowerShell: o editor bloqueia título vazio, comando vazio e quebra de linha sem confirmar nem chamar a API", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  await abrirEditor(h);
  const status = () => h.element("powershell-codigos-status").textContent;
  const linha = () => linhasEditor(h)[0];
  achar(linha(), "titulo").value = "   ";
  await h.run("salvarCodigosPowerShell()");
  assert.equal(status(), "Informe o título de cada código.");
  achar(linha(), "titulo").value = "CIC";
  for (const comando of ["a\nb", "a\r\nb", "a\rb"]) {
    achar(linha(), "comando").value = comando;
    await h.run("salvarCodigosPowerShell()");
    assert.equal(status(), "O comando não pode ter quebra de linha.");
  }
  achar(linha(), "comando").value = "  ";
  await h.run("salvarCodigosPowerShell()");
  assert.equal(status(), "Informe o comando de cada código.");
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 0);
  assert.deepEqual(h.effects.confirmations, []);
  assert.equal(painelAberto(h), true);
});

test("PowerShell: erro do PUT mostra o detail e mantém o painel com as edições; Cancelar descarta", async () => {
  const { h, chamadas } = criarHarnessCodigos({ put: () => apiResponse({ detail: "O título deve ter de 1 a 80 caracteres." }, { status: 422 }) });
  await abrirEditor(h);
  achar(linhasEditor(h)[0], "titulo").value = "Editado";
  await h.run("salvarCodigosPowerShell()");
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 1);
  assert.match(h.element("powershell-codigos-status").textContent, /O título deve ter de 1 a 80 caracteres\./);
  assert.equal(painelAberto(h), true);
  assert.equal(achar(linhasEditor(h)[0], "titulo").value, "Editado");
  assert.equal(h.element("btn-powershell-codigos-salvar").disabled, false);
  assert.equal(h.element("select-powershell-codigo").children[1].children[0].textContent, "CIC"); // select intacto
  await h.run("alternarEditorCodigosPowerShell()"); // Cancelar
  assert.equal(painelAberto(h), false);
  await h.run("alternarEditorCodigosPowerShell()");
  assert.equal(achar(linhasEditor(h)[0], "titulo").value, "CIC");
});

test("PowerShell: cancelar a confirmação do editor não chama a API e mantém o painel", async () => {
  const { h, chamadas } = criarHarnessCodigos({ confirmResult: false });
  await abrirEditor(h);
  await h.run("salvarCodigosPowerShell()");
  assert.equal(h.effects.confirmations.length, 1);
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 0);
  assert.equal(painelAberto(h), true);
  assert.equal(h.element("btn-powershell-codigos-salvar").disabled, false);
});

test("PowerShell: abrir o editor relê a lista do servidor (outra aba pode ter salvo)", async () => {
  let lista = CODIGOS;
  const { h, chamadas } = criarHarnessCodigos({ get: () => apiResponse({ codigos: lista }) });
  await abrirCard(h);
  lista = [CODIGOS[1]];
  await h.run("alternarEditorCodigosPowerShell()");
  assert.equal(chamadas.filter(c => c.metodo === "GET").length, 2);
  assert.equal(linhasEditor(h).length, 1);
  assert.equal(achar(linhasEditor(h)[0], "titulo").value, "Reiniciar <b>spooler</b>");
  assert.deepEqual(h.element("select-powershell-codigo").children.map(o => o.label ?? ""), ["", "SYSTEM"]);
});

test("PowerShell: clique duplo em Salvar lista abre uma só confirmação e manda um só PUT", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  await abrirEditor(h);
  await Promise.all([h.run("salvarCodigosPowerShell()"), h.run("salvarCodigosPowerShell()")]);
  assert.equal(h.effects.confirmations.length, 1);
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 1);
});

test("PowerShell: o editor recusa Add-Printer -ConnectionName (ou abreviado) no modo SYSTEM", async () => {
  const { h, chamadas } = criarHarnessCodigos();
  await abrirEditor(h);
  const linha = linhasEditor(h)[0];
  achar(linha, "modo").value = "sistema";
  for (const comando of [CODIGOS[0].comando, "add-printer -conn \\\\srv\\fila"]) {
    achar(linha, "comando").value = comando;
    await h.run("salvarCodigosPowerShell()");
    assert.equal(h.element("powershell-codigos-status").textContent, "Adicionar impressora de rede só funciona no modo Usuário logado. Ajuste o modo do código.");
  }
  assert.deepEqual(h.effects.confirmations, []);
  assert.equal(chamadas.filter(c => c.metodo === "PUT").length, 0);
});

test("PowerShell: Add-Printer -ConnectionName no modo SYSTEM é bloqueado sem confirmar nem chamar a API", async () => {
  let fetched = 0;
  const h = createAppHarness(() => { fetched += 1; return apiResponse({}); });
  for (const comando of ['Add-Printer -ConnectionName "\\\\prsrvvm-imp\\VP_CIC"', "  add-printer   -connectionname \\\\srv\\fila", "Add-Printer -Con \\\\srv\\fila"]) {
    preencher(h, { comando, modo: "sistema" });
    await h.run("abrirPowerShellEndpoint()");
    assert.match(h.element("endpoint-powershell-result").textContent, /só funciona no modo Usuário logado/);
  }
  assert.equal(fetched, 0);
  assert.deepEqual(h.effects.confirmations, []);
});

test("PowerShell: Add-Printer sem -ConnectionName no modo SYSTEM segue para a confirmação", async () => {
  let fetched = 0;
  const h = createAppHarness(() => { fetched += 1; return apiResponse({}); }, { confirmResult: false });
  preencher(h, { comando: "Add-Printer -Name X -DriverName Y -PortName Z", modo: "sistema" });
  await h.run("abrirPowerShellEndpoint()");
  assert.equal(h.effects.confirmations.length, 1);
  assert.match(h.effects.confirmations[0], /Add-Printer -Name X -DriverName Y -PortName Z/);
  assert.equal(fetched, 0);
  assert.equal(h.element("endpoint-powershell-result").textContent, "");
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
