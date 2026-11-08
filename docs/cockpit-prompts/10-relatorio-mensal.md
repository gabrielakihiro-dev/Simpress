# Prompt 10 — Relatório mensal (painel e prévia)

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Adaptar `Relatório mensal` para o painel da captura e acessá-lo pelo menu Ferramentas dos nove pontos como `F8`. O painel reúne indicadores do mês, gráficos/tabelas de dados disponíveis e uma prévia em texto com ações de copiar e exportar.

## Regras obrigatórias

1. Antes de editar, leia `AGENTS.md`, `docs/operacao/relatorio-mensal.md` e confira o estado do Git. Inspecione `domains/monthly_report.py`, `routers/monthly_report.py`, `static/js/features/monthly-report.js` e `#modal-relatorio-mensal`.
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

