/** Cobertura de equipamentos (F10): necessidades, disponíveis, reservas, movimentações e devoluções por cidade. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).coverage = factory;
})(typeof window !== "undefined" ? window : globalThis, function createCoverage(context) {
  "use strict";
  const { app } = context;
  const ABAS = ["necessidades", "disponiveis", "reservas", "movimento", "devolucoes"];
  let dados = null;
  let ligado = false;
  let fila = Promise.resolve();
  let carregouAlgumaVez = false;

  const byId = id => document.getElementById(id);
  const modelo = () => window.SimpressCoverageModel;

  // Texto do servidor entra só por textContent.
  function el(tag, classe, texto) {
    const node = document.createElement(tag);
    if (classe) node.className = classe;
    if (texto !== undefined && texto !== null) node.textContent = String(texto);
    return node;
  }

  function status(texto, tipo = "info") {
    const node = byId("cobertura-status");
    if (!node) return;
    node.textContent = texto;
    node.dataset.tipo = tipo;
  }

  function avisar(texto, tipo) {
    status(texto, tipo === "error" ? "erro" : "info");
    app.showToast?.(texto, tipo);
  }

  async function requisitar(metodo, url, corpo) {
    let resposta;
    try {
      resposta = await fetch(url, {
        method: metodo,
        headers: corpo ? { "Content-Type": "application/json" } : undefined,
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
    } catch (error) {
      return { ok: false, status: 0, corpo: null };
    }
    const json = await resposta.json().catch(() => null);
    return { ok: resposta.ok, status: resposta.status, corpo: json };
  }

  // Toda escrita leva o rev do registro; 404, 409 e 503 recarregam antes de mostrar a mensagem do servidor.
  async function escrever(url, corpo, sucesso) {
    if (!dados) {
      avisar("A cobertura não está carregada; nada foi gravado.", "error");
      return null;
    }
    const r = await requisitar("POST", url, corpo);
    if (r.ok) {
      await carregarCobertura();
      if (sucesso) avisar(sucesso, "success");
      return r.corpo || {};
    }
    if (r.status === 404 || r.status === 409 || r.status === 503) await carregarCobertura();
    avisar(modelo().mensagemErro(r.corpo, r.status), "error");
    return null;
  }

  function bloquearEscrita(bloquear) {
    document.querySelectorAll("[data-cobertura-escrita]").forEach(form => {
      form.hidden = bloquear;
      form.querySelectorAll("input, select, textarea, button").forEach(campo => { campo.disabled = bloquear; });
    });
  }

  function limparListas() {
    ABAS.forEach(aba => byId(`cobertura-lista-${aba}`)?.replaceChildren());
    byId("cobertura-alertas")?.replaceChildren();
    document.querySelectorAll("[data-cobertura-n]").forEach(n => { n.textContent = "0"; });
  }

  // Leituras em fila: a releitura pedida depois de uma escrita nunca reaproveita uma leitura iniciada antes dela.
  function carregarCobertura() {
    ligar();
    const vez = fila.then(lerCobertura);
    fila = vez.catch(() => false);
    return vez;
  }

  // aria-busy só nos painéis e nos alertas: nunca no ancestral de #cobertura-status (aria-live), que engoliria o anúncio.
  const regioesOcupadas = () => [...document.querySelectorAll(".cob__painel"), byId("cobertura-alertas")].filter(Boolean);

  async function lerCobertura() {
    status("Carregando…");
    regioesOcupadas().forEach(regiao => regiao.setAttribute("aria-busy", "true"));
    try {
      const r = await requisitar("GET", "/api/cobertura");
      carregouAlgumaVez = true;
      if (!r.ok || !r.corpo) {
        dados = null;
        bloquearEscrita(true);
        limparListas();
        status(modelo().mensagemErro(r.corpo, r.status), "erro");
        return false;
      }
      dados = r.corpo;
      bloquearEscrita(false);
      renderizar();
      status(`Cobertura atualizada em ${modelo().formatarData(dados.hoje)}.`);
      return true;
    } finally {
      regioesOcupadas().forEach(regiao => regiao.removeAttribute("aria-busy"));
    }
  }

  // ------------------------------------------------------------------ montagem
  function botao(rotulo, variante, aoClicar, rotuloAcessivel) {
    const b = el("button", `ck-btn ck-btn--${variante} ck-btn--sm`, rotulo);
    b.type = "button";
    if (rotuloAcessivel) b.setAttribute("aria-label", rotuloAcessivel);
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await aoClicar();
      } finally {
        b.disabled = false;
        // A lista foi redesenhada: o foco volta para o painel da aba, nunca para o body.
        if (!b.isConnected) document.querySelector(".cob__painel:not([hidden])")?.focus();
      }
    });
    return b;
  }

  function selo({ texto, status: tipo }) {
    const s = el("span", "ck-badge", texto);
    s.dataset.status = tipo;
    return s;
  }

  function campo(rotulo, entrada) {
    const label = el("label", "ck-campo");
    label.append(el("span", "ck-campo__rotulo", rotulo), entrada);
    return label;
  }

  function entrada(tipo, valor, extra = {}) {
    const input = el("input", "ck-entrada");
    input.type = tipo;
    if (valor) input.value = valor;
    Object.assign(input, extra);
    return input;
  }

  function grupo(classe, ...filhos) {
    const div = el("div", classe);
    div.append(...filhos.filter(Boolean));
    return div;
  }

  function tabela(rotulo, colunas, linhas, vazio) {
    if (!linhas.length) return el("p", "cob__vazio", vazio);
    const table = el("table", "ck-tabela ck-tabela--cards cob__tabela");
    table.setAttribute("aria-label", rotulo);
    const tr = el("tr");
    colunas.forEach(c => { const th = el("th", "", c); th.scope = "col"; tr.append(th); });
    const thead = el("thead");
    thead.append(tr);
    const tbody = el("tbody");
    linhas.forEach(celulas => {
      const linha = el("tr");
      celulas.forEach((conteudo, i) => {
        const td = el("td");
        td.dataset.label = colunas[i];
        if (i === celulas.length - 1) td.classList.add("ck-td--largo");
        if (conteudo instanceof Node) td.append(conteudo);
        else td.textContent = conteudo === undefined || conteudo === null || conteudo === "" ? "—" : String(conteudo);
        linha.append(td);
      });
      tbody.append(linha);
    });
    table.append(thead, tbody);
    return table;
  }

  function casos(secao) {
    return (dados?.casos && dados.casos[secao]) || {};
  }

  // ------------------------------------------------------------------ alertas e abas
  function renderizarAlertas() {
    const caixa = byId("cobertura-alertas");
    if (!caixa) return;
    const pendencias = window.SimpressCoberturaVinculo?.pendenciaSemVinculo?.() || [];
    const itens = modelo().alertas(dados, pendencias).map(alerta => {
      const aviso = el("div", "ck-aviso");
      aviso.dataset.gravidade = alerta.gravidade;
      aviso.dataset.coberturaAlerta = alerta.tipo;
      const icone = el("span", "ck-aviso__icone");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ck-ico");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", alerta.tipo === "sem_vinculo" ? "#i-link" : "#i-alerta");
      svg.append(use);
      icone.append(svg);
      aviso.append(icone, grupo("ck-aviso__topo", el("p", "ck-aviso__titulo", alerta.texto)));
      if (alerta.detalhe && alerta.detalhe !== alerta.texto) aviso.append(el("p", "ck-aviso__texto", alerta.detalhe));
      if (alerta.tipo === "sem_vinculo") {
        aviso.append(el("p", "ck-aviso__texto", `Série ${alerta.serie}`));
        const tentar = botao("Tentar vincular de novo", "secundario", () => tentarDeNovo(alerta.movimentacaoId), `Tentar vincular de novo — série ${alerta.serie}`);
        tentar.classList.add("ck-aviso__acao");
        aviso.append(tentar);
      }
      return aviso;
    });
    caixa.replaceChildren(...itens);
  }

  async function tentarDeNovo(id) {
    const api = window.SimpressCoberturaVinculo;
    if (!api) return;
    await api.tentarVincularDeNovo(id);
    await carregarCobertura();
  }

  function selecionarAba(nome, focar) {
    ABAS.forEach(aba => {
      const tab = byId(`cobertura-aba-${aba}`);
      const ativo = aba === nome;
      tab?.setAttribute("aria-selected", String(ativo));
      if (tab) tab.tabIndex = ativo ? 0 : -1;
      const painel = byId(`cobertura-painel-${aba}`);
      if (painel) painel.hidden = !ativo;
      if (ativo && focar) tab?.focus();
    });
  }

  // ------------------------------------------------------------------ listas
  function renderizarNecessidades() {
    const m = modelo();
    const demandas = casos("demandas");
    const linhas = (dados.vagas || []).map(vaga => {
      const demanda = demandas[vaga.demanda_id] || {};
      const situacao = grupo("cob__selos", ...m.selosDaVaga(vaga).map(selo));
      if (vaga.motivo) situacao.append(el("span", "cob__nota", vaga.motivo));
      const acoes = grupo("cob__acoes");
      const acao = m.acaoDaVaga(vaga);
      if (acao) acoes.append(botao(acao.rotulo, "primario", () => reservar(acao), `${acao.rotulo} — ${vaga.serie || ""} para ${vaga.cidade}`));
      if (vaga.indice === 1 && demanda.estado === "aberta") {
        acoes.append(botao("Cancelar necessidade", "perigo", () => cancelarNecessidade(demanda), `Cancelar necessidade de ${demanda.cidade}`));
      }
      return [
        `${vaga.indice}/${demanda.quantidade || vaga.indice}`,
        vaga.cidade,
        m.formatarData(vaga.data),
        `${vaga.perfil || "—"}${vaga.monitor ? " + monitor" : ""}`,
        situacao,
        vaga.serie,
        acoes,
      ];
    });
    byId("cobertura-lista-necessidades").replaceChildren(tabela(
      "Necessidades", ["Necessidade", "Cidade", "Data", "Perfil", "Situação", "Série", "Ações"], linhas, "Nenhuma necessidade aberta.",
    ));
  }

  async function reservar(acao) {
    const corpo = { ...acao.corpo, manutencao_conferida: false };
    if (modelo().exigeConferenciaManutencao(dados)) {
      const confirmado = await app.confirmarAcao({
        titulo: "Manutenção não verificada",
        mensagem: `${dados.manutencao.aviso || "A fonte de manutenção não pôde ser lida."} Confirme que a máquina não está em manutenção antes de reservar.`,
        confirmar: acao.rotulo,
        destrutiva: false,
      });
      if (!confirmado) return;
      corpo.manutencao_conferida = true;
    }
    await escrever("/api/cobertura/reservas", corpo, "Reserva registrada.");
  }

  async function cancelarNecessidade(demanda) {
    const ok = await app.confirmarAcao({
      titulo: "Cancelar necessidade",
      mensagem: `A necessidade de ${demanda.cidade} (${modelo().formatarData(demanda.data)}) será cancelada.`,
      confirmar: "Cancelar necessidade",
      cancelar: "Voltar",
    });
    if (ok) await escrever(`/api/cobertura/demandas/${encodeURIComponent(demanda.id)}/cancelar`, { rev: demanda.rev }, "Necessidade cancelada.");
  }

  function renderizarDisponiveis() {
    const m = modelo();
    const bloqueios = new Map((dados.bloqueios || []).map(b => [m.chaveSerie(b.serie), b.motivo]));
    const sinais = new Map((dados.sinais || []).map(s => [m.chaveSerie(s.serie), s.sinal]));
    const registros = Object.values(casos("disponibilidade")).sort((a, b) => String(a.serie).localeCompare(String(b.serie)));
    const linhas = registros.map(reg => {
      const estado = reg.estado_efetivo || reg.estado;
      const tipo = estado === "disponivel" ? "ok" : estado === "a_confirmar" ? "alerta" : "erro";
      const chave = m.chaveSerie(reg.serie);
      const nota = [bloqueios.has(chave) ? m.textoBloqueio(bloqueios.get(chave)) : "", sinais.get(chave) || ""].filter(Boolean).join(" · ");
      const acoes = grupo("cob__acoes",
        botao("Confirmar disponível", "secundario", () => disponibilidade(reg.serie, "disponivel", reg.rev), `Confirmar disponível — ${reg.serie}`),
        botao("Marcar manutenção", "fantasma", () => disponibilidade(reg.serie, "em_manutencao", reg.rev), `Marcar manutenção — ${reg.serie}`),
        botao("Marcar indisponível", "fantasma", () => disponibilidade(reg.serie, "indisponivel", reg.rev), `Marcar indisponível — ${reg.serie}`),
      );
      return [reg.serie, reg.cidade, selo({ texto: m.DISPONIBILIDADE[estado] || estado, status: tipo }), m.formatarData(reg.valida_ate), nota, acoes];
    });
    byId("cobertura-lista-disponiveis").replaceChildren(tabela(
      "Disponíveis", ["Série", "Cidade", "Situação", "Válida até", "Observação", "Ações"], linhas, "Nenhuma máquina registrada.",
    ));
  }

  function disponibilidade(serie, estado, rev, cidade) {
    const corpo = { serie, estado };
    if (cidade) corpo.cidade = cidade;
    if (rev !== undefined && rev !== null) corpo.rev = rev;
    return escrever("/api/cobertura/disponibilidade", corpo, "Disponibilidade registrada.");
  }

  function renderizarReservas() {
    const m = modelo();
    const demandas = casos("demandas");
    const disponibilidades = casos("disponibilidade");
    const linhas = m.reservasAbertas(dados).map(reserva => {
      const demanda = demandas[reserva.demanda_id] || {};
      const situacao = grupo("cob__selos", selo({ texto: m.ESTADO_RESERVA[reserva.estado] || reserva.estado, status: reserva.estado === "ativa" ? "ok" : "alerta" }));
      if (reserva.kit_pronto) situacao.append(selo({ texto: "Kit pronto", status: "ok" }));
      if (reserva.vencida) situacao.append(selo({ texto: "Reserva vencida", status: "alerta" }));
      const kit = el("fieldset", "cob__kit");
      kit.append(el("legend", "sr-only", `Kit da série ${reserva.serie}`));
      m.itensKit(reserva).forEach(({ item, rotulo, marcado }) => {
        const caixa = entrada("checkbox", "", { checked: marcado });
        caixa.addEventListener("change", async () => {
          // O kit inteiro espera: outro clique antes da releitura iria com o rev velho e voltaria 409.
          kit.disabled = true;
          const ok = await escrever(`/api/cobertura/reservas/${encodeURIComponent(reserva.id)}/kit`, { item, marcado: caixa.checked, rev: reserva.rev });
          if (!ok && caixa.isConnected) { caixa.checked = !caixa.checked; kit.disabled = false; }
        });
        const label = el("label", "cob__check");
        label.append(caixa, el("span", "", rotulo));
        kit.append(label);
      });
      const acoes = grupo("cob__acoes");
      const disponivel = disponibilidades[m.chaveSerie(reserva.serie)];
      for (const acao of m.acoesDaReserva(reserva, demanda, disponivel)) {
        if (acao === "renovar") acoes.append(botao("Renovar reserva", "secundario", () => escrever(`/api/cobertura/reservas/${encodeURIComponent(reserva.id)}/renovar`, { rev: reserva.rev }, "Reserva renovada."), `Renovar reserva — ${reserva.serie}`));
        if (acao === "cancelar") acoes.append(botao("Cancelar reserva", "perigo", () => cancelarReserva(reserva), `Cancelar reserva — ${reserva.serie}`));
        if (acao === "preparar") acoes.append(botao("Preparar Transporte", "primario", () => prepararTransporte(reserva, demanda), `Preparar Transporte — ${reserva.serie}`));
        if (acao === "local") acoes.append(botao("Entregar sem Transporte", "secundario", () => escrever("/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "local" }, "Entrega sem Transporte registrada; confirme o recebimento em Em movimento."), `Entregar sem Transporte — ${reserva.serie}`));
      }
      return [reserva.serie, `${demanda.cidade || "—"} · ${m.formatarData(demanda.data)}`, situacao, m.formatarData(reserva.valida_ate), kit, acoes];
    });
    byId("cobertura-lista-reservas").replaceChildren(tabela(
      "Reservas", ["Série", "Necessidade", "Situação", "Válida até", "Kit", "Ações"], linhas, "Nenhuma reserva aberta.",
    ));
  }

  async function cancelarReserva(reserva) {
    const ok = await app.confirmarAcao({
      titulo: "Cancelar reserva",
      mensagem: `A reserva da série ${reserva.serie} será cancelada e a vaga volta a ficar aberta.`,
      confirmar: "Cancelar reserva",
      cancelar: "Voltar",
    });
    if (ok) await escrever(`/api/cobertura/reservas/${encodeURIComponent(reserva.id)}/cancelar`, { rev: reserva.rev }, "Reserva cancelada.");
  }

  // Só preenche o Transporte; quem gera a planilha é sempre o operador.
  async function prepararTransporte(reserva, demanda) {
    const mov = await escrever("/api/cobertura/movimentacoes", { reserva_id: reserva.id, rev: reserva.rev, tipo: "transporte" },
      "Transporte preparado: confira os dados e gere a planilha no Transporte.");
    if (!mov) return;
    await app.prepararTransporte?.({ serial: mov.serie, cidade: mov.destino_cidade, obs: demanda?.observacao || "", movimentacao: mov });
  }

  function renderizarMovimento() {
    const m = modelo();
    const movs = m.movimentacoesAbertas(dados).sort((a, b) => String(a.criada_em).localeCompare(String(b.criada_em)));
    const linhas = movs.map(mov => {
      const estado = grupo("cob__selos", selo({ texto: m.ESTADO_MOVIMENTACAO[mov.estado] || mov.estado, status: mov.estado === "recebida_com_divergencia" ? "erro" : "info" }));
      if (mov.divergencia) {
        const tipo = (m.TIPOS_DIVERGENCIA.find(([v]) => v === mov.divergencia.tipo) || [])[1] || mov.divergencia.tipo;
        estado.append(el("span", "cob__nota", [tipo, mov.divergencia.descricao, mov.divergencia.serie_recebida].filter(Boolean).join(" · ")));
      }
      return [mov.serie, mov.destino_cidade, mov.tipo === "local" ? "Sem Transporte" : "Transporte", estado, acoesMovimentacao(mov)];
    });
    byId("cobertura-lista-movimento").replaceChildren(tabela(
      "Em movimento", ["Série", "Destino", "Tipo", "Estado", "Ações"], linhas, "Nenhuma movimentação aberta.",
    ));
  }

  function mudarEstado(mov, estado, extra, sucesso) {
    return escrever(`/api/cobertura/movimentacoes/${encodeURIComponent(mov.id)}/estado`, { estado, rev: mov.rev, ...extra }, sucesso);
  }

  function acoesMovimentacao(mov) {
    const m = modelo();
    const caixa = grupo("cob__acoes");
    const url = sufixo => `/api/cobertura/movimentacoes/${encodeURIComponent(mov.id)}/${sufixo}`;
    for (const acao of m.acoesDaMovimentacao(mov)) {
      if (acao === "vincular") {
        const area = grupo("cob__sub");
        caixa.append(botao("Vincular transferência já gerada", "secundario", () => mostrarCandidatos(mov, area), `Vincular transferência já gerada — ${mov.serie}`), area);
      }
      if (acao === "coletada") caixa.append(botao("Marcar coletada", "secundario", () => mudarEstado(mov, "coletada", {}, "Movimentação coletada."), `Marcar coletada — ${mov.serie}`));
      if (acao === "em_transito") caixa.append(botao("Marcar em trânsito", "secundario", () => mudarEstado(mov, "em_transito", {}, "Movimentação em trânsito."), `Marcar em trânsito — ${mov.serie}`));
      if (acao === "receber") caixa.append(formularioRecebimento(mov));
      if (acao === "cancelar") {
        caixa.append(botao("Cancelar movimentação", "perigo", async () => {
          const ok = await app.confirmarAcao({
            titulo: "Cancelar movimentação",
            mensagem: `A movimentação da série ${mov.serie} será cancelada e a reserva volta a ficar ativa.`
              + (mov.estado === "preparada" ? "" : " A planilha de Transporte já foi gerada e continua no histórico de transferências.")
              + (mov.estado === "coletada" ? " O Transporte já coletou a máquina: confirme que ela voltou antes de cancelar, porque a série fica livre para outra demanda." : ""),
            confirmar: "Cancelar movimentação",
            cancelar: "Voltar",
          });
          if (ok) await mudarEstado(mov, "cancelada", {}, "Movimentação cancelada; reserva devolvida.");
        }, `Cancelar movimentação — ${mov.serie}`));
      }
      if (acao === "resolver") {
        const serie = entrada("text", mov.divergencia?.serie_recebida || "", { name: "serie_recebida", maxLength: 60, autocomplete: "off" });
        caixa.append(
          campo("Série recebida", serie),
          botao("Aceitar e encerrar", "primario", () => escrever(url("resolver-divergencia"), { resolucao: "aceitar", rev: mov.rev }, "Divergência aceita."), `Aceitar e encerrar — ${mov.serie}`),
          botao("Corrigir série recebida", "secundario", () => escrever(url("resolver-divergencia"), { resolucao: "corrigir", serie_recebida: serie.value.trim(), rev: mov.rev }, "Série recebida corrigida."), `Corrigir série recebida — ${mov.serie}`),
          botao("Cancelar e reabrir vaga", "perigo", async () => {
            const ok = await app.confirmarAcao({
              titulo: "Cancelar e reabrir vaga",
              mensagem: `A movimentação da série ${mov.serie} será cancelada e a vaga volta a ficar aberta.`,
              confirmar: "Cancelar e reabrir vaga",
              cancelar: "Voltar",
            });
            if (ok) await escrever(url("resolver-divergencia"), { resolucao: "cancelar", rev: mov.rev }, "Movimentação cancelada; vaga reaberta.");
          }, `Cancelar e reabrir vaga — ${mov.serie}`),
        );
      }
    }
    return caixa;
  }

  function mostrarCandidatos(mov, area) {
    const candidatos = Array.isArray(mov.candidatos_historico) ? mov.candidatos_historico : [];
    if (!candidatos.length) {
      area.replaceChildren(el("p", "cob__nota",
        "Nenhuma planilha gerada para esta série e destino depois da preparação. Gere a planilha de novo no Transporte."));
      return;
    }
    const itens = candidatos.map(c => {
      const quando = new Date(String(c.criado_em));
      const texto = `${Number.isNaN(quando.getTime()) ? c.criado_em : quando.toLocaleString("pt-BR")} · ${c.retirada_cidade || "—"} → ${c.entrega_cidade || "—"}`;
      return grupo("cob__candidato", el("span", "", texto), botao("Vincular esta planilha", "primario",
        () => escrever(`/api/cobertura/movimentacoes/${encodeURIComponent(mov.id)}/vincular-historico`, { historico_id: c.id, rev: mov.rev }, "Transferência vinculada."),
        `Vincular planilha de ${texto}`));
    });
    area.replaceChildren(...itens);
  }

  function formularioRecebimento(mov) {
    const m = modelo();
    const form = el("div", "cob__sub cob__receber");
    const recebidoPor = entrada("text", "", { name: "recebido_por", maxLength: 120, autocomplete: "off", required: true });
    const data = entrada("date", dados.hoje || "", { name: "data", required: true });
    const comprovante = entrada("text", "", { name: "comprovante", maxLength: 500, autocomplete: "off" });
    const tipo = el("select", "ck-entrada");
    tipo.name = "tipo";
    m.TIPOS_DIVERGENCIA.forEach(([valor, rotulo]) => { const o = el("option", "", rotulo); o.value = valor; tipo.append(o); });
    const descricao = entrada("text", "", { name: "descricao", maxLength: 500, autocomplete: "off" });
    const serieRecebida = entrada("text", "", { name: "serie_recebida", maxLength: 60, autocomplete: "off" });
    const recebimento = () => ({ recebido_por: recebidoPor.value.trim(), data: data.value, comprovante: comprovante.value.trim() || null });
    form.append(
      campo("Recebido por", recebidoPor), campo("Data do recebimento", data), campo("Comprovante (opcional)", comprovante),
      botao("Confirmar recebimento", "primario", () => mudarEstado(mov, "recebida", recebimento(), "Recebimento registrado."), `Confirmar recebimento — ${mov.serie}`),
      campo("Tipo da divergência", tipo), campo("Descrição", descricao), campo("Série recebida", serieRecebida),
      botao("Registrar divergência", "secundario", () => mudarEstado(mov, "recebida_com_divergencia", {
        ...recebimento(),
        divergencia: { tipo: tipo.value, descricao: descricao.value.trim(), serie_recebida: serieRecebida.value.trim() || null },
      }, "Divergência registrada."), `Registrar divergência — ${mov.serie}`),
    );
    return form;
  }

  function renderizarDevolucoes() {
    const m = modelo();
    const linhas = m.devolucoesAbertas(dados).map(dev => {
      const url = sufixo => `/api/cobertura/devolucoes/${encodeURIComponent(dev.id)}/${sufixo}`;
      const novaData = entrada("date", dev.data_prevista || "", { name: "data_prevista" });
      const acoes = grupo("cob__acoes",
        campo("Nova data prevista", novaData),
        botao("Reprogramar devolução", "secundario", () => escrever(url("reprogramar"), { rev: dev.rev, data_prevista: novaData.value }, "Devolução reprogramada."), `Reprogramar devolução — ${dev.serie}`),
        botao("Receber devolução", "primario", () => escrever(url("receber"), { rev: dev.rev }, "Devolução recebida."), `Receber devolução — ${dev.serie}`),
        botao("Cancelar devolução", "perigo", async () => {
          const ok = await app.confirmarAcao({
            titulo: "Cancelar devolução",
            mensagem: `A devolução prevista da série ${dev.serie} será cancelada.`,
            confirmar: "Cancelar devolução",
            cancelar: "Voltar",
          });
          if (ok) await escrever(url("cancelar"), { rev: dev.rev }, "Devolução cancelada.");
        }, `Cancelar devolução — ${dev.serie}`),
      );
      const situacao = dev.situacao || dev.estado;
      return [dev.serie, m.formatarData(dev.data_prevista), dev.cidade, selo({ texto: m.SITUACAO_DEVOLUCAO[situacao] || situacao, status: situacao === "atrasada" ? "erro" : "info" }), acoes];
    });
    byId("cobertura-lista-devolucoes").replaceChildren(tabela(
      "Devoluções", ["Série", "Data prevista", "Cidade", "Situação", "Ações"], linhas, "Nenhuma devolução prevista.",
    ));
  }

  function renderizar() {
    const contagens = modelo().contagensAbas(dados);
    document.querySelectorAll("[data-cobertura-n]").forEach(n => { n.textContent = String(contagens[n.dataset.coberturaN] ?? 0); });
    renderizarAlertas();
    renderizarNecessidades();
    renderizarDisponiveis();
    renderizarReservas();
    renderizarMovimento();
    renderizarDevolucoes();
  }

  // ------------------------------------------------------------------ ligação única do DOM estático
  function ligar() {
    if (ligado) return;
    ligado = true;
    document.querySelectorAll("[data-cobertura-aba]").forEach(tab => {
      tab.addEventListener("click", () => selecionarAba(tab.dataset.coberturaAba, false));
      tab.addEventListener("keydown", event => {
        const i = ABAS.indexOf(tab.dataset.coberturaAba);
        const destino = { ArrowRight: (i + 1) % ABAS.length, ArrowLeft: (i - 1 + ABAS.length) % ABAS.length, Home: 0, End: ABAS.length - 1 }[event.key];
        if (destino === undefined) return;
        event.preventDefault();
        selecionarAba(ABAS[destino], true);
      });
    });
    const valor = (form, nome) => String(new FormData(form).get(nome) || "").trim();
    byId("cobertura-form-necessidade")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const ok = await escrever("/api/cobertura/demandas", {
        data: valor(form, "data"), cidade: valor(form, "cidade"), quantidade: Number(valor(form, "quantidade")) || 1,
        perfil: valor(form, "perfil"), monitor: Boolean(form.elements.monitor?.checked), observacao: valor(form, "observacao"),
      }, "Necessidade registrada.");
      if (ok) form.reset();
    });
    byId("cobertura-form-disponibilidade")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const serie = valor(form, "serie");
      const atual = casos("disponibilidade")[modelo().chaveSerie(serie)];
      const ok = await disponibilidade(serie, event.submitter?.value || "disponivel", atual?.rev, valor(form, "cidade"));
      if (ok) form.reset();
    });
    byId("cobertura-form-devolucao")?.addEventListener("submit", async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const corpo = { serie: valor(form, "serie"), data_prevista: valor(form, "data_prevista"), observacao: valor(form, "observacao") };
      if (valor(form, "cidade")) corpo.cidade = valor(form, "cidade");
      const ok = await escrever("/api/cobertura/devolucoes", corpo, "Devolução registrada.");
      if (ok) form.reset();
    });
    document.addEventListener("simpress:cobertura-atualizada", () => {
      if (carregouAlgumaVez) void carregarCobertura();
    });
  }

  return { carregarCobertura };
});
