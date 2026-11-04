/** Automação → "Chamados novos do SoftExpert": importa o Dashboard, lista os novos
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
  const PADROES_MANUAIS = Object.freeze({ D: "EM ABERTO", S: "DISPONIBILIDADE" }); // Status e Tipo SLA habituais dos novos; o usuário pode trocar ou apagar
  // Chamados criados pela API: classificação habitual (A, B, J) mais os padrões de todos; a descrição "Revisado." entra uma vez só (secaoFinalizar)
  const PADROES_API_SEBRAE = Object.freeze({ A: "CLIENTE", B: "OUTRO", D: "EM ABERTO", J: "INCIDENTE", S: "DISPONIBILIDADE" });
  const DESCRICAO_API_SEBRAE = "Revisado.";
  const SOLICITANTE_API_SEBRAE = "api sebrae"; // mesma comparação de SOLICITANTE_SEM_EMAIL (scripts/sebrae_softexpert.py): sem acento, maiúsculas e espaços extras

  function ehApiSebrae(solicitante) {
    const limpo = String(solicitante || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    return limpo === SOLICITANTE_API_SEBRAE;
  }

  /** Padrões de um chamado novo; recebe o solicitante (coluna I) ou o item do formulário. */
  function padroesManuais(origem) {
    const solicitante = origem && typeof origem === "object" ? origem.linha?.I : origem;
    return ehApiSebrae(solicitante) ? PADROES_API_SEBRAE : PADROES_MANUAIS;
  }
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

  /** O que mostrar do antigo: o Dashboard manda; título e solicitante vazios usam a leitura do SoftExpert (botão Ler chamados antigos). */
  function dadosAntigo(item) {
    const leitura = item.leitura_softexpert || null;
    const texto = valor => String(valor ?? "").trim();
    return {
      lido: Boolean(leitura),
      titulo: texto(item.titulo) || texto(leitura?.titulo),
      solicitante: texto(item.usuario) || texto(leitura?.solicitante),
      descricao: texto(leitura?.descricao), atendimento: texto(leitura?.atendimento), abertura: texto(leitura?.habilitada_em),
    };
  }

  /** Texto da leitura dos antigos: andamento (X de Y), resultado ou interrupção. `anteriorEm` ignora o resultado da execução anterior. */
  function resumoLeituraAntigos(resultado, emAndamento, quando = "", anteriorEm = null) {
    const contar = lista => Object.keys(lista || {}).length;
    if (emAndamento) {
      const atual = resultado && resultado.em !== anteriorEm ? resultado : null;
      const feitos = atual ? (atual.lidos || []).length + contar(atual.falhas) : 0;
      return `Lendo chamados antigos no SoftExpert…${atual?.total ? ` ${feitos} de ${atual.total}.` : ""} Para parar, use Cancelar execução.`;
    }
    if (!resultado) return "";
    const extras = [
      [resultado.ja_lidos, "já lido(s) antes"], [resultado.sem_utic, "sem UTIC (não dá para ler)"],
    ].filter(([n]) => n > 0).map(([n, texto]) => `, ${n} ${texto}`).join("");
    const inicio = `Leitura dos antigos${resultado.concluido ? "" : " interrompida"}${quando ? ` de ${quando}` : ""}`;
    return `${inicio}: ${(resultado.lidos || []).length} lido(s), ${contar(resultado.falhas)} com falha${extras}.${resultado.concluido ? "" : " Ler de novo continua de onde parou."}`;
  }

  /** Quantos antigos em aberto o site preencheria (Série, Modelo, Cidade ou OS vazios). */
  function totalPreenchimentos(abertos) {
    return (abertos || []).filter(item => Object.keys(item.automaticos_sugeridos || {}).length > 0).length;
  }

  function linhaChamado(item, v) {
    return { numero: item.numero, A: v.A || "", B: v.B || "", D: v.D || "", J: v.J || "", R: formatarEncerramento(v.R), S: v.S || "" };
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

  /** Rótulos dos campos que precisam estar preenchidos para finalizar (B, R e S ficam opcionais: o horário do SoftExpert substitui o R manual). */
  const ROTULOS_FALTA = Object.freeze({ A: "Responsável (A)", J: "Tipo do chamado (J)" });

  /** O que falta preencher antes de finalizar no SoftExpert: A, J, Status (D) em FINALIZADO e a descrição. */
  function camposFaltando(valores, descricao) {
    const vazio = valor => String(valor || "").trim() === "";
    const faltas = [];
    if (vazio(valores?.A)) faltas.push(ROTULOS_FALTA.A);
    const status = String(valores?.D || "").trim().toUpperCase();
    if (status !== "FINALIZADO") faltas.push(status ? "Status (D) em FINALIZADO (está EM ABERTO)" : "Status (D) em FINALIZADO");
    if (vazio(valores?.J)) faltas.push(ROTULOS_FALTA.J);
    if (vazio(descricao)) faltas.push("Descrição para Finalizar o Chamado");
    return faltas;
  }

  /** O que "Atualizar Dashboard" finalizaria de verdade: D virando FINALIZADO, número UTIC, com descrição, ainda não finalizado. */
  function candidatosFinalizar(abertos, edicoes, soft, formulario = [], valores = {}) {
    const marcados = [
      ...payloadEdicoes(abertos, edicoes),
      ...payloadAtualizacao(formulario, valores),
    ];
    return marcados
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

  const PREFIXO_CAMPO = `${CHAVE_RASCUNHO}:campo:`;

  /** Eventos separados por campo evitam que uma aba substitua o rascunho inteiro de outra. */
  function lerRascunho(armazenamento, importadoEm) {
    const vazio = { valores: {}, edicoes: {}, salvoEm: "" };
    if (!importadoEm) return vazio;
    try {
      let bruto = null;
      try { bruto = JSON.parse(armazenamento?.getItem(CHAVE_RASCUNHO) || "null"); } catch (_erro) { /* registros por campo ainda podem ser lidos */ }
      const migrar = campos => Object.fromEntries(Object.entries(limparValoresRascunho(campos))
        .filter(([numero]) => bruto?.importado_em === importadoEm || NUMERO_UTIC.test(numero)));
      const saida = { valores: migrar(bruto?.valores), edicoes: migrar(bruto?.edicoes), salvoEm: String(bruto?.salvo_em || ""), origens: {} };
      ["valores", "edicoes"].forEach(tipo => Object.entries(saida[tipo]).forEach(([numero, campos]) => {
        saida.origens[numero] = { ...saida.origens[numero], ...Object.fromEntries(Object.keys(campos).map(campo => [campo, bruto?.importado_em])) };
      }));
      const registros = [];
      for (let i = 0; i < (armazenamento?.length || 0); i++) {
        const chave = armazenamento.key(i);
        if (!chave?.startsWith(PREFIXO_CAMPO)) continue;
        try {
          const registro = JSON.parse(armazenamento.getItem(chave));
          if (!registro || typeof registro.em !== "string") continue;
          registros.push({ ...registro, chave });
        } catch (_erro) { /* um registro danificado não oculta os demais */ }
      }
      registros.sort((a, b) => a.em.localeCompare(b.em) || (Number(a.instante) || 0) - (Number(b.instante) || 0) || a.chave.localeCompare(b.chave));
      registros.forEach(registro => {
        if (registro.importado_em !== importadoEm && !NUMERO_UTIC.test(registro.numero)) return;
        const campos = limparValoresRascunho({ [registro.numero]: { [registro.campo]: registro.valor } });
        if (!campos[registro.numero]) return;
        const alvo = registro.alvo === "antigo" ? "edicoes" : "valores";
        // Um chamado pode ter passado de novo para antigo na reimportação.
        ["valores", "edicoes"].forEach(tipo => {
          if (saida[tipo][registro.numero]) delete saida[tipo][registro.numero][registro.campo];
        });
        saida[alvo][registro.numero] = { ...saida[alvo][registro.numero], ...campos[registro.numero] };
        saida.origens[registro.numero] = { ...saida.origens[registro.numero], [registro.campo]: registro.importado_em };
        saida.salvoEm = registro.em;
      });
      return saida;
    } catch (_erro) { return vazio; }
  }

  function gravarCampoRascunho(armazenamento, importadoEm, numero, campo, valor, alvo) {
    if (!armazenamento || !importadoEm) return false;
    try {
      const em = new Date().toISOString();
      const chave = `${PREFIXO_CAMPO}${em}:${Math.random().toString(36).slice(2)}`;
      armazenamento.setItem(chave, JSON.stringify({ importado_em: importadoEm, numero, campo, valor, alvo, em, instante: performance.timeOrigin + performance.now() }));
      return true;
    } catch (_erro) { return false; }
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
      const chaves = [];
      for (let i = 0; i < (armazenamento?.length || 0); i++) {
        const chave = armazenamento.key(i);
        if (chave?.startsWith(PREFIXO_CAMPO)) chaves.push(chave);
      }
      chaves.forEach(chave => armazenamento.removeItem(chave));
      armazenamento?.removeItem(CHAVE_RASCUNHO);
    } catch (_erro) {
      // sem armazenamento não há rascunho a apagar
    }
  }

  /** Só o que ainda vale: chamados novos que continuam no formulário e campos de antigos ainda vazios no Dashboard (D sempre pode ir a FINALIZADO). */
  function aplicarRascunho(rascunho, formulario, abertos, importadoEm = "") {
    const novos = new Set((formulario || []).map(item => item.numero));
    const conhecidos = new Set([...novos, ...(abertos || []).map(item => item.numero)]);
    const valores = {};
    const conflitos = [];
    novos.forEach(numero => {
      const antigos = rascunho.edicoes[numero] || {};
      const recentes = rascunho.valores[numero] || {};
      const campos = {};
      new Set([...Object.keys(antigos), ...Object.keys(recentes)]).forEach(letra => {
        if (letra in antigos && letra in recentes && antigos[letra] !== recentes[letra]) {
          conflitos.push(`${numero} (${letra}): rascunho antigo ${antigos[letra]}; rascunho novo ${recentes[letra]}`);
        } else campos[letra] = recentes[letra] ?? antigos[letra];
      });
      if (Object.keys(campos).length) valores[numero] = campos;
    });
    const edicoes = {};
    (abertos || []).forEach(item => {
      const campos = { ...rascunho.valores[item.numero], ...rascunho.edicoes[item.numero] };
      if (!campos) return;
      const livres = Object.fromEntries(Object.entries(campos).filter(([letra, valor]) => !String(item.valores?.[letra] || "").trim() || (letra === "D" && Boolean(importadoEm) && rascunho.origens?.[item.numero]?.D === importadoEm)));
      if (Object.keys(livres).length) edicoes[item.numero] = livres;
    });
    (abertos || []).forEach(item => {
      const campos = { ...rascunho.valores[item.numero], ...rascunho.edicoes[item.numero] };
      Object.entries(campos).forEach(([letra, valor]) => {
        const atual = letra === "R" ? encerramentoParaCampo(item.valores?.R) : String(item.valores?.[letra] || "");
        if (atual.trim() && atual !== valor && !(letra === "D" && Boolean(importadoEm) && rascunho.origens?.[item.numero]?.D === importadoEm)) conflitos.push(`${item.numero} (${letra}): rascunho ${valor}; Dashboard ${atual}`);
      });
    });
    const pendentes = Object.entries({ ...rascunho.valores, ...rascunho.edicoes }).filter(([numero]) => !conhecidos.has(numero));
    return { valores, edicoes, conflitos, pendentes, restaurado: Object.keys(valores).length + Object.keys(edicoes).length > 0, salvoEm: rascunho.salvoEm };
  }

  function createSebraeDashboard(context) {
    const { app, dom } = context;
    const armazenamento = (() => { try { return window.localStorage || null; } catch (_erro) { return null; } })();
    const estado = {
      naoSalvos: { valores: {}, edicoes: {} }, rascunhoExterno: false, formulario: [], valores: {}, consulta: 0, listas: {}, abertos: [], edicoes: {}, atualizavel: false, importadoEm: "", versaoImportacao: "", descartar: false,
      soft: {}, refs: new Map(), temporizadores: {}, salvando: {}, finalizados: new Set(),
      fechar: { emAndamento: false, mensagemInicio: "", numeros: [], pulados: [], resultado: null, sharepoint: null, token: 0, recarregado: "" },
      antigos: { emAndamento: false, resultado: null, mensagem: "", token: 0, anteriorEm: null },
    };

    if (typeof window.addEventListener === "function") window.addEventListener("storage", evento => {
      if (evento.key === CHAVE_RASCUNHO || evento.key?.startsWith(PREFIXO_CAMPO)) {
        estado.rascunhoExterno = true;
        mostrarRascunho("O rascunho mudou em outra aba. Suas edições foram preservadas; recarregue para conferir a versão mais recente antes de atualizar o Dashboard.", "alerta");
      }
    });

    const el = id => document.getElementById(id);

    function definirTexto(id, texto) {
      const elemento = el(id);
      if (elemento) elemento.textContent = texto;
    }

    /** Texto do resultado de Atualizar Dashboard; `situacao` (ok, alerta, erro) vai para `data-estado` e o CSS pinta a cor. */
    function definirStatusAtualizar(texto, situacao = "") {
      definirTexto("sebrae-atualizar-status", texto);
      const elemento = el("sebrae-atualizar-status");
      if (elemento) elemento.dataset.estado = situacao;
    }

    /** "Enviar ao SharePoint" só vale com o arquivo gerado por Atualizar Dashboard; sem ele a rotina falharia com "Não achei...". */
    function definirEnvioDisponivel(pronto) {
      const botao = el("btn-sebrae-enviar");
      if (!botao) return;
      botao.dataset.semSaida = String(!pronto);
      botao.title = pronto ? "" : "Gere o Dashboard atualizado (Atualizar Dashboard) antes de enviar.";
      if (!pronto) {
        botao.disabled = true;
        botao.setAttribute("aria-disabled", "true");
      } else if (botao.disabled && !botao.hasAttribute("aria-busy")) {
        botao.disabled = false;
        botao.setAttribute("aria-disabled", "false");
      }
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
      const inicial = antigo ? (letra === "R" ? encerramentoParaCampo(atual) : atual) : padroesManuais(estado.formulario.find(item => item.numero === numero))[letra] ?? "";
      controle.value = valores[letra] ?? inicial;
      if (antigo && atual && letra !== "D") controle.disabled = true; // antigo só recebe o que está vazio; o Status ainda pode ir a FINALIZADO
      if (!antigo && !(letra in valores) && controle.value) guardados[numero] = { ...valores, [letra]: controle.value };
      controle.dataset.sebraeNumero = numero;
      controle.dataset.sebraeCampo = letra;
      controle.dataset.sebraeAlvo = alvo;
      destacarFinalizado(controle);
      controle.addEventListener("input", aoEditar);
      controle.addEventListener("change", aoEditar);
      return controle;
    }

    /** Status (D) em FINALIZADO fica verde, para ver de relance quais ainda faltam finalizar. */
    function destacarFinalizado(controle) {
      if (controle.dataset.sebraeCampo === "D") controle.classList.toggle("sebrae-status--finalizado", controle.value === "FINALIZADO");
    }

    /** Valores que valem agora para o chamado: do formulário (novo) ou do Dashboard com as edições não vazias (antigo). */
    function valoresEfetivos(numero) {
      if (estado.soft[numero]?.novo) return estado.valores[numero] || {};
      const efetivos = { ...(estado.abertos.find(item => item.numero === numero)?.valores || {}) };
      Object.entries(estado.edicoes[numero] || {}).forEach(([letra, valor]) => { if (String(valor || "").trim()) efetivos[letra] = valor; });
      return efetivos;
    }

    const ROTULOS_MANUAIS = Object.freeze({
      A: "Responsável (A) *", B: "Categoria (B)", D: "Status (D) *", J: "Tipo do chamado (J) *",
      R: "Encerramento (R)", S: "Tipo SLA (S)",
    });

    /** Cartão do chamado como está na tela agora, guardado no servidor para reaparecer em "Chamados finalizados". */
    function montarFicha(numero) {
      const antigo = estado.abertos.find(item => item.numero === numero);
      const novo = estado.formulario.find(item => item.numero === numero);
      const cortar = texto => String(texto || "").slice(0, 4000);
      let titulo, solicitante, fatos, detalhes = [];
      if (antigo) {
        const dados = dadosAntigo(antigo);
        [titulo, solicitante] = [dados.titulo, dados.solicitante];
        fatos = [["Solicitante", dados.solicitante], ["Abertura", dados.abertura],
          ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => [rotulo, antigo.automaticos?.[letra] || antigo.automaticos_sugeridos?.[letra]])];
        detalhes = [["Descrição", dados.descricao], ["Atendimento realizado", dados.atendimento]];
      } else if (novo) {
        [titulo, solicitante] = [novo.linha.G, novo.linha.I];
        fatos = CAMPOS_AUTOMATICOS.map(([letra, rotulo]) => [rotulo, novo.linha[letra]]);
        detalhes = [["Descrição", novo.linha.H], ["Atendimento realizado", novo.linha.F]];
      } else return null;
      const efetivos = valoresEfetivos(numero);
      const manuais = Object.fromEntries(["A", "B", "D", "J", "S"].map(letra => [letra, String(efetivos[letra] || "").slice(0, 80)])); // R vem do SoftExpert
      const limpar = lista => lista.filter(([, valor]) => String(valor || "").trim()).map(([rotulo, valor]) => [rotulo, cortar(valor)]);
      return { titulo: cortar(titulo), solicitante: cortar(solicitante), fatos: limpar(fatos), detalhes: limpar(detalhes), manuais };
    }

    /** Falha aqui só deixa o cartão finalizado sem a ficha completa; nunca impede a finalização. */
    async function guardarFicha(numero) {
      const ficha = montarFicha(numero);
      if (!ficha) return;
      try {
        await app.apiFetch(urlChamado(numero, "ficha"), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ficha }),
          errorMessage: "Não foi possível guardar a ficha do chamado.",
        });
      } catch (_erro) {
        // o cartão finalizado mostra então só número, encerramento e descrição
      }
    }

    function controleLeitura(letra, valor) {
      const controle = document.createElement("input");
      controle.type = "text";
      controle.className = "ck-entrada ck-entrada--sm";
      controle.value = valor || "";
      controle.disabled = true;
      controle.dataset.sebraeCampo = letra;
      destacarFinalizado(controle);
      return controle;
    }

    // ---- Layout do cartão em três zonas: Solicitação (só leitura), Classificação operacional (manual) e Finalização no SoftExpert ----

    /** Zona do cartão: `div` agrupado com título e selo. `destaque` = faixa de aviso da finalização; `aviso` = frase sob o título. */
    function criarZona(sufixo, titulo, selo, { destaque = false, aviso = "", classe = "" } = {}) {
      const zona = document.createElement("div");
      zona.className = `sebrae-zona sebrae-zona--${sufixo}${classe ? ` ${classe}` : ""}`;
      zona.setAttribute("role", "group");
      zona.setAttribute("aria-label", titulo);
      const cab = document.createElement("div");
      cab.className = `sebrae-zona__cab${destaque ? " sebrae-zona__cab--aviso" : ""}`;
      cab.append(dom.createTextElement("h4", "sebrae-zona__titulo", titulo), dom.createTextElement("span", "sebrae-zona__selo", selo));
      if (aviso) cab.appendChild(dom.createTextElement("p", "sebrae-zona__aviso", aviso));
      zona.appendChild(cab);
      return zona;
    }

    /** Cabeçalho do cartão: título (número · assunto) e selo de situação (`data-status`: info = Novo, vazio = Em aberto, ok = Finalizado). */
    function cabecalhoChamado(titulo, seloTexto, seloStatus) {
      const cab = document.createElement("header");
      cab.className = "sebrae-chamado__cab";
      const selo = dom.createTextElement("span", "ck-badge sebrae-chamado__selo", seloTexto);
      selo.dataset.status = seloStatus;
      cab.append(titulo, selo);
      return cab;
    }

    /** Cartão vazio: `article.sebrae-chamado--novo|antigo|finalizado` com o cabeçalho; as zonas são acrescentadas por quem chama. */
    function cartaoChamado(numero, tipo, titulo, seloTexto, seloStatus) {
      const artigo = document.createElement("article");
      artigo.className = `sebrae-chamado sebrae-chamado--${tipo}`;
      artigo.dataset.numero = numero;
      artigo.appendChild(cabecalhoChamado(titulo, seloTexto, seloStatus));
      return artigo;
    }

    /** Zona 1: fatos, avisos e blocos de texto (Descrição, Atendimento), tudo só leitura. */
    function zonaSolicitacao(fatos, notas, detalhes) {
      const zona = criarZona("solicitacao", "Solicitação", "Somente leitura");
      zona.append(...[fatos, ...notas].filter(Boolean));
      if (detalhes.length) {
        const bloco = document.createElement("div");
        bloco.className = "sebrae-chamado__detalhes";
        bloco.append(...detalhes);
        zona.appendChild(bloco);
      }
      return zona;
    }

    /** Zona 2: os seis campos manuais (A, B, D, J, R, S). */
    function zonaClassificacao(manuais) {
      const zona = criarZona("classificacao", "Classificação operacional", "Preenchimento manual");
      zona.appendChild(manuais);
      return zona;
    }

    function listaFatos(pares) {
      const fatos = document.createElement("dl");
      fatos.className = "ck-fatos sebrae-chamado__auto";
      pares.forEach(([rotulo, valor]) => {
        const linha = document.createElement("div");
        linha.append(dom.createTextElement("dt", "", rotulo), dom.createTextElement("dd", "", valor));
        fatos.appendChild(linha);
      });
      return fatos;
    }

    const SVG_NS = "http://www.w3.org/2000/svg";

    /** Ícone do sprite da página (`#i-pendente`, `#i-ok`); o CSS mostra um ou outro conforme o campo esteja preenchido. */
    function iconePendencia(id, classe) {
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", `ck-ico ck-ico--xs ${classe}`);
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const uso = document.createElementNS(SVG_NS, "use");
      uso.setAttribute("href", `#${id}`);
      svg.appendChild(uso);
      return svg;
    }

    /** Selo "o que falta": quem decide pendente/ok é só o CSS (`:has` nos campos do cartão); o JS não guarda esse estado. */
    function pendenciaItem(requisito, rotulo) {
      const li = document.createElement("li");
      li.className = "sebrae-pend";
      li.dataset.req = requisito;
      li.append(
        iconePendencia("i-pendente", "sebrae-pend__falta"), iconePendencia("i-ok", "sebrae-pend__ok"), rotulo,
        dom.createTextElement("span", "ck-sr sebrae-pend__falta", ": pendente"), dom.createTextElement("span", "ck-sr sebrae-pend__ok", ": ok"),
      );
      return li;
    }

    function listaPendencias() {
      const lista = document.createElement("ul");
      lista.className = "sebrae-pendencias";
      lista.setAttribute("aria-label", "O que falta para finalizar");
      const opcional = dom.createTextElement("li", "sebrae-pend sebrae-pend--opcional", "Encerramento (R): opcional");
      opcional.title = "O horário do SoftExpert substitui o Encerramento (R) digitado";
      lista.append(
        dom.createTextElement("li", "sebrae-pendencias__rotulo", "Para finalizar:"),
        pendenciaItem("A", ROTULOS_FALTA.A), pendenciaItem("D", "Status (D) em FINALIZADO"), pendenciaItem("J", ROTULOS_FALTA.J), pendenciaItem("DESC", "Descrição"),
        opcional,
      );
      return lista;
    }

    /** Mesmo layout do chamado, só leitura, recolhido: o resumo diz número, título, pessoa e encerramento. */
    function textoFinalizado(item) {
      const ficha = item.ficha || {};
      const li = document.createElement("li");
      const detalhe = document.createElement("details");
      detalhe.className = "sebrae-finalizado";
      detalhe.dataset.numero = item.numero;
      const encerramento = item.encerrado_em ? `encerrado em ${item.encerrado_em}` : "";
      detalhe.appendChild(dom.createTextElement("summary", "sebrae-finalizado__resumo", [item.numero, ficha.titulo, ficha.solicitante, encerramento].filter(Boolean).join(" · ")));
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", ficha.titulo || "Sem título"));
      const artigo = cartaoChamado(item.numero, "finalizado", titulo, "Finalizado", "ok");
      artigo.appendChild(zonaSolicitacao((ficha.fatos || []).length ? listaFatos(ficha.fatos) : null, [],
        (ficha.detalhes || []).map(([rotulo, texto]) => blocoDetalhe(rotulo, texto))));
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => {
        const valor = letra === "R" ? item.encerrado_em : letra === "D" ? "FINALIZADO" : ficha.manuais?.[letra];
        manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleLeitura(letra, valor)));
      });
      artigo.appendChild(zonaClassificacao(manuais));
      // Zona 3 concluída: sem pendências nem botões, só a descrição enviada, o PDF e o resultado.
      const zonaFinal = criarZona("finalizacao", "Finalização no SoftExpert", "Concluída", { destaque: true });
      const descricao = document.createElement("textarea");
      descricao.className = "ck-entrada";
      descricao.rows = 3;
      descricao.readOnly = true;
      descricao.placeholder = " ";
      descricao.dataset.sebraeDescricao = item.numero;
      descricao.value = item.descricao || "";
      const colTexto = document.createElement("div");
      colTexto.className = "sebrae-final__texto";
      colTexto.appendChild(campo("Descrição para Finalizar o Chamado", descricao));
      const colAnexo = document.createElement("div");
      colAnexo.className = "sebrae-final__anexo";
      colAnexo.appendChild(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__pdf", item.pdf ? `PDF anexado: ${item.pdf}` : "Nenhum PDF anexado."));
      const quando = formatarDataHora(item.em);
      const resultado = dom.createTextElement("p", "ck-cartao__meta sebrae-chamado__resultado", `${textoResultado({ status: "ok", encerrado_em: item.encerrado_em })}${quando ? ` · ${quando}` : ""}`);
      resultado.dataset.estado = "ok";
      const rodape = document.createElement("div");
      rodape.className = "sebrae-final__rodape";
      rodape.appendChild(resultado);
      const corpo = document.createElement("div");
      corpo.className = "sebrae-final__corpo";
      corpo.append(colTexto, colAnexo, rodape);
      zonaFinal.appendChild(corpo);
      artigo.appendChild(zonaFinal);
      detalhe.appendChild(artigo);
      li.appendChild(detalhe);
      return li;
    }

    /** Bloco recolhido "Descrição" / "Atendimento realizado" (novo, antigo lido e finalizado). */
    function blocoDetalhe(rotulo, texto) {
      const detalhe = document.createElement("details");
      detalhe.className = "sebrae-chamado__texto";
      detalhe.append(dom.createTextElement("summary", "", rotulo), dom.createTextElement("p", "", texto || "Vazio"));
      return detalhe;
    }

    /** Bloco "Descrição" com lápis (F5): o texto muda só neste site, o SoftExpert e a linha já lançada no Dashboard ficam como estão.
     * Texto vazio restaura o original. `aplicar(dados)` atualiza o item em memória (ficha e cartão); nome e cruzamento se refazem ao recarregar. */
    function blocoDescricaoEditavel(item, texto, aplicar) {
      const numero = item.numero;
      let atual = texto || "";
      let editada = Boolean(item.softexpert?.descricao_editada);
      const detalhe = blocoDetalhe("Descrição", atual);
      const resumo = detalhe.querySelector("summary");
      const paragrafo = detalhe.querySelector("p");
      const selo = dom.createTextElement("span", "ck-badge sebrae-selo sebrae-descricao__selo", "Editada");
      selo.dataset.status = "info";
      const lapis = document.createElement("button");
      lapis.type = "button";
      lapis.className = "ck-btn ck-btn--fantasma ck-btn--sm sebrae-descricao__lapis";
      lapis.title = "Editar descrição";
      lapis.setAttribute("aria-label", `Editar descrição de ${numero}`);
      lapis.setAttribute("aria-expanded", "false");
      lapis.dataset.sebraeEditarDescricao = numero;
      lapis.appendChild(iconePendencia("i-pencil", ""));
      resumo.appendChild(selo);
      const entrada = document.createElement("textarea");
      entrada.className = "ck-entrada";
      entrada.rows = 5;
      entrada.maxLength = MAX_DESCRICAO;
      entrada.placeholder = "Vazio volta ao texto original do chamado.";
      entrada.setAttribute("aria-label", `Descrição de ${numero}`);
      entrada.dataset.sebraeDescricaoEditada = numero;
      const criarBotao = (rotulo, classe, chave) => {
        const botao = document.createElement("button");
        botao.type = "button";
        botao.className = `ck-btn ${classe} ck-btn--sm`;
        botao.textContent = rotulo;
        botao.dataset[chave] = numero;
        return botao;
      };
      const salvar = criarBotao("Salvar", "ck-btn--primario", "sebraeSalvarDescricao");
      const cancelar = criarBotao("Cancelar", "ck-btn--secundario", "sebraeCancelarDescricao");
      const restaurar = criarBotao("Restaurar original", "ck-btn--fantasma", "sebraeRestaurarDescricao");
      const acoes = document.createElement("div");
      acoes.className = "sebrae-chamado__acoes";
      acoes.append(salvar, cancelar, restaurar);
      const editor = document.createElement("div");
      editor.className = "sebrae-descricao__editor";
      editor.hidden = true;
      editor.append(entrada, acoes);
      const feedback = dom.createTextElement("span", "sebrae-descricao__feedback", "");
      feedback.setAttribute("role", "status");
      detalhe.append(editor, feedback);
      const mostrarEstado = () => { selo.hidden = !editada; restaurar.hidden = !editada; };
      const abrirEditor = aberto => {
        editor.hidden = !aberto;
        paragrafo.hidden = aberto;
        lapis.setAttribute("aria-expanded", String(aberto));
      };
      mostrarEstado();
      lapis.addEventListener("click", evento => {
        detalhe.open = true;
        entrada.value = atual;
        definirFeedback(feedback, "");
        abrirEditor(true);
        entrada.focus();
      });
      cancelar.addEventListener("click", () => { abrirEditor(false); lapis.focus(); });
      const enviar = async novoTexto => {
        [salvar, cancelar, restaurar].forEach(botao => { botao.disabled = true; });
        definirFeedback(feedback, "Salvando…", "salvando");
        try {
          const dados = await app.apiFetch(urlChamado(numero, "descricao"), {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ descricao: novoTexto }),
            errorMessage: "Não foi possível salvar a descrição.",
          });
          atual = dados.descricao || "";
          editada = Boolean(dados.descricao_editada);
          paragrafo.textContent = atual || "Vazio";
          aplicar(dados);
          mostrarEstado();
          abrirEditor(false);
          definirFeedback(feedback, editada ? "Descrição salva só neste site." : "Descrição original restaurada.", "ok");
          lapis.focus();
        } catch (error) {
          definirFeedback(feedback, `Não foi possível salvar: ${error.message}`, "erro");
        } finally {
          [salvar, cancelar, restaurar].forEach(botao => { botao.disabled = false; });
        }
      };
      salvar.addEventListener("click", () => enviar(entrada.value));
      restaurar.addEventListener("click", () => enviar(""));
      // O lápis fica ao lado do <details>, não dentro do <summary>: botão dentro de summary é "nested-interactive" no axe.
      const envoltorio = document.createElement("div");
      envoltorio.className = "sebrae-descricao";
      envoltorio.append(lapis, detalhe); // lápis primeiro: a ordem do Tab segue a tela (canto superior direito do cabeçalho)
      return envoltorio;
    }

    /** Guarda no item em memória o que o servidor devolveu ao editar a descrição (flag do estado local e o texto que o cartão mostra). */
    function marcarDescricaoEditada(item, dados) {
      item.softexpert = { ...(item.softexpert || {}), descricao_editada: dados.descricao_editada || "" };
    }

    /** Selo de leitura do resumo: só chamado com UTIC pode ser lido no SoftExpert; sem UTIC nada é prometido. */
    function seloLeitura(item, dados) {
      if (!NUMERO_UTIC.test(item.numero)) return null;
      const selo = dom.createTextElement("span", "ck-badge sebrae-selo", dados.lido ? "Lido" : "Não lido");
      selo.dataset.status = dados.lido ? "info" : "";
      return selo;
    }

    /** Selos automáticos do resumo: ficam escondidos e o CSS mostra o que vale agora (D FINALIZADO, pronto, andamento, atenção, erro). */
    function selosAutomaticos() {
      return [
        ["d", "ok", "D: FINALIZADO"], ["pronto", "info", "Pronto para finalizar"], ["andamento", "info", "Finalizando…"],
        ["atencao", "alerta", "Ver resultado"], ["erro", "erro", "Falhou"],
      ].map(([sufixo, status, texto]) => {
        const selo = dom.createTextElement("span", `ck-badge sebrae-selo sebrae-selo--auto sebrae-selo--${sufixo}`, texto);
        selo.dataset.status = status;
        return selo;
      });
    }

    /** Item da lista de antigos: `details` recolhido; o resumo mostra número, assunto, pessoa e selos, e o cartão fica dentro. */
    function blocoAntigo(item) {
      const dados = dadosAntigo(item);
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", tituloAntigo(item));
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", dados.titulo || "Sem título"));
      const artigo = cartaoChamado(item.numero, "antigo", titulo, "Em aberto", "");
      const pares = [["I", "Solicitante", dados.solicitante], ["", "Abertura", dados.abertura],
        ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => [letra, rotulo, item.automaticos?.[letra]])];
      const fatos = document.createElement("dl");
      fatos.className = "ck-fatos sebrae-chamado__auto";
      pares.forEach(([letra, rotulo, atual]) => {
        const sugerido = letra ? item.automaticos_sugeridos?.[letra] : "";
        if (!atual && !sugerido) return;
        const linha = document.createElement("div");
        linha.append(dom.createTextElement("dt", "", rotulo), dom.createTextElement("dd", "", atual || `${sugerido} (será preenchido)`));
        fatos.appendChild(linha);
      });
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleManual(item.numero, letra, "antigo"))));
      const notas = [];
      const outra = [avisoOutraPessoa(item), avisoNomeDaDescricao(item)].filter(Boolean).join(" ");
      if (outra) notas.push(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", outra));
      let detalhes = [];
      if (dados.lido) {
        detalhes = [blocoDescricaoEditavel(item, dados.descricao, resposta => {
          marcarDescricaoEditada(item, resposta);
          item.leitura_softexpert = { ...item.leitura_softexpert, descricao: resposta.descricao };
        }), blocoDetalhe("Atendimento realizado", dados.atendimento)];
      }
      else if (NUMERO_UTIC.test(item.numero)) {
        const dica = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__dica", "Ainda não lido no SoftExpert: use Ler chamados antigos.");
        dica.dataset.leitura = "pendente";
        notas.push(dica);
      }
      artigo.append(zonaSolicitacao(fatos, notas, detalhes), zonaClassificacao(manuais));
      if (NUMERO_UTIC.test(item.numero)) artigo.appendChild(secaoFinalizar(item));
      const detalhe = document.createElement("details");
      detalhe.className = "sebrae-antigo";
      const texto = document.createElement("span");
      texto.className = "sebrae-antigo__texto";
      texto.append(dom.createTextElement("span", "sebrae-antigo__num", tituloAntigo(item)), dom.createTextElement("span", "sebrae-antigo__assunto", dados.titulo || "Sem título"));
      if (dados.solicitante) texto.appendChild(dom.createTextElement("span", "sebrae-antigo__quem", dados.solicitante));
      const selos = document.createElement("span");
      selos.className = "sebrae-antigo__selos";
      selos.append(...[seloLeitura(item, dados), ...selosAutomaticos()].filter(Boolean));
      const resumo = document.createElement("summary");
      resumo.className = "sebrae-antigo__resumo";
      resumo.append(texto, selos);
      detalhe.append(resumo, artigo);
      return detalhe;
    }

    function blocoChamado(item) {
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", item.linha.G || "Sem título"));
      const artigo = cartaoChamado(item.numero, "novo", titulo, "Novo", "info");
      const fatos = listaFatos(CAMPOS_AUTOMATICOS.map(([letra, rotulo]) => [rotulo, item.linha[letra] || "—"]));
      const notas = [];
      const aviso = [avisoOutraPessoa(item), avisoNomeDaDescricao(item), AVISO_CRUZAMENTO[item.cruzamento?.status]].filter(Boolean).join(" ");
      if (aviso) notas.push(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", aviso));
      const detalhes = [blocoDescricaoEditavel(item, item.linha.H, resposta => {
        marcarDescricaoEditada(item, resposta);
        item.linha = { ...item.linha, H: resposta.descricao };
      }), blocoDetalhe("Atendimento realizado", item.linha.F)];
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleManual(item.numero, letra))));
      artigo.append(zonaSolicitacao(fatos, notas, detalhes), zonaClassificacao(manuais));
      if (NUMERO_UTIC.test(item.numero)) artigo.appendChild(secaoFinalizar(item, true));
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

    function secaoFinalizar(item, novo = false) {
      const numero = item.numero;
      const guardado = item.softexpert || {};
      // "Revisado." só entra se o servidor nunca guardou descrição (campo ausente); apagada depois, vira "" guardado e não volta
      const aplicarRevisado = novo && ehApiSebrae(item.linha?.I) && guardado.descricao_definida === false;
      const soft = estado.soft[numero] = {
        descricao: aplicarRevisado ? DESCRICAO_API_SEBRAE : guardado.descricao_finalizacao || "", enviado: guardado.descricao_finalizacao || "",
        pdf: guardado.pdf || null, finalizacao: guardado.finalizacao || null, processando: false, novo,
      };
      const area = criarZona("finalizacao", "Finalização no SoftExpert", "Irreversível", {
        destaque: true, classe: "sebrae-chamado__finalizar",
        aviso: "Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada.",
      });
      const texto = document.createElement("textarea");
      texto.className = "ck-entrada";
      texto.rows = 4;
      texto.placeholder = " "; // o CSS usa :placeholder-shown para saber se a descrição está vazia (pendência e botão "pronto")
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
      const cancelar = document.createElement("button");
      cancelar.type = "button";
      cancelar.className = "ck-btn ck-btn--secundario ck-btn--sm";
      cancelar.textContent = "Cancelar";
      cancelar.hidden = true;
      cancelar.dataset.sebraeCancelarFinalizar = numero;
      const acoes = document.createElement("div");
      acoes.className = "sebrae-chamado__acoes";
      acoes.append(botao, cancelar);
      const resultado = dom.createTextElement("p", "ck-cartao__meta sebrae-chamado__resultado", "");
      resultado.setAttribute("role", "status");
      const pdfLinha = document.createElement("div");
      pdfLinha.className = "sebrae-chamado__pdf-linha";
      pdfLinha.append(infoPdf, remover);
      // A ordem no DOM dos dois `.sebrae-chamado__feedback` (descrição primeiro, PDF depois) precisa ser mantida.
      const colTexto = document.createElement("div");
      colTexto.className = "sebrae-final__texto";
      colTexto.append(campo("Descrição para Finalizar o Chamado", texto), feedbackDescricao);
      const colAnexo = document.createElement("div");
      colAnexo.className = "sebrae-final__anexo";
      colAnexo.append(campo("Anexo PDF (opcional)", arquivo), pdfLinha, feedbackPdf);
      const rodape = document.createElement("div");
      rodape.className = "sebrae-final__rodape";
      rodape.append(acoes, resultado);
      const corpo = document.createElement("div");
      corpo.className = "sebrae-final__corpo";
      corpo.append(listaPendencias(), colTexto, colAnexo, rodape);
      area.appendChild(corpo);
      estado.refs.set(numero, { texto, feedbackDescricao, arquivo, infoPdf, remover, feedbackPdf, botao, cancelar, resultado });
      texto.addEventListener("input", () => {
        window.clearTimeout(estado.temporizadores[numero]);
        estado.temporizadores[numero] = window.setTimeout(() => salvarDescricao(numero), 800);
        definirFeedback(feedbackDescricao, "Alteração ainda não salva…", "pendente");
        atualizarFinalizar(numero);
      });
      texto.addEventListener("change", () => salvarDescricao(numero));
      arquivo.addEventListener("change", () => enviarPdf(numero));
      remover.addEventListener("click", () => removerPdf(numero));
      botao.addEventListener("click", () => finalizarNoSoftExpert(numero));
      cancelar.addEventListener("click", () => cancelarFinalizacao(numero));
      atualizarFinalizar(numero);
      if (aplicarRevisado) salvarDescricao(numero); // só salva; finalizar continua sendo clique do usuário
      return area;
    }

    function atualizarFinalizar(numero) {
      const ref = estado.refs.get(numero);
      const soft = estado.soft[numero];
      if (!ref || !soft) return;
      // Fica clicável com campos faltando: o clique avisa na tela o que preencher (descrição, A, D, J e R).
      ref.botao.disabled = estado.fechar.emAndamento || STATUS_DESFEITOS.includes(soft.finalizacao?.status);
      ref.cancelar.hidden = !soft.processando;
      ref.infoPdf.textContent = soft.pdf ? `PDF anexado: ${soft.pdf.nome} (${formatarTamanho(soft.pdf.tamanho)})` : "Nenhum PDF anexado.";
      ref.remover.hidden = !soft.pdf;
      const quando = formatarDataHora(soft.finalizacao?.em);
      ref.resultado.textContent = soft.processando ? "Finalizando no SoftExpert…"
        : soft.cancelado && !soft.finalizacao ? "Finalização cancelada."
        : soft.finalizacao ? `${textoResultado(soft.finalizacao)}${quando ? ` · ${quando}` : ""}` : "";
      ref.resultado.dataset.estado = soft.processando ? "andamento" : soft.finalizacao?.status || (soft.cancelado ? "cancelado" : "");
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
      definirFeedback(ref.feedbackDescricao, "Salvando…", "salvando");
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
      definirFeedback(ref.feedbackPdf, "Enviando PDF…", "salvando");
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
      definirFeedback(ref.feedbackPdf, "Removendo PDF…", "salvando");
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

    /** A cópia de saída é refeita da importada: vão o próprio chamado (se novo, mesmo sem campos) e os outros novos que o usuário trabalhou
     * (campo diferente do padrão do próprio chamado: D/S, e também A/B/J no API SEBRAE), nunca novos em branco; edições dos antigos só com campo mudado. */
    function manuaisDoChamado(numero) {
      const trabalhado = item => item.numero === numero
        || ["A", "B", "D", "J", "R", "S"].some(letra => { const valor = estado.valores[item.numero]?.[letra]; return valor && valor !== padroesManuais(item)[letra]; });
      return { chamados: payloadAtualizacao(estado.formulario.filter(trabalhado), estado.valores), edicoes: payloadEdicoes(estado.abertos, estado.edicoes) };
    }

    async function finalizarNoSoftExpert(numero) {
      const ref = estado.refs.get(numero);
      const soft = estado.soft[numero];
      if (!ref || ref.botao.disabled) return;
      const faltas = camposFaltando(valoresEfetivos(numero), ref.texto.value);
      if (faltas.length) {
        app.showToast(`${numero}: antes de finalizar, preencha ${faltas.join(", ")}.`, "warning");
        return;
      }
      const confirmado = await app.confirmarAcao({
        titulo: "Finalizar no SoftExpert",
        mensagem: `Finalizar ${numero} no SoftExpert? Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada`
          + `${soft.pdf ? " e o PDF anexado será enviado" : ""}.`
          + (soft.novo ? " Este chamado novo ainda não está no Dashboard: depois clique em Atualizar Dashboard para gravar o status FINALIZADO e a data de encerramento." : ""),
        confirmar: "Confirmar finalização", cancelar: "Cancelar",
      });
      if (!confirmado) return;
      ref.botao.disabled = true;
      if (!(await salvarDescricao(numero))) {
        app.showToast("Salve a descrição antes de finalizar.", "error");
        atualizarFinalizar(numero);
        return;
      }
      await guardarFicha(numero);
      try {
        await app.apiFetch("/api/sebrae/finalizar-softexpert", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numero, confirmado: true, versao_importacao: estado.versaoImportacao, ...manuaisDoChamado(numero) }),
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

    /** Para a rotina em andamento (mesmo cancelamento da tela Automação); o acompanhamento mostra o resultado quando ela termina. */
    async function cancelarFinalizacao(numero) {
      const ref = estado.refs.get(numero);
      if (!ref || ref.cancelar.disabled) return;
      ref.cancelar.disabled = true;
      try {
        await app.apiFetch("/api/automacao/cancelar", { method: "POST", errorMessage: "Não foi possível cancelar a finalização." });
        app.showToast("Cancelamento pedido. A finalização para no próximo passo; confira no SoftExpert se o chamado ficou aberto.", "warning");
      } catch (error) {
        app.showToast(error.message, "error");
      } finally {
        ref.cancelar.disabled = false;
      }
    }

    function renderizarFechar() {
      const host = el("sebrae-fechar");
      if (!host) return;
      const f = estado.fechar;
      const res = f.resultado;
      const aoVivo = f.emAndamento && Boolean(res?.em_andamento);
      const pulados = f.pulados.length ? f.pulados : res?.pulados || [];
      // Os finalizados saem daqui na hora (vão para "Chamados finalizados"); sobram só avisos, erros e pulados.
      const restantes = (res?.resultados || []).filter(r => r.status !== "ok");
      let status = "";
      if (f.emAndamento) status = `Finalizando no SoftExpert…${aoVivo && f.numeros.length ? ` ${(res.resultados || []).length} de ${f.numeros.length} concluído(s).` : ""}`;
      else if (f.mensagemInicio) status = f.mensagemInicio;
      else if (res && (restantes.length || pulados.length || !(res.resultados || []).length)) status = resumoResultado({ ...res, resultados: restantes });
      host.hidden = !status;
      definirTexto("sebrae-fechar-status", status);
      host.setAttribute("aria-busy", f.emAndamento ? "true" : "false");
      const itens = [
        ...(f.emAndamento && !aoVivo ? [] : restantes.map(r => ({ status: r.status, texto: `${[r.numero, identificacaoChamado(r.numero)].filter(Boolean).join(" · ")}: ${textoResultado(r)}` }))),
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
    /** O horário gravado pelo SoftExpert substitui o Encerramento (R) digitado: a tela já mostra o valor que o Dashboard terá. */
    function mostrarEncerramentoSoftExpert(r) {
      const valor = r.status === "ok" ? encerramentoParaCampo(r.encerrado_em) : "";
      if (!valor) return;
      [estado.valores, estado.edicoes].forEach(guardados => { if (guardados[r.numero] && "R" in guardados[r.numero]) guardados[r.numero].R = valor; });
      document.querySelectorAll(`[data-sebrae-campo="R"][data-sebrae-numero="${CSS.escape(r.numero)}"]`).forEach(controle => { controle.value = valor; });
    }

    /** Título e solicitante (nome completo) do chamado, para o resultado da finalização dizer de qual se trata. */
    function identificacaoChamado(numero) {
      const antigo = estado.abertos.find(item => item.numero === numero);
      const novo = estado.formulario.find(item => item.numero === numero);
      const dadosDoAntigo = antigo ? dadosAntigo(antigo) : null;
      const titulo = dadosDoAntigo ? dadosDoAntigo.titulo : novo?.linha?.G;
      const solicitante = dadosDoAntigo ? dadosDoAntigo.solicitante : novo?.linha?.I;
      return [titulo, solicitante].map(parte => String(parte || "").trim()).filter(Boolean).join(" · ");
    }

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
        mostrarEncerramentoSoftExpert(r);
      });
      if (!f.emAndamento) Object.values(estado.soft).forEach(soft => {
        if (soft.processando && f.resultado?.cancelado) soft.cancelado = true;
        soft.processando = false;
      });
      renderizarFechar();
      renderizarSharepoint();
      atualizarTodosFinalizar();
      moverFinalizados(f);
    }

    /** Todo chamado `ok` sai da lista de abertos e aparece em "Chamados finalizados" assim que o SoftExpert confirma (uma recarga por novo `ok`). */
    function moverFinalizados(f) {
      const oks = (f.resultado?.resultados || []).filter(r => r.status === "ok");
      const chave = `${f.resultado?.iniciado_em || ""}:${oks.length}`;
      if (!oks.length || f.recarregado === chave) return;
      f.recarregado = chave;
      app.showToast(`${oks.length} chamado(s) finalizado(s) no SoftExpert. Veja em Chamados finalizados.`, "success");
      carregarNovosSebrae();
    }

    /** Consulta a rotina até terminar; erros passageiros de rede não derrubam o acompanhamento. */
    async function acompanharFechar(numeros) {
      const f = estado.fechar;
      const token = ++f.token;
      const anterior = f.resultado?.iniciado_em;
      f.emAndamento = true;
      f.numeros = numeros;
      numeros.forEach(numero => { if (estado.soft[numero]) Object.assign(estado.soft[numero], { processando: true, cancelado: false }); });
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

    // ---- Ler chamados antigos: o POST inicia a rotina `antigos`; o GET acompanha e guarda o último resultado ----

    function renderizarAntigos() {
      const a = estado.antigos;
      definirTexto("sebrae-antigos-leitura-status", a.mensagem || resumoLeituraAntigos(a.resultado, a.emAndamento, formatarDataHora(a.resultado?.em), a.anteriorEm));
      const lista = el("sebrae-antigos-leitura-falhas");
      if (lista) {
        const falhas = a.emAndamento ? [] : Object.entries(a.resultado?.falhas || {});
        lista.replaceChildren(...falhas.map(([numero, motivo]) => dom.createTextElement("li", "", `${numero}: ${motivo}`)));
        lista.hidden = falhas.length === 0;
      }
      const botao = el("btn-sebrae-ler-antigos");
      if (botao) a.emAndamento ? botao.setAttribute("aria-busy", "true") : botao.removeAttribute("aria-busy");
    }

    function aplicarAntigos(dados) {
      const a = estado.antigos;
      a.emAndamento = Boolean(dados?.em_andamento);
      a.resultado = dados?.resultado || null;
      a.mensagem = "";
      renderizarAntigos();
    }

    /** Consulta a leitura até terminar; erros passageiros de rede não derrubam o acompanhamento. Ao fim recarrega a lista. */
    async function acompanharAntigos() {
      const a = estado.antigos;
      const token = ++a.token;
      a.anteriorEm = a.resultado?.em ?? null;
      a.emAndamento = true;
      a.mensagem = "";
      renderizarAntigos();
      let visto = false;
      let esperas = 0;
      let falhas = 0;
      while (token === a.token) {
        await esperar(INTERVALO_FECHAR_MS);
        if (token !== a.token) return;
        let dados;
        try {
          dados = await app.apiFetch("/api/sebrae/antigos/ler", { errorMessage: "Não foi possível consultar a leitura dos chamados antigos." });
          falhas = 0;
        } catch (error) {
          if (++falhas < 5) continue;
          a.emAndamento = false;
          a.mensagem = `Não foi possível acompanhar a leitura dos chamados antigos: ${error.message}`;
          renderizarAntigos();
          return;
        }
        visto = visto || Boolean(dados.em_andamento);
        const comecou = visto || (dados.resultado?.em ?? null) !== a.anteriorEm;
        if (!dados.em_andamento && !comecou && ++esperas < 4) continue; // a rotina ainda não começou a responder
        aplicarAntigos(dados);
        if (dados.em_andamento) continue;
        if (comecou && dados.resultado) {
          const limpa = dados.resultado.concluido && !Object.keys(dados.resultado.falhas || {}).length;
          app.showToast(resumoLeituraAntigos(dados.resultado, false), limpa ? "success" : "warning");
        }
        carregarNovosSebrae();
        return;
      }
    }

    /** Uma consulta ao abrir a lista: pega leitura em andamento e o último resultado. */
    async function carregarAntigos() {
      const a = estado.antigos;
      try {
        const dados = await app.apiFetch("/api/sebrae/antigos/ler", { errorMessage: "Não foi possível consultar a leitura dos chamados antigos." });
        if (a.emAndamento) return; // o acompanhamento em curso já atualiza a tela
        aplicarAntigos(dados);
        if (dados.em_andamento) acompanharAntigos();
      } catch (_erro) {
        // Sem o resultado a lista segue funcionando; a próxima consulta traz o texto de volta.
      }
    }

    async function lerAntigosSebrae() {
      const a = estado.antigos;
      if (a.emAndamento) return;
      const botao = el("btn-sebrae-ler-antigos");
      botao?.setAttribute("aria-busy", "true");
      try {
        await app.apiFetch("/api/sebrae/antigos/ler", { method: "POST", errorMessage: "Não foi possível iniciar a leitura dos chamados antigos." });
      } catch (error) {
        // 409 = outra rotina em andamento (aviso); 503 sem runner e 422 sem Dashboard importado são erros.
        a.mensagem = error.message;
        renderizarAntigos();
        app.showToast(error.message, error.status === 409 ? "warning" : "error");
        return;
      }
      app.showToast("Leitura dos chamados antigos iniciada.", "success");
      app.atualizarEstadoAutomacao?.(); // habilita o Cancelar execução sem esperar a próxima consulta da Automação
      acompanharAntigos();
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
      destacarFinalizado(event.currentTarget);
      if (gravarCampoRascunho(armazenamento, estado.importadoEm, sebraeNumero, sebraeCampo, event.currentTarget.value, sebraeAlvo)) {
        const tipo = sebraeAlvo === "antigo" ? "edicoes" : "valores";
        if (estado.naoSalvos[tipo][sebraeNumero]) {
          delete estado.naoSalvos[tipo][sebraeNumero][sebraeCampo];
          if (!Object.keys(estado.naoSalvos[tipo][sebraeNumero]).length) delete estado.naoSalvos[tipo][sebraeNumero];
        }
        mostrarRascunho("Rascunho salvo automaticamente neste navegador.", "ok");
      } else {
        const tipo = sebraeAlvo === "antigo" ? "edicoes" : "valores";
        estado.naoSalvos[tipo][sebraeNumero] = { ...estado.naoSalvos[tipo][sebraeNumero], [sebraeCampo]: event.currentTarget.value };
        mostrarRascunho("Não foi possível salvar o rascunho. Mantenha esta aba aberta e copie suas edições antes de recarregar.", "erro");
      }
      atualizarBotaoAtualizar();
    }

    /** `situacao` vai para `data-estado` do bloco (o CSS pinta a bolinha): "ok" = salvo agora; vazio = restaurado/descartado. */
    function mostrarRascunho(texto, situacao = "") {
      definirTexto("sebrae-rascunho-status", texto);
      const bloco = el("sebrae-rascunho");
      if (!bloco) return;
      bloco.hidden = !texto;
      bloco.dataset.estado = situacao;
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

    function atualizarBotaoAtualizar() {
      const botao = el("btn-sebrae-atualizar");
      if (!botao) return;
      const alteracoes = payloadEdicoes(estado.abertos, estado.edicoes).length;
      const preenchimentos = totalPreenchimentos(estado.abertos);
      botao.disabled = !estado.atualizavel || (estado.formulario.length === 0 && alteracoes === 0 && preenchimentos === 0);
      const visiveis = estado.abertos.filter(item => !estado.finalizados.has(item.numero)).length;
      definirTexto("sebrae-antigos-resumo", visiveis
        ? `${visiveis} chamado(s) antigo(s) em aberto ou sem status; ${alteracoes} com alteração e ${preenchimentos} com Série, Modelo, Cidade ou OS a preencher.`
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
      estado.rascunhoExterno = false;
      const importado = dados.importado;
      estado.listas = importado?.listas || {};
      estado.abertos = importado?.abertos || [];
      estado.atualizavel = Boolean(importado?.atualizavel);
      estado.importadoEm = importado?.versao || importado?.importado_em || "";
      estado.versaoImportacao = importado?.versao || "";
      if (estado.descartar) {
        apagarRascunho(armazenamento);
        estado.valores = {};
        estado.naoSalvos = { valores: {}, edicoes: {} };
      }
      const novos = dados.novos;
      const guardado = lerRascunho(armazenamento, estado.importadoEm);
      ["valores", "edicoes"].forEach(tipo => Object.entries(estado.naoSalvos[tipo]).forEach(([numero, campos]) => {
        guardado[tipo][numero] = { ...guardado[tipo][numero], ...campos };
      }));
      const rascunho = aplicarRascunho(guardado, novos?.formulario, estado.abertos, estado.importadoEm);
      estado.edicoes = rascunho.edicoes;
      estado.valores = rascunho.valores;
      const salvoEm = formatarDataHora(rascunho.salvoEm);
      mostrarRascunho(estado.descartar ? "Rascunho descartado." : rascunho.restaurado ? `Rascunho restaurado${salvoEm ? ` (salvo em ${salvoEm})` : ""}. Passe por Atualizar Dashboard para gravar no arquivo.` : "");
      if (rascunho.conflitos.length) mostrarRascunho(`Rascunho preservado com divergências; o arquivo importado prevalece nos campos já preenchidos. Confira: ${rascunho.conflitos.join("; ")}`, "alerta");
      if (rascunho.pendentes.length) mostrarRascunho(`Rascunhos preservados sem correspondência nesta importação: ${rascunho.pendentes.map(([numero, campos]) => `${numero}: ${JSON.stringify(campos)}`).join("; ")}. ${rascunho.conflitos.join("; ")}`, "alerta");
      if (Object.values(estado.naoSalvos).some(itens => Object.keys(itens).length)) mostrarRascunho("Há edições preservadas apenas nesta aba porque o navegador não conseguiu salvá-las. Copie os valores antes de recarregar.", "erro");
      estado.soft = {};
      estado.refs.clear();
      const finalizados = importado?.finalizados || [];
      estado.finalizados = new Set(finalizados.map(item => item.numero));
      const emAberto = item => !estado.finalizados.has(item.numero); // os `ok` seguem em estado.abertos/formulario só para não perder A, B, J e S no Atualizar
      el("sebrae-antigos-lista")?.replaceChildren(...estado.abertos.filter(emAberto).map(blocoAntigo));
      const painelAntigos = el("sebrae-antigos");
      if (painelAntigos) painelAntigos.hidden = !importado;
      el("sebrae-finalizados-lista")?.replaceChildren(...finalizados.map(textoFinalizado));
      const painelFinalizados = el("sebrae-finalizados");
      if (painelFinalizados) painelFinalizados.hidden = !finalizados.length;
      definirTexto("sebrae-finalizados-resumo", `${finalizados.length} chamado(s) finalizado(s) no SoftExpert.`);
      definirTexto("sebrae-dashboard-status", importado
        ? `Dashboard importado: ${importado.arquivo || "sem nome"} (${importado.total} chamados já lançados).${importado.atualizavel ? "" : " Não dá para atualizar a cópia: importe de novo."}`
        : "Nenhum Dashboard importado.");
      // "Enviar ao SharePoint" só tem o que enviar depois de Atualizar; sem a saída, avisa já em vez de falhar no clique.
      definirEnvioDisponivel(Boolean(importado?.saida_pronta));
      if (importado && !importado.saida_pronta) definirStatusAtualizar("Gere o Dashboard atualizado antes de enviar ao SharePoint.", "alerta");
      estado.formulario = novos?.formulario || [];
      const lista = el("sebrae-novos-lista");
      lista?.replaceChildren(...estado.formulario.filter(emAberto).map(blocoChamado));
      lista?.removeAttribute("aria-busy"); // a lista já está pronta (também vale para a importação, que chama renderizar direto)
      renderizarAvisos(novos);
      if (!importado) definirTexto("sebrae-novos-resumo", "Importe o Dashboard para buscar os chamados novos.");
      else if (!novos) definirTexto("sebrae-novos-resumo", "Nenhuma busca feita ainda. Use Buscar chamados novos.");
      else {
        const quando = formatarDataHora(novos.lidos_em);
        definirTexto("sebrae-novos-resumo",
          `${quando ? `Busca de ${quando}: ` : ""}${estado.formulario.filter(emAberto).length} novo(s), ${novos.ignorados} já no Dashboard, ${(novos.pendentes || []).length} pendente(s).`);
      }
      if (estado.fechar.emAndamento) estado.fechar.numeros.forEach(numero => { if (estado.soft[numero]) estado.soft[numero].processando = true; });
      atualizarTodosFinalizar();
      atualizarBotaoAtualizar();
      app.carregarResumoHistoricoSebrae?.();
      carregarFechar();
      carregarAntigos();
    }

    async function carregarNovosSebrae() {
      if (!el("sebrae-novos-painel") && !el("sebrae-novos-lista")) return; // vale com só o cartão F4 ou só o painel F5 montado
      const consulta = ++estado.consulta;
      const lista = el("sebrae-novos-lista");
      lista?.setAttribute("aria-busy", "true"); // o CSS mostra o esqueleto de carregamento enquanto a lista está vazia
      try {
        const dados = await app.apiFetch("/api/sebrae/novos", { errorMessage: "Não foi possível consultar os chamados novos." });
        if (consulta === estado.consulta) renderizar(dados);
      } catch (error) {
        if (consulta === estado.consulta) definirTexto("sebrae-dashboard-status", error.message);
      } finally {
        // Só a consulta mais recente solta o "ocupado"; se outra a substituiu, ela mesma solta ao terminar.
        if (consulta === estado.consulta) lista?.removeAttribute("aria-busy");
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
        if (dados.saida_anterior_preservada) definirTexto("sebrae-dashboard-status", "Dashboard importado. A cópia atualizada anterior foi preservada em data/state/sebrae_dashboard_saida/preservados; confira essa cópia antes de enviar outra versão.");
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
      if (estado.rascunhoExterno) {
        app.showToast("O rascunho mudou em outra aba. Recarregue e confira os campos antes de atualizar o Dashboard.", "warning");
        return;
      }
      const chamados = payloadAtualizacao(estado.formulario, estado.valores);
      const edicoes = payloadEdicoes(estado.abertos, estado.edicoes);
      if (!estado.atualizavel || (!chamados.length && !edicoes.length && !totalPreenchimentos(estado.abertos))) return;
      const botao = el("btn-sebrae-atualizar");
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        // Finalizar no SoftExpert não tem volta: quem marcou FINALIZADO com descrição confirma antes de qualquer envio.
        await Promise.all(Object.keys(estado.soft).map(salvarDescricao));
        const finalizar = candidatosFinalizar(estado.abertos, estado.edicoes, estado.soft, estado.formulario, estado.valores);
        // Cancelar e Esc (o diálogo resolve false) só atualizam o Dashboard: nunca finalizam.
        const finalizarSoftExpert = finalizar.length > 0 && await app.confirmarAcao({
          titulo: "Atualizar Dashboard e finalizar no SoftExpert",
          mensagem: `${finalizar.length} chamado(s) marcado(s) como FINALIZADO (${finalizar.join(", ")}) podem ser finalizados no SoftExpert. `
            + "Atualizar e finalizar: atualiza o Dashboard e finaliza no SoftExpert, o que não tem volta. "
            + "Só atualizar: atualiza o Dashboard e NÃO finaliza nada no SoftExpert.",
          confirmar: "Atualizar e finalizar", cancelar: "Só atualizar",
        });
        // Só a finalização em massa exige A e J (a descrição e o Status FINALIZADO já filtraram os candidatos): avisa e não envia nada.
        const incompletos = finalizarSoftExpert
          ? finalizar.map(numero => [numero, camposFaltando(valoresEfetivos(numero), estado.soft[numero]?.descricao)]).filter(([, faltas]) => faltas.length)
          : [];
        if (incompletos.length) {
          const aviso = `Para finalizar no SoftExpert, preencha: ${incompletos.map(([numero, faltas]) => `${numero} (${faltas.join(", ")})`).join("; ")}. Nada foi enviado.`;
          definirStatusAtualizar(aviso, "alerta");
          app.showToast(aviso, "warning");
          return;
        }
        if (finalizarSoftExpert) await Promise.all(finalizar.map(guardarFicha));
        const dados = await app.apiFetch("/api/sebrae/dashboard/atualizar", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chamados, edicoes, versao_importacao: estado.versaoImportacao, finalizar_softexpert: finalizarSoftExpert }),
          errorMessage: "Não foi possível atualizar o Dashboard.",
        });
        baixarArquivo(dados.arquivo, dados.conteudo_base64);
        const novos = dados.linhas.filter(linha => linha.tipo === "novo").length;
        const quando = formatarDataHora(dados.base?.importado_em);
        definirStatusAtualizar(
          `Baixado "${dados.arquivo}": ${novos} novo(s) e ${dados.linhas.length - novos} alterado(s). `
          + `Baseado no Dashboard importado${quando ? ` em ${quando}` : ""}. Para não perder edições de outras pessoas, importe a versão atual antes.`
          + (finalizar.length && !finalizarSoftExpert ? " Dashboard atualizado; nenhum chamado foi finalizado no SoftExpert." : ""), "ok");
        definirEnvioDisponivel(true);
        app.showToast("Dashboard atualizado. Use Enviar ao SharePoint para sobrepor o arquivo.", "success");
        tratarFechar(dados.fechar);
      } catch (error) {
        definirStatusAtualizar(error.message, "erro");
        app.showToast(error.message, "error");
      } finally {
        botao.removeAttribute("aria-busy");
        atualizarBotaoAtualizar();
      }
    }

    return { carregarNovosSebrae, lerAntigosSebrae, importarDashboardSebrae, atualizarDashboardSebrae, descartarRascunhoSebrae };
  }

  createSebraeDashboard.puro = { formatarEncerramento, encerramentoParaCampo, payloadAtualizacao, payloadEdicoes, avisoOutraPessoa, avisoNomeDaDescricao, tituloAntigo, dadosAntigo, resumoLeituraAntigos, totalPreenchimentos, camposFaltando, ehApiSebrae, padroesManuais,
    formatarTamanho, textoResultado, textoPulado, podeFinalizar, candidatosFinalizar, resumoResultado, resumoInicio,
    lerRascunho, gravarRascunho, gravarCampoRascunho, apagarRascunho, aplicarRascunho };
  return createSebraeDashboard;
})());
