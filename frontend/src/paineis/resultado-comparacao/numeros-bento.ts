// Número dos cartões do bento do Resumo (F3, Novo layout). Só sintaxe apagável e nada de DOM na carga do módulo:
// estado.ts, que importa este arquivo, é carregado direto no Node pelos testes.

const TRACO = "—";

function elementoDoNumero(chave: string): HTMLElement | null {
  if (typeof document === "undefined" || typeof document.querySelector !== "function") return null;
  return document.querySelector<HTMLElement>(`[data-nf3-cartao="${chave}"] [data-nf3-numero]`);
}

// Escreve o número do cartão `chave`. Valor igual ao que já está na tela: não faz nada (a contagem de 900 ms não
// recomeça a cada filtro ou redesenho). Sem valor (null): cancela a contagem e deixa "—". Com `sufixo` ("%") a
// contagem leva 1200 ms, como no contrato do bento (docs/ui-motion/contrato-bento.md).
export function escreverNumeroCartao(chave: string, valor: number | null, sufixo = ""): void {
  const el = elementoDoNumero(chave);
  if (!el) return;
  const bento = globalThis.SimpressBento;
  if (valor === null) {
    bento?.cancelar?.(el);
    delete el.dataset.bentoContar;
    delete el.dataset.bentoSufixo;
    delete el.dataset.nf3Valor;
    el.textContent = TRACO;
    return;
  }
  const atual = `${valor}${sufixo}`;
  if (el.dataset.nf3Valor === atual) return;
  el.dataset.nf3Valor = atual;
  el.dataset.bentoContar = String(valor);
  if (sufixo) el.dataset.bentoSufixo = sufixo;
  else delete el.dataset.bentoSufixo;
  const formatar = (v: number): string => `${Math.round(v).toLocaleString("pt-BR")}${sufixo}`;
  if (bento?.contarAte) bento.contarAte(el, valor, formatar, sufixo ? bento.duracao.anel : bento.duracao.contagem);
  else el.textContent = formatar(valor);
}
