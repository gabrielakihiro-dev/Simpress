# Plano: barra de abas do topo no Novo layout (opção C)

Escrito em 18/11/2026 pela sessão "Desenhar barra de abas no Novo layout". Só código de interface (CSS, marcação do topo, testes e doc); nenhuma regra de negócio, API ou dado muda.

## Fonte do desenho (aprovada pelo usuário em 18/11/2026)

- Canvas "Novo layout": https://claude.ai/artifact/2txBkhk2PDgyh1cr35zcED (v51). Quadros `NL-Abas-C` (desktop, tema escuro e claro, demos de hover, foco e menu aberto) e `NL-Abas-C-cel` (celular). Leia os arquivos publicados `project/NL-Abas-C.dc.html` e `project/NL-Abas-C-cel.dc.html` com `Artifact` (`action: read`, `path`) e copie os valores do CSS deles; a nota `n_abas_c` do `project/canvas.json` registra as aprovações.
- Não edite o canvas. Item sem desenho no canvas vira pergunta ao usuário, nunca invenção.

## O que foi aprovado

1. **Barra compacta (opção C):** abas com ícone + rótulo; o atalho (`<kbd>` F1…F6) aparece só no hover e no foco do teclado. No celular, só ícones; a aba ativa mostra o rótulo.
2. **Cor do ciclo por aba:** Home índigo, Transporte ciano, Resumo esmeralda, Automação fúcsia, Chamados âmbar, OS índigo.
3. **Hover de cada aba:** brilho radial na própria cor (`rgba(var(--nl-ac), .24)` no centro até `.06`), anel interno `.38`, sombra `0 8px 20px -12px`, sobe 2 px em 200 ms, ícone na cor de texto do tom (`--nl-actx`) com `scale(1.12)`, atalho aparece tingido em 150 ms. A pílula ativa pega a cor da aba. Foco: contorno sólido de 2 px em `rgb(var(--nl-ac))`.
4. **Ferramentas do topo (direita), mesmo hover:** Buscar ciano, Notificações índigo, Ferramentas esmeralda, Assistente fúcsia, Tema âmbar. Pontos de status (fontes, Chrome) ficam sem hover.
5. **Menu Ferramentas (botão de grade):** mesmo hover em cada item, na cor do ciclo depois da OS: Histórico de apelidos F7 ciano, Relatório mensal F8 esmeralda, Cobertura F10 fúcsia, Lembretes âmbar, Catálogo de unidades índigo (os itens só do modo compacto seguem a aba: Chamados âmbar, OS índigo). O item desliza 2 px para a direita em 200 ms e o atalho fica tingido; no toque (`:active`) mostra o mesmo brilho.
6. **Movimento reduzido** (`prefers-reduced-motion: reduce`) tira subida, escala e deslize; cor e contorno ficam. Todo `transition` com `transform` dentro de `@media (prefers-reduced-motion: no-preference)`, como manda `docs/ui-motion/contrato-bento.md`.

Rótulos, IDs, ARIA, `title`, `aria-keyshortcuts` e atalhos ficam exatamente como estão.

## Onde mexer (mapa)

- Marcação do topo: `static/index.html` linhas ~99–232 (`#ck-topbar`, `#ck-abas`, `.ck-aba`, `.ck-aba--painel`, `.ck-topbar__acoes`, `#cockpit-tools-menu`, `.ck-menu__item`). O topo não está em partial; confira em `docs/cockpit-prompts/14-cockpit-v2.md` antes de editar.
- Estilo NL: `static/styles/nl-base.css` (tokens `--nl-i/c/e/f/a`, `--nl-*tx`, seletores `[data-nl-tom]` nas linhas 33–37 e regras do topo nas linhas 40–70). Base antiga: `static/styles/ck-cockpit.css` 187–287 e `static/styles/ck-bento.css` 61–63 e 227. Mude no `nl-base.css`; só toque nos outros se a causa estiver lá.
- Atalhos: `frontend/src/ui/ux-enhancements.ts` (`shortcutAction`) e `frontend/src/paineis/ferramentas-cockpit/estado.ts` (`toolKeys`). Não mudam; só confira que continuam alinhados.
- Testes que olham o topo: `tests/frontend/test_cockpit_tool_panels.cjs`, `tests/e2e/ui.spec.cjs` (altura 64 px, `.ck-menu__item`, foco 2 px), `tests/e2e/cockpit-tools.spec.cjs` (`.ck-aba__kbd`, axe em `#ck-abas`), `tests/e2e/color-contrast.spec.cjs`, `tests/e2e/theme-toggle.spec.cjs`.
- Doc da tela: `docs/cockpit-prompts/02-shell-barra-superior.md`.

## Blocos (um `model-super-power:executor` por bloco, em sequência)

### Bloco 1: cor por aba e hover das abas (desktop)

- Objetivo: cada `.ck-aba` e `.ck-aba--painel` ganha seu tom e o hover, foco e ativo aprovados (itens 2, 3 e 6).
- Arquivos: `static/index.html` (só o atributo `data-nl-tom` nos botões das abas; sem o atributo, a peça cai no índigo pelo fallback do `var()`, então Home e OS ficam sem ele), `static/styles/nl-base.css`.
- Critérios de aceite: tons na ordem do item 2; hover com brilho, anel, sombra, subida de 2 px e ícone `scale(1.12)` em 200 ms; ativo na cor da aba; foco 2 px sólido na cor; com movimento reduzido, `transform: none`; contraste ≥ 4,5 nos dois temas.
- Verificar: `node --test tests/frontend/test_cockpit_tool_panels.cjs`; Playwright com hover real (estilo computado de `transform`, `transition-duration` e `outline`) nos dois modos de movimento; `npx playwright test tests/e2e/color-contrast.spec.cjs tests/e2e/theme-toggle.spec.cjs`.
- Proibidos: `frontend/src/**` (exceto se um teste provar que um atributo precisa vir do TS), `static/dist/**`, `domains/`, `routers/`.

### Bloco 2: atalho só no hover e no foco

- Objetivo: `.ck-aba__kbd` some em repouso e aparece tingido no hover e no `:focus-visible` (150 ms), sem mudar a altura da barra (64 px) nem deslocar as abas vizinhas.
- Arquivos: `static/styles/nl-base.css`; testes `tests/e2e/cockpit-tools.spec.cjs` e `tests/e2e/ui.spec.cjs` só onde esperam o `<kbd>` sempre visível.
- Critérios de aceite: `<kbd>`, `title` e `aria-keyshortcuts` continuam no HTML (leitor de tela e testes de atalho intactos); a barra mede 64 px; nenhuma aba pula de largura no hover.
- Verificar: `npx playwright test tests/e2e/cockpit-tools.spec.cjs tests/e2e/ui.spec.cjs`.

### Bloco 3: ferramentas do topo e menu Ferramentas

- Objetivo: itens 4 e 5. Botões `#form-busca-serial .ck-busca__campo` (Buscar), `#btn-notificacoes`, `#cockpit-tools-trigger`, `#btn-assistente`, `#theme-toggle` com o hover no tom do item 4; `.ck-menu__item` do `#cockpit-tools-menu` com o tom do item 5 e o deslize de 2 px; `.ck-chip` (status) sem hover novo.
- Arquivos: `static/index.html` (`data-nl-tom` nos botões e itens do menu), `static/styles/nl-base.css`.
- Atenção: `nl-base.css` diz que o Assistente fica fora do NL; o usuário aprovou em 18/11/2026 o hover fúcsia só no **botão** `#btn-assistente`. Não toque em `#assistente-widget`.
- Critérios de aceite: cada item com o tom certo (estilo computado da cor do ícone = `--nl-*tx` do tom); menu desliza `translateX(2px)` em 200 ms; `:active` mostra o mesmo brilho; movimento reduzido sem deslize; abrir e fechar o menu (`details`/`summary`, clique fora, teclado) continua igual a hoje.
- Verificar: Playwright com hover real nos 5 botões e nos itens do menu aberto; `npx playwright test tests/e2e/cockpit-tools.spec.cjs`.

### Bloco 4: celular (só ícones, ativa com rótulo)

- Objetivo: abaixo do ponto de quebra atual do topo (`ck-cockpit.css` 233–247 e `nl-base.css` 69–70), as abas mostram só o ícone e a ativa mostra ícone + rótulo, como em `NL-Abas-C-cel`. Hoje é o contrário (rótulo sem ícone): troque.
- Arquivos: `static/styles/nl-base.css` (e `ck-cockpit.css` só se a regra antiga impedir); `tests/e2e/ui.spec.cjs` onde espera o layout antigo do celular.
- Critérios de aceite: 320 px e 375 px sem rolagem lateral; alvos de toque ≥ 32 px; rótulo oculto continua acessível (`aria-label` já existe); no toque, o mesmo brilho do hover.
- Verificar: Playwright em 320, 375 e 768 px (`scrollWidth <= clientWidth`, tamanho dos alvos); captura de tela de cada largura.

### Bloco 5: doc, verificação completa e PR

- Atualize `docs/cockpit-prompts/02-shell-barra-superior.md` com os tons, o hover, o atalho no hover e o celular (link para o canvas v51).
- Rode `npm run verify` e `npm run test:ui:e2e`. Teto de 3 ciclos de correção por falha.
- `model-super-power:revisor` revê o diff inteiro (bugs, acessibilidade, contraste, escopo).
- Skill `ponytail:ponytail-review` no diff antes do commit; corrija "Corrigir antes".
- Commit, push da própria branch, PR contra `main`; `bind_pr` e `set_monitor` com `auto_fix: true`. Não mescle, não faça `git pull`, não envie nada direto para a `main`.

## Pronto quando

Cada critério acima tem uma linha `AC: <critério> — PROVEN BY <evidência>` no relatório final, junto do link do PR, do estado da CI e do que não foi verificado (movimento ao vivo a olho, celular físico).
