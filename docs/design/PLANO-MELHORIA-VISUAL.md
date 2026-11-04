# Plano: melhoria visual do Simpress (tokens, blocos, textos, animações)

## Context

Pedido: usar o melhor de 5 repositórios (ui-ux-pro-max-skill, taste-skill, awesome-claude-design, design-md-chrome, design-motion-principles) para analisar todo o visual do Simpress e melhorar blocos, organização, textos e animações, e entregar um prompt melhorado + plano. **Tudo que for criado fica dentro de `C:\Users\Gabriel\Desktop\Empresa\Simpress`.**

O Simpress já tem um design Cockpit aprovado (`AGENTS.md`: layout idêntico ao artefato de referência, ajustes pontuais, IDs/ARIA/`data-*` e rótulos aprovados intocáveis). Por isso o plano é **cirúrgico e incremental**, não um redesign. Auditoria feita só por leitura de código (3 agentes); **nenhuma tela foi renderizada ainda**, então o primeiro passo é medir no navegador.

## O que aproveitar de cada repositório (e o que descartar)

| Repo | Aproveitar | Descartar |
|---|---|---|
| ui-ux-pro-max-skill | Checklist de pré-entrega; teste em 375/768/1024/1440; contraste 4.5:1; foco visível; tokens semânticos; valor completo quando truncado; `MASTER.md` + exceções por tela | Gerador de design system (o design já existe); instalar Python/CLI |
| taste-skill | Ciclo captura → autocrítica → 3 problemas → repetir (máx. 3 rodadas); checklist de enquadramento; dashboards: painéis discretos, números alinhados, cor só nos dados | Sorteio de "direções" e imagens de acervo (landing page, não app interno) |
| awesome-claude-design | Estrutura de 9 seções do `DESIGN.md`; referências de produto denso (IBM Carbon, Linear, Airtable, Sentry) só como inspiração | Copiar a identidade de qualquer marca |
| design-md-chrome | Formato do `DESIGN.md` (linha de base e Quality Gates como checklist de PR); extração feita manualmente do CSS | Carregar a extensão pelo agente (código de terceiros no Chrome real); tratar extração automática como verdade |
| design-motion-principles | Pergunta "deveria animar?"; análise de lacunas; filtro anti-excesso; lente primária Emil (restrição/velocidade), secundária Jakub (polimento) | Stagger em tabelas, pulsos contínuos, hover com scale em células, springs em ações utilitárias |

## Achados confirmados (leitura de código)

**Tokens/cores** (`static/styles/ck-tokens.css`, `nocturne.css`, `tokens.css`, `theme.css`)
- 4 vocabulários de token em paralelo (`--cor-*`, `--cockpit-*`, `--ux-*`/`--text-*`, `--color-*`); `nocturne.css` espelha `ck-tokens.css` → risco de divergência.
- Contraste: `--cor-texto-apagado` 2,51:1 (claro e escuro); `--cor-destaque-forte` escuro sobre `destaque-fundo` 2,98:1; `--text-faint` 4,24–4,34:1; borda/superfície 1,27–1,42:1.
- Hex soltos em `ux-refinements.css:192-194,369-413` e `theme.css:47-123`; fontes fora da escala `--fs-*` (22/16/18px literais no cockpit; `.78rem`…`1.5rem` e pesos 450/650/800 em `ux-refinements.css`).
- Alvos de toque 20–30px (`.ck-btn--mini` 24, `.ck-chip` 26, `.ck-segmentado__op` 24); `@media (pointer: coarse)` só na aba Sebrae (`ck-cockpit.css:1299-1305`).
- `.ck-busca__entrada` remove outline (`ck-cockpit.css:254`); conferir indicador em `:focus-within`.
- Sem escala de espaçamento no cockpit; z-index solto (toast cockpit 70 < popover 100 < toast legado 130).

**Estados/organização**
- `data-estado` (carregando/vazio/erro/pronto) só em OS e Comparação; Home, Resumo, Transporte não. Não há componente visual comum de erro com "tentar de novo". Skeleton só em 3 buscas + `#sebrae-novos-lista`.
- Home: 10 ações de copiar/editar no cabeçalho e grade; Transporte: 6 ações no banner antes dos passos; Assistente: 6 botões na mesma barra, aviso de anexos com 33 palavras; Histórico de apelidos: 2 pílulas desabilitadas sem dados; Automação: cartão SoftExpert concentra importar+buscar+agendar+status.

**Textos (candidatos; ver bloco B5, tudo "precisa de aprovação")**
- Caixa/termos: "Usuário AD"/"Nome Completo" vs "CNPJ faturamento"; cabeçalhos do Resumo em caixa alta no HTML e de frase no JS; "Fat."; "Observações · célula B37" (jargão); "Ambas"; "Ordens" vs "OS".
- Verbos de exportar: "Exportar", "Exportar Excel", "Exportar CSV", "Exportar planilha". OS: triagem "Atualizados <3 dias" vs filtro "3+ dias".
- Variações de fonte ("Endpoint Central"/"Endpoint"/"no endpoint"/"na Simpress") seguem regras do `AGENTS.md`: **não tocar sem aprovação**.

**Motion** (`static/js/ui/ui-motion.js`, `ui-motion.css`, `ck-tokens.css`)
- Base boa: `--duracao` 180 ms / `--duracao-lenta` 260 ms, `prefers-reduced-motion` em JS e CSS, toast/skeleton/modal/drawer animados.
- Lacunas: troca de painel/aba e abertura de `<details>` sem transição; durações literais (`.9s`, `1.2s`, `1.4s`, `900ms`, `150ms`) em `ck-cockpit.css:522,1042,1045,1082`; `automation-pulse` (infinite) e `ux-spin` só cobertos pelo reset global; 6 fade-ins duplicados e 3 spinners; reduced-motion duplicado com valores diferentes (1ms vs 0.01ms).

## Plano em blocos (execução em subagentes sucessivos, um por bloco, sempre um de cada vez, arquivos sobrepostos)

Cada bloco: ajuste pontual → antes/depois (skill `ajuste-visual-ui`: desktop 1366×900 e mobile 390×844 × claro/escuro, fixture `ui-fixture` porta 8765, prints em `.claude/prints/<assunto>/`) → `npm run verify` + `npm run test:ui:e2e`. Quando um bloco mudar texto, ferramenta ou comportamento, **alinhar e testar o assistente de IA de verdade** (regra permanente de 03/11/2026) e atualizar `AGENTS.md` + `.md` da aba em `docs/`.

- **B0 – Linha de base (somente leitura + docs).** Rodar o fixture, capturar as 10 abas × 4 combinações; extrair o estado atual **manualmente a partir do CSS** (todos os valores de token já foram levantados na auditoria) e gravar em `Simpress/docs/design/`: `DESIGN.md` (9 seções + Quality Gates), `AUDITORIA-VISUAL.md` (achados acima com prints), `PLANO-MELHORIA-VISUAL.md` (cópia deste plano) e `PROMPT-MELHORIA-VISUAL.md` (prompt abaixo) = 4 arquivos. Critério: nenhum arquivo de código alterado. A extensão design-md-chrome **não** é carregada pelo agente (código de terceiros no Chrome real); fica como passo opcional que o próprio usuário pode rodar para comparar.
- **B1 – Tokens e acessibilidade (só CSS).** (a) Corrigir contraste de `--cor-texto-apagado`/`--cor-destaque-forte` e uso como texto; ajustar valor do token (não cores novas); reforçar borda de campos/controles. (b) Trocar hex soltos de `ux-refinements.css`/`theme.css` por tokens; mapear tamanhos de fonte fora da escala para `--fs-*`. (c) `@media (pointer: coarse)` com alvo ≥ 44px nos controles globais, sem mudar desktop. (d) Conferir `:focus-within` da busca. Arquivos: `ck-tokens.css`, `nocturne.css`, `ux-refinements.css`, `theme.css`, `ck-cockpit.css`. Teste sensível: `tests/e2e/color-contrast.spec.cjs`, `ui.spec.cjs:505-515` (cores de foco `rgb(2,132,199)`/`rgb(145,132,217)`) → **não mudar a cor do anel de foco**, para o teste continuar protegendo. **DECISÃO DO USUÁRIO: pode ajustar o valor de `--cor-texto-apagado` e `--cor-destaque-forte` (escuro) para ≥ 4,5:1**, medindo antes/depois; sem cores novas.
- **B2 – Estados padrão.** Estender `data-estado` (aditivo) a Home, Resumo e Transporte; estado de erro comum com ação "Tentar de novo" onde já existe fluxo de recarga; reutilizar `.ui-skeleton` (`ui-motion.js:97-134`) em vez de criar novo. Arquivos: `ck-cockpit.css`, `static/js/features/cockpit-summary.js`, `equipment-search.js`, `dashboard.js`. Texto novo de erro/vazio → aprovação.
- **B3 – Motion (lente Emil: restrição).** Só onde hoje é seco: transição de troca de painel/aba e abertura de `<details>` (fade+4px, 150–200 ms, tokens `--duracao`); consolidar os 6 fade-ins em 1 keyframe; trocar durações literais por tokens; unificar o reset de movimento reduzido (um valor, um lugar); garantir `reduce` para `automation-pulse`/`ux-spin`. Proibido: stagger em tabelas, pulso contínuo novo, hover com scale. Arquivos: `ui-motion.css`, `ui-motion.js`, `ck-tokens.css`, `ck-cockpit.css`, `ux-refinements.css`. Teste: `ui.spec.cjs` (bloco `reduce`), `tests/frontend/test_ui_motion.cjs`.
- **B4 – Organização dos blocos. DECISÃO DO USUÁRIO: só espaçamento e prioridade visual (CSS); nada movido, recolhido nem vira menu. Os candidatos de composição abaixo ficam FORA do escopo até autorização explícita de redesign.** `AGENTS.md:173-175` exige layout idêntico ao artefato Cockpit aprovado (`claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC`); mudança de composição só em redesign autorizado, registrado com data. O artefato é um bundle comprimido (793 KB) e **não foi decodificado** nesta sessão, então não se sabe quais itens abaixo já batem com ele. Candidatos (cada um é mudança de composição, não só de espaçamento): Home: menu "Mais" para ações do cabeçalho, **excluindo** `Sem acesso`/`Divergente` em `#home-equipment-actions` (`AGENTS.md:44`: ficam fora da lista, alcançáveis por Tab/Enter/Espaço); modelos de chamado abaixo da grade. Transporte: ações do banner em grupo secundário. Automação: separar "Importar" e "Buscar" no cartão SoftExpert. Histórico de apelidos: esconder pílulas sem dados. Assistente: agrupar Voz/Instruções/Lembretes em menu. Comparação: separar "escolha" e "ações". Se o usuário só liberar espaçamento/prioridade visual: limitar a CSS (peso, espaço, agrupamento por borda), sem mover nem recolher nada. Preservar IDs, handlers, ordem de Tab.
- **B5 – Textos (só após aprovação do usuário, item a item).** Antes de apresentar a lista, **conferir cada candidato contra os parágrafos de texto aprovado** (`AGENTS.md:37-44, 91, 100, 108-111, 120`); o que bater vai para "só com pedido explícito". Candidatos ainda abertos (a conferir): padronizar caixa dos cabeçalhos do Resumo e da grade da Home; remover "· célula B37" e expandir "Fat."; renomear "Ambas"; encurtar aviso de anexos. Cada mudança propaga para UI, validação, testes e assistente. **Fora do escopo sem pedido explícito (texto aprovado):** rótulos de fonte (`No Endpoint`, `na Simpress`, `Endpoint`), `Planilha Exportada com Sucesso!`, `Chamados`/`OS`, `Exportar Excel` (`AGENTS.md:111`; logo, **não** uniformizar verbos "Exportar …"), `3+ dias` na OS (`AGENTS.md:100`; **não** unificar com "<3 dias"/"7 dias ou mais"), `Importar e gerenciar` e demais textos aprovados.
- **B6 – Verificação final.** `npm run verify`, `npm run test:ui:e2e`, revalidação nos 4 viewports (375/768/1024/1440 + 390×844), console limpo, foco por teclado, contraste medido, teste real do assistente no servidor local; relatório com o que foi e não foi verificado e quais `.md` mudaram.

## Prompt melhorado (para colar numa nova sessão; salvar em `Simpress/docs/design/PROMPT-MELHORIA-VISUAL.md`)

```
Contexto: app Simpress (FastAPI local + front estático em static/). Siga o AGENTS.md da raiz do projeto.
Objetivo: melhorar o visual (tokens/acessibilidade, estados, motion, organização dos blocos e textos) em ajustes pontuais e revisáveis, sem redesign.
Fonte da verdade: docs/design/AUDITORIA-VISUAL.md e docs/design/DESIGN.md.
Execute SOMENTE o bloco <Bn> do plano docs/design/PLANO-MELHORIA-VISUAL.md.

Regras: preservar IDs, ARIA, data-*, handlers, regras de negócio, temas claro/escuro, rótulos aprovados do AGENTS.md; usar tokens existentes (sem cor solta); animação 150–300 ms com prefers-reduced-motion; nada de stagger em tabelas nem pulso contínuo; tabelas viram cards em telas pequenas. Não mude texto sem aprovação explícita.

Entrada (envie só): <lista de arquivos do bloco>. NÃO envie: node_modules, .venv, caches, data/ (planilhas e estado), .transactions, static/vendor, static/app.css e static/index.html inteiros (use faixas de linha ou grep).

Processo: (1) explique objetivo/arquivos/verificação em português simples; (2) prints antes (desktop 1366×900 e mobile 390×844 × claro/escuro, fixture ui-fixture); (3) altere; (4) prints depois; (5) npm run verify e npm run test:ui:e2e; (6) alinhe e teste o assistente de IA se houver texto/ferramenta afetado; (7) atualize AGENTS.md e o .md da aba; (8) relate o que foi e não foi verificado. Pare e pergunte se faltar decisão.
```

**Fatiar por bloco — arquivos a enviar em cada prompt:** B1: `static/styles/{ck-tokens,nocturne,ux-refinements,theme}.css` + trechos de `ck-cockpit.css` por grep; B2: `ck-cockpit.css` (trechos), `static/js/features/{cockpit-summary,equipment-search,dashboard}.js`, `static/js/ui/ui-motion.js`; B3: `static/styles/{ui-motion,ck-tokens}.css`, `static/js/ui/ui-motion.js`, `tests/frontend/test_ui_motion.cjs`; B4: faixas de `static/index.html` da aba + JS da aba; B5: lista de textos aprovada + `AGENTS.md` (seções de rótulos). **Nunca enviar:** `node_modules`, `.venv`, `data/`, `.transactions`, `.env`, `static/vendor`, planilhas `.xlsx`, `package-lock.json`.

## Arquivos críticos / reaproveitar

- Tokens e motion existentes: `static/styles/ck-tokens.css` (`--duracao`, `--curva`, `--fs-*`, `--raio-*`), `static/js/ui/ui-motion.js` (`SimpressMotion`: `reveal`, `openOverlay`, `startLoading`), `.ui-skeleton` em `ui-motion.css`.
- Ferramental: `.claude/launch.json` (`ui-fixture`), `tests/support/serve_ui_motion_preview.py`, `playwright.config.cjs`, `scripts/verify.cjs`.
- Testes que quebram se mudar: `tests/frontend/test_dom_id_coverage.cjs`, `test_ui_motion.cjs`, `test_ux_enhancements.cjs`, `tests/e2e/{ui,color-contrast,theme-toggle,sebrae-dashboard}.spec.cjs`, `tests/test_frontend_assets.py` (CSP, sem estilo/script inline).
- Se o CSS do Tailwind mudar: `npm run build:ui`.

## Verificação (como testar de ponta a ponta)

1. `ui-fixture` (porta 8765): prints antes/depois nas 4 combinações por aba alterada.
2. `npm run verify` (não roda Playwright) e `npm run test:ui:e2e`.
3. Contraste medido de novo nos pares da tabela de achados (meta ≥ 4,5:1 texto; ≥ 3:1 controles).
4. Teclado: Tab/foco visível; atalhos F1–F9 intactos; movimento reduzido ativado → sem animação.
5. Assistente real no servidor local: pedir a mudança relevante e conferir a tela.

## Não verificado até aqui / riscos

- Nenhuma aba foi renderizada; `static/app.css` (68 KB) e as 36 ocorrências de altura pequena não foram lidas. Os contrastes vêm do cálculo sobre os hex dos tokens.
- Não confirmei se KPIs com sparkline do Resumo e chips da Automação (docs 03–06) foram implementados.
- Duas fontes de verdade de cor (`--cor-*` e `--cockpit-*`): editar uma só diverge.
- Mudar valor de token (B1), qualquer texto (B5) e qualquer mudança de composição (B4) exigem sua aprovação; criar os 4 arquivos de `docs/design/` é a única escrita do B0.
- O artefato Cockpit de referência é um bundle comprimido e não foi decodificado: a conformidade de B4 com ele não foi checada.
- design-md-chrome não é executado pelo agente (extensão de terceiros no seu Chrome real).
