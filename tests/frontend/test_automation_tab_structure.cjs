// Automação (F5): desde o Dia 3 (G7, React) a aba vive em frontend/src/paineis/chrome-automation/ e o comportamento de
// tela é testado no navegador (tests/e2e/chrome-automation.spec.cjs e tests/e2e/react-g7.spec.cjs, rotas /api/automacao/*
// simuladas). Aqui ficam as regras puras (regras-puro.ts, carregado direto pelo require do Node), a ponte do código antigo
// (frontend/src/aplicacao/pontes.ts), o registro, o HTML montado (seis pontos de montagem), o TSX dos cartões e o
// CSS da barra de ações. Dados sintéticos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const createChromeAutomation = require("../../frontend/src/aplicacao/registro.ts").fabricas.chromeAutomation;

const root = path.resolve(__dirname, "../..");
const pasta = path.join(root, "frontend/src/paineis/chrome-automation");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");
// A ponte é a entrada chromeAutomation da tabela de pontes.ts (da chave até a próxima entrada).
const pontesSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/pontes.ts"), "utf8");
const ponteSource = pontesSource.slice(pontesSource.indexOf("  chromeAutomation: {"), pontesSource.indexOf("  assistantChat: {"));
const styles = fs.readFileSync(path.join(root, "static/styles/ux-refinements.css"), "utf8");
const cockpitCss = fs.readFileSync(path.join(root, "static/styles/ck-cockpit.css"), "utf8");
const lerPasta = nome => fs.readFileSync(path.join(pasta, nome), "utf8");
const regras = require(path.join(pasta, "regras-puro.ts"));
const {
  ROTINAS, STATUS, POLL_ATIVO_MS, POLL_LIVRE_MS, MAX_LINHAS, MAX_EVENTOS, ROTINAS_DOS_CARTOES, eServidorDesatualizado, nomeDaRotina,
  nomeDoStatus, formatarDuracao, descreverQuando, rotuloInicio, dataLocalIso, situacaoDoSelo, iconeDoSelo, situacaoDoCartao, botaoBloqueado,
  rotuloDoBotao, iconeDoBotao, descreverEstado, textoResultado, classificarEvento, eventosDoLog, textoDoModo, textoDoArquivo, resumoDoHistorico,
  limitarPagina, descricaoDaCaptura, dicaDosLotes, visaoDoLog, verBackupsDepois,
} = regras;

const AGORA = new Date(2026, 10, 12, 10, 0, 0); // 12/11/2026 10:00, hora local

// ---- Regras puras ----
test("regras: as rotinas têm os nomes aprovados e a aba mostra quatro cartões, na ordem dos botões", () => {
  assert.equal(ROTINAS.os, "Rotina de OS");
  assert.equal(ROTINAS.inventarios, "Inventários");
  assert.equal(ROTINAS.usuarios, "Verificar usuários");
  assert.equal(ROTINAS.ambas, "Rotina Completa");
  assert.equal(ROTINAS.login, "Abrir Chrome para login");
  assert.equal(nomeDaRotina("os"), "Rotina de OS");
  assert.equal(nomeDaRotina("desconhecida"), "desconhecida");
  assert.equal(nomeDaRotina(undefined), "");
  assert.equal(nomeDoStatus("falha"), "Falha");
  assert.equal(nomeDoStatus(""), "");
  assert.deepEqual(Object.keys(STATUS), ["em_andamento", "concluido", "falha", "cancelado", "ocupada", "interrompido"]);
  assert.deepEqual([...ROTINAS_DOS_CARTOES], ["os", "inventarios", "ambas", "usuarios"]);
  assert.equal(Object.isFrozen(ROTINAS) && Object.isFrozen(STATUS), true);
});

test("regras: o polling segue 1,5 s com rotina em andamento e 5 s livre; o log guarda 500 linhas e 200 eventos", () => {
  assert.equal(POLL_ATIVO_MS, 1500);
  assert.equal(POLL_LIVRE_MS, 5000);
  assert.equal(MAX_LINHAS, 500);
  assert.equal(MAX_EVENTOS, 200);
});

test("regras: 404 com o corpo padrão do FastAPI é servidor antigo; 404 com mensagem própria e outros erros não são", () => {
  assert.equal(eServidorDesatualizado({ status: 404, detail: "Not Found" }), true);
  assert.equal(eServidorDesatualizado({ status: 404 }), true);
  assert.equal(eServidorDesatualizado({ status: 404, detail: "Execução não encontrada." }), false);
  assert.equal(eServidorDesatualizado({ status: 409, detail: "Not Found" }), false);
  assert.equal(eServidorDesatualizado(null), false);
  assert.equal(eServidorDesatualizado(undefined), false);
});

test("regras: nunca libera uma segunda rotina; só a própria rotina em andamento vira Acompanhar", () => {
  const livre = { ocupado: false, emAndamento: false, acompanhar: false, semSaida: false };
  assert.equal(botaoBloqueado(livre), false);
  assert.equal(botaoBloqueado({ ...livre, ocupado: true }), true, "um clique em curso trava todos (clique duplo)");
  assert.equal(botaoBloqueado({ ...livre, emAndamento: true }), true, "outra rotina em andamento trava");
  assert.equal(botaoBloqueado({ ...livre, emAndamento: true, acompanhar: true }), false, "a própria rotina fica livre para acompanhar");
  assert.equal(botaoBloqueado({ ...livre, emAndamento: true, acompanhar: true, ocupado: true }), true);
  assert.equal(botaoBloqueado({ ...livre, semSaida: true }), true, "sem resposta real do servidor fica bloqueado");
});

test("regras: rótulo e ícone do botão — Executar, Acompanhar ou Tentar de novo depois de falha", () => {
  assert.equal(rotuloDoBotao(false, false), "Executar");
  assert.equal(rotuloDoBotao(true, false), "Acompanhar");
  assert.equal(rotuloDoBotao(true, true), "Acompanhar", "rotina em andamento nunca é Tentar de novo");
  assert.equal(rotuloDoBotao(false, true), "Tentar de novo");
  assert.equal(iconeDoBotao(false, false), "i-play");
  assert.equal(iconeDoBotao(true, false), "i-text");
  assert.equal(iconeDoBotao(false, true), "i-refresh");
});

test("regras: o selo de cada cartão mostra andamento, conclusão de hoje, outro dia, falha ou ausência", () => {
  assert.deepEqual(situacaoDoSelo(true, null, AGORA), { status: "info", texto: "Em andamento" });
  assert.deepEqual(situacaoDoSelo(false, null, AGORA), { status: "", texto: "Sem execuções" });
  const hoje = { id: "1", rotina: "os", status: "concluido", inicio: "2026-11-12T08:15:00", fim: "2026-11-12T08:30:00" };
  assert.deepEqual(situacaoDoSelo(false, hoje, AGORA), { status: "ok", texto: "Concluído 08:30" });
  const ontem = { id: "2", rotina: "os", status: "concluido", fim: "2026-11-11T17:45:00" };
  assert.deepEqual(situacaoDoSelo(false, ontem, AGORA), { status: "", texto: "Ontem 17:45" });
  const falha = { id: "3", rotina: "os", status: "falha", fim: "2026-11-12T09:00:00" };
  assert.deepEqual(situacaoDoSelo(false, falha, AGORA), { status: "erro", texto: "Falha 09:00" });
  assert.equal(iconeDoSelo(true, "info"), "i-loader");
  assert.equal(iconeDoSelo(false, ""), "i-clock");
  assert.equal(iconeDoSelo(false, "ok"), "i-ok");
  assert.equal(situacaoDoCartao(true, "info"), "em-andamento");
  assert.equal(situacaoDoCartao(false, "ok"), "concluido");
  assert.equal(situacaoDoCartao(false, "erro"), "ocioso");
});

test("regras: datas — hoje, ontem, outro dia, duração e dia do log", () => {
  assert.deepEqual(descreverQuando("2026-11-12T08:30:00", AGORA), { dia: 0, texto: "08:30" });
  assert.deepEqual(descreverQuando("2026-11-11T17:45:00", AGORA), { dia: 1, texto: "ontem 17:45" });
  assert.equal(descreverQuando("2026-10-22T16:20:00", AGORA).texto, "22/10 16:20");
  assert.deepEqual(descreverQuando("sem data", AGORA), { dia: -1, texto: "" });
  assert.equal(rotuloInicio("2026-11-12T08:30:00", AGORA), "Hoje 08:30");
  assert.equal(rotuloInicio("2026-11-11T17:45:00", AGORA), "Ontem 17:45");
  assert.equal(rotuloInicio(null, AGORA), "—");
  assert.equal(formatarDuracao("2026-11-12T08:00:00", "2026-11-12T08:02:05"), "2m 5s");
  assert.equal(formatarDuracao("2026-11-12T08:00:00", "2026-11-12T09:30:00"), "1h 30m");
  assert.equal(formatarDuracao("2026-11-12T08:00:00", "2026-11-12T07:00:00"), "—");
  assert.equal(formatarDuracao("sem data", "sem data"), "—");
  assert.equal(dataLocalIso("2026-11-05T22:10:00"), "2026-11-05");
  assert.equal(dataLocalIso("sem data"), "");
});

test("regras: livre, ocupado e cancelando descrevem a aba, o chip e o aviso de login", () => {
  const livre = descreverEstado({ estado: "livre" });
  assert.deepEqual([livre.ativo, livre.dataState, livre.seloStatus, livre.titulo, livre.chipState, livre.chipTitulo], [false, "livre", "ok", "Livre", "idle", "Chrome livre"]);
  assert.equal(livre.detalhe, "Nenhuma rotina em andamento.");
  assert.equal(livre.chipDica, "Chrome livre para uma nova rotina.");
  const ocupado = descreverEstado({ estado: "em_andamento", rotina: "os", inicio: "2026-11-12T09:00:00" });
  assert.deepEqual([ocupado.ativo, ocupado.dataState, ocupado.seloStatus, ocupado.titulo, ocupado.chipState, ocupado.chipTitulo], [true, "em_andamento", "info", "Ocupado", "occupied", "Chrome ocupado"]);
  assert.match(ocupado.detalhe, /^Rotina de OS em andamento desde \d{2}:\d{2}$/);
  assert.equal(ocupado.chipDica, "Rotina de OS em andamento.");
  const cancelando = descreverEstado({ estado: "em_andamento", rotina: "os", cancelamento_pedido: true });
  assert.deepEqual([cancelando.dataState, cancelando.seloStatus, cancelando.titulo], ["cancelando", "alerta", "Cancelando…"]);
  assert.equal(cancelando.detalhe, "Rotina de OS em andamento");
  const login = descreverEstado({ estado: "em_andamento", rotina: "os", aguardando_login: true, login_origem: "Oracle" });
  assert.equal(login.esperandoLogin, true);
  assert.equal(login.avisoLogin, "Faça o login no Chrome de automação (Oracle). A rotina continua sozinha depois do login.");
  assert.equal(descreverEstado({ estado: "livre", aguardando_login: true }).esperandoLogin, false, "aviso de login só com rotina em andamento");
  const ultima = descreverEstado({ estado: "livre", ultima: { id: "1", rotina: "inventarios", status: "falha", fim: "2026-11-12T09:30:00" } });
  assert.match(ultima.detalhe, /^Última execução: Inventários, Falha em \d{2}\/\d{2}, \d{2}:\d{2}\.$|^Última execução: Inventários, Falha em .+\.$/);
});

test("regras: o aviso ao terminar nomeia a rotina e o status; só 'Atualizar apelidos' leva a mensagem de falha", () => {
  assert.equal(textoResultado({ id: "1", rotina: "os", status: "concluido" }), "Rotina de OS: Concluído.");
  assert.equal(textoResultado({ id: "1", rotina: "os", status: "falha", mensagem: "Quebrou" }), "Rotina de OS: Falha.");
  assert.equal(textoResultado({ id: "1", rotina: "ux_apelidos", status: "falha", mensagem: "Sessão expirou." }), "Atualizar apelidos e id no UX Simpress: Falha. Sessão expirou.");
  assert.equal(textoResultado({ id: "1", rotina: "ux_apelidos", status: "concluido", mensagem: "ignorada" }), "Atualizar apelidos e id no UX Simpress: Concluído.");
});

test("regras: o log vira eventos classificados; '0 com erro' não é falha; sem linhas, aviso de espera", () => {
  assert.deepEqual(classificarEvento("Falha ao abrir o Oracle"), { estado: "error", icone: "✕", status: "Falha" });
  assert.equal(classificarEvento("Resumo: 3 concluídas, 0 com erro").estado, "success");
  assert.equal(classificarEvento("Ação necessária: faça login").estado, "waiting");
  assert.deepEqual(classificarEvento("Exportando 40% concluído"), { estado: "active", icone: "◌", status: "40%" });
  assert.equal(classificarEvento("Texto qualquer").estado, "info");
  assert.deepEqual(eventosDoLog("")[0], { hora: "—", origem: "", mensagem: "Aguardando atividade do Chrome.", estado: "waiting", status: "Aguardando", nivel: "alerta" });
  const [evento, semHora] = eventosDoLog("[09:15:02] [oracle] Login necessário\nsó texto");
  assert.deepEqual([evento.hora, evento.origem, evento.mensagem, evento.nivel], ["09:15:02", "oracle", "Login necessário", "alerta"]);
  assert.deepEqual([semHora.hora, semHora.origem, semHora.mensagem], ["—", "", "só texto"]);
  const muitas = Array.from({ length: MAX_EVENTOS + 50 }, (_, i) => `linha ${i}`).join("\n");
  assert.equal(eventosDoLog(muitas).length, MAX_EVENTOS);
  assert.equal(eventosDoLog(muitas).at(-1).mensagem, `linha ${MAX_EVENTOS + 49}`);
});

test("regras: modo, arquivo e visão do log — ao vivo, histórico, erro e antes da primeira leitura", () => {
  assert.equal(textoDoModo({ historico: false, limite: 200, total: 30 }), "Ao vivo · últimas 30 linhas");
  assert.equal(textoDoModo({ historico: false, limite: 50, total: 300 }), "Ao vivo · últimas 50 linhas");
  assert.match(textoDoModo({ historico: true, limite: 200, total: 10, execucao: { id: "1", rotina: "os", status: "falha", inicio: "2026-11-12T09:00:00" }, limitado: true }), /^Histórico · Rotina de OS · .+ · últimas 10 linhas \(trecho final\)$/);
  assert.equal(textoDoModo({ historico: true, limite: 200, total: 0 }), "Histórico · Consultando execução · últimas 0 linhas");
  assert.equal(textoDoArquivo("log.txt"), "Arquivo: log.txt");
  assert.equal(textoDoArquivo(""), "Nenhum log disponível.");
  const base = { logMostrado: true, execucaoSelecionada: "", linhasAoVivo: ["a", "b", "c"], arquivo: "vivo.log", logHistorico: null, logErro: null, limiteLog: 2 };
  assert.deepEqual(visaoDoLog({ ...base, logMostrado: false }).eventos.map(e => e.mensagem), ["Aguardando atividade do Chrome."]);
  assert.equal(visaoDoLog({ ...base, logMostrado: false }).modo, "Ao vivo · execução mais recente");
  const aoVivo = visaoDoLog(base);
  assert.deepEqual([aoVivo.historico, aoVivo.texto, aoVivo.arquivoTexto, aoVivo.modo], [false, "b\nc", "Arquivo: vivo.log", "Ao vivo · últimas 2 linhas"]);
  const historico = visaoDoLog({ ...base, execucaoSelecionada: "x1", logHistorico: { arquivo: "velho.log", linhas: ["h1", "h2", "h3"] } });
  assert.deepEqual([historico.historico, historico.texto, historico.arquivoTexto], [true, "h2\nh3", "Arquivo: velho.log"]);
  const erro = visaoDoLog({ ...base, execucaoSelecionada: "x1", logErro: "Não foi possível abrir o log selecionado." });
  assert.deepEqual([erro.texto, erro.modo], ["Não foi possível abrir o log selecionado.", "Histórico · erro ao consultar"]);
});

test("regras: resumo, página e legendas do histórico", () => {
  assert.equal(resumoDoHistorico(3, {}), "3 execuções");
  assert.equal(
    resumoDoHistorico(3, { data_inicio: "2026-11-01", data_fim: "2026-11-10", rotina: "os", status: "falha" }),
    "3 execuções · de 01/11/2026 · até 10/11/2026 · Rotina de OS · Falha",
  );
  assert.equal(limitarPagina(0, 5), 1);
  assert.equal(limitarPagina(9, 5), 5);
  assert.equal(limitarPagina(3, 5), 3);
  assert.equal(dicaDosLotes({ id: "1", rotina: "os", status: "concluido", lotes: [{ id: "L1", status: "ok" }, { id: "L2" }] }), "Lotes: L1 (ok), L2");
  assert.equal(dicaDosLotes({ id: "1", rotina: "os", status: "concluido" }), "");
  assert.match(descricaoDaCaptura({ id: "1", rotina: "os", status: "falha", inicio: "2026-11-12T09:00:00", mensagem: "Timeout" }), /^Captura de tela da falha em Rotina de OS às .+: Timeout$/);
  assert.equal(descricaoDaCaptura({ id: "1", rotina: "", status: "falha" }), "Captura de tela da falha em Automação");
});

test("regras: o atalho 'Ver backups no Resumo' só aparece quando inventários ou a rotina completa acabam de concluir", () => {
  const passo = (anterior, depois) => verBackupsDepois({ emAndamento: depois.emAndamento, estavaAtivo: anterior.ativo, rotinaAnterior: anterior.rotina, statusUltima: depois.status });
  assert.equal(passo({ ativo: false, rotina: "" }, { emAndamento: false, status: "concluido" }), null, "sem execução observada, fica como está");
  assert.equal(passo({ ativo: true, rotina: "os" }, { emAndamento: false, status: "concluido" }), null, "rotina de OS não mostra");
  assert.equal(passo({ ativo: true, rotina: "inventarios" }, { emAndamento: false, status: "falha" }), null, "falha não mostra");
  assert.equal(passo({ ativo: true, rotina: "inventarios" }, { emAndamento: false, status: "concluido" }), true);
  assert.equal(passo({ ativo: true, rotina: "ambas" }, { emAndamento: false, status: "concluido" }), true);
  assert.equal(passo({ ativo: true, rotina: "usuarios" }, { emAndamento: false, status: "concluido" }), null);
  assert.equal(passo({ ativo: false, rotina: "" }, { emAndamento: true, status: undefined }), false, "nova rotina esconde");
});

// ---- Ponte do código antigo ----
const NOMES_PONTE = [
  "inicializarAutomacao", "alterarAgendamentoDashboard", "carregarAgendamentoDashboard", "iniciarRotinaAutomacao",
  "acompanharExecucaoAutomacao", "cancelarRotinaAutomacao", "atualizarEstadoAutomacao", "carregarHistoricoAutomacao",
  "filtrarHistoricoAutomacao", "limparFiltrosAutomacao", "mudarPaginaHistoricoAutomacao", "carregarExecucoesLogAutomacao",
  "mudarPaginaLogAutomacao", "selecionarLogAutomacao", "abrirLogExecucaoAutomacao", "voltarAoVivoAutomacao",
  "alterarLimiteLogAutomacao",
];

function ponteFalsa(acao) {
  const chamadas = [];
  const feature = createChromeAutomation({
    ponteReact(painel, nomes) {
      chamadas.push([painel, nomes]);
      return Object.fromEntries(nomes.map(nome => [nome, (...args) => acao(nome, ...args)]));
    },
  });
  return { chamadas, feature };
}

async function semConsole(fn) {
  const original = {};
  for (const metodo of ["log", "info", "debug", "warn", "error"]) {
    original[metodo] = console[metodo];
    console[metodo] = () => {};
  }
  try {
    return await fn();
  } finally {
    Object.assign(console, original);
  }
}

test("registro: a entrada chromeAutomation de pontes.ts é a ponte do painel React chrome-automation e continua no arranque e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.chromeAutomation, "function");
  assert.match(appSource, /"chromeAutomation",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
  for (const nome of NOMES_PONTE) assert.match(lerPasta("montar.tsx"), new RegExp(`\\b${nome}\\b`), `${nome} falta no retorno de montar()`);
});

test("ponte: os 17 nomes continuam publicados e repassam ao painel React com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome; });
  assert.deepEqual(chamadas, [["chrome-automation", NOMES_PONTE]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PONTE);
  await feature.iniciarRotinaAutomacao("os");
  await feature.mudarPaginaHistoricoAutomacao(-1);
  await feature.abrirLogExecucaoAutomacao("exec-1", "2026-11-12T09:00:00");
  assert.deepEqual(chamadasReact, [
    ["iniciarRotinaAutomacao", ["os"]],
    ["mudarPaginaHistoricoAutomacao", [-1]],
    ["abrirLogExecucaoAutomacao", ["exec-1", "2026-11-12T09:00:00"]],
  ]);
});

test("ponte: se o React não carregou, nenhuma ação rejeita (quem chama, como data-on-*, não trata erro)", async () => {
  const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "chrome-automation" não carregou.')));
  await semConsole(async () => {
    for (const nome of NOMES_PONTE) assert.equal(await feature[nome](), undefined, nome);
  });
});

test("ponte: nenhum chamador usa o retorno das ações e a ponte não guarda regra nem estado", () => {
  assert.doesNotMatch(appSource, /=\s*(?:await\s+)?(?:app\.)?(?:chromeAutomation|iniciarRotinaAutomacao)\b/);
  assert.doesNotMatch(ponteSource, /\bfetch\(|apiFetch|document\.|setTimeout|setInterval/);
  assert.ok(ponteSource.split("\n").length < 60, "a ponte só publica os nomes");
});

test("o polling não vaza: inicializarAutomacao desfaz o observador, o ouvinte de visibilitychange e o timer anteriores", () => {
  const acoes = lerPasta("acoes.ts");
  assert.match(acoes, /interno\.desmontar\?\.\(\);\s*interno\.desmontar = null;/);
  assert.match(acoes, /document\.addEventListener\("visibilitychange", aoMudarVisibilidade\);/);
  assert.match(acoes, /document\.removeEventListener\("visibilitychange", aoMudarVisibilidade\);/);
  assert.match(acoes, /observador\.disconnect\(\);/);
  assert.equal((acoes.match(/window\.setTimeout\(/g) || []).length, 1, "um único timer de polling");
  assert.match(acoes, /clearTimeout\(interno\.timer\);/);
  assert.match(acoes, /if \(!painelVisivel\(\) && !interno\.acompanharFim\) \{ semEstadoReal\(\); return; \}/);
  assert.match(acoes, /ler\(\)\.emAndamento \? POLL_ATIVO_MS : POLL_LIVRE_MS/);
  assert.match(acoes, /attributeFilter: \["hidden"\]/);
});

test("a rotina só começa por clique e um segundo clique não inicia outra", () => {
  const acoes = lerPasta("acoes.ts");
  const iniciar = acoes.slice(acoes.indexOf("export async function iniciarRotinaAutomacao"), acoes.indexOf("export async function cancelarRotinaAutomacao"));
  assert.match(iniciar, /if \(!ROTINAS\[rotina\] \|\| atual\.ocupado\) return;/);
  assert.match(iniciar, /if \(atual\.emAndamento\) \{\s*if \(atual\.rotinaAtiva === rotina\) acompanharRotina\(\);\s*return;\s*\}/);
  assert.ok(iniciar.indexOf("mudar({ ocupado: true") < iniciar.indexOf("await consultarAutomacao"), "ocupado antes de qualquer await");
  assert.match(iniciar, /method: "POST"/);
  assert.match(iniciar, /body: JSON\.stringify\(\{ rotina \}\)/);
  // Nenhum efeito, timer ou montagem chama iniciarRotinaAutomacao: só o data-on-click dos botões.
  for (const arquivo of fs.readdirSync(pasta).filter(nome => nome !== "regras-puro.ts")) {
    const codigo = lerPasta(arquivo);
    const chamadas = [...codigo.matchAll(/(?<!function )iniciarRotinaAutomacao\(/g)].length;
    assert.equal(chamadas, 0, `${arquivo} não chama iniciarRotinaAutomacao`);
  }
});

// ---- Privacidade ----
test("o painel só fala com a API por apiFetch e nenhum arquivo traz e-mail corporativo, CPF ou senha", () => {
  const arquivos = [...fs.readdirSync(pasta).map(nome => path.join(pasta, nome)), path.join(root, "frontend/src/aplicacao/pontes.ts")];
  assert.ok(arquivos.length >= 8);
  for (const arquivo of arquivos) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    assert.doesNotMatch(codigo, /@simpress\.com\.br/, arquivo);
    assert.doesNotMatch(codigo, /(?<![A-Za-z.])fetch\(/, `${arquivo}: chamada de API só por apiFetch`);
    assert.doesNotMatch(codigo, /\d{3}\.\d{3}\.\d{3}-\d{2}/, `${arquivo}: sem CPF`);
    assert.doesNotMatch(codigo, /localStorage|sessionStorage/, `${arquivo}: nada gravado no navegador`);
  }
  assert.doesNotMatch(lerPasta("consulta.ts") + lerPasta("acoes.ts") + lerPasta("agendamento.ts"), /from "\.\.\/\.\.\/api"[^;]*fetch/);
  assert.match(lerPasta("consulta.ts"), /import \{ apiFetch, type ApiFetchError, type ApiFetchOptions \} from "\.\.\/\.\.\/api";/);
});

test("regras-puro.ts não importa nada e nenhum arquivo do painel importa CSS", () => {
  assert.doesNotMatch(lerPasta("regras-puro.ts"), /^\s*import\s/m);
  for (const arquivo of fs.readdirSync(pasta)) assert.doesNotMatch(lerPasta(arquivo), /import\s+["'][^"']+\.css["']/, arquivo);
});

// ---- Markup: o HTML é só o ponto de montagem; o TSX desenha os cartões com os mesmos IDs, rótulos e ARIA ----
const HOSTS = [
  ["aviso", /<section id="automacao-aviso-login" class="ck-aviso ck-aviso--alerta automation-login-alert" role="alert" aria-labelledby="automacao-aviso-login-titulo" data-automacao-regiao="aviso" data-react-painel="chrome-automation" hidden><\/section>/],
  ["chrome", /<section class="ck-cartao ck-chrome" aria-labelledby="automacao-titulo" data-automacao-regiao="chrome"><\/section>/],
  ["rotinas", /<section aria-labelledby="ck-rotinas-titulo" data-automacao-regiao="rotinas"><\/section>/],
  ["historico", /<section class="ck-cartao" id="automacao-historico-painel" aria-labelledby="automacao-historico-titulo" data-automacao-regiao="historico"><\/section>/],
  ["console", /<section class="ck-console" id="automacao-andamento-painel" aria-labelledby="automacao-andamento-titulo" data-automacao-regiao="console"><\/section>/],
  ["dialogo", /<div class="ck-veu" id="ck-dialogo-log" data-automacao-regiao="dialogo" hidden><\/div>/],
];

test("o HTML montado traz só os seis pontos de montagem do React; o conteúdo da aba sai do HTML", () => {
  for (const [regiao, padrao] of HOSTS) assert.match(html, padrao, `host ${regiao}`);
  assert.equal(html.split('data-react-painel="chrome-automation"').length - 1, 1, "main.tsx monta pelo primeiro host");
  assert.equal(html.split("data-automacao-regiao=").length - 1, 6);
  const aba = html.match(/<section id="tab-panel-automacao"[\s\S]*?\n    <\/section>/)?.[0];
  assert.ok(aba);
  for (const id of [
    "automacao-estado", "automacao-ver-backups", "btn-automacao-login", "btn-automacao-os", "btn-automacao-inventarios", "btn-automacao-usuarios",
    "btn-automacao-ambas", "btn-automacao-cancelar", "automacao-historico", "automacao-historico-filtros", "cockpit-automation-events", "automacao-log",
    "btn-log-completo", "automacao-log-modo", "ck-rotina-os-titulo", "ck-verificacao-titulo",
  ]) assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} é desenhado pelo React`);
  assert.doesNotMatch(html, /data-rotina-badge/, "os selos dentro da aba são estado do React");
  assert.doesNotMatch(html, /class="ck-rotinas"/);
  assert.doesNotMatch(html, /ck-linha-acao/);
});

test("o console continua filho direto de #automacao-cards (o CSS do console depende disso) e o cartão Sebrae fica entre as regiões", () => {
  const cards = html.slice(html.indexOf('id="automacao-cards"'), html.indexOf('id="ck-dialogo-log"'));
  const posicoes = ["data-automacao-regiao=\"historico\"", 'id="sebrae-novos-painel"', 'data-automacao-regiao="console"'].map(trecho => cards.indexOf(trecho));
  assert.ok(posicoes.every(posicao => posicao > 0), "historico, cartão Sebrae e console dentro de #automacao-cards");
  assert.match(cockpitCss, /#automacao-cards > #automacao-andamento-painel\.ck-console/);
});

test("o TSX desenha as quatro rotinas na ordem, com ícone, rótulo acessível, ARIA e os ids do HTML antigo", () => {
  const componentes = lerPasta("componentes.tsx");
  const ordem = ["os", "inventarios", "usuarios", "ambas"].map(id => componentes.indexOf(`{ id: "${id}"`));
  assert.ok(ordem.every(posicao => posicao > 0));
  assert.deepEqual(ordem, [...ordem].sort((x, y) => x - y), "os, inventarios, usuarios, ambas");
  assert.match(componentes, /data-on-click="iniciarRotinaAutomacao" data-args=\{args\(cartao\.id\)\}/);
  assert.match(componentes, /id=\{`btn-automacao-\$\{cartao\.id\}`\} data-automacao-rotina=\{cartao\.id\}/);
  assert.match(componentes, /ck-btn--sm ck-btn--icone/);
  assert.match(componentes, /aria-label=\{e\.botoesProntos \? `\$\{rotulo\} \$\{cartao\.nome\}` : `Executar \$\{cartao\.nome\}`\}/);
  assert.match(componentes, /<span className="ck-sr">\{e\.botoesProntos \? rotulo : "Executar"\}<\/span>/);
  assert.match(componentes, /className="ck-cartao ck-rotina" data-rotina=\{cartao\.id\}/);
  assert.match(componentes, /<div className="ck-rotinas" role="group" aria-label="Rotinas principais">/);
  assert.match(componentes, /icone: "i-users", nome: "Verificar usuários", idTitulo: "ck-verificacao-titulo"/);
  assert.match(componentes, /id="btn-automacao-login" data-automacao-rotina="login"/);
  assert.match(componentes, /id="btn-automacao-cancelar"/);
  assert.match(componentes, /data-on-click="cancelarRotinaAutomacao"/);
  const ids = [
    "automacao-aviso-login-titulo", "automacao-aviso-login-texto", "automacao-titulo", "automacao-estado", "automacao-estado-titulo",
    "automacao-estado-detalhe", "automacao-ver-backups", "ck-rotinas-titulo", "automacao-historico-titulo", "automacao-historico-resumo",
    "automacao-historico-filtros", "automacao-historico-inicio", "automacao-historico-fim", "automacao-historico-rotina", "automacao-historico-status",
    "automacao-historico", "automacao-historico-limite", "automacao-historico-anterior", "automacao-historico-pagina", "automacao-historico-proxima",
    "automacao-andamento-titulo", "cockpit-automation-live", "automacao-log-modo", "automacao-log-filtros", "automacao-log-data", "automacao-log-execucao",
    "automacao-log-paginas", "automacao-log-anterior", "automacao-log-pagina", "automacao-log-proxima", "automacao-log-limite", "automacao-log-ao-vivo",
    "cockpit-automation-events", "automacao-andamento-conteudo", "btn-log-completo", "ck-dialogo-log-titulo", "automacao-log-arquivo", "automacao-log",
  ];
  for (const id of ids) assert.ok(componentes.includes(`id="${id}"`), `id ausente no TSX: ${id}`);
});

test("Automação mostra o histórico e o console sem painéis recolhíveis e sem sync antigo do Sebrae", () => {
  const codigo = fs.readdirSync(pasta).map(lerPasta).join("\n") + ponteSource;
  assert.doesNotMatch(html + codigo, /Recolher Últimas execuções|Ampliar Andamento/);
  assert.doesNotMatch(codigo, /recolherPainelAutomacao|ampliarPainelAutomacao/);
  assert.doesNotMatch(codigo, /api\/automacao\/sebrae/);
});

test("Os chamados novos do Sebrae ficam na área de Automação e o cartão antigo de sincronização saiu", () => {
  assert.match(html, /id="sebrae-novos-painel"/);
  assert.doesNotMatch(html, /id="sebrae-painel"/);
});

test("Cartão Chamados novos é compacto: Chamados no cabeçalho, automático primário e buscar secundário (F4 Bloco 2)", () => {
  const cartao = html.match(/<section[^>]*id="sebrae-novos-painel"[\s\S]*?\n      <\/section>/)?.[0];
  assert.ok(cartao);
  const cab = cartao.match(/<div class="ck-cartao__cab">[\s\S]*?<\/div>/)[0];
  const corpo = cartao.slice(cartao.indexOf(cab) + cab.length);
  const botao = (texto, id) => texto.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || "";
  const chamados = botao(cab, "btn-sebrae-abrir-chamados");
  assert.match(chamados, /class="ck-btn ck-btn--fantasma ck-btn--sm"/);
  assert.match(chamados, /data-on-click="abrirPainelCockpit"/);
  assert.match(chamados, /data-args='\["sebrae-chamados"\]'/);
  assert.match(cab, /<span>Chamados<\/span><\/button>/);
  assert.doesNotMatch(corpo, /btn-sebrae-abrir-chamados/);
  assert.match(cab, /data-agendamento="ligado"[\s\S]*<span>Agendamento ligado<\/span>/);
  assert.match(cab, /data-agendamento="desligado"[\s\S]*<span>Agendamento desligado<\/span>/);
  assert.match(botao(corpo, "btn-sebrae-automatico"), /class="ck-btn ck-btn--primario ck-btn--sm"/);
  assert.match(botao(corpo, "btn-sebrae-buscar"), /class="ck-btn ck-btn--secundario ck-btn--sm"/);
  assert.match(botao(corpo, "btn-sebrae-importar"), /class="ck-btn ck-btn--secundario ck-btn--sm"/);
  assert.equal((corpo.match(/ck-btn--primario/g) || []).length, 1, "um só botão primário no cartão");
  for (const id of ["sebrae-dashboard-file", "sebrae-dashboard-name", "btn-sebrae-importar", "btn-sebrae-buscar", "btn-sebrae-automatico", "dashboard-agendamento-ativo", "dashboard-agendamento-intervalo", "dashboard-agendamento-status", "sebrae-dashboard-status", "sebrae-novos-resumo", "sebrae-historico-resumo", "sebrae-novos-avisos"]) {
    assert.equal(cartao.split(`id="${id}"`).length - 1, 1, `${id} no cartão`);
  }
  for (const id of ["dashboard-agendamento-status", "sebrae-dashboard-status", "sebrae-novos-resumo"]) {
    assert.match(corpo, new RegExp(`<p id="${id}"[^>]*role="status" aria-live="polite"`), `${id} segue como região de status`);
  }
  assert.match(corpo, /data-vazio="\.xlsx · aba CHAMADOS"/);
  assert.match(cockpitCss, /#sebrae-novos-painel:has\(#dashboard-agendamento-ativo:checked\)/);
});

test("Os botões do Sebrae continuam imperativos: ficam fora das regiões do React e iniciam a rotina pelo mesmo data-on-click", () => {
  for (const [id, rotina] of [["btn-sebrae-buscar", "sebrae"], ["btn-sebrae-automatico", "dashboard"]]) {
    const botao = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(botao, id);
    assert.ok(botao.includes(`data-automacao-rotina="${rotina}"`));
    assert.ok(botao.includes('data-on-click="iniciarRotinaAutomacao"'));
    assert.ok(botao.includes(`data-args='["${rotina}"]'`));
  }
  assert.match(lerPasta("fora.ts"), /querySelectorAll[^\n]*\[data-automacao-rotina\]/);
  assert.match(lerPasta("fora.ts"), /closest\("\[data-automacao-regiao\]"\)/);
});

test("Automation action layout keeps a responsive support group", () => {
  assert.match(styles, /\.automation-action-layout/);
  assert.match(styles, /\.automation-action-support/);
  assert.match(styles, /\.automation-action-independent/);
  assert.match(styles, /@media \(max-width: 40rem\)[\s\S]*?\.automation-action-support/);
});
