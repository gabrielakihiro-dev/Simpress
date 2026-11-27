// Chips da última leitura dos chamados antigos (#sebrae-leitura, topo do F5): estado lido por leitura.tsx
// (useSyncExternalStore) e escrito por renderizarAntigos e abrirFalhas em estado.ts.
// Só sintaxe apagável: os testes carregam estado.ts direto no Node.
import type { Registro } from "./tipos";

export interface EstadoLeitura {
  /** Resultado mostrado nos chips; null = sem leitura ou leitura em andamento (o grupo some). */
  resultado: Registro | null;
  /** Popover do chip "N falhas" aberto. */
  falhasAbertas: boolean;
}
export type LojaLeitura = ReturnType<typeof criarLojaLeitura>;

export function criarLojaLeitura() {
  // O estado inicial repete o partial (frontend/partials/cockpit-tool-panels.html): grupo oculto e popover fechado.
  let estado: EstadoLeitura = { resultado: null, falhasAbertas: false };
  const ouvintes = new Set<() => void>();
  return {
    assinar(ouvinte: () => void) { ouvintes.add(ouvinte); return () => { ouvintes.delete(ouvinte); }; },
    ler: () => estado,
    atualizar(parte: Partial<EstadoLeitura>) { estado = { ...estado, ...parte }; ouvintes.forEach(ouvinte => ouvinte()); },
  };
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

/** Textos dos chips (vazio = chip oculto) e a lista de falhas [UTIC, motivo], como renderizarChipsLeitura os escrevia. */
export function chipsLeitura(r: Registro | null) {
  const horario = r?.em ? new Date(r.em) : null;
  const hora = horario && !Number.isNaN(horario.getTime())
    ? horario.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "") : "";
  const falhas = Object.entries(r?.falhas || {}).map(([numero, motivo]) => [numero, String(motivo)] as [string, string]);
  return {
    hora: r ? `${hora}${r.concluido ? "" : `${hora ? " · " : ""}interrompida`}` : "",
    lidos: r ? plural((r.lidos || []).length, "lido", "lidos") : "",
    falhas,
    textoFalhas: falhas.length ? plural(falhas.length, "falha", "falhas") : "",
    semUtic: r && r.sem_utic > 0 ? `${r.sem_utic} sem UTIC` : "",
  };
}
