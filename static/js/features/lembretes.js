/** Lembretes (Ferramentas): lista local de tarefas em /api/lembretes. A descrição tem dado pessoal: nunca vai para log nem para storage. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).lembretes = factory;
})(typeof window !== "undefined" ? window : globalThis, function createLembretes(context) {
  "use strict";
  const { app, apiFetch } = context;

  const URL_API = "/api/lembretes";
  const LIMITE = 2000;
  const JSON_HEADERS = { "Content-Type": "application/json" };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const doc = () => (typeof document !== "undefined" ? document : null);
  const porId = (id) => (doc() ? doc().getElementById(id) : null);

  let lembretes = [];
  let editandoId = null;
  let excluindoId = null;
  let concluidosAbertos = false;
  let ocupado = false;
  let pedidoLista = 0;
  // Termo de origem enquanto o diálogo Criar lembrete está aberto.
  let criando = null;
  // Vista aberta ("hoje" ou "embreve") e semana mostrada em Em breve (0 = a semana de hoje).
  let vista = "hoje";
  let semanaAtual = 0;
  // Cópia dos dados do termo tirada quando o diálogo abre ({campos, itens, obs}); vai junto no POST.
  let copiaTermo = null;
  // Ids com o bloco "Dados do termo" aberto: renderizar() refaz os itens e não pode fechá-los.
  let termosAbertos = new Set();

  const tamanho = (texto) => [...String(texto ?? "")].length;
  // O backend recusa caractere de controle (422): quebra de linha e tab viram espaço, e espaços repetidos viram um só.
  const limparTexto = (texto) => String(texto ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  // Mesmos limites do backend para a cópia do termo (200 por campo, 2000 nas observações; controle vira espaço,
  // exceto quebra de linha e tab nas observações): sem isso o POST dava 422 e o diálogo não deixava corrigir.
  const textoTermo = (texto, limite, permitidos = "") =>
    [...String(texto ?? "").replace(/\p{Cs}/gu, "").replace(/\p{Cc}/gu, (c) => (permitidos.includes(c) ? c : " "))].slice(0, limite).join("");
  const mensagemDe = (erro, padrao) => (erro?.status && erro.message ? erro.message : padrao);
  const avisarErro = (erro, padrao) => app.showToast(mensagemDe(erro, padrao), "error");
  // Toda escrita invalida o GET em andamento: a resposta antiga não pode sobrescrever a lista já alterada.
  const mutar = (url, opcoes) => {
    pedidoLista += 1;
    return apiFetch(url, opcoes);
  };

  // Cada fonte da data exibida é o texto em ISO com fuso; o navegador converte para a hora local.
  function formatarData(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const dois = (n) => String(n).padStart(2, "0");
    return `${dois(d.getDate())}/${dois(d.getMonth() + 1)}/${d.getFullYear()} ${dois(d.getHours())}:${dois(d.getMinutes())}`;
  }

  const dataExibida = (l) => l.alterado_em ?? l.criado_em;
  const instante = (l) => Date.parse(dataExibida(l)) || 0;
  // Mais recente no topo, pela data que aparece no item. A data tem precisão de segundo: no empate, o que veio depois no arquivo fica acima.
  const ordenar = (itens) => itens
    .map((item, posicao) => ({ item, posicao }))
    .sort((a, b) => instante(b.item) - instante(a.item) || b.posicao - a.posicao)
    .map(({ item }) => item);
  const achar = (id) => lembretes.find((l) => String(l.id) === String(id));

  // Datas agendadas são texto "AAAA-MM-DD" e só passam por Date.UTC/getUTC*: new Date("AAAA-MM-DD") e toISOString dependem do fuso do navegador.
  // Só hojeEm olha para America/Sao_Paulo; os rótulos usam Intl com timeZone "UTC" para não deslocar o dia.
  const FUSO = "America/Sao_Paulo";
  const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
  const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DIA_MS = 86400000;
  const DIAS_CURTOS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const dois = (n) => String(n).padStart(2, "0");
  const formatoUtc = (opcoes) => new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", ...opcoes });
  const fmtMesCurto = formatoUtc({ month: "short" });
  const fmtMesLongo = formatoUtc({ month: "long" });
  const fmtSemana = formatoUtc({ weekday: "long" });
  const fmtSaoPaulo = new Intl.DateTimeFormat("en-US", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

  // Meia-noite UTC da data real no formato estrito, ou null (recusa 2026-02-30 e ano 0000, como o backend).
  // setUTCFullYear em vez de Date.UTC: o Date.UTC trata os anos 0 a 99 como 1900 a 1999.
  function dataMs(texto) {
    const partes = typeof texto === "string" ? RE_DATA.exec(texto) : null;
    if (!partes) return null;
    const [ano, mes, dia] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
    const d = new Date(0);
    d.setUTCFullYear(ano, mes - 1, dia);
    return ano >= 1 && d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? d.getTime() : null;
  }
  const dataValida = (texto) => dataMs(texto) !== null;
  const textoDeMs = (ms) => {
    const d = new Date(ms);
    return `${String(d.getUTCFullYear()).padStart(4, "0")}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}`;
  };
  const somarDias = (data, n) => textoDeMs(dataMs(data) + n * DIA_MS);
  const diaDaSemana = (data) => new Date(dataMs(data)).getUTCDay();

  // "Hoje" em America/Sao_Paulo, no formato AAAA-MM-DD, para o instante em milissegundos.
  function hojeEm(instanteMs = Date.now()) {
    const partes = Object.fromEntries(fmtSaoPaulo.formatToParts(new Date(instanteMs)).map(({ type, value }) => [type, value]));
    return `${partes.year}-${partes.month}-${partes.day}`;
  }

  // Segunda-feira seguinte a hoje; numa segunda, a da semana que vem (+7).
  const proximaSegunda = (hoje) => somarDias(hoje, (8 - diaDaSemana(hoje)) % 7 || 7);
  // Os 7 dias (domingo a sábado) da semana de hoje deslocada em n semanas.
  const semanaDe = (hoje, n = 0) => {
    const domingo = somarDias(hoje, 7 * n - diaDaSemana(hoje));
    return Array.from({ length: 7 }, (_, i) => somarDias(domingo, i));
  };

  const semPonto = (texto) => texto.replace(/\.$/, "");
  const capitalizar = (texto) => texto.charAt(0).toUpperCase() + texto.slice(1);
  // "13 nov"; em ano diferente do de hoje, "13 nov 2027".
  const diaEMes = (data, hoje) => `${Number(data.slice(8))} ${semPonto(fmtMesCurto.format(dataMs(data)))}${data.slice(0, 4) === hoje.slice(0, 4) ? "" : ` ${data.slice(0, 4)}`}`;
  const rotuloDia = (data, hoje) => (data === hoje ? "Hoje" : data === somarDias(hoje, 1) ? "Amanhã" : diaEMes(data, hoje));
  // Rótulo do item: "Hoje · 14:00", "Amanhã", "13 nov", "13 nov 2027".
  const rotuloAgenda = (data, hora, hoje) => `${rotuloDia(data, hoje)}${RE_HORA.test(hora ?? "") ? ` · ${hora}` : ""}`;
  // Cabeçalho de um dia: "12 nov · Hoje · quinta-feira", "13 nov · Amanhã · sexta-feira", "14 nov · sábado".
  const tituloGrupoDia = (data, hoje) => [
    diaEMes(data, hoje), data === hoje && "Hoje", data === somarDias(hoje, 1) && "Amanhã", fmtSemana.format(dataMs(data)),
  ].filter(Boolean).join(" · ");
  // Mês e ano da faixa: "Novembro 2026", ou "Novembro – Dezembro 2026" quando a semana cruza o mês.
  function tituloSemana(dias) {
    const [inicio, fim] = [dias[0], dias[dias.length - 1]];
    const mes = (d) => capitalizar(fmtMesLongo.format(dataMs(d)));
    if (inicio.slice(0, 7) === fim.slice(0, 7)) return `${mes(inicio)} ${inicio.slice(0, 4)}`;
    if (inicio.slice(0, 4) === fim.slice(0, 4)) return `${mes(inicio)} – ${mes(fim)} ${inicio.slice(0, 4)}`;
    return `${mes(inicio)} ${inicio.slice(0, 4)} – ${mes(fim)} ${fim.slice(0, 4)}`;
  }

  // Data fora do formato (arquivo editado à mão) conta como sem data; hora só vale com data.
  const dataDe = (l) => (dataValida(l?.data_agendada) ? l.data_agendada : null);
  const horaDe = (l) => (dataDe(l) && RE_HORA.test(l.hora_agendada ?? "") ? l.hora_agendada : null);
  const chaveAgenda = (l) => `${dataDe(l)} ${horaDe(l) ?? "99:99"}`;

  // Função pura: separa os pendentes em atrasados (data < hoje), um grupo por dia (de hoje em diante) e sem data.
  // Dentro de cada grupo: data e hora crescentes, com hora antes de sem hora; no empate, a regra de ordenar (mais recente no topo).
  function agruparLembretes(pendentes, hoje) {
    const recentes = ordenar(pendentes ?? []);
    const comData = recentes.filter((l) => dataDe(l)).sort((a, b) => (chaveAgenda(a) < chaveAgenda(b) ? -1 : chaveAgenda(a) > chaveAgenda(b) ? 1 : 0));
    const porDia = new Map();
    comData.filter((l) => dataDe(l) >= hoje).forEach((l) => porDia.set(dataDe(l), [...(porDia.get(dataDe(l)) ?? []), l]));
    return { atrasados: comData.filter((l) => dataDe(l) < hoje), porDia, semData: recentes.filter((l) => !dataDe(l)) };
  }

  // Grupos da vista aberta. Hoje: Atrasada, hoje e Sem data. Em breve: Atrasada só na semana atual, um grupo por dia (de hoje em diante) e Sem data.
  function montarVista(agrupado, hoje, qual = "hoje", semana = 0) {
    const grupos = [];
    if (agrupado.atrasados.length && (qual === "hoje" || semana === 0)) {
      grupos.push({ chave: "atrasada", titulo: "Atrasada", n: agrupado.atrasados.length, itens: agrupado.atrasados, reagendar: true });
    }
    const dias = qual === "embreve" ? semanaDe(hoje, semana).filter((d) => d >= hoje) : [hoje];
    dias.forEach((d) => grupos.push({ chave: d, data: d, titulo: tituloGrupoDia(d, hoje), itens: agrupado.porDia.get(d) ?? [], adicionar: true }));
    if (agrupado.semData.length) grupos.push({ chave: "sem-data", titulo: "Sem data", n: agrupado.semData.length, itens: agrupado.semData });
    return grupos;
  }

  function elemento(tag, classe, texto) {
    const el = doc().createElement(tag);
    if (classe) el.className = classe;
    if (texto !== undefined) el.textContent = texto;
    return el;
  }

  function ligar(el, evento, acao, args) {
    el.setAttribute(`data-on-${evento}`, acao);
    if (args) el.setAttribute(evento === "keydown" ? "data-args-keydown" : "data-args", JSON.stringify(args));
  }

  function botaoIcone(classe, rotulo, icone, acao, id) {
    const b = elemento("button", `lembretes__acao ${classe}`);
    b.type = "button";
    b.setAttribute("aria-label", rotulo);
    b.title = rotulo;
    // Sprite do index.html (#i-<nome>): o subconjunto do lucide não traz pencil nem trash.
    const svg = doc().createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ck-ico");
    svg.setAttribute("aria-hidden", "true");
    const uso = doc().createElementNS(SVG_NS, "use");
    uso.setAttribute("href", `#i-${icone}`);
    svg.append(uso);
    b.append(svg);
    ligar(b, "click", acao, [id]);
    return b;
  }

  // Ícone de calendário e de fechar (o sprite do index.html não traz calendário): SVG próprio, só com currentColor.
  function icone(desenho, tamanho = 12) {
    const svg = doc().createElementNS(SVG_NS, "svg");
    [["viewBox", "0 0 24 24"], ["width", tamanho], ["height", tamanho], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"],
      ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["class", "lembretes__ico"]]
      .forEach(([nome, valor]) => svg.setAttribute(nome, String(valor)));
    desenho.forEach(([tag, atributos]) => {
      const parte = doc().createElementNS(SVG_NS, tag);
      Object.entries(atributos).forEach(([nome, valor]) => parte.setAttribute(nome, valor));
      svg.append(parte);
    });
    return svg;
  }
  const iconeCalendario = (tamanho) => icone([["rect", { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ["path", { d: "M16 3v4M8 3v4M3 10h18" }]], tamanho);
  const iconeMais = (tamanho) => icone([["path", { d: "M12 5v14M5 12h14" }]], tamanho);
  const iconeFechar = (tamanho) => icone([["path", { d: "M18 6 6 18M6 6l12 12" }]], tamanho);

  // Campo nativo de data ou de hora com rótulo visível (Data, Hora (opcional)); id e escopo definem qual é.
  function campoDataHora(escopo, tipo, rotulo, valor, desligado = false) {
    const bloco = elemento("div", "lembretes__campo-data");
    const label = elemento("label", "lembretes__rotulo-campo", rotulo);
    label.htmlFor = `lembretes-${escopo}-${tipo}`;
    const entrada = elemento("input", "ck-entrada");
    entrada.type = tipo === "data" ? "date" : "time";
    entrada.id = `lembretes-${escopo}-${tipo}`;
    entrada.value = valor;
    entrada.disabled = desligado;
    if (tipo === "data") entrada.max = "9999-12-31";
    ligar(entrada, "change", "lembretesAoMudarData", ["$this"]);
    bloco.append(label, entrada);
    return bloco;
  }

  function criarEdicao(l) {
    const form = elemento("form", "lembretes__edicao");
    form.autocomplete = "off";
    form.noValidate = true;
    ligar(form, "submit", "lembretesSalvarEdicao", [l.id]);
    // O Esc vale em qualquer campo da edição (descrição, data ou hora): o evento sobe até o formulário.
    ligar(form, "keydown", "lembretesTeclaEdicao", ["$event"]);
    const rotulo = elemento("label", "sr-only", "Editar descrição");
    rotulo.htmlFor = "lembretes-edicao-campo";
    const campo = elemento("input", "ck-entrada lembretes__campo");
    campo.type = "text";
    campo.id = "lembretes-edicao-campo";
    campo.value = l.descricao;
    campo.autocomplete = "off";
    campo.setAttribute("aria-describedby", "lembretes-edicao-dica lembretes-edicao-erro");
    ligar(campo, "input", "lembretesAoDigitar", ["$this"]);
    const agenda = elemento("div", "lembretes__edicao-agenda");
    const data = campoDataHora("edicao", "data", "Data", dataDe(l) ?? "");
    // Hora sem data não existe: sem data, o campo da hora já nasce desligado.
    const hora = campoDataHora("edicao", "hora", "Hora (opcional)", horaDe(l) ?? "", !dataDe(l));
    const remover = elemento("button", "ck-btn ck-btn--fantasma ck-btn--sm lembretes__remover-data");
    remover.type = "button";
    remover.append(iconeFechar(14), "Remover data");
    ligar(remover, "click", "lembretesRemoverData", ["edicao"]);
    agenda.append(data, hora, remover);
    const dica = elemento("p", "lembretes__dica");
    dica.append(elemento("kbd", "", "Enter"), " salva · ", elemento("kbd", "", "Esc"), " cancela");
    dica.id = "lembretes-edicao-dica";
    const erro = elemento("p", "lembretes__erro", `A descrição pode ter até ${LIMITE} caracteres.`);
    erro.id = "lembretes-edicao-erro";
    erro.setAttribute("role", "alert");
    erro.hidden = true;
    const acoes = elemento("div", "lembretes__edicao-acoes");
    const cancelar = elemento("button", "ck-btn ck-btn--secundario ck-btn--sm", "Cancelar");
    cancelar.type = "button";
    ligar(cancelar, "click", "lembretesCancelarEdicao", [l.id]);
    const salvar = elemento("button", "ck-btn ck-btn--primario ck-btn--sm", "Salvar");
    salvar.type = "submit";
    acoes.append(cancelar, salvar);
    // Como no modelo: campo, erro, data/hora/remover, botões e, por último, a dica das teclas.
    form.append(rotulo, campo, erro, agenda, acoes, dica);
    return form;
  }

  // Um dia da faixa da semana (Em breve): sem item possível antes de hoje, então o botão fica desligado.
  function criarDia(data, hoje) {
    const botao = elemento("button", "lembretes__dia");
    botao.type = "button";
    botao.dataset.dia = data;
    if (data === hoje) botao.setAttribute("aria-current", "date");
    botao.disabled = data < hoje;
    botao.append(elemento("span", "lembretes__dia-nome", DIAS_CURTOS[diaDaSemana(data)]), elemento("span", "lembretes__dia-num", String(Number(data.slice(8)))));
    ligar(botao, "click", "lembretesIrParaDia", [data]);
    return botao;
  }

  // Um grupo da vista: título, contagem, Reagendar (só em Atrasada), itens e + Adicionar lembrete (só nos dias).
  function criarGrupo(grupo, hoje) {
    const secao = elemento("section", "lembretes__grupo");
    secao.dataset.grupo = grupo.chave;
    const titulo = elemento("h3", "lembretes__grupo-titulo", grupo.titulo);
    titulo.id = `lembretes-grupo-${grupo.chave}`;
    titulo.tabIndex = -1;
    secao.setAttribute("aria-labelledby", titulo.id);
    const topo = elemento("div", "lembretes__grupo-topo");
    topo.append(titulo);
    if (grupo.n !== undefined) topo.append(elemento("span", "lembretes__grupo-n", String(grupo.n)));
    if (grupo.reagendar) {
      const reagendar = elemento("button", "ck-btn ck-btn--fantasma ck-btn--sm lembretes__reagendar", "Reagendar para hoje");
      reagendar.type = "button";
      ligar(reagendar, "click", "lembretesReagendarAtrasados");
      topo.append(reagendar);
    }
    secao.append(topo);
    if (grupo.itens.length) {
      const lista = elemento("ul", "lembretes__lista lembretes__itens");
      lista.append(...grupo.itens.map((l) => criarItem(l, hoje)));
      secao.append(lista);
    }
    if (grupo.adicionar) {
      const adicionar = elemento("button", "lembretes__adicionar-dia");
      adicionar.type = "button";
      adicionar.setAttribute("aria-label", `Adicionar lembrete em ${grupo.titulo}`);
      adicionar.append(iconeMais(14), "Adicionar lembrete");
      ligar(adicionar, "click", "lembretesAdicionarNoDia", [grupo.data]);
      secao.append(adicionar);
    }
    return secao;
  }

  // Chamado UTIC-AAAA-N e OS de 7 dígitos no texto viram botão que abre a janela Chamado × OS (só leitura); o resto fica texto puro.
  function criarLinkReferencia({ tipo, numero, texto }) {
    const b = elemento("button", "ck-link-btn ck-mono lembretes__ref", texto);
    b.type = "button";
    b.setAttribute("aria-haspopup", "dialog");
    b.setAttribute("aria-label", `${tipo === "chamado" ? "Abrir o chamado" : "Abrir a OS"} ${numero} na janela Chamado × OS`);
    ligar(b, "click", "abrirReferenciaLembrete", [{ tipo, numero }, "$this"]);
    return b;
  }

  function criarTexto(descricao) {
    const p = elemento("p", "lembretes__texto");
    const partes = context.chamadosOsModel?.referenciasNoTexto(descricao) ?? [{ texto: descricao }];
    p.append(...partes.map((parte) => (parte.tipo ? criarLinkReferencia(parte) : doc().createTextNode(parte.texto))));
    return p;
  }

  // Bloco recolhível com os dados salvos do termo (só lembretes criados de um termo com a cópia gravada).
  function criarBlocoTermo(l) {
    const secoes = l.termo ? app.termosSecoesLembrete?.(l.origem, l.termo) : null;
    if (!secoes) return null;
    const bloco = elemento("details", "lembretes__termo");
    if (termosAbertos.has(String(l.id))) bloco.open = true;
    bloco.append(elemento("summary", "lembretes__termo-resumo", "Dados do termo"));
    secoes.forEach((s) => {
      const secao = elemento("section", "lembretes__termo-secao");
      secao.append(elemento("h3", "lembretes__termo-titulo", s.titulo));
      if (s.texto !== undefined) {
        secao.append(elemento("p", "lembretes__termo-obs", s.texto));
      } else {
        const lista = elemento("dl", "lembretes__termo-campos");
        s.campos.forEach(([rotulo, valor]) => {
          const linha = elemento("div", "lembretes__termo-linha");
          linha.append(elemento("dt", "", rotulo), elemento("dd", "", valor));
          lista.append(linha);
        });
        secao.append(lista);
      }
      bloco.append(secao);
    });
    const acoes = elemento("div", "lembretes__termo-acoes");
    const pdf = elemento("button", "ck-btn ck-btn--secundario ck-btn--sm", "Gerar PDF");
    pdf.type = "button";
    ligar(pdf, "click", "lembretesGerarPdfTermo", [l.id]);
    const preencher = elemento("button", "ck-btn ck-btn--secundario ck-btn--sm", "Preencher no Termo");
    preencher.type = "button";
    ligar(preencher, "click", "lembretesPreencherTermo", [l.id]);
    acoes.append(pdf, preencher);
    bloco.append(acoes);
    return bloco;
  }

  function criarItem(l, hoje) {
    const li = elemento("li", "lembretes__item");
    li.dataset.lembreteId = l.id;
    if (l.concluido) li.classList.add("lembretes__item--feito");
    if (String(l.id) === String(editandoId)) {
      li.classList.add("lembretes__item--editando");
      // Anel só visual: o item segue no lugar, como no modelo; concluir fica para depois de salvar ou cancelar.
      const anel = elemento("span", "lembretes__marcar lembretes__marcar--fixo");
      anel.setAttribute("aria-hidden", "true");
      li.append(anel, criarEdicao(l));
      return li;
    }
    const marcar = elemento("button", "lembretes__marcar");
    marcar.type = "button";
    marcar.setAttribute("aria-label", `${l.concluido ? "Desmarcar" : "Concluir"}: ${l.descricao}`);
    ligar(marcar, "click", "lembretesAlternar", [l.id]);
    const corpo = elemento("div", "lembretes__corpo");
    const data = elemento("time", l.alterado_em ? "lembretes__data lembretes__data--alterado" : "lembretes__data",`${l.alterado_em ? "Alterado" : "Criado"} em ${formatarData(dataExibida(l))}`);
    data.setAttribute("datetime", dataExibida(l));
    corpo.append(criarTexto(l.descricao));
    const dia = dataDe(l);
    if (dia) {
      // span e não <time>: o único <time> do item é o de Criado/Alterado em.
      const classe = !l.concluido && dia < hoje ? " lembretes__agenda--atrasada" : dia === hoje ? " lembretes__agenda--hoje" : "";
      const agenda = elemento("span", `lembretes__agenda${classe}`);
      agenda.append(iconeCalendario(12), rotuloAgenda(dia, horaDe(l), hoje));
      corpo.append(agenda);
    }
    corpo.append(data);
    const blocoTermo = criarBlocoTermo(l);
    if (blocoTermo) corpo.append(blocoTermo);
    const acoes = elemento("div", "lembretes__acoes");
    acoes.append(
      botaoIcone("lembretes__editar", "Editar lembrete", "pencil", "lembretesEditar", l.id),
      botaoIcone("lembretes__excluir", "Excluir lembrete", "trash", "lembretesExcluir", l.id),
    );
    li.append(marcar, corpo, acoes);
    return li;
  }

  const CAMPOS_EDICAO = ["lembretes-edicao-campo", "lembretes-edicao-data", "lembretes-edicao-hora"];

  // Pílulas Hoje <n> / Em breve, painel da semana (só em Em breve) e faixa de 7 dias.
  function renderizarVistas(agrupado, hoje) {
    const hojeN = porId("lembretes-hoje-n");
    if (hojeN) hojeN.textContent = String(agrupado.atrasados.length + (agrupado.porDia.get(hoje)?.length ?? 0));
    ["hoje", "embreve"].forEach((qual) => {
      const aba = porId(`lembretes-aba-${qual}`);
      if (!aba) return;
      aba.setAttribute("aria-selected", String(qual === vista));
      aba.tabIndex = qual === vista ? 0 : -1;
    });
    porId("lembretes-lista")?.setAttribute("aria-labelledby", `lembretes-aba-${vista}`);
    // Faixa de dias e navegação ‹ Hoje › só existem em Em breve.
    ["lembretes-semana", "lembretes-navegar"].forEach((id) => { const el = porId(id); if (el) el.hidden = vista !== "embreve"; });
    if (vista !== "embreve") return;
    const dias = semanaDe(hoje, semanaAtual);
    const mes = porId("lembretes-mes");
    if (mes) mes.textContent = tituloSemana(dias);
    const anterior = porId("lembretes-semana-anterior");
    if (anterior) anterior.disabled = semanaAtual === 0;
    porId("lembretes-faixa")?.replaceChildren(...dias.map((d) => criarDia(d, hoje)));
  }

  function renderizar() {
    if (!doc()) return;
    // Refazer a lista não pode apagar o que o usuário digita na edição ainda não salva (descrição, data e hora).
    const rascunho = porId("lembretes-edicao-campo") ? {
      id: editandoId,
      valores: CAMPOS_EDICAO.map((id) => porId(id)?.value ?? ""),
      foco: CAMPOS_EDICAO.find((id) => doc().activeElement === porId(id)),
    } : null;
    termosAbertos = new Set([...doc().querySelectorAll("details.lembretes__termo[open]")]
      .map((bloco) => bloco.closest("[data-lembrete-id]")?.dataset.lembreteId));
    // "Hoje" é recalculado a cada desenho: a aba aberta de um dia para o outro não fica presa na data antiga.
    const hoje = hojeEm();
    const pendentes = lembretes.filter((l) => !l.concluido);
    const concluidos = ordenar(lembretes.filter((l) => l.concluido));
    const agrupado = agruparLembretes(pendentes, hoje);
    porId("lembretes-lista")?.replaceChildren(...montarVista(agrupado, hoje, vista, semanaAtual).map((g) => criarGrupo(g, hoje)));
    porId("lembretes-concluidos-lista")?.replaceChildren(...concluidos.map((l) => criarItem(l, hoje)));
    renderizarVistas(agrupado, hoje);
    const vazio = porId("lembretes-vazio");
    if (vazio) vazio.hidden = lembretes.length > 0;
    const bloco = porId("lembretes-concluidos");
    if (bloco) bloco.hidden = concluidos.length === 0;
    const rotulo = porId("lembretes-concluidos-rotulo");
    if (rotulo) rotulo.textContent = `Concluídos (${concluidos.length})`;
    aplicarConcluidos();
    const contador = porId("lembretes-pendentes");
    if (contador) contador.textContent = String(pendentes.length);
    atualizarBotaoData();
    const novoCampo = porId("lembretes-edicao-campo");
    if (rascunho && novoCampo && String(rascunho.id) === String(editandoId)) {
      CAMPOS_EDICAO.forEach((id, i) => { const el = porId(id); if (el) el.value = rascunho.valores[i]; });
      lembretesAoMudarData(porId("lembretes-edicao-data"));
      lembretesAoDigitar(novoCampo);
      if (rascunho.foco) porId(rascunho.foco)?.focus();
    }
  }

  function aplicarConcluidos() {
    porId("lembretes-concluidos-botao")?.setAttribute("aria-expanded", String(concluidosAbertos));
    const lista = porId("lembretes-concluidos-lista");
    if (lista) lista.hidden = !concluidosAbertos;
  }

  function focarCampoNovo() {
    porId("lembretes-novo-descricao")?.focus();
  }

  function focarItem(id, seletor) {
    const item = [...doc().querySelectorAll("[data-lembrete-id]")].find((el) => el.dataset.lembreteId === String(id));
    const alvo = item?.querySelector(seletor);
    if (alvo && alvo.getClientRects().length) alvo.focus();
    else if (!porId("lembretes-concluidos-lista")?.hidden || !porId("lembretes-concluidos")?.hidden) porId("lembretes-concluidos-botao")?.focus();
    else focarCampoNovo();
  }

  // Função pura: monta a descrição a partir do que termosLerDados devolve. Partes vazias ficam de fora e nada é cortado.
  function montarDescricaoTermo(termo, dados) {
    const entrada = termo === "entrega";
    const c = dados?.campos ?? {};
    const v = (nome) => limparTexto(c[nome]);
    const equipamento = (modelo, serie) => [modelo, serie && `série ${serie}`].filter(Boolean).join(", ");
    const recebido = equipamento(v(entrada ? "modelo_entregue" : "modelo"), v(entrada ? "serie_entregue" : "serie"));
    const unidade = v("unidade");
    const data = limparTexto(app.termosFormatarData?.(c.data) ?? c.data);
    const itens = (dados?.itens ?? []).filter((i) => i.resposta === "sim").map((i) => limparTexto(i.rotulo));
    const anterior = entrada ? equipamento(v("modelo_anterior"), v("serie_anterior")) : "";
    const obs = limparTexto(dados?.obs);
    const abertura = `${entrada ? "Entrada" : "Saída"}: ${v("nome")}${unidade ? ` (${unidade})` : ""}`;
    return limparTexto([
      `${abertura}${recebido ? ` ${entrada ? "recebeu" : "devolveu"} ${recebido}` : ""}${data ? ` em ${data}` : ""}.`,
      itens.length && `Itens: ${itens.join(", ")}.`,
      anterior && `Anterior: ${anterior}.`,
      obs && `Obs.: ${obs}`,
    ].filter(Boolean).join(" "));
  }

  function estadoBotaoNovo() {
    const campo = porId("lembretes-novo-descricao");
    const botao = porId("lembretes-adicionar");
    if (!campo || !botao) return;
    const n = tamanho(campo.value.trim());
    botao.disabled = ocupado || n === 0 || n > LIMITE;
    const erro = porId("lembretes-novo-erro");
    if (erro) erro.hidden = n <= LIMITE;
    campo.setAttribute("aria-invalid", String(n > LIMITE));
  }

  // Mesmo teste para o campo de adicionar e para o de editar: vazio ou acima de 2000 desliga o botão de confirmar.
  function lembretesAoDigitar(campo) {
    if (!campo) return;
    if (campo.id === "lembretes-novo-descricao") {
      estadoBotaoNovo();
      return;
    }
    if (campo.id === "lembretes-criar-descricao") {
      estadoBotaoCriar();
      return;
    }
    const form = campo.form;
    const n = tamanho(campo.value.trim());
    const salvar = form?.querySelector('button[type="submit"]');
    if (salvar) salvar.disabled = n === 0 || n > LIMITE;
    const erro = form?.querySelector(".lembretes__erro");
    if (erro) erro.hidden = n <= LIMITE;
    campo.setAttribute("aria-invalid", String(n > LIMITE));
  }

  async function carregarLembretes() {
    const pedido = ++pedidoLista;
    try {
      const dados = await apiFetch(URL_API, { errorMessage: "Não foi possível carregar os lembretes." });
      if (pedido !== pedidoLista) return;
      lembretes = Array.isArray(dados?.lembretes) ? dados.lembretes : [];
      editandoId = null;
      renderizar();
    } catch (erro) {
      if (pedido === pedidoLista) avisarErro(erro, "Não foi possível carregar os lembretes.");
    }
  }

  // Agenda do formulário de novo lembrete: campos nativos de data e hora (texto "" quando vazios).
  const valorCampo = (id) => porId(id)?.value ?? "";

  function atualizarBotaoData() {
    const botao = porId("lembretes-data-botao");
    if (!botao) return;
    const data = valorCampo("lembretes-novo-data");
    const ativa = dataValida(data);
    const hoje = hojeEm();
    const rotulo = porId("lembretes-data-rotulo");
    if (rotulo) rotulo.textContent = ativa ? rotuloAgenda(data, valorCampo("lembretes-novo-hora"), hoje) : "Data";
    botao.classList.toggle("lembretes__data-botao--ativa", ativa);
    [["hoje", hoje], ["amanha", somarDias(hoje, 1)], ["segunda", proximaSegunda(hoje)]].forEach(([nome, dia]) => {
      porId(`lembretes-atalho-${nome}`)?.setAttribute("aria-pressed", String(ativa && data === dia));
    });
  }

  // Hora só existe com data: sem data o campo de hora fica desligado e vazio. Vale para o formulário novo e para a edição.
  function lembretesAoMudarData(campo) {
    const escopo = campo?.id?.startsWith("lembretes-edicao") ? "edicao" : "novo";
    const data = porId(`lembretes-${escopo}-data`);
    const hora = porId(`lembretes-${escopo}-hora`);
    if (!data || !hora) return;
    // Data digitada pela metade (badInput) também chega como "": não apaga a hora já escolhida.
    if (!data.validity?.badInput) {
      hora.disabled = !data.value;
      if (!data.value) hora.value = "";
    }
    if (escopo === "novo") atualizarBotaoData();
  }

  function lembretesAtalhoData(qual) {
    const campo = porId("lembretes-novo-data");
    if (!campo) return;
    const hoje = hojeEm();
    campo.value = qual === "amanha" ? somarDias(hoje, 1) : qual === "segunda" ? proximaSegunda(hoje) : hoje;
    lembretesAoMudarData(campo);
  }

  function lembretesRemoverData(escopo) {
    const data = porId(`lembretes-${escopo === "edicao" ? "edicao" : "novo"}-data`);
    if (!data) return;
    data.value = "";
    lembretesAoMudarData(data);
    data.focus();
  }

  function painelData(abrir) {
    const painel = porId("lembretes-data-painel");
    if (!painel) return;
    painel.hidden = !abrir;
    porId("lembretes-data-botao")?.setAttribute("aria-expanded", String(abrir));
  }

  function lembretesAlternarPainelData() {
    const painel = porId("lembretes-data-painel");
    if (painel) painelData(painel.hidden);
  }

  // Esc fecha só o painel Data agendada e devolve o foco ao botão Data; preventDefault impede o Esc de fechar o painel de ferramentas.
  function lembretesTeclaPainelData(evento) {
    if (evento?.key !== "Escape" || porId("lembretes-data-painel")?.hidden !== false) return;
    evento.preventDefault();
    painelData(false);
    porId("lembretes-data-botao")?.focus();
  }

  function limparAgendaNovo() {
    const data = porId("lembretes-novo-data");
    const hora = porId("lembretes-novo-hora");
    if (data) data.value = "";
    if (hora) { hora.value = ""; hora.disabled = true; }
    painelData(false);
    atualizarBotaoData();
  }

  // Corpo do POST: só inclui a data quando é uma data real; a hora, só com data e no formato HH:MM.
  function lerAgendaNova() {
    const data = valorCampo("lembretes-novo-data");
    if (!dataValida(data)) return {};
    const hora = valorCampo("lembretes-novo-hora");
    return RE_HORA.test(hora) ? { data_agendada: data, hora_agendada: hora } : { data_agendada: data };
  }

  // Item agendado para um dia fora da vista aberta: o toast diz para onde ele foi.
  function avisarSeFora(l) {
    const dia = l && !l.concluido ? dataDe(l) : null;
    if (!dia) return;
    const aqui = [...(porId("lembretes-lista")?.querySelectorAll("[data-lembrete-id]") ?? [])].some((el) => el.dataset.lembreteId === String(l.id));
    if (!aqui) app.showToast(`Lembrete agendado para ${rotuloAgenda(dia, horaDe(l), hojeEm())}.`);
  }

  async function lembretesAdicionar() {
    const campo = porId("lembretes-novo-descricao");
    if (!campo || ocupado) return;
    const descricao = campo.value.trim();
    if (!descricao || tamanho(descricao) > LIMITE) return;
    // Data incompleta: não cria o lembrete sem data; leva o foco ao campo para completar.
    const campoData = porId("lembretes-novo-data");
    if (campoData?.validity?.badInput) {
      painelData(true);
      campoData.focus();
      return;
    }
    const agenda = lerAgendaNova();
    ocupado = true;
    estadoBotaoNovo();
    try {
      const criado = await mutar(URL_API, {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ descricao, ...agenda }),
        errorMessage: "Não foi possível adicionar o lembrete.",
      });
      lembretes = [...lembretes, criado];
      campo.value = "";
      limparAgendaNovo();
      renderizar();
      avisarSeFora(criado);
    } catch (erro) {
      avisarErro(erro, "Não foi possível adicionar o lembrete.");
    } finally {
      ocupado = false;
      estadoBotaoNovo();
      focarCampoNovo();
    }
  }

  async function atualizar(id, campos, mensagem) {
    const atualizado = await mutar(`${URL_API}/${encodeURIComponent(id)}`, {
      method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(campos), errorMessage: mensagem,
    });
    lembretes = lembretes.map((l) => (String(l.id) === String(id) ? atualizado : l));
  }

  async function lembretesAlternar(id) {
    const l = achar(id);
    if (!l || ocupado) return;
    ocupado = true;
    try {
      await atualizar(id, { concluido: !l.concluido }, "Não foi possível atualizar o lembrete.");
      renderizar();
    } catch (erro) {
      avisarErro(erro, "Não foi possível atualizar o lembrete.");
    } finally {
      ocupado = false;
    }
    focarItem(id, ".lembretes__marcar");
  }

  function lembretesEditar(id) {
    if (!achar(id)) return;
    editandoId = id;
    renderizar();
    const campo = porId("lembretes-edicao-campo");
    campo?.focus();
    campo?.setSelectionRange?.(campo.value.length, campo.value.length);
  }

  function sairDaEdicao(id) {
    editandoId = null;
    renderizar();
    focarItem(id, ".lembretes__editar");
  }

  function lembretesCancelarEdicao(id) {
    if (String(editandoId) === String(id)) sairDaEdicao(id);
  }

  function lembretesTeclaEdicao(evento) {
    if (evento?.key !== "Escape" || editandoId === null) return;
    // preventDefault impede o Esc de também fechar o painel de ferramentas.
    evento.preventDefault();
    sairDaEdicao(editandoId);
  }

  // Função pura: só o que mudou vai no PATCH. Tirar a data manda data_agendada null (o backend limpa a hora junto);
  // trocar só a data mantém a hora; a hora só entra quando há data e ela mudou.
  function camposEditados(l, { descricao, data, hora }) {
    const campos = {};
    if (descricao !== l.descricao) campos.descricao = descricao;
    if (data !== (dataDe(l) ?? "")) campos.data_agendada = data || null;
    if (data && hora !== (horaDe(l) ?? "")) campos.hora_agendada = hora || null;
    return campos;
  }

  async function lembretesSalvarEdicao(id) {
    const l = achar(id);
    const campo = porId("lembretes-edicao-campo");
    if (!l || !campo || ocupado) return;
    const descricao = campo.value.trim();
    if (!descricao || tamanho(descricao) > LIMITE) return;
    const campoData = porId("lembretes-edicao-data");
    // Data incompleta chega como "": sem esta checagem o PATCH apagaria a data e a hora.
    if (campoData?.validity?.badInput) {
      campoData.focus();
      return;
    }
    const data = valorCampo("lembretes-edicao-data");
    if (data && !dataValida(data)) return;
    const campos = camposEditados(l, { descricao, data, hora: valorCampo("lembretes-edicao-hora") });
    // Nada mudou: sem PATCH, e o alterado_em continua o mesmo.
    if (!Object.keys(campos).length) {
      sairDaEdicao(id);
      return;
    }
    ocupado = true;
    try {
      await atualizar(id, campos, "Não foi possível salvar o lembrete.");
      sairDaEdicao(id);
      if ("data_agendada" in campos || "hora_agendada" in campos) avisarSeFora(achar(id));
    } catch (erro) {
      avisarErro(erro, "Não foi possível salvar o lembrete.");
    } finally {
      ocupado = false;
    }
  }

  function lembretesAlternarConcluidos() {
    concluidosAbertos = !concluidosAbertos;
    aplicarConcluidos();
  }

  function lembretesExcluir(id) {
    const l = achar(id);
    if (!l) return;
    excluindoId = id;
    porId("lembretes-confirmar-item").textContent = l.descricao;
    app.abrirModalAcessivel("lembretes-confirmar", "#lembretes-confirmar-cancelar", "lembretesCancelarExclusao");
    // abrirModalAcessivel marca todo diálogo como role="dialog"; esta pergunta é destrutiva.
    porId("lembretes-confirmar")?.firstElementChild?.setAttribute("role", "alertdialog");
  }

  // Também é o fechamento do Esc (accessible-dialogs chama window[data-close-function]).
  function lembretesCancelarExclusao() {
    if (excluindoId === null) return;
    excluindoId = null;
    app.fecharModalAcessivel("lembretes-confirmar");
  }

  async function lembretesConfirmarExclusao() {
    const id = excluindoId;
    if (id === null || ocupado) return;
    ocupado = true;
    const antes = lembretes.find((l) => String(l.id) === String(id));
    const lista = antes?.concluido ? "lembretes-concluidos-lista" : "lembretes-lista";
    // A lista de pendentes tem grupos: os itens (li) são contados na ordem da tela, de todos os grupos.
    const itensDaLista = () => [...(porId(lista)?.querySelectorAll("[data-lembrete-id]") ?? [])];
    const indice = itensDaLista().findIndex((li) => li.dataset.lembreteId === String(id));
    let removido = false;
    try {
      await mutar(`${URL_API}/${encodeURIComponent(id)}`, { method: "DELETE", errorMessage: "Não foi possível excluir o lembrete." });
      removido = true;
    } catch (erro) {
      avisarErro(erro, "Não foi possível excluir o lembrete.");
      if (erro?.status === 404) removido = true;
    } finally {
      ocupado = false;
      excluindoId = null;
      app.fecharModalAcessivel("lembretes-confirmar");
    }
    if (!removido) return;
    lembretes = lembretes.filter((l) => String(l.id) !== String(id));
    renderizar();
    // O foco volta ao item que ocupou o lugar do excluído; sem itens na lista, ao campo de adicionar.
    const itens = itensDaLista();
    const proximo = itens[Math.min(indice, itens.length - 1)];
    if (proximo && proximo.getClientRects().length) proximo.querySelector(".lembretes__marcar")?.focus();
    else focarCampoNovo();
  }

  // Diálogo Criar lembrete (Termo Entrega e Termo Devolução): o texto já vem montado e o usuário revisa antes de criar.
  function estadoBotaoCriar() {
    const campo = porId("lembretes-criar-descricao");
    const botao = porId("lembretes-criar-ok");
    if (!campo || !botao) return;
    const n = tamanho(limparTexto(campo.value));
    botao.disabled = n === 0 || n > LIMITE;
    const erro = porId("lembretes-criar-erro");
    if (erro) erro.hidden = n <= LIMITE;
    campo.setAttribute("aria-invalid", String(n > LIMITE));
  }

  function avisoDoTermo(termo, texto) {
    const el = porId(`termos-status-${termo}`);
    if (!el) return null;
    el.textContent = texto;
    delete el.dataset.tipo;
    return el;
  }

  function lembretesCriarDoTermo(termo) {
    // Sem número de série ou sem nome, termosLerValidado mostra o aviso no termo e nada abre.
    const dados = app.termosLerValidado?.(termo);
    const campo = porId("lembretes-criar-descricao");
    // Com um POST em andamento, o fim dele fecharia este diálogo novo e o texto revisado se perderia.
    if (!dados || !campo || ocupado) return;
    avisoDoTermo(termo, "");
    criando = termo;
    copiaTermo = {
      campos: Object.fromEntries(Object.entries(dados.campos).map(([chave, valor]) => [chave, textoTermo(valor, 200)])),
      itens: dados.itens.map((item) => item.resposta),
      obs: textoTermo(dados.obs, 2000, "\n\r\t"),
    };
    campo.value = montarDescricaoTermo(termo, dados);
    estadoBotaoCriar();
    app.abrirModalAcessivel("lembretes-criar", "#lembretes-criar-descricao", "lembretesCancelarCriar");
  }

  // Também é o fechamento do Esc (accessible-dialogs chama window[data-close-function]).
  function lembretesCancelarCriar() {
    if (criando === null) return;
    criando = null;
    copiaTermo = null;
    app.fecharModalAcessivel("lembretes-criar");
  }

  async function lembretesConfirmarCriar() {
    const termo = criando;
    const campo = porId("lembretes-criar-descricao");
    if (termo === null || !campo || ocupado) return;
    // Mesma limpeza da parte pura: o usuário pode ter digitado quebra de linha no campo.
    const descricao = limparTexto(campo.value);
    if (!descricao || tamanho(descricao) > LIMITE) return;
    ocupado = true;
    porId("lembretes-criar-ok").disabled = true;
    let criado = null;
    try {
      criado = await mutar(URL_API, {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ descricao, origem: termo, termo: copiaTermo }),
        errorMessage: "Não foi possível criar o lembrete.",
      });
    } catch (erro) {
      avisarErro(erro, "Não foi possível criar o lembrete.");
    } finally {
      ocupado = false;
      estadoBotaoCriar();
    }
    // Em erro o diálogo continua aberto, com o texto, para tentar de novo.
    if (!criado) return;
    criando = null;
    copiaTermo = null;
    lembretes = [...lembretes, criado];
    renderizar();
    app.fecharModalAcessivel("lembretes-criar");
    const aviso = avisoDoTermo(termo, "Lembrete criado.");
    if (!aviso) return;
    const ver = elemento("button", "ck-btn ck-btn--fantasma ck-btn--sm lembretes__ver", "Ver em Lembretes");
    ver.type = "button";
    ligar(ver, "click", "lembretesVerLembretes", [criado.id]);
    aviso.append(ver);
  }

  function lembretesVerLembretes(id) {
    app.termosSelecionarAba?.("lembretes");
    focarItem(id, ".lembretes__marcar");
  }

  // Vistas Hoje e Em breve (pílulas, tablist com setas) e navegação por semana.
  function lembretesSelecionarVista(qual) {
    if ((qual !== "hoje" && qual !== "embreve") || qual === vista) return;
    editandoId = null;
    vista = qual;
    semanaAtual = 0;
    renderizar();
  }

  function lembretesTeclaVista(evento) {
    const abas = ["hoje", "embreve"];
    const passo = { ArrowRight: 1, ArrowLeft: -1 }[evento?.key];
    const alvo = evento?.key === "Home" ? 0 : evento?.key === "End" ? abas.length - 1
      : passo === undefined ? null : (abas.indexOf(vista) + passo + abas.length) % abas.length;
    if (alvo === null) return;
    evento.preventDefault();
    lembretesSelecionarVista(abas[alvo]);
    porId(`lembretes-aba-${vista}`)?.focus();
  }

  // delta: -1 semana anterior, 1 próxima semana, 0 volta à semana de hoje. Nunca mostra semana passada.
  function lembretesMudarSemana(delta) {
    const nova = Number(delta) === 0 ? 0 : Math.max(0, semanaAtual + Number(delta));
    if (nova === semanaAtual) return;
    editandoId = null;
    semanaAtual = nova;
    renderizar();
    // Semana anterior fica desligada na semana de hoje: o foco passa para Próxima semana em vez de se perder.
    if (Number(delta) < 0 && porId("lembretes-semana-anterior")?.disabled) porId("lembretes-semana-proxima")?.focus();
  }

  function lembretesIrParaDia(data) {
    porId(`lembretes-grupo-${data}`)?.focus();
  }

  // + Adicionar lembrete de um dia: põe a data no formulário e leva o foco à descrição.
  function lembretesAdicionarNoDia(data) {
    const campo = porId("lembretes-novo-data");
    if (!campo || !dataValida(data)) return;
    campo.value = data;
    lembretesAoMudarData(campo);
    focarCampoNovo();
  }

  // Sem confirmação (como no Todoist): o backend move todo pendente atrasado para hoje, mantendo a hora.
  async function lembretesReagendarAtrasados() {
    if (ocupado) return;
    // Uma edição aberta seria salva depois com a data antiga e desfaria o reagendamento.
    editandoId = null;
    ocupado = true;
    let movidos = 0;
    try {
      const dados = await mutar(`${URL_API}/reagendar-atrasados`, { method: "POST", errorMessage: "Não foi possível reagendar os lembretes." });
      if (Array.isArray(dados?.lembretes)) lembretes = dados.lembretes;
      movidos = Number(dados?.reagendados) || 0;
      renderizar();
      if (movidos > 0) app.showToast(movidos === 1 ? "1 lembrete reagendado para hoje." : `${movidos} lembretes reagendados para hoje.`);
    } catch (erro) {
      avisarErro(erro, "Não foi possível reagendar os lembretes.");
    } finally {
      ocupado = false;
    }
    // O botão Reagendar sai da tela: o foco vai ao grupo de hoje, onde os itens foram parar.
    if (movidos > 0) porId(`lembretes-grupo-${hojeEm()}`)?.focus();
  }

  // Ações do bloco "Dados do termo": usam só os dados salvos no lembrete.
  function lembretesGerarPdfTermo(id) {
    const l = achar(id);
    if (l?.termo) return app.termosGerarPdfDoLembrete?.(l.origem, l.termo);
  }

  function lembretesPreencherTermo(id) {
    const l = achar(id);
    if (l?.termo) return app.termosPreencherDoLembrete?.(l.origem, l.termo);
  }

  return {
    carregarLembretes, lembretesAdicionar, lembretesAoDigitar, lembretesAlternar, lembretesEditar,
    lembretesCancelarEdicao, lembretesTeclaEdicao, lembretesSalvarEdicao, lembretesAlternarConcluidos,
    lembretesExcluir, lembretesCancelarExclusao, lembretesConfirmarExclusao,
    montarDescricaoTermo, lembretesCriarDoTermo, lembretesCancelarCriar, lembretesConfirmarCriar, lembretesVerLembretes,
    lembretesSelecionarVista, lembretesTeclaVista, lembretesMudarSemana, lembretesIrParaDia, lembretesAdicionarNoDia,
    lembretesReagendarAtrasados, lembretesAlternarPainelData, lembretesTeclaPainelData, lembretesAtalhoData,
    lembretesAoMudarData, lembretesRemoverData,
    // Funções puras (testadas em tests/frontend/test_lembretes.cjs).
    hojeEm, agruparLembretes, montarVista, camposEditados, rotuloAgenda, tituloGrupoDia, tituloSemana, proximaSegunda, semanaDe, dataValida, somarDias,
    lembretesGerarPdfTermo, lembretesPreencherTermo,
  };
});
