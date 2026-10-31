/** Automação → resumo das últimas entradas do histórico do Dashboard Sebrae (mini-lista no cartão). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeHistorico = factory;
})(typeof window !== "undefined" ? window : globalThis, (function () {
  "use strict";

  const ENTRADAS_NO_CARTAO = 3;
  const ROTULOS_TIPO = Object.freeze({ importacao: "Importação", busca: "Busca" });

  function plural(n, singular, pluralTexto) {
    return `${n} ${n === 1 ? singular : pluralTexto}`;
  }

  function rotuloTipo(tipo) {
    return ROTULOS_TIPO[tipo] || (tipo ? tipo[0].toUpperCase() + tipo.slice(1) : "");
  }

  /** One line with the counts of an entry, the text shown in the card. */
  function resumoEntrada(entrada) {
    if (entrada?.tipo === "busca") {
      const partes = [];
      if (entrada.n_lidos) partes.push(plural(entrada.n_lidos, "lido", "lidos"));
      if (entrada.ignorados) partes.push(`${entrada.ignorados} já no Dashboard`);
      if (entrada.n_pendentes) partes.push(plural(entrada.n_pendentes, "pendente", "pendentes"));
      if (entrada.n_erros) partes.push(`${entrada.n_erros} com erro`);
      return partes.join(", ") || "Nenhum chamado novo";
    }
    if (entrada?.inicial) return `Primeira importação: ${plural(entrada.total || 0, "chamado", "chamados")}`;
    const partes = [];
    if (entrada?.n_adicionados) partes.push(plural(entrada.n_adicionados, "adicionado", "adicionados"));
    if (entrada?.n_removidos) partes.push(plural(entrada.n_removidos, "removido", "removidos"));
    if (entrada?.n_alterados) partes.push(`${entrada.n_alterados} com status alterado`);
    return partes.join(", ") || "Sem mudanças";
  }

  function textoRepeticoes(entrada) {
    const vezes = entrada?.tipo === "importacao" ? Number(entrada.repeticoes) || 0 : 0;
    return vezes > 0 ? `Reimportado ${plural(vezes, "vez", "vezes")}` : "";
  }

  function ultimasEntradas(itens) {
    return (Array.isArray(itens) ? itens : []).slice(0, ENTRADAS_NO_CARTAO);
  }

  function createSebraeHistorico(context) {
    const { app, dom } = context;
    const estado = { resumo: 0 };

    const el = id => document.getElementById(id);

    function dataHora(iso) {
      const data = new Date(iso);
      return Number.isNaN(data.getTime()) ? "—" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    }

    function selo(tipo) {
      const node = dom.createTextElement("span", "ck-badge", rotuloTipo(tipo));
      if (tipo === "busca") node.dataset.status = "alerta";
      return node;
    }

    // Mini-list in the "Chamados novos do SoftExpert" card.
    function renderizarResumo(corpo) {
      const host = el("sebrae-historico-resumo");
      if (!host) return;
      const itens = ultimasEntradas(corpo?.itens);
      if (!itens.length) {
        host.replaceChildren(dom.createTextElement("p", "ck-campo__ajuda", "Nenhuma importação registrada ainda."));
        return;
      }
      const lista = document.createElement("ul");
      lista.className = "sebrae-historico-mini";
      itens.forEach(item => {
        const linha = document.createElement("li");
        linha.append(
          dom.createTextElement("span", "sebrae-historico-mini__quando", dataHora(item.em)),
          selo(item.tipo),
          dom.createTextElement("span", "sebrae-historico-mini__texto", [resumoEntrada(item), textoRepeticoes(item)].filter(Boolean).join(" · ")),
        );
        lista.appendChild(linha);
      });
      host.replaceChildren(dom.createTextElement("p", "ck-campo__rotulo", "Últimos registros do histórico"), lista);
    }

    async function carregarResumoHistoricoSebrae() {
      if (!el("sebrae-historico-resumo")) return;
      const consulta = ++estado.resumo;
      try {
        const corpo = await app.apiFetch(`/api/sebrae/historico?limite=${ENTRADAS_NO_CARTAO}`, {
          errorMessage: "Não foi possível consultar o histórico do Dashboard Sebrae.",
        });
        if (consulta === estado.resumo) renderizarResumo(corpo);
      } catch (error) {
        if (consulta === estado.resumo) el("sebrae-historico-resumo").replaceChildren(dom.createTextElement("p", "ck-campo__ajuda", error.message));
      }
    }

    return { carregarResumoHistoricoSebrae };
  }

  createSebraeHistorico.puro = { rotuloTipo, resumoEntrada, textoRepeticoes, ultimasEntradas };
  return createSebraeHistorico;
})());
