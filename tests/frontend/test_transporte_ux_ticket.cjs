const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const createUxTicket = require("../../static/js/features/ux-ticket.js");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "static", "index.html"), "utf8");
const API = "/api/ux/gerar-ticket/";
const PAYLOAD = { serial: "LENTO", entrega_contato: "Maria Teste", entrega_telefone: "(41) 3333-0000", entrega_cnpj: "11.111.111/0001-11" };
const SOLICITANTE = { nome: "Pessoa Teste", email: "pessoa@exemplo.com", telefone: "(41) 90000-0000" };
const PREPARADO = {
  status: "preparado", session_id: "a".repeat(32), serial: "LENTO", modelo: "Modelo X", endereco: "Rua Um, 1",
  opcoes_endereco: [], cnpj_instalacao: "11.111.111/0001-11", cnpj_faturamento: "75.110.585/0001-00",
  arquivo: "transferencia.xlsx", solicitante: SOLICITANTE, ultimo_envio: null,
};
const REGISTRO_OK = "Prezados,\nContato no local: Maria Teste\nColaborador(a) Novo(a): Fulano\nData de Instalação: 10/11/2026\nHorário da Instalação: 09h";

function erro(detail, codigo, status = 409) {
  return Object.assign(new Error(detail), { status, detail, data: { detail, codigo } });
}

function fakeElement(id = "") {
  return {
    id, value: "", textContent: "", hidden: false, disabled: false, title: "", checked: false, children: [], attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
  };
}

const PADRAO = { nome: "Pessoa Padrão", email: "padrao@exemplo.com", telefone: "(41) 90000-0000" };
const TEXTO_TRANSPORTE = [
  "Prezados,", "", "Solicito o transporte do equipamento da unidade do Sebrae de Origem/PR para a unidade do Sebrae de Destino/PR", "",
  "O transporte dos equipamentos é previsto em edital e de responsabilidade da Simpress.", "",
  "Endereço para Retirada: Rua A, 1", "Endereço para Entrega: Rua B, 2",
].join(String.fromCharCode(10));

function criar({ responder, cep = "80000-000", confirmar = true, textoTransporte = "" } = {}) {
  const elementos = new Map();
  const listeners = {};
  const el = id => {
    if (!elementos.has(id)) elementos.set(id, fakeElement(id));
    return elementos.get(id);
  };
  // The address fieldset finds the checked radio among the rendered labels.
  el("ux-ticket-enderecos").querySelector = () => el("ux-ticket-enderecos-lista").children
    .flatMap(rotulo => rotulo.children || []).find(radio => radio.checked) || null;
  global.document = {
    getElementById: el,
    createElement: () => fakeElement(),
    createTextNode: text => ({ text }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const efeitos = { chamadas: [], abertos: [], fechados: [], confirmacoes: [], toasts: [] };
  const app = {
    apiFetch(url, opcoes) {
      // GET /solicitante: the default solicitante served by the backend.
      if (!opcoes.method) return Promise.resolve(url === "/api/ux/gerar-ticket/solicitante" ? { ...PADRAO } : null);
      const corpo = JSON.parse(opcoes.body);
      efeitos.chamadas.push([url.replace(API, ""), corpo]);
      try {
        return Promise.resolve(responder(url.replace(API, ""), corpo));
      } catch (falha) {
        return Promise.reject(falha);
      }
    },
    abrirModalAcessivel: (...args) => efeitos.abertos.push(args),
    fecharModalAcessivel: id => efeitos.fechados.push(id),
    confirmarAcao: async opcoes => { efeitos.confirmacoes.push(opcoes); return confirmar; },
    showToast: (mensagem, tipo) => efeitos.toasts.push({ mensagem, tipo }),
    // transfer-form.js publishes this; it returns { aviso } when the F2 addresses are missing.
    montarTextoSolicitacaoTransporte: () => textoTransporte ? { texto: textoTransporte } : { aviso: "Selecione o equipamento de origem e a unidade de destino para carregar os endereços." },
  };
  el("select-unidade-destino").value = "7";
  const acoes = createUxTicket({ app, appState: { unidadesList: [{ id: 7, cep }] } });
  const gerar = async (payload = PAYLOAD) => {
    listeners["simpress:transfer-generated"]({ detail: { payload } });
    await esperar();
  };
  return { el, acoes, efeitos, gerar, listeners };
}

const esperar = () => new Promise(resolve => setImmediate(resolve));
const etapas = efeitos => efeitos.chamadas.map(([etapa]) => etapa);

test("Gerar Planilha opens the modal and prepares with the payload plus the delivery CEP", async () => {
  const h = criar({ responder: () => PREPARADO, textoTransporte: TEXTO_TRANSPORTE });
  await h.gerar();
  assert.deepEqual(h.efeitos.abertos, [["modal-ticket-ux", "#ux-ticket-cancelar", "fecharTicketUX"]]);
  assert.deepEqual(h.efeitos.chamadas, [["preparar", { ...PAYLOAD, entrega_cep: "80000-000" }]]);
  assert.equal(h.el("ux-ticket-estado").textContent, "Pronto para simular ou finalizar");
  assert.equal(h.el("ux-ticket-modelo").textContent, "Modelo X");
  assert.equal(h.el("ux-ticket-endereco").textContent, "Rua Um, 1");
  assert.equal(h.el("ux-ticket-nome").value, SOLICITANTE.nome);
  // Default Registro = the F2 "Texto para Transporte" (same function as the button); Deslocamento stays in the Home (F1).
  assert.equal(h.el("ux-ticket-registro").value, TEXTO_TRANSPORTE);
  assert.equal(h.el("ux-ticket-erro").hidden, true);
  assert.equal(h.el("ux-ticket-simular").disabled, false);
  assert.equal(h.el("ux-ticket-motivo").hidden, true);
});

test("the default Registro reaches /enviar unchanged when the user does not edit it", async () => {
  const h = criar({ responder: (etapa, corpo) => etapa === "preparar" ? PREPARADO : { status: "preenchido" }, textoTransporte: TEXTO_TRANSPORTE });
  await h.gerar();
  await h.acoes.executarTicketUX(false);
  assert.equal(h.efeitos.chamadas.at(-1)[0], "enviar");
  assert.equal(h.efeitos.chamadas.at(-1)[1].descricao, TEXTO_TRANSPORTE);
});

test("a Registro line ending in ':' blocks Simular and Finalizar with a visible reason", async () => {
  const h = criar({ responder: () => PREPARADO });
  await h.gerar();
  // Without the F2 addresses the transport text is not built: the Registro starts empty and blocked.
  assert.equal(h.el("ux-ticket-simular").disabled, true);
  assert.equal(h.el("ux-ticket-finalizar").disabled, true);
  assert.equal(h.el("ux-ticket-motivo").textContent, "Preencha o Registro.");
  assert.equal(h.el("ux-ticket-motivo").hidden, false);
  h.el("ux-ticket-registro").value = "Prezados,\nColaborador(a) Novo(a):";
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-simular").disabled, true);
  assert.match(h.el("ux-ticket-motivo").textContent, /terminam com “:”/);
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-simular").disabled, false);
  assert.equal(h.el("ux-ticket-finalizar").disabled, false);
  assert.equal(h.el("ux-ticket-motivo").hidden, true);
  h.el("ux-ticket-registro").value = REGISTRO_OK + "\nObservação: [preencher]";
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-simular").disabled, true);
});

test("Simular sends enviar:false without confirmation; Finalizar sends enviar:true and confirmado:true only after confirmation", async () => {
  const h = criar({ responder: (etapa, corpo) => etapa === "preparar" ? PREPARADO
    : corpo.enviar ? { status: "enviado", ticket: "998877" } : { status: "preenchido" } });
  await h.gerar();
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  h.el("ux-ticket-chamado-interno").value = "INT-1";
  await h.acoes.executarTicketUX(false);
  assert.equal(h.efeitos.confirmacoes.length, 0);
  assert.equal(h.el("ux-ticket-estado").textContent, "Simulado");
  const base = { session_id: PREPARADO.session_id, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE, chamado_interno: "INT-1" };
  assert.deepEqual(h.efeitos.chamadas[1], ["enviar", { ...base, enviar: false, confirmado: false }]);

  // Declined confirmation: nothing is sent.
  const recusa = criar({ confirmar: false, responder: () => PREPARADO });
  await recusa.gerar();
  recusa.el("ux-ticket-registro").value = REGISTRO_OK;
  await recusa.acoes.executarTicketUX(true);
  assert.equal(recusa.efeitos.confirmacoes.length, 1);
  assert.deepEqual(etapas(recusa.efeitos), ["preparar"]);

  // Confirmed: enviar:true + confirmado:true, ticket shown, session gone.
  const h2 = criar({ responder: (etapa, corpo) => etapa === "preparar" ? PREPARADO
    : corpo.enviar ? { status: "enviado", ticket: "998877" } : { status: "preenchido" } });
  await h2.gerar();
  h2.el("ux-ticket-registro").value = REGISTRO_OK;
  await h2.acoes.executarTicketUX(true);
  assert.equal(h2.efeitos.confirmacoes[0].titulo, "Finalizar ticket no UX");
  assert.equal(h2.efeitos.confirmacoes[0].confirmar, "Finalizar ticket");
  assert.deepEqual(h2.efeitos.chamadas.at(-1), ["enviar", {
    session_id: PREPARADO.session_id, serial: "LENTO", descricao: REGISTRO_OK, solicitante: SOLICITANTE,
    chamado_interno: "", enviar: true, confirmado: true,
  }]);
  assert.equal(h2.el("ux-ticket-estado").textContent, "Enviado");
  assert.match(h2.el("ux-ticket-status-detalhe").textContent, /998877/);
  assert.equal(h2.el("ux-ticket-simular").disabled, true);
  assert.equal(h2.el("ux-ticket-finalizar").disabled, true);
  assert.equal(h2.el("ux-ticket-cancelar").textContent, "Fechar");
  // The server already removed the session: closing does not call /cancelar.
  h2.acoes.fecharTicketUX();
  await esperar();
  assert.deepEqual(etapas(h2.efeitos), ["preparar", "enviar"]);
  assert.deepEqual(h2.efeitos.fechados, ["modal-ticket-ux"]);
});

test("an ambiguous address requires an explicit choice of the exact UX option", async () => {
  const opcoes = ["Rua Um, 1 - Centro", "Rua Um, 1 - Batel"];
  const h = criar({ responder: (etapa, corpo) => etapa === "preparar"
    ? { ...PREPARADO, status: "endereco_ambiguo", endereco: "", opcoes_endereco: opcoes }
    : { status: "preparado", session_id: PREPARADO.session_id, serial: "LENTO", endereco: corpo.endereco } });
  await h.gerar();
  assert.equal(h.el("ux-ticket-estado").textContent, "Escolha o endereço");
  assert.equal(h.el("ux-ticket-enderecos").hidden, false);
  const radios = h.el("ux-ticket-enderecos-lista").children.map(rotulo => rotulo.children[0]);
  assert.deepEqual(radios.map(radio => radio.value), opcoes);
  assert.ok(radios.every(radio => radio.type === "radio" && radio.name === "ux-ticket-endereco"));
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-confirmar-endereco").disabled, true);
  assert.equal(h.el("ux-ticket-simular").disabled, true);
  assert.match(h.el("ux-ticket-motivo").textContent, /Escolha e confirme o endereço/);
  radios[1].checked = true;
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-confirmar-endereco").disabled, false);
  await h.acoes.confirmarEnderecoTicketUX();
  assert.deepEqual(h.efeitos.chamadas[1], ["escolher-endereco", { session_id: PREPARADO.session_id, serial: "LENTO", endereco: opcoes[1] }]);
  // The short answer is merged: the model and the solicitante stay.
  assert.equal(h.el("ux-ticket-modelo").textContent, "Modelo X");
  assert.equal(h.el("ux-ticket-endereco").textContent, opcoes[1]);
  assert.equal(h.el("ux-ticket-enderecos").hidden, true);
  assert.equal(h.el("ux-ticket-simular").disabled, false);
});

test("a /preparar failure shows the detail in the alert, keeps the Registro and offers only Preparar novamente", async () => {
  let falhar = true;
  const h = criar({ responder: etapa => {
    if (etapa === "preparar" && falhar) throw erro("O Chrome de automação não abriu.", "chrome_indisponivel", 503);
    return PREPARADO;
  } });
  await h.gerar();
  assert.equal(h.el("ux-ticket-erro").hidden, false);
  assert.equal(h.el("ux-ticket-erro").textContent, "O Chrome de automação não abriu.");
  assert.equal(h.el("ux-ticket-estado").textContent, "Erro");
  assert.equal(h.el("ux-ticket-preparar").hidden, false);
  assert.equal(h.el("ux-ticket-conferido").hidden, true);
  assert.equal(h.el("ux-ticket-simular").disabled, true);
  assert.equal(h.el("ux-ticket-formulario").disabled, false);
  assert.deepEqual(etapas(h.efeitos), ["preparar"]); // no automatic retry
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  falhar = false;
  await h.acoes.prepararNovamenteTicketUX();
  assert.deepEqual(h.efeitos.chamadas[1], ["preparar", { ...PAYLOAD, entrega_cep: "80000-000" }]);
  assert.equal(h.el("ux-ticket-registro").value, REGISTRO_OK);
  assert.equal(h.el("ux-ticket-erro").hidden, true);
  assert.equal(h.el("ux-ticket-simular").disabled, false);
});

test("the generated download never depends on the ticket: the listener swallows synchronous failures", () => {
  const h = criar({ responder: () => { throw erro("x", "aba_perdida"); } });
  global.document.getElementById = () => { throw new Error("DOM indisponível"); };
  assert.doesNotThrow(() => h.listeners["simpress:transfer-generated"]({ detail: { payload: PAYLOAD } }));
  assert.doesNotThrow(() => h.listeners["simpress:transfer-generated"]({}));
});

test("a delivery unit without an 8-digit CEP shows the error and never calls /preparar", async () => {
  const h = criar({ cep: "", responder: () => PREPARADO });
  await h.gerar();
  assert.equal(h.efeitos.abertos.length, 1);
  assert.deepEqual(h.efeitos.chamadas, []);
  assert.match(h.el("ux-ticket-erro").textContent, /CEP com 8 dígitos/);
  assert.equal(h.el("ux-ticket-erro").hidden, false);
  assert.equal(h.el("ux-ticket-simular").disabled, true);
});

test("ux_tentativas_esgotadas and other /enviar errors show their detail", async () => {
  const detalhe = "O UX não respondeu depois de 3 tentativas. Use Preparar novamente.";
  const h = criar({ responder: etapa => {
    if (etapa === "enviar") throw erro(detalhe, "ux_tentativas_esgotadas", 503);
    return PREPARADO;
  } });
  await h.gerar();
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  await h.acoes.executarTicketUX(false);
  assert.equal(h.el("ux-ticket-erro").textContent, detalhe);
  assert.equal(h.el("ux-ticket-erro").hidden, false);
  assert.equal(h.el("ux-ticket-estado").textContent, "Erro");
  assert.equal(h.el("ux-ticket-preparar").hidden, false);
  assert.deepEqual(etapas(h.efeitos), ["preparar", "enviar"]);
});

test("envio_incerto requires the explicit 'Conferi no UX' action, which sends conferido:true", async () => {
  let incerto = true;
  const h = criar({ responder: () => {
    if (incerto) throw erro("A última tentativa ficou incerta. Confira no UX.", "envio_incerto", 409);
    return PREPARADO;
  } });
  await h.gerar();
  assert.equal(h.el("ux-ticket-estado").textContent, "Incerto — confira no UX");
  assert.equal(h.el("ux-ticket-conferido").hidden, false);
  assert.equal(h.el("ux-ticket-preparar").hidden, true);
  await h.acoes.prepararNovamenteTicketUX(); // not offered while uncertain
  assert.equal(h.efeitos.chamadas.length, 1);
  incerto = false;
  await h.acoes.conferirTicketUX();
  assert.deepEqual(h.efeitos.chamadas[1], ["preparar", { ...PAYLOAD, entrega_cep: "80000-000", conferido: true }]);
  assert.equal(h.el("ux-ticket-conferido").hidden, true);
});

test("an uncertain submission locks the session and only the explicit check reopens the form", async () => {
  const h = criar({ responder: etapa => {
    if (etapa === "enviar") return { status: "incerto", mensagem: "Não deu para confirmar o ticket. Confira no UX." };
    return PREPARADO;
  } });
  await h.gerar();
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  await h.acoes.executarTicketUX(true);
  assert.equal(h.el("ux-ticket-estado").textContent, "Incerto — confira no UX");
  assert.equal(h.el("ux-ticket-finalizar").disabled, true);
  assert.equal(h.el("ux-ticket-conferido").hidden, false);
  assert.equal(h.el("ux-ticket-formulario").disabled, true);
  await h.acoes.conferirTicketUX();
  assert.equal(h.efeitos.chamadas.at(-1)[1].conferido, true);
  assert.equal(h.el("ux-ticket-formulario").disabled, false);
  assert.equal(h.el("ux-ticket-finalizar").disabled, false);
});

test("Cancelar calls /cancelar for the open session, swallows a 409 and closes the modal", async () => {
  const h = criar({ responder: etapa => {
    if (etapa === "cancelar") throw erro("Sessão já encerrada.", "sessao_inexistente", 409);
    return PREPARADO;
  } });
  await h.gerar();
  assert.equal(h.el("ux-ticket-cancelar").textContent, "Cancelar");
  h.acoes.fecharTicketUX();
  await esperar();
  assert.deepEqual(h.efeitos.chamadas.at(-1), ["cancelar", { session_id: PREPARADO.session_id }]);
  assert.deepEqual(h.efeitos.fechados, ["modal-ticket-ux"]);
});

test("the default solicitante is shown at once, stays editable while preparing and survives a failure", async () => {
  let resolver;
  const h = criar({ responder: () => new Promise((_, rejeitar) => { resolver = rejeitar; }) });
  await h.gerar();
  // While /preparar runs (minutes in the real UX) the user can already fill the Registro and edit the solicitante.
  assert.equal(h.el("ux-ticket-nome").value, PADRAO.nome);
  assert.equal(h.el("ux-ticket-email").value, PADRAO.email);
  assert.equal(h.el("ux-ticket-telefone").value, PADRAO.telefone);
  assert.equal(h.el("ux-ticket-formulario").disabled, false);
  h.el("ux-ticket-registro").value = ["Prezados,", "Colaborador(a) Novo(a):"].join(String.fromCharCode(10));
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-registro").attrs["aria-invalid"], "true");
  assert.equal(h.el("ux-ticket-simular").disabled, true);
  h.el("ux-ticket-email").value = "outra@exemplo.com";
  resolver(erro("O Chrome de automação não abriu.", "chrome_indisponivel", 503));
  await esperar();
  assert.equal(h.el("ux-ticket-nome").value, PADRAO.nome);
  assert.equal(h.el("ux-ticket-email").value, "outra@exemplo.com");
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  h.acoes.atualizarTicketUX();
  assert.equal(h.el("ux-ticket-registro").attrs["aria-invalid"], "false");
});

test("the front-end never embeds the default solicitante: it reads GET /solicitante", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "..", "static", "js", "features", "ux-ticket.js"), "utf8");
  assert.ok(js.includes('app.apiFetch(API + "/solicitante"'));
  assert.doesNotMatch(js, /@simpress\.com\.br/);
});

test("the Registro alert border outranks the generic dialog field border", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "static", "styles", "ck-cockpit.css"), "utf8");
  // .ck-veu > .ck-dialogo :is(input, select, textarea) is (0,2,1); a bare .ux-ticket-registro[aria-invalid] (0,2,0) loses.
  assert.ok(css.includes('.ck-veu > .ck-dialogo :is(input, select, textarea) {'));
  assert.ok(css.includes('.ck-veu > .ck-dialogo .ux-ticket-registro[aria-invalid="true"] { border-color: var(--cor-alerta-texto); }'));
});

test("closing while /preparar is in flight cancels the session that arrives later", async () => {
  let resolver;
  const h = criar({ responder: etapa => etapa === "preparar" ? new Promise(resolve => { resolver = resolve; }) : { status: "cancelado" } });
  await h.gerar();
  h.acoes.fecharTicketUX();
  resolver(PREPARADO);
  await esperar();
  assert.deepEqual(h.efeitos.chamadas.at(-1), ["cancelar", { session_id: PREPARADO.session_id }]);
});

test("closing is ignored while the final submission is in flight", async () => {
  let resolver;
  const h = criar({ responder: etapa => etapa === "enviar" ? new Promise(resolve => { resolver = resolve; }) : PREPARADO });
  await h.gerar();
  h.el("ux-ticket-registro").value = REGISTRO_OK;
  const envio = h.acoes.executarTicketUX(true);
  await esperar();
  h.acoes.fecharTicketUX();
  assert.deepEqual(h.efeitos.fechados, []);
  assert.equal(h.el("ux-ticket-cancelar").disabled, true);
  resolver({ status: "enviado", ticket: "1" });
  await envio;
  assert.equal(h.el("ux-ticket-cancelar").disabled, false);
});

test("the modal markup keeps the visible alert; Deslocamento is the Home default and Texto para Transporte is in F2", () => {
  assert.match(html, /<p id="ux-ticket-erro"[^>]*role="alert"/);
  // The "Solicitante" title spans the two-column grid, so each label stays next to its field.
  assert.match(html, /<p id="ux-ticket-solicitante-titulo" class="[^"]*ux-chamado-solicitante__titulo/);
  assert.match(html, /<p id="ux-ticket-motivo" class="ux-ticket-aviso"/);
  assert.match(html, /id="modal-ticket-ux"/);
  // Restored on 08/11/2026 at the user's request (the 07/11 migration to the ticket Registro was undone).
  assert.match(html, /aria-selected="true"[^>]*id="pill-chamado-deslocamento"/);
  assert.match(html, /id="texto-chamado-deslocamento"[^>]*>Prezados,/);
  assert.match(html, /data-on-click="gerarTextoSolicitacaoTransporte"/);
  assert.match(html, /id="modal-texto-transporte"/);
  // Copiar texto stays out of the F2 aside (not requested back).
  assert.doesNotMatch(html, /btn-copiar-resumo-cockpit/);
});
