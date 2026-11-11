const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Home e-mail by template (modal "E-mail pelo Outlook"). Every /api/outlook/** call is stubbed here:
// no test reaches the real backend, the Outlook or the Entra base. People and addresses are fictional.

const EQUIPAMENTO = { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", nome_pessoa: "Pessoa Teste" };
const CONTAS = [
  { id: "sebrae", rotulo: "Sebrae", email: "conta1@exemplo.test", padrao: true },
  { id: "simpress", rotulo: "Simpress", email: "conta2@exemplo.test", padrao: false },
];
const CABO_PADRAO = {
  id: "cabo", nome: "Modelo 1 - Cabo", conta: "sebrae", para: "Ana Exemplo <ana@exemplo.test>", cc: "",
  assunto: "Cabo de segurança para {nome}", corpo: "Olá, {nome} do setor {setor}. Segue o cabo de segurança.",
};
const AVISO = {
  id: "aviso", nome: "Modelo 2 - Aviso", conta: "simpress", para: "grupo@exemplo.test", cc: "copia@exemplo.test",
  assunto: "Aviso geral", corpo: "Texto do aviso geral.",
};
const ANA = { nome: "Ana Exemplo", email: "ana.exemplo@exemplo.test" };
const ANA_TESTE = { nome: "Ana Teste", email: "ana.teste@exemplo.test" };
const PESSOA = { nome: "Pessoa Teste", email: "pessoa.teste@exemplo.test" };
const OUTLOOK_FECHADO = "O Outlook (classic) não está aberto. Abra o Outlook e tente enviar de novo.";
const INCERTO = "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.";

function resolver(token) {
  if (token === "unico") return { token, status: "unico", ...PESSOA };
  if (token === "ambiguo") return { token, status: "ambiguo", opcoes: [ANA, ANA_TESTE] };
  return { token, status: "nenhum" };
}

// Fake backend: records each call and answers like routers/outlook_mail.py. Tests tune it through the returned object.
async function prepararServidor(page, { diretorio = true } = {}) {
  const servidor = {
    chamadas: [], modelos: [{ ...CABO_PADRAO }, { ...AVISO }], respostaEmail: null, respostaExcluir: null, segurarPut: null,
    de(metodo, caminho) { return this.chamadas.filter(c => c.metodo === metodo && c.caminho === caminho); },
  };
  await page.route("**/api/outlook/**", async route => {
    const pedido = route.request();
    const url = new URL(pedido.url());
    const metodo = pedido.method();
    const caminho = url.pathname.replace("/api/outlook", "");
    const corpo = pedido.postData() ? pedido.postDataJSON() : null;
    servidor.chamadas.push({ metodo, caminho, busca: url.search, corpo });
    const modelo = servidor.modelos.find(item => caminho.startsWith(`/email/modelos/${item.id}`));
    if (metodo === "GET" && caminho === "/email/configuracao") {
      return route.fulfill({ json: { contas: CONTAS, modelos: servidor.modelos, diretorio: { disponivel: diretorio } } });
    }
    if (metodo === "PUT" && modelo) {
      if (servidor.segurarPut) await servidor.segurarPut;
      Object.assign(modelo, corpo);
      return route.fulfill({ json: modelo });
    }
    if (metodo === "POST" && modelo && caminho.endsWith("/restaurar")) {
      Object.assign(modelo, CABO_PADRAO);
      return route.fulfill({ json: modelo });
    }
    if (metodo === "DELETE" && modelo) {
      return route.fulfill(servidor.respostaExcluir || { json: { ok: true } });
    }
    if (metodo === "GET" && caminho === "/contatos") {
      const termo = url.searchParams.get("q") || "";
      return route.fulfill({ json: { contatos: termo.startsWith("an") ? [ANA, ANA_TESTE] : [] } });
    }
    if (metodo === "POST" && caminho === "/contatos/resolver") {
      return route.fulfill({ json: { resultados: corpo.tokens.map(resolver) } });
    }
    if (metodo === "POST" && caminho === "/email") {
      return route.fulfill(servidor.respostaEmail || { json: { status: corpo.modo === "enviar" ? "enviado" : "aberto" } });
    }
    return route.fulfill({ status: 404, json: { detail: "Rota não simulada." } });
  });
  return servidor;
}

async function selecionarEquipamento(page) {
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
}

async function abrirModal(page, opcoes) {
  const servidor = await prepararServidor(page, opcoes);
  await selecionarEquipamento(page);
  await page.locator("#btn-enviar-email").click();
  await expect(page.locator("#modal-email-outlook")).toBeVisible();
  await expect(page.locator("#email-modelo")).toBeEnabled(); // models loaded
  return servidor;
}

const status = page => page.locator("#email-status");
const confirmar = page => ({ titulo: page.locator("#titulo-confirmar-acao"), mensagem: page.locator("#mensagem-confirmar-acao") });

test("Enviar e-mail needs an equipment, then opens the modal with the person's name filled in", async ({ page }) => {
  await prepararServidor(page);
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.goto("/");
  const botao = page.locator("#btn-enviar-email");
  await expect(botao).toBeDisabled();
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
  await expect(botao).toBeEnabled();
  await botao.click();
  await expect(page.getByRole("dialog", { name: "E-mail pelo Outlook" })).toBeVisible();
  await expect(page.locator("#titulo-email-outlook")).toHaveText("E-mail pelo Outlook");
  await expect(page.locator("#email-nome-pessoa")).toHaveValue("Pessoa Teste");
});

test("changing the Modelo loads its account, recipients, subject and message; Restaurar padrão only shows on cabo", async ({ page }) => {
  await abrirModal(page);
  await expect(page.locator("#email-modelo-nome")).toHaveValue(CABO_PADRAO.nome);
  await expect(page.locator("#email-conta")).toHaveValue("sebrae");
  await expect(page.locator("#email-para")).toHaveValue(CABO_PADRAO.para);
  await expect(page.locator("#email-assunto")).toHaveValue(CABO_PADRAO.assunto);
  await expect(page.locator("#email-modelo-restaurar")).toBeVisible();

  await page.locator("#email-modelo").selectOption("aviso");
  await expect(page.locator("#email-modelo-nome")).toHaveValue(AVISO.nome);
  await expect(page.locator("#email-conta")).toHaveValue("simpress");
  await expect(page.locator("#email-para")).toHaveValue(AVISO.para);
  await expect(page.locator("#email-cc")).toHaveValue(AVISO.cc);
  await expect(page.locator("#email-assunto")).toHaveValue(AVISO.assunto);
  await expect(page.locator("#email-corpo")).toHaveValue(AVISO.corpo);
  await expect(page.locator("#email-modelo-restaurar")).toBeHidden();

  await page.locator("#email-modelo").selectOption("cabo");
  await expect(page.locator("#email-modelo-restaurar")).toBeVisible();
});

test("autosave shows pending then saved, and switching models flushes the edit to the OLD model first", async ({ page }) => {
  const servidor = await abrirModal(page);
  const salvamentos = () => servidor.chamadas.filter(c => c.metodo === "PUT");
  const autosave = page.locator("#email-autosave-status");

  await page.locator("#email-assunto").fill("Assunto novo");
  await expect(autosave).toHaveText("Alteração ainda não salva…");
  await expect(autosave).toHaveText("Salva.");
  expect(salvamentos().map(({ caminho, corpo }) => ({ caminho, corpo }))).toEqual([
    { caminho: "/email/modelos/cabo", corpo: { assunto: "Assunto novo" } },
  ]);

  // Hold the PUT: the new model must not load while the old one is still being written.
  let liberar;
  servidor.segurarPut = new Promise(resolve => { liberar = resolve; });
  await page.locator("#email-assunto").fill("Edição pendente");
  await page.locator("#email-modelo").selectOption("aviso");
  await expect.poll(() => salvamentos().length).toBe(2);
  await expect(page.locator("#email-assunto")).toHaveValue("Edição pendente");
  liberar();
  await expect(page.locator("#email-assunto")).toHaveValue(AVISO.assunto);
  expect(salvamentos().map(({ caminho, corpo }) => ({ caminho, corpo }))[1]).toEqual({ caminho: "/email/modelos/cabo", corpo: { assunto: "Edição pendente" } });
  expect(salvamentos()).toHaveLength(2);
  await expect(page.locator("#email-modelo")).toHaveValue("aviso");
});

test("Para autocomplete is an ARIA combobox: keyboard picks a contact, Esc closes only the list, no match is explained", async ({ page }) => {
  await abrirModal(page);
  const para = page.locator("#email-para");
  const lista = page.getByRole("listbox", { name: "Para" });

  await para.fill("an");
  await expect(lista).toBeVisible();
  await expect(para).toHaveAttribute("aria-expanded", "true");
  await expect(lista.getByRole("option")).toHaveText([`${ANA.nome} <${ANA.email}>`, `${ANA_TESTE.nome} <${ANA_TESTE.email}>`]);
  await para.press("ArrowDown");
  await expect(para).toHaveAttribute("aria-activedescendant", "email-para-opcao-0");
  await para.press("ArrowDown");
  await expect(para).toHaveAttribute("aria-activedescendant", "email-para-opcao-1");
  await para.press("Enter");
  await expect(para).toHaveValue(`${ANA_TESTE.nome} <${ANA_TESTE.email}>; `);
  await expect(lista).toBeHidden();
  await expect(para).toHaveAttribute("aria-expanded", "false");

  await para.fill("an");
  await expect(lista).toBeVisible();
  await para.press("Escape");
  await expect(lista).toBeHidden();
  await expect(para).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#modal-email-outlook")).toBeVisible();

  await para.fill("zz");
  await expect(lista.getByRole("option")).toHaveText("Nenhum contato encontrado no Entra.");

  // Leaving the field before the 200 ms debounce must not reopen the list later.
  await para.fill("ambiguo");
  await para.blur();
  await page.waitForTimeout(600);
  await expect(lista).toBeHidden();
  await expect(para).toHaveAttribute("aria-expanded", "false");
});

test("leaving Para resolves a single match into Nome <email>; an ambiguous name blocks Enviar but not Abrir no Outlook", async ({ page }) => {
  const servidor = await abrirModal(page);
  const para = page.locator("#email-para");
  const envios = () => servidor.de("POST", "/email");

  await para.fill("unico");
  await para.blur();
  await expect(para).toHaveValue(`${PESSOA.nome} <${PESSOA.email}>`);
  expect(servidor.de("POST", "/contatos/resolver")[0].corpo).toEqual({ tokens: ["unico"] });

  await para.fill("ambiguo");
  await para.blur();
  await expect(page.locator("#email-para-opcoes")).toContainText('Escolha o destinatário certo para "ambiguo":');
  await expect(page.locator("#email-para-opcoes").getByRole("button")).toHaveText([`${ANA.nome} <${ANA.email}>`, `${ANA_TESTE.nome} <${ANA_TESTE.email}>`]);

  await page.locator("#email-setor").fill("Setor Teste");
  await page.locator("#email-enviar").click();
  await expect(status(page)).toHaveText("Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.");
  expect(envios()).toHaveLength(0);

  await page.locator("#email-abrir").click();
  await expect(status(page)).toHaveText("E-mail aberto no Outlook. Revise e envie por lá.");
  expect(envios().map(({ corpo }) => ({ modo: corpo.modo, confirmado: corpo.confirmado }))).toEqual([{ modo: "abrir", confirmado: false }]);
});

test("the mouse picks a suggestion and an ambiguous option, even when the click blurs Para", async ({ page }) => {
  const servidor = await abrirModal(page);
  const para = page.locator("#email-para");

  await para.fill("an");
  await page.getByRole("listbox", { name: "Para" }).getByRole("option").first().click();
  await expect(para).toHaveValue(`${ANA.nome} <${ANA.email}>; `);

  await para.fill("ambiguo");
  await para.blur();
  const opcoes = page.locator("#email-para-opcoes").getByRole("button");
  await expect(opcoes).toHaveCount(2);
  await para.focus(); // the click below blurs Para and starts a second resolve of "ambiguo"
  await opcoes.nth(1).click();
  await expect(para).toHaveValue(`${ANA_TESTE.nome} <${ANA_TESTE.email}>`);
  await page.waitForTimeout(300);
  await expect(para).toHaveValue(`${ANA_TESTE.nome} <${ANA_TESTE.email}>`);
  await expect(page.locator("#email-para-opcoes")).toBeHidden();

  await page.locator("#email-setor").fill("Setor Teste");
  await page.locator("#email-enviar").click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(status(page)).toHaveText("E-mail enviado pelo Outlook.");
  const envios = servidor.de("POST", "/email");
  expect(envios).toHaveLength(1);
  expect(envios[0].corpo.para).toBe(`${ANA_TESTE.nome} <${ANA_TESTE.email}>`);
});

test("Enviar pelo Outlook asks first: Cancelar sends nothing, Enviar posts once with confirmado true", async ({ page }) => {
  const servidor = await abrirModal(page);
  const envios = () => servidor.de("POST", "/email");
  await page.locator("#email-setor").fill("Setor Teste");

  await page.locator("#email-enviar").click();
  await expect(confirmar(page).titulo).toHaveText("Enviar o e-mail pelo Outlook?");
  await expect(confirmar(page).mensagem).toHaveText(
    "O e-mail será enviado de conta1@exemplo.test para Ana Exemplo <ana@exemplo.test>. Depois de enviado, não há como desfazer.",
  );
  await page.locator("#btn-confirmar-acao-cancelar").click();
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  expect(envios()).toHaveLength(0);

  await page.locator("#email-enviar").click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(status(page)).toHaveText("E-mail enviado pelo Outlook.");
  expect(envios().map(({ corpo }) => corpo)).toEqual([{
    conta: "sebrae", para: CABO_PADRAO.para, cc: "", assunto: CABO_PADRAO.assunto, corpo: CABO_PADRAO.corpo,
    nome: "Pessoa Teste", setor: "Setor Teste", modo: "enviar", confirmado: true,
  }]);
});

test("a server error is shown as an error and an uncertain send is a warning, never a success", async ({ page }) => {
  const servidor = await abrirModal(page);
  await page.locator("#email-setor").fill("Setor Teste");

  servidor.respostaEmail = { status: 503, json: { detail: OUTLOOK_FECHADO, codigo: "outlook_fechado" } };
  await page.locator("#email-abrir").click();
  await expect(status(page)).toHaveText(OUTLOOK_FECHADO);
  await expect(status(page)).toHaveAttribute("data-tipo", "erro");

  servidor.respostaEmail = { json: { status: "incerto", aviso: INCERTO } };
  await page.locator("#email-enviar").click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(status(page)).toHaveText(INCERTO);
  await expect(status(page)).toHaveAttribute("data-tipo", "aviso");
  await expect(status(page)).not.toContainText("E-mail enviado pelo Outlook.");
});

test("Excluir modelo and Restaurar padrão ask for confirmation; the last-model error is shown; restore posts to /restaurar", async ({ page }) => {
  const servidor = await abrirModal(page);

  servidor.respostaExcluir = { status: 422, json: { detail: "Mantenha ao menos um modelo.", codigo: "ultimo_modelo" } };
  await page.locator("#email-modelo-excluir").click();
  await expect(confirmar(page).titulo).toHaveText("Excluir o modelo?");
  await expect(confirmar(page).mensagem).toHaveText("O modelo Modelo 1 - Cabo será excluído deste site. Não há como desfazer.");
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(status(page)).toHaveText("Mantenha ao menos um modelo.");
  expect(servidor.de("DELETE", "/email/modelos/cabo")).toHaveLength(1);

  await page.locator("#email-assunto").fill("Assunto alterado");
  await page.locator("#email-modelo-restaurar").click();
  await expect(confirmar(page).titulo).toHaveText("Restaurar o padrão?");
  expect(servidor.de("POST", "/email/modelos/cabo/restaurar")).toHaveLength(0);
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(page.locator("#email-assunto")).toHaveValue(CABO_PADRAO.assunto);
  expect(servidor.de("POST", "/email/modelos/cabo/restaurar")).toHaveLength(1);
});

test("without the Entra base the modal warns and never calls /contatos", async ({ page }) => {
  const servidor = await abrirModal(page, { diretorio: false });
  await expect(page.locator("#email-aviso-diretorio")).toHaveText("A base do Microsoft Entra não foi importada; digite o e-mail completo.");
  await page.locator("#email-para").fill("ana");
  await page.locator("#email-para").blur();
  await page.waitForTimeout(600); // longer than the 200 ms search debounce
  await expect(page.locator("#email-para-lista")).toBeHidden();
  expect(servidor.chamadas.filter(({ caminho }) => caminho.startsWith("/contatos"))).toEqual([]);
});

test("the modal fits 320 px without horizontal scroll and stays readable in both themes", async ({ page }) => {
  await prepararServidor(page);
  await selecionarEquipamento(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator("#btn-enviar-email").click();
  const modal = page.locator("#modal-email-outlook");
  await expect(modal).toBeVisible();
  await expect(page.locator("#email-modelo")).toBeEnabled();
  for (const tema of ["dark", "light"]) {
    await page.locator("html").evaluate((raiz, valor) => { raiz.dataset.theme = valor; }, tema);
    await modal.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
    await expect(modal).toBeVisible();
    const medidas = await page.evaluate(() => ({
      pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogo: document.querySelector("#modal-email-outlook > .ck-dialogo").getBoundingClientRect().right - document.documentElement.clientWidth,
    }));
    expect(medidas.pagina).toBeLessThanOrEqual(0);
    expect(medidas.dialogo).toBeLessThanOrEqual(0);
    const cores = await page.evaluate(() => ({
      titulo: getComputedStyle(document.querySelector("#titulo-email-outlook")).color,
      fundo: getComputedStyle(document.querySelector("#modal-email-outlook > .ck-dialogo")).backgroundColor,
    }));
    expect(cores.titulo).not.toBe(cores.fundo);
    const resultado = await new AxeBuilder({ page }).include("#modal-email-outlook").withRules(["color-contrast"]).analyze();
    expect(resultado.violations.flatMap(({ nodes }) => nodes.map(({ target, failureSummary }) => ({ target, failureSummary })))).toEqual([]);
  }
});
