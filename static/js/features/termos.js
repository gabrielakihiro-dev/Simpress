/** Termos de entrega e devolução (Ferramentas): formulários na tela, folha de PDF montada na hora; nada é guardado. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).termos = factory;
})(typeof window !== "undefined" ? window : globalThis, function createTermos(context) {
  "use strict";
  const { app } = context;

  const ITENS_ENTREGA = [
    "01 Mochila", "02 Notebook", "03 Teclado", "04 Mouse", "05 Hub USB", "06 Suporte notebook",
    "07 Headset (modelo 8225 ou 3220)", "08 Case headset", "09 Mousepad", "10 Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 Cabo de Segurança",
  ];
  const ITENS_DEVOLUCAO = [
    "1 - Mochila", "2 - Notebook", "3 - Teclado", "4 - Mouse", "5 - Hub USB", "6 - Suporte notebook",
    "7 - Headset", "8 - Case headset (modelo 8225)", "9 - Mousepad", "10 - Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 - Cabo de Segurança",
  ];
  const CAMPOS_ENTREGA = ["nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"];
  const CAMPOS_DEVOLUCAO = ["nome", "unidade", "data", "modelo", "serie"];
  const TERMOS = {
    entrega: { itens: ITENS_ENTREGA, campos: CAMPOS_ENTREGA, campoSerie: "serie_entregue" },
    devolucao: { itens: ITENS_DEVOLUCAO, campos: CAMPOS_DEVOLUCAO, campoSerie: "serie" },
  };
  // "lembretes" é a terceira pílula do painel Lembretes; a lista em si mora em lembretes.js.
  const ORDEM_ABAS = ["entrega", "devolucao", "lembretes"];
  const AVISO_SEM_NOME = "Preencha o número de série e o nome do colaborador.";
  const LIMITE_PARTE = 100;
  // Única requisição do termo: GET da assinatura do técnico (arquivo local, sem enviar nada do termo).
  const URL_ASSINATURA = "/api/assinatura-tecnico";
  const TEMPO_ASSINATURA_MS = 3000;
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

  // A imagem (se houver) vai só no lado do técnico, acima do rótulo; o do colaborador fica em branco.
  function assinaturas(d, esquerda, direita, imagemTecnico) {
    const a = criar(d, "div", "tp__assinaturas");
    const tecnico = criar(d, "div", "tp__assinatura", direita);
    if (imagemTecnico) tecnico.prepend(imagemTecnico);
    a.append(criar(d, "div", "tp__assinatura", esquerda), tecnico);
    return a;
  }

  // A folha usa só createElement e textContent: nada digitado vira HTML.
  function termosMontarFolha(d, dados, assinaturaTecnico) {
    const c = dados.campos;
    const entrega = dados.termo === "entrega";
    // Mesma estrutura nos dois termos; a devolução muda só os textos e a cor de destaque (tp--devolucao).
    const folha = criar(d, "article", entrega ? "tp" : "tp tp--devolucao");
    const cab = criar(d, "header", "tp__cab");
    cab.append(
      criar(d, "div", "tp__org", "SEBRAE/PR"),
      criar(d, "div", "tp__marca", "Interno"),
      criar(d, "h1", "tp__titulo", entrega ? "Termo de Entrega" : "Termo de Devolução de Equipamentos"),
    );
    folha.append(cab);

    const colab = secao(d, "Dados do colaborador");
    const grade = criar(d, "div", "tp__campos");
    grade.append(
      campoFolha(d, "Nome do colaborador", c.nome, true),
      campoFolha(d, entrega ? "Unidade / Departamento" : "Unidade", c.unidade),
      campoFolha(d, entrega ? "Data da entrega / troca" : "Data", termosFormatarData(c.data)),
    );
    // A devolução não tem a tabela de identificação: modelo e série ficam nos dados do colaborador.
    if (!entrega) grade.append(campoFolha(d, "Modelo do computador", c.modelo), campoFolha(d, "Número de série", c.serie));
    colab.append(grade);
    folha.append(colab);

    if (entrega) {
      const ident = secao(d, "Identificação do equipamento");
      ident.append(tabela(d, ["Campo", "Equipamento anterior", "Equipamento entregue"], [
        ["Modelo do computador", c.modelo_anterior, c.modelo_entregue],
        ["Número de série / Service Tag", c.serie_anterior, c.serie_entregue],
      ]));
      folha.append(ident);
    }

    const itens = secao(d, entrega ? "Equipamentos e acessórios entregues" : "Equipamentos e acessórios devolvidos");
    itens.append(
      criar(d, "p", "tp__dica", `Assinale Sim ou Não para cada item apresentado no ato da ${entrega ? "entrega" : "devolução"}.`),
      tabelaItens(d, dados.itens),
    );
    folha.append(itens, observacoes(d, dados.obs));

    const validacao = secao(d, entrega ? "Validação do recebimento" : "Validação da devolução");
    validacao.append(criar(d, "p", "tp__texto", entrega
      ? "Declaro que conferi as informações deste termo e recebi os equipamentos e acessórios assinalados acima."
      : "Declaro que conferi as informações deste termo e devolvi os equipamentos e acessórios assinalados acima."));
    folha.append(validacao, assinaturas(d, "Assinatura do colaborador", entrega ? "Assinatura do técnico responsável" : "Assinatura do Técnico", assinaturaTecnico));
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
    if (!ORDEM_ABAS.includes(termo)) return;
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

  // Lê o termo da tela. O nome do arquivo é sempre "SÉRIE - Nome completo": sem uma das partes, mostra o aviso e devolve null.
  // Gerar PDF e Criar lembrete usam o mesmo teste.
  function termosLerValidado(termo) {
    const form = porId(`termos-form-${termo}`);
    if (!form || !TERMOS[termo]) return null;
    const dados = termosLerDados(termo, form);
    if (!termosLimparParte(dados.campos[TERMOS[termo].campoSerie], true) || !termosLimparParte(dados.campos.nome)) {
      avisar(termo, AVISO_SEM_NOME, true);
      return null;
    }
    return dados;
  }

  // Carrega a assinatura numa <img> fora da página; qualquer falha (404, 422, imagem inválida, tempo) devolve null
  // e o PDF sai como antes, com a linha em branco.
  async function termosCarregarAssinatura(d) {
    const img = d.createElement("img");
    img.className = "tp__assinatura-img";
    img.alt = "";
    img.src = URL_ASSINATURA;
    let relogio;
    try {
      const limite = new Promise((_, rejeitar) => { relogio = setTimeout(rejeitar, TEMPO_ASSINATURA_MS); });
      await Promise.race([img.decode(), limite]);
      return img;
    } catch (erro) {
      return null;
    } finally {
      clearTimeout(relogio);
    }
  }

  // Pedido em andamento (carregando a assinatura): novo clique é ignorado e Limpar o cancela.
  let pdfPendente = null;

  async function termosGerarPdf(termo) {
    const d = doc();
    const folha = porId("termos-impressao");
    if (!d || !folha || pdfPendente) return;
    if (!termosLerValidado(termo)) return;
    avisar(termo, "");
    const pedido = (pdfPendente = { termo });
    const assinatura = await termosCarregarAssinatura(d);
    if (pdfPendente !== pedido) return;
    pdfPendente = null;
    // Relê depois da espera: o formulário pode ter mudado (edição ou busca de série na Home).
    const dados = termosLerValidado(termo);
    if (!dados) return;
    const serie = dados.campos[TERMOS[termo].campoSerie];
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
    folha.replaceChildren(termosMontarFolha(d, dados, assinatura));
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
    if (pdfPendente?.termo === termo) pdfPendente = null;
    form.reset();
    form.querySelectorAll("[data-preenchido-home]").forEach((input) => { delete input.dataset.preenchidoHome; });
    delete form.dataset.serieHome;
    avisar(termo, "");
    if (encerrarImpressao) encerrarImpressao();
    else porId("termos-impressao")?.replaceChildren();
    form.querySelector("input")?.focus();
  }

  // Campos que a busca de série da Home preenche em cada termo; o resto o usuário digita.
  const PREENCHIMENTO_HOME = {
    entrega: { nome: "nome_pessoa", modelo_entregue: "modelo", serie_entregue: "serial" },
    devolucao: { nome: "nome_pessoa", modelo: "modelo", serie: "serial" },
  };

  // Chamado pela Home a cada equipamento exibido. Só age quando a série muda (salvar a edição cadastral
  // reexibe a mesma série e não pode desfazer o que o usuário mudou). Valor vazio só apaga o que a
  // própria Home tinha posto, para não perder o que o usuário digitou à mão.
  function termosPreencherDoEquipamento(eq) {
    const serial = String(eq?.serial ?? "").trim();
    if (!serial) return;
    Object.keys(PREENCHIMENTO_HOME).forEach((termo) => {
      const form = porId(`termos-form-${termo}`);
      if (!form || form.dataset.serieHome === serial) return;
      form.dataset.serieHome = serial;
      Object.entries(PREENCHIMENTO_HOME[termo]).forEach(([campo, chave]) => {
        const input = form.querySelector(`[name="${campo}"]`);
        if (!input) return;
        const valor = String(eq[chave] ?? "").trim();
        if (valor) {
          input.value = valor;
          input.dataset.preenchidoHome = "1";
        } else if (input.dataset.preenchidoHome) {
          input.value = "";
          delete input.dataset.preenchidoHome;
        }
      });
      // Item 02 Notebook: o equipamento buscado é o notebook do termo.
      const notebook = form.querySelector('input[name="item-02"][value="sim"]');
      if (notebook) notebook.checked = true;
    });
  }

  return {
    termosSelecionarAba, termosTeclaAba, termosGerarPdf, termosLimpar, termosPreencherDoEquipamento,
    termosFormatarData, termosLimparParte, termosNomeArquivo, termosLerDados, termosLerValidado, termosMontarFolha,
  };
});
