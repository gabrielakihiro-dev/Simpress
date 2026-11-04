# DESIGN.md: estado visual atual do Simpress

Linha de base do visual, extraída à mão a partir do CSS em `static/styles/` (B0 do plano em `docs/design/PLANO-MELHORIA-VISUAL.md`). Nenhuma extensão de navegador foi usada e nenhuma tela foi renderizada para escrever este arquivo: todo valor abaixo vem da leitura do código. Os contrastes são calculados a partir dos hex (fórmula WCAG 2.x), não medidos no navegador.

Arquivos lidos: `ck-tokens.css`, `nocturne.css`, `tokens.css`, `theme.css`, `ck-cockpit.css` (trechos e greps; tem 1918 linhas), `ui-motion.css`, `ux-refinements.css`. `app.css` (fora de `static/styles/`) e `ck-pendencias.css` só por grep.

Regra de ouro herdada do `AGENTS.md`: o design Cockpit é aprovado. Layout idêntico ao artefato de referência, ajustes pontuais, IDs, ARIA, `data-*` e rótulos aprovados intocáveis, CSP sem estilo nem script inline, Cockpit adapta de 320 a 2560 px sem rolagem horizontal. Este documento descreve; não autoriza redesign.

## 1. Visão geral e tema

- App local (FastAPI + front estático). Interface densa de operação: cabeçalho com abas F1–F10, telas por aba, painéis de detalhe, modais e um assistente flutuante.
- Duas aparências, escolhidas por `html[data-theme="light" | "dark"]`.
- Os temas não são simétricos entre arquivos:
  - `ck-tokens.css`: `:root` é o tema claro; `[data-theme="dark"]` redefine para o escuro.
  - `tokens.css`: `:root` é o tema escuro (padrão); `html[data-theme="light"]` redefine para o claro.
  - `nocturne.css`: `:root` é escuro; `html[data-theme="light"]` é claro.
  - `theme.css`: só tem o remapeamento do tema claro (Tailwind e cores soltas).
- Fontes: Inter Variable (texto) e JetBrains Mono Variable (valores); em `nocturne.css` o `@font-face` do Inter aponta para arquivos locais em `/static/vendor/fonts/`.
- Quatro vocabulários de token convivem (ver seção 2). O cockpit consome de fato o `--cor-*`.

## 2. Paleta e tokens por vocabulário

### 2.1 `--cor-*` (`ck-tokens.css`): o vocabulário realmente usado no cockpit

| Token | Claro | Escuro |
|---|---|---|
| `--cor-fundo` | #f2f3f8 | #161826 |
| `--cor-superficie` | #ffffff | #1d2031 |
| `--cor-superficie-elevada` | #ffffff | #23263a |
| `--cor-superficie-funda` | #f7f7fb | #161826 |
| `--cor-campo` | #f9f9fc | #23263a |
| `--cor-texto` | #23232f | #e9e9ed |
| `--cor-texto-forte` | #454756 | #dcdde4 |
| `--cor-texto-suave` | #575a69 | #c3c5d0 |
| `--cor-texto-mudo` | #656777 | #9a9dad |
| `--cor-texto-sutil` | #656777 | #969bad |
| `--cor-texto-apagado` | #a1a3b0 | #5a5e70 |
| `--cor-borda` | #d7d8e2 | #2f3244 |
| `--cor-borda-suave` | #e6e6ed | #23263a |
| `--cor-destaque` | #705dc6 | #9184d9 |
| `--cor-destaque-forte` | #5947a9 | #7568c1 |
| `--cor-destaque-fundo` | #edeafb | #2a2550 |
| `--cor-destaque-texto` | #34276f | #e8e5fb |
| ok (texto / fundo) | #087650 / #e5f5ee | #60d7a5 / #193d34 |
| alerta (texto / fundo) | #8a5a08 / #fff3d7 | #f1bd55 / #49351a |
| erro (texto / fundo) | #a52d37 / #fbe8e9 | #ff797c / #4b262d |
| neutro (texto / fundo) | #575a69 / #ececf2 | #b7bac8 / #30313c |
| `--cor-veu` | rgb(24 24 38 / 32%) | rgb(0 0 0 / 48%) |
| `--sombra-sm` | 0 1px 2px rgb(24 24 38 / 8%) | sombra com rgb(0 0 0 / 28%) |
| `--sombra-lg` | 0 16px 40px rgb(24 24 38 / 16%) | sombra com rgb(0 0 0 / 48%) |

Contrastes calculados dos hex (texto = meta 4,5:1; componente não textual = meta 3:1):

| Par | Razão |
|---|---|
| `texto` sobre `superficie` (claro) | 15,52:1 |
| `texto-mudo` sobre `fundo` (claro) | 5,04:1 |
| `texto-mudo` sobre `superficie` (escuro) | 5,99:1 |
| `destaque` sobre `superficie` (claro / escuro) | 5,16:1 / 4,99:1 |
| `destaque-texto` sobre `destaque-fundo` (claro / escuro) | 10,66:1 / 11,52:1 |
| ok / alerta / erro, texto sobre fundo (claro) | 5,01 / 5,37 / 5,88:1 |
| ok / alerta / erro, texto sobre fundo (escuro) | 6,69 / 6,72 / 5,13:1 |
| `texto-apagado` sobre `superficie` (claro / escuro) | 2,51:1 / 2,51:1 |
| `texto-apagado` sobre `fundo` (claro / escuro) | 2,26:1 / 2,74:1 |
| `destaque-forte` sobre `destaque-fundo` (escuro) | 3,05:1 (era 2,98:1 com #7466c0; ajustado no B1) |
| `destaque-forte` sobre `destaque-fundo` (claro) | 6,13:1 |
| `borda` sobre `superficie` (claro / escuro) | 1,42:1 / 1,27:1 |
| `borda-suave` sobre `superficie` (claro / escuro) | 1,24:1 / 1,08:1 |

### 2.2 `--cockpit-*` (`nocturne.css`)

- Define superfícies, bordas, acento, status (em `oklch` no escuro), raios 4/8/14, `--cockpit-control-height: 30px` e sombras.
- Nenhum arquivo em `static/` consome `var(--cockpit-*)` (grep em CSS, JS e HTML). O vocabulário está definido e dormente.
- Tema claro: valores idênticos ao `--cor-*`. Tema escuro: valores diferentes (por exemplo `--cockpit-surface` #232532 contra `--cor-superficie` #1d2031; `--cockpit-accent-strong` #5d5294 contra `--cor-destaque-forte` #7568c1).

### 2.3 `--ux-*`, `--text-*`, `--surface*` (`tokens.css`, 625 linhas)

- Paleta escura em `:root` (por exemplo `--ux-surface-0` #020617, `-1` #0f172a, `-2` #1e293b, `--ux-text` #f1f5f9, `--ux-text-muted` #a9b7c8, `--ux-accent` #38bdf8) e redefinição para o claro em `html[data-theme="light"]` (linhas ~569–614).
- Semânticos: `--surface*`, `--text*`, `--primary` #026fc7 (claro: #0358a1 no hover), `--focus-color` #7dd3fc.
- `--text-faint` #64748b é igual nos dois temas (comentário na linha 121): 4,24:1 sobre #020617, 3,75:1 sobre #0f172a, 4,34:1 sobre #f1f5f9, 4,76:1 sobre #ffffff. `--text-subtle` #94a3b8. Uso real de `--text-faint`: só `app.css:463` (separador) e `app.css:929` (descrição pequena).
- Dezenas de tokens por componente (sidebar, menu, busca, modelos, prontidão etc.).

### 2.4 `--color-*` (`theme.css`, `@theme` do Tailwind)

- No tema claro, `html[data-theme="light"]` remapeia `--color-brand-*`, `amber`, `yellow`, `emerald`, `cyan`, `sky`, `blue`, `indigo`, `violet`, `purple`, `rose` (linhas 7–44) para tons escuros legíveis sobre fundo claro.
- Hex soltos fora de token: body #f1f5f9 / #0f172a (47–48); seleção #bfdbfe / #1e3a8a (52–53); `.text-white` vira #0f172a (57); toasts #d1fae5, #ffe4e6, #fef3c7, #dbeafe (80–83); botão de tema (98–123).
- Foco claro: `--focus-color` #0284c7 (4,10:1 sobre branco), `--focus-shadow-color` #fff. Esses valores são protegidos por `tests/e2e/ui.spec.cjs:505-515` (`rgb(2,132,199)` no claro e `rgb(145,132,217)` no escuro).

### 2.5 Hex soltos em `ux-refinements.css`

Resolvidos no B1 com tokens de mesmo valor: linhas 192–194 (agora `--color-emerald-200`, `--color-emerald-300` e `--text-body`, só no tema claro), 369 e 378 (fallback `#334155` removido; `--ux-border` existe nos dois temas) e 413 (`--scrollbar-thumb-hover`). Continuam literais de propósito: 384 (`#0f172a`/`#fff` em `option`, vale nos dois temas e nenhum token tem o mesmo valor nos dois) e 425 (`rgba(250, 204, 21, 0.12)`, sem token equivalente). `ck-cockpit.css` não tem hex solto. Em `theme.css`, os valores do tema claro (fundo e texto do `body`, `.text-white`, botão de tema) usam `--surface`, `--text-strong`, `--text-body`, `--border-control`, `--border-firm`, `--surface-control` e `--surface-raised`; ficam literais a seleção de texto, o `#fff` dos botões coloridos e as cores dos toasts, que não têm token idêntico.

## 3. Tipografia

Escala `--fs-*` (px, `ck-tokens.css`): `2xs` 10, `xs` 11, `sm` 11.5, `ui` 12, `md` 12.5, `base` 13, `lg` 15, `xl` 16, `2xl` 18, `kpi` 22. Pesos: 400, 500, 600. Famílias: Inter Variable, JetBrains Mono Variable (`.ck-mono`).

Fora da escala (confirmado):

- `ck-cockpit.css`: 16px em 710 (campos no mobile, evita zoom do iOS; continua literal). No B1, 898, 731, 903 e 964 passaram a `--fs-xl`, `--fs-2xl` e `--fs-kpi` (mesmos 16, 18 e 22 px).
- `ux-refinements.css` (mantidos em rem de propósito: trocar por tokens em px faria o texto deixar de acompanhar a fonte do navegador): `.75rem`, `.78rem`, `.8rem`, `.82rem`, `.85rem`, `.95rem`, `1.05rem`, `1.5rem`; pesos 450 (654), 650 (22), 800 (113, 396).

## 4. Espaçamento, raios, alturas e camadas

- Cockpit não tem escala de espaçamento: usa px literais. `tokens.css` tem `--ux-space-1..6` = 0,25 / 0,5 / 0,75 / 1 / 1,5 / 2 rem, usados pelo código legado.
- Raios: `--raio-sm` 5, `--raio-md` 8, `--raio-lg` 11 px (cockpit); `--ux-radius-sm 0.375rem`, `md 0.6rem`, `lg 0.875rem`, `xl 1.125rem`, `pill 999px` (legado).
- Alturas: `--altura-barra` 48, `--altura-aba` 32, `--altura-controle` 30, `--altura-controle-sm` 26, `--altura-pilula` 24.
- Larguras: lista da Home 360, prévia 380, console 560, detalhe 400, menu 300, sino 360, busca 340, sugestões 560.
- z-index (escalas separadas): cockpit usa 3, 5, 30 (topbar), 40 (menu, sino, assistente de prontidão), 45 (autocompletar), 50 (widget do assistente), 60 (véu, assistente maximizado), 70 (toast). Legado em `tokens.css`: quick-actions 30, header 60, sidebar 70, drawer 74/75, dropdown 80, popover 100, overlay 120, toast 130. `.modal-overlay.ck-veu` usa `var(--z-overlay, 60)`, que resolve para 120.

## 5. Componentes (como estão hoje)

- Botão `.ck-btn`: altura 30, `--sm` 26, `--icone` 30 de largura, `--mini` 24×24. Variantes `--primario`, `--secundario`, `--fantasma`, `--perigo`; estado ativo usa `--cor-destaque-forte` na borda.
- Campo `.ck-entrada`, `.ck-campo` (rótulo + controle), busca `.ck-busca__campo` com indicador de foco no próprio wrapper (`:focus-within`, ver auditoria).
- Chip `.ck-chip` (26), tag `.ck-tag` (22), selo `.ck-badge` (20), pílula `.ck-pilula` (24), segmentado `.ck-segmentado__op` (24).
- Cartão `.ck-cartao`, rotina `.ck-rotina` com `data-estado`, diálogo `.ck-dialogo` dentro de `.ck-veu`, toast `.ck-toast`.
- Tabela que vira cards abaixo de 1200 px; lista/detalhe dividido (`.ck-dividido`).
- Assistente flutuante `.ck-assist-widget` (50; maximizado 60), painel `.ck-assist__*`.
- Skeleton: `.ui-skeleton` (`ui-motion.css`), criado por `SimpressMotion.startLoading` (`static/js/ui/ui-motion.js`); usado em buscas (`equipment-search.js`, `full-equipment-search.js`, `comparison-history.js`) e na lista de chamados novos.
- Estados com `data-estado`: OS e Comparação (`vazio`, `carregando`, `erro`, `pronto`, em `data-panels.js` e `cockpit-tool-panels.js`), seletor de arquivo (`vazio`/`selecionado`), rotinas da Automação (`ocioso`/`em-andamento`) e vários blocos do painel Chamados (`ok`, `alerta`, `erro`, `andamento`, `salvando`). Desde o B2 (04/11/2026), Home (`#home-equipment-list`: `carregando`, `pronto`, `vazio`, `erro`), Resumo (`#resumo-cards`: `carregando`, `pronto`, `erro`) e Transporte (`#transfer-equipment-banner` e `#cockpit-transport-preview-state`: `vazio`/`pronto`) também expõem `data-estado`, ao lado do `data-state` em inglês que já existia (não removido). Home e Resumo reaproveitam o skeleton de `startLoading`.

## 6. Layout e responsividade

- Faixas do Cockpit: compacto até 767,98 px, médio de 768 a 1199,98 px, amplo a partir de 1200 px.
- Em telas amplas as telas travam a altura (`.ck-home`, `.ck-auto`, `.ck-ferramenta` com `height: 100%` e rolagem interna). Abaixo de 1200 px a rolagem volta para a página e as tabelas viram cards.
- Alvos de toque: `@media (pointer: coarse)` com 44 px existe em `ck-cockpit.css` (aba Sebrae e, desde o B1, `.ck-btn--mini` 44×44, `.ck-segmentado__op`, `details.ck-chip`, `.ck-chip--botao` e `.ck-chip__gatilho`) e em `ux-refinements.css:150,188` (dois chips). No desktop (ponteiro fino) as medidas continuam 24, 26 e 24 px. Os chips só de estado (sem ação) e os demais controles ficam entre 20 e 30 px. Em toque, a faixa do topo cresce 18 px porque o chip de prontidão passa de 26 para 44 px.
- `@media (hover: none)` em `ck-cockpit.css:1643`.

## 7. Motion

| Token | Valor | Onde |
|---|---|---|
| `--duracao` | 180ms | `ck-tokens.css` |
| `--duracao-lenta` | 260ms | `ck-tokens.css` |
| `--curva` | cubic-bezier(.2,.7,.2,1) | `ck-tokens.css` |
| `--motion-fast` | 160ms | `tokens.css` |
| `--motion-normal` | 220ms | `tokens.css` |
| `--motion-ease` | cubic-bezier(0.22,1,0.36,1) | `tokens.css` |

- Keyframes: `ck-surgir` (fade + 4px; entrada padrão de menus, popovers, toasts, véus, painéis de ferramenta e blocos recolhíveis), `ck-girar`, `ui-shimmer`, `panel-card-enter` (6px), `sebrae-historico-entrada` (só opacidade), `ck-assist-entrada` (+4px, sobe), `ck-assist-abrir` (scale), `equipment-user-in` (-2px, 200ms, em `app.css`), `ux-pop`, `ux-nudge`, `ux-spin`, `automation-pulse`, `sebrae-varredura`, `sebrae-brilho`. Desde o B3, `ui-menu-enter` e `sebrae-descricao-entrar` (idênticos a `ck-surgir`) foram removidos e usam `ck-surgir`; os demais fade-ins diferem em distância, direção ou propriedade e ficam como estão.
- Entradas (B3, `ck-cockpit.css`, bloco depois de `.ck-ferr-painel`): `.ck-ferr-painel:not([hidden])` (painéis F5 a F9), `.ck-chamado__painel:not([hidden])` (abas de modelo de chamado da Home) e o conteúdo de `.ckp-recolher[open]` e `details.ck-det-bloco[open]` animam com `ck-surgir var(--duracao) var(--curva)` (180 ms), só dentro de `@media (prefers-reduced-motion: no-preference)`. Só a entrada anima (sem saída). As abas principais F1 a F4 já usam `SimpressMotion.reveal(..., "page")` (220 ms, 8px); os `<details>` do Sebrae usam `::details-content`; ficam sem entrada por decisão: `details[data-user-change-details]` (nasce aberto e seria animado a cada renderização da comparação), `.ticket-disclosure` (dentro de célula de tabela) e as linhas de qualquer tabela.
- Durações literais fora de token: `ck-cockpit.css` 522 (900ms), 862 (150ms), 1042 e 1227 e 1252 (.8s), 1045 e 1058 (1.2s), 1082 (1.4s), 1769 (900ms); `ux-refinements.css` 259 (800ms), 479 (1.4s), 540 (150ms), 550 (200ms).
- Movimento reduzido, três mecanismos com valores diferentes: `ck-tokens.css:155-157` (1ms), `ck-cockpit.css:673-675` (0.01ms, com comentário de que o contrato do `ui.spec` exige 0.01ms ou menos), `tokens.css:617-625` (variáveis `--motion-*` em 0.01ms). Há também guards locais (`ck-cockpit.css` 995, 1267–1270, 1913; `ux-refinements.css` 270, 597–598; `ui-motion.css` 68–69).
- `<details>` do Sebrae já animam a altura (`ck-cockpit.css`, `::details-content`, bloco `@supports (interpolate-size…)`).
- Durações literais que ficam (B3, deliberadas, nenhuma equivale a `--duracao` 180 ms ou `--duracao-lenta` 260 ms sem mudar o efeito): períodos de giro e varredura contínuos (`ck-girar` 900 ms e .8 s, `ux-spin` 800 ms, `sebrae-varredura` 1.2 s, `sebrae-brilho` 1.4 s, `automation-pulse` 1.4 s, `ui-shimmer` 1500 ms), que são ritmo de laço e não duração de transição; e transições curtas de 150 ms (`.ck-log__linha`, `ux-refinements.css` 540) e 200 ms (`ck-assist-abrir`, `ux-refinements.css` 550, `equipment-user-in`), que ficam para não mudar o efeito percebido.
- Regra para qualquer animação nova: em CSS, dentro de `@media (prefers-reduced-motion: no-preference)` (ou com guard `reduce` próprio, como `ux-spin` e `automation-pulse`); em JS, passar por `SimpressMotion` (`reveal`, `openOverlay`, `startLoading`), que já pula a animação quando `matchMedia("(prefers-reduced-motion: reduce)")` casa. Não unifique os resets: 1 ms (`ck-tokens.css`) e 0.01 ms (`ck-cockpit.css`) são deliberados, e o `ui.spec` exige no máximo 0.01 ms.

## 8. Acessibilidade

- Foco global: `:focus-visible { outline: 2px solid var(--cor-destaque); outline-offset: 2px; }` (`ck-tokens.css:137`, repetido em `ck-cockpit.css:8` para `.simpress-app-shell`). No tema claro, `theme.css:84-87` usa `--focus-color` e `box-shadow`.
- `.ck-pular` (link de pular) com z-index 100.
- `outline: none` só em `.ck-tela:focus` (14), `#cockpit-tool-panels:focus` (893) e `.ck-busca__entrada:focus-visible` (254); o último é compensado por `.ck-busca__campo:focus-within` (252).
- Atalhos F1–F10 e navegação por setas na lista da Home são contratos do `AGENTS.md`.
- Pontos fracos (detalhe em `AUDITORIA-VISUAL.md`): `--cor-texto-apagado` abaixo de 3:1 (decisão do B1: valor mantido, ver AUDITORIA-VISUAL.md seção F), bordas abaixo de 1,5:1, alvos de toque pequenos nos chips só de estado e nos demais controles. `--cor-destaque-forte` escuro passou a 3,05:1 no B1.

## 9. Quality Gates (checklist de PR visual)

Marque cada item antes de abrir ou aprovar um PR que mexa em visual.

- [ ] Escopo: só o bloco pedido; nenhum ID, ARIA, `data-*`, handler ou regra de negócio mudou; ordem de Tab preservada.
- [ ] Rótulos: nenhum texto visível mudou sem aprovação explícita; cabeçalhos de tabela e rótulos de grade em caixa de frase (primeira letra maiúscula, siglas e nomes próprios mantidos), sem `text-transform: uppercase` para forçar caixa alta; termos aprovados do `AGENTS.md` intactos (`Planilha Exportada com Sucesso!`, `No Endpoint`, `na Simpress`, `Exportar Excel`, `3+ dias`, `Importar e gerenciar`).
- [ ] Tokens: sem cor, tamanho de fonte ou duração solta nova; usar `--cor-*`, `--fs-*`, `--duracao*`.
- [ ] Contraste: texto >= 4,5:1; componentes e bordas funcionais >= 3:1; medido antes e depois, nos dois temas.
- [ ] Foco: anel visível por teclado em todo controle novo ou alterado; cor do anel de foco inalterada (`ui.spec.cjs:505-515`).
- [ ] Toque: controles novos com alvo >= 44 px em `(pointer: coarse)`, sem mudar desktop.
- [ ] Responsivo: 375, 390×844, 768, 1024 e 1366/1440; sem rolagem horizontal de 320 a 2560 px; tabelas viram cards abaixo de 1200 px.
- [ ] Temas: claro e escuro conferidos; prints antes e depois (`.claude/prints/<assunto>/`, skill `ajuste-visual-ui`).
- [ ] Motion: 150 a 300 ms, `prefers-reduced-motion` respeitado (manter 0.01ms no reset do cockpit), sem stagger em tabelas, sem pulso contínuo novo, sem hover com scale.
- [ ] CSP: nenhum estilo ou script inline; `!important` existente não removido mecanicamente.
- [ ] Testes: `npm run verify` e `npm run test:ui:e2e` (inclui `color-contrast`, `ui`, `theme-toggle`, `sebrae-dashboard`); se o Tailwind mudar, `npm run build:ui`.
- [ ] Assistente de IA: se texto, ferramenta ou comportamento mudou, alinhado e testado de verdade no servidor local.
- [ ] Documentação: `AGENTS.md` e o `.md` da aba em `docs/` atualizados; relatório diz o que foi e o que não foi verificado.
