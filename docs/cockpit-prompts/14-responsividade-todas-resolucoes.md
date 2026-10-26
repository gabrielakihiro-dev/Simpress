# Prompt 14 — Responsividade do Cockpit de 320px a 2560px

Este documento é a especificação das Fases 2 a 6 da responsividade. Ele **substitui** a regra antiga de `min-width:1200px` com rolagem horizontal da página (prompts 03 e 12 e README).

## Regra universal: identidade com o artefato

O layout fica **exatamente idêntico** ao artefato do Cockpit (https://claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC) em composição, medidas, cores, tipografia, espaçamentos, rótulos e estados.

- **Amplo (1200px ou mais):** idêntico ao artefato, nas medidas CSS. A responsividade não altera nada nessa faixa.
- **Médio e compacto:** o artefato não mostra essas faixas. Use os mesmos componentes, cores, fontes, espaçamentos e rótulos; mude só a disposição (empilhar, recolher, virar card). Não invente estilo novo.
- Diferença no amplo sem justificativa é defeito e deve ser registrada no relato da fase.

> Observação da Fase 1: a referência é o artefato original acima. A leitura pela ferramenta devolve só uma tela de carregamento ("Unpacking..."), sem o layout; as medidas do amplo vêm do plano aprovado e do código atual, e a comparação visual fica para as fases seguintes.

## Faixas (iguais em todos os CSS)

| Faixa | Largura | Media query |
| --- | --- | --- |
| compacto | até 767px | `@media (max-width: 767.98px)` |
| médio | 768 a 1199px | `@media (min-width: 768px) and (max-width: 1199.98px)` |
| amplo | 1200px ou mais | `@media (min-width: 1200px)` |

`@media` não aceita variáveis CSS: repita os valores e documente as faixas num comentário no topo de cada CSS alterado. Cobertura: 320px a 2560px, inclusive celular em paisagem e telas baixas (altura de 390 a 500px). Nenhuma página tem rolagem horizontal: `scrollWidth <= clientWidth` em `html` e `body`.

## Medidas que não mudam no amplo (pixels CSS)

- barra superior: 48px
- lista da Home: 360px
- painel "Chamados abertos": 300px
- busca da barra: `flex: 0 1 240px; min-width: 120px` (valor do artefato original; antes constava `clamp(220px, 23vw, 340px)`, que difere do artefato; o 427px de um diagnóstico veio de zoom do Windows)

## Composição por tela e faixa

### Barra superior
- **Amplo:** logo, abas (Home, Transporte, Resumo, Automação), busca, chips e status, notificações, ferramentas (nove pontos) e tema, numa linha de 48px.
- **Médio:** mesma linha; a busca encolhe (`flex: 0 1 240px; min-width: 120px` (como no artefato)) e chips/status ficam compactos, sem passar da borda.
- **Compacto:** abas e busca na linha; chips e status vão para um menu acessível (botão com `aria-expanded` e `aria-controls`, fecha com Esc). `#notification-center-panel` e `#cockpit-tools-trigger` continuam funcionando; nenhuma ação se perde.

### Home
- **Amplo:** lista de 360px, detalhe ao lado; modelos de chamado com o painel "Chamados abertos" (`.cockpit-home-open-tickets`, 300px) ao lado.
- **Médio:** lista com `clamp()` e detalhe; "Chamados abertos" desce para baixo dos modelos de chamado.
- **Compacto:** uma coluna; navegação lista → detalhe com botão "Voltar"; "Chamados abertos" abaixo dos modelos.
- Altura em `dvh` descontando a barra (no lugar de `calc(100vh - 48px)`/`calc(100dvh - 48px)`). Em telas baixas (844×390), rolagem interna, sem `overflow:hidden` escondendo conteúdo.

### Transporte
- **Amplo:** três colunas (hoje `minmax(310px, 26vw)` na lateral).
- **Médio:** a coluna lateral desce para baixo do formulário.
- **Compacto:** uma coluna.

### Resumo
- **Amplo:** KPIs e tabela como hoje.
- **Médio:** KPIs com `repeat(auto-fit, minmax(150px, 1fr))`.
- **Compacto:** KPIs em auto-fit; a tabela vira cards com os mesmos dados e ações (rótulo + valor via `data-label`).

### Automação
- **Amplo:** controles e console lado a lado (hoje `minmax(330px, 32vw)`).
- **Médio e compacto:** uma coluna, console depois dos controles. A sincronização Sebrae continua acessível, mesmo recolhida.

### Painéis Chamados, Comparação, Histórico de apelidos e Relatório mensal
- **Amplo:** faixa de KPIs, pílulas de filtro, tabela densa e detalhe lateral de 380–420px.
- **Médio:** detalhe desce para baixo da tabela; pílulas quebram linha.
- **Compacto:** cada linha da tabela vira card (rótulo + valor via `data-label`), com as mesmas ações. Anotações do histórico continuam editáveis e salvando. Textos com ellipsis mantêm o valor completo em `title` ou `aria-label`. O `@media` de 760px de `cockpit-tool-panels.css` passa a usar as faixas comuns; o Histórico de apelidos alinha o ponto de 1200px às faixas (ou justifica manter).

### Modais e overlays
`max-height: 100dvh` com rolagem interna, botões sempre alcançáveis, respeito a `env(safe-area-inset-*)`, em todas as faixas.

### Toque, telas largas e baixas
- `@media (pointer: coarse)`: alvos de 44px.
- Compacto: inputs com 16px (iOS não dá zoom).
- 1920px ou mais: largura útil limitada com `max-width` e centralizada; até 2560px nada estica.
- Telas baixas (844×390 e 1024×500): todo conteúdo e botão alcançáveis por rolagem (Home e Automação).

## Plano por fase (um commit por fase, sem push)

1. Especificação e prints "antes" (este documento).
2. Barra superior e Home; remover `min-width:1200px` do shell e da Home e `overflow-x:auto` do `html`; teste e2e parametrizado em 320, 390, 768, 1024, 1200, 1440 e 1920px.
3. Transporte, Resumo e Automação; trocar `calc(100vh - 48px)` em `cockpit-pages.css`.
4. Painéis de ferramenta e modais.
5. Toque, telas largas e baixas; incluir 2560px no teste parametrizado.
6. Prints "depois", tabela antes/depois e relato final.

Regras de toda fase: preservar IDs, ARIA, `data-*`, handlers, foco e os temas claro/escuro; só tokens de cor existentes; animações de 150 a 300ms com `prefers-reduced-motion`; sem `innerHTML` com dados de API, log ou planilha; textos aprovados inalterados; testes afetados atualizados na mesma fase.

## Diagnóstico "antes" (Fase 1)

Medido no commit `044fdcc` com o `ui-fixture`: elementos visíveis cuja borda direita passa da largura da janela. Prints em `.claude/prints/responsividade/antes-<tela>-<largura>-<light|dark>.png` (fora do Git). Valores: claro / escuro.

| Tela | 390×844 | 768×1024 | 1024×768 | 1200×800 | 1440×900 |
| --- | --- | --- | --- | --- | --- |
| Home | 138 / 142 | 127 / 131 | 47 / 51 | 0 / 0 | 0 / 0 |
| Transporte | 348 / 352 (página com 1046px) | 237 / 241 | 85 / 89 | 0 / 0 | 0 / 0 |
| Resumo | 235 / 239 | 206 / 210 | 87 / 91 | 0 / 0 | 0 / 0 |
| Automação | 297 / 301 | 238 / 242 | 77 / 81 | 0 / 0 | 0 / 0 |
| Painel Chamados | 179 / 183 | 159 / 163 | 0 / 0 | 0 / 0 | 0 / 0 |
| Painel Comparação | 164 / 168 | 144 / 148 | 0 / 0 | 0 / 0 | 0 / 0 |
| Painel Histórico de apelidos | 156 / 160 | 139 / 143 | 0 / 0 | 0 / 0 | 0 / 0 |
| Painel Relatório mensal | 181 / 185 | 141 / 145 | 0 / 0 | 0 / 0 | 0 / 0 |

Leitura: o diagnóstico anterior se confirma (138 a 352 em 390px; 127 a 242 em 768px; 47 a 91 em 1024px; zero a partir de 1200px). Nos painéis de ferramenta a 1024px a contagem é 0 porque o painel preenche a janela. Em 390px o Transporte estica a página para 1046px (`scrollWidth`). O 844×390 não foi capturado nesta fase (altura baixa é tratada na Fase 5).

Causas: `#simpress-app-shell.cockpit-shell { min-width: 1200px }` (`static/styles/cockpit-shell.css`, ~linha 16), `min-width: 1200px` no split da Home (`cockpit-home.css`, ~linha 617), `html:has(> .cockpit-shell-body) { overflow-x: auto }`, e só `cockpit-tool-panels.css` tem `@media` de largura (760px).

Método: Playwright/Chromium contra o `ui-fixture` (porta 8791); contagem por `getBoundingClientRect().right > clientWidth + 1` em todo elemento visível do `body`, fora de `[hidden]`.

## Fidelidade ao artefato (Fase 6)

Fonte: `artefato.html` (Nocturne, só escuro). Medido a 1440px (amplo, onde o app deve ser igual ao artefato) com `getComputedStyle` no `ui-fixture`; o claro mantém a mesma estrutura com os tokens claros. Prints em `.claude/prints/fase6/` (fora do Git).

| Área | Artefato | App antes | App agora | Situação |
| --- | --- | --- | --- | --- |
| Tokens (cores, raios, sombras, rampas) | Nocturne | `--cockpit-*` diferentes | alinhados em `nocturne.css` (escuro e claro) | idêntico |
| Barra superior | 48px, abas 32px/13px/500, busca h32, chips | abas 40px | idêntico às medidas do artefato | idêntico |
| Botões (`.btn`) | h30, 14px/500, raio md, primário contornado | h36, 12px/600, primário preenchido | h30, 14px/500, contornado em acento; `.btn-sm` h26; `.btn-icon` 36×36 | idêntico |
| Home: lista | itens, pílulas 24px, estado | diferentes | alinhados | idêntico |
| Home: detalhe | cabeçalho em uma linha, grade com bordas internas e sombra, copiar 24×24, valores com reticências | ícone 40px, título empilhado, copiar 16×40 | uma linha, grade com bordas internas, copiar 24×24, reticências | idêntico nas medidas; composição de "Modelos de chamado" e "Chamados abertos" aproximada |
| Transporte: campos | rótulo 11px, campo 30px/12.5px | campo 36–42px/14px | 30px/12.5px, rótulo 11px | campos idênticos; 3 colunas `1fr 1fr 400px` já existentes |
| Resumo | KPIs 22px/500, rótulo 11.5px, cabeçalho 13px/500, tabela 12.5px, regionais 100px · 5px | idêntico em medidas e tipografia | idêntico (tokens) | sem sparkline nos KPIs (dado real não existe) |
| Automação | títulos 13px/500, botões 28px/12px, tabela 12.5px, console em surface | idêntico em medidas e tipografia | idêntico (tokens) | o app tem mais controles que o artefato (filtros, capturas, Sebrae), mantidos |
| Painéis de ferramenta, modais, notificações | sem equivalente no artefato | — | estilo atual com os tokens novos | sem equivalente: mantidos |

Limites: comparação feita em tela cheia no navegador embutido (artefato em https://claude.ai/artifact/…, iframe de domínio cruzado, então só por imagem, sem `getComputedStyle`). O artefato é somente escuro: o claro é derivado dos tokens. Capturas do app em `.claude/prints/fase6/`: Home 1440 e 1200 claro/escuro; Resumo e Automação 1440 claro/escuro; Transporte 1440 escuro.

### Tipografia (Fase 6, `getComputedStyle` a 1440px, escuro e claro iguais)

Famílias: o artefato usa `"Inter", system-ui, sans-serif` e `'JetBrains Mono', ui-monospace, monospace`. O app agora usa as mesmas pilhas. Como o artefato só carrega `"Inter"` e `"JetBrains Mono Variable"`, o `'JetBrains Mono'` dele cai em `ui-monospace`; o app copia a pilha literal, então renderiza igual a ele. `document.fonts` confirma `Inter` (alias novo em `nocturne.css`, mesmos arquivos locais) e `Inter Variable` carregadas.

| Componente | Artefato | App agora (família · tamanho · peso · entrelinha · espaçamento) |
| --- | --- | --- |
| Aba da barra | 13px/500 | Inter · 13px · 500 · 18.85px · normal |
| Busca | 12.5px | Inter · 12.5px · 400 · 18.1px · normal |
| Série do detalhe | mono 18px/500 | mono · 18px · 500 · 27.9px · normal |
| Tags do detalhe | 11px, 0.02em | Inter · 11px · 400 · 15.95px · 0.22px |
| Modelo | 13px | Inter · 13px · 400 · 1.45 · normal |
| Rótulo da grade | 11px | Inter · 11px · 400 · 14.85px · normal |
| Valor / valor mono | 13px | 13px (Inter / mono) |
| Pílulas de modelo | 12px | Inter · 12px · 400 |
| Textarea de modelo | 12.5px | Inter · 12.5px · 400 · 20.6px |
| Títulos h1–h5 | 500, entrelinha 1.12, -0.015em | regra base no shell (`:where`, não vence regras de componente) |
| Cabeçalho de tabela (Resumo) | 11px, 0.08em, caixa alta | 11px · 0.08em · caixa alta |

Diferenças restantes: painéis, modais e notificações não existem no artefato; filtros da lista medem 11.5px/24px e botões 14px/500, iguais ao artefato.

Ajustes de fechamento da Fase 6:

- Campo de busca da barra: 12.5px (valor do artefato) no amplo; 16px no compacto (anti-zoom do iOS).
- Barra compacta (≤767px, toque): a marca fica visível a partir de 390px; abaixo de 390px ela sai da barra (4 abas de 44px não deixam largura), mudança deliberada e só de layout.
- Prova visual: o artefato foi aberto renderizado no navegador embutido e comparado com o app (porta 8803) a 1440px. Medidas base do artefato: corpo Inter, botão 13px/500, campo 12.5px, iguais ao app. Capturas do app em `.claude/prints/fase6/`.

### Painéis, sino, menu e modais (Fase 6, fechamento)

No artefato, Chamados, Comparação, Histórico de apelidos e Relatório mensal são telas inteiras (KPIs, pílulas de 24px, tabela de 12.5px, detalhe lateral de 380–420px em surface), a central de notificações é um popover de 340px, o menu Ferramentas tem 240px e o diálogo tem 440px.

| Área | Artefato | App agora | Situação |
| --- | --- | --- | --- |
| KPIs dos painéis | 22px/500, rótulo 11.5px, padding 12×16 | igual (`cockpit-tool-panels.css`) | idêntico |
| Pílulas de filtro | 24px, 11.5px, raio sm, sem borda | igual | idêntico |
| Tabela/lista e detalhe | 12.5px, detalhe em surface, linha do tempo com ponto de 9px | igual | idêntico nas medidas; o app usa lista/botões, não `<table>` |
| Cabeçalho "Ferramentas do Cockpit" e botão Voltar | não existe | mantido com os tokens novos | sem equivalente |
| Barra de busca/Relação/Atualizar dos painéis | não existe | mantida | sem equivalente |
| Sino (popover) | 340px, padding 6, raio sm, título 11px | igual; alertas viram itens de 12.5/11.5px | idêntico nas medidas |
| Menu Ferramentas | 240px, itens 34px, atalho 10.5px | já alinhado na barra | idêntico |
| Modais | fundo neutral-900 50%, raio lg, surface, sombra lg | igual (fundo, raio, surface, sombra); conteúdo interno de cada modal mantido | parcial: o app tem dezenas de modais com layouts próprios |

Limite desta comparação: o painel do navegador embutido só renderiza cerca de 800×500px do artefato (iframe de outro domínio, sem DOM), então não foi possível um print lado a lado a 1440px; a comparação é por medidas do `artefato.html` e capturas do app em `.claude/prints/fase6/` (Home, notificações, Ferramentas, Chamados e Comparação, 1440px, claro e escuro).

### Decisão sobre toque e telas muito largas (herdadas da Fase 5)

Ficam. As regras `@media (pointer: coarse)` (alvos de 44px) só valem em aparelhos de toque, e o `max-width: 1920px` só vale a partir de 1920px de largura; nenhuma das duas muda o desktop de mouse entre 1200 e 1919px, onde o app deve ser idêntico ao artefato. O artefato não mostra esses casos, então não há contradição; cobertas por `tests/e2e/cockpit-layout.spec.cjs`.

### Desvios deliberados do artefato por contraste e tema claro (Fase 6)

- Cabeçalho da tabela do Resumo no tema claro usa `--cockpit-text-subtle`: a mistura de 60% do artefato (que é só escuro) dá contraste 4,05:1 no claro e reprova AA.
- O total do Histórico de apelidos (`#total-historico-apelidos`) saiu dos tokens azuis antigos e usa o accent do Cockpit (4,21:1 no escuro reprovava AA).
- O fundo dos modais no tema claro usa o texto do Cockpit a 45% (o `neutral-900` do claro é quase branco e viraria um véu claro, não um escurecimento).
- Verificado com axe (claro e escuro, 1440px) em Resumo/Home, Chamados, Comparação, Histórico de apelidos, Relatório mensal e no modal do histórico: sem violações. A central de notificações e os demais modais ficaram fora do axe.

## Resultado da responsividade (Fase 7)

Medido no `ui-fixture` (porta 8811), Playwright/Chromium, mesmo método do diagnóstico "antes" (elementos visíveis com borda direita além de `clientWidth + 1`). Prints em `.claude/prints/responsividade/depois-<tela>-<largura>-<light|dark>.png` (80 arquivos, fora do Git). Valores: claro / escuro.

| Tela | 390×844 | 768×1024 | 1024×768 | 1200×800 | 1440×900 |
| --- | --- | --- | --- | --- | --- |
| Home | 138 / 142 → 0 / 0 | 127 / 131 → 0 / 0 | 47 / 51 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Transporte | 348 / 352 → 0 / 0 | 237 / 241 → 0 / 0 | 85 / 89 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Resumo | 235 / 239 → 0 / 0 | 206 / 210 → 0 / 0 | 87 / 91 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Automação | 297 / 301 → 2 / 2 (*) | 238 / 242 → 0 / 0 | 77 / 81 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Painel Chamados | 179 / 183 → 0 / 0 | 159 / 163 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Painel Comparação | 164 / 168 → 0 / 0 | 144 / 148 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Painel Histórico de apelidos | 156 / 160 → 0 / 0 | 139 / 143 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |
| Painel Relatório mensal | 181 / 185 → 0 / 0 | 141 / 145 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 | 0 / 0 → 0 / 0 |

(*) Dois `<th>` do cabeçalho da tabela de execuções da Automação a 390px. Em `ux-refinements.css` (~linha 672) o `thead` fica oculto só visualmente (1px, `clip`) quando a tabela vira cards; os `<th>` continuam para leitores de tela e não aparecem. Falso positivo da contagem: `scrollWidth` do `html` e do `body` é igual a `clientWidth`.

### Verificações da Fase 7

- **Rolagem horizontal, 320 a 2560px:** 20 larguras (320, 360, 390, 414, 480, 600, 767, 768, 820, 1024, 1100, 1199, 1200, 1280, 1440, 1600, 1919, 1920, 2200, 2560) × 8 telas × 2 temas = 320 checagens; `scrollWidth <= clientWidth` em `html` e `body` em todas.
- **Console:** sem erros de JavaScript. Único aviso: `404` em `GET /api/usuarios-entra/estado`, a rota existe no app (`routers/entra_users.py`), mas o `ui-fixture` não registra esse router (limite do fixture, não do app).
- **Foco por teclado:** 40 `Tab` a partir do topo em 390px e 1440px, nos dois temas; os 38 elementos focados em cada caso têm anel de foco visível (outline ou sombra).
- **Contraste:** `tests/e2e/color-contrast.spec.cjs` passou (claro e escuro). Suíte e2e completa (`npm run test:ui:e2e`, porta 8812): 238 passed, 1 skipped, 0 failed. `npm run verify`: tudo OK.
- **Movimento reduzido:** com `prefers-reduced-motion: reduce`, nenhum elemento de Home, Resumo, Automação, Chamados e Comparação tem transição ou animação acima de 1ms.
- **Comparação com o artefato:** o link https://claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC foi aberto no navegador embutido (renderiza, mas o painel mostra só ~800×600px, iframe de outro domínio: só captura de tela, sem `getComputedStyle`; o artefato é só escuro). Comparado por imagem com `depois-home-1440-dark` e `depois-home-1200-dark`: mesma composição (barra de 48px com marca, 4 abas, busca com Ctrl+K, status e chips, ícones; lista de 360px com filtros em pílulas; detalhe à direita), mesmas cores e tipografia. Diferenças esperadas: o artefato usa dados de exemplo (o fixture tem 1 equipamento) e exibe controles do host ("Entrar", "Compartilhar", selo "Made with Claude Design"). Resumo e Automação foram conferidos nas medidas do `artefato.html` na Fase 6; esta fase não alterou CSS nem HTML, então as medidas são as mesmas. Sem diferença nova no amplo. Pelo link também foi comparada a aba Resumo (captura a ~800×600px) com `depois-resumo-1200-dark`: mesma faixa de 5 KPIs com o quarto selecionado e sublinhado em acento, título "Divergência de localidade" com Regional/Exportar, cabeçalho da tabela em caixa alta e coluna "Ativos por regional" com barras. Diferenças: o artefato tem sparklines nos KPIs e dados de exemplo (já registrado na Fase 6: sem dado real para sparkline); o app mantém blocos que o artefato não tem ("Resumo do parque", "OS por equipamento"). Automação e os painéis de ferramenta não foram reabertos pelo link nesta fase.
- **Não verificado:** aparelho físico de toque, dados operacionais reais, rotinas Oracle/UX/SoftExpert/Endpoint e CDP 9333 (fora do escopo).

### Comparação com o artefato real via Windows UI Automation (Fase 7, complemento)

- Janela comparada: "Design form project – Claude artifact" (Chrome, 1920x988 físicos, escala 125% = 1536 px CSS). Foram lidas, pela árvore de acessibilidade, as telas Home, Transporte, Resumo e Automação; cada mapa só foi salvo depois de confirmar um texto próprio da tela (Home "Todos", Transporte "Retirada", Resumo "Total de ativos", Automação "Rotina de OS"). A árvore do Chrome atualiza com atraso de alguns segundos depois do clique, então a primeira leitura mostrava a tela anterior. Mapas e capturas ficam em `.claude/prints/responsividade/artefato-uia/`, fora do Git.
- Medidas do app a 1536x746 contra o artefato (dividindo o artefato por 1,25): barra 48 px nos dois; abas 32 px de altura nos dois; busca 240x32 no app. Diferença confirmada: as abas do app têm ícone antes do texto, o artefato não; largura Home 74 contra 60 px, Transporte 105 contra 91, Resumo 87 contra 73, Automação 108 contra 94 (cerca de 14 px a mais por aba). Não corrigido nesta fase.
- Não comparadas por esse método: menu Ferramentas aberto, popover do sino e modais.
