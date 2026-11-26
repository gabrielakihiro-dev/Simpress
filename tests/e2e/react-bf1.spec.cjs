// Bloco final 1 (BF1): pesquisa de equipamento, formulário de transferência, contatos regionais, edição do equipamento
// e histórico de apelidos (frontend/src/aplicacao/{pontes,alias-history}.ts).
// Baselines gravados com o código antigo. Todo /api/* é simulado aqui, com dados sintéticos: nenhum teste chega ao
// backend real. A versão em React tem de passar este arquivo sem mudanças; por isso só vale o que o usuário vê e as
// chamadas de rede, nunca detalhes internos do código.
//
// Fotos: Home com equipamento, autocomplete, edição em linha, seção Endpoint/PowerShell, aba Transferência, texto para
// transporte e diálogo do representante regional (claro e escuro, desktop e celular). O diálogo de pré-visualização
// (modal-preview) não tem botão que o abra e fica de fora.
// Comportamento (só no desktop): PowerShell nunca envia Enter, consulta ao Endpoint, geração da planilha, edição em
// linha, nome da pessoa e usuário manual, contatos regionais, corrida de filtros da Home e histórico de apelidos.
const { test, expect } = require("@playwright/test");
const { abrirEtapaTransporte } = require("./support/etapas-transporte.cjs");

const TIPOS = ["Notebook", "Monitor", "Micro Computador"];
const resumoBase = n => ({
  serial: `BRJ000${n}`, tipo: TIPOS[n % 3], modelo: `Modelo de teste ${n}`, apelido: `PRTESTE00${n}`, idCliente: "",
  retirada_cidade: "Curitiba", retirada_cnpj: "00.000.000/0001-00", retirada_cep: "80000-000",
  retirada_endereco: "Rua Exemplo, 100 - Centro, Curitiba/PR", descricao_sugerida: `Equipamento de teste ${n}`,
  usuarios_logados: `usuario.teste${n}`, usuarios_logados_origem: "endpoint", nome_pessoa: "", nome_pessoa_editavel: false,
});
const equipamentosBase = () => ({
  BRJ0001: { ...resumoBase(1), idCliente: "Obs de teste", nome_pessoa: "Pessoa de Teste Um", nome_pessoa_origem: "base", nome_pessoa_editavel: true },
  BRJ0002: { ...resumoBase(2), retirada_cidade: "Londrina", nome_pessoa_editavel: true },
  BRJ0003: { ...resumoBase(3), apelido: "", usuarios_logados: "", usuarios_logados_origem: "" },
  BRJ0004: { ...resumoBase(4) },
  BRJ0005: { ...resumoBase(5), usuarios_logados: "", usuarios_logados_origem: "" },
  BRJ0006: { ...resumoBase(6) },
});
const itemDaLista = eq => ({
  serial: eq.serial, tipo: eq.tipo, modelo: eq.modelo, apelido: eq.apelido, retirada_cidade: eq.retirada_cidade,
  ...(eq.usuarios_logados ? { usuarios_logados: eq.usuarios_logados, usuarios_logados_origem: eq.usuarios_logados_origem } : {}),
});
const FILTROS = { categories: [{ value: "notebook", label: "Notebooks", count: 6 }], cities: ["Curitiba", "Londrina", "Maringá"], users: { sem: 2, com: 4 } };

const UNIDADES = [
  { id: "unidade-curitiba", cidade: "Curitiba", cnpj: "00.000.000/0001-00", endereco: "Rua Exemplo, 100", endereco_completo: "Rua Exemplo, 100 - Centro, Curitiba/PR", cep: "80000-000", label: "Curitiba - Sede (Rua Exemplo, 100)", is_sede: true },
  { id: "unidade-londrina", cidade: "Londrina", cnpj: "00.000.000/0003-62", endereco: "Rua Fictícia, 300", endereco_completo: "Rua Fictícia, 300 - Centro, Londrina/PR", cep: "86000-000", label: "Londrina (Rua Fictícia, 300)", is_sede: false },
  { id: "unidade-maringa", cidade: "Maringá", cnpj: "00.000.000/0002-81", endereco: "Avenida Teste, 200", endereco_completo: "Avenida Teste, 200 - Centro, Maringá/PR", cep: "87000-000", label: "Maringá (Avenida Teste, 200)", is_sede: false },
];
const PADROES = [
  { cidade: "Curitiba", nome: "Carla Teste de Curitiba", email: "carla.teste@exemplo.invalid", telefone: "(41) 90000-0001", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
  { cidade: "Londrina", nome: "Rita Teste de Londrina", email: "rita.teste@exemplo.invalid", telefone: "(43) 90000-0002", horario: "08:00:00 às 18:00:00", almoco: "Escritório não fecha", pausaDuracao: "" },
  { cidade: "Maringá", nome: "Tereza Teste de Maringá", email: "tereza.teste@exemplo.invalid", telefone: "(44) 90000-0003", horario: "09:00:00 às 17:00:00", almoco: "12:00:00", pausaDuracao: "1h" },
];
const eventosBase = () => [
  { id: "ev-apelido-1", horario: "2026-10-20T12:00:00-03:00", tipo: "apelido", serial: "BRJ0001", equipamento: "Notebook de teste", acao: "alteracao", apelido_anterior: "PRANTIGO001", apelido_novo: "PRTESTE001" },
  { id: "ev-aviso-1", horario: "2026-10-19T12:00:00-03:00", tipo: "aviso_endpoint", serial: "BRJ0002", equipamento: "Notebook de teste", acao: "alteracao", motivo: "usuario_removido" },
];

const criarPortao = () => { let liberar; const promessa = new Promise(resolve => { liberar = resolve; }); return { promessa, liberar }; };
// A resposta pode chegar a uma requisição que a página já abortou (troca de equipamento): isso não é falha do teste.
const responder = async (route, opcoes) => { try { await route.fulfill(opcoes); } catch (erro) { /* requisição abortada pela página */ } };

// Cada `portao` é uma promessa que o teste cria com `ambiente.segurar(nome)` e libera quando quiser: só a primeira
// requisição seguinte daquele nome espera (resposta atrasada). Nomes: consultar, salvar, semUsuario, planilha, powershell.
async function preparar(page, { tema = "light" } = {}) {
  const ambiente = {
    chamadas: [], portoes: {}, equipamentos: equipamentosBase(), eventos: eventosBase(),
    alteracoesRegionais: {}, consulta: { status: "found", serial: "BRJ0001", ultimo_logon: "usuario.endpoint1" },
  };
  ambiente.segurar = nome => { ambiente.portoes[nome] = criarPortao(); return ambiente.portoes[nome]; };
  const passar = async nome => {
    const portao = ambiente.portoes[nome];
    if (!portao) return;
    ambiente.portoes[nome] = null;
    await portao.promessa;
  };
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  page.on("request", requisicao => {
    const url = new URL(requisicao.url());
    if (url.pathname.startsWith("/api/")) ambiente.chamadas.push({ metodo: requisicao.method(), caminho: url.pathname, busca: url.searchParams, corpo: requisicao.postData() });
  });
  const modelo = serial => ambiente.equipamentos[String(serial).toUpperCase()];
  const filtrar = termo => Object.values(ambiente.equipamentos).filter(eq => eq.serial.includes(String(termo || "").toUpperCase()));

  await page.route("**/api/unidades", route => responder(route, { json: UNIDADES }));
  await page.route("**/api/config/transferencia", route => responder(route, { json: {
    retirada_contato: "Contato de Origem Teste", retirada_email: "origem.teste@exemplo.invalid", retirada_telefone: "(41) 90000-0009",
    contato_origem_configurado: true, contato_origem_fontes: { retirada_contato: "arquivo", retirada_email: "arquivo", retirada_telefone: "arquivo" },
    contato_origem_arquivo_invalido: false, contrato: "000000/2026", cnpj_faturamento: "00.000.000/0001-00",
    cliente_configurado: true, modelo_transferencia_disponivel: true,
  } }));
  await page.route("**/api/config/cliente", route => responder(route, { json: {
    contrato: "000000/2026", cnpj_faturamento: "00.000.000/0001-00", series_sebrae_fora: [], cliente_configurado: true,
    cliente_fontes: { contrato: "arquivo", cnpj_faturamento: "arquivo", series_sebrae_fora: "arquivo" }, cliente_arquivo_invalido: false,
  } }));
  await page.route("**/api/config/representantes-regionais", route => responder(route, { json: {
    alteracoes: ambiente.alteracoesRegionais, arquivo_invalido: false, padroes: PADROES, padroes_arquivo_invalido: false,
  } }));
  await page.route("**/api/config/representantes-regionais/*", route => {
    const requisicao = route.request();
    const cidade = decodeURIComponent(new URL(requisicao.url()).pathname.split("/").pop());
    if (requisicao.method() === "PUT") ambiente.alteracoesRegionais[cidade] = requisicao.postDataJSON();
    else if (requisicao.method() === "DELETE") delete ambiente.alteracoesRegionais[cidade];
    return responder(route, { json: { alteracoes: ambiente.alteracoesRegionais, arquivo_invalido: false } });
  });

  await page.route("**/api/buscar-expandida*", async route => {
    const busca = new URL(route.request().url()).searchParams;
    const termo = busca.get("q") || "";
    if (busca.get("usuario") === "sem") {
      await passar("semUsuario");
      const itens = filtrar(termo).filter(eq => !eq.usuarios_logados).map(itemDaLista);
      return responder(route, { json: { items: itens, total: itens.length, offset: 0, limit: 50, has_more: false, filters: FILTROS } });
    }
    const itens = filtrar(termo).map(itemDaLista);
    return responder(route, { json: { items: itens, total: itens.length, offset: 0, limit: Number(busca.get("limit")) || 50, has_more: false, filters: FILTROS } });
  });
  await page.route("**/api/equipamento/*", async route => {
    const requisicao = route.request();
    const ultimo = decodeURIComponent(new URL(requisicao.url()).pathname.split("/").pop());
    if (requisicao.method() === "GET") {
      const eq = modelo(ultimo);
      return responder(route, eq ? { json: { ...eq } } : { status: 404, json: { detail: "Equipamento não encontrado" } });
    }
    const corpo = requisicao.postDataJSON();
    const eq = modelo(corpo.serial);
    if (ultimo === "atualizar-apelido") {
      await passar("salvar");
      eq.apelido = corpo.apelido;
    } else if (ultimo === "atualizar-usuario") {
      await passar("salvar");
      Object.assign(eq, { usuarios_logados: corpo.usuario, usuarios_logados_origem: corpo.usuario ? "manual" : "" });
    } else if (ultimo === "nome-pessoa") {
      await passar("salvar");
      Object.assign(eq, { nome_pessoa: corpo.nome, nome_pessoa_origem: corpo.nome ? "manual" : "" });
      return responder(route, { json: { equipamento: { ...eq }, base_atualizada: true } });
    } else return responder(route, { status: 404, json: { detail: "Rota fora do previsto no teste" } });
    return responder(route, { json: { equipamento: { ...eq } } });
  });
  await page.route("**/api/equipamento/apelido/desfazer", route => {
    const { evento_id: id } = route.request().postDataJSON();
    const evento = ambiente.eventos.find(item => item.id === id);
    const eq = modelo(evento.serial);
    eq.apelido = evento.apelido_anterior;
    return responder(route, { json: { equipamento: { ...eq } } });
  });
  await page.route("**/api/endpoint/consultar", async route => {
    await passar("consultar");
    return responder(route, { json: { ...ambiente.consulta } });
  });
  await page.route("**/api/endpoint/powershell/codigos", route => responder(route, { json: { codigos: [{ id: "demo", titulo: "Listar serviços", modo: "sistema", comando: "Get-Service" }] } }));
  await page.route("**/api/endpoint/powershell", async route => {
    await passar("powershell");
    return responder(route, { json: { status: "inserido", hostname: "PRTESTE001", modo: "sistema", usuario: "", enter_enviado: false } });
  });
  await page.route("**/api/historico-alteracoes", route => responder(route, { json: { eventos: ambiente.eventos, total: ambiente.eventos.length } }));
  await page.route("**/api/historico-alteracoes/*", route => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop());
    const evento = ambiente.eventos.find(item => item.id === id);
    ambiente.eventos = ambiente.eventos.filter(item => item.id !== id);
    return responder(route, { json: { sucesso: true, evento_id: id, tipo: evento?.tipo || "apelido" } });
  });
  await page.route("**/api/gerar-planilha", async route => {
    await passar("planilha");
    return responder(route, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="Transferencia_BRJ0001_teste.xlsx"',
      },
      body: Buffer.from("PK\u0003\u0004conteudo-de-teste"),
    });
  });

  // Depois da planilha o código antigo registra o histórico de transferências e abre o diálogo do ticket UX, que só
  // PREPARA o ticket. Nada é enviado: o teste confere que a rota `/enviar` nunca é chamada.
  await page.route("**/api/historico-transferencias", route => responder(route, { json: { sucesso: true } }));
  await page.route("**/api/ux/gerar-ticket/*", route => {
    const rota = new URL(route.request().url()).pathname.split("/").pop();
    if (rota === "solicitante") return responder(route, { json: { nome: "Solicitante de Teste", email: "solicitante@exemplo.invalid", telefone: "" } });
    if (rota === "preparar") {
      return responder(route, { json: {
        session_id: "sessao-teste", serial: "BRJ0001", modelo: "Modelo de teste 1", endereco: "Avenida Teste, 200",
        cnpj_faturamento: "00.000.000/0001-00", arquivo: "Transferencia_BRJ0001_teste.xlsx", solicitante: { nome: "", email: "", telefone: "" },
      } });
    }
    return responder(route, { json: {} });
  });

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  return ambiente;
}

async function buscar(page, serial) {
  await page.locator("#input-serial").fill(serial);
  await page.locator("#btn-buscar-serial").click();
  await expect(page.locator("#card-serial")).toHaveText(serial);
}

// Troca a seleção como outro fluxo da página faria enquanto uma resposta ainda não chegou.
async function trocarSelecao(page, serial) {
  await page.evaluate(valor => { document.getElementById("input-serial").value = valor; return window.buscarSerial(); }, serial);
  await expect(page.locator("#card-serial")).toHaveText(serial);
}

async function abrirTransferencia(page) {
  const botaoMenu = page.locator("#btn-sidebar-open");
  const casca = page.locator("#simpress-app-shell");
  if (await botaoMenu.isVisible() && await casca.getAttribute("data-sidebar-open") !== "true") {
    await botaoMenu.click();
    await expect(casca).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-retirada-entrega").click();
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
  // Retirada e Entrega são etapas recolhíveis: campo de etapa fechada não recebe clique nem preenchimento.
  await abrirEtapaTransporte(page, 2, 3);
}

const esperarToast = (page, texto) => expect(page.locator("#toast-container .ck-toast", { hasText: texto })).toBeVisible();
const escritas = ambiente => ambiente.chamadas.filter(chamada => chamada.metodo !== "GET");
const chamadasDe = (ambiente, metodo, caminho) => ambiente.chamadas.filter(chamada => chamada.metodo === metodo && chamada.caminho === caminho);
const corpoDe = chamada => JSON.parse(chamada.corpo);
const confirmar = page => page.locator("#btn-confirmar-acao-ok").click();
const cancelar = page => page.locator("#btn-confirmar-acao-cancelar").click();

const foto = { animations: "disabled", maxDiffPixelRatio: 0.01 };
// O aviso de sucesso ou erro (canto da tela) não faz parte da foto. A CSP da página (style-src 'self') bloqueia
// <style> injetado; mudar `style` pelo CSSOM é permitido.
async function fotografar(page, seletor, nome) {
  await page.evaluate(() => { document.getElementById("toast-container").style.display = "none"; });
  await page.mouse.move(0, 0);
  await expect(page.locator(seletor)).toHaveScreenshot(nome, foto);
}

for (const tema of ["light", "dark"]) {
  test(`baseline: autocomplete, Home com equipamento, Endpoint e edição em linha, tema ${tema}`, async ({ page }) => {
    test.setTimeout(60_000);
    const ambiente = await preparar(page, { tema });
    await page.locator("#input-serial").fill("BRJ");
    await expect(page.locator("#autocomplete-list .autocomplete-row")).toHaveCount(6);
    await fotografar(page, "#autocomplete-box", `autocomplete-aberto-${tema}.png`);

    await page.keyboard.press("Escape");
    await buscar(page, "BRJ0001");
    await expect(page.locator("#home-equipment-list")).toHaveAttribute("aria-busy", "false");
    await fotografar(page, "#tab-panel-home .ck-home", `home-equipamento-${tema}.png`);

    await page.locator("#btn-consultar-endpoint").click();
    await expect(page.locator("#endpoint-lookup-result")).toHaveText("Usuário do último logon: usuario.endpoint1");
    await fotografar(page, '[aria-labelledby="home-acoes-endpoint"]', `endpoint-powershell-${tema}.png`);
    await fotografar(page, "#endpoint-powershell", `powershell-endpoint-${tema}.png`);

    await page.locator("#btn-editar-equipamento").click();
    await expect(page.locator("#form-editar-equipamento")).toBeVisible();
    await fotografar(page, "#card-equipamento .nlh-ident", `edicao-em-linha-${tema}.png`);
    expect(escritas(ambiente).filter(chamada => chamada.caminho !== "/api/endpoint/consultar")).toEqual([]);
  });

  test(`baseline: transferência, texto para transporte e representante regional, tema ${tema}`, async ({ page }) => {
    test.setTimeout(60_000);
    await preparar(page, { tema });
    await buscar(page, "BRJ0001");
    await abrirTransferencia(page);
    await page.locator("#select-unidade-destino").selectOption("unidade-maringa");
    await expect(page.locator("#entrega-cnpj")).toHaveText("00.000.000/0002-81");
    await expect(page.locator("#entrega-contato")).toHaveValue("Tereza Teste de Maringá");
    await fotografar(page, "#tab-panel-retirada-entrega", `transferencia-destino-escolhido-${tema}.png`);

    await page.locator('[data-on-click="gerarTextoSolicitacaoTransporte"]').first().click();
    await expect(page.locator("#modal-texto-transporte")).toBeVisible();
    await expect(page.locator("#textarea-texto-transporte")).not.toHaveValue("");
    await fotografar(page, "#modal-texto-transporte .ck-dialogo", `texto-transporte-${tema}.png`);
    await page.locator('#modal-texto-transporte [data-on-click="fecharModalTextoTransporte"]').first().click();
    await expect(page.locator("#modal-texto-transporte")).toBeHidden();

    await page.locator("#btn-editar-representante-entrega").click();
    await expect(page.locator("#modal-representante-regional")).toBeVisible();
    await expect(page.locator("#representante-regional-nome")).toHaveValue("Tereza Teste de Maringá");
    await fotografar(page, "#modal-representante-regional .ck-dialogo", `representante-regional-${tema}.png`);
  });
}

test.describe("comportamento (só no desktop)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "o comportamento é igual no celular; as fotos cobrem o layout");
  test.describe.configure({ timeout: 40_000 });

  test("PowerShell: o aviso nunca promete Enter e nada é enviado sem confirmar", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await expect(page.locator("#endpoint-powershell")).toContainText("Nunca envia Enter");
    await expect(page.locator("#input-powershell-hostname")).toHaveValue("PRTESTE001");

    await page.locator("#input-powershell-comando").fill("Get-Service");
    await page.locator("#btn-powershell-endpoint").click();
    await expect(page.locator("#modal-confirmar-acao")).toBeVisible();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Inserir comando no PowerShell");
    await expect(page.locator("#mensagem-confirmar-acao")).toContainText("NÃO será executado");
    await cancelar(page);
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    expect(chamadasDe(ambiente, "POST", "/api/endpoint/powershell")).toHaveLength(0);

    await page.locator("#btn-powershell-endpoint").click();
    await confirmar(page);
    const resultado = page.locator("#endpoint-powershell-result");
    await expect(resultado).toContainText("NÃO foi executado");
    await expect(resultado).toContainText("Computador: PRTESTE001");
    await expect(resultado).not.toHaveText(/(?<!NÃO )foi executado/);
    const envios = chamadasDe(ambiente, "POST", "/api/endpoint/powershell");
    expect(envios).toHaveLength(1);
    const corpo = corpoDe(envios[0]);
    expect(Object.keys(corpo).sort()).toEqual(["comando", "hostname", "modo"]);
    expect(corpo).toEqual({ modo: "sistema", comando: "Get-Service", hostname: "PRTESTE001" });
  });

  test("Home: contadores, Restaurar modelo, modo segmentado e Ver inteiro só mexem na tela, sem enviar nada", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");

    const area = page.locator(".ck-chamado__painel:not([hidden]) textarea");
    const modelo = await area.inputValue();
    await expect(page.locator("#nlh-chamado-contador")).toHaveText(`${modelo.length} / 2500`);
    await area.fill("Texto novo");
    await expect(page.locator("#nlh-chamado-contador")).toHaveText("10 / 2500");
    await page.locator("#btn-restaurar-chamado").click();
    await expect(area).toHaveValue(modelo);
    await expect(page.locator("#nlh-chamado-contador")).toHaveText(`${modelo.length} / 2500`);

    const comando = page.locator("#input-powershell-comando");
    await comando.fill("Get-Service");
    await expect(page.locator("#nlh-ps-contador")).toHaveText("11 / 2000");
    const sistema = page.locator("#btn-ps-modo-sistema");
    const usuario = page.locator("#btn-ps-modo-usuario");
    await expect(sistema).toHaveAttribute("aria-pressed", "true");
    await usuario.click();
    await expect(usuario).toHaveAttribute("aria-pressed", "true");
    await expect(sistema).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#select-powershell-modo")).toHaveValue("usuario");
    await sistema.click();
    await expect(page.locator("#select-powershell-modo")).toHaveValue("sistema");

    const inteiro = page.locator("#btn-ps-ver-inteiro");
    await expect(inteiro).toHaveAttribute("aria-expanded", "false");
    await inteiro.click();
    await expect(page.locator("#ps-editor")).toBeVisible();
    await expect(inteiro).toHaveAttribute("aria-expanded", "true");
    await page.locator("#btn-ps-editor-fechar").click();
    await expect(page.locator("#ps-editor")).toBeHidden();
    await expect(inteiro).toHaveAttribute("aria-expanded", "false");

    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Home: Chamado manual carrega o padrão salvo, renomeia a aba e salva nome e texto como padrão", async ({ page }) => {
    const salvos = [];
    await page.route("**/api/modelos-chamado", route => responder(route, { json: { modelos: { "teclado-mouse": { rotulo: "Kit periféricos", texto: "Texto salvo de teste" } } } }));
    await page.route("**/api/modelos-chamado/*", route => {
      salvos.push({ slug: route.request().url().split("/").pop(), corpo: route.request().postDataJSON() });
      return responder(route, { json: { modelos: {} } });
    });
    await preparar(page);
    await buscar(page, "BRJ0001");

    await expect(page.getByRole("tab", { name: "Kit periféricos" })).toBeVisible();
    await page.getByRole("tab", { name: "Kit periféricos" }).click();
    await expect(page.locator("#texto-chamado-teclado-mouse")).toHaveValue("Texto salvo de teste");

    await page.getByRole("tab", { name: "Deslocamento" }).click();
    const salvar = page.locator("#btn-salvar-padrao-chamado");
    await expect(salvar).toBeDisabled();
    await page.locator("#btn-renomear-chamado").click();
    await page.locator("#input-rotulo-chamado").fill("Visita técnica");
    await page.locator("#input-rotulo-chamado").press("Enter");
    await expect(page.getByRole("tab", { name: "Visita técnica" })).toHaveAttribute("aria-selected", "true");
    await expect(salvar).toBeEnabled();

    await page.locator("#btn-restaurar-chamado").click();
    await expect(page.getByRole("tab", { name: "Deslocamento" })).toBeVisible();
    await expect(salvar).toBeDisabled();

    await page.locator("#btn-renomear-chamado").click();
    await page.locator("#input-rotulo-chamado").fill("Visita técnica");
    await page.locator("#btn-renomear-ok").click();
    await page.locator("#texto-chamado-deslocamento").fill("Novo texto padrão");
    await salvar.click();
    await esperarToast(page, "Modelo salvo como padrão.");
    expect(salvos).toEqual([{ slug: "deslocamento", corpo: { rotulo: "Visita técnica", texto: "Novo texto padrão" } }]);
    await expect(salvar).toBeDisabled();
    await page.locator("#texto-chamado-deslocamento").fill("Outro");
    await page.locator("#btn-restaurar-chamado").click();
    await expect(page.locator("#texto-chamado-deslocamento")).toHaveValue("Novo texto padrão");
  });

  test("PowerShell: o editor do comando abre vazio, descarta ao cancelar e insere pelo mesmo envio, sem Enter", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    const inteiro = page.locator("#btn-ps-ver-inteiro");
    const editor = page.locator("#ps-editor");
    const texto = page.locator("#ps-editor-texto");
    const campo = page.locator("#input-powershell-comando");

    // Vazio também abre; Enter não cria linha; contador e linhas acompanham.
    await inteiro.click();
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute("aria-label", "Editor do comando");
    await expect(texto).toBeFocused();
    await expect(texto).toHaveValue("");
    await expect(page.locator("#ps-editor-contador")).toHaveText("0 / 2000");
    await expect(page.locator("#ps-editor-total-linhas")).toHaveText("1 linha");
    await expect(page.locator("#ps-editor-hostname")).toHaveText("PRTESTE001");
    await texto.pressSequentially("Get-Service");
    await texto.press("Enter");
    await expect(texto).toHaveValue("Get-Service");
    await expect(page.locator("#ps-editor-contador")).toHaveText("11 / 2000");
    const longo = `Get-ChildItem -Path 'C:\\Users' -Directory | ${"Select-Object Name, LastWriteTime | ".repeat(12)}Format-Table -AutoSize`;
    await texto.fill(longo);
    const linhas = Number((await page.locator("#ps-editor-total-linhas").textContent()).split(" ")[0]);
    expect(linhas).toBeGreaterThan(1);
    await expect(page.locator("#ps-editor-linhas")).toHaveText(Array.from({ length: linhas }, (_, i) => i + 1).join("\n"));

    // Cancelar e Esc descartam e devolvem o foco ao "Ver inteiro".
    await page.locator("#btn-ps-editor-cancelar").click();
    await expect(editor).toBeHidden();
    await expect(campo).toHaveValue("");
    await expect(inteiro).toBeFocused();
    await campo.fill("ipconfig");
    await inteiro.click();
    await expect(texto).toHaveValue("ipconfig");
    await texto.fill("ipconfig /all");
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await expect(campo).toHaveValue("ipconfig");
    await expect(inteiro).toHaveAttribute("aria-expanded", "false");

    // Quebra de linha colada é recusada no editor, sem fechar nem enviar.
    await inteiro.click();
    await texto.fill("a\nb");
    await page.locator("#btn-ps-editor-inserir").click();
    await expect(page.locator("#ps-editor-aviso")).toHaveText("O comando não pode ter quebra de linha.");
    await expect(editor).toBeVisible();

    // Segmento do editor muda o modo do cartão; Inserir grava, confirma e faz um único POST.
    await texto.fill("Get-Service");
    await editor.locator('.nlh-segmento__op[data-modo="usuario"]').click();
    await expect(page.locator("#select-powershell-modo")).toHaveValue("usuario");
    await editor.locator('.nlh-segmento__op[data-modo="sistema"]').click();
    await page.locator("#btn-ps-editor-inserir").click();
    await expect(editor).toBeHidden();
    await expect(campo).toHaveValue("Get-Service");
    await expect(page.locator("#modal-confirmar-acao")).toBeVisible();
    await confirmar(page);
    await expect(page.locator("#endpoint-powershell-result")).toContainText("NÃO foi executado");
    const envios = chamadasDe(ambiente, "POST", "/api/endpoint/powershell");
    expect(envios).toHaveLength(1);
    expect(corpoDe(envios[0])).toEqual({ modo: "sistema", comando: "Get-Service", hostname: "PRTESTE001" });
  });

  test("PowerShell: no celular o editor é folha inferior, sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await page.locator("#btn-ps-ver-inteiro").click();
    const caixa = page.locator("#ps-editor .nlh-editor__caixa");
    await expect(caixa).toBeVisible();
    const box = await caixa.boundingBox();
    expect(Math.round(box.y + box.height)).toBe(812);
    expect(Math.round(box.width)).toBe(375);
    expect(await caixa.evaluate(el => getComputedStyle(el).borderTopLeftRadius)).toBe("24px");
    expect(await page.locator("#ps-editor-texto").evaluate(el => el.getBoundingClientRect().height)).toBe(236);
    const [cancelar, inserir] = await Promise.all(["#btn-ps-editor-cancelar", "#btn-ps-editor-inserir"].map(s => page.locator(s).boundingBox()));
    expect(Math.round(cancelar.y)).toBe(Math.round(inserir.y));
    expect(await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)).toBe(true);
    await page.locator("#btn-ps-editor-cancelar").click();
    expect(escritas(ambiente)).toEqual([]);
  });

  test("PowerShell: comando vazio, quebra de linha, Enter no campo e hostname ausente não enviam nada", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    const resultado = page.locator("#endpoint-powershell-result");
    const comando = page.locator("#input-powershell-comando");
    const enviar = page.locator("#btn-powershell-endpoint");

    await enviar.click();
    await expect(resultado).toHaveText("Informe o comando.");
    await comando.fill("Get-Service\nGet-Process");
    await enviar.click();
    await expect(resultado).toHaveText("O comando não pode ter quebra de linha.");
    await comando.fill("Get-Service");
    await comando.press("Enter");
    await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
    await expect(comando).toHaveValue("Get-Service\n");
    await comando.fill("Add-Printer -ConnectionName \\\\servidor\\impressora");
    await enviar.click();
    await expect(resultado).toContainText("só funciona no modo Usuário logado");
    expect(escritas(ambiente)).toEqual([]);

    // Caractere de controle (BEL): o código antigo não o recusa no navegador, a recusa é do servidor. Só chega ao diálogo
    // de confirmação, e sem confirmar nada é enviado.
    await comando.fill("Get-Service\u0007");
    await enviar.click();
    await expect(page.locator("#modal-confirmar-acao")).toBeVisible();
    await cancelar(page);
    expect(escritas(ambiente)).toEqual([]);

    await trocarSelecao(page, "BRJ0003");
    await expect(page.locator("#input-powershell-hostname")).toHaveValue("");
    await comando.fill("Get-Service");
    await enviar.click();
    await expect(resultado).toHaveText("Informe o hostname.");
    expect(escritas(ambiente)).toEqual([]);
  });

  test("Endpoint: consulta uma vez e descarta resposta atrasada de outro equipamento", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await page.locator("#btn-consultar-endpoint").click();
    await expect(page.locator("#endpoint-lookup-result")).toHaveText("Usuário do último logon: usuario.endpoint1");
    const consultas = chamadasDe(ambiente, "POST", "/api/endpoint/consultar");
    expect(consultas).toHaveLength(1);
    expect(corpoDe(consultas[0])).toEqual({ serial: "BRJ0001" });

    const portao = ambiente.segurar("consultar");
    ambiente.consulta = { status: "found", serial: "BRJ0001", ultimo_logon: "usuario.atrasado" };
    await page.locator("#btn-consultar-endpoint").click();
    await expect(page.locator("#endpoint-lookup-result")).toContainText("Consultando no Endpoint");
    await expect.poll(() => chamadasDe(ambiente, "POST", "/api/endpoint/consultar").length).toBe(2);
    await trocarSelecao(page, "BRJ0002");
    portao.liberar();
    await page.waitForTimeout(300);
    await expect(page.locator("#endpoint-lookup-result")).toHaveText("");
    await expect(page.locator("#btn-consultar-endpoint")).toBeEnabled();
    expect(chamadasDe(ambiente, "POST", "/api/endpoint/consultar")).toHaveLength(2);
  });

  test("Transferência: sem campos obrigatórios não gera planilha; completa gera uma só, mesmo com clique duplo", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await abrirTransferencia(page);
    const gerar = page.locator("#btn-gerar-planilha");
    await gerar.click();
    await esperarToast(page, "Preencha o campo obrigatório “Nome do destinatário”.");
    expect(chamadasDe(ambiente, "POST", "/api/gerar-planilha")).toHaveLength(0);

    await page.locator("#select-unidade-destino").selectOption("unidade-maringa");
    await gerar.click();
    await esperarToast(page, "Preencha o campo obrigatório “Observações” para gerar a planilha oficial.");
    expect(chamadasDe(ambiente, "POST", "/api/gerar-planilha")).toHaveLength(0);

    await page.locator("#retirada-obs").fill("Retirada de teste");
    await page.locator("#entrega-obs").fill("Entrega de teste");
    const portao = ambiente.segurar("planilha");
    const download = page.waitForEvent("download");
    await gerar.dblclick();
    await expect.poll(() => chamadasDe(ambiente, "POST", "/api/gerar-planilha").length).toBe(1);
    portao.liberar();
    expect((await download).suggestedFilename()).toBe("Transferencia_BRJ0001_teste.xlsx");
    await esperarToast(page, "Planilha Exportada com Sucesso!");
    expect(chamadasDe(ambiente, "POST", "/api/gerar-planilha")).toHaveLength(1);
    // Só a planilha, o histórico e a preparação do ticket saem; envio real ao UX nunca.
    expect(escritas(ambiente).map(chamada => chamada.caminho).sort()).toEqual(
      ["/api/gerar-planilha", "/api/historico-transferencias", "/api/ux/gerar-ticket/preparar"],
    );
    expect(chamadasDe(ambiente, "POST", "/api/ux/gerar-ticket/enviar")).toHaveLength(0);
  });

  test("Edição em linha: sem mudança avisa, só o apelido muda e a troca de seleção durante o salvamento é respeitada", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await page.locator("#btn-editar-equipamento").click();
    await expect(page.locator("#ck-dados-edicao-texto")).toHaveText("Editando dados cadastrais · nenhuma alteração");
    await page.locator("#btn-salvar-dados-cadastrais").click();
    await esperarToast(page, "Nenhuma alteração para salvar.");
    expect(escritas(ambiente)).toEqual([]);

    const apelido = page.locator('[data-campo-edicao="apelido"]');
    await apelido.fill("PRNOVO001");
    await expect(page.locator("#ck-dados-edicao-texto")).toHaveText("Editando dados cadastrais · 1 alteração");
    await page.locator("#btn-salvar-dados-cadastrais").click();
    await esperarToast(page, "Dados cadastrais salvos.");
    expect(escritas(ambiente)).toHaveLength(1);
    expect(corpoDe(chamadasDe(ambiente, "POST", "/api/equipamento/atualizar-apelido")[0])).toEqual({ serial: "BRJ0001", apelido: "PRNOVO001" });
    await expect(page.locator("#badge-apelido")).toHaveText("PRNOVO001");
    await expect(page.locator("#form-editar-equipamento")).toBeHidden();

    // Troca de seleção com o salvamento ainda sem resposta: o card fica com o equipamento novo e nada mais é enviado.
    await page.locator("#btn-editar-equipamento").click();
    await page.locator('[data-campo-edicao="apelido"]').fill("PRATRASADO001");
    const portao = ambiente.segurar("salvar");
    await page.locator("#btn-salvar-dados-cadastrais").click();
    await expect.poll(() => chamadasDe(ambiente, "POST", "/api/equipamento/atualizar-apelido").length).toBe(2);
    await trocarSelecao(page, "BRJ0002");
    portao.liberar();
    await page.waitForTimeout(300);
    await expect(page.locator("#card-serial")).toHaveText("BRJ0002");
    await expect(page.locator("#badge-apelido")).toHaveText("PRTESTE002");
    expect(escritas(ambiente)).toHaveLength(2);
  });

  test("Nome da pessoa e usuário manual: cada um grava na rota certa", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0002");
    await expect(page.locator("#form-nome-pessoa")).toBeVisible();
    await page.locator("#input-nome-pessoa").fill("Pessoa de Teste Dois");
    await page.locator("#btn-salvar-nome-pessoa").click();
    await esperarToast(page, "Nome da pessoa salvo.");
    expect(corpoDe(chamadasDe(ambiente, "POST", "/api/equipamento/nome-pessoa")[0])).toEqual({ serial: "BRJ0002", login_atual: "usuario.teste2", nome: "Pessoa de Teste Dois" });
    await expect(page.locator("#card-nome-pessoa")).toHaveText("Pessoa de Teste Dois (manual)");

    await trocarSelecao(page, "BRJ0003");
    await expect(page.locator("#form-usuario-manual")).toBeVisible();
    await page.locator("#btn-salvar-usuario-manual").click();
    await esperarToast(page, "Digite o usuário antes de salvar.");
    expect(chamadasDe(ambiente, "POST", "/api/equipamento/atualizar-usuario")).toHaveLength(0);
    await page.locator("#input-usuario-manual").fill("usuario.manual3");
    await page.locator("#btn-salvar-usuario-manual").click();
    await esperarToast(page, "Usuário salvo e registrado no histórico de alterações.");
    expect(corpoDe(chamadasDe(ambiente, "POST", "/api/equipamento/atualizar-usuario")[0])).toEqual({ serial: "BRJ0003", usuario: "usuario.manual3" });
    await expect(page.locator("#card-usuarios-logados")).toHaveText("usuario.manual3 (M)");
    expect(escritas(ambiente)).toHaveLength(2);
  });

  test("Contatos regionais: restaurar padrão pede confirmação e salvar grava com a cidade codificada", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await abrirTransferencia(page);
    await page.locator("#select-unidade-destino").selectOption("unidade-maringa");
    await page.locator("#btn-editar-representante-entrega").click();
    const dialogo = page.getByRole("dialog", { name: "Editar representante regional" });
    await expect(dialogo).toBeVisible();
    await expect(page.locator("#btn-restaurar-representante-regional")).toBeDisabled();
    await page.locator("#representante-regional-nome").fill("Renata Editada de Teste");
    await page.locator("#representante-regional-inicio").fill("09:30:00");
    await page.locator("#btn-salvar-representante-regional").click();
    await expect(dialogo).toBeHidden();
    await esperarToast(page, "Representante salvo.");
    const puts = chamadasDe(ambiente, "PUT", "/api/config/representantes-regionais/Maring%C3%A1");
    expect(puts).toHaveLength(1);
    const corpo = corpoDe(puts[0]);
    expect(Object.keys(corpo).sort()).toEqual(["almoco", "email", "horario", "nome", "pausaDuracao", "telefone"]);
    expect(corpo.nome).toBe("Renata Editada de Teste");
    expect(corpo.horario).toMatch(/^09:30:00 às /);
    await expect(page.locator("#entrega-contato")).toHaveValue("Renata Editada de Teste");

    await page.locator("#btn-editar-representante-entrega").click();
    await expect(page.locator("#btn-restaurar-representante-regional")).toBeEnabled();
    await page.locator("#btn-restaurar-representante-regional").click();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Restaurar padrão?");
    await cancelar(page);
    expect(chamadasDe(ambiente, "DELETE", "/api/config/representantes-regionais/Maring%C3%A1")).toHaveLength(0);
    await expect(dialogo).toBeVisible();

    await page.locator("#btn-restaurar-representante-regional").click();
    await confirmar(page);
    await expect(dialogo).toBeHidden();
    await esperarToast(page, "Padrão restaurado.");
    expect(chamadasDe(ambiente, "DELETE", "/api/config/representantes-regionais/Maring%C3%A1")).toHaveLength(1);
    await expect(page.locator("#entrega-contato")).toHaveValue("Tereza Teste de Maringá");
  });

  test("Lista da Home: filtros trocados em sequência mostram o resultado do último", async ({ page }) => {
    const ambiente = await preparar(page);
    await expect(page.locator("#home-filter-total")).toHaveText("6");
    await expect(page.locator("#home-equipment-list [role='option']")).toHaveCount(6);
    const portao = ambiente.segurar("semUsuario");
    await page.locator('button[data-filter="sem-usuario"]').click();
    await expect.poll(() => ambiente.chamadas.filter(chamada => chamada.busca.get("usuario") === "sem").length).toBe(1);
    await page.locator('button[data-filter="todos"]').click();
    await expect(page.locator('button[data-filter="todos"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#home-equipment-list [role='option']")).toHaveCount(6);
    portao.liberar();
    await page.waitForTimeout(300);
    await expect(page.locator("#home-equipment-list [role='option']")).toHaveCount(6);
    await expect(page.locator('#home-equipment-list [data-serial="BRJ0002"]')).toHaveCount(1);
    await expect(page.locator('button[data-filter="todos"]')).toHaveAttribute("aria-pressed", "true");
  });

  for (const tema of ["light", "dark"]) {
    test(`Lista da Home: o item ativo das setas tem contorno visível, tema ${tema}`, async ({ page }) => {
      await preparar(page, { tema });
      const lista = page.locator("#home-equipment-list");
      await expect(lista.locator("[role='option']")).toHaveCount(6);
      await lista.focus();
      await page.keyboard.press("ArrowDown");
      const ativo = lista.locator("[role='option']").first();
      await expect(ativo).toHaveClass(/is-focused/);
      await expect(lista).toHaveAttribute("aria-activedescendant", await ativo.getAttribute("id"));
      const estilo = await ativo.evaluate(el => {
        const css = getComputedStyle(el);
        const destaque = document.createElement("span");
        destaque.style.color = "var(--cor-destaque)";
        el.append(destaque);
        const cor = getComputedStyle(destaque).color;
        destaque.remove();
        return { estilo: css.outlineStyle, largura: css.outlineWidth, cor: css.outlineColor, destaque: cor };
      });
      expect(estilo).toEqual({ estilo: "solid", largura: "2px", cor: estilo.destaque, destaque: estilo.destaque });
    });
  }

  test("Histórico de apelidos: desfazer e excluir chamam as rotas esperadas depois de confirmar", async ({ page }) => {
    const ambiente = await preparar(page);
    await buscar(page, "BRJ0001");
    await page.locator('#card-equipamento [data-args=\'["apelidos"]\']').click();
    const painel = page.locator('[data-cockpit-tool-panel="apelidos"]');
    await expect(painel).toBeVisible();
    await expect(page.locator("#cockpit-alias-list .ck-ferr-item")).toHaveCount(2);

    await page.locator("#cockpit-alias-list .ck-ferr-item").filter({ hasText: "PRANTIGO001" }).getByRole("button").click();
    await page.locator("#cockpit-alias-detail").getByRole("button", { name: "Restaurar anterior" }).click();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Desfazer alteração?");
    await confirmar(page);
    await esperarToast(page, "Apelido restaurado. A reversão foi registrada no histórico.");
    const desfazer = chamadasDe(ambiente, "POST", "/api/equipamento/apelido/desfazer");
    expect(desfazer).toHaveLength(1);
    expect(corpoDe(desfazer[0])).toEqual({ evento_id: "ev-apelido-1" });
    await expect(page.locator("#badge-apelido")).toHaveText("PRANTIGO001");

    await page.locator("#cockpit-alias-list .ck-ferr-item").filter({ hasText: "BRJ0002" }).getByRole("button").click();
    await page.locator("#cockpit-alias-detail").getByRole("button", { name: "Excluir aviso" }).click();
    await expect(page.locator("#titulo-confirmar-acao")).toHaveText("Excluir registro?");
    await cancelar(page);
    expect(chamadasDe(ambiente, "DELETE", "/api/historico-alteracoes/ev-aviso-1")).toHaveLength(0);
    await page.locator("#cockpit-alias-detail").getByRole("button", { name: "Excluir aviso" }).click();
    await confirmar(page);
    await esperarToast(page, "Aviso removido do histórico.");
    expect(chamadasDe(ambiente, "DELETE", "/api/historico-alteracoes/ev-aviso-1")).toHaveLength(1);
  });
});
