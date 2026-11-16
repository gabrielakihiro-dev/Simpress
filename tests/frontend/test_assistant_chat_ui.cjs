// Assistente (F9): chat flutuante. Desde o Dia 3 (G7b, React) o painel vive em frontend/src/paineis/assistant-chat/ e o
// comportamento de tela é testado no navegador (tests/e2e/assistente.spec.cjs, tests/e2e/react-g7b.spec.cjs e
// tests/e2e/react-g7.spec.cjs, todas as rotas /api/assistente/* simuladas). Aqui ficam as regras puras (assistente-puro.ts,
// carregado direto pelo require do Node), a ponte do código antigo (static/js/features/assistant-chat.js), o registro, o HTML
// montado, o prazo e o cancelamento do envio (herdados de test_assistant_endpoint_timeout.cjs) e a privacidade. Dados sintéticos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const createAssistantChat = require("../../static/js/features/assistant-chat.js");

const root = path.resolve(__dirname, "../..");
const pasta = path.join(root, "frontend/src/paineis/assistant-chat");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");
const lerPasta = nome => fs.readFileSync(path.join(pasta, nome), "utf8");
const regras = require(path.join(pasta, "assistente-puro.ts"));
const {
  LIMITE, PRAZO_ENVIO_MS, LIMITE_ANEXO_BYTES, TAXA_WAV, LIMITE_SEGUNDOS, LIMITE_CONTEXTO_UX, DESLIGADO, MSG_PRAZO, MSG_CANCELADO,
  MSG_CONVERSA_OCUPADA, MSG_FALHA_ENVIO, tamanhoLegivel, dataBrasileira, metaLembrete, metaAnexo, tituloConversa, metaConversa,
  contador, resumirFerramentas, arquivosValidos, buscasValidas, contextoUX, mensagemDeAborto, resultadoErroEnvio, textoDevolvido,
  textoStatusPronto, rotuloGravacao, estadoDoGlobo, paraWav,
} = regras;

const NOMES_PONTE = [
  "carregarAssistente", "alternarAssistente", "minimizarAssistente", "maximizarAssistente", "voltarConversaAssistente",
  "enviarMensagemAssistente", "confirmarPendenteAssistente", "cancelarPendenteAssistente", "cancelarEnvioAssistente",
  "novaConversaAssistente", "contarMensagemAssistente", "preencherAtalhoAssistente", "teclaAssistente", "alternarGravacaoAssistente", "alternarVozAssistente",
  "alternarInstrucoesAssistente", "alternarBuscaWebAssistente", "contarInstrucoesAssistente", "salvarInstrucoesAssistente", "limparInstrucoesAssistente",
  "anexarArquivoAssistente", "removerAnexoAssistente",
  "alternarHistoricoAssistente", "abrirConversaHistoricoAssistente", "abrirConversaLateralAssistente", "fecharConversaHistoricoAssistente",
  "exportarPdfHistoricoAssistente", "pedirApagarConversaHistoricoAssistente", "cancelarApagarConversaHistoricoAssistente", "apagarConversaHistoricoAssistente",
  "alternarLembretesAssistente", "marcarLembreteAssistente", "pedirApagarLembreteAssistente", "cancelarApagarLembreteAssistente", "apagarLembreteAssistente",
];

// ---- Prazo e cancelamento do envio (herdado de test_assistant_endpoint_timeout.cjs) ----
test("prazo: o navegador espera 600000 ms (Endpoint + modelo) antes de abortar o envio", () => {
  assert.equal(PRAZO_ENVIO_MS, 600000);
  assert.match(lerPasta("estado.ts"), /setTimeout\(\(\) => \{ envio\.motivo = "prazo"; envio\.controle\.abort\(\); \}, PRAZO_ENVIO_MS\);/);
});

test("prazo: o motivo 'prazo' mostra o texto do prazo e qualquer outro motivo mostra o do cancelamento manual", () => {
  assert.equal(mensagemDeAborto("prazo"), MSG_PRAZO);
  assert.match(MSG_PRAZO, /demorou demais/);
  assert.equal(mensagemDeAborto("cancelado"), MSG_CANCELADO);
  assert.match(MSG_CANCELADO, /Envio cancelado/);
  assert.equal(mensagemDeAborto(""), MSG_CANCELADO);
});

test("prazo: abortar no prazo ou cancelar à mão usa o texto certo, não deixa ligar de novo e devolve o texto ao campo", () => {
  const abortado = { name: "AbortError", message: "aborted" };
  assert.deepEqual({ ...resultadoErroEnvio(abortado, "prazo") }, { texto: MSG_PRAZO, offline: false, oferecerNovamente: false });
  assert.deepEqual({ ...resultadoErroEnvio(abortado, "cancelado") }, { texto: MSG_CANCELADO, offline: false, oferecerNovamente: false });
  // O texto digitado volta ao campo só se ele continua vazio (nunca sobrescreve o que a pessoa escreveu depois).
  assert.equal(textoDevolvido("Consulte ABC no Endpoint", ""), "Consulte ABC no Endpoint");
  assert.equal(textoDevolvido("Consulte ABC no Endpoint", "outra coisa"), null);
  assert.equal(textoDevolvido("", ""), null);
});

test("prazo: o cronômetro é desfeito no finally (resposta, cancelamento e prazo) e o cancelamento manual segue possível", () => {
  const estado = lerPasta("estado.ts");
  const inicio = estado.indexOf("async function enviarAoAssistente(");
  const fim = estado.indexOf("function cancelarEnvioAssistente(");
  assert.ok(inicio > 0 && fim > inicio, "enviarAoAssistente não achado");
  const corpo = estado.slice(inicio, fim);
  assert.match(corpo, /const prazo = setTimeout\(/);
  assert.ok(corpo.indexOf("clearTimeout(prazo)") > corpo.indexOf("} finally {"), "clearTimeout(prazo) fica no finally");
  assert.match(corpo, /signal: envio\.controle\.signal/);
  assert.match(corpo, /resultadoErroEnvio\(e as ErroApi, envio\.motivo\)/);
  assert.match(corpo, /textoDevolvido\(textoParaDevolver, campo\.value\)/);
  assert.match(estado, /envioAtual\.motivo = "cancelado";\s+envioAtual\.controle\.abort\(\);/);
});

test("erro de envio: conversa ocupada (409), servidor sem IA (503, oferece tentar de novo) e falha comum", () => {
  assert.deepEqual({ ...resultadoErroEnvio({ status: 409 }, "") }, { texto: MSG_CONVERSA_OCUPADA, offline: false, oferecerNovamente: false });
  assert.deepEqual({ ...resultadoErroEnvio({ status: 503, message: "Sem chave." }, "") }, { texto: "Sem chave.", offline: true, oferecerNovamente: true });
  assert.deepEqual({ ...resultadoErroEnvio({ status: 500 }, "") }, { texto: MSG_FALHA_ENVIO, offline: false, oferecerNovamente: false });
  assert.deepEqual({ ...resultadoErroEnvio(null, "") }, { texto: MSG_FALHA_ENVIO, offline: false, oferecerNovamente: false });
});

// ---- Regras puras ----
test("regras: limites, textos aprovados e formatos", () => {
  assert.equal(LIMITE, 4000);
  assert.equal(LIMITE_ANEXO_BYTES, 10 * 1024 * 1024);
  assert.equal(TAXA_WAV, 16000);
  assert.equal(LIMITE_SEGUNDOS, 120);
  assert.equal(LIMITE_CONTEXTO_UX, 8000);
  assert.equal(DESLIGADO, "Assistente desligado. Configure a chave em Prontidão da base > Configuração local.");
  assert.equal(contador(12), "12 / 4000");
  assert.equal(textoStatusPronto("modelo-teste"), "Assistente pronto · modelo-teste");
  assert.equal(textoStatusPronto(""), "Assistente pronto.");
  assert.equal(rotuloGravacao(true, false, 75), "Parar (1:15)");
  assert.equal(rotuloGravacao(false, true, 0), "Transcrevendo…");
  assert.equal(rotuloGravacao(false, false, 0), "Gravar áudio");
  assert.equal(estadoDoGlobo({ gravando: true, ocupado: true, transcrevendo: false, falando: false }), "ouvindo");
  assert.equal(estadoDoGlobo({ gravando: false, ocupado: true, transcrevendo: false, falando: true }), "pensando");
  assert.equal(estadoDoGlobo({ gravando: false, ocupado: false, transcrevendo: false, falando: true }), "falando");
  assert.equal(estadoDoGlobo({ gravando: false, ocupado: false, transcrevendo: false, falando: false }), "parado");
});

test("regras: tamanhos, datas e rótulos de anexo, lembrete e conversa", () => {
  assert.equal(tamanhoLegivel(1), "1 KB");
  assert.equal(tamanhoLegivel(2048), "2 KB");
  assert.equal(tamanhoLegivel(1572864), "1,5 MB");
  assert.equal(dataBrasileira("2026-11-15T10:30:00"), "15/11/2026");
  assert.equal(dataBrasileira("sem-data"), "sem-data");
  assert.equal(metaAnexo({ tipo: "pdf", tamanho: 2048, paginas: 3 }), "PDF · 2 KB · 3 páginas de texto");
  assert.equal(metaAnexo({ tipo: "imagem", tamanho: 2048, paginas: 3 }), "Imagem · 2 KB");
  assert.equal(metaAnexo({ tipo: "x", tamanho: 0 }), "Arquivo · 1 KB");
  assert.equal(
    metaLembrete({ id: "1", prazo: "2026-11-10", criada_em: "2026-11-01T08:00:00" }, "2026-11-15"),
    "Prazo 10/11/2026 (vencido) · Criado em 01/11/2026",
  );
  assert.equal(metaLembrete({ id: "1", prazo: "2026-11-10", concluida: true }, "2026-11-15"), "Prazo 10/11/2026 · Concluído");
  assert.equal(metaLembrete({ id: "1" }, "2026-11-15"), "");
  assert.equal(tituloConversa({}), "Conversa sem título");
  assert.equal(tituloConversa({ titulo: "Série teste" }), "Série teste");
  assert.equal(metaConversa({ id: "c1", atualizada_em: "2026-11-15T10:30:00", mensagens: 4 }), "15/11/2026 10:30 · 4 mensagens");
  assert.equal(metaConversa({ id: "c1" }), "0 mensagens");
});

test("regras: ferramentas usadas: lista simples até duas, contagem com ×n acima disso", () => {
  assert.equal(resumirFerramentas(["consultar_endpoint"]), "Ferramentas: consultar_endpoint");
  assert.equal(resumirFerramentas(["a", "b"]), "Ferramentas: a, b");
  assert.equal(resumirFerramentas(["a", "b", "a"]), "Ferramentas (3 chamadas): a ×2, b");
});

test("regras: relatórios gerados só viram link com id de 16 hexadecimais e nome", () => {
  const validos = arquivosValidos([
    { id: "0123456789abcdef", nome: " relatorio.xlsx ", tamanho: 2048 },
    { id: "0123456789abcdef", nome: "sem-tamanho.pdf" },
    { id: "../../etc/passwd", nome: "mau.pdf", tamanho: 1 },
    { id: "0123456789abcdef", nome: "  " },
    { id: "ZZZZ", nome: "curto.pdf" },
  ]);
  assert.deepEqual(validos.map(arquivo => ({ ...arquivo })), [
    { id: "0123456789abcdef", nome: "relatorio.xlsx", titulo: "relatorio.xlsx (2 KB)" },
    { id: "0123456789abcdef", nome: "sem-tamanho.pdf", titulo: "" },
  ]);
});

test("regras: busca na web: só http e https viram link; o resto vira texto sem href", () => {
  const buscas = buscasValidas([
    {
      consulta: "tema genérico",
      resumo: " Resumo da busca. ",
      fontes: [
        { titulo: "Página A", dominio: "a.exemplo.test", url: "https://a.exemplo.test/x" },
        { titulo: "", dominio: "b.exemplo.test", url: "javascript:alert(1)" },
        { titulo: "", dominio: "", url: "HTTP://c.exemplo.test" },
        { titulo: "", dominio: "", url: "data:text/html,x" },
      ],
    },
    { consulta: "vazia", resumo: "", fontes: [] },
  ]);
  assert.equal(buscas.length, 1);
  assert.equal(buscas[0].titulo, "Fonte externa · busca na web: tema genérico");
  assert.equal(buscas[0].resumo, "Resumo da busca.");
  assert.deepEqual(buscas[0].fontes.map(fonte => ({ ...fonte })), [
    { texto: "Página A", href: "https://a.exemplo.test/x", dominio: "a.exemplo.test" },
    { texto: "b.exemplo.test", href: "", dominio: "b.exemplo.test" },
    { texto: "HTTP://c.exemplo.test", href: "HTTP://c.exemplo.test", dominio: "" },
    { texto: "Fonte sem link", href: "", dominio: "" },
  ]);
});

test("regras: o contexto do chamado UX só vai com série e descrição de até 8000 caracteres", () => {
  const contexto = { serial: "SERIE-TESTE", descricao: "x" };
  assert.deepEqual({ ...contextoUX(contexto) }, { contexto_ux: contexto });
  assert.deepEqual({ ...contextoUX({ serial: "", descricao: "x" }) }, {});
  assert.deepEqual({ ...contextoUX({ serial: "SERIE-TESTE", descricao: "x".repeat(LIMITE_CONTEXTO_UX + 1) }) }, {});
  assert.deepEqual({ ...contextoUX(null) }, {});
});

test("regras: a gravação sai em WAV PCM de 16 bits, 16 kHz, mono", () => {
  const wav = paraWav([0, 1, -1, 2]);
  const dados = new DataView(wav);
  const texto = (inicio, fim) => String.fromCharCode(...new Uint8Array(wav, inicio, fim - inicio));
  assert.equal(wav.byteLength, 44 + 4 * 2);
  assert.equal(texto(0, 4), "RIFF");
  assert.equal(texto(8, 16), "WAVEfmt ");
  assert.equal(texto(36, 40), "data");
  assert.equal(dados.getUint32(4, true), 36 + 8);
  assert.equal(dados.getUint16(20, true), 1);
  assert.equal(dados.getUint16(22, true), 1);
  assert.equal(dados.getUint32(24, true), 16000);
  assert.equal(dados.getUint32(28, true), 32000);
  assert.equal(dados.getUint16(34, true), 16);
  assert.equal(dados.getUint32(40, true), 8);
  assert.equal(dados.getInt16(46, true), 0x7fff);
  assert.equal(dados.getInt16(48, true), -0x7fff);
  // Acima do limite a amostra é cortada, nunca dá a volta.
  assert.equal(dados.getInt16(50, true), 0x7fff);
});

// ---- Cópia de rascunho ----
test("Copiar texto usa navigator.clipboard.writeText e, se falhar, o textarea com execCommand('copy')", () => {
  const estado = lerPasta("estado.ts");
  assert.match(estado, /await navigator\.clipboard\.writeText\(texto\);/);
  assert.match(estado, /document\.execCommand\("copy"\)/);
  assert.match(estado, /campo\.remove\(\)/);
  assert.match(lerPasta("mensagens.tsx"), /onClick=\{\(\) => void copiarResposta\(mensagem\.texto\)\}/);
});

// ---- Ponte do código antigo ----
function ponteFalsa(acao) {
  const chamadas = [];
  const feature = createAssistantChat({
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

test("registro: assistant-chat.js é a ponte do painel React assistant-chat e continua no app-entry e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\/js\/features\/assistant-chat\.js";/);
  assert.match(appSource, /"assistantChat",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
  assert.match(lerPasta("montar.tsx"), /return \{ \.\.\.acoes \};/);
  assert.match(lerPasta("montar.tsx"), /flushSync\(\(\) => root\.render\(<Painel \/>\)\);\s+iniciar\(container\);/);
  const estado = lerPasta("estado.ts");
  const acoes = estado.slice(estado.indexOf("export const acoes = {"));
  for (const nome of NOMES_PONTE) assert.match(acoes, new RegExp(`\\b${nome}\\b`), `${nome} falta em acoes (estado.ts)`);
});

test("ponte: os 35 nomes continuam publicados e repassam ao painel React assistant-chat com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome; });
  assert.equal(NOMES_PONTE.length, 35);
  assert.deepEqual(chamadas, [["assistant-chat", NOMES_PONTE]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PONTE);
  await feature.preencherAtalhoAssistente("Qual o andamento do chamado ");
  await feature.abrirConversaLateralAssistente("c1");
  await feature.alternarAssistente();
  assert.deepEqual(chamadasReact, [
    ["preencherAtalhoAssistente", ["Qual o andamento do chamado "]],
    ["abrirConversaLateralAssistente", ["c1"]],
    ["alternarAssistente", []],
  ]);
});

test("ponte: teclaAssistente continua publicada (F9 e #btn-assistente chamam alternarAssistente)", async () => {
  const chamadasReact = [];
  const { feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); });
  const evento = { key: "Escape" };
  await feature.teclaAssistente(evento);
  assert.deepEqual(chamadasReact, [["teclaAssistente", [evento]]]);
  assert.equal(typeof feature.alternarAssistente, "function");
});

test("ponte: se o React não carregou, a ação não rejeita (quem chama, como data-on-*, não trata erro)", async () => {
  const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "assistant-chat" não carregou.')));
  await semConsole(async () => {
    for (const nome of NOMES_PONTE) assert.equal(await feature[nome](), undefined, nome);
  });
});

// ---- Markup: o HTML é só o ponto de montagem; o TSX desenha o painel com os mesmos IDs, rótulos e ARIA ----
test("o HTML montado traz só a <section> vazia do React; o Esc e o Enter são do listener nativo, não do data-on-keydown", () => {
  assert.match(
    html,
    /<section id="assistente-widget" class="ck-assist ck-assist-widget" role="dialog" aria-modal="false" aria-labelledby="assistente-heading" data-react-painel="assistant-chat" hidden><\/section>/,
  );
  assert.equal(html.split('id="assistente-widget"').length - 1, 1);
  assert.equal(html.split('data-react-painel="assistant-chat"').length - 1, 1);
  assert.doesNotMatch(html, /teclaAssistente/);
  assert.doesNotMatch(html, /id="assistente-(mensagens|texto|form|enviar|pendente|confirmar|instrucoes|lembretes|historico|globo)/, "os IDs do chat são desenhados pelo React");
  assert.match(lerPasta("estado.ts"), /addEventListener\("keydown", teclaAssistente\)/);
});

test("o botão #btn-assistente e os atalhos continuam chamando as ações publicadas", () => {
  assert.match(html, /id="btn-assistente"[^>]*data-on-click="alternarAssistente"/);
});

test("o TSX do painel mantém os rótulos aprovados e todos os IDs do chat antigo", () => {
  const codigo = ["painel.tsx", "areas.tsx", "mensagens.tsx", "formulario.tsx", "comuns.tsx"].map(lerPasta).join("\n");
  for (const rotulo of [
    "Assistente", "Histórico de conversas", "Minimizar Assistente", "Maximizar Assistente", "Fechar Assistente", "Nova conversa",
    "Tentar novamente", "Instruções permanentes", "Lembretes e notas", "Nenhum lembrete guardado.", "Nenhuma conversa guardada.",
    "Olá! Como posso ajudar?", "Escolha um atalho ou escreva sua pergunta.", "Confirmação necessária", "Confirmar e executar",
    "Copiar texto", "Voltar à conversa", "Digite sua pergunta…", "Enter envia; Shift+Enter quebra a linha.", "Exportar PDF",
    "Atenção: imagens vão ao OpenRouter sem ocultar dados pessoais (CPF, nome, e-mail). Anexe só o que pode sair deste computador.",
  ]) assert.ok(codigo.includes(rotulo), `rótulo aprovado ausente: ${rotulo}`);
  const ids = [
    "assistente-globo", "assistente-heading", "assistente-historico-botao", "assistente-minimizar", "assistente-maximizar", "assistente-fechar",
    "assistente-status", "assistente-cancelar-envio", "assistente-tentar", "assistente-nova", "assistente-lateral-conversas",
    "assistente-lateral-conversas-lista", "assistente-lateral-conversas-vazio", "assistente-voz", "assistente-instrucoes-botao",
    "assistente-lembretes-botao", "assistente-instrucoes", "assistente-instrucoes-titulo", "assistente-instrucoes-texto",
    "assistente-instrucoes-contador", "assistente-instrucoes-limpar", "assistente-instrucoes-salvar", "assistente-instrucoes-status",
    "assistente-busca-web", "assistente-busca-web-aviso", "assistente-busca-web-status", "assistente-lembretes", "assistente-lembretes-titulo",
    "assistente-lembretes-lista", "assistente-lembretes-vazio", "assistente-lembretes-status", "assistente-historico",
    "assistente-historico-voltar", "assistente-historico-titulo", "assistente-historico-lista", "assistente-historico-vazio",
    "assistente-historico-lista-voltar", "assistente-historico-exportar", "assistente-historico-leitura", "assistente-historico-status",
    "assistente-mensagens", "assistente-anuncio", "assistente-pendente", "assistente-pendente-titulo", "assistente-pendente-descricao",
    "assistente-confirmar", "assistente-cancelar", "assistente-form", "assistente-anexo-arquivo", "assistente-anexos", "assistente-anexos-aviso",
    "assistente-anexos-status", "assistente-anexar", "assistente-texto", "assistente-gravar", "assistente-gravar-rotulo", "assistente-enviar",
    "assistente-contador", "assistente-texto-dica", "assistente-anexar-dica", "assistente-gravar-dica",
  ];
  for (const id of ids) assert.ok(codigo.includes(`id="${id}"`), `id ausente no TSX: ${id}`);
  // Textos do usuário e do Assistente entram como texto do React, nunca como HTML.
  assert.doesNotMatch(codigo, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
  // Os manipuladores são do React: nada de data-on-* (o despachante do documento dispararia duas vezes).
  assert.doesNotMatch(codigo, /data-on-|data-click-target|data-args/);
  assert.match(lerPasta("formulario.tsx"), /id="assistente-texto"[^>]*maxLength=\{4000\}/);
  assert.match(lerPasta("areas.tsx"), /id="assistente-instrucoes-texto"[^>]*maxLength=\{4000\}/);
});

test("o envio de ação pendente só sai pelos botões do cartão, que travam enquanto uma resposta está em andamento", () => {
  const mensagens = lerPasta("mensagens.tsx");
  assert.match(mensagens, /id="assistente-confirmar"[^>]*disabled=\{e\.decidirDesabilitado\} onClick=\{\(\) => void acoes\.confirmarPendenteAssistente\(\)\}/);
  assert.match(mensagens, /id="assistente-cancelar"[^>]*aria-keyshortcuts="Escape" disabled=\{e\.decidirDesabilitado\} onClick=\{\(\) => void acoes\.cancelarPendenteAssistente\(\)\}/);
  const estado = lerPasta("estado.ts");
  assert.match(estado, /if \(!pendente \|\| ocupado\) return;/);
  assert.match(estado, /\{ confirmado, \.\.\.contextoUXLocal\(\) \}/);
});

// ---- Privacidade ----
test("nenhum arquivo do painel nem a ponte traz e-mail corporativo, nome completo seguido de ';' ou fetch cru", () => {
  const arquivos = [...fs.readdirSync(pasta).map(nome => path.join(pasta, nome)), path.join(root, "static/js/features/assistant-chat.js")];
  assert.ok(arquivos.length >= 8);
  for (const arquivo of arquivos) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    assert.doesNotMatch(codigo, /@simpress\.com\.br|@pr\.sebrae\.com\.br/i, arquivo);
    assert.doesNotMatch(codigo, /[A-ZÀ-Ý][a-zà-ÿ]+ [A-ZÀ-Ý][a-zà-ÿ]+;/u, arquivo);
    assert.doesNotMatch(codigo, /(?<![A-Za-z.])fetch\(/, `${arquivo}: chamada de API só por apiFetch`);
  }
  assert.match(lerPasta("estado.ts"), /return apiFetch<T>\(url, opcoes\);/);
});
