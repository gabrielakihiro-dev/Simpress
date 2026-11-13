// Regras puras do painel Sebrae (F5), sem DOM, rede nem estado.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressSebraeDashboardModel = api;
})(typeof window !== "undefined" ? window : globalThis, function createSebraeDashboardModel() {
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

  const MAX_TITULO = 300; // mesmo limite de ChamadoManual.G no servidor (routers/sebrae_dashboard.py)
  const LIMITE_H_LIDO = 2000; // a coluna H lida do Dashboard chega cortada aqui (LIMITE_H_LIDO em domains/sebrae_dashboard_gravacao.py)

  /** Uma linha, sem espaços repetidos: a forma em que o servidor grava e lê G e H (`" ".join(texto.split())`). */
  function umaLinha(texto) {
    return String(texto ?? "").split(/\s+/).filter(Boolean).join(" ");
  }

  /**
   * A descrição editada no lápis já é a coluna H lida do Dashboard? Mesma regra do servidor (`h_ja_gravado`): uma linha, sem o apóstrofo
   * protetor (a célula não o guarda) e, se o H lido tem LIMITE_H_LIDO caracteres (foi cortado), só o começo precisa bater.
   * Sem isso, editar com Enter ou espaço duplo deixaria "1 com alteração" para sempre depois de reimportar o Dashboard.
   */
  function descricaoJaNoDashboard(editada, lida) {
    const novo = umaLinha(editada).replace(/^'(?=[=+\-@])/, "");
    const cortada = String(lida ?? "").length >= LIMITE_H_LIDO; // medido antes de aparar: o corte pode terminar num espaço
    const atual = umaLinha(lida);
    return novo === atual || (cortada && novo.startsWith(atual));
  }

  /**
   * Só os campos que o usuário mudou e não deixou em branco: em branco nunca apaga o que já está no Dashboard.
   * G (título) vai junto, comparado com o título que o cartão mostra (`item.titulo`); o título editado só chega à coluna G da cópia do Dashboard.
   */
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
      if ("G" in editado) {
        const titulo = String(editado.G || "").trim();
        if (titulo && umaLinha(titulo) !== umaLinha(item.titulo)) mudou.G = titulo; // o servidor grava G em uma linha: espaço duplo sozinho não é mudança
      }
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
      lido: Boolean(leitura), naoEncontrado: !leitura && item.nao_encontrado_softexpert === true,
      titulo: texto(item.titulo) || texto(leitura?.titulo),
      solicitante: texto(item.usuario) || texto(leitura?.solicitante),
      // a descrição editada no lápis vem primeiro: o Dashboard (H) só muda quando "Atualizar Dashboard" a grava
      descricao: texto(item.softexpert?.descricao_editada) || texto(item.descricao) || texto(leitura?.descricao), atendimento: texto(leitura?.atendimento), abertura: texto(leitura?.habilitada_em),
    };
  }

  const AJUDA_ENCERRAMENTO = "Obrigatório ao finalizar chamado não encontrado no SoftExpert";

  /**
   * DT ENCERRAMENTO (R) é obrigatório: antigo "não encontrado" no SoftExpert com Status (D) FINALIZADO (digitado ou gravado) e sem R gravado.
   * Nenhuma leitura trará a data desse chamado. Espelha a recusa 422 do servidor em Atualizar Dashboard (`_edicoes`).
   */
  function encerramentoObrigatorio(item, edicao) {
    const efetivo = letra => String(edicao?.[letra] ?? "").trim() || String(item?.valores?.[letra] ?? "").trim();
    return dadosAntigo(item || {}).naoEncontrado && efetivo("D") === "FINALIZADO" && !String(item.valores?.R ?? "").trim();
  }

  /** Números dos antigos com R obrigatório e ainda sem uma data válida no campo (é o que bloqueia Atualizar). */
  function pendenciasEncerramento(abertos, edicoes) {
    return (abertos || [])
      .filter(item => encerramentoObrigatorio(item, edicoes?.[item.numero]) && !formatarEncerramento(edicoes?.[item.numero]?.R))
      .map(item => item.numero);
  }

  /** Mensagem de Atualizar bloqueado; no singular é a mesma frase que o servidor devolve em 422. */
  function avisoEncerramento(numeros) {
    return numeros.length === 1
      ? `Informe a DT ENCERRAMENTO (coluna R) do chamado ${numeros[0]}: ele não foi encontrado no SoftExpert.`
      : `Informe a DT ENCERRAMENTO (coluna R) dos chamados ${numeros.join(", ")}: eles não foram encontrados no SoftExpert.`;
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

  /** G (título) só vai se o usuário digitou algo: sem isso o servidor mantém o título do SoftExpert. */
  function linhaChamado(item, v) {
    const linha = { numero: item.numero, A: v.A || "", B: v.B || "", D: v.D || "", J: v.J || "", R: formatarEncerramento(v.R), S: v.S || "" };
    const titulo = String(v.G ?? "").trim();
    if (titulo) linha.G = titulo;
    return linha;
  }

  /** Atualizar Dashboard grava TODOS os chamados novos, mesmo sem A, D e J (vazios viram ""). */
  function payloadAtualizacao(formulario, valores) {
    return formulario.map(item => linhaChamado(item, valores[item.numero] || {}));
  }

  const MAX_DESCRICAO = 4000;
  const NUMERO_UTIC = /^UTIC-\d{4}-\d+$/i;
  const INTERVALO_FECHAR_MS = 1500;
  const STATUS_OUTRO_TECNICO = "finalizado_outro_tecnico"; // fora da central, com D=FINALIZADO e R do usuário (regra de 12/11/2026)
  const STATUS_DESFEITOS = Object.freeze(["ok", STATUS_OUTRO_TECNICO]); // nada mais a fazer no SoftExpert (ja_finalizado e nao_encontrado não bloqueiam: espelha ja_finalizado() do backend)
  const ROTULOS_RESULTADO = Object.freeze({
    ok: "Finalizado no SoftExpert", [STATUS_OUTRO_TECNICO]: "Finalizado por outro técnico: Dashboard atualizado com a DT ENCERRAMENTO informada", ja_finalizado: "Já estava finalizado no SoftExpert", erro: "Erro ao finalizar",
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
    const extra = STATUS_DESFEITOS.includes(item?.status) && item.encerrado_em ? ` (encerrado em ${item.encerrado_em})` : "";
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

  /** Chamados que o usuário marcou com D = FINALIZADO nesta atualização (formulários novos e edições dos antigos). */
  function marcadosFinalizado(abertos, edicoes, formulario = [], valores = {}) {
    return [
      ...payloadEdicoes(abertos, edicoes),
      ...payloadAtualizacao(formulario, valores),
    ].filter(e => String(e.D || "").toUpperCase() === "FINALIZADO");
  }

  /** O que "Atualizar Dashboard" finalizaria de verdade: D virando FINALIZADO, número UTIC, com descrição, ainda não finalizado. */
  function candidatosFinalizar(abertos, edicoes, soft, formulario = [], valores = {}) {
    return marcadosFinalizado(abertos, edicoes, formulario, valores)
      .filter(e => NUMERO_UTIC.test(e.numero))
      .map(e => e.numero)
      .filter(numero => podeFinalizar(soft?.[numero]?.descricao, soft?.[numero]?.finalizacao, false));
  }

  /** Os marcados FINALIZADO que `candidatosFinalizar` deixa de fora, com o motivo (mesmos códigos de `MOTIVOS_PULADO`), sem repetir chamado. */
  function excluidosFinalizar(abertos, edicoes, soft, formulario = [], valores = {}) {
    const vistos = new Set();
    const excluidos = [];
    for (const { numero } of marcadosFinalizado(abertos, edicoes, formulario, valores)) {
      if (vistos.has(numero)) continue;
      vistos.add(numero);
      let motivo = "";
      if (!NUMERO_UTIC.test(numero)) motivo = "sem_numero";
      else if (String(soft?.[numero]?.descricao || "").trim() === "") motivo = "sem_descricao";
      else if (!podeFinalizar(soft[numero].descricao, soft[numero].finalizacao, false)) motivo = "ja_finalizado";
      if (motivo) excluidos.push({ numero, motivo });
    }
    return excluidos;
  }

  /** Aviso visível dos FINALIZADO que ficam de fora da finalização no SoftExpert ("" quando não há nenhum). */
  function avisoExcluidosFinalizar(excluidos) {
    if (!excluidos?.length) return "";
    return `Não serão finalizados no SoftExpert: ${excluidos.map(e => `${e.numero} (${MOTIVOS_PULADO[e.motivo] || e.motivo})`).join("; ")}.`;
  }

  const MOTIVO_SEM_FINALIZACAO = "nenhum chamado foi finalizado no SoftExpert";

  /** Texto e tipo do aviso depois de Atualizar Dashboard: o servidor diz se finalizou (fechar) ou só enviou (enviar) ao SharePoint. */
  function resultadoEnvioAtualizacao(dados) {
    if (dados?.fechar?.iniciado) return { texto: "Dashboard atualizado. Finalizando no SoftExpert; o envio ao SharePoint só acontece se algum chamado for finalizado.", tipo: "success" };
    if (dados?.enviar?.iniciado) return { texto: "Dashboard atualizado. Enviando ao SharePoint…", tipo: "success" };
    const motivo = String(dados?.enviar?.motivo || "").trim().replace(/\.$/, "");
    // Sem finalização no SoftExpert, "Enviar ao SharePoint" gravaria D FINALIZADO sem finalizar (marca falsa de outro técnico): não sugere o envio.
    if (motivo === MOTIVO_SEM_FINALIZACAO) return { texto: `Dashboard atualizado, mas não foi enviado ao SharePoint: ${motivo}. Confira o SoftExpert antes de enviar.`, tipo: "warning" };
    if (motivo) return { texto: `Dashboard atualizado, mas não foi enviado ao SharePoint: ${motivo}. Use Enviar ao SharePoint.`, tipo: "warning" };
    return { texto: "Dashboard atualizado. Use Enviar ao SharePoint para sobrepor o arquivo.", tipo: "success" };
  }

  function resumoResultado(resultado) {
    const lista = resultado?.resultados || [];
    if (!lista.length) return resultado?.cancelado ? "Finalização cancelada." : "Finalização terminada sem resultado por chamado.";
    const contar = status => lista.filter(r => r.status === status).length;
    const partes = [
      [contar("ok"), "finalizado(s)"], [contar(STATUS_OUTRO_TECNICO), "finalizado(s) por outro técnico"], [contar("ja_finalizado"), "já finalizado(s)"], [contar("erro"), "com erro"],
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
      if (typeof campos.G === "string" && campos.G.length <= MAX_TITULO) limpos.G = campos.G; // título (G): texto livre, limite próprio
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

  return Object.freeze({
    CAMPOS_AUTOMATICOS, CAMPOS_PREENCHIDOS, STATUS_CHAMADO, TIPOS_CHAMADO, PADROES_MANUAIS, PADROES_API_SEBRAE, DESCRICAO_API_SEBRAE, SOLICITANTE_API_SEBRAE,
    ehApiSebrae, padroesManuais, AVISO_CRUZAMENTO, avisoOutraPessoa, avisoNomeDaDescricao, formatarEncerramento, encerramentoParaCampo, payloadEdicoes, descricaoJaNoDashboard,
    tituloAntigo, dadosAntigo, AJUDA_ENCERRAMENTO, encerramentoObrigatorio, pendenciasEncerramento, avisoEncerramento,
    resumoLeituraAntigos, totalPreenchimentos, linhaChamado, payloadAtualizacao,
    MAX_TITULO, MAX_DESCRICAO, NUMERO_UTIC, INTERVALO_FECHAR_MS, STATUS_DESFEITOS, STATUS_OUTRO_TECNICO, ROTULOS_RESULTADO, MOTIVOS_PULADO, formatarTamanho, textoResultado, textoPulado, podeFinalizar,
    ROTULOS_FALTA, camposFaltando, marcadosFinalizado, candidatosFinalizar, excluidosFinalizar, avisoExcluidosFinalizar, MOTIVO_SEM_FINALIZACAO,
    resultadoEnvioAtualizacao, resumoResultado, resumoInicio,
    CHAVE_RASCUNHO, NUMERO_RASCUNHO, limparValoresRascunho, PREFIXO_CAMPO, lerRascunho, gravarCampoRascunho, gravarRascunho, apagarRascunho, aplicarRascunho,
  });
});
