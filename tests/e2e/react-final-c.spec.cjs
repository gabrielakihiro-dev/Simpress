// Grupo C da migração React (react-final-c): diálogo "Transferências geradas" (antigo ui/transfer-history.js).
// Baselines gravados com o código antigo. Todo /api/* do diálogo é simulado aqui, com dados sintéticos: nenhum teste
// chega ao backend real. A versão em React tem de passar este arquivo sem mudanças; por isso só vale o que o usuário vê
// e as chamadas de rede, nunca detalhes internos do código.
//
// HTML: o conteúdo do diálogo vira texto canônico (atributos e classes em ordem alfabética, sem espaços entre tags e
// cada <svg> reduzido às classes) e é comparado com o baseline em cada estado: lista com 2 itens, vazio, busca sem
// resultado, 501, 503 e servidor fora do ar.
// Comportamento: busca com espera de 250 ms, "Copiar série", "Duplicar destino" (com e sem unidade no catálogo) e o
// fechamento pelo botão do rodapé.
const { test, expect } = require("@playwright/test");

test.use({ timezoneId: "America/Sao_Paulo", locale: "pt-BR" });

const UNIDADES = [
  { id: "unidade-curitiba", cidade: "Curitiba", cnpj: "00.000.000/0001-00", endereco: "Rua Exemplo, 100" },
  { id: "unidade-londrina", cidade: "Londrina", cnpj: "00.000.000/0003-62", endereco: "Rua Fictícia, 300" },
];

const ITENS = [
  {
    id: "transferencia-1", criado_em: "2026-11-10T14:30:00-03:00", serial: "BRJ0001", nome_pessoa: "Pessoa de Teste Um",
    retirada_cidade: "Curitiba", entrega_cidade: "Londrina", entrega_contato: "Contato de Teste", entrega_obs: "Obs de teste",
    payload: {
      entrega_cnpj: "00.000.000/0003-62", entrega_endereco: "Rua Fictícia, 300 - Centro, Londrina/PR",
      entrega_contato: "Contato de Teste", entrega_email: "contato@exemplo.invalid", entrega_telefone: "(00) 0000-0000",
      entrega_horario: "08h às 17h", entrega_almoco: "12h às 13h", entrega_pausa_duracao: "1h", entrega_obs: "Obs de teste",
    },
  },
  {
    id: "transferencia-2", criado_em: "2026-11-09T09:05:00-03:00", serial: "BRJ0002", nome_pessoa: "",
    retirada_cidade: "", entrega_cidade: "", entrega_contato: "", entrega_obs: "",
    payload: { entrega_cnpj: "99.999.999/0001-99", entrega_contato: "Outro Contato", entrega_obs: "" },
  },
];

async function preparar(page, { lista = () => ({ json: { itens: ITENS, total: 7 } }) } = {}) {
  const ambiente = { buscas: [] };
  await page.route("**/api/unidades", route => route.fulfill({ json: UNIDADES }));
  await page.route("**/api/historico-transferencias?**", route => {
    const busca = new URL(route.request().url()).searchParams.get("busca") || "";
    ambiente.buscas.push(busca);
    const resposta = lista(busca);
    if (resposta === "abort") return route.abort("connectionrefused");
    return route.fulfill(resposta);
  });
  await page.goto("/");
  return ambiente;
}

async function abrirDialogo(page) {
  const botaoMenu = page.locator("#btn-sidebar-open");
  const casca = page.locator("#simpress-app-shell");
  if (await botaoMenu.isVisible() && await casca.getAttribute("data-sidebar-open") !== "true") {
    await botaoMenu.click();
    await expect(casca).toHaveAttribute("data-sidebar-open", "true");
  }
  await page.locator("#tab-retirada-entrega").click();
  await expect(page.locator("#tab-panel-retirada-entrega")).toBeVisible();
  await page.locator("#btn-historico-transferencias").click();
  await expect(page.locator("#modal-historico-transferencias")).toBeVisible();
}

// Texto canônico do conteúdo do diálogo: ignora a ordem dos atributos e os espaços entre tags, que mudam entre HTML
// estático e JSX sem mudar a página.
const htmlCanonico = page => page.locator("#modal-historico-transferencias .ck-dialogo").evaluate(raiz => {
  const classes = valor => valor.split(/\s+/).filter(Boolean).sort().join(" ");
  const canon = no => {
    if (no.nodeType === 3) return no.textContent.replace(/\s+/g, " ").trim();
    if (no.nodeType !== 1) return "";
    const tag = no.tagName.toLowerCase();
    if (tag === "svg") return `<svg class="${classes(no.getAttribute("class") || "")}"/>`;
    const atributos = [...no.attributes]
      .filter(a => a.name !== "data-react-painel")
      .map(a => `${a.name}="${a.name === "class" ? classes(a.value) : a.value}"`)
      .sort().join(" ");
    const filhos = [...no.childNodes].map(canon).filter(Boolean);
    return `<${tag}${atributos ? ` ${atributos}` : ""}>${filhos.length ? `\n${filhos.join("\n")}\n` : ""}</${tag}>`;
  };
  return [...raiz.childNodes].map(canon).filter(Boolean).join("\n");
});

const esperarToast = (page, texto) => expect(page.locator("#toast-container .ck-toast", { hasText: texto })).toBeVisible();

test.describe("Transferências geradas (react-final-c)", () => {
  test("lista com itens: HTML igual ao baseline", async ({ page }, info) => {
    await preparar(page);
    await abrirDialogo(page);
    await expect(page.locator("#historico-transferencias-status")).toHaveText("Mostrando as 2 mais recentes de 7.");
    await expect(page.locator("#lista-historico-transferencias table")).toHaveCount(1);
    expect(await htmlCanonico(page)).toMatchSnapshot("lista.html");
  });

  for (const [nome, lista, status, mensagem] of [
    ["vazio", () => ({ json: { itens: [], total: 0 } }), "Nenhuma transferência registrada.", "Nenhuma planilha de transferência foi gerada ainda."],
    ["indisponivel-501", () => ({ status: 501, json: { detail: "x" } }), "", "O histórico de transferências não está disponível neste modo de armazenamento."],
    ["ilegivel-503", () => ({ status: 503, json: { detail: "x" } }), "", "O arquivo local do histórico está ilegível; os dados foram preservados. Verifique data/state/historico_transferencias.json."],
    ["fora-do-ar", () => "abort", "", "Não foi possível carregar o histórico de transferências."],
  ]) {
    test(`estado ${nome}: HTML igual ao baseline`, async ({ page }, info) => {
      test.skip(info.project.name !== "desktop", "estados sem tabela: basta o desktop");
      await preparar(page, { lista });
      await abrirDialogo(page);
      await expect(page.locator("#lista-historico-transferencias p")).toHaveText(mensagem);
      await expect(page.locator("#historico-transferencias-status")).toHaveText(status);
      expect(await htmlCanonico(page)).toMatchSnapshot(`estado-${nome}.html`);
    });
  }

  test("busca espera 250 ms, manda o termo e mostra 'Nenhum resultado.'", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "comportamento: basta o desktop");
    const ambiente = await preparar(page, {
      lista: busca => ({ json: busca ? { itens: [], total: 0 } : { itens: ITENS, total: 2 } }),
    });
    await abrirDialogo(page);
    await expect(page.locator("#historico-transferencias-status")).toHaveText("2 transferências.");
    await page.locator("#filtro-historico-transferencias").pressSequentially("Lon");
    await expect(page.locator("#historico-transferencias-status")).toHaveText("Nenhum resultado.");
    await expect(page.locator("#lista-historico-transferencias p")).toHaveText("Nenhuma transferência corresponde à busca.");
    expect(await htmlCanonico(page)).toMatchSnapshot("estado-busca-sem-resultado.html");
    // Digitação seguida cai na mesma espera: só a abertura e o termo completo chegam ao servidor.
    expect(ambiente.buscas).toEqual(["", "Lon"]);
  });

  test("Copiar série avisa e Fechar devolve o diálogo", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "comportamento: basta o desktop");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await preparar(page);
    await abrirDialogo(page);
    await page.locator("#lista-historico-transferencias table").getByRole("button", { name: "Copiar série" }).first().click();
    await esperarToast(page, "Série BRJ0001 copiada para a área de transferência.");
    await page.locator("#modal-historico-transferencias").getByRole("button", { name: "Fechar", exact: true }).click();
    await expect(page.locator("#modal-historico-transferencias")).toBeHidden();
  });

  test("Duplicar destino preenche unidade e contato", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "comportamento: basta o desktop");
    await preparar(page);
    await abrirDialogo(page);
    await page.locator("#lista-historico-transferencias table").getByRole("button", { name: "Duplicar destino" }).first().click();
    await expect(page.locator("#modal-historico-transferencias")).toBeHidden();
    await esperarToast(page, "Destino e contato duplicados. Pesquise o equipamento na aba Home.");
    await expect(page.locator("#select-unidade-destino")).toHaveValue("unidade-londrina");
    await expect(page.locator("#entrega-contato")).toHaveValue("Contato de Teste");
    await expect(page.locator("#entrega-email")).toHaveValue("contato@exemplo.invalid");
    await expect(page.locator("#entrega-obs")).toHaveValue("Obs de teste");
    await expect(page.locator("#entrega-contato")).toBeFocused();
  });

  test("Duplicar destino fora do catálogo só copia o contato", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "comportamento: basta o desktop");
    await preparar(page);
    await abrirDialogo(page);
    await page.locator("#lista-historico-transferencias table").getByRole("button", { name: "Duplicar destino" }).nth(1).click();
    await esperarToast(page, "Contato duplicado, mas o destino não está mais no catálogo. Selecione a unidade.");
    await expect(page.locator("#entrega-contato")).toHaveValue("Outro Contato");
    await expect(page.locator("#entrega-contato")).toBeFocused();
  });

  // Acrescentado depois do port (não é baseline): data-panels.js troca os <th> por botões e move as linhas por fora do
  // React; a busca seguinte tem de trocar a tabela inteira sem erro e sem duplicar "Copiar tabela".
  test("ordenar e buscar de novo troca a tabela sem erro nem ferramentas duplicadas", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "comportamento: basta o desktop");
    const erros = [];
    page.on("pageerror", erro => erros.push(erro.message));
    await preparar(page, {
      lista: busca => ({ json: busca ? { itens: [ITENS[1]], total: 1 } : { itens: ITENS, total: 2 } }),
    });
    await abrirDialogo(page);
    const lista = page.locator("#lista-historico-transferencias");
    await lista.getByRole("button", { name: "Ordenar por Série" }).click();
    await expect(lista.locator("th[aria-sort]:not([aria-sort='none'])")).toHaveCount(1);
    await page.locator("#filtro-historico-transferencias").fill("BRJ0002");
    await expect(page.locator("#historico-transferencias-status")).toHaveText("1 transferência.");
    await expect(lista.locator("table tbody tr")).toHaveCount(1);
    await expect(lista.locator(".ux-table-tools")).toHaveCount(1);
    expect(erros).toEqual([]);
  });
});
