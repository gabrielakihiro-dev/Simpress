const { test, expect } = require("@playwright/test");
const AxeBuilder = require("@axe-core/playwright").default;

// Resumo (F3), sub-aba Backups + cartão do sino. Só a fixture (porta 8765): séries TSTBK*, apelidos "Estacao Teste N", nada real.
// Estado padrão da fixture: Cascavel sem backup; Londrina "conferir" (TSTBK0001 confirmável); Pato Branco ok, com TSTBK0004 por confirmação.
// O estado vive na memória do servidor e é compartilhado pelos projetos: cada teste zera antes e depois.

const APELIDO = "Estacao Teste";
const ABA = "#resumo-aba-backups";
const PAINEL = "#resumo-painel-backups";
const CONTEUDO = "#comparacao-planilhas-conteudo";
const CARTAO = "#alerta-backups-regionais";
const SELO_ABA = "#resumo-backups-contagem";
const ABAS_RESUMO = ["visao", "divergencias", "apelidos", "usuarios", "sem-acesso", "backups"];
const EVENTO_ANTERIOR = "fixture-event-000";

async function zerarFixture(request) {
  await request.get("/__fixture_cockpit?comparacao=0");
  await request.get("/__fixture_alertas_painel?estado=ocultos"); // o selo "1" do sino conta só o cartão de backups
  await request.get("/__fixture_base_desatualizada?estado=atualizada");
  await request.get("/__fixture_backups?estado=padrao");
}

test.beforeEach(({ request }) => zerarFixture(request));
test.afterEach(({ request }) => zerarFixture(request));

const linha = (page, cidade) => page.locator(`${PAINEL} tbody tr`).filter({ has: page.locator(".ck-backups__cidade", { hasText: cidade }) });
const aba = (page, chave) => page.locator(`#resumo-aba-${chave}`);

// openPanel recarrega o histórico e pode refazer o Resumo; só depois disso a aba e o teclado são estáveis.
async function esperarResumoPronto(page) {
  await expect(page.locator("#cockpit-comparison-status")).not.toContainText("Carregando");
  await expect(page.locator(SELO_ABA)).toHaveText(/^\d+$/); // o /api/painel já chegou ao módulo
}

async function abrirResumo(page) {
  await page.goto("/");
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await esperarResumoPronto(page);
}

async function abrirSino(page) {
  // Alterna aberto/fechado: só clica se o painel ainda estiver fechado.
  if (await page.locator("#notification-center-panel").isHidden()) await page.locator("#btn-notificacoes").click();
  await expect(page.locator("#notification-center-panel")).toBeVisible();
  await expect(page.locator(CARTAO)).toBeVisible();
}

async function fecharSino(page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("#notification-center-panel")).toBeHidden();
}

async function irParaBackupsPeloSino(page) {
  await abrirSino(page);
  await page.locator("#btn-alerta-backups-regionais").click();
  await expect(page.locator("#notification-center-panel")).toBeHidden();
  await expect(page.locator("#cockpit-tool-title")).toHaveText("Resumo");
  await esperarResumoPronto(page);
}

async function esperarBackupsAberta(page) {
  await expect(page.locator(ABA)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(ABA)).toHaveAttribute("tabindex", "0");
  await expect(page.locator(PAINEL)).toBeVisible();
  await expect(page.locator(CONTEUDO)).toBeHidden();
  await expect(page.locator("#resumo-ativos-secao")).toBeHidden();
  for (const outra of ABAS_RESUMO.filter(chave => chave !== "backups")) await expect(aba(page, outra)).toHaveAttribute("aria-selected", "false");
  await expect(linha(page, "Londrina")).toBeVisible();
}

const semRolagemHorizontal = page => page.evaluate(() => {
  const excesso = seletor => {
    const no = document.querySelector(seletor);
    return no ? no.scrollWidth - no.clientWidth : 0;
  };
  return {
    documento: excesso("html"), corpo: document.body.scrollWidth - document.documentElement.clientWidth,
    painelFerramenta: excesso("#cockpit-tool-panels"), painelBackups: excesso("#resumo-painel-backups"),
  };
});

test("o botão do sino abre o Resumo direto em Backups, mesmo sem nenhum evento de comparação", async ({ page }) => {
  // A fixture sempre devolve eventos; o histórico vazio vem de uma rota simulada (mesmo padrão de mockComparison).
  await page.route("**/api/historico-comparacoes", route => route.fulfill({ json: { eventos: [], total: 0 } }));
  await page.goto("/");
  await irParaBackupsPeloSino(page);
  await expect(page.locator("#cockpit-comparison-event option")).toHaveCount(0);
  await expect(page.locator("#cockpit-comparison-event")).toBeDisabled();
  await esperarBackupsAberta(page);
  await expect(linha(page, "Cascavel").locator(".ck-badge")).toHaveText("Sem backup disponível");
});

test("o botão do sino abre Backups também com outro evento de comparação selecionado", async ({ page }) => {
  await abrirResumo(page);
  const evento = page.locator("#cockpit-comparison-event");
  await expect(evento.locator("option")).toHaveCount(2);
  await evento.selectOption(EVENTO_ANTERIOR);
  await expect(page.locator("#cockpit-comparison-status")).toContainText("2026-10-07");
  await expect(aba(page, "divergencias")).toHaveAttribute("aria-selected", "true");
  // O sino fica acessível com o painel aberto; a escolha do evento vive no módulo e não pode se perder.
  await irParaBackupsPeloSino(page);
  await expect(evento).toHaveValue(EVENTO_ANTERIOR);
  await esperarBackupsAberta(page);
  // Voltar a Divergências mostra o conteúdo da comparação de novo.
  await aba(page, "divergencias").click();
  await expect(page.locator(CONTEUDO)).toBeVisible();
  await expect(page.locator(PAINEL)).toBeHidden();
  await expect(evento).toHaveValue(EVENTO_ANTERIOR);
});

test("teclado: End chega em Backups, Home volta à primeira aba e as setas circulam por todas", async ({ page }) => {
  await abrirResumo(page);
  const foco = async chave => {
    await expect(aba(page, chave)).toBeFocused();
    await expect(aba(page, chave)).toHaveAttribute("aria-selected", "true");
    await expect(aba(page, chave)).toHaveAttribute("tabindex", "0");
  };
  await aba(page, "divergencias").focus();
  await page.keyboard.press("End");
  await foco("backups");
  await expect(page.locator(PAINEL)).toBeVisible();
  await expect(page.locator(CONTEUDO)).toBeHidden();
  await expect(aba(page, "divergencias")).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("Home");
  await foco("visao");
  await expect(page.locator(PAINEL)).toBeHidden();
  await expect(aba(page, "backups")).toHaveAttribute("aria-selected", "false");
  await expect(aba(page, "backups")).toHaveAttribute("tabindex", "-1");

  for (const chave of ABAS_RESUMO.slice(1)) {
    await page.keyboard.press("ArrowRight");
    await foco(chave);
  }
  await expect(page.locator(PAINEL)).toBeVisible();
  await page.keyboard.press("ArrowRight"); // de Backups, a seta volta à primeira
  await foco("visao");
  await page.keyboard.press("ArrowLeft"); // da primeira, a seta volta a Backups
  await foco("backups");
  for (const chave of [...ABAS_RESUMO].reverse().slice(1)) {
    await page.keyboard.press("ArrowLeft");
    await foco(chave);
  }
});

test("confirmar e desfazer atualizam a linha, o cartão do sino e o selo da aba", async ({ page }) => {
  test.slow();
  await abrirResumo(page);
  await irParaBackupsPeloSino(page);
  await esperarBackupsAberta(page);
  const selo = page.locator(SELO_ABA);
  const londrina = linha(page, "Londrina");
  const badgeSino = page.locator("#badge-notificacoes");
  const itensSino = page.locator(`${CARTAO} li`);
  const confirmar = page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" });
  const desfazer = page.getByRole("button", { name: "Desfazer confirmação: série TSTBK0001, Londrina" });

  await expect(selo).toHaveText("2");
  await expect(londrina.locator(".ck-badge")).toHaveText("Conferir possível backup");
  await expect(desfazer).toHaveCount(0);
  await abrirSino(page);
  await expect(page.locator(`${CARTAO} .ck-badge`)).toHaveText("Urgente");
  await expect(page.locator(`${CARTAO}-titulo`)).toHaveText("Sem backup disponível");
  await expect(itensSino).toHaveText(["Cascavel — sem backup disponível", "Londrina — conferir possível backup"]);
  await expect(badgeSino).toHaveText("1");
  await fecharSino(page);

  // Confirmar TSTBK0001: Londrina passa a "Backup disponível"; o sino fica só com Cascavel e o selo da aba cai para 1.
  await confirmar.click();
  await expect(londrina.locator(".ck-badge")).toHaveText("Backup disponível");
  await expect(selo).toHaveText("1");
  await expect(desfazer).toBeVisible();
  await expect(confirmar).toHaveCount(0);
  await abrirSino(page);
  await expect(page.locator(`${CARTAO} .ck-badge`)).toHaveText("Urgente");
  await expect(page.locator(`${CARTAO}-titulo`)).toHaveText("Sem backup disponível");
  await expect(itensSino).toHaveText(["Cascavel — sem backup disponível"]);
  await expect(badgeSino).toHaveText("1");
  await fecharSino(page);

  // Desfazer na mesma série: volta a "Conferir possível backup" e o sino lista as duas regionais de novo.
  await desfazer.click();
  await expect(londrina.locator(".ck-badge")).toHaveText("Conferir possível backup");
  await expect(selo).toHaveText("2");
  await expect(confirmar).toBeVisible();
  await expect(desfazer).toHaveCount(0);
  await abrirSino(page);
  await expect(itensSino).toHaveText(["Cascavel — sem backup disponível", "Londrina — conferir possível backup"]);
  await fecharSino(page);

  // Pato Branco: TSTBK0004 (confirmado manualmente) deixa de contar; o status segue "Backup disponível" por causa de TSTBK0003.
  const pato = linha(page, "Pato Branco");
  const desfazerPato = page.getByRole("button", { name: "Desfazer confirmação: série TSTBK0004, Pato Branco" });
  await expect(pato.locator(".ck-backups__nota", { hasText: "+1 além do mínimo" })).toBeVisible();
  await expect(pato.locator(".ck-badge")).toHaveText("Backup disponível");
  await desfazerPato.click();
  await expect(desfazerPato).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0004, Pato Branco" })).toBeVisible();
  await expect(pato.locator(".ck-backups__nota", { hasText: "além do mínimo" })).toHaveCount(0);
  await expect(pato.locator(".ck-badge")).toHaveText("Backup disponível");
  await expect(selo).toHaveText("2");
});

// Regressão: app.js entrega a fábrica do renderer; sem instanciá-la, o aria-label ficava em "Backups: aguardando dados".
test("o rótulo acessível da aba Backups acompanha o selo", async ({ page }) => {
  await abrirResumo(page);
  await expect(aba(page, "backups")).toHaveAttribute("aria-label", "Backups: 2 regionais pendentes");
  await irParaBackupsPeloSino(page);
  await esperarBackupsAberta(page);
  await page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" }).click();
  await expect(aba(page, "backups")).toHaveAttribute("aria-label", "Backups: 1 regional pendente");
});

// Regional fora das prioritárias (Curitiba): o candidato TSTBK0008 vira "sobra" ao confirmar, com o Desfazer na própria seção.
test("sobra fora das prioritárias: confirmar mostra Desfazer em Sobras e desfazer devolve o candidato, com foco e sem rolagem horizontal", async ({ page }) => {
  test.slow();
  await abrirResumo(page);
  await irParaBackupsPeloSino(page);
  await esperarBackupsAberta(page);
  const secao = titulo => page.locator(`${PAINEL} .ck-backups__secao`).filter({ has: page.getByRole("heading", { name: titulo }) });
  const sobras = secao("Sobras");
  const demais = secao("Candidatos nas demais regionais");
  const nomeConfirmar = "Confirmar disponível por 7 dias: série TSTBK0008, Curitiba";
  const nomeDesfazer = "Desfazer confirmação: série TSTBK0008, Curitiba";
  const sobraCuritiba = sobras.locator("li").filter({ has: page.locator(".ck-backups__cidade", { hasText: "Curitiba" }) }).first();

  // Estado inicial: TSTBK0008 é candidato de Curitiba; Curitiba não tem sobra. Pato Branco tem sobra prioritária (TSTBK0004) sem botão.
  await expect(demais.getByRole("button", { name: nomeConfirmar })).toBeVisible();
  await expect(sobras.locator(".ck-backups__cidade", { hasText: "Curitiba" })).toHaveCount(0);
  await expect(sobras.locator(".ck-backups__cidade", { hasText: "Pato Branco" })).toHaveCount(1);
  await expect(sobras.locator("code", { hasText: "TSTBK0004" })).toBeVisible();
  await expect(sobras.getByRole("button")).toHaveCount(0);
  const desfazerPato = page.getByRole("button", { name: "Desfazer confirmação: série TSTBK0004, Pato Branco" });
  await expect(desfazerPato).toHaveCount(1); // o da tabela; a sobra prioritária não repete

  // Confirmar: o candidato sai de "demais regionais" e aparece em Sobras, com origem, data e Desfazer.
  await demais.getByRole("button", { name: nomeConfirmar }).click();
  const desfazer = sobras.getByRole("button", { name: nomeDesfazer });
  await expect(desfazer).toBeVisible();
  await expect(desfazer).toHaveAttribute("data-serie", "TSTBK0008");
  await expect(desfazer).toHaveAttribute("data-cidade", "Curitiba");
  await expect(sobraCuritiba.locator("code", { hasText: "TSTBK0008" })).toBeVisible();
  await expect(sobraCuritiba).toContainText("Confirmado manualmente");
  await expect(sobraCuritiba).toContainText("confirmado até");
  await expect(sobraCuritiba).toContainText("1 backup em regional fora das prioritárias");
  await expect(page.getByRole("button", { name: nomeConfirmar })).toHaveCount(0);
  await expect(demais).toHaveCount(0); // Curitiba era o único grupo com candidatos
  await expect(desfazerPato).toHaveCount(1); // continua só o da tabela
  await expect(sobras.getByRole("button")).toHaveCount(1);
  // O redesenho troca Confirmar por Desfazer: o foco vai ao botão da mesma série e cidade.
  await expect(desfazer).toBeFocused();

  // 320px com a sobra confirmada: sem rolagem horizontal e o botão Desfazer inteiro na largura.
  await page.setViewportSize({ width: 320, height: 800 });
  for (const [nome, excesso] of Object.entries(await semRolagemHorizontal(page))) expect(excesso, `320px com sobra: ${nome}`).toBeLessThanOrEqual(0);
  await desfazer.scrollIntoViewIfNeeded();
  const caixa = await desfazer.boundingBox();
  expect(caixa.x).toBeGreaterThanOrEqual(0);
  expect(caixa.x + caixa.width).toBeLessThanOrEqual(320);

  // Desfazer: a sobra de Curitiba some e o candidato volta, com o foco no Confirmar da mesma série.
  await desfazer.click();
  const confirmar = page.getByRole("button", { name: nomeConfirmar });
  await expect(confirmar).toBeVisible();
  await expect(demais.getByRole("button", { name: nomeConfirmar })).toBeVisible();
  await expect(page.getByRole("button", { name: nomeDesfazer })).toHaveCount(0);
  await expect(sobras.locator(".ck-backups__cidade", { hasText: "Curitiba" })).toHaveCount(0);
  await expect(sobras.locator(".ck-backups__cidade", { hasText: "Pato Branco" })).toHaveCount(1); // a sobra prioritária segue
  await expect(confirmar).toBeFocused();
  expect(await page.evaluate(() => ({ ...document.activeElement.dataset }))).toEqual({ backupAcao: "confirmar", serie: "TSTBK0008", cidade: "Curitiba" });
  for (const [nome, excesso] of Object.entries(await semRolagemHorizontal(page))) expect(excesso, `320px depois de desfazer: ${nome}`).toBeLessThanOrEqual(0);
});

for (const largura of [320]) {
  test(`${largura}px: sem rolagem horizontal com a sub-aba Backups e com o sino abertos, e a tabela vira cards`, async ({ page }) => {
    await page.setViewportSize({ width: largura, height: 800 });
    await page.goto("/");

    await abrirSino(page);
    const painelSino = page.locator("#notification-center-panel");
    const caixa = await painelSino.boundingBox();
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(largura);
    await expect(page.locator("#btn-alerta-backups-regionais")).toBeInViewport();
    for (const [nome, excesso] of Object.entries(await semRolagemHorizontal(page))) expect(excesso, `sino aberto: ${nome}`).toBeLessThanOrEqual(0);

    await irParaBackupsPeloSino(page);
    await esperarBackupsAberta(page);
    for (const [nome, excesso] of Object.entries(await semRolagemHorizontal(page))) expect(excesso, `sub-aba Backups: ${nome}`).toBeLessThanOrEqual(0);

    // Abaixo de 1200px a tabela vira cards: cada regional é um bloco visível, o cabeçalho sai de cena e cada célula leva o rótulo.
    const estilos = await page.evaluate(() => {
      const tr = document.querySelector("#resumo-painel-backups tbody tr");
      const rotulo = document.querySelector("#resumo-painel-backups tbody tr td[data-label]");
      const cabecalho = document.querySelector("#resumo-painel-backups thead");
      return {
        linha: getComputedStyle(tr).display, cabecalhoPosicao: getComputedStyle(cabecalho).position,
        cabecalhoLargura: cabecalho.getBoundingClientRect().width, rotulo: getComputedStyle(rotulo, "::before").content,
      };
    });
    expect(estilos.linha).toBe("grid");
    expect(estilos.cabecalhoPosicao).toBe("absolute");
    expect(estilos.cabecalhoLargura).toBeLessThanOrEqual(1);
    expect(estilos.rotulo).toBe('"Situação"');
    await expect(page.locator(`${PAINEL} tbody tr`)).toHaveCount(5);
    for (const cidade of ["Cascavel", "Londrina", "Pato Branco", "Maringá", "Ponta Grossa"]) {
      await expect(linha(page, cidade)).toBeVisible();
      await expect(linha(page, cidade).locator(".ck-badge")).toBeVisible();
    }
    const cartoes = await page.locator(`${PAINEL} tbody tr`).evaluateAll(trs => trs.map(tr => {
      const caixaLinha = tr.getBoundingClientRect();
      return { esquerda: caixaLinha.left, direita: caixaLinha.right, largura: caixaLinha.width };
    }));
    for (const cartao of cartoes) {
      expect(cartao.esquerda).toBeGreaterThanOrEqual(0);
      expect(cartao.direita).toBeLessThanOrEqual(largura);
      expect(cartao.largura).toBeGreaterThan(150);
    }
    await expect(page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" })).toBeInViewport({ ratio: 0.9 }).catch(async () => {
      await page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" }).scrollIntoViewIfNeeded();
    });
    const botao = await page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" }).boundingBox();
    expect(botao.x).toBeGreaterThanOrEqual(0);
    expect(botao.x + botao.width).toBeLessThanOrEqual(largura);
  });
}

for (const tema of ["light", "dark"]) {
  test(`tema ${tema}: sub-aba Backups e cartão do sino abrem sem erro e com contraste AA`, async ({ page }) => {
    test.slow();
    const erros = [];
    page.on("pageerror", erro => erros.push(erro.message));
    page.on("console", mensagem => { if (mensagem.type() === "error" && !/404|Failed to load resource/.test(mensagem.text())) erros.push(mensagem.text()); });
    // O tema vem do localStorage no carregamento: o Axe não mede no meio de uma transição de cor.
    await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", tema);

    await abrirSino(page);
    const violacoes = async escopo => (await new AxeBuilder({ page }).include(escopo).withRules(["color-contrast"]).analyze())
      .violations.flatMap(item => item.nodes.map(no => ({ alvo: no.target, resumo: no.failureSummary })));
    expect(await violacoes(CARTAO), "cartão do sino").toEqual([]);

    await irParaBackupsPeloSino(page);
    await esperarBackupsAberta(page);
    await page.locator(`${PAINEL} .ck-backups__excluidos > summary`).first().click(); // abre o "excluído" de Cascavel
    expect(await violacoes(PAINEL), "sub-aba Backups").toEqual([]);

    // Texto legível e distinto do fundo (cor efetiva, subindo até o primeiro fundo opaco).
    const sem = await page.locator(PAINEL).evaluate(painel => {
      const opaco = valor => { const m = valor.match(/rgba?\(([^)]+)\)/); return m ? (m[1].split(",").length < 4 || Number(m[1].split(",")[3]) > 0.9) : false; };
      const fundoDe = no => { for (let atual = no; atual; atual = atual.parentElement) { if (opaco(getComputedStyle(atual).backgroundColor)) return getComputedStyle(atual).backgroundColor; } return "rgb(255, 255, 255)"; };
      return [...painel.querySelectorAll(".ck-backups__cidade, .ck-backups__serie, .ck-backups__apelido, .ck-backups__detalhe, .ck-backups__meta, .ck-badge, button")]
        .filter(no => no.getClientRects().length && no.textContent.trim())
        .filter(no => getComputedStyle(no).color === fundoDe(no)).map(no => no.className || no.tagName);
    });
    expect(sem).toEqual([]);
    expect(erros).toEqual([]);
  });
}

for (const reduzir of [true, false]) {
  test(`${reduzir ? "movimento reduzido" : "movimento normal"}: transições e animações da sub-aba e do cartão ${reduzir ? "≤ 1 ms" : "≤ 300 ms"}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduzir ? "reduce" : "no-preference" });
    await page.goto("/");
    await abrirSino(page);
    // Com o cartão recém-aberto: lê estilos e animações em curso, antes de qualquer espera.
    const medir = () => page.evaluate(({ alvo }) => {
      const maximo = valor => Math.max(...String(valor).split(",").map(item => Number.parseFloat(item) || 0));
      const nos = [...document.querySelectorAll(alvo)];
      const estilos = nos.flatMap(no => [null, "::before", "::after"].map(pseudo => {
        const css = getComputedStyle(no, pseudo);
        return { no: `${no.tagName}${no.id ? `#${no.id}` : ""}.${no.getAttribute("class") || ""}${pseudo || ""}`, transicao: maximo(css.transitionDuration), animacao: maximo(css.animationDuration) };
      }));
      const emCurso = document.getAnimations().filter(item => item.effect?.target?.closest?.(alvo.split(",")[0]) || nos.includes(item.effect?.target))
        .map(item => ({ no: item.effect.target.id || item.effect.target.className, ms: Number(item.effect.getTiming().duration) }));
      return { total: nos.length, estilos, emCurso };
    }, { alvo: `${CARTAO}, ${CARTAO} *, ${ABA}, ${ABA} *, ${PAINEL}, ${PAINEL} *` });

    let resultado = await medir();
    await irParaBackupsPeloSino(page);
    await esperarBackupsAberta(page);
    const painel = await medir();
    resultado = { total: resultado.total + painel.total, estilos: [...resultado.estilos, ...painel.estilos], emCurso: [...resultado.emCurso, ...painel.emCurso] };
    expect(resultado.total).toBeGreaterThan(20); // cartão + aba + painel de fato medidos
    const limite = reduzir ? 0.001 : 0.3;
    expect(resultado.estilos.filter(item => item.transicao > limite || item.animacao > limite)).toEqual([]);
    expect(resultado.emCurso.filter(item => item.ms > limite * 1000)).toEqual([]);
    if (!reduzir) {
      // Sem a preferência há movimento: o teste não pode passar por não medir nada.
      expect(resultado.estilos.some(item => item.transicao > 0)).toBe(true);
    }
  });
}

test("o apelido nunca aparece em toast nem em região aria-live global depois de confirmar e desfazer", async ({ page }) => {
  test.slow();
  // Toasts somem em 4 s: um observador guarda o texto de toda região viva (fora do painel local) a cada mudança.
  await page.addInitScript(() => {
    const vivas = new Set();
    window.__regioesVivas = vivas;
    const seletor = "#toast-container, [aria-live], [role='status'], [role='alert'], [role='log']";
    const ler = () => document.querySelectorAll(seletor).forEach(no => {
      const texto = (no.textContent || "").replace(/\s+/g, " ").trim();
      if (texto && !no.closest("#resumo-painel-backups")) vivas.add(texto);
    });
    new MutationObserver(ler).observe(document, { subtree: true, childList: true, characterData: true });
  });
  await abrirResumo(page);
  await irParaBackupsPeloSino(page);
  await esperarBackupsAberta(page);
  // O apelido aparece na tela local (o teste não passa por não ter o dado).
  await expect(page.locator(PAINEL)).toContainText(`${APELIDO} 1`);

  await page.getByRole("button", { name: "Confirmar disponível por 7 dias: série TSTBK0001, Londrina" }).click();
  await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Backup disponível");
  await expect.poll(() => page.evaluate(() => [...window.__regioesVivas].some(texto => texto.includes("Backup confirmado por 7 dias: série TSTBK0001, Londrina.")))).toBe(true);
  await page.getByRole("button", { name: "Desfazer confirmação: série TSTBK0001, Londrina" }).click();
  await expect(linha(page, "Londrina").locator(".ck-badge")).toHaveText("Conferir possível backup");
  await expect.poll(() => page.evaluate(() => [...window.__regioesVivas].some(texto => texto.includes("Confirmação desfeita: série TSTBK0001, Londrina.")))).toBe(true);
  await page.getByRole("button", { name: "Desfazer confirmação: série TSTBK0004, Pato Branco" }).click();
  await expect.poll(() => page.evaluate(() => [...window.__regioesVivas].some(texto => texto.includes("Confirmação desfeita: série TSTBK0004, Pato Branco.")))).toBe(true);
  await abrirSino(page);

  const vazou = await page.evaluate(apelido => [...window.__regioesVivas].filter(texto => texto.toLowerCase().includes(apelido.toLowerCase())), APELIDO);
  expect(vazou).toEqual([]);
  // Estado final das regiões vivas (a leitura de agora, fora do painel local).
  const agora = await page.evaluate(() => [...document.querySelectorAll("#toast-container, [aria-live], [role='status'], [role='alert'], [role='log']")]
    .filter(no => !no.closest("#resumo-painel-backups")).map(no => no.textContent || "").filter(texto => /estacao teste/i.test(texto)));
  expect(agora).toEqual([]);
});
