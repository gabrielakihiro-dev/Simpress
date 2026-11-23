export type Custos = { opus: number; sonnet: number; fable: number; haiku: number }

declare module 'claude-code' {
  interface PluginState {
    'custo-modelos': { custos: Custos }
  }
}
