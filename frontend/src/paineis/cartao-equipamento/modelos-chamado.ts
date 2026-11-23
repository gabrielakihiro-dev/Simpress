import { apiRota } from "../../api";

// Chamado manual (Home F1): renomear a aba ativa e "Salvar como padrão". O padrão salvo vai para
// config/modelos_chamado.json (versionado: entra no próximo commit). Sem padrão salvo, valem o nome e o texto do HTML.
// O padrão de cada modelo fica no próprio DOM: nome em data-rotulo-padrao da aba, texto no defaultValue da área.
type Avisar = (mensagem: string, tipo: string) => void;

let instalado = false;

function porId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function abaAtiva() {
  return document.querySelector<HTMLElement>('.ck-modelo-aba[aria-selected="true"]');
}

function slugDa(aba: HTMLElement | null) {
  return aba?.id.replace(/^pill-chamado-/, "") ?? "";
}

function rotuloDa(aba: HTMLElement | null) {
  return aba?.querySelector<HTMLElement>(".ck-modelo-aba__rotulo") ?? null;
}

function areaDo(slug: string) {
  return porId<HTMLTextAreaElement>(`texto-chamado-${slug}`);
}

// O lápis (e o campo de renomear) ficam fora do tablist, por cima da aba ativa, como no artefato.
function posicionarLapis() {
  const aba = abaAtiva();
  const linha = aba?.closest<HTMLElement>(".nlh-abas-linha");
  if (!aba || !linha) return;
  const base = linha.getBoundingClientRect();
  const caixa = aba.getBoundingClientRect();
  const esquerda = caixa.left - base.left;
  const topo = caixa.top - base.top;
  const lapis = porId("btn-renomear-chamado");
  if (lapis) {
    lapis.style.left = `${esquerda + caixa.width - 36}px`;
    lapis.style.top = `${topo + (caixa.height - 32) / 2}px`;
  }
  const campo = porId("nlh-renomear-campo");
  if (campo) {
    campo.style.left = `${esquerda}px`;
    campo.style.top = `${topo}px`;
    campo.style.height = `${caixa.height}px`;
    campo.style.minWidth = `${caixa.width}px`;
  }
}

function guardarPadraoDoHtml() {
  document.querySelectorAll<HTMLElement>(".ck-modelo-aba").forEach(aba => {
    const rotulo = rotuloDa(aba);
    if (rotulo && aba.dataset.rotuloPadrao === undefined) aba.dataset.rotuloPadrao = rotulo.textContent?.trim() ?? "";
  });
}

function atualizarBotaoSalvar() {
  const botao = porId<HTMLButtonElement>("btn-salvar-padrao-chamado");
  const aba = abaAtiva();
  const area = areaDo(slugDa(aba));
  posicionarLapis();
  if (!botao) return;
  const mudouNome = (rotuloDa(aba)?.textContent?.trim() ?? "") !== (aba?.dataset.rotuloPadrao ?? "");
  botao.disabled = !area || !(mudouNome || area.value !== area.defaultValue);
}

function aplicar(slug: string, padrao: { rotulo?: string; texto?: string }) {
  const aba = porId(`pill-chamado-${slug}`);
  const rotulo = rotuloDa(aba);
  if (aba && rotulo && padrao.rotulo) {
    if (rotulo.textContent?.trim() === aba.dataset.rotuloPadrao) rotulo.textContent = padrao.rotulo;
    aba.dataset.rotuloPadrao = padrao.rotulo;
  }
  const area = areaDo(slug);
  if (area && padrao.texto) {
    const intocada = area.value === area.defaultValue;
    area.defaultValue = padrao.texto;
    if (intocada) {
      area.value = padrao.texto;
      area.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

function fecharRenomear(confirmar: boolean) {
  const campo = porId("nlh-renomear-campo");
  const entrada = porId<HTMLInputElement>("input-rotulo-chamado");
  if (!campo || campo.hidden) return;
  const novo = entrada?.value.trim() ?? "";
  const rotulo = rotuloDa(abaAtiva());
  if (confirmar && novo && rotulo) rotulo.textContent = novo;
  campo.hidden = true;
  const lapis = porId("btn-renomear-chamado");
  if (lapis) { lapis.hidden = false; lapis.focus(); }
  atualizarBotaoSalvar();
}

function abrirRenomear() {
  const campo = porId("nlh-renomear-campo");
  const entrada = porId<HTMLInputElement>("input-rotulo-chamado");
  const lapis = porId("btn-renomear-chamado");
  if (!campo || !entrada || !lapis) return;
  entrada.value = rotuloDa(abaAtiva())?.textContent?.trim() ?? "";
  lapis.hidden = true;
  campo.hidden = false;
  posicionarLapis();
  entrada.focus();
  entrada.select();
}

function restaurarNome() {
  const aba = abaAtiva();
  const rotulo = rotuloDa(aba);
  if (rotulo && aba?.dataset.rotuloPadrao) rotulo.textContent = aba.dataset.rotuloPadrao;
}

async function salvarPadrao(avisar: Avisar) {
  fecharRenomear(true);
  const aba = abaAtiva();
  const slug = slugDa(aba);
  const area = areaDo(slug);
  const rotulo = rotuloDa(aba)?.textContent?.trim() ?? "";
  const botao = porId<HTMLButtonElement>("btn-salvar-padrao-chamado");
  if (!aba || !area || !botao) return;
  botao.disabled = true;
  try {
    await apiRota("PUT /api/modelos-chamado/{slug}", {
      caminho: { slug }, corpo: { rotulo, texto: area.value },
      errorMessage: "Não foi possível salvar o modelo como padrão.",
    });
    aba.dataset.rotuloPadrao = rotulo;
    area.defaultValue = area.value;
    avisar("Modelo salvo como padrão.", "success");
  } catch (erro) {
    avisar(erro instanceof Error ? erro.message : "Não foi possível salvar o modelo como padrão.", "error");
  }
  atualizarBotaoSalvar();
}

export function instalarModelosChamado(avisar: Avisar) {
  if (instalado || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  if (!porId("btn-salvar-padrao-chamado")) return;
  instalado = true;
  guardarPadraoDoHtml();

  document.addEventListener("input", evento => {
    if ((evento.target as HTMLElement | null)?.classList?.contains("ck-chamado__texto")) atualizarBotaoSalvar();
  });
  document.addEventListener("click", evento => {
    const alvo = evento.target as Element | null;
    if (alvo?.closest?.("#btn-renomear-chamado")) abrirRenomear();
    else if (alvo?.closest?.("#btn-renomear-ok")) fecharRenomear(true);
    else if (alvo?.closest?.("#btn-salvar-padrao-chamado")) void salvarPadrao(avisar);
    else if (alvo?.closest?.("#btn-restaurar-chamado")) { fecharRenomear(false); restaurarNome(); atualizarBotaoSalvar(); }
    else if (alvo?.closest?.(".ck-modelo-aba")) { fecharRenomear(false); setTimeout(atualizarBotaoSalvar, 0); }
  });
  porId("input-rotulo-chamado")?.addEventListener("keydown", evento => {
    if (evento.key === "Enter") { evento.preventDefault(); fecharRenomear(true); }
    else if (evento.key === "Escape") { evento.preventDefault(); fecharRenomear(false); }
  });

  const linha = document.querySelector(".nlh-abas-linha");
  if (linha && typeof ResizeObserver === "function") new ResizeObserver(posicionarLapis).observe(linha);

  // Sem servidor ou sem arquivo, ficam o nome e o texto do HTML, sem aviso.
  apiRota("GET /api/modelos-chamado", {})
    .then(resposta => Object.entries(resposta.modelos ?? {}).forEach(([slug, padrao]) => aplicar(slug, padrao)))
    .catch(() => undefined)
    .finally(atualizarBotaoSalvar);
}
