/**
 * Resumo (F3), sub-aba Backups: backups por regional prioritária, só com o campo `backups_regionais` do /api/painel.
 * Os dados chegam pelo evento `simpress:painel-atualizado`; este módulo não consulta o painel. O apelido pode ser nome
 * de pessoa: aparece só na tela local, nunca em toast, console ou aria-live.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).backupsRegionais = factory;
})(typeof window !== "undefined" ? window : globalThis, function createBackupsRegionais(context) {
  "use strict";
  const { app, dom, historyFormat } = context;
  const renderer = context.comparisonResultRenderer(context);
  const escapar = dom.escapeHtml;

  const STATUS = {
    ok: { rotulo: "Backup disponível", tom: "ok" },
    conferir: { rotulo: "Conferir possível backup", tom: "alerta" },
    sem_backup: { rotulo: "Sem backup disponível", tom: "erro" },
    dados_insuficientes: { rotulo: "Dados insuficientes", tom: "info" },
  };
  const MOTIVOS = {
    // Candidatos (por que ainda não contam como backup).
    fonte_endpoint_indisponivel: "Endpoint indisponível: a verificação não foi possível",
    ausente_no_endpoint: "Não aparece no Endpoint",
    sem_verificacao_7_dias: "Sem verificação nos últimos 7 dias",
    encontrado_sem_usuario: "Verificada nos últimos 7 dias e sem usuário, mas o apelido não tem a marca de backup",
    // Conferência (o cadastro e o apelido não batem).
    serie_duplicada: "Série duplicada no cadastro ou no Endpoint",
    leitura_ambigua: "O apelido indica mais de uma cidade",
    cidade_divergente: "A cidade do apelido difere da cidade do cadastro",
    cidade_ausente: "Cadastro sem cidade; o apelido indica esta regional",
    // Excluídos (fora do cálculo).
    usuario_vigente: "Com usuário vigente",
    "bloqueio:reserva_ativa": "Reserva ativa",
    "bloqueio:reserva_vencida_em_revisao": "Reserva vencida em revisão",
    "bloqueio:reserva_em_espera": "Reserva em espera",
    "bloqueio:movimentacao_aberta": "Movimentação aberta",
    "bloqueio:devolucao_pendente": "Devolução pendente",
    "bloqueio:manutencao": "Em manutenção",
    "bloqueio:em_manutencao": "Em manutenção",
    "bloqueio:indisponivel": "Marcada como indisponível",
  };
  const MOTIVOS_CONFIRMACAO = {
    expirada: "a confirmação anterior expirou",
    cidade_mudou: "a confirmação anterior era de outra cidade",
    usuario_vigente: "a confirmação anterior perdeu o efeito: usuário vigente",
    bloqueio: "a confirmação anterior perdeu o efeito: máquina bloqueada",
  };
  const ORIGENS = { marca: "Marca no apelido", confirmacao: "Confirmado manualmente" };
  const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;

  const lista = valor => (Array.isArray(valor) ? valor.filter(item => item && typeof item === "object") : []);
  const texto = valor => (valor === null || valor === undefined ? "" : String(valor));
  const inteiro = valor => (Number.isFinite(Number(valor)) ? Math.trunc(Number(valor)) : 0);
  // Código desconhecido aparece cru (escapado), nunca some.
  const traduzir = (mapa, codigo) => (Object.hasOwn(mapa, codigo) ? mapa[codigo] : texto(codigo));
  const plural = (n, singular, pluralTexto) => (n === 1 ? singular : pluralTexto);
  const data = valor => (historyFormat?.formatarHorarioHistorico ? texto(historyFormat.formatarHorarioHistorico(valor)) : texto(valor));

  function notaConfirmacaoAnterior(confirmacao) {
    if (!confirmacao || confirmacao.estado !== "invalidada") return "";
    return `<span class="ck-backups__nota">Antes: ${escapar(traduzir(MOTIVOS_CONFIRMACAO, confirmacao.motivo))}</span>`;
  }

  function botao(acao, serie, cidade) {
    const confirmar = acao === "confirmar";
    const rotulo = confirmar ? "Confirmar disponível por 7 dias" : "Desfazer confirmação";
    return `<button type="button" class="ck-btn ck-btn--sm ${confirmar ? "ck-btn--secundario" : "ck-btn--fantasma"}" data-backup-acao="${acao}" data-serie="${escapar(serie)}" data-cidade="${escapar(cidade)}" aria-label="${rotulo}: série ${escapar(serie)}, ${escapar(cidade)}">${rotulo}</button>`;
  }

  function identificacao(item) {
    const apelido = texto(item.apelido);
    return `<code class="ck-backups__serie">${escapar(texto(item.serie))}</code>${apelido ? ` <span class="ck-backups__apelido">${escapar(apelido)}</span>` : ""}`;
  }

  const itens = (linhas, vazio = "Nenhum") => (linhas.length
    ? `<ul class="ck-backups__lista">${linhas.map(linha => `<li class="ck-backups__item">${linha}</li>`).join("")}</ul>`
    : `<span class="ck-backups__vazio">${vazio}</span>`);

  function itemBackup(backup, cidade) {
    const detalhes = [
      traduzir(ORIGENS, backup.origem),
      backup.ultima_verificacao ? `verificado em ${data(backup.ultima_verificacao)}` : "",
      backup.confirmado_ate ? `confirmado até ${data(backup.confirmado_ate)}` : "",
    ].filter(Boolean).map(escapar).join(" · ");
    const desfazer = backup.origem === "confirmacao" ? botao("desfazer", texto(backup.serie), cidade) : "";
    return `${identificacao(backup)}<span class="ck-backups__detalhe">${detalhes}</span>${desfazer}`;
  }

  function itemCandidato(candidato, cidade) {
    const dias = candidato.dias_sem_verificacao === null || candidato.dias_sem_verificacao === undefined ? null : inteiro(candidato.dias_sem_verificacao);
    const detalhes = [
      traduzir(MOTIVOS, candidato.motivo),
      dias === null ? "" : `${dias} ${plural(dias, "dia", "dias")} sem verificação`,
      candidato.ultima_verificacao ? `última verificação em ${data(candidato.ultima_verificacao)}` : "",
    ].filter(Boolean).map(escapar).join(" · ");
    return `${identificacao(candidato)}<span class="ck-backups__detalhe">${detalhes}</span>${notaConfirmacaoAnterior(candidato.confirmacao)}${botao("confirmar", texto(candidato.serie), cidade)}`;
  }

  const itemConferencia = item => `${identificacao(item)}<span class="ck-backups__detalhe">${escapar(traduzir(MOTIVOS, item.motivo))}</span>`;
  const itemExcluido = item => `${identificacao(item)}<span class="ck-backups__detalhe">${escapar(traduzir(MOTIVOS, item.motivo))}</span>${notaConfirmacaoAnterior(item.confirmacao)}`;

  function celulaExcluidos(excluidos, cidade, abertos) {
    if (!excluidos.length) return itens([]);
    const n = excluidos.length;
    return `<details class="ck-backups__excluidos" data-cidade="${escapar(cidade)}"${abertos.has(cidade) ? " open" : ""}><summary>${n} ${plural(n, "excluído", "excluídos")}</summary>${itens(excluidos.map(itemExcluido))}</details>`;
  }

  function linhaRegional(regional, abertos) {
    const cidade = texto(regional.cidade);
    const status = Object.hasOwn(STATUS, regional.status) ? STATUS[regional.status] : { rotulo: texto(regional.status), tom: "info" };
    const excedente = inteiro(regional.excedente);
    return `<tr data-status="${escapar(texto(regional.status))}">`
      + `<td class="ck-td--largo ck-td--sem-rotulo"><strong class="ck-backups__cidade">${escapar(cidade)}</strong></td>`
      + `<td class="ck-td--largo" data-label="Situação"><span class="ck-backups__contagem">${inteiro(regional.contados)}/${inteiro(regional.minimo)}</span> <span class="ck-badge" data-status="${status.tom}">${escapar(status.rotulo)}</span>${excedente > 0 ? ` <span class="ck-backups__nota">+${excedente} além do mínimo</span>` : ""}</td>`
      + `<td class="ck-td--largo" data-label="Backups">${itens(lista(regional.backups).map(backup => itemBackup(backup, cidade)))}</td>`
      + `<td class="ck-td--largo" data-label="Candidatos">${itens(lista(regional.candidatos).map(candidato => itemCandidato(candidato, cidade)))}</td>`
      + `<td class="ck-td--largo" data-label="Conferência">${itens(lista(regional.conferencia).map(itemConferencia))}</td>`
      + `<td class="ck-td--largo" data-label="Excluídos">${celulaExcluidos(lista(regional.excluidos), cidade, abertos)}</td>`
      + "</tr>";
  }

  function secao(titulo, corpo) {
    return `<section class="ck-cartao ck-backups__secao"><div class="ck-cartao__cab"><h3 class="ck-cartao__titulo">${titulo}</h3></div><div class="ck-cartao__corpo">${corpo}</div></section>`;
  }

  function limitacoes(dados) {
    const textos = (Array.isArray(dados.limitacoes) ? dados.limitacoes : []).map(texto).filter(Boolean);
    if (!textos.length) return "";
    return `<section class="ck-backups__limites"><h3 class="ck-backups__limites-titulo">Limitações dos dados</h3><ul>${textos.map(item => `<li>${escapar(item)}</li>`).join("")}</ul></section>`;
  }

  const tabela = (regionais, abertos) => `<table class="ck-tabela ck-tabela--cards"><caption class="ui-sr-only">Backups por regional prioritária</caption>`
    + "<thead><tr><th scope=\"col\">Regional</th><th scope=\"col\">Situação</th><th scope=\"col\">Backups</th><th scope=\"col\">Candidatos</th><th scope=\"col\">Conferência</th><th scope=\"col\">Excluídos</th></tr></thead>"
    + `<tbody>${regionais.map(regional => linhaRegional(regional, abertos)).join("")}</tbody></table>`;

  function secaoSobras(sobras) {
    if (!sobras.length) return "";
    const linhas = sobras.map(sobra => {
      const n = inteiro(sobra.quantidade);
      const series = (Array.isArray(sobra.series) ? sobra.series : []).map(serie => `<code class="ck-backups__serie">${escapar(texto(serie))}</code>`).join(" ");
      const motivo = sobra.prioritaria ? "além do mínimo" : "em regional fora das prioritárias";
      return `<strong class="ck-backups__cidade">${escapar(texto(sobra.cidade))}</strong> <span class="ck-backups__detalhe">${n} ${plural(n, "backup", "backups")} ${motivo}</span> ${series}`;
    });
    return secao("Sobras", itens(linhas));
  }

  function secaoOutrasCandidatos(outras) {
    const grupos = outras.filter(grupo => lista(grupo.candidatos).length);
    if (!grupos.length) return "";
    const blocos = grupos.map(grupo => {
      const cidade = texto(grupo.cidade);
      return `<div class="ck-backups__grupo"><strong class="ck-backups__cidade">${escapar(cidade)}</strong>${itens(lista(grupo.candidatos).map(candidato => itemCandidato(candidato, cidade)))}</div>`;
    });
    return secao("Candidatos nas demais regionais", blocos.join(""));
  }

  /** HTML do painel Backups. `dados`: undefined (sem painel ainda), null (serviço desligado) ou o `backups_regionais`. */
  function renderizarBackupsRegionais(dados, { abertos = new Set() } = {}) {
    const estado = mensagem => `<p class="ck-backups__estado">${mensagem}</p>`;
    if (dados === undefined) return estado("Aguardando os dados do painel local…");
    if (dados === null || typeof dados !== "object") return estado("O cálculo de backups regionais está desligado neste servidor.");
    if (dados.indisponivel) return estado("Não foi possível calcular os backups regionais agora.") + limitacoes(dados);
    const regionais = lista(dados.prioritarias);
    const minimo = inteiro(dados.minimo);
    const topo = `<p class="ck-backups__meta">${dados.gerado_em ? `Atualizado em ${escapar(data(dados.gerado_em))}. ` : ""}Mínimo: ${minimo} ${plural(minimo, "backup", "backups")} por regional prioritária.</p>`;
    return topo + limitacoes(dados)
      + (regionais.length ? tabela(regionais, abertos) : estado("Os dados recebidos não trazem regionais prioritárias."))
      + secaoSobras(lista(dados.sobras)) + secaoOutrasCandidatos(lista(dados.outras_candidatos));
  }

  // ---- DOM ----
  let dados;
  let htmlAtual = "";
  let emAndamento = false;

  const painel = () => document.getElementById("resumo-painel-backups");

  function pendencias() {
    if (!dados || typeof dados !== "object" || dados.indisponivel) return null;
    const contar = valor => (Array.isArray(valor) ? valor.length : 0);
    return contar(dados.pendencias?.sem_backup) + contar(dados.pendencias?.conferir);
  }

  function atualizarAba() {
    const total = pendencias();
    const selo = document.getElementById("resumo-backups-contagem");
    if (selo) selo.textContent = total === null ? "—" : total.toLocaleString("pt-BR");
    const aba = document.getElementById("resumo-aba-backups");
    const rotulo = renderer.rotuloContagemAba("backups", total);
    if (aba && rotulo) aba.setAttribute("aria-label", rotulo);
  }

  // O painel é redesenhado a cada atualização do painel: guarda o foco e as listas abertas.
  function renderizar() {
    const alvo = painel();
    if (!alvo) return;
    atualizarAba();
    const abertos = new Set([...(alvo.querySelectorAll?.("details[open][data-cidade]") || [])].map(item => item.dataset.cidade));
    const html = renderizarBackupsRegionais(dados, { abertos });
    if (html === htmlAtual) return;
    const foco = document.activeElement;
    const marca = foco && alvo.contains?.(foco) ? { ...foco.dataset, lista: foco.closest?.("details[data-cidade]")?.dataset.cidade } : null;
    alvo.innerHTML = html;
    htmlAtual = html;
    if (!marca) return;
    // Foco volta ao mesmo botão; se a ação o trocou (Confirmar vira Desfazer), ao botão da mesma série e cidade;
    // depois à lista de excluídos que estava em foco; por último à aba.
    const botoes = [...(alvo.querySelectorAll?.("[data-backup-acao]") || [])];
    const mesmaSerie = item => item.dataset.serie === marca.serie && item.dataset.cidade === marca.cidade;
    const mesmo = botoes.find(item => item.dataset.backupAcao === marca.backupAcao && mesmaSerie(item))
      || (marca.serie ? botoes.find(mesmaSerie) : null)
      || (marca.lista ? [...(alvo.querySelectorAll?.("details[data-cidade] > summary") || [])].find(item => item.parentElement?.dataset.cidade === marca.lista) : null);
    (mesmo || document.getElementById("resumo-aba-backups"))?.focus?.();
  }

  function mensagemDoErro(erro, padrao) {
    const mensagem = erro?.detail?.mensagem;
    return typeof mensagem === "string" && mensagem.trim() ? mensagem.trim() : erro?.message || padrao;
  }

  function liberar(botao) {
    botao.disabled = false;
    botao.removeAttribute("aria-busy");
  }

  async function aoClicar(evento) {
    const botaoAcao = evento.target?.closest?.("[data-backup-acao]");
    if (!botaoAcao || emAndamento) return;
    const { backupAcao: acao, serie, cidade } = botaoAcao.dataset;
    if ((acao !== "confirmar" && acao !== "desfazer") || !serie || !cidade) return;
    emAndamento = true;
    botaoAcao.disabled = true;
    botaoAcao.setAttribute("aria-busy", "true");
    try {
      const resposta = await app.apiFetch(`/api/backups-regionais/${acao}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serie, cidade }),
        errorMessage: acao === "confirmar" ? "Não foi possível confirmar o backup." : "Não foi possível desfazer a confirmação.",
      });
      if (acao === "desfazer" && resposta?.removido === false) app.showToast(`Não havia confirmação para desfazer: série ${serie}, ${cidade}.`, "warning");
      else app.showToast(acao === "confirmar" ? `Backup confirmado por 7 dias: série ${serie}, ${cidade}.` : `Confirmação desfeita: série ${serie}, ${cidade}.`, "success");
      document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));
      // O redesenho troca o botão; se a leitura do painel falhar, ele volta a funcionar sozinho em 10 s.
      const reabrir = setTimeout(() => liberar(botaoAcao), 10000);
      reabrir?.unref?.();
    } catch (erro) {
      app.showToast(mensagemDoErro(erro, "Não foi possível concluir a ação."), "error");
      liberar(botaoAcao);
    } finally {
      emAndamento = false;
    }
  }

  document.addEventListener("simpress:painel-atualizado", evento => {
    const painelLido = evento.detail;
    if (!painelLido || typeof painelLido !== "object") return;
    dados = "backups_regionais" in painelLido ? painelLido.backups_regionais : null;
    renderizar();
  });
  painel()?.addEventListener("click", aoClicar);
  renderizar();
  // Cartão do sino e sub-aba ficam em dia sem ação do usuário: pede o painel a cada 5 min, só com a aba visível
  // (importações e abrir o sino já pedem atualização por conta própria).
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    window.setInterval(() => {
      if (!document.hidden) document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));
    }, INTERVALO_ATUALIZACAO_MS);
  }

  return { renderizarBackupsRegionais };
});
