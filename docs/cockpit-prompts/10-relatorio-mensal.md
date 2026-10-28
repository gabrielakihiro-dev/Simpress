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

## Composição do painel

- O item `Relatório mensal` aparece no menu Ferramentas dos nove pontos com atalho `F8`; ele não entra na navegação principal. Atalho e clique abrem o mesmo painel e levam o foco ao título.
- No topo, use cartões para chamados abertos, concluídos (%), tempo médio até fechar (variação) e transportes (divergências). Cada cartão/percentual só aparece com origem e regra válidas no relatório do mês.
- Mostre o mês atual e meses recentes como seletores dinâmicos, sem nomes/datas fixos. O mês atual é parcial e exibe a data de corte real; meses passados mostram o período encerrado. Mantenha também o seletor `type=month` e limites existentes.
- A área central pode conter chamados abertos/concluídos por semana, movimentações por tipo e uma tabela em largura total com Unidades, Chamados, Transportes, Divergências e Tempo médio. Cada agrupamento deriva de datas, tipos e unidades reais. Se o `build_monthly_report` não oferecer detalhe suficiente, omita o bloco ou marque-o indisponível; não crie dados de demonstração.
- À direita, apresente em fonte mono a prévia textual do mesmo relatório e do mesmo mês selecionado. Inclua os totais que o relatório suporta: chamados, tempo médio, transportes, divergências, alterações de apelido, lista por tipo e top 3 unidades. Use os mesmos critérios do XLSX e omita ou marque indisponível qualquer parte sem dados suficientes; não mantenha duas versões independentes do conteúdo.
- No rodapé da prévia, ofereça `Copiar texto` e `Exportar planilha`. Mantenha feedback legível e o estado de carregamento/erro; em telas pequenas, os controles continuam acessíveis sem sobreposição.

## Layout reestruturado (Cockpit, Etapa F)

Sobrepõe a composição acima no painel Cockpit (`data-cockpit-tool-panel="relatorio"`); mesmos dados, endpoints, exportação e IDs.

1. **Barra única:** meses recentes (`#cockpit-monthly-periods`), seletor de mês, `Copiar resumo`, `Exportar planilha` e o status, na mesma linha (quebra em telas menores).
2. **KPIs:** mantidos (`#cockpit-monthly-kpis`).
3. **Grade de 2 colunas (≥1200px):** esquerda = gráfico de ordens + tabela de inventário por unidade; direita = cartões compactos — `Inventário por tipo` (número grande + rótulo), `Divergências` (um número por categoria de `comparacao.contagens`, mais as linhas de detalhe quando houver) e `Ordens do mês` (abertas/concluídas/pendentes por fonte, mais as linhas de detalhe quando houver). Também na coluna direita, `Resumo da base atual`.
4. **Dados insuficientes:** aviso curto de uma linha (`role="status"`) acima da grade, somente quando `os.dados_insuficientes` tem itens; o detalhe fica no `title`.
5. **Prévia para a gestão:** `<details>` fechado por padrão com `#cockpit-monthly-preview`; `Copiar resumo` copia o texto mesmo recolhida.
6. **<1200px:** mesma ordem em 1 coluna; só muda a disposição, sem estilo novo.

## Responsividade e acessibilidade

- Mantenha `min-width:1200px` no app. Abaixo disso, a página pode rolar horizontalmente para preservar a composição completa; não corte os controles.
- Em desktop, mantenha a área analítica à esquerda e a prévia à direita, com rolagem independente se necessário.
- Gráficos devem ter legenda, rótulo textual e alternativa acessível aos valores; cor sozinha não comunica série.
- Preserve foco visível, nomes acessíveis, `aria-live` para estados de cópia/exportação e `prefers-reduced-motion`.

## Integração e validação

1. Escreva no relatório operacional o mapeamento confirmado das métricas novas antes de introduzir qualquer regra de negócio. Prefira os campos já cobertos pela especificação; não expanda o escopo para preencher a captura.
2. Teste mês atual parcial, mês encerrado, mês sem dados, erro de base e datas/status insuficientes. Compare a prévia com os mesmos valores exportados para XLSX.
3. Teste copiar texto, erro de clipboard, exportar, validação de mês e atalho `F8`, usando fixtures sintéticas. Não altere relatórios automáticos, planilhas ou estado operacional real.
4. Rode `npm run verify` e `npm run test:ui:e2e`; confira tema claro/escuro em 1200px ou mais e rolagem horizontal acessível abaixo desse limite. Revise `git diff --check` e o diff preparado.
5. Faça commit local somente se estiver autorizado na conversa atual. Não faça push sem autorização explícita.

## Relato final

Liste a origem usada por cada cartão, gráfico, tabela e trecho da prévia; indique o que ficou indisponível por falta de dados; e informe com precisão os testes executados e o contrato de exportação preservado.
