# Regras da interface (`frontend/` e `static/`)

Valem junto com o `AGENTS.md` da raiz ao editar `frontend/` ou `static/`. Não há `AGENTS.md` em `static/`, porque ela é servida publicamente.

- Nova tela: atualize a especificação antes e siga as referências visuais; preserve IDs, ARIA, `data-*`, manipuladores, regras de negócio, temas claro e escuro.
- React em migração (`docs/planos/migracao-react-vite.md`): a fonte é `frontend/src/` (TypeScript estrito; API só por `frontend/src/api.ts`); não ler nem editar `static/dist/`, gerado por `npm run build:react` e commitado.
- `static/index.html` é montado de `frontend/partials/` (`<!-- include: partials/<nome>.html -->`): edite o painel no partial e leia o HTML montado nos testes (`docs/cockpit-prompts/14-cockpit-v2.md`, "index.html dividido em partials").
- Cockpit de 320px a 2560px, sem rolagem horizontal e sem `min-width:1200px`; idêntico ao artefato https://claude.ai/artifact/1MBeThmaD94YS5L4fCV3vp (canvas "Simpress Bento", 14/11/2026; abaixo de 1200px muda só a disposição).
- Movimento: toda tela nova e todo ajuste seguem `docs/ui-motion/contrato-bento.md`, que prevalece sobre os 150–300 ms antigos; `prefers-reduced-motion` zera tudo e o Assistente fica fora.
- Não remova `!important` mecanicamente; corrija a causa e preserve os usos justificados. Atalhos F1 a F10: `shortcutAction` e `toolKeys`, com `<kbd>`, `title`, `aria-keyshortcuts` e testes alinhados.
- Playwright MCP (`.mcp.json`): só a fixture na porta 8765, nunca o app real, pelo fluxo da skill `playwright-teste`; capturas: skill `ajuste-visual-ui`.

## Índice

Em `docs/cockpit-prompts/`: Cockpit `14-cockpit-v2.md` e `14-responsividade-todas-resolucoes.md`; Home `03-home-split-view.md`, Comparação `08-comparacao-operacional.md`, Relatório `10-relatorio-mensal.md`, Termos `17-termos.md`, Lembretes `18-lembretes.md`, Assistente `15-assistente.md`.
