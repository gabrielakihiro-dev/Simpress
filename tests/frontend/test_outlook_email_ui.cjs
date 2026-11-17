// Home (F1): modal "E-mail pelo Outlook". Desde o Dia 3 (G7, React) o modal vive em frontend/src/paineis/outlook-email/ e o
// comportamento de tela é testado no navegador (tests/e2e/outlook-email.spec.cjs e tests/e2e/react-g7.spec.cjs, todas as
// rotas /api/outlook/* simuladas). Aqui ficam as regras puras (regras-puro.ts, carregado direto pelo require do Node), a ponte
// do código antigo (frontend/src/aplicacao/pontes.ts), o registro, o HTML montado, os invariantes do envio real e a
// privacidade (nenhum e-mail corporativo, nome completo nem fetch cru no JS e no TSX). Dados sintéticos.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assembledHtml } = require("./support/assembled-html.cjs");
const createOutlookEmail = require("../../frontend/src/aplicacao/registro.ts").fabricas.outlookEmail;

const root = path.resolve(__dirname, "../..");
const pasta = path.join(root, "frontend/src/paineis/outlook-email");
const html = assembledHtml();
const appSource = fs.readFileSync(path.join(root, "frontend/src/aplicacao/app.ts"), "utf8");
const entrySource = fs.readFileSync(path.join(root, "frontend/src/arranque/entrada.ts"), "utf8");
const lerPasta = nome => fs.readFileSync(path.join(pasta, nome), "utf8");
const regras = require(path.join(pasta, "regras-puro.ts"));
const {
  ID_CABO, ATRASO_SALVAR, ATRASO_BUSCA, MAX_TOKENS, MAX_TOKEN, MARCADOR, TEXTO, dividir, tokenFinal, rotuloContato, rotuloConta,
  temDestinatario, mensagemDeErro, inserirContato, substituirTokens, tokensParaResolver, podeBuscar, proximoAtivo, substituir,
  marcadorPendente, textoCopiado, textoConfirmacaoEnvio, contaInicial, resultadoEmail, falhaEmail,
} = regras;

const CONTAS = [
  { id: "conta-a", email: "conta@exemplo.test", rotulo: "Conta A", padrao: true },
  { id: "conta-b", email: "outra@exemplo.test", rotulo: "Conta B", padrao: false },
];
const MSG_INCERTO = "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.";

test("regras: os tempos, o modelo padrão e os limites do resolvedor são os de sempre", () => {
  assert.equal(ID_CABO, "cabo");
  assert.equal(ATRASO_SALVAR, 800);
  assert.equal(ATRASO_BUSCA, 200);
  // Mesmos limites de domains/outlook_mail.py.
  assert.equal(MAX_TOKENS, 50);
  assert.equal(MAX_TOKEN, 200);
  assert.deepEqual({ ...MARCADOR }, { nome: "[Nome da pessoa]", setor: "[Setor]" });
});

test("regras: os textos aprovados não mudaram", () => {
  assert.deepEqual({ ...TEXTO }, {
    pendente: "Alteração ainda não salva…",
    salvando: "Salvando…",
    salva: "Salva.",
    falhaSalvar: "Não foi possível salvar: ",
    aberto: "E-mail aberto no Outlook. Revise e envie por lá.",
    enviado: "E-mail enviado pelo Outlook.",
    copiado: "Texto copiado.",
    incerto: MSG_INCERTO,
    ultimoModelo: "Mantenha ao menos um modelo.",
    semContato: "Nenhum contato encontrado no Entra.",
    ambiguo: "Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.",
    marcador: "Preencha o nome da pessoa e o setor antes de enviar.",
    semPara: "Informe o destinatário no campo Para.",
    falha: "Não foi possível concluir a operação do e-mail. Tente de novo.",
  });
});

test("regras: destinatários se dividem por ';', e só ';' e espaços não é destinatário", () => {
  assert.deepEqual(dividir(" Ana ; ; bia@exemplo.test;"), ["Ana", "bia@exemplo.test"]);
  assert.equal(tokenFinal("Ana; Bi"), "Bi");
  assert.equal(tokenFinal("Ana; "), "");
  assert.equal(tokenFinal("Ana"), "Ana");
  assert.equal(temDestinatario(" ; ;  "), false);
  assert.equal(temDestinatario(""), false);
  assert.equal(temDestinatario("a@exemplo.test"), true);
});

test("regras: rótulos de contato e de conta", () => {
  assert.equal(rotuloContato({ nome: "Pessoa Teste", email: "teste@exemplo.test" }), "Pessoa Teste <teste@exemplo.test>");
  assert.equal(rotuloContato({ email: "teste@exemplo.test" }), "teste@exemplo.test");
  assert.equal(rotuloConta(CONTAS[0]), "Conta A (conta@exemplo.test)");
  assert.equal(rotuloConta({ id: "x", rotulo: "Conta X" }), "Conta X (não configurada)");
});

test("regras: escolher uma sugestão troca só o texto depois do último ';'", () => {
  const bia = { nome: "Bia Teste", email: "bia@exemplo.test" };
  assert.equal(inserirContato("Ana; Bi", bia), "Ana; Bia Teste <bia@exemplo.test>; ");
  assert.equal(inserirContato("Bi", { email: "bia@exemplo.test" }), "bia@exemplo.test; ");
  assert.equal(inserirContato("a@exemplo.test;Bi", bia), "a@exemplo.test; Bia Teste <bia@exemplo.test>; ");
});

test("regras: a resolução troca cada nome pelo texto resolvido, mantém ';' e espaços, e não interpreta '$'", () => {
  const ana = new Map([["Ana", "Ana Teste <ana@exemplo.test>"]]);
  assert.deepEqual(substituirTokens("Ana; bia@exemplo.test", ana), { valor: "Ana Teste <ana@exemplo.test>; bia@exemplo.test", mudou: true });
  assert.deepEqual(substituirTokens("Ana ; Bia", ana), { valor: "Ana Teste <ana@exemplo.test> ; Bia", mudou: true });
  assert.deepEqual(substituirTokens("Bia", ana), { valor: "Bia", mudou: false });
  assert.equal(substituirTokens("Ana", new Map([["Ana", "Ana $& <ana@exemplo.test>"]])).valor, "Ana $& <ana@exemplo.test>");
});

test("regras: só nomes sem '@' vão ao Entra, sem repetição e dentro dos limites do servidor", () => {
  assert.deepEqual(tokensParaResolver("Ana; Bia; ana@exemplo.test; Ana; "), ["Ana", "Bia"]);
  assert.deepEqual(tokensParaResolver("x".repeat(MAX_TOKEN + 1) + "; " + "y".repeat(MAX_TOKEN)), ["y".repeat(MAX_TOKEN)]);
  const muitos = Array.from({ length: MAX_TOKENS + 10 }, (_, indice) => `Pessoa ${indice}`).join("; ");
  assert.equal(tokensParaResolver(muitos).length, MAX_TOKENS);
});

test("regras: a busca de contatos precisa da base do Entra, de duas letras e de um termo sem '@'", () => {
  assert.equal(podeBuscar("ab", true), true);
  assert.equal(podeBuscar("a", true), false);
  assert.equal(podeBuscar("ab", false), false);
  assert.equal(podeBuscar("ab@exemplo.test", true), false);
  assert.equal(podeBuscar("", true), false);
});

test("regras: setas na lista de sugestões dão a volta nas duas pontas", () => {
  assert.equal(proximoAtivo(-1, 3, 1), 0);
  assert.equal(proximoAtivo(-1, 3, -1), 2);
  assert.equal(proximoAtivo(2, 3, 1), 0);
  assert.equal(proximoAtivo(0, 3, -1), 2);
  assert.equal(proximoAtivo(1, 3, 1), 2);
  assert.equal(proximoAtivo(-1, 0, 1), -1);
});

test("regras: {nome} e {setor} usam o valor digitado ou o marcador visível; marcador sem preencher bloqueia o envio", () => {
  assert.equal(substituir("Olá {nome}, {setor}. {nome}", "  Pessoa Teste ", ""), "Olá Pessoa Teste, [Setor]. Pessoa Teste");
  assert.equal(marcadorPendente("Olá {nome}", "Setor {setor}", "Pessoa Teste", ""), true);
  assert.equal(marcadorPendente("Olá {nome}", "Setor {setor}", "", "TI"), true);
  assert.equal(marcadorPendente("Olá {nome}", "Setor {setor}", "Pessoa Teste", "TI"), false);
  // Um marcador digitado à mão no texto também conta como pendente.
  assert.equal(marcadorPendente("Assunto", "[Setor] aqui", "Pessoa Teste", "TI"), true);
  assert.equal(marcadorPendente("Assunto sem marcador", "Corpo", "", ""), false);
});

test("regras: Copiar Texto junta assunto e mensagem já preenchidos, sem linha vazia sobrando", () => {
  assert.equal(textoCopiado("Olá {nome}", "Setor {setor}", "Pessoa Teste", "TI"), "Olá Pessoa Teste\n\nSetor TI");
  assert.equal(textoCopiado("Olá {nome}", "Setor {setor}", "", ""), "Olá [Nome da pessoa]\n\nSetor [Setor]");
  assert.equal(textoCopiado("", "Corpo", "", ""), "Corpo");
});

test("regras: o cartão de confirmação mostra conta, destinatário e a cláusula do Cc só com Cc preenchido", () => {
  assert.equal(
    textoConfirmacaoEnvio("conta@exemplo.test", " teste@exemplo.test ", ""),
    "O e-mail será enviado de conta@exemplo.test para teste@exemplo.test. Depois de enviado, não há como desfazer.",
  );
  assert.equal(
    textoConfirmacaoEnvio("conta@exemplo.test", "teste@exemplo.test", " copia@exemplo.test "),
    "O e-mail será enviado de conta@exemplo.test para teste@exemplo.test, com cópia para copia@exemplo.test. Depois de enviado, não há como desfazer.",
  );
  assert.doesNotMatch(textoConfirmacaoEnvio("conta@exemplo.test", "teste@exemplo.test", " ; "), /com cópia/);
});

test("regras: a conta do modelo vale se existir; senão a padrão; senão a primeira", () => {
  assert.equal(contaInicial(CONTAS, "conta-b"), "conta-b");
  assert.equal(contaInicial(CONTAS, "inexistente"), "conta-a");
  assert.equal(contaInicial(CONTAS, ""), "conta-a");
  assert.equal(contaInicial([{ id: "x", rotulo: "X" }, { id: "y", rotulo: "Y" }], "z"), "x");
});

test("regras: erro HTTP mostra o texto do servidor; conexão perdida mostra o texto aprovado", () => {
  assert.equal(mensagemDeErro({ status: 422, message: "Envio desativado neste servidor." }), "Envio desativado neste servidor.");
  assert.equal(mensagemDeErro({ message: "Failed to fetch" }), TEXTO.falha);
  assert.equal(mensagemDeErro({ status: 500, message: "" }), TEXTO.falha);
  assert.equal(mensagemDeErro(null), TEXTO.falha);
});

test("regras: resposta do servidor: enviado e aberto são sucesso; aviso do servidor nunca vira sucesso puro", () => {
  assert.deepEqual({ ...resultadoEmail({ status: "enviado" }, "enviar") }, { texto: TEXTO.enviado, tipo: "ok" });
  assert.deepEqual({ ...resultadoEmail({ status: "aberto" }, "abrir") }, { texto: TEXTO.aberto, tipo: "ok" });
  // Aberto com aviso do servidor: só o aviso aparece.
  assert.deepEqual({ ...resultadoEmail({ status: "aberto", aviso: "Confira a conta." }, "abrir") }, { texto: "Confira a conta.", tipo: "aviso" });
  assert.deepEqual({ ...resultadoEmail({ status: "enviado", aviso: "Cópia não guardada." }, "enviar") }, { texto: `${TEXTO.enviado} Cópia não guardada.`, tipo: "aviso" });
});

test("regras: envio que o servidor não provou nunca aparece como enviado", () => {
  assert.deepEqual({ ...resultadoEmail({ status: "incerto" }, "enviar") }, { texto: MSG_INCERTO, tipo: "aviso" });
  assert.deepEqual({ ...resultadoEmail({ status: "incerto", aviso: "Veja os Itens Enviados." }, "enviar") }, { texto: "Veja os Itens Enviados.", tipo: "aviso" });
  for (const resposta of [{}, null, undefined, { status: "qualquer" }]) {
    assert.deepEqual({ ...resultadoEmail(resposta, "enviar") }, { texto: MSG_INCERTO, tipo: "aviso" }, JSON.stringify(resposta));
  }
  // Abrir sem resposta válida é falha comum, não incerteza.
  assert.deepEqual({ ...resultadoEmail({}, "abrir") }, { texto: TEXTO.falha, tipo: "erro" });
});

test("regras: falha do POST: sem status HTTP o envio é incerto; com status vale o texto do servidor, e a recusa 422 é erro", () => {
  assert.deepEqual({ ...falhaEmail({ message: "Failed to fetch" }, "enviar") }, { texto: MSG_INCERTO, tipo: "aviso" });
  assert.deepEqual({ ...falhaEmail(null, "enviar") }, { texto: MSG_INCERTO, tipo: "aviso" });
  assert.deepEqual({ ...falhaEmail({ status: 422, message: "O envio está desativado." }, "enviar") }, { texto: "O envio está desativado.", tipo: "erro" });
  assert.deepEqual({ ...falhaEmail({ status: 500, message: "" }, "enviar") }, { texto: TEXTO.falha, tipo: "erro" });
  // Abrir não envia nada: conexão perdida é falha comum.
  assert.deepEqual({ ...falhaEmail({ message: "Failed to fetch" }, "abrir") }, { texto: TEXTO.falha, tipo: "erro" });
});

// ---- Ponte do código antigo ----
const NOMES_PONTE = [
  "abrirEmailOutlook", "fecharEmailOutlook", "atualizarEmailOutlook", "trocarModeloEmail", "novoModeloEmail", "duplicarModeloEmail",
  "excluirModeloEmail", "restaurarModeloEmail", "copiarTextoEmail", "abrirEmailNoOutlook", "enviarEmailPeloOutlook",
];

function ponteFalsa(acao) {
  const chamadas = [];
  const feature = createOutlookEmail({
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

test("registro: a ponte do painel React outlook-email (aplicacao/registro.ts) continua no arranque e no FEATURE_ORDER", () => {
  assert.match(entrySource, /import "\.\.\/aplicacao\/registro\.ts";/);
  assert.equal(typeof require("../../frontend/src/aplicacao/registro.ts").fabricas.outlookEmail, "function");
  assert.match(appSource, /"outlookEmail",/);
  assert.ok(fs.existsSync(path.join(pasta, "montar.tsx")));
  for (const nome of NOMES_PONTE) assert.match(lerPasta("montar.tsx"), new RegExp(`\\b${nome}\\b`), `${nome} falta no retorno de montar()`);
});

test("ponte: os onze nomes continuam publicados e repassam ao painel React outlook-email com os mesmos argumentos", async () => {
  const chamadasReact = [];
  const { chamadas, feature } = ponteFalsa(async (nome, ...args) => { chamadasReact.push([nome, args]); return nome; });
  assert.deepEqual(chamadas, [["outlook-email", NOMES_PONTE]]);
  assert.equal(chamadasReact.length, 0, "criar o módulo não chama o React");
  assert.deepEqual(Object.keys(feature), NOMES_PONTE);
  const equipamento = { serial: "SERIE-TESTE" };
  await feature.atualizarEmailOutlook(equipamento);
  await feature.trocarModeloEmail("m2");
  await feature.enviarEmailPeloOutlook();
  assert.deepEqual(chamadasReact, [["atualizarEmailOutlook", [equipamento]], ["trocarModeloEmail", ["m2"]], ["enviarEmailPeloOutlook", []]]);
});

test("ponte: devolve o valor da ação (o fechamento devolve o salvamento pendente)", async () => {
  const { feature } = ponteFalsa(async nome => `devolvido:${nome}`);
  assert.equal(await feature.fecharEmailOutlook(), "devolvido:fecharEmailOutlook");
});

test("ponte: se o React não carregou, a ação não rejeita (quem chama, como data-on-*, não trata erro)", async () => {
  const { feature } = ponteFalsa(() => Promise.reject(new Error('O painel React "outlook-email" não carregou.')));
  await semConsole(async () => {
    for (const nome of NOMES_PONTE) assert.equal(await feature[nome](), undefined, nome);
  });
});

test("o Esc do modal (data-close-function) aponta para uma ação publicada pela ponte e o foco inicial é o select Modelo", () => {
  const estado = lerPasta("estado.ts");
  const aberturas = [...estado.matchAll(/abrirModalAcessivel\(MODAL, "([^"]+)", "([^"]+)"\)/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(aberturas, [["#email-modelo", "fecharEmailOutlook"]]);
  assert.ok(NOMES_PONTE.includes("fecharEmailOutlook"));
  assert.match(estado, /const MODAL = "modal-email-outlook";/);
  // Com o select ainda travado o foco inicial não vale; ele vai ao select assim que a configuração carrega.
  assert.match(estado, /document\.getElementById\("email-modelo"\)\?\.focus\(\);/);
});

// ---- Privacidade ----
test("nenhum arquivo do painel nem a ponte traz e-mail corporativo, nome completo seguido de ';', fetch cru ou console com dados", () => {
  const arquivos = [...fs.readdirSync(pasta).map(nome => path.join(pasta, nome)), path.join(root, "frontend/src/aplicacao/pontes.ts")];
  assert.ok(arquivos.length >= 5);
  for (const arquivo of arquivos) {
    const codigo = fs.readFileSync(arquivo, "utf8");
    assert.doesNotMatch(codigo, /@simpress\.com\.br|@pr\.sebrae\.com\.br/i, arquivo);
    // Nenhum destinatário "Nome Sobrenome;" no front: o texto padrão do Modelo 1 vem do servidor.
    assert.doesNotMatch(codigo, /[A-ZÀ-Ý][a-zà-ÿ]+ [A-ZÀ-Ý][a-zà-ÿ]+;/u, arquivo);
    assert.doesNotMatch(codigo, /(?<![A-Za-z.])fetch\(/, `${arquivo}: chamada de API só por apiFetch`);
    if (arquivo.startsWith(pasta)) assert.doesNotMatch(codigo, /\bconsole\.[a-z]+\(/, `${arquivo}: corpo e destinatários nunca vão para o console`);
  }
  assert.match(lerPasta("estado.ts"), /const API = "\/api\/outlook";/);
  assert.match(lerPasta("estado.ts"), /return apiFetch<T>\(API \+ caminho, opcoes\);/);
});

test("o envio real só sai pelo clique, depois da confirmação, com confirmado igual ao modo, e uma vez por pedido ocupado", () => {
  const estado = lerPasta("estado.ts");
  // exclusivo: uma ação lenta por vez; "ocupado" trava na hora, antes de qualquer await (clique duplo).
  assert.match(estado, /if \(ocupado \|\| !aberto \|\| !config\) return undefined;/);
  assert.match(estado, /ocupado = true;\s+sincronizar\(\);\s+try \{\s+return await passo\(\);/);
  const inicio = estado.indexOf("function executarEmail(");
  assert.ok(inicio > 0, "executarEmail não achado");
  const confirmacao = estado.indexOf("app().confirmarAcao(", inicio);
  const envio = estado.indexOf('chamar<{ status?: string; aviso?: string }>("/email"', inicio);
  assert.ok(confirmacao > inicio && confirmacao < envio, "a confirmação vem antes do POST /email");
  assert.match(estado.slice(inicio, confirmacao), /if \(modo === "enviar"\) \{/);
  assert.ok(estado.indexOf("temAmbiguidade()", inicio) < confirmacao, "ambiguidade, destinatário e marcadores são checados antes da confirmação");
  assert.ok(estado.indexOf("temDestinatario(", inicio) < confirmacao);
  assert.ok(estado.indexOf("marcadorPendente(", inicio) < confirmacao);
  assert.match(estado, /if \(!confirmou \|\| !vigente\(\)\) return;/);
  assert.match(estado, /modo, confirmado: modo === "enviar",/);
  // Resposta perdida: um envio real nunca vira sucesso nem falha comum.
  assert.match(estado, /falhaEmail\(erro as ErroApi, modo\)/);
  assert.match(estado, /resultadoEmail\(resposta, modo\)/);
  // Os dois botões só chamam as ações do modo certo, sem mais nada no clique.
  const dialogo = lerPasta("dialogo.tsx");
  assert.match(dialogo, /id="email-abrir"[^>]*onClick=\{\(\) => void abrirEmailNoOutlook\(\)\}/);
  assert.match(dialogo, /id="email-enviar"[^>]*onClick=\{\(\) => void enviarEmailPeloOutlook\(\)\}/);
  assert.match(estado, /export const abrirEmailNoOutlook = \(\) => executarEmail\("abrir"\);/);
  assert.match(estado, /export const enviarEmailPeloOutlook = \(\) => executarEmail\("enviar"\);/);
});

// ---- Markup: o HTML é só o ponto de montagem; o TSX desenha o modal com os mesmos IDs, rótulos e ARIA ----
test("o HTML montado traz só o overlay do React; o modal inteiro sai do HTML", () => {
  assert.match(html, /<div id="modal-email-outlook" class="modal-overlay ck-veu hidden" aria-labelledby="titulo-email-outlook" data-react-painel="outlook-email"><\/div>/);
  assert.equal(html.split('id="modal-email-outlook"').length - 1, 1);
  assert.equal(html.split('data-react-painel="outlook-email"').length - 1, 1);
  assert.doesNotMatch(html, /id="email-(modelo|conta|para|cc|assunto|corpo|enviar|abrir|copiar|cancelar|status|autosave-status)/, "os IDs do e-mail são desenhados pelo React");
  assert.doesNotMatch(html, /id="titulo-email-outlook">/);
});

test("a Home mantém o botão Enviar e-mail que abre o modal pela ação publicada", () => {
  assert.match(html, /id="btn-enviar-email" data-on-click="abrirEmailOutlook"[^>]*disabled[^>]*aria-controls="modal-email-outlook"[\s\S]*?<span>Enviar e-mail<\/span>/);
});

test("o TSX do modal mantém os rótulos aprovados, o aviso do Entra, a barra de botões e todos os IDs do modal antigo", () => {
  const dialogo = lerPasta("dialogo.tsx");
  assert.match(dialogo, /<div className="ck-dialogo email-outlook">/);
  assert.match(dialogo, /<div className="pt-4 border-t border-line-quiet flex flex-wrap justify-end gap-2">/);
  assert.match(dialogo, /<p id="email-autosave-status" className="email-outlook__autosave" role="status" aria-live="polite"/);
  assert.match(dialogo, /<p id="email-status" className="email-outlook__status" role="status" aria-live="polite"/);
  assert.match(dialogo, /<p id="email-aviso-diretorio" className="email-outlook__aviso" role="status"/);
  assert.match(dialogo, /role="combobox" aria-autocomplete="list"/);
  assert.match(dialogo, /role="listbox"/);
  for (const rotulo of [
    "E-mail pelo Outlook", "Sobre E-mail pelo Outlook", "As alterações no modelo são salvas automaticamente.",
    "A base do Microsoft Entra não foi importada; digite o e-mail completo.", "Modelo", "Nome do modelo", "Enviar de", "Para", "Cc",
    "Assunto", "Nome da pessoa", "Setor", "Mensagem", "Sobre os marcadores", "Novo modelo", "Duplicar modelo", "Excluir modelo",
    "Restaurar padrão", "Abrir no Outlook", "Enviar pelo Outlook", "Copiar Texto", "Cancelar",
    "Use {nome} e {setor} no assunto ou na mensagem para preencher com os campos Nome da pessoa e Setor.",
    "Escolha o destinatário certo para",
  ]) assert.ok(dialogo.includes(rotulo), `rótulo aprovado ausente: ${rotulo}`);
  const ids = [
    "titulo-email-outlook", "email-aviso-diretorio", "email-modelo", "email-modelo-nome",
    "email-modelo-novo", "email-modelo-duplicar", "email-modelo-excluir", "email-modelo-restaurar", "email-conta", "email-assunto",
    "email-corpo", "email-nome-pessoa", "email-setor", "email-autosave-status", "email-status", "email-cancelar", "email-copiar",
    "email-abrir", "email-enviar",
  ];
  for (const id of ids) assert.ok(dialogo.includes(`id="${id}"`), `id ausente no TSX: ${id}`);
  // As duas dicas (info-tip) recebem o id pelo componente local DicaInfo.
  for (const id of ["email-ajuda-autosave", "email-ajuda-marcadores"]) assert.ok(dialogo.includes(`idDica="${id}"`), `dica ausente no TSX: ${id}`);
  // Para e Cc compartilham o componente: os IDs saem do nome do campo.
  for (const modelo of ["email-${campo}-rotulo", "email-${campo}`", "email-${campo}-lista", "email-${campo}-opcao-${indice}", "email-${campo}-opcoes"]) {
    assert.ok(dialogo.includes(modelo), `id do combo ausente no TSX: ${modelo}`);
  }
  assert.match(dialogo, /<CampoContato campo="para" rotulo="Para" \/>/);
  assert.match(dialogo, /<CampoContato campo="cc" rotulo="Cc" \/>/);
  // Limites do modal antigo.
  assert.match(dialogo, /id="email-modelo-nome"[^>]*maxLength=\{80\}/);
  assert.match(dialogo, /id="email-assunto"[^>]*maxLength=\{200\}/);
  assert.match(dialogo, /id="email-corpo"[^>]*rows=\{6\} maxLength=\{4000\}/);
  assert.match(dialogo, /id="email-nome-pessoa"[^>]*maxLength=\{200\}/);
  assert.match(dialogo, /id="email-setor"[^>]*maxLength=\{200\}/);
  assert.match(dialogo, /maxLength=\{1000\}/);
});

test("o botão Cancelar nunca trava; os campos livres seguem editáveis durante uma ação e os controles de ação não", () => {
  const dialogo = lerPasta("dialogo.tsx");
  assert.doesNotMatch(dialogo, /id="email-cancelar"[^>]*disabled/);
  assert.match(dialogo, /const livre = !s\.pronto;/);
  assert.match(dialogo, /const travado = !s\.pronto \|\| s\.ocupado;/);
  for (const id of ["email-modelo-nome", "email-conta", "email-assunto", "email-corpo", "email-nome-pessoa", "email-setor"]) {
    assert.match(dialogo, new RegExp(`id="${id}"[^>]*disabled=\\{livre\\}`), `${id} deve seguir livre durante a ação`);
  }
  for (const id of ["email-modelo", "email-modelo-novo", "email-modelo-duplicar", "email-modelo-excluir", "email-copiar", "email-abrir", "email-enviar"]) {
    assert.match(dialogo, new RegExp(`id="${id}"[^>]*disabled=\\{travado\\}`), `${id} deve travar durante a ação`);
  }
});
