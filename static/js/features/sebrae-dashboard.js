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
  const STATUS_CHAMADO = Object.freeze(["EM ABERTO", "FINALIZADO"]);
  const TIPOS_CHAMADO = Object.freeze(["INCIDENTE", "SOLICITAÇÃO"]);
  const OBRIGATORIOS = Object.freeze(["A", "D", "J"]);
  const AVISO_CRUZAMENTO = Object.freeze({
    ausente: "Série, modelo e cidade vazios: nenhum equipamento encontrado para este solicitante.",
    ambiguo: "Série, modelo e cidade vazios: mais de um equipamento encontrado para este solicitante.",
  });

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

  function createSebraeDashboard(context) {
    const { app, dom } = context;
    const estado = { formulario: [], valores: {}, consulta: 0, listas: {}, abertos: [], edicoes: {}, atualizavel: false, importadoEm: "" };

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
      if (!antigo && !(letra in valores) && controle.value) guardados[numero] = { ...valores, [letra]: controle.value };
      controle.dataset.sebraeNumero = numero;
      controle.dataset.sebraeCampo = letra;
      controle.dataset.sebraeAlvo = alvo;
      controle.addEventListener("input", aoEditar);
      controle.addEventListener("change", aoEditar);
      return controle;
    }

    const PADROES_MANUAIS = Object.freeze({ S: "DISPONIBILIDADE" }); // Tipo SLA habitual; o usuário pode trocar ou apagar

    const ROTULOS_MANUAIS = Object.freeze({
      A: "Responsável (A) *", B: "Categoria (B)", D: "Status (D) *", J: "Tipo do chamado (J) *",
      R: "Encerramento (R)", S: "Tipo SLA (S)",
    });

    function blocoAntigo(item) {
      const artigo = document.createElement("article");
      artigo.className = "sebrae-chamado";
      artigo.dataset.numero = item.numero;
      const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
      titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", item.titulo || "Sem título"));
      const manuais = document.createElement("div");
      manuais.className = "sebrae-chamado__manuais";
      ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campo(ROTULOS_MANUAIS[letra], controleManual(item.numero, letra, "antigo"))));
      artigo.append(titulo, manuais);
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
      const aviso = AVISO_CRUZAMENTO[item.cruzamento?.status];
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

    function aoEditar(event) {
      const { sebraeNumero, sebraeCampo, sebraeAlvo } = event.currentTarget.dataset;
      const guardados = valoresDe(sebraeAlvo);
      guardados[sebraeNumero] = { ...(guardados[sebraeNumero] || {}), [sebraeCampo]: event.currentTarget.value };
      atualizarExportacao();
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
      botao.disabled = !estado.atualizavel || (estado.formulario.length === 0 && alteracoes === 0);
      definirTexto("sebrae-antigos-resumo", estado.abertos.length
        ? `${estado.abertos.length} chamado(s) antigo(s) em aberto ou sem status; ${alteracoes} com alteração.`
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
      estado.edicoes = {};
      el("sebrae-antigos-lista")?.replaceChildren(...estado.abertos.map(blocoAntigo));
      const painelAntigos = el("sebrae-antigos");
      if (painelAntigos) painelAntigos.hidden = !importado;
      definirTexto("sebrae-dashboard-status", importado
        ? `Dashboard importado: ${importado.arquivo || "sem nome"} (${importado.total} chamados já lançados).${importado.atualizavel ? "" : " Não dá para atualizar a cópia: importe de novo."}`
        : "Nenhum Dashboard importado.");
      const novos = dados.novos;
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
      if (!estado.atualizavel || (!chamados.length && !edicoes.length)) return;
      const botao = el("btn-sebrae-atualizar");
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        const dados = await app.apiFetch("/api/sebrae/dashboard/atualizar", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chamados, edicoes }),
          errorMessage: "Não foi possível atualizar o Dashboard.",
        });
        baixarArquivo(dados.arquivo, dados.conteudo_base64);
        const novos = dados.linhas.filter(linha => linha.tipo === "novo").length;
        const quando = formatarDataHora(dados.base?.importado_em);
        definirTexto("sebrae-atualizar-status",
          `Baixado "${dados.arquivo}": ${novos} novo(s) e ${dados.linhas.length - novos} alterado(s). `
          + `Baseado no Dashboard importado${quando ? ` em ${quando}` : ""}. Para não perder edições de outras pessoas, importe a versão atual antes.`);
        app.showToast("Dashboard atualizado. O original não foi alterado.", "success");
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

    return { carregarNovosSebrae, importarDashboardSebrae, exportarChamadosSebrae, atualizarDashboardSebrae, copiarBlocoSebrae };
  }

  createSebraeDashboard.puro = { formatarEncerramento, encerramentoParaCampo, chamadoPronto, payloadExportacao, payloadAtualizacao, payloadEdicoes };
  return createSebraeDashboard;
})());
