# 14 · Cockpit v2 (redesign visual com o pacote de design)

Especificação escrita antes da implementação (AGENTS.md › Interface). Plano de origem: `C:\Users\Gabriel\.claude\plans\pasted-content-id-f0e4-aten-o-mandato-serialized-neumann.md`.

## Contexto

O pacote `C:\Users\Gabriel\Downloads\Copy of Design form project\` (`simpress-cockpit\` + `Simpress Entrega.md`) é a **fonte visual**: tokens, classes `ck-`, estrutura e medidas. O front real mantém IDs, `data-on-*`/`data-args`, ARIA, regras de negócio, temas claro/escuro e os textos aprovados do AGENTS.md. Nenhum dado fictício do pacote entra no HTML.

Não dá para colar o pacote direto:

- `static/index.html` tem ~453 IDs; o pacote, 352. ~225 IDs usados pelo JS não existem no pacote (17 modais, `toast-container`, campos reais do Transporte, `cockpit-summary-*`, `cockpit-tool-*`/`cockpit-comparison-*`/`cockpit-monthly-*`, `readiness-details-content`, `home-open-tickets-*`).
- A busca real usa `#input-serial`; o pacote usa `#serial`. O form atual não tem `id="form-busca-serial"` (a ser adicionado na sessão 2).
- O Transporte do pacote usa campos inventados (`retirada-expediente`, `entrega-destinatario`…).
- `4-comportamento.js` conflita com o projeto (tema `ck-tema`, `mostrarTela`, F1–F8/Ctrl+K, `submit` global, `escolher()`, toast "Salvo"); por isso `ck-cockpit-visual.js` traz só o comportamento puramente visual.
- Testes de contrato fixam o `<head>`, proíbem `style=`/inline (CSP estrita) e fixam IDs e estrutura F5–F8.

## Decisões do usuário (2026-10-26)

1. **Modais**: manter HTML/IDs/`data-accessible-modal` e restilizar a casca com classes `ck-` (`ck-veu`, `ck-dialogo`, `ck-btn`, `ck-campo`); no fim, remover Tailwind/`app.css` se nada mais depender.
2. **Transporte**: campos reais `retirada-*`/`entrega-*` no layout de grade do pacote; a planilha gerada não muda.
3. **OS por equipamento**: lista real no layout novo, chamado UTIC só leitura; sem `salvarChamadoOs`.

## Mapa região do pacote → IDs reais atuais (`static/index.html`)

| Região | IDs reais a preservar |
|---|---|
| 3A Barra | abas `tab-home`, `tab-retirada-entrega`, `tab-resumo`, `tab-automacao` (`data-on-keydown="controlarAbasTransferencia"`); busca `input-serial`, `btn-buscar-serial`, `btn-clear-serial`, `autocomplete-box/-header/-count/-list/-empty-state/-more-results`; prontidão `readiness-panel`, `readiness-summary(-short)`, `readiness-title`, `readiness-content`, `readiness-details-content`, `stat-base-dot`; `stat-equipamentos(-rotulo)`, `stat-unidades`; Ferramentas `cockpit-tools-dropdown/-trigger/-menu` (todos os itens, com `<kbd aria-hidden="true">F5…</kbd>`); sino `btn-notificacoes`, `notification-center-panel/-title/-summary`, `alerta-base-desatualizada`, `alerta-os-paradas`, `alerta-divergencias-novas` (+ `-titulo`/`-texto`); `theme-toggle`; `header-page-title`; `cockpit-automation-shell-status/-title` |
| 3B Home | `tab-panel-home`, `home-filter-total/-sem-usuario/-7-dias/-divergentes`, `home-equipment-list`, `home-list-empty/-count`, `home-recentes(-titulo/-lista)`, `home-detail-empty`, `card-equipamento/-serial/-modelo/-usuarios-logados/-usuario-manual-acoes/-nome-pessoa/-localizacao/-id-cliente/-cnpj-atual`, `grid-serial/-apelido/-cep/-cnpj-fat/-cnpj-inst`, `form-usuario-manual`, `form-nome-pessoa`, `ticket-templates-content/-title/-serial`, `home-open-tickets-title/-count/-body` |
| 3C Transporte | `tab-panel-retirada-entrega`, `transfer-equipment-banner/-title/-description/-users`, `transfer-serial(-status)`, `retirada-*` (cnpj, endereco, horario, almoco, pausa-duracao, tipo-acesso, voltagem, representante, contato, email, telefone, obs), `aviso-contato-origem(-texto)`, `select-unidade-destino`, `filiais-count`, `entrega-*` (cnpj, endereco, representante, contato, email, telefone, horario, almoco, pausa-obrigatorio, pausa-duracao, obs), `btn-copiar-cnpj-instalacao-entrega`, `cockpit-preview-*`, `cockpit-transport-preview-title/-state`, `textarea-resumo-preview`, `btn-gerar-planilha` |
| 3D OS por equipamento | fonte real `resumo-os-equipamento` (só leitura); sem fonte → seção fora e vai ao relatório |
| 3E Resumo | `tab-panel-resumo`, `resumo-cards`, `cockpit-summary-kpis/-table-title/-count/-status/-rows/-pagination/-previous/-page/-next/-regions-title/-region-list`, export |
| 3F Automação | `tab-panel-automacao`, `automacao-*` (inclui IDs de template), `sebrae-*`, `cockpit-automation-live/-events`, `data-automacao-rotina`; diálogo de log completo só com fonte real |
| 3G F5–F8 | `cockpit-tool-panels[hidden]`, 4 `section[data-cockpit-tool-panel]` (chamados, comparacao, apelidos, relatorio), `cockpit-tool-title/-subtitle`, `cockpit-tickets-*`, `cockpit-comparison-*`, `cockpit-alias-*`, `cockpit-monthly-*` |
| 3I Toast | `toast-container` (texto `Planilha Exportada com Sucesso!` vem do JS) |
| Modais | todos os `data-accessible-modal` atuais, intactos |

## Handlers ausentes no projeto

`abrirTextoTransporte`, `copiarTextoTransporte`, `gerarPlanilha`, `salvarChamadoOs`. O pacote os referencia; no front real, os botões equivalentes usam os handlers que já existem, e `salvarChamadoOs` não é criado (decisão 3).

## Divisão em 8 sessões (mesmo branch `feat/cockpit-layout`, sem worktree, sem push)

1. Spec + prints "antes" + `ck-tokens.css`/`ck-cockpit.css` + `<head>` + `ck-cockpit-visual.js` + tema.
2. 3A barra/busca/Ferramentas/sino/prontidão.
3. 3B Home.
4. 3C Transporte + 3D OS por equipamento.
5. 3E Resumo + 3F Automação.
6. 3G F5–F8 + toast.
7. Modais restilizados.
8. Limpeza de CSS/JS legado + `tests/frontend/test_dom_id_coverage.cjs` + verificação final (breakpoints, temas, prints "depois").

## Sessão 1: o que foi feito e decisões

- `static/styles/ck-tokens.css` e `ck-cockpit.css`: cópias fiéis do pacote; `ck-cockpit.css` termina com o bloco vazio `/* Integração Simpress */`. `ck-tokens.css` é o primeiro stylesheet do `<head>` e `ck-cockpit.css` o último. CSS legados continuam carregados até a sessão 8.
- `static/js/ui/ck-cockpit-visual.js` (importado em `app-entry.js` depois de `ux-enhancements`): mantém popovers `data-abre`/`data-fechar` + Esc com devolução de foco, setas em abas e menus, edição em linha, "Ver mais" (`data-expandir`), diálogo (`data-dialogo`/`.ck-veu`), `data-grupo`/`aria-pressed`. Removidos: demonstração, tema, `mostrarTela` e ramos `data-tela`/`data-tab`/`data-tela-link`/`data-voltar`/`data-rolar`/`data-focar`, F1–F8/Ctrl+K, `submit` global, `escolher()`/sugestões, toast "Salvo", seleção de linhas `.ck-item`/`tr[data-clicavel]` e abas de modelo de chamado (a sessão 3 decide se o JS atual já as controla).
- Tema: `theme-preference.js` continua dono. `updateToggle` **não** foi alterado: `tests/e2e/theme-toggle.spec.cjs` exige que o `svg` do botão troque entre `lucide-sun` e `lucide-moon`. Rever na sessão 2, quando o botão passar a usar o sprite.
- Prints "antes": `.claude/prints/cockpit-v2/antes/` (pasta ignorada pelo Git).

### Conflito encontrado entre o pacote e o legado

- `ck-tokens.css` traz `@media (prefers-reduced-motion: reduce) { * { animation-duration: 1ms !important; transition-duration: 1ms !important } }`, que vencia o 0,01 ms legado e quebrava `tests/e2e/ui.spec.cjs` ("reduced-motion preference suppresses CSS motion…"). Correção: o bloco `/* Integração Simpress */` de `ck-cockpit.css` (último stylesheet) reaplica 0,01 ms com `!important`. O conteúdo fiel do pacote não foi editado.
- Prints "antes" (HEAD limpo) e capturas com os novos CSS/JS ficaram byte a byte idênticos nas 16 combinações (4 telas × desktop/mobile × claro/escuro): os CSS `ck-` não afetam as telas legadas enquanto o HTML não usa essas classes.

### Sessão 4: Transporte (3C) e OS por equipamento (3D)

- 3C entrou: campos reais `retirada-*`/`entrega-*` na grade do pacote (3 colunas 1fr·1fr·380px; 2 em tela compacta), prévia marcando campos faltantes, barra de ações fixa com "N pendentes" (clique foca o primeiro campo inválido) e cartão do equipamento selecionado. A planilha gerada não mudou.
- Resumo do parque no Transporte (Base importada, Cidades, Pontos de atenção) é uma cópia com IDs `ck-parque-*`, alimentada pelo mesmo `/api/painel`; o bloco da aba Resumo mantém os IDs originais.
- 3D não entrou no Transporte: a lista real e o chamado UTIC (somente leitura) já vivem, com IDs únicos exigidos por `resumo-os.spec.cjs`, em `#resumo-os-equipamento` na aba Resumo. Duplicar quebraria os IDs. `salvarChamadoOs` não foi criado. A sessão 5 deve vestir esse bloco no estilo Cockpit.
- Limite conhecido: o shell legado `#simpress-app-shell` mantém `min-width:1200px` (rolagem horizontal interna abaixo disso, igual à Home); fica para a sessão 8.
- Abaixo de 1200px o Resumo do parque do Transporte vai para o fim da tela (`order: 3`): com o shell legado de 1200px, o emulador mobile só alcança cliques no primeiro trecho da página, e `origin-contact.spec.cjs` (mobile) precisa do botão "Configurar contato de origem" nessa faixa.

### Sessão 5: Resumo (3E), OS por equipamento (3D) e Automação (3F)

- 3E: `resumo-cards`, KPIs (`cockpit-summary-*`, classes `ck-kpi*`), tabela de cidades em `ck-tabela--cards` (cartões abaixo de 1200px, `data-label` por célula), barras `ck-barra*`, paginação e exportação reais. Textos aprovados (ex.: "Planilha Exportada com Sucesso!") intactos.
- 3D: `#resumo-os-equipamento` (gerado em `data-panels.js`) com `ck-cartao ck-os`, colunas 9/12/10/13/13/20% mais Descrição, destaque `data-vinculo="selecionado"` só quando há vínculo salvo real, descrição em 2 linhas com "Ver mais" (`data-expandir`). IDs únicos de `resumo-os.spec.cjs` mantidos.
- 3D omitido: filtro "Este equipamento/Todas" (não há fonte real; a lista já é uma linha por série). Chamado UTIC continua o editor real existente; `salvarChamadoOs` NÃO foi criado.
- 3F: `#automacao-cards.ck-auto` com cartão do Chrome, 3 cartões de rotina (botões/IDs/`data-on-click`/`data-args` iguais), Verificação manual e Controles do Chrome, Sebrae (`<details open>`, sempre visível), Últimas execuções, e console de 560px à direita (sticky, altura da janela) com log de 4 colunas (origem·hora·mensagem·nível; abaixo de 768px a mensagem vai para a 2ª linha), consulta por data, seletor de linhas e "Cancelar execução".
- Diálogo 3H "Log completo" implementado: a fonte é real (`#automacao-log` e `#automacao-log-arquivo`). Esc fecha e devolve o foco ao botão. Correção associada: `accessible-dialogs.js` não fecha mais um `<details>` aberto da tela quando o Esc fecha um `.ck-veu`.
- Mantidos de propósito: Recolher/Ampliar (controles reais, o e2e clica em Ampliar), `automation-card--expanded`, `automation-capture*`, `info-tip` da regra do Sebrae (`role="tooltip"`), classes legadas de agrupamento (`automation-action-*`). Texto do botão de cancelar agora é "Cancelar execução" (e2e ajustado).
- Testes ajustados só em classe/estrutura: `.ck-log__linha`, `.ck-tabela`, `grid` no cartão mobile da tabela de pendências, regex de `test_automation_tab_structure.cjs`. Série em `td:nth-child(2)` do OS deixou de ser monoespaçada (o e2e exige a mesma fonte do usuário). `static/vendor/lucide-*-subset.js` e `tailwind-*.css` regenerados por `npm run build:ui` (ícones `globe` e `play`).
- Limite conhecido (igual à sessão 4): shell legado com `min-width:1200px`, então abaixo disso a página rola na horizontal; 320px não foi corrigido (sessão 8). Verificado no navegador do agente: 1440 (escuro/claro) e 768; 390 (claro/escuro) também capturado: a página tem 1200px de largura por causa do shell, então a grade do log em 390 não reflete o layout de celular. Esc sem diálogo aberto ainda recolhe o Sebrae (comportamento existente de accessible-dialogs.js; o ajuste de 1 linha ali só impede que Esc no diálogo do log feche o Sebrae junto). O 404 de /api/usuarios-entra/estado é esperado no fixture.

## Sessão 8 — limpeza e verificação final

- Removidos: `cockpit-shell.css`, `cockpit-home.css`, `cockpit-pages.css`, `cockpit-tool-panels.css`, `sidebar-navigation.css` e `static/js/ui/sidebar-navigation.js` (não importado). O `min-width: 1200px` do shell legado sumiu: zero rolagem horizontal de 320 a 2560 px (verificado com Playwright headless, claro/escuro, 4 telas + F5–F8 + 17 modais abertos removendo `.hidden`, não pelos gatilhos reais). Também saíram de `ck-cockpit.css` o workaround de barra sticky e o bloco de alturas dos painéis legados.
- Mantidos (motivo): `ux-refinements.css` (≈150 elementos por tela dependem dele: avisos, tabelas, painéis de Automação/Resumo e miolo dos modais; testes de contrato leem-no), `tailwind-4.3.3.css` (classes utilitárias do `index.html` e do HTML gerado pelo JS, inclusive `.hidden` dos véus), `app.css`, `tokens.css`, `nocturne.css`, `theme.css` (miolo dos modais, histórico de comparação e tokens `--ux-*`; vários testes leem `app.css`/`tokens.css`). Remoção exigiria reescrever o miolo dos modais: fora do escopo desta etapa.
- Novo `tests/frontend/test_dom_id_coverage.cjs`: todo id literal do JS existe no `index.html`; exceções explícitas (ids criados pelo próprio JS ou sidebar legada).
- Atalhos F1–F4 e F5–F8 ignoram digitação em campo (comportamento existente de `ux-enhancements.js`); Ctrl+K funciona sempre.
- Foco: a regra `.simpress-app-shell :focus-visible` (2px) fica no início de `ck-cockpit.css`, antes dos componentes, para não apagar `.ck-busca__entrada:focus-visible` (sem anel, o campo já tem anel no wrapper) nem o `outline-offset:-2px` de `.ck-itens`.
- Gancho antigo `.cockpit-shell-body > .modal-overlay` (overlays seguindo a viewport durante rolagem horizontal) ficou sem uso: não há mais rolagem horizontal. Fonte `Inter Variable` existe em `static/vendor/fonts.css`.
- Limites: Esc/foco testado em um modal real; comparação com `Simpress Cockpit v2.dc.html` não feita.

## v2 (pacote re-cockpit-demo-v2, aplicado em 6 fases)

Pacote: `C:\Users\Gabriel\Downloads\Copy of Design form project (3)\re-cockpit-demo-v2`. Nenhum arquivo é substituído por inteiro: entra só o que a v2 traz de novo (CSS 2.15–2.17, edição cadastral em linha, "Nova transferência" no Transporte e 4 telas). `4-comportamento.js` não entra (conflita com `theme-preference.js`, F1–F8, submit global e `app.showToast`). `.ck-parque` continua fora e o bloco `/* Integração Simpress */` continua por último.

### Decisões do usuário

1. **Local, CEP e CNPJs somente leitura**: não há rota de gravação e os dados vêm da planilha oficial. "Editar" libera só Apelido, Usuário e Login (nome da pessoa).
2. **4 telas novas com dados reais** no layout v2, cada uma com botão "Fluxo completo" que abre o modal atual (como já é feito em Comparação e Apelidos). Atualização de 31/10/2026: o Catálogo de unidades deixou de ter "Fluxo completo"; o modal `#modal-gerenciar-unidades` foi removido e o painel absorveu o formulário.
3. **Popover de Prontidão fora**: entra só o CSS 2.17, que não aparece sozinho.

### Mapa das telas (`#cockpit-tool-panels`, `section[data-cockpit-tool-panel]`)

| Tela (`data-cockpit-tool-panel`) | Fonte real | Handlers |
|---|---|---|
| `planilhas` | último evento de `GET /api/historico-comparacoes` (status, KPIs, lista) | área de upload vira botão: `abrirModalAtualizarPlanilhas` (fluxo real: 2 arquivos, prévia, `preview_token`); sem `<input type=file>` próprio |
| ~~`historico-planilhas`~~ | Removida em 31/10/2026: menu, painel e botões de acesso saíram; o modal `#modal-historico-comparacoes` continua, aberto por `#cockpit-comparison-legacy` (aba Comparação) |  |
| ~~`evolucao`~~ | Removida em 31/10/2026: menu `#btn-evolucao-atualizacoes`, painel e modal `#modal-evolucao-atualizacoes` saíram; o front-end não chama mais `GET /api/operacoes/evolucao` (endpoint mantido, só o assistente o usa). O botão `#btn-alerta-divergencias-novas` da Home abre `comparacao` |  |
| `unidades` | `GET /api/unidades` (nome = `label`/`cidade`) | Desde 31/10/2026 o painel traz tudo o que o modal oferecia: "Nova unidade" (`#cockpit-units-new` → `toggleFormNovaUnidade`), formulário `#form-nova-unidade` (`form-unidade-titulo/-id/-cidade/-cep/-cnpj/-endereco`, `#btn-salvar-unidade` → `salvarUnidadeForm`), selo SEDE (lista e detalhe), detalhe com cidade, UF, endereço, CEP e CNPJ e botões `#cockpit-units-copy-cnpj` / `#cockpit-units-copy-cep`. Um lápis `Editar CNPJ da unidade <cidade>` ao fim do CNPJ (linha da lista e detalhe) abre o formulário preenchido com o foco no CNPJ (`editarUnidade(id, "form-unidade-cnpj")`). Saíram "Fluxo completo" (`#cockpit-units-legacy`), "Editar" (`#cockpit-units-edit`) e o modal; `abrirModalGerenciarUnidades` continua exportado (Home, "Cadastrar regionais") e só abre o painel. Salvar recarrega `carregarUnidades()` e a lista do painel (`recarregarUnidadesCockpit`) |

- Menu Ferramentas: IDs preservados (`#btn-historico-comparacoes` e `#badge-total-historico-comparacoes` removidos em 31/10/2026); ações `abrirPainelCockpit` com `data-args` `["planilhas"]`, `["unidades"]` (`["evolucao"]` removido em 31/10/2026). Voltar: `fecharPainelCockpit` (volta à tela anterior).
- Home, edição em linha: `#btn-editar-equipamento` (`editarDadosCadastrais`), `#form-editar-equipamento` (`salvarDadosCadastrais`), campos `data-campo` = `apelido`, `usuario`, `login`. Rotas existentes: `/api/equipamento/atualizar-apelido`, `/api/equipamento/atualizar-usuario`, `/api/equipamento/nome-pessoa`; só campos alterados. Usuário do Endpoint não é editável.
- Transporte: `#btn-nova-transferencia` ao lado de `#btn-trocar-equipamento` (`resetarFormulario`).
- Textos de planilha entram só por `textContent`; sem `style=` (CSP). Barras do gráfico do Relatório mensal com `<rect height>` em SVG (o gráfico da Evolução saiu em 31/10/2026).

### Pontos sem fonte real

- Local, CEP, CNPJs: sem rota de gravação (somente leitura).
- Unidades: `representante`, região e filtro por região não existem em `/api/unidades`; "Usar no Transporte" sem handler.
- Evolução (removida em 31/10/2026): sem série histórica; o gráfico mostrava só anterior × atual.
- Atualizar planilhas: o upload de 1 arquivo da v2 não existe; o fluxo real é o modal.
- `salvarDadosEquipamento` não envia `revisao` (provável 409 ao editar existente): fora desta entrega.

### Fase 1 (esta)

Spec, prints "antes" (`.claude/prints/cockpit-v2/antes-<tela>-<largura>-<tema>.png`), CSS 2.15–2.17 copiados literalmente de `2-componentes-telas.css`, comentário 2.13 atualizado e `fonts.css` antes de `ck-tokens.css` no `<head>`. Sem HTML do body nem JS.

## Resultado da aplicação

Cadeia de branches (cada fase foi cortada da anterior; a fase 7 contém tudo): `claude/cockpit-v2-fase1-6b4399` → `fase2-fe4595` → `fase3-c1dcf3` → `fase4-29f79c` → `fase5-3524dd` → `fase6-26275c` → `fase7-b718de`. Nada foi enviado ao remoto nem mesclado.

| Fase | Commit | O que mudou |
|---|---|---|
| 1 | `90bab5b` | Spec, CSS 2.15–2.17, ordem das fontes |
| 2 | `5445ea3` | HTML do Home, Transporte, menu e 4 telas |
| 3 | `925adb2` + `8422d8c` | JS de Planilhas, Histórico, Evolução e Unidades (+ selo Restauração) |
| 4 | `81b1acd` | Edição cadastral em linha no Home |
| 5 | `b4deffd` + `7bfbaed` | OS por equipamento no Transporte e popover do sino |
| 6 | `6f0ea7c` | Suíte de testes atualizada |
| 7 | (este) | Verificação final e este relatório |

### Verificado (estado final, fase 7)

- `npm run verify`: OK — 1132 testes Python, `node --test` (285 de 285), `node --check`, tipos JS, compileall, mypy (gradual e estrito) e busca de credenciais.
- `npm run test:ui:e2e`: 197 passaram (desktop, mobile e perfil).
- Prints "depois" no `ui-fixture` (1440/768/390, claro/escuro; Home normal e em edição, Transporte, menu, sino e as 4 telas) em `.claude/prints/cockpit-v2/depois7/` (fora do Git). Sem rolagem horizontal em nenhuma largura; console sem erros, exceto um 404 de `/api/usuarios-entra/estado`, rota que o fixture não implementa (não é regressão da v2).
- Teclado: `E` abre a edição, `Esc` cancela e devolve o foco a `#btn-editar-equipamento`, `Voltar` fecha a tela e devolve o foco ao menu Ferramentas.
- `<head>`: fonts → ck-tokens → tailwind/tokens/app → … → ck-cockpit (último); `theme-preference.js` preservado.
- Conformidade: `git diff 0571b69 --stat -- '*.py'` vazio; nenhum `style=`/script inline/`onclick=` novo; nenhuma cor literal nova no CSS; nenhuma série/dado da demo v2 no HTML/JS; `data/` sem alteração (só `.gitkeep` e o modelo já versionados); "Planilha Exportada com Sucesso!" preservado; minimizar/maximizar não reintroduzidos.

- Teclado, detalhe: com `E` o foco vai para o campo Apelido (INPUT).
- IDs/`data-on-click`/`data-args` do `index.html`: nada sumiu, exceto o título decorativo `ck-menu-g-transf` ("Transferência"), do grupo que a v2 removeu do menu; nenhum JS/teste o usa. Os botões desse grupo continuam existindo.
- O 404 de `/api/usuarios-entra/estado` já existia no commit-base (`entra-users.js`); o fixture é que não tem a rota.
- Nenhuma função de cor nova (`oklch`/`hsl`/`color-mix`) nem variável CSS nova no diff.
- Os prints "depois" ficaram em `depois7/` (a pasta `depois/` já existia da fase 1); referência v2 capturada em `ref-v2/` (1440 escuro).

### Divergências visuais restantes (Simpress × referência v2, 1440 escuro)

- Home: filtros mostram "—" e a lista fica vazia no fixture (a v2 usa 1.284 itens de exemplo); chip "Sincronizado" ao lado do modelo e lista "Chamados abertos" dependem de dados reais; Local/CEP/CNPJ em texto, não em campo editável (decisão do usuário).
- Transporte: sem o bloco "Resumo do parque" (no Simpress é a aba Resumo); filiais em lista "Outras filiais" em vez de abas de cidades; sem o selo numérico no sino; a barra fixa de ações da v2 (Gerar Planilha etc.) não foi conferida (ids diferentes no Simpress).
- Planilhas/Histórico/Evolução/Unidades: estrutura igual; valores vazios porque o fixture tem poucos dados.

### NÃO verificado

- Navegador real com dados operacionais (só o fixture, que tem poucos dados: Unidades e Histórico aparecem quase vazios).
- Comparação pixel a pixel com o artefato v2 (só inspeção visual lado a lado em 1440 escuro; 768/390 e tema claro sem referência v2).
- Unidades: o botão "Editar" ficava ativo sem unidade selecionada (abria o modal de gestão). Resolvido em 31/10/2026: botão e modal saíram; a edição é pelo lápis do CNPJ.
- Gravação real de Apelido/Usuário/Login contra o servidor com dados reais.

### Divergências e pontos sem fonte real

- Local, CEP e CNPJ: somente leitura (sem rota de gravação).
- Unidades: representante, região e "Usar no Transporte" sem fonte/handler; o botão "Editar" saiu em 31/10/2026 (edição pelo lápis do CNPJ).
- Evolução: sem série histórica (só anterior × atual).
- Atualizar planilhas: upload de 1 arquivo na tela; o fluxo real usa 2 arquivos (modal via "Fluxo completo").
- Follow-up sugerido: `salvarDadosEquipamento` não envia `revisao` (provável 409 ao editar equipamento existente); fora do escopo.

### Observação de ambiente

O worktree da fase 7 tem uma junction `node_modules` apontando ao `node_modules` do checkout principal. Antes de `git worktree remove`, rode `cmd /c rmdir node_modules` (regra do AGENTS.md), senão o do checkout principal é apagado.

### Desvio aprovado: OS por equipamento unida (etapa C)

A tabela do Resumo/OS (`#ck-os-tabela`) tem uma linha por OS, não por OS e fonte. Quando a mesma série e a mesma OS aparecem no Oracle e na Simpress, a coluna Fonte empilha os dois selos e a coluna Chamado empilha um editor UTIC por fonte, alinhado ao selo (a chave do vínculo continua `[fonte, série, OS]`, então nenhum chamado é sobrescrito). Série, OS, Usuário e Hostname aparecem uma vez; a Descrição vem do Oracle. A coluna da OS fica alinhada ao topo. Abaixo de 1200px os cards seguem a mesma união. O contador "N OS · M séries" e "Todas · N" passa a contar OS únicas.
