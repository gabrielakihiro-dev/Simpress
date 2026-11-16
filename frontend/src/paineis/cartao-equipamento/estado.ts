import type { EstadoApp } from "../../estado-app";
import type { ApiFetchOptions } from "../../api";

interface EquipamentoCartao extends Record<string, unknown> {
  serial?: string;
  apelido?: string;
  modelo?: string;
  retirada_cidade?: string;
  retirada_endereco?: string;
  retirada_cep?: string;
  retirada_cnpj?: string;
  retirada_cnpj_instalacao?: string;
  idCliente?: string;
  tipo?: string;
  usuarios_logados?: string;
  usuarios_logados_origem?: string;
  nome_pessoa?: string;
  nome_pessoa_origem?: string;
  nome_pessoa_editavel?: boolean;
}
interface EstadoCartao extends Omit<EstadoApp, "currentEquipamento"> {
  currentEquipamento: EquipamentoCartao | null;
}
interface ElementoCartao extends HTMLElement {
  value: string;
  disabled: boolean;
  hidden: boolean;
  select(): void;
  querySelector<T extends Element = Element>(selectors: string): T | null;
  querySelectorAll<T extends Element = Element>(selectors: string): NodeListOf<T>;
}
interface CampoCadastral {
  editavel(eq: EquipamentoCartao): boolean;
  valor(eq: EquipamentoCartao): string;
  maxlength: number;
}
interface AppCartao {
  apiFetch<T = Record<string, unknown>>(url: string, options: ApiFetchOptions): Promise<T>;
  showToast(mensagem: string, tipo: string): void;
  definirEquipamentoAtual(eq: EquipamentoCartao): void;
  exibirEquipamento(eq: EquipamentoCartao): void;
  atualizarIndicadoresPosSalvamento(): void;
  atualizarObrigatoriedadeDuracaoPausaEntrega(): void;
  fecharModalEditarEquipamento(): void;
  fecharModalEditarApelido(): void;
}
export interface ContextoCartaoEquipamento {
  app: AppCartao;
  appState: EstadoCartao;
  ponteReact(painel: string, nomes: string[]): Record<string, (...args: string[]) => Promise<unknown>>;
  loggedUserMarkers?: {
    TITULO_AMBIGUO: string;
    textoAmbiguo?(candidatos: unknown): string;
    tituloManual?(data: unknown): string;
  };
}

const elemento = <T extends HTMLElement = ElementoCartao>(id: string): T => document.getElementById(id) as T;
const mensagemErro = (erro: unknown, padrao: string): string => erro instanceof Error ? erro.message : padrao;

interface RespostaEquipamento {
  equipamento: EquipamentoCartao;
  base_atualizada?: boolean;
}
interface CampoEdicao {
  input: HTMLInputElement;
  original: string;
  dd: Element;
  dado: Element;
  textoOriginal: string | null;
  ocultos: Element[];
}
interface EstadoEdicaoCadastral {
  serial: string;
  campos: Map<string, CampoEdicao>;
  salvando: boolean;
}
export function criarAcoesCartaoEquipamento(context: ContextoCartaoEquipamento) {
  "use strict";
  const { app, appState } = context;

  // Since the React migration (Dia 2, G10) the equipment and alias dialogs live in frontend/src/paineis/editar-equipamento/
  // and editar-apelido/: React does the validation, the POST and the button/toast texts, and hands the saved equipment back.
  // This module stays the bridge (data-on-click names, the accessible dialog's Esc) and applies the saved equipment to
  // the card, which it still owns (definirEquipamentoAtual, exibirEquipamento, the delivery fields).
  const ponteEquipamento = context.ponteReact("editar-equipamento", [
    "abrirModalEditarEquipamento", "cadastrarNovoSerial", "fecharModalEditarEquipamento", "salvarDadosEquipamento",
  ]);
  const ponteApelido = context.ponteReact("editar-apelido", [
    "abrirModalEditarApelido", "fecharModalEditarApelido", "salvarApelido",
  ]);
  // Callers ignore the promise: a React panel that did not load is logged, never an unhandled rejection.
  const registrar = (promessa: Promise<unknown>) => promessa.catch(erro => { console.error(erro); });

  function abrirModalEditarEquipamento() {
    return registrar(ponteEquipamento.abrirModalEditarEquipamento());
  }

  function cadastrarNovoSerialPesquisado() {
    return registrar(ponteEquipamento.cadastrarNovoSerial(elemento("input-serial")?.value || ""));
  }

  function fecharModalEditarEquipamento() {
    return registrar(ponteEquipamento.fecharModalEditarEquipamento());
  }

  function abrirModalEditarApelido() {
    return registrar(ponteApelido.abrirModalEditarApelido());
  }

  function fecharModalEditarApelido() {
    return registrar(ponteApelido.fecharModalEditarApelido());
  }

  // React returns { equipamento } when the save succeeded and the selection did not change meanwhile, otherwise null.
  async function salvarApelido() {
    let resultado;
    try {
      resultado = await ponteApelido.salvarApelido() as RespostaEquipamento | null;
    } catch (erro) {
      console.error(erro);
      return;
    }
    if (!resultado) return;
    try {
      app.definirEquipamentoAtual(resultado.equipamento);
      elemento("badge-apelido").textContent = appState.currentEquipamento?.apelido || "Sem Apelido";
      app.atualizarIndicadoresPosSalvamento();
      app.fecharModalEditarApelido();
    } catch (err) {
      console.error("Erro ao salvar apelido:", err);
      app.showToast(mensagemErro(err, "Falha ao salvar o apelido."), "error");
    }
  }

  // Usuário logado: vem do Endpoint; quando ele não informa, permite digitar o usuário manualmente.
  function atualizarUsuarioLogadoCard(eq: EquipamentoCartao | null = null) {
    const texto = elemento("card-usuarios-logados");
    const acoes = elemento("card-usuario-manual-acoes");
    const formulario = elemento("form-usuario-manual");
    const usuario = String(eq?.usuarios_logados || "").trim();
    const manual = eq?.usuarios_logados_origem === "manual";
    // Série repetida no Endpoint: mostra os candidatos sem escolher um; o manual continua possível.
    const marcadores = context.loggedUserMarkers;
    const ambiguo = marcadores?.textoAmbiguo?.(eq?.usuarios_logados_candidatos) || "";
    const titulo = [manual ? marcadores?.tituloManual?.(eq?.usuarios_logados_informado_em) : "", ambiguo ? marcadores?.TITULO_AMBIGUO : ""]
      .filter(Boolean).join(". ");
    texto.textContent = [usuario ? `${usuario}${manual ? " (M)" : ""}` : "", ambiguo].filter(Boolean).join(" · ");
    if (titulo) texto.title = titulo;
    else texto.removeAttribute("title");
    texto.classList.toggle("equipment-user-ambiguous", Boolean(ambiguo) && !usuario);
    texto.classList.toggle("hidden", !usuario && !ambiguo);
    acoes.classList.toggle("hidden", !manual);
    // Sem usuário no Endpoint nem manual: mostra o campo para digitar.
    formulario.classList.toggle("hidden", Boolean(usuario) || !eq?.serial);
    if (!usuario) elemento("input-usuario-manual").value = "";
    const nome = String(eq?.nome_pessoa || "").trim();
    const nomeTexto = elemento("card-nome-pessoa");
    const nomeForm = elemento("form-nome-pessoa");
    const nomeEditarButton = elemento("btn-editar-nome-pessoa");
    nomeTexto.textContent = nome ? `${nome}${eq?.nome_pessoa_origem === "manual" ? " (manual)" : ""}` : "";
    nomeTexto.classList.toggle("hidden", !nome);
    nomeForm.classList.toggle("hidden", !eq?.nome_pessoa_editavel || Boolean(nome));
    nomeEditarButton?.classList.toggle("hidden", !eq?.nome_pessoa_editavel || !nome);
    if (nomeEditarButton) {
      nomeEditarButton.textContent = "Editar nome";
      nomeEditarButton.setAttribute("aria-expanded", "false");
    }
    elemento("input-nome-pessoa").value = eq?.nome_pessoa_origem === "manual" ? nome : "";
  }

  function editarNomePessoa() {
    const formulario = elemento("form-nome-pessoa");
    const campo = elemento("input-nome-pessoa");
    const button = elemento("btn-editar-nome-pessoa");
    const abrir = formulario.classList.contains("hidden");
    formulario.classList.toggle("hidden", !abrir);
    button.textContent = abrir ? "Cancelar edição" : "Editar nome";
    button.setAttribute("aria-expanded", String(abrir));
    if (abrir) campo.focus();
    else {
      const equipment = appState.currentEquipamento;
      campo.value = equipment?.nome_pessoa_origem === "manual" ? String(equipment.nome_pessoa || "").trim() : "";
    }
  }

  async function salvarNomePessoa() {
    const equipment = appState.currentEquipamento;
    if (!equipment?.serial) return;
    const button = elemento("btn-salvar-nome-pessoa");
    const nome = elemento("input-nome-pessoa").value.trim();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const result = await app.apiFetch<RespostaEquipamento>("/api/equipamento/nome-pessoa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial: equipment.serial, login_atual: equipment.usuarios_logados || "", nome }),
        errorMessage: "Não foi possível salvar o nome da pessoa.",
      });
      if (appState.currentEquipamento?.serial === equipment.serial) {
        app.definirEquipamentoAtual(result.equipamento);
        atualizarUsuarioLogadoCard(result.equipamento);
      }
      if (result.base_atualizada === false) app.showToast("Nome salvo; a base será atualizada na próxima carga.", "warning");
      else app.showToast(nome ? "Nome da pessoa salvo." : "Nome manual removido.", "success");
      document.dispatchEvent(new CustomEvent("simpress:usuarios-equipamento-atualizados"));
    } catch (error) {
      app.showToast(mensagemErro(error, "Não foi possível salvar o nome da pessoa."), "error");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  function editarUsuarioLogado() {
    const atual = appState.currentEquipamento;
    if (!atual) return;
    const formulario = elemento("form-usuario-manual");
    const campo = elemento("input-usuario-manual");
    formulario.classList.remove("hidden");
    campo.value = atual.usuarios_logados || "";
    campo.focus();
    campo.select();
  }

  async function enviarUsuarioLogado(usuario: string, mensagemSucesso: string) {
    if (!appState.currentEquipamento) {
      app.showToast("Pesquise um equipamento antes de informar o usuário.", "warning");
      return;
    }
    const serial = appState.currentEquipamento.serial;
    const selectionRevisionAtSave = appState.equipamentoSelectionRevision;
    const botao = elemento("btn-salvar-usuario-manual");
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    try {
      const data = await app.apiFetch<RespostaEquipamento>("/api/equipamento/atualizar-usuario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, usuario }),
        errorMessage: "Falha ao salvar o usuário.",
      });
      const stillSelected = appState.equipamentoSelectionRevision === selectionRevisionAtSave
        && String(appState.currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
      if (stillSelected) {
        app.definirEquipamentoAtual(data.equipamento);
        atualizarUsuarioLogadoCard(appState.currentEquipamento);
      }
      app.showToast(mensagemSucesso, "success");
    } catch (err) {
      console.error("Erro ao salvar usuário logado:", err);
      app.showToast(mensagemErro(err, "Falha ao salvar o usuário."), "error");
    } finally {
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
    }
  }

  function salvarUsuarioLogado() {
    const usuario = elemento("input-usuario-manual").value.trim();
    if (!usuario) {
      app.showToast("Digite o usuário antes de salvar.", "warning");
      return Promise.resolve();
    }
    return enviarUsuarioLogado(usuario, "Usuário salvo e registrado no histórico de alterações.");
  }

  function limparUsuarioLogado() {
    return enviarUsuarioLogado("", "Usuário manual removido e registrado no histórico de alterações.");
  }

  // Edição cadastral em linha do Home (Cockpit v2): só Apelido, Usuário e Login; Local, CEP e CNPJs ficam somente leitura.
  const CAMPOS_CADASTRAIS: Record<string, CampoCadastral> = {
    apelido: { maxlength: 160, valor: eq => String(eq.apelido || "").trim(), editavel: () => true },
    usuario: {
      maxlength: 160,
      valor: eq => String(eq.usuarios_logados || "").trim(),
      editavel: eq => !String(eq.usuarios_logados || "").trim() || eq.usuarios_logados_origem === "manual",
    },
    login: { maxlength: 300, valor: eq => String(eq.nome_pessoa || "").trim(), editavel: eq => Boolean(eq.nome_pessoa_editavel) },
  };
  const edicaoCadastral: EstadoEdicaoCadastral = { serial: "", campos: new Map(), salvando: false };

  const formEdicaoCadastral = () => elemento("form-editar-equipamento");
  const gridCadastral = () => elemento("ck-dados-equipamento");

  function contarAlteracoesCadastrais() {
    return [...edicaoCadastral.campos.values()].filter(c => c.input.value.trim() !== c.original).length;
  }

  function atualizarContadorCadastral() {
    let total = 0;
    edicaoCadastral.campos.forEach(({ input, original, dado }) => {
      const alterado = input.value.trim() !== original;
      dado.classList.toggle("ck-dado--alterado", alterado);
      if (alterado) total += 1;
    });
    const texto = total === 0 ? "nenhuma alteração" : `${total} ${total === 1 ? "alteração" : "alterações"}`;
    elemento("ck-dados-edicao-texto").textContent = `Editando dados cadastrais · ${texto}`;
  }

  function restaurarExibicaoCadastral() {
    edicaoCadastral.campos.forEach(({ input, dd, textoOriginal, ocultos }) => {
      input.remove();
      ocultos.forEach(el => el.removeAttribute("hidden"));
      if (textoOriginal !== null) dd.textContent = textoOriginal;
    });
    edicaoCadastral.campos.forEach(({ dado }) => dado.classList.remove("ck-dado--alterado"));
    edicaoCadastral.campos.clear();
    edicaoCadastral.serial = "";
    gridCadastral().classList.remove("ck-dados--editando");
    formEdicaoCadastral().hidden = true;
    const botao = elemento("btn-editar-equipamento");
    botao.setAttribute("aria-pressed", "false");
  }

  function cancelarDadosCadastrais() {
    if (!gridCadastral().classList.contains("ck-dados--editando")) return;
    restaurarExibicaoCadastral();
    elemento("btn-editar-equipamento").focus();
  }

  function editarDadosCadastrais() {
    if (gridCadastral().classList.contains("ck-dados--editando")) {
      cancelarDadosCadastrais();
      return;
    }
    const eq = appState.currentEquipamento;
    if (!eq?.serial) {
      app.showToast("Pesquise um equipamento antes de editar.", "warning");
      return;
    }
    edicaoCadastral.serial = eq.serial;
    Object.entries(CAMPOS_CADASTRAIS).forEach(([nome, regra]) => {
      const dd = gridCadastral().querySelector<ElementoCartao>(`dd[data-campo="${nome}"]`);
      if (!dd || !regra.editavel(eq)) return;
      const dado = dd.closest(".ck-dado");
      if (!dado) return;
      const original = regra.valor(eq);
      const input = document.createElement("input");
      input.type = "text";
      input.className = "ck-entrada ck-entrada--sm ck-dado__entrada";
      input.maxLength = regra.maxlength;
      input.value = original;
      input.setAttribute("aria-label", dado.querySelector("dt")?.textContent.trim() || nome);
      input.dataset.campoEdicao = nome;
      const ocultos = [...dd.children].filter(el => !el.hasAttribute("hidden"));
      ocultos.forEach(el => el.setAttribute("hidden", ""));
      // dd só com texto (apelido): guarda o texto para restaurar; os demais escondem os filhos.
      const textoOriginal = dd.children.length ? null : dd.textContent;
      if (textoOriginal !== null) dd.textContent = "";
      dd.appendChild(input);
      input.addEventListener("input", atualizarContadorCadastral);
      edicaoCadastral.campos.set(nome, { input, original, dd, dado, textoOriginal, ocultos });
    });
    gridCadastral().classList.add("ck-dados--editando");
    formEdicaoCadastral().hidden = false;
    elemento("btn-editar-equipamento").setAttribute("aria-pressed", "true");
    atualizarContadorCadastral();
    edicaoCadastral.campos.values().next().value?.input.focus();
  }

  async function salvarDadosCadastrais() {
    if (edicaoCadastral.salvando || !gridCadastral().classList.contains("ck-dados--editando")) return;
    const alterados = [...edicaoCadastral.campos].filter(([, c]) => c.input.value.trim() !== c.original);
    if (!alterados.length) {
      app.showToast("Nenhuma alteração para salvar.", "info");
      return;
    }
    const serial = edicaoCadastral.serial;
    // definirEquipamentoAtual incrementa a revisão; por isso ela é renovada após cada aplicação própria.
    let revisao = appState.equipamentoSelectionRevision;
    const botao = elemento("btn-salvar-dados-cadastrais");
    const textoBotao = botao.textContent;
    edicaoCadastral.salvando = true;
    botao.disabled = true;
    botao.setAttribute("aria-busy", "true");
    botao.textContent = "Salvando...";
    const salvos = [];
    let falhas = 0;
    const aindaSelecionado = () => appState.equipamentoSelectionRevision === revisao
      && String(appState.currentEquipamento?.serial || "").toUpperCase() === String(serial).toUpperCase();
    const enviar = (rota: string, corpo: Record<string, string>, erro: string) => app.apiFetch<RespostaEquipamento>(rota, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo), errorMessage: erro,
    });
    try {
      for (const [nome, campo] of alterados) {
        const valor = campo.input.value.trim();
        try {
          let data: RespostaEquipamento;
          if (nome === "apelido") data = await enviar("/api/equipamento/atualizar-apelido", { serial, apelido: valor }, "Falha ao salvar o apelido.");
          else if (nome === "usuario") data = await enviar("/api/equipamento/atualizar-usuario", { serial, usuario: valor }, "Falha ao salvar o usuário.");
          else {
            data = await enviar("/api/equipamento/nome-pessoa",
              { serial, login_atual: appState.currentEquipamento?.usuarios_logados || "", nome: valor }, "Não foi possível salvar o nome da pessoa.");
            if (data.base_atualizada === false) app.showToast("Nome salvo; a base será atualizada na próxima carga.", "warning");
          }
          salvos.push(nome);
          campo.original = valor;
          if (aindaSelecionado()) {
            app.definirEquipamentoAtual(data.equipamento);
            revisao = appState.equipamentoSelectionRevision;
            if (nome === "apelido") elemento("badge-apelido").textContent = appState.currentEquipamento?.apelido || "Sem Apelido";
            app.atualizarIndicadoresPosSalvamento();
            atualizarUsuarioLogadoCard(appState.currentEquipamento);
          }
          if (nome !== "apelido") document.dispatchEvent(new CustomEvent("simpress:usuarios-equipamento-atualizados"));
        } catch (err) {
          falhas += 1;
          console.error("Erro ao salvar dado cadastral:", err);
          app.showToast(mensagemErro(err, "Falha ao salvar."), "error");
        }
        if (!aindaSelecionado()) break;
      }
    } finally {
      edicaoCadastral.salvando = false;
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      botao.textContent = textoBotao;
    }
    if (salvos.length) {
      app.showToast("Dados cadastrais salvos.", "success");
      document.dispatchEvent(new CustomEvent("ck:dados-salvos", { detail: { campos: salvos } }));
    }
    if (!falhas || !aindaSelecionado()) {
      restaurarExibicaoCadastral();
      const apelido = elemento("grid-apelido");
      if (aindaSelecionado() && apelido) apelido.textContent = appState.currentEquipamento?.apelido || "—";
    } else atualizarContadorCadastral();
  }

  const CAMPOS_ENTREGA_PRESERVADOS_AO_EDITAR_EQUIPAMENTO = [
    "select-unidade-destino",
    "entrega-cnpj",
    "entrega-endereco",
    "entrega-representante",
    "entrega-contato",
    "entrega-email",
    "entrega-telefone",
    "entrega-horario",
    "entrega-almoco",
    "entrega-pausa-duracao",
    "entrega-obs"
  ];

  function capturarDadosEntrega(): Record<string, string> {
    return CAMPOS_ENTREGA_PRESERVADOS_AO_EDITAR_EQUIPAMENTO.reduce<Record<string, string>>((valores, id) => {
      const campo = elemento(id);
      if (campo) valores[id] = campo.value;
      return valores;
    }, {});
  }

  function restaurarDadosEntrega(valores: Record<string, string>) {
    Object.entries(valores).forEach(([id, valor]) => {
      const campo = elemento(id);
      if (campo) campo.value = valor;
    });
    app.atualizarObrigatoriedadeDuracaoPausaEntrega();
  }

  // Same contract as salvarApelido: the card keeps the delivery fields the person already filled in.
  async function salvarDadosEquipamento() {
    let resultado;
    try {
      resultado = await ponteEquipamento.salvarDadosEquipamento() as RespostaEquipamento | null;
    } catch (erro) {
      console.error(erro);
      return;
    }
    if (!resultado) return;
    try {
      const dadosEntrega = capturarDadosEntrega();
      app.definirEquipamentoAtual(resultado.equipamento);
      app.exibirEquipamento(resultado.equipamento);
      restaurarDadosEntrega(dadosEntrega);
      elemento("input-serial").value = resultado.equipamento.serial || "";
      elemento("btn-clear-serial").classList.remove("hidden");

      app.atualizarIndicadoresPosSalvamento();
      app.fecharModalEditarEquipamento();
    } catch (err) {
      console.error("Erro ao salvar:", err);
      app.showToast(mensagemErro(err, "Falha ao salvar o equipamento."), "error");
    }
  }

  return {
    abrirModalEditarEquipamento, cadastrarNovoSerialPesquisado, fecharModalEditarEquipamento, abrirModalEditarApelido,
    fecharModalEditarApelido, salvarApelido, salvarDadosEquipamento,
    atualizarUsuarioLogadoCard, editarUsuarioLogado, salvarUsuarioLogado, limparUsuarioLogado, salvarNomePessoa, editarNomePessoa,
    editarDadosCadastrais, salvarDadosCadastrais, cancelarDadosCadastrais,
  };
}


