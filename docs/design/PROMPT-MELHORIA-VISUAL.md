# Prompt de melhoria visual do Simpress

Prompt para colar numa nova sessão. Troque `<Bn>` pelo bloco a executar e `<lista de arquivos do bloco>` pelos arquivos do fatiamento abaixo. Fonte: `docs/design/PLANO-MELHORIA-VISUAL.md`.

## Prompt

```
Contexto: app Simpress (FastAPI local + front estático em static/). Siga o AGENTS.md da raiz do projeto.
Objetivo: melhorar o visual (tokens/acessibilidade, estados, motion, organização dos blocos e textos) em ajustes pontuais e revisáveis, sem redesign.
Fonte da verdade: docs/design/AUDITORIA-VISUAL.md e docs/design/DESIGN.md.
Execute SOMENTE o bloco <Bn> do plano docs/design/PLANO-MELHORIA-VISUAL.md.

Regras: preservar IDs, ARIA, data-*, handlers, regras de negócio, temas claro/escuro, rótulos aprovados do AGENTS.md; usar tokens existentes (sem cor solta); animação 150–300 ms com prefers-reduced-motion; nada de stagger em tabelas nem pulso contínuo; tabelas viram cards em telas pequenas. Não mude texto sem aprovação explícita.

Entrada (envie só): <lista de arquivos do bloco>. NÃO envie: node_modules, .venv, caches, data/ (planilhas e estado), .transactions, static/vendor, static/app.css e static/index.html inteiros (use faixas de linha ou grep).

Processo: (1) explique objetivo/arquivos/verificação em português simples; (2) prints antes (desktop 1366×900 e mobile 390×844 × claro/escuro, fixture ui-fixture); (3) altere; (4) prints depois; (5) npm run verify e npm run test:ui:e2e; (6) alinhe e teste o assistente de IA se houver texto/ferramenta afetado; (7) atualize AGENTS.md e o .md da aba; (8) relate o que foi e não foi verificado. Pare e pergunte se faltar decisão.
```

## Fatiamento por bloco e o que nunca enviar

**Fatiar por bloco — arquivos a enviar em cada prompt:** B1: `static/styles/{ck-tokens,nocturne,ux-refinements,theme}.css` + trechos de `ck-cockpit.css` por grep; B2: `ck-cockpit.css` (trechos), `static/js/features/{cockpit-summary,equipment-search,dashboard}.js`, `static/js/ui/ui-motion.js`; B3: `static/styles/{ui-motion,ck-tokens}.css`, `static/js/ui/ui-motion.js`, `tests/frontend/test_ui_motion.cjs`; B4: faixas de `static/index.html` da aba + JS da aba; B5: lista de textos aprovada + `AGENTS.md` (seções de rótulos). **Nunca enviar:** `node_modules`, `.venv`, `data/`, `.transactions`, `.env`, `static/vendor`, planilhas `.xlsx`, `package-lock.json`.

## Decisões do usuário que valem para qualquer sessão

- B1: pode ajustar o valor de `--cor-texto-apagado` e `--cor-destaque-forte` (escuro) para chegar a 4,5:1 quando usados como texto, medindo antes e depois; sem cores novas; não mudar a cor do anel de foco.
- B4: somente espaçamento e prioridade visual em CSS; nada movido, recolhido nem vira menu.
- B5: só após aprovação do usuário, item a item, conferindo cada candidato contra os textos aprovados do `AGENTS.md`.
- B3: não unificar o reset de movimento reduzido em 1ms; o contrato do `ui.spec` exige no máximo 0.01ms (ver `docs/design/AUDITORIA-VISUAL.md`).
