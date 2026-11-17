import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { apiFetch } from "../../api";
import { PainelBackups } from "./painel";

// Chamado por frontend/src/main.tsx com o painel #resumo-painel-backups (data-react-painel="backups-regionais").
// Os dados chegam pelo evento `simpress:painel-atualizado`; o painel não consulta o /api/painel sozinho. Se o evento
// passou antes do bundle (paineis-dados lê o painel ao instalar), a ponte repete o último com `repetirPainel`.
// O pedido do painel a cada 5 min fica na aplicação (frontend/src/aplicacao/backups-regionais.ts), para os alertas do
// sino não dependerem do bundle React.

type Marca = Record<string, string | undefined>;
const mostrarToast = (mensagem: string, tipo: string) => (window as unknown as { showToast?: (m: string, t: string) => void }).showToast?.(mensagem, tipo);
const pedirPainel = () => document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));

let raiz: Root;
let alvo: HTMLElement;
let dados: unknown;
let fixoAtual: string | undefined;
let emAndamento = false;
// `disabled` no clique tira o foco do botão (o navegador o manda ao body): guarda a marca para o redesenho.
let focoDaAcao: Marca | null = null;
// O React reaproveita o botão (Confirmar vira Desfazer): o timer de um clique não pode soltar o clique seguinte.
let reabrir: number | undefined;

// Cópia de rotuloContagemAba("backups", total) de frontend/src/paineis/resultado-comparacao/renderizador.ts (só o ramo Backups).
function rotuloAba(total: number | null | undefined) {
  if (total === undefined) return "Backups: aguardando dados";
  if (total === null) return "Backups: dados indisponíveis";
  return `Backups: ${total.toLocaleString("pt-BR")} ${total === 1 ? "regional pendente" : "regionais pendentes"}`;
}

function pendencias(): number | null | undefined {
  if (dados === undefined) return undefined; // rótulo "aguardando dados"
  const lido = dados as { indisponivel?: unknown; pendencias?: { sem_backup?: unknown; conferir?: unknown } } | null;
  if (!lido || typeof lido !== "object" || lido.indisponivel) return null;
  const contar = (valor: unknown) => (Array.isArray(valor) ? valor.length : 0);
  return contar(lido.pendencias?.sem_backup) + contar(lido.pendencias?.conferir);
}

function atualizarAba() {
  const total = pendencias();
  const selo = document.getElementById("resumo-backups-contagem");
  if (selo) selo.textContent = total === null || total === undefined ? "—" : total.toLocaleString("pt-BR");
  document.getElementById("resumo-aba-backups")?.setAttribute("aria-label", rotuloAba(total));
}

// Tudo menos o "Atualizado em": se só ele mudou, o React troca o texto da linha e nada mais.
function parteFixa() {
  if (!dados || typeof dados !== "object") return String(dados);
  const { gerado_em: geradoEm, ...resto } = dados as Record<string, unknown>;
  return JSON.stringify([Boolean(geradoEm), resto]);
}

function desenhar() {
  atualizarAba();
  const fixo = parteFixa();
  const soMeta = !focoDaAcao && fixo === fixoAtual;
  const foco = document.activeElement as HTMLElement | null;
  const semFoco = !foco || foco === document.body;
  const marca: Marca | null = soMeta ? null
    : foco && alvo.contains(foco) ? { ...foco.dataset, lista: foco.closest<HTMLElement>("details[data-cidade]")?.dataset.cidade }
      : semFoco ? focoDaAcao : null;
  focoDaAcao = null;
  // Redesenho com o painel à vista (ação ou dado novo) não refaz a entrada dos cartões; a troca de sub-aba refaz
  // (comparison-result.js tira o data-sem-entrada ao abrir a sub-aba).
  const redesenho = alvo.childElementCount > 0 && !alvo.closest("[hidden]");
  flushSync(() => { raiz.render(<PainelBackups dados={dados} />); });
  fixoAtual = fixo;
  if (soMeta) return;
  // Antes o innerHTML recriava os botões soltos; o React reaproveita o mesmo botão, então solta o que ficou ocupado.
  alvo.querySelectorAll<HTMLButtonElement>("[data-backup-acao][aria-busy]").forEach(soltar);
  if (redesenho) alvo.querySelectorAll<HTMLElement>(".ck-bento-cartao").forEach(cartao => { cartao.dataset.semEntrada = ""; });
  if (!marca || (foco && alvo.contains(foco) && document.activeElement === foco)) return;
  // Foco volta ao mesmo botão; se a ação o trocou (Confirmar vira Desfazer), ao botão da mesma série e cidade;
  // depois à lista de excluídos que estava em foco; por último à aba.
  const botoes = [...alvo.querySelectorAll<HTMLElement>("[data-backup-acao]")];
  const mesmaSerie = (item: HTMLElement) => item.dataset.serie === marca.serie && item.dataset.cidade === marca.cidade;
  const mesmo = botoes.find(item => item.dataset.backupAcao === marca.backupAcao && mesmaSerie(item))
    || (marca.serie ? botoes.find(mesmaSerie) : null)
    || (marca.lista ? [...alvo.querySelectorAll<HTMLElement>("details[data-cidade] > summary")].find(item => item.parentElement?.dataset.cidade === marca.lista) : null);
  (mesmo || document.getElementById("resumo-aba-backups"))?.focus();
}

function soltar(botao: HTMLButtonElement) {
  botao.disabled = false;
  botao.removeAttribute("aria-busy");
}

// Sem `status` é erro de rede: o texto cru do navegador ("Failed to fetch") não vai ao toast.
function mensagemDoErro(erro: unknown, padrao: string) {
  const lido = erro as { status?: number; message?: string; detail?: { mensagem?: unknown } } | null;
  const mensagem = lido?.detail?.mensagem;
  if (typeof mensagem === "string" && mensagem.trim()) return mensagem.trim();
  return (lido?.status && lido?.message) || padrao;
}

function liberar(botao: HTMLButtonElement) {
  focoDaAcao = null; // sem redesenho até aqui, a marca não pode puxar o foco depois
  soltar(botao);
}

async function aoClicar(evento: MouseEvent) {
  const botao = (evento.target as Element | null)?.closest<HTMLButtonElement>("[data-backup-acao]");
  if (!botao || emAndamento) return;
  const { backupAcao: acao, serie, cidade } = botao.dataset;
  if ((acao !== "confirmar" && acao !== "desfazer") || !serie || !cidade) return;
  // Marca e `disabled` no mesmo clique, antes de qualquer await: o segundo clique de um duplo clique não manda outro POST.
  emAndamento = true;
  window.clearTimeout(reabrir);
  focoDaAcao = { ...botao.dataset };
  botao.disabled = true;
  botao.setAttribute("aria-busy", "true");
  const errorMessage = acao === "confirmar" ? "Não foi possível confirmar o backup." : "Não foi possível desfazer a confirmação.";
  try {
    const resposta = await apiFetch<{ removido?: boolean }>(`/api/backups-regionais/${acao}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serie, cidade }),
      errorMessage,
    });
    if (acao === "desfazer" && resposta?.removido === false) mostrarToast(`Não havia confirmação para desfazer: série ${serie}, ${cidade}.`, "warning");
    else mostrarToast(acao === "confirmar" ? `Backup confirmado por 7 dias: série ${serie}, ${cidade}.` : `Confirmação desfeita: série ${serie}, ${cidade}.`, "success");
    pedirPainel();
    // O redesenho troca o botão; se a leitura do painel falhar, ele volta a funcionar sozinho em 10 s.
    reabrir = window.setTimeout(() => liberar(botao), 10000);
  } catch (erro) {
    mostrarToast(mensagemDoErro(erro, errorMessage), "error");
    liberar(botao);
    // 422: a série saiu do cálculo depois que a tela foi desenhada; pede o painel para a tela mostrar o estado atual.
    if ((erro as { status?: number } | null)?.status === 422) pedirPainel();
    if (!document.activeElement || document.activeElement === document.body) botao.focus();
  } finally {
    emAndamento = false;
  }
}

export function montar(container: HTMLElement) {
  alvo = container;
  raiz = createRoot(container);
  const aoAtualizar = (painelLido: unknown) => {
    if (!painelLido || typeof painelLido !== "object") return;
    dados = "backups_regionais" in painelLido ? (painelLido as Record<string, unknown>).backups_regionais : null;
    desenhar();
  };
  // Leitura do painel falhou antes de qualquer resposta: "aguardando" vira "indisponível" (selo e rótulo da aba também).
  const aoFalhar = () => {
    if (dados !== undefined) return;
    dados = { indisponivel: true, limitacoes: [] };
    desenhar();
  };
  document.addEventListener("simpress:painel-atualizado", evento => aoAtualizar((evento as CustomEvent).detail));
  document.addEventListener("simpress:painel-indisponivel", aoFalhar);
  container.addEventListener("click", evento => { void aoClicar(evento); });
  // flushSync: o painel já existe no DOMContentLoaded, como no HTML antigo.
  desenhar();
  return {
    // O evento pode ter passado antes de este bundle carregar: a ponte (backups-regionais.js) guardou o último e o repete.
    repetirPainel(ultimo: { painel?: unknown; indisponivel?: boolean }) {
      if (ultimo.painel !== undefined) aoAtualizar(ultimo.painel);
      else if (ultimo.indisponivel) aoFalhar();
    },
  };
}
