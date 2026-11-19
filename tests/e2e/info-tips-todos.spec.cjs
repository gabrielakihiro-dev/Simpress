const { test, expect } = require("@playwright/test");
const { abrirEtapaTransporte } = require("./support/etapas-transporte.cjs");

// Limpeza dos textos explicativos, Bloco 4 (varredura geral): percorre as abas, sub-abas, painéis e modais e confere TODO ⓘ (.info-tip)
// visível em cada tela, no desktop (1366px) e no celular (390px): o botão se descreve (aria-label "Sobre ..." e aria-describedby para um
// balão com texto), o balão abre por mouse (desktop) ou toque (celular) inteiro dentro da janela e por cima de tudo (nenhum contêiner
// com overflow o corta), e o primeiro Esc fecha só o balão. Cada tela também fica sem rolagem horizontal.
// Só a fixture (porta 8765); as rotas /api/* que a fixture não cobre são simuladas aqui.

const EQUIPAMENTO = { serial: "LENTO", modelo: "Notebook de teste", tipo: "Notebook", apelido: "TESTE-001", nome_pessoa: "Pessoa Teste" };
const PRONTO = { online: true, modelo: "modelo-teste", aguardando_confirmacao: false };

test.beforeEach(async ({ request }) => {
  await request.get("/__fixture_cockpit?comparacao=1");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await request.get("/__fixture_backups?estado=padrao");
  await request.get("/__fixture_lembretes?itens=0");
  await request.get("/__fixture_representantes");
});

test.afterEach(async ({ request }) => {
  await request.get("/__fixture_cockpit?comparacao=0");
  await request.get("/__fixture_alertas_painel?estado=ocultos");
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await request.get("/__fixture_backups?estado=padrao");
  await request.get("/__fixture_lembretes?itens=0");
});

// ---- Como chegar em cada tela ----

async function abrirFerramenta(page, id) {
  const menu = page.locator("#cockpit-tools-dropdown");
  if (!(await menu.evaluate(no => no.open))) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(id).click();
}

// Chamados (OS) e Chamados do Sebrae ficam na barra principal; abaixo de 1200px a barra os esconde e o menu Ferramentas os oferece.
async function abrirFerramentaDaBarra(page, idBarra, idMenu) {
  if (await page.locator(idBarra).isVisible()) await page.locator(idBarra).click();
  else await abrirFerramenta(page, idMenu);
}

async function abrirAbaTransporte(page) {
  const botao = page.locator("#btn-sidebar-open");
  const casca = page.locator("#simpress-app-shell");
  if (await botao.isVisible() && await casca.getAttribute("data-sidebar-open") !== "true") {
    await botao.click();
    await expect(casca).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-retirada-entrega").click();
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
}

async function buscarEquipamento(page) {
  await page.route("**/api/equipamento/*", route => route.fulfill({ json: EQUIPAMENTO }));
  await page.goto("/");
  await page.locator("#input-serial").fill("LENTO");
  await page.getByRole("button", { name: "Buscar Equipamento" }).click();
  await expect(page.locator("#card-serial")).toHaveText("LENTO");
}

async function abrirResumo(page, aba) {
  await page.goto("/");
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", /^(pronto|erro)$/);
  await expect(page.locator("#resumo-backups-contagem")).toHaveText(/^\d+$/);
  await page.locator(`#resumo-aba-${aba}`).click();
  const painel = page.locator(`#resumo-painel-${aba}`);
  await expect(painel).toBeVisible();
  return painel;
}

async function abrirPainelChamadosOs(page, aba) {
  await page.goto("/");
  await abrirFerramentaDaBarra(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu");
  const painel = page.locator('[data-cockpit-tool-panel="chamados"]');
  await expect(painel).toBeVisible();
  if (aba) await page.locator(`#os-aba-${aba}`).click();
  return painel;
}

async function abrirPainelSebrae(page, request, { aba, extra = "" } = {}) {
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}&antigos=`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  if (aba) await page.locator(`#sebrae-aba-${aba}`).click();
  return painel;
}

async function abrirAutomacao(page, aba) {
  await page.request.get("/__fixture_automacao?quantidade=0&sebrae=padrao");
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  await expect(page.locator("#sebrae-novos-resumo")).toContainText("novo(s)");
  await page.locator(`#tab-rotina-${aba}`).click();
  return page.locator("#tab-panel-automacao");
}

async function abrirTermo(page, termo) {
  await page.goto("/");
  await abrirFerramenta(page, "#btn-lembretes");
  await page.locator(`#termos-aba-${termo}`).click();
  const painel = page.locator(`#termos-painel-${termo}`);
  await expect(painel).toBeVisible();
  return painel;
}

async function abrirAssistente(page, botao, secao) {
  await page.route("**/api/assistente/**", route => {
    const nome = new URL(route.request().url()).pathname.split("/").pop();
    const respostas = { estado: PRONTO, instrucoes: { texto: "", limite: 4000 }, notas: { notas: [] }, conversas: { conversas: [] } };
    return route.fulfill({ json: respostas[nome] ?? { ok: true } });
  });
  await page.goto("/");
  await page.locator("#btn-assistente").click();
  await expect(page.locator("#assistente-widget")).toBeVisible();
  await page.locator(botao).click();
  const painel = page.locator(secao);
  await expect(painel).toBeVisible();
  return painel;
}

const chamar = (page, nome) => page.evaluate(funcao => window[funcao](), nome);

// Cada tela: `abrir` deixa a tela aberta e devolve o contêiner a varrer; `minimo` é quantos ⓘ ela tem por desenho (a tela não pode
// perder um sem o teste avisar) e `rotulos` lista os aria-label que precisam estar entre eles.
const TELAS = [
  // A Automação mostra uma rotina por vez (seletor de abas): cada aba é uma tela a varrer.
  {
    nome: "Automação, aba SoftExpert (chamados novos)", minimo: 0,
    // No celular (< 768px) o cartão compacto do Design esconde o ⓘ do título (ck-cockpit.css, F4 Bloco 2); só no desktop ele existe.
    rotulosSoDesktop: ["Sobre Chamados novos do SoftExpert"],
    abrir: page => abrirAutomacao(page, "softexpert"),
  },
  {
    nome: "Automação, aba Rotina Completa", minimo: 3,
    rotulos: ["Sobre Rotina de OS", "Sobre Verificar usuários", "Sobre Rotina Completa"],
    abrir: page => abrirAutomacao(page, "completa"),
  },
  {
    nome: "Automação, aba Inventários", minimo: 1, rotulos: ["Sobre Inventários"],
    abrir: page => abrirAutomacao(page, "inventarios"),
  },
  {
    nome: "Home: códigos prontos do PowerShell", minimo: 1, rotulos: ["Sobre Códigos prontos"],
    abrir: async page => {
      await buscarEquipamento(page);
      await page.locator("#btn-powershell-codigos-gerenciar").click();
      await expect(page.locator("#powershell-codigos-titulo")).toBeVisible();
      return page.locator("#card-equipamento");
    },
  },
  {
    nome: "Home sem equipamento", minimo: 0,
    abrir: async page => {
      await page.goto("/");
      await expect(page.locator("#home-detail-empty")).toHaveText("Selecione um equipamento.");
      await expect(page.locator(".ck-ac__dica")).toHaveCount(0); // "Esc fecha" saiu da lista de sugestões (redundante)
      return page.locator("#tab-panel-home");
    },
  },
  {
    nome: "Home com equipamento", minimo: 0,
    abrir: async page => { await buscarEquipamento(page); return page.locator("#card-equipamento"); },
  },
  {
    nome: "Transporte", minimo: 0,
    abrir: async page => { await page.goto("/"); await abrirAbaTransporte(page); return page.locator("#tab-panel-retirada-entrega"); },
  },
  // A sub-aba "Visão geral" não tem cartões, painel vazio e sem ⓘ: fica de fora.
  ...["sem-acesso", "divergencias", "apelidos", "usuarios", "backups"].map(aba => ({
    nome: `Resumo, sub-aba ${aba}`, minimo: 0, abrir: page => abrirResumo(page, aba),
  })),
  { nome: "Chamados (OS), Abertas", minimo: 1, abrir: page => abrirPainelChamadosOs(page, "abertas") },
  { nome: "Chamados (OS), Finalizadas", minimo: 0, abrir: page => abrirPainelChamadosOs(page, "finalizadas") },
  ...["novos", "antigos", "finalizados", "destaques"].map(aba => ({
    nome: `Chamados do Sebrae, sub-aba ${aba}`, minimo: 0, abrir: (page, request) => abrirPainelSebrae(page, request, { aba }),
  })),
  {
    nome: "Chamados do Sebrae, conflitos do Dashboard", minimo: 1,
    abrir: async (page, request) => {
      await page.route("**/api/automacao/estado*", route => route.fulfill({ json: { estado: "livre", rotina: "", ultima: { status: "concluido" } } }));
      await abrirPainelSebrae(page, request, { extra: "&conflitos=1" });
      const conflitos = page.locator("#sebrae-conflitos");
      await expect(conflitos).toBeVisible();
      return conflitos;
    },
  },
  {
    nome: "Apelidos", minimo: 0,
    abrir: async page => { await page.goto("/"); await abrirFerramenta(page, "#btn-historico-apelidos"); return page.locator('[data-cockpit-tool-panel="apelidos"]'); },
  },
  {
    nome: "Unidades", minimo: 0,
    abrir: async page => { await page.goto("/"); await abrirFerramenta(page, "#btn-catalogo-unidades"); return page.locator('[data-cockpit-tool-panel="unidades"]'); },
  },
  {
    nome: "Cobertura", minimo: 0,
    abrir: async page => { await page.goto("/"); await abrirFerramenta(page, "#btn-cobertura"); return page.locator('[data-cockpit-tool-panel="cobertura"]'); },
  },
  {
    nome: "Planilhas", minimo: 1,
    abrir: async page => { await page.goto("/"); await page.evaluate(() => abrirPainelCockpit("planilhas")); return page.locator('[data-cockpit-tool-panel="planilhas"]'); },
  },
  {
    nome: "Relatório mensal (painel)", minimo: 1,
    abrir: async page => { await page.goto("/"); await abrirFerramenta(page, "#btn-relatorio-mensal"); return page.locator('[data-cockpit-tool-panel="relatorio"]'); },
  },
  { nome: "Lembretes", minimo: 0, abrir: async page => { await page.goto("/"); await abrirFerramenta(page, "#btn-lembretes"); return page.locator("#termos-painel-lembretes"); } },
  { nome: "Termo de entrega", minimo: 3, abrir: page => abrirTermo(page, "entrega") },
  { nome: "Termo de devolução (PDF)", minimo: 1, abrir: page => abrirTermo(page, "devolucao") },
  {
    nome: "Criar lembrete (modal)", minimo: 1,
    abrir: async page => {
      const painel = await abrirTermo(page, "entrega");
      await page.locator("#termos-entrega-nome").fill("Maria Teste");
      await page.locator("#termos-entrega-serie-entregue").fill("NOVA456");
      await painel.getByRole("button", { name: "Criar lembrete" }).click();
      await expect(page.locator("#lembretes-criar-descricao")).toBeVisible();
      return page.locator("#lembretes-criar");
    },
  },
  {
    nome: "Modal Atualizar planilhas", minimo: 5,
    abrir: async page => { await page.goto("/"); await chamar(page, "abrirModalAtualizarPlanilhas"); return page.locator("#modal-atualizar-planilhas"); },
  },
  {
    nome: "Modal Importar arquivos (modelo de transferência)", minimo: 1, rotulos: ["Sobre Importar arquivos"],
    abrir: async page => { await page.goto("/"); await chamar(page, "abrirImportacaoModeloTransferencia"); return page.locator("#modal-importar-modelo"); },
  },
  {
    nome: "Modal Dados do cliente (campos do ambiente)", minimo: 3, rotulos: ["Sobre Dados do cliente", "Sobre os campos bloqueados"],
    abrir: async page => {
      const cliente = { contrato: "10101", cnpj_faturamento: "11.222.333/0001-81", series_sebrae_fora: [], cliente_configurado: true, cliente_fontes: { contrato: "ambiente", cnpj_faturamento: "ambiente" } };
      await page.route("**/api/config/cliente", route => route.fulfill({ json: cliente }));
      await page.route("**/api/config/transferencia", route => route.fulfill({ json: { ...cliente, modelo_transferencia_disponivel: false, retirada_contato: "", retirada_email: "", retirada_telefone: "", contato_origem_configurado: false, contato_origem_fontes: {} } }));
      await page.goto("/");
      await chamar(page, "abrirConfiguracaoCliente");
      await expect(page.locator("#cliente-config-ambiente")).toBeVisible();
      return page.locator("#modal-cliente-config");
    },
  },
  {
    nome: "Modal Contato de origem (campos do ambiente)", minimo: 2, rotulos: ["Sobre Contato de origem", "Sobre os campos bloqueados"],
    abrir: async page => {
      await page.route("**/api/config/transferencia", route => route.fulfill({ json: {
        retirada_contato: "Contato Teste", retirada_email: "contato@exemplo.invalid", retirada_telefone: "(41) 90000-0000", contato_origem_configurado: true,
        contato_origem_fontes: { retirada_contato: "ambiente", retirada_email: "ambiente", retirada_telefone: "ambiente" }, contato_origem_arquivo_invalido: false,
      } }));
      await page.goto("/");
      await abrirAbaTransporte(page);
      await chamar(page, "abrirConfiguracaoContatoOrigem");
      await expect(page.locator("#contato-origem-ambiente")).toBeVisible();
      return page.locator("#modal-contato-origem");
    },
  },
  {
    nome: "Modal Editar representante regional", minimo: 1, rotulos: ["Sobre Editar representante regional"],
    abrir: async page => {
      await page.goto("/");
      await abrirAbaTransporte(page);
      await abrirEtapaTransporte(page, 2);
      await page.locator("#retirada-representante").selectOption("Londrina");
      await page.locator("#btn-editar-representante-retirada").click();
      await expect(page.locator("#representante-regional-nome")).toBeVisible();
      return page.locator("#modal-representante-regional");
    },
  },
  {
    nome: "Modal Transferências geradas", minimo: 1, rotulos: ["Sobre Transferências geradas"],
    abrir: async page => { await page.goto("/"); await abrirAbaTransporte(page); await page.locator("#btn-historico-transferencias").click(); return page.locator("#modal-historico-transferencias"); },
  },
  {
    nome: "Modal Editar apelido", minimo: 1, rotulos: ["Sobre Editar apelido"],
    abrir: async page => { await buscarEquipamento(page); await chamar(page, "abrirModalEditarApelido"); return page.locator("#modal-editar-apelido"); },
  },
  {
    // A edição de equipamento já cadastrado é em linha; o modal só abre para cadastrar um serial novo.
    nome: "Modal Cadastrar novo equipamento", minimo: 1,
    abrir: async page => { await page.goto("/"); await chamar(page, "cadastrarNovoSerialPesquisado"); return page.locator("#modal-editar-equipamento"); },
  },
  {
    nome: "Modal E-mail pelo Outlook", minimo: 2, rotulos: ["Sobre E-mail pelo Outlook"],
    abrir: async page => {
      await page.route("**/api/outlook/**", route => {
        const caminho = new URL(route.request().url()).pathname.replace("/api/outlook", "");
        if (caminho === "/email/configuracao") {
          return route.fulfill({ json: {
            contas: [{ id: "sebrae", rotulo: "Sebrae", email: "conta1@exemplo.test", padrao: true }],
            modelos: [{ id: "cabo", nome: "Modelo 1 - Cabo", conta: "sebrae", para: "ana@exemplo.test", cc: "", assunto: "Cabo para {nome}", corpo: "Olá, {nome}." }],
            diretorio: { disponivel: true },
          } });
        }
        return route.fulfill({ json: { contatos: [] } });
      });
      await buscarEquipamento(page);
      await page.locator("#btn-enviar-email").click();
      await expect(page.locator("#email-modelo")).toBeEnabled();
      return page.locator("#modal-email-outlook");
    },
  },
  {
    nome: "Assistente: instruções permanentes", minimo: 1, rotulos: ["Sobre Instruções permanentes"],
    abrir: page => abrirAssistente(page, "#assistente-instrucoes-botao", "#assistente-instrucoes"),
  },
  {
    nome: "Assistente: lembretes e notas", minimo: 1, rotulos: ["Sobre Lembretes e notas"],
    abrir: page => abrirAssistente(page, "#assistente-lembretes-botao", "#assistente-lembretes"),
  },
  {
    nome: "Assistente: histórico de conversas", minimo: 1, rotulos: ["Sobre Histórico de conversas"],
    abrir: page => abrirAssistente(page, "#assistente-historico-botao", "#assistente-historico"),
  },
];

// ---- Conferências ----

// O balão (fixed no celular, absolute no desktop) cabe na janela e nada o cobre: os quatro cantos e o centro, recuados 4px,
// pertencem a ele. Um contêiner com overflow, transform ou contain que o corte falha aqui, mesmo com `toBeVisible` verde.
async function balaoNaJanelaEPorCima(balao, rotulo) {
  await expect.poll(() => balao.evaluate(no => {
    const c = no.getBoundingClientRect();
    const caixa = `${Math.round(c.left)},${Math.round(c.top)} a ${Math.round(c.right)},${Math.round(c.bottom)} em ${innerWidth}x${innerHeight}`;
    // 3px de folga: o balão fechado fica 2px acima (translateY), então a rolagem do painel pode sobrar 2px ao abrir.
    if (c.left < -1 || c.top < -1 || c.right > innerWidth + 3 || c.bottom > innerHeight + 3) return `fora da janela (${caixa})`;
    const pontos = [[c.left + 4, c.top + 4], [c.right - 4, c.top + 4], [c.left + 4, c.bottom - 4], [c.right - 4, c.bottom - 4], [c.left + c.width / 2, c.top + c.height / 2]];
    for (const [x, y] of pontos) {
      const topo = document.elementFromPoint(x, y);
      if (!topo || !no.contains(topo)) return `coberto ou cortado em ${Math.round(x)},${Math.round(y)} por ${topo ? `${topo.tagName.toLowerCase()}#${topo.id}.${String(topo.className).trim().split(/\s+/).join(".")}` : "nada"} (${caixa})`;
    }
    return "ok";
  }), { message: `${rotulo}: balão inteiro e por cima` }).toBe("ok");
}

async function conferirDica(page, gatilho, escopo, testInfo) {
  await gatilho.evaluate(no => no.scrollIntoView({ block: "center", inline: "nearest" }));
  const rotulo = await gatilho.getAttribute("aria-label");
  expect(rotulo, "aria-label do ⓘ").toMatch(/^Sobre \S/);
  const id = await gatilho.getAttribute("aria-describedby");
  const balao = page.locator(`[id="${id}"]`);
  await expect(balao, `${rotulo}: balão por aria-describedby`).toHaveCount(1);
  await expect(balao, rotulo).toHaveAttribute("role", "tooltip");
  await expect(balao, `${rotulo}: balão com texto`).not.toHaveText(/^\s*$/);

  await page.mouse.move(0, 0);
  await expect(balao, `${rotulo}: balão começa escondido`).toBeHidden();
  if (testInfo.project.use.hasTouch) await gatilho.tap();
  else await gatilho.hover();
  await expect(balao, `${rotulo}: abre por mouse ou toque`).toBeVisible();
  await balaoNaJanelaEPorCima(balao, rotulo);
  await page.mouse.move(0, 0);

  await gatilho.focus();
  await expect(balao, `${rotulo}: abre por foco`).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(balao, `${rotulo}: Esc fecha o balão`).toBeHidden();
  await expect(escopo, `${rotulo}: Esc não fecha a tela`).toBeVisible();
  await expect(gatilho).toBeFocused();
  return rotulo;
}

for (const tela of TELAS) {
  test(`${tela.nome}: todo ⓘ abre inteiro e por cima, Esc fecha só o balão e não há rolagem horizontal`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const escopo = await tela.abrir(page, request);
    await expect(escopo.first()).toBeVisible();
    const gatilhos = escopo.first().locator(".info-tip-trigger:visible");
    const total = await gatilhos.count();
    expect(total, `${tela.nome}: quantidade de ⓘ`).toBeGreaterThanOrEqual(tela.minimo);
    const rotulos = [];
    for (let i = 0; i < total; i += 1) rotulos.push(await conferirDica(page, gatilhos.nth(i), escopo.first(), testInfo));
    const larguraJanela = page.viewportSize().width;
    const esperados = [...(tela.rotulos || []), ...(larguraJanela >= 768 ? tela.rotulosSoDesktop || [] : [])];
    for (const esperado of esperados) expect(rotulos, `${tela.nome}: ⓘ esperado`).toContain(esperado);
    const largura = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(largura[0], `${tela.nome}: rolagem horizontal da página`).toBeLessThanOrEqual(largura[1]);
  });
}

// Sem rolagem horizontal em 320, 390, 1366 e 2560px nas quatro telas principais (o projeto desktop redimensiona a janela).
test("Home, Transporte, Automação e Resumo não rolam na horizontal em 320, 390, 1366 e 2560px", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a janela é redimensionada aqui; um projeto basta");
  test.setTimeout(90_000);
  await request.get("/__fixture_automacao?quantidade=0&sebrae=padrao");
  for (const [largura, altura] of [[320, 700], [390, 844], [1366, 900], [2560, 1200]]) {
    await page.setViewportSize({ width: largura, height: altura });
    await page.goto("/");
    const telas = [
      ["Home", async () => { await page.locator("#tab-home").click(); }],
      ["Transporte", () => abrirAbaTransporte(page)],
      ["Automação", async () => { await page.locator("#tab-automacao").click(); }],
      ["Resumo", async () => { await page.locator("#btn-resumo-aba").click(); await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo"); }],
    ];
    for (const [nome, ir] of telas) {
      await ir();
      const medidas = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(medidas[0], `${nome} em ${largura}px`).toBeLessThanOrEqual(medidas[1]);
    }
  }
});
