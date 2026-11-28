// Automação -> "Chamados novos do SoftExpert": importa o Dashboard, lista os novos e baixa uma cópia atualizada do
// Dashboard (chamados novos e alterações nos antigos em aberto). Porte fiel do antigo frontend/src/legado/features/sebrae-dashboard.js:
// mesmos IDs, ARIA, textos, toasts e corpos de POST. Depende só do contexto recebido (app, dom, modelo). A tela segue
// montada à mão no DOM (sem JSX), porque o resto da Automação procura esses elementos pelo ID; só os chips da última leitura
// dos antigos saem do React (leitura.tsx), a partir da loja que renderizarAntigos e abrirFalhas escrevem.
import { baixarDaApi } from "../../comum/baixar-api.ts";
import { tomDoLado } from "../../componentes/nl-modelo.ts";
import { criarLojaLeitura } from "./leitura-loja.ts";
import { criarLojaAvisos, criarLojaRascunho, type ItemRascunho } from "./lojas.ts";
import { legendaCampoOs, pedeDecisao, SELO_OS_NOVA, SELO_OS_SEM_RELACAO } from "./sugestao-os-modelo.ts";
import type { CampoVisao, ContextoSebraeDashboard, ElementoSebrae, ErroApi, EstadoSebrae, OsNova, Registro, VisaoSebrae } from "./tipos";

export function criarDashboardSebrae(context: ContextoSebraeDashboard) {
  "use strict";
  const { app, dom } = context;
  const {
    CAMPOS_AUTOMATICOS, CAMPOS_PREENCHIDOS, STATUS_CHAMADO, STATUS_FINALIZADO, TIPOS_CHAMADO, DESCRICAO_API_SEBRAE, AVISO_CRUZAMENTO, ROTULOS_FALTA,
    MAX_TITULO, MAX_DESCRICAO, NUMERO_UTIC, INTERVALO_FECHAR_MS, STATUS_DESFEITOS, STATUS_OUTRO_TECNICO, CHAVE_RASCUNHO, NUMERO_RASCUNHO, PREFIXO_CAMPO,
    ehApiSebrae, padroesManuais, avisoOutraPessoa, avisoNomeDaDescricao, formatarEncerramento, encerramentoParaCampo, encerramentoAgora, payloadEdicoes, descricaoJaNoDashboard,
    tituloAntigo, dadosAntigo, AJUDA_ENCERRAMENTO, encerramentoInformado, ajudaEncerramentoSemHora, encerramentoObrigatorio, pendenciasEncerramento, avisoEncerramento,
    resumoLeituraAntigos, totalPreenchimentos, payloadAtualizacao, formatarTamanho, textoResultado, textoPulado,
    camposFaltando, blocoOutroTecnico, candidatosFinalizar, excluidosFinalizar, avisoExcluidosFinalizar, resultadoEnvioAtualizacao, resumoResultado, resumoInicio,
    lerRascunho, gravarCampoRascunho, apagarRascunho, aplicarRascunho,
  } = context.sebraeDashboardModel;
  const armazenamento = (() => { try { return window.localStorage || null; } catch (_erro) { return null; } })();
  const estado: EstadoSebrae = {
    naoSalvos: { valores: {}, edicoes: {} }, rascunhoExterno: false, formulario: [], valores: {}, consulta: 0, listas: {}, abertos: [], edicoes: {}, atualizavel: false, importadoEm: "", versaoImportacao: "", descartar: false,
    soft: {}, refs: new Map(), temporizadores: {}, salvando: {}, finalizados: new Set(),
    observacoes: {}, temporizadoresObs: {}, salvandoObs: {}, finalizando: new Set(), pdfOcupado: new Map(),
    // Destaque manual: única fonte de verdade (número -> {em, observacao}); cartões, selos, botões e a seção `Chamados em destaque` leem daqui.
    destaques: {}, destaqueEditados: new Set(), destaqueOcupado: new Set(), finalizadosItens: [],
    // PUT de destaque concluído: versão global + último resultado por número; respostas de GET iniciadas antes dele são ignoradas para esse número.
    destaqueVersao: 0, destaqueUltimo: {},
    fechar: { emAndamento: false, mensagemInicio: "", numeros: [], pulados: [], resultado: null, sharepoint: null, token: 0, recarregado: "" },
    antigos: { emAndamento: false, resultado: null, mensagem: "", token: 0, anteriorEm: null },
  };
  // Chips da última leitura dos antigos: o DOM nasce em leitura.tsx a partir desta loja.
  const leitura = context.lojaLeitura ?? criarLojaLeitura();
  // Avisos dos novos e rascunho: o DOM nasce em avisos-rascunho.tsx a partir destas lojas.
  const avisos = context.lojaAvisos ?? criarLojaAvisos();
  const rascunhoTela = context.lojaRascunho ?? criarLojaRascunho();

  if (typeof window.addEventListener === "function") window.addEventListener("storage", evento => {
    if (evento.key === CHAVE_RASCUNHO || evento.key?.startsWith(PREFIXO_CAMPO)) {
      estado.rascunhoExterno = true;
      mostrarRascunho("O rascunho mudou em outra aba. Suas edições foram preservadas; recarregue para conferir a versão mais recente antes de atualizar o Dashboard.", "alerta");
    }
  });

  const el = (id: string) => document.getElementById(id) as ElementoSebrae;

  function definirTexto(id: string, texto: string) {
    const elemento = el(id);
    if (elemento) elemento.textContent = texto;
  }

  // ---- Sub-abas do F5 (Novos, Antigos, Destaques, Finalizados), filtro e paginação: só apresentação, nada é gravado ----
  const ABAS: string[] = ["novos", "antigos", "destaques", "finalizados"];
  const ROTULO_ABA: Record<string, string> = { novos: "Novos", antigos: "Antigos", destaques: "Destaques", finalizados: "Finalizados" };
  const POR_PAGINA = 25;
  const TEXTO_ORIENTACAO_NAO_ENCONTRADO = "Se você já finalizou este chamado no SoftExpert, clique em Conferir este chamado. Se ele não for encontrado, em Finalizar no SoftExpert marque “registrar como finalizado por outro técnico” (precisa de A, B, D = FINALIZADO e R).";
  // Vive só na memória da página: F5 → F4 → F5 mantém a aba; recarregar volta a Novos com o filtro vazio.
  const visao: VisaoSebrae = { aba: "novos", termo: "", paginas: { antigos: POR_PAGINA, finalizados: POR_PAGINA }, novosAbertos: null, itens: [], porNo: new Map() };
  const abertosPelaPessoa = new WeakSet<Element>();
  let linhaAberta: ElementoSebrae | null = null; // a linha `details` (novo, antigo ou finalizado) aberta por último
  const normalizar = (valor: unknown): string => (context.ticketRules?.normalizarFiltroChamados || app.normalizarFiltroChamados
    || ((texto: unknown) => String(texto || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLocaleLowerCase("pt-BR")))(valor);

  /** Texto do resultado de Atualizar Dashboard; `situacao` (ok, alerta, erro) vai para `data-estado` e o CSS pinta a cor. */
  function definirStatusAtualizar(texto: string, situacao = "") {
    definirTexto("sebrae-atualizar-status", texto);
    const elemento = el("sebrae-atualizar-status");
    if (elemento) elemento.dataset.estado = situacao;
  }

  /** Chamados em aberto (antigos visíveis e novos) com D FINALIZADO e ainda sem DT ENCERRAMENTO (R): o servidor recusaria Atualizar.
   * O já finalizado por este site fica de fora, como no servidor (o R registrado volta à coluna R). */
  function pendentesEncerramento() {
    const emAberto = (item: Registro) => !estado.finalizados.has(item.numero) && !STATUS_DESFEITOS.includes(estado.soft[item.numero]?.finalizacao?.status);
    return pendenciasEncerramento(estado.abertos.filter(emAberto), estado.edicoes, estado.formulario.filter(emAberto), estado.valores);
  }

  // O aviso de "falta R" que está no status de Atualizar agora; só ele é apagado quando a falta some (nunca o resultado de um Atualizar).
  let avisoEncerramentoNoStatus = "";

  /** Mostra (ou, quando some a falta, apaga) o aviso de R obrigatório no status de Atualizar; devolve se há falta. */
  function mostrarFaltaEncerramento(pendentes: string[]) {
    if (pendentes.length) {
      avisoEncerramentoNoStatus = avisoEncerramento(pendentes);
      definirStatusAtualizar(avisoEncerramentoNoStatus, "alerta");
    } else if (avisoEncerramentoNoStatus) {
      if (el("sebrae-atualizar-status")?.textContent === avisoEncerramentoNoStatus) definirStatusAtualizar("", "");
      avisoEncerramentoNoStatus = "";
    }
    return pendentes.length > 0;
  }

  /** "Enviar ao SharePoint" só vale com o arquivo gerado por Atualizar Dashboard; sem ele a rotina falharia com "Não achei...". */
  function definirEnvioDisponivel(pronto: boolean) {
    const botao = el("btn-sebrae-enviar");
    if (!botao) return;
    botao.dataset.semSaida = String(!pronto);
    botao.title = pronto ? "" : "Gere o Dashboard atualizado (Atualizar Dashboard) antes de enviar.";
    if (!pronto) {
      botao.disabled = true;
      botao.setAttribute("aria-disabled", "true");
    } else if (botao.disabled && !botao.hasAttribute("aria-busy")) {
      botao.disabled = false;
      botao.setAttribute("aria-disabled", "false");
    }
  }

  function formatarDataHora(iso?: string | null) {
    const data = new Date(iso as string);
    return Number.isNaN(data.getTime()) ? "" : data.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function campo(rotulo: string, controle: ElementoSebrae) {
    const rotuloEl = document.createElement("label");
    rotuloEl.className = "ck-campo";
    rotuloEl.append(dom.createTextElement("span", "ck-campo__rotulo", rotulo), controle);
    return rotuloEl;
  }

  /** Valores digitados: dos chamados novos (``estado.valores``) ou das alterações nos antigos (``estado.edicoes``). */
  function valoresDe(alvo: string | undefined) {
    return alvo === "antigo" ? estado.edicoes : estado.valores;
  }

  function controleManual(numero: string, letra: string, alvo = "novo") {
    const antigo = alvo === "antigo";
    const guardados = valoresDe(alvo);
    const valores = guardados[numero] || {};
    const atual = antigo ? estado.abertos.find(item => item.numero === numero)?.valores?.[letra] || "" : "";
    const opcoesLista = estado.listas[letra] || [];
    let controle: ElementoSebrae;
    if (letra === "D" || letra === "J" || opcoesLista.length) {
      controle = document.createElement("select");
      const opcoes = letra === "D" ? STATUS_CHAMADO : letra === "J" ? TIPOS_CHAMADO : opcoesLista;
      // valor que a lista não traz: o que o antigo já tem, ou (novo, só B) a categoria nova aplicada com `Usar` e guardada no rascunho; sem a opção o select voltaria a vazio ao recarregar
      const fora = atual || (!antigo && letra === "B" ? String(valores[letra] ?? "") : "");
      const extra = fora && !opcoes.includes(fora) ? [fora] : [];
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
    const inicial = antigo ? (letra === "R" ? encerramentoParaCampo(atual) : atual) : padroesManuais(estado.formulario.find(item => item.numero === numero))[letra] ?? "";
    controle.value = valores[letra] ?? inicial;
    // antigo só recebe o que está vazio; o Status ainda pode ir a FINALIZADO e o R gravado só com a data (sem hora) é redigitado com a hora
    if (antigo && atual && letra !== "D" && !(letra === "R" && !encerramentoParaCampo(atual))) controle.disabled = true;
    if (!antigo && !(letra in valores) && controle.value) guardados[numero] = { ...valores, [letra]: controle.value };
    controle.dataset.sebraeNumero = numero;
    controle.dataset.sebraeCampo = letra;
    controle.dataset.sebraeAlvo = alvo;
    destacarFinalizado(controle);
    controle.addEventListener("input", aoEditar);
    controle.addEventListener("change", aoEditar);
    return controle;
  }

  /**
   * "Título (G)" do chamado novo ou do antigo em aberto: texto livre, sempre editável (G vazio ou preenchido).
   * Vazio mantém o título de hoje. O texto digitado só chega à coluna G da cópia do Dashboard (Atualizar) e ao SharePoint:
   * o SoftExpert acha o chamado pelo número UTIC e nunca recebe o título. O valor inicial não entra no estado; só o que a pessoa digita vira rascunho.
   */
  function campoTitulo(numero: string, alvo = "novo") {
    const controle = document.createElement("input");
    controle.type = "text";
    controle.className = "ck-entrada ck-entrada--sm";
    controle.maxLength = MAX_TITULO;
    controle.autocomplete = "off";
    controle.value = valoresDe(alvo)[numero]?.G ?? tituloOriginal(numero).slice(0, MAX_TITULO); // título original maior que o limite faria o Atualizar voltar 422
    controle.dataset.sebraeNumero = numero;
    controle.dataset.sebraeCampo = "G";
    controle.dataset.sebraeAlvo = alvo;
    controle.addEventListener("input", aoEditar);
    controle.addEventListener("change", aoEditar);
    return campo(ROTULO_TITULO, controle);
  }

  /** O assunto do cartão e o da linha recolhida acompanham o que está sendo digitado em "Título (G)". */
  function mostrarTituloDigitado(controle: ElementoSebrae) {
    const texto = tituloEfetivo(controle.dataset.sebraeNumero as string) || "Sem título";
    controle.closest<ElementoSebrae>("details")?.querySelectorAll<ElementoSebrae>(".sebrae-chamado__assunto, .sebrae-antigo__assunto").forEach(no => { no.textContent = texto; });
  }

  /**
   * R (DT ENCERRAMENTO) de qualquer chamado (novo ou antigo) vira obrigatório quando D é FINALIZADO: `required`, `aria-required` e a ajuda visível.
   * A ajuda fica fora do `<label>` (não entra no nome do campo) e só descreve o campo enquanto aparece.
   */
  function sincronizarEncerramento(manuais: ElementoSebrae | null, numero: string, alvo = "antigo") {
    const ajuda = manuais?.querySelector<ElementoSebrae>(".sebrae-chamado__encerramento-ajuda");
    const controle = manuais?.querySelector<ElementoSebrae>('[data-sebrae-campo="R"]');
    if (!ajuda || !controle) return;
    const item = (alvo === "antigo" ? estado.abertos : estado.formulario).find(aberto => aberto.numero === numero);
    const obrigatorio = encerramentoObrigatorio(item, valoresDe(alvo)[numero]);
    // R antigo gravado só com a data: o campo começa vazio (sem hora inventada) e a ajuda mostra a data gravada
    const semHora = alvo === "antigo" ? ajudaEncerramentoSemHora(item?.valores?.R) : "";
    controle.required = obrigatorio;
    controle.setAttribute("aria-required", String(obrigatorio));
    ajuda.textContent = semHora || AJUDA_ENCERRAMENTO;
    if (obrigatorio || semHora) controle.setAttribute("aria-describedby", ajuda.id);
    else controle.removeAttribute("aria-describedby");
    ajuda.hidden = !(obrigatorio || semHora);
  }

  /** Ajuda "Obrigatório ao finalizar o chamado" do R: com D FINALIZADO a data de encerramento é sempre digitada (regra de 24/11/2026). */
  function ajudaEncerramento(manuais: ElementoSebrae, numero: string, alvo: string) {
    const ajuda = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__encerramento-ajuda", AJUDA_ENCERRAMENTO);
    ajuda.id = `sebrae-encerramento-ajuda-${numero}`;
    manuais.appendChild(ajuda);
    sincronizarEncerramento(manuais, numero, alvo);
  }

  /** Status (D) em FINALIZADO fica verde, para ver de relance quais ainda faltam finalizar. */
  function destacarFinalizado(controle: ElementoSebrae) {
    if (controle.dataset.sebraeCampo === "D") controle.classList.toggle("sebrae-status--finalizado", controle.value === "FINALIZADO");
  }

  /** Valores que valem agora para o chamado: do formulário (novo) ou do Dashboard com as edições não vazias (antigo). */
  function valoresEfetivos(numero: string) {
    if (estado.soft[numero]?.novo) return estado.valores[numero] || {};
    const efetivos = { ...(estado.abertos.find(item => item.numero === numero)?.valores || {}) };
    Object.entries(estado.edicoes[numero] || {}).forEach(([letra, valor]) => { if (String(valor || "").trim()) efetivos[letra] = valor; });
    return efetivos;
  }

  const ROTULOS_MANUAIS = Object.freeze({
    A: "Responsável (A) *", B: "Categoria (B)", D: "Status (D) *", J: "Tipo do chamado (J) *",
    R: "Encerramento (R)", S: "Tipo SLA (S)",
  });
  const ROTULO_TITULO = "Título (G)"; // campo à parte dos manuais: texto livre de até MAX_TITULO, sem lista de sugestões

  /** Título do SoftExpert (novo) ou do Dashboard/leitura (antigo), antes de qualquer edição em "Título (G)". */
  function tituloOriginal(numero: string) {
    const antigo = estado.abertos.find(item => item.numero === numero);
    if (antigo) return dadosAntigo(antigo).titulo;
    return String(estado.formulario.find(item => item.numero === numero)?.linha?.G ?? "").trim();
  }

  /** Título que vale agora: o digitado em "Título (G)" (se não estiver vazio) ou o original. */
  function tituloEfetivo(numero: string) {
    const guardados = estado.abertos.some(item => item.numero === numero) ? estado.edicoes : estado.valores;
    return String(guardados[numero]?.G ?? "").trim() || tituloOriginal(numero);
  }

  /** Cartão do chamado como está na tela agora, guardado no servidor para reaparecer em "Chamados finalizados". */
  function montarFicha(numero: string) {
    const antigo = estado.abertos.find(item => item.numero === numero);
    const novo = estado.formulario.find(item => item.numero === numero);
    const cortar = (texto: unknown) => String(texto || "").slice(0, 4000);
    let titulo: unknown, solicitante: unknown, fatos: unknown[][], detalhes: unknown[][] = [];
    if (antigo) {
      const dados = dadosAntigo(antigo);
      [titulo, solicitante] = [tituloEfetivo(numero), dados.solicitante];
      fatos = [["Solicitante", dados.solicitante], ["Abertura", dados.abertura],
        ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => [rotulo, antigo.automaticos?.[letra] || antigo.automaticos_sugeridos?.[letra]])];
      detalhes = [["Descrição", dados.descricao], ["Atendimento realizado", dados.atendimento]];
    } else if (novo) {
      [titulo, solicitante] = [tituloEfetivo(numero), novo.linha.I];
      fatos = CAMPOS_AUTOMATICOS.map(([letra, rotulo]) => [rotulo, novo.linha[letra]]);
      detalhes = [["Descrição", novo.linha.H], ["Atendimento realizado", novo.linha.F]];
    } else return null;
    const efetivos = valoresEfetivos(numero);
    const manuais = Object.fromEntries(["A", "B", "D", "J", "S"].map(letra => [letra, String(efetivos[letra] || "").slice(0, 80)])); // R fica fora da ficha: o R é sempre o digitado e vai no próprio pedido
    const limpar = (lista: unknown[][]) => lista.filter(([, valor]) => String(valor || "").trim()).map(([rotulo, valor]) => [rotulo, cortar(valor)]);
    return { titulo: cortar(titulo), solicitante: cortar(solicitante), fatos: limpar(fatos), detalhes: limpar(detalhes), manuais };
  }

  /** Falha aqui só deixa o cartão finalizado sem a ficha completa; nunca impede a finalização. */
  async function guardarFicha(numero: string) {
    const ficha = montarFicha(numero);
    if (!ficha) return;
    try {
      await app.apiFetch(urlChamado(numero, "ficha"), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ficha }),
        errorMessage: "Não foi possível guardar a ficha do chamado.",
      });
    } catch (_erro) {
      // o cartão finalizado mostra então só número, encerramento e descrição
    }
  }

  function controleLeitura(letra: string, valor?: string) {
    const controle = document.createElement("input");
    controle.type = "text";
    controle.className = "ck-entrada ck-entrada--sm";
    controle.value = valor || "";
    controle.disabled = true;
    controle.dataset.sebraeCampo = letra;
    destacarFinalizado(controle);
    return controle;
  }

  // ---- Layout do cartão em três zonas: Solicitação (só leitura), Classificação operacional (manual) e Finalização no SoftExpert ----

  /** Zona do cartão: `div` agrupado com título e selo. `destaque` = faixa de aviso da finalização; `aviso` = frase sob o título. */
  function criarZona(sufixo: string, titulo: string, selo: string, { destaque = false, aviso = "", classe = "" }: { destaque?: boolean; aviso?: string; classe?: string } = {}) {
    const zona = document.createElement("div");
    zona.className = `sebrae-zona sebrae-zona--${sufixo}${classe ? ` ${classe}` : ""}`;
    zona.setAttribute("role", "group");
    zona.setAttribute("aria-label", titulo);
    const cab = document.createElement("div");
    cab.className = `sebrae-zona__cab${destaque ? " sebrae-zona__cab--aviso" : ""}`;
    cab.append(dom.createTextElement("h4", "sebrae-zona__titulo", titulo), dom.createTextElement("span", "sebrae-zona__selo", selo));
    if (aviso) cab.appendChild(dom.createTextElement("p", "sebrae-zona__aviso", aviso));
    zona.appendChild(cab);
    return zona;
  }

  /** Cabeçalho do cartão: recolher, título (número · assunto) e selo de situação (`data-status`: info = Novo, vazio = Em aberto, ok = Finalizado). */
  function cabecalhoChamado(titulo: ElementoSebrae, seloTexto: string, seloStatus: string) {
    const cab = document.createElement("header");
    cab.className = "sebrae-chamado__cab";
    const selo = dom.createTextElement("span", "ck-badge sebrae-chamado__selo", seloTexto);
    selo.dataset.status = seloStatus;
    // Todo cartão daqui mora numa linha `details`: aberto, a linha some (CSS) e recolher passa a este botão.
    const recolher = document.createElement("button");
    recolher.type = "button";
    recolher.className = "sebrae-chamado__recolher";
    recolher.setAttribute("aria-expanded", "true");
    recolher.setAttribute("aria-label", "Recolher chamado");
    recolher.appendChild(iconePendencia("i-chevron-up", ""));
    recolher.addEventListener("click", () => {
      const linha = recolher.closest<ElementoSebrae>("details");
      if (!linha) return;
      linha.open = false;
      linha.querySelector<ElementoSebrae>("summary")?.focus();
    });
    cab.append(recolher, titulo, selo);
    return cab;
  }

  /** Liga a linha recolhida: guarda os Novos abertos entre recargas e, só quando a pessoa abriu, leva o foco ao botão Recolher. */
  function ligarLinha(detalhe: ElementoSebrae, resumo: ElementoSebrae, numero: string) {
    resumo.addEventListener("click", () => abertosPelaPessoa.add(detalhe));
    detalhe.addEventListener("toggle", () => {
      const pelaPessoa = abertosPelaPessoa.delete(detalhe);
      // um chamado aberto por vez nas três listas; linha já fora da tela (lista redesenhada) não é fechada
      if (detalhe.open) {
        if (linhaAberta !== detalhe && linhaAberta?.isConnected && linhaAberta.open) linhaAberta.open = false;
        linhaAberta = detalhe;
      }
      if (detalhe.className === "sebrae-novo" && visao.novosAbertos) visao.novosAbertos[detalhe.open ? "add" : "delete"](numero);
      if (detalhe.open && pelaPessoa) detalhe.querySelector<ElementoSebrae>(".sebrae-chamado__recolher")?.focus();
    });
  }

  /** Cartão vazio: `article.sebrae-chamado--novo|antigo|finalizado` com o cabeçalho; as zonas são acrescentadas por quem chama. */
  function cartaoChamado(numero: string, tipo: string, titulo: ElementoSebrae, seloTexto: string, seloStatus: string) {
    const artigo = document.createElement("article");
    artigo.className = `sebrae-chamado sebrae-chamado--${tipo}${estado.destaques[numero] ? " sebrae-chamado--destaque" : ""}`;
    artigo.dataset.numero = numero;
    const cab = cabecalhoChamado(titulo, seloTexto, seloStatus);
    cab.appendChild(seloDestaque(numero));
    artigo.appendChild(cab);
    if (tipo === "novo" || tipo === "antigo") artigo.appendChild(etapasChamado(numero, tipo === "novo" ? 1 : 2));
    return artigo;
  }

  const ETAPAS = ["Aberto", "Em andamento", "Finalizado"];
  /** Cartão "Etapas do chamado": 01 Aberto, 02 Em andamento, 03 Finalizado. Só mostra; novo = etapa 1, antigo em aberto = etapa 2. */
  function etapasChamado(numero: string, atual: number) {
    const cartao = document.createElement("div");
    cartao.className = "sebrae-etapas";
    const cab = document.createElement("div");
    cab.className = "sebrae-etapas__cab";
    cab.append(dom.createTextElement("span", "sebrae-etapas__titulo", "Etapas do chamado"), dom.createTextElement("span", "sebrae-etapas__numero", numero));
    const passos = document.createElement("ol");
    passos.className = "sebrae-etapas__passos";
    ETAPAS.forEach((rotulo, i) => {
      const passo = document.createElement("li");
      passo.className = "sebrae-etapa";
      passo.dataset.estado = i + 1 < atual ? "feito" : i + 1 === atual ? "atual" : "futuro";
      if (i + 1 === atual) passo.setAttribute("aria-current", "step");
      passo.append(dom.createTextElement("span", "sebrae-etapa__n", `0${i + 1}`), dom.createTextElement("span", "sebrae-etapa__rotulo", rotulo));
      passos.appendChild(passo);
    });
    cartao.append(cab, passos, dom.createTextElement("p", "sebrae-etapas__resumo", `Etapa ${atual} de ${ETAPAS.length} · ${ETAPAS[atual - 1]}`));
    return cartao;
  }

  /** Zona 1: fatos, avisos e blocos de texto (Descrição, Atendimento), tudo só leitura. */
  function zonaSolicitacao(fatos: ElementoSebrae | null, notas: ElementoSebrae[], detalhes: ElementoSebrae[]) {
    const zona = criarZona("solicitacao", "Solicitação", "Somente leitura");
    zona.append(...([fatos, ...notas].filter(Boolean) as ElementoSebrae[]));
    if (detalhes.length) {
      const bloco = document.createElement("div");
      bloco.className = "sebrae-chamado__detalhes";
      bloco.append(...detalhes);
      zona.appendChild(bloco);
    }
    return zona;
  }

  /** Zona 2: os seis campos manuais (A, B, D, J, R, S) e a observação interna do andamento. */
  function zonaClassificacao(manuais: ElementoSebrae, observacao: ElementoSebrae | null = null, numero = "") {
    const zona = criarZona("classificacao", "Classificação operacional", "Preenchimento manual");
    zona.appendChild(manuais);
    if (observacao) zona.appendChild(observacao);
    if (numero) zona.appendChild(blocoDestaque(numero)); // também no finalizado, onde a observação é só leitura
    return zona;
  }

  /** Número da OS como botão: abre a janela Chamado × OS (cartão do chamado ao lado da OS da aba OS). Só navegação e leitura. */
  function valorOs(os: unknown, serie: unknown, sufixo = "", chamado = "") {
    const botao = dom.createTextElement("button", "sebrae-chamado__os", os);
    botao.type = "button";
    botao.setAttribute("aria-label", `Abrir a OS ${os} na janela Chamado × OS`);
    botao.addEventListener("click", () => app.abrirJanelaChamadoOs?.({ chamado, serie, os }, botao));
    const dd = document.createElement("dd");
    dd.append(botao, sufixo);
    return dd;
  }

  /**
   * Campo OS do cartão aberto de um antigo. Com sugestão a decidir, o botão da OS atual ganha "mais nova: 7400000?" ao lado;
   * sem OS na linha, o campo diz "sem OS sugerida: 7400000?". É só texto: Aceitar e Recusar ficam na caixa da sugestão.
   */
  function campoOs(valor: string, serie: unknown, sufixo: string, chamado: string, osNova: OsNova | null) {
    const dd = valor ? valorOs(valor, serie, sufixo, chamado) : document.createElement("dd");
    if (!osNova) return dd;
    const { semOs, legenda, sugerida } = legendaCampoOs(osNova);
    if (semOs && !valor) dd.append(dom.createTextElement("span", "sebrae-osnova-campo__sem", "sem OS"));
    dd.append(" ", dom.createTextElement("span", "sebrae-osnova-campo__legenda", legenda), " ", dom.createTextElement("strong", "sebrae-osnova-campo__os", sugerida));
    dd.className = "sebrae-osnova-campo";
    return dd;
  }

  /** `leitura`: a OS vira texto (cartão da própria janela Chamado × OS). */
  function listaFatos(pares: unknown[][], serie = "", chamado = "", leitura = false) {
    const fatos = document.createElement("dl");
    fatos.className = "ck-fatos sebrae-chamado__auto";
    pares.forEach(([rotulo, valor]) => {
      const linha = document.createElement("div");
      const ehOs = !leitura && rotulo === "OS" && valor && valor !== "—";
      linha.append(dom.createTextElement("dt", "", rotulo), ehOs ? valorOs(valor, serie, "", chamado) : dom.createTextElement("dd", "", valor));
      fatos.appendChild(linha);
    });
    return fatos;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  /** Ícone do sprite da página (`#i-pendente`, `#i-ok`); o CSS mostra um ou outro conforme o campo esteja preenchido. */
  function iconePendencia(id: string, classe: string) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", `ck-ico ck-ico--xs ${classe}`);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const uso = document.createElementNS(SVG_NS, "use");
    uso.setAttribute("href", `#${id}`);
    svg.appendChild(uso);
    return svg;
  }

  /** Selo "o que falta": quem decide pendente/ok é só o CSS (`:has` nos campos do cartão); o JS não guarda esse estado. */
  function pendenciaItem(requisito: string, rotulo: string) {
    const li = document.createElement("li");
    li.className = "sebrae-pend";
    li.dataset.req = requisito;
    li.append(
      iconePendencia("i-pendente", "sebrae-pend__falta"), iconePendencia("i-ok", "sebrae-pend__ok"), rotulo,
      dom.createTextElement("span", "ck-sr sebrae-pend__falta", ": pendente"), dom.createTextElement("span", "ck-sr sebrae-pend__ok", ": ok"),
    );
    return li;
  }

  function listaPendencias() {
    const lista = document.createElement("ul");
    lista.className = "sebrae-pendencias";
    lista.setAttribute("aria-label", "O que falta para finalizar");
    // Sem `data-req`: o CSS não sabe se um datetime-local está vazio; o clique em Finalizar confere o R (camposFaltando).
    const encerramento = dom.createTextElement("li", "sebrae-pend sebrae-pend--encerramento", "Encerramento (R): obrigatório");
    encerramento.title = "Informe a data e a hora de encerramento (ou clique em Agora); o sistema nunca preenche sozinho";
    lista.append(
      dom.createTextElement("li", "sebrae-pendencias__rotulo", "Para finalizar:"),
      pendenciaItem("A", ROTULOS_FALTA.A), pendenciaItem("D", "Status (D) em FINALIZADO"), pendenciaItem("J", ROTULOS_FALTA.J), pendenciaItem("DESC", "Descrição"),
      encerramento,
    );
    return lista;
  }

  /** Mesmo layout do chamado, só leitura, recolhido: o resumo diz número, título, pessoa e encerramento. */
  function textoFinalizado(item: Registro) {
    const ficha = item.ficha || {};
    const pares = (valor: unknown): string[][] => Array.isArray(valor)
      ? valor.filter((par: unknown) => Array.isArray(par) && par.length === 2 && par.every((texto: unknown) => typeof texto === "string")) : [];
    const fatos = pares(ficha.fatos);
    const detalhes = pares(ficha.detalhes);
    const li = document.createElement("li");
    const detalhe = document.createElement("details");
    detalhe.className = "sebrae-finalizado";
    detalhe.dataset.numero = item.numero;
    const encerramento = item.encerrado_em ? `encerrado em ${item.encerrado_em}` : "";
    const resumo = document.createElement("summary");
    resumo.className = "sebrae-finalizado__resumo";
    const textoResumo = [item.numero, ficha.titulo, ficha.solicitante, encerramento].filter(Boolean).join(" · ");
    if (item.status === STATUS_OUTRO_TECNICO) {
      // dentro do mesmo item da grade do resumo: o texto e o selo seguem juntos, sem coluna nova
      const selo = dom.createTextElement("span", "ck-badge sebrae-selo", "Finalizado por outro técnico");
      selo.dataset.status = "info";
      const bloco = document.createElement("span");
      bloco.append(textoResumo, " ", selo);
      resumo.append(bloco, seloDestaque(item.numero));
    } else resumo.append(textoResumo, seloDestaque(item.numero));
    detalhe.appendChild(resumo);
    ligarLinha(detalhe, resumo, item.numero);
    const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
    titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", ficha.titulo || "Sem título"));
    const artigo = cartaoChamado(item.numero, "finalizado", titulo, "Finalizado", "ok");
    const serieFicha = fatos.find(([rotulo]) => rotulo === "Série")?.[1] || "";
    artigo.appendChild(zonaSolicitacao(fatos.length ? listaFatos(fatos, serieFicha, item.numero) : null, [],
      detalhes.map(([rotulo, texto]) => blocoDetalhe(rotulo, texto, rotulo === "Descrição"))));
    const manuais = document.createElement("div");
    manuais.className = "sebrae-chamado__manuais";
    ["A", "B", "D", "J", "R", "S"].forEach(letra => {
      const valor = letra === "R" ? item.encerrado_em : letra === "D" ? "FINALIZADO" : ficha.manuais?.[letra];
      manuais.appendChild(campo(ROTULOS_MANUAIS[letra as keyof typeof ROTULOS_MANUAIS], controleLeitura(letra, valor)));
    });
    artigo.appendChild(zonaClassificacao(manuais, blocoObservacao(item.numero, item.observacao, true), item.numero));
    // Zona 3 concluída: sem pendências nem botões, só a descrição enviada, o PDF e o resultado.
    const zonaFinal = criarZona("finalizacao", "Finalização no SoftExpert", "Concluída", { destaque: true });
    const descricao = document.createElement("textarea");
    descricao.className = "ck-entrada";
    descricao.rows = 3;
    descricao.readOnly = true;
    descricao.placeholder = " ";
    descricao.dataset.sebraeDescricao = item.numero;
    descricao.value = item.descricao || "";
    const colTexto = document.createElement("div");
    colTexto.className = "sebrae-final__texto";
    colTexto.appendChild(campo("Descrição para Finalizar o Chamado", descricao));
    const colAnexo = document.createElement("div");
    colAnexo.className = "sebrae-final__anexo";
    const pdf = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__pdf", item.pdf ? `PDF anexado: ${item.pdf}` : "Nenhum PDF anexado.");
    if (item.pdf) pdf.setAttribute("data-anexado", ""); // o CSS faz dele o selo verde "PDF anexado"
    colAnexo.appendChild(pdf);
    if (item.pdf_remocao_pendente) {
      const tentar = document.createElement("button");
      tentar.type = "button";
      tentar.className = "ck-btn ck-btn--fantasma ck-btn--sm";
      tentar.textContent = "Tentar remover novamente o PDF antigo";
      tentar.dataset.sebraePdfRemocao = item.numero;
      const feedback = dom.createTextElement("p", "ck-campo__ajuda", "Remoção de PDF pendente.");
      feedback.setAttribute("role", "status");
      tentar.addEventListener("click", async () => {
        tentar.disabled = true;
        try {
          await app.apiFetch(urlChamado(item.numero, "anexo") + "?somente_pendentes=true", { method: "DELETE", errorMessage: "Não foi possível remover o PDF antigo." });
          tentar.hidden = true;
          feedback.textContent = "PDF antigo removido.";
        } catch (falha) { const error = falha as ErroApi; feedback.textContent = error.message; }
        finally { tentar.disabled = false; }
      });
      colAnexo.append(tentar, feedback);
    }
    const quando = formatarDataHora(item.em);
    const resultado = dom.createTextElement("p", "ck-cartao__meta sebrae-chamado__resultado", `${textoResultado({ status: item.status === STATUS_OUTRO_TECNICO ? STATUS_OUTRO_TECNICO : "ok", encerrado_em: item.encerrado_em })}${quando ? ` · ${quando}` : ""}`);
    resultado.dataset.estado = "ok";
    const rodape = document.createElement("div");
    rodape.className = "sebrae-final__rodape";
    rodape.appendChild(resultado);
    if (item.status === STATUS_OUTRO_TECNICO) rodape.appendChild(botaoDesfazerOutroTecnico(item.numero));
    const corpo = document.createElement("div");
    corpo.className = "sebrae-final__corpo";
    corpo.append(colTexto, colAnexo, rodape);
    zonaFinal.appendChild(corpo);
    artigo.appendChild(zonaFinal);
    detalhe.appendChild(artigo);
    li.appendChild(detalhe);
    return li;
  }

  /** Desfaz só o registro local "finalizado por outro técnico" (pedido do usuário, 13/11/2026): o chamado volta aos abertos para corrigir D e R. */
  function botaoDesfazerOutroTecnico(numero: string) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "ck-btn ck-btn--fantasma ck-btn--sm";
    botao.textContent = "Desfazer finalização";
    botao.dataset.sebraeDesfazerOutroTecnico = numero;
    botao.addEventListener("click", async () => {
      const confirmado = await app.confirmarAcao({
        titulo: "Desfazer finalização",
        mensagem: `Desfazer a finalização de ${numero} registrada como feita por outro técnico? Só os dados locais mudam: o chamado volta para os abertos e o SharePoint não é revertido.`,
        confirmar: "Desfazer finalização", cancelar: "Cancelar",
      });
      if (!confirmado) return;
      botao.disabled = true;
      try {
        await app.apiFetch("/api/sebrae/finalizacao/desfazer-outro-tecnico", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numero, confirmado: true }),
          errorMessage: "Não foi possível desfazer a finalização.",
        });
      } catch (falha) { const error = falha as ErroApi;
        botao.disabled = false;
        app.showToast(error.message, "error");
        return;
      }
      app.showToast("Finalização desfeita: o chamado voltou para os abertos. Corrija D e R no cartão e use Atualizar.", "success");
      carregarNovosSebrae();
    });
    return botao;
  }

  /** Cópia só leitura do cartão do F5 para a janela Chamado × OS: zonas 1 e 2 sem lápis nem campos editáveis, sem a zona 3.
   * `chave` = número do chamado (ou a chave `linha:N` do antigo sem UTIC único). Nada é gravado; null quando não acha. */
  async function cartaoChamadoSebraeLeitura(chave: string) {
    const alvo = String(chave ?? "").trim();
    if (!alvo) return null;
    if (!estado.formulario.length && !estado.abertos.length && !estado.finalizadosItens.length) await carregarNovosSebrae();
    const igual = (item: Registro) => String(item.numero ?? "") === alvo;
    const fin = estado.finalizadosItens.find(igual);
    const novo = fin ? null : estado.formulario.find(igual);
    const antigo = fin || novo ? null : estado.abertos.find(igual)
      || estado.abertos.find(item => String(item.numero ?? "").startsWith("linha:") && String(item.chamado ?? "").trim() === alvo);
    const item = fin || novo || antigo;
    const ficha = fin ? fin.ficha || {} : item ? montarFicha(item.numero) : null;
    if (!ficha || !item) return null;
    const pares = (valor: unknown): string[][] => Array.isArray(valor)
      ? valor.filter((par: unknown) => Array.isArray(par) && par.length === 2 && par.every((texto: unknown) => typeof texto === "string")) : [];
    const fatos = pares(ficha.fatos);
    const valores = fin ? { ...ficha.manuais, D: "FINALIZADO", R: fin.encerrado_em }
      : antigo ? valoresEfetivos(antigo.numero) : { ...padroesManuais(novo), ...estado.valores[novo!.numero] };
    const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", antigo ? tituloAntigo(antigo) : item.numero);
    titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", ficha.titulo || "Sem título"));
    const [tipo, seloTexto, seloStatus] = fin ? ["finalizado", "Finalizado", "ok"] : antigo ? ["antigo", "Em aberto", ""] : ["novo", "Novo", "info"];
    const artigo = cartaoChamado(item.numero, tipo, titulo, seloTexto, seloStatus);
    artigo.querySelector<ElementoSebrae>(".sebrae-chamado__recolher")?.remove();
    delete artigo.dataset.numero; // a cópia não é o cartão do F5: quem procura `article[data-numero]` acha só o original
    artigo.dataset.serie = fatos.find(([rotulo]) => rotulo === "Série")?.[1] || "";
    artigo.dataset.os = fatos.find(([rotulo]) => rotulo === "OS")?.[1] || "";
    const manuais = document.createElement("div");
    manuais.className = "sebrae-chamado__manuais";
    ["A", "B", "D", "J", "R", "S"].forEach(letra => {
      const valor = valores[letra];
      manuais.appendChild(campo(ROTULOS_MANUAIS[letra as keyof typeof ROTULOS_MANUAIS], controleLeitura(letra, letra === "R" ? formatarEncerramento(valor) || valor : valor)));
    });
    const observacao = fin ? fin.observacao : estado.observacoes[item.numero]?.textarea?.value ?? item.observacao;
    artigo.append(zonaSolicitacao(fatos.length ? listaFatos(fatos, "", "", true) : null, [], pares(ficha.detalhes).map(([rotulo, texto]) => blocoDetalhe(rotulo, texto))),
      zonaClassificacao(manuais, blocoObservacao(item.numero, observacao, true)));
    return artigo;
  }

  /**
   * Senha do chamado (exceção de LGPD autorizada em 19/11/2026): só o botão fica na tela; o valor vem do servidor no clique
   * e sai do DOM ao ocultar, para nenhuma leitura da página (snapshot de automação inclusive) vê-lo sem a pessoa pedir.
   */
  function blocoSenha(numero: string) {
    const bloco = document.createElement("div");
    bloco.className = "sebrae-senha";
    bloco.setAttribute("role", "group");
    bloco.setAttribute("aria-label", "Senha do chamado");
    const botao = dom.createTextElement("button", "ck-btn ck-btn--fantasma ck-btn--sm sebrae-senha__mostrar", "Mostrar senha");
    botao.type = "button";
    botao.setAttribute("aria-expanded", "false");
    const lista = document.createElement("ul");
    lista.className = "sebrae-senha__lista";
    const ocultar = () => {
      lista.replaceChildren();
      botao.textContent = "Mostrar senha";
      botao.setAttribute("aria-expanded", "false");
    };
    botao.addEventListener("click", async () => {
      if (botao.getAttribute("aria-expanded") === "true") return ocultar();
      botao.disabled = true;
      try {
        const dados = await app.apiFetch(urlChamado(numero, "credenciais"), { errorMessage: "Não foi possível consultar a senha do chamado." });
        const valores: string[] = Array.isArray(dados?.credenciais) ? dados.credenciais.map(String) : [];
        if (!valores.length) {
          app.showToast(`${numero}: nenhuma senha guardada.`, "warning");
          return;
        }
        lista.replaceChildren(...valores.map((valor, indice) => {
          const linha = document.createElement("li");
          const copiar = dom.createTextElement("button", "ck-btn ck-btn--fantasma ck-btn--sm sebrae-senha__copiar", "Copiar");
          copiar.type = "button";
          if (valores.length > 1) copiar.setAttribute("aria-label", `Copiar senha ${indice + 1}`);
          copiar.addEventListener("click", async () => {
            try {
              await app.copiarTextoParaAreaTransferencia(valor);
              app.showToast("Senha copiada.", "success");
            } catch (_erro) {
              app.showToast("Não foi possível copiar a senha.", "error");
            }
          });
          linha.append(dom.createTextElement("code", "sebrae-senha__valor", valor), " ", copiar);
          return linha;
        }));
        botao.textContent = "Ocultar senha";
        botao.setAttribute("aria-expanded", "true");
      } catch (error) {
        app.showToast((error as Error).message, "error");
      } finally {
        botao.disabled = false;
      }
    });
    bloco.append(botao, lista);
    return bloco;
  }

  /** Bloco "Descrição" / "Atendimento realizado" (novo, antigo lido e finalizado), recolhido. Com `direta` (a Descrição dos cartões do F5) o texto fica à mostra
   * e inteiro, sem corte nem botão de expandir: o `details` fica sempre aberto e o `summary` vira só o rótulo, sem alternar. A cópia só leitura da janela Chamado × OS não usa `direta`. */
  function blocoDetalhe(rotulo: string, texto: string, direta = false) {
    const detalhe = document.createElement("details");
    detalhe.className = "sebrae-chamado__texto";
    const resumo = dom.createTextElement("summary", "", rotulo);
    detalhe.append(resumo, dom.createTextElement("p", "", texto || "Vazio"));
    if (!direta) return detalhe;
    detalhe.open = true;
    detalhe.className += " sebrae-chamado__texto--direto";
    resumo.setAttribute("tabindex", "-1");
    resumo.addEventListener("click", evento => evento.preventDefault());
    return detalhe;
  }

  /** Bloco "Descrição" com lápis (F5): o texto vale neste site e vai à coluna H da cópia do Dashboard no próximo "Atualizar Dashboard"
   * (linha nova ou antigo em aberto com UTIC); o SoftExpert nunca o recebe. Texto vazio restaura o original só no site: não apaga nem desfaz um H já enviado.
   * `aplicar(dados)` atualiza o item em memória (ficha e cartão); nome e cruzamento se refazem ao recarregar. */
  function blocoDescricaoEditavel(item: Registro, texto: string, aplicar: (dados: Registro) => unknown) {
    const numero = item.numero;
    let atual = texto || "";
    let editada = Boolean(item.softexpert?.descricao_editada);
    const detalhe = blocoDetalhe("Descrição", atual, true);
    const resumo = detalhe.querySelector<ElementoSebrae>("summary")!;
    const paragrafo = detalhe.querySelector<ElementoSebrae>("p")!;
    const selo = dom.createTextElement("span", "ck-badge sebrae-selo sebrae-descricao__selo", "Editada");
    selo.dataset.status = "info";
    const lapis = document.createElement("button");
    lapis.type = "button";
    lapis.className = "ck-btn ck-btn--fantasma ck-btn--sm sebrae-descricao__lapis";
    lapis.title = "Editar descrição";
    lapis.setAttribute("aria-label", `Editar descrição de ${numero}`);
    lapis.setAttribute("aria-expanded", "false");
    lapis.dataset.sebraeEditarDescricao = numero;
    lapis.appendChild(iconePendencia("i-pencil", ""));
    resumo.appendChild(selo);
    const entrada = document.createElement("textarea");
    entrada.className = "ck-entrada";
    entrada.rows = 5;
    entrada.maxLength = MAX_DESCRICAO;
    entrada.placeholder = "Vazio volta ao texto original do chamado.";
    entrada.setAttribute("aria-label", `Descrição de ${numero}`);
    entrada.dataset.sebraeDescricaoEditada = numero;
    const criarBotao = (rotulo: string, classe: string, chave: string) => {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.className = `ck-btn ${classe} ck-btn--sm`;
      botao.textContent = rotulo;
      botao.dataset[chave] = numero;
      return botao;
    };
    const salvar = criarBotao("Salvar", "ck-btn--primario", "sebraeSalvarDescricao");
    const cancelar = criarBotao("Cancelar", "ck-btn--secundario", "sebraeCancelarDescricao");
    const restaurar = criarBotao("Restaurar original", "ck-btn--fantasma", "sebraeRestaurarDescricao");
    const acoes = document.createElement("div");
    acoes.className = "sebrae-chamado__acoes";
    acoes.append(salvar, cancelar, restaurar);
    const editor = document.createElement("div");
    editor.className = "sebrae-descricao__editor";
    editor.hidden = true;
    editor.append(entrada, acoes);
    const feedback = dom.createTextElement("span", "sebrae-descricao__feedback", "");
    feedback.setAttribute("role", "status");
    detalhe.append(editor, feedback);
    const mostrarEstado = () => { selo.hidden = !editada; restaurar.hidden = !editada; };
    // `sujo`: texto digitado e ainda não salvo; a recarga da lista espera (um cartão novo fecharia o editor e perderia o texto)
    entrada.addEventListener("input", () => { editor.dataset.sujo = "true"; });
    const abrirEditor = (aberto: boolean) => {
      delete editor.dataset.sujo;
      editor.hidden = !aberto;
      paragrafo.hidden = aberto;
      lapis.setAttribute("aria-expanded", String(aberto));
    };
    mostrarEstado();
    lapis.addEventListener("click", evento => {
      detalhe.open = true;
      entrada.value = atual;
      definirFeedback(feedback, "");
      abrirEditor(true);
      entrada.focus();
    });
    cancelar.addEventListener("click", () => { abrirEditor(false); lapis.focus(); });
    const enviar = async (novoTexto: string) => {
      [salvar, cancelar, restaurar].forEach(botao => { botao.disabled = true; });
      definirFeedback(feedback, "Salvando…", "salvando");
      try {
        const dados = await app.apiFetch(urlChamado(numero, "descricao"), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ descricao: novoTexto }),
          errorMessage: "Não foi possível salvar a descrição.",
        });
        atual = dados.descricao || "";
        editada = Boolean(dados.descricao_editada);
        paragrafo.textContent = atual || "Vazio";
        aplicar(dados);
        mostrarEstado();
        abrirEditor(false);
        definirFeedback(feedback, editada
          ? "Descrição salva. Vai à coluna H do Dashboard em Atualizar Dashboard; o SoftExpert não recebe esse texto."
          : "Descrição original restaurada neste site. Um H já enviado ao Dashboard não é desfeito.", "ok");
        lapis.focus();
      } catch (falha) { const error = falha as ErroApi;
        definirFeedback(feedback, `Não foi possível salvar: ${error.message}`, "erro");
      } finally {
        [salvar, cancelar, restaurar].forEach(botao => { botao.disabled = false; });
      }
    };
    salvar.addEventListener("click", () => enviar(entrada.value));
    restaurar.addEventListener("click", () => enviar(""));
    // O lápis fica ao lado do <details>, não dentro do <summary>: botão dentro de summary é "nested-interactive" no axe.
    const envoltorio = document.createElement("div");
    envoltorio.className = "sebrae-descricao";
    envoltorio.append(lapis, detalhe); // lápis primeiro: a ordem do Tab segue a tela (canto superior direito do cabeçalho)
    return envoltorio;
  }

  /** Guarda no item em memória o que o servidor devolveu ao editar a descrição (flag do estado local e o texto que o cartão mostra). */
  function marcarDescricaoEditada(item: Registro, dados: Registro) {
    item.softexpert = { ...(item.softexpert || {}), descricao_editada: dados.descricao_editada || "" };
  }

  /** Selo de leitura do resumo: só chamado com UTIC pode ser lido no SoftExpert; sem UTIC nada é prometido. */
  function seloLeitura(item: Registro, dados: Registro) {
    if (!NUMERO_UTIC.test(item.numero)) return null;
    const selo = dom.createTextElement("span", "ck-badge sebrae-selo", dados.lido ? "Lido" : dados.naoEncontrado ? "Não encontrado" : "Não lido");
    selo.dataset.status = dados.lido ? "info" : dados.naoEncontrado ? "laranja" : "";
    return selo;
  }

  /** Selo `OS`: só aparece quando o chamado tem OS vinculada (E gravado ou sugerido); o número vai no `title`. */
  function seloOs(os: string) {
    if (!os || os === "—") return null;
    const selo = dom.createTextElement("span", "ck-badge sebrae-selo sebrae-selo-os", "OS");
    selo.dataset.status = "ok";
    selo.title = `OS ${os}`;
    return selo;
  }

  /**
   * Decisão de OS que o chamado espera (cartão rosa, `data-os-decidir`): `nova` com a caixa Aceitar/Manter ou Recusar, `sem-relacao` com o
   * aviso Manter/Remover (o mesmo `!item.os_nova` cru de `montar`: a troca mostra só a nota). Chamar depois de `hostSugestaoOs`, que apaga
   * a decisão antiga de outra OS.
   */
  function osDecidir(item: Registro): "nova" | "sem-relacao" | null {
    if (context.sugestaoOs?.temDecisao(item.numero)) return null;
    if (pedeDecisao(item.os_nova)) return "nova";
    return !item.os_nova && item.os_sem_relacao ? "sem-relacao" : null;
  }

  /** Selo rosa da linha recolhida enquanto a decisão espera: `OS nova?` (a troca automática já foi feita e não ganha selo) ou `OS sem relação?`. */
  function seloOsDecidir(item: Registro, decidir: ReturnType<typeof osDecidir>) {
    if (!decidir) return null;
    const nova = decidir === "nova";
    const selo = dom.createTextElement("span", `ck-badge sebrae-selo sebrae-selo-os-decidir ${nova ? "sebrae-selo-os-nova" : "sebrae-selo-os-sem-relacao"}`, nova ? SELO_OS_NOVA : SELO_OS_SEM_RELACAO);
    selo.dataset.status = "info";
    selo.title = `OS ${nova ? item.os_nova.nova.os : item.os_sem_relacao?.atual.os}`;
    return selo;
  }

  /**
   * Host da caixa React "OS nova sugerida" e do aviso "OS sem relação" (`sugestao-os.tsx`). Este arquivo só cria o
   * `<div data-sugestao-os>` e o entrega; nunca escreve dentro dele. Sem sugestão, aviso nem decisão guardada, não há host.
   */
  function hostSugestaoOs(item: Registro) {
    const painel = context.sugestaoOs;
    if (!painel || (!item.os_nova && !item.os_sem_relacao && !painel.temDecisao(item.numero))) return null;
    const host = document.createElement("div");
    host.setAttribute("data-sugestao-os", "");
    painel.montar(host, { numero: item.numero, osNova: item.os_nova || null, osSemRelacao: item.os_sem_relacao || null, recarregar: () => recarregarOsNova(item.numero) });
    return host;
  }

  /** Depois de Aceitar, Recusar, Manter ou Remover: recarrega o F5, reabre o cartão (a linha é refeita recolhida) e leva o foco à nota. */
  async function recarregarOsNova(numero: string) {
    await carregarNovosSebrae();
    const artigo = mostrarChamadoSebrae(numero);
    artigo?.querySelector("[data-sugestao-os] [data-nota-os]")?.focus();
  }

  /** Selos automáticos do resumo: ficam escondidos e o CSS mostra o que vale agora (D FINALIZADO, pronto, andamento, atenção, erro). */
  function selosAutomaticos() {
    return [
      ["d", "ok", "D: FINALIZADO"], ["pronto", "info", "Pronto para finalizar"], ["andamento", "info", "Finalizando…"],
      ["atencao", "alerta", "Ver resultado"], ["erro", "erro", "Falhou"],
    ].map(([sufixo, status, texto]) => {
      const selo = dom.createTextElement("span", `ck-badge sebrae-selo sebrae-selo--auto sebrae-selo--${sufixo}`, texto);
      selo.dataset.status = status;
      return selo;
    });
  }

  /** Item da lista de antigos: `details` recolhido; o resumo mostra número, assunto, pessoa e selos, e o cartão fica dentro. */
  function blocoAntigo(item: Registro) {
    const dados = dadosAntigo(item);
    const tituloAtual = tituloEfetivo(item.numero);
    const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", tituloAntigo(item));
    titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", tituloAtual || "Sem título"));
    const artigo = cartaoChamado(item.numero, "antigo", titulo, "Em aberto", "");
    const pares = [["I", "Solicitante", dados.solicitante], ["", "Abertura", dados.abertura],
      ...CAMPOS_PREENCHIDOS.flatMap(([letra, rotulo]) => {
        const par = [letra, rotulo, item.automaticos?.[letra]];
        return letra === "K" ? [par, ["", "Apelido", item.apelido]] : [par]; // Apelido: só exibição, vem da base
      })];
    const fatos = document.createElement("dl");
    fatos.className = "ck-fatos sebrae-chamado__auto";
    const osNova: OsNova | null = pedeDecisao(item.os_nova) ? item.os_nova : null; // troca já feita pelo servidor não muda o campo
    pares.forEach(([letra, rotulo, atual]) => {
      const sugerido = letra ? item.automaticos_sugeridos?.[letra] : "";
      const comOsNova = letra === "E" && osNova; // chamado sem OS: a linha OS aparece só para mostrar a sugerida
      if (!atual && !sugerido && !comOsNova) return;
      const linha = document.createElement("div");
      const serie = item.automaticos?.K || item.automaticos_sugeridos?.K || "";
      linha.append(dom.createTextElement("dt", "", rotulo), letra === "E" ? campoOs(atual || sugerido, serie, atual ? "" : " (será preenchido)", item.numero, osNova) : dom.createTextElement("dd", "", atual || `${sugerido} (será preenchido)`));
      fatos.appendChild(linha);
    });
    const manuais = document.createElement("div");
    manuais.className = "sebrae-chamado__manuais";
    manuais.appendChild(campoTitulo(item.numero, "antigo"));
    ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campoManualComSugestao(item, letra, "antigo")));
    ajudaEncerramento(manuais, item.numero, "antigo");
    const notas = [];
    const outra = [avisoOutraPessoa(item), avisoNomeDaDescricao(item)].filter(Boolean).join(" ");
    if (outra) notas.push(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", outra));
    const sugestao = hostSugestaoOs(item);
    if (sugestao) notas.push(sugestao);
    const detalhes = [];
    // O lápis vale para todo antigo com UTIC (lido ou não): o texto editado vai à coluna H da cópia do Dashboard; chave "linha:<n>" não tem lápis.
    if (NUMERO_UTIC.test(item.numero)) {
      detalhes.push(blocoDescricaoEditavel(item, dados.descricao, resposta => {
        marcarDescricaoEditada(item, resposta);
        atualizarBotaoAtualizar();
      }));
    } else if (dados.descricao) detalhes.push(blocoDetalhe("Descrição", dados.descricao, true)); // sem UTIC: coluna H da planilha, só leitura
    if (dados.lido) detalhes.push(blocoDetalhe("Atendimento realizado", dados.atendimento));
    else {
      if (NUMERO_UTIC.test(item.numero)) {
        // Não encontrado na última leitura (ex.: finalizado por outro técnico): o CSS pinta a linha para conferir depois.
        const dica = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__dica", dados.naoEncontrado
          ? "Não encontrado no SoftExpert na última leitura: pode ter sido finalizado por outro técnico. Confira depois."
          : "Ainda não lido no SoftExpert: use Ler chamados antigos.");
        dica.dataset.leitura = dados.naoEncontrado ? "nao_encontrado" : "pendente";
        notas.push(dica);
      }
    }
    if (item.tem_credencial) detalhes.push(blocoSenha(item.numero));
    artigo.append(zonaSolicitacao(fatos, notas, detalhes), zonaClassificacao(manuais, blocoObservacao(item.numero, item.observacao), item.numero));
    if (NUMERO_UTIC.test(item.numero)) artigo.appendChild(secaoFinalizar(item));
    const decidir = osDecidir(item); // depois de hostSugestaoOs: o montar já apagou a decisão que não vale mais (outra OS ou só o aviso)
    const linha = linhaRecolhida("sebrae-antigo", item.numero, tituloAntigo(item), tituloAtual, dados.solicitante,
      [seloDestaque(item.numero), seloObservacao(item.numero, item.observacao), seloOs(item.automaticos?.E || item.automaticos_sugeridos?.E), seloOsDecidir(item, decidir), seloLeitura(item, dados), ...selosAutomaticos()], artigo);
    if (decidir) linha.dataset.osDecidir = decidir;
    return linha;
  }

  /** Linha recolhida dos novos e antigos: `details` cujo resumo mostra número, assunto, pessoa e selos; o cartão fica dentro. */
  function linhaRecolhida(classe: string, numero: string, numeroTexto: string, assunto: string, solicitante: string, selos: (ElementoSebrae | null)[], artigo: ElementoSebrae) {
    const detalhe = document.createElement("details");
    detalhe.className = classe;
    detalhe.dataset.numero = numero;
    const texto = document.createElement("span");
    texto.className = "sebrae-antigo__texto";
    texto.append(dom.createTextElement("span", "sebrae-antigo__num", numeroTexto), dom.createTextElement("span", "sebrae-antigo__assunto", assunto || "Sem título"));
    if (solicitante) texto.appendChild(dom.createTextElement("span", "sebrae-antigo__quem", solicitante));
    const caixaSelos = document.createElement("span");
    caixaSelos.className = "sebrae-antigo__selos";
    caixaSelos.append(...(selos.filter(Boolean) as ElementoSebrae[]));
    const resumo = document.createElement("summary");
    resumo.className = "sebrae-antigo__resumo";
    resumo.append(texto, caixaSelos);
    detalhe.append(resumo, artigo);
    ligarLinha(detalhe, resumo, numero);
    return detalhe;
  }

  /** Item da lista de novos: mesmo formato de linha dos antigos, com o selo `Novo`. */
  function blocoNovo(item: Registro) {
    const novo = dom.createTextElement("span", "ck-badge sebrae-selo", "Novo");
    novo.dataset.status = "info";
    return linhaRecolhida("sebrae-novo", item.numero, item.numero, tituloEfetivo(item.numero), item.linha.I,
      [novo, seloDestaque(item.numero), seloObservacao(item.numero, item.observacao), seloOs(item.linha.E), ...selosAutomaticos()], blocoChamado(item));
  }

  /**
   * Sugestão do servidor para A (Responsável), B (Categoria) ou J (Tipo) de chamado novo, ou só A e J de antigo; vazia para as outras letras e para API SEBRAE (que já vem preenchido).
   * Status (D): todo chamado, novo ou antigo, sugere `FINALIZADO` (pedido do usuário, 27/11/2026); só aparece enquanto D não é FINALIZADO.
   */
  function sugestaoManual(item: Registro, letra: string, alvo = "novo") {
    if (letra === "D") return STATUS_FINALIZADO;
    if (ehApiSebrae(item.linha?.I ?? item.usuario)) return "";
    const valor = { A: item.sugestao_responsavel, B: alvo === "novo" ? item.sugestao_categoria : undefined, J: item.sugestao_tipo }[letra];
    return typeof valor === "string" ? valor.trim() : "";
  }

  /**
   * Campo manual de chamado novo ou antigo em aberto (`alvo`). Em A, B e J (nos antigos, só A e J), com sugestão e o campo ainda vazio (inclusive no rascunho), põe um chip
   * `Sugestão: <valor>` + `Usar` abaixo do campo. Nada é preenchido nem salvo sem o clique em `Usar`.
   * Escolher à mão qualquer valor esconde o chip; voltar a vazio o mostra de novo. No Status (D) o chip `Sugestão: FINALIZADO` aparece
   * também com `EM ABERTO` e só some com D em FINALIZADO.
   * shortcut: a sugestão de J vem do servidor já calculada com a sugestão de B; mudar B na tela não a recalcula, só ao recarregar a lista.
   */
  function campoManualComSugestao(item: Registro, letra: string, alvo = "novo") {
    const controle = controleManual(item.numero, letra, alvo);
    const rotulo = campo(ROTULOS_MANUAIS[letra as keyof typeof ROTULOS_MANUAIS], controle);
    if (letra === "R") return comBotaoAgora(rotulo, controle);
    const sugestao = sugestaoManual(item, letra, alvo);
    // D: "preenchido" é só FINALIZADO; EM ABERTO (o padrão dos novos) ainda mostra a sugestão
    const preenchido = (valor: unknown) => letra === "D" ? String(valor || "").trim().toUpperCase() === STATUS_FINALIZADO : Boolean(String(valor || "").trim());
    if (!sugestao || controle.disabled || preenchido(controle.value) || preenchido(valoresDe(alvo)[item.numero]?.[letra])) return rotulo;
    const nomeCampo = ROTULOS_MANUAIS[letra as keyof typeof ROTULOS_MANUAIS].replace(/\s*\*$/, "");
    const chip = document.createElement("div");
    chip.className = "sebrae-sugestao";
    chip.dataset.sebraeSugestao = letra;
    const usar = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm sebrae-sugestao__usar", "Usar");
    usar.type = "button";
    usar.setAttribute("aria-label", `Usar sugestão ${sugestao} em ${nomeCampo}`);
    chip.append(dom.createTextElement("span", "sebrae-sugestao__texto", `Sugestão: ${sugestao}`), usar);
    usar.addEventListener("click", () => {
      // B pode sugerir uma categoria que a lista do Dashboard não traz (o servidor acrescenta as categorias novas): vira opção extra.
      if (controle.tagName === "SELECT" && ![...controle.children].some(opcao => (opcao as ElementoSebrae).value === sugestao)) {
        const extra = document.createElement("option");
        extra.value = sugestao;
        extra.textContent = sugestao;
        controle.appendChild(extra);
      }
      controle.value = sugestao;
      aoEditar({ currentTarget: controle }); // o mesmo caminho da edição manual: estado, rascunho e botão Atualizar
      chip.remove();
      controle.focus();
    });
    const alternar = () => { chip.hidden = preenchido(controle.value); };
    controle.addEventListener("input", alternar);
    controle.addEventListener("change", alternar);
    const envoltorio = document.createElement("div");
    envoltorio.className = "sebrae-campo-sugestao";
    envoltorio.append(rotulo, chip);
    return envoltorio;
  }

  /**
   * Botão "Agora" ao lado do Encerramento (R) (pedido do usuário, 27/11/2026): o clique põe a data e a hora do relógio deste
   * computador no campo, que continua editável. O sistema nunca preenche sozinho (regra de 24/11/2026); nada é enviado sem o clique de envio.
   */
  function comBotaoAgora(rotulo: ElementoSebrae, controle: ElementoSebrae) {
    if (controle.disabled) return rotulo; // R já gravado com data e hora: travado, sem botão
    const agora = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm sebrae-encerramento__agora", "Agora");
    agora.type = "button";
    agora.title = "Preencher com a data e a hora deste computador";
    agora.setAttribute("aria-label", "Preencher Encerramento (R) com a data e a hora de agora");
    agora.addEventListener("click", () => {
      controle.value = encerramentoAgora();
      aoEditar({ currentTarget: controle }); // o mesmo caminho da edição manual: estado, rascunho, R obrigatório e botão Atualizar
      controle.focus();
    });
    const envoltorio = document.createElement("div");
    envoltorio.className = "sebrae-campo-agora";
    envoltorio.append(rotulo, agora);
    return envoltorio;
  }

  function blocoChamado(item: Registro) {
    const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", item.numero);
    titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", tituloEfetivo(item.numero) || "Sem título"));
    const artigo = cartaoChamado(item.numero, "novo", titulo, "Novo", "info");
    const selo = seloOs(item.linha.E);
    if (selo) artigo.querySelector<ElementoSebrae>(".sebrae-chamado__cab")!.appendChild(selo);
    const fatos = listaFatos(CAMPOS_AUTOMATICOS.flatMap(([letra, rotulo]) => {
      const par = [rotulo, item.linha[letra] || "—"];
      return letra === "K" ? [par, ["Apelido", item.apelido || "—"]] : [par]; // Apelido: só exibição, vem da base
    }), item.linha.K, item.numero);
    const notas = [];
    const aviso = [avisoOutraPessoa(item), avisoNomeDaDescricao(item), AVISO_CRUZAMENTO[item.cruzamento?.status]].filter(Boolean).join(" ");
    if (aviso) notas.push(dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__aviso", aviso));
    const detalhes = [blocoDescricaoEditavel(item, item.linha.H, resposta => {
      marcarDescricaoEditada(item, resposta);
      item.linha = { ...item.linha, H: resposta.descricao };
    }), blocoDetalhe("Atendimento realizado", item.linha.F)];
    if (item.tem_credencial) detalhes.push(blocoSenha(item.numero));
    const manuais = document.createElement("div");
    manuais.className = "sebrae-chamado__manuais";
    manuais.appendChild(campoTitulo(item.numero));
    ["A", "B", "D", "J", "R", "S"].forEach(letra => manuais.appendChild(campoManualComSugestao(item, letra)));
    ajudaEncerramento(manuais, item.numero, "novo");
    artigo.append(zonaSolicitacao(fatos, notas, detalhes), zonaClassificacao(manuais, blocoObservacao(item.numero, item.observacao), item.numero));
    if (NUMERO_UTIC.test(item.numero)) artigo.appendChild(secaoFinalizar(item, true));
    return artigo;
  }

  // ---- Finalizar no SoftExpert: descrição, PDF opcional, botão por chamado, resultado e aviso do SharePoint ----

  const urlChamado = (numero: string, parte: string) => `/api/sebrae/chamados/${encodeURIComponent(numero)}/${parte}`;
  const esperar = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

  function definirFeedback(elemento: ElementoSebrae | null, texto: string, situacao = "") {
    if (!elemento) return;
    elemento.textContent = texto;
    elemento.dataset.estado = situacao;
  }

  function secaoFinalizar(item: Registro, novo = false) {
    const numero = item.numero;
    const guardado = item.softexpert || {};
    // "Revisado." só entra se o servidor nunca guardou descrição (campo ausente); apagada depois, vira "" guardado e não volta
    const aplicarRevisado = novo && ehApiSebrae(item.linha?.I) && guardado.descricao_definida === false;
    const soft = estado.soft[numero] = {
      descricao: aplicarRevisado ? DESCRICAO_API_SEBRAE : guardado.descricao_finalizacao || "", enviado: guardado.descricao_finalizacao || "",
      pdf: guardado.pdf || null, finalizacao: guardado.finalizacao || null, processando: false, novo,
        pdfRemocaoPendente: Boolean(guardado.pdf_remocao_pendente),
    };
    const area = criarZona("finalizacao", "Finalização no SoftExpert", "Irreversível", {
      destaque: true, classe: "sebrae-chamado__finalizar",
      aviso: "Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada.",
    });
    const texto = document.createElement("textarea");
    texto.className = "ck-entrada";
    texto.rows = 4;
    texto.placeholder = " "; // o CSS usa :placeholder-shown para saber se a descrição está vazia (pendência e botão "pronto")
    texto.maxLength = MAX_DESCRICAO;
    texto.value = soft.descricao;
    texto.dataset.sebraeDescricao = numero;
    const feedbackDescricao = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__feedback", `Salva automaticamente. Até ${MAX_DESCRICAO} caracteres.`);
    feedbackDescricao.setAttribute("role", "status");
    const arquivo = document.createElement("input");
    arquivo.type = "file";
    arquivo.accept = ".pdf,application/pdf";
    arquivo.dataset.sebraePdf = numero;
    const infoPdf = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__pdf", "");
    const remover = document.createElement("button");
    remover.type = "button";
    remover.className = "ck-btn ck-btn--fantasma ck-btn--sm";
    remover.textContent = "Remover PDF";
    remover.dataset.sebraePdfRemover = numero;
    const tentarRemover = document.createElement("button");
    tentarRemover.type = "button";
    tentarRemover.className = "ck-btn ck-btn--fantasma ck-btn--sm";
    tentarRemover.textContent = "Tentar remover novamente o PDF antigo";
    tentarRemover.dataset.sebraePdfRemocao = numero;
    const feedbackPdf = dom.createTextElement("p", "ck-campo__ajuda sebrae-chamado__feedback", "");
    feedbackPdf.setAttribute("role", "status");
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "ck-btn ck-btn--primario ck-btn--sm";
    botao.textContent = "Finalizar no SoftExpert";
    botao.dataset.sebraeFinalizar = numero;
    const cancelar = document.createElement("button");
    cancelar.type = "button";
    cancelar.className = "ck-btn ck-btn--secundario ck-btn--sm";
    cancelar.textContent = "Cancelar";
    cancelar.hidden = true;
    cancelar.dataset.sebraeCancelarFinalizar = numero;
    const acoes = document.createElement("div");
    acoes.className = "sebrae-chamado__acoes";
    acoes.append(botao, cancelar);
    const resultado = dom.createTextElement("p", "ck-cartao__meta sebrae-chamado__resultado", "");
    resultado.setAttribute("role", "status");
    const pdfLinha = document.createElement("div");
    pdfLinha.className = "sebrae-chamado__pdf-linha";
    pdfLinha.append(infoPdf, remover, tentarRemover);
    // A ordem no DOM dos dois `.sebrae-chamado__feedback` (descrição primeiro, PDF depois) precisa ser mantida.
    const colTexto = document.createElement("div");
    colTexto.className = "sebrae-final__texto";
    const contador = dom.createTextElement("span", "sebrae-final__contador", "");
    const contar = () => { contador.textContent = `${texto.value.length}/${MAX_DESCRICAO}`; };
    contar();
    colTexto.append(campo("Descrição para Finalizar o Chamado", texto), feedbackDescricao, contador);
    const colAnexo = document.createElement("div");
    colAnexo.className = "sebrae-final__anexo";
    colAnexo.append(campo("Anexo PDF (opcional)", arquivo), pdfLinha, feedbackPdf);
    // Fora do `resultado` (role=status): orientação quando o SoftExpert não achou o antigo (talvez finalizado à mão).
    const orientacao = document.createElement("div");
    orientacao.className = "sebrae-final__orientacao";
    orientacao.hidden = true;
    const conferir = document.createElement("button");
    conferir.type = "button";
    conferir.className = "ck-btn ck-btn--secundario ck-btn--sm";
    conferir.textContent = "Conferir este chamado";
    conferir.dataset.sebraeConferir = numero;
    orientacao.append(dom.createTextElement("p", "ck-campo__ajuda", TEXTO_ORIENTACAO_NAO_ENCONTRADO), conferir);
    const rodape = document.createElement("div");
    rodape.className = "sebrae-final__rodape";
    rodape.append(acoes, resultado, orientacao);
    const corpo = document.createElement("div");
    corpo.className = "sebrae-final__corpo";
    corpo.append(listaPendencias(), colTexto, colAnexo, rodape);
    area.appendChild(corpo);
    estado.refs.set(numero, { texto, feedbackDescricao, arquivo, infoPdf, remover, tentarRemover, feedbackPdf, botao, cancelar, resultado, orientacao, conferir });
    texto.addEventListener("input", () => {
      contar();
      window.clearTimeout(estado.temporizadores[numero]);
      estado.temporizadores[numero] = window.setTimeout(() => salvarDescricao(numero), 800);
      definirFeedback(feedbackDescricao, "Alteração ainda não salva…", "pendente");
      atualizarFinalizar(numero);
    });
    texto.addEventListener("change", () => salvarDescricao(numero));
    arquivo.addEventListener("change", () => enviarPdf(numero));
    remover.addEventListener("click", () => removerPdf(numero));
    tentarRemover.addEventListener("click", () => removerPdf(numero, true));
    botao.addEventListener("click", () => finalizarNoSoftExpert(numero));
    cancelar.addEventListener("click", () => cancelarFinalizacao(numero));
    conferir.addEventListener("click", () => conferirAntigo(numero));
    atualizarFinalizar(numero);
    if (aplicarRevisado) salvarDescricao(numero); // só salva; finalizar continua sendo clique do usuário
    return area;
  }

  function atualizarFinalizar(numero: string) {
    const ref = estado.refs.get(numero);
    const soft = estado.soft[numero];
    if (!ref || !soft) return;
    // Fica clicável com campos faltando: o clique avisa na tela o que preencher (descrição, A, D, J e R) e nada é enviado sem eles.
    const ocupado = estado.finalizando.has(numero) || estado.pdfOcupado.has(numero); // Finalizar ou PDF em andamento: nada de anexo novo nem remoção
    ref.botao.disabled = estado.fechar.emAndamento || ocupado || STATUS_DESFEITOS.includes(soft.finalizacao?.status);
    ref.arquivo.disabled = ref.remover.disabled = ref.tentarRemover.disabled = ocupado;
    ref.cancelar.hidden = !soft.processando;
    ref.infoPdf.textContent = soft.pdf ? `PDF anexado: ${soft.pdf.nome} (${formatarTamanho(soft.pdf.tamanho)})` : "Nenhum PDF anexado.";
    ref.remover.hidden = !soft.pdf;
    ref.tentarRemover.hidden = !soft.pdfRemocaoPendente;
    const quando = formatarDataHora(soft.finalizacao?.em);
    ref.resultado.textContent = soft.processando ? "Finalizando no SoftExpert…"
      : soft.cancelado && !soft.finalizacao ? "Finalização cancelada."
      : soft.finalizacao ? `${textoResultado(soft.finalizacao)}${quando ? ` · ${quando}` : ""}` : "";
    ref.resultado.dataset.estado = soft.processando ? "andamento" : soft.finalizacao?.status || (soft.cancelado ? "cancelado" : "");
    ref.orientacao.hidden = soft.novo || soft.processando || soft.finalizacao?.status !== "nao_encontrado";
    ref.conferir.disabled = estado.antigos.emAndamento || estado.fechar.emAndamento;
  }

  function atualizarTodosFinalizar() {
    estado.refs.forEach((_ref, numero) => atualizarFinalizar(numero));
  }

  /** Salvamentos do mesmo chamado entram em fila: o último texto digitado é o que fica no servidor. */
  function salvarDescricao(numero: string) {
    window.clearTimeout(estado.temporizadores[numero]);
    const fila = (estado.salvando[numero] || Promise.resolve(true)).then(() => enviarDescricao(numero));
    estado.salvando[numero] = fila;
    return fila;
  }

  async function enviarDescricao(numero: string) {
    const ref = estado.refs.get(numero);
    const soft = estado.soft[numero];
    if (!ref || !soft) return true;
    const texto = ref.texto.value;
    if (texto === soft.enviado) return true;
    definirFeedback(ref.feedbackDescricao, "Salvando…", "salvando");
    try {
      const dados = await app.apiFetch(urlChamado(numero, "finalizacao"), {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ descricao_finalizacao: texto }),
        errorMessage: "Não foi possível salvar a descrição.",
      });
      soft.enviado = texto;
      soft.descricao = dados.descricao_finalizacao ?? texto;
      definirFeedback(ref.feedbackDescricao, "Descrição salva.", "ok");
      return true;
    } catch (falha) { const error = falha as ErroApi;
      definirFeedback(ref.feedbackDescricao, `Não foi possível salvar: ${error.message}`, "erro");
      return false;
    } finally {
      atualizarFinalizar(numero);
    }
  }

  /** Bloco de anotação interna do andamento (Zona 2, abaixo dos campos manuais). */
  function blocoObservacao(numero: string, observacaoInicial: string | undefined, somenteLeitura = false) {
    const bloco = document.createElement("div");
    bloco.className = "sebrae-chamado__observacao";
    const textarea = document.createElement("textarea");
    textarea.className = "ck-entrada";
    textarea.rows = 2;
    textarea.maxLength = 4000; // limite do servidor: acima disso o salvamento falharia sempre
    textarea.placeholder = somenteLeitura
      ? " "
      : "Anotação interna do andamento deste chamado (não vai para o SoftExpert nem para o Dashboard)";
    textarea.dataset.sebraeObservacao = numero;
    textarea.value = observacaoInicial || "";

    if (somenteLeitura) {
      textarea.readOnly = true;
      bloco.appendChild(campo("Observação do andamento", textarea));
      return bloco;
    }

    const feedback = dom.createTextElement(
      "p",
      "ck-campo__ajuda sebrae-obs__feedback",
      "Salva automaticamente."
    );
    feedback.setAttribute("role", "status");
    feedback.dataset.estado = "";

    estado.observacoes[numero] = {
      enviado: observacaoInicial || "",
      textarea,
      feedback,
    };

    textarea.addEventListener("input", () => {
      window.clearTimeout(estado.temporizadoresObs[numero]);
      estado.temporizadoresObs[numero] = window.setTimeout(() => salvarObservacao(numero), 800);
      definirFeedback(feedback, "Alteração ainda não salva…", "pendente");
    });
    textarea.addEventListener("change", () => salvarObservacao(numero));
    textarea.addEventListener("blur", () => salvarObservacao(numero));

    bloco.append(campo("Observação do andamento", textarea), feedback);
    return bloco;
  }

  // ---- Destaque manual: `estado.destaques` manda; tudo o que aparece na tela é refeito a partir dele ----

  /** Selo `Destaque` (cor + estrela + texto); escondido enquanto o chamado não está em destaque. */
  function seloDestaque(numero: string) {
    const selo = document.createElement("span");
    selo.className = "ck-badge sebrae-selo-destaque";
    selo.dataset.status = "alerta";
    selo.dataset.sebraeDestaqueSelo = numero;
    selo.hidden = !estado.destaques[numero];
    const estrela = dom.createTextElement("span", "sebrae-selo-destaque__estrela", "★");
    estrela.setAttribute("aria-hidden", "true");
    selo.append(estrela, "Destaque");
    return selo;
  }

  /** Região `aria-live` fixa (fora da seção, que pode estar escondida): um nó novo a cada aviso para o leitor de tela repetir o texto. */
  function anunciarDestaque(texto: string) {
    el("sebrae-destaque-anuncio")?.replaceChildren(document.createTextNode(texto));
  }

  function atualizarBotaoDestaque(botao: ElementoSebrae, ligado: boolean) {
    botao.setAttribute("aria-pressed", String(ligado));
    botao.textContent = ligado ? "Tirar destaque" : "Marcar destaque";
  }

  /** Botão que alterna o destaque (aria-pressed) + mensagem de erro; vale para todo cartão, inclusive o finalizado. */
  function blocoDestaque(numero: string) {
    const bloco = document.createElement("div");
    bloco.className = "sebrae-destaque__acao";
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "ck-btn ck-btn--secundario ck-btn--sm sebrae-destaque__botao";
    botao.dataset.sebraeDestaque = numero;
    atualizarBotaoDestaque(botao, Boolean(estado.destaques[numero]));
    const feedback = dom.createTextElement("p", "ck-campo__ajuda sebrae-destaque__feedback", "");
    feedback.setAttribute("role", "status");
    feedback.dataset.estado = "";
    botao.addEventListener("click", () => alternarDestaque(numero, botao, feedback));
    bloco.append(botao, feedback);
    return bloco;
  }

  const nosDoChamado = (seletor: string, atributo: string, numero: string) => [...document.querySelectorAll<ElementoSebrae>(seletor)].filter(no => no.dataset[atributo] === numero);

  /** Selo `Observação` do resumo: aparece enquanto o chamado tem observação do andamento salva. */
  function seloObservacao(numero: string, texto: string) {
    const selo = dom.createTextElement("span", "ck-badge sebrae-selo sebrae-selo-obs", "Observação");
    selo.dataset.status = "info";
    selo.dataset.sebraeObsSelo = numero;
    selo.hidden = !String(texto || "").trim();
    return selo;
  }

  function sincronizarSeloObservacao(numero: string, texto: string) {
    nosDoChamado("[data-sebrae-obs-selo]", "sebraeObsSelo", numero).forEach(selo => { selo.hidden = !String(texto || "").trim(); });
  }

  /** Leva `estado.destaques[numero]` para todos os cartões desse chamado (o original e o da seção), sem criar ids. */
  function sincronizarDestaque(numero: string) {
    const ligado = Boolean(estado.destaques[numero]);
    nosDoChamado("[data-sebrae-destaque]", "sebraeDestaque", numero).forEach(botao => atualizarBotaoDestaque(botao, ligado));
    nosDoChamado("[data-sebrae-destaque-selo]", "sebraeDestaqueSelo", numero).forEach(selo => { selo.hidden = !ligado; });
    nosDoChamado("article.sebrae-chamado", "numero", numero).forEach(artigo => artigo.classList.toggle("sebrae-chamado--destaque", ligado));
  }

  /** Título, solicitante e observação de um chamado das listas atuais; `null` quando ele não está em nenhuma (destaque só no servidor). */
  function resumoChamado(numero: string) {
    const fin = estado.finalizadosItens.find(item => item.numero === numero);
    if (fin) return { titulo: fin.ficha?.titulo, solicitante: fin.ficha?.solicitante, observacao: fin.observacao };
    const novo = estado.formulario.find(item => item.numero === numero);
    if (novo) return { titulo: tituloEfetivo(numero), solicitante: novo.linha?.I, observacao: novo.observacao };
    const antigo = estado.abertos.find(item => item.numero === numero);
    if (antigo) { const dados = dadosAntigo(antigo); return { titulo: tituloEfetivo(numero), solicitante: dados.solicitante, observacao: antigo.observacao }; }
    return null;
  }

  /** Cartão compacto da seção: só leitura (número, solicitante, observação, data) + o botão. Não é `article[data-numero]`: o F5 da Home procura esse seletor e deve achar o original. */
  function cartaoDestaque(numero: string) {
    const info = resumoChamado(numero);
    const registro = estado.destaques[numero] || {};
    const cartao = document.createElement("div");
    cartao.className = "sebrae-chamado sebrae-chamado--resumo sebrae-chamado--destaque";
    cartao.dataset.sebraeDestaqueCartao = numero;
    const titulo = dom.createTextElement("h3", "sebrae-chamado__titulo", numero);
    if (info?.titulo) titulo.append(" · ", dom.createTextElement("span", "sebrae-chamado__assunto", info.titulo));
    const cab = document.createElement("header");
    cab.className = "sebrae-chamado__cab";
    cab.append(titulo, seloDestaque(numero));
    const desde = formatarDataHora(registro.em);
    const fatos = listaFatos([info?.solicitante ? ["Solicitante", info.solicitante] : null, desde ? ["Em destaque desde", desde] : null].filter(Boolean) as string[][]);
    const observacao = estado.observacoes[numero]?.enviado ?? registro.observacao ?? info?.observacao ?? "";
    const bloco = document.createElement("div");
    bloco.className = "sebrae-destaque__observacao";
    bloco.append(dom.createTextElement("span", "ck-campo__rotulo", "Observação do andamento"), dom.createTextElement("p", "sebrae-destaque__texto", observacao || "—"));
    const zona = document.createElement("div");
    zona.className = "sebrae-destaque__corpo";
    zona.append(...([fatos.children.length ? fatos : null, bloco, blocoDestaque(numero)].filter(Boolean) as HTMLElement[]));
    cartao.append(cab, zona);
    return cartao;
  }

  /** Refaz a aba `Destaques`; contagem, selo de alerta e visibilidade ficam com `aplicarVisao`. */
  function desenharDestaques() {
    const lista = el("sebrae-destaques-lista");
    const numeros = lista ? Object.keys(estado.destaques).sort((a, b) => String(estado.destaques[b].em || "").localeCompare(String(estado.destaques[a].em || "")) || a.localeCompare(b)) : [];
    const cartoes = numeros.map(cartaoDestaque);
    if (lista) {
      const comFoco = lista.contains(document.activeElement) ? (document.activeElement as ElementoSebrae).dataset?.sebraeDestaque : undefined;
      const aberto = ([...lista.children] as ElementoSebrae[]).find(estaAberta)?.dataset.sebraeDestaqueCartao; // o cartão do detalhe continua o mesmo
      lista.replaceChildren(...cartoes);
      cartoes.forEach(cartao => { if (cartao.dataset.sebraeDestaqueCartao === aberto) definirAberta(cartao, true); });
      // a seção é refeita por inteiro; quem estava no botão de um cartão continua nele (no cartão novo)
      if (comFoco) [...lista.querySelectorAll<ElementoSebrae>("[data-sebrae-destaque]")].find(botao => botao.dataset.sebraeDestaque === comFoco)?.focus();
    }
    indexar([...visao.itens.filter(item => item.aba !== "destaques"), ...cartoes.map((cartao, i) => entradaVisao("destaques", numeros[i], cartao))]);
    aplicarVisao();
  }

  /** Campos que o filtro procura em cada aba (os mesmos dados que a aba desenha); `naLinha` diz se o campo já aparece na linha recolhida. */
  function entradaVisao(aba: string, entrada: Registro | string, no: ElementoSebrae) {
    const item = entrada as Registro; // na aba Destaques `entrada` é o número do chamado
    const campo = (rotulo: string, valor: unknown, naLinha = false): CampoVisao => ({ rotulo, valor, naLinha });
    let campos: CampoVisao[] = [];
    let resumo = no.querySelector<ElementoSebrae>(".sebrae-antigo__texto");
    if (aba === "novos") {
      const linha = item.linha || {};
      campos = [campo("", item.numero, true), campo("", tituloEfetivo(item.numero), true), campo("", linha.I, true), ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => campo(rotulo, linha[letra]))];
    } else if (aba === "antigos") {
      const dados = dadosAntigo(item);
      campos = [campo("", item.numero, true), campo("", tituloAntigo(item), true), campo("", tituloEfetivo(item.numero), true), campo("", dados.solicitante, true),
        ...CAMPOS_PREENCHIDOS.map(([letra, rotulo]) => campo(rotulo, item.automaticos?.[letra] || item.automaticos_sugeridos?.[letra]))];
    } else if (aba === "finalizados") {
      const ficha = item.ficha || {};
      const fatos: [string, unknown][] = Array.isArray(ficha.fatos) ? ficha.fatos.filter((par: unknown) => Array.isArray(par) && par.length === 2) : [];
      campos = [campo("", item.numero, true), campo("", ficha.titulo, true), campo("", ficha.solicitante, true), ...fatos.map(([rotulo, valor]) => campo(rotulo, valor, rotulo === "Solicitante"))];
      resumo = no.querySelector<ElementoSebrae>("summary");
    } else {
      const info: Registro = resumoChamado(entrada as string) || {};
      // o destaque acha o que a sub-aba de origem acha (série, modelo, cidade, OS...)
      const origem = visao.itens.find(e => e.aba !== "destaques" && e.numero === entrada);
      campos = [campo("", entrada, true), campo("", info.titulo, true), campo("", info.solicitante, true),
        ...(origem?.campos || []).filter((c: CampoVisao) => !c.naLinha).map((c: CampoVisao) => campo(c.rotulo, c.valor))];
      resumo = null;
    }
    campos = campos.filter(c => c.valor && c.valor !== "—").map(c => ({ ...c, valor: String(c.valor), norma: normalizar(c.valor) }));
    return { numero: aba === "destaques" ? entrada : item.numero, aba, no, resumo, campos, achado: null };
  }

  function indexar(itens: Registro[]) {
    visao.itens = itens;
    visao.porNo = new Map(itens.map(item => [item.no, item]));
  }

  const casaTermo = (item: Registro, termo: string) => !termo || item.campos.some((c: CampoVisao) => (c.norma as string).includes(termo));

  /** Segunda linha do resumo quando o termo só casou com um campo que a linha não mostra (Série, Modelo, Cidade, OS...). */
  function marcarAchado(item: Registro, termo: string) {
    item.achado?.remove();
    item.achado = null;
    if (!termo || !item.resumo || item.campos.some((c: CampoVisao) => c.naLinha && (c.norma as string).includes(termo))) return;
    const campo = item.campos.find((c: CampoVisao) => !c.naLinha && (c.norma as string).includes(termo));
    if (!campo) return;
    // normaliza letra a letra para saber onde o trecho casado começa e termina no texto original
    let norma = "";
    const origem = [];
    for (let i = 0; i < campo.valor.length; i++) {
      const parte = campo.valor[i].normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("pt-BR");
      norma += parte;
      for (let j = 0; j < parte.length; j++) origem.push(i);
    }
    const achado = dom.createTextElement("span", "sebrae-achado", "");
    achado.append(`${campo.rotulo}: `);
    const pos = norma.indexOf(termo);
    if (pos < 0) achado.append(campo.valor);
    else {
      const inicio = origem[pos];
      const fim = origem[pos + termo.length - 1] + 1;
      achado.append(campo.valor.slice(0, inicio), dom.createTextElement("mark", "", campo.valor.slice(inicio, fim)), campo.valor.slice(fim));
    }
    item.resumo.appendChild(achado);
    item.achado = achado;
  }

  /** Recalcula tudo o que depende de aba, termo e página: linhas visíveis, contagens, rótulos, vazios e `Carregar mais`. */
  function aplicarVisao() {
    const termo = normalizar(visao.termo);
    const contagens: Record<string, number> = {};
    const encontrados = new Set();
    ABAS.forEach(aba => {
      const painel = el(`sebrae-${aba}`);
      const lista = el(`sebrae-${aba}-lista`);
      const filhos = (lista ? [...lista.children] : []) as ElementoSebrae[];
      const limite = visao.paginas[aba];
      let casam = 0;
      filhos.forEach(filho => {
        const item = visao.porNo.get(filho);
        const casa = !item || casaTermo(item, termo);
        if (casa) casam += 1;
        if (casa && termo && item) encontrados.add(item.numero);
        filho.hidden = !casa || (!termo && limite !== undefined && casam > limite);
        if (item) marcarAchado(item, casa ? termo : "");
      });
      contagens[aba] = casam;
      if (!painel) return;
      painel.hidden = aba !== visao.aba;
      if (termo) painel.setAttribute("data-filtrando", "");
      else painel.removeAttribute("data-filtrando");
      const mais = painel.querySelector<ElementoSebrae>("[data-sebrae-mais]");
      if (mais) {
        mais.hidden = Boolean(termo) || limite === undefined || filhos.length <= limite;
        const n = mais.querySelector<ElementoSebrae>(".sebrae-mais__n");
        if (n) n.textContent = mais.hidden ? "" : `Mostrando ${limite} de ${filhos.length}`;
      }
    });
    const outraAba = ABAS.find(aba => contagens[aba] > 0);
    ABAS.forEach(aba => {
      const n = contagens[aba];
      definirTexto(`sebrae-${aba}-contagem`, String(n));
      const botao = el(`sebrae-aba-${aba}`);
      if (botao) {
        const selecionada = aba === visao.aba;
        botao.setAttribute("aria-selected", String(selecionada));
        botao.tabIndex = selecionada ? 0 : -1;
        botao.setAttribute("aria-label", `${ROTULO_ABA[aba]}: ${n} ${n === 1 ? "chamado" : "chamados"}${termo ? (n === 1 ? " encontrado" : " encontrados") : ""}`);
        if (n) botao.removeAttribute("data-zero");
        else botao.setAttribute("data-zero", "");
      }
      const vazio = el(`sebrae-${aba}`)?.querySelector<ElementoSebrae>("[data-sebrae-vazio-filtro]");
      if (!vazio) return;
      vazio.hidden = !termo || n > 0;
      const frase = vazio.querySelector<ElementoSebrae>(".sebrae-vazio__1");
      if (frase) frase.textContent = vazio.hidden ? "" : `Nenhum chamado encontrado para “${visao.termo.trim()}”.`;
      const ir = vazio.querySelector<ElementoSebrae>(".sebrae-vazio__ir");
      if (ir) {
        ir.hidden = vazio.hidden || !outraAba;
        ir.textContent = ir.hidden ? "" : `Ir para ${ROTULO_ABA[outraAba as string]}`;
        ir.dataset.sebraeIr = ir.hidden ? "" : outraAba;
      }
    });
    // selo âmbar segue o número exibido na aba (com filtro, o que bateu), como no artefato aprovado
    const contagemDestaques = el("sebrae-destaques-contagem");
    if (contagemDestaques) {
      if (contagens.destaques > 0) contagemDestaques.setAttribute("data-status", "alerta");
      else contagemDestaques.removeAttribute("data-status");
    }
    definirTexto("sebrae-filtro-resultado", termo ? `${encontrados.size} chamado(s) encontrado(s)` : "");
    atualizarMestre();
  }

  // ---- Lista compacta (coluna da esquerda) de cada sub-aba: espelha as linhas visíveis; o chamado aberto é o do detalhe ----
  // Linha de Novos e Antigos = `details`; de Finalizados = `li > details`; de Destaques = cartão (aberto = `data-sebrae-aberto`).

  const ABAS_MESTRE = ["novos", "antigos", "finalizados", "destaques"];
  const modoLista = () => typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1023.98px)").matches;

  const linhasVisiveis = (aba: string) => ([...(el(`sebrae-${aba}-lista`)?.children || [])] as ElementoSebrae[]).filter(filho => !filho.hidden);
  const ehCartao = (no: ElementoSebrae) => no.dataset.sebraeDestaqueCartao !== undefined;
  const detalheDe = (no: ElementoSebrae) => (no.tagName === "DETAILS" ? no : no.querySelector<ElementoSebrae>("details"));
  const numeroDe = (no: ElementoSebrae) => no.dataset.numero || no.dataset.sebraeDestaqueCartao || "";
  const estaAberta = (no: ElementoSebrae) => (ehCartao(no) ? no.dataset.sebraeAberto !== undefined : Boolean(detalheDe(no)?.open));
  function definirAberta(no: ElementoSebrae, aberta: boolean) {
    if (!ehCartao(no)) { const detalhe = detalheDe(no); if (detalhe) detalhe.open = aberta; }
    else if (aberta) no.dataset.sebraeAberto = "";
    else delete no.dataset.sebraeAberto;
  }

  const estrelaMestre = () => {
    const estrela = dom.createTextElement("span", "sebrae-mestre__estrela", "★");
    estrela.setAttribute("role", "img");
    estrela.setAttribute("aria-label", "Destaque");
    return estrela;
  };
  const seloMestre = (texto: string, status: string, classe = "") => {
    const selo = dom.createTextElement("span", `ck-badge sebrae-selo${classe}`, texto);
    selo.dataset.status = status;
    return selo;
  };

  /** Botão do item: número, selos, título, `quem`, data (`quando`, à direita) e o trecho achado pelo filtro. */
  function montarItemMestre(d: { numero: string; titulo: string; quem: string; selos: ElementoSebrae[]; selecionado: boolean; tom?: string; quando?: string; achado?: string; osDecidir?: string }) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "sebrae-mestre__botao";
    botao.dataset.sebraeMestre = d.numero;
    if (d.selecionado) botao.setAttribute("aria-current", "true");
    if (d.tom) botao.dataset.tom = d.tom;
    if (d.osDecidir) botao.dataset.osDecidir = d.osDecidir;
    const selos = dom.createTextElement("span", "sebrae-mestre__selos", "");
    selos.append(...d.selos);
    botao.append(dom.createTextElement("span", "sebrae-mestre__num", d.numero), selos, dom.createTextElement("span", "sebrae-mestre__titulo", d.titulo), dom.createTextElement("span", "sebrae-mestre__quem", d.quem));
    if (d.quando) botao.appendChild(dom.createTextElement("span", "sebrae-mestre__quando", d.quando));
    if (d.achado) botao.appendChild(dom.createTextElement("span", "sebrae-mestre__achado", d.achado));
    const item = document.createElement("li");
    item.className = "sebrae-mestre__item";
    item.appendChild(botao);
    return item;
  }

  /** Um item da lista compacta. Novos e Antigos copiam o resumo da linha (número, título, `[solicitante] · série`, selos e o lado CLIENTE/SIMPRESS);
   * Finalizados e Destaques leem os dados do próprio chamado (o resumo da linha fica escondido). */
  function itemMestre(aba: string, linha: ElementoSebrae, selecionado: boolean) {
    const numero = numeroDe(linha);
    const entrada = visao.porNo.get(linha);
    const achado = entrada?.achado?.textContent as string | undefined;
    if (aba === "finalizados") {
      const fin = estado.finalizadosItens.find(item => item.numero === numero);
      const ficha = fin?.ficha || {};
      const serie = Array.isArray(ficha.fatos) ? ficha.fatos.find((par: string[]) => par?.[0] === "Série")?.[1] : "";
      const selos = [seloMestre("Finalizado", "ok", " sebrae-mestre__ok")];
      if (fin?.status === STATUS_OUTRO_TECNICO) selos.push(seloMestre("Finalizado por outro técnico", "info", " sebrae-mestre__outro"));
      if (estado.destaques[numero]) selos.push(estrelaMestre());
      return montarItemMestre({ numero, titulo: ficha.titulo || "", quem: [ficha.solicitante, serie].filter(Boolean).join(" · "), selos, selecionado, tom: estado.destaques[numero] ? "alerta" : undefined, quando: fin?.encerrado_em, achado });
    }
    if (aba === "destaques") {
      const info = resumoChamado(numero);
      return montarItemMestre({ numero, titulo: info?.titulo || "", quem: info?.solicitante || "", selos: [estrelaMestre()], selecionado, tom: "alerta", quando: formatarDataHora(estado.destaques[numero]?.em), achado });
    }
    const resumo = linha.querySelector<ElementoSebrae>("summary");
    const texto = (seletor: string) => resumo?.querySelector<ElementoSebrae>(seletor)?.textContent || "";
    const serie = entrada?.campos.find((c: CampoVisao) => c.rotulo === "Série")?.valor;
    // O realce que o resumo antigo dava (borda à esquerda) passa ao item da lista: laranja se o SoftExpert não achou o chamado, âmbar se é destaque.
    const tom = linha.querySelector('[data-leitura="nao_encontrado"]') ? "laranja" : linha.querySelector(".sebrae-chamado--destaque") ? "alerta" : undefined;
    const selos: ElementoSebrae[] = [];
    // Os selos `--auto` (D: FINALIZADO, Pronto para finalizar, Finalizando…, atenção, falha) são acesos por CSS (`:has`) no resumo; a cópia só leva os que estão acesos agora.
    const aceso = (selo: ElementoSebrae) => !selo.matches(".sebrae-selo--auto") || (typeof getComputedStyle === "function" && getComputedStyle(selo).display !== "none");
    resumo?.querySelectorAll<ElementoSebrae>(".sebrae-antigo__selos > .ck-badge").forEach(selo => {
      if (selo.hidden || !aceso(selo)) return;
      const copia = selo.matches(".sebrae-selo-destaque") ? estrelaMestre() : dom.createTextElement("span", selo.className, selo.textContent);
      if (selo.dataset.status) copia.dataset.status = selo.dataset.status;
      if (selo.title) copia.title = selo.title;
      selos.push(copia);
    });
    const lado = String(linha.querySelector<ElementoSebrae>('[data-sebrae-campo="A"]')?.value || "").trim().toUpperCase();
    if (lado === "CLIENTE" || lado === "SIMPRESS") {
      const selo = dom.createTextElement("span", "nl-selo-lado", lado);
      if (tomDoLado(lado) !== "indigo") selo.dataset.nlTom = tomDoLado(lado);
      selos.push(selo);
    }
    return montarItemMestre({ numero, titulo: texto(".sebrae-antigo__assunto"), quem: [texto(".sebrae-antigo__quem"), serie].filter(Boolean).join(" · "), selos, selecionado, tom, achado, osDecidir: linha.dataset.osDecidir });
  }

  /** Refaz as listas compactas e, sem chamado aberto na aba atual, abre o primeiro (o detalhe nunca fica vazio). */
  // último chamado escolhido em cada aba: abrir outra aba fecha a linha (um aberto nas três listas), e a volta reabre o mesmo
  const escolhidoPorAba = new Map<string, string>();

  function atualizarMestre() {
    ABAS_MESTRE.forEach(aba => {
      const mestre = el(`sebrae-${aba}-mestre`);
      if (!mestre) return;
      const linhas = linhasVisiveis(aba);
      let aberta = linhas.find(estaAberta);
      if (!aberta && aba === visao.aba && linhas.length) {
        aberta = linhas.find(linha => numeroDe(linha) === escolhidoPorAba.get(aba)) || linhas[0];
        definirAberta(aberta, true);
      }
      if (aberta) escolhidoPorAba.set(aba, numeroDe(aberta));
      const comFoco = mestre.contains(document.activeElement) ? (document.activeElement as ElementoSebrae).dataset?.sebraeMestre : undefined;
      mestre.replaceChildren(...linhas.map(linha => itemMestre(aba, linha, linha === aberta)));
      if (comFoco) mestre.querySelectorAll<ElementoSebrae>("[data-sebrae-mestre]").forEach(botao => { if (botao.dataset.sebraeMestre === comFoco) botao.focus(); });
    });
  }

  /** Abre o chamado no detalhe (um por lista); no celular troca a lista pelo detalhe. */
  function escolherChamado(linha: ElementoSebrae) {
    [...(linha.parentElement?.children || [])].forEach(irma => { if (irma !== linha && estaAberta(irma as ElementoSebrae)) definirAberta(irma as ElementoSebrae, false); });
    definirAberta(linha, true);
    linha.closest<ElementoSebrae>(".sebrae-painel")?.setAttribute("data-sebrae-detalhe", "");
    atualizarMestre();
  }

  const voltarParaLista = () => ABAS_MESTRE.forEach(aba => el(`sebrae-${aba}`)?.removeAttribute("data-sebrae-detalhe"));

  /** Liga cliques da lista compacta, `Voltar à lista` e a atualização automática dos selos e do lado (CLIENTE/SIMPRESS). */
  function instalarMestre() {
    ABAS_MESTRE.forEach(aba => {
      const mestre = el(`sebrae-${aba}-mestre`);
      const lista = el(`sebrae-${aba}-lista`);
      const painel = el(`sebrae-${aba}`);
      if (!mestre || !lista) return;
      mestre.addEventListener("click", evento => {
        const botao = (evento.target as ElementoSebrae).closest?.<ElementoSebrae>("[data-sebrae-mestre]");
        const linha = ([...lista.children] as ElementoSebrae[]).find(filho => numeroDe(filho) === botao?.dataset.sebraeMestre);
        if (!linha) return;
        escolherChamado(linha);
        if (modoLista()) painel?.querySelector<ElementoSebrae>("[data-sebrae-voltar]")?.focus();
      });
      painel?.querySelector<ElementoSebrae>("[data-sebrae-voltar]")?.addEventListener("click", () => {
        painel.removeAttribute("data-sebrae-detalhe");
        mestre.querySelector<ElementoSebrae>('[aria-current="true"]')?.focus();
      });
      lista.addEventListener("change", atualizarMestre); // trocar o Responsável (A) muda o selo do lado
      if (typeof MutationObserver === "function") {
        // selos (Lido, estrela, OS) e linhas redesenhadas; ignora o que acontece dentro do cartão (digitação, contadores)
        new MutationObserver(registros => {
          if (registros.some(r => { const no = (r.target.nodeType === 1 ? r.target : r.target.parentElement) as Element | null; return !no?.closest("article, [data-sebrae-destaque-cartao]"); })) atualizarMestre();
        }).observe(lista, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open", "data-status"], characterData: true });
      }
    });
  }

  /** Seleciona a sub-aba (clique, setas, Home, End, `Ir para…`); `focar` leva o foco ao botão da aba. */
  function selecionarAba(nome: string, { focar = false }: { focar?: boolean } = {}) {
    if (!ABAS.includes(nome)) return;
    visao.aba = nome;
    voltarParaLista();
    aplicarVisao();
    if (focar) el(`sebrae-aba-${nome}`)?.focus();
  }

  function definirTermo(texto: string) {
    const entrada = el("sebrae-filtro-termo");
    if (entrada && entrada.value !== texto) entrada.value = texto;
    if (texto === visao.termo) return;
    visao.termo = texto;
    visao.paginas = { antigos: POR_PAGINA, finalizados: POR_PAGINA };
    voltarParaLista();
    aplicarVisao();
  }

  function abrirFiltro(abrir: boolean) {
    const caixa = el("sebrae-filtro");
    if (!caixa) return;
    caixa.hidden = !abrir;
    el("btn-sebrae-filtro")?.setAttribute("aria-expanded", String(abrir));
    if (abrir) el("sebrae-filtro-termo")?.focus();
    else {
      definirTermo("");
      el("btn-sebrae-filtro")?.focus();
    }
  }

  /** Liga abas, lupa, filtro, `Ir para…` e `Carregar mais` uma vez, já na criação (a lista pode nunca chegar se a consulta falhar). */
  function instalarVisao() {
    ABAS.forEach((aba, indice) => {
      const botao = el(`sebrae-aba-${aba}`);
      botao?.addEventListener("click", () => selecionarAba(aba));
      botao?.addEventListener("keydown", evento => {
        const destino = { ArrowRight: indice + 1, ArrowLeft: indice - 1, Home: 0, End: ABAS.length - 1 }[evento.key];
        if (destino === undefined) return;
        evento.preventDefault();
        selecionarAba(ABAS[(destino + ABAS.length) % ABAS.length], { focar: true });
      });
      const painel = el(`sebrae-${aba}`);
      const ir = painel?.querySelector<ElementoSebrae>(".sebrae-vazio__ir");
      ir?.addEventListener("click", () => selecionarAba(ir.dataset.sebraeIr as string, { focar: true }));
      const mais = painel?.querySelector<ElementoSebrae>(".sebrae-mais__botao");
      mais?.addEventListener("click", () => {
        const anterior = visao.paginas[aba];
        visao.paginas[aba] = anterior + POR_PAGINA;
        aplicarVisao();
        // o botão some quando a lista acaba: o foco vai para a primeira linha que apareceu
        if (painel.querySelector<ElementoSebrae>("[data-sebrae-mais]")?.hidden) (el(`sebrae-${aba}-mestre`)?.children[anterior]?.querySelector<ElementoSebrae>("button") || el(`sebrae-${aba}-lista`)?.children[anterior]?.querySelector<ElementoSebrae>("summary"))?.focus();
      });
    });
    const lupa = el("btn-sebrae-filtro");
    lupa?.addEventListener("click", () => abrirFiltro(Boolean(el("sebrae-filtro")?.hidden)));
    const entrada = el("sebrae-filtro-termo");
    entrada?.addEventListener("input", () => definirTermo(entrada.value));
    entrada?.addEventListener("keydown", evento => {
      if (evento.key !== "Escape") return;
      evento.preventDefault(); // o campo de busca do Chrome limparia sozinho e o mesmo Esc ainda fecharia o filtro
      if (entrada.value) definirTermo("");
      else abrirFiltro(false);
    });
    el("btn-sebrae-limpar-filtro")?.addEventListener("click", () => {
      definirTermo("");
      entrada?.focus();
    });
    instalarMestre();
    instalarFalhas();
  }

  /** Leva a aba ao chamado (Novos > Antigos > Finalizados; só destaque → Destaques), limpa o filtro que o esconde, estende a página e abre a linha. Não rola nem destaca. */
  function mostrarChamadoSebrae(numero: string) {
    const chave = String(numero);
    const doNumero = visao.itens.filter(item => item.numero === chave);
    const alvo = ["novos", "antigos", "finalizados", "destaques"].map(aba => doNumero.find(item => item.aba === aba)).find(Boolean);
    if (!alvo) return null;
    if (!casaTermo(alvo, normalizar(visao.termo))) definirTermo("");
    const lista = el(`sebrae-${alvo.aba}-lista`);
    const posicao = lista ? [...lista.children].indexOf(alvo.no) : -1;
    if (visao.paginas[alvo.aba] !== undefined && posicao >= visao.paginas[alvo.aba]) visao.paginas[alvo.aba] = Math.ceil((posicao + 1) / POR_PAGINA) * POR_PAGINA;
    selecionarAba(alvo.aba);
    escolherChamado(alvo.no);
    return alvo.no.querySelector("article[data-numero]") || null;
  }

  /** Destaques fora das listas atuais (e as datas) vêm de GET /api/sebrae/observacoes; o que a pessoa mexeu enquanto isso não é sobrescrito. */
  async function carregarDestaques() {
    const consulta = estado.consulta;
    const versao = estado.destaqueVersao;
    try {
      const dados = await app.apiFetch("/api/sebrae/observacoes", { errorMessage: "Não foi possível consultar os destaques." });
      if (consulta !== estado.consulta) return;
      Object.entries((dados?.observacoes || {}) as Record<string, Registro>).forEach(([numero, reg]) => {
        if (!NUMERO_RASCUNHO.test(numero) || reg?.destaque !== true || estado.destaqueEditados.has(numero) || estado.destaqueOcupado.has(numero) || (estado.destaqueUltimo[numero]?.versao || 0) > versao) return;
        estado.destaques[numero] = { em: reg.destaque_em || "", observacao: typeof reg.observacao === "string" ? reg.observacao : undefined };
        sincronizarDestaque(numero);
      });
      definirTexto("sebrae-destaques-resumo", "");
      desenharDestaques();
    } catch (falha) { const error = falha as ErroApi;
      if (consulta === estado.consulta) definirTexto("sebrae-destaques-resumo", error.message);
    }
  }

  async function alternarDestaque(numero: string, botao: ElementoSebrae, feedback: ElementoSebrae) {
    if (estado.destaqueOcupado.has(numero)) return;
    estado.destaqueOcupado.add(numero);
    estado.destaqueEditados.add(numero);
    const ligar = !estado.destaques[numero];
    definirFeedback(feedback, "Salvando…", "salvando");
    try {
      const dados = await app.apiFetch(urlChamado(numero, "destaque"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destaque: ligar }),
        errorMessage: "Não foi possível salvar o destaque.",
      });
      const ligado = typeof dados?.destaque === "boolean" ? dados.destaque : ligar;
      if (ligado) estado.destaques[numero] = { em: dados?.destaque_em || "", observacao: estado.destaques[numero]?.observacao };
      else delete estado.destaques[numero];
      estado.destaqueUltimo[numero] = { versao: ++estado.destaqueVersao, ligado, em: dados?.destaque_em || "" };
      // lido depois da resposta: o botão pode ter sido refeito (autosave) e a pessoa pode ter saído dele durante o PUT
      const tinhaFoco = (document.activeElement as ElementoSebrae | null)?.dataset?.sebraeDestaque === numero;
      definirFeedback(feedback, "", "");
      anunciarDestaque(ligado ? "Destaque marcado." : "Destaque removido.");
      sincronizarDestaque(numero);
      // como em mostrarChamadoSebrae: o chamado em uso não pode sumir atrás de "Carregar mais"
      const posicao = [...(el("sebrae-finalizados-lista")?.children || [])].findIndex(li => (li as ElementoSebrae).dataset.numero === numero);
      if (posicao >= visao.paginas.finalizados) visao.paginas.finalizados = Math.ceil((posicao + 1) / POR_PAGINA) * POR_PAGINA;
      desenharDestaques();
      // details fechado e seção escondida não recebem foco: se o foco se perdeu, cai no resumo visível mais próximo
      const escondidoPorDetails = (n: ElementoSebrae) => {
        for (let d: Element | null | undefined = n.closest?.("details:not([open])"); d; d = d.parentElement?.closest?.("details:not([open])")) {
          if (!(n.tagName === "SUMMARY" && n.parentElement === d)) return true;
        }
        return false;
      };
      const focalizavel = (n: ElementoSebrae | null) => n?.isConnected && n !== document.body && !n.closest?.("[hidden]") && !escondidoPorDetails(n);
      if (tinhaFoco && !focalizavel(document.activeElement as ElementoSebrae | null)) {
        const original = nosDoChamado("[data-sebrae-destaque]", "sebraeDestaque", numero)[0];
        const resumos = [];
        for (let d: Element | null | undefined = original?.closest?.("details"); d; d = d.parentElement?.closest?.("details")) resumos.push(d.querySelector<ElementoSebrae>("summary"));
        // último recurso (chamado fora das listas e seção some): o título visível da primeira seção, nunca o body
        const titulo = el("sebrae-novos-secao");
        if (titulo && titulo.tabIndex < 0 && !titulo.hasAttribute("tabindex")) titulo.tabIndex = -1;
        [botao, original, el(`sebrae-aba-${visao.aba}`), ...resumos, titulo].find(focalizavel)?.focus?.();
      }
    } catch (falha) { const error = falha as ErroApi;
      definirFeedback(feedback, `Não foi possível salvar o destaque: ${error.message}`, "erro");
    } finally {
      estado.destaqueOcupado.delete(numero);
    }
  }

  /** Salvamentos de observação entram em fila: a última versão digitada é a que fica gravada. */
  function salvarObservacao(numero: string) {
    window.clearTimeout(estado.temporizadoresObs[numero]);
    const fila = (estado.salvandoObs[numero] || Promise.resolve(true)).then(() => enviarObservacao(numero));
    estado.salvandoObs[numero] = fila;
    return fila;
  }

  async function enviarObservacao(numero: string) {
    const reg = estado.observacoes[numero];
    if (!reg || !reg.textarea) return true;
    const texto = reg.textarea.value;
    if (texto === reg.enviado) {
      if (reg.feedback && reg.feedback.dataset.estado === "pendente") {
        definirFeedback(reg.feedback, "Salva automaticamente.", "");
      }
      return true;
    }
    definirFeedback(reg.feedback, "Salvando…", "salvando");
    try {
      const dados = await app.apiFetch(urlChamado(numero, "observacao"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observacao: texto }),
        errorMessage: "Não foi possível salvar a observação.",
      });
      reg.enviado = texto;
      if (dados && typeof dados.observacao === "string") {
        reg.enviado = dados.observacao;
        if (reg.textarea.value === texto) {
          reg.textarea.value = dados.observacao;
        }
      }
      definirFeedback(reg.feedback, "Salva.", "ok");
      sincronizarSeloObservacao(numero, reg.enviado);
      if (estado.destaques[numero]) desenharDestaques(); // o cartão da seção mostra a observação salva
      return true;
    } catch (falha) { const error = falha as ErroApi;
      definirFeedback(reg.feedback, `Não foi possível salvar: ${error.message}`, "erro");
      return false;
    }
  }

  async function enviarPdf(numero: string) {
    const ref = estado.refs.get(numero);
    const arquivo = ref?.arquivo.files?.[0];
    if (!arquivo) return;
    try {
      ocuparPdf(numero, 1);
      const corpo = new FormData();
      corpo.append("file", arquivo);
      definirFeedback(ref.feedbackPdf, "Enviando PDF…", "salvando");
      const dados = await app.apiFetch(urlChamado(numero, "anexo"), { method: "POST", body: corpo, errorMessage: "Não foi possível enviar o PDF." });
      estado.soft[numero].pdf = dados.pdf || null;
      estado.soft[numero].pdfRemocaoPendente = Boolean(dados.pdf_remocao_pendente);
      definirFeedback(ref.feedbackPdf, "PDF salvo.", "ok");
    } catch (falha) { const error = falha as ErroApi;
      definirFeedback(ref.feedbackPdf, `PDF não salvo: ${error.message}`, "erro");
    } finally {
      ref.arquivo.value = "";
      ocuparPdf(numero, -1);
    }
  }

  /** Enquanto o PDF vai ou sai, Finalizar e Atualizar Dashboard ficam travados (o chamado seguiria sem o anexo certo). */
  function ocuparPdf(numero: string, delta: 1 | -1) { // contador: envio e remoção simultâneos não destravam cedo
    const total = (estado.pdfOcupado.get(numero) ?? 0) + delta;
    if (total > 0) estado.pdfOcupado.set(numero, total); else estado.pdfOcupado.delete(numero);
    atualizarFinalizar(numero);
    atualizarBotaoAtualizar();
  }

  async function removerPdf(numero: string, somentePendentes = false) {
    const ref = estado.refs.get(numero);
    if (!ref) return;
    try {
      ocuparPdf(numero, 1);
      definirFeedback(ref.feedbackPdf, "Removendo PDF…", "salvando");
      const dados = await app.apiFetch(urlChamado(numero, "anexo") + (somentePendentes ? "?somente_pendentes=true" : ""), { method: "DELETE", errorMessage: "Não foi possível remover o PDF." });
      estado.soft[numero].pdf = dados.pdf || null;
      estado.soft[numero].pdfRemocaoPendente = Boolean(dados.pdf_remocao_pendente);
      definirFeedback(ref.feedbackPdf, "PDF removido.", "ok");
    } catch (falha) { const error = falha as ErroApi;
      const dados = error.data;
      if (error.status === 503 && dados?.numero === numero && dados.pdf_remocao_pendente === true && Object.hasOwn(dados, "pdf")) {
        estado.soft[numero].pdf = dados.pdf;
        estado.soft[numero].pdfRemocaoPendente = true;
      }
      definirFeedback(ref.feedbackPdf, `PDF não removido: ${error.message}`, "erro");
    } finally {
      ocuparPdf(numero, -1);
    }
  }

  /** A cópia de saída é refeita da importada: vão o próprio chamado (se novo, mesmo sem campos) e os outros novos que o usuário trabalhou
   * (campo diferente do padrão do próprio chamado: D/S, e também A/B/J no API SEBRAE), nunca novos em branco; edições dos antigos só com campo mudado. */
  function manuaisDoChamado(numero: string) {
    // título (G) digitado e diferente do que veio do SoftExpert também conta como trabalho no chamado novo
    const tituloMudado = (item: Registro) => { const digitado = String(estado.valores[item.numero]?.G ?? "").trim(); return Boolean(digitado) && digitado !== String(item.linha?.G ?? "").trim(); };
    const trabalhado = (item: Registro) => item.numero === numero || tituloMudado(item)
      || ["A", "B", "D", "J", "R", "S"].some(letra => { const valor = estado.valores[item.numero]?.[letra]; return valor && valor !== padroesManuais(item)[letra]; });
    return { chamados: payloadAtualizacao(estado.formulario.filter(trabalhado), estado.valores), edicoes: payloadEdicoes(estado.abertos, estado.edicoes) };
  }

  async function finalizarNoSoftExpert(numero: string) {
    const ref = estado.refs.get(numero);
    const soft = estado.soft[numero];
    if (!ref || ref.botao.disabled) return;
    const valores = valoresEfetivos(numero);
    const faltas = camposFaltando(valores, ref.texto.value);
    if (faltas.length) {
      app.showToast(`${numero}: antes de finalizar, preencha ${faltas.join(", ")}.`, "warning");
      return;
    }
    // O R confirmado no diálogo é o mesmo enviado em `encerramento` (regra de 24/11/2026: digitado pelo usuário, nunca a hora atual).
    const encerramento = encerramentoInformado(valores.R);
    // Payload e versão da importação são fixados agora: uma recarga durante o diálogo não pode anular o 409 de proteção.
    const manuais = manuaisDoChamado(numero);
    const versaoImportacao = estado.versaoImportacao;
    estado.finalizando.add(numero); // trava de Finalizar até o pedido terminar: nenhum recálculo de botão o reabilita
    atualizarFinalizar(numero);
    try {
      // incerto (26/11/2026): Finalizar já foi clicado; o novo pedido só confere a central de tarefas, sem clicar de novo
      const dialogo = soft?.finalizacao?.status === "incerto" ? {
        titulo: "Conferir no SoftExpert",
        mensagem: `O Finalizar de ${numero} já foi clicado e o resultado não foi confirmado. Este pedido não clica de novo: só confere a central de tarefas.`
          + ` Fora dela, o chamado é registrado como finalizado com a DT ENCERRAMENTO (R): ${encerramento}. Ainda nela, finalize à mão no SoftExpert.`,
        confirmar: "Conferir", cancelar: "Cancelar",
      } : {
        titulo: "Finalizar no SoftExpert",
        mensagem: `Finalizar ${numero} no SoftExpert? Finalizar não tem volta: o chamado será encerrado no SoftExpert com a descrição informada`
          + `${soft.pdf ? " e o PDF anexado será enviado" : ""}. DT ENCERRAMENTO (R): ${encerramento}.`
          + (soft.novo ? " Este chamado novo ainda não está no Dashboard: depois clique em Atualizar Dashboard para gravar o status FINALIZADO e a data de encerramento." : ""),
        confirmar: "Confirmar finalização", cancelar: "Cancelar",
      };
      // Antigo não encontrado na última leitura: o bloco laranja pede a caixa; sem ela (padrão) o servidor recusa "outro técnico".
      const naoEncontrado = estado.abertos.some(item => item.numero === numero && dadosAntigo(item).naoEncontrado);
      let confirmarOutroTecnico = false;
      let confirmado: boolean | null;
      if (naoEncontrado) {
        const resposta = await app.confirmarAcao({ ...dialogo, blocos: [blocoOutroTecnico(numero, valores)] });
        confirmado = resposta.confirmado;
        confirmarOutroTecnico = resposta.marcados.includes(numero);
      } else confirmado = await app.confirmarAcao(dialogo);
      if (!confirmado) return;
      if (!(await salvarDescricao(numero))) {
        app.showToast("Salve a descrição antes de finalizar.", "error");
        atualizarFinalizar(numero);
        return;
      }
      await guardarFicha(numero);
      try {
        await app.apiFetch("/api/sebrae/finalizar-softexpert", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numero, confirmado: true, confirmar_outro_tecnico: confirmarOutroTecnico, versao_importacao: versaoImportacao, encerramento, ...manuais }),
          errorMessage: "Não foi possível iniciar a finalização no SoftExpert.",
        });
      } catch (falha) { const error = falha as ErroApi;
        const atual = estado.soft[numero]; // uma recarga no meio troca o objeto do chamado
        if (atual) atual.finalizacao = { status: "erro", mensagem: error.message };
        atualizarFinalizar(numero);
        app.showToast(error.message, "error");
        return;
      }
      acompanharFechar([numero]);
    } finally {
      estado.finalizando.delete(numero);
      atualizarFinalizar(numero);
    }
  }

  /** Para a rotina em andamento (mesmo cancelamento da tela Automação); o acompanhamento mostra o resultado quando ela termina. */
  async function cancelarFinalizacao(numero: string) {
    const ref = estado.refs.get(numero);
    if (!ref || ref.cancelar.disabled) return;
    ref.cancelar.disabled = true;
    try {
      await app.apiFetch("/api/automacao/cancelar", { method: "POST", errorMessage: "Não foi possível cancelar a finalização." });
      app.showToast("Cancelamento pedido. A finalização para no próximo passo; confira no SoftExpert se o chamado ficou aberto.", "warning");
    } catch (falha) { const error = falha as ErroApi;
      app.showToast(error.message, "error");
    } finally {
      ref.cancelar.disabled = false;
    }
  }

  function renderizarFechar() {
    const host = el("sebrae-fechar");
    if (!host) return;
    const f = estado.fechar;
    const res = f.resultado;
    const aoVivo = f.emAndamento && Boolean(res?.em_andamento);
    const pulados = f.pulados.length ? f.pulados : res?.pulados || [];
    // Os finalizados saem daqui na hora (vão para "Chamados finalizados"); sobram só avisos, erros e pulados.
    const restantes = (res?.resultados || []).filter((r: Registro) => !STATUS_DESFEITOS.includes(r.status) || r.pdf_nao_reenviado === true);
    let status = "";
    if (f.emAndamento) status = `Finalizando no SoftExpert…${aoVivo && f.numeros.length ? ` ${(res?.resultados || []).length} de ${f.numeros.length} concluído(s).` : ""}`;
    else if (f.mensagemInicio) status = f.mensagemInicio;
    else if (res && (restantes.length || pulados.length || !(res.resultados || []).length)) status = resumoResultado({ ...res, resultados: restantes });
    host.hidden = !status;
    definirTexto("sebrae-fechar-status", status);
    host.setAttribute("aria-busy", f.emAndamento ? "true" : "false");
    const itens = [
      ...(f.emAndamento && !aoVivo ? [] : restantes.map((r: Registro) => ({ status: r.status, texto: `${[r.numero, identificacaoChamado(r.numero)].filter(Boolean).join(" · ")}: ${textoResultado(r)}` }))),
      ...pulados.map((p: Registro) => ({ status: "pulado", texto: textoPulado(p) })),
    ];
    el("sebrae-fechar-lista")?.replaceChildren(...itens.map(item => {
      const li = dom.createTextElement("li", "sebrae-fechar__item", item.texto);
      li.dataset.status = item.status;
      return li;
    }));
  }

  function renderizarSharepoint() {
    const host = el("sebrae-sharepoint-aviso");
    if (!host) return;
    const aviso = estado.fechar.sharepoint as Registro; // pode ser null: as leituras fora dos botões usam `?.`
    const recuperar = async (acao: string, confirmacao = "") => {
      try {
        const dados = await app.apiFetch("/api/sebrae/dashboard/envio/recuperar", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envio_id: aviso.envio_id, acao, confirmacao }),
          errorMessage: "Não foi possível recuperar o envio. Recarregue e confira o estado.",
        });
        estado.fechar.sharepoint = dados.sharepoint;
        renderizarSharepoint();
        // O servidor mantém a pendência quando sobra cópia não comprovada: sem este aviso o clique parecia não fazer nada.
        if (acao === "limpar" && dados.sharepoint?.limpeza_pendente) app.showToast("A limpeza não terminou: ainda há cópia local diferente do que foi enviado. Ela foi preservada; veja o aviso na tela.", "warning");
      } catch (falha) { const error = falha as ErroApi; app.showToast(error.message, "error"); }
    };
    const controlesRecuperacao = () => {
      if (!aviso.envio_id) return;
      host.appendChild(dom.createTextElement("p", "ck-campo__ajuda", `ID do envio: ${aviso.envio_id}`));
      if (!aviso.snapshot_disponivel) {
        if (aviso.legado && aviso.status === "confirmado" && !aviso.incerto) {
          host.appendChild(dom.createTextElement("p", "", `Confira o Dashboard no SharePoint e preserve/mova manualmente todos os arquivos, sidecars e subpastas para fora de ${aviso.pasta_pendente}. O sistema só conclui com a pasta vazia; não move nem exclui arquivos.`));
          const frase = "CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS";
          const entrada = document.createElement("input");
          entrada.type = "text";
          entrada.className = "ck-entrada";
          entrada.id = "sebrae-legado-confirmacao";
          const label = dom.createTextElement("label", "", `Após conferir e preservar, digite ${frase}`);
          label.setAttribute("for", entrada.id);
          const concluir = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm", "Concluir legado após conferência e preservação");
          concluir.type = "button";
          concluir.dataset.sebraeEnvioAcao = "concluir_legado";
          concluir.disabled = true;
          const atualizar = () => { concluir.disabled = estado.fechar.emAndamento || entrada.value !== frase; };
          entrada.addEventListener("input", atualizar);
          concluir.addEventListener("click", async () => { if (concluir.disabled) return; concluir.disabled = true; await recuperar("concluir_legado", entrada.value); atualizar(); });
          host.append(label, entrada, concluir);
          return;
        }
        host.appendChild(dom.createTextElement("p", "", "Este envio não tem cópia local verificável. A recuperação permanece bloqueada; preserve os arquivos para conferência."));
        return;
      }
      host.appendChild(botaoBaixarCopia("Baixar cópia local deste envio para conferir", aviso.envio_id));
      if (!aviso.incerto) {
        const limpar = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm", "Tentar limpar cópias já enviadas");
        limpar.type = "button";
        limpar.dataset.sebraeEnvioAcao = "limpar";
        limpar.disabled = estado.fechar.emAndamento;
        limpar.addEventListener("click", async () => { limpar.disabled = true; await recuperar("limpar"); limpar.disabled = estado.fechar.emAndamento; });
        host.appendChild(limpar);
        return;
      }
      host.appendChild(dom.createTextElement("p", "", "O sistema não consultou o SharePoint. Compare o conteúdo do Dashboard com a cópia local antes de declarar o resultado. A declaração não dispara upload."));
      // 25/11/2026: "CONFIRMO APLICADO" foi digitado sem o arquivo ter chegado; a data, o aviso e o tamanho não provam o envio.
      host.appendChild(dom.createTextElement("p", "", "Para conferir: feche o Dashboard no Excel (Online e desktop), abra o Dashboard no SharePoint e veja se as linhas alteradas por este envio estão lá. A data de modificação, um aviso de envio ou o tamanho do arquivo não provam que o envio chegou."));
      const entrada = document.createElement("input");
      entrada.id = "sebrae-envio-confirmacao";
      entrada.className = "ck-entrada";
      entrada.type = "text";
      entrada.autocomplete = "off";
      const label = dom.createTextElement("label", "", "Digite CONFIRMO APLICADO ou CONFIRMO NAO APLICADO, conforme a conferência realizada.");
      label.setAttribute("for", entrada.id);
      host.append(label, entrada);
      for (const [acao, frase, texto] of [["confirmar_recebimento", "CONFIRMO APLICADO", "Declaro que está aplicado no SharePoint"], ["declarar_nao_enviado", "CONFIRMO NAO APLICADO", "Declaro que não está aplicado no SharePoint"]]) {
        const botao = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm", texto);
        botao.type = "button";
        botao.dataset.sebraeEnvioAcao = acao;
        botao.disabled = true;
        const atualizar = () => { botao.disabled = estado.fechar.emAndamento || entrada.value !== frase; };
        entrada.addEventListener("input", atualizar);
        botao.addEventListener("click", async () => { if (botao.disabled) return; botao.disabled = true; await recuperar(acao, entrada.value); atualizar(); });
        host.appendChild(botao);
      }
    };
    if (aviso?.recuperacao && !aviso.limpeza_pendente && !aviso.incerto) {
      const naoEnviado = aviso.status === "falhou" && aviso.recuperacao.acao === "declarar_nao_enviado";
      // Fechar só esconde o aviso desta recuperação (chave = envio_id); um novo envio tem outro ID e o aviso volta.
      const chaveRecuperacao = "sebrae_sharepoint_recuperacao_descartada";
      let fechado = "";
      try { fechado = armazenamento?.getItem(chaveRecuperacao) || ""; } catch (_erro) { /* sem armazenamento: aviso continua visível */ }
      if (!naoEnviado && aviso.envio_id && fechado === aviso.envio_id) {
        host.hidden = true;
        host.replaceChildren();
        return;
      }
      host.replaceChildren(dom.createTextElement("p", "", naoEnviado
        ? "Você declarou que este envio não está aplicado no SharePoint. As cópias foram preservadas. Nenhum upload foi disparado."
        : aviso.reenvio_confirmado
          ? "Esta cópia foi reenviada ao SharePoint com sucesso. A fila pendente foi preservada."
          : "Recuperação concluída. A limpeza das cópias comprovadamente cobertas terminou. Nenhum upload foi disparado."));
      if (aviso.recuperacao.acao === "concluir_legado") host.replaceChildren(dom.createTextElement("p", "", `Conclusão manual do legado ${aviso.envio_id} registrada após conferência e pasta vazia. Nenhum arquivo foi movido ou excluído pelo sistema; nenhum upload foi disparado.`));
      if (naoEnviado) {
        host.appendChild(dom.createTextElement("p", "ck-campo__ajuda", `Esta cópia: ${aviso.envio_id}; SHA-256: ${aviso.sha256 || "indisponível"}. A fila pendente será preservada.`));
        host.appendChild(botaoBaixarCopia("Baixar ESTA cópia para revisar", aviso.envio_id));
        const reenviar = dom.createTextElement("button", "ck-btn ck-btn--secundario ck-btn--sm", "Revisar e reenviar ESTA cópia");
        reenviar.type = "button";
        reenviar.id = "btn-sebrae-reenviar-snapshot";
        reenviar.dataset.sebraeEnvioAcao = "reenviar_snapshot";
        reenviar.disabled = estado.fechar.emAndamento || !aviso.snapshot_disponivel || !/^[a-f0-9]{64}$/.test(aviso.sha256 || "");
        reenviar.addEventListener("click", async () => {
          if (reenviar.disabled || !(await app.confirmarAcao({ titulo: "Reenviar ESTA cópia", mensagem: `Reenvia somente a cópia revisada ${aviso.envio_id}, SHA-256 ${aviso.sha256}. A fila existente não será escolhida nem alterada. Confirme após conferir esta cópia e a declaração de que não está aplicada no SharePoint.`, confirmar: "Reenviar esta cópia", cancelar: "Cancelar" }))) return;
          reenviar.disabled = true;
          try {
            await app.apiFetch("/api/sebrae/dashboard/envio/reenviar-snapshot", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envio_id: aviso.envio_id, sha256: aviso.sha256, confirmado: true }),
              errorMessage: "Não foi possível reenviar esta cópia. Recarregue e confira o ID e o estado.",
            });
            acompanharFechar([]);
          } catch (falha) { const error = falha as ErroApi; reenviar.disabled = false; app.showToast(error.message, "error"); }
        });
        host.appendChild(reenviar);
      } else {
        const fecharAviso = dom.createTextElement("button", "ck-btn ck-btn--fantasma ck-btn--sm", "Fechar aviso");
        fecharAviso.type = "button";
        fecharAviso.id = "btn-sebrae-fechar-recuperacao";
        fecharAviso.addEventListener("click", () => {
          try { armazenamento?.setItem(chaveRecuperacao, aviso.envio_id || ""); } catch (_erro) { /* sem armazenamento: esconde só nesta tela */ }
          host.hidden = true;
          host.replaceChildren();
        });
        host.appendChild(fecharAviso);
      }
      host.hidden = false;
      return;
    }
    if (aviso?.incerto) {
      host.replaceChildren(dom.createTextElement("p", "", "O resultado do envio é incerto. Confira o Dashboard no SharePoint e reconcilie o registro local manualmente antes de repetir. Nenhuma cópia local foi descartada automaticamente."));
      host.hidden = false;
      controlesRecuperacao();
      return;
    }
    if (aviso?.limpeza_pendente && !aviso.falhou) {
      host.replaceChildren(dom.createTextElement("p", "", "Dashboard enviado ao SharePoint. Cópias locais foram preservadas porque a limpeza não foi concluída. Confira-as antes de qualquer reenvio."));
      if (aviso.envio_id && aviso.snapshot_disponivel && aviso.pasta_pendente) host.appendChild(dom.createTextElement("p", "ck-campo__ajuda", `Ainda há cópia diferente do que foi enviado em ${aviso.pasta_pendente}. O sistema não a remove: preserve-a em outro lugar e tente limpar de novo.`));
      host.hidden = false;
      controlesRecuperacao();
      return;
    }
    // Descarte só esconde o aviso desta cópia (chave = caminho da cópia); nova falha gera nova cópia e o aviso volta.
    const chaveDescarte = "sebrae_sharepoint_aviso_descartado";
    const idAviso = aviso?.copia_local || aviso?.motivo || "";
    let descartado = "";
    try { descartado = armazenamento?.getItem(chaveDescarte) || ""; } catch (_erro) { /* sem armazenamento: aviso continua visível */ }
    if (!aviso?.falhou || (idAviso && descartado === idAviso)) {
      host.hidden = true;
      host.replaceChildren();
      return;
    }
    const temCopia = Boolean(aviso.copia_local); // sem cópia local não há o que reenviar
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "ck-btn ck-btn--secundario ck-btn--sm";
    botao.id = "btn-sebrae-reenviar";
    botao.textContent = "Tentar substituir de novo";
    botao.disabled = estado.fechar.emAndamento;
    botao.addEventListener("click", reenviarPendente);
    const descartar = dom.createTextElement("button", "ck-btn ck-btn--fantasma ck-btn--sm", "Já atualizei manualmente, descartar aviso");
    descartar.type = "button";
    descartar.id = "btn-sebrae-descartar-aviso";
    descartar.addEventListener("click", () => {
      try { armazenamento?.setItem(chaveDescarte, idAviso); } catch (_erro) { /* sem armazenamento: esconde só nesta tela */ }
      host.hidden = true;
      host.replaceChildren();
    });
    const acoes = document.createElement("div");
    acoes.className = "sebrae-sharepoint__acoes";
    if (temCopia) acoes.append(botao);
    acoes.append(descartar);
    const copiaCodigo = document.createElement("code");
    copiaCodigo.textContent = aviso.copia_local || "—";
    const copia = document.createElement("p");
    copia.append("Cópia local pendente: ", copiaCodigo);
    const sugestoes = document.createElement("ol");
    (aviso.sugestoes || []).forEach((texto: string) => sugestoes.appendChild(dom.createTextElement("li", "", texto)));
    host.replaceChildren(
      dom.createTextElement("strong", "", "O Dashboard não foi substituído no SharePoint."),
      dom.createTextElement("p", "", `Motivo: ${aviso.motivo || "não informado"}.`),
      ...(temCopia ? [copia,
        dom.createTextElement("p", "", aviso.copia_sharepoint
          ? "A cópia pendente também foi enviada à pasta DASHBOARD SEBRAE, com outro nome."
          : "A cópia pendente não foi enviada ao SharePoint: ela está só neste computador.")] : []),
      dom.createTextElement("p", "ck-campo__ajuda", "O que fazer:"),
      sugestoes, acoes,
    );
    host.hidden = false;
  }

  /** Repete no campo o Encerramento (R) que o servidor gravou: é o digitado pelo usuário (regra de 24/11/2026), nunca o horário do SoftExpert. */
  function mostrarEncerramentoSoftExpert(r: Registro) {
    const valor = STATUS_DESFEITOS.includes(r.status) ? encerramentoParaCampo(r.encerrado_em) : "";
    if (!valor) return;
    [estado.valores, estado.edicoes].forEach(guardados => { if (guardados[r.numero] && "R" in guardados[r.numero]) guardados[r.numero].R = valor; });
    document.querySelectorAll<ElementoSebrae>(`[data-sebrae-campo="R"][data-sebrae-numero="${CSS.escape(r.numero)}"]`).forEach(controle => { controle.value = valor; });
  }

  /** Título e solicitante (nome completo) do chamado, para o resultado da finalização dizer de qual se trata. */
  function identificacaoChamado(numero: string) {
    const antigo = estado.abertos.find(item => item.numero === numero);
    const novo = estado.formulario.find(item => item.numero === numero);
    const dadosDoAntigo = antigo ? dadosAntigo(antigo) : null;
    const titulo = dadosDoAntigo || novo ? tituloEfetivo(numero) : "";
    const solicitante = dadosDoAntigo ? dadosDoAntigo.solicitante : novo?.linha?.I;
    return [titulo, solicitante].map(parte => String(parte || "").trim()).filter(Boolean).join(" · ");
  }

  /** Aplica o que o GET trouxe: estado da rotina, resultado por chamado (também nos cartões) e aviso do SharePoint. */
  function aplicarFechar(dados?: Registro | null) {
    const f = estado.fechar;
    f.emAndamento = Boolean(dados?.em_andamento);
    f.resultado = dados?.resultado || null;
    f.sharepoint = dados?.sharepoint || null;
    (f.resultado?.resultados || []).forEach((r: Registro) => {
      const soft = estado.soft[r.numero];
      if (!soft) return;
      soft.finalizacao = { status: r.status, em: r.em, encerrado_em: r.encerrado_em, mensagem: r.mensagem };
      soft.processando = false;
      mostrarEncerramentoSoftExpert(r);
    });
    if (!f.emAndamento) Object.values(estado.soft).forEach(soft => {
      if (soft.processando && f.resultado?.cancelado) soft.cancelado = true;
      soft.processando = false;
    });
    renderizarFechar();
    renderizarSharepoint();
    atualizarTodosFinalizar();
    moverFinalizados(f);
  }

  /** Todo chamado `ok` sai da lista de abertos e aparece em "Chamados finalizados" assim que o SoftExpert confirma (uma recarga por novo `ok`). */
  function moverFinalizados(f: EstadoSebrae["fechar"]) {
    const finalizados = (f.resultado?.resultados || []).filter((r: Registro) => STATUS_DESFEITOS.includes(r.status));
    const oks = finalizados.filter((r: Registro) => r.status === "ok");
    const chave = `${f.resultado?.iniciado_em || ""}:${finalizados.length}`;
    if (!finalizados.length || f.recarregado === chave) return;
    f.recarregado = chave;
    const outros = finalizados.length - oks.length;
    app.showToast(oks.length ? `${oks.length} chamado(s) finalizado(s) no SoftExpert.${outros ? ` ${outros} finalizado(s) por outro técnico.` : ""} Veja em Chamados finalizados.`
      : `${outros} chamado(s) finalizado(s) por outro técnico. Veja em Chamados finalizados.`, "success");
    // A lista na tela já foi pedida depois do fim da rotina (ex.: resultado antigo ao abrir a página): recarregar só repetiria as mesmas consultas.
    // +1 s: `terminado_em` vem sem milissegundos.
    const terminou = Date.parse(f.resultado?.terminado_em || "");
    if (!(terminou + 1000 < (estado.novosPedidoEm ?? 0))) carregarNovosSebrae();
  }

  /** Consulta a rotina até terminar; erros passageiros de rede não derrubam o acompanhamento. */
  async function acompanharFechar(numeros: string[]) {
    const f = estado.fechar;
    const token = ++f.token;
    const anterior = f.resultado?.iniciado_em;
    f.emAndamento = true;
    f.numeros = numeros;
    numeros.forEach(numero => { if (estado.soft[numero]) Object.assign(estado.soft[numero], { processando: true, cancelado: false }); });
    renderizarFechar();
    renderizarSharepoint();
    atualizarTodosFinalizar();
    let visto = false;
    let esperas = 0;
    let falhas = 0;
    while (token === f.token) {
      await esperar(INTERVALO_FECHAR_MS);
      if (token !== f.token) return;
      let dados;
      try {
        dados = await app.apiFetch("/api/sebrae/finalizar-softexpert", { errorMessage: "Não foi possível consultar a finalização." });
        falhas = 0;
      } catch (falha) { const error = falha as ErroApi;
        if (++falhas < 5) continue;
        f.emAndamento = false;
        f.mensagemInicio = `Não foi possível acompanhar a finalização: ${error.message}`;
        Object.values(estado.soft).forEach(soft => { soft.processando = false; });
        renderizarFechar();
        atualizarTodosFinalizar();
        return;
      }
      visto = visto || Boolean(dados.em_andamento);
      const comecou = visto || dados.resultado?.iniciado_em !== anterior;
      if (!dados.em_andamento && !comecou && ++esperas < 4) continue; // a rotina ainda não começou a responder
      f.mensagemInicio = "";
      const recarregadoAntes = f.recarregado;
      aplicarFechar(dados);
      if (!dados.em_andamento) {
        document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes")); // o sino mostra na hora a falha ao finalizar
        if (Number(dados.conflitos) > 0 && f.recarregado === recarregadoAntes) carregarNovosSebrae(); // ex.: reenviar sem itens em resultados; moverFinalizados já recarrega nos outros casos
        return;
      }
    }
  }

  /** Uma consulta ao abrir a lista: pega rotina em andamento, o último resultado e o aviso do SharePoint. */
  async function carregarFechar() {
    try {
      const dados = await app.apiFetch("/api/sebrae/finalizar-softexpert", { errorMessage: "Não foi possível consultar a finalização." });
      if (estado.fechar.emAndamento) return; // o acompanhamento em curso já atualiza a tela
      aplicarFechar(dados);
      if (dados.em_andamento) acompanharFechar([]);
    } catch (_erro) {
      // Sem o resultado da rotina a tela segue funcionando; a próxima consulta traz o aviso de volta.
    }
  }

  // ---- Ler chamados antigos: o POST inicia a rotina `antigos`; o GET acompanha e guarda o último resultado ----

  function renderizarAntigos() {
    const a = estado.antigos;
    definirTexto("sebrae-antigos-leitura-status", a.mensagem || resumoLeituraAntigos(a.resultado, a.emAndamento, formatarDataHora(a.resultado?.em), a.anteriorEm));
    const botao = el("btn-sebrae-ler-antigos");
    if (botao) a.emAndamento ? botao.setAttribute("aria-busy", "true") : botao.removeAttribute("aria-busy");
    // Chips e lista de falhas (leitura.tsx): somem durante a leitura; sem falhas, o popover fecha.
    const resultado = a.emAndamento ? null : a.resultado;
    leitura.atualizar({ resultado, falhasAbertas: leitura.ler().falhasAbertas && Object.keys(resultado?.falhas || {}).length > 0 });
    atualizarTodosFinalizar(); // "Conferir este chamado" fica desabilitado enquanto a leitura roda
  }

  const abrirFalhas = (abrir: boolean) => leitura.atualizar({ falhasAbertas: abrir });

  /** O chip `N falhas` abre e fecha o popover; Esc e clique fora fecham. */
  function instalarFalhas() {
    const botao = el("btn-sebrae-falhas");
    botao?.addEventListener("click", () => abrirFalhas(!leitura.ler().falhasAbertas));
    document.addEventListener?.("keydown", evento => {
      if (evento.key !== "Escape" || !leitura.ler().falhasAbertas) return;
      abrirFalhas(false);
      botao?.focus();
    });
    document.addEventListener?.("click", evento => {
      if (leitura.ler().falhasAbertas && !(evento.target as ElementoSebrae).closest?.("#sebrae-leitura-falhas")) abrirFalhas(false);
    });
  }

  function aplicarAntigos(dados?: Registro | null) {
    const a = estado.antigos;
    a.emAndamento = Boolean(dados?.em_andamento);
    a.resultado = dados?.resultado || null;
    a.mensagem = "";
    renderizarAntigos();
  }

  /** Consulta a leitura até terminar; erros passageiros de rede não derrubam o acompanhamento. Ao fim recarrega a lista. */
  async function acompanharAntigos() {
    const a = estado.antigos;
    const token = ++a.token;
    a.anteriorEm = a.resultado?.em ?? null;
    a.emAndamento = true;
    a.mensagem = "";
    renderizarAntigos();
    let visto = false;
    let esperas = 0;
    let falhas = 0;
    while (token === a.token) {
      await esperar(INTERVALO_FECHAR_MS);
      if (token !== a.token) return;
      let dados;
      try {
        dados = await app.apiFetch("/api/sebrae/antigos/ler", { errorMessage: "Não foi possível consultar a leitura dos chamados antigos." });
        falhas = 0;
      } catch (falha) { const error = falha as ErroApi;
        if (++falhas < 5) continue;
        a.emAndamento = false;
        a.mensagem = `Não foi possível acompanhar a leitura dos chamados antigos: ${error.message}`;
        renderizarAntigos();
        return;
      }
      visto = visto || Boolean(dados.em_andamento);
      const comecou = visto || (dados.resultado?.em ?? null) !== a.anteriorEm;
      if (!dados.em_andamento && !comecou && ++esperas < 4) continue; // a rotina ainda não começou a responder
      aplicarAntigos(dados);
      if (dados.em_andamento) continue;
      if (comecou && dados.resultado) {
        const limpa = dados.resultado.concluido && !Object.keys(dados.resultado.falhas || {}).length;
        app.showToast(resumoLeituraAntigos(dados.resultado, false), limpa ? "success" : "warning");
      }
      carregarNovosSebrae();
      return;
    }
  }

  /** Uma consulta ao abrir a lista: pega leitura em andamento e o último resultado. */
  async function carregarAntigos() {
    const a = estado.antigos;
    try {
      const dados = await app.apiFetch("/api/sebrae/antigos/ler", { errorMessage: "Não foi possível consultar a leitura dos chamados antigos." });
      if (a.emAndamento) return; // o acompanhamento em curso já atualiza a tela
      aplicarAntigos(dados);
      if (dados.em_andamento) acompanharAntigos();
    } catch (_erro) {
      // Sem o resultado a lista segue funcionando; a próxima consulta traz o texto de volta.
    }
  }

  async function lerAntigosSebrae() {
    const a = estado.antigos;
    if (a.emAndamento) return;
    const botao = el("btn-sebrae-ler-antigos");
    botao?.setAttribute("aria-busy", "true");
    try {
      await app.apiFetch("/api/sebrae/antigos/ler", { method: "POST", errorMessage: "Não foi possível iniciar a leitura dos chamados antigos." });
    } catch (falha) { const error = falha as ErroApi;
      // 409 = outra rotina em andamento (aviso); 503 sem runner e 422 sem Dashboard importado são erros.
      a.mensagem = error.message;
      renderizarAntigos();
      app.showToast(error.message, error.status === 409 ? "warning" : "error");
      return;
    }
    app.showToast("Leitura dos chamados antigos iniciada.", "success");
    app.atualizarEstadoAutomacao?.(); // habilita o Cancelar execução sem esperar a próxima consulta da Automação
    acompanharAntigos();
  }

  /** "Conferir este chamado": relê no SoftExpert só este antigo e acompanha como a leitura de todos (recarrega a lista ao fim). */
  async function conferirAntigo(numero: string) {
    const a = estado.antigos;
    if (a.emAndamento) return;
    try {
      await app.apiFetch("/api/sebrae/antigos/ler", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ numero }),
        errorMessage: "Não foi possível conferir o chamado no SoftExpert.",
      });
    } catch (falha) { const error = falha as ErroApi;
      app.showToast(error.message, error.status === 409 ? "warning" : "error");
      return;
    }
    app.showToast(`Conferindo ${numero} no SoftExpert.`, "success");
    app.atualizarEstadoAutomacao?.();
    acompanharAntigos();
  }

  async function reenviarPendente() {
    const botao = el("btn-sebrae-reenviar");
    if (botao) botao.disabled = true;
    try {
      await app.apiFetch("/api/sebrae/dashboard/pendente/reenviar", { method: "POST", errorMessage: "Não foi possível reenviar a cópia pendente." });
    } catch (falha) { const error = falha as ErroApi;
      if (botao) botao.disabled = false;
      app.showToast(error.message, "error");
      return;
    }
    acompanharFechar([]);
  }

  /** Lê o campo `fechar` do Atualizar; qualquer falha aqui só some com a informação, nunca estraga a atualização. */
  function tratarFechar(fechar?: Registro | null) {
    try {
      if (!fechar || typeof fechar !== "object") return;
      const f = estado.fechar;
      f.pulados = Array.isArray(fechar.pulados) ? fechar.pulados : [];
      f.mensagemInicio = resumoInicio(fechar);
      if (fechar.iniciado) acompanharFechar(Array.isArray(fechar.numeros) ? fechar.numeros : []);
      else {
        f.emAndamento = false;
        renderizarFechar();
      }
    } catch (_erro) {
      // O arquivo já foi baixado; a finalização pode ser acompanhada depois pelo botão de cada chamado.
    }
  }

  function aoEditar(event: { currentTarget: EventTarget | null }) {
    const alvo = event.currentTarget as ElementoSebrae;
    const { sebraeNumero, sebraeCampo, sebraeAlvo } = alvo.dataset as Record<string, string>;
    const guardados = valoresDe(sebraeAlvo);
    guardados[sebraeNumero] = { ...(guardados[sebraeNumero] || {}), [sebraeCampo]: alvo.value };
    destacarFinalizado(alvo);
    if (sebraeCampo === "D" || sebraeCampo === "R") sincronizarEncerramento(alvo.closest<ElementoSebrae>(".sebrae-chamado__manuais"), sebraeNumero, sebraeAlvo);
    if (sebraeCampo === "G") mostrarTituloDigitado(alvo);
    if (gravarCampoRascunho(armazenamento, estado.importadoEm, sebraeNumero, sebraeCampo, alvo.value, sebraeAlvo)) {
      const tipo = sebraeAlvo === "antigo" ? "edicoes" : "valores";
      if (estado.naoSalvos[tipo][sebraeNumero]) {
        delete estado.naoSalvos[tipo][sebraeNumero][sebraeCampo];
        if (!Object.keys(estado.naoSalvos[tipo][sebraeNumero]).length) delete estado.naoSalvos[tipo][sebraeNumero];
      }
      mostrarRascunho("Rascunho salvo automaticamente neste navegador.", "ok");
    } else {
      const tipo = sebraeAlvo === "antigo" ? "edicoes" : "valores";
      estado.naoSalvos[tipo][sebraeNumero] = { ...estado.naoSalvos[tipo][sebraeNumero], [sebraeCampo]: alvo.value };
      mostrarRascunho("Não foi possível salvar o rascunho. Mantenha esta aba aberta e copie suas edições antes de recarregar.", "erro");
    }
    atualizarBotaoAtualizar();
  }

  /** `situacao` vai para `data-estado` do bloco (o CSS pinta a bolinha): "ok" = salvo agora; vazio = restaurado/descartado. */
  function mostrarRascunho(texto: string, situacao = "", detalhes: ItemRascunho[] = []) {
    // O bloco some sem texto; cada chamada recolhe a lista "Ver detalhes" de novo (avisos-rascunho.tsx).
    rascunhoTela.atualizar({ texto, situacao, detalhes, versao: rascunhoTela.ler().versao + 1 });
  }

  /** Linhas do detalhe do rascunho: um chamado por linha, com as seleções (A, B, D, J, R, S) lado a lado. */
  function detalhesRascunho(pendentes: [string, Registro][], conflitos: string[]) {
    return [
      ...pendentes.map(([numero, campos]) => ({ numero, campos: Object.entries(campos).map(([letra, valor]) => [letra, String(valor)] as [string, string]) })),
      ...conflitos,
    ];
  }

  /** Volta ao que o Dashboard importado traz: apaga o rascunho e refaz a tela (se a consulta falhar, nada muda). */
  async function descartarRascunhoSebrae() {
    const confirmado = await app.confirmarAcao({
      titulo: "Descartar rascunho",
      mensagem: "Descartar o que foi preenchido e ainda não passou por Atualizar Dashboard? Os campos voltam ao que o Dashboard importado traz.",
      confirmar: "Descartar rascunho", cancelar: "Cancelar",
    });
    if (!confirmado) return;
    estado.descartar = true;
    try {
      await carregarNovosSebrae();
    } finally {
      estado.descartar = false;
    }
  }

  /** Antigos em aberto (com UTIC) cuja descrição editada no lápis difere da coluna H importada: "Atualizar" a grava na cópia. Só conta; o servidor confere de novo. */
  function totalDescricoesAEnviar() {
    return estado.abertos.filter(item => NUMERO_UTIC.test(item.numero) && !estado.finalizados.has(item.numero)).filter(item => {
      const editada = String(item.softexpert?.descricao_editada ?? "").trim();
      return editada && !descricaoJaNoDashboard(editada, item.descricao);
    }).length;
  }

  function atualizarBotaoAtualizar() {
    const alteracoes = payloadEdicoes(estado.abertos, estado.edicoes).length + totalDescricoesAEnviar();
    const preenchimentos = totalPreenchimentos(estado.abertos);
    const visiveis = estado.abertos.filter(item => !estado.finalizados.has(item.numero)).length;
    // o resumo também é o vazio da aba Antigos (CSS): escrito mesmo sem o botão Atualizar montado
    definirTexto("sebrae-antigos-resumo", visiveis
      ? `${visiveis} chamado(s) antigo(s) em aberto ou sem status; ${alteracoes} com alteração e ${preenchimentos} com Série, Modelo, Cidade ou OS a preencher.`
      : "Nenhum chamado antigo em aberto ou sem status.");
    const faltaEncerramento = mostrarFaltaEncerramento(pendentesEncerramento());
    const botao = el("btn-sebrae-atualizar");
    if (!botao) return;
    botao.disabled = !estado.atualizavel || faltaEncerramento || botao.getAttribute("aria-busy") === "true" || estado.pdfOcupado.size > 0 || (estado.formulario.length === 0 && alteracoes === 0 && preenchimentos === 0);
  }

  function renderizarAvisos(novos?: Registro | null) {
    avisos.atualizar({ itens: [
      ...(novos?.pendentes || []).map((p: Registro) => `${p.numero}: pendente. ${p.motivo}`),
      ...Object.entries(novos?.erros || {}).map(([numero, motivo]) => `${numero}: não foi lido. ${motivo}`),
    ] });
  }

  function renderizar(dados: Registro, versaoDestaque = estado.destaqueVersao) {
    estado.rascunhoExterno = false;
    const importado = dados.importado;
    estado.listas = importado?.listas || {};
    estado.abertos = importado?.abertos || [];
    estado.atualizavel = Boolean(importado?.atualizavel);
    estado.importadoEm = importado?.versao || importado?.importado_em || "";
    estado.versaoImportacao = importado?.versao || "";
    if (estado.descartar) {
      apagarRascunho(armazenamento);
      estado.valores = {};
      estado.naoSalvos = { valores: {}, edicoes: {} };
    }
    const novos = dados.novos;
    const guardado = lerRascunho(armazenamento, estado.importadoEm);
    (["valores", "edicoes"] as const).forEach(tipo => Object.entries(estado.naoSalvos[tipo]).forEach(([numero, campos]) => {
      guardado[tipo][numero] = { ...guardado[tipo][numero], ...campos };
    }));
    const rascunho = aplicarRascunho(guardado, novos?.formulario, estado.abertos, estado.importadoEm);
    estado.edicoes = rascunho.edicoes;
    estado.valores = rascunho.valores;
    const salvoEm = formatarDataHora(rascunho.salvoEm);
    mostrarRascunho(estado.descartar ? "Rascunho descartado." : rascunho.restaurado ? `Rascunho restaurado${salvoEm ? ` (salvo em ${salvoEm})` : ""}. Passe por Atualizar Dashboard para gravar no arquivo.` : "");
    if (rascunho.conflitos.length) mostrarRascunho("Rascunho preservado com divergências; o arquivo importado prevalece nos campos já preenchidos.", "alerta", detalhesRascunho([], rascunho.conflitos));
    if (rascunho.pendentes.length) mostrarRascunho(`Rascunhos preservados sem correspondência nesta importação (${rascunho.pendentes.length}).`, "alerta", detalhesRascunho(rascunho.pendentes, rascunho.conflitos));
    if (Object.values(estado.naoSalvos).some(itens => Object.keys(itens).length)) mostrarRascunho("Há edições preservadas apenas nesta aba porque o navegador não conseguiu salvá-las. Copie os valores antes de recarregar.", "erro");
    estado.soft = {};
    estado.observacoes = {}; // os campos novos se registram de novo; texto não salvo volta por `reaplicarNaoSalvos`
    estado.refs.clear();
    const finalizados: Registro[] = importado?.finalizados || [];
    estado.finalizados = new Set(finalizados.map(item => item.numero));
    estado.finalizadosItens = finalizados;
    estado.formulario = novos?.formulario || []; // antes dos cartões: `cartaoDestaque` e `resumoChamado` leem daqui
    // Destaques das listas (a data e os de fora das listas chegam em carregarDestaques); refeito a cada recarga.
    const anteriores = estado.destaques;
    estado.destaques = {};
    estado.destaqueEditados = new Set(estado.destaqueOcupado); // PUT em andamento: o número segue "mexido" até a resposta chegar
    [...estado.formulario, ...estado.abertos, ...finalizados].forEach(item => { if (item.destaque === true) estado.destaques[item.numero] = { em: anteriores[item.numero]?.em || "" }; });
    // lista lida antes de um PUT que já terminou (ou com ele em andamento): vale o resultado do PUT, não o da lista
    Object.entries(estado.destaqueUltimo).forEach(([numero, ultimo]) => {
      if (ultimo.versao <= versaoDestaque && !estado.destaqueOcupado.has(numero)) return;
      if (ultimo.ligado) estado.destaques[numero] = { em: ultimo.em, observacao: anteriores[numero]?.observacao };
      else delete estado.destaques[numero];
    });
    estado.destaqueOcupado.forEach(numero => { if (anteriores[numero]) estado.destaques[numero] = anteriores[numero]; else delete estado.destaques[numero]; });
    const emAberto = (item: Registro) => !estado.finalizados.has(item.numero); // os `ok` seguem em estado.abertos/formulario só para não perder A, B, J e S no Atualizar
    const antigos = estado.abertos.filter(emAberto);
    const linhasAntigos = antigos.map(blocoAntigo);
    el("sebrae-antigos-lista")?.replaceChildren(...linhasAntigos);
    // na ordem do servidor (data de finalização, a mais recente primeiro); o destaque não muda a posição
    const linhasFinalizados = finalizados.map(item => {
      const li = textoFinalizado(item);
      li.dataset.numero = item.numero;
      return li;
    });
    el("sebrae-finalizados-lista")?.replaceChildren(...linhasFinalizados);
    definirTexto("sebrae-finalizados-resumo", `${finalizados.length} chamado(s) finalizado(s) no SoftExpert.`);
    definirTexto("sebrae-dashboard-status", importado
      ? `Dashboard importado: ${importado.arquivo || "sem nome"} (${importado.total} chamados já lançados).${importado.atualizavel ? "" : " Não dá para atualizar a cópia: importe de novo."}`
      : "Nenhum Dashboard importado.");
    // "Enviar ao SharePoint" só tem o que enviar depois de Atualizar; sem a saída, avisa já em vez de falhar no clique.
    definirEnvioDisponivel(Boolean(importado?.saida_pronta));
    if (importado && !importado.saida_pronta) definirStatusAtualizar("Gere o Dashboard atualizado antes de enviar ao SharePoint.", "alerta");
    const novosAbertos = estado.formulario.filter(emAberto);
    const linhasNovos = novosAbertos.map(blocoNovo);
    // na primeira lista o primeiro novo vem aberto; depois valem os que a pessoa deixou abertos (antigos voltam recolhidos)
    if (!visao.novosAbertos && novosAbertos.length) visao.novosAbertos = new Set([novosAbertos[0].numero]);
    linhasNovos.forEach((linha, i) => { linha.open = Boolean(visao.novosAbertos?.has(novosAbertos[i].numero)); });
    indexar([
      ...linhasNovos.map((linha, i) => entradaVisao("novos", novosAbertos[i], linha)),
      ...linhasAntigos.map((linha, i) => entradaVisao("antigos", antigos[i], linha)),
      ...linhasFinalizados.map((linha, i) => entradaVisao("finalizados", finalizados[i], linha)),
    ]);
    const lista = el("sebrae-novos-lista");
    lista?.replaceChildren(...linhasNovos);
    context.sugestaoOs?.limparOrfas(); // as caixas das linhas antigas saíram do DOM: desmonta as raízes React delas
    lista?.removeAttribute("aria-busy"); // a lista já está pronta (também vale para a importação, que chama renderizar direto)
    renderizarAvisos(novos);
    if (!importado) definirTexto("sebrae-novos-resumo", "Importe o Dashboard primeiro.");
    else if (!novos) definirTexto("sebrae-novos-resumo", "Nenhuma busca feita ainda.");
    else {
      const quando = formatarDataHora(novos.lidos_em);
      definirTexto("sebrae-novos-resumo",
        `${quando ? `Busca de ${quando}: ` : ""}${estado.formulario.filter(emAberto).length} novo(s), ${novos.ignorados} já no Dashboard, ${(novos.pendentes || []).length} pendente(s).`);
    }
    if (estado.fechar.emAndamento) estado.fechar.numeros.forEach(numero => { if (estado.soft[numero]) estado.soft[numero].processando = true; });
    atualizarTodosFinalizar();
    atualizarBotaoAtualizar();
    app.carregarResumoHistoricoSebrae?.();
    app.carregarConflitosSebrae?.();
    desenharDestaques(); // também reaplica aba, filtro e página sobre as listas novas
    carregarDestaques(); // sem await: os de fora das listas e as datas entram quando chegarem
    carregarFechar();
    carregarAntigos();
  }

  /** Tenta salvar descrição e observação digitadas; o resultado não importa: a recarga nunca espera nem é recusada por falha de salvamento. */
  const salvarPendentes = () => Promise.all([...Object.keys(estado.soft).map(salvarDescricao), ...Object.keys(estado.observacoes).map(salvarObservacao)]);

  /** Lê do DOM, antes de a recarga refazer os cartões, o texto ainda não salvo (descrição, observação, editor do lápis) e o campo em foco. */
  function guardarNaoSalvos() {
    const descricoes: Record<string, string> = {};
    const observacoes: Record<string, string> = {};
    const lapis: Record<string, string> = {};
    const lapisAbertos: string[] = []; // editor aberto sem nada digitado: volta aberto, sem aviso (nenhum texto em risco)
    Object.entries(estado.soft).forEach(([numero, soft]) => { const ref = estado.refs.get(numero); if (ref && ref.texto.value !== soft.enviado) descricoes[numero] = ref.texto.value; });
    Object.entries(estado.observacoes).forEach(([numero, reg]) => { if (reg.textarea && reg.textarea.value !== reg.enviado) observacoes[numero] = reg.textarea.value; });
    document.querySelectorAll<ElementoSebrae>(".sebrae-descricao__editor textarea[data-sebrae-descricao-editada]").forEach(campo => {
      const editor = campo.closest<ElementoSebrae>(".sebrae-descricao__editor");
      const numero = campo.dataset.sebraeDescricaoEditada as string;
      if (editor?.dataset.sujo) lapis[numero] = campo.value;
      else if (editor && !editor.hidden) lapisAbertos.push(numero);
    });
    return { descricoes, observacoes, lapis, lapisAbertos, restaurarFoco: guardarFoco() };
  }

  /** Reaplica o texto não salvo nos campos novos do mesmo chamado (o temporizador volta a salvar); chamado que saiu da lista é avisado uma vez e descartado. */
  function reaplicarNaoSalvos({ descricoes, observacoes, lapis, lapisAbertos, restaurarFoco }: ReturnType<typeof guardarNaoSalvos>) {
    const saiu = new Set<string>();
    let mantidos = 0;
    const digitar = (campo: ElementoSebrae, texto: string) => { campo.value = texto; campo.dispatchEvent(new Event("input")); mantidos += 1; };
    Object.entries(descricoes).forEach(([numero, texto]) => {
      const campo = document.querySelector<ElementoSebrae>(`textarea[data-sebrae-descricao="${numero}"]`);
      if (campo) digitar(campo, texto); else saiu.add(numero);
    });
    Object.entries(observacoes).forEach(([numero, texto]) => {
      const campo = document.querySelector<ElementoSebrae>(`textarea[data-sebrae-observacao="${numero}"]`);
      if (campo) digitar(campo, texto); else saiu.add(numero);
    });
    Object.entries(lapis).forEach(([numero, texto]) => {
      const botao = document.querySelector<ElementoSebrae>(`button[data-sebrae-editar-descricao="${numero}"]`);
      if (!botao) { saiu.add(numero); return; }
      botao.click(); // reabre o editor no cartão novo
      const campo = document.querySelector<ElementoSebrae>(`textarea[data-sebrae-descricao-editada="${numero}"]`);
      if (campo) digitar(campo, texto);
    });
    lapisAbertos.forEach(numero => document.querySelector<ElementoSebrae>(`button[data-sebrae-editar-descricao="${numero}"]`)?.click());
    restaurarFoco();
    if (saiu.size) app.showToast(`${[...saiu].join(", ")}: o chamado saiu da lista; o texto não salvo foi descartado.`, "warning");
    else if (mantidos) app.showToast("Texto não salvo mantido nos campos.", "warning");
  }

  function renderizarPreservando(dados: Registro, versaoDestaque?: number) {
    const naoSalvos = guardarNaoSalvos();
    renderizar(dados, versaoDestaque);
    reaplicarNaoSalvos(naoSalvos);
  }

  /** Guarda o elemento em foco e devolve quem o restaura: nas listas, o do cartão refeito com os mesmos `data-*` (campo, lápis, botão),
   * reabrindo o antigo que a recarga recolheu; fora delas, o próprio elemento (o clique que reabre o lápis não pode levar o foco). */
  function guardarFoco() {
    const ativo = document.activeElement as ElementoSebrae | null;
    if (!ativo || ativo === document.body) return () => {};
    const lista = ["sebrae-novos-lista", "sebrae-antigos-lista", "sebrae-finalizados-lista"].map(el).find(no => no?.contains(ativo));
    const dados: Record<string, string | undefined> = { ...ativo.dataset };
    const chaves = Object.keys(dados);
    const [inicio, fim, rolagem] = [ativo.selectionStart, ativo.selectionEnd, ativo.scrollTop];
    return () => {
      const novo = ativo.isConnected ? ativo : lista && chaves.length
        ? [...lista.querySelectorAll<ElementoSebrae>(ativo.tagName)].find(no => Object.keys(no.dataset).length === chaves.length && chaves.every(chave => no.dataset[chave] === dados[chave]))
        : null;
      if (!novo) return;
      if (novo !== ativo) for (let d = novo.closest("details"); d; d = d.parentElement?.closest("details") ?? null) d.open = true;
      novo.focus({ preventScroll: true });
      if (inicio != null && fim != null) novo.setSelectionRange?.(inicio, fim);
      if (novo !== ativo) novo.scrollTop = rolagem || 0;
    };
  }

  async function carregarNovosSebrae() {
    if (!el("sebrae-novos-painel") && !el("sebrae-novos-lista")) return; // vale com só o cartão F4 ou só o painel F5 montado
    const consulta = ++estado.consulta;
    const pedidoEm = Date.now();
    const versaoDestaque = estado.destaqueVersao;
    const lista = el("sebrae-novos-lista");
    lista?.setAttribute("aria-busy", "true"); // o CSS mostra o esqueleto de carregamento enquanto a lista está vazia
    try {
      await salvarPendentes(); // o servidor devolve a lista já com o que foi digitado
      const dados = await app.apiFetch("/api/sebrae/novos", { errorMessage: "Não foi possível consultar os chamados novos." });
      if (consulta === estado.consulta) { // uma recarga mais nova substitui esta
        estado.novosPedidoEm = pedidoEm;
        renderizarPreservando(dados, versaoDestaque);
      }
    } catch (falha) { const error = falha as ErroApi;
      if (consulta === estado.consulta) definirTexto("sebrae-dashboard-status", error.message);
    } finally {
      // Só a consulta mais recente solta o "ocupado"; se outra a substituiu, ela mesma solta ao terminar.
      if (consulta === estado.consulta) lista?.removeAttribute("aria-busy");
    }
  }

  async function importarDashboardSebrae(event?: Event) {
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
      await salvarPendentes(); // antes do POST: a importação refaz os cartões
      const dados = await app.apiFetch("/api/sebrae/dashboard", {
        method: "POST", body: corpo, errorMessage: "Não foi possível importar o Dashboard.",
      });
      estado.consulta += 1;
      renderizarPreservando(dados);
      // `aviso` (texto do servidor, opcional) entra no status e no toast junto da confirmação normal; só textContent.
      const aviso = typeof dados.aviso === "string" ? dados.aviso.trim() : "";
      const preservada = dados.saida_anterior_preservada ? "Dashboard importado. A cópia atualizada anterior foi preservada em data/state/sebrae_dashboard_saida/preservados; confira essa cópia antes de enviar outra versão." : "";
      if (preservada) definirTexto("sebrae-dashboard-status", preservada);
      if (aviso) definirTexto("sebrae-dashboard-status", [el("sebrae-dashboard-status")?.textContent, aviso].filter(Boolean).join(" "));
      entrada.value = "";
      entrada.dispatchEvent(new Event("change", { bubbles: true }));
      app.showToast(aviso ? `Dashboard importado. ${aviso}` : "Dashboard importado.", aviso ? "warning" : "success");
    } catch (falha) { const error = falha as ErroApi;
      definirTexto("sebrae-dashboard-status", error.message);
      app.showToast(error.message, "error");
    } finally {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
    }
  }

  // Um <a href> não leva o X-Simpress-Sessao: a cópia vem por fetch e a falha vira toast, não uma página de erro.
  function botaoBaixarCopia(texto: string, envioId: string) {
    const botao = dom.createTextElement("button", "ck-btn ck-btn--fantasma ck-btn--sm", texto);
    botao.type = "button";
    botao.addEventListener("click", async () => {
      botao.disabled = true; // evita baixar duas vezes enquanto a cópia vem
      try {
        await baixarDaApi(`/api/sebrae/dashboard/envio/${encodeURIComponent(envioId)}/snapshot`, "Dashboard Operacional_SEBRAE.xlsx", "Não foi possível baixar a cópia deste envio.");
      } catch (falha) { app.showToast((falha as ErroApi).message, "error"); } finally { botao.disabled = false; }
    });
    return botao;
  }

  function baixarArquivo(nome: string, base64: string) {
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

  /** Entrega o estado da rotina enviar à Automação, que acompanha até o fim (e recarrega os conflitos) mesmo com a aba oculta. */
  async function acompanharEnviarNaAutomacao() {
    try {
      const automacao = await app.apiFetch("/api/automacao/estado", { errorMessage: "Não foi possível consultar a automação." });
      if (automacao?.estado === "em_andamento" && automacao.rotina === "enviar") { app.acompanharExecucaoAutomacao?.(automacao); return; }
      if (automacao?.ultima?.rotina === "enviar") carregarNovosSebrae(); // terminou entre o atualizar e este GET: a Automação não vai ver o fim
    } catch (_erro) { /* sem estado: a consulta comum abaixo cobre */ }
    app.atualizarEstadoAutomacao?.();
  }

  async function atualizarDashboardSebrae() {
    if (estado.rascunhoExterno) {
      app.showToast("O rascunho mudou em outra aba. Recarregue e confira os campos antes de atualizar o Dashboard.", "warning");
      return;
    }
    if (estado.pdfOcupado.size) {
      app.showToast("Aguarde o PDF terminar de enviar ou remover.", "warning");
      return;
    }
    const faltaR = pendentesEncerramento();
    if (faltaR.length) { // o botão já fica desabilitado; esta é a barreira de quem chega aqui sem ele (o servidor também recusa com 422)
      mostrarFaltaEncerramento(faltaR);
      app.showToast(avisoEncerramento(faltaR), "warning");
      return;
    }
    const chamados = payloadAtualizacao(estado.formulario, estado.valores);
    const edicoes = payloadEdicoes(estado.abertos, estado.edicoes);
    const versaoImportacao = estado.versaoImportacao; // fixada com o payload: uma recarga durante o diálogo não pode anular o 409 de proteção
    if (!estado.atualizavel || (!chamados.length && !edicoes.length && !totalPreenchimentos(estado.abertos) && !totalDescricoesAEnviar())) return;
    const botao = el("btn-sebrae-atualizar");
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    try {
      // Finalizar no SoftExpert não tem volta: quem marcou FINALIZADO com descrição confirma antes de qualquer envio.
      const numeros = Object.keys(estado.soft);
      const salvos = await Promise.all(numeros.map(salvarDescricao));
      const naoSalvos = numeros.filter((_numero, indice) => !salvos[indice]);
      const finalizar = candidatosFinalizar(estado.abertos, estado.edicoes, estado.soft, estado.formulario, estado.valores);
      // Só barra quem seria finalizado sem a descrição salva; nos demais, segue e avisa.
      if (finalizar.some((numero: string) => naoSalvos.includes(numero))) {
        app.showToast("Salve a descrição antes de finalizar.", "error");
        return;
      }
      if (naoSalvos.length) app.showToast(`Descrição não salva: ${naoSalvos.join(", ")}.`, "warning");
      const excluidos = excluidosFinalizar(estado.abertos, estado.edicoes, estado.soft, estado.formulario, estado.valores);
      const avisoExcluidos = avisoExcluidosFinalizar(excluidos);
      // Sem candidatos não há diálogo: atualiza e envia ao SharePoint. Com candidatos, só "Atualizar e finalizar" (true) finaliza e envia;
      // "Atualizar sem finalizar", Esc e fechar o diálogo (null) só atualizam e baixam: D FINALIZADO sem SoftExpert nunca vai ao SharePoint por este clique.
      let resposta: boolean | null = false;
      let marcadosOutroTecnico: string[] = [];
      if (!finalizar.length && excluidos.some((e: Registro) => e.motivo === "sem_descricao")) {
        // FINALIZADO sem descrição iria ao SharePoint sem passar pelo SoftExpert: só envia com confirmação explícita.
        const enviar = await app.confirmarAcao({
          titulo: "Enviar ao SharePoint sem finalizar no SoftExpert",
          mensagem: `${avisoExcluidos} Eles vão ao Dashboard no SharePoint como FINALIZADO sem serem finalizados no SoftExpert pelo site. `
            + "Envie só se já estiverem finalizados no SoftExpert.",
          confirmar: "Atualizar e enviar", cancelar: "Atualizar sem enviar",
        });
        resposta = enviar ? false : null;
      } else if (finalizar.length) {
        const dialogo = {
          titulo: "Atualizar Dashboard e finalizar no SoftExpert",
          mensagem: `${finalizar.length} chamado(s) marcado(s) como FINALIZADO (${finalizar.join(", ")}) podem ser finalizados no SoftExpert. `
            + "Atualizar e finalizar: atualiza o Dashboard, finaliza no SoftExpert (o que não tem volta) e envia ao SharePoint. "
            + "Atualizar sem finalizar: só atualiza e baixa o Dashboard; NÃO finaliza no SoftExpert nem envia ao SharePoint."
            + (avisoExcluidos ? ` ${avisoExcluidos}` : ""),
          confirmar: "Atualizar e finalizar", cancelar: "Atualizar sem finalizar",
        };
        // Cada não encontrado ganha o bloco laranja com a caixa própria; só os marcados vão em `confirmar_outro_tecnico`.
        const blocos = finalizar.filter((numero: string) => estado.abertos.some(item => item.numero === numero && dadosAntigo(item).naoEncontrado))
          .map((numero: string) => blocoOutroTecnico(numero, valoresEfetivos(numero)));
        if (blocos.length) {
          const respondido = await app.confirmarAcao({ ...dialogo, blocos });
          resposta = respondido.confirmado || null;
          marcadosOutroTecnico = respondido.marcados;
        } else resposta = await app.confirmarAcao(dialogo) || null;
      }
      const finalizarSoftExpert = Boolean(resposta);
      const enviarSharepoint = resposta !== null;
      // Só a finalização em massa exige A e J (a descrição e o Status FINALIZADO já filtraram os candidatos): avisa e não envia nada.
      const incompletos: [string, string[]][] = finalizarSoftExpert
        ? finalizar.map((numero: string): [string, string[]] => [numero, camposFaltando(valoresEfetivos(numero), estado.soft[numero]?.descricao)]).filter(([, faltas]: [string, string[]]) => faltas.length)
        : [];
      if (incompletos.length) {
        const aviso = `Para finalizar no SoftExpert, preencha: ${incompletos.map(([numero, faltas]) => `${numero} (${faltas.join(", ")})`).join("; ")}. Nada foi enviado.`;
        definirStatusAtualizar(aviso, "alerta");
        app.showToast(aviso, "warning");
        return;
      }
      if (finalizarSoftExpert) await Promise.all(finalizar.map(guardarFicha));
      const dados = await app.apiFetch("/api/sebrae/dashboard/atualizar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chamados, edicoes, versao_importacao: versaoImportacao, finalizar_softexpert: finalizarSoftExpert, confirmar_outro_tecnico: marcadosOutroTecnico, enviar_sharepoint: enviarSharepoint }),
        errorMessage: "Não foi possível atualizar o Dashboard.",
      });
      baixarArquivo(dados.arquivo, dados.conteudo_base64);
      const novos = dados.linhas.filter((linha: Registro) => linha.tipo === "novo").length;
      const quando = formatarDataHora(dados.base?.importado_em);
      const envio = resultadoEnvioAtualizacao(dados);
      definirStatusAtualizar(
        `Baixado "${dados.arquivo}": ${novos} novo(s) e ${dados.linhas.length - novos} alterado(s). `
        + `Baseado no Dashboard importado${quando ? ` em ${quando}` : ""}. Para não perder edições de outras pessoas, importe a versão atual antes.`
        + (finalizar.length && !finalizarSoftExpert ? " Dashboard atualizado; nenhum chamado foi finalizado no SoftExpert." : "")
        + (avisoExcluidos ? ` ${avisoExcluidos}` : "")
        + (envio.tipo === "warning" ? ` ${envio.texto}` : ""),
        avisoExcluidos || envio.tipo === "warning" ? "alerta" : "ok");
      definirEnvioDisponivel(true);
      app.showToast(envio.texto, envio.tipo);
      if (dados.enviar?.iniciado) void acompanharEnviarNaAutomacao();
      tratarFechar(dados.fechar);
    } catch (falha) { const error = falha as ErroApi;
      definirStatusAtualizar(error.message, "erro");
      app.showToast(error.message, "error");
    } finally {
      botao.removeAttribute("aria-busy");
      atualizarBotaoAtualizar();
    }
  }


  instalarVisao();
  return { carregarNovosSebrae, lerAntigosSebrae, importarDashboardSebrae, atualizarDashboardSebrae, descartarRascunhoSebrae, mostrarChamadoSebrae, cartaoChamadoSebraeLeitura };
}
