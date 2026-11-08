/** Transporte (F2): after "Gerar Planilha", prepare the UX "Gerar ticket" and simulate or confirm the submission. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).uxTicket = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUxTicket(context) {
  "use strict";
  const { app, appState } = context;
  const MODAL = "modal-ticket-ux";
  const API = "/api/ux/gerar-ticket";
  const REGISTRO_MAX = 2500;
  const INTERNO_MAX = 10;
  // Same pattern as PLACEHOLDER in domains/ux_chamados.py: keep both in sync.
  const PLACEHOLDER = /\[[^\]\n]*\]|:[ \t]*$/m;
  // Single source of the "Deslocamento" text (it left the Home tabs). "Contato no local:" is filled from the delivery contact.
  const TEXTO_DESLOCAMENTO = [
    "Prezados,",
    "",
    "Solicito o deslocamento de um técnico à unidade do Sebrae para realizar a sanitização e configuração de um notebook para novo usuário.",
    "",
    "Ressalto que o procedimento deve ser realizado exclusivamente através do pendrive com a ISO padrão disponível no local, seguindo as etapas descritas na folha de configuração já compartilhada. Este é o procedimento padrão estipulado pelo cliente e devidamente previsto em edital.",
    "",
    "Em caso de dúvidas durante o processo, entre em contato com o responsável configurado para a retirada do equipamento.",
    "",
    "Contato no local:",
    "Colaborador(a) Novo(a):",
    "Data de Instalação:",
    "Horário da Instalação:",
    "",
    "Lembrando que é necessário o correto preenchimento do termo e anexá-lo ao chamado no fechamento.",
  ].join("\n");
  const CAMPOS = { nome: "ux-ticket-nome", email: "ux-ticket-email", telefone: "ux-ticket-telefone" };
  const byId = id => document.getElementById(id);
  let vigente = null;

  function textoDeslocamento(payload) {
    const contato = [payload?.entrega_contato, payload?.entrega_telefone].map(v => String(v || "").trim()).filter(Boolean).join(" - ");
    return contato ? TEXTO_DESLOCAMENTO.replace("Contato no local:", "Contato no local: " + contato) : TEXTO_DESLOCAMENTO;
  }

  function cepDaEntrega() {
    const valor = byId("select-unidade-destino")?.value;
    const unidade = (appState.unidadesList || []).find(item => String(item.id) === String(valor));
    return String(unidade?.cep || "").trim();
  }

  function post(etapa, dados) {
    return app.apiFetch(API + "/" + etapa, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dados), errorMessage: "Não foi possível continuar o ticket no UX.",
    });
  }

  // The server answers 409 for a session already gone (sent, expired or replaced): nothing left to cancel.
  function cancelarSessao(session_id) {
    if (session_id) void post("cancelar", { session_id }).catch(() => {});
  }

  const atual = pedido => vigente === pedido;
  const lerSolicitante = () => Object.fromEntries(Object.entries(CAMPOS).map(([campo, id]) => [campo, byId(id).value.trim()]));

  function mostrarEstado(estado, detalhe) {
    byId("ux-ticket-estado").textContent = estado;
    byId("ux-ticket-status-detalhe").textContent = detalhe ? " " + detalhe : "";
  }

  function mostrarErro(mensagem) {
    const alerta = byId("ux-ticket-erro");
    alerta.textContent = mensagem || "";
    alerta.hidden = !mensagem;
  }

  function motivoBloqueio(pedido) {
    if (!pedido) return "Gere a planilha no Transporte para preparar o ticket.";
    if (pedido.enviando) return "Envio em andamento: aguarde o resultado do UX.";
    if (pedido.ocupado) return "";
    if (!pedido.session_id) {
      if (pedido.concluido) return "Esta sessão do UX já foi usada. Gere a planilha de novo se precisar de outro ticket.";
      return "Simulação e finalização indisponíveis: a sessão do UX não está preparada. Use Preparar novamente.";
    }
    if (!pedido.dados?.endereco) return "Escolha e confirme o endereço para liberar a simulação e a finalização.";
    const registro = byId("ux-ticket-registro").value.trim();
    if (!registro) return "Preencha o Registro.";
    if (registro.length > REGISTRO_MAX) return "O Registro passa de " + REGISTRO_MAX + " caracteres.";
    if (PLACEHOLDER.test(registro)) return "Complete as linhas do Registro que terminam com “:” ou têm campos entre colchetes.";
    const solicitante = lerSolicitante();
    if (!Object.values(solicitante).every(Boolean)) return "Preencha Nome, E-mail e Contato do solicitante.";
    if (!/^[^@\s]+@[^@\s]+$/.test(solicitante.email)) return "Informe um E-mail válido para o solicitante.";
    if (byId("ux-ticket-chamado-interno").value.trim().length > INTERNO_MAX) return "O Nº de chamado interno aceita até " + INTERNO_MAX + " caracteres.";
    return "";
  }

  function controles() {
    const pedido = vigente;
    const ocupado = Boolean(pedido?.ocupado);
    const motivo = motivoBloqueio(pedido);
    const pronto = !ocupado && !motivo;
    const aviso = byId("ux-ticket-motivo");
    aviso.textContent = motivo;
    aviso.hidden = !motivo;
    for (const id of ["ux-ticket-simular", "ux-ticket-finalizar"]) {
      byId(id).disabled = !pronto;
      byId(id).title = pronto ? "" : motivo;
    }
    const editavel = Boolean(pedido?.session_id) && !ocupado;
    // The Registro and the solicitante stay editable after a failure, so nothing typed is lost before "Preparar novamente".
    byId("ux-ticket-formulario").disabled = !pedido || ocupado || Boolean(pedido.concluido);
    byId("ux-ticket-enderecos").disabled = !editavel;
    byId("ux-ticket-confirmar-endereco").disabled = !editavel || !byId("ux-ticket-enderecos").querySelector("input:checked");
    const tamanho = byId("ux-ticket-registro").value.length;
    byId("ux-ticket-registro-contador").textContent = tamanho + "/" + REGISTRO_MAX;
    // No retry while a request is in flight; "Preparar novamente" only after a failure, never automatically.
    byId("ux-ticket-preparar").hidden = ocupado || !pedido?.falha || pedido.incerto;
    byId("ux-ticket-conferido").hidden = ocupado || !pedido?.incerto;
    const cancelar = byId("ux-ticket-cancelar");
    cancelar.disabled = Boolean(pedido?.enviando);
    cancelar.textContent = pedido?.session_id || (ocupado && !pedido?.enviando) ? "Cancelar" : "Fechar";
    byId("ux-ticket-formulario").setAttribute("aria-busy", String(ocupado));
  }

  function atualizarTicketUX() {
    controles();
  }

  function definirTexto(id, valor) {
    byId(id).textContent = valor ? String(valor) : "—";
  }

  function renderizarResumo(pedido) {
    const dados = pedido.dados || {};
    definirTexto("ux-ticket-serie", dados.serial || pedido.corpo.serial);
    definirTexto("ux-ticket-modelo", dados.modelo);
    definirTexto("ux-ticket-endereco", dados.endereco);
    definirTexto("ux-ticket-cnpj-instalacao", dados.cnpj_instalacao || pedido.corpo.entrega_cnpj);
    definirTexto("ux-ticket-cnpj-faturamento", dados.cnpj_faturamento);
    definirTexto("ux-ticket-anexo", dados.arquivo);
    const ultimo = dados.ultimo_envio;
    const aviso = byId("ux-ticket-ultimo-envio");
    if (ultimo?.ticket) {
      const data = new Date(ultimo.data);
      const quando = Number.isNaN(data.getTime()) ? "" : " em " + data.toLocaleDateString("pt-BR");
      aviso.textContent = "Atenção: já há um ticket enviado para esta série (nº " + ultimo.ticket + quando + "). Confira no UX antes de prosseguir.";
    }
    aviso.hidden = !ultimo?.ticket;
  }

  function renderizarEnderecos(pedido) {
    const grupo = byId("ux-ticket-enderecos");
    const lista = byId("ux-ticket-enderecos-lista");
    const ambiguo = Boolean(pedido.session_id) && !pedido.dados?.endereco;
    const opcoes = ambiguo && Array.isArray(pedido.dados?.opcoes_endereco) ? pedido.dados.opcoes_endereco : [];
    lista.replaceChildren(...opcoes.map((texto, indice) => {
      const rotulo = document.createElement("label");
      rotulo.className = "ux-ticket-opcao";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "ux-ticket-endereco";
      radio.id = "ux-ticket-endereco-" + indice;
      radio.value = texto; // exact string from the UX: the server only accepts a listed option
      rotulo.append(radio, document.createTextNode(" " + texto));
      return rotulo;
    }));
    byId("ux-ticket-enderecos-vazio").hidden = !ambiguo || opcoes.length > 0;
    grupo.hidden = !ambiguo;
  }

  function aplicarPreparo(pedido, dados) {
    pedido.session_id = dados.session_id;
    pedido.dados = { ...pedido.dados, ...dados };
    pedido.falha = false;
    renderizarResumo(pedido);
    renderizarEnderecos(pedido);
    for (const [campo, id] of Object.entries(CAMPOS)) {
      if (!byId(id).value.trim()) byId(id).value = dados.solicitante?.[campo] || "";
    }
    if (pedido.dados.endereco) {
      mostrarEstado("Pronto para simular ou finalizar", "Revise o Registro e o solicitante; nada foi enviado ao UX.");
    } else if (pedido.dados.opcoes_endereco?.length) {
      mostrarEstado("Escolha o endereço", "O UX listou mais de um endereço para o CEP da unidade de entrega. Escolha o correto e confirme.");
    } else {
      pedido.falha = true;
      mostrarEstado("Escolha o endereço", "O UX não listou nenhum endereço para o CEP da unidade de entrega.");
    }
  }

  function falhar(pedido, erro) {
    pedido.falha = true;
    pedido.incerto = erro?.data?.codigo === "envio_incerto";
    mostrarEstado(pedido.incerto ? "Incerto — confira no UX" : "Erro", pedido.incerto
      ? "Confira no UX se o ticket anterior foi criado antes de preparar de novo."
      : "Corrija o que o aviso indica e use Preparar novamente.");
    mostrarErro(erro?.message || "Não foi possível continuar o ticket no UX.");
  }

  async function preparar(pedido, conferido) {
    pedido.ocupado = true;
    pedido.falha = false;
    pedido.incerto = false;
    pedido.concluido = false; // "Conferi no UX; preparar de novo" after an uncertain submission reopens the form
    pedido.session_id = null;
    mostrarErro("");
    mostrarEstado("Preparando no UX…", "Pode levar alguns minutos. Se o Chrome de automação pedir login, entre manualmente.");
    renderizarEnderecos(pedido);
    controles();
    try {
      const dados = await post("preparar", conferido ? { ...pedido.corpo, conferido: true } : pedido.corpo);
      if (!atual(pedido)) {
        cancelarSessao(dados?.session_id); // closed while preparing: do not leave the UX tab behind
        return;
      }
      aplicarPreparo(pedido, dados);
    } catch (erro) {
      if (atual(pedido)) falhar(pedido, erro);
    } finally {
      if (atual(pedido)) {
        pedido.ocupado = false;
        controles();
      }
    }
  }

  function limparModal(payload) {
    for (const id of ["ux-ticket-serie", "ux-ticket-modelo", "ux-ticket-endereco", "ux-ticket-cnpj-instalacao", "ux-ticket-cnpj-faturamento", "ux-ticket-anexo"]) {
      byId(id).textContent = "—";
    }
    byId("ux-ticket-serie").textContent = payload.serial || "—";
    byId("ux-ticket-ultimo-envio").hidden = true;
    byId("ux-ticket-enderecos").hidden = true;
    byId("ux-ticket-enderecos-lista").replaceChildren();
    byId("ux-ticket-registro").value = textoDeslocamento(payload);
    for (const id of Object.values(CAMPOS)) byId(id).value = "";
    byId("ux-ticket-chamado-interno").value = "";
    mostrarErro("");
  }

  async function prepararTicketUX(payload) {
    try {
      if (!payload?.serial) return;
      if (vigente?.ocupado) {
        app.showToast("Já há um ticket em preparação no UX. Aguarde o resultado ou cancele antes de gerar outro.", "warning");
        return;
      }
      encerrar();
      const entrega_cep = cepDaEntrega();
      const pedido = vigente = { corpo: { ...payload, entrega_cep }, dados: null, session_id: null };
      limparModal(payload);
      app.abrirModalAcessivel(MODAL, "#ux-ticket-cancelar", "fecharTicketUX");
      if (entrega_cep.replace(/\D/g, "").length !== 8) {
        pedido.falha = true;
        mostrarEstado("Erro", "O ticket não foi preparado.");
        mostrarErro("A unidade de entrega não tem CEP com 8 dígitos no cadastro de unidades. Corrija o CEP da unidade e gere a planilha de novo.");
        controles();
        return;
      }
      await preparar(pedido, false);
    } catch (erro) {
      // Optional step after the download: never let it break the transfer flow.
      console.error("Erro ao preparar o ticket no UX:", erro);
    }
  }

  function encerrar() {
    if (!vigente) return;
    const encerrado = vigente;
    vigente = null;
    cancelarSessao(encerrado.session_id);
  }

  function fecharTicketUX() {
    if (vigente?.enviando) {
      controles(); // the reason stays visible; closing now could hide a ticket being submitted
      return;
    }
    encerrar();
    app.fecharModalAcessivel(MODAL);
  }

  function prepararNovamenteTicketUX() {
    if (vigente && !vigente.ocupado && vigente.falha && !vigente.incerto) return preparar(vigente, false);
  }

  function conferirTicketUX() {
    if (vigente && !vigente.ocupado && vigente.incerto) return preparar(vigente, true);
  }

  async function confirmarEnderecoTicketUX() {
    const pedido = vigente;
    const escolhido = byId("ux-ticket-enderecos").querySelector("input:checked");
    if (!pedido?.session_id || pedido.ocupado || !escolhido) return;
    pedido.ocupado = true;
    mostrarErro("");
    controles();
    try {
      const dados = await post("escolher-endereco", { session_id: pedido.session_id, serial: pedido.dados.serial, endereco: escolhido.value });
      if (!atual(pedido)) return;
      aplicarPreparo(pedido, dados); // the answer carries only status/endereco: merge with the prepared data
    } catch (erro) {
      if (atual(pedido)) {
        mostrarEstado("Erro", "O endereço não foi confirmado.");
        mostrarErro(erro.message);
      }
    } finally {
      if (atual(pedido)) {
        pedido.ocupado = false;
        controles();
      }
    }
  }

  async function executarTicketUX(enviar) {
    const pedido = vigente;
    if (!pedido || pedido.ocupado || motivoBloqueio(pedido)) return;
    const { session_id } = pedido;
    const serial = pedido.dados.serial;
    const descricao = byId("ux-ticket-registro").value.trim();
    const solicitante = lerSolicitante();
    const chamado_interno = byId("ux-ticket-chamado-interno").value.trim();
    pedido.ocupado = true;
    controles();
    try {
      if (enviar) {
        const confirmou = await app.confirmarAcao({
          titulo: "Finalizar ticket no UX",
          mensagem: "Série: " + serial + "\nEndereço: " + pedido.dados.endereco
            + "\nSolicitante: " + solicitante.nome + " · " + solicitante.email + " · " + solicitante.telefone
            + (chamado_interno ? "\nNº de chamado interno: " + chamado_interno : "") + "\n\n" + descricao,
          confirmar: "Finalizar ticket",
        });
        if (!confirmou || !atual(pedido)) return;
        pedido.enviando = true;
        controles();
      }
      mostrarErro("");
      mostrarEstado(enviar ? "Finalizando no UX…" : "Simulando no UX…", enviar
        ? "Não feche esta janela até o resultado."
        : "Preenchendo o formulário no Chrome de automação.");
      const dados = await post("enviar", { session_id, serial, descricao, solicitante, chamado_interno, enviar, confirmado: enviar });
      if (!atual(pedido)) return;
      if (dados.status === "preenchido") {
        mostrarEstado("Simulado", "Confira o formulário no Chrome de automação. Nenhum ticket foi enviado.");
      } else if (dados.status === "enviado" && dados.ticket) {
        pedido.session_id = null;
        pedido.concluido = true;
        mostrarEstado("Enviado", "Ticket nº " + dados.ticket + ".");
        app.showToast("Ticket enviado. Nº " + dados.ticket + ".", "success");
      } else if (dados.status === "incerto") {
        pedido.session_id = null;
        pedido.concluido = true;
        pedido.incerto = true;
        mostrarEstado("Incerto — confira no UX", dados.mensagem || "Confira no UX se o ticket foi criado.");
      } else {
        throw new Error("O UX não confirmou o resultado.");
      }
    } catch (erro) {
      if (!atual(pedido)) return;
      if (enviar && !erro.status) {
        // No answer after the submission started: never retry automatically.
        pedido.session_id = null;
        pedido.concluido = true;
        pedido.incerto = true;
        mostrarEstado("Incerto — confira no UX", "Não foi possível receber o resultado. Confira no UX se o ticket foi criado antes de tentar de novo.");
        mostrarErro(erro.message);
      } else {
        falhar(pedido, erro);
        if (erro.data?.codigo === "envio_incerto") pedido.session_id = null;
      }
    } finally {
      if (atual(pedido)) {
        pedido.ocupado = false;
        pedido.enviando = false;
        controles();
      }
    }
  }

  // Listener stays sync and swallows everything: the download and the other listeners never depend on the ticket.
  document.addEventListener("simpress:transfer-generated", event => {
    try {
      void prepararTicketUX(event?.detail?.payload);
    } catch (erro) {
      console.error("Erro ao preparar o ticket no UX:", erro);
    }
  });

  return {
    fecharTicketUX, atualizarTicketUX, prepararNovamenteTicketUX, conferirTicketUX,
    confirmarEnderecoTicketUX, executarTicketUX,
  };
});
