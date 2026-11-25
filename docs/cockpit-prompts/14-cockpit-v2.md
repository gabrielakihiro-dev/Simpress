# 14 · Cockpit v2 (redesign visual com o pacote de design)

Migração React BF4 (17/11/2026): as ferramentas do Cockpit (Chamados, Comparação, Histórico de apelidos, Relatório mensal, Planilhas, Unidades, Cobertura, Lembretes e Chamados Sebrae) abrem pelo painel React `ferramentas-cockpit`, em `frontend/src/paineis/ferramentas-cockpit/` (`estado.ts`, `montar.tsx` e `tipos.ts`). `frontend/src/aplicacao/cockpit-tool-panels.ts` virou ponte (antes `static/js/features/cockpit-tool-panels.js`) e mantém os nomes (`abrirPainelCockpit`, `fecharPainelCockpit` e os demais). Ids, textos, eventos e atalhos não mudaram; onde este doc cita `cockpit-tool-panels.js`, a regra agora está em `ferramentas-cockpit/estado.ts`. Sem o bundle React, a ponte abre a casca das nove ferramentas (título, atalho, subtítulo, foco no título, menu Ferramentas fechado, botão da barra e skip-link) e o Voltar devolve o foco a quem abriu; Chamados, Comparação, Histórico, Relatório e Planilhas mostram também o texto de erro que já existia (na Comparação, o resultado ganha `data-estado="erro"`, que o cartão do Resumo espera), e as outras ferramentas abrem a casca sem texto de erro e só registram o erro no console. O Escape também fecha a ferramenta aberta pela casca, com a mesma regra do painel React (sem `defaultPrevented` e sem modal aberto). Teste da ponte: `tests/frontend/test_bf4_ferramentas_bridge.cjs`.

Especificação escrita antes da implementação (AGENTS.md › Interface). Plano de origem: `C:\Users\Gabriel\.claude\plans\pasted-content-id-f0e4-aten-o-mandato-serialized-neumann.md`.

## Contexto

O pacote `C:\Users\Gabriel\Downloads\Copy of Design form project\` (`simpress-cockpit\` + `Simpress Entrega.md`) é a **fonte visual**: tokens, classes `ck-`, estrutura e medidas. O front real mantém IDs, `data-on-*`/`data-args`, ARIA, regras de negócio, temas claro/escuro e os textos aprovados (`docs/desenvolvimento/regras-agentes.md`, "Textos aprovados da interface"). Nenhum dado fictício do pacote entra no HTML.

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
| 3G F5–F8 | `cockpit-tool-panels[hidden]`, 4 `section[data-cockpit-tool-panel]` (chamados, comparacao, apelidos, relatorio), `cockpit-tool-title/-subtitle`, `cockpit-tickets-*` (inclui o bloco Importação e versões; ver `07-chamados-operacional.md`), `cockpit-comparison-*`, `cockpit-alias-*` (inclui `cockpit-alias-tabs` e `cockpit-alias-kpis`; ver `09-historico-apelidos.md`), `cockpit-monthly-*` |
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
- `frontend/src/ui/ck-cockpit-visual.ts` (importado em `frontend/src/arranque/entrada.ts` depois de `ux-enhancements`; antes `static/js/ui/ck-cockpit-visual.js` em `app-entry.js`): mantém popovers `data-abre`/`data-fechar` + Esc com devolução de foco, setas em abas e menus, edição em linha, "Ver mais" (`data-expandir`), diálogo (`data-dialogo`/`.ck-veu`), `data-grupo`/`aria-pressed`. Removidos: demonstração, tema, `mostrarTela` e ramos `data-tela`/`data-tab`/`data-tela-link`/`data-voltar`/`data-rolar`/`data-focar`, F1–F8/Ctrl+K, `submit` global, `escolher()`/sugestões, toast "Salvo", seleção de linhas `.ck-item`/`tr[data-clicavel]` e abas de modelo de chamado (a sessão 3 decide se o JS atual já as controla).
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
- 3D: `#resumo-os-equipamento` (gerado em `frontend/src/paineis/paineis-dados/tabela-os.ts`) com `ck-cartao ck-os`, colunas 9/12/10/13/13/20% mais Descrição, destaque `data-vinculo="selecionado"` só quando há vínculo salvo real, descrição em 2 linhas com "Ver mais" (`data-expandir`). IDs únicos de `resumo-os.spec.cjs` mantidos.
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
| `unidades` | `GET /api/unidades` (nome = `label`/`cidade`) | Desde 31/10/2026 o painel traz tudo o que o modal oferecia: "Nova unidade" (`#cockpit-units-new` → `toggleFormNovaUnidade`), formulário `#form-nova-unidade` (`form-unidade-titulo/-id/-cidade/-cep/-cnpj/-endereco`, `#btn-salvar-unidade` → `salvarUnidadeForm`), selo SEDE no cartão (o detalhe e os botões `#cockpit-units-copy-cnpj` / `#cockpit-units-copy-cep` saíram em 18/11/2026, ver "Novo layout do Catálogo de unidades"). Um lápis `Editar CNPJ da unidade <cidade>` ao fim do CNPJ do cartão abre o formulário preenchido com o foco no CNPJ (`editarUnidade(id, "form-unidade-cnpj")`). Saíram "Fluxo completo" (`#cockpit-units-legacy`), "Editar" (`#cockpit-units-edit`) e o modal; `abrirModalGerenciarUnidades` continua exportado (Home, "Cadastrar regionais") e só abre o painel. Salvar recarrega `carregarUnidades()` e a lista do painel (`recarregarUnidadesCockpit`). Desde 15/11/2026 (migração React, G2) o conteúdo da seção é React (`frontend/src/paineis/unidades/`: `estado.ts`, `acoes.ts`, `corpo.tsx`, `montar.tsx`); a `<section>` fica vazia no partial com `data-react-painel="unidades"`, e `static/js/features/units-catalog.js` virou ponte (`ponteReact`) com os mesmos 7 nomes em `window`. `appState.unidadesList` só por `lerEstado`/`gravarEstado`. Testes: `tests/e2e/react-g2.spec.cjs` (comportamento e baselines 390/1366 px, claro e escuro), que substitui `tests/frontend/test_units_catalog.cjs` |

- Menu Ferramentas: IDs preservados (`#btn-historico-comparacoes` e `#badge-total-historico-comparacoes` removidos em 31/10/2026); ações `abrirPainelCockpit` com `data-args` `["planilhas"]`, `["unidades"]` (`["evolucao"]` removido em 31/10/2026). Voltar: `fecharPainelCockpit` (volta à tela anterior).
- Home, edição em linha: `#btn-editar-equipamento` (`editarDadosCadastrais`), `#form-editar-equipamento` (`salvarDadosCadastrais`), campos `data-campo` = `apelido`, `usuario`, `login`. Rotas existentes: `/api/equipamento/atualizar-apelido`, `/api/equipamento/atualizar-usuario`, `/api/equipamento/nome-pessoa`; só campos alterados. Usuário do Endpoint não é editável.
- Transporte: `#btn-nova-transferencia` (`resetarFormulario`) fica no cabeçalho da página, ao lado de `#btn-historico-transferencias` ("Transferências geradas"); o banner `#transfer-equipment-banner` mantém só `#btn-trocar-equipamento`. Até 17/11/2026 ele ficava ao lado de `#btn-trocar-equipamento`; a mudança é do NL-F2 (18/11/2026), com o layout em 4 etapas descrito em `docs/cockpit-prompts/04-transporte-tres-colunas.md`, seção "Novo layout (NL-F2)".
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

## Navegação do Cockpit e atalhos (31/10/2026)

Reorganização autorizada pelo usuário em 31/10/2026; não reverta nem altere sem novo pedido dele. Esta seção prevalece sobre as menções anteriores a F5–F8 e a "F1–F4 e F5–F8 ignoram digitação em campo".

- Barra superior, nesta ordem: Home (F1), Transporte (F2), Resumo (F3), Automação (F4), **Chamados** (F5, painel `sebrae-chamados`, aba `#btn-sebrae-chamados-aba`, o antigo "Chamados Sebrae") e **OS** (F6, painel `chamados`, botão `#btn-acompanhamento-chamados`, o antigo "Chamados"). Os rótulos visíveis são exatamente `Chamados` e `OS`; IDs e chaves internas foram mantidos. Abaixo de 1200 px os dois saíam da barra e iam para o grupo "Painéis" do menu Ferramentas (`ck-menu__item--so-compacto`); desde 18/11/2026 (opção C, seção "Novo layout: base") ficam na barra em toda largura e esses itens do menu não aparecem.
- Atalho na barra: cada aba mostra F1 a F6 embaixo do nome, sem aumentar a altura da barra, em `<kbd class="ck-aba__kbd" aria-hidden="true">`, escondido abaixo de 768 px e de 1200 a 1289 px (onde a barra estouraria a largura); o rótulo visível e o `aria-label` não mudam. Desde 18/11/2026 (opção C) o atalho só aparece no hover e no foco por teclado, embaixo da aba, e some abaixo de 1200 px.
- Painel de ferramenta aberto (`#cockpit-tool-panels`): o cabeçalho (`.ck-ferramenta__cab`) fica fixo e só `.ck-ferr-painel` rola, sem rolagem da página (regra `#simpress-app-shell:has(#cockpit-tool-panels:not([hidden]))` em `static/styles/ck-cockpit.css`, só CSS); vale para todos os painéis de ferramenta.
- Menu Ferramentas: Comparação **F7**, Histórico de apelidos **F8**, Relatório mensal **F9**. O Assistente passou de F9 para **F10** para liberar o F9 (mapa desta data; o mapa atual, na seção "Navegação do Cockpit e atalhos (31/10/2026)" deste documento, é Histórico de apelidos F7, Relatório mensal F8, Assistente F9, desde 07/11/2026 Cobertura F10 e, desde 12/11/2026, Lembretes, sem atalho, com os termos de entrega e devolução dentro). F1 a F10 valem também com o cursor numa caixa de texto (autorizado em 31/10/2026; senão o F5 recarregaria a página); as demais teclas de atalho (`/`, `t`, `e`, `c`) continuam ignoradas ao digitar. O mapa fica em `shortcutAction` (`frontend/src/ui/ux-enhancements.ts`) e `toolKeys` (`frontend/src/aplicacao/cockpit-tool-panels.ts`); mantenha `<kbd>`, `title`, `aria-keyshortcuts` e testes alinhados.
- O modal `#modal-historico-apelidos` (e `abrirModalHistoricoApelidos`) foi removido em 31/10/2026 por pedido do usuário: o painel F8 (`data-cockpit-tool-panel="apelidos"`, em `frontend/src/aplicacao/cockpit-tool-panels.ts`) é o histórico completo. As ações de restaurar/excluir ficam em `frontend/src/aplicacao/alias-history.ts` (`acoesEventoHistorico`, `desfazerEventoHistoricoApelidos`, `excluirRegistroHistorico`). Não recrie o modal; a API `/api/historico-alteracoes` não mudou.
- O menu Ferramentas não tem mais o grupo "Planilhas": `Atualizar planilhas` (`#btn-atualizar-planilhas`) saiu (o modal abre por **Nova comparação** na aba Comparação, pelo `Importar` da Home e pelo alerta `Atualizar base`) e `Exportar Excel` (`#btn-exportar-equipamentos`, exportação do modelo com Apelido/IdCliente) passou para a barra da aba Comparação, com a mesma lógica de exibição (desde o BF3, 16/11/2026, em `frontend/src/paineis/indicadores-home/estado.ts`; ponte: `frontend/src/aplicacao/dashboard.ts`) e o rótulo visível `Exportar Excel`.

## Sub-aba Backups do Resumo (F3, 12/11/2026)

Sexta aba do Resumo (`#resumo-aba-backups`, painel `#resumo-painel-backups` com `data-react-painel="backups-regionais"`; React em `frontend/src/paineis/backups-regionais/` desde a migração React, Dia 2, G5, 15/11/2026, com `frontend/src/aplicacao/backups-regionais.ts` só com o pedido do painel a cada 5 min, que não depende do bundle). Mostra o campo `backups_regionais` de `GET /api/painel` (contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md`, seção "Backups regionais (Resumo F3)"); o painel não consulta o /api/painel, escuta `simpress:painel-atualizado`. Comportamento testado no navegador em `tests/e2e/react-g5.spec.cjs` (baseline de screenshots gravado no código antigo) e `tests/e2e/backups-regionais.spec.cjs`.

- Funciona sem comparação importada e com qualquer evento selecionado: não depende de `ultima_comparacao` nem do histórico.
- Teclado: `Setas`, `Home` e `End` movem o foco entre as abas do Resumo.
- Em 1200 px ou mais, tabela; abaixo disso, cards com os mesmos dados e ações; sem rolagem horizontal de 320 px a 2560 px.
- Abaixo de 600 px as seis abas do Resumo ficam em duas linhas de três (`.resumo-abas` com `flex-wrap`), para nenhum rótulo ser cortado.
- Comparação nova, aberta do histórico ou navegação por série com a aba Backups aberta volta a Divergências antes de mostrar o resultado.
- Atualização de 23/11/2026 (pedido do usuário): o Resumo ganhou a sub-aba `Visão Geral` como primeira e padrão; um resultado novo sem alvo de linha volta à `Visão Geral` (com alvo, à aba da linha). A barra de abas ficou no topo e, abaixo de 768 px, as seis abas seguem em duas linhas de três (`.nf3-sub--abas .resumo-abas` com `flex-wrap`).
- Depois de um redesenho, o foco volta ao mesmo botão, ao botão da mesma série e cidade (Confirmar vira Desfazer), ao resumo `N excluídos` que estava em foco ou, sem par, à aba Backups.
- Nas sobras de regional fora das prioritárias, cada série mostra a origem (`marca` ou `confirmação`) e, se for confirmação, o próprio `Desfazer confirmação` (12/11/2026); nas sobras das prioritárias o botão fica só na tabela da regional.
- Botões `Confirmar Backup` (desabilitado com o Endpoint indisponível), `Desfazer confirmação` e, quando aparece usuário novo num apelido manual, `Manter` e `Excluir` (`05-resumo-kpis.md`); a tela pede a atualização do painel depois de cada ação (`simpress:atualizar-notificacoes`).
- O apelido aparece só na tela local: nunca em toast, `console`, região `aria-live` global, log nem Assistente. Todo texto vindo do campo é escapado.
- Ao fim da automação de inventário, o botão `Ver backups no Resumo` (`#automacao-ver-backups`) abre essa sub-aba (`openPanel("comparacao","backups")`).
- Cartão do sino (`#alerta-backups-regionais`): `docs/operacao/alertas-os-divergencias.md`, seção 5.
- Fixture dos e2e (`tests/support/serve_ui_motion_preview.py`): `GET /__fixture_backups?estado=padrao|so_conferir|nulo|indisponivel` reinicia o estado em memória; `POST /api/backups-regionais/confirmar` e `/desfazer` mudam esse estado. Séries `TSTBK*` e apelidos `Estacao Teste N` são fictícios.

## Visual do Catálogo de unidades (13/11/2026)

Pedido do usuário: deixar os blocos do painel `unidades` mais organizados e limpos, no mesmo padrão do Histórico de apelidos. Só CSS, numa seção própria no fim de `static/styles/ck-cockpit.css`, escopada a `[data-cockpit-tool-panel="unidades"]`; HTML, IDs, ARIA, textos e dados não mudaram; no JavaScript entrou só um comentário em `renderUnits` avisando que a ordem dos pares (Cidade, UF, Endereço, CEP, CNPJ) e das colunas é usada pelo CSS via `nth-child`. Proposta aprovada no artefato de design do catálogo.

- Painel com largura máxima de 1400 px, centralizado.
- KPIs (Unidades, Cidades, Com CNPJ) em cartões compactos com borda, lado a lado; no celular dividem a linha em três.
- Barra numa linha só: busca (até 360 px), contagem `N de M unidades` ao lado e `Nova unidade` à direita. No celular a busca ocupa a linha toda.
- Em 1200 px ou mais, a lista é uma tabela dentro de um cartão (cabeçalho com fundo suave, linha selecionada com faixa de 3 px). Abaixo disso continuam os cards de `.ck-tabela--cards`.
- CNPJ da lista e CEP e CNPJ do detalhe em fonte mono com números tabulares. O texto continua cru, sem máscara (o e2e confere `03209636000100`).
- Detalhe em cartão: título maior, pares em grade 2×2 com linhas finas e Endereço na largura toda. A faixa cinza com cartões empilhados saiu: `.ck-det__corpo` transformava `.ck-pares` em coluna flexível.
- Bordas dos cartões e linhas do detalhe em `--cor-borda-suave` no tema claro, como no artefato; no escuro em `--cor-borda`, porque o token suave quase some sobre a superfície.
- Linha da lista com foco: anel para dentro (`outline-offset: -2px`), porque a lista rola e cortaria o anel. Detalhe fixo com `max-height` descontando o `top` de 12 px. Detalhe sem seleção não desenha faixa vazia (`:empty`). Abaixo de 400 px o lápis do CNPJ quebra para a linha de baixo sem margem negativa.
- Temas claro e escuro só com tokens de `ck-tokens.css`; sem `!important`.
- Verificado no fixture com 6 unidades fictícias, em 1366×900 e 390×844, nos dois temas, sem rolagem horizontal. Não verificado com os dados reais nem no navegador do usuário.

## Novo layout do Catálogo de unidades (18/11/2026)

Novo layout parte 2, frame NL-Catalogo (visual B) e NL-Catalogo-Filtros do canvas v43. Decisão do usuário (18/11/2026): o Catálogo não tem tela de detalhe.

- Resumo num cartão em linha: Unidades, Cidades e Com CNPJ (`#cockpit-units-kpis`, número de 30 px) e o botão primário `+ Nova unidade` (`#cockpit-units-new`) à direita. No celular os três números viram três cartões pequenos e o botão ocupa a linha.
- Busca `#cockpit-units-search` (300 px; celular, largura toda) com lupa, placeholder "Nome, cidade ou CNPJ", `X` "Limpar busca" quando há texto (limpa e devolve o foco) e Esc com texto limpa a busca sem fechar o painel; Esc com a busca vazia fecha o painel como antes. A busca ignora acento e caixa e acha o CNPJ só pelos dígitos (`000272` acha `00.000.000/0002-72`).
- Contagem `#cockpit-units-status` mudou de `N de M unidades` para `N de M` (texto aprovado alterado a pedido do desenho); com busca ativa o selo fica destacado.
- Lista `#cockpit-units-list-body` em grade de cartões (4 colunas em 1200 px ou mais, 2 abaixo, 1 no celular): nome em negrito com o trecho achado em `<mark>`, selo SEDE (cartão da sede com borda e fundo do acento), `Cidade/UF` e CNPJ em mono com o lápis "Editar CNPJ da unidade <cidade>".
- Saíram: tabela, detalhe (`#cockpit-units-detail*`), seleção de linha e botões Copiar CNPJ/CEP. `copiarDadoUnidade` continua exportado na ponte (`window`), sem botão no painel.
- Estados vazios mantidos: "O catálogo não contém unidades." e "Nenhuma unidade corresponde à busca.".
- Formulário `#form-nova-unidade` sem mudança de campos, abaixo da grade.
- CSS em `static/styles/nl-lemb-cat.css` (escopo `[data-cockpit-tool-panel="unidades"]`, tokens `--nl-*`); entrada dos cartões em 250 ms e realce da busca em 200 ms, só com `prefers-reduced-motion: no-preference`.
- Testes: `tests/frontend/test_unidades_busca.cjs` (busca sem acento, CNPJ por dígitos, trechos do `<mark>`), `tests/e2e/react-g2.spec.cjs` e `tests/e2e/cockpit-tools.spec.cjs`.

## Textos explicativos no ⓘ (14/11/2026)

Pedido do usuário (14/11/2026, plano `docs/planos/limpeza-textos-explicativos.md`): texto que só explica (subtítulo, descrição de seção, dica de campo) sai da tela e vai para o ⓘ ao lado do título ou do rótulo, na mesma linha. Status, erros, dados, contagens, textos aprovados e avisos de envio real ou de privacidade continuam visíveis.

- Componente único: `.info-tip` de `static/styles/ux-refinements.css` (botão `.info-tip-trigger` com `aria-label="Sobre X"` e `aria-describedby` apontando para o `span.info-tip-text` com `role="tooltip"`). Abre por mouse, foco ou toque; Esc fecha (`dismissInfoTips` em `frontend/src/ui/ux-enhancements.ts`). Com o foco num ⓘ de balão aberto, o Esc só fecha o balão (`preventDefault` e `stopPropagation`, este desde o Bloco 3, porque o Esc dos diálogos em `frontend/src/ui/accessible-dialogs.ts` ouve no `document` e não checa `defaultPrevented`) e o painel ou o diálogo continua aberto; um segundo Esc já fecha o painel ou o diálogo. Balão aberto só pelo mouse: o Esc fecha o balão e segue normalmente (fecha o painel ou o diálogo). Não crie outro componente.
- No HTML estático (partials), o `span` do balão segue a ordem `id`, `role="tooltip"`, `class="info-tip-text"` e não fica vazio: `tests/frontend/test_ux_enhancements.cjs` confere cada ⓘ do HTML montado.
- Para markup gerado em string, use `infoTipHtml(rotulo, texto, { fim })` de `frontend/src/comum/dom-utils.ts`: devolve o markup acima com `aria-label="Sobre <rotulo>"`, `id` único `tip-auto-<n>` (contador por instância de `SimpressDomUtils`, uma por documento), rótulo e texto escapados por `escapeHtml`, e `info-tip--end` quando `fim` for verdadeiro (balão alinhado à direita); `{ bloco: true }` acrescenta `info-tip--bloco` (abaixo). Quando o balão precisa de um `id` fixo (ⓘ redesenhado a cada leitura, ou citado por e2e e docs), passe `{ id }` ao helper: `infoTipHtml(rotulo, texto, { fim, id })` usa esse `id` no lugar do automático (Bloco 2, 14/11/2026; ex.: `resumo-backups-minimo`). Use `id` fixo só quando a mesma tela pode ter um único ⓘ com ele: repetir o `id` na página quebra o `aria-describedby`. Em código que monta por DOM (`cockpit-tool-panels.js`), a função local `infoTip(rotulo, texto, id, { fim })` faz o mesmo (ex.: `cockpit-monthly-fora-nota`, `cockpit-monthly-pendentes-nota`, `cockpit-monthly-sebrae-nota`, `cockpit-tickets-kpis-nota`).
- Dentro de linhas com altura justa (`.ckp-rotulo`, `.ckp-cab__titulo`, `.ck-ferramenta__linha`, `.ck-chamados-triagem__resumo`), o `.info-tip` usa `margin-block: -0.75rem` (`static/styles/ck-pendencias.css`), porque o botão herda `min-height: 2.5rem` de `app.css` e não pode aumentar a linha.
- Não ponha o ⓘ dentro de um `label` nem de um título cujo texto o JS troca por `textContent`: o texto do balão entraria no nome acessível, ou o ⓘ seria apagado.
- Cabeçalho das ferramentas (Bloco 1): o subtítulo de cada ferramenta (`toolInfo` em `frontend/src/aplicacao/cockpit-tool-panels.ts`) virou o balão `span#cockpit-tool-subtitle` (`role="tooltip"`, sem `aria-live`, porque o título recebe o foco) do ⓘ ao lado de `#cockpit-tool-title`, em `div.ck-ferramenta__linha`. `openPanel` troca só o texto do balão; o botão tem `aria-label="Sobre a ferramenta"` fixo (o nome da ferramenta já está no título ao lado).
- Resumo (F3), Comparação, Relatório mensal e Backups regionais (Bloco 2): descrições de seção, notas de cartão e o mínimo de backups por regional foram para o ⓘ; ver `05-resumo-kpis.md`, `08-comparacao-operacional.md` e `10-relatorio-mensal.md`. Em `#resumo-painel-backups` e `#comparacao-planilhas-conteudo` o botão do ⓘ tem `min-height: 0` (`static/styles/ck-cockpit.css`), e `.ck-rel__cartao-cab` e `.ck-bento-sech` (cabeçalho dos cartões bento do Resumo e de Backups; a antiga `.ck-backups__cabeca` foi removida em 14/11/2026) alinham título e ⓘ em `flex`.
- Ferramentas (Bloco 3, 14/11/2026): Lembretes, Termos, Planilhas e Sebrae (conflitos) levaram a dica para o ⓘ; ver `18-lembretes.md`, `17-termos.md` e `docs/operacao/sincronizar-chamados-sebrae.md`. Regras do bloco:
  - `.ck-rotulo-info` (`static/styles/ck-cockpit.css`) alinha título ou rótulo e ⓘ na mesma linha (`inline-flex`, `gap: 4px`); o ⓘ fica ao lado do `label`, `h2` ou `strong`, nunca dentro dele, e o botão tem `min-height: 0` para não crescer a linha.
  - Em `fieldset`, o ⓘ vai dentro da `legend` (que continua o primeiro filho) e o texto da legenda fica em `span#<id>-leg`; o `fieldset` usa `aria-labelledby` apontando para esse `span`, para o balão não entrar no nome acessível do grupo. O mesmo vale para `strong#sebrae-conflitos-titulo`, que dá nome à seção: o ⓘ é irmão do título.
- Conflitos de edição (Chamados, F5) no layout C desde 24/11/2026: lista de blocos (legenda dentro do bloco, `Título`, `Solicitante`, opções de 44px com o valor ligado por `aria-describedby`) e, a partir de 1200px, o painel `O que vai para o SharePoint` com 360px ao lado; abaixo disso uma coluna. Detalhe e regras em `docs/operacao/sincronizar-chamados-sebrae.md`.
  - Planilhas (`#cockpit-sheets-detail`): a coluna de detalhe é `sticky` com `overflow: auto` a partir de 1200px e cortaria o balão; ali o `overflow` vira `visible` e o balão tem `max-width: 17rem` (cabe na coluna de 400px). Abaixo de 1200px a coluna empilha e não há corte.
  - Até 640px o balão compartilhado (`ux-refinements.css`) é `position: fixed; inset-block-start: auto`, ou seja, fica onde o layout o pôs; com o ⓘ abaixo da dobra ele abre fora da tela (Planilhas, Termos). Nos ⓘ do Bloco 3 o balão ancora no contêiner: `.ck-rotulo-info` (`ck-cockpit.css`) e `.termos__grupo` / `.termos__acoes` (`ck-termos.css`) viram `position: relative` e o balão `position: absolute` com a largura do contêiner; o da barra "Gerar PDF" abre para cima, porque a barra fica no fim do formulário. Corrigido na camada compartilhada no Bloco 4 (ver abaixo); os remendos locais de `.ck-rotulo-info` e `.termos__*` foram removidos.
  - O E2E `tests/e2e/info-tips-ferramentas.spec.cjs` confere no celular que o balão está dentro da janela e por cima (`elementFromPoint`), porque `toBeVisible` não pega balão fora da tela.
- Testes: texto no ⓘ não passa em `toBeVisible`, `innerText` nem `getByText().click`; use `toHaveText`, `textContent` ou leitura do HTML.
- O `aria-label` do ⓘ não repete o nome do botão vizinho: `getByRole("button", { name: "Gerar PDF" })` casa por trecho e falharia com dois botões (por isso o ⓘ de Termos é "Sobre o PDF").
- Home, modais, Automação e revisão final (Bloco 4, 14/11/2026): o que restou nas abas e nos modais foi para o ⓘ ou saiu; ver `03-home-split-view.md` (seção "Textos explicativos no ⓘ (Bloco 4)"), `06-automacao-console.md`, `11-modais-ajustes-finais.md`, `15-assistente.md`, `04-transporte-tres-colunas.md` e `docs/operacao/sincronizar-chamados-sebrae.md`. Regras do bloco:
  - Correção compartilhada do balão no celular (`static/styles/ux-refinements.css`, `@media (max-width: 640px)`): o balão é `position: fixed` com `inset-block-end: 1rem` e `inset-inline: 1rem`, ou seja, preso ao pé da janela e com a largura dela. Antes, `inset-block-start: auto` deixava o balão onde o layout o pôs e um ⓘ abaixo da dobra abria fora da tela. Vale para todo ⓘ; por isso os remendos locais do Bloco 3 (`.ck-rotulo-info`, `.termos__grupo`, `.termos__acoes`) foram apagados.
  - Desktop, `info-tip--end`: balão alinhado à borda direita do ⓘ. Use quando o ⓘ fica perto da borda direita da janela ou do modal (ex.: `Códigos prontos` do PowerShell, `Apelido / Hostname`).
  - Desktop, `info-tip--bloco` (novo, só `min-width: 641px`): o ⓘ vira `position: static`, e o balão ancora no bloco do título (o pai precisa de `position: relative`), com `inset-inline-start: 0` e `max-width: min(20rem, 100%)`. Use quando um ancestral com `overflow: hidden` ou `auto` cortaria o balão, ou quando o balão escondido alargaria o painel (rolagem horizontal): títulos do Assistente (`Instruções permanentes`, `Lembretes e notas`, `Histórico de conversas`, `Busca na web`, ancorados por `.ck-assist .ck-det__titulo` e `.ck-assist__busca > div` em `ck-cockpit.css`) e `Importar arquivos` (`.ckp-dialogo--estreito .ckp-cab`, em `ck-pendencias.css`, com 1rem de folga de cada lado). Os títulos de seção da Comparação usam a classe `.info-tip-ancora` (`position: relative`, em `ux-refinements.css`) no `div` do título: sem ela, o balão escondido criava rolagem horizontal em `#cockpit-tool-panels` a 641-700px (revisão do PR, 14/11/2026).
  - E2E genérico `tests/e2e/info-tips-todos.spec.cjs` (desktop e celular): abre cada tela, sub-aba e modal e, para todo `.info-tip-trigger` visível, confere `aria-label` `Sobre ...`, `aria-describedby`, `role="tooltip"`, texto não vazio, balão oculto no início, abre por mouse ou toque e por foco, Esc fecha só o balão (o gatilho mantém o foco) e o balão inteiro dentro da janela (tolerância de 3px, por causa do `translateY(-2px)` do estado fechado) e por cima (`elementFromPoint` nos quatro cantos e no centro). Cada tela declara o mínimo de ⓘ e os rótulos obrigatórios; um ⓘ novo entra sem mudar o teste, e um que sumir faz o teste falhar. O ⓘ de `Chamados novos do SoftExpert` só existe a partir de 768px (o cartão compacto do celular o esconde, `ck-cockpit.css`, F4 Bloco 2), por isso o spec o cobra só no desktop. Fora da lista de propósito: a sub-aba `Visão geral` do Resumo, que não tem painel.
  - Também no Bloco 4: `ul.ckp-fatos` (e o CSS dele) foi apagado e o texto foi para o ⓘ do título de `Importar arquivos`; `span.ck-ac__dica` (`Esc fecha`) saiu da Home por redundante (regra C); os estados vazios `Selecione um equipamento.` (Home) e `Nenhum equipamento a listar.` (pesquisa completa) ficaram curtos (regra D).

## `index.html` dividido em partials (10/11/2026)

Para reduzir conflitos entre sessões paralelas, trechos grandes do `static/index.html` ficam em `frontend/partials/<nome>.html`, fora de `static/` (não são servidos sozinhos). No `index.html`, uma linha que contém só `<!-- include: partials/<nome>.html -->` é trocada pelo arquivo inteiro antes de a página sair; o navegador recebe o mesmo HTML de antes, byte a byte.

- Quem monta: `assembled_html()` em `domains/frontend_assets.py`, chamada por `versioned_html()` (rota `/` e servidor do e2e). Aceita só caminhos dentro de `frontend/partials/`, terminados em `.html`, com no máximo 2 níveis (um partial pode incluir outro); partial ausente para a página com erro que diz o nome.
- Testes que leem o HTML como texto usam o HTML montado: `assembled_html(app_config.STATIC_DIR)` no Python e `assembledHtml()` de `tests/frontend/support/assembled-html.cjs` no Node; `tests/test_frontend_assets.py` confere que os dois montam o mesmo texto.
- Os varredores do build leem também os partials: Tailwind (`@source` em `static/styles/tailwind.input.css` e `content` em `config/tailwind.config.cjs`) e o subconjunto do Lucide (`scripts/build/lucide-subset.cjs`). Sem isso, classe ou ícone que só aparece num partial sumiria do CSS ou do JS gerado.
- `GET /static/index.html` continua servindo o arquivo cru, com as linhas de include; a página real é a rota `/`.
- Partials atuais: `cockpit-tool-panels.html` (`#cockpit-tool-panels`) `modais.html` (todos os `.modal-overlay`, um bloco contínuo) e `card-equipamento.html` (`#card-equipamento`, dentro do painel de detalhe).

- Para editar um painel extraído, abra o partial; IDs, ARIA, `data-*` e classes não mudaram de lugar no HTML final.


## Regras movidas do AGENTS.md (10/11/2026)

Texto integral das seções que ficavam no `AGENTS.md` da raiz até 10/11/2026. O resumo e o índice continuam no `AGENTS.md`.

### Navegação do Cockpit e atalhos (31/10/2026)

Reorganização autorizada pelo usuário em 31/10/2026; não reverta nem altere sem novo pedido dele.

- Barra superior, nesta ordem: Home (F1), Transporte (F2), Resumo (F3, abre o painel de ferramenta `comparacao` pelo botão `#btn-resumo-aba`; não é mais uma aba própria), Automação (F4), **Chamados** (F5, painel `sebrae-chamados`, o antigo "Chamados Sebrae") e **OS** (F6, painel `chamados`, botão `#btn-acompanhamento-chamados`, o antigo "Chamados"). Os rótulos visíveis são exatamente `Chamados` e `OS`; IDs e chaves internas foram mantidos.
- Menu Ferramentas: Histórico de apelidos **F7**, Relatório mensal **F8** e, desde 07/11/2026, **Cobertura** **F10** (`#btn-cobertura`, painel `cobertura`; ver "Cobertura de equipamentos"), e, desde 12/11/2026, **Lembretes** (`#btn-lembretes`, painel `lembretes`, sem atalho, com as sub-abas `Termo Entrega`, `Termo Devolução` e `Lembretes`; a ferramenta Termos de 09/11/2026 e o `#btn-termos` foram removidos; ver `18-lembretes.md` e `17-termos.md`); o Resumo (F3) saiu do menu e fica só na barra. O Assistente é **F9**. F1 a F9 valem também com o cursor numa caixa de texto (autorizado em 31/10/2026; senão o F5 recarregaria a página), e o F10 também, junto com a Cobertura (07/11/2026); as demais teclas de atalho (`/`, `t`, `e`, `c`) continuam ignoradas ao digitar. O mapa fica em `shortcutAction` e `toolKeys`; mantenha `<kbd>`, `title`, `aria-keyshortcuts` e testes alinhados.
- O painel F7 (`data-cockpit-tool-panel="apelidos"`) é o histórico completo de apelidos; o modal `#modal-historico-apelidos` foi removido em 31/10/2026 por pedido do usuário. Não recrie o modal. Desde 04/11/2026 (pedido do usuário) o F7 não exibe eventos de séries iniciadas por `VMWARE` ou `GOOGLECLOUD` (máquinas virtuais do próprio Sebrae, sem relação com os equipamentos): filtro só na exibição, em `cockpit-tool-panels.js` (`ALIAS_HIDDEN_SERIAL`); nada é apagado do histórico e as demais telas não mudam. Em 11/11/2026 (pedido do usuário, com base no artefato https://claude.ai/artifact/6wWuMH8a7VhKDBjPyFnxf9) o painel foi reorganizado: abas por tipo `#cockpit-alias-tabs` (o `<select id="cockpit-alias-type">` fica oculto e sincronizado, e é a fonte da verdade; contagem das abas segue busca, `Somente com ação disponível` e período), uma cor por tipo com rótulo em texto, lista agrupada por dia, detalhe em blocos, KPIs `Alterações neste mês` e `Equipamentos afetados` com `Exportar CSV` e período em `.ck-segmentado`. Saíram os KPIs `Fora do padrão` e `Apelidos duplicados`, as 2 pílulas desabilitadas e `#cockpit-alias-data-note` (desvio aprovado em 11/11/2026; detalhes em `09-historico-apelidos.md`).
- O menu Ferramentas não tem grupo "Planilhas": o modal de atualização abre por **Nova comparação** (aba Comparação), pelo `Importar` da Home e pelo alerta `Atualizar base`; `Exportar Excel` (`#btn-exportar-equipamentos`) fica na barra da aba Comparação, com o rótulo visível `Exportar Excel`.

Detalhes em `docs/cockpit-prompts/14-cockpit-v2.md`, seção "Navegação do Cockpit e atalhos (31/10/2026)".

## Novo layout: base (18/11/2026)

Fonte: canvas "Novo layout" (https://claude.ai/artifact/2txBkhk2PDgyh1cr35zcED, versão v23 `1794977337-d093`; parte 2 sobre a v43 `1795012604-5719`), quadros NL-Base-Topo, NL-Base-Formulario, NL-Janelas-Config, NL-Janelas-Cadastro, NL-Janelas-Planilhas, NL-Janelas-Arquivos, NL-Janelas-Dossie, NL-Tabelas e NL-Responsaveis, cada um com o par `-cel`. Os quadros NL-Confirmar-* estão "A CONFIRMAR" e ficaram de fora; janela usada por uma aba só fica para a sessão daquela aba. Em conflito, vale o canvas Simpress Bento.

- `static/styles/nl-base.css`, carregado logo depois do `ck-bento.css`: tokens `--nl-*` (tema claro com contraste 4.5:1, raios, sombras, curvas, véu; escuro em `:root[data-theme="dark"]`) e `[data-nl-tom]` para o acento de uma peça. Não reatribui `--cor-*`.
- Barra de abas: opção C do canvas (v49, revisada na v51; quadros NL-Abas-C e NL-Abas-C-cel), aprovada pelo usuário em 18/11/2026. As 6 abas (Home F1, Transporte F2, Resumo F3, Automação F4, Chamados F5, OS F6) ficam numa cápsula só (`.nl-abas`, que envolve o tablist `#ck-abas` e os botões de painel Chamados e OS; IDs, ARIA e manipuladores não mudaram). Cada aba tem a sua cor no hover e quando ativa (`data-nl-tom`: Transporte ciano, Resumo esmeralda, Automação fúcsia, Chamados âmbar; Home e OS índigo); só uma aba fica destacada por vez. O atalho F1–F6 fica escondido e aparece embaixo da aba no hover e no foco por teclado. Abaixo de 1200px as 6 abas ficam só com ícone e a ativa mostra o rótulo (220 ms); sem atalho; Chamados e OS não se repetem no menu Ferramentas. Ferramentas do topo com o mesmo hover, cada uma com a sua cor (Buscar ciano, Notificações índigo, Ferramentas esmeralda, Tema âmbar); itens do menu Ferramentas também (Histórico de apelidos ciano, Relatório mensal esmeralda, Cobertura fúcsia, Lembretes âmbar, Catálogo de unidades índigo), com 40px de altura. Ficaram de fora: os números nas abas (o canvas usa dados de exemplo), a lupa do celular que abre uma paleta e o hover colorido do Assistente (o Assistente fica fora do novo layout).
- Barra superior (`#ck-topbar`): busca sem placeholder com `Ctrl K`, chips e botões de ícone de 40px; a partir de 1200px a barra tem 64px (`--altura-barra`). Ordem dos botões: Notificações, Ferramentas, Assistente (F9) e tema. O chip `Ctrl K` some abaixo de 768px. No celular a grade e a busca continuam as atuais (só o visual mudou); a busca também ficou sem placeholder (o `aria-label` continua). O quadro NL-Base-Topo-cel troca a busca por um botão de lupa que abre uma paleta; isso ainda não foi feito.
- Véu e diálogos comuns (`.ck-veu`, `.ck-dialogo`): raio 24px (20px no celular), sombra e desfoque; o movimento continua no `SimpressMotion`.
- Janelas comuns (`.ckp-veu`, `.ckp-dialogo`: Configuração, Cadastro, Planilhas, Arquivos e Dossiê): cabeçalho em duas colunas sem ícone, kicker em caixa alta, seções separadas por linha (tracejada quando opcional), arquivo em área tracejada (verde quando escolhido, vermelho com erro), rodapé à direita com Cancelar/Fechar com borda; no celular os botões do rodapé dividem a largura. Só aparência: IDs, ARIA e manipuladores ficam.
- Atualizar planilhas (`#modal-atualizar-planilhas`, nota `n_janelas_planilhas`): o aviso de impacto (`#upload-impacto-aviso`) saiu do corpo e virou o ⓘ "Impacto" no rodapé, à esquerda dos botões, nas etapas 1 e 2; o texto aparece no hover e no foco por teclado (`.info-tip`), Esc fecha.
- Popovers da barra: Pendências (`.ck-sino`) e Prontidão da base (`.ck-pront`) com 440px no desktop; cada pendência é um cartão com barra de 3px (Atenção âmbar, Urgente fúcsia).
- Campo de formulário (`.nl-campo`, componente `CampoNl`): 44px (área de texto com 88px no mínimo), rótulo fixo acima do campo, 12px (canvas v43, `nl-campo-rotulo-fix`: nada fica sobre o valor), erro com borda vermelha e mensagem ligada por `aria-describedby`. A marcação antiga com o campo antes do rótulo (F2, `frontend/partials/transporte.html`) mantém o rótulo flutuante dentro do campo, como foi aprovado nessa aba.
- Alvos de toque de 32px no celular ou ponteiro grosso, por área invisível (`::after`), sem mudar o desenho.
- Peças em `frontend/src/componentes/`: `CartaoBento`, `PilulaSubaba`, `TabelaNl` (vira cartões no celular; "Anotações" sempre por último; `grupo` opcional separa as linhas em blocos com rótulo e contagem), `Toasts`, `FolhaInferior` (gaveta à direita no desktop, folha de baixo no celular) e `SeloResponsavel` com `SeloLado` (CLIENTE em ciano, SIMPRESS em índigo; dica e nome acessível "Responsável (A)"). Regras puras em `nl-modelo.ts`, testadas em `tests/frontend/test_nl_componentes.cjs`. Ainda não estão montadas em nenhuma aba: cada aba as adota na própria sessão.
- O Assistente fica fora de tudo isso e mantém a paleta antiga.
