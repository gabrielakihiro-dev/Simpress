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
| Resumo, Automação, painéis de ferramenta, modais, notificações | ver artefato | — | herdam tokens e botões novos | **não** revisados linha a linha |

Limites: não foi feita a comparação lado a lado automática do iframe do artefato (domínio cruzado: só imagem); Resumo, Automação, painéis, modais e notificações receberam apenas tokens e botões, sem medição individual.
