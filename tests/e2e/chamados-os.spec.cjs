const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Janela Chamado × OS: na aba OS (F6), o prefixo UTIC de uma OS vinculada abre #modal-chamado-os.
// O fixture tem a OS 7285070 (série DEMO-SN-001) e o chamado UTIC-2026-1378 entre os novos do F5;
// o vínculo salvo vem só desta rota (nada é gravado no servidor de fixture).

// F5 e F6 ficam na barra principal; abaixo de 1200px só o menu Ferramentas os oferece.
async function abrirAba(page, botaoBarra, itemMenu, titulo) {
  const naBarra = await page.locator(botaoBarra).isVisible();
  if (!naBarra) await page.locator("#cockpit-tools-trigger").click();
  await page.locator(naBarra ? botaoBarra : itemMenu).click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText(titulo);
}

// A OS com marca ativa (ou selo Entregue da Simpress) fica na sub-aba Finalizadas; as demais, em Abertas (a padrão).
async function abrirAbaOsComVinculo(page, numero, { finalizadas = false } = {}) {
  const vinculo = { fonte: "oracle", serie: "DEMO-SN-001", os: "7285070", ano: 2026, numero, origem: "manual", chamado: `UTIC-2026-${numero}` };
  await page.route("**/api/operacoes/chamados/vinculos-os", route => route.request().method() === "GET"
    ? route.fulfill({ json: { vinculos: [vinculo] } })
    : route.fallback());
  await page.goto("/");
  await abrirAba(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu", "OS");
  if (finalizadas) await page.locator("#os-aba-finalizadas").click();
  const gatilho = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"] button.ticket-os-link-goto').first();
  await expect(gatilho).toBeVisible();
  await expect(gatilho).toHaveAttribute("aria-haspopup", "dialog");
  return gatilho;
}

test("Chamado × OS: o UTIC da OS vinculada na aba OS (F6) abre a janela com o chamado e a OS; Esc fecha e devolve o foco", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(modal).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await expect(page.locator("#chamado-os-janela-f6")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});

test("Chamado × OS: chamado ausente da F5 avisa e ainda mostra a OS", async ({ page }) => {
  const gatilho = await abrirAbaOsComVinculo(page, "9999");
  await gatilho.click();
  await expect(page.locator("#modal-chamado-os")).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toHaveText("Chamado não encontrado na aba Chamados (F5).");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.locator('#modal-chamado-os button:text-is("Fechar")').click();
  await expect(page.locator("#modal-chamado-os")).toBeHidden();
  await expect(gatilho).toBeFocused();
});

test("Chamado × OS: o botão da OS no cartão do chamado na aba Chamados (F5) abre a janela; Esc fecha e devolve o foco", async ({ page }) => {
  // A OS do UTIC-2026-1378 no fixture (7303022) não está no relatório da aba OS: só no navegador, a lista
  // de chamados passa a trazer 7285070 (série DEMO-SN-001), que existe lá. Nada é gravado no servidor.
  await page.route("**/api/sebrae/novos", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, body: (await resposta.text()).replaceAll("7303022", "7285070") });
  });
  await page.goto("/");
  await abrirAba(page, "#btn-sebrae-chamados-aba", "#btn-sebrae-chamados-menu", "Chamados");
  const gatilho = page.locator('#sebrae-novos-lista article.sebrae-chamado[data-numero="UTIC-2026-1378"] button.sebrae-chamado__os');
  await expect(gatilho).toHaveText("7285070");
  await gatilho.click();
  const modal = page.locator("#modal-chamado-os");
  await expect(page.getByRole("dialog", { name: "Chamado × OS" })).toBeVisible();
  await expect(page.locator("#chamado-os-janela-chamado")).toContainText("UTIC-2026-1378");
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(gatilho).toBeFocused();
});

// ----- Marca de OS finalizada (célula Chamado da aba OS, F6) -----
// GET/PUT de marcas-finalizacao são simulados no navegador: o fixture nunca grava marcas e nada vai ao SoftExpert.
const EVENTO_PUT = { desfazer: "desfeita", refazer: "refeita", conferir: "conferida" };
const MARCA_SITE = {
  serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1378", origem: "site", motivo: "",
  finalizado_em: "2026-11-08T09:00:00-03:00", ativa: true, conferido_em: "",
  historico: [{ acao: "marcada", origem: "auto", em: "2026-11-08T09:00:00-03:00" }],
};
const MARCA_OUTRO = {
  ...MARCA_SITE, chamado: "UTIC-2026-1379", origem: "outro_tecnico", motivo: "saiu_do_dashboard",
};

async function simularMarcas(page, iniciais) {
  const estado = { marcas: iniciais.map(marca => ({ ...marca, historico: [...marca.historico] })), puts: [] };
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", async route => {
    const pedido = route.request();
    if (pedido.method() === "GET") return route.fulfill({ json: { marcas: estado.marcas } });
    if (pedido.method() !== "PUT") return route.fallback();
    const corpo = pedido.postDataJSON();
    estado.puts.push(corpo);
    const marca = estado.marcas.find(item => item.chamado === corpo.chamado);
    if (!marca) return route.fulfill({ status: 422, json: { detail: "Marca inexistente." } });
    if (corpo.acao === "desfazer") marca.ativa = false;
    if (corpo.acao === "refazer") marca.ativa = true;
    if (corpo.acao === "conferir") marca.conferido_em = "2026-11-08T10:30:00-03:00";
    marca.historico.push({ acao: EVENTO_PUT[corpo.acao], origem: "manual", em: "2026-11-08T10:30:00-03:00" });
    return route.fulfill({ json: { marca } });
  });
  return estado;
}

// Marca ativa leva a OS para a sub-aba Finalizadas; Desfazer a devolve para Abertas (a padrão).
async function abrirF6ComMarcas(page, iniciais, aba = "finalizadas") {
  const estado = await simularMarcas(page, iniciais);
  await page.goto("/");
  await abrirAba(page, "#btn-acompanhamento-chamados", "#btn-chamados-menu", "OS");
  if (aba === "finalizadas") await page.locator("#os-aba-finalizadas").click();
  const linha = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"]').first();
  await expect(linha).toBeVisible();
  return { estado, linha };
}

test("Marca de OS finalizada: selo, Desfazer só com confirmação, Refazer e histórico; nada é gravado fora do PUT local", async ({ page }, testInfo) => {
  const { estado, linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  const bloco = linha.locator(".ck-os-marca");
  await expect(bloco).toHaveCount(1);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(bloco).toContainText("UTIC-2026-1378");
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveCount(0);
  await expect(bloco.getByRole("button", { name: /^Conferido/ })).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    // Telas menores: o bloco cabe na largura da tela, sem rolagem horizontal da página.
    const caixa = await bloco.boundingBox();
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(391);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  // Animação de entrada entre 150 e 300 ms.
  const duracao = await bloco.evaluate(no => parseFloat(getComputedStyle(no).animationDuration));
  expect(duracao).toBeGreaterThanOrEqual(0.15);
  expect(duracao).toBeLessThanOrEqual(0.3);

  await bloco.locator("summary").click();
  await expect(bloco.locator("summary")).toHaveText("Histórico da marca");
  await expect(bloco.locator(".ck-os-marca__lista li")).toHaveText(["08/11/2026 às 09:00 · Marcada (automática)"]);

  // Cancelar a confirmação não envia nada.
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await expect(page.locator("#mensagem-confirmar-acao")).toContainText("não é reaberto no SoftExpert");
  await page.locator("#btn-confirmar-acao-cancelar").click();
  expect(estado.puts).toHaveLength(0);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveCount(1);

  // Confirmar desfaz: a OS volta para Abertas (a linha sai das Finalizadas) e o foco vai para a aba ativa.
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  expect(estado.puts).toEqual([{ serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1378", acao: "desfazer" }]);
  await expect(linha).toBeHidden();
  await expect(page.locator("#os-aba-finalizadas")).toBeFocused();
  await page.locator("#os-aba-abertas").click();
  const desfeita = linha.locator('.ck-os-marca[data-ativa="false"]');
  await expect(desfeita).toHaveCount(1);
  await expect(linha).toHaveAttribute("data-finalizada", "false");
  await expect(desfeita.locator(".ck-os-marca__selo")).toHaveCount(0);
  await expect(desfeita.getByRole("button", { name: "Refazer, chamado UTIC-2026-1378" })).toBeVisible();
  await desfeita.locator("summary").click();
  await expect(desfeita.locator(".ck-os-marca__lista li")).toHaveText([
    "08/11/2026 às 09:00 · Marcada (automática)",
    "08/11/2026 às 10:30 · Desfeita (manual)",
  ]);

  // Refazer devolve a OS para Finalizadas.
  await desfeita.getByRole("button", { name: "Refazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  await expect(linha).toBeHidden();
  await page.locator("#os-aba-finalizadas").click();
  await expect(linha.locator('.ck-os-marca[data-ativa="true"] .ck-os-marca__selo')).toHaveText("Chamado finalizado");
  expect(estado.puts.map(item => item.acao)).toEqual(["desfazer", "refazer"]);
});

test("Marca de OS finalizada: finalizado por outro técnico mostra motivo e dica; Conferido grava só a conferência", async ({ page }) => {
  const { estado, linha } = await abrirF6ComMarcas(page, [MARCA_OUTRO]);
  const bloco = linha.locator(".ck-os-marca");
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Finalizado por outro técnico");
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveText("Conferir no SoftExpert");
  await expect(bloco.locator(".ck-os-marca__motivo")).toHaveText("Saiu da lista de abertos do Dashboard sem finalização pelo site.");
  await bloco.getByRole("button", { name: "Conferido, chamado UTIC-2026-1379" }).click();
  // Conferir não abre confirmação: a dica e o botão saem e o histórico registra a conferência.
  await expect(page.locator("#modal-confirmar-acao")).toBeHidden();
  await expect(bloco.locator(".ck-os-marca__dica")).toHaveCount(0);
  await expect(bloco.getByRole("button", { name: /^Conferido/ })).toHaveCount(0);
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Finalizado por outro técnico");
  expect(estado.puts).toEqual([{ serie: "DEMO-SN-001", os: "7285070", chamado: "UTIC-2026-1379", acao: "conferir" }]);
  await bloco.locator("summary").click();
  await expect(bloco.locator(".ck-os-marca__lista li").last()).toHaveText("08/11/2026 às 10:30 · Conferida (manual)");
});

test("Marca de OS finalizada: falha do PUT mostra o erro, mantém a marca e reabilita os botões", async ({ page }) => {
  const { linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  await page.route("**/api/operacoes/chamados/marcas-finalizacao", route => route.request().method() === "PUT"
    ? route.fulfill({ status: 503, json: { detail: "Marcas indisponíveis no momento." } })
    : route.fallback());
  const bloco = linha.locator(".ck-os-marca");
  await bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" }).click();
  await page.locator("#btn-confirmar-acao-ok").click();
  // A mensagem de status da tabela fica na barra das sub-abas (#cockpit-tickets-contagem).
  await expect(page.locator("#cockpit-tickets-contagem")).toContainText("Marcas indisponíveis no momento.");
  await expect(bloco.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(bloco.getByRole("button", { name: "Desfazer, chamado UTIC-2026-1378" })).toBeEnabled();
});

test("Marca de OS finalizada: movimento reduzido desliga a animação de entrada", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { linha } = await abrirF6ComMarcas(page, [MARCA_SITE]);
  const duracao = await linha.locator(".ck-os-marca").evaluate(no => parseFloat(getComputedStyle(no).animationDuration));
  expect(duracao).toBeLessThan(0.01);
});

test("Marca de OS finalizada: a janela Chamado × OS (somente leitura) mostra só o selo do chamado, sem botões nem histórico", async ({ page }) => {
  // Duas marcas na mesma OS: a do chamado da janela (ativa) e outra de outro chamado; só a primeira aparece.
  await simularMarcas(page, [MARCA_SITE, { ...MARCA_OUTRO, chamado: "UTIC-2026-4000" }]);
  const gatilho = await abrirAbaOsComVinculo(page, "1378", { finalizadas: true });
  await gatilho.click();
  await expect(page.locator("#modal-chamado-os")).toBeVisible();
  const janela = page.locator("#chamado-os-janela-os");
  await expect(janela.locator(".ck-os-marca")).toHaveCount(1);
  await expect(janela.locator(".ck-os-marca__selo")).toHaveText("Chamado finalizado");
  await expect(janela.locator(".ck-os-marca button, .ck-os-marca details")).toHaveCount(0);
});

test("Marca de OS finalizada: marca desfeita não aparece na janela Chamado × OS", async ({ page }) => {
  await simularMarcas(page, [{ ...MARCA_SITE, ativa: false }]);
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  await gatilho.click();
  await expect(page.locator("#chamado-os-janela-os")).toContainText("7285070");
  await expect(page.locator("#chamado-os-janela-os .ck-os-marca")).toHaveCount(0);
});

test("Aba OS (F6): selos Técnico e Aberta há N dias aparecem na célula da OS e na janela Chamado × OS", async ({ page }) => {
  // O fixture não calcula os campos; só no navegador a resposta de GET ganha os sinais da OS 7285070.
  await page.route("**/api/operacoes/chamados", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const corpo = await (await route.fetch()).json();
    Object.assign(corpo.chamados[0].oracle[0], { envio_tecnico: true, dias_aberta: 3 });
    await route.fulfill({ json: corpo });
  });
  const gatilho = await abrirAbaOsComVinculo(page, "1378");
  const celula = page.locator('#cockpit-tickets-os tbody tr[data-serial="DEMO-SN-001"] td[data-label="OS"]').first();
  const dias = celula.locator(".ck-os__selo--dias");
  const tecnico = celula.locator(".ck-os__selo--tecnico");
  await expect(dias).toHaveText("Aberta há 3 dias");
  await expect(tecnico).toHaveText("Técnico");
  await gatilho.click();
  await expect(page.locator("#chamado-os-janela-os .ck-os__selo--dias")).toHaveText("Aberta há 3 dias");
  await expect(page.locator("#chamado-os-janela-os .ck-os__selo--tecnico")).toHaveText("Técnico");
});

// ---- Helpers do painel Chamados (F5), copiados de sebrae-dashboard.spec.cjs: cada spec é autônomo, não há arquivo comum ----
// The fixture answers /api/sebrae/* with fictional tickets; no Chrome, SoftExpert or Dashboard file is touched.
async function abrirCartao(page, request, extra = "", antigos = "", consulta = "") {
  await request.get(`/__fixture_automacao?quantidade=0&sebrae=padrao&run=${extra}&antigos=${antigos}${consulta}`);
  await page.goto("/");
  await page.locator("#tab-automacao").click();
  const cartao = page.locator("#sebrae-novos-painel");
  await expect(cartao).toBeVisible();
  return cartao;
}

// A lista, os antigos, a exportação e Atualizar Dashboard moram no painel Chamados (F5; barra principal, menu Ferramentas ou botão do cartão).
async function abrirPainel(page, request, extra = "", antigos = "", consulta = "") {
  const cartao = await abrirCartao(page, request, extra, antigos, consulta);
  await expect(cartao.locator("#sebrae-novos-resumo")).toContainText("novo(s)"); // a lista já foi carregada
  await cartao.locator("#btn-sebrae-abrir-chamados").click();
  const painel = page.locator('[data-cockpit-tool-panel="sebrae-chamados"]');
  await expect(painel).toBeVisible();
  return { cartao, painel };
}

// Cada antigo é um `details.sebrae-antigo` recolhido (resumo + cartão): abre o do cartão `antigo` se ainda estiver fechado.
async function abrirItemAntigo(antigo) {
  const item = antigo.locator("xpath=..");
  if (!(await item.evaluate(no => no.open))) await item.locator("> summary").click();
  await expect(antigo).toBeVisible();
}

// "Chamados antigos em aberto" é a sub-aba Antigos do F5 (07/11/2026): seleciona a aba e espera o painel.
async function abrirSecaoAntigos(painel) {
  await painel.locator("#sebrae-aba-antigos").click();
  await expect(painel.locator("#sebrae-antigos-lista")).toBeVisible();
}

// ---- OS nova sugerida no cartão aberto do antigo (F5, 17/11/2026) ----
// O servidor de teste não devolve `os_nova`: a rota troca GET /api/sebrae/novos por três antigos sintéticos (sugestão, chamado sem OS e
// troca já feita) e imita as duas gravações (vinculos-os e os-recusada). Nada vai ao SoftExpert, ao SharePoint nem aos dados reais.
const CHAMADOS_OS = { sugestao: "UTIC-2026-1200", sem_os: "UTIC-2026-1300", troca: "UTIC-2026-1301" };

function osNovaDe(tipo, chamado, os, atual) {
  const [, ano, numero] = chamado.split("-");
  return {
    tipo, atual,
    nova: { os, serie: "DEMO0001", fonte: "sebrae", assunto: `Teclado sem resposta (OS ${os})`, descricao: `Descrição sintética da OS ${os}.`, data: "15/11/2026" },
    sinais: { mesma_serie: tipo !== "sem_os", nome: tipo === "sem_os", assunto: true, numero_chamado: tipo === "troca" },
    aceitar: { fonte: "sebrae", serie: "DEMO0001", os, ano, numero },
  };
}

async function simularOsNova(page) {
  const estado = { vinculos: [], recusas: [], leituras: 0, tentativas: 0, falhar: false, decididos: new Set() };
  await page.route("**/api/sebrae/novos", async rota => {
    const resposta = await rota.fetch();
    const corpo = await resposta.json();
    estado.leituras += 1;
    const base = corpo.importado.abertos.find(item => item.numero === CHAMADOS_OS.sugestao);
    const decidido = numero => estado.decididos.has(numero);
    const antigo = (numero, titulo, extra) => ({ ...structuredClone(base), numero, chamado: numero, titulo, ...extra });
    corpo.importado.abertos = [
      antigo(CHAMADOS_OS.sugestao, "Teclado sem resposta", {
        automaticos: { E: "7303022", K: "DEMO0001" }, automaticos_sugeridos: {},
        os_nova: decidido(CHAMADOS_OS.sugestao) ? null : osNovaDe("sugestao", CHAMADOS_OS.sugestao, "7400000", { os: "7303022", assunto: "Teclado sem resposta (OS antiga)", descricao: "", data: "03/11/2026" }),
      }),
      antigo(CHAMADOS_OS.sem_os, "Monitor sem imagem", {
        automaticos: {}, automaticos_sugeridos: { K: "DEMO0002" },
        os_nova: decidido(CHAMADOS_OS.sem_os) ? null : osNovaDe("sem_os", CHAMADOS_OS.sem_os, "7400001", null),
      }),
      antigo(CHAMADOS_OS.troca, "Notebook não liga", {
        automaticos: { E: "7400002", K: "DEMO0003" }, automaticos_sugeridos: {},
        os_nova: osNovaDe("troca", CHAMADOS_OS.troca, "7400002", { os: "7303000", assunto: "Notebook não liga (OS antiga)", descricao: "Sem descrição.", data: "02/11/2026" }),
      }),
    ];
    await rota.fulfill({ response: resposta, json: corpo });
  });
  await page.route("**/api/operacoes/chamados/vinculos-os", async rota => {
    if (rota.request().method() !== "PUT") return rota.fallback();
    estado.tentativas += 1;
    if (estado.falhar) return rota.fulfill({ status: 500, json: { detail: "Falha sintética ao gravar." } });
    const corpo = rota.request().postDataJSON();
    estado.vinculos.push(corpo);
    estado.decididos.add(`UTIC-${corpo.ano}-${corpo.numero}`);
    return rota.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/sebrae/chamados/*/os-recusada", async rota => {
    if (rota.request().method() !== "PUT") return rota.fallback();
    estado.tentativas += 1;
    if (estado.falhar) return rota.fulfill({ status: 500, json: { detail: "Falha sintética ao gravar." } });
    const numero = decodeURIComponent(new URL(rota.request().url()).pathname.split("/")[4]);
    estado.recusas.push({ numero, corpo: rota.request().postDataJSON() });
    estado.decididos.add(numero);
    return rota.fulfill({ json: { ok: true } });
  });
  return estado;
}

async function abrirChamadoOs(page, request, numero) {
  const simulacao = await simularOsNova(page);
  const { painel } = await abrirPainel(page, request);
  await abrirSecaoAntigos(painel);
  const lista = painel.locator("#sebrae-antigos-lista");
  const linha = lista.locator(`details.sebrae-antigo:has(.sebrae-chamado[data-numero="${numero}"])`);
  const cartao = lista.locator(`.sebrae-chamado[data-numero="${numero}"]`);
  return { simulacao, painel, linha, cartao, seloNovo: linha.locator("> summary .sebrae-selo-os-nova"), campoOs: cartao.locator(".ck-fatos > div").filter({ has: page.locator("dt", { hasText: /^OS$/ }) }).locator("dd"), caixa: cartao.locator("[data-sugestao-os] .sebrae-osnova"), nota: cartao.locator("[data-sugestao-os] [data-nota-os]") };
}

test("OS nova sugerida: mostra selo, campo e caixa; Aceitar grava o vínculo pronto do servidor, recarrega e deixa a nota com o foco", async ({ page, request }) => {
  const { simulacao, linha, cartao, seloNovo, campoOs, caixa, nota } = await abrirChamadoOs(page, request, CHAMADOS_OS.sugestao);
  await expect(seloNovo).toHaveText("OS nova?");
  await abrirItemAntigo(cartao);
  await expect(campoOs).toHaveText("7303022 mais nova: 7400000?");
  await expect(caixa.getByRole("heading", { name: "OS mais nova na mesma série: 7400000" })).toBeVisible();
  await expect(caixa).toContainText("O número do chamado não está na OS, então a troca espera a sua decisão.");
  await expect(caixa.locator(".sebrae-osnova__chip")).toHaveText(["Mesma série", "Assunto parecido"]);
  const cartoes = caixa.locator(".sebrae-osnova__os");
  await expect(cartoes).toHaveCount(2);
  await expect(cartoes.first()).toContainText("atual · 03/11/2026");
  await expect(cartoes.first()).toContainText("Descrição não disponível"); // a OS atual veio sem descrição
  await expect(cartoes.nth(1)).toContainText("mais nova · 15/11/2026");
  await expect(cartoes.nth(1)).toContainText("Descrição sintética da OS 7400000.");
  await expect(caixa.getByRole("button", { name: "Manter 7303022" })).toBeVisible();
  const leiturasAntes = simulacao.leituras;
  await caixa.getByRole("button", { name: "Aceitar 7400000" }).click();
  await expect(nota).toHaveText("OS 7400000 aceita. A aba OS já mostra o vínculo.");
  await expect(nota).toHaveAttribute("data-tipo", "ok");
  await expect(nota).toBeFocused();
  expect(simulacao.vinculos).toEqual([osNovaDe("sugestao", CHAMADOS_OS.sugestao, "7400000", null).aceitar]);
  expect(simulacao.recusas).toEqual([]);
  expect(simulacao.leituras).toBeGreaterThan(leiturasAntes); // o F5 recarregou depois da gravação
  await expect(cartao).toBeVisible(); // a linha refeita volta aberta, no mesmo chamado
  await expect(linha.locator("> summary .sebrae-selo-os-nova")).toHaveCount(0);
  await expect(cartao.locator("[data-sugestao-os]").getByRole("button")).toHaveCount(0);
});

test("OS nova sugerida: chamado sem OS mostra 'sem OS sugerida' e Recusar grava só o par chamado + OS", async ({ page, request }) => {
  const { simulacao, cartao, seloNovo, campoOs, caixa, nota } = await abrirChamadoOs(page, request, CHAMADOS_OS.sem_os);
  await expect(seloNovo).toHaveText("OS nova?");
  await abrirItemAntigo(cartao);
  await expect(campoOs).toHaveText("sem OS sugerida: 7400001?");
  await expect(caixa.getByRole("heading", { name: "OS encontrada para este chamado: 7400001" })).toBeVisible();
  await expect(caixa.locator(".sebrae-osnova__os")).toHaveCount(1);
  await expect(caixa.locator(".sebrae-osnova__os")).toContainText("encontrada · 15/11/2026");
  await expect(caixa.getByRole("button", { name: "Aceitar 7400001" })).toBeVisible();
  await caixa.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(nota).toHaveText("OS 7400001 recusada. Ela não volta a ser sugerida para este chamado.");
  await expect(nota).toHaveAttribute("data-tipo", "neutro");
  await expect(nota).toBeFocused();
  expect(simulacao.recusas).toEqual([{ numero: CHAMADOS_OS.sem_os, corpo: { os: "7400001" } }]);
  expect(simulacao.vinculos).toEqual([]);
  await expect(cartao.locator("[data-sugestao-os]").getByRole("button")).toHaveCount(0);
});

test("OS nova sugerida: Manter a OS atual grava a recusa da OS nova", async ({ page, request }) => {
  const { simulacao, caixa, cartao, nota } = await abrirChamadoOs(page, request, CHAMADOS_OS.sugestao);
  await abrirItemAntigo(cartao);
  await caixa.getByRole("button", { name: "Manter 7303022" }).click();
  await expect(nota).toHaveText("OS 7400000 recusada. Ela não volta a ser sugerida para este chamado.");
  expect(simulacao.recusas).toEqual([{ numero: CHAMADOS_OS.sugestao, corpo: { os: "7400000" } }]);
  expect(simulacao.vinculos).toEqual([]);
});

test("OS nova sugerida: troca automática só mostra a nota verde, sem selo, sem marca no campo e sem botões", async ({ page, request }) => {
  const { simulacao, cartao, seloNovo, campoOs, nota } = await abrirChamadoOs(page, request, CHAMADOS_OS.troca);
  await expect(seloNovo).toHaveCount(0);
  await abrirItemAntigo(cartao);
  await expect(campoOs).toHaveText("7400002");
  await expect(nota).toHaveText("OS trocada sozinha: o número do chamado está no assunto da OS 7400002.");
  await expect(nota).toHaveAttribute("data-tipo", "ok");
  await expect(cartao.locator("[data-sugestao-os]").getByRole("button")).toHaveCount(0);
  await expect(cartao.locator(".sebrae-osnova")).toHaveCount(0);
  expect(simulacao.tentativas).toBe(0);
});

test("OS nova sugerida: erro ao gravar mostra aviso curto, devolve os botões e não repete sozinho", async ({ page, request }) => {
  const { simulacao, cartao, caixa, nota } = await abrirChamadoOs(page, request, CHAMADOS_OS.sugestao);
  await abrirItemAntigo(cartao);
  simulacao.falhar = true;
  await caixa.getByRole("button", { name: "Aceitar 7400000" }).click();
  await expect(caixa.getByRole("alert")).toContainText("Falha sintética ao gravar.");
  await expect(caixa.getByRole("button", { name: "Aceitar 7400000" })).toBeEnabled();
  await expect(caixa.getByRole("button", { name: "Manter 7303022" })).toBeEnabled();
  await page.waitForTimeout(700);
  expect(simulacao.tentativas).toBe(1); // sem repetição automática
  expect(simulacao.vinculos).toEqual([]);
  simulacao.falhar = false;
  await caixa.getByRole("button", { name: "Aceitar 7400000" }).click();
  await expect(nota).toHaveText("OS 7400000 aceita. A aba OS já mostra o vínculo.");
  expect(simulacao.tentativas).toBe(2);
});

test("OS nova sugerida: as duas OS empilham no celular e lado a lado no desktop, sem rolagem horizontal; movimento reduzido e axe nos dois temas", async ({ page, request }) => {
  const { cartao, caixa } = await abrirChamadoOs(page, request, CHAMADOS_OS.sugestao);
  await abrirItemAntigo(cartao);
  const cartoes = caixa.locator(".sebrae-osnova__os");
  for (const [largura, empilha] of [[390, true], [320, true], [1280, false]]) {
    await page.setViewportSize({ width: largura, height: 900 });
    await expect(cartoes.nth(1)).toBeVisible();
    const [a, b] = [await cartoes.first().boundingBox(), await cartoes.nth(1).boundingBox()];
    if (empilha) expect(b.y, `${largura}px`).toBeGreaterThanOrEqual(a.y + a.height - 1);
    else expect(b.x, `${largura}px`).toBeGreaterThan(a.x + a.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `página a ${largura}px`).toBe(true);
    expect(await caixa.evaluate(no => no.scrollWidth <= no.clientWidth), `caixa a ${largura}px`).toBe(true);
    for (const botao of await caixa.locator(".sebrae-osnova__acoes .ck-btn").all()) expect((await botao.boundingBox()).height, `botão a ${largura}px`).toBeGreaterThanOrEqual(44);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await caixa.evaluate(no => getComputedStyle(no).animationName)).toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(await caixa.evaluate(no => getComputedStyle(no).animationName)).not.toBe("none");
  expect(await caixa.evaluate(no => Number.parseFloat(getComputedStyle(no).animationDuration) * 1000)).toBeLessThanOrEqual(300);
  for (const tema of ["light", "dark"]) {
    await page.evaluate(valor => document.documentElement.setAttribute("data-theme", valor), tema);
    const resultado = await new AxeBuilder({ page }).include("#sebrae-antigos-lista [data-sugestao-os]").analyze();
    expect(resultado.violations.map(v => `${v.id}: ${v.nodes.length}`), tema).toEqual([]);
  }
});
