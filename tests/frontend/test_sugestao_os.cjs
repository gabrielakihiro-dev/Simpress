// "OS nova sugerida" no F5 (cartão aberto de um chamado antigo). Três camadas:
// 1) regras puras de sugestao-os-modelo.ts (textos aprovados, chips, corpos dos PUT);
// 2) estado.ts com um provedor falso no lugar da caixa React: campo OS, selo "OS nova?", host `data-sugestao-os`, limpeza de raízes;
// 3) leitura do sugestao-os.tsx (o Node não lê JSX): endpoints e corpos dos PUT, sem repetição automática. O comportamento desenhado
//    no navegador (Aceitar, Recusar, troca) é provado em tests/e2e/chamados-os.spec.cjs. Só dados sintéticos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { criarDashboardSebrae: createSebraeDashboard } = require("../../frontend/src/paineis/sebrae-dashboard/estado.ts");
const modelo = require("../../frontend/src/paineis/sebrae-dashboard/sugestao-os-modelo.ts");
const sebraeDashboardModel = require("../../frontend/src/comum/sebrae-dashboard-model.ts");
const { createFakeDocument } = require("./support/fake-dom.cjs");

const textos = (os, extra = {}) => ({ os, assunto: `Assunto ${os}`, descricao: `Descrição ${os}`, data: "15/11/2026", ...extra });
const sinais = (extra = {}) => ({ mesma_serie: true, nome: false, assunto: true, numero_chamado: false, ...extra });
const aceitar = (os, chamado = "UTIC-2026-1200", serie = "BRJ0001") => ({ fonte: "oracle", serie, os, ano: 2026, numero: chamado.split("-").pop() });
const sugestao = () => ({ tipo: "sugestao", atual: textos("7303022", { data: "03/11/2026" }), nova: { ...textos("7400000"), serie: "BRJ0001", fonte: "oracle" }, sinais: sinais(), aceitar: aceitar("7400000") });
const semOs = () => ({ tipo: "sem_os", atual: null, nova: { ...textos("7400001"), serie: "BRJ0002", fonte: "oracle" }, sinais: sinais({ nome: true, mesma_serie: false }), aceitar: aceitar("7400001", "UTIC-2026-1201", "BRJ0002") });
const troca = () => ({ tipo: "troca", atual: textos("7303000"), nova: { ...textos("7400002"), serie: "BRJ0003", fonte: "oracle" }, sinais: sinais({ numero_chamado: true }), aceitar: aceitar("7400002", "UTIC-2026-1202", "BRJ0003") });

// ---- 1) regras puras ----

test("só sugestao e sem_os pedem decisão; a troca automática já foi feita pelo servidor", () => {
  assert.equal(modelo.pedeDecisao(sugestao()), true);
  assert.equal(modelo.pedeDecisao(semOs()), true);
  assert.equal(modelo.pedeDecisao(troca()), false);
  assert.equal(modelo.pedeDecisao(null), false);
  assert.equal(modelo.pedeDecisao(undefined), false);
});

test("campo OS do cartão: legenda 'mais nova:' com OS atual, 'sugerida:' sem OS, sempre com ? no número novo", () => {
  assert.deepEqual(modelo.legendaCampoOs(sugestao()), { semOs: false, legenda: "mais nova:", sugerida: "7400000?" });
  assert.deepEqual(modelo.legendaCampoOs(semOs()), { semOs: true, legenda: "sugerida:", sugerida: "7400001?" });
});

test("rótulos dos botões: Aceitar com a OS nova; Manter com a OS atual, ou Recusar quando não há OS atual", () => {
  assert.equal(modelo.rotuloAceitar(sugestao()), "Aceitar 7400000");
  assert.equal(modelo.rotuloRecusar(sugestao()), "Manter 7303022");
  assert.equal(modelo.rotuloRecusar(semOs()), "Recusar");
  assert.equal(modelo.rotuloRecusar({ ...sugestao(), atual: null }), "Recusar");
});

test("títulos e explicações da caixa seguem os textos aprovados", () => {
  assert.equal(modelo.tituloCaixa(sugestao()), "OS mais nova na mesma série: 7400000");
  assert.equal(modelo.tituloCaixa(semOs()), "OS encontrada para este chamado: 7400001");
  assert.equal(modelo.explicacaoCaixa(sugestao()), "O número do chamado não está na OS, então a troca espera a sua decisão.");
  assert.equal(modelo.explicacaoCaixa(semOs()), "A série do chamado não tem OS, então a OS espera a sua decisão.");
});

test("chips de sinais: sugestão começa pela série; sem OS começa pelos achados do solicitante e fecha com série e assunto", () => {
  assert.deepEqual(modelo.chipsSinais(sugestao()), [{ texto: "Mesma série", ok: true }, { texto: "Assunto parecido", ok: true }]);
  assert.deepEqual(modelo.chipsSinais({ ...sugestao(), sinais: sinais({ mesma_serie: false, assunto: false, nome: true, numero_chamado: true }) }), [
    { texto: "Série diferente", ok: false }, { texto: "Número do chamado na OS", ok: true }, { texto: "Nome do solicitante", ok: true }, { texto: "Assunto diferente", ok: false },
  ]);
  assert.deepEqual(modelo.chipsSinais(semOs()).map(chip => chip.texto), ["Nome do solicitante", "Série diferente", "Assunto parecido"]);
});

test("selo do cartão de OS leva a data quando existe; descrição vazia vira 'Descrição não disponível'", () => {
  assert.equal(modelo.seloOs("atual", { data: "03/11/2026" }), "atual · 03/11/2026");
  assert.equal(modelo.seloOs("mais nova", { data: "" }), "mais nova");
  assert.equal(modelo.seloOs("encontrada", { data: "15/11/2026" }), "encontrada · 15/11/2026");
  assert.equal(modelo.textoOuIndisponivel(""), "Descrição não disponível");
  assert.equal(modelo.textoOuIndisponivel("   "), "Descrição não disponível");
  assert.equal(modelo.textoOuIndisponivel(null), "Descrição não disponível");
  assert.equal(modelo.textoOuIndisponivel(" Teclado trocado "), "Teclado trocado");
  assert.equal(modelo.SELO_OS_NOVA, "OS nova?");
});

test("notas depois da decisão usam os textos aprovados", () => {
  assert.equal(modelo.notaTroca("7400002"), "OS trocada sozinha: o número do chamado está no assunto da OS 7400002.");
  assert.equal(modelo.notaAceita("7400000"), "OS 7400000 aceita. A aba OS já mostra o vínculo.");
  assert.equal(modelo.notaRecusada("7400000"), "OS 7400000 recusada. Ela não volta a ser sugerida para este chamado.");
});

test("Aceitar copia o corpo pronto do servidor; Recusar e Manter gravam só a OS nova no endereço do chamado", () => {
  const dado = sugestao();
  const corpo = modelo.corpoAceitar(dado);
  assert.deepEqual(corpo, dado.aceitar);
  assert.notEqual(corpo, dado.aceitar, "é cópia: mexer nela não altera o dado do servidor");
  assert.equal(modelo.URL_VINCULOS_OS, "/api/operacoes/chamados/vinculos-os");
  assert.deepEqual(modelo.corpoRecusar(dado), { os: "7400000" });
  assert.equal(modelo.urlOsRecusada("UTIC-2026-1200"), "/api/sebrae/chamados/UTIC-2026-1200/os-recusada");
  assert.equal(modelo.urlOsRecusada("linha:27"), "/api/sebrae/chamados/linha%3A27/os-recusada");
});

// ---- 2) estado.ts com provedor falso ----

const esvaziarFila = () => new Promise(resolver => setImmediate(resolver));
const cartaoAntigoDe = (el, numero) => el["sebrae-antigos-lista"].querySelectorAll("details.sebrae-antigo").find(no => no.dataset.numero === numero);
const aberto = (numero, extra = {}) => ({
  numero, titulo: `Chamado ${numero}`, chamado: numero, usuario: "Solicitante Teste", automaticos: {}, automaticos_sugeridos: {},
  valores: { A: "", B: "", D: "EM ABERTO", J: "", R: "", S: "" }, leitura_softexpert: null, ...extra,
});
const cargaComOsNova = () => ({
  importado: {
    arquivo: "Dashboard.xlsx", importado_em: "2026-11-16T10:00:00-03:00", total: 4, atualizavel: true, saida_pronta: false, listas: { A: ["CLIENTE"] },
    abertos: [
      aberto("UTIC-2026-1200", { automaticos: { E: "7303022", K: "BRJ0001" }, os_nova: sugestao() }),
      aberto("UTIC-2026-1201", { automaticos: { K: "BRJ0002" }, os_nova: semOs() }),
      aberto("UTIC-2026-1202", { automaticos: { E: "7400002", K: "BRJ0003" }, os_nova: troca() }),
      aberto("UTIC-2026-1203", { automaticos: { E: "7303999", K: "BRJ0004" }, os_nova: null }),
    ],
    finalizados: [],
  },
  novos: { lidos_em: "2026-11-16T10:05:00-03:00", ignorados: 0, pendentes: [], erros: {}, formulario: [] },
});

async function montarComProvedor(carga = cargaComOsNova(), decididos = [], comProvedor = true) {
  const doc = createFakeDocument();
  const criar = doc.createElement;
  doc.createElement = tag => {
    const no = criar(tag);
    no.classList = { toggle(nome, forcar) { const outras = no.className.split(/\s+/).filter(c => c && c !== nome); no.className = (forcar ? [...outras, nome] : outras).join(" "); } };
    return no;
  };
  global.document = doc;
  global.window = { setTimeout: () => 0, clearTimeout() {}, localStorage: null };
  const ids = [["sebrae-novos-lista", "div"], ["sebrae-novos", "section"], ["sebrae-antigos-lista", "div"], ["sebrae-antigos", "section"], ["sebrae-finalizados-lista", "ul"], ["sebrae-finalizados", "section"],
    ["sebrae-sharepoint-aviso", "div"], ["sebrae-atualizar-status", "p"], ["sebrae-novos-resumo", "p"], ["sebrae-dashboard-status", "p"], ["btn-sebrae-atualizar", "button"],
    ["sebrae-destaques", "section"], ["sebrae-destaques-contagem", "span"], ["sebrae-destaques-resumo", "p"], ["sebrae-destaques-lista", "div"], ["sebrae-destaque-anuncio", "p"], ["sebrae-novos-secao", "h3"]];
  const el = {};
  for (const [id, tag] of ids) { el[id] = doc.createElement(tag); el[id].setAttribute("id", id); doc.body.append(el[id]); }
  el["sebrae-novos"].append(el["sebrae-novos-lista"]);
  el["sebrae-antigos"].append(el["sebrae-antigos-lista"]);
  el["sebrae-finalizados"].append(el["sebrae-finalizados-lista"]);
  el["sebrae-destaques"].append(el["sebrae-destaques-lista"]);
  ["novos", "antigos", "destaques", "finalizados"].forEach(aba => { const botao = doc.createElement("button"); botao.setAttribute("id", `sebrae-aba-${aba}`); doc.body.append(botao); el[`sebrae-aba-${aba}`] = botao; });
  ["sebrae-antigos", "sebrae-destaques", "sebrae-finalizados"].forEach(id => { el[id].hidden = true; });
  const chamadas = [];
  const apiFetch = async (url, opcoes = {}) => { chamadas.push({ url, metodo: opcoes.method || "GET" }); return url.includes("observacoes") ? { observacoes: {} } : carga; };
  const provedor = {
    montagens: [], limpezas: 0, decididos: new Set(decididos),
    montar(host, args) { this.montagens.push({ host, ...args }); },
    temDecisao(numero) { return this.decididos.has(numero); },
    limparOrfas() { this.limpezas += 1; },
  };
  const app = { apiFetch, showToast() {}, confirmarAcao: async () => true };
  const dom = { createTextElement: (tag, classe, texto) => { const no = doc.createElement(tag); no.className = classe || ""; no.textContent = texto; return no; } };
  const feature = createSebraeDashboard({ app, dom, sebraeDashboardModel, ...(comProvedor ? { sugestaoOs: provedor } : {}) });
  await feature.carregarNovosSebrae();
  await esvaziarFila();
  return { doc, el, feature, provedor, chamadas, carga };
}

const campoE = cartao => cartao.querySelectorAll(".sebrae-chamado__auto div").find(linha => linha.querySelector("dt")?.textContent === "OS")?.querySelector("dd");

test("sugestão: campo OS 'mais nova: N?', selo 'OS nova?' na linha, host entregue à caixa e raízes antigas limpas", async () => {
  const { el, provedor } = await montarComProvedor();
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1200");
  assert.match(campoE(cartao).textContent, /^7303022\s+mais nova: 7400000\?$/);
  assert.equal(campoE(cartao).className, "sebrae-osnova-campo");
  assert.ok(campoE(cartao).querySelector("button.sebrae-chamado__os"), "a OS atual continua sendo o botão que abre a janela Chamado × OS");
  const selo = cartao.querySelector(".sebrae-selo-os-nova");
  assert.equal(selo.textContent, "OS nova?");
  assert.equal(selo.title, "OS 7400000");
  const host = cartao.querySelector("[data-sugestao-os]");
  assert.ok(host, "host criado dentro do cartão aberto");
  assert.equal(host.children.length, 0, "estado.ts nunca escreve dentro do host");
  const montagem = provedor.montagens.find(m => m.numero === "UTIC-2026-1200");
  assert.equal(montagem.host, host);
  assert.equal(montagem.osNova.tipo, "sugestao");
  assert.equal(montagem.osNova.nova.os, "7400000");
  assert.equal(typeof montagem.recarregar, "function");
  assert.ok(provedor.limpezas >= 1, "limparOrfas roda a cada desenho da lista");
});

test("chamado sem OS: campo diz 'sem OS sugerida: N?' e a linha OS aparece só por causa da sugestão", async () => {
  const { el } = await montarComProvedor();
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1201");
  assert.equal(campoE(cartao).textContent, "sem OS sugerida: 7400001?");
  assert.equal(cartao.querySelector(".sebrae-selo-os-nova").textContent, "OS nova?");
  assert.ok(cartao.querySelector("[data-sugestao-os]"));
});

test("troca automática: sem selo e sem marca no campo OS, mas o host existe para a nota verde", async () => {
  const { el, provedor } = await montarComProvedor();
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1202");
  assert.equal(cartao.querySelector(".sebrae-selo-os-nova"), null);
  assert.notEqual(campoE(cartao).className, "sebrae-osnova-campo");
  assert.doesNotMatch(campoE(cartao).textContent, /\?/);
  assert.ok(cartao.querySelector("[data-sugestao-os]"));
  assert.equal(provedor.montagens.find(m => m.numero === "UTIC-2026-1202").osNova.tipo, "troca");
});

test("chamado sem os_nova: sem host, sem selo e sem chamada ao provedor", async () => {
  const { el, provedor } = await montarComProvedor();
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1203");
  assert.equal(cartao.querySelector("[data-sugestao-os]"), null);
  assert.equal(cartao.querySelector(".sebrae-selo-os-nova"), null);
  assert.equal(provedor.montagens.some(m => m.numero === "UTIC-2026-1203"), false);
});

test("decisão já tomada: o host continua mesmo com os_nova vazio, sem selo 'OS nova?'", async () => {
  const carga = cargaComOsNova();
  carga.importado.abertos[0].os_nova = null;
  const { el, provedor } = await montarComProvedor(carga, ["UTIC-2026-1200"]);
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1200");
  assert.ok(cartao.querySelector("[data-sugestao-os]"), "a nota da decisão precisa de host depois da recarga");
  assert.equal(provedor.montagens.find(m => m.numero === "UTIC-2026-1200").osNova, null);
  assert.equal(cartao.querySelector(".sebrae-selo-os-nova"), null);
});

test("sem provedor injetado: o cartão nasce sem host e sem selo de decisão, e o painel não quebra", async () => {
  const { el } = await montarComProvedor(cargaComOsNova(), [], false);
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1200");
  assert.ok(cartao, "o cartão existe");
  assert.equal(cartao.querySelector("[data-sugestao-os]"), null);
});

test("recarregar: lê o F5 de novo, reabre o cartão do chamado e limpa as raízes órfãs", async () => {
  const { el, provedor, chamadas, carga } = await montarComProvedor();
  const montagem = provedor.montagens.find(m => m.numero === "UTIC-2026-1200");
  const antes = chamadas.filter(c => c.url.includes("/api/sebrae/novos")).length;
  const limpezasAntes = provedor.limpezas;
  // como depois do PUT: o servidor já não devolve os_nova; o provedor guardou a decisão
  carga.importado.abertos[0].os_nova = null;
  provedor.decididos.add("UTIC-2026-1200");
  await montagem.recarregar();
  await esvaziarFila();
  assert.equal(chamadas.filter(c => c.url.includes("/api/sebrae/novos")).length, antes + 1, "uma leitura nova, sem repetição");
  assert.ok(provedor.limpezas > limpezasAntes, "cada desenho limpa as raízes órfãs");
  const cartao = cartaoAntigoDe(el, "UTIC-2026-1200");
  assert.equal(cartao.open, true, "a linha refeita volta aberta");
  assert.equal(cartao.querySelector(".sebrae-selo-os-nova"), null);
});

// ---- 3) leitura do sugestao-os.tsx ----

const fonteTsx = fs.readFileSync(path.resolve(__dirname, "../../frontend/src/paineis/sebrae-dashboard/sugestao-os.tsx"), "utf8");

test("sugestao-os.tsx: Aceitar grava em vinculos-os, Recusar e Manter em os-recusada, sem repetir sozinho e sem importar CSS", () => {
  assert.match(fonteTsx, /apiFetch\(URL_VINCULOS_OS, \{ method: "PUT"[^}]*body: JSON\.stringify\(corpoAceitar\(osNova\)\)/);
  assert.match(fonteTsx, /apiFetch\(urlOsRecusada\(numero\), \{ method: "PUT"[^}]*body: JSON\.stringify\(corpoRecusar\(osNova\)\)/);
  assert.equal((fonteTsx.match(/apiFetch\(/g) || []).length, 2, "só dois pontos de gravação");
  assert.doesNotMatch(fonteTsx, /setTimeout|setInterval|retry/i, "sem repetição automática");
  assert.doesNotMatch(fonteTsx, /import\s+["'][^"']+\.css["']/, "o CSS vem de static/styles/ck-cockpit.css");
  assert.match(fonteTsx, /emEnvio\.current/, "guarda contra dois cliques seguidos");
  assert.match(fonteTsx, /disabled=\{enviando\}/);
  assert.doesNotMatch(fonteTsx, /data-on-/, "nenhuma ação nova no registro de ações");
});

test("sugestao-os.tsx: só a troca automática mostra nota sem botões; erro devolve os botões com mensagem curta", () => {
  assert.match(fonteTsx, /osNova\.tipo === "troca"\) return <Nota tipo="ok" texto=\{notaTroca\(osNova\.nova\.os\)\} \/>/);
  assert.match(fonteTsx, /errorMessage: "Não foi possível aceitar a OS\."/);
  assert.match(fonteTsx, /errorMessage: "Não foi possível recusar a OS\."/);
  assert.match(fonteTsx, /role="alert"/);
});
