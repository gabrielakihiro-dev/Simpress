import { EVENTO_COMPARACOES, horarioCurto, tipoLegivel, ultimasComparacoes } from "./rotulos-comparacao";
import type { AnuncioComparacoes } from "./rotulos-comparacao";
import { escreverNumeroCartao } from "./numeros-bento";

// Bento do Resumo (F3, Novo layout): números vindos do painel local (Ativos e Backups em dia) e cartão "Histórico".
// O HTML dos cartões é estático (frontend/partials/cockpit-tool-panels.html, `.nf3-topo`); os de Divergências,
// Apelidos, Usuários e Sem acesso são escritos por resultado-comparacao/estado.ts.

const VISIVEIS_NO_HISTORICO = 4;
type Registro = Record<string, unknown>;

const inteiro = (valor: unknown): number | null => {
  if (valor === null || valor === undefined || typeof valor === "boolean" || String(valor).trim() === "") return null;
  const lido = Number(valor);
  return Number.isSafeInteger(lido) && lido >= 0 ? lido : null;
};

// "Backups em dia": regionais prioritárias com status "ok" sobre todas as prioritárias. Sem dados utilizáveis: null ("—").
function backupsEmDia(dados: unknown): { ok: number; total: number } | null {
  if (!dados || typeof dados !== "object") return null;
  const lido = dados as Registro;
  if (lido.indisponivel || !Array.isArray(lido.prioritarias) || !lido.prioritarias.length) return null;
  const ok = lido.prioritarias.filter(item => (item as Registro | null)?.status === "ok").length;
  return { ok, total: lido.prioritarias.length };
}

function pintarBackups(dados: unknown): void {
  const resumo = backupsEmDia(dados);
  const anel = document.querySelector<SVGElement>('[data-nf3-cartao="backups"] [data-nf3-anel]');
  const caixa = document.querySelector<HTMLElement>('[data-nf3-cartao="backups"] .ck-bento-anel');
  if (!resumo) {
    escreverNumeroCartao("backups", null);
    if (anel) {
      globalThis.SimpressBento?.cancelar?.(anel);
      delete (anel as unknown as HTMLElement).dataset.bentoAnel;
      anel.style.setProperty("stroke-dashoffset", "326.73");
    }
    caixa?.setAttribute("aria-label", "Backups em dia: dados indisponíveis");
    return;
  }
  const fracao = resumo.ok / resumo.total;
  escreverNumeroCartao("backups", Math.floor(fracao * 100), "%"); // floor: 998 de 1000 não vira 100%
  if (anel) {
    const el = anel as unknown as HTMLElement;
    if (el.dataset.bentoAnel !== String(fracao)) {
      el.dataset.bentoAnel = String(fracao);
      if (globalThis.SimpressBento?.animarAnel) globalThis.SimpressBento.animarAnel(anel, fracao);
      else anel.style.setProperty("stroke-dashoffset", (326.73 * (1 - fracao)).toFixed(2));
    }
  }
  caixa?.setAttribute("aria-label", `Backups em dia: ${resumo.ok} de ${resumo.total} regionais`);
}

// Chamado por backups-regionais/montar.tsx a cada leitura do /api/painel (e na repetição do último, se o evento passou antes do bundle).
export function pintarPainelNoBento(painel: unknown): void {
  const lido = painel && typeof painel === "object" ? painel as Registro : {};
  escreverNumeroCartao("ativos", inteiro(lido.total_equipamentos));
  pintarBackups("backups_regionais" in lido ? lido.backups_regionais : null);
}

// Leitura do painel falhou antes de qualquer resposta: Ativos e Backups em dia ficam em "—".
export function marcarPainelIndisponivel(): void {
  escreverNumeroCartao("ativos", null);
  pintarBackups({ indisponivel: true });
}

// "12/11/2026 09:33" -> "12/11 09:33" (a linha do cartão não leva o ano).
function horarioDaLinha(horario: unknown): string {
  const completo = horarioCurto(horario);
  return /^\d/.test(completo) ? `${completo.slice(0, 5)}${completo.slice(10)}` : completo;
}

function linhaDoHistorico(evento: Registro, selecionado: boolean): HTMLLIElement {
  const item = document.createElement("li");
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "nf3-historico__item";
  botao.dataset.nf3Evento = String(evento.id ?? "");
  if (selecionado) botao.setAttribute("aria-current", "true");
  const quando = document.createElement("span");
  quando.className = "nf3-historico__quando";
  quando.textContent = horarioDaLinha(evento.horario);
  const tipo = document.createElement("span");
  tipo.className = "nf3-historico__tipo";
  tipo.textContent = tipoLegivel(evento);
  botao.append(quando, tipo);
  if (selecionado) {
    const selo = document.createElement("span");
    selo.className = "nf3-historico__atual";
    selo.textContent = "atual";
    botao.append(selo);
  }
  item.append(botao);
  return item;
}

// Cartão "Histórico": os quatro primeiros registros que a lista do seletor já carregou (sem novo pedido à API).
function pintarHistorico(anuncio: AnuncioComparacoes | null): void {
  const lista = document.getElementById("nf3-historico-lista");
  const vazio = document.getElementById("nf3-historico-vazio");
  if (!lista || !anuncio) return;
  const eventos = anuncio.eventos.filter((evento): evento is Registro => Boolean(evento) && typeof evento === "object");
  // Repintar tira o botão focado do DOM: devolve o foco ao mesmo registro.
  const focado = lista.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.nf3Evento : undefined;
  lista.replaceChildren(...eventos.slice(0, VISIVEIS_NO_HISTORICO).map(evento => linhaDoHistorico(evento, String(evento.id ?? "") === anuncio.selecionadoId)));
  if (vazio) vazio.hidden = eventos.length > 0;
  if (focado !== undefined) lista.querySelector<HTMLElement>(`[data-nf3-evento="${CSS.escape(focado)}"]`)?.focus();
}

function ligarHistorico(): void {
  const lista = document.getElementById("nf3-historico-lista");
  lista?.addEventListener("click", evento => {
    const botao = (evento.target as HTMLElement).closest<HTMLElement>("[data-nf3-evento]");
    const seletor = document.getElementById("cockpit-comparison-event") as HTMLSelectElement | null;
    const id = botao?.dataset.nf3Evento;
    if (!id || !seletor || seletor.value === id) return;
    // Mesma ação de escolher no seletor: o handler dele carrega o resultado e atualiza o status.
    seletor.value = id;
    seletor.dispatchEvent(new Event("change", { bubbles: true }));
    // Selo "atual" já no clicado, mesmo se a abertura falhar ou demorar.
    const anuncio = ultimasComparacoes();
    if (anuncio) pintarHistorico({ ...anuncio, selecionadoId: id });
  });
  // "Ver tudo →" abre o mesmo diálogo do botão antigo (app.abrirModalHistoricoComparacoes); o botão antigo continua existindo.
  document.getElementById("nf3-historico-ver-tudo")?.addEventListener("click", () => {
    document.getElementById("cockpit-comparison-legacy")?.click();
  });
  document.addEventListener(EVENTO_COMPARACOES, evento => pintarHistorico((evento as CustomEvent<AnuncioComparacoes>).detail));
  pintarHistorico(ultimasComparacoes());
}

// Contagens e anel partem do zero cada vez que o Resumo volta à tela (contrato do bento).
function repetirAoAparecer(): void {
  const topo = document.querySelector<HTMLElement>(".nf3-topo");
  if (!topo || typeof IntersectionObserver !== "function") return;
  let visivel = false;
  new IntersectionObserver(entradas => {
    const agora = entradas.some(entrada => entrada.isIntersecting);
    if (agora && !visivel) {
      topo.querySelectorAll<HTMLElement>("[data-nf3-cartao]").forEach(cartao => {
        globalThis.SimpressBento?.animarDentro?.(cartao);
      });
    }
    visivel = agora;
  }, { threshold: 0.15 }).observe(topo);
}

export function montarBentoResumo(): void {
  ligarHistorico();
  repetirAoAparecer();
}
