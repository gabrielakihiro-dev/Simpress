// Piloto da migração React (Bloco 3): cartão "Ativos por regional" do Resumo (F3, Visão geral).
// O baseline de screenshots foi gravado com o cartão antigo (JS puro), antes da troca para React:
// o cartão em React tem de sair igual nos dois tamanhos (390 e 1366 px) e nos dois temas.
const { test, expect } = require("@playwright/test");

// 12 regionais (mostra "Ver menos", o --linhas e as duas colunas a partir de 1000 px) e uma categoria zerada (pílula desabilitada).
const cidades = Array.from({ length: 12 }, (_, i) => ({ cidade: `Cidade ${String(i + 1).padStart(2, "0")}`, total: 100 - i * 7 }));
const PAINEL = {
  total_equipamentos: 738,
  por_categoria: [
    { value: "notebook", label: "Notebooks", total: 500 },
    { value: "macbook", label: "MacBooks", total: 200 },
    { value: "monitor", label: "Monitores", total: 38 },
    { value: "fone", label: "Fones", total: 0 },
  ],
  cidades_principais: cidades,
  cidades_por_categoria: {
    notebook: [{ cidade: "Curitiba", total: 300 }, { cidade: "Londrina", total: 200 }],
    macbook: [{ cidade: "Londrina", total: 200 }],
    monitor: [{ cidade: "Curitiba", total: 38 }],
    fone: [],
  },
};

// Mantém o resto da resposta da fixture (outros cartões leem /api/painel) e troca só os campos do cartão.
// `painel` pode ser uma função: o teste troca a resposta entre um carregamento e outro.
async function rotaPainel(page, painel) {
  await page.route("**/api/painel", async route => {
    const atual = typeof painel === "function" ? painel() : painel;
    if (atual === "erro") return route.abort();
    const resposta = await route.fetch();
    await route.fulfill({ response: resposta, json: { ...(await resposta.json()), ...atual } });
  });
}

async function abrirCartao(page, { tema, painel }) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(valor => { try { localStorage.setItem("simpress:theme", valor); } catch (erro) { /* sem armazenamento */ } }, tema);
  await rotaPainel(page, painel);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", tema);
  await page.locator("#btn-resumo-aba").click();
  await expect(page.locator("#cockpit-tool-panels")).toBeVisible();
  await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
  await expect(page.locator("#resumo-regionais")).toHaveAttribute("data-estado", (typeof painel === "function" ? painel() : painel) === "erro" ? "erro" : "pronto");
  await page.locator("#resumo-aba-visao").click();
  await expect(page.locator("#resumo-aba-visao")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#resumo-ativos-secao")).toBeVisible();
  // O brilho do bento segue o ponteiro (--mx/--my): o mouse fica fora do cartão.
  await page.mouse.move(0, 0);
}

for (const tema of ["light", "dark"]) {
  test(`baseline: cartão com 12 regionais, tema ${tema}`, async ({ page }) => {
    await abrirCartao(page, { tema, painel: PAINEL });
    await expect(page.locator("#resumo-regionais .ck-barra")).toHaveCount(12);
    await expect(page.locator("#resumo-regionais .ck-barra__valor").first()).toHaveText("100");
    await expect(page.locator(".ck-regionais")).toHaveScreenshot(`regionais-pronto-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });

  test(`baseline: cartão com o servidor fora do ar, tema ${tema}`, async ({ page }) => {
    await abrirCartao(page, { tema, painel: "erro" });
    await expect(page.locator("#resumo-regionais")).toContainText("indisponível");
    await expect(page.locator(".ck-regionais")).toHaveScreenshot(`regionais-erro-${tema}.png`, { animations: "disabled", maxDiffPixelRatio: 0.01 });
  });
}

// Comportamento do cartão, portado de tests/frontend/test_resumo_ativos.cjs (DOM falso) quando ele virou React.
// Os dados são os mesmos do painelBase de lá.
const painelBase = () => ({
  total_equipamentos: 16,
  por_categoria: [
    { value: "notebook", label: "Notebooks", total: 10 },
    { value: "macbook", label: "MacBooks", total: 3 },
    { value: "monitor", label: "Monitores", total: 2 },
    { value: "fone", label: "Fones", total: 0 },
  ],
  cidades_principais: [{ cidade: "Londrina", total: 5 }, { cidade: "Curitiba", total: 10 }, { cidade: "", total: 1 }],
  cidades_por_categoria: {
    notebook: [{ cidade: "Curitiba", total: 8 }, { cidade: "Londrina", total: 2 }],
    macbook: [{ cidade: "Londrina", total: 3 }],
    monitor: [{ cidade: "Curitiba", total: 2 }],
    fone: [],
  },
});
const barras = page => page.locator("#resumo-regionais .ck-barra");
const nomes = page => page.locator("#resumo-regionais .ck-barra__nome");
const pilula = (page, categoria) => page.locator(`#resumo-regionais-filtros button[data-categoria="${categoria}"]`);
// Ação publicada pela ponte (static/js/features/resumo-ativos.js), a mesma que o painel chama ao abrir.
const recarregar = page => page.evaluate(() => window.carregarResumoAtivos());

test.describe("comportamento (1366 px)", () => {
  test.skip(({ viewport }) => viewport.width < 1366, "comportamento não depende da largura: roda só no desktop");

  test("regionais: barras ordenadas pelo total, largura proporcional e contagem no cabeçalho", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: painelBase() });
    await expect(nomes(page)).toHaveText(["Curitiba", "Londrina", "Sem cidade"]);
    await expect(page.locator("#resumo-regionais .ck-barra__valor")).toHaveText(["10", "5", "1"]);
    const larguras = await page.locator("#resumo-regionais .ck-barra__cheio").evaluateAll(els => els.map(el => el.style.width));
    expect(larguras).toEqual(["100%", "50%", "10%"]);
    await expect(page.locator("#resumo-regionais-contagem")).toHaveText("16 ativos em 3 regionais");
    await expect(page.locator("#resumo-regionais")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#resumo-regionais-mais")).toBeHidden();
  });

  test("filtros: Todos + 4 categorias com contagem, só Todos marcado e categoria sem ativos desabilitada", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: painelBase() });
    const pilulas = page.locator("#resumo-regionais-filtros button");
    expect(await pilulas.evaluateAll(els => els.map(el => el.dataset.categoria))).toEqual(["todos", "notebook", "macbook", "monitor", "fone"]);
    expect(await pilulas.evaluateAll(els => els.map(el => el.getAttribute("aria-pressed")))).toEqual(["true", "false", "false", "false", "false"]);
    expect(await pilulas.evaluateAll(els => els.map(el => el.textContent))).toEqual(["Todos 16", "Notebooks 10", "MacBooks 3", "Monitores 2", "Fones 0"]);
    expect(await pilulas.evaluateAll(els => els.map(el => el.disabled))).toEqual([false, false, false, false, true]);
  });

  test("filtros: escolher categoria troca as barras e a contagem, o foco fica na pílula; voltar a Todos restaura", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: painelBase() });
    await pilula(page, "notebook").click();
    await expect(nomes(page)).toHaveText(["Curitiba", "Londrina"]);
    await expect(page.locator("#resumo-regionais-contagem")).toHaveText("10 ativos em 2 regionais");
    await expect(pilula(page, "notebook")).toHaveAttribute("aria-pressed", "true");
    await expect(pilula(page, "todos")).toHaveAttribute("aria-pressed", "false");
    await expect(pilula(page, "notebook")).toBeFocused();
    await pilula(page, "macbook").click();
    await expect(nomes(page)).toHaveText(["Londrina"]);
    await expect(pilula(page, "macbook")).toBeFocused();
    await pilula(page, "todos").click();
    await expect(nomes(page)).toHaveText(["Curitiba", "Londrina", "Sem cidade"]);
  });

  test("filtros: o filtro escolhido sobrevive a recarregar; se a categoria zerar, volta para Todos", async ({ page }) => {
    let atual = painelBase();
    await abrirCartao(page, { tema: "light", painel: () => atual });
    await pilula(page, "monitor").click();
    await recarregar(page);
    await expect(nomes(page)).toHaveText(["Curitiba"]);
    await expect(pilula(page, "monitor")).toHaveAttribute("aria-pressed", "true");

    atual = painelBase();
    atual.por_categoria[2].total = 0;
    await recarregar(page);
    await expect(pilula(page, "monitor")).toBeDisabled();
    await expect(pilula(page, "monitor")).toHaveAttribute("aria-pressed", "false");
    await expect(pilula(page, "todos")).toHaveAttribute("aria-pressed", "true");
  });

  test("regionais: mais de 8 mostram todas por padrão e 'Ver menos' recolhe para o top 8", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: PAINEL });
    const regionais = page.locator("#resumo-regionais");
    const mais = page.locator("#resumo-regionais-mais");
    const linhas = () => regionais.evaluate(el => el.style.getPropertyValue("--linhas"));
    await expect(barras(page)).toHaveCount(12);
    expect(await linhas()).toBe("6");
    await expect(mais).toBeVisible();
    await expect(mais).toHaveText("Ver menos");
    await expect(mais).toHaveAttribute("aria-expanded", "true");
    await mais.click();
    await expect(barras(page)).toHaveCount(8);
    expect(await linhas()).toBe("4");
    await expect(mais).toHaveText("Ver todas as 12 regionais");
    await expect(mais).toHaveAttribute("aria-expanded", "false");
    await pilula(page, "todos").click();
    await expect(barras(page)).toHaveCount(12);
  });

  test("regionais: base sem cidades e categoria sem ativos mostram aviso em vez de barras", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: { ...painelBase(), cidades_principais: [], cidades_por_categoria: { notebook: [] } } });
    await expect(barras(page)).toHaveCount(0);
    await expect(page.locator("#resumo-regionais-contagem")).toHaveText("");
    await expect(page.locator("#resumo-regionais")).toHaveText("A distribuição por cidade não está disponível.");
    await expect(pilula(page, "fone")).toBeDisabled();
    await pilula(page, "notebook").click();
    await expect(page.locator("#resumo-regionais")).toHaveText("Nenhum ativo de Notebooks na base local.");
    await expect(page.locator("#resumo-regionais-mais")).toBeHidden();
  });

  test("servidor fora do ar: aviso, sem barras, sem pílulas, sem 'Ver todas' e data-estado erro", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: "erro" });
    const regionais = page.locator("#resumo-regionais");
    await expect(regionais).toHaveText("A distribuição por regional está indisponível enquanto o servidor local não responde.");
    await expect(regionais).toHaveAttribute("aria-busy", "false");
    await expect(barras(page)).toHaveCount(0);
    await expect(page.locator("#resumo-regionais-filtros button")).toHaveCount(0);
    await expect(page.locator("#resumo-regionais-mais")).toBeHidden();
    expect(await regionais.evaluate(el => el.style.getPropertyValue("--linhas"))).toBe("");
  });

  test("carregamento: data-estado carregando, aria-busy e esqueleto com rótulo enquanto a resposta não chega", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: painelBase() });
    let soltar;
    const portao = new Promise(resolve => { soltar = resolve; });
    await page.route("**/api/painel", async route => { await portao; await route.fallback(); });
    const pedido = recarregar(page);
    const regionais = page.locator("#resumo-regionais");
    await expect(regionais).toHaveAttribute("data-estado", "carregando");
    await expect(regionais).toHaveAttribute("aria-busy", "true");
    await expect(regionais.locator(".ui-skeleton-list .ui-sr-only[role=status]")).toHaveText("Carregando dados da base local…");
    soltar();
    await pedido;
    await expect(regionais).toHaveAttribute("data-estado", "pronto");
    await expect(regionais).toHaveAttribute("aria-busy", "false");
    await expect(regionais.locator(".ui-skeleton-list")).toHaveCount(0);
    await expect(nomes(page)).toHaveText(["Curitiba", "Londrina", "Sem cidade"]);
  });

  test("IDs, ARIA e data-*: os mesmos do cartão antigo, sem IDs repetidos na página", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: PAINEL });
    await expect(page.locator("html")).toHaveAttribute("data-react-pronto", /.*/);
    const secao = page.locator("section#resumo-ativos-secao.ck-resumo-secao[data-react-painel='resumo-ativos']");
    await expect(secao).toHaveAttribute("aria-labelledby", "resumo-regionais-titulo");
    await expect(secao.locator("h3#resumo-regionais-titulo.ck-cartao__titulo")).toHaveText("Ativos por regional");
    await expect(secao.locator("#resumo-regionais-contagem")).toHaveAttribute("role", "status");
    await expect(secao.locator("#resumo-regionais-contagem")).toHaveAttribute("aria-live", "polite");
    await expect(secao.locator("#resumo-regionais-filtros")).toHaveAttribute("role", "group");
    await expect(secao.locator("#resumo-regionais-filtros")).toHaveAttribute("aria-label", "Filtrar ativos por categoria");
    await expect(secao.locator("#resumo-regionais.ck-barras")).toHaveAttribute("data-estado", "pronto");
    await expect(secao.locator("button#resumo-regionais-mais[type=button]")).toHaveAttribute("aria-expanded", "true");
    const repetidos = await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(repetidos).toEqual([]);
  });

  for (const tema of ["light", "dark"]) {
    test(`bento: o cartão usa os tokens do tema ${tema} (getComputedStyle)`, async ({ page }) => {
      await abrirCartao(page, { tema, painel: PAINEL });
      await pilula(page, "notebook").click();
      await page.mouse.move(0, 0);
      // Regras de static/styles/ck-bento.css (.ck-regionais.ck-cartao e filhos); uma sonda ao lado da seção (fora
      // da raiz do React, no mesmo escopo de tokens) resolve var(--cor-*) para comparar com o cartão React.
      const estilos = await page.evaluate(() => {
        const cartao = document.querySelector(".ck-regionais");
        const sonda = document.querySelector("#resumo-ativos-secao").parentElement.appendChild(document.createElement("span"));
        // Sem transição: com ela, getComputedStyle devolveria a cor de partida (a herdada), não o token.
        sonda.style.setProperty("transition", "none", "important");
        const cor = valor => { sonda.style.color = valor; return getComputedStyle(sonda).color; };
        sonda.style.fontFamily = "var(--fonte-corpo)";
        const titulo = getComputedStyle(cartao.querySelector(".ck-cartao__titulo"));
        const pilula = getComputedStyle(cartao.querySelector('.ck-pilula[aria-pressed="true"]'));
        const estilo = getComputedStyle(cartao);
        const ac = estilo.getPropertyValue("--ac").trim();
        const resultado = {
          cartao: [estilo.borderRadius, estilo.boxShadow, estilo.borderTopColor, estilo.getPropertyValue("--tom").trim()],
          esperadoCartao: ["24px", "none", cor("var(--cor-borda)")],
          titulo: [titulo.fontWeight, titulo.fontSize, titulo.fontFamily, titulo.color],
          esperadoTitulo: ["500", "14px", getComputedStyle(sonda).fontFamily, cor("var(--cor-texto-forte)")],
          pilula: [pilula.borderTopColor, pilula.backgroundColor, pilula.borderRadius],
          esperadoPilula: [cor(`rgba(${ac}, .6)`), cor(`rgba(${ac}, .12)`), "999px"],
          cheio: getComputedStyle(cartao.querySelector(".ck-barra__cheio")).backgroundColor,
          tom: cor(estilo.getPropertyValue("--tom").trim()),
        };
        sonda.remove();
        return resultado;
      });
      expect(estilos.cartao).toEqual([...estilos.esperadoCartao, tema === "dark" ? "#67e8f9" : "#0e7490"]);
      expect(estilos.titulo).toEqual(estilos.esperadoTitulo);
      expect(estilos.pilula).toEqual(estilos.esperadoPilula);
      expect(estilos.cheio).toBe(estilos.tom); // ck-bento.css: #resumo-regionais .ck-barra__cheio { background: var(--tom) }
    });
  }

  test("movimento reduzido: números aparecem no valor final e as barras não têm transição", async ({ page }) => {
    await abrirCartao(page, { tema: "light", painel: painelBase() });
    // Lido no mesmo instante em que o redesenho termina: com movimento reduzido não há contagem.
    const valores = await page.evaluate(async () => {
      await window.carregarResumoAtivos();
      return [...document.querySelectorAll("#resumo-regionais .ck-barra__valor")].map(el => el.textContent);
    });
    expect(valores).toEqual(["10", "5", "1"]);
    // "Zera tudo" (docs/ui-motion/contrato-bento.md): aceita 0 s ou o 0,01 ms que algumas regras usam.
    const duracoes = await page.locator(".ck-regionais, #resumo-regionais .ck-barra, #resumo-regionais .ck-barra__cheio").evaluateAll(els => els.flatMap(el => {
      const estilo = getComputedStyle(el);
      return `${estilo.transitionDuration},${estilo.animationDuration}`.split(",").map(valor => valor.trim());
    }));
    expect(duracoes.filter(valor => !(valor.endsWith("s") && parseFloat(valor) <= 0.00001)), duracoes.join(" ")).toEqual([]);
  });

  test("movimento normal: a contagem do bento termina no valor final", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await rotaPainel(page, painelBase());
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    await page.locator("#resumo-aba-visao").click();
    await expect(page.locator("#resumo-regionais .ck-barra__valor")).toHaveText(["10", "5", "1"]);
  });

  test("voltar à Visão geral repete o bento: as barras são recriadas (simpress:bento-repetir)", async ({ page }) => {
    await rotaPainel(page, painelBase());
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    await page.locator("#resumo-aba-visao").click();
    await expect(page.locator("#resumo-regionais .ck-barra__valor")).toHaveText(["10", "5", "1"]);
    await page.locator("#resumo-regionais .ck-barra").first().evaluate(el => { el.dataset.marcaTeste = "1"; });
    await page.locator("#resumo-aba-divergencias").click();
    await page.locator("#resumo-aba-visao").click();
    // React troca a key das barras (geracao + 1): o elemento marcado sai e entra um novo com o mesmo valor.
    await expect(page.locator("#resumo-regionais [data-marca-teste]")).toHaveCount(0);
    await expect(page.locator("#resumo-regionais .ck-barra__valor")).toHaveText(["10", "5", "1"]);
  });

  test("sem o bundle React: o Resumo abre, o cartão fica vazio e o erro vai para o console", async ({ page }) => {
    const erros = [];
    page.on("console", mensagem => { if (mensagem.type() === "error") erros.push(mensagem.text()); });
    await page.route("**/static/dist/react-entry.js*", route => route.abort());
    await page.goto("/");
    await page.locator("#btn-resumo-aba").click();
    await expect(page.locator("#comparacao-planilhas-conteudo")).toHaveAttribute("data-estado", /^(pronto|vazio|erro)$/);
    await expect(page.locator("html")).not.toHaveAttribute("data-react-pronto", /.*/);
    await expect(page.locator("#resumo-ativos-secao")).toBeEmpty();
    await expect.poll(() => erros.some(texto => texto.includes('O painel React "resumo-ativos" não carregou.'))).toBe(true);
  });
});

