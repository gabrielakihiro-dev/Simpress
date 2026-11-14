# Plano: limpeza dos textos explicativos (site inteiro)

Pedido do usuário (14/11/2026): tirar os textos explicativos que poluem todas as abas, sub-abas e modais, levando a explicação para um ícone ⓘ (passar o mouse ou focar) ou removendo o que for desnecessário. Plano aprovado automaticamente pelo usuário; cada bloco roda numa sessão nova, em sequência, e o último abre um único PR.

## Referência visual obrigatória (pedido do usuário, 14/11/2026: "imitar igualzinho o layout")

- **Base do layout:** artefato do Cockpit, https://claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC. Cores, espaçamentos, componentes e rótulos continuam idênticos a ele; nenhum bloco reinterpreta nem simplifica o design.
- **Posição do ⓘ e do texto que sai da tela:** artefato "Layout mais limpo", https://claude.ai/artifact/TU6r6mY3tvCm3gWZispTgP. O ⓘ fica logo após o título ou o rótulo, na mesma linha. Tamanhos, cores e bolha são os do componente existente (botão de 1.5rem, ícone de 0.95rem, em `ux-refinements.css`); as medidas desenhadas no artefato são ilustrativas e não pedem mudança de CSS.
- Cada sessão lê os dois artefatos antes de editar: o do Cockpit com Artifact `action: "read"` e `url`; o "Layout mais limpo" com Artifact `action: "read"`, a mesma `url` e `paths: ["project/Main.dc.html", "project/Resumo.dc.html", "project/Componente.dc.html"]`. Se a leitura devolver só um resumo, siga com ele e com este plano, sem parar. A sessão também compara as capturas "depois" com eles. Critério de aceite de todo bloco: **igual ao artefato**, provado por captura na fixture (1366px e 390px, claro e escuro). A única diferença permitida é a remoção do texto explicativo e o ⓘ no lugar dele.

## Regras de decisão

| Regra | Quando | O que fazer |
|---|---|---|
| A | Subtítulo ou descrição de painel, cartão ou seção | ⓘ ao lado do título; o texto vira o conteúdo do ícone |
| B | Dica de campo (abaixo de input, select ou textarea) | ⓘ ao lado do rótulo; manter o `id` e o `aria-describedby` que já apontam para a dica |
| C | Texto que repete o título, o botão ou o óbvio | Apagar |
| D | Estado vazio longo | Uma linha curta (ex.: "Nenhum lembrete.") |
| E | Status, progresso, erro, dado, contagem, texto aprovado, confirmação de envio real ou irreversível, aviso de privacidade no momento da ação | Fica visível, sem mudança |

### Ficam visíveis (regra E, não mexer)

- Nota do PowerShell `p.ck-ps-endpoint__aviso` (texto exato, testado em `tests/frontend/test_endpoint_powershell.cjs`).
- "Ausência na planilha não confirma resolução." e `#cockpit-tickets-evolution`.
- `tp__dica` do termo impresso (`static/js/features/termos.js`), `#comparacao-planilhas-fontes`, `.ckp-arquivo__meta`.
- "Salva automaticamente. Até N caracteres." (`sebrae-dashboard.js`), dica `kbd` "Enter salva · Esc cancela" (`lembretes.js`).
- "Finalizar não tem volta…", aviso OpenRouter `#assistente-anexos-aviso`, `#cliente-config-modelo-ausente`.
- Avisos condicionais e regiões de status (`role="status"`, `aria-live`, `#sebrae-atualizar-status`), contagens (`cockpit-tool-panels.js` linha da contagem do relatório), avisos de clone e de lista ausente em `comparison-result-renderer.js`.
- Textos aprovados exatos: `Planilha Exportada com Sucesso!`, `No Endpoint`, `na Simpress`.

## Componente ⓘ (já existe, reutilizar)

- Markup: `<span class="info-tip"><button type="button" class="info-tip-trigger" aria-label="Sobre X" aria-describedby="tip-x"><svg class="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info"></use></svg></button><span id="tip-x" role="tooltip" class="info-tip-text">…</span></span>`.
- CSS: `static/styles/ux-refinements.css` (`.info-tip`, variante `info-tip--end`, bolha fixa até 640px, 160 ms com movimento reduzido). Não criar outro componente.
- Esc fecha (`dismissInfoTips` em `static/js/ui/ux-enhancements.js`), por delegação no `document`; ícones injetados por JS já funcionam.
- Testes: texto movido para ⓘ deixa de passar em `toBeVisible`, `innerText` e `getByText().click`; use `textContent`, `toHaveText` ou leitura do HTML. Ajuste o teste, nunca o comportamento.

## Regras para todas as sessões

- Preservar IDs, ARIA, `data-*`, manipuladores, temas claro e escuro; cockpit de 320px a 2560px sem rolagem horizontal; não remover `!important` mecanicamente.
- Conteúdo que está num partial (`frontend/partials/*.html`) se edita no partial; o que não está (Home, Assistente, autocompletar) se edita em `static/index.html`, sem tocar nos marcadores `<!-- include: ... -->`.
- Nada de `.md` nem dado pessoal em `static/**`. Nenhuma escrita em sistema externo.
- Playwright só na fixture (porta 8765). Capturas em `.claude/prints/limpeza-textos/` (ignorado pelo Git).
- Cada bloco termina com `npm run verify` verde; teto de 3 ciclos de correção sobre a mesma falha.
- Commit local na branch do bloco, com `ponytail:ponytail-review` antes; push e PR só no Bloco 4.
- Se um bloco esgotar os 3 ciclos ou ficar bloqueado: não espere resposta (o usuário está dormindo). Commite o que estiver verde, faça push da branch do bloco, abra um PR em rascunho (draft) para `main` dizendo o que falta e qual falha ficou, faça `bind_pr` e relate. A cadeia de blocos para aí.

## Bloco 1: helper, cabeçalho das ferramentas e Chamados (F5/F6)

- **Objetivo:** criar o helper do ⓘ, levar o subtítulo de cada ferramenta para um ⓘ ao lado do título e limpar o painel de chamados.
- **Arquivos:** `static/js/shared/dom-utils.js`, `frontend/partials/cockpit-tool-panels.html` (cabeçalho e painel `chamados`), `static/js/features/cockpit-tool-panels.js` (mapa `toolInfo` e `openPanel`), testes afetados, `docs/cockpit-prompts/14-cockpit-v2.md` (convenção do ⓘ) e `docs/cockpit-prompts/07-chamados-operacional.md`.
- **Passos:**
  1. Antes de mudar: capturas "antes" de todos os painéis na fixture, 1366px e 390px, claro e escuro, em `.claude/prints/limpeza-textos/antes/`.
  2. Contrato do helper em `dom-utils.js`: `infoTipHtml(rotulo, texto, { fim } = {})` devolve o markup acima como string, com `id` único (`tip-auto-<n>`), `rotulo` e `texto` escapados por `escapeHtml`, e a classe `info-tip--end` quando `fim` for verdadeiro. Exportar junto dos outros helpers e cobrir com um teste unitário (escape e id único).
  3. `#cockpit-tool-subtitle` vira o `span.info-tip-text` de um ⓘ ao lado de `#cockpit-tool-title` (mesmo `id`, `role="tooltip"`, sem `aria-live`, porque o título já recebe foco). O `textContent` continua vindo de `toolInfo`.
  4. Painel chamados: `#cockpit-tickets-kpis-nota` e `#cockpit-tickets-version-hint` viram ⓘ (regras A e B), mantendo os `id` e o `aria-describedby` do select.
- **Critérios de aceite:** layout igual aos dois artefatos da referência visual (captura); nenhum desses textos visível sem passar o mouse; ⓘ abre por mouse, foco e toque e fecha com Esc; ids e `aria-describedby` intactos; `npm run verify` verde; `npm run test:ui:e2e` verde nos specs do cockpit.
- **Verificar:** `npm run verify`; `npx playwright test` dos specs afetados; captura do painel na fixture (claro e escuro, 390px).
- **Proibidos:** outros painéis, `static/index.html`, CSS do `.info-tip` (só ajuste se faltar algo, sem mudar o visual).

## Bloco 2: Resumo (F3), Comparação e Relatório mensal

- **Objetivo:** tirar as descrições dos cartões do Resumo e as notas do relatório.
- **Arquivos:** `static/js/ui/comparison-result-renderer.js`, `static/js/features/cockpit-tool-panels.js` (trechos do relatório), `static/js/features/backups-regionais.js`, testes afetados, `docs/cockpit-prompts/05-resumo-kpis.md`, `08-comparacao-operacional.md`, `10-relatorio-mensal.md`.
- **Passos:**
  1. Descrições `p.text-xs.text-fg-muted` dos cartões do renderer viram ⓘ ao lado do título do cartão, via `infoTipHtml` (regra A). Segundos parágrafos com instrução nos cartões de anotação entram no mesmo ⓘ.
  2. Apagar `p.comparison-table-scroll-hint` (regra C) e ajustar `tests/frontend/test_inventory_transfer_copy.cjs`.
  3. Notas `p.ck-rel__nota` do relatório (cortes, "Criados até o corte e ainda sem conclusão ou entrega.") viram ⓘ; a contagem e o estado vazio do relatório ficam.
  4. Em `backups-regionais.js` (linha `meta`), "Atualizado em …" continua visível (dado); só a parte "Mínimo: N backup(s) por regional prioritária." vai para um ⓘ ao lado do título de backups.
- **Critérios de aceite:** layout igual aos dois artefatos da referência visual (captura); cartões do Resumo sem parágrafo descritivo visível; avisos de clone, status, lista ausente e `warn` continuam visíveis; specs `monthly-report.spec.cjs` e de backups verdes.
- **Verificar:** `npm run verify`; specs e2e do Resumo e do relatório; captura na fixture.
- **Proibidos:** textos da regra E, painéis de outros blocos.

## Bloco 3: ferramentas (Lembretes, Termos, Planilhas, Apelidos, Unidades, Sebrae, Cobertura)

- **Objetivo:** limpar as ferramentas restantes do cockpit.
- **Arquivos:** `frontend/partials/cockpit-tool-panels.html`, `frontend/partials/sebrae-conflitos.html`, `static/js/features/lembretes.js`, `termos.js`, `sebrae-dashboard.js`, `coverage.js` (só se houver texto explicativo), testes afetados, `docs/cockpit-prompts/16-cobertura.md`, `17-termos.md`, `18-lembretes.md`, `docs/operacao/sincronizar-chamados-sebrae.md`.
- **Passos:**
  1. Lembretes: `#lembretes-vazio` vira "Nenhum lembrete." (regra D); `#lembretes-criar-dica` vira ⓘ. Ajustar `tests/e2e/lembretes.spec.cjs` e `tests/frontend/test_lembretes.cjs`.
  2. Termos: `p.termos__dica` e `p.termos__aviso` ("Na janela que abrir, escolha Salvar como PDF e a pasta.") viram ⓘ; `#termos-entrega-obs-dica` vira ⓘ do rótulo, mantendo o `id` e o `aria-describedby`. O `tp__dica` impresso fica.
  3. Planilhas: os 3 passos de "Ao atualizar" (`ol.ck-tempo`) viram o texto de um ⓘ ao lado de `h2` "Ao atualizar"; `#cockpit-sheets-detail-sub` fica.
  4. Apelidos e Unidades: `#cockpit-alias-detail` e `#cockpit-units-detail-sub` com texto de instrução viram linha curta ou ⓘ.
  5. Sebrae: `p.ck-campo__ajuda` de `sebrae-conflitos.html` vira ⓘ; estados vazios longos de `sebrae-dashboard.js` encurtados. "Salva automaticamente…" fica.
- **Critérios de aceite:** layout igual aos dois artefatos da referência visual (captura); nenhum desses textos visível sem ⓘ; ids e ARIA intactos; specs de lembretes, termos e Sebrae verdes.
- **Verificar:** `npm run verify`; specs e2e afetados; captura na fixture.
- **Proibidos:** textos da regra E, Home, modais, Automação.

## Bloco 4: Home, Transporte, Automação, modais, revisão e PR

- **Objetivo:** limpar o que resta, revisar o conjunto e abrir o PR único.
- **Arquivos:** `static/index.html` (Home e Assistente, fora dos partials), `frontend/partials/modais.html`, `frontend/partials/card-equipamento.html`, `static/js/features/full-equipment-search.js`, testes afetados, `docs/cockpit-prompts/03-home-split-view.md`, `06-automacao-console.md`.
- **Passos:**
  1. Home: `#home-detail-empty` em uma linha; `span.ck-ac__dica` vira ⓘ ou some (regra C); metadados que forem explicação viram ⓘ.
  2. Modais: `#email-ajuda-marcadores` e `#email-ajuda-autosave` viram ⓘ (mantendo `aria-describedby`); `#upload-impacto-aviso`, `label.ckp-nota`, `ul.ckp-fatos`, `#contato-origem-ambiente`, `#cliente-config-ambiente`, `#cliente-config-series-ajuda`, parágrafo do representante viram ⓘ ou somem. `#cliente-config-modelo-ausente` fica.
  3. `#powershell-codigos-titulo` encurtado ou com ⓘ; a nota do PowerShell fica exata.
  4. `full-equipment-search.js`: estado vazio vira "Nenhum equipamento a listar."
  5. Varredura final: abrir cada aba, sub-aba e modal na fixture e confirmar que não sobrou texto explicativo visível fora da regra E.
  6. Capturas "depois" (mesmas telas e larguras do Bloco 1) em `.claude/prints/limpeza-textos/depois/`.
  7. `npm run verify` e `npm run test:ui:e2e` completos; revisão do diff inteiro (`main...HEAD`) pelo `model-super-power:revisor`; `ponytail:ponytail-review`.
  8. Push da branch do Bloco 4 e PR único para `main`; `bind_pr` e `set_monitor` com `auto_fix: true`; ler a CI e informar.
- **Critérios de aceite:** layout igual aos dois artefatos da referência visual (captura); todos os blocos no PR; suítes verdes; cada critério relatado como `AC: <critério> — PROVEN BY <evidência>`.
- **Verificar:** saída dos dois comandos de teste; link do PR; estado da CI.
- **Proibidos:** merge, auto-merge, force push.
