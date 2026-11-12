/** Chamados (F5) → conflitos de edição do Dashboard: escolha por célula entre o SharePoint e o site, e reenvio. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeConflitos = factory;
})(typeof window !== "undefined" ? window : globalThis, (function () {
  "use strict";

  const URL_CONFLITOS = "/api/sebrae/dashboard/conflitos";
  const URL_ESTADO_AUTOMACAO = "/api/automacao/estado";
  const INTERVALO_MS = 3000;
  const TENTATIVAS_MAX = 300; // ~15 min: a rotina enviar espera o SharePoint
  const LIMITE_VALOR = 300;
  const OPCOES = Object.freeze([
    { valor: "sharepoint", rotulo: "Manter o do SharePoint" },
    { valor: "site", rotulo: "Usar o do site" },
  ]);
  const AVISO_SO_SHAREPOINT = "Sem número UTIC único para achar a linha no SharePoint: só dá para manter o valor do SharePoint.";

  /** ``aceita_site`` false: the target row is uncertain, so the server refuses ``site`` (a conflict without the key accepts both). */
  const aceitaSite = conflito => conflito?.aceita_site !== false;

  /** A cell value as shown in the sentence: quoted, cut when long, "(vazio)" when blank. */
  function valorVisivel(valor) {
    const texto = String(valor ?? "");
    if (!texto.trim()) return "(vazio)";
    return `"${texto.length > LIMITE_VALOR ? `${texto.slice(0, LIMITE_VALOR)}…` : texto}"`;
  }

  function textoDoConflito(conflito) {
    const chamado = conflito?.chamado || "—";
    if (conflito?.tipo === "linha_apagada") return `Chamado ${chamado}: linha apagada no SharePoint, mas editada no site.`;
    return `Chamado ${chamado}, coluna ${conflito?.coluna || "—"}: SharePoint diz ${valorVisivel(conflito?.sharepoint)}, site quer ${valorVisivel(conflito?.site)}.`;
  }

  /** Only the ids of the current list with a valid choice go in the POST (never ``site`` where it is not accepted). */
  function escolhasParaEnviar(conflitos, escolhas) {
    const corpo = {};
    (Array.isArray(conflitos) ? conflitos : []).forEach(conflito => {
      const valor = escolhas?.[conflito?.id];
      if (OPCOES.some(opcao => opcao.valor === valor) && (valor !== "site" || aceitaSite(conflito))) corpo[conflito.id] = valor;
    });
    return corpo;
  }

  function createSebraeConflitos(context) {
    const { app, dom } = context;
    const estado = { ligado: false, consulta: 0, conflitos: [], escolhas: {}, versao: "", ocupado: false, acompanhamento: 0, timer: 0 };

    const el = id => document.getElementById(id);

    function definirStatus(texto) {
      const node = el("sebrae-conflitos-status");
      if (node) node.textContent = texto;
    }

    function atualizarBotao() {
      const botao = el("btn-sebrae-conflitos-enviar");
      if (!botao) return;
      const faltam = estado.conflitos.length - Object.keys(escolhasParaEnviar(estado.conflitos, estado.escolhas)).length;
      botao.disabled = estado.ocupado || !estado.conflitos.length || faltam > 0;
      if (!estado.ocupado) definirStatus(faltam > 0 ? `Escolha uma opção em cada célula (faltam ${faltam}).` : "");
    }

    function linhaDoConflito(conflito, indice) {
      const grupo = document.createElement("fieldset");
      grupo.className = "sebrae-conflito";
      grupo.setAttribute("role", "group");
      grupo.dataset.conflitoId = conflito.id;
      grupo.append(dom.createTextElement("legend", "sebrae-conflito__texto", textoDoConflito(conflito)));
      const opcoes = document.createElement("div");
      opcoes.className = "sebrae-conflito__opcoes";
      OPCOES.filter(opcao => opcao.valor !== "site" || aceitaSite(conflito)).forEach(opcao => {
        const rotulo = document.createElement("label");
        rotulo.className = "sebrae-conflito__opcao";
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `sebrae-conflito-${indice}`;
        radio.id = `sebrae-conflito-${indice}-${opcao.valor}`;
        radio.value = opcao.valor;
        radio.checked = estado.escolhas[conflito.id] === opcao.valor;
        radio.addEventListener("change", () => {
          estado.escolhas[conflito.id] = opcao.valor;
          atualizarBotao();
        });
        rotulo.append(radio, document.createTextNode(` ${opcao.rotulo}`));
        opcoes.appendChild(rotulo);
      });
      grupo.appendChild(opcoes);
      if (!aceitaSite(conflito)) grupo.appendChild(dom.createTextElement("p", "sebrae-conflito__aviso", AVISO_SO_SHAREPOINT));
      return grupo;
    }

    function renderizar() {
      const host = el("sebrae-conflitos");
      if (!host) return;
      host.hidden = estado.conflitos.length === 0;
      el("sebrae-conflitos-lista")?.replaceChildren(...estado.conflitos.map(linhaDoConflito));
      atualizarBotao();
    }

    function aplicar(corpo) {
      const conflitos = (Array.isArray(corpo?.conflitos) ? corpo.conflitos : []).filter(item => item && typeof item.id === "string");
      const ids = new Set(conflitos.map(item => item.id));
      const doServidor = corpo?.escolhas && typeof corpo.escolhas === "object" ? corpo.escolhas : {};
      const locais = Object.fromEntries(Object.entries(estado.escolhas).filter(([id]) => ids.has(id)));
      estado.conflitos = conflitos;
      estado.versao = typeof corpo?.versao_importacao === "string" ? corpo.versao_importacao : "";
      estado.escolhas = { ...doServidor, ...locais }; // a escolha ainda não salva de quem está na tela vale mais que a gravada
      renderizar();
    }

    async function carregarConflitosSebrae() {
      if (!el("sebrae-conflitos")) return;
      if (!estado.ligado) {
        estado.ligado = true;
        el("btn-sebrae-conflitos-enviar")?.addEventListener("click", salvarEReenviar);
      }
      const consulta = ++estado.consulta;
      try {
        const corpo = await app.apiFetch(URL_CONFLITOS, { errorMessage: "Não foi possível consultar os conflitos do Dashboard." });
        if (consulta === estado.consulta) aplicar(corpo);
      } catch (_erro) {
        // Sem a lista, a tela fica como estava; o aviso do SharePoint e o painel de Automação seguem valendo.
      }
    }

    function parar() {
      estado.acompanhamento += 1;
      clearTimeout(estado.timer);
    }

    /** Polls the automation state until the routine ends, then reloads the list: it empties when the send went through. */
    function acompanharEnvio() {
      parar();
      const minha = estado.acompanhamento;
      let tentativas = 0;
      const passo = async () => {
        if (minha !== estado.acompanhamento) return;
        let dados = null;
        try {
          dados = await app.apiFetch(URL_ESTADO_AUTOMACAO, { errorMessage: "Não foi possível consultar a automação." });
        } catch (_erro) {
          dados = null; // falha de rede: tenta de novo até o limite
        }
        if (minha !== estado.acompanhamento) return;
        tentativas += 1;
        if ((dados && dados.estado !== "em_andamento") || tentativas >= TENTATIVAS_MAX) {
          await terminarEnvio(dados?.ultima);
          return;
        }
        estado.timer = setTimeout(passo, INTERVALO_MS);
      };
      estado.timer = setTimeout(passo, INTERVALO_MS);
    }

    async function terminarEnvio(ultima) {
      estado.ocupado = false;
      await carregarConflitosSebrae();
      app.carregarNovosSebrae?.(); // atualiza o aviso do SharePoint e a lista de chamados
      if (estado.conflitos.length) {
        definirStatus("O envio parou de novo e ainda há conflitos. Confira a lista e escolha outra vez.");
        return;
      }
      if (ultima?.status === "concluido") app.showToast("Conflitos resolvidos e Dashboard enviado ao SharePoint.", "success");
      else app.showToast("O envio terminou sem concluir. Veja o resultado na Automação.", "error");
    }

    async function salvarEReenviar() {
      const escolhas = escolhasParaEnviar(estado.conflitos, estado.escolhas);
      if (estado.ocupado || !Object.keys(escolhas).length) return;
      estado.ocupado = true;
      atualizarBotao();
      definirStatus("Salvando as escolhas…");
      try {
        const corpo = await app.apiFetch(URL_CONFLITOS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ escolhas, enviar: true, versao_importacao: estado.versao }),
          errorMessage: "Não foi possível salvar as escolhas.",
        });
        if (corpo?.enviar?.iniciado) {
          definirStatus("Escolhas salvas. Reenviando ao SharePoint…");
          app.atualizarEstadoAutomacao?.(); // mostra a rotina enviar e o Cancelar execução sem esperar a próxima consulta
          acompanharEnvio();
          return;
        }
        estado.ocupado = false;
        atualizarBotao();
        definirStatus(`Escolhas salvas, mas o envio não começou: ${corpo?.enviar?.motivo || "motivo não informado"}`);
      } catch (error) {
        estado.ocupado = false;
        atualizarBotao();
        if (error.status === 422) await carregarConflitosSebrae(); // a lista mudou no servidor
        definirStatus(error.message); // depois do recarregamento, que limpa o status
        app.showToast(error.message, "error");
      }
    }

    return { carregarConflitosSebrae };
  }

  createSebraeConflitos.puro = { valorVisivel, textoDoConflito, escolhasParaEnviar };
  return createSebraeConflitos;
})());
