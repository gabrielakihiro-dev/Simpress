/** Automação → "Chamados novos do SoftExpert": importa o Dashboard, lista os novos e exporta as linhas para colar. */
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

  function payloadExportacao(formulario, valores) {
    return formulario.filter(item => chamadoPronto(valores[item.numero])).map(item => {
      const v = valores[item.numero];
      return { numero: item.numero, A: v.A || "", B: v.B || "", D: v.D || "", J: v.J || "", R: formatarEncerramento(v.R), S: v.S || "" };
    });
  }

  function createSebraeDashboard(context) {
    const { app, dom } = context;
    const estado = { formulario: [], valores: {}, consulta: 0 };

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

    function controleManual(numero, letra) {
      const valores = estado.valores[numero] || {};
      let controle;
      if (letra === "D" || letra === "J") {
        controle = document.createElement("select");
        const opcoes = letra === "D" ? STATUS_CHAMADO : TIPOS_CHAMADO;
        [["", "Escolher"], ...opcoes.map(o => [o, o])].forEach(([valor, texto]) => {
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
      controle.value = valores[letra] ?? PADROES_MANUAIS[letra] ?? "";
      if (!(letra in valores) && controle.value) estado.valores[numero] = { ...valores, [letra]: controle.value };
      controle.dataset.sebraeNumero = numero;
      controle.dataset.sebraeCampo = letra;
      controle.addEventListener("input", aoEditar);
      controle.addEventListener("change", aoEditar);
      return controle;
    }

    const PADROES_MANUAIS = Object.freeze({ S: "DISPONIBILIDADE" }); // Tipo SLA habitual; o usuário pode trocar ou apagar

    const ROTULOS_MANUAIS = Object.freeze({
      A: "Responsável (A) *", B: "Categoria (B)", D: "Status (D) *", J: "Tipo do chamado (J) *",
      R: "Encerramento (R)", S: "Tipo SLA (S)",
    });

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
      const { sebraeNumero, sebraeCampo } = event.currentTarget.dataset;
      estado.valores[sebraeNumero] = { ...(estado.valores[sebraeNumero] || {}), [sebraeCampo]: event.currentTarget.value };
      atualizarExportacao();
    }

    function atualizarExportacao() {
      const prontos = payloadExportacao(estado.formulario, estado.valores).length;
      const botao = el("btn-sebrae-exportar");
      if (botao) botao.disabled = prontos === 0;
      const total = estado.formulario.length;
      definirTexto("sebrae-exportacao-status", total ? `${prontos} de ${total} chamado(s) com Responsável, Status e Tipo preenchidos.` : "");
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
      definirTexto("sebrae-dashboard-status", importado
        ? `Dashboard importado: ${importado.arquivo || "sem nome"} (${importado.total} chamados já lançados).`
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

    return { carregarNovosSebrae, importarDashboardSebrae, exportarChamadosSebrae, copiarBlocoSebrae };
  }

  createSebraeDashboard.puro = { formatarEncerramento, chamadoPronto, payloadExportacao };
  return createSebraeDashboard;
})());
