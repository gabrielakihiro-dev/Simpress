/** Assistente: conversa com a IA do Simpress (OpenRouter, chamada pelo servidor local) pelas rotas /api/assistente/*, no painel F9 do Cockpit. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).assistantChat = factory;
})(typeof window !== "undefined" ? window : globalThis, function createAssistantChat(context) {
  "use strict";
  const { apiFetch } = context;
  const { createTextElement } = context.dom;
  const LIMITE = 4000;
  const DESLIGADO = "Assistente desligado. Preencha OPENROUTER_API_KEY no arquivo .env da pasta do Simpress.";
  // Reserva caso o estado traga a pendência sem a descrição da ação.
  const PENDENTE_SEM_DESCRICAO = "Há uma ação aguardando sua confirmação.";
  let online = false;
  let modelo = "";
  let ocupado = false;
  let pendente = false;

  const byId = id => document.getElementById(id);

  function painelVisivel() {
    const painel = document.querySelector('[data-cockpit-tool-panel="assistente"]');
    return Boolean(painel && !painel.hidden && !byId("cockpit-tool-panels")?.hidden);
  }

  function mostrarStatus(texto, oferecerNovaTentativa = false) {
    byId("assistente-status").textContent = texto;
    byId("assistente-tentar").hidden = !oferecerNovaTentativa;
  }

  function statusPronto() {
    mostrarStatus(modelo ? `Assistente pronto · ${modelo}` : "Assistente pronto.");
  }

  function atualizarControles() {
    const bloqueado = !online || ocupado || pendente;
    byId("assistente-texto").disabled = bloqueado;
    byId("assistente-enviar").disabled = bloqueado;
    byId("assistente-nova").disabled = ocupado;
    byId("assistente-confirmar").disabled = ocupado;
    byId("assistente-cancelar").disabled = ocupado;
    byId("assistente-mensagens").setAttribute("aria-busy", String(ocupado));
  }

  function contarMensagemAssistente() {
    byId("assistente-contador").textContent = `${byId("assistente-texto").value.length} / ${LIMITE}`;
  }

  // Todo texto vindo do usuário ou do Assistente entra como textContent, nunca como HTML.
  function adicionarMensagem(autor, texto, ferramentas = []) {
    const item = document.createElement("div");
    item.className = `ck-assist__msg ck-assist__msg--${autor}`;
    item.append(createTextElement("span", "ck-sr", autor === "usuario" ? "Você:" : "Assistente:"));
    item.append(createTextElement("p", "ck-assist__texto", texto));
    if (ferramentas.length) item.append(createTextElement("p", "ck-assist__ferramentas", `Ferramentas: ${ferramentas.join(", ")}`));
    const lista = byId("assistente-mensagens");
    lista.append(item);
    lista.scrollTop = lista.scrollHeight;
  }

  function mostrarPendente(descricao) {
    pendente = descricao !== null;
    byId("assistente-pendente-descricao").textContent = descricao ?? "";
    byId("assistente-pendente").hidden = !pendente;
  }

  function focarProximo() {
    if (!painelVisivel()) return;
    if (pendente) byId("assistente-pendente").focus();
    else if (online) byId("assistente-texto").focus();
  }

  function mostrarResposta(dados) {
    const texto = String(dados?.texto ?? "");
    const ferramentas = Array.isArray(dados?.ferramentas) ? dados.ferramentas.map(String).filter(Boolean) : [];
    if (texto || ferramentas.length) adicionarMensagem("assistente", texto, ferramentas);
    byId("assistente-anuncio").textContent = texto;
    mostrarPendente(dados?.pendente ? String(dados.pendente.descricao ?? "") || PENDENTE_SEM_DESCRICAO : null);
    statusPronto();
  }

  // As respostas podem levar até ~90 s; enquanto isso a entrada fica bloqueada.
  async function enviarAoAssistente(url, corpo, textoParaDevolver = "") {
    ocupado = true;
    mostrarStatus("Pensando…");
    atualizarControles();
    try {
      const dados = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        errorMessage: "Não foi possível falar com o Assistente.",
      });
      mostrarResposta(dados);
    } catch (error) {
      if (error?.status === 503) online = false;
      mostrarStatus(error?.message || "Não foi possível falar com o Assistente.", error?.status === 503);
      // Não perde o texto digitado quando o envio falha.
      const campo = byId("assistente-texto");
      if (textoParaDevolver && !campo.value) { campo.value = textoParaDevolver; contarMensagemAssistente(); }
    } finally {
      ocupado = false;
      atualizarControles();
      focarProximo();
    }
  }

  async function carregarAssistente() {
    if (ocupado) return;
    mostrarStatus("Verificando o Assistente…", !byId("assistente-tentar").hidden);
    try {
      const estado = await apiFetch("/api/assistente/estado", { errorMessage: "Não foi possível verificar o Assistente." });
      online = Boolean(estado?.online);
      modelo = String(estado?.modelo ?? "");
      if (online) statusPronto();
      else mostrarStatus(DESLIGADO, true);
      if (online && estado?.aguardando_confirmacao) mostrarPendente(String(estado?.pendente?.descricao ?? "") || PENDENTE_SEM_DESCRICAO);
      else if (online && !estado?.aguardando_confirmacao && pendente) mostrarPendente(null);
    } catch (error) {
      online = false;
      mostrarStatus(error?.message || DESLIGADO, true);
    }
    atualizarControles();
    if (pendente || document.activeElement === byId("assistente-tentar") || !document.activeElement || document.activeElement === document.body) focarProximo();
  }

  function enviarMensagemAssistente() {
    if (!online || ocupado || pendente) return;
    const campo = byId("assistente-texto");
    const texto = campo.value.trim();
    if (!texto) { campo.focus(); return; }
    if (texto.length > LIMITE) { mostrarStatus(`A mensagem passa de ${LIMITE} caracteres.`); return; }
    adicionarMensagem("usuario", texto);
    campo.value = "";
    contarMensagemAssistente();
    return enviarAoAssistente("/api/assistente/mensagem", { texto }, texto);
  }

  function responderPendente(confirmado) {
    if (!pendente || ocupado) return;
    adicionarMensagem("usuario", confirmado ? "Confirmar e executar" : "Cancelar");
    return enviarAoAssistente("/api/assistente/confirmar", { confirmado });
  }

  function confirmarPendenteAssistente() { return responderPendente(true); }
  function cancelarPendenteAssistente() { return responderPendente(false); }

  async function novaConversaAssistente() {
    if (ocupado) return;
    try {
      await apiFetch("/api/assistente/limpar", { method: "POST", errorMessage: "Não foi possível iniciar uma nova conversa." });
      byId("assistente-mensagens").replaceChildren();
      byId("assistente-anuncio").textContent = "";
      mostrarPendente(null);
      if (online) statusPronto();
    } catch (error) {
      mostrarStatus(error?.message || "Não foi possível iniciar uma nova conversa.");
    }
    atualizarControles();
    focarProximo();
  }

  // Enter envia e Shift+Enter quebra a linha; com ação pendente, Esc cancela em vez de fechar o painel.
  function teclaAssistente(event) {
    if (event.key === "Escape" && pendente && !ocupado) {
      event.preventDefault();
      void cancelarPendenteAssistente();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.target?.id === "assistente-texto") {
      event.preventDefault();
      void enviarMensagemAssistente();
    }
  }

  return {
    carregarAssistente, enviarMensagemAssistente, confirmarPendenteAssistente, cancelarPendenteAssistente,
    novaConversaAssistente, contarMensagemAssistente, teclaAssistente,
  };
});
