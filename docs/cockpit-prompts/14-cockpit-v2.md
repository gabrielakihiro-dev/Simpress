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
