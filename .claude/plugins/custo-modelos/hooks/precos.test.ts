import { expect, test } from 'claude-code/testing'
import { custo, familia, porcentagens } from './precos'

test('familia pelo id do modelo', () => {
  expect(familia('claude-opus-5-5')).toBe('opus')
  expect(familia('claude-fable-5-2')).toBe('fable')
  expect(familia('claude-haiku-5-5')).toBe('haiku')
  expect(familia('claude-sonnet-5-5')).toBe('sonnet')
  expect(familia('gpt-x')).toBeUndefined()
})

test('custo de 1M de entrada e 1M de saída no Opus = $24', () => {
  const c = custo({ model: 'claude-opus-5-5', input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  expect(Math.round((c?.usd ?? 0) * 100) / 100).toBe(24)
})

test('cache write 1h vale 2x a entrada', () => {
  const c = custo({ model: 'claude-sonnet-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 })
  expect(Math.round((c?.usd ?? 0) * 100) / 100).toBe(4)
})

test('porcentagens de cada família no total', () => {
  expect(porcentagens({ opus: 3, sonnet: 1, fable: 0, haiku: 0 })).toEqual({ opus: 75, sonnet: 25, fable: 0, haiku: 0 })
})

test('porcentagens com total zero = tudo 0', () => {
  expect(porcentagens({ opus: 0, sonnet: 0, fable: 0, haiku: 0 })).toEqual({ opus: 0, sonnet: 0, fable: 0, haiku: 0 })
})
