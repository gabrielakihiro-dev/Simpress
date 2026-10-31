/** Assistente: conversa com a IA do Simpress (OpenRouter, chamada pelo servidor local) pelas rotas /api/assistente/*, no chat flutuante (F9). */
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
  // Envio em andamento (AbortController + motivo do aborto); o navegador desiste um pouco depois do orçamento de 90 s do servidor.
  const PRAZO_ENVIO_MS = 100000;
  const MSG_PRAZO = "O Assistente demorou demais para responder. Se havia uma ação pendente, confira o cartão antes de tentar de novo.";
  const MSG_CANCELADO = "Envio cancelado. Se o Assistente ainda estiver terminando, aguarde alguns segundos antes de enviar de novo.";
  const MSG_CONVERSA_OCUPADA = "O Assistente ainda está terminando a resposta anterior. Aguarde alguns segundos e tente de novo.";
  let envioAtual = null;
  let botaoCancelar = null;
  // Instruções permanentes: texto do usuário guardado no servidor; só edita depois de carregar, para um erro de leitura nunca apagar o salvo.
  let instrucoesCarregadas = false;
  let instrucoesOcupadas = false;
  // Busca na web: interruptor guardado no servidor (desligado por padrão); o card de fonte vem pronto do servidor.
  const AVISO_BUSCA_WEB = "Busca na web ligada: a pergunta de pesquisa sai do computador (vai ao OpenRouter e ao provedor de busca). Só texto genérico; dados do cadastro são recusados antes de sair.";
  let buscaWebCarregada = false;
  let buscaWebOcupada = false;
  // Lembretes e notas: guardados no servidor (data/state); aqui a lista para mostrar, concluir e apagar (o Assistente cria pelo chat).
  let lembretes = [];
  let lembretesOcupados = false;
  let lembreteApagando = "";
  let historico = [];
  let historicoApagando = "";
  let historicoOcupado = false;
  let conversaAberta = null;
  // Anexos: o servidor guarda só em memória (30 min, apagados em "Nova conversa"); aqui fica a lista para mostrar.
  const LIMITE_ANEXO_BYTES = 10 * 1024 * 1024;
  const ROTULO_TIPO = { pdf: "PDF", docx: "Word", imagem: "Imagem" };
  let anexos = [];
  let anexando = false;
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
    if (!vozLigada || !sintese || !texto.trim() || !painelVisivel()) return; // resposta que chega com o chat fechado não fala
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
    return !byId("assistente-widget").hidden;
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
    byId("assistente-enviar").disabled = bloqueado || gravando || transcrevendo || anexando;
    byId("assistente-anexar").disabled = bloqueado || gravando || transcrevendo || anexando;
    byId("assistente-anexos").querySelectorAll("button").forEach(botao => { botao.disabled = ocupado || anexando; });
    // Durante a gravação o botão continua ativo: é ele que para.
    const botaoGravar = byId("assistente-gravar");
    botaoGravar.disabled = !gravando && (bloqueado || transcrevendo);
    const segundos = Math.floor((Date.now() - inicioGravacao) / 1000);
    byId("assistente-gravar-rotulo").textContent = gravando
      ? `Parar (${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")})`
      : transcrevendo ? "Transcrevendo…" : "Gravar áudio";
    // Sem rótulo visível: o tempo de gravação vai no tooltip e o estado aparece no ícone (parar) e na cor.
    botaoGravar.title = byId("assistente-gravar-rotulo").textContent;
    botaoGravar.classList.toggle("ck-assist__icone--gravando", gravando);
    botaoGravar.querySelector("use").setAttribute("href", gravando ? "#i-stop" : "#i-mic");
    byId("assistente-nova").disabled = ocupado;
    byId("assistente-confirmar").disabled = ocupado;
    byId("assistente-cancelar").disabled = ocupado;
    byId("assistente-mensagens").setAttribute("aria-busy", String(ocupado));
    botaoCancelarEnvio().hidden = !ocupado;
    atualizarGlobo();
  }

  // Criado aqui (não no HTML) e com o termo aprovado "Cancelar"; o nome acessível o distingue do Cancelar do cartão de confirmação.
  function botaoCancelarEnvio() {
    let botao = botaoCancelar;
    if (!botao) {
      botao = botaoCancelar = createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm ck-assist__cancelar-envio", "Cancelar");
      botao.type = "button";
      botao.id = "assistente-cancelar-envio";
      botao.hidden = true;
      botao.dataset.onClick = "cancelarEnvioAssistente";
      botao.setAttribute("aria-label", "Cancelar envio");
      byId("assistente-status").after(botao);
    }
    return botao;
  }

  function tamanhoLegivel(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  }

  function mostrarStatusAnexos(texto) {
    byId("assistente-anexos-status").textContent = texto;
  }

  // Nome do arquivo e textos vêm de fora: entram só como textContent.
  function desenharAnexos() {
    const lista = byId("assistente-anexos");
    lista.replaceChildren(...anexos.map(anexo => {
      const item = document.createElement("li");
      item.className = "ck-assist__anexo";
      const texto = document.createElement("span");
      texto.className = "ck-assist__anexo-texto";
      texto.append(createTextElement("span", "ck-assist__anexo-nome", String(anexo.nome)));
      const partes = [ROTULO_TIPO[anexo.tipo] || "Arquivo", tamanhoLegivel(Number(anexo.tamanho) || 0)];
      if (anexo.tipo !== "imagem" && Number(anexo.paginas) > 1) partes.push(`${anexo.paginas} páginas de texto`);
      texto.append(createTextElement("span", "ck-assist__anexo-meta", partes.join(" · ")));
      if (anexo.aviso) texto.append(createTextElement("span", "ck-assist__anexo-alerta", String(anexo.aviso)));
      const remover = document.createElement("button");
      remover.type = "button";
      remover.className = "ck-btn ck-btn--fantasma ck-btn--sm ck-btn--icone";
      remover.setAttribute("aria-label", `Remover anexo ${anexo.nome}`);
      remover.title = "Remover anexo";
      remover.dataset.onClick = "removerAnexoAssistente";
      remover.dataset.args = JSON.stringify([String(anexo.id)]);
      const icone = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icone.setAttribute("class", "ck-ico ck-ico--sm");
      icone.setAttribute("aria-hidden", "true");
      icone.setAttribute("focusable", "false");
      icone.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "use")).setAttribute("href", "#i-x");
      remover.append(icone);
      item.append(texto, remover);
      return item;
    }));
    lista.hidden = !anexos.length;
    byId("assistente-anexos-aviso").hidden = !anexos.some(anexo => anexo.tipo === "imagem");
    atualizarControles();
  }

  async function carregarAnexos() {
    try {
      const dados = await apiFetch("/api/assistente/anexos", { errorMessage: "Não foi possível carregar os anexos." });
      anexos = Array.isArray(dados?.anexos) ? dados.anexos : [];
    } catch {
      anexos = [];
    }
    desenharAnexos();
  }

  async function enviarAnexo(arquivo) {
    if (arquivo.size > LIMITE_ANEXO_BYTES) {
      mostrarStatusAnexos(`${arquivo.name}: o arquivo é grande demais. O limite é ${LIMITE_ANEXO_BYTES / (1024 * 1024)} MB.`);
      return;
    }
    mostrarStatusAnexos(`Enviando ${arquivo.name}…`);
    try {
      const anexo = await apiFetch("/api/assistente/anexo", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Nome-Arquivo": encodeURIComponent(arquivo.name) },
        body: arquivo,
        errorMessage: "Não foi possível anexar o arquivo.",
      });
      anexos = [...anexos, anexo];
      mostrarStatusAnexos(anexo.aviso ? `${anexo.nome} anexado, mas: ${anexo.aviso}` : `${anexo.nome} anexado.`);
    } catch (error) {
      if (error?.status === 503) online = false;
      mostrarStatusAnexos(`${arquivo.name}: ${error?.status ? error.message : "Não foi possível anexar o arquivo."}`);
    }
  }

  async function anexarArquivoAssistente(event) {
    const campo = event?.target;
    const arquivos = [...(campo?.files || [])];
    if (campo) campo.value = ""; // permite escolher o mesmo arquivo de novo
    if (!arquivos.length || !online || ocupado || pendente || anexando) return;
    anexando = true;
    atualizarControles();
    for (const arquivo of arquivos) await enviarAnexo(arquivo);
    anexando = false;
    desenharAnexos();
    byId("assistente-anexar").focus();
  }

  async function removerAnexoAssistente(id) {
    if (ocupado || anexando) return;
    anexando = true;
    atualizarControles();
    try {
      await apiFetch(`/api/assistente/anexo/${encodeURIComponent(id)}`, { method: "DELETE", errorMessage: "Não foi possível remover o anexo." });
      anexos = anexos.filter(anexo => anexo.id !== id);
      mostrarStatusAnexos("Anexo removido.");
    } catch (error) {
      if (error?.status === 404) anexos = anexos.filter(anexo => anexo.id !== id); // já expirou no servidor
      mostrarStatusAnexos(error?.status === 404 ? "O anexo já tinha sido removido." : error?.message || "Não foi possível remover o anexo.");
    }
    anexando = false;
    desenharAnexos();
    byId("assistente-anexar").focus();
  }

  function contarMensagemAssistente() {
    byId("assistente-contador").textContent = `${byId("assistente-texto").value.length} / ${LIMITE}`;
  }

  function mostrarStatusInstrucoes(texto) {
    byId("assistente-instrucoes-status").textContent = texto;
  }

  function atualizarInstrucoes() {
    const bloqueado = !instrucoesCarregadas || instrucoesOcupadas;
    byId("assistente-instrucoes-texto").disabled = bloqueado;
    byId("assistente-instrucoes-salvar").disabled = bloqueado;
    byId("assistente-instrucoes-limpar").disabled = bloqueado;
  }

  function contarInstrucoesAssistente() {
    byId("assistente-instrucoes-contador").textContent = `${byId("assistente-instrucoes-texto").value.length} / ${LIMITE}`;
  }

  async function carregarInstrucoes() {
    instrucoesOcupadas = true;
    atualizarInstrucoes();
    mostrarStatusInstrucoes("Carregando as instruções…");
    try {
      const dados = await apiFetch("/api/assistente/instrucoes", { errorMessage: "Não foi possível carregar as instruções." });
      byId("assistente-instrucoes-texto").value = String(dados?.texto ?? "");
      instrucoesCarregadas = true;
      mostrarStatusInstrucoes("");
    } catch (error) {
      mostrarStatusInstrucoes(`${error?.message || "Não foi possível carregar as instruções."} Feche e abra de novo para tentar outra vez.`);
    }
    instrucoesOcupadas = false;
    contarInstrucoesAssistente();
    atualizarInstrucoes();
    if (instrucoesCarregadas) byId("assistente-instrucoes-texto").focus();
  }

  function mostrarStatusBuscaWeb(texto) {
    byId("assistente-busca-web-status").textContent = texto;
  }

  function mostrarBuscaWeb(ativa) {
    const caixa = byId("assistente-busca-web");
    caixa.checked = ativa === true;
    caixa.disabled = !buscaWebCarregada || buscaWebOcupada;
    byId("assistente-busca-web-aviso").textContent = ativa === true ? AVISO_BUSCA_WEB : "";
  }

  async function carregarBuscaWeb() {
    buscaWebOcupada = true;
    mostrarBuscaWeb(false);
    try {
      const dados = await apiFetch("/api/assistente/busca-web", { errorMessage: "Não foi possível ler o estado da busca na web." });
      buscaWebCarregada = true;
      buscaWebOcupada = false;
      mostrarBuscaWeb(dados?.ativa);
    } catch (error) {
      buscaWebOcupada = false;
      mostrarStatusBuscaWeb(`${error?.message || "Não foi possível ler o estado da busca na web."} A busca fica desligada.`);
      mostrarBuscaWeb(false);
    }
  }

  async function alternarBuscaWebAssistente() {
    if (!buscaWebCarregada || buscaWebOcupada) return;
    const caixa = byId("assistente-busca-web");
    const ativa = caixa.checked;
    buscaWebOcupada = true;
    caixa.disabled = true;
    try {
      const dados = await apiFetch("/api/assistente/busca-web", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativa }),
        errorMessage: "Não foi possível mudar a busca na web.",
      });
      buscaWebOcupada = false;
      mostrarBuscaWeb(dados?.ativa);
      mostrarStatusBuscaWeb(dados?.ativa === true ? "Busca na web ligada." : "Busca na web desligada. Vale já na próxima rodada.");
    } catch (error) {
      buscaWebOcupada = false;
      mostrarBuscaWeb(!ativa);
      mostrarStatusBuscaWeb(error?.message || "Não foi possível mudar a busca na web.");
    }
    caixa.focus();
  }

  function alternarInstrucoesAssistente() {
    const area = byId("assistente-instrucoes");
    area.hidden = !area.hidden;
    if (!area.hidden) { fecharLembretes(); fecharHistorico(); }
    byId("assistente-instrucoes-botao").setAttribute("aria-expanded", String(!area.hidden));
    if (area.hidden) byId("assistente-instrucoes-botao").focus();
    else {
      void carregarBuscaWeb();
      if (!instrucoesCarregadas) return carregarInstrucoes();
      byId("assistente-instrucoes-texto").focus();
    }
  }

  async function guardarInstrucoes(texto, aviso) {
    if (!instrucoesCarregadas || instrucoesOcupadas) return;
    if (texto.length > LIMITE) { mostrarStatusInstrucoes(`As instruções passam de ${LIMITE} caracteres.`); return; }
    instrucoesOcupadas = true;
    atualizarInstrucoes();
    mostrarStatusInstrucoes("Salvando…");
    try {
      const dados = await apiFetch("/api/assistente/instrucoes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto }),
        errorMessage: "Não foi possível salvar as instruções.",
      });
      byId("assistente-instrucoes-texto").value = String(dados?.texto ?? texto);
      mostrarStatusInstrucoes(aviso(byId("assistente-instrucoes-texto").value));
    } catch (error) {
      mostrarStatusInstrucoes(error?.message || "Não foi possível salvar as instruções.");
    }
    instrucoesOcupadas = false;
    contarInstrucoesAssistente();
    atualizarInstrucoes();
    byId("assistente-instrucoes-texto").focus();
  }

  function salvarInstrucoesAssistente() {
    return guardarInstrucoes(byId("assistente-instrucoes-texto").value, salvo => (salvo ? "Instruções salvas. Valem a partir da próxima mensagem." : "Instruções removidas."));
  }

  function limparInstrucoesAssistente() {
    return guardarInstrucoes("", () => "Instruções removidas.");
  }

  function mostrarStatusLembretes(texto) {
    byId("assistente-lembretes-status").textContent = texto;
  }

  function fecharLembretes() {
    byId("assistente-lembretes").hidden = true;
    byId("assistente-lembretes-botao").setAttribute("aria-expanded", "false");
    lembreteApagando = "";
  }

  function dataLocalHoje() {
    const agora = new Date();
    const dois = n => String(n).padStart(2, "0");
    return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;
  }

  function dataBrasileira(iso) {
    const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
    return dia && mes && ano ? `${dia}/${mes}/${ano}` : String(iso);
  }

  function botaoLembrete(rotulo, classe, acao, id, { icone = "", aria = "" } = {}) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = `ck-btn ${classe}`;
    botao.dataset.onClick = acao;
    botao.dataset.args = JSON.stringify([id]);
    if (aria) botao.setAttribute("aria-label", aria);
    if (icone) {
      botao.title = rotulo;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ck-ico ck-ico--sm");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "use")).setAttribute("href", icone);
      botao.append(svg);
    } else {
      botao.textContent = rotulo;
    }
    return botao;
  }

  function desenharLembretes() {
    const hoje = dataLocalHoje();
    const lista = byId("assistente-lembretes-lista");
    lista.replaceChildren(...lembretes.map(nota => {
      const id = String(nota.id);
      const texto = String(nota.texto ?? "");
      const concluida = nota.concluida === true;
      const item = document.createElement("li");
      item.className = `ck-assist__lembrete${concluida ? " ck-assist__lembrete--feito" : ""}`;
      item.dataset.lembreteId = id;
      const corpo = document.createElement("span");
      corpo.className = "ck-assist__anexo-texto";
      corpo.append(createTextElement("span", "ck-assist__lembrete-texto", texto));
      const partes = [];
      if (nota.prazo) partes.push(`Prazo ${dataBrasileira(nota.prazo)}${!concluida && String(nota.prazo) < hoje ? " (vencido)" : ""}`);
      if (concluida) partes.push("Concluído");
      if (nota.criada_em) partes.push(`Criado em ${dataBrasileira(nota.criada_em)}`);
      if (partes.length) corpo.append(createTextElement("span", "ck-assist__anexo-meta", partes.join(" · ")));
      item.append(corpo);
      const acoes = document.createElement("span");
      acoes.className = "ck-assist__lembrete-acoes";
      if (id === lembreteApagando) {
        acoes.append(
          createTextElement("span", "ck-assist__anexo-meta", "Apagar este lembrete?"),
          botaoLembrete("Apagar", "ck-btn--primario ck-btn--sm", "apagarLembreteAssistente", id, { aria: `Confirmar: apagar lembrete ${texto}` }),
          botaoLembrete("Cancelar", "ck-btn--secundario ck-btn--sm", "cancelarApagarLembreteAssistente", id),
        );
      } else {
        acoes.append(
          botaoLembrete(concluida ? "Reabrir" : "Concluir", "ck-btn--secundario ck-btn--sm", "marcarLembreteAssistente", id, { aria: `${concluida ? "Reabrir" : "Concluir"}: ${texto}` }),
          botaoLembrete("Apagar lembrete", "ck-btn--fantasma ck-btn--sm ck-btn--icone", "pedirApagarLembreteAssistente", id, { icone: "#i-trash", aria: `Apagar lembrete: ${texto}` }),
        );
      }
      item.append(acoes);
      return item;
    }));
    lista.hidden = !lembretes.length;
    byId("assistente-lembretes-vazio").hidden = lembretes.length > 0;
  }

  function focarLembrete(id, seletor) {
    const item = [...byId("assistente-lembretes-lista").children].find(li => li.dataset.lembreteId === id);
    (item?.querySelector(seletor) || byId("assistente-lembretes-titulo")).focus();
  }

  async function carregarLembretes() {
    lembretesOcupados = true;
    try {
      const dados = await apiFetch("/api/assistente/notas", { errorMessage: "Não foi possível carregar os lembretes." });
      lembretes = Array.isArray(dados?.notas) ? dados.notas : [];
      return true;
    } catch (error) {
      mostrarStatusLembretes(error?.message || "Não foi possível carregar os lembretes.");
      return false;
    } finally {
      lembretesOcupados = false;
      desenharLembretes();
    }
  }

  async function alternarLembretesAssistente() {
    const area = byId("assistente-lembretes");
    if (!area.hidden) {
      fecharLembretes();
      byId("assistente-lembretes-botao").focus();
      return;
    }
    byId("assistente-instrucoes").hidden = true;
    byId("assistente-instrucoes-botao").setAttribute("aria-expanded", "false");
    fecharHistorico();
    area.hidden = false;
    byId("assistente-lembretes-botao").setAttribute("aria-expanded", "true");
    mostrarStatusLembretes("Carregando os lembretes…");
    if (await carregarLembretes()) mostrarStatusLembretes("");
    byId("assistente-lembretes-titulo").focus();
  }

  // Concluir/reabrir e apagar são ações do próprio usuário nesta área: gravam direto, sem cartão (o cartão vale para o Assistente).
  async function alterarLembrete(id, requisicao, sucesso) {
    if (lembretesOcupados) return;
    lembretesOcupados = true;
    mostrarStatusLembretes("");
    let mensagem = sucesso;
    try {
      await apiFetch(`/api/assistente/notas/${encodeURIComponent(id)}`, requisicao);
    } catch (error) {
      mensagem = error?.status === 404 ? "Esse lembrete não existe mais." : error?.message || "Não foi possível alterar o lembrete.";
    }
    lembretesOcupados = false;
    lembreteApagando = "";
    if (await carregarLembretes()) mostrarStatusLembretes(mensagem);
    focarLembrete(id, "button");
  }

  function marcarLembreteAssistente(id) {
    const nota = lembretes.find(item => String(item.id) === id);
    if (!nota) return;
    const concluir = nota.concluida !== true;
    return alterarLembrete(id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concluida: concluir }),
      errorMessage: "Não foi possível alterar o lembrete.",
    }, concluir ? "Lembrete concluído." : "Lembrete reaberto.");
  }

  function pedirApagarLembreteAssistente(id) {
    if (lembretesOcupados) return;
    lembreteApagando = id;
    mostrarStatusLembretes("");
    desenharLembretes();
    focarLembrete(id, "button[data-on-click=cancelarApagarLembreteAssistente]");
  }

  function cancelarApagarLembreteAssistente(id) {
    lembreteApagando = "";
    desenharLembretes();
    focarLembrete(id, "button[data-on-click=pedirApagarLembreteAssistente]");
  }

  function apagarLembreteAssistente(id) {
    return alterarLembrete(id, { method: "DELETE", errorMessage: "Não foi possível apagar o lembrete." }, "Lembrete apagado.");
  }

  // Histórico: só leitura; o servidor guarda o texto já mascarado (sem CPF, e-mail, telefone, senha nem nomes).
  function mostrarStatusHistorico(texto) {
    byId("assistente-historico-status").textContent = texto;
  }

  function fecharHistorico() {
    byId("assistente-historico").hidden = true;
    byId("assistente-historico-botao").setAttribute("aria-expanded", "false");
    historicoApagando = "";
    mostrarListaHistorico();
  }

  function mostrarListaHistorico() {
    byId("assistente-historico-leitura").hidden = true;
    byId("assistente-historico-lista-voltar").hidden = true;
    byId("assistente-historico-exportar").hidden = true;
    conversaAberta = null;
    desenharHistorico();
  }

  function desenharHistorico() {
    const lista = byId("assistente-historico-lista");
    lista.replaceChildren(...historico.map(conversa => {
      const id = String(conversa.id);
      const titulo = String(conversa.titulo || "Conversa sem título");
      const item = document.createElement("li");
      item.className = "ck-assist__lembrete";
      item.dataset.conversaId = id;
      const corpo = document.createElement("span");
      corpo.className = "ck-assist__anexo-texto";
      const abrir = createTextElement("button", "ck-assist__lembrete-texto", titulo);
      abrir.type = "button";
      abrir.dataset.onClick = "abrirConversaHistoricoAssistente";
      abrir.dataset.args = JSON.stringify([id]);
      corpo.append(abrir);
      const quando = String(conversa.atualizada_em || "");
      const partes = [];
      if (quando) partes.push(`${dataBrasileira(quando)} ${quando.slice(11, 16)}`);
      partes.push(`${Number(conversa.mensagens) || 0} mensagens`);
      corpo.append(createTextElement("span", "ck-assist__anexo-meta", partes.join(" · ")));
      item.append(corpo);
      const acoes = document.createElement("span");
      acoes.className = "ck-assist__lembrete-acoes";
      if (id === historicoApagando) {
        acoes.append(
          createTextElement("span", "ck-assist__anexo-meta", "Apagar esta conversa?"),
          botaoLembrete("Apagar", "ck-btn--primario ck-btn--sm", "apagarConversaHistoricoAssistente", id, { aria: `Confirmar: apagar conversa ${titulo}` }),
          botaoLembrete("Cancelar", "ck-btn--secundario ck-btn--sm", "cancelarApagarConversaHistoricoAssistente", id),
        );
      } else {
        acoes.append(
          botaoLembrete("Exportar PDF", "ck-btn--fantasma ck-btn--sm ck-btn--icone", "exportarPdfHistoricoAssistente", id, { icone: "#i-download", aria: `Exportar PDF: ${titulo}` }),
          botaoLembrete("Apagar conversa", "ck-btn--fantasma ck-btn--sm ck-btn--icone", "pedirApagarConversaHistoricoAssistente", id, { icone: "#i-trash", aria: `Apagar conversa: ${titulo}` }),
        );
      }
      item.append(acoes);
      return item;
    }));
    lista.hidden = !historico.length;
    byId("assistente-historico-vazio").hidden = historico.length > 0;
  }

  function focarConversaHistorico(id, seletor) {
    const item = [...byId("assistente-historico-lista").children].find(li => li.dataset.conversaId === id);
    (item?.querySelector(seletor) || byId("assistente-historico-titulo")).focus();
  }

  async function carregarHistorico() {
    historicoOcupado = true;
    try {
      const dados = await apiFetch("/api/assistente/conversas", { errorMessage: "Não foi possível carregar o histórico." });
      historico = Array.isArray(dados?.conversas) ? dados.conversas : [];
      return true;
    } catch (error) {
      mostrarStatusHistorico(error?.message || "Não foi possível carregar o histórico.");
      return false;
    } finally {
      historicoOcupado = false;
      desenharHistorico();
    }
  }

  async function alternarHistoricoAssistente() {
    const area = byId("assistente-historico");
    if (!area.hidden) {
      fecharHistorico();
      byId("assistente-historico-botao").focus();
      return;
    }
    byId("assistente-instrucoes").hidden = true;
    byId("assistente-instrucoes-botao").setAttribute("aria-expanded", "false");
    fecharLembretes();
    area.hidden = false;
    byId("assistente-historico-botao").setAttribute("aria-expanded", "true");
    mostrarListaHistorico();
    mostrarStatusHistorico("Carregando o histórico…");
    if (await carregarHistorico()) mostrarStatusHistorico("");
    byId("assistente-historico-titulo").focus();
  }

  async function buscarConversaHistorico(id) {
    mostrarStatusHistorico("");
    try {
      return await apiFetch(`/api/assistente/conversas/${encodeURIComponent(id)}`, { errorMessage: "Não foi possível abrir a conversa." });
    } catch (error) {
      mostrarStatusHistorico(error?.status === 404 ? "Essa conversa não existe mais." : error?.message || "Não foi possível abrir a conversa.");
      if (error?.status === 404) await carregarHistorico();
      return null;
    }
  }

  async function abrirConversaHistoricoAssistente(id) {
    if (historicoOcupado) return;
    const conversa = await buscarConversaHistorico(id);
    if (!conversa) return;
    conversaAberta = conversa;
    const leitura = byId("assistente-historico-leitura");
    leitura.replaceChildren(...(Array.isArray(conversa?.mensagens) ? conversa.mensagens : []).map(mensagem => {
      const autor = mensagem?.papel === "usuario" ? "usuario" : "assistente";
      const item = document.createElement("div");
      item.className = `ck-assist__msg ck-assist__msg--${autor}`;
      item.append(createTextElement("span", "ck-sr", autor === "usuario" ? "Você:" : "Assistente:"));
      item.append(createTextElement("p", "ck-assist__texto", String(mensagem?.texto ?? "")));
      return item;
    }));
    byId("assistente-historico-lista").hidden = true;
    byId("assistente-historico-vazio").hidden = true;
    leitura.hidden = false;
    byId("assistente-historico-lista-voltar").hidden = false;
    byId("assistente-historico-exportar").hidden = false;
    leitura.scrollTop = 0;
    leitura.focus();
  }

  // PDF: documento isolado num iframe (estilo Cockpit em assistente-pdf.css) e impressão do navegador ("Salvar como PDF"); nada sai do computador.
  async function exportarPdfHistoricoAssistente(id) {
    if (historicoOcupado) return;
    const conversa = typeof id === "string" && id !== conversaAberta?.id ? await buscarConversaHistorico(id) : conversaAberta;
    if (!conversa) return;
    const quando = String(conversa.atualizada_em || "");
    const dataHora = quando ? `${dataBrasileira(quando)} ${quando.slice(11, 16)}` : "";
    const titulo = String(conversa.titulo || "Conversa sem título");
    const mensagens = Array.isArray(conversa.mensagens) ? conversa.mensagens : [];
    document.querySelectorAll("iframe[data-assistente-pdf]").forEach(antigo => antigo.remove());
    const quadro = document.createElement("iframe");
    quadro.dataset.assistentePdf = "";
    quadro.setAttribute("aria-hidden", "true");
    quadro.tabIndex = -1;
    quadro.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.append(quadro);
    const doc = quadro.contentDocument;
    doc.open();
    doc.write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title></title></head><body></body></html>');
    doc.close();
    doc.title = `Simpress - Assistente - ${titulo.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 40)}${quando ? ` - ${quando.slice(0, 10)}` : ""}`;
    for (const href of ["/static/vendor/fonts.css", "/static/styles/assistente-pdf.css"]) {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      doc.head.append(link);
    }
    const pagina = doc.createElement("main");
    pagina.className = "pdf";
    const cab = doc.createElement("header");
    cab.className = "pdf__cab";
    const marca = doc.createElement("p");
    marca.className = "pdf__marca";
    marca.textContent = "Simpress · Assistente";
    const h1 = doc.createElement("h1");
    h1.className = "pdf__titulo";
    h1.textContent = titulo;
    const meta = doc.createElement("ul");
    meta.className = "pdf__meta";
    for (const texto of [dataHora && `Atualizada em ${dataHora}`, `${mensagens.length} mensagens`]) {
      if (!texto) continue;
      const li = doc.createElement("li");
      li.textContent = texto;
      meta.append(li);
    }
    cab.append(marca, h1, meta);
    const lista = doc.createElement("div");
    lista.className = "pdf__msgs";
    for (const mensagem of mensagens) {
      const usuario = mensagem?.papel === "usuario";
      const caixa = doc.createElement("section");
      caixa.className = `pdf__msg pdf__msg--${usuario ? "usuario" : "assistente"}`;
      const autor = doc.createElement("p");
      autor.className = "pdf__autor";
      autor.textContent = usuario ? "Você" : "Assistente";
      const texto = doc.createElement("p");
      texto.className = "pdf__texto";
      texto.textContent = String(mensagem?.texto ?? "");
      caixa.append(autor, texto);
      lista.append(caixa);
    }
    const rodape = doc.createElement("footer");
    rodape.className = "pdf__rodape";
    rodape.textContent = "Gerado no Simpress · dados pessoais já mascarados no histórico";
    pagina.append(cab, lista, rodape);
    doc.body.append(pagina);
    await Promise.all([...doc.querySelectorAll("link")].map(link => new Promise(resolve => {
      link.addEventListener("load", resolve, { once: true });
      link.addEventListener("error", resolve, { once: true });
    })));
    await doc.fonts?.ready;
    mostrarStatusHistorico("Abrindo a impressão: escolha “Salvar como PDF”.");
    quadro.contentWindow.addEventListener("afterprint", () => quadro.remove(), { once: true });
    quadro.contentWindow.focus();
    quadro.contentWindow.print();
  }

  function fecharConversaHistoricoAssistente() {
    mostrarListaHistorico();
    byId("assistente-historico-titulo").focus();
  }

  function pedirApagarConversaHistoricoAssistente(id) {
    if (historicoOcupado) return;
    historicoApagando = id;
    mostrarStatusHistorico("");
    desenharHistorico();
    focarConversaHistorico(id, "button[data-on-click=cancelarApagarConversaHistoricoAssistente]");
  }

  function cancelarApagarConversaHistoricoAssistente(id) {
    historicoApagando = "";
    desenharHistorico();
    focarConversaHistorico(id, "button[data-on-click=pedirApagarConversaHistoricoAssistente]");
  }

  async function apagarConversaHistoricoAssistente(id) {
    if (historicoOcupado) return;
    historicoOcupado = true;
    let mensagem = "Conversa apagada.";
    try {
      await apiFetch(`/api/assistente/conversas/${encodeURIComponent(id)}`, { method: "DELETE", errorMessage: "Não foi possível apagar a conversa." });
    } catch (error) {
      mensagem = error?.status === 404 ? "Essa conversa não existe mais." : error?.message || "Não foi possível apagar a conversa.";
    }
    historicoOcupado = false;
    historicoApagando = "";
    if (await carregarHistorico()) mostrarStatusHistorico(mensagem);
    byId("assistente-historico-titulo").focus();
  }

  // Relatórios gerados: o servidor devolve só id/nome/tamanho; o link aponta sempre para a rota fixa de download (id validado).
  function criarArquivos(arquivos) {
    const caixa = document.createElement("div");
    caixa.className = "ck-assist__arquivos";
    for (const arquivo of arquivos) {
      const id = String(arquivo?.id ?? "");
      const nome = String(arquivo?.nome ?? "").trim();
      if (!/^[0-9a-f]{16}$/.test(id) || !nome) continue;
      const link = createTextElement("a", "ck-btn ck-btn--secundario ck-assist__arquivo", `Baixar ${nome}`);
      link.href = `/api/assistente/relatorio/${id}`;
      link.download = nome;
      const bytes = Number(arquivo.tamanho);
      if (bytes > 0) link.title = `${nome} (${tamanhoLegivel(bytes)})`;
      caixa.append(link);
    }
    return caixa;
  }

  // Card da busca na web: consulta, resumo e fontes vêm montados pelo servidor; tudo entra como texto e só links http/https abrem (nova aba, sem referrer).
  function criarBuscasWeb(buscas) {
    const caixa = document.createElement("div");
    caixa.className = "ck-assist__buscas";
    for (const busca of buscas) {
      const resumo = String(busca?.resumo ?? "").trim();
      const fontes = Array.isArray(busca?.fontes) ? busca.fontes : [];
      if (!resumo && !fontes.length) continue;
      const card = document.createElement("section");
      card.className = "ck-assist__busca-card";
      card.setAttribute("aria-label", "Resultado da busca na web (fonte externa)");
      card.append(createTextElement("p", "ck-assist__busca-titulo", `Fonte externa · busca na web: ${String(busca?.consulta ?? "")}`));
      if (resumo) card.append(createTextElement("p", "ck-assist__busca-resumo", resumo));
      const lista = document.createElement("ul");
      lista.className = "ck-assist__busca-fontes";
      for (const fonte of fontes) {
        const titulo = String(fonte?.titulo ?? "").trim();
        const dominio = String(fonte?.dominio ?? "").trim();
        const url = String(fonte?.url ?? "");
        const item = document.createElement("li");
        if (/^https?:\/\//i.test(url)) {
          const link = createTextElement("a", "", titulo || dominio || url);
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          item.append(link);
        } else {
          item.append(createTextElement("span", "", titulo || dominio || "Fonte sem link"));
        }
        if (dominio) item.append(createTextElement("span", "ck-assist__busca-dominio", ` (${dominio})`));
        lista.append(item);
      }
      if (lista.children.length) card.append(lista);
      caixa.append(card);
    }
    return caixa;
  }

  // Rascunho de e-mail/texto: nada é enviado; o botão só copia o texto da resposta (já com os nomes restaurados) para a área de transferência.
  async function copiarTexto(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      const campo = document.createElement("textarea");
      campo.value = texto;
      campo.setAttribute("readonly", "");
      campo.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
      document.body.append(campo);
      campo.select();
      try {
        return document.execCommand("copy");
      } catch {
        return false;
      } finally {
        campo.remove();
      }
    }
  }

  function criarCopiar(texto) {
    const caixa = document.createElement("div");
    caixa.className = "ck-assist__arquivos";
    const botao = createTextElement("button", "ck-btn ck-btn--secundario ck-assist__arquivo", "Copiar texto");
    botao.type = "button";
    botao.addEventListener("click", async () => {
      mostrarStatus((await copiarTexto(texto)) ? "Texto copiado." : "Não foi possível copiar. Selecione o texto da resposta e copie manualmente.");
    });
    caixa.append(botao);
    return caixa;
  }

  // Até 2 ferramentas: a lista simples. Com mais (consultas encadeadas), a contagem e cada nome uma vez, com "×n" quando repetido.
  function resumirFerramentas(ferramentas) {
    if (ferramentas.length <= 2) return `Ferramentas: ${ferramentas.join(", ")}`;
    const contagem = new Map();
    ferramentas.forEach(nome => contagem.set(nome, (contagem.get(nome) || 0) + 1));
    const nomes = [...contagem].map(([nome, vezes]) => (vezes > 1 ? `${nome} ×${vezes}` : nome));
    return `Ferramentas (${ferramentas.length} chamadas): ${nomes.join(", ")}`;
  }

  // Todo texto vindo do usuário ou do Assistente entra como textContent, nunca como HTML.
  function adicionarMensagem(autor, texto, ferramentas = [], arquivos = [], buscas = []) {
    const item = document.createElement("div");
    item.className = `ck-assist__msg ck-assist__msg--${autor}`;
    item.append(createTextElement("span", "ck-sr", autor === "usuario" ? "Você:" : "Assistente:"));
    item.append(createTextElement("p", "ck-assist__texto", texto));
    if (ferramentas.length) item.append(createTextElement("p", "ck-assist__ferramentas", resumirFerramentas(ferramentas)));
    if (arquivos.length) item.append(criarArquivos(arquivos));
    if (buscas.length) item.append(criarBuscasWeb(buscas));
    if (ferramentas.includes("montar_rascunho") && texto) item.append(criarCopiar(texto));
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
    const arquivos = Array.isArray(dados?.arquivos) ? dados.arquivos : [];
    const buscas = Array.isArray(dados?.busca_web) ? dados.busca_web : [];
    if (texto || ferramentas.length || arquivos.length || buscas.length) adicionarMensagem("assistente", texto, ferramentas, arquivos, buscas);
    byId("assistente-anuncio").textContent = texto;
    if (!byId("assistente-lembretes").hidden && ferramentas.some(nome => nome.includes("lembrete"))) void carregarLembretes();
    mostrarPendente(dados?.pendente ? String(dados.pendente.descricao ?? "") || PENDENTE_SEM_DESCRICAO : null);
    statusPronto();
    falar(texto);
  }

  // As respostas podem levar até ~90 s (orçamento do servidor); enquanto isso a entrada fica bloqueada.
  // O prazo do navegador é maior para a resposta de erro do servidor chegar antes de abortarmos.
  async function enviarAoAssistente(url, corpo, textoParaDevolver = "") {
    pararFala();
    ocupado = true;
    const envio = { controle: new AbortController(), motivo: "" };
    const prazo = setTimeout(() => { envio.motivo = "prazo"; envio.controle.abort(); }, PRAZO_ENVIO_MS);
    envioAtual = envio;
    mostrarStatus("Pensando…");
    atualizarControles();
    try {
      const dados = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        signal: envio.controle.signal,
        errorMessage: "Não foi possível falar com o Assistente.",
      });
      mostrarResposta(dados);
    } catch (error) {
      if (error?.status === 503) online = false;
      if (error?.name === "AbortError") mostrarStatus(envio.motivo === "prazo" ? MSG_PRAZO : MSG_CANCELADO);
      // O servidor mantém a conversa travada até terminar a rodada anterior.
      else if (error?.status === 409) mostrarStatus(MSG_CONVERSA_OCUPADA);
      else mostrarStatus(error?.message || "Não foi possível falar com o Assistente.", error?.status === 503);
      // Não perde o texto digitado quando o envio falha.
      const campo = byId("assistente-texto");
      if (textoParaDevolver && !campo.value) { campo.value = textoParaDevolver; contarMensagemAssistente(); }
    } finally {
      clearTimeout(prazo);
      envioAtual = null;
      ocupado = false;
      atualizarControles();
      focarProximo();
    }
  }

  function cancelarEnvioAssistente() {
    if (!envioAtual) return;
    envioAtual.motivo = "cancelado";
    envioAtual.controle.abort();
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
      if (online) await carregarAnexos(); // a lista do servidor vale também depois de recarregar a página
      if (online && estado?.aguardando_confirmacao) mostrarPendente(String(estado?.pendente?.descricao ?? "") || PENDENTE_SEM_DESCRICAO);
      else if (online && !estado?.aguardando_confirmacao && pendente) mostrarPendente(null);
    } catch (error) {
      online = false;
      mostrarStatus(error?.message || DESLIGADO, true);
    }
    atualizarControles();
    const foco = document.activeElement;
    if (pendente || !foco || !byId("assistente-widget").contains(foco) || foco === byId("assistente-tentar")) focarProximo();
  }

  // Abre ou fecha o chat flutuante (ícone do topbar, F9, botão X e Esc).
  function alternarAssistente() {
    const widget = byId("assistente-widget");
    const botao = byId("btn-assistente");
    if (widget.hidden) {
      widget.hidden = false;
      if (widget.dataset.modo && widget.dataset.modo !== "normal") definirModo("normal");
      botao.setAttribute("aria-expanded", "true");
      atualizarGlobo();
      focarProximo();
      void carregarAssistente();
      return;
    }
    pararFala();
    if (gravando) cancelarGravacao();
    const focoDentro = widget.contains(document.activeElement);
    widget.hidden = true;
    botao.setAttribute("aria-expanded", "false");
    if (focoDentro) botao.focus();
  }

  // Tamanho do chat: "normal", "minimizado" (só a barra de título) ou "maximizado" (tela toda). Reabrir o chat volta ao normal.
  function definirModo(modo) {
    const widget = byId("assistente-widget");
    const minimizado = modo === "minimizado";
    const maximizado = modo === "maximizado";
    widget.dataset.modo = modo;
    const botaoMin = byId("assistente-minimizar");
    botaoMin.setAttribute("aria-expanded", String(!minimizado));
    botaoMin.setAttribute("aria-label", minimizado ? "Restaurar Assistente" : "Minimizar Assistente");
    botaoMin.title = minimizado ? "Restaurar" : "Minimizar";
    botaoMin.querySelector("use").setAttribute("href", minimizado ? "#i-chevron-up" : "#i-minus");
    const botaoMax = byId("assistente-maximizar");
    botaoMax.setAttribute("aria-label", maximizado ? "Restaurar tamanho do Assistente" : "Maximizar Assistente");
    botaoMax.title = maximizado ? "Restaurar tamanho" : "Maximizar";
    botaoMax.querySelector("use").setAttribute("href", maximizado ? "#i-restaurar" : "#i-maximize");
    // O conteúdo some ao minimizar: o foco vai para o botão, para não ficar preso num campo oculto.
    if (minimizado && widget.contains(document.activeElement) && document.activeElement !== botaoMin) botaoMin.focus();
    else if (!minimizado) focarProximo();
  }

  function minimizarAssistente() {
    definirModo(byId("assistente-widget").dataset.modo === "minimizado" ? "normal" : "minimizado");
  }

  function maximizarAssistente() {
    definirModo(byId("assistente-widget").dataset.modo === "maximizado" ? "normal" : "maximizado");
  }

  // Fecha Instruções, Lembretes e Histórico e mostra a conversa de novo.
  function voltarConversaAssistente() {
    byId("assistente-instrucoes").hidden = true;
    byId("assistente-instrucoes-botao").setAttribute("aria-expanded", "false");
    fecharLembretes();
    fecharHistorico();
    focarProximo();
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
    if (!online || ocupado || pendente || gravando || transcrevendo || anexando) return;
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
      anexos = [];
      mostrarStatusAnexos("");
      desenharAnexos();
      if (online) statusPronto();
    } catch (error) {
      mostrarStatus(error?.message || "Não foi possível iniciar uma nova conversa.");
    }
    atualizarControles();
    focarProximo();
  }

  // Enter envia e Shift+Enter quebra a linha; com ação pendente, Esc cancela a ação; sem nada em andamento, Esc fecha o chat.
  function teclaAssistente(event) {
    if (event.key === "Escape" && gravando) {
      event.preventDefault();
      cancelarGravacao();
    } else if (event.key === "Escape" && lembreteApagando) {
      event.preventDefault();
      cancelarApagarLembreteAssistente(lembreteApagando);
    } else if (event.key === "Escape" && pendente && !ocupado) {
      event.preventDefault();
      void cancelarPendenteAssistente();
    } else if (event.key === "Escape") {
      event.preventDefault();
      alternarAssistente();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.target?.id === "assistente-texto") {
      event.preventDefault();
      void enviarMensagemAssistente();
    }
  }

  return {
    carregarAssistente, alternarAssistente, minimizarAssistente, maximizarAssistente, voltarConversaAssistente, enviarMensagemAssistente, confirmarPendenteAssistente, cancelarPendenteAssistente, cancelarEnvioAssistente,
    novaConversaAssistente, contarMensagemAssistente, teclaAssistente, alternarGravacaoAssistente, alternarVozAssistente,
    alternarInstrucoesAssistente, alternarBuscaWebAssistente, contarInstrucoesAssistente, salvarInstrucoesAssistente, limparInstrucoesAssistente,
    anexarArquivoAssistente, removerAnexoAssistente,
    alternarHistoricoAssistente, abrirConversaHistoricoAssistente, fecharConversaHistoricoAssistente,
    exportarPdfHistoricoAssistente, pedirApagarConversaHistoricoAssistente, cancelarApagarConversaHistoricoAssistente, apagarConversaHistoricoAssistente,
    alternarLembretesAssistente, marcarLembreteAssistente, pedirApagarLembreteAssistente, cancelarApagarLembreteAssistente, apagarLembreteAssistente,
  };
});
