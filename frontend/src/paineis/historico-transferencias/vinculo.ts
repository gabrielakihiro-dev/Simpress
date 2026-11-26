// Cobertura: a planilha que o operador baixou para uma movimentação vai SÓ para a rota da cobertura, que grava
// histórico e movimentação juntos. Falha transitória guarda a pendência neste navegador para reenviar com a
// mesma chave (idempotente). Quem usa: a tela da Cobertura (pendenciaSemVinculo e tentarVincularDeNovo) e o evento
// simpress:transfer-generated (ouvinte registrado por montar.tsx).
// Não importa nada de ../cobertura (evita ciclo: a Cobertura importa este arquivo).
import { apiFetch, type ApiFetchError } from "../../api";
import { ENDPOINT, type Payload } from "./historico-transferencias-puro";

const PENDING_KEY = "simpress:cobertura:sem-vinculo";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Registro = Record<string, any>;
export interface ItemPendente { movimentacao: Registro; payload: Payload; chave?: unknown; criadoEm?: number }

// LGPD: o payload tem nome, e-mail e celular do destinatário; a pendência expira em 7 dias (decisão de 26/11/2026).
const PRAZO_MS = 7 * 24 * 60 * 60 * 1000;

// Carimba itens sem data (gravados antes do prazo existir) e apaga os vencidos. Devolve true se mudou algo.
function podarVencidos(data: Record<string, ItemPendente>): boolean {
  const agora = Date.now();
  let mudou = false;
  for (const [id, item] of Object.entries(data)) {
    if (typeof item?.criadoEm !== "number") { item.criadoEm = agora; mudou = true; }
    else if (agora - item.criadoEm > PRAZO_MS) { delete data[id]; mudou = true; }
  }
  return mudou;
}

interface Resposta { ok: boolean; status: number; corpo: Registro | null; rede: boolean; erro?: unknown }

const notify = (message: string, type = "success") => {
  const { showToast } = window as unknown as { showToast?: (texto: string, tipo?: string) => void };
  if (typeof showToast === "function") showToast(message, type);
};

function readPending(): Record<string, ItemPendente> {
  try {
    const data = JSON.parse(window.localStorage?.getItem(PENDING_KEY) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    if (podarVencidos(data)) writePending(data);
    return data;
  } catch {
    return {};
  }
}

function writePending(data: Record<string, ItemPendente>) {
  try {
    if (Object.keys(data).length) window.localStorage?.setItem(PENDING_KEY, JSON.stringify(data));
    else window.localStorage?.removeItem(PENDING_KEY);
  } catch {
    // Sem localStorage a pendência vive só nesta página.
  }
}

// Pendências desta página valem mesmo se o localStorage falhar.
const memoryPending: Record<string, ItemPendente> = {};
const allPending = (): Record<string, ItemPendente> => {
  podarVencidos(memoryPending);
  return { ...memoryPending, ...readPending() };
};

function errorMessage(body: Registro | null): string {
  const detail = body?.detail;
  return typeof detail?.mensagem === "string" ? detail.mensagem : "A movimentação não aceitou esta planilha.";
}

// POST pelo apiFetch (que também avisa simpress:servidor-offline). Sem status numérico = falha de rede (status 0).
async function enviar(url: string, corpo: unknown): Promise<Resposta> {
  try {
    const resposta = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      responseType: "response",
    });
    let lido: Registro | null = null;
    try {
      lido = JSON.parse(await resposta.text());
    } catch {
      // corpo vazio ou ilegível: segue sem corpo
    }
    return { ok: true, status: resposta.status, corpo: lido, rede: false };
  } catch (erro) {
    const { status, data } = erro as Partial<ApiFetchError>;
    if (typeof status !== "number") return { ok: false, status: 0, corpo: null, rede: true, erro };
    return { ok: false, status, corpo: (data as Registro | null | undefined) ?? null, rede: false };
  }
}

// The history is optional, so failures never reach the user's flow.
// Resolves true when the entry was stored (never rejects).
export async function appendGenericHistory(payload: Payload): Promise<boolean> {
  const resposta = await enviar(ENDPOINT, payload);
  if (resposta.rede) {
    console.warn("Histórico de transferências não registrado:", resposta.erro);
    return false;
  }
  if (!resposta.ok && resposta.status !== 501) console.warn("Histórico de transferências não registrado:", resposta.status);
  return resposta.ok;
}

export async function linkToMovement(item: ItemPendente) {
  const { movimentacao, payload, chave } = item;
  const response = await enviar(
    `/api/cobertura/movimentacoes/${encodeURIComponent(movimentacao.id)}/registrar-transferencia`,
    { payload, chave, rev: movimentacao.rev },
  );
  const body = response.corpo;
  const pending = allPending();
  if (response.ok) {
    delete memoryPending[movimentacao.id];
    delete pending[movimentacao.id];
    writePending(pending);
    document.dispatchEvent(new CustomEvent("simpress:cobertura-atualizada", { detail: body }));
    return { ok: true, resultado: body };
  }
  // Conflito, dado recusado ou movimentação inexistente não melhoram com outra tentativa; arquivo ocupado (409) é
  // transitório. Na recusa definitiva a planilha já baixada vai ao histórico genérico para não sumir de todo.
  const { status } = response;
  if (status === 404 || status === 422 || (status === 409 && body?.detail?.codigo !== "arquivo_ocupado")) {
    delete memoryPending[movimentacao.id];
    delete pending[movimentacao.id];
    writePending(pending);
    const stored = await appendGenericHistory(payload);
    notify(`${errorMessage(body)} ${stored
      ? "A planilha foi registrada no histórico sem vínculo; use Vincular transferência já gerada se ela for desta movimentação."
      : "A planilha também não entrou no histórico."}`, "error");
    return { ok: false, status, detail: body?.detail };
  }
  item.criadoEm ??= Date.now(); // nova tentativa mantém a data original: o prazo não renova
  memoryPending[movimentacao.id] = item;
  pending[movimentacao.id] = item;
  writePending(pending);
  notify("Planilha baixada sem vínculo — Tentar de novo", "warning");
  return { ok: false, status, pendente: true };
}

// Lista {movimentacao, payload, chave} das planilhas baixadas que ainda não ficaram ligadas à movimentação.
export const pendenciaSemVinculo = (): ItemPendente[] => Object.values(allPending());

// Reenvia com a MESMA chave; sem id, reenvia todas. Resolve com o resultado de cada tentativa.
export const tentarVincularDeNovo = (id?: unknown) => Promise.all(Object.values(allPending())
  .filter(item => id === undefined || item.movimentacao?.id === id)
  .map(linkToMovement));

// Append after each generated sheet. Chamado no topo de montar.tsx (na importação): o evento pode vir antes de o painel desenhar.
let ouvinteRegistrado = false;
export function registrarOuvinteTransferencia() {
  if (ouvinteRegistrado) return;
  ouvinteRegistrado = true;
  document.addEventListener("simpress:transfer-generated", evento => {
    const detalhe = (evento as CustomEvent).detail;
    const payload = detalhe?.payload;
    if (!payload) return;
    const movimentacao = detalhe?.movimentacao;
    if (movimentacao?.id) {
      void linkToMovement({ movimentacao, payload, chave: movimentacao.chave });
      return;
    }
    void appendGenericHistory(payload);
  });
}
