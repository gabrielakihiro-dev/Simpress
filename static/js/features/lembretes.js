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

  const tamanho = (texto) => [...String(texto ?? "")].length;
  const mensagemDe = (erro, padrao) => (erro?.status && erro.message ? erro.message : padrao);
  const avisarErro = (erro, padrao) => app.showToast(mensagemDe(erro, padrao), "error");

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

  function criarEdicao(l) {
    const form = elemento("form", "lembretes__edicao");
    form.autocomplete = "off";
    form.noValidate = true;
    ligar(form, "submit", "lembretesSalvarEdicao", [l.id]);
    const rotulo = elemento("label", "sr-only", "Editar descrição");
    rotulo.htmlFor = "lembretes-edicao-campo";
    const campo = elemento("input", "ck-entrada lembretes__campo");
    campo.type = "text";
    campo.id = "lembretes-edicao-campo";
    campo.value = l.descricao;
    campo.autocomplete = "off";
    campo.setAttribute("aria-describedby", "lembretes-edicao-dica lembretes-edicao-erro");
    ligar(campo, "input", "lembretesAoDigitar", ["$this"]);
    ligar(campo, "keydown", "lembretesTeclaEdicao", ["$event"]);
    const dica = elemento("p", "lembretes__dica", "Enter salva · Esc cancela");
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
    form.append(rotulo, campo, dica, erro, acoes);
    return form;
  }

  function criarItem(l) {
    const li = elemento("li", "lembretes__item");
    li.dataset.lembreteId = l.id;
    if (l.concluido) li.classList.add("lembretes__item--feito");
    if (String(l.id) === String(editandoId)) {
      li.classList.add("lembretes__item--editando");
      li.append(criarEdicao(l));
      return li;
    }
    const marcar = elemento("button", "lembretes__marcar");
    marcar.type = "button";
    marcar.setAttribute("aria-label", `${l.concluido ? "Desmarcar" : "Concluir"}: ${l.descricao}`);
    ligar(marcar, "click", "lembretesAlternar", [l.id]);
    const corpo = elemento("div", "lembretes__corpo");
    const data = elemento("time", "lembretes__data", `${l.alterado_em ? "Alterado" : "Criado"} em ${formatarData(dataExibida(l))}`);
    data.setAttribute("datetime", dataExibida(l));
    corpo.append(elemento("p", "lembretes__texto", l.descricao), data);
    const acoes = elemento("div", "lembretes__acoes");
    acoes.append(
      botaoIcone("lembretes__editar", "Editar lembrete", "pencil", "lembretesEditar", l.id),
      botaoIcone("lembretes__excluir", "Excluir lembrete", "trash", "lembretesExcluir", l.id),
    );
    li.append(marcar, corpo, acoes);
    return li;
  }

  function renderizar() {
    if (!doc()) return;
    const pendentes = ordenar(lembretes.filter((l) => !l.concluido));
    const concluidos = ordenar(lembretes.filter((l) => l.concluido));
    porId("lembretes-lista")?.replaceChildren(...pendentes.map(criarItem));
    porId("lembretes-concluidos-lista")?.replaceChildren(...concluidos.map(criarItem));
    const vazio = porId("lembretes-vazio");
    if (vazio) vazio.hidden = lembretes.length > 0;
    const bloco = porId("lembretes-concluidos");
    if (bloco) bloco.hidden = concluidos.length === 0;
    const rotulo = porId("lembretes-concluidos-rotulo");
    if (rotulo) rotulo.textContent = `Concluídos (${concluidos.length})`;
    aplicarConcluidos();
    const contador = porId("lembretes-pendentes");
    if (contador) contador.textContent = String(pendentes.length);
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

  async function lembretesAdicionar() {
    const campo = porId("lembretes-novo-descricao");
    if (!campo || ocupado) return;
    const descricao = campo.value.trim();
    if (!descricao || tamanho(descricao) > LIMITE) return;
    ocupado = true;
    estadoBotaoNovo();
    try {
      const criado = await apiFetch(URL_API, {
        method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ descricao }),
        errorMessage: "Não foi possível adicionar o lembrete.",
      });
      lembretes = [...lembretes, criado];
      campo.value = "";
      renderizar();
    } catch (erro) {
      avisarErro(erro, "Não foi possível adicionar o lembrete.");
    } finally {
      ocupado = false;
      estadoBotaoNovo();
      focarCampoNovo();
    }
  }

  async function atualizar(id, campos, mensagem) {
    const atualizado = await apiFetch(`${URL_API}/${encodeURIComponent(id)}`, {
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

  async function lembretesSalvarEdicao(id) {
    const l = achar(id);
    const campo = porId("lembretes-edicao-campo");
    if (!l || !campo || ocupado) return;
    const descricao = campo.value.trim();
    if (!descricao || tamanho(descricao) > LIMITE) return;
    // Sem mudança no texto não há PATCH: a data não muda.
    if (descricao === l.descricao) {
      sairDaEdicao(id);
      return;
    }
    ocupado = true;
    try {
      await atualizar(id, { descricao }, "Não foi possível salvar o lembrete.");
      sairDaEdicao(id);
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
    const indice = [...(porId(lista)?.children ?? [])].findIndex((li) => li.dataset.lembreteId === String(id));
    let removido = false;
    try {
      await apiFetch(`${URL_API}/${encodeURIComponent(id)}`, { method: "DELETE", errorMessage: "Não foi possível excluir o lembrete." });
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
    const itens = [...(porId(lista)?.children ?? [])];
    const proximo = itens[Math.min(indice, itens.length - 1)];
    if (proximo && proximo.getClientRects().length) proximo.querySelector(".lembretes__marcar")?.focus();
    else focarCampoNovo();
  }

  return {
    carregarLembretes, lembretesAdicionar, lembretesAoDigitar, lembretesAlternar, lembretesEditar,
    lembretesCancelarEdicao, lembretesTeclaEdicao, lembretesSalvarEdicao, lembretesAlternarConcluidos,
    lembretesExcluir, lembretesCancelarExclusao, lembretesConfirmarExclusao,
  };
});
