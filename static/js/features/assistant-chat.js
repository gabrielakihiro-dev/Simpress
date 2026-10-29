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
  // Mensagem de voz: o navegador grava, converte para WAV mono de 16 kHz e o servidor devolve só o texto.
  const TAXA_WAV = 16000;
  const LIMITE_SEGUNDOS = 120;
  let gravando = false;
  let transcrevendo = false;
  let cancelado = false;
  let gravador = null;
  let fluxo = null;
  let pedacos = [];
  let temporizador = 0;
  let inicioGravacao = 0;
  // Globo e voz: o globo mostra o estado (parado, ouvindo, pensando, falando); a fala usa uma voz em português instalada no computador (nada sai dele).
  const CHAVE_VOZ = "simpress:assistente-voz";
  let vozLigada = lerPreferenciaVoz();
  let falando = false;
  let sequenciaFala = 0;
  let contextoAudio = null;
  let analisador = null;
  let amostrasNivel = null;
  let nivelMicrofone = 0;
  let quadro = 0;
  let giro = 0;
  let ultimoQuadro = 0;

  const byId = id => document.getElementById(id);

  function lerPreferenciaVoz() {
    try { return window.localStorage.getItem(CHAVE_VOZ) === "true"; } catch { return false; }
  }

  function guardarPreferenciaVoz() {
    try { window.localStorage.setItem(CHAVE_VOZ, String(vozLigada)); } catch { /* sem armazenamento: vale só nesta sessão */ }
  }

  // Só voz local: as vozes "online" do navegador enviariam o texto das respostas para fora do computador.
  function vozPortuguesa() {
    const locais = (window.speechSynthesis?.getVoices?.() || []).filter(voz => voz.localService && /^pt/i.test(voz.lang));
    return locais.find(voz => /br/i.test(voz.lang)) || locais[0] || null;
  }

  function atualizarVoz() {
    const botao = byId("assistente-voz");
    botao.disabled = !window.speechSynthesis;
    botao.setAttribute("aria-pressed", String(vozLigada && !botao.disabled));
  }

  function pararFala() {
    sequenciaFala += 1;
    window.speechSynthesis?.cancel();
    falando = false;
    atualizarGlobo();
  }

  function falar(texto) {
    const sintese = window.speechSynthesis;
    if (!vozLigada || !sintese || !texto.trim()) return;
    const voz = vozPortuguesa();
    if (!voz) {
      mostrarStatus("Não há voz em português instalada neste computador. Instale uma nos idiomas do Windows.");
      return;
    }
    sintese.cancel();
    const id = ++sequenciaFala;
    // shortcut: trechos de até 200 caracteres porque o Chrome corta falas longas; sem pausa inteligente, melhorar se incomodar.
    const trechos = (texto.match(/[^.!?\n]{1,200}[.!?]*/g) || []).map(trecho => trecho.trim()).filter(Boolean);
    trechos.forEach((trecho, indice) => {
      const fala = new SpeechSynthesisUtterance(trecho);
      fala.voice = voz;
      fala.lang = voz.lang;
      if (indice === 0) fala.onstart = () => { if (id === sequenciaFala) { falando = true; atualizarGlobo(); } };
      if (indice === trechos.length - 1) fala.onend = fala.onerror = () => { if (id === sequenciaFala) { falando = false; atualizarGlobo(); } };
      sintese.speak(fala);
    });
  }

  function alternarVozAssistente() {
    vozLigada = !vozLigada;
    guardarPreferenciaVoz();
    if (vozLigada) {
      if (!vozPortuguesa()) mostrarStatus("Voz ligada, mas não há voz em português instalada neste computador.");
    } else pararFala();
    atualizarVoz();
  }

  const movimentoReduzido = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  function estadoDoGlobo() {
    if (gravando) return "ouvindo";
    if (ocupado || transcrevendo) return "pensando";
    return falando ? "falando" : "parado";
  }

  function lerNivelMicrofone() {
    if (!analisador) { nivelMicrofone = 0; return; }
    analisador.getByteTimeDomainData(amostrasNivel);
    let soma = 0;
    for (const amostra of amostrasNivel) soma += ((amostra - 128) / 128) ** 2;
    nivelMicrofone += (Math.min(1, Math.sqrt(soma / amostrasNivel.length) * 4) - nivelMicrofone) * 0.3;
  }

  // Globo de arame (contorno, meridianos que giram e paralelos) na cor de destaque do tema; o raio acompanha o volume ou o ritmo do estado.
  function desenharGlobo(agora) {
    const tela = byId("assistente-globo");
    const g = tela.getContext("2d");
    if (!g) return;
    const estado = tela.dataset.estado;
    const parado = movimentoReduzido();
    const t = parado ? 0 : agora / 1000;
    const velocidade = { parado: 0.4, ouvindo: 0.9, pensando: 3, falando: 1.4 }[estado];
    giro += parado ? 0 : Math.min(0.1, (agora - ultimoQuadro) / 1000) * velocidade;
    ultimoQuadro = agora;
    const nivel = {
      parado: 0.04 * Math.sin(t * 1.6),
      ouvindo: nivelMicrofone,
      pensando: 0.12 + 0.08 * Math.sin(t * 5),
      falando: 0.28 + 0.2 * Math.abs(Math.sin(t * 9)),
    }[estado];
    const lado = tela.width;
    const centro = lado / 2;
    const raio = centro * 0.6 * (1 + nivel * 0.5);
    const traco = (rx, ry, y = 0) => { g.beginPath(); g.ellipse(centro, centro + y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, 2 * Math.PI); g.stroke(); };
    g.clearRect(0, 0, lado, lado);
    g.fillStyle = g.strokeStyle = getComputedStyle(tela).color;
    g.lineWidth = lado / 40;
    g.globalAlpha = 0.06 + nivel * 0.2;
    g.beginPath(); g.arc(centro, centro, raio * 1.4, 0, 2 * Math.PI); g.fill();
    g.beginPath(); g.arc(centro, centro, raio * 1.18, 0, 2 * Math.PI); g.fill();
    g.globalAlpha = 0.95;
    traco(raio, raio);
    g.globalAlpha = 0.6;
    for (let i = 0; i < 3; i += 1) traco(raio * Math.abs(Math.cos(giro + (i * Math.PI) / 3)), raio);
    g.globalAlpha = 0.45;
    traco(raio, raio * 0.25);
    for (const y of [-0.55, 0.55]) { const meia = Math.sqrt(1 - y * y) * raio; traco(meia, meia * 0.25, y * raio); }
    g.globalAlpha = 0.9;
    g.beginPath(); g.arc(centro, centro, raio * 0.16 * (1 + nivel), 0, 2 * Math.PI); g.fill();
    g.globalAlpha = 1;
  }

  function animarGlobo(agora) {
    quadro = 0;
    if (!painelVisivel()) { pararFala(); return; }
    lerNivelMicrofone();
    desenharGlobo(agora);
    if (!movimentoReduzido()) quadro = requestAnimationFrame(animarGlobo);
  }

  // Com movimento reduzido o globo não anima: só é redesenhado (parado) quando o estado muda.
  function atualizarGlobo() {
    byId("assistente-globo").dataset.estado = estadoDoGlobo();
    if (!painelVisivel()) return;
    if (movimentoReduzido()) desenharGlobo(0);
    else if (!quadro) quadro = requestAnimationFrame(animarGlobo);
  }

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
    byId("assistente-texto").disabled = bloqueado || transcrevendo;
    byId("assistente-enviar").disabled = bloqueado || gravando || transcrevendo;
    // Durante a gravação o botão continua ativo: é ele que para.
    const botaoGravar = byId("assistente-gravar");
    botaoGravar.disabled = !gravando && (bloqueado || transcrevendo);
    const segundos = Math.floor((Date.now() - inicioGravacao) / 1000);
    byId("assistente-gravar-rotulo").textContent = gravando
      ? `Parar (${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")})`
      : transcrevendo ? "Transcrevendo…" : "Gravar áudio";
    byId("assistente-nova").disabled = ocupado;
    byId("assistente-confirmar").disabled = ocupado;
    byId("assistente-cancelar").disabled = ocupado;
    byId("assistente-mensagens").setAttribute("aria-busy", String(ocupado));
    atualizarGlobo();
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
    falar(texto);
  }

  // As respostas podem levar até ~90 s; enquanto isso a entrada fica bloqueada.
  async function enviarAoAssistente(url, corpo, textoParaDevolver = "") {
    pararFala();
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
    window.speechSynthesis?.getVoices?.(); // o Chrome só carrega a lista de vozes na primeira consulta
    atualizarVoz();
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

  function paraWav(amostras) {
    const dados = new DataView(new ArrayBuffer(44 + amostras.length * 2));
    const texto = (posicao, valor) => [...valor].forEach((letra, i) => dados.setUint8(posicao + i, letra.charCodeAt(0)));
    texto(0, "RIFF");
    dados.setUint32(4, 36 + amostras.length * 2, true);
    texto(8, "WAVEfmt ");
    dados.setUint32(16, 16, true);
    dados.setUint16(20, 1, true); // PCM
    dados.setUint16(22, 1, true); // mono
    dados.setUint32(24, TAXA_WAV, true);
    dados.setUint32(28, TAXA_WAV * 2, true);
    dados.setUint16(32, 2, true);
    dados.setUint16(34, 16, true);
    texto(36, "data");
    dados.setUint32(40, amostras.length * 2, true);
    amostras.forEach((valor, i) => dados.setInt16(44 + i * 2, Math.max(-1, Math.min(1, valor)) * 0x7fff, true));
    return dados.buffer;
  }

  async function gravacaoParaWav(blob) {
    const contexto = new AudioContext();
    let audio;
    try { audio = await contexto.decodeAudioData(await blob.arrayBuffer()); } finally { void contexto.close(); }
    // O OfflineAudioContext já converte para mono e reamostra para 16 kHz.
    const saida = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * TAXA_WAV)), TAXA_WAV);
    const fonte = saida.createBufferSource();
    fonte.buffer = audio;
    fonte.connect(saida.destination);
    fonte.start();
    const pronto = await saida.startRendering();
    return paraWav(pronto.getChannelData(0).subarray(0, LIMITE_SEGUNDOS * TAXA_WAV));
  }

  async function transcreverGravacao(blob) {
    transcrevendo = true;
    mostrarStatus("Transcrevendo…");
    atualizarControles();
    try {
      const wav = await gravacaoParaWav(blob);
      const dados = await apiFetch("/api/assistente/audio", {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: wav,
        errorMessage: "Não foi possível transcrever o áudio.",
      });
      const texto = String(dados?.texto ?? "").trim();
      if (!texto) {
        mostrarStatus("Não ouvi nenhuma fala. Tente gravar de novo.");
      } else {
        const campo = byId("assistente-texto");
        campo.value = (campo.value.trim() ? `${campo.value.trimEnd()} ${texto}` : texto).slice(0, LIMITE);
        contarMensagemAssistente();
        mostrarStatus("Áudio transcrito. Revise o texto e envie.");
      }
    } catch (error) {
      if (error?.status === 503) online = false;
      mostrarStatus(error?.status ? error.message : "Não foi possível processar o áudio gravado.", error?.status === 503);
    } finally {
      transcrevendo = false;
      atualizarControles();
      focarProximo();
    }
  }

  function encerrarGravacao() {
    clearInterval(temporizador);
    fluxo?.getTracks().forEach(faixa => faixa.stop());
    fluxo = null;
    void contextoAudio?.close();
    contextoAudio = null;
    analisador = null;
    gravador = null;
    gravando = false;
  }

  function aoParar() {
    const blob = new Blob(pedacos, { type: gravador?.mimeType || "audio/webm" });
    pedacos = [];
    encerrarGravacao();
    if (cancelado || !blob.size) {
      if (online) statusPronto();
      atualizarControles();
      focarProximo();
      return;
    }
    void transcreverGravacao(blob);
  }

  function pararGravacao() {
    if (gravador?.state === "recording") gravador.stop();
  }

  function cancelarGravacao() {
    cancelado = true;
    pararGravacao();
  }

  function tiqueGravacao() {
    if (!painelVisivel()) cancelarGravacao();
    else if (Date.now() - inicioGravacao >= LIMITE_SEGUNDOS * 1000) pararGravacao();
    else atualizarControles();
  }

  async function iniciarGravacao() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      mostrarStatus("Este navegador não permite gravar áudio.");
      return;
    }
    pararFala(); // para o microfone não captar a própria voz do Assistente
    gravando = true; // bloqueia novo clique enquanto o navegador pede permissão
    cancelado = false;
    inicioGravacao = Date.now();
    atualizarControles();
    try {
      fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      gravando = false;
      mostrarStatus("Não consegui usar o microfone. Libere o acesso nas permissões do navegador.");
      atualizarControles();
      return;
    }
    // Esc ou fechar o painel enquanto o navegador pedia permissão: não começa a gravar.
    if (cancelado || !painelVisivel()) {
      encerrarGravacao();
      if (online) statusPronto();
      atualizarControles();
      return;
    }
    try {
      contextoAudio = new AudioContext();
      analisador = contextoAudio.createAnalyser();
      analisador.fftSize = 256;
      amostrasNivel = new Uint8Array(analisador.fftSize);
      contextoAudio.createMediaStreamSource(fluxo).connect(analisador);
    } catch {
      analisador = null; // sem medidor o globo só respira; a gravação segue
    }
    pedacos = [];
    gravador = new MediaRecorder(fluxo);
    gravador.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
    gravador.onstop = aoParar;
    inicioGravacao = Date.now();
    gravador.start();
    temporizador = setInterval(tiqueGravacao, 250);
    mostrarStatus(`Gravando… fale e clique em Parar (máximo ${LIMITE_SEGUNDOS} s). Esc cancela.`);
    atualizarControles();
  }

  function alternarGravacaoAssistente() {
    if (gravando) return pararGravacao();
    if (!online || ocupado || pendente || transcrevendo) return;
    return iniciarGravacao();
  }

  function enviarMensagemAssistente() {
    if (!online || ocupado || pendente || gravando || transcrevendo) return;
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
    pararFala();
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
    if (event.key === "Escape" && gravando) {
      event.preventDefault();
      cancelarGravacao();
    } else if (event.key === "Escape" && pendente && !ocupado) {
      event.preventDefault();
      void cancelarPendenteAssistente();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.target?.id === "assistente-texto") {
      event.preventDefault();
      void enviarMensagemAssistente();
    }
  }

  return {
    carregarAssistente, enviarMensagemAssistente, confirmarPendenteAssistente, cancelarPendenteAssistente,
    novaConversaAssistente, contarMensagemAssistente, teclaAssistente, alternarGravacaoAssistente, alternarVozAssistente,
  };
});
