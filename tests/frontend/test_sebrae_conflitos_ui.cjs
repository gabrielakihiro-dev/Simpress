const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const createDomUtils = require("../../static/js/shared/dom-utils.js");
const createSebraeConflitos = require("../../static/js/features/sebrae-conflitos.js");
const { createFakeDocument } = require("./support/fake-dom.cjs");
const { assembledHtml, staticDir } = require("./support/assembled-html.cjs");

const { valorVisivel, textoDoConflito, escolhasParaEnviar } = createSebraeConflitos.puro;

const celula = (id, extra = {}) => ({ id, tipo: "celula", chamado: "UTIC-2026-1", coluna: "G", sharepoint: "A", site: "B", ...extra });
const apagada = (id, extra = {}) => ({ id, tipo: "linha_apagada", chamado: "UTIC-2026-2", ...extra });
const lido = arquivo => fs.readFileSync(path.join(staticDir, arquivo), "utf8");

/** Fake screen: the real partial ids on a fake document, an app whose apiFetch answers from `rotas`, and manual timers. */
function montar(rotas) {
  const doc = createFakeDocument();
  const no = (tag, id, extra = {}) => {
    const node = doc.createElement(tag);
    node.setAttribute("id", id);
    Object.assign(node, extra);
    doc.body.appendChild(node);
    return node;
  };
  const host = no("section", "sebrae-conflitos", { hidden: true });
  no("div", "sebrae-conflitos-lista");
  const botao = no("button", "btn-sebrae-conflitos-enviar", { disabled: true });
  const status = no("p", "sebrae-conflitos-status");
  const chamadas = [];
  const efeitos = { toasts: [], automacao: 0, novos: 0 };
  const app = {
    apiFetch: async (url, opcoes = {}) => {
      chamadas.push({ url, metodo: opcoes.method || "GET", cabecalhos: opcoes.headers, corpo: opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const resposta = rotas[`${opcoes.method || "GET"} ${url}`];
      const valor = typeof resposta === "function" ? resposta() : resposta;
      if (valor instanceof Error) throw valor;
      return valor;
    },
    showToast: (mensagem, tipo) => efeitos.toasts.push({ mensagem, tipo }),
    atualizarEstadoAutomacao: () => { efeitos.automacao += 1; },
    carregarNovosSebrae: () => { efeitos.novos += 1; },
  };
  const timers = [];
  const anteriores = { document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  globalThis.document = doc;
  globalThis.setTimeout = funcao => { timers.push(funcao); return timers.length; };
  globalThis.clearTimeout = id => { if (id) timers[id - 1] = null; };
  const modulo = createSebraeConflitos({ app, dom: createDomUtils(doc) });
  return {
    host, botao, status, chamadas, efeitos, app, modulo,
    lista: doc.getElementById("sebrae-conflitos-lista"),
    grupos: () => doc.getElementById("sebrae-conflitos-lista").querySelectorAll("fieldset"),
    escolher: (indice, valor) => {
      const radio = doc.getElementById("sebrae-conflitos-lista").querySelectorAll("input")
        .find(item => item.name === `sebrae-conflito-${indice}` && item.value === valor);
      radio.checked = true;
      radio.dispatchEvent({ type: "change", target: radio });
    },
    proximoTimer: async () => { const funcao = timers.filter(Boolean).pop(); timers.length = 0; await funcao(); },
    timersPendentes: () => timers.filter(Boolean).length,
    restaurar: () => Object.assign(globalThis, anteriores),
  };
}

async function comTela(rotas, corpo) {
  const tela = montar(rotas);
  try {
    await corpo(tela);
  } finally {
    tela.restaurar();
  }
}

test("a tela está ligada: módulo, ordem das features, partial no painel e um gancho no Dashboard", () => {
  assert.match(lido("app-entry.js"), /^import "\.\/js\/features\/sebrae-conflitos\.js";$/m);
  assert.match(lido("app.js"), /"sebraeConflitos",/);
  const html = assembledHtml();
  const secao = html.match(/<section id="sebrae-conflitos"[\s\S]*?<\/section>/)?.[0] || "";
  for (const id of ["sebrae-conflitos-titulo", "sebrae-conflitos-lista", "btn-sebrae-conflitos-enviar", "sebrae-conflitos-status"]) {
    assert.equal(secao.split(`id="${id}"`).length - 1, 1, `${id} na seção`);
  }
  assert.match(secao, /<section id="sebrae-conflitos"[^>]*\bhidden\b/, "nasce escondida");
  assert.match(secao, /aria-labelledby="sebrae-conflitos-titulo"/);
  assert.match(secao, /id="sebrae-conflitos-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="sebrae-sharepoint-aviso"') < html.indexOf('id="sebrae-conflitos"'), "logo depois do aviso do SharePoint");
  assert.equal(lido("js/features/sebrae-dashboard.js").split("app.carregarConflitosSebrae").length - 1, 1, "um só gancho no Dashboard");
});

test("valor da célula: vazio vira (vazio), longo é cortado e o texto vai entre aspas", () => {
  assert.equal(valorVisivel("abc"), '"abc"');
  assert.equal(valorVisivel(""), "(vazio)");
  assert.equal(valorVisivel("   "), "(vazio)");
  assert.equal(valorVisivel(null), "(vazio)");
  assert.equal(valorVisivel("x".repeat(400)), `"${"x".repeat(300)}…"`);
});

test("frase do conflito traz chamado, coluna e os dois valores; linha apagada tem frase própria", () => {
  assert.equal(textoDoConflito(celula("a")), 'Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer "B".');
  assert.equal(textoDoConflito(celula("a", { site: "" })), 'Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer (vazio).');
  assert.equal(textoDoConflito(apagada("b")), "Chamado UTIC-2026-2: linha apagada no SharePoint, mas editada no site.");
});

test("só ids da lista atual com valor válido entram no envio", () => {
  const lista = [celula("a"), celula("b"), apagada("c")];
  assert.deepEqual(
    JSON.parse(JSON.stringify(escolhasParaEnviar(lista, { a: "site", b: "talvez", z: "sharepoint", c: "sharepoint" }))),
    { a: "site", c: "sharepoint" },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(escolhasParaEnviar(undefined, { a: "site" }))), {});
});

test("sem conflito a seção fica escondida e o botão desligado", async () => {
  await comTela({ "GET /api/sebrae/dashboard/conflitos": { conflitos: [], escolhas: {}, criado_em: "" } }, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    assert.equal(tela.host.hidden, true);
    assert.equal(tela.grupos().length, 0);
    assert.equal(tela.botao.disabled, true);
  });
});

test("lista cada célula com duas opções, botão só liga com todas escolhidas e o POST leva escolhas e enviar", async () => {
  const rotas = {
    "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a"), apagada("b")], escolhas: {}, criado_em: "2026-11-12T10:00:00" },
    "POST /api/sebrae/dashboard/conflitos": { escolhas: { a: "site", b: "sharepoint" }, enviar: { iniciado: true, motivo: "" } },
  };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    assert.equal(tela.host.hidden, false);
    const grupos = tela.grupos();
    assert.equal(grupos.length, 2);
    assert.equal(grupos[0].dataset.conflitoId, "a");
    assert.equal(grupos[0].getAttribute("role"), "group");
    assert.equal(grupos[0].querySelector("legend").textContent, 'Chamado UTIC-2026-1, coluna G: SharePoint diz "A", site quer "B".');
    assert.deepEqual(grupos[0].querySelectorAll("label").map(item => item.textContent.trim()), ["Manter o do SharePoint", "Usar o do site"]);
    assert.deepEqual(grupos[0].querySelectorAll("input").map(item => item.type), ["radio", "radio"]);
    assert.equal(tela.botao.disabled, true);
    assert.equal(tela.status.textContent, "Escolha uma opção em cada célula (faltam 2).");

    tela.escolher(0, "site");
    assert.equal(tela.botao.disabled, true);
    assert.equal(tela.status.textContent, "Escolha uma opção em cada célula (faltam 1).");
    tela.escolher(1, "sharepoint");
    assert.equal(tela.botao.disabled, false);
    assert.equal(tela.status.textContent, "");

    tela.botao.click();
    await new Promise(resolve => setImmediate(resolve));
    const post = tela.chamadas.find(item => item.metodo === "POST");
    assert.deepEqual(post.corpo, { escolhas: { a: "site", b: "sharepoint" }, enviar: true });
    assert.equal(post.cabecalhos["Content-Type"], "application/json");
    assert.equal(tela.efeitos.automacao, 1, "mostra a rotina enviar sem esperar a próxima consulta");
    assert.equal(tela.botao.disabled, true, "fica desligado enquanto o envio roda");
    assert.equal(tela.status.textContent, "Escolhas salvas. Reenviando ao SharePoint…");
    assert.equal(tela.timersPendentes(), 1, "acompanha o estado da automação");
  });
});

test("escolha gravada antes aparece marcada ao recarregar", async () => {
  const rotas = { "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a")], escolhas: { a: "sharepoint", velha: "site" }, criado_em: "" } };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    const marcados = tela.grupos()[0].querySelectorAll("input").filter(item => item.checked).map(item => item.value);
    assert.deepEqual(marcados, ["sharepoint"]);
    assert.equal(tela.botao.disabled, false);
  });
});

test("valores vindos do SharePoint entram só como texto, nunca como HTML", async () => {
  const perigoso = '<img src=x onerror="alert(1)">';
  const rotas = { "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a", { sharepoint: perigoso })], escolhas: {}, criado_em: "" } };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    const grupo = tela.grupos()[0];
    assert.equal(grupo.querySelector("legend").textContent.includes(perigoso), true);
    assert.equal(grupo.querySelectorAll("img").length, 0);
  });
  assert.doesNotMatch(lido("js/features/sebrae-conflitos.js"), /innerHTML|insertAdjacentHTML|outerHTML/);
});

test("envio que termina concluído esvazia a lista, atualiza o painel e avisa o sucesso", async () => {
  let rodadas = 0;
  const rotas = {
    "GET /api/sebrae/dashboard/conflitos": () => (rodadas ? { conflitos: [], escolhas: { a: "site" }, criado_em: "" } : { conflitos: [celula("a")], escolhas: {}, criado_em: "" }),
    "POST /api/sebrae/dashboard/conflitos": () => { rodadas += 1; return { escolhas: { a: "site" }, enviar: { iniciado: true, motivo: "" } }; },
    "GET /api/automacao/estado": { estado: "livre", rotina: "", ultima: { status: "concluido" } },
  };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    tela.escolher(0, "site");
    tela.botao.click();
    await new Promise(resolve => setImmediate(resolve));
    await tela.proximoTimer();
    assert.equal(tela.host.hidden, true);
    assert.equal(tela.efeitos.novos, 1);
    assert.deepEqual(tela.efeitos.toasts, [{ mensagem: "Conflitos resolvidos e Dashboard enviado ao SharePoint.", tipo: "success" }]);
    assert.equal(tela.timersPendentes(), 0);
  });
});

test("rotina ainda em andamento continua a esperar; ao parar com conflitos de novo, avisa e mantém a lista", async () => {
  let estado = "em_andamento";
  const rotas = {
    "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a")], escolhas: { a: "site" }, criado_em: "" },
    "POST /api/sebrae/dashboard/conflitos": { escolhas: { a: "site" }, enviar: { iniciado: true, motivo: "" } },
    "GET /api/automacao/estado": () => ({ estado, rotina: "enviar", ultima: { status: "erro" } }),
  };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    tela.botao.click();
    await new Promise(resolve => setImmediate(resolve));
    await tela.proximoTimer();
    assert.equal(tela.timersPendentes(), 1, "em andamento: agenda outra consulta");
    assert.equal(tela.efeitos.novos, 0);
    estado = "livre";
    await tela.proximoTimer();
    assert.equal(tela.host.hidden, false);
    assert.equal(tela.botao.disabled, false);
    assert.equal(tela.status.textContent, "O envio parou de novo e ainda há conflitos. Confira a lista e escolha outra vez.");
    assert.equal(tela.efeitos.toasts.length, 0);
  });
});

test("envio que não começou (rotina ocupada) explica o motivo e religa o botão", async () => {
  const rotas = {
    "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a")], escolhas: {}, criado_em: "" },
    "POST /api/sebrae/dashboard/conflitos": { escolhas: { a: "site" }, enviar: { iniciado: false, motivo: "Há outra rotina em andamento." } },
  };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    tela.escolher(0, "site");
    tela.botao.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tela.status.textContent, "Escolhas salvas, mas o envio não começou: Há outra rotina em andamento.");
    assert.equal(tela.botao.disabled, false);
    assert.equal(tela.timersPendentes(), 0);
    assert.equal(tela.efeitos.automacao, 0);
  });
});

test("422 do servidor mostra o erro e recarrega a lista", async () => {
  const falha = Object.assign(new Error("Há escolha para um conflito que não existe mais; recarregue a lista."), { status: 422 });
  const rotas = {
    "GET /api/sebrae/dashboard/conflitos": { conflitos: [celula("a")], escolhas: {}, criado_em: "" },
    "POST /api/sebrae/dashboard/conflitos": falha,
  };
  await comTela(rotas, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    tela.escolher(0, "site");
    tela.botao.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(tela.status.textContent, falha.message);
    assert.deepEqual(tela.efeitos.toasts, [{ mensagem: falha.message, tipo: "error" }]);
    assert.equal(tela.chamadas.filter(item => item.metodo === "GET").length, 2, "consulta de novo");
    assert.equal(tela.botao.disabled, false);
  });
});

test("falha ao consultar a lista deixa a tela como estava, sem erro solto", async () => {
  await comTela({ "GET /api/sebrae/dashboard/conflitos": new Error("fora do ar") }, async tela => {
    await tela.modulo.carregarConflitosSebrae();
    assert.equal(tela.host.hidden, true);
    assert.equal(tela.efeitos.toasts.length, 0);
  });
});
