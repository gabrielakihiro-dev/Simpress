# Handoff react-final-3 (17/11/2026)

## Onde está
- Branch local `claude/react-final-3`, commit WIP `f44716c6`, empilhado sobre `b4c92ad6` (react-final-2). Sem push e sem PR.
- Worktree: `C:\Users\Gabriel\Desktop\Empresa\Simpress\.claude\worktrees\vistoria-tokens-3ad28b` (agora com checkout em `claude/react-final-3`; a branch `claude/vistoria-tokens-3ad28b` ficou em b4c92ad6).
- Rascunhos da parte (b), fora do repo: `react-final-3-rascunhos-b/` nesta pasta (app.ts, action-dispatcher.ts, ux-enhancements.ts, ck-cockpit-visual.ts, cromo-marca.ts, arranque/*.ts, vendor-index.d.ts, baseline-head.json, comparar.py).

## Primeiro passo da sessão nova
`git merge origin/claude/react-final-2`: traz #280 (audit) e #281. Conflitos previstos:
- `frontend/src/legado/app.js`: manter o listener da #281 depois de `app.carregarNovosSebrae();`:
  `document.addEventListener("simpress:chamados-atualizados", () => app.carregarNovosSebrae());`
  O rascunho `app.ts` já tem esse listener (linha ~175). Quando app.js sumir, ele deve ficar só uma vez, em app.ts.
- `frontend/src/paineis/chrome-automation/{acoes.ts,...}`: manter a versão da main e o comentário de caminho novo.
- `static/dist/react-entry.js`: aceitar a versão deles (`--theirs`) e rodar `npm run build:react`.

## Feito (parte a, no commit WIP)
- 16 módulos em `frontend/src/aplicacao/`: alias-history, app-shell, backups-regionais, cockpit-chamados, cockpit-tool-panels, comparison-history, comparison-result, dashboard, equipment-dossier, full-equipment-search, pontes (19 repassadores), registro (`fabricas`, 31), ticket-rules, tipos, ux-chamados, ux-ticket.
- `frontend/src/legado/features/` removida; `legado/app-entry.js` importa só `../aplicacao/registro.ts`.
- Caminhos repontados: tailwind, domains/lembretes.py, domains/ux_chamados.py (só comentários), ~49 comentários em paineis/**, harnesses, ~25 testes (`require(".../aplicacao/registro.ts").fabricas.<chave>`), e2e react-*, test_maintenance_contracts.py.
- Verificado: `node --test tests/frontend/*.cjs` deu 1009 pass e 0 fail; baseline igual ao HEAD; tsc estrito limpo.
- NÃO verificado: `npm run verify` completo (a 1ª rodada falhou só no bundle, depois corrigido; a 2ª foi interrompida), E2E, prova do Tailwind.

## Falta (parte b)
- Copiar os rascunhos; ajustar main.tsx e estado-app.ts; remover o plugin `legadoUmdNavegador` e `RAMOS_MORTOS` (vite.config.mts); `paths` no tsconfig.json e no tsconfig.ui.json; tailwind; scripts/verify.cjs:132; domains/frontend_assets.py:9.
- Tirar as publicações sem consumidor: window.SimpressFeatures, SimpressTicketRules, SimpressUxEnhancements, SimpressFilePicker. Revisar os 17 comentários "Ponte temporária".
- Repontar: test_action_registry, test_dom_id_coverage, test_feature_modules, boot-page, app-sources, test_frontend_assets.py:129, test_verification_coverage.cjs e as asserções de ordem em test_maintenance_contracts.py (~304, ~718-760).
- Rodar `npm run build:react`, a prova do Tailwind (CSS antes e depois) e apagar `frontend/src/legado`. Depois, baseline, verify, `npm run test:ui:e2e`, revisor e commit.
- Atualizar comentários e docs que citam `legado/`: paineis/** (~25), static/index.html, README, docs/arquitetura, docs/cockpit-prompts/14-cockpit-v2.md, docs/operacao.
- Em `pontes.ts` o comentário já cita `frontend/src/aplicacao/app.ts`, que só passa a existir na parte (b).

## Riscos
- Nem toda feature só repassa: 19 repassam, 12 têm lógica própria. backups-regionais tem ouvintes, `repetirPainel` e `setInterval` de 5 min, todos preservados.
- app-shell.ts (`createShell`) e cockpit-tool-panels.ts foram portados à mão e não passaram pelo navegador nem pelo E2E. Só os testes JS cobrem.
- ticket-rules: o app.ts do rascunho importa `createTicketRules` direto, e a publicação no window sai.
- A ordem de avaliação mudou: registro.ts agora roda antes de `ui/equipment-search-renderers.ts`. Isso é seguro hoje porque as fábricas só rodam no app.js, mas o E2E precisa confirmar.
- `require()` de `.ts` roda o topo do arquivo uma vez por processo. Por isso app.ts exporta `iniciar(win)` sem estado de módulo. Os harnesses precisam definir `globalThis.fetch` antes de carregar e passar o sandbox da VM.
- Antes de tirar o plugin UMD, confira `typeof module` nos arquivos UMD.
- Consumidores `window.X` nos ~137 `data-on-*` de index.html e partials: precisam continuar resolvendo.
- O `declare module "/static/vendor/..."` dá TS2307. A solução (`paths` + .d.ts) foi provada só no scratchpad.
