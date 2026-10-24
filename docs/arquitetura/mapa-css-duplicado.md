# Mapa de CSS duplicado e `!important`

Relatório de leitura (item 7 da auditoria do front-end). **Nenhum CSS foi alterado.** Serve de guia para limpezas futuras, uma por vez, com prints antes/depois (skill `ajuste-visual-ui`).

## Resumo em linguagem simples

O CSS do Simpress está em 6 arquivos (`static/app.css` e cinco em `static/styles/`), carregados nesta ordem em `static/index.html`: `tokens.css`, `app.css`, `ui-motion.css`, `sidebar-navigation.css`, `theme.css`, `ux-refinements.css`. **Quem vem depois vence** quando duas regras empatam.

Resultado da varredura: o CSS está em bom estado. Há ~1.300 regras e só ~18 seletores repetidos de forma relevante. Exemplo do dia a dia: a regra `.header-inner` existe em `app.css` (layout em grade) e de novo em `sidebar-navigation.css` (layout flex). Hoje vale a segunda, porque carrega depois; a primeira é "código morto parcial" que confunde quem lê, mas não quebra nada.

Ou seja: **não há urgência**. A limpeza é de manutenção, não de bug.

## Como foi medido

Script descartável (não está no repositório) que lê os 6 arquivos, separa regras por seletor e contexto (`@media`), e compara propriedades repetidas. Limites: não resolve `@layer`, nem cascata real por especificidade, nem uso de classes no JS/HTML; por isso "duplicado" aqui significa **candidato**, não "pode apagar".

Números: 1.301 regras, 1.233 combinações únicas de seletor+contexto, 17 repetidas entre arquivos, 47 repetidas dentro do mesmo arquivo (a maioria sem propriedade em comum, ou seja, só complementam uma à outra).

## Lista priorizada

Risco = chance de mudar a aparência ao mexer. Todos os itens exigem prints claro/escuro, desktop/mobile.

| # | Seletor | Onde | O que acontece | Risco | Sugestão |
|---|---------|------|----------------|-------|----------|
| 1 | `.header-inner` (e a versão `@media (max-width: 640px)`) | `app.css:186` e `:847` vs `styles/sidebar-navigation.css:491` e `:781` | Duas definições de layout do cabeçalho (grid vs flex), com `min-height` e `padding` diferentes. Vence `sidebar-navigation.css`. | Médio (cabeçalho aparece em todas as telas) | Manter só a de `sidebar-navigation.css`; apagar a de `app.css` depois de conferir o mobile. |
| 2 | `.header-base-summary` | `app.css:269` vs `sidebar-navigation.css:526` | A segunda desfaz `grid-column`, `grid-row`, `justify-self` da primeira. Existem só para serem anuladas. | Médio | Mesmo pacote do item 1: apagar o original em `app.css` e a anulação. |
| 3 ✅ removido | `.site-header` | `app.css:191` vs `sidebar-navigation.css:503` | `z-index` repetido com o mesmo valor. | Baixo | Remover a repetição de `sidebar-navigation.css:503`. |
| 4 ⏸ mantido | `.alias-history-page-button` | `app.css:1197` e `app.css:1323` | Mesma regra duas vezes no arquivo; `min-height` 2,65rem é sobrescrito por 2,4rem. | Baixo | Fundir em uma regra. |
| 5 ⏸ mantido | `.alias-history-table tbody` / `td` (`@media 1200px`) | `app.css:1348-1349` | Duas regras adjacentes, propriedades diferentes. | Baixo | Fundir (só legibilidade). |
| 6 ✅ removido | `.automation-history-table td` (`@media 40rem`) | `ux-refinements.css:677` e `:679` | `display: block` e depois `display: grid` no mesmo seletor; vale o último. | Baixo | Remover `td` da regra do `:677`. |
| 7 | `html[data-theme="light"]` | `tokens.css:363` e `theme.css:7` | Tokens do tema claro divididos em dois arquivos (propriedades diferentes). | Baixo | Só mover para um lugar; não mexer sem teste dos dois temas. |
| 8 | `:root` | `app.css:107`, `tokens.css:13`, `sidebar-navigation.css:2` | Variáveis/`color-scheme` espalhadas em três lugares. | Baixo | Centralizar em `tokens.css`. |
| 9 | `#readiness-panel:not([open]) > .readiness-panel-summary` (mobile) | `app.css:966` e `ux-refinements.css:709` | Propriedades diferentes, complementares. | Baixo | Deixar como está ou juntar. |
| 10 | `.ui-toast` | `ui-motion.css:30` e `ux-refinements.css:264` | Propriedades diferentes (movimento vs aparência). | Baixo | Deixar: a divisão é intencional (movimento reduzido). |

Itens com seletores como `button`, `select`, `input`, `summary`, `.glass-input` em `app.css` e `ui-motion.css` não são duplicação: um define aparência e o outro só transição.

Observação: o script também apontou várias repetições em `theme.css:82` (`[class*="bg-cyan-"]` etc.). É falso positivo do leitor simples (seletores dentro de `:is(...)`), não duplicação real.

## `!important` (17 declarações em 2 blocos)

Nenhuma deve ser removida de forma mecânica (regra do `AGENTS.md`).

1. **`ux-refinements.css:46-56` (9 declarações), `button[data-copy-state="copied|warning|error"]`.** Justificado: o próprio arquivo comenta que o `!important` existe para vencer as classes utilitárias do Tailwind no estado transitório de "copiado". Manter.
2. **`app.css:1265-1289` (8 declarações), classes `.alias-history-*` (cores e `vertical-align`).** Sem justificativa em comentário. Provável causa: vencer estilos de tabela/Tailwind carregados antes. Candidato a revisão: descobrir quem a regra está vencendo, aumentar a especificidade do seletor (ex.: `.alias-history-table .alias-history-date`) e só então tirar o `!important`. Risco médio: o histórico de apelidos tem teste e2e (`tests/e2e/alias-history.spec.cjs`) e deve ser rodado.

Se não fizer: nada quebra, só fica mais difícil sobrescrever essas cores no futuro. Se fizer: o CSS fica previsível, desde que verificado nos dois temas.

## Limpeza aplicada (branch `claude/css-limpeza-baixo-risco-item7`)

Só dois itens provadamente sem efeito foram removidos:

- **Item 3:** apagado `.site-header { z-index: var(--z-header); }` de `sidebar-navigation.css`; `app.css` já define exatamente o mesmo valor.
- **Item 6:** em `ux-refinements.css`, tirado `.automation-history-table td` da lista de `display: block`; a regra seguinte (mesma `@media`, mesma especificidade) já o trocava por `display: grid`.

Mantidos de propósito:

- **Item 5:** tirar `tbody` da lista com `td` e `tr` também removeria o `width: 100%` do `tbody`; então não é idêntico.
- **Item 4:** fundir exigiria checar as regras entre as linhas 1197 e 1323; só ganho de leitura.
- **Itens 1 e 2 (risco médio) e `!important`:** não tocados.

Verificação: prints antes/depois do cabeçalho, do histórico de apelidos e da tabela de Automação, desktop (1366x900) e mobile (390x844), tema claro e escuro (12 pares), mais estilos computados dos elementos afetados. 11 pares ficaram idênticos byte a byte; o 12º (Home, mobile, claro) difere só porque a captura pegou a transição do tema (ruído, repetível com o mesmo código).

## Ordem sugerida

1. Itens 3, 4, 5, 6 (baixo risco, ganho pequeno), num PR só.
2. Itens 1 e 2 juntos (cabeçalho), com prints desktop e mobile nos dois temas.
3. `!important` do histórico de apelidos (bloco 2), com e2e.
4. Itens 7 e 8 só se houver razão para reorganizar tokens.

## O que não foi verificado

- Nenhuma regra foi testada no navegador; "vence o último" parte da ordem dos `<link>` no HTML e da regra de empate de especificidade.
- Não foi checado se as classes ainda são usadas no HTML/JS (CSS morto inteiro).
- Não foram analisados `static/vendor/*.css` (Tailwind e fontes) nem regras dentro de `@layer`.
