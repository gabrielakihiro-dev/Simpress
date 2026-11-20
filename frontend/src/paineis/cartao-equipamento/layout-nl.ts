import type { EstadoApp } from "../../estado-app";

// Novo layout da Home (F1): só apresentação. Contador do texto do chamado, "Restaurar modelo", cidade ao lado do modelo,
// modo do PowerShell em controle segmentado e o editor do comando ("Ver inteiro"). Nada aqui executa ou aperta Enter:
// "Inserir no PowerShell" (do cartão ou do editor) segue no estado.ts, com a mesma confirmação e o mesmo envio.
const LIMITE_CHAMADO = 2500;
const LIMITE_COMANDO = 2000;

let instalado = false;

function porId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function escreverContagem(alvo: HTMLElement | null, total: number, limite: number) {
  if (!alvo) return;
  alvo.textContent = `${total} / ${limite}`;
  alvo.classList.toggle("nlh-contador--alerta", total > limite);
}

function textareaDoChamadoAtivo() {
  return document.querySelector<HTMLTextAreaElement>(".ck-chamado__painel:not([hidden]) textarea");
}

function atualizarContadorChamado() {
  escreverContagem(porId("nlh-chamado-contador"), textareaDoChamadoAtivo()?.value.length ?? 0, LIMITE_CHAMADO);
}

function restaurarModeloChamado() {
  const area = textareaDoChamadoAtivo();
  if (!area) return;
  area.value = area.defaultValue;
  area.dispatchEvent(new Event("input", { bubbles: true }));
}

function sincronizarModoPowerShell() {
  const modo = porId<HTMLSelectElement>("select-powershell-modo")?.value;
  document.querySelectorAll<HTMLElement>(".nlh-segmento__op").forEach(op => {
    op.setAttribute("aria-pressed", String(op.dataset.modo === modo));
  });
}

function atualizarComandoPowerShell() {
  const campo = porId<HTMLTextAreaElement>("input-powershell-comando");
  if (!campo) return;
  escreverContagem(porId("nlh-ps-contador"), campo.value.length, LIMITE_COMANDO);
  // A altura é a do CSS; o que passa dela vira "+N linhas". O texto inteiro fica no editor ("Ver inteiro").
  const pilula = porId("nlh-ps-linhas");
  if (!pilula) return;
  const altura = parseFloat(getComputedStyle(campo).lineHeight) || 18;
  const ocultas = Math.ceil((campo.scrollHeight - campo.clientHeight) / altura);
  pilula.hidden = ocultas < 1;
  pilula.textContent = ocultas < 1 ? "" : `+${ocultas} ${ocultas === 1 ? "linha" : "linhas"}`;
}

function plural(n: number) {
  return `${n} ${n === 1 ? "linha" : "linhas"}`;
}

// Editor do comando: as linhas são as que aparecem na tela (o comando não aceita quebra de linha, então o texto só dobra).
function atualizarEditor() {
  const area = porId<HTMLTextAreaElement>("ps-editor-texto");
  if (!area) return;
  const estilo = getComputedStyle(area);
  const altura = parseFloat(estilo.lineHeight) || 20;
  const topo = area.scrollTop;
  const { height, minHeight } = area.style;
  area.style.minHeight = area.style.height = "0px"; // mede só o texto, sem a sobra da caixa
  const conteudo = area.scrollHeight - parseFloat(estilo.paddingTop) - parseFloat(estilo.paddingBottom);
  Object.assign(area.style, { height, minHeight });
  area.scrollTop = topo;
  const total = Math.max(1, Math.round(conteudo / altura));
  const linhas = porId("ps-editor-linhas");
  if (linhas) {
    linhas.textContent = Array.from({ length: total }, (_, i) => i + 1).join("\n");
    linhas.scrollTop = area.scrollTop;
  }
  const contador = porId("ps-editor-contador");
  if (contador) contador.textContent = `${area.value.length} / ${LIMITE_COMANDO}`;
  const totalLinhas = porId("ps-editor-total-linhas");
  if (totalLinhas) totalLinhas.textContent = plural(total);
}

function abrirEditor(botao: HTMLElement) {
  const dialogo = porId<HTMLDialogElement>("ps-editor");
  const area = porId<HTMLTextAreaElement>("ps-editor-texto");
  if (!dialogo || !area || dialogo.open) return;
  area.value = porId<HTMLTextAreaElement>("input-powershell-comando")?.value ?? "";
  const host = porId("ps-editor-hostname");
  if (host) {
    host.textContent = porId<HTMLInputElement>("input-powershell-hostname")?.value.trim() ?? "";
    host.hidden = !host.textContent;
  }
  const aviso = porId("ps-editor-aviso");
  if (aviso) aviso.textContent = "";
  sincronizarModoPowerShell();
  if (typeof dialogo.showModal === "function") dialogo.showModal();
  else dialogo.setAttribute("open", "");
  botao.setAttribute("aria-expanded", "true");
  area.focus();
  atualizarEditor();
}

// Cancelar, X, Esc e clique fora: descarta o que foi digitado no editor; o campo do cartão fica como estava.
function fecharEditor() {
  const dialogo = porId<HTMLDialogElement>("ps-editor");
  if (dialogo?.open) dialogo.close();
}

function inserirDoEditor() {
  const area = porId<HTMLTextAreaElement>("ps-editor-texto");
  const campo = porId<HTMLTextAreaElement>("input-powershell-comando");
  const enviar = porId<HTMLButtonElement>("btn-powershell-endpoint");
  if (!area || !campo || !enviar) return;
  if (/[\r\n]/.test(area.value)) {
    const aviso = porId("ps-editor-aviso");
    if (aviso) aviso.textContent = "O comando não pode ter quebra de linha.";
    return;
  }
  campo.value = area.value;
  campo.dispatchEvent(new Event("input", { bubbles: true }));
  fecharEditor();
  porId("btn-ps-ver-inteiro")?.focus();
  // Mesmo caminho do botão do cartão: validações, confirmação e um único POST, sem Enter.
  enviar.form?.requestSubmit(enviar);
}

function instalarEditor() {
  const dialogo = porId<HTMLDialogElement>("ps-editor");
  const area = porId<HTMLTextAreaElement>("ps-editor-texto");
  if (!dialogo || !area) return;
  let apertouNoFundo = false;
  dialogo.addEventListener("pointerdown", evento => { apertouNoFundo = evento.target === dialogo; });
  // Fundo: só fecha se o clique começou e terminou nele (arrastar a seleção para fora não descarta o texto).
  dialogo.addEventListener("click", evento => { if (evento.target === dialogo && apertouNoFundo) fecharEditor(); });
  dialogo.addEventListener("keydown", evento => {
    if (evento.key === "Escape") evento.stopPropagation(); // o Esc é do diálogo, não fecha outro menu atrás
  });
  dialogo.addEventListener("close", () => {
    const botao = porId("btn-ps-ver-inteiro");
    botao?.setAttribute("aria-expanded", "false");
    if (!document.activeElement || document.activeElement === document.body) botao?.focus();
  });
  area.addEventListener("keydown", evento => {
    if (evento.key === "Enter") evento.preventDefault(); // o comando nunca tem Enter
  });
  area.addEventListener("input", atualizarEditor);
  area.addEventListener("scroll", () => {
    const linhas = porId("ps-editor-linhas");
    if (linhas) linhas.scrollTop = area.scrollTop;
  });
  porId("btn-ps-editor-fechar")?.addEventListener("click", fecharEditor);
  porId("btn-ps-editor-cancelar")?.addEventListener("click", fecharEditor);
  porId("btn-ps-editor-inserir")?.addEventListener("click", inserirDoEditor);
}

function escolherModoPowerShell(op: HTMLElement) {
  const select = porId<HTMLSelectElement>("select-powershell-modo");
  if (!select || !op.dataset.modo) return;
  select.value = op.dataset.modo;
  sincronizarModoPowerShell();
}

// A cidade vem de appState.retiradaCidadeSelecionada, mas só vale se o "Local atual" começa por ela (a aba Transporte
// também escreve nesse campo, com um padrão).
function sincronizarCidade(appState: Pick<EstadoApp, "retiradaCidadeSelecionada">) {
  const alvo = porId("card-cidade");
  if (!alvo) return;
  const local = porId("card-localizacao")?.textContent?.trim() ?? "";
  const cidade = String(appState.retiradaCidadeSelecionada || "").trim();
  alvo.textContent = cidade && local.startsWith(cidade) ? cidade : "";
}

export function instalarLayoutNl(appState: Pick<EstadoApp, "retiradaCidadeSelecionada">) {
  if (instalado || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  instalado = true;

  document.addEventListener("input", evento => {
    const alvo = evento.target as HTMLElement | null;
    if (alvo?.classList?.contains("ck-chamado__texto")) atualizarContadorChamado();
    else if (alvo?.id === "input-powershell-comando") atualizarComandoPowerShell();
  });
  document.addEventListener("click", evento => {
    const alvo = evento.target as Element | null;
    const op = alvo?.closest?.<HTMLElement>(".nlh-segmento__op");
    if (op) return escolherModoPowerShell(op);
    const inteiro = alvo?.closest?.<HTMLElement>("#btn-ps-ver-inteiro");
    if (inteiro) return abrirEditor(inteiro);
    if (alvo?.closest?.("#btn-restaurar-chamado")) restaurarModeloChamado();
  });
  document.addEventListener("change", evento => {
    const id = (evento.target as HTMLElement | null)?.id;
    if (id === "select-powershell-modo") sincronizarModoPowerShell();
    // O código pronto grava comando e modo sem disparar eventos; relê no turno seguinte, depois do handler dele.
    else if (id === "select-powershell-codigo") setTimeout(() => { sincronizarModoPowerShell(); atualizarComandoPowerShell(); }, 0);
  });
  window.addEventListener("resize", () => { atualizarComandoPowerShell(); atualizarEditor(); });
  instalarEditor();

  if (typeof MutationObserver === "function") {
    const conteudo = porId("ticket-templates-content");
    if (conteudo) new MutationObserver(atualizarContadorChamado).observe(conteudo, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
    const local = porId("card-localizacao");
    if (local) new MutationObserver(() => sincronizarCidade(appState)).observe(local, { childList: true, characterData: true, subtree: true });
    const cartao = porId("card-equipamento");
    if (cartao) {
      new MutationObserver(() => { atualizarContadorChamado(); atualizarComandoPowerShell(); }).observe(cartao, { attributes: true, attributeFilter: ["class"] });
    }
  }
  atualizarContadorChamado();
  sincronizarModoPowerShell();
  atualizarComandoPowerShell();
  sincronizarCidade(appState);
}
