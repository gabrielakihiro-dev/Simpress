# Regras de `tests/`

Testes do Python, do front-end (`tests/frontend`) e e2e (`tests/e2e`). Valem junto com o `AGENTS.md` da raiz; o texto integral está em `docs/desenvolvimento/regras-agentes.md`, sob "Regras movidas do AGENTS.md (10/11/2026)".

- `npm run verify` (ou `node scripts/verify.cjs`) roda as checagens do CI: testes Python, `node --test`, `node --check`, `compileall`, `mypy` gradual e busca de credenciais. Doc: `docs/desenvolvimento/regras-agentes.md`.
- Mudança de interface também roda `npm run test:ui:e2e` (Playwright). Doc: o mesmo.
- Testes de privacidade não podem ser enfraquecidos: `tests/test_maintenance_contracts.py` e `tests/frontend/test_transporte_ux_ticket.cjs` proíbem `@simpress.com.br` e outros dados pessoais no HTML e no JS. Doc: `docs/operacao/automacao-chrome.md`, seção do ticket UX.
- Assistente: teste com cliente falso (`tests/test_assistant*.py`) e, além dele, peça a mudança ao assistente real no servidor local e confira na tela. Doc: `docs/cockpit-prompts/15-assistente.md`.
- Termo aprovado que muda se propaga para os testes junto com interface e validação. Doc: `docs/desenvolvimento/regras-agentes.md`.
- Dados reais ou operacionais (`data/state`, planilhas) nunca entram em fixtures versionadas; use dados sintéticos. Doc: `docs/operacao/regras-cadastro-historico.md`.
- Cada critério de aceite dado como pronto traz `AC: <critério> — PROVEN BY <evidência>`; no máximo 3 ciclos de correção sobre a mesma falha. Doc: `docs/desenvolvimento/regras-agentes.md`.
