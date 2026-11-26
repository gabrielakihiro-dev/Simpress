# Prompt 10 — Relatório mensal (painel e prévia)

Cole este prompt no agente de código com o repositório Simpress aberto.

Migração React BF4 (17/11/2026): a ponte `cockpit-tool-panels.js` e o painel React `ferramentas-cockpit` (ferramentas do Cockpit) estão descritos no primeiro parágrafo de `14-cockpit-v2.md`.

## Objetivo

Adaptar `Relatório mensal` para o painel da captura e acessá-lo pelo menu Ferramentas dos nove pontos como `F8`. O painel reúne indicadores do mês, gráficos/tabelas de dados disponíveis e uma prévia em texto com ações de copiar e exportar.

## Regras obrigatórias

1. Antes de editar, leia `AGENTS.md`, `docs/operacao/relatorio-mensal.md` e confira o estado do Git. Inspecione `domains/monthly_report.py`, `routers/monthly_report.py`, `frontend/src/paineis/relatorio-mensal/` e `#modal-relatorio-mensal`.
2. Reaproveite `build_monthly_report`, as regras e a fonte local existentes. O inventário continua refletindo a base oficial atual; chamados e pedidos vêm do histórico local; comparação segue as regras atuais. Não atualize nem regrave os dados para montar o painel.
3. Os valores, percentuais, categorias, meses, unidades e datas da captura são exemplos. Mapeie cada indicador e gráfico à sua fonte, regra e período antes de renderizar. Se os dados necessários não existirem, apresente `—`, uma mensagem de indisponibilidade ou omita o bloco; não infira por texto nem invente série temporal.
4. Não calcule tempo médio de fechamento sem datas individuais confiáveis, nem percentual sem denominador explícito. Não some categorias sobrepostas. “Até hoje” usa a data local atual para o mês em andamento; mês encerrado usa o período completo.
5. Preserve a validação atual de `mes` (`AAAA-MM`, mês válido, não futuro), o contrato do download `GET /api/relatorio-mensal?mes=...`, o nome de arquivo, as mensagens de erro e o texto de sucesso `Planilha Exportada com Sucesso!`.
6. Se a tela precisar de dados estruturados que hoje só existem dentro do gerador XLSX, exponha no máximo uma leitura local que reutilize o mesmo builder/serviços e serialização segura. Não duplique cálculos, não altere o contrato de exportação existente, não grave arquivos ou estado ao consultar a prévia e não faça chamadas externas.
7. O botão `Copiar texto` copia somente a prévia visível do mês selecionado e informa sucesso/erro de forma acessível. `Exportar planilha` usa o fluxo atual; não mostre sucesso antes de confirmar o download.
8. Preserve IDs, `data-*`, handlers, atributos ARIA, tema claro/escuro, navegação por teclado e movimento reduzido. Conteúdo vindo das APIs/planilhas é dado; renderize com APIs seguras do DOM.

## Composição do painel — substituída

> Substituída pelo "Layout operacional (07/11/2026)" no fim deste arquivo: não recrie os cartões de tempo médio, transportes e alterações de apelido, removidos a pedido do usuário. Mantida como histórico.

- O item `Relatório mensal` aparece no menu Ferramentas dos nove pontos com atalho `F8`; ele não entra na navegação principal. Atalho e clique abrem o mesmo painel e levam o foco ao título.
- No topo, use cartões para chamados abertos, concluídos (%), tempo médio até fechar (variação) e transportes (divergências). Cada cartão/percentual só aparece com origem e regra válidas no relatório do mês.
- Mostre o mês atual e meses recentes como seletores dinâmicos, sem nomes/datas fixos. O mês atual é parcial e exibe a data de corte real; meses passados mostram o período encerrado. Mantenha também o seletor `type=month` e limites existentes.
- A área central pode conter chamados abertos/concluídos por semana, movimentações por tipo e uma tabela em largura total com Unidades, Chamados, Transportes, Divergências e Tempo médio. Cada agrupamento deriva de datas, tipos e unidades reais. Se o `build_monthly_report` não oferecer detalhe suficiente, omita o bloco ou marque-o indisponível; não crie dados de demonstração.
- À direita, apresente em fonte mono a prévia textual do mesmo relatório e do mesmo mês selecionado. Inclua os totais que o relatório suporta: chamados, tempo médio, transportes, divergências, alterações de apelido, lista por tipo e top 3 unidades. Use os mesmos critérios do XLSX e omita ou marque indisponível qualquer parte sem dados suficientes; não mantenha duas versões independentes do conteúdo.
- No rodapé da prévia, ofereça `Copiar texto` e `Exportar planilha`. Mantenha feedback legível e o estado de carregamento/erro; em telas pequenas, os controles continuam acessíveis sem sobreposição.

## Layout reestruturado (Cockpit, Etapa F) — substituído

> Substituído pelo "Layout operacional (07/11/2026)" abaixo; mantido como histórico.

Sobrepõe a composição acima no painel Cockpit (`data-cockpit-tool-panel="relatorio"`); mesmos dados, endpoints, exportação e IDs.

1. **Barra única:** meses recentes (`#cockpit-monthly-periods`), seletor de mês, `Copiar resumo`, `Exportar planilha` e o status, na mesma linha (quebra em telas menores).
2. **KPIs:** mantidos (`#cockpit-monthly-kpis`).
3. **Grade de 2 colunas (≥1200px):** esquerda = gráfico de ordens + tabela de inventário por unidade; direita = cartões compactos — `Inventário por tipo` (número grande + rótulo), `Divergências` (um número por categoria de `comparacao.contagens`, mais as linhas de detalhe quando houver) e `Ordens do mês` (abertas/concluídas/pendentes por fonte, mais as linhas de detalhe quando houver). Também na coluna direita, `Resumo da base atual`.
4. **Dados insuficientes:** aviso curto de uma linha (`role="status"`) acima da grade, somente quando `os.dados_insuficientes` tem itens; o detalhe fica no `title`.
5. **Prévia para a gestão:** `<details>` fechado por padrão com `#cockpit-monthly-preview`; `Copiar resumo` copia o texto mesmo recolhida.
6. **<1200px:** mesma ordem em 1 coluna; só muda a disposição, sem estilo novo.

## Responsividade e acessibilidade

- Vale a regra geral do `AGENTS.md`: de 320px a 2560px sem rolagem horizontal da página e sem `min-width:1200px`. Tabelas largas rolam dentro da própria caixa e viram cartões no celular.
- Preserve foco visível, nomes acessíveis, `aria-live` para estados de cópia/exportação e `prefers-reduced-motion`.

## Integração e validação

1. Escreva no relatório operacional o mapeamento confirmado das métricas novas antes de introduzir qualquer regra de negócio. Prefira os campos já cobertos pela especificação; não expanda o escopo para preencher a captura.
2. Teste mês atual parcial, mês encerrado, mês sem dados, erro de base e datas/status insuficientes. Compare a prévia com os mesmos valores exportados para XLSX.
3. Teste copiar texto, erro de clipboard, exportar, validação de mês e atalho `F8`, usando fixtures sintéticas. Não altere relatórios automáticos, planilhas ou estado operacional real.
4. Rode `npm run verify` e `npm run test:ui:e2e`; confira tema claro/escuro em 1200px ou mais e rolagem horizontal acessível abaixo desse limite. Revise `git diff --check` e o diff preparado.
5. Faça commit local somente se estiver autorizado na conversa atual. Não faça push sem autorização explícita.

## Relato final

Liste a origem usada por cada cartão, gráfico, tabela e trecho da prévia; indique o que ficou indisponível por falta de dados; e informe com precisão os testes executados e o contrato de exportação preservado.

## Layout operacional (07/11/2026)

Substituído em parte em 18/11/2026: ver "Novo layout, A com sub-abas" no fim deste arquivo (quatro abas, sem a comparação, sem a linha de status).

Autorização: pedido do usuário de 07/11/2026 ("tudo está desconexo… planejar um layout perfeito e conectar às outras abas"), com plano e mockups aprovados no mesmo dia (canvas de Design da sessão: desktop claro, desktop escuro e celular). O usuário autorizou explicitamente os elementos visuais que o artefato de referência do Cockpit não tem: bloco tracejado para o que não muda com o mês, barras proporcionais em `Inventário por tipo` e botões de filtro por situação. Decisões do usuário: foco em acompanhar a operação (pendências no topo); remover `Tempo médio até fechar`, `Transportes` e `Alterações de apelido` da tela e da prévia (a XLSX não muda); escopo front-end + o campo de leitura `comparacao.evento_id`; incluir os chamados do SoftExpert (aba Chamados, F5) em duas etapas: primeiro a situação atual e a lista com data conhecida (esta entrega, só front-end), depois uma contagem mensal no backend (etapa 2, feita em 07/11/2026; ver "Etapa 2: contagem do mês no servidor" abaixo).

Problemas que motivaram a mudança: o mesmo número aparecia três vezes (KPIs, gráfico e cartão) e de novo na prévia; dois KPIs eram sempre `—`; inventário da base atual misturado com dados do mês; listas sem ação; registros fora das contagens só no `title`; data crua no status; o painel não acompanhava importações.

Composição (IDs antigos mantidos: `#cockpit-monthly-periods`, `-month`, `-copy`, `-export`, `-status`, `-kpis`, `-details`, `-preview`; novos: `#cockpit-monthly-period`, `#cockpit-monthly-attention`, `#cockpit-monthly-attention-title`, `#cockpit-monthly-fora`, títulos `#cockpit-monthly-{os,comp,sebrae,base,movimento}-title` e `data-rel-secao` em cada seção):

| Bloco | Fonte | Observação |
| --- | --- | --- |
| `Precisa de atenção` | `os.oracle/simpress.pendentes`, `comparacao.contagens`, `comparacao.horario`, `os.dados_insuficientes` | `Ver lista ↓` leva à seção (o das OS já filtra `Pendentes`). |
| `Movimento do mês` | `os.*.abertas/concluidas/encerradas_sem_data` | Pendentes ficam só no bloco de atenção. |
| `OS e pedidos do mês` | `os.linhas` (mesma aba `OS do mês` da XLSX) | Filtro por `situacao`; 25 por vez. |
| `Pendências da comparação` | `comparacao.linhas` | `Abrir no Resumo (F3)` só com `evento_id`. |
| `Chamados (F5)` · `Situação atual` | `GET /api/sebrae/novos` (totais de hoje) e `report.sebrae` de `GET /api/relatorio-mensal/dados` (contagem do mês) | Totais de hoje com a regra do F5 (`sebraeOpenLists`: finalizado pelo site não conta como aberto). `Com data em <mês>`: `Abertos no mês`, `Finalizados no mês` e a linha dos sem data, contados no servidor; lista `report.sebrae.linhas`, uma linha por chamado (`Chamado`, `Título`, `Série`, `Abertura`, `Finalização`, `Situação no mês`). As duas partes falham separadamente. |
| `Base atual` · `Não muda com o mês` | `inventario` | Top 8 unidades; `Ver todas as N unidades` / `Ver menos`. |
| `Prévia para a gestão` | `monthlyPreviewText` | Inclui período, `Comparação usada` e, se carregaram, a linha da situação atual do F5 e a da contagem do mês (`report.sebrae`). |

Ligações: ver `docs/operacao/relatorio-mensal.md`, seção "Tela". Nada é gravado; o único POST observado ao navegar é a consulta `POST /api/equipamentos/usuarios-logados`, feita pela própria aba OS.

Textos novos aceitos pelo usuário em 07/11/2026: `Precisa de atenção`, `OS pendentes no fim do período`, `Comparação de inventário`, `Fora das contagens`, `Mostrar registros`, `Ocultar registros`, `Movimento do mês`, `OS e pedidos do mês`, `Pendências da comparação`, `Comparação usada`, `Base atual`, `Não muda com o mês`, `Ver lista ↓`, `Ver na aba OS (F6)`, `Abrir no Resumo (F3)`, `Ver todas as N unidades`. Da opção escolhida para os chamados do SoftExpert: `Situação atual`. Textos de apoio desta entrega (seguem o mesmo padrão): `Chamados (F5)`, `Chamados novos`, `Antigos em aberto`, `Ver novos`, `Ver antigos`, `Com data em <mês>`, `Aberto no mês`, `Finalizado no mês`, `Abertos no mês`, `Finalizados no mês`, `Sem data de abertura ou de encerramento: N`, `(fora da contagem)`, `Encerradas sem data`, `Unidades com mais equipamentos`, `Criados até o corte e ainda sem conclusão ou entrega.`, `Datas ou vínculo insuficientes: não entram nos números do mês.`, `Contagem pelo Dashboard importado (abertura em P, encerramento em R), pelos chamados novos da busca e pelos finalizados pelo site.` (substituiu, na etapa 2, a nota antiga sobre data conhecida), `Nenhum Dashboard importado. A importação e a busca ficam na aba Automação (F4).`

Limites conhecidos: a aba OS (F6) mostra a situação atual, sem filtro por mês; o atalho para ela filtra pela série. A contagem do mês depende do Dashboard importado (a cópia local, não o SharePoint ao vivo): chamado sem nenhuma data fica fora da contagem e aparece só na linha `Sem data de abertura ou de encerramento`. O link para a aba Chamados só aparece quando a linha do mês casa com um chamado carregado no F5. A lista de finalizados de `GET /api/sebrae/novos` continua limitada aos 100 mais recentes (`MAX_FINALIZADOS_NO_DASHBOARD`): isso vale só para os totais da `Situação atual` e para o link de um finalizado antigo; a contagem do mês (`report.sebrae`) não tem esse limite.

### Etapa 2: contagem do mês no servidor (07/11/2026)

Decisão do usuário de 07/11/2026: a fonte são os dados locais, só leitura (cópia do Dashboard importado, aba `CHAMADOS`, abertura em P e encerramento em R; chamados novos da última busca, abertura = `Habilitada em`; finalizados pelo site com status ok, que vencem a coluna R). Os chamados com número antigo de 5 dígitos contam pelas próprias datas P/R, deduplicados pelo número; sem número, a chave é `linha:N`. "Sem data" significa sem nenhuma data (nem abertura nem encerramento) e fica fora de `Abertos no mês` e `Finalizados no mês`. A XLSX não muda. A contagem aparece na tela, na prévia e no Assistente. Contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md` (rota 68).

Tela (`monthlySebraeSection`): a `Situação atual` (`GET /api/sebrae/novos`) continua igual; abaixo, `Com data em <mês>` lê `report.sebrae`:

- `null` (sem Dashboard importado): `Nenhum Dashboard importado. A importação e a busca ficam na aba Automação (F4).`;
- `{erro}`: a mensagem em `ck-nota ck-nota--erro`, só nessa subparte (a situação atual e o resto do relatório continuam);
- com dados: `Abertos no mês`, `Finalizados no mês`, `Sem data de abertura ou de encerramento: N (fora da contagem)`, a nota da fonte e a tabela (25 por vez, `Carregar mais`; cartões no celular). Série vazia é completada pela coluna K do chamado novo (`novos.formulario[].linha.K`); sem série, `—`. O número só vira link para a aba Chamados (F5) quando casa com os dados do F5, usando a chave do F5 (`sebraeMonthMatch`): UTIC igual; número antigo de 5 dígitos ou `linha:N` casam com o antigo `linha:N` do F5 pelo texto da coluna C, só com resultado único.

Prévia: `Chamados (F5), com data em <mês>: Abertos no mês N · Finalizados no mês N · Sem data de abertura ou de encerramento: N (fora da contagem)`, omitida com erro ou sem Dashboard importado.

## Sub-abas (12/11/2026)

Substituído em parte em 18/11/2026: ver "Novo layout, A com sub-abas" no fim deste arquivo (quatro abas, sem a comparação, sem a linha de status).

Autorização do usuário de 12/11/2026: dividir o Relatório Mensal (F8) em cinco sub-abas, para a tela não virar uma rolagem longa. É só navegação: nada é gravado em sistema externo nem em dado local, e a XLSX, a prévia e o endpoint seguem iguais. O `Layout operacional (07/11/2026)` continua valendo para o conteúdo de cada bloco; muda só onde cada bloco aparece.

Sub-abas (tablist `Assuntos do relatório`, abaixo da barra de mês, acima do corpo):

| Aba (`id`) | Rótulo | Painel (`id`) | Conteúdo |
|---|---|---|---|
| `rel-aba-visao` | `Visão geral` | `rel-painel-visao` | `Precisa de atenção`, `Movimento do mês`, faixa `Chamados (F5)` com `Ver chamados →` e `Prévia para a gestão`. |
| `rel-aba-os` | `OS e pedidos do mês` | `rel-painel-os` | Seção `OS e pedidos do mês`, com o filtro e `Carregar mais`. |
| `rel-aba-comp` | `Pendências da comparação` | `rel-painel-comp` | Seção `Pendências da comparação`. |
| `rel-aba-sebrae` | `Chamados (F5)` | `rel-painel-sebrae` | Seção `Chamados (F5)`: `Situação atual` e `Com data em <mês>`. |
| `rel-aba-base` | `Base atual` | `rel-painel-base` | Seção `Base atual`, com `Não muda com o mês`. |

Contadores nas abas (`rel-os-contagem`, `rel-comp-contagem`, `rel-sebrae-contagem`), com o total de linhas do mês na fonte da aba (o filtro `Todas`/`Pendentes` da OS não muda o contador):

- OS: linhas de `os.linhas`; tom de alerta quando for maior que zero.
- Pendências da comparação: linhas de `comparacao.linhas`; tom de alerta quando for maior que zero.
- Chamados (F5): linhas da contagem do mês (`report.sebrae.linhas`); tom neutro, porque só informa.
- `Visão geral` e `Base atual` não têm contador. Se a fonte não veio (sem Dashboard, erro, carregando), o contador fica oculto e nunca mostra o número do mês anterior. Sem nenhuma comparação, o servidor devolve lista vazia e a aba mostra `0`.

Textos novos: `Visão geral` e `Ver chamados →` (botão da faixa `Chamados (F5)`). Os outros rótulos já eram textos aprovados e não mudaram. `Ver lista ↓` (OS e comparação) e `Ver chamados →` trocam para a aba certa e levam o foco ao título da seção; `Ver lista ↓` da OS abre a aba já filtrada em `Pendentes`.

IDs novos: `rel-aba-*`, `rel-painel-*`, `rel-*-contagem`, `cockpit-monthly-estado` (carregando e erro; o invólucro `cockpit-monthly-details` nunca é esvaziado), `cockpit-monthly-chamados` (faixa), `cockpit-monthly-chamados-dados` e `cockpit-monthly-chamados-ver`. Os `id` dos títulos das seções (`cockpit-monthly-<chave>-title`) e os `data-rel-secao` não mudaram.

Comportamento:

- Abre em `Visão geral` só na primeira abertura do F8. A aba escolhida fica ao mudar o mês, ao recarregar em silêncio (importar OS ou nova comparação com o F8 aberto) e ao fechar e reabrir o F8 na mesma carga da página. O filtro da OS fica só na recarga silenciosa; ao mudar o mês, volta a `Todas`. Carregando e erro aparecem em `cockpit-monthly-estado`, com as abas sempre à vista.
- Carregar uma vez (18/11/2026, pedido do usuário): fechar e reabrir o F8 no mesmo mês não refaz `GET /api/relatorio-mensal/dados`; a tela, a aba e o filtro ficam como estavam. Se algo mudou com o F8 fechado (importar OS, `simpress:chamados-atualizados`; ou o painel chegou com outra comparação ou inventário, `simpress:painel-atualizado`), a reabertura faz a recarga silenciosa (mantém aba e filtros, sem `Carregando`). Falha na carga também recarrega ao voltar. Limite: o Dashboard regravado pelo agendador não avisa a tela; o F8 só vê a mudança ao trocar o mês ou quando um desses sinais chegar. Teste: "Relatório mensal (F8) carrega uma vez…" em `tests/frontend/test_cockpit_tool_panels.cjs`.
- Teclado, mesmo molde da F6: `role=tablist` / `tab` / `tabpanel`, `aria-selected`, `tabindex` rotativo (só a aba ativa entra na ordem do Tab), setas circulares, `Home` e `End`; focar uma aba pelas setas a ativa.
- Telas pequenas: a tablist rola sozinha na horizontal (a página nunca rola); em ponteiro grosso cada aba tem no mínimo 44px de altura.

Verificação: `tests/e2e/monthly-report.spec.cjs` (abas, contadores, clique, teclado, `Ver lista ↓`, `Ver chamados →`, mudança de mês, 320px e axe nas cinco abas nos dois temas) e `tests/frontend/test_cockpit_tool_panels.cjs`.

## Notas dos cartões no ⓘ (Bloco 2, 14/11/2026)

Substituído em parte em 18/11/2026: ver "Novo layout, A com sub-abas" no fim deste arquivo (quatro abas, sem a comparação, sem a linha de status).

Pedido do usuário (14/11/2026, plano `docs/planos/limpeza-textos-explicativos.md`, Bloco 2): as três notas que só explicavam o número saíram da tela e foram para um ⓘ (`.info-tip`) ao lado do título do cartão, na mesma linha (`div.ck-rel__cartao-cab`, em `flex`). O texto de cada nota é o mesmo de antes (texto aprovado, ver acima); mudou só o lugar. Componente e contrato: `docs/cockpit-prompts/14-cockpit-v2.md`.

| Cartão | Balão (`role="tooltip"`) | `aria-label` do botão |
|---|---|---|
| `OS pendentes no fim do período` | `#cockpit-monthly-pendentes-nota` | `Sobre as OS pendentes` |
| `Fora das contagens` | `#cockpit-monthly-fora-nota` | `Sobre fora das contagens` |
| `Com data em <mês>` (Chamados (F5), `Situação atual`) | `#cockpit-monthly-sebrae-nota` | `Sobre a contagem do mês` |

- Os ids são fixos porque o painel é redesenhado a cada leitura e o e2e os usa.
- Continuam visíveis, por serem dado: o total e a lista de `Fora das contagens`, a linha `Comparação usada` (`p.ck-rel__nota`), `Mostrando X de Y`, `Sem data de abertura ou de encerramento: N` e a origem dos dados. O estado vazio não mudou.
- Testes: `tests/frontend/test_cockpit_tool_panels.cjs` (os três balões com texto exato e nenhuma `p.ck-rel__nota` com o texto antigo) e `tests/e2e/monthly-report.spec.cjs` (texto escondido até mouse, toque ou foco; foco + `Esc` fecha só o balão; a altura da linha do título não cresce além do ⓘ de 24px).

## Visual bento (Bloco 2, 14/11/2026)

Substituído em parte em 18/11/2026: ver "Novo layout, A com sub-abas" no fim deste arquivo (quatro abas, sem a comparação, sem a linha de status).

Só a aparência mudou, a pedido do usuário, seguindo o canvas "Simpress Bento" (opção A, telas `rel-visao`, `rel-os`, `rel-pend`, `rel-cha` e `rel-base`). Textos, IDs, ARIA, `data-*`, botões e regras ficam como estavam; nada de texto novo.

- Cartões: `monthlyCartao` (`frontend/src/paineis/ferramentas-cockpit/estado.ts`) transforma cada cartão ou seção existente em cartão bento (`.ck-bento-cartao > .ck-bento-face`, com tom ciano, fúcsia, âmbar ou índigo). O elemento externo guarda `id`, ARIA e `data-*`, então os seletores do e2e continuam valendo. Visão geral: OS pendentes (ciano), Comparação de inventário (fúcsia), Fora das contagens (âmbar, número grande) e Movimento (índigo); OS e pedidos (ciano), Pendências (fúcsia) e Chamados (F5) (âmbar): um cartão por seção. Base atual: os quatro totais continuam numa seção só; os três blocos de dentro (números, tipos, unidades) viram cartões. Como no desenho, o cartão dos totais ocupa a largura toda, com os quatro totais em 4 colunas (2 abaixo de 1024px, 1 abaixo de 640px); tipos e unidades ficam lado a lado embaixo (1 coluna abaixo de 640px).
- Barra do mês, sub-abas e filtros: pílulas de 38px com borda ciano na escolhida; botões de 40px na barra e de 32px nos cartões; números em caixinhas com valor de 32px; faixa de Chamados (F5) e `Prévia para a gestão` com a mesma superfície dos cartões e seta que gira ao abrir.
- Tabelas: de 1200px para cima, tabela com cabeçalho em maiúsculas pequenas; abaixo, cartões com rótulo à esquerda (40%) e valor à direita (`ck-tabela--cards`). Essas regras ficam em `static/styles/ck-cockpit.css`, porque `tests/frontend/test_ui_motion.cjs` proíbe `tr` e `.ck-tabela` no `ck-bento.css`.
- CSS novo em `static/styles/ck-bento.css`, seção 11.2, preso a `[data-cockpit-tool-panel="relatorio"]`; as sub-abas (`.rel-aba`) ganharam cor nova só ali, pois o teste do `ck-cockpit.css` não aceita cor nova nelas. Sem Tailwind, sem `npm run build:ui`, sem refazer `static/index.html`.
- Movimento (só com `prefers-reduced-motion: no-preference`, `docs/ui-motion/contrato-bento.md`): entrada de 700 ms (cartões 760 ms) com passos de 80 ms; barras crescem em 700 ms com 200 ms de espera e os números contam em 900 ms (`data-bento-largura` e `data-bento-contar`); tudo se repete ao trocar de sub-aba; filtrar ou usar `Carregar mais` não refaz a entrada do cartão (`data-sem-entrada`). Botão sobe 3px, sub-aba sobe 2px e a seta anda 3px ao passar o mouse (300 ms).
- Desvios do desenho: a barra do mês (meses, campo do mês, `Copiar resumo` e `Exportar planilha`) segue numa linha compacta que o desenho não tem; as séries usam a fonte do corpo, como no desenho (antes eram em fonte monoespaçada).
- Não verificado: comparação pixel a pixel com o desenho, capturas de 320px a 2560px e o tema escuro a olho.

## Novo layout, "A com sub-abas" (18/11/2026)

Pedido do usuário de 18/11/2026, seguindo as telas `NL-F8-Relatorio`, `NL-F8-Grafico` e `NL-F8-Meses` do canvas (versão desktop e `-cel`). Onde esta seção contradiz as anteriores (`Layout operacional`, `Sub-abas`, `Notas dos cartões`, `Visual bento`), vale esta: pedido do usuário vence texto aprovado. Mesmos dados, endpoints, XLSX e prévia; sem API nova e sem busca extra. IDs, ARIA e `data-*` existentes foram mantidos. Só a aparência vem do CSS de `static/styles/nl-f3-f7-f8.css` (seção F8, presa a `[data-cockpit-tool-panel="relatorio"]`); o que muda de estrutura está em `estado.ts` (`monthly*`), no partial do painel e em `frontend/src/paineis/relatorio-mensal/`.

Mudanças:

1. **Quatro sub-abas** (nota de 26/11/2026: agora são cinco, com `Tendências` depois de `Base atual`; ver "Sub-aba Tendências (26/11/2026)" no fim deste arquivo): `Visão geral`, `OS e pedidos do mês`, `Chamados (F5)`, `Base atual`. A aba `Pendências da comparação` e a seção `Comparação de inventário` saíram da tela (ids `rel-aba-comp`, `rel-painel-comp`, `rel-comp-contagem` e `cockpit-monthly-comp-*` não existem mais). Os dados da comparação continuam na XLSX e em `Copiar resumo` (linha `Comparação usada`); a seção em texto simples não se aplica mais.
2. **Barra do mês:** rótulo `Mês do relatório`, pílulas dos três meses mais recentes, selo `Parcial até dd/mm/aaaa` ou `Mês encerrado` (`#cockpit-monthly-period`), `Copiar resumo` e `Exportar planilha` (primário). No modal de exportação (`modais.html` e `relatorio-mensal/formulario.tsx`) o rótulo é `Mês` com `*` vermelho, sem dois-pontos.
3. **Status sem linha visível:** `#cockpit-monthly-status` ficou `sr-only` com `aria-live="polite"`. Painel: carregando `Carregando dados do relatório…`; erro `Falha ao carregar o relatório.` (ou a mensagem do servidor), sempre com toast curto. Exportação (modal): inválido `Selecione o mês atual ou um mês anterior.` com toast; gerando `Gerando relatório...`; erro `Falha ao gerar o relatório mensal.` e toast curto; sucesso: toast `Planilha Exportada com Sucesso!` (texto exato, sem contagens).
4. **Visão geral:** `Precisa de atenção` com o cartão `OS pendentes no fim do período`, o cartão `Chamados (F5)` (`#cockpit-monthly-chamados`, fixo no partial, nunca recriado; chips `N novos` âmbar e `N antigos` fúcsia e `Ver chamados →`) e, só quando há registros, `Fora das contagens`. Depois, `Movimento do mês` (tabela Fonte, Abertas, Concluídas, Encerradas; cartões no celular), o gráfico e `Prévia para a gestão`.
5. **Gráfico do movimento** (`relatorio-mensal/grafico-semanal.ts`, teste `tests/frontend/test_relatorio_grafico.cjs`): segmentado `Fonte` (`Ambas`, `Oracle`, `Simpress`; `aria-label="Fonte"`), legenda com a soma das barras de cada série (o total do servidor de `Encerradas` inclui OS criadas antes do mês, que não têm barra), barras agrupadas por semana, eixo Y com grade, `title` em cada barra, área do gráfico com `role="img"` e `aria-label`. Escala única em `Ambas`, sem folga acima do maior valor. Entrada das barras com 40 ms de escalonamento (`scaleY`; atraso até 400 ms, mais 300 ms de animação), zerada com `prefers-reduced-motion`. Eixo, contagens e barras vêm de `report.os.linhas`; "Encerradas" por semana usa a data de criação, porque o relatório não guarda a data de encerramento.
6. **OS e pedidos do mês:** rótulo `Filtrar por situação` acima do segmentado `Todas`, `Abertas`, `Concluídas` e `Pendentes`; paginação de 20 em 20 com `Mostrando 20 de N` e `Carregar mais` (o rodapé só aparece quando há mais a mostrar).
7. **Chamados (F5):** título e selo `Situação atual` fora dos cartões; cartões `Chamados novos` com `Ver novos →` (âmbar) e `Antigos em aberto` com `Ver antigos →` (fúcsia); cartão de informação `Com data em <mês por extenso>` (por exemplo `outubro de 2026`) com o chip `N sem data` e os números `Abertos` e `Finalizados`. A nota da fonte e a frase `Sem data de abertura ou de encerramento: N (fora da contagem)` saíram da tela (continuam na prévia). A tabela de linhas do mês e os estados (`Nenhum Dashboard importado...`, erro só dessa parte) seguem como antes.
8. **Base atual:** selo `Não muda com o mês` (sem bloco tracejado); `Inventário por tipo` em linhas sem barras; `Ver todas as N unidades →` / `Ver menos`; sem nota de origem.
9. Links `Ver ... →` na cor do cartão; setas andam na horizontal ao passar o mouse (300 ms, zerado com movimento reduzido).

Desvios do desenho (decididos, não pendências): sem o cabeçalho da tela do desenho (h1, `F8`, `Voltar`/`Esc`), porque o cockpit já tem o seu; sem a marca deslizante entre as sub-abas (a aba ativa troca de estilo); os quatro números da Base ficam em caixas dentro de um só cartão; a coluna `OS/Pedido` da tabela de OS foi mantida; em 320px as sub-abas rolam na horizontal se não couberem.

Assistente (`domains/assistant_chat.py`, regra do F8, e `tests/test_assistant_estilo_e_abas.py`): alinhado às quatro sub-abas; não cita mais `Pendências da comparação` (o teste confere a ausência).

Verificação: `tests/frontend/test_cockpit_tool_panels.cjs`, `tests/frontend/test_relatorio_grafico.cjs` e `tests/e2e/monthly-report.spec.cjs` (quatro abas, selo do período, toast, chip e cartões de Chamados, 320px e axe nos dois temas). Não verificado: comparação pixel a pixel com o desenho e o tema escuro a olho.

## Sub-aba Tendências (26/11/2026)

Aprovado pelo usuário em 26/11/2026: quinta sub-aba do F8, depois de `Base atual`. Só leitura: nada é gravado, e a XLSX, a prévia e `Copiar resumo` não mudam.

- Rota: `GET /api/relatorio-mensal/tendencias?dias=30|90` (`build_trends` em `domains/monthly_report.py`; rota em `routers/monthly_report.py`; contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md`). Outro valor ou ausente: 422 `O período deve ser de 30 ou 90 dias.`; histórico de chamados ilegível: 503. Só agregados, sem série, hostname ou nome.
- Período: `inicio` = hoje − (dias − 1) até hoje, sem depender do mês da barra. Selo `Até hoje · não muda com o mês`. Seletor `Período`: `30 dias` | `90 dias` (padrão 30). Carrega ao abrir a aba e ao trocar o período.
- Cartão `Tempo médio das OS`: OS Oracle de `data/state/historico_chamados.json` com conclusão dentro do período (a criação pode ser anterior); média em dias de (conclusão − criação), 1 casa decimal. Mesma deduplicação do F8 (`ordem_servico`/`solicitacao`; importação mais nova vence). Duração negativa fica de fora. Pedidos Simpress ficam fora (medem entrega, não OS). Compara com os N dias anteriores (`Variação`); sem anterior: `Sem OS encerradas nos N dias anteriores para comparar.` Aviso `Encerradas sem data de conclusão ficam de fora: N` (encerradas sem data e criadas no período).
- Cartão `Sem acesso há 7 dias ou mais`: um ponto por atualização de inventário no período, da lista `comparacao.sem_acesso_7_dias` de cada evento de `data/state/historico_comparacoes.json`, sem Backup e Administrador (mesma regra do F3 e do sino; evento antigo sem lista usa `resumo.sem_acesso_7_dias`; sem nenhum dos dois, o evento é ignorado). Restaurações e a linha de base fixa ficam de fora. A lista cobre todos os computadores do Endpoint, não só notebooks. Gráfico de linha simples em SVG, `Primeira (dd/mm)`, `Variação no período`; selo `Histórico desde dd/mm/aaaa` quando o histórico começa depois do início do período.
- Sem dados: `Sem dados suficientes nos últimos N dias.`, com `Nenhuma OS Oracle encerrada com data no período.` ou `Menos de 2 atualizações de inventário no período.` Carregando `Carregando tendências…`; erro `Falha ao carregar as tendências.`
- Fora do escopo: "modelos/regionais com mais incidentes de hardware". As OS gravadas não têm categoria de incidente; classificar por texto livre seria inventar. Proposta futura não aprovada: "Modelos e cidades com mais OS".
- Riscos conhecidos: o tempo médio depende de a exportação Oracle continuar trazendo as OS concluídas e do limite de 50 importações (`MAX_TICKET_SNAPSHOTS`); por isso a janela anterior de 90 dias (91 a 180 dias atrás) pode estar incompleta.
- O cartão `Tempo médio até fechar`, removido em 07/11/2026, continua fora do resumo, da visão geral e da prévia; o tempo médio volta só na sub-aba `Tendências`.
