/** Automação → "Histórico de importações do Dashboard Sebrae": mini-lista no cartão e painel completo da ferramenta. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).sebraeHistorico = factory;
})(typeof window !== "undefined" ? window : globalThis, (function () {
  "use strict";

  const ENTRADAS_NO_CARTAO = 3;
  const LIMITE_LISTA = 50;
  const ROTULOS_TIPO = Object.freeze({ importacao: "Importação", busca: "Busca" });

  function plural(n, singular, pluralTexto) {
    return `${n} ${n === 1 ? singular : pluralTexto}`;
  }

  function rotuloTipo(tipo) {
    return ROTULOS_TIPO[tipo] || (tipo ? tipo[0].toUpperCase() + tipo.slice(1) : "");
  }

  /** One line with the counts of an entry, the same text in the card and in the table. */
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

  function linhasDeMudanca(alterados) {
    return (Array.isArray(alterados) ? alterados : []).map(item => {
      const encerrado = item.encerramento ? ` (encerrado em ${item.encerramento})` : "";
      return `${item.numero}: ${item.de || "sem status"} → ${item.para || "sem status"}${encerrado}`;
    });
  }

  const GRUPOS = Object.freeze({
    importacao: [["adicionados", "Adicionados", "n_adicionados"], ["removidos", "Removidos", "n_removidos"], ["alterados", "Status alterado", "n_alterados"]],
    busca: [["lidos", "Lidos", "n_lidos"], ["pendentes", "Pendentes", "n_pendentes"], ["erros", "Com erro", "n_erros"]],
  });

  /** Groups of the detail that have at least one number; ``cortado`` when the stored list is shorter than the count. */
  function grupoDoDetalhe(detalhe) {
    return (GRUPOS[detalhe?.tipo] || []).map(([chave, titulo, contagem]) => {
      const lista = Array.isArray(detalhe[chave]) ? detalhe[chave] : [];
      const itens = chave === "alterados" ? linhasDeMudanca(lista) : lista.map(String);
      const total = Number(detalhe[contagem]) || itens.length;
      return { titulo, itens, total, cortado: total > itens.length };
    }).filter(grupo => grupo.itens.length > 0);
  }

  function ultimasEntradas(itens) {
    return (Array.isArray(itens) ? itens : []).slice(0, ENTRADAS_NO_CARTAO);
  }

  function createSebraeHistorico(context) {
    const { app, dom } = context;
    const estado = { itens: [], selecionado: "", lista: 0, detalhe: 0, resumo: 0 };

    const el = id => document.getElementById(id);

    function dataHora(iso) {
      const data = new Date(iso);
      return Number.isNaN(data.getTime()) ? "—" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    }

    function numero(valor) {
      return new Intl.NumberFormat("pt-BR").format(Number(valor) || 0);
    }

    function selo(tipo) {
      const node = dom.createTextElement("span", "ck-badge", rotuloTipo(tipo));
      if (tipo === "busca") node.dataset.status = "alerta";
      return node;
    }

    function pares(alvo, entradas) {
      alvo.replaceChildren(...entradas.filter(([, valor]) => valor).map(([rotulo, valor]) => {
        const par = document.createElement("div");
        par.className = "ck-par";
        par.append(dom.createTextElement("dt", "", rotulo), dom.createTextElement("dd", "", valor));
        return par;
      }));
    }

    function vazio(alvo, colunas, mensagem) {
      const celula = dom.createTextElement("td", "ck-lista__vazio", mensagem);
      celula.colSpan = colunas;
      const linha = document.createElement("tr");
      linha.append(celula);
      alvo.replaceChildren(linha);
    }

    function kpis(alvo, entradas) {
      alvo.replaceChildren(...entradas.map(([rotulo, valor]) => {
        const cartao = document.createElement("div");
        cartao.className = "ck-kpi";
        cartao.append(dom.createTextElement("span", "ck-kpi__rotulo", rotulo), dom.createTextElement("strong", "ck-kpi__valor", valor));
        return cartao;
      }));
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

    // Tool panel.
    function renderizarLinhas() {
      const corpo = el("sebrae-historico-lista-corpo");
      if (!estado.itens.length) {
        vazio(corpo, 5, "Nenhum registro no histórico.");
        mostrarDetalhe(null);
        return;
      }
      if (!estado.itens.some(item => item.id === estado.selecionado)) estado.selecionado = estado.itens[0].id;
      corpo.replaceChildren(...estado.itens.map(item => {
        const linha = document.createElement("tr");
        linha.tabIndex = 0;
        linha.setAttribute("aria-selected", String(item.id === estado.selecionado));
        const selecionar = () => { estado.selecionado = item.id; renderizarLinhas(); };
        linha.addEventListener("click", selecionar);
        linha.addEventListener("keydown", event => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          selecionar();
        });
        [
          ["Data", dataHora(item.em)], ["Tipo", selo(item.tipo)], ["Arquivo", item.arquivo || "—"],
          ["O que mudou", [resumoEntrada(item), textoRepeticoes(item)].filter(Boolean).join(" · ")],
          ["Chamados", item.tipo === "importacao" ? numero(item.total) : "—", "ck-td--dir"],
        ].forEach(([rotulo, conteudo, classe]) => {
          const celula = document.createElement("td");
          if (classe) celula.className = classe;
          celula.dataset.label = rotulo;
          celula.append(conteudo instanceof Node ? conteudo : document.createTextNode(String(conteudo)));
          linha.appendChild(celula);
        });
        return linha;
      }));
      void mostrarDetalhe(estado.itens.find(item => item.id === estado.selecionado));
    }

    async function mostrarDetalhe(item) {
      const consulta = ++estado.detalhe;
      const nota = el("sebrae-historico-detalhe-nota");
      nota.hidden = true;
      el("sebrae-historico-detalhe-tag").replaceChildren();
      el("sebrae-historico-detalhe-grupos").replaceChildren();
      if (!item) {
        el("sebrae-historico-detalhe-titulo").textContent = "—";
        el("sebrae-historico-detalhe-sub").textContent = "Selecione um registro.";
        el("sebrae-historico-detalhe-pares").replaceChildren();
        return;
      }
      el("sebrae-historico-detalhe-titulo").textContent = dataHora(item.em);
      el("sebrae-historico-detalhe-sub").textContent = item.arquivo || "Busca de chamados novos";
      el("sebrae-historico-detalhe-tag").replaceChildren(selo(item.tipo));
      pares(el("sebrae-historico-detalhe-pares"), [["Situação", "Carregando…"]]);
      try {
        const detalhe = await app.apiFetch(`/api/sebrae/historico/${encodeURIComponent(item.id)}`, {
          errorMessage: "Não foi possível abrir este registro.",
        });
        if (consulta !== estado.detalhe) return;
        pares(el("sebrae-historico-detalhe-pares"), [
          ["O que mudou", resumoEntrada(detalhe)],
          ["Chamados no Dashboard", detalhe.tipo === "importacao" ? numero(detalhe.total) : ""],
          ["Reimportado", textoRepeticoes(detalhe) ? `${textoRepeticoes(detalhe).replace("Reimportado ", "")}, a última em ${dataHora(detalhe.ultima_repeticao_em)}` : ""],
          ["Impressão digital (SHA-256)", detalhe.sha256 ? `${detalhe.sha256.slice(0, 16)}…` : ""],
        ]);
        el("sebrae-historico-detalhe-grupos").replaceChildren(...grupoDoDetalhe(detalhe).map(grupo => {
          const bloco = document.createElement("section");
          bloco.className = "sebrae-historico-grupo";
          const lista = document.createElement("ul");
          lista.className = "sebrae-avisos";
          grupo.itens.forEach(texto => lista.appendChild(dom.createTextElement("li", "ck-cartao__meta", texto)));
          bloco.append(dom.createTextElement("h3", "ck-campo__rotulo", `${grupo.titulo} (${numero(grupo.total)})`), lista);
          if (grupo.cortado) bloco.appendChild(dom.createTextElement("p", "ck-campo__ajuda", `Mostrando os primeiros ${grupo.itens.length}.`));
          return bloco;
        }));
      } catch (error) {
        if (consulta !== estado.detalhe) return;
        pares(el("sebrae-historico-detalhe-pares"), []);
        el("sebrae-historico-detalhe-nota-texto").textContent = error.message;
        nota.hidden = false;
      }
    }

    async function carregarPainelHistoricoSebrae() {
      if (!el("sebrae-historico-lista-corpo")) return;
      const consulta = ++estado.lista;
      const status = el("sebrae-historico-status");
      const tipo = el("sebrae-historico-filtro")?.value || "";
      status.textContent = "Carregando…";
      vazio(el("sebrae-historico-lista-corpo"), 5, "Carregando…");
      try {
        const corpo = await app.apiFetch(`/api/sebrae/historico?limite=${LIMITE_LISTA}${tipo ? `&tipo=${encodeURIComponent(tipo)}` : ""}`, {
          errorMessage: "Não foi possível carregar o histórico do Dashboard Sebrae.",
        });
        if (consulta !== estado.lista) return;
        estado.itens = corpo.itens || [];
        kpis(el("sebrae-historico-kpis"), [
          ["Importações", numero(corpo.importacoes)], ["Buscas", numero(corpo.buscas)],
          ["Última importação", dataHora(estado.itens.find(item => item.tipo === "importacao")?.em)],
        ]);
        status.textContent = `${plural(corpo.total, "registro", "registros")}${corpo.total > estado.itens.length ? `, mostrando os ${estado.itens.length} mais recentes` : ""}`;
        renderizarLinhas();
      } catch (error) {
        if (consulta !== estado.lista) return;
        estado.itens = [];
        status.textContent = error.message;
        vazio(el("sebrae-historico-lista-corpo"), 5, error.message);
        void mostrarDetalhe(null);
      }
    }

    function filtrarHistoricoSebrae() {
      return carregarPainelHistoricoSebrae();
    }

    return { carregarResumoHistoricoSebrae, carregarPainelHistoricoSebrae, filtrarHistoricoSebrae };
  }

  createSebraeHistorico.puro = { rotuloTipo, resumoEntrada, textoRepeticoes, linhasDeMudanca, grupoDoDetalhe, ultimasEntradas };
  return createSebraeHistorico;
})());
