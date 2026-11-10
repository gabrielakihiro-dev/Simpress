/** Termos de entrega e devolução (Ferramentas): formulários na tela, folha de PDF montada na hora; nada é guardado. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).termos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTermos(context) {
  "use strict";
  const { app } = context;

  const ITENS_ENTREGA = [
    "01 Mochila", "02 Notebook", "03 Teclado", "04 Mouse", "05 Hub USB", "06 Suporte notebook",
    "07 Headset (modelo 8225 ou 3220)", "08 Case headset", "09 Mousepad", "10 Monitor", "11 Cabo de Segurança",
  ];
  const ITENS_DEVOLUCAO = [
    "1 - Mochila", "2 - Notebook", "3 - Teclado", "4 - Mouse", "5 - Hub USB", "6 - Suporte notebook",
    "7 - Headset", "8 - Case headset (modelo 8225)", "9 - Mousepad", "10 - Monitor", "11 - Cabo de Segurança",
  ];
  const CAMPOS_ENTREGA = ["nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"];
  const CAMPOS_DEVOLUCAO = ["nome", "unidade", "data", "modelo", "serie"];
  const TERMOS = {
    entrega: { itens: ITENS_ENTREGA, campos: CAMPOS_ENTREGA, campoSerie: "serie_entregue" },
    devolucao: { itens: ITENS_DEVOLUCAO, campos: CAMPOS_DEVOLUCAO, campoSerie: "serie" },
  };
  const ORDEM_ABAS = ["entrega", "devolucao"];
  const AVISO_SEM_NOME = "Preencha o número de série e o nome do colaborador.";
  const LIMITE_PARTE = 100;
  const doc = () => (typeof document !== "undefined" ? document : null);

  // Fatia o texto em vez de usar new Date: o fuso não pode deslocar o dia.
  function termosFormatarData(valor) {
    const texto = String(valor ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : texto;
  }

  function termosLimparParte(valor, maiusculas = false) {
    let texto = String(valor ?? "").normalize("NFC").replace(/\s+/g, " ").replace(/[^\p{L}\p{N} -]/gu, "").replace(/ {2,}/g, " ").trim();
    if (maiusculas) texto = texto.toUpperCase();
    texto = texto.slice(0, LIMITE_PARTE).trim();
    return /^[\s-]*$/.test(texto) ? "" : texto;
  }

  // Nome sugerido do arquivo (título da página durante a impressão): "<série> - <nome>"; vazio se não houver nenhum dos dois.
  function termosNomeArquivo(serie, nome) {
    return [termosLimparParte(serie, true), termosLimparParte(nome)].filter(Boolean).join(" - ");
  }

  function termosLerDados(termo, form) {
    const t = TERMOS[termo];
    const valor = (nome) => {
      const campo = form.querySelector(`[name="${nome}"]`);
      return campo ? String(campo.value ?? "") : "";
    };
    const campos = {};
    t.campos.forEach((nome) => { campos[nome] = valor(nome); });
    const itens = t.itens.map((rotulo, i) => {
      const marcado = form.querySelector(`input[name="item-${String(i + 1).padStart(2, "0")}"]:checked`);
      return { rotulo, resposta: marcado ? marcado.value : "" };
    });
    return { termo, campos, itens, obs: valor("obs") };
  }

  function criar(d, tag, classe, texto) {
    const el = d.createElement(tag);
    if (classe) el.className = classe;
    if (texto !== undefined) el.textContent = texto;
    return el;
  }

  function secao(d, titulo) {
    const s = criar(d, "section", "tp__secao");
    if (titulo) s.append(criar(d, "h2", "tp__secao-titulo", titulo));
    return s;
  }

  function campoFolha(d, rotulo, valor, cheio) {
    const c = criar(d, "div", cheio ? "tp__campo tp__campo--cheio" : "tp__campo");
    c.append(criar(d, "span", "tp__rotulo", `${rotulo}:`), criar(d, "span", "", valor));
    return c;
  }

  function tabela(d, cabecalhos, linhas, classesColunas = []) {
    const t = criar(d, "table", "tp__tabela");
    const tr = d.createElement("tr");
    cabecalhos.forEach((texto, i) => {
      const th = criar(d, "th", classesColunas[i] || "", texto);
      th.scope = "col";
      tr.append(th);
    });
    const cabeca = criar(d, "thead");
    cabeca.append(tr);
    t.append(cabeca);
    const corpo = criar(d, "tbody");
    linhas.forEach((celulas) => {
      const linha = d.createElement("tr");
      celulas.forEach((texto, i) => {
        const c = criar(d, i === 0 ? "th" : "td", i === 0 ? "" : classesColunas[i] || "", texto);
        if (i === 0) c.scope = "row";
        linha.append(c);
      });
      corpo.append(linha);
    });
    t.append(corpo);
    return t;
  }

  const marcas = (resposta) => `${resposta === "sim" ? "[X]" : "[ ]"} Sim   ${resposta === "nao" ? "[X]" : "[ ]"} Não`;

  function tabelaItens(d, itens) {
    return tabela(d, ["Equipamento / Acessório", "Sim / Não"], itens.map((i) => [i.rotulo, marcas(i.resposta)]), ["", "tp__marcas"]);
  }

  function observacoes(d, texto) {
    const s = secao(d, "Observações");
    s.append(criar(d, "div", "tp__obs", String(texto ?? "")));
    return s;
  }

  function assinaturas(d, esquerda, direita) {
    const a = criar(d, "div", "tp__assinaturas");
    a.append(criar(d, "div", "tp__assinatura", esquerda), criar(d, "div", "tp__assinatura", direita));
    return a;
  }

  // A folha usa só createElement e textContent: nada digitado vira HTML.
  function termosMontarFolha(d, dados) {
    const c = dados.campos;
    const folha = criar(d, "article", "tp");
    const cab = criar(d, "header", "tp__cab");
    cab.append(criar(d, "div", "tp__org", "SEBRAE/PR"));
    if (dados.termo === "entrega") cab.append(criar(d, "div", "tp__marca", "Interno"));
    cab.append(criar(d, "h1", "tp__titulo", dados.termo === "entrega" ? "Termo de Entrega" : "Termo de Devolução de Equipamentos"));
    folha.append(cab);

    const colab = secao(d, "Dados do colaborador");
    const grade = criar(d, "div", "tp__campos");
    if (dados.termo === "entrega") {
      grade.append(
        campoFolha(d, "Nome do colaborador", c.nome, true),
        campoFolha(d, "Unidade / Departamento", c.unidade),
        campoFolha(d, "Data da entrega / troca", termosFormatarData(c.data)),
      );
    } else {
      grade.append(
        campoFolha(d, "Nome do colaborador", c.nome, true),
        campoFolha(d, "Unidade", c.unidade),
        campoFolha(d, "Data", termosFormatarData(c.data)),
        campoFolha(d, "Modelo do computador", c.modelo),
        campoFolha(d, "Número de série", c.serie),
      );
    }
    colab.append(grade);
    folha.append(colab);

    if (dados.termo === "entrega") {
      const ident = secao(d, "Identificação do equipamento");
      ident.append(tabela(d, ["Campo", "Equipamento anterior", "Equipamento entregue"], [
        ["Modelo do computador", c.modelo_anterior, c.modelo_entregue],
        ["Número de série / Service Tag", c.serie_anterior, c.serie_entregue],
      ]));
      folha.append(ident);

      const itens = secao(d, "Equipamentos e acessórios entregues");
      itens.append(criar(d, "p", "tp__dica", "Assinale Sim ou Não para cada item apresentado no ato da entrega."), tabelaItens(d, dados.itens));
      folha.append(itens, observacoes(d, dados.obs));

      const validacao = secao(d, "Validação do recebimento");
      validacao.append(criar(d, "p", "tp__texto", "Declaro que conferi as informações deste termo e recebi os equipamentos e acessórios assinalados acima."));
      folha.append(validacao, assinaturas(d, "Assinatura do colaborador", "Assinatura do técnico responsável"));
      folha.append(criar(d, "footer", "tp__rodape", "SEBRAE/PR • Termo de Entrega"));
    } else {
      const itens = secao(d);
      itens.append(tabelaItens(d, dados.itens));
      folha.append(itens, observacoes(d, dados.obs), assinaturas(d, "Assinatura do colaborador", "Assinatura do Técnico"));
    }
    return folha;
  }

  const porId = (id) => (doc() ? doc().getElementById(id) : null);

  function avisar(termo, texto, erro) {
    const el = porId(`termos-status-${termo}`);
    if (!el) return;
    el.textContent = texto;
    if (erro) el.dataset.tipo = "erro";
    else delete el.dataset.tipo;
  }

  function termosSelecionarAba(termo) {
    if (!TERMOS[termo]) return;
    ORDEM_ABAS.forEach((nome) => {
      const ativa = nome === termo;
      const aba = porId(`termos-aba-${nome}`);
      const painel = porId(`termos-painel-${nome}`);
      if (aba) {
        aba.setAttribute("aria-selected", String(ativa));
        aba.tabIndex = ativa ? 0 : -1;
      }
      if (painel) painel.hidden = !ativa;
    });
  }

  function termosTeclaAba(evento) {
    const aba = evento?.target?.closest?.('[role="tab"]');
    if (!aba) return;
    const atual = ORDEM_ABAS.findIndex((nome) => aba.id === `termos-aba-${nome}`);
    if (atual < 0) return;
    const total = ORDEM_ABAS.length;
    const destino = { ArrowRight: (atual + 1) % total, ArrowLeft: (atual + total - 1) % total, Home: 0, End: total - 1 }[evento.key];
    if (destino === undefined) return;
    evento.preventDefault();
    termosSelecionarAba(ORDEM_ABAS[destino]);
    porId(`termos-aba-${ORDEM_ABAS[destino]}`)?.focus();
  }

  let encerrarImpressao = null;

  function termosGerarPdf(termo) {
    const d = doc();
    const form = porId(`termos-form-${termo}`);
    const folha = porId("termos-impressao");
    if (!d || !form || !folha || !TERMOS[termo]) return;
    const dados = termosLerDados(termo, form);
    const serie = dados.campos[TERMOS[termo].campoSerie];
    // O nome do arquivo é sempre "SÉRIE - Nome completo": sem uma das partes, não gera.
    if (!termosLimparParte(serie, true) || !termosLimparParte(dados.campos.nome)) {
      avisar(termo, AVISO_SEM_NOME, true);
      return;
    }
    avisar(termo, "");
    if (encerrarImpressao) encerrarImpressao();
    const tituloOriginal = d.title;
    const encerrar = () => {
      window.removeEventListener("afterprint", encerrar);
      d.documentElement.classList.remove("termos-imprimindo");
      folha.replaceChildren();
      folha.hidden = true;
      d.title = tituloOriginal;
      if (encerrarImpressao === encerrar) encerrarImpressao = null;
    };
    encerrarImpressao = encerrar;
    folha.replaceChildren(termosMontarFolha(d, dados));
    // O [hidden] !important do Tailwind (em @layer) vence o CSS de impressão; por isso o atributo sai.
    folha.hidden = false;
    d.title = termosNomeArquivo(serie, dados.campos.nome);
    d.documentElement.classList.add("termos-imprimindo");
    window.addEventListener("afterprint", encerrar);
    try {
      window.print();
    } catch (erro) {
      encerrar();
      avisar(termo, "Não foi possível abrir a janela de impressão.", true);
    }
  }

  async function termosLimpar(termo) {
    const form = porId(`termos-form-${termo}`);
    if (!form || !TERMOS[termo]) return;
    const confirmou = await app.confirmarAcao({
      titulo: "Limpar o termo?",
      mensagem: "Todos os campos do termo serão apagados. Nada foi guardado em outro lugar.",
      confirmar: "Limpar",
      cancelar: "Cancelar",
    });
    if (confirmou !== true) return;
    form.reset();
    avisar(termo, "");
    if (encerrarImpressao) encerrarImpressao();
    else porId("termos-impressao")?.replaceChildren();
    form.querySelector("input")?.focus();
  }

  return {
    termosSelecionarAba, termosTeclaAba, termosGerarPdf, termosLimpar,
    termosFormatarData, termosLimparParte, termosNomeArquivo, termosLerDados, termosMontarFolha,
  };
});
