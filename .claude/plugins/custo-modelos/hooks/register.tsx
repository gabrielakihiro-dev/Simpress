import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { custo, porcentagens, ZERO } from './precos'

const custos = atom({ plugin: 'custo-modelos', key: 'custos' } as const, ZERO)

const ROTULO = { opus: 'Opus', sonnet: 'Sonnet', fable: 'Fable', haiku: 'Haiku' } as const

export const register: Register = on => {
  // Cada turno (sessão principal e subagentes) soma no modelo que respondeu.
  on('turn.complete', async ($, e, next) => {
    const c = e.usage ? custo(e.usage) : undefined
    if (c) await update($, custos, x => ({ ...ZERO, ...x, [c.familia]: (x[c.familia] ?? 0) + c.usd }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    // A faixa do Ponytail divide o espaço: a linha dela vem antes, a nossa logo abaixo.
    const acima = await next(e).catch(() => undefined)
    const x = { ...ZERO, ...(await read($, custos)) }
    const pct = porcentagens(x)
    const { Box, Text } = $.ui.resolve(e)
    const linha = (
      <Box flexDirection="row" gap={2}>
        <Text dimColor>custo por modelo</Text>
        {(Object.keys(ROTULO) as (keyof typeof ROTULO)[]).map(f => (
          <Text key={f} dimColor={x[f] === 0}>
            {ROTULO[f]} ${x[f].toFixed(2)} ({pct[f]}%)
          </Text>
        ))}
      </Box>
    )
    return acima ? <Box flexDirection="column">{acima}{linha}</Box> : linha
  })
}
