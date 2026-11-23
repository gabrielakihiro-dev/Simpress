import type { Custos } from '../types'

export type Familia = keyof Custos

// US$ por 1M tokens (tabela da skill claude-api, 2026-11-03). Cache write: 1,25x a entrada (5 min) e 2x (1 h).
// shortcut: Haiku 5.5 acima de 100K tokens de prompt custa $0.50/$2.50; aqui fica sempre a faixa baixa.
const PRECO: Record<Familia, { entrada: number; saida: number; leitura: number }> = {
  fable: { entrada: 8, saida: 40, leitura: 0.2 },
  opus: { entrada: 4, saida: 20, leitura: 0.2 },
  sonnet: { entrada: 2, saida: 10, leitura: 0.1 },
  haiku: { entrada: 0.1, saida: 0.5, leitura: 0.01 },
}

export const ZERO: Custos = { opus: 0, sonnet: 0, fable: 0, haiku: 0 }

// Total zero devolve tudo 0, nunca NaN.
export const porcentagens = (c: Custos): Custos => {
  const t = c.opus + c.sonnet + c.fable + c.haiku
  const p = (v: number) => (t > 0 ? Math.round((v / t) * 100) : 0)
  return { opus: p(c.opus), sonnet: p(c.sonnet), fable: p(c.fable), haiku: p(c.haiku) }
}

export const familia = (model: string): Familia | undefined =>
  (Object.keys(PRECO) as Familia[]).find(f => model.includes(`-${f}-`) || model.includes(`${f}[`) || model.endsWith(f))

type Uso = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  ephemeral_1h_input_tokens?: number
}

export function custo(u: Uso): { familia: Familia; usd: number } | undefined {
  const f = familia(u.model)
  if (!f) return undefined
  const p = PRECO[f]
  const h1 = u.ephemeral_1h_input_tokens ?? 0
  const m5 = u.cache_creation_input_tokens - h1
  const usd = (u.input_tokens * p.entrada + u.output_tokens * p.saida + u.cache_read_input_tokens * p.leitura + m5 * p.entrada * 1.25 + h1 * p.entrada * 2) / 1e6
  return { familia: f, usd }
}
