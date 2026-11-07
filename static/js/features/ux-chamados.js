/** Home ticket templates: prepare a session, then simulate or confirm the UX submission. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).uxChamados = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUxChamados(context) {
  "use strict";
  const { app, appState } = context;
  const MODAL = "modal-chamado-ux";
  const API = "/api/ux/abrir-chamado";
  const byId = id => document.getElementById(id);
  let vigente = null;

  function contextoChamadoUX() {
    const serial = String(appState.currentEquipamento?.serial || "").trim().toUpperCase();
    const [campo] = JSON.parse(byId("btn-copiar-chamado-atual")?.dataset.args || "[]");
    return { serial, descricao: byId(campo)?.value.trim() || "", revisao: appState.equipamentoSelectionRevision };
  }

  function post(etapa, dados) {
    return app.apiFetch(API + "/" + etapa, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dados), errorMessage: "Não foi possível continuar o chamado no UX.",
    });
  }

  function cancelarSessaoUX(session_id) {
    if (session_id) void post("cancelar", { session_id }).catch(() => {});
  }

  function fecharChamadoUX() {
    if (!vigente) return;
    const encerrado = vigente;
    vigente = null;
    cancelarSessaoUX(encerrado.session_id);
    byId("ux-chamado-descricao").textContent = "";
    app.fecharModalAcessivel(MODAL);
  }

  function atual(pedido) {
    return vigente === pedido && appState.equipamentoSelectionRevision === pedido.revisao;
  }

  function controles(ocupado) {
    const preparado = !!vigente?.session_id;
    const pronto = !ocupado && preparado && !!byId("ux-chamado-problema").value;
    // The reason stays visible (and linked by aria-describedby) while the two actions are disabled.
    const motivo = ocupado || pronto ? "" : preparado
      ? "Escolha um problema para liberar a simulação e o envio."
      : vigente?.falha
        ? "Simulação e envio indisponíveis: a preparação no UX não foi concluída. A descrição foi mantida; corrija o que a mensagem acima indica e abra o chamado de novo."
        : "Simulação e envio indisponíveis: esta sessão do UX já foi usada. Abra o chamado de novo se precisar.";
    const aviso = byId("ux-chamado-motivo");
    aviso.textContent = motivo;
    aviso.hidden = !motivo;
    byId("ux-chamado-problema").disabled = ocupado || !preparado;
    for (const id of ["ux-chamado-simular", "ux-chamado-enviar"]) {
      byId(id).disabled = !pronto;
      byId(id).title = pronto ? "" : motivo;
    }
    byId("ux-chamado-problema").setAttribute("aria-busy", String(ocupado));
  }

  function atualizarProblemaChamadoUX() {
    controles(Boolean(vigente?.ocupado));
  }

  async function preparar(pedido, conferido) {
    const status = byId("ux-chamado-status");
    byId("ux-chamado-conferido").hidden = true;
    pedido.falha = false;
    status.textContent = "Preparando no UX… Se o Chrome de automação pedir login, entre manualmente.";
    pedido.ocupado = true;
    controles(true);
    try {
      const dados = await post("preparar", { serial: pedido.serial, conferido });
      if (!atual(pedido) || dados.serial !== pedido.serial) {
        cancelarSessaoUX(dados.session_id);
        return;
      }
      pedido.session_id = dados.session_id;
      const seletor = byId("ux-chamado-problema");
      seletor.replaceChildren(...["", ...dados.opcoes].map(texto => {
        const opcao = document.createElement("option");
        opcao.value = texto;
        opcao.textContent = texto || "Escolha um problema";
        return opcao;
      }));
      byId("ux-chamado-modelo").textContent = dados.modelo;
      status.textContent = dados.ultimo_envio
        ? "Atenção: já há um chamado enviado para esta série (OS " + dados.ultimo_envio.os + "). Confira antes de prosseguir."
        : "Escolha um problema para simular ou enviar.";
      seletor.disabled = false;
      seletor.focus();
    } catch (erro) {
      if (!atual(pedido)) return;
      pedido.falha = true;
      status.textContent = erro.message;
      byId("ux-chamado-conferido").hidden = erro.data?.codigo !== "envio_incerto";
    } finally {
      if (atual(pedido)) {
        pedido.ocupado = false;
        controles(false);
      }
    }
  }

  function abrirChamadoUX() {
    const contexto = contextoChamadoUX();
    if (!contexto.serial) return;
    // Same pattern as PLACEHOLDER in domains/ux_chamados.py: keep both in sync.
    if (!contexto.descricao || /\[[^\]\n]*\]|:[ \t]*$/m.test(contexto.descricao)) {
      app.showToast("Preencha a descrição e substitua os campos em branco ou entre colchetes.", "warning");
      return;
    }
    fecharChamadoUX();
    const pedido = vigente = contexto;
    byId("ux-chamado-serie").textContent = pedido.serial;
    byId("ux-chamado-modelo").textContent = "—";
    byId("ux-chamado-descricao").textContent = pedido.descricao;
    byId("ux-chamado-problema").replaceChildren();
    app.abrirModalAcessivel(MODAL, "#ux-chamado-fechar", "fecharChamadoUX");
    return preparar(pedido, false);
  }

  function conferirChamadoUX() {
    if (vigente && !vigente.ocupado && !vigente.session_id && !byId("ux-chamado-conferido").hidden) {
      return preparar(vigente, true);
    }
  }

  async function executarChamadoUX(enviar) {
    const pedido = vigente;
    const problema = byId("ux-chamado-problema").value;
    if (!pedido?.session_id || pedido.ocupado || !problema || !atual(pedido)) return;
    const { session_id, serial, descricao } = pedido;
    pedido.ocupado = true;
    controles(true);
    const status = byId("ux-chamado-status");
    try {
      if (enviar) {
        const confirmou = await app.confirmarAcao({
          titulo: "Confirmar chamado no UX",
          mensagem: "Série: " + serial + "\nProblema: " + problema + "\n\n" + descricao,
          confirmar: "Enviar solicitação",
        });
        if (!confirmou || !atual(pedido)) return;
      }
      status.textContent = enviar ? "Enviando a solicitação ao UX…" : "Preenchendo o formulário no Chrome de automação…";
      const dados = await post("enviar", { session_id, serial, problema, descricao, enviar, confirmado: enviar });
      if (!atual(pedido)) return;
      if (dados.status === "preenchido") {
        status.textContent = "Simulação concluída. Confira o formulário no Chrome de automação. Nenhuma solicitação foi enviada.";
      } else if (dados.status === "enviado" && dados.os) {
        pedido.session_id = null;
        status.textContent = "Chamado enviado. OS #" + dados.os + ".";
        app.showToast(status.textContent, "success");
      } else if (dados.status === "incerto") {
        pedido.session_id = null;
        status.textContent = dados.mensagem;
        byId("ux-chamado-conferido").hidden = false;
      } else {
        throw new Error("O UX não confirmou o resultado.");
      }
    } catch (erro) {
      if (!atual(pedido)) return;
      if (enviar && !erro.status) {
        pedido.session_id = null;
        status.textContent = "Não foi possível receber o resultado. Confira no UX se a solicitação foi criada antes de tentar novamente.";
        byId("ux-chamado-conferido").hidden = false;
      } else {
        status.textContent = erro.message;
      }
    } finally {
      if (atual(pedido)) {
        pedido.ocupado = false;
        controles(false);
      }
    }
  }

  return {
    abrirChamadoUX, fecharChamadoUX, atualizarProblemaChamadoUX, conferirChamadoUX,
    executarChamadoUX, contextoChamadoUX,
  };
});

