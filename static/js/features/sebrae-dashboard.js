/** Automação → "Chamados novos do SoftExpert": importa o Dashboard, lista os novos, exporta as linhas para colar
 *  e baixa uma cópia atualizada do Dashboard (chamados novos e alterações nos antigos em aberto). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeDashboard = factory;
})(typeof window !== "undefined" ? window : globalThis, (function () {
  "use strict";

  const CAMPOS_AUTOMATICOS = Object.freeze([
    ["C", "Chamado"], ["P", "Abertura"], ["I", "Solicitante"], ["K", "Série"], ["L", "Modelo"], ["N", "Cidade"], ["E", "OS"],
  ]);
  const CAMPOS_PREENCHIDOS = Object.freeze([["K", "Série"], ["L", "Modelo"], ["N", "Cidade"], ["E", "OS"]]); // do antigo: vazios são preenchidos pelo site
  const STATUS_CHAMADO =Object.freeze(["EM ABERTO", "FINALIZADO"]);
  const TIPOS_CHAMADO = Object.freeze(["INCIDENTE", "SOLICITAÇÃO"]);
  const OBRIGATORIOS = Object.freeze(["A", "D", "J"]);
  const AVISO_CRUZAMENTO = Object.freeze({
    ausente: "Série, modelo e cidade vazios: nenhum equipamento encontrado para este solicitante.",
    ambiguo: "Série, modelo e cidade vazios: mais de um equipamento encontrado para este solicitante.",
  });

  /** Aviso de descrição que cita mais de uma pessoa: nada foi preenchido pelo nome, o usuário preenche série, modelo, cidade e OS. */
  function avisoOutraPessoa(item) {
    return item.outra_pessoa ? `A descrição cita mais de uma pessoa (${item.outra_pessoa} e outra): série, modelo, cidade e OS não foram preenchidos; preencha à mão.` : "";
  }

  /** Nota de chamado ligado ao equipamento pelo nome citado na descrição, e não pelo solicitante. */
  function avisoNomeDaDescricao(item) {
    return item.nome_da_descricao ? `Equipamento procurado pelo nome citado na descrição (${item.nome_da_descricao}), não pelo solicitante.` : "";
  }

  /** "2026-10-28T14:30" (campo datetime-local) → "28/10/2026 14:30", o formato da coluna R. */
  function formatarEncerramento(valor) {
    const partes = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(valor || ""));
    return partes ? `${partes[3]}/${partes[2]}/${partes[1]} ${partes[4]}` : "";
  }

  /** Só os chamados com A, D e J preenchidos entram na exportação. */
  function chamadoPronto(valores) {
    return OBRIGATORIOS.every(letra => String(valores?.[letra] || "").trim() !== "");
  }

  /** "28/10/2026 14:30" (como o Dashboard guarda a coluna R) → "2026-10-28T14:30" (campo datetime-local). */
  function encerramentoParaCampo(texto) {
    const partes = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}))?/.exec(String(texto || "").trim());
    return partes ? `${partes[3]}-${partes[2]}-${partes[1]}T${partes[4] || "00:00"}` : "";
  }

  /** Só os campos que o usuário mudou e não deixou em branco: em branco nunca apaga o que já está no Dashboard. */
  function payloadEdicoes(abertos, edicoes) {
    return (abertos || []).flatMap(item => {
      const editado = edicoes?.[item.numero];
      if (!editado) return [];
      const mudou = {};
      ["A", "B", "D", "J", "R", "S"].forEach(letra => {
        if (!(letra in editado)) return;
        const novo = letra === "R" ? formatarEncerramento(editado.R) : String(editado[letra] || "").trim();
        if (novo && novo !== String(item.valores?.[letra] || "").trim()) mudou[letra] = novo;
      });
      return Object.keys(mudou).length ? [{ numero: item.numero, ...mudou }] : [];
    });
  }

  /** Chave "linha:27" (sem UTIC único) aparece como o texto da coluna C e a linha da planilha. */
  function tituloAntigo(item) {
    const linha = /^linha:(\d+)$/.exec(String(item.numero || ""));
    return linha ? `${item.chamado || "Sem chamado"} (linha ${linha[1]})` : item.chamado || item.numero;
  }

  /** Quantos antigos em aberto o site preencheria (Série, Modelo, Cidade ou OS vazios). */
  function totalPreenchimentos(abertos) {
    return (abertos || []).filter(item => Object.keys(item.automaticos_sugeridos || {}).length > 0).length;
  }

  function linhaChamado(item, v) {
    return { numero: item.numero, A: v.A || "", B: v.B || "", D: v.D || "", J: v.J || "", R: formatarEncerramento(v.R), S: v.S || "" };
  }

  function payloadExportacao(formulario, valores) {
    return formulario.filter(item => chamadoPronto(valores[item.numero])).map(item => linhaChamado(item, valores[item.numero]));
  }

  /** Atualizar Dashboard grava TODOS os chamados novos, mesmo sem A, D e J (vazios viram ""). */
  function payloadAtualizacao(formulario, valores) {
    return formulario.map(item => linhaChamado(item, valores[item.numero] || {}));
  }

  const MAX_DESCRICAO = 4000;
  const NUMERO_UTIC = /^UTIC-\d{4}-\d+$/i;
  const INTERVALO_FECHAR_MS = 1500;
  const STATUS_DESFEITOS = Object.freeze(["ok"]); // nada mais a fazer no SoftExpert (ja_finalizado e nao_encontrado não bloqueiam: espelha ja_finalizado() do backend)
  const ROTULOS_RESULTADO = Object.freeze({
    ok: "Finalizado no SoftExpert", ja_finalizado: "Já estava finalizado no SoftExpert", erro: "Erro ao finalizar",
    sem_descricao: "Sem descrição para finalizar", nao_encontrado: "Não encontrado na central de tarefas", pronto: "Formulário conferido; Finalizar não foi clicado",
  });
  const MOTIVOS_PULADO = Object.freeze({
    sem_descricao: "sem descrição para finalizar", ja_finalizado: "já finalizado no SoftExpert", sem_numero: "sem número UTIC",
  });

  function formatarTamanho(bytes) {
    const n = Number(bytes) || 0;
    const num = (valor, un) => `${valor.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${un}`;
    if (n < 1024) return `${n} B`;
    return n < 1024 * 1024 ? num(n / 1024, "KB") : num(n / (1024 * 1024), "MB");
  }

  function textoResultado(item) {
    const base = ROTULOS_RESULTADO[item?.status] || "Sem resultado";
    const extra = item?.status === "ok" && item.encerrado_em ? ` (encerrado em ${item.encerrado_em})` : "";
    const mensagem = (item?.status === "erro" || item?.status === "nao_encontrado") && item.mensagem ? `: ${item.mensagem}` : "";
    return `${base}${extra}${mensagem}`;
  }

  function textoPulado(pulado) {
    return `${pulado?.numero}: não será finalizado no SoftExpert (${MOTIVOS_PULADO[pulado?.motivo] || pulado?.motivo || "motivo não informado"}).`;
  }

  /** Botão por chamado: precisa de descrição, nenhuma rotina rodando e o chamado ainda não finalizado. */
  function podeFinalizar(descricao, finalizacao, emAndamento) {
    return String(descricao || "").trim() !== "" && !emAndamento && !STATUS_DESFEITOS.includes(finalizacao?.status);
  }

  /** O que "Atualizar Dashboard" finalizaria de verdade: D virando FINALIZADO, número UTIC, com descrição, ainda não finalizado. */
  function candidatosFinalizar(abertos, edicoes, soft) {
    return payloadEdicoes(abertos, edicoes)
      .filter(e => String(e.D || "").toUpperCase() === "FINALIZADO" && NUMERO_UTIC.test(e.numero))
      .map(e => e.numero)
      .filter(numero => podeFinalizar(soft?.[numero]?.descricao, soft?.[numero]?.finalizacao, false));
  }

  function resumoResultado(resultado) {
    const lista = resultado?.resultados || [];
    if (!lista.length) return resultado?.cancelado ? "Finalização cancelada." : "Finalização terminada sem resultado por chamado.";
    const contar = status => lista.filter(r => r.status === status).length;
    const partes = [
      [contar("ok"), "finalizado(s)"], [contar("ja_finalizado"), "já finalizado(s)"], [contar("erro"), "com erro"],
      [contar("nao_encontrado"), "não encontrado(s)"],
      [contar("sem_descricao"), "sem descrição"], [contar("pronto"), "só conferido(s)"],
    ].filter(([n]) => n > 0).map(([n, texto]) => `${n} ${texto}`);
    return `${resultado.cancelado ? "Finalização cancelada" : "Finalização no SoftExpert terminada"}: ${partes.join(", ")}.`;
  }

  function resumoInicio(fechar) {
    const pulados = fechar?.pulados || [];
    if (fechar?.iniciado) {
      const total = (fechar.numeros || []).length;
      return `Finalizando ${total} chamado(s) no SoftExpert…${pulados.length ? ` ${pulados.length} pulado(s).` : ""}`;
    }
    const motivo = fechar?.motivo ? `Nenhum chamado foi finalizado no SoftExpert: ${fechar.motivo}` : "Nenhum chamado foi finalizado no SoftExpert.";
    return pulados.length ? `${motivo} ${pulados.length} pulado(s).` : motivo;
  }

  // ---- Rascunho automático: o que o usuário seleciona fica no navegador, sem precisar de "Atualizar Dashboard" ----

  const CHAVE_RASCUNHO = "simpress:sebrae-rascunho";
  const NUMERO_RASCUNHO = /^(?:UTIC-\d{4}-\d+|linha:\d+)$/i; // também barra chaves como "__proto__" vindas do armazenamento

  /** O rascunho vem do navegador: só números e letras conhecidos, textos curtos. */
  function limparValoresRascunho(bruto) {
    const saida = {};
    if (!bruto || typeof bruto !== "object") return saida;
    Object.entries(bruto).forEach(([numero, campos]) => {
      if (!NUMERO_RASCUNHO.test(numero) || !campos || typeof campos !== "object") return;
      const limpos = {};
      ["A", "B", "D", "J", "R", "S"].forEach(letra => {
        if (typeof campos[letra] === "string" && campos[letra].length <= 80) limpos[letra] = campos[letra];
      });
      if (Object.keys(limpos).length) saida[numero] = limpos;
    });
    return saida;
  }

  /** Rascunho salvo para ESTE Dashboard importado; outro arquivo importado, armazenamento indisponível ou texto corrompido dão rascunho vazio. */
  function lerRascunho(armazenamento, importadoEm) {
    const vazio = { valores: {}, edicoes: {}, salvoEm: "" };
    if (!importadoEm) return vazio;
    try {
      const bruto = JSON.parse(armazenamento?.getItem(CHAVE_RASCUNHO) || "null");
      if (!bruto || bruto.importado_em !== importadoEm) return vazio;
      return { valores: limparValoresRascunho(bruto.valores), edicoes: limparValoresRascunho(bruto.edicoes), salvoEm: String(bruto.salvo_em || "") };
    } catch (_erro) {
      return vazio;
    }
  }

  /** `true` só se gravou; sem armazenamento (janela privada, cota cheia) a tela segue funcionando sem rascunho. */
  function gravarRascunho(armazenamento, importadoEm, valores, edicoes) {
    if (!importadoEm || !armazenamento) return false;
    try {
      armazenamento.setItem(CHAVE_RASCUNHO, JSON.stringify({ importado_em: importadoEm, salvo_em: new Date().toISOString(), valores, edicoes }));
      return true;
    } catch (_erro) {
      return false;
    }
  }

  function apagarRascunho(armazenamento) {
    try {
      armazenamento?.removeItem(CHAVE_RASCUNHO);
    } catch (_erro) {
      // sem armazenamento não há rascunho a apagar
    }
  }

  /** Só o que ainda vale: chamados novos que continuam no formulário e campos de antigos ainda vazios no Dashboard (D sempre pode ir a FINALIZADO). */
  function aplicarRascunho(rascunho, formulario, abertos) {
    const novos = new Set((formulario || []).map(item => item.numero));
    const valores = {};
    Object.entries(rascunho.valores).forEach(([numero, campos]) => { if (novos.has(numero)) valores[numero] = campos; });
    const edicoes = {};
    (abertos || []).forEach(item => {
      const campos = rascunho.edicoes[item.numero];
      if (!campos) return;
      const livres = Object.fromEntries(Object.entries(campos).filter(([letra]) => letra === "D" || !String(item.valores?.[letra] || "").trim()));
      if (Object.keys(livres).length) edicoes[item.numero] = livres;
    });
    return { valores, edicoes, restaurado: Object.keys(valores).length + Object.keys(edicoes).length > 0, salvoEm: rascunho.salvoEm };
  }

  function createSebraeDashboard(context) {
    const { app, dom } = context;
    const armazenamento = (() => { try { return window.localStorage || null; } catch (_erro) { return null; } })();
    const estado = {
      formulario: [], valores: {}, consulta: 0, listas: {}, abertos: [], edicoes: {}, atualizavel: false, importadoEm: "", descartar: false,
      soft: {}, refs: new Map(), temporizadores: {}, salvando: {},
      fechar: { emAndamento: false, mensagemInicio: "", numeros: [], pulados: [], resultado: null, sharepoint: null, token: 0 },
    };

    const el = id => document.getElementById(id);

    function definirTexto(id, texto) {
      const elemento = el(id);
      if (elemento) elemento.textContent = texto;
    }

    function formatarDataHora(iso) {
      const data = new Date(iso);
      return Number.isNaN(data.getTime()) ? "" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    }

    function campo(rotulo, controle) {
      const rotuloEl = document.createElement("label");
      rotuloEl.className = "ck-campo";
      rotuloEl.append(dom.createTextElement("span", "ck-campo__rotulo", rotulo), controle);
      return rotuloEl;
    }

    /** Valores digitados: dos chamados novos (``estado.valores``) ou das alterações nos antigos (``estado.edicoes``). */
    function valoresDe(alvo) {
      return alvo === "antigo" ? estado.edicoes : estado.valores;
    }

    function controleManual(numero, letra, alvo = "novo") {
      const antigo = alvo === "antigo";
      const guardados = valoresDe(alvo);
      const valores = guardados[numero] || {};
      const atual = antigo ? estado.abertos.find(item => item.numero === numero)?.valores?.[letra] || "" : "";
      const opcoesLista = estado.listas[letra] || [];
      let controle;
      if (letra === "D" || letra === "J" || opcoesLista.length) {
        controle = document.createElement("select");
        const opcoes = letra === "D" ? STATUS_CHAMADO : letra === "J" ? TIPOS_CHAMADO : opcoesLista;
        const extra = atual && !opcoes.includes(atual) ? [atual] : []; // valor que o chamado já tem e a lista não traz
        [["", "Escolher"], ...[...opcoes, ...extra].map(o => [o, o])].forEach(([valor, texto]) => {
          const opcao = document.createElement("option");
          opcao.value = valor;
          opcao.textContent = texto;
          controle.appendChild(opcao);
        });
      } else {
        controle = document.createElement("input");
        controle.type = letra === "R" ? "datetime-local" : "text";
        if (letra !== "R") {
          controle.maxLength = 80;
          controle.setAttribute("list", `sebrae-sugestoes-${letra.toLowerCase()}`);
          controle.autocomplete = "off";
        }
      }
      controle.className = "ck-entrada ck-entrada--sm";
      const inicial = antigo ? (letra === "R" ? encerramentoParaCampo(atual) : atual) : PADROES_MANUAIS[letra] ?? "";
      controle.value = valores[letra] ?? inicial;
      if (antigo && atual && letra !== "D") controle.disabled = true; // antigo só recebe o que está vazio; o Status ainda pode ir a FINALIZADO
      if (!antigo && !(letra in valores) && controle.value) guardados[numero] = { ...valores, [letra]: controle.value };
      controle.dataset.sebraeNumero = numero;
      controle.dataset.sebraeCampo = letra;
      controle.dataset.sebraeAlvo = alvo;
      controle.addEventListener("input", aoEditar);
      controle.addEventListener("change", aoEditar);
      return controle;
    }

    const PADROES_MANUAIS = Object.freeze({ D: "EM ABERTO", S: "DISPONIBILIDADE" }); // Status e Tipo SLA habituais dos novos; o usuário pode trocar ou apagar

    const ROTULOS_MANUAIS = Object.freeze({
      A: "Responsável (A) *", B: "Categoria (B)", D: "Status (D) *", J: "Tipo do chamado (J) *",
      R: "Encerramento (R)", S: "Tipo SLA (S)",
    });

    function blocoAntigo(item) {
      const artigo = document.createElement("article");
      artigo.className = "sebrae-chamado";
      artigo.dataset.numero = item.numero;
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", tituloAntigo(item));
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", item.titulo || "Sem título"));
      const fatos = document.createElement("dl");
      fatos.className = "ck-fatos sebrae-chamado__auto";
      [["I", "Solicitante", item.usuario], ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => [letra, rotulo, item.automaticos?.[letra]])].forEach(([letra, rotulo, atual]) => {
        const sugerido = item.automaticos_sugeridos?.[letra];
        if (!atual && !sugerido) return;
        const linha = document.createElement("div");
        linha.append(dom.createTextElement("dt", "", rotulo), dom.createTextElement("dd", "", atual || `${sugerido} (será preenchido)`));
        fatos.appendChild(linha);
      });
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleManual(item.numero, letra, "antigo"))));
      artigo.append(titulo, fatos);
      const outra = avisoOutraPessoa(item) || avisoNomeDaDescricao(item);
      if (outra) artigo.appendChild(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", outra));
      artigo.appendChild(manuais);
      if (NUMERO_UTIC.test(item.numero)) artigo.appendChild(secaoFinalizar(item));
      return artigo;
    }

    function blocoChamado(item) {
      const artigo = document.createElement("article");
      artigo.className = "sebrae-chamado";
      artigo.dataset.numero = item.numero;
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", item.linha.G || "Sem título"));
      const fatos = document.createElement("dl");
      fatos.className = "ck-fatos sebrae-chamado__auto";
      CAMPOS_AUTOMATICOS.forEach(([letra, rotulo]) => {
        const linha = document.createElement("div");
        linha.append(dom.createTextElement("dt", "", rotulo), dom.createTextElement("dd", "", item.linha[letra] || "—"));
        fatos.appendChild(linha);
      });
      artigo.append(titulo, fatos);
      const aviso = [avisoOutraPessoa(item), avisoNomeDaDescricao(item), AVISO_CRUZAMENTO[item.cruzamento?.status]].filter(Boolean).join(" ");
      if (aviso) artigo.appendChild(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", aviso));
      [["H", "Descrição"], ["F", "Atendimento realizado"]].forEach(([letra, rotulo]) => {
        const detalhe = document.createElement("details");
        detalhe.className = "sebrae-chamado__texto";
        detalhe.append(dom.createTextElement("summary", "", rotulo), dom.createTextElement("p", "", item.linha[letra] || "Vazio"));
        artigo.appendChild(detalhe);
      });
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleManual(item.numero, letra))));
      artigo.appendChild(manuais);
      return artigo;
    }

    // ---- Finalizar no SoftExpert: descrição, PDF opcional, botão por chamado, resultado e aviso do SharePoint ----

    const urlChamado = (numero, parte) => `/api/sebrae/chamados/${encodeURIComponent(numero)}/${parte}`;
    const esperar = ms => new Promise(resolve => window.setTimeout(resolve, ms));

    function definirFeedback(elemento, texto, situacao = "") {
      if (!elemento) return;
      elemento.textContent = texto;
      elemento.dataset.estado = situacao;
    }

    function secaoFinalizar(item) {
      const numero = item.numero;
      const guardado = item.softexpert || {};
      const soft = estado.soft[numero] = {
        descricao: guardado.descricao_finalizacao || "", enviado: guardado.descricao_finalizacao || "",
        pdf: guardado.pdf || null, finalizacao: guardado.finalizacao || null, processando: false,
      };
      const area = document.createElement("div");
      area.className = "sebrae-chamado__finalizar";
      const texto = document.createElement("textarea");
      texto.className = "ck-entrada";
      texto.rows = 4;
      texto.maxLength = MAX_DESCRICAO;
      texto.value = soft.descricao;
      texto.dataset.sebraeDescricao = numero;
      const feedbackDescricao = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__feedback", `Salva automaticamente. Até ${MAX_DESCRICAO} caracteres.`);
      feedbackDescricao.setAttribute("role", "status");
      const arquivo = document.createElement("input");
      arquivo.type = "file";
      arquivo.accept = ".pdf,application/pdf";
      arquivo.dataset.sebraePdf = numero;
      const infoPdf = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__pdf", "");
      const remover = document.createElement("button");
      remover.type = "button";
      remover.className = "ck-btn ck-btn--fantasma ck-btn--sm";
      remover.textContent = "Remover PDF";
      remover.dataset.sebraePdfRemover = numero;
      const feedbackPdf = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__feedback", "");
      feedbackPdf.setAttribute("role", "status");
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "ck-btn ck-btn--primario ck-btn--sm";
      botao.textContent = "Finalizar no SoftExpert";
      botao.dataset.sebraeFinalizar = numero;
      const resultado = dom.createTextElement("p", "ck-cartao__meta sebrae-chamado__resultado", "");
      resultado.setAttribute("role", "status");
      const pdfLinha = document.createElement("div");
      pdfLinha.className = "sebrae-chamado__pdf-linha";
      pdfLinha.append(infoPdf, remover);
      area.append(
        campo("Descrição para Finalizar o Chamado", texto), feedbackDescricao,
        campo("Anexo PDF (opcional)", arquivo), pdfLinha, feedbackPdf,
        botao, resultado,
      );
      estado.refs.set(numero, { texto, feedbackDescricao, arquivo, infoPdf, remover, feedbackPdf, botao, resultado });
      texto.addEventListener("input", () => {
        window.clearTimeout(estado.temporizadores[numero]);
        estado.temporizadores[numero] = window.setTimeout(() => salvarDescricao(numero), 800);
        definirFeedback(feedbackDescricao, "Alteração ainda não salva…");
        atualizarFinalizar(numero);
      });
      texto.addEventListener("change", () => salvarDescricao(numero));
      arquivo.addEventListener("change", () => enviarPdf(numero));
      remover.addEventListener("click", () => removerPdf(numero));
      botao.addEventListener("click", () => finalizarNoSoftExpert(numero));
      atualizarFinalizar(numero);
      return area;
    }

    function atualizarFinalizar(numero) {
      const ref = estado.refs.get(numero);
      const soft = estado.soft[numero];
      if (!ref || !soft) return;
      ref.botao.disabled = !podeFinalizar(ref.texto.value, soft.finalizacao, estado.fechar.emAndamento);
      ref.botao.title = ref.botao.disabled && !String(ref.texto.value).trim() ? "Preencha a descrição para finalizar o chamado." : "";
      ref.infoPdf.textContent = soft.pdf ? `PDF anexado: ${soft.pdf.nome} (${formatarTamanho(soft.pdf.tamanho)})` : "Nenhum PDF anexado.";
      ref.remover.hidden = !soft.pdf;
      const quando = formatarDataHora(soft.finalizacao?.em);
      ref.resultado.textContent = soft.processando ? "Finalizando no SoftExpert…"
        : soft.finalizacao ? `${textoResultado(soft.finalizacao)}${quando ? ` · ${quando}` : ""}` : "";
      ref.resultado.dataset.estado = soft.processando ? "andamento" : soft.finalizacao?.status || "";
    }

    function atualizarTodosFinalizar() {
      estado.refs.forEach((_ref, numero) => atualizarFinalizar(numero));
    }

    /** Salvamentos do mesmo chamado entram em fila: o último texto digitado é o que fica no servidor. */
    function salvarDescricao(numero) {
      window.clearTimeout(estado.temporizadores[numero]);
      const fila = (estado.salvando[numero] || Promise.resolve(true)).then(() => enviarDescricao(numero));
      estado.salvando[numero] = fila;
      return fila;
    }

    async function enviarDescricao(numero) {
      const ref = estado.refs.get(numero);
      const soft = estado.soft[numero];
      if (!ref || !soft) return true;
      const texto = ref.texto.value;
      if (texto === soft.enviado) return true;
      definirFeedback(ref.feedbackDescricao, "Salvando…");
      try {
        const dados = await app.apiFetch(urlChamado(numero, "finalizacao"), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ descricao_finalizacao: texto }),
          errorMessage: "Não foi possível salvar a descrição.",
        });
        soft.enviado = texto;
        soft.descricao = dados.descricao_finalizacao ?? texto;
        definirFeedback(ref.feedbackDescricao, "Descrição salva.", "ok");
        return true;
      } catch (error) {
        definirFeedback(ref.feedbackDescricao, `Não foi possível salvar: ${error.message}`, "erro");
        return false;
      } finally {
        atualizarFinalizar(numero);
      }
    }

    async function enviarPdf(numero) {
      const ref = estado.refs.get(numero);
      const arquivo = ref?.arquivo.files?.[0];
      if (!arquivo) return;
      const corpo = new FormData();
      corpo.append("file", arquivo);
      definirFeedback(ref.feedbackPdf, "Enviando PDF…");
      try {
        const dados = await app.apiFetch(urlChamado(numero, "anexo"), { method: "POST", body: corpo, errorMessage: "Não foi possível enviar o PDF." });
        estado.soft[numero].pdf = dados.pdf || null;
        definirFeedback(ref.feedbackPdf, "PDF salvo.", "ok");
      } catch (error) {
        definirFeedback(ref.feedbackPdf, `PDF não salvo: ${error.message}`, "erro");
      } finally {
        ref.arquivo.value = "";
        atualizarFinalizar(numero);
      }
    }

    async function removerPdf(numero) {
      const ref = estado.refs.get(numero);
      if (!ref) return;
      definirFeedback(ref.feedbackPdf, "Removendo PDF…");
      try {
        const dados = await app.apiFetch(urlChamado(numero, "anexo"), { method: "DELETE", errorMessage: "Não foi possível remover o PDF." });
        estado.soft[numero].pdf = dados.pdf || null;
        definirFeedback(ref.feedbackPdf, "PDF removido.", "ok");
      } catch (error) {
        definirFeedback(ref.feedbackPdf, `PDF não removido: ${error.message}`, "erro");
      } finally {
        atualizarFinalizar(numero);
      }
    }

    async function finalizarNoSoftExpert(numero) {
      const ref = estado.refs.get(numero);
      const soft = estado.soft[numero];
      if (!ref || ref.botao.disabled) return;
      const confirmado = await app.confirmarAcao({
        titulo: "Finalizar no SoftExpert",
        mensagem: `Finalizar ${numero} no SoftExpert? Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada`
          + `${soft.pdf ? " e o PDF anexado será enviado" : ""}.`,
        confirmar: "Confirmar finalização", cancelar: "Cancelar",
      });
      if (!confirmado) return;
      ref.botao.disabled = true;
      if (!(await salvarDescricao(numero))) {
        app.showToast("Salve a descrição antes de finalizar.", "error");
        atualizarFinalizar(numero);
        return;
      }
      try {
        await app.apiFetch("/api/sebrae/finalizar-softexpert", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numero, confirmado: true }),
          errorMessage: "Não foi possível iniciar a finalização no SoftExpert.",
        });
      } catch (error) {
        soft.finalizacao = { status: "erro", mensagem: error.message };
        atualizarFinalizar(numero);
        app.showToast(error.message, "error");
        return;
      }
      acompanharFechar([numero]);
    }

    function renderizarFechar() {
      const host = el("sebrae-fechar");
      if (!host) return;
      const f = estado.fechar;
      const res = f.resultado;
      const aoVivo = f.emAndamento && Boolean(res?.em_andamento);
      const pulados = f.pulados.length ? f.pulados : res?.pulados || [];
      let status = "";
      if (f.emAndamento) status = `Finalizando no SoftExpert…${aoVivo && f.numeros.length ? ` ${(res.resultados || []).length} de ${f.numeros.length} concluído(s).` : ""}`;
      else if (f.mensagemInicio) status = f.mensagemInicio;
      else if (res) status = resumoResultado(res);
      host.hidden = !status;
      definirTexto("sebrae-fechar-status", status);
      host.setAttribute("aria-busy", f.emAndamento ? "true" : "false");
      const itens = [
        ...(f.emAndamento && !aoVivo ? [] : (res?.resultados || []).map(r => ({ status: r.status, texto: `${r.numero}: ${textoResultado(r)}` }))),
        ...pulados.map(p => ({ status: "pulado", texto: textoPulado(p) })),
      ];
      el("sebrae-fechar-lista")?.replaceChildren(...itens.map(item => {
        const li = dom.createTextElement("li", "sebrae-fechar__item", item.texto);
        li.dataset.status = item.status;
        return li;
      }));
    }

    function renderizarSharepoint() {
      const host = el("sebrae-sharepoint-aviso");
      if (!host) return;
      const aviso = estado.fechar.sharepoint;
      if (!aviso?.falhou) {
        host.hidden = true;
        host.replaceChildren();
        return;
      }
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = "ck-btn ck-btn--secundario ck-btn--sm";
      botao.id = "btn-sebrae-reenviar";
      botao.textContent = "Tentar substituir de novo";
      botao.disabled = estado.fechar.emAndamento;
      botao.addEventListener("click", reenviarPendente);
      const copiaCodigo = document.createElement("code");
      copiaCodigo.textContent = aviso.copia_local || "—";
      const copia = document.createElement("p");
      copia.append("Cópia local pendente: ", copiaCodigo);
      const sugestoes = document.createElement("ol");
      (aviso.sugestoes || []).forEach(texto => sugestoes.appendChild(dom.createTextElement("li", "", texto)));
      host.replaceChildren(
        dom.createTextElement("strong", "", "O Dashboard não foi substituído no SharePoint."),
        dom.createTextElement("p", "", `Motivo: ${aviso.motivo || "não informado"}.`),
        copia,
        dom.createTextElement("p", "", aviso.copia_sharepoint
          ? "A cópia pendente também foi enviada à pasta DASHBOARD SEBRAE, com outro nome."
          : "A cópia pendente não foi enviada ao SharePoint: ela está só neste computador."),
        dom.createTextElement("p", "ck-campo__ajuda", "O que fazer:"),
        sugestoes, botao,
      );
      host.hidden = false;
    }

    /** Aplica o que o GET trouxe: estado da rotina, resultado por chamado (também nos cartões) e aviso do SharePoint. */
    function aplicarFechar(dados) {
      const f = estado.fechar;
      f.emAndamento = Boolean(dados?.em_andamento);
      f.resultado = dados?.resultado || null;
      f.sharepoint = dados?.sharepoint || null;
      (f.resultado?.resultados || []).forEach(r => {
        const soft = estado.soft[r.numero];
        if (!soft) return;
        soft.finalizacao = { status: r.status, em: r.em, encerrado_em: r.encerrado_em, mensagem: r.mensagem };
        soft.processando = false;
      });
      if (!f.emAndamento) Object.values(estado.soft).forEach(soft => { soft.processando = false; });
      renderizarFechar();
      renderizarSharepoint();
      atualizarTodosFinalizar();
    }

    /** Consulta a rotina até terminar; erros passageiros de rede não derrubam o acompanhamento. */
    async function acompanharFechar(numeros) {
      const f = estado.fechar;
      const token = ++f.token;
      const anterior = f.resultado?.iniciado_em;
      f.emAndamento = true;
      f.numeros = numeros;
      numeros.forEach(numero => { if (estado.soft[numero]) estado.soft[numero].processando = true; });
      renderizarFechar();
      renderizarSharepoint();
      atualizarTodosFinalizar();
      let visto = false;
      let esperas = 0;
      let falhas = 0;
      while (token === f.token) {
        await esperar(INTERVALO_FECHAR_MS);
        if (token !== f.token) return;
        let dados;
        try {
          dados = await app.apiFetch("/api/sebrae/finalizar-softexpert", { errorMessage: "Não foi possível consultar a finalização." });
          falhas = 0;
        } catch (error) {
          if (++falhas < 5) continue;
          f.emAndamento = false;
          f.mensagemInicio = `Não foi possível acompanhar a finalização: ${error.message}`;
          Object.values(estado.soft).forEach(soft => { soft.processando = false; });
          renderizarFechar();
          atualizarTodosFinalizar();
          return;
        }
        visto = visto || Boolean(dados.em_andamento);
        const comecou = visto || dados.resultado?.iniciado_em !== anterior;
        if (!dados.em_andamento && !comecou && ++esperas < 4) continue; // a rotina ainda não começou a responder
        f.mensagemInicio = "";
        aplicarFechar(dados);
        if (!dados.em_andamento) return;
      }
    }

    /** Uma consulta ao abrir a lista: pega rotina em andamento, o último resultado e o aviso do SharePoint. */
    async function carregarFechar() {
      try {
        const acompanhando = estado.fechar.emAndamento;
        const dados = await app.apiFetch("/api/sebrae/finalizar-softexpert", { errorMessage: "Não foi possível consultar a finalização." });
        if (acompanhando) return; // o acompanhamento em curso já atualiza a tela
        aplicarFechar(dados);
        if (dados.em_andamento) acompanharFechar([]);
      } catch (_erro) {
        // Sem o resultado da rotina a tela segue funcionando; a próxima consulta traz o aviso de volta.
      }
    }

    async function reenviarPendente() {
      const botao = el("btn-sebrae-reenviar");
      if (botao) botao.disabled = true;
      try {
        await app.apiFetch("/api/sebrae/dashboard/pendente/reenviar", { method: "POST", errorMessage: "Não foi possível reenviar a cópia pendente." });
      } catch (error) {
        if (botao) botao.disabled = false;
        app.showToast(error.message, "error");
        return;
      }
      acompanharFechar([]);
    }

    /** Lê o campo `fechar` do Atualizar; qualquer falha aqui só some com a informação, nunca estraga a atualização. */
    function tratarFechar(fechar) {
      try {
        if (!fechar || typeof fechar !== "object") return;
        const f = estado.fechar;
        f.pulados = Array.isArray(fechar.pulados) ? fechar.pulados : [];
        f.mensagemInicio = resumoInicio(fechar);
        if (fechar.iniciado) acompanharFechar(Array.isArray(fechar.numeros) ? fechar.numeros : []);
        else {
          f.emAndamento = false;
          renderizarFechar();
        }
      } catch (_erro) {
        // O arquivo já foi baixado; a finalização pode ser acompanhada depois pelo botão de cada chamado.
      }
    }

    function aoEditar(event) {
      const { sebraeNumero, sebraeCampo, sebraeAlvo } = event.currentTarget.dataset;
      const guardados = valoresDe(sebraeAlvo);
      guardados[sebraeNumero] = { ...(guardados[sebraeNumero] || {}), [sebraeCampo]: event.currentTarget.value };
      salvarRascunho();
      atualizarExportacao();
    }

    function mostrarRascunho(texto) {
      definirTexto("sebrae-rascunho-status", texto);
      const bloco = el("sebrae-rascunho");
      if (bloco) bloco.hidden = !texto;
    }

    function salvarRascunho() {
      if (!gravarRascunho(armazenamento, estado.importadoEm, estado.valores, estado.edicoes)) return;
      mostrarRascunho(`Rascunho salvo automaticamente neste navegador às ${new Date().toLocaleTimeString("pt-BR")}.`);
    }

    /** Volta ao que o Dashboard importado traz: apaga o rascunho e refaz a tela (se a consulta falhar, nada muda). */
    async function descartarRascunhoSebrae() {
      const confirmado = await app.confirmarAcao({
        titulo: "Descartar rascunho",
        mensagem: "Descartar o que foi preenchido e ainda não passou por Atualizar Dashboard? Os campos voltam ao que o Dashboard importado traz.",
        confirmar: "Descartar rascunho", cancelar: "Cancelar",
      });
      if (!confirmado) return;
      estado.descartar = true;
      try {
        await carregarNovosSebrae();
      } finally {
        estado.descartar = false;
      }
    }

    function atualizarExportacao() {
      const prontos = payloadExportacao(estado.formulario, estado.valores).length;
      const botao = el("btn-sebrae-exportar");
      if (botao) botao.disabled = prontos === 0;
      const total = estado.formulario.length;
      definirTexto("sebrae-exportacao-status", total ? `${prontos} de ${total} chamado(s) com Responsável, Status e Tipo preenchidos.` : "");
      atualizarBotaoAtualizar();
    }

    function atualizarBotaoAtualizar() {
      const botao = el("btn-sebrae-atualizar");
      if (!botao) return;
      const alteracoes = payloadEdicoes(estado.abertos, estado.edicoes).length;
      const preenchimentos = totalPreenchimentos(estado.abertos);
      botao.disabled = !estado.atualizavel || (estado.formulario.length === 0 && alteracoes === 0 && preenchimentos === 0);
      definirTexto("sebrae-antigos-resumo", estado.abertos.length
        ? `${estado.abertos.length} chamado(s) antigo(s) em aberto ou sem status; ${alteracoes} com alteração e ${preenchimentos} com Série, Modelo, Cidade ou OS a preencher.`
        : "Nenhum chamado antigo em aberto ou sem status neste Dashboard.");
    }

    function renderizarAvisos(novos) {
      const host = el("sebrae-novos-avisos");
      if (!host) return;
      const itens = [
        ...(novos?.pendentes || []).map(p => `${p.numero}: pendente. ${p.motivo}`),
        ...Object.entries(novos?.erros || {}).map(([numero, motivo]) => `${numero}: não foi lido. ${motivo}`),
      ];
      if (!itens.length) {
        host.replaceChildren();
        return;
      }
      const lista = document.createElement("ul");
      lista.className = "sebrae-avisos";
      itens.forEach(texto => lista.appendChild(dom.createTextElement("li", "ck-cartao__meta", texto)));
      host.replaceChildren(dom.createTextElement("p", "ck-campo__ajuda", "Sem formulário (veja os motivos):"), lista);
    }

    function renderizar(dados) {
      const importado = dados.importado;
      estado.listas = importado?.listas || {};
      estado.abertos = importado?.abertos || [];
      estado.atualizavel = Boolean(importado?.atualizavel);
      estado.importadoEm = importado?.importado_em || "";
      if (estado.descartar) {
        apagarRascunho(armazenamento);
        estado.valores = {};
      }
      const novos = dados.novos;
      const rascunho = aplicarRascunho(lerRascunho(armazenamento, estado.importadoEm), novos?.formulario, estado.abertos);
      estado.edicoes = rascunho.edicoes;
      Object.entries(rascunho.valores).forEach(([numero, campos]) => { estado.valores[numero] = { ...campos, ...estado.valores[numero] }; });
      const salvoEm = formatarDataHora(rascunho.salvoEm);
      mostrarRascunho(estado.descartar ? "Rascunho descartado." : rascunho.restaurado ? `Rascunho restaurado${salvoEm ? ` (salvo em ${salvoEm})` : ""}. Passe por Atualizar Dashboard para gravar no arquivo.` : "");
      estado.soft = {};
      estado.refs.clear();
      el("sebrae-antigos-lista")?.replaceChildren(...estado.abertos.map(blocoAntigo));
      const painelAntigos = el("sebrae-antigos");
      if (painelAntigos) painelAntigos.hidden = !importado;
      definirTexto("sebrae-dashboard-status", importado
        ? `Dashboard importado: ${importado.arquivo || "sem nome"} (${importado.total} chamados já lançados).${importado.atualizavel ? "" : " Não dá para atualizar a cópia: importe de novo."}`
        : "Nenhum Dashboard importado.");
      // "Enviar ao SharePoint" só tem o que enviar depois de Atualizar; sem a saída, avisa já em vez de falhar no clique.
      if (importado && !importado.saida_pronta) definirTexto("sebrae-atualizar-status", "Gere o Dashboard atualizado antes de enviar ao SharePoint.");
      estado.formulario = novos?.formulario || [];
      const lista = el("sebrae-novos-lista");
      lista?.replaceChildren(...estado.formulario.map(blocoChamado));
      renderizarAvisos(novos);
      if (!importado) definirTexto("sebrae-novos-resumo", "Importe o Dashboard para buscar os chamados novos.");
      else if (!novos) definirTexto("sebrae-novos-resumo", "Nenhuma busca feita ainda. Use Buscar chamados novos.");
      else {
        const quando = formatarDataHora(novos.lidos_em);
        definirTexto("sebrae-novos-resumo",
          `${quando ? `Busca de ${quando}: ` : ""}${estado.formulario.length} novo(s), ${novos.ignorados} já no Dashboard, ${(novos.pendentes || []).length} pendente(s).`);
      }
      atualizarExportacao();
      app.carregarResumoHistoricoSebrae?.();
      carregarFechar();
    }

    async function carregarNovosSebrae() {
      if (!el("sebrae-novos-painel")) return;
      const consulta = ++estado.consulta;
      try {
        const dados = await app.apiFetch("/api/sebrae/novos", { errorMessage: "Não foi possível consultar os chamados novos." });
        if (consulta === estado.consulta) renderizar(dados);
      } catch (error) {
        if (consulta === estado.consulta) definirTexto("sebrae-dashboard-status", error.message);
      }
    }

    async function importarDashboardSebrae(event) {
      event?.preventDefault?.();
      const entrada = el("sebrae-dashboard-file");
      const botao = el("btn-sebrae-importar");
      const arquivo = entrada?.files?.[0];
      if (!arquivo) {
        app.showToast("Selecione o Dashboard em .xlsx.", "warning");
        return;
      }
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      definirTexto("sebrae-dashboard-status", "Lendo a coluna C do Dashboard…");
      const corpo = new FormData();
      corpo.append("file", arquivo);
      try {
        const dados = await app.apiFetch("/api/sebrae/dashboard", {
          method: "POST", body: corpo, errorMessage: "Não foi possível importar o Dashboard.",
        });
        estado.consulta += 1;
        renderizar(dados);
        entrada.value = "";
        entrada.dispatchEvent(new Event("change", { bubbles: true }));
        app.showToast("Dashboard importado.", "success");
      } catch (error) {
        definirTexto("sebrae-dashboard-status", error.message);
        app.showToast(error.message, "error");
      } finally {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
      }
    }

    async function exportarChamadosSebrae() {
      const chamados = payloadExportacao(estado.formulario, estado.valores);
      if (!chamados.length) return;
      const botao = el("btn-sebrae-exportar");
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        const dados = await app.apiFetch("/api/sebrae/exportar", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chamados }),
          errorMessage: "Não foi possível exportar as linhas.",
        });
        el("sebrae-bloco-a-p").value = dados.bloco_a_p;
        el("sebrae-bloco-r-s").value = dados.bloco_r_s;
        el("sebrae-exportacao-blocos").hidden = false;
        try {
          await app.copiarTextoParaAreaTransferencia(dados.bloco_a_p);
        } catch (_erro) {
          // O usuário ainda pode copiar pelos botões abaixo dos blocos.
        }
        definirTexto("sebrae-exportacao-status", dados.mensagem);
      } catch (error) {
        definirTexto("sebrae-exportacao-status", error.message);
        app.showToast(error.message, "error");
      } finally {
        botao.removeAttribute("aria-busy");
        atualizarBotaoExportar();
      }
    }

    function atualizarBotaoExportar() {
      const botao = el("btn-sebrae-exportar");
      if (botao) botao.disabled = payloadExportacao(estado.formulario, estado.valores).length === 0;
    }

    function baixarArquivo(nome, base64) {
      const bytes = Uint8Array.from(atob(base64), caractere => caractere.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = nome;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    }

    async function atualizarDashboardSebrae() {
      const chamados = payloadAtualizacao(estado.formulario, estado.valores);
      const edicoes = payloadEdicoes(estado.abertos, estado.edicoes);
      if (!estado.atualizavel || (!chamados.length && !edicoes.length && !totalPreenchimentos(estado.abertos))) return;
      const botao = el("btn-sebrae-atualizar");
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        // Finalizar no SoftExpert não tem volta: quem marcou FINALIZADO com descrição confirma antes de qualquer envio.
        await Promise.all(Object.keys(estado.soft).map(salvarDescricao));
        const finalizar = candidatosFinalizar(estado.abertos, estado.edicoes, estado.soft);
        // Cancelar e Esc (o diálogo resolve false) só atualizam o Dashboard: nunca finalizam.
        const finalizarSoftExpert = finalizar.length > 0 && await app.confirmarAcao({
          titulo: "Atualizar Dashboard e finalizar no SoftExpert",
          mensagem: `${finalizar.length} chamado(s) marcado(s) como FINALIZADO (${finalizar.join(", ")}) podem ser finalizados no SoftExpert. `
            + "Atualizar e finalizar: atualiza o Dashboard e finaliza no SoftExpert, o que não tem volta. "
            + "Só atualizar: atualiza o Dashboard e NÃO finaliza nada no SoftExpert.",
          confirmar: "Atualizar e finalizar", cancelar: "Só atualizar",
        });
        const dados = await app.apiFetch("/api/sebrae/dashboard/atualizar", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chamados, edicoes, finalizar_softexpert: finalizarSoftExpert }),
          errorMessage: "Não foi possível atualizar o Dashboard.",
        });
        baixarArquivo(dados.arquivo, dados.conteudo_base64);
        const novos = dados.linhas.filter(linha => linha.tipo === "novo").length;
        const quando = formatarDataHora(dados.base?.importado_em);
        definirTexto("sebrae-atualizar-status",
          `Baixado "${dados.arquivo}": ${novos} novo(s) e ${dados.linhas.length - novos} alterado(s). `
          + `Baseado no Dashboard importado${quando ? ` em ${quando}` : ""}. Para não perder edições de outras pessoas, importe a versão atual antes.`
          + (finalizar.length && !finalizarSoftExpert ? " Dashboard atualizado; nenhum chamado foi finalizado no SoftExpert." : ""));
        app.showToast("Dashboard atualizado. Use Enviar ao SharePoint para sobrepor o arquivo.", "success");
        tratarFechar(dados.fechar);
      } catch (error) {
        definirTexto("sebrae-atualizar-status", error.message);
        app.showToast(error.message, "error");
      } finally {
        botao.removeAttribute("aria-busy");
        atualizarBotaoAtualizar();
      }
    }

    async function copiarBlocoSebrae(bloco) {
      const campoBloco = el(bloco === "r_s" ? "sebrae-bloco-r-s" : "sebrae-bloco-a-p");
      if (!campoBloco?.value) return;
      try {
        await app.copiarTextoParaAreaTransferencia(campoBloco.value);
        app.showToast("Bloco copiado.", "success");
      } catch (error) {
        app.showToast(error.message, "error");
      }
    }

    return { carregarNovosSebrae, importarDashboardSebrae, exportarChamadosSebrae, atualizarDashboardSebrae, copiarBlocoSebrae, descartarRascunhoSebrae };
  }

  createSebraeDashboard.puro = { formatarEncerramento, encerramentoParaCampo, chamadoPronto, payloadExportacao, payloadAtualizacao, payloadEdicoes, avisoOutraPessoa, avisoNomeDaDescricao, tituloAntigo, totalPreenchimentos,
    formatarTamanho, textoResultado, textoPulado, podeFinalizar, candidatosFinalizar, resumoResultado, resumoInicio,
    lerRascunho, gravarRascunho, apagarRascunho, aplicarRascunho };
  return createSebraeDashboard;
})());
