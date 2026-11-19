import type { EstadoApp } from "../../estado-app";

// Novo layout da Home (F1): só apresentação. Contador do texto do chamado, "Restaurar modelo", cidade ao lado do modelo,
// modo do PowerShell em controle segmentado e "Ver inteiro" do comando. Nada aqui envia, executa ou aperta Enter:
// "Inserir no PowerShell" segue no estado.ts, com a mesma confirmação.
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
  const aberto = porId("btn-ps-ver-inteiro")?.getAttribute("aria-expanded") === "true";
  campo.style.height = "";
  if (aberto) campo.style.height = `${campo.scrollHeight}px`;
  // Recolhido, a altura é a do CSS; o que passa dela vira "+N linhas".
  const pilula = porId("nlh-ps-linhas");
  if (!pilula) return;
  const altura = parseFloat(getComputedStyle(campo).lineHeight) || 18;
  const ocultas = aberto ? 0 : Math.ceil((campo.scrollHeight - campo.clientHeight) / altura);
  pilula.hidden = ocultas < 1;
  pilula.textContent = ocultas < 1 ? "" : `+${ocultas} ${ocultas === 1 ? "linha" : "linhas"}`;
}

function alternarVerInteiro(botao: HTMLElement) {
  botao.setAttribute("aria-expanded", String(botao.getAttribute("aria-expanded") !== "true"));
  atualizarComandoPowerShell();
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
    if (inteiro) return alternarVerInteiro(inteiro);
    if (alvo?.closest?.("#btn-restaurar-chamado")) restaurarModeloChamado();
  });
  document.addEventListener("change", evento => {
    const id = (evento.target as HTMLElement | null)?.id;
    if (id === "select-powershell-modo") sincronizarModoPowerShell();
    // O código pronto grava comando e modo sem disparar eventos; relê no turno seguinte, depois do handler dele.
    else if (id === "select-powershell-codigo") setTimeout(() => { sincronizarModoPowerShell(); atualizarComandoPowerShell(); }, 0);
  });
  window.addEventListener("resize", atualizarComandoPowerShell);

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
