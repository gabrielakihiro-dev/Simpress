// Transporte (F2): modal "Gerar ticket no UX". Desde o Dia 3 (G7, React) o modal vive em frontend/src/paineis/ux-ticket/
// e o comportamento de tela é testado no navegador (tests/e2e/ux-ticket.spec.cjs e tests/e2e/react-g7.spec.cjs, todas as
// rotas /api/ux/gerar-ticket/* simuladas). Aqui ficam as regras puras (regras-puro.ts, carregado direto pelo require do
// Node), a ponte do código antigo (static/js/features/ux-ticket.js), o registro, o HTML montado, a barra do Transporte e a
// privacidade (nenhum e-mail corporativo no JS nem no TSX). Dados sintéticos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const createUxTicket = require("../../static/js/features/ux-ticket.js");

const root = path.resolve(__dirname, "../..");
const pasta = path.join(root, "frontend/src/paineis/ux-ticket");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "static/app-entry.js"), "utf8");
const lerPasta = nome => fs.readFileSync(path.join(pasta, nome), "utf8");
const regras = require(path.join(pasta, "regras-puro.ts"));
const {
  PLACEHOLDER, REGISTRO_MAX, INTERNO_MAX, ATUALIZACAO, ENDERECO, motivoBloqueio, textoConfirmacao, rotuloCancelar, cepDaEntrega,
  cepTemOitoDigitos, mesclarSolicitante, preencherVazio, textoUltimoEnvio, valorOuTraco,
} = regras;

const REGISTRO_OK = "Prezados,\nContato no local: Maria Teste\nColaborador(a) Novo(a): Fulano\nData de Instalação: 10/11/2026\nHorário da Instalação: 09h";
const TEXTO_ENDERECO = ["Prezados,", "", "Solicito alteração do endereço do equipamento da Unidade de Curitiba/PR para Maringá/PR."].join("\n");

// Entrada que libera Simular e Finalizar; cada teste muda só o campo em exame.
const entrada = (parcial = {}) => ({
  existe: true, enviando: false, ocupado: false, temSessao: true, concluido: false, ehEndereco: false, temEnderecoEscolhido: true,
  registro: REGISTRO_OK, nome: "Pessoa Teste", email: "pessoa@exemplo.com", telefone: "(41) 90000-0000", chamadoInterno: "", ...parcial,
});

test("regras: o tipo do ticket e os limites são os do backend", () => {
  assert.equal(ATUALIZACAO, "atualizacao");
  assert.equal(ENDERECO, "endereco");
  assert.equal(REGISTRO_MAX, 2500);
  assert.equal(INTERNO_MAX, 10);
});

test("regras: PLACEHOLDER é igual ao de domains/ux_chamados.py", () => {
  const python = fs.readFileSync(path.join(root, "domains/ux_chamados.py"), "utf8");
  const origem = python.match(/^PLACEHOLDER = re\.compile\(r"(.+)", re\.MULTILINE\)$/m);
  assert.ok(origem, "PLACEHOLDER não achado em domains/ux_chamados.py");
  assert.equal(PLACEHOLDER.source, origem[1]);
  assert.equal(PLACEHOLDER.flags, "m");
});

test("regras: sem pedido, enviando e ocupado explicam por que Simular e Finalizar ficam travados", () => {
  assert.equal(motivoBloqueio(entrada({ existe: false })), "Use Transporte ou Alterar Endereço para preparar o ticket.");
  assert.equal(motivoBloqueio(entrada({ enviando: true, ocupado: true })), "Envio em andamento: aguarde o resultado do UX.");
  // Ocupado sem envio: o próprio andamento trava os botões, sem mensagem.
  assert.equal(motivoBloqueio(entrada({ ocupado: true })), "");
});

test("regras: sem sessão do UX, o motivo é Preparar novamente; sessão usada pede um ticket novo", () => {
  assert.match(motivoBloqueio(entrada({ temSessao: false })), /a sessão do UX não está preparada\. Use Preparar novamente\.$/);
  assert.match(motivoBloqueio(entrada({ temSessao: false, concluido: true })), /^Esta sessão do UX já foi usada\./);
});

test("regras: endereço ambíguo exige escolha e confirmação; Alterar Endereço não tem endereço escolhido", () => {
  assert.match(motivoBloqueio(entrada({ temEnderecoEscolhido: false })), /^Escolha e confirme o endereço/);
  assert.equal(motivoBloqueio(entrada({ temEnderecoEscolhido: false, ehEndereco: true })), "");
});

test("regras: um Registro vazio, longo demais, com linha terminada em ':' ou com [campo] bloqueia com motivo visível", () => {
  assert.equal(motivoBloqueio(entrada({ registro: "   " })), "Preencha o Registro.");
  assert.equal(motivoBloqueio(entrada({ registro: "x".repeat(REGISTRO_MAX + 1) })), "O Registro passa de 2500 caracteres.");
  assert.equal(motivoBloqueio(entrada({ registro: "x".repeat(REGISTRO_MAX) })), "");
  assert.match(motivoBloqueio(entrada({ registro: "Prezados,\nColaborador(a) Novo(a):" })), /terminam com “:”/);
  assert.match(motivoBloqueio(entrada({ registro: "Prezados,\nColaborador(a) Novo(a):   " })), /terminam com “:”/);
  assert.match(motivoBloqueio(entrada({ registro: REGISTRO_OK + "\nObservação: [preencher]" })), /campos entre colchetes/);
  assert.equal(motivoBloqueio(entrada()), "");
  assert.ok(PLACEHOLDER.test("a\nb:"));
  assert.ok(!PLACEHOLDER.test("Contato no local: Maria"));
});

test("regras: o solicitante precisa de nome, e-mail válido e contato; o Nº de chamado interno aceita 10 caracteres", () => {
  for (const campo of ["nome", "email", "telefone"]) {
    assert.equal(motivoBloqueio(entrada({ [campo]: "  " })), "Preencha Nome, E-mail e Contato do solicitante.", campo);
  }
  for (const email of ["sem-arroba", "a@", "@b", "a b@c"]) {
    assert.equal(motivoBloqueio(entrada({ email })), "Informe um E-mail válido para o solicitante.", email);
  }
  assert.equal(motivoBloqueio(entrada({ chamadoInterno: "1".repeat(INTERNO_MAX) })), "");
  assert.equal(motivoBloqueio(entrada({ chamadoInterno: "1".repeat(INTERNO_MAX + 1) })), "O Nº de chamado interno aceita até 10 caracteres.");
  // Alterar Endereço nunca manda o Nº de chamado interno: o campo não bloqueia.
  assert.equal(motivoBloqueio(entrada({ ehEndereco: true, chamadoInterno: "1".repeat(INTERNO_MAX + 1) })), "");
});

test("regras: o cartão de confirmação mostra série, endereço, solicitante, Nº interno e o Registro que será enviado", () => {
  const base = {
    serial: "LENTO", ehEndereco: false, endereco: "Rua Um, 1", nome: "Pessoa Teste", email: "pessoa@exemplo.com", telefone: "(41) 90000-0000",
    chamadoInterno: "", descricao: REGISTRO_OK,
  };
  assert.equal(
    textoConfirmacao(base),
    "Série: LENTO\nEndereço: Rua Um, 1\nSolicitante: Pessoa Teste · pessoa@exemplo.com · (41) 90000-0000\n\n" + REGISTRO_OK,
  );
  assert.match(textoConfirmacao({ ...base, chamadoInterno: "INT-1" }), /\nNº de chamado interno: INT-1\n\n/);
  const endereco = textoConfirmacao({ ...base, ehEndereco: true, descricao: TEXTO_ENDERECO });
  assert.match(endereco, /^Série: LENTO\nIncidente: Transporte · Transferência Fisica de Equipamentos\nSolicitante: /);
  assert.doesNotMatch(endereco, /Endereço: Rua Um/);
  assert.ok(endereco.endsWith("\n\n" + TEXTO_ENDERECO));
});

test("regras: Cancelar enquanto há sessão ou algo cancelável; Fechar depois de enviar ou durante o envio", () => {
  assert.equal(rotuloCancelar(true, false, false), "Cancelar");
  assert.equal(rotuloCancelar(false, true, false), "Cancelar"); // preparando: ainda dá para cancelar
  assert.equal(rotuloCancelar(false, true, true), "Fechar"); // enviando
  assert.equal(rotuloCancelar(false, false, false), "Fechar"); // enviado ou sem sessão
});

test("regras: o CEP da unidade de entrega vem do id escolhido e precisa de 8 dígitos", () => {
  const unidades = [{ id: 7, cep: " 80000-000 " }, { id: 8, cep: "" }, { id: 9 }];
  assert.equal(cepDaEntrega(unidades, "7"), "80000-000");
  assert.equal(cepDaEntrega(unidades, 7), "80000-000");
  assert.equal(cepDaEntrega(unidades, "8"), "");
  assert.equal(cepDaEntrega(unidades, "9"), "");
  assert.equal(cepDaEntrega(unidades, "99"), "");
  assert.equal(cepDaEntrega(null, "7"), "");
  assert.equal(cepTemOitoDigitos("80000-000"), true);
  assert.equal(cepTemOitoDigitos("80000000"), true);
  assert.equal(cepTemOitoDigitos("8000-000"), false);
  assert.equal(cepTemOitoDigitos(""), false);
});

test("regras: o solicitante do servidor ou o padrão só entram em campo vazio, nunca sobre o que o usuário digitou", () => {
  assert.equal(mesclarSolicitante("", "Padrão", "Servidor"), "Servidor");
  assert.equal(mesclarSolicitante("Padrão", "Padrão", "Servidor"), "Servidor");
  assert.equal(mesclarSolicitante("Digitado", "Padrão", "Servidor"), "Digitado");
  assert.equal(mesclarSolicitante("Digitado", "Padrão", undefined), "Digitado");
  assert.equal(mesclarSolicitante("", "Padrão", undefined), "");
  assert.equal(preencherVazio("  ", "Padrão"), "Padrão");
  assert.equal(preencherVazio("Digitado", "Padrão"), "Digitado");
  assert.equal(preencherVazio("", undefined), "");
});

test("regras: aviso do último envio e traço para valor ausente", () => {
  assert.equal(textoUltimoEnvio(null), "");
  assert.equal(textoUltimoEnvio({ ticket: "" }), "");
  assert.match(textoUltimoEnvio({ ticket: "445566", data: "2026-11-10T12:00:00" }), /^Atenção: já há um ticket enviado para esta série \(nº 445566 em \d{2}\/\d{2}\/2026\)\. Confira no UX antes de prosseguir\.$/);
  assert.equal(textoUltimoEnvio({ ticket: "445566", data: "sem data" }), "Atenção: já há um ticket enviado para esta série (nº 445566). Confira no UX antes de prosseguir.");
  assert.equal(valorOuTraco(""), "—");
  assert.equal(valorOuTraco(undefined), "—");
  assert.equal(valorOuTraco("Modelo X"), "Modelo X");
});

// ---- Ponte do código antigo ----
const NOMES_PONTE = [
  "fecharTicketUX", "atualizarTicketUX", "prepararNovamenteTicketUX", "conferirTicketUX", "confirmarEnderecoTicketUX",
  "executarTicketUX", "alterarEnderecoTicketUX", "prepararTicketUX",
];
const NOMES_PUBLICOS = NOMES_PONTE.filter(nome => nome !== "prepararTicketUX");

// document falso só durante a criação: o módulo registra o ouvinte de simpress:transfer-generated.
function ponteFalsa(acao) {
  const chamadas = [];
  const ouvintes = {};
  const anterior = global.document;
  global.document = { addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; } };
  try {
    const feature = createUxTicket({
      ponteReact(painel, nomes) {
        chamadas.push([painel, nomes]);
        return Object.fromEntries(nomes.map(nome => [nome, (...args) => acao(nome, ...args)]));
      },
    });
    return { chamadas, feature, ouvintes };
  } finally {
    global.document = anterior;
  }
}

const esperar = () => new Promise(resolve => setImmediate(resolve));

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

test("registro: ux-ticket.js é a ponte do painel React ux-ticket e continua no app-entry e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\/js\/features\/ux-ticket\.js";/);
  assert.match(appSource, /"uxTicket",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
  for (const nome of NOMES_PONTE) assert.match(lerPasta("montar.tsx"), new RegExp(`\\b${nome}\\b`), `${nome} falta no retorno de montar()`);
});

test("ponte: os sete nomes públicos continuam publicados e repassam ao painel React ux-ticket com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome; });
  assert.deepEqual(chamadas, [["ux-ticket", NOMES_PONTE]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PUBLICOS);
  await feature.executarTicketUX(false);
  await feature.executarTicketUX(true);
  await feature.fecharTicketUX();
  assert.deepEqual(chamadasReact, [["executarTicketUX", [false]], ["executarTicketUX", [true]], ["fecharTicketUX", []]]);
});

test("ponte: se o React não carregou, a ação não rejeita (quem chama, como data-on-*, não trata erro)", async () => {
  const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "ux-ticket" não carregou.')));
  await semConsole(async () => {
    for (const nome of NOMES_PUBLICOS) assert.equal(await feature[nome](), undefined, nome);
  });
});

test("o download nunca depende do ticket: o ouvinte de simpress:transfer-generated é síncrono e engole qualquer falha", async () => {
  const payload = { serial: "LENTO", entrega_contato: "Maria Teste" };
  const recebidas = [];
  const certo = ponteFalsa(async (nome, ...args) => { recebidas.push([nome, args]); });
  assert.deepEqual(Object.keys(certo.ouvintes), ["simpress:transfer-generated"]);
  certo.ouvintes["simpress:transfer-generated"]({ detail: { payload } });
  await esperar();
  assert.deepEqual(recebidas, [["prepararTicketUX", [payload]]]);

  // Evento sem payload: segue para o React, que ignora sem série (o modal não abre).
  certo.ouvintes["simpress:transfer-generated"]({});
  await esperar();
  assert.deepEqual(recebidas.at(-1), ["prepararTicketUX", [undefined]]);

  await semConsole(async () => {
    const rejeita = ponteFalsa(() => Promise.reject(new Error("React ausente")));
    assert.doesNotThrow(() => rejeita.ouvintes["simpress:transfer-generated"]({ detail: { payload } }));
    const lanca = ponteFalsa(() => { throw new Error("falha síncrona"); });
    assert.doesNotThrow(() => lanca.ouvintes["simpress:transfer-generated"]({ detail: { payload } }));
    assert.doesNotThrow(() => lanca.ouvintes["simpress:transfer-generated"]({}));
    await esperar();
  });
});

test("o Esc do modal (data-close-function) aponta para uma ação publicada pela ponte", () => {
  const estado = lerPasta("estado.ts");
  const nomes = [...estado.matchAll(/abrirModalAcessivel\(MODAL, "[^"]+", "([^"]+)"\)/g)].map(match => match[1]);
  assert.deepEqual(nomes, ["fecharTicketUX"]);
  assert.ok(NOMES_PUBLICOS.includes("fecharTicketUX"));
  assert.match(estado, /const MODAL = "modal-ticket-ux";/);
});

// ---- Privacidade ----
test("o front-end nunca embute o solicitante padrão: lê GET /solicitante e nenhum arquivo traz e-mail corporativo", () => {
  const arquivos = [...fs.readdirSync(pasta).map(nome => path.join(pasta, nome)), path.join(root, "static/js/features/ux-ticket.js")];
  assert.ok(arquivos.length >= 5);
  for (const arquivo of arquivos) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    assert.doesNotMatch(codigo, /@simpress\.com\.br/, arquivo);
    assert.doesNotMatch(codigo, /(?<![A-Za-z.])fetch\(/, `${arquivo}: chamada de API só por apiFetch`);
  }
  assert.match(lerPasta("estado.ts"), /apiFetch<Solicitante>\(API \+ "\/solicitante"/);
  assert.match(lerPasta("estado.ts"), /const API = "\/api\/ux\/gerar-ticket";/);
});

test("o envio real só sai com enviar e confirmado iguais ao argumento, depois da confirmação, e uma vez por pedido ocupado", () => {
  const estado = lerPasta("estado.ts");
  assert.match(estado, /post<Envio>\("enviar", \{ session_id, serial, descricao, solicitante, chamado_interno, enviar, confirmado: enviar \}\)/);
  assert.match(estado, /if \(!pedido \|\| pedido\.ocupado \|\| derivar\(estado\)\.motivo\) return;/);
  assert.match(estado, /pedido\.ocupado = true; \/\/ antes de qualquer await/);
  assert.ok(estado.indexOf("app().confirmarAcao(") < estado.indexOf('post<Envio>("enviar"'), "a confirmação vem antes do POST");
  assert.match(estado, /if \(enviar && !statusHttp\(erro\)\)/);
  const dialogo = lerPasta("dialogo.tsx");
  assert.match(dialogo, /id="ux-ticket-simular"[^>]*onClick=\{\(\) => void executarTicketUX\(false\)\}/);
  assert.match(dialogo, /id="ux-ticket-finalizar"[^>]*onClick=\{\(\) => void executarTicketUX\(true\)\}/);
});

test("the Registro alert border outranks the generic dialog field border", () => {
  const css = fs.readFileSync(path.join(root, "static", "styles", "ck-cockpit.css"), "utf8");
  // .ck-veu > .ck-dialogo :is(input, select, textarea) is (0,2,1); a bare .ux-ticket-registro[aria-invalid] (0,2,0) loses.
  assert.ok(css.includes('.ck-veu > .ck-dialogo :is(input, select, textarea) {'));
  assert.ok(css.includes('.ck-veu > .ck-dialogo .ux-ticket-registro[aria-invalid="true"] { border-color: var(--cor-alerta-texto); }'));
});

// ---- Markup: o HTML é só o ponto de montagem; o TSX desenha o modal com os mesmos IDs, rótulos e ARIA ----
test("o HTML montado traz só o overlay do React; o modal inteiro sai do HTML", () => {
  assert.match(html, /<div id="modal-ticket-ux" class="modal-overlay ck-veu hidden" aria-labelledby="titulo-ticket-ux" data-react-painel="ux-ticket"><\/div>/);
  assert.equal(html.split('id="modal-ticket-ux"').length - 1, 1);
  assert.equal(html.split("data-react-painel=\"ux-ticket\"").length - 1, 1);
  assert.doesNotMatch(html, /id="ux-ticket-/, "os IDs do ticket são desenhados pelo React");
});

test("o TSX do modal mantém o alerta visível, a barra de botões, os rótulos aprovados e todos os IDs do modal antigo", () => {
  const dialogo = lerPasta("dialogo.tsx");
  assert.match(dialogo, /<p id="ux-ticket-erro" className="ux-ticket-erro" role="alert"/);
  // O título "Solicitante" ocupa as duas colunas da grade: cada rótulo fica ao lado do seu campo.
  assert.match(dialogo, /<p id="ux-ticket-solicitante-titulo" className="font-bold ux-chamado-solicitante__titulo"/);
  assert.match(dialogo, /<p id="ux-ticket-motivo" className="ux-ticket-aviso"/);
  assert.match(dialogo, /<p id="ux-ticket-status" role="status" aria-live="polite">/);
  assert.match(dialogo, /<div className="ck-dialogo">/);
  assert.match(dialogo, /<div className="pt-4 border-t border-line-quiet flex flex-wrap justify-end gap-2">/);
  for (const rotulo of [
    "Gerar ticket no UX", "Alterar Endereço no UX", "Simular preenchimento", "Revisar e finalizar", "Preparar novamente",
    "Conferi no UX; preparar de novo", "Confirmar endereço", "Escolha o endereço", "Dados do ticket", "Registro", "Solicitante",
    "Nº de chamado interno", "Endereço escolhido", "CNPJ de Instalação", "CNPJ de Faturamento", "Anexo",
  ]) assert.ok(dialogo.includes(rotulo), `rótulo aprovado ausente: ${rotulo}`);
  const ids = [
    "titulo-ticket-ux", "ux-ticket-status", "ux-ticket-estado", "ux-ticket-status-detalhe", "ux-ticket-erro", "ux-ticket-ultimo-envio",
    "ux-ticket-serie", "ux-ticket-modelo", "ux-ticket-endereco", "ux-ticket-cnpj-instalacao", "ux-ticket-cnpj-faturamento", "ux-ticket-anexo",
    "ux-ticket-enderecos", "ux-ticket-enderecos-lista", "ux-ticket-enderecos-vazio", "ux-ticket-confirmar-endereco", "ux-ticket-formulario",
    "ux-ticket-registro", "ux-ticket-registro-contador", "ux-ticket-solicitante", "ux-ticket-solicitante-titulo", "ux-ticket-nome",
    "ux-ticket-email", "ux-ticket-telefone", "ux-ticket-chamado-interno", "ux-ticket-motivo", "ux-ticket-cancelar", "ux-ticket-preparar",
    "ux-ticket-conferido", "ux-ticket-simular", "ux-ticket-finalizar",
  ];
  for (const id of ids) assert.ok(dialogo.includes(`id="${id}"`) || dialogo.includes(`id: "${id}"`), `id ausente no TSX: ${id}`);
  assert.match(dialogo, /maxLength=\{REGISTRO_MAX\}/);
  assert.match(dialogo, /placeholder="Opcional"/);
});

test("Deslocamento é o padrão da Home e o Texto para Transporte fica no F2", () => {
  // Restored on 08/11/2026 at the user's request (the 07/11 migration to the ticket Registro was undone).
  assert.match(html, /aria-selected="true"[^>]*id="pill-chamado-deslocamento"/);
  assert.match(html, /id="texto-chamado-deslocamento"[^>]*>Prezados,/);
  assert.match(html, /data-on-click="gerarTextoSolicitacaoTransporte"/);
  assert.match(html, /id="modal-texto-transporte"/);
  // Copiar texto stays out of the F2 aside (not requested back).
  assert.doesNotMatch(html, /btn-copiar-resumo-cockpit/);
});

test("the bar shows Transporte first and Alterar Endereço second, before Texto para Transporte", () => {
  const transporte = html.indexOf('id="btn-gerar-planilha"');
  const alterar = html.indexOf('id="btn-alterar-endereco"');
  const texto = html.indexOf("Texto para Transporte</span>");
  assert.ok(transporte > 0 && transporte < alterar && alterar < texto);
  assert.match(html, /id="btn-gerar-planilha"[^>]*>[\s\S]*?<span>Transporte<\/span>/);
  assert.match(html, /id="btn-alterar-endereco"\s+data-on-click="alterarEnderecoTicketUX"[^>]*disabled\s*>[\s\S]*?<span>Alterar Endereço<\/span>/);
  assert.doesNotMatch(html, /Gerar Planilha/);
});
