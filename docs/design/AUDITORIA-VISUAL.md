# Auditoria visual do Simpress (B0, somente leitura)

Origem: seção "Achados confirmados" do plano (`docs/design/PLANO-MELHORIA-VISUAL.md`), reconferida em 03/11/2026 contra o código atual. Cada achado tem arquivo:linha, gravidade (alta, média, baixa) e certeza (alta = lido no código e/ou calculado; média = lido mas depende de renderização; baixa = herdado do plano, não reconferido).

Método e limites que valem para tudo abaixo:

- Leitura de `static/styles/*.css` e greps em `static/index.html` e `static/js/`. Nenhuma tela foi renderizada nesta etapa (ver "Limitações").
- Razões de contraste calculadas dos hex dos tokens (fórmula de luminância relativa WCAG 2.x). Não são medições no navegador, e não consideram transparências nem sobreposições.
- Nenhum arquivo de código, `data/`, `.env` ou `node_modules` foi tocado.

## A. Falhas confirmadas

### A1. Contraste de tokens (`ck-tokens.css`)

Status B1 (04/11/2026): `--cor-destaque-forte` escuro corrigido (3,05:1); `--cor-texto-apagado` mantido de propósito. Ver seção F.

| Par | Razão | Meta | Veredito |
|---|---|---|---|
| `--cor-texto-apagado` #a1a3b0 sobre #ffffff (claro) | 2,51:1 | 3:1 (não texto) / 4,5:1 (texto) | abaixo |
| `--cor-texto-apagado` #a1a3b0 sobre #f2f3f8 (claro, fundo) | 2,26:1 | idem | abaixo |
| `--cor-texto-apagado` #5a5e70 sobre #1d2031 (escuro) | 2,51:1 | idem | abaixo |
| `--cor-texto-apagado` #5a5e70 sobre #161826 / #23263a (escuro) | 2,74:1 / 2,32:1 | idem | abaixo |
| `--cor-destaque-forte` #7466c0 sobre `destaque-fundo` #2a2550 (escuro) | 2,98:1 | 3:1 (não texto) | marginalmente abaixo |
| `--cor-destaque-forte` #7466c0 sobre `superficie` #1d2031 (escuro) | 3,38:1 | 3:1 | passa |
| `--cor-destaque-forte` #5947a9 sobre `destaque-fundo` #edeafb (claro) | 6,13:1 | 4,5:1 | passa |
| `--text-faint` #64748b (`tokens.css:121`, igual nos dois temas) | 3,75:1 sobre #0f172a; 4,24:1 sobre #020617; 4,34:1 sobre #f1f5f9; 4,76:1 sobre #fff | 4,5:1 (texto) | abaixo na maioria dos fundos |
| `--cor-borda` sobre `superficie` | 1,42:1 (claro), 1,27:1 (escuro) | 3:1 se a borda for o único limite do controle | abaixo |
| `--cor-borda-suave` sobre `superficie` | 1,24:1 (claro), 1,08:1 (escuro) | decorativa (separador) | aceitável como separador, não como limite de campo |

Gravidade e certeza, achado a achado:

1. `--cor-texto-apagado` 2,51:1. Valores do plano confirmados (claro e escuro, sobre `superficie`). Certeza alta no número.
   - Divergência de gravidade: o token quase nunca é cor de texto. Usos (todos conferidos): `ck-cockpit.css` 36 e 105 (borda no hover), 168 (marca de tempo), 216 (ponto do chip), 565 (cor do risco em `text-decoration-color`), 582 (preenchimento do gráfico "concluídos"), 1061 (ponto), 1745 (borda); `ck-pendencias.css:134`. O único uso como `color` é `ck-cockpit.css:1032` (`.sebrae-topo__seta`, seta decorativa). Logo o limite aplicável é 3:1 (não textual) e a falha de leitura de texto fica restrita a um ícone decorativo. Gravidade: média (bordas de hover e preenchimento de gráfico abaixo de 3:1). Certeza: alta nos números, média no impacto (depende de como cada uso aparece).
   - O 168 (marca de tempo) merece conferência visual: se for texto legível, passa a falha de texto. Não foi renderizado.
2. `--cor-destaque-forte` escuro sobre `destaque-fundo` 2,98:1. Número confirmado. Usos (todos não textuais): bordas e `inset box-shadow` de estados ativo/pressionado em `ck-cockpit.css` 34, 37, 49, 79, 209, 361, 1343, 1746 e `ck-pendencias.css:123`; mais `a:hover` em `ck-tokens.css:133`. Gravidade: baixa a média (0,02 abaixo do limite de 3:1, em estado transitório). Certeza: alta no número.
3. `--text-faint` 4,24 a 4,34:1. Faixa do plano confirmada, mas o resultado depende do fundo: 3,75:1 sobre #0f172a. Uso real é só `app.css:463` (separador "•") e `app.css:929` (`.readiness-group-description`, 0.75rem, é texto de verdade). Gravidade: baixa (um único texto real, em arquivo fora da lista do plano). Certeza: alta no cálculo, média na superfície real do fundo.
4. Bordas de campo e controle 1,27 a 1,42:1. Confirmado. Campos usam `--cor-campo` + `--cor-borda`; o limite visual do controle é só a borda. Gravidade: média. Certeza: média (o contraste real também depende da diferença campo/superfície, 1,05:1 no claro; não renderizado).

### A2. Hex soltos e valores fora de token

Status B1: 192-194, 369, 378 e 413 de `ux-refinements.css` e os valores do tema claro de `theme.css` agora usam tokens; 384, 425, seleção, toasts e `#fff` dos botões ficam literais; fontes de 898, 731, 903 e 964 usam `--fs-*`. Ver seção F.

| Local | Situação |
|---|---|
| `ux-refinements.css:192-194` | `#065f46`, `#047857`, `#334155` soltos (confirmado) |
| `ux-refinements.css:369, 378` | fallbacks `var(--ux-border, #334155)` (confirmado) |
| `ux-refinements.css:384` | `#0f172a`/`#fff` em `option` (confirmado) |
| `ux-refinements.css:413` | `scrollbar-color: #475569` (confirmado) |
| `ux-refinements.css:425` | `rgba(250, 204, 21, 0.12)`, não citado no plano |
| `theme.css:47-123` | hex e rgba soltos em body, seleção, `.text-white`, toasts e botão de tema (confirmado; o remapeamento `--color-*` das linhas 7-44 é intencional) |
| `ck-cockpit.css` | nenhum hex solto (os 5 literais de fonte abaixo são tamanhos, não cores) |

Divergência: o intervalo `369-413` do plano na prática são 4 linhas (369, 378, 384, 413) mais o `rgba` de 425. Gravidade: baixa (consistência e manutenção, sem falha de uso). Certeza: alta.

Fontes fora da escala `--fs-*`:

- `ck-cockpit.css`: 16px (710, 898), 18px (731), 22px (903, 964). O 16px do mobile é deliberado (evita zoom do iOS).
- `ux-refinements.css`: `.75rem`, `.78rem` (369, 373, 397, 415), `.8rem` (320, 382, 513), `.82rem` (400, 405, 526), `.85rem` (385, 454, 477, 511), `.95rem` (453, 476), `1.05rem` (372), `1.5rem` (396); pesos 450 (654), 650 (22), 800 (113, 396).

Gravidade: baixa. Certeza: alta.

### A3. Alvos de toque

Status B1: `.ck-btn--mini`, `.ck-segmentado__op`, `details.ck-chip`, `.ck-chip--botao` e `.ck-chip__gatilho` têm 44 px só em `@media (pointer: coarse)`; desktop inalterado. Ver seção F.

- `ck-cockpit.css:46` `.ck-btn--mini` 24×24; `:84` `.ck-segmentado__op` altura 24; `:215` `.ck-chip` altura 26; `.ck-tag` 22; `.ck-badge` 20; `.ck-pilula` 24; `.ck-btn` 30 e `--sm` 26. Abaixo dos 44 px recomendados para toque (e dos 24 px mínimos do WCAG 2.2 AA em alguns casos de espaçamento).
- `@media (pointer: coarse)` confirmado em `ck-cockpit.css:1299-1304` só para a aba Sebrae. Divergência do plano: também existe em `ux-refinements.css:150` e `:188` (`.ux-recent-chip`, `.ux-pending-chip`, 44 px) e em `app.css:552, 794` (esses dois mudam layout, não alvo de toque).
- As "36 ocorrências de altura pequena" do plano não foram recontadas nem lidas em `app.css`.

Gravidade: média em uso por toque, baixa no desktop com mouse. Certeza: alta nas alturas; média na contagem total.

### A4. Z-index sem escala única

Toast do cockpit 70 (`ck-cockpit.css:609, 971`) fica abaixo do popover 100 e do toast legado 130 (`tokens.css:21,23`). Divergência: `.modal-overlay.ck-veu` usa `var(--z-overlay, 60)` (`ck-cockpit.css:980`), que resolve para 120 via `tokens.css`. Outros valores soltos: 3, 5, 30, 40, 45, 50, 60, 100 (`.ck-pular`). Risco real depende de existirem elementos dos dois sistemas na mesma tela ao mesmo tempo. Gravidade: baixa a média. Certeza: média (empilhamento real não renderizado).

### A5. Sem escala de espaçamento no cockpit

`ck-cockpit.css` usa px literais; a escala `--ux-space-*` (`tokens.css`) é do código legado. Gravidade: baixa. Certeza: alta.

### A6. Motion: durações e animações literais, duplicação

- Literais: `ck-cockpit.css` 522 (900ms), 862 (150ms), 1042/1227/1252 (.8s), 1045/1058 (1.2s), 1082 (1.4s), 1769 (900ms); `ux-refinements.css` 259 (800ms), 479 (1.4s), 540 (150ms), 550 (200ms). Confirmado. Gravidade: baixa. Certeza: alta.
- 6 fade-ins duplicados: `ck-surgir`, `ui-menu-enter`, `panel-card-enter`, `sebrae-descricao-entrar`, `ck-assist-entrada`, `equipment-user-in`. Confirmado. Spinners: `ck-girar` e `ux-spin` confirmados; o terceiro (`animate-spin` do Tailwind) não foi buscado nesta etapa. Gravidade: baixa. Certeza: alta nos seis, média nos três.
- Reduced motion em três mecanismos: `ck-tokens.css:155-157` (1ms `!important`), `ck-cockpit.css:673-675` (0.01ms) e `tokens.css:617-625` (`--motion-*` em 0.01ms). Confirmado. Ver divergência D5: o valor diferente é proposital.

## B. Divergências entre o plano e o código real

| # | Plano diz | Código real | Efeito |
|---|---|---|---|
| D1 | `.ck-busca__entrada` remove outline (`ck-cockpit.css:254`), "conferir `:focus-within`" | `:254` tem `outline: none` no `:focus-visible` da entrada, mas `:252` `.ck-busca__campo:focus-within` desenha `border-color` + `outline: 2px solid var(--cor-destaque)` + `outline-offset: 2px` no wrapper | Não é falha: o indicador existe. Fica como "conferido no código, falta confirmar no navegador" |
| D2 | `nocturne.css` espelha `ck-tokens.css` | Só no tema claro. No escuro os valores divergem (ex.: `--cockpit-surface` #232532 contra `--cor-superficie` #1d2031; `--cockpit-border` #3f424d contra #2f3244). Nenhum uso de `var(--cockpit-*)` em `static/` | O risco de divergência é de duplicação morta, não de efeito visível hoje. B1 pode ignorar `nocturne.css` ou removê-lo do escopo; editar só `--cor-*` já cobre o cockpit |
| D3 | `automation-pulse` e `ux-spin` só cobertos pelo reset global | `ux-spin` tem `animation: none` sob reduce em `ux-refinements.css:270`; `automation-pulse` em `:597-598` | Já têm guard próprio. B3 não precisa criar esse guard |
| D4 | Troca de painel/aba e `<details>` sem transição | `<details>` do Sebrae já animam a altura (`ck-cockpit.css:1259-1266`, `::details-content`, `--duracao-lenta`); `.ck-chip details` gira o ícone (685-686) | Lacuna é parcial. A troca de aba/painel não foi confirmada como seca (não renderizado) |
| D5 | Unificar o reset de movimento reduzido "um valor, um lugar" | `ck-cockpit.css:672` documenta que o contrato do `ui.spec` ("reduced-motion") exige 0.01ms ou menos; `ck-tokens.css:156` usa 1ms | B3 não pode padronizar em 1ms. Padronizar em 0.01ms, ou manter os dois e documentar. Riscos para `tests/e2e/ui.spec.cjs` |
| D6 | `--cor-texto-apagado` com 2,51:1 "uso como texto" | Só um uso como cor de texto (seta decorativa, `ck-cockpit.css:1032`); o resto são bordas, pontos e preenchimentos | Gravidade menor que a do plano; ver A1.1 |
| D7 | `--cor-destaque-forte` escuro 2,98:1 | Usado em borda e `inset shadow`, não em texto | Limite aplicável é 3:1; falta 0,02. Ver A1.2 |
| D8 | `data-estado` "só em OS e Comparação" | Também existe em seletor de arquivo (`file-picker.js:24`), rotinas da Automação (`ck-cockpit.css:477`, `chrome-automation.js:172`), painel Chamados (`sebrae-dashboard.js` e `ck-cockpit.css` 1036-1247) e no globo do assistente (`assistant-chat.js:193`) | "Padrão comum" não existe: cada área usa vocabulários próprios (`ok/alerta/erro`, `ocioso/em-andamento`, `vazio/selecionado`...). B2 deve alinhar sem quebrar esses | Tratado no B2 (seção G): Home, Resumo e Transporte ganharam `data-estado` aditivo. Correção: essas telas já tinham `data-state` em inglês (`loading/ready/error/empty/selected/pending`), usado por testes e CSS. |
| D9 | `ck-cockpit.css:1299-1305` | Bloco real: 1299-1304 | Linha ajustada |
| D10 | Hex soltos `369-413` | 369, 378, 384, 413 + `rgba` em 425 | Ver A2 |

## C. Melhorias (não são falhas)

Itens que o plano trata como achados mas que são evolução de organização ou consistência. Nenhum está confirmado como defeito para o usuário.

1. Estados padrão: `data-estado` e erro com "Tentar de novo" para Home, Resumo e Transporte (D8). Skeleton hoje em `equipment-search.js`, `full-equipment-search.js`, `comparison-history.js` e `#sebrae-novos-lista` (via `SimpressMotion.startLoading`, `ui-motion.js:97-134`). Home, Resumo e Transporte não têm `data-estado`. Certeza: alta no que existe, baixa na lacuna visual (não renderizado).
2. Organização dos blocos (Home com 10 ações, Transporte com 6, Assistente com 6 botões e aviso de anexos de 33 palavras, Histórico de apelidos com 2 pílulas desabilitadas, cartão SoftExpert da Automação). Contagens vêm do plano; não foram reconferidas. Pela decisão do usuário, B4 fica restrito a espaçamento e prioridade visual em CSS, sem mover nada. Certeza: baixa.
3. Candidatos de texto (B5, todos dependem de aprovação). Reconferidos em `static/index.html`: "Usuário AD" (305), "Nome Completo" (321), "CNPJ faturamento" (341), "Fat." (584), "Observações · célula B37" (613), "Ambas" (764, 808). Não reconferidos: caixa dos cabeçalhos do Resumo, "Ordens" contra "OS", aviso de anexos. Itens protegidos pelo `AGENTS.md` não entram: `Planilha Exportada com Sucesso!` (linha 37), `No Endpoint`/`na Simpress` (linha 38), `Exportar Excel`, `3+ dias` na OS, `Importar e gerenciar`. O mapeamento linha a linha do plano (`37-44, 91, 100, 108-111, 120`) bate em parte: a linha 120 trata de `Editar`/`Restaurar padrão` (representante); `Exportar Excel` e "3+ dias" aparecem em trechos longos das linhas 100 e 111. Reconferir o texto exato antes do B5.
4. Reduzir duplicação (6 fade-ins para 1, spinners, `nocturne.css` morto). Impacto estético nulo; é manutenção.
5. Escala de espaçamento e z-index do cockpit. Manutenção.

## D. O que NÃO foi verificado

- Nenhuma das 10 abas foi renderizada em nenhum viewport (ver registro dos prints abaixo). Todo juízo de aparência, alinhamento, quebra de linha e "bloco denso demais" é inferência do código.
- Contrastes só calculados de hex. Transparências (`--cor-veu`, `rgb(... / %)`), imagens de fundo, sobreposições e antialiasing não entram.
- `static/app.css` (68 KB) não foi lido inteiro; só greps. As "36 ocorrências de altura pequena" não foram recontadas.
- O artefato Cockpit de referência (`claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC`) não foi decodificado: a conformidade de qualquer mudança de composição com ele não foi checada.
- Se KPIs com sparkline do Resumo e chips da Automação (docs 03 a 06) foram implementados: não conferido.
- `ck-cockpit.css` foi lido em trechos e por grep (1918 linhas), não de ponta a ponta.
- Efeito dos achados no usuário (alvo de toque em dispositivos reais, foco por teclado em cada tela, leitores de tela): não testado.
- Nenhum teste (`npm run verify`, `npm run test:ui:e2e`) foi rodado; B0 não altera código.

## E. Registro de prints (linha de base)

Capturados em 03/11/2026 com Chromium do Playwright do projeto (headless), contra o fixture isolado `ui-fixture` (`tests/support/serve_ui_motion_preview.py`, porta 8765, dados fictícios; iniciado com `.venv/Scripts/python.exe -B` e parado ao fim). 40 PNGs em `.claude/prints/linha-de-base/`, nome `antes-<tela>-<desktop|mobile>-<light|dark>.png`.

- Telas (por atalho F1 a F10): home, transporte, resumo, automacao, sebrae-chamados, os, comparacao, apelidos, relatorio, assistente.
- Viewports: desktop 1366×900 e mobile 390×844, cada um em tema claro e escuro (tema fixado por `localStorage["simpress:theme"]`; `data-theme` conferido em cada combinação).
- Só a janela visível (sem página inteira). Home recapturada com espera maior, porque a primeira captura pegou "Carregando equipamentos...".
- Limites: dados do fixture (1 equipamento fictício, 1 OS), não os dados operacionais reais; espera fixa de 700 ms por tela, então estados lentos podem aparecer incompletos; nenhum print foi inspecionado um a um (só `antes-os-desktop-dark`, `antes-home-desktop-dark` e `antes-home-mobile-light` foram vistos).
- Console: 4 respostas 404 de recurso por carga no fixture (não identificadas; o fixture não implementa todos os endpoints). Não investigado.
- Observação visual, certeza média: ao abrir uma ferramenta por F6 o título da ferramenta ("OS") aparece com contorno de foco roxo largo; `ck-cockpit.css:893` tira o outline de `#cockpit-tool-panels:focus`, então o contorno vem de outro elemento (não identificado). Conferir no B1/B6. Na Home mobile, a barra de abas rola na horizontal (Automação cortada), o que é esperado em compacto, mas precisa de conferência de acessibilidade.

## F. B1 (tokens e acessibilidade, só CSS): o que foi feito, em 04/11/2026

Arquivos tocados: `static/styles/ck-tokens.css`, `ck-cockpit.css`, `ux-refinements.css`, `theme.css`. Nenhum HTML, JS, texto, ID, ARIA, `data-*`, `data/`, `.env` ou `node_modules`. Nenhum commit nem push. O CSS do Tailwind (`tailwind.input.css`) não importa `theme.css`, então `npm run build:ui` não foi necessário.

### F1. Tokens

| Token | Antes | Depois | Decisão |
|---|---|---|---|
| `--cor-destaque-forte` (escuro) | #7466c0 (2,98:1 sobre `destaque-fundo`) | #7568c1 (3,05:1 sobre `destaque-fundo`; 3,46:1 sobre `superficie`; 3,20:1 sobre #23263a) | Corrigido. Passo de um tom, imperceptível. É só borda e sombra interna (no escuro `a:hover` usa `destaque-texto`), então o limite é 3:1 de não texto. Chegar a 4,5:1 deixaria o token quase igual a `--cor-destaque` e achataria todos os estados ativos. Só existe no escuro, então `nocturne.css` não muda. A tabela de comentários no fim de `ck-tokens.css` e o `DESIGN.md` (2.1 e tabela de contraste) foram atualizados. |
| `--cor-texto-apagado` (claro e escuro) | #a1a3b0 e #5a5e70 | sem mudança | Mantido de propósito. O token só é bordas, pontos, risco de texto e preenchimento de gráfico; o único uso como `color` era `.sebrae-topo__seta`, um SVG `aria-hidden`. Mudar o valor alteraria a aparência de bordas e pontos sem ganho de leitura. Mantê-lo também mantém o espelho claro `--cockpit-neutral-600` de `nocturne.css` igual. |
| `.sebrae-topo__seta` (`ck-cockpit.css:1032`) | `color: var(--cor-texto-apagado)` (2,26:1 claro, 2,74:1 escuro sobre `--cor-fundo`) | `color: var(--cor-texto-mudo)` (5,04:1 claro, 6,54:1 escuro) | Corrigido onde há "texto" de fato. A seta fica mais escura no claro e mais clara no escuro (única mudança de aparência desta etapa fora do toque). Para voltar, basta restaurar o token anterior nessa linha. |

Pendente, decisão do usuário: ainda abaixo de 3:1 e não alterados porque mudariam a aparência: ponto do chip neutro (`.ck-chip__ponto`), `.ck-tempo__marca` e o preenchimento "concluídos" do gráfico, todos com `--cor-texto-apagado`. O A1.4 (bordas de campo, 1,27 a 1,42:1) e o `--text-faint` também seguem como estavam.

### F2. Hex soltos trocados por token (mesmo valor, conferido por `getComputedStyle` nos dois temas)

- `ux-refinements.css`: 192-194 por `--color-emerald-200` (#065f46), `--color-emerald-300` (#047857) e `--text-body` (#334155), todos no tema claro; 369 e 378 sem o fallback `#334155` (`--ux-border` existe nos dois temas); 413 por `--scrollbar-thumb-hover` (#475569, igual nos dois temas).
- Mantidos literais: 384 (`option` com `#0f172a`/`#fff`, vale nos dois temas e `--ux-text` deixaria a opção quase branca sobre branco no escuro) e 425 (amarelo com alfa, sem token equivalente).
- `theme.css`, só regras do tema claro: fundo e texto do `body` (`--surface`, `--text-strong`), `.text-white` (`--text-strong`), botão de tema (`--border-control`, `--surface-raised`, `--text-body`; hover `--border-firm`, `--surface-control`, `--text-strong`). Regras base do botão de tema: `--text-body` e `--ux-surface-2` (no claro elas são sobrescritas pelas regras do tema claro). Literais mantidos: seleção de texto, `#fff` dos botões coloridos, toasts e o `#7dd3fc` de fallback do foco.
- Fontes em `ck-cockpit.css`: 731 `--fs-2xl`, 898 `--fs-xl`, 903 e 964 `--fs-kpi`. O 16px de 710 fica literal (evita zoom do iOS). Os `rem` de `ux-refinements.css` não foram trocados: em px o texto deixaria de seguir a fonte do navegador (WCAG 1.4.4) e a igualdade só vale com raiz de 16 px.

### F3. Alvo de toque (só `@media (pointer: coarse)`)

Regra nova em `ck-cockpit.css` logo após o bloco do Sebrae: `.ck-btn--mini` com `min-width` e `min-height` de 44 px, `.ck-segmentado__op` com `min-height` de 44 px, e `details.ck-chip`, `.ck-chip--botao` e `.ck-chip__gatilho` com `min-height` de 44 px.

- Medido no fixture em desktop 1366×900 (ponteiro fino): `summary.ck-chip__gatilho` 44×24, chip 52×26, `.ck-btn--mini` 24 de largura (a altura de 40 no F2 já era assim antes). Idêntico ao antes.
- Medido em 390×844 com toque (`isMobile` e `hasTouch`): `.ck-btn--mini` 44×44, gatilho 44×44, chip de prontidão 52×44, sem rolagem horizontal. O chip só de estado (ponto de 16×26) não cresce, porque não é interativo.
- Custo: na Home em toque, a faixa do topo cresce 18 px (chip de 26 para 44), o que empurra o conteúdo para baixo.
- `.ck-segmentado__op` não aparece em nenhuma das 10 abas do fixture (nem em `static/index.html` ou `static/js`): a regra existe no CSS mas não foi medida em tela.

### F4. Contorno do título da ferramenta com F6

Origem: `#cockpit-tool-title` (h1 com `tabindex="-1"`), focado por JS em `cockpit-tool-panels.js:1449` ao abrir a ferramenta; `ck-cockpit.css` tem `#cockpit-tool-title:focus-visible { outline: 2px solid var(--cor-destaque); outline-offset: 2px; }` de propósito (e `tests/e2e` exige `toBeFocused` nele). Medido: claro, `rgb(112, 93, 198) solid 2px`, offset 2px, halo `0 0 0 2px #fff` vindo de `theme.css`; escuro, `rgb(145, 132, 217) solid 2px`, halo `rgb(2, 6, 23)`. Parece largo porque o h1 é um bloco de largura total. É gestão de foco intencional (acessibilidade); não foi removido nem alterado. Cor do anel de foco não mexida, como pedido.

### F5. Prints e testes

- Prints antes e depois em `.claude/prints/b1-tokens/` (`antes-*` e `depois-*`, mesmos nomes da linha de base; os de mobile em toque levam `mobile-touch`). Comparação pixel a pixel: desktop claro idêntico em 8 das 10 telas; Sebrae claro difere em 43 px (a seta) e Assistente claro em 662 px com variação de 1 unidade por canal num ícone animado (ruído de animação, não do CSS). Desktop escuro difere em 189 a 902 px, também com variações de 1 a 2 unidades por canal nas bordas de estados ativos (#7466c0 para #7568c1), imperceptíveis. Mobile em toque difere por deslocamento (faixa do topo 18 px mais alta). Home, OS, Resumo e Sebrae-Chamados (mobile em toque, antes e depois) foram vistos lado a lado (Home claro, OS escuro, Resumo escuro, Sebrae claro); as outras combinações foram comparadas só por contagem de pixels. Nenhuma tela de desktop foi olhada imagem a imagem. A seta do Sebrae fica oculta em mobile, então só aparece no desktop.
- Testes depois das mudanças: `npm run verify` saiu com 0 (Python isolados OK, `node --test` 380 passaram e 0 falharam, `node --check`, TypeScript gradual, `compileall`, mypy gradual e estrito, varredura de credenciais OK). `npx playwright test` (inclui `color-contrast`, `ui` e `theme-toggle`, projetos desktop, mobile e desktop-profile): 395 passaram, 2 ignorados, 0 falhas, igual à linha de base anterior às mudanças.
- Console: os 404 do fixture (`/api/usuarios-entra/estado`) continuam; são do fixture, não do CSS.
- Assistente de IA: não foi preciso ajustar nem exercitar, porque a mudança é só CSS (nenhum texto, ferramenta, prompt ou contrato mudou). Não foi testado ao vivo.

## G. B2 (estados padrão): o que foi feito, em 04/11/2026

Arquivos tocados: `static/index.html` (só atributos `data-estado` iniciais), `static/js/features/cockpit-summary.js`, `equipment-search.js`, `transfer-form.js`, `static/styles/ck-cockpit.css`. Nenhum texto visível novo ou alterado, nenhum ID, ARIA, `data-*` existente, handler, regra de negócio ou ordem de Tab. Sem commit nem push. O Tailwind não mudou (sem `build:ui`).

### G1. Mapa antes de editar (arquivo:linha original)

| Tela | Carrega | Esvazia | Falha | Já usava |
|---|---|---|---|---|
| Home, lista | `equipment-search.js` `carregarListaHome` (ramo `reset`: `aria-busy`, texto "Carregando equipamentos…") | `limparListaHome` (dica de 1 caractere, filtro sem comparação) e `#home-list-empty` | `catch` de `carregarListaHome`, que chama `limparListaHome` | `aria-busy`, `#home-list-empty`; sem skeleton na lista |
| Resumo | `cockpit-summary.js` `carregarResumoCockpitInterno` (`aria-busy`) | `renderRegions` e `renderRows` | `catch`: `data-state="error"` e mensagens existentes | `data-state` (`loading/ready/error`), texto "Carregando dados da base local…" |
| Transporte | sem carga remota própria | `transfer-form.js` banner e prévia | sem fluxo de erro | `data-state` (`empty/selected`, `empty/pending/ready`) |

### G2. O que mudou

- `data-estado` (vocabulário `carregando`, `pronto`, `vazio`, `erro`): `#home-equipment-list` (inicia `carregando`; `vazio` em `limparListaHome` e quando a resposta vem sem itens; `erro` no `catch`), `#resumo-cards` (`carregando`, `pronto`, `erro`; `vazio` não se aplica, o painel sempre tem KPIs ou erro), `#transfer-equipment-banner` (`vazio`/`pronto`) e `#cockpit-transport-preview-state` (`pronto` só com equipamento e entrega; senão `vazio`).
- Skeleton: `SimpressMotion.startLoading` (componente existente, sem novo) em `#equipment-loading` (Home, rótulo "Carregando equipamentos…") e `#cockpit-summary-region-list` (Resumo, rótulo "Carregando dados da base local…", ambos textos que já existiam). Parado em sucesso, erro e nova carga. A busca por série compartilha `#equipment-loading`; o loader por contêiner cancela o anterior, sem efeito colateral.
- CSS (só tokens): erro do Resumo (`#cockpit-summary-kpis` com `--cor-erro-fundo`/`--cor-erro-texto`, o texto que antes aparecia cru e sem estilo) e mensagem de erro da Home em `--cor-erro-texto`; skeleton recolorido com `--cor-superficie`, `--cor-borda-suave`, `--cor-neutro-fundo` e `--raio-md` só em `.ck-home` e `#resumo-cards` (o padrão do `ui-motion.css` é escuro fixo e virava uma placa cinza no tema claro). Movimento: o brilho do skeleton já tem guarda de movimento reduzido em `ui-motion.css`; nenhuma animação nova.

### G3. Propostas pendentes de aprovação (NÃO implementadas)

1. Botão "Tentar de novo" no erro da Resumo (texto, `#cockpit-summary-status`, `cockpit-summary.js`) e na lista da Home (`#home-list-empty`, `equipment-search.js`).
2. Mensagem de vazio própria para a lista da Home por filtro, hoje cobertas pelos textos existentes.

### G4. Prints

`.claude/prints/b2-estados/` (`antes-*` e `depois-*`; telas home, transporte, resumo, mais `home-carregando`, `home-erro`, `resumo-carregando`, `resumo-erro`; desktop 1366×900 e mobile 390×844, claro e escuro). Carregando e erro forçados por interceptação de rede no fixture.

## H. B3 (movimento, com restrição): o que foi feito, em 04/11/2026

Arquivos tocados: `static/styles/ck-cockpit.css`, `static/styles/ui-motion.css`, `docs/design/DESIGN.md` (seção 7). Só CSS. Nenhum HTML, JS, texto, ID, ARIA, ordem de Tab, foco ou atalho F1-F10. Sem commit nem push. O Tailwind não mudou (sem `build:ui`).

### H1. Confirmação do D4: onde a troca estava seca

- F1 a F4 já animavam: `SimpressMotion.reveal(painel, "page")` (220 ms, 8 px). Não foram tocadas.
- Secas antes: os painéis de ferramenta F5 a F9 (`.ck-ferr-painel`, trocam só pelo atributo `hidden`), as abas de modelo da Home (`.ck-chamado__painel`) e os `details` que não são do Sebrae (`.ckp-recolher`, `details.ck-det-bloco`, incluindo a prévia do relatório mensal).
- Os `details` do Sebrae já animam a altura por `::details-content` e `interpolate-size`; ficaram fora.

### H2. O que mudou

- Uma regra em `ck-cockpit.css`, dentro de `@media (prefers-reduced-motion: no-preference)`, aplica `animation: ck-surgir var(--duracao) var(--curva)` a `.ck-ferr-painel:not([hidden])`, `.ck-chamado__painel:not([hidden])` e ao conteúdo (tudo menos o `summary`) de `.ckp-recolher` e `details.ck-det-bloco` quando abertos. Entrada de 180 ms: opacidade de 0 a 1 e deslocamento vertical de -4 px a 0. Quando o `hidden` sai, o painel volta de `display: none` e a animação reinicia sozinha, sem JS.
- Sem entrada de propósito: `details[data-user-change-details]`, `.ticket-disclosure` e linhas de tabela (regras do pedido: nada de animar linhas nem escalonar tabelas).

### H3. Durações literais (item 2) e fade-ins duplicados (item 3)

- Nenhuma troca de literal por token foi equivalente (180 ms e 260 ms só existem como `--duracao` e `--duracao-lenta` onde já estavam em uso; os demais valores literais diferem em duração, curva ou propriedade e trocar mudaria o efeito). Todos os que ficam estão listados em `DESIGN.md`, seção 7.
- Dos seis fade-ins encontrados no A6, dois eram idênticos ao `ck-surgir` e foram consolidados: `sebrae-descricao-entrar` (agora `.sebrae-descricao__editor` usa `ck-surgir` com `--duracao` e `--curva`) e `ui-menu-enter` (agora o painel do menu secundário usa `ck-surgir` com `--motion-fast` e `--motion-ease`, o mesmo tempo de antes). As duas `@keyframes` foram removidas; nenhum teste as citava. Os outros quatro diferem em distância, duração ou curva e foram mantidos.

### H4. Movimento reduzido (item 4)

Os resets de 1 ms (`ck-tokens.css`) e 0,01 ms (`ck-cockpit.css`) não foram unificados: são deliberados e o contrato do `ui.spec` exige no máximo 0,01 ms. A animação nova só existe dentro de `no-preference`. A regra para animações futuras (CSS dentro de `no-preference` ou com guarda própria; JS por `SimpressMotion`, que já pula a animação com `matchMedia`) está no `DESIGN.md`.

### H5. Medição (`document.getAnimations()` a cada quadro, Playwright, fixture em 8765, desktop 1366×900, tema claro)

| Cenário | Antes | Depois |
|---|---|---|
| F5, F6, F7, F8, F9 (`section.ck-ferr-painel`) | nenhuma animação | `ck-surgir`, 180 ms, opacidade 0 a 1, translateY -4 px a 0 |
| `details` internos e externos (`div.ckp-recolher__corpo`) | nenhuma | `ck-surgir`, 180 ms |
| Prévia do relatório (`#cockpit-monthly-preview`) | nenhuma | `ck-surgir`, 180 ms |
| Abas de modelo (`#visualizacao-chamado-*`) | nenhuma | `ck-surgir`, 180 ms |
| F1 e F2 | `reveal` em JS, 220 ms, 8 px | igual |
| Com `reducedMotion: 'reduce'` | sem animação | nenhuma `ck-surgir` nem `js` em nenhum cenário; as transições restantes caem em 0,01 ms |

Limitação da medição: as abas de modelo não aparecem no fixture sem equipamento selecionado, então no script os ancestrais foram forçados a visíveis para disparar a entrada. É artefato de medição, não comportamento real.

### H6. Prints

`.claude/prints/b3-motion/` (`antes-*` e `depois-*`; 10 telas, desktop 1366×900 e mobile 390×844, claro e escuro, mais `medicao-antes.json` e `medicao-depois.json`). Comparação pixel a pixel (canvas): igual em todas, exceto Relatório desktop claro e escuro, com 2 px de diferença (caixa 632,15 a 638,15), ruído do relógio/estado. Print estático não mostra animação; a prova do movimento é a medição de H5.

### H7. Riscos conhecidos

- O primeiro `.ck-chamado__painel` anima uma vez no carregamento da página (é a entrada do painel já visível).
- Durante os 180 ms o `transform` em `.ck-ferr-painel` cria bloco de contenção para descendentes `fixed` ou `sticky`. Nada disso apareceu nas telas medidas, mas só termina de ser conferido com dados reais.
- Edições paralelas do Sebrae em `ck-cockpit.css` foram preservadas; a regra de B3 fica logo após `.ck-ferr-painel .ck-barra-ferr .ck-campo`.
- Assistente de IA: não afetado (só CSS; nenhum texto, ferramenta, prompt ou contrato mudou). Não foi testado ao vivo.

### H8. Testes depois das mudanças

- `npm run verify` saiu com 0: Python isolados OK (614,9 s), `node --test` 390 testes, 390 passaram, 0 falharam, 0 ignorados, `node --check`, TypeScript gradual, `compileall`, mypy gradual e estrito e varredura de credenciais OK. Nenhuma falha atribuível ao trabalho paralelo do Sebrae apareceu. A linha `document.createDocumentFragment is not a function` no log é saída de um teste que passa (simulação de falha da automação), não falha.
- `npm run test:ui:e2e` (Playwright, projetos desktop, mobile e desktop-profile, inclui `ui.spec` com o bloco de movimento reduzido, `color-contrast` e `theme-toggle`): 395 passaram, 2 ignorados, 0 falhas, igual à linha de base (13,2 min).
- Não rodei `npm run build:ui` (Tailwind não mudou).

## I. B4 (organização dos blocos, só CSS)

Escopo fixado pelo usuário: "Só espaçamento e prioridade visual". Nenhum HTML, JS, texto, ID, ARIA, `data-*`, handler ou ordem de Tab mudou; `#home-equipment-actions` não foi tocado. Candidatos de composição (menu "Mais" na Home, grupo secundário no Transporte, separar Importar/Buscar na Automação, esconder pílulas vazias do Histórico, menu no Assistente, separar escolha/ações na Comparação) ficam fora de escopo. Todos os ajustes estão em `static/styles/ck-cockpit.css` (números de linha da data desta auditoria; o arquivo recebe edições paralelas do Sebrae e os números se deslocam).

### I1. Ajustes por aba

| Aba | Problema (medido no fixture) | Correção | Arquivo:linha |
|---|---|---|---|
| Assistente (desktop) | Widget de 420px: Nova conversa, Voz, Instruções e Lembretes somavam 389 px + 3 gaps de 8 px contra 393 px úteis; "Lembretes" caía sozinho numa segunda linha (y 427 contra 379) | Botões fantasma da barra com `padding-inline: 6px` (era 9 px); os quatro ficam na mesma linha (y 378) | `ck-cockpit.css:1370` |
| Assistente (estado normal, desktop e celular, e com erro visível) | Depois do padding, o status (globo + texto) ainda dividia a primeira linha com atalhos soltos (1+3 no desktop); com erro, "Tentar novamente" + 2 atalhos na primeira linha e 2 atalhos de larguras desiguais (170 px) na segunda | Status com `flex-basis: calc(100% - 64px)` (primeira linha só dele) e "Tentar novamente", quando visível, com `flex-basis: 100%` (própria linha, regra movida do bloco mobile para a base); os quatro atalhos ficam juntos na linha de baixo | `ck-cockpit.css:1372-1373` |
| Histórico de apelidos (celular) | Campo "Buscar no histórico" preso em 220 px (placeholder cortado em "alteraç"): `.ck-ferr-painel .ck-barra-ferr .ck-campo { flex: 0 1 220px }` vencia o `flex: 1 1 100%` do bloco mobile | Busca em 100% da linha; Tipo cresce ao lado de Exportar CSV | `ck-cockpit.css:930-934` |
| Catálogo de unidades (celular) | Mesma causa: "Buscar unidade" em 220 px | Mesma regra (`:is(apelidos, unidades)`); busca em 100% | `ck-cockpit.css:930-934` |
| Comparação (desktop) | Cabeçalho "Anotações" (texto puro) alinhado ao topo da célula e as colunas com botão de ordenação ao centro (y 692 contra 704) | `vertical-align: middle` nos `th` da tabela | `ck-cockpit.css:1881` |
| Automação (desktop) | No card de chamados novos, "Repetir a cada 30 minutos" e as três linhas de status (uma só informação) estavam separadas por 14 px, como itens independentes | `margin-top: -8px` nas três linhas encadeadas: 6 px dentro do grupo, 14 px entre grupos | `ck-cockpit.css:877-880` |
| Transporte (até 1280 px e toque) | Na barra de ações, "Abrir chamado" (link) ficava com 30 px ao lado de botões de 48 px, porque `app.css:795` só dá `min-height: 48px` a `button` | `.ck-acoes-barra a.ck-btn { min-height: 48px }` com a mesma condição de mídia do `app.css` | `ck-cockpit.css:809-812` |

Tokens: nenhum valor novo; `6px`, `8px`, `48px` já existem como medidas da própria tela. Nenhuma cor nova. `DESIGN.md` não mudou (nenhum valor ou regra global de espaçamento foi alterado).

### I2. Abas sem alteração

Home, Resumo, Chamados/OS (OS), Relatório mensal e Chamados do Sebrae: sem problema real de espaçamento ou prioridade nos prints (Sebrae também recebe edição paralela, então não foi tocada). Planilhas: o painel não abre a partir do fixture (sem botão de acesso), portanto não foi avaliado visualmente.

### I3. Prints

`.claude/prints/b4-organizacao/`: `antes-*` e `depois-*` das 10 telas (home, transporte, resumo, automacao, sebrae-chamados, os, comparacao, apelidos, relatorio, assistente) em desktop 1366×900 e mobile 390×844, claro e escuro, mais `antes-unidades-*` e `depois-unidades-*` (desktop e celular, tema escuro). Os `depois-*` foram regerados para as 10 telas depois da última mudança de CSS (`depois-unidades-*` só no tema escuro; `depois-assistente-normal-*` com o botão de erro escondido); `foco-*.png` mostram o foco por teclado em "Abrir chamado" (Transporte, desktop e celular) e "Lembretes" (Assistente, desktop e celular). Comparação pixel a pixel antes/depois nas telas sem alteração: desktop idêntico; em celular, Resumo, Relatório e OS (escuro) diferem em 0 a 19 pixels com variação de no máximo 2 níveis de cor (antialiasing de cantos/indicador de status, sem mudança de layout). Console sem erros novos (só o 404 de `/api/usuarios-entra/estado`, que é do fixture).

### I4. Riscos conhecidos

- Padding de 6 px nos atalhos do Assistente deixa só 4 px de folga em 420 px; um texto de botão mais longo reabre a quebra. A base de 100% - 64px do status supõe o botão de globo com largura fixa; mudar o botão exige rever o valor.
- `margin-top` negativo na Automação depende de o contêiner continuar `display: flex; gap: 14px`.
- Com `min-height: 48px` no link, a barra do Transporte fica 18 px mais alta em telas até 1280 px (coerente com os botões vizinhos, que já tinham 48 px).
- Assistente de IA: não afetado (só CSS; nenhum texto, ferramenta, prompt ou contrato mudou). Não foi testado ao vivo.

### I5. Testes depois das mudanças

- Rodada final, depois da última mudança de CSS (fixture manual parado antes): `npm run verify` saiu com 0 (1978 testes Python em 604,8 s) e `npm run test:ui:e2e` deu 395 passaram, 2 ignorados, 0 falhas (13,2 min). Primeira rodada, antes do ajuste final do Assistente:
- `npm run verify` saiu com 0: Python isolados OK (610,9 s), `node --test` OK (0 falhas, 0 ignorados), `node --check`, TypeScript gradual, `compileall`, mypy gradual (89 arquivos) e estrito (66 arquivos) e varredura de credenciais OK.
- `npm run test:ui:e2e` (Playwright, desktop, mobile e desktop-profile): 395 passaram, 2 ignorados, 0 falhas (13,2 min), igual à linha de base de B3. Sem falhas do Sebrae. A primeira tentativa abortou por conflito de porta 8765 com o fixture manual; repetida depois de parar o fixture.
- Não rodei `npm run build:ui` (Tailwind não mudou).
- Não verificado: dados reais, navegador real do usuário (só Chromium headless do Playwright), painel Planilhas (não abre a partir do fixture), catálogo de unidades só no tema escuro, só Chromium headless. Foco por teclado conferido via Tab em "Abrir chamado" e "Lembretes": `:focus-visible` ativo, outline sólido de 2 px (Transporte) e 3 px (Assistente), regras de foco inalteradas.

## J. B5 (textos): o que foi feito, em 04/11/2026

Só os cinco textos aprovados item a item. Nenhum ID, ARIA, `data-*`, handler, chave (`ambas`) ou valor de API mudou; nenhum CSS mudou (nem `text-transform` nem Tailwind).

### J1. Antes e depois

| # | Onde (arquivo:linha) | Antes | Depois |
|---|---|---|---|
| 1 | `static/index.html:613` (label de `entrega-obs`) | `Observações * · célula B37` | `Observações *` (o `*` e o `for` ficam) |
| 2 | `static/index.html:584` (botão do CNPJ de faturamento; `title` e `aria-label` já diziam "faturamento") | `Fat.` | `Faturamento` |
| 3 | `static/js/features/chrome-automation.js:12` (rótulo da rotina) | `Ambas as rotinas` | `Rotina Completa` |
| 3 | `domains/chrome_automation.py:34` (`ROUTINE_LABELS`, usado na mensagem 409) | `Ambas as rotinas` | `Rotina Completa` |
| 3 | `static/index.html:764` (título do cartão) e `aria-label` do ícone de ajuda | `Ambas` / `Sobre Ambas` | `Rotina Completa` / `Sobre Rotina Completa` |
| 3 | `static/index.html:808` (filtro "Rotina" do histórico) | `Ambas` | `Rotina Completa` |
| 4 | `static/index.html:711` (tabela do Resumo) | `SÉRIE`, `MODELO / HOST`, `SIMPRESS`, `ENDPOINT CENTRAL`, `ÚLTIMO ACESSO`, `SITUAÇÃO`, `AÇÃO` | `Série`, `Modelo / host`, `Simpress`, `Endpoint Central`, `Último acesso`, `Situação`, `Ação` |
| 4 | `static/index.html:321` (grade da Home) | `Nome Completo` | `Nome completo` |
| 5 | `static/index.html:1170` (`#assistente-anexos-aviso`, 29 palavras) | `Atenção: imagens anexadas vão para o OpenRouter exatamente como estão, sem ocultar CPF, nome, e-mail ou outros dados que apareçam nelas. Anexe só o que pode sair deste computador.` | `Atenção: imagens vão ao OpenRouter sem ocultar dados pessoais (CPF, nome, e-mail). Anexe só o que pode sair deste computador.` (20 palavras) |

Notas do item 4: o HTML era a causa (não havia `text-transform: uppercase` nos cabeçalhos do Resumo nem na grade da Home); `cockpit-summary.js:149` já estava em caixa de frase. Os demais rótulos da grade da Home já estavam corretos. Termos aprovados do `AGENTS.md` ficaram intactos. Os `uppercase` que restam (`ck-cockpit.css:1666`, selo "Manual" da OS; `app.css:627`; `ux-refinements.css:373`) estão fora do escopo aprovado e não foram tocados.

Nota do item 3: o cartão e o filtro usavam "Ambas" (forma curta); alinhei ao nome aprovado. O botão do cartão continua "Executar".

### J2. Testes, assistente e documentos alinhados

- `tests/test_chrome_automation.py:191`: mensagem 409 esperada passou a `Rotina Completa desde 07:30`.
- `tests/e2e/assistente.spec.cjs:774`: o trecho do aviso passou a `sem ocultar dados pessoais (CPF, nome, e-mail)`.
- Assistente: `domains/assistant_chat.py:81` (prompt), `domains/assistant_tools.py:142` (texto do cartão de confirmação) e `:975` (descrição da ferramenta) agora dizem que `ambas` aparece na tela como "Rotina Completa". A chave `ambas` não mudou.
- Documentos: `README.md:313`, `docs/operacao/automacao-chrome.md` (linhas 64, 86, 96, 119), `docs/cockpit-prompts/04-transporte-tres-colunas.md:107`, `05-resumo-kpis.md` (tabela de colunas), `06-automacao-console.md:39` e a lista de Rótulos em `docs/design/DESIGN.md` (seção 9, caixa de frase).
- `AGENTS.md:151` cita só a chave `ambas`; não precisou mudar.
- Menu de console `executar_automacao.bat:30`: `Executar Ambas as Rotinas` passou a `Executar Rotina Completa` (só texto de `echo`; a opção `3` não mudou). Deixados como estavam: docstrings e logs de `scripts/automacao_rotinas_chrome.py` ("Ambas"); `PLANO-MELHORIA-VISUAL.md` e a seção C acima citam os textos antigos de propósito, como registro histórico, e não foram editados.

### J3. Prints

`.claude/prints/b5-textos/` (`antes-*` e `depois-*`; Home, Resumo, Transporte (entrega e observações), Automação e Assistente; desktop 1366×900 e mobile 390×844, claro e escuro). "Faturamento" cabe na linha do CNPJ no desktop e no mobile sem CSS novo; o aviso do Assistente ocupa 3 linhas no mobile (antes 4).

### J4. Riscos conhecidos

- O Resumo exibe "Série/Modelo / host/…" em caixa de frase agora; qualquer script externo que procure o texto em caixa alta deixa de achar (não encontrei nenhum no repositório).
- O cartão de confirmação do assistente para `ambas` ficou mais longo (acrescenta "(na tela, "Rotina Completa")"); não afeta a chave nem a API.

### J5. Testes depois das mudanças

- `npm run verify` saiu com 0 (Python isolados OK em 656,3 s; `node --test` 390 passaram, 0 falhas; `node --check`, TypeScript gradual, `compileall`, mypy gradual 89 arquivos e estrito 66 arquivos, varredura de credenciais OK). Rodou antes das edições finais em `executar_automacao.bat` e neste `.md` (só texto, sem teste que os leia).
- `npm run test:ui:e2e` (fixture manual parado antes): 395 passaram, 2 ignorados, 0 falhas (13,9 min), igual à linha de base. Rodou depois de todas as edições de código e de teste.
- Assistente (servidor real local em porta própria, chave do `.env` válida, dados reais da pasta `data/`): pergunta "O que é o cartão Rotina Completa?" respondeu corretamente (OS e depois Inventários, sem SharePoint). Pedido "Rode agora a Rotina Completa." gerou o cartão `executar_automacao_chrome` com `'ambas'` e "(na tela, "Rotina Completa")"; recusei na confirmação e nada rodou. Só via API; o cartão não foi conferido na tela do navegador. Efeito colateral: as duas perguntas e a recusa ficaram no histórico do assistente (não limpei). Servidores já abertos em 8000/8011 continuam com o Python antigo até reiniciar (mensagem 409 e assistente ainda dizem "Ambas as rotinas" lá).
- `npm run build:ui` não rodou (Tailwind não mudou). Não verificado: navegador real do usuário, dados reais na tela, tema escuro do aviso em dispositivo real.

## K. B6 (verificação final), em 04/11/2026

Só verificação: nenhum código, CSS, HTML, JS, teste ou dependência foi alterado. Os únicos arquivos escritos foram os prints em `.claude/prints/b6-final/` e esta seção.

### K1. Testes automáticos

- `npm run verify` saiu com código 1. A falha está só nos Python isolados: 1978 testes, 2 erros, 2 ignorados, em 630,9 s. Os dois erros são `test_detalhes_do_atendimento_indisponiveis_geram_falha_clara` e `test_detalhes_do_atendimento_ja_visiveis_sao_lidos_sem_navegar`, em `tests/test_sebrae_softexpert_browser.py` (linhas 713 e 673), ambos com `RotinaCancelada`. As demais etapas passaram: `node --test` 390 de 390, `node --check`, TypeScript gradual, `compileall`, mypy gradual (89 arquivos) e estrito (66 arquivos), varredura de credenciais.
- Causa dos dois erros, com evidência: existe o arquivo `data/state/automacao_chrome.cancelar` (25 bytes, criado em 04/11/2026 às 06:34:52, durante a janela do verify). Em `scripts/automacao_rotinas_chrome.py`, `cancelamento_pedido()` compara a data do arquivo com `_inicio_execucao`, que vale 0.0 até alguém iniciar uma rotina; com o arquivo presente, qualquer espera dessas funções lança `RotinaCancelada`. Reexecutando só `tests.test_sebrae_softexpert_browser` no ambiente real: os mesmos 2 erros (79 testes, 390 s). Reexecutando os dois testes com `CANCELAR_ARQUIVO` apontado, só em memória, para um caminho inexistente: os dois passam. Conclusão: os dois erros vêm de um arquivo de sinal em `data/`, não das mudanças visuais B1 a B5 (certeza alta). Quem criou o arquivo não está provado. O B5 passou no `verify` com código 0, então o arquivo não existia antes; a data dele (06:34:52) cai cerca de 30 s depois do início da minha execução (o `verify` durou 630,9 s e terminou às 06:44:51). Li as classes de teste que mexem no sinal: `ChromeAutomationHelpersTests` e `LoginAbasTests` (`tests/test_automacao_rotinas_chrome.py`) trocam `CANCELAR_ARQUIVO` por uma pasta temporária, e o `RunnerHarness` de `tests/test_chrome_automation.py` usa raiz temporária com runner de mentira (o POST de cancelar da linha 465 não toca `data/`). Para conferir de fato, rodei a suíte Python inteira duas vezes (por engano, as duas ao mesmo tempo) com um espião em memória em `Path.write_text` que bloqueava qualquer escrita em `data/state/automacao_chrome.cancelar`: 0 escritas nas duas execuções, e o arquivo real continuou com a data 06:34:52. Limites: o espião só vê escritas do mesmo processo (não vê subprocessos), e essas duas execuções não valem como `verify` (terminaram com 31 a 32 erros, provavelmente por rodarem juntas e dividirem a pasta `TEMP`; não investiguei). Portanto não há evidência de vazamento de isolamento nos testes; o escritor mais provável é algo fora da suíte (clique em cancelar no site ou no Assistente, `--cancelar` do script, ou outra sessão), mas isso é hipótese. Não removi o arquivo, porque `data/` não podia ser tocado. Para fechar: o dono remove o arquivo e roda `npm run verify` de novo; se o arquivo voltar mesmo sem ninguém cancelar nada, aí sim investigar o escritor.
- `npm run test:ui:e2e` (fixture manual parado antes, porta 8765 livre): código 0, 395 passaram, 2 ignorados, 0 falhas, 14,9 min. Igual à linha de base. Inclui o teste real de movimento reduzido (`ui.spec.cjs:516`) e o de anel de foco (`ui.spec.cjs:475`).
- `tests/frontend/test_dom_id_coverage.cjs`: 2 de 2 passaram. O `index.html` tem 655 IDs, nenhum duplicado.
- `tests/frontend/test_sebrae_dashboard_ui.cjs` reexecutado: 46 de 46.

### K2. Layout no navegador embutido (fixture na porta 8765)

Medido por script em 1440, 1024, 768, 375 e 390×844, tema escuro, nas abas Home, Transporte, Resumo, Automação, Chamados, OS, Comparação, Histórico de apelidos, Assistente e Catálogo de unidades: nenhuma rolagem horizontal (`scrollWidth <= innerWidth`) e nenhuma sobreposição real de texto. O tema claro foi conferido só em 1440 (Transporte, Home, Comparação) e nas varreduras de contraste; a varredura completa de layout por aba não foi repetida no claro.

Problema confirmado (fora da lista pedida, aba F9 Relatório mensal): em 375 e 390 px a linha de rótulos do gráfico (`.ck-graf__rotulos`) tem quatro colunas de cerca de 41 px e os textos se sobrepõem ("Oracle ·" com "Simpress"); a coluna lateral fica espremida e os cabeçalhos da tabela "Inventário por unidade" ficam cortados. Gravidade média, certeza alta. Não sei se já era assim antes do plano. Print: `.claude/prints/b6-final/relatorio-375-escuro-legenda-sobreposta.jpg`.

Console: só mensagens "Failed to load resource ... 404" e nenhuma exceção de JavaScript. Vi 404 em `/api/automacao/dashboard/agendamento` e `/api/assistente/estado`; não afirmo que apareceu `/api/usuarios-entra/estado` (a janela de rede que li tinha os últimos 200 de 268 pedidos, não tinha esse pedido). Os três caminhos são chamados por `static/js/features/chrome-automation.js` (linhas 668 e 680), `assistant-chat.js` (linha 1088) e `entra-users.js` (linha 21). O B1 a B5 só trocou um rótulo em `chrome-automation.js:12` e não mexeu nessas chamadas, e o servidor do fixture (`tests/support/serve_ui_motion_preview.py`) não implementa essas rotas. Portanto: anterior ao plano, o fixture não implementa as rotas; sem achado novo.

### K3. Teclado

Com teclas reais no navegador embutido: Tab percorre a Home (skip link, abas, busca, botões, filtros, menu de ferramentas, notificações, Assistente, tema) e o Transporte (painel e botões identificados por ID: `ck-link-os` e os demais; não li o texto visível de cada botão, então não registro rótulos aqui), com `:focus-visible` verdadeiro e anel `outline` ou `box-shadow` nos elementos que receberam foco. Exceção que vi: o `#input-serial` em si mostrou `outline: none` e nenhuma sombra; o anel dele fica no contêiner `.ck-busca__campo`, e isso só foi verificado pelo e2e, não por mim. No Assistente (F10), Tab entra nos botões de histórico, minimizar, maximizar, fechar, `assistente-tentar` e `assistente-nova` (por ID), todos com anel. F1 a F6 trocam Home, Transporte, Resumo, Automação, Chamados e OS (título do painel "Chamados" em F5 e "OS" em F6). Cor do anel no tema claro: `rgb(2, 132, 199)` em todos, que é o esperado em `ui.spec.cjs`. Exceção: o botão de ferramentas `#cockpit-tools-trigger` mostrou `rgb(112, 93, 198)` (roxo de destaque) no claro; o e2e não exige cor para ele, então é só uma inconsistência pequena. As larguras medidas vêm do zoom 1,25 do painel embutido: 1,6 px equivale a 2 px declarados e 2,4 px equivale a 3 px declarados (o link de pular conteúdo e todos os botões do Assistente mediram 2,4 px, ou seja, 3 px). O e2e confirma 2 px apenas para os seletores de `ui.spec.cjs:477-484`; não verifiquei por conta própria a largura declarada dos demais. Foco no tema escuro não foi percorrido tecla a tecla aqui; o e2e cobre os dois temas.

### K4. Contraste (WCAG, estilos computados)

Em 591 elementos por tema, nenhum texto abaixo de 4,5:1 nos dois temas. Aba ativa da Home no escuro: 11,52:1. Itens conhecidos abaixo de 3:1 continuam como antes: ponto do chip neutro 2,51:1; preenchimento "concluídos" do gráfico 2,74:1 (escuro) e 2,26:1 (claro); bordas de campo e botão secundário 1,27:1 (escuro) e 1,42:1 (claro); `--cor-texto-apagado` sobre a superfície 2,51:1. `--cor-destaque-forte` no escuro dá 3,05:1 sobre `--cor-destaque-fundo` (3,46 sobre a superfície, 3,78 sobre o fundo), usado só em borda e sombra. Nota nova: `--cor-destaque` sobre `--cor-destaque-fundo` dá 4,40:1 (escuro) e 4,36:1 (claro), mas nenhum texto usa esse par abaixo de 4,5.

### K5. Movimento reduzido

O navegador embutido não tem opção de emular `prefers-reduced-motion`. Simulei assim: copiei as regras dos 18 blocos `@media (prefers-reduced-motion: reduce)` da própria página para uma folha adotada e medi 9600 pares elemento/pseudoelemento. Antes: animações de 180 e 260 ms e transições de 180 e 260 ms. Depois: máximo de 0,01 ms em animações nomeadas e em transições (painéis, menus, notificações, Home, Resumo). É simulação, não emulação nativa; a emulação nativa é o teste `ui.spec.cjs:516`, que passou no e2e. Os dois resets (1 ms em `ck-tokens.css` e 0,01 ms em `ck-cockpit.css`) são deliberados.

### K6. Textos

Os cinco textos do B5 aparecem (Observações *, Faturamento, Rotina Completa, cabeçalhos do Resumo em caixa de frase com "Nome completo" na Home, aviso do Assistente de 20 palavras) e os antigos não. Termos aprovados do `AGENTS.md` intactos: Exportar Excel, 3+ dias na OS, Importar e gerenciar, No Endpoint, na Simpress, Planilha Exportada com Sucesso!, Chamados/OS.

### K7. Prints e o que não foi verificado

Prints em `.claude/prints/b6-final/`: Home 1440 claro, Transporte 1440 claro, Comparação 390 escuro, Histórico de apelidos 390 escuro, Automação 375 escuro, Assistente 375 escuro e o defeito do Relatório mensal. O painel embutido é pequeno, então os prints de 1440 mostram só o canto superior esquerdo; as medidas de layout vêm dos scripts, não dos prints. Não verificado: navegador real do usuário (Chrome), dados reais, dispositivos físicos, layout completo por aba no tema claro, `verify` limpo (falha de ambiente descrita em K1), fixture parado ao fim (porta 8765 livre; o fixture da porta 18765 é de outra sessão e não foi tocado).

## L. F9 (Relatório mensal no celular), em 04/11/2026

Correção pedida pelo usuário para o problema confirmado em K2. Só CSS e DOM (classes e `data-label`); nenhum texto mudou, então o Assistente de IA não é afetado. Nenhuma regra do `DESIGN.md` mudou.

### L1. O que mudou

- `static/styles/ck-cockpit.css`: nova regra em `@media (max-width: 767.98px)`, logo depois de `.ck-rel__detalhe > .ck-rel__largo`, que põe `.ck-rel__detalhe` em uma coluna (antes: duas colunas de cerca de 165 px, que esmagavam gráfico e tabela).
- `static/js/features/cockpit-tool-panels.js`, `unitsTable`: a tabela ganha a classe `ck-tabela--cards`, cada `td` ganha `data-label` (Cidade, Endereço, Equipamentos) e o endereço ganha `ck-td--largo`. A tabela vira cards no celular; no desktop segue tabela.

### L2. Verificação

- Playwright (Chromium) contra o fixture, com dados de exemplo (3 unidades, endereço longo), tema claro e escuro. Colunas do detalhe: 375 px, antes `168,5px 168,5px`, depois `351px`; 390 px, antes `176px 176px`, depois `366px`; 1366 px, `656px 656px` antes e depois. Sem rolagem horizontal em nenhum caso (`scrollWidth` = largura da janela).
- Nos prints de 375 px, os rótulos do gráfico deixam de se sobrepor e a tabela deixa de cortar os cabeçalhos.
- Desktop 1366×900: o detalhe continua em duas colunas. Comparei os prints antes/depois pixel a pixel: tema claro idêntico (0 pixels diferentes); tema escuro com 10 pixels diferentes, delta máximo 1/255, na caixa x 1132–1139, y 13–38, no cabeçalho, fora do relatório (ruído de anti-aliasing, não de layout).
- O "antes" foi reconstruído no próprio navegador, interceptando `ck-cockpit.css` e `cockpit-tool-panels.js` para remover a regra e o `data-label`; não é um checkout antigo.
- Larguras de tablet, 768 a 1199 px (medidas depois, com a mesma técnica de antes/depois, temas claro e escuro, janela de 1900 px de altura). Nessa faixa o detalhe segue em duas colunas, porque a regra de uma coluna vale só até 767,98 px, e a tabela de unidades vira cards dentro da coluna da esquerda (as regras `.ck-tabela--cards` valem abaixo de 1200 px). Colunas do detalhe, iguais antes e depois: 768 px, `357px 357px`; 900 px, `423px 423px`; 1024 px, `485px 485px`; 1199 px, `572,5px 572,5px`. Sem rolagem horizontal em nenhum caso (`scrollWidth` = largura da janela, nos dois temas). Rótulos do gráfico (`.ck-graf__rotulos`): quatro filhos de 89,3 / 105,8 / 121,3 / 143,1 px de largura, sem sobreposição (borda esquerda de cada um >= borda direita do anterior) e sem corte (`scrollWidth` <= `clientWidth`), antes e depois. Cards da tabela: nenhum `td` cortado nem com rolagem interna; o endereço, que no "antes" ficava numa coluna de 119 / 141 / 162 / 191 px (4 a 5 linhas a 768 e 900 px, 4 linhas a 1024 e 1199 px), passa a ocupar 331 / 397 / 459 / 547 px e quebra em 2 linhas a 768 px (altura do `td` 54 px, com o rótulo) e em 1 linha nas demais (36 px, com o rótulo). Resultado: nada pior que o "antes" e a leitura melhora, então a regra de uma coluna não foi alargada e o CSS ficou como estava.
- Larguras restantes, medidas em 04/11/2026 com a mesma técnica de antes/depois (Chromium, fixture na porta 8769, claro e escuro, janela de 1900 px de altura até 768 px e 1100 px acima disso; abaixo de 768 px com emulação de celular), com dois conjuntos de dados. O curto é o de exemplo (3 unidades). O longo tem uma cidade de 57 caracteres sem espaço (só hífens), um endereço de 141 caracteres com uma palavra de 57 caracteres sem espaço, outro endereço com uma palavra de 47 caracteres sem espaço e uma contagem de 7 dígitos (1.234.567). Larguras: 320, 360, 414, 480, 600, 700, 767, 768, 1440 e 1920 px.
  - Resultado do "depois": nas 40 combinações (10 larguras x 2 temas x 2 conjuntos) não houve rolagem horizontal da página (`scrollWidth` = largura da janela), filho do `.ck-rel__detalhe` com `scrollWidth` maior que `clientWidth`, elemento fora da janela, `td` ou `tr` com corte ou rolagem interna, texto de `td` fora da própria caixa, nem rótulo do gráfico sobreposto, cortado ou com texto fora da caixa. O único elemento com `scrollWidth` maior que `clientWidth` é o `thead` escondido dos cards (1 px, recortado de propósito, para leitores de tela). Claro e escuro deram as mesmas medidas.
  - Colunas do detalhe e largura de cada rótulo do gráfico, depois (antes entre parênteses): 320 px, 1 coluna de 296 px, rótulos de 74 px (antes 2 colunas de 141 px, rótulos de 35,3 px); 360 px, 336 px, rótulos de 84 px (161 px; 40,3 px); 414 px, 390 px, rótulos de 97,5 px (188 px; 47 px); 480 px, 456 px, rótulos de 114 px (221 px; 55,3 px); 600 px, 576 px, rótulos de 144 px (281 px; 70,3 px); 700 px, 676 px, rótulos de 169 px (331 px; 82,8 px); 767 px (borda), 743 px, rótulos de 185,8 px (364,5 px; 91,1 px). Em 768 px (borda) segue em duas colunas de 357 px, rótulos de 89,3 px, igual ao antes. Em 1440 px, duas colunas de 693 px, rótulos de 173,3 px; em 1920 px, duas colunas de 933 px, rótulos de 233,3 px; iguais ao antes.
  - O "antes" tinha defeito de verdade de 320 a 480 px, nos dois conjuntos: os quatro rótulos do gráfico (35,3 / 40,3 / 47 / 55,3 px de largura) ficavam com texto maior que a caixa e colidiam com os vizinhos, e a linha de rótulos tinha 63,8 px de altura (320 a 414 px). Depois, nenhum rótulo estoura, e a altura cai para 47,8 px (320 a 414 px) e 31,9 px (480 px ou mais). De 600 a 767 px o "antes" já não estourava, e o depois também não. O "antes" nunca teve rolagem horizontal da página, porque a tabela de largura fixa quebra as palavras em qualquer letra.
  - Cards da tabela de unidades, conjunto curto, largura x altura do `td` do endereço (antes -> depois): 320 px, 47 x 288,9 -> 270 x 54,2; 360 px, 53,7 x 288,9 -> 310 x 54,2; 414 px, 62,7 x 180,1 -> 364 x 36,1; 480 px, 73,7 x 180,1 -> 430 x 36,1; 600 px, 93,7 x 125,8 -> 550 x 36,1; 700 px, 110,3 x 107,6 -> 650 x 36,1; 767 px, 121,5 x 89,5 -> 717 x 36,1; 768 px, 119 x 89,5 -> 331 x 54,2; 1440 e 1920 px, tabela comum, 231 x 53,3 e 311 x 53,3, iguais.
  - Conjunto longo, altura do `td` do endereço de 141 caracteres (antes -> depois): 320 px, 723,9 -> 108,6 px; 360 px, 578,9 -> 72,3; 414 px, 506,4 -> 72,3; 480 px, 397,6 -> 72,3; 600 px, 270,8 -> 72,3; 700 px, 234,5 -> 54,2; 767 px, 216,4 -> 54,2; 768 px, 234,5 -> 72,3; 1440 px, 107,6 e 1920 px, 89,5, iguais. A palavra de 57 caracteres e a cidade de 57 caracteres quebram dentro do card (`overflow-wrap: anywhere` do `.ck-tabela td`), sem estourar, inclusive em 320 px (270 px úteis). Por isso nenhum CSS novo foi preciso: nada ficou quebrado por causa da F9 e nada ficou quebrado em 320 px.
  - Altura total da tabela de unidades, conjunto curto (antes -> depois): 320 px, 627,7 -> 492,7 px; 360 px, 555,2 -> 492,7; 414 px, 410,2 -> 474,6; 480 px, 373,9 -> 474,6; 600 px, 319,6 -> 474,6; 700 px, 265,2 -> 474,6; 767 px, 228,9 -> 474,6. De 414 a 767 px os cards ficam mais altos que a tabela espremida de antes (cada unidade usa três linhas empilhadas, mesmo com muita largura livre). Não é quebra de layout, mas é um custo de espaço que o "antes" não tinha; ver L4.
  - Desktop (1440 e 1920 px): as medidas de layout são idênticas antes e depois. Nos prints, longo 1440 claro, longo 1920 claro e longo 1920 escuro deram 0 pixels diferentes; longo 1440 escuro e curto 1440 escuro, 4 pixels com diferença máxima de 1/255 (x 687 a 688, y 13 a 14); curto 1440 claro, 13 pixels com diferença máxima de 19/255 (x 1339 a 1354, y 16 a 27). Todos ficam na faixa do cabeçalho, acima do relatório, fora da área alterada; não investiguei o que muda ali entre duas cargas.
  - Nenhum arquivo do projeto foi alterado nesta rodada (nem CSS, nem JS, nem teste). `node --test tests/frontend/test_cockpit_tool_panels.cjs tests/frontend/test_dom_id_coverage.cjs`: 23 de 23. O e2e do Playwright não foi rodado, porque não houve mudança de CSS nem de JS.
- `node --test tests/frontend/test_cockpit_tool_panels.cjs tests/frontend/test_dom_id_coverage.cjs`: 23 de 23.
- `npm run test:ui:e2e` (porta 8765 livre antes), rodado depois do teste novo abaixo: 397 passaram, 2 ignorados, 0 falhas, 13,7 min. Os 395 anteriores mais os 2 do teste novo (um por projeto, desktop e mobile).
- `npm run verify`, rodado em seguida: todas as etapas OK (1978 testes Python, `OK (skipped=2)`, 568 s; `node --test` 390 passaram, 0 falhas; sintaxe e tipos JS, `compileall`, mypy gradual e estrito, varredura de credenciais). Nessa rodada os testes de `tests/test_sebrae_softexpert_browser.py` passaram, porque o arquivo `data/state/automacao_chrome.cancelar` não existia mais.
- Teste novo em `tests/e2e/monthly-report.spec.cjs` ("the Cockpit report detail keeps one column and card rows on phones without horizontal scroll"): confere os `data-label` da tabela de unidades, 1 coluna abaixo de 768 px, 2 colunas a partir de 1200 px e ausência de rolagem horizontal. Passa em desktop e mobile (10 de 10 no arquivo). Sem a regra de 1 coluna falha no mobile (`["176px", "176px"]`); sem o `data-label` falha nos dois. Não cobre 768 a 1199 px nem endereço longo.

### L3. Prints

`.claude/prints/f9-relatorio-mobile/`: `antes-` e `depois-` em 375 e 390 px, claro e escuro, mais 1366 px (claro e escuro) para o desktop. Os de celular usam janela alta (1900 px) para mostrar o detalhe inteiro. Os de tablet (768, 900, 1024 e 1199 px, claro e escuro, `antes-` e `depois-`) ficam em `.claude/prints/f9-relatorio-mobile/tablet/`, também com janela de 1900 px de altura. Os das demais larguras ficam em `.claude/prints/f9-relatorio-mobile/larguras/` (36 arquivos, 4,3 MB), nomeados `<conjunto>-<antes|depois>-<largura>-<tema>.png`: conjunto `longo` em 320, 414, 600, 767, 1440 e 1920 px (24 arquivos) e conjunto `curto` em 320, 767 e 1440 px (12 arquivos), sempre em claro e escuro, antes e depois. Até 768 px a janela tem 1900 px de altura; em 1440 e 1920 px, 1100 px. Cada print começa no topo do `.ck-rel__detalhe`.

### L4. Não verificado

Chrome real do usuário, dispositivos físicos (a emulação de celular do Playwright só ajusta janela, agente e toque), Firefox e Safari (só medi Chromium), dados reais do relatório (só o fixture e os dois conjuntos de L2), tamanho de fonte ou zoom do navegador diferente do padrão e celular na horizontal.

Larguras sem medida: as que ficam entre os pontos medidos (por exemplo 321 a 359, 361 a 413, 415 a 479, 481 a 599, 601 a 699, 701 a 766 e 769 a 1439 px), 1200 px exatos e os valores fracionários nas fronteiras (767,98 e 1199,98 px). Considerei o comportamento contínuo entre os pontos, mas isso não foi testado. Em 769 a 1199 px, os pontos 900, 1024 e 1199 px foram medidos só com o conjunto curto; o conjunto longo foi medido apenas em 768 px dentro dessa faixa.

Casos sem teste: muitas unidades (30 ou mais linhas na tabela), cidade ou endereço vazios (o código mostra "—" no endereço), `linhas` de comparação e de ordens preenchidas (vazias no fixture) e a prévia para a gestão aberta.

Sem avaliação de uso: de 414 a 767 px os cards ficam mais altos que a tabela de antes (474,6 px contra 228,9 px em 767 px), porque cada unidade empilha três campos mesmo com muita largura livre. Não é quebra de layout; usar mais colunas por card nessa faixa seria uma melhoria possível, não pedida.

`npm run verify` e o e2e do Playwright não foram rodados nesta rodada; a pendência dos 2 erros `RotinaCancelada` (K1) continua.
