# Relatório mensal do contrato

Objetivo: entregar ao gestor do contrato 16467 uma planilha com o retrato do mês escolhido (inventário, última comparação, OS e uso do sistema), montada somente com dados que o Simpress já guarda localmente.

## Formato

- XLSX gerado com `openpyxl` (sem biblioteca de PDF). Nome do arquivo: `Relatorio-mensal-AAAA-MM.xlsx`.
- Gerado sob demanda por `GET /api/relatorio-mensal?mes=AAAA-MM`; nada é gravado em `data/`.
- Textos vindos das planilhas entram como texto literal (proteção contra fórmulas).
- A exportação conta como `exportacoes` em `metricas_uso.json`, como as demais exportações.

## Abas e origem de cada número

### `Resumo`

Cabeçalho: título `Relatório mensal — <mês> de <ano>`, contrato `16467 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR`, data de geração. Depois, uma tabela `Indicador | Valor | Origem` em quatro blocos:

| Bloco | Indicador | Origem |
| --- | --- | --- |
| Inventário | Equipamentos na base | Séries únicas da base oficial `EquipamentosDetalhes` carregada (o mesmo cache usado pela busca). O InvAll/Endpoint não aumenta o total. |
| Inventário | Unidades com equipamentos | Pares cidade + endereço de instalação distintos nessas séries. |
| Inventário | Linhas sem número de série | Linhas da base oficial com algum dado e série vazia (não entram no total). |
| Inventário | Séries duplicadas | Séries que aparecem em mais de uma linha da base oficial (contam uma vez no total). |
| Última comparação | Data da comparação | Atualização de inventário mais recente do histórico de planilhas com horário até o último dia do mês (restaurações e a linha de base fixa ficam de fora). |
| Última comparação | Sem correspondência — no endpoint | `ausentes_no_endpoint` dessa atualização, com a classificação atual do histórico. |
| Última comparação | Sem correspondência — na Simpress | `ausentes_em_detalhes`, sem as séries do Sebrae (`BRJ135P5XS`, `BRJ142QKBQ`, `BRJ9435VMR`, `BRJ9435VMF`, `BRJ149SCJG`). |
| Última comparação | Localidade divergente | `divergencias_local`, sem os hostnames `PRNOTESJP*`, `PRNOTERL*` e `PRNOTEARC*` (instalados em Curitiba). |
| Última comparação | Atualizações registradas no mês | Atualizações de inventário do histórico com horário dentro do mês. |
| OS do mês | OS Oracle abertas no mês | OS distintas (pela `ordem_servico`, ou `solicitacao` quando não houver) cuja `data_criacao` cai no mês. |
| OS do mês | OS Oracle concluídas no mês | OS cuja `data_conclusao` cai no mês. |
| OS do mês | OS Oracle pendentes no fim do mês | Criadas até o fim do mês e sem conclusão até essa data. Uma OS com status encerrado e sem data de conclusão não conta como pendente. |
| OS do mês | Pedidos Simpress abertos no mês | Pedidos distintos cuja data do pedido cai no mês. |
| OS do mês | Pedidos Simpress entregues no mês | Pedidos cuja etapa `Pedido entregue` tem data no mês. |
| OS do mês | Pedidos Simpress em andamento no fim do mês | Pedidos feitos até o fim do mês e sem entrega até essa data. Pedido com status de entregue ou cancelado sem data não conta como em andamento. |
| OS do mês | Encerrados sem data | OS ou pedidos encerrados sem data de conclusão/entrega; ficam fora das contagens de conclusão do mês. |
| Uso no mês | Transferências geradas, Comparações feitas, Exportações, OS conciliadas, Buscas | Soma dos dias do mês em `data/state/metricas_uso.json`. |
| Uso no mês | Horas economizadas (estimativa) | Σ(total × minutos configurados) / 60, somente quando há tempos configurados. |
| Uso no mês | Registrado desde | Primeiro dia com registro em `metricas_uso.json`. |

As OS vêm de `data/state/historico_chamados.json` (importado pela pasta `entrada_chamados` ou pela tela de chamados). São consideradas todas as importações guardadas no histórico; quando a mesma OS aparece em mais de uma, vale a versão da importação mais recente.

### Abas de detalhe

- `Inventário por tipo`: `Tipo | Equipamentos`, do maior para o menor; tipo vazio aparece como `Sem tipo`.
- `Inventário por unidade`: `Cidade | Endereço | Equipamentos`.
- `Comparação`: uma linha por pendência da última comparação: `Seção | Hostname | Série | Local previsto | Local na Simpress`. Seções: `Sem correspondência — no endpoint`, `Sem correspondência — na Simpress`, `Localidade divergente`.
- `OS do mês`: `Fonte | OS/Pedido | Série | Status | Criação | Conclusão | Situação no mês` (`Aberta no mês`, `Concluída no mês`, `Pendente no fim do mês`, combinadas por `; `). Só entram as OS e pedidos com alguma situação no mês.
- `Uso por dia`: `Data` e as cinco métricas, um dia por linha.

## Regras

- O inventário reflete a base oficial **atual** (não há fotografia mensal da base); o resumo informa o arquivo de origem e quando foi carregado.
- As regras do `AGENTS.md` valem como no histórico: equivalência de séries de MacBook, séries do Sebrae fora de `ausentes_em_detalhes`, exceção de Curitiba para `PRNOTESJP`, `PRNOTERL` e `PRNOTEARC`. Os arquivos de origem e o histórico não são regravados.
- Rótulos de fonte: `no endpoint` e `na Simpress`.
- `mes` precisa ser `AAAA-MM` válido e não pode ser posterior ao mês atual (422). Base não carregada: 503 com mensagem clara. Histórico de chamados ilegível: 503.
- Mês sem dados: a planilha é gerada mesmo assim, com zeros e a observação `Sem registros no mês`.

## Tela

- Menu lateral › `Históricos e Análises` › `Ações` › botão `Relatório mensal` (`#btn-relatorio-mensal`).
- Abre o diálogo `#modal-relatorio-mensal` (mesmo estilo do diálogo de contato de origem): campo `Mês` (`<input type="month">`, padrão = mês atual, máximo = mês atual), texto curto sobre o conteúdo e botão `Exportar relatório`.
- Durante a geração o botão fica desabilitado com `aria-busy="true"`; erros aparecem na região `role="status"` do diálogo e em toast.
- Sucesso: download do arquivo e toast com o texto exato `Planilha Exportada com Sucesso!`.
- Temas claro e escuro pelos tokens existentes; no celular o diálogo ocupa a largura com 16 px de margem, sem rolagem horizontal.

## Critérios de aceite

1. Com fixtures, o total de equipamentos é o número de séries únicas da base oficial; linhas sem série e séries duplicadas são sinalizadas e não alteram o total; registros só do Endpoint não entram.
2. A soma de `Inventário por tipo` e a de `Inventário por unidade` são iguais ao total.
3. Séries do Sebrae não aparecem em `Sem correspondência — na Simpress`; hostnames `PRNOTESJP`, `PRNOTERL` e `PRNOTEARC` não aparecem em `Localidade divergente`.
4. A comparação usada é a mais recente até o fim do mês; comparações posteriores ao mês são ignoradas.
5. OS abertas, concluídas e pendentes seguem as datas descritas acima; OS repetidas em várias importações contam uma vez.
6. O uso do mês soma exatamente os dias do mês em `metricas_uso.json`.
7. `mes` inválido ou futuro responde 422; o botão mostra `Planilha Exportada com Sucesso!` após o download.
8. `npm run verify` e `npm run test:ui:e2e` passam; nenhum dado real entra no Git.

## Limitações

- O inventário não é histórico: um relatório de um mês antigo mostra a base atual.
- As OS dependem das importações feitas; uma OS que nunca apareceu numa importação não é contada.
- O uso só existe a partir do dia em que as métricas começaram a ser registradas.
