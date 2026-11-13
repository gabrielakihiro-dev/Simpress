# Relatório mensal do contrato

Objetivo: entregar ao gestor do contrato 16467 uma planilha com o retrato do mês escolhido (inventário, última comparação e OS), montada somente com dados que o Simpress já guarda localmente.

## Formato

- XLSX gerado com `openpyxl` (sem biblioteca de PDF). Nome do arquivo: `Relatorio-mensal-AAAA-MM.xlsx`.
- Gerado sob demanda por `GET /api/relatorio-mensal?mes=AAAA-MM`; o download não grava nada em `data/`. O mês atual é parcial até a data local do servidor; meses anteriores usam o mês completo.
- A prévia Cockpit usa `GET /api/relatorio-mensal/dados?mes=AAAA-MM`, construído pelo mesmo serviço e sem gravar estado. A resposta JSON inclui `mes.parcial` e `mes.data_corte` para apresentar o período corretamente e `comparacao.evento_id` (identificador da comparação usada, ou `null`) para o link ao Resumo (F3).
- O servidor também salva automaticamente o relatório do mês anterior em `data/relatorios_mensais/`, uma vez por mês (ver `relatorio-mensal-automatico.md`).
- Textos vindos das planilhas entram como texto literal (proteção contra fórmulas).

## Abas e origem de cada número

### `Resumo`

Cabeçalho: título `Relatório mensal — <mês> de <ano>`, contrato `16467 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR`, data de geração. Depois, uma tabela `Indicador | Valor | Origem` em quatro blocos:

| Bloco | Indicador | Origem |
| --- | --- | --- |
| Inventário | Equipamentos na base | Séries únicas da base oficial `EquipamentosDetalhes` carregada (o mesmo cache usado pela busca). O InvAll/Endpoint não aumenta o total. |
| Inventário | Unidades com equipamentos | Pares cidade + endereço de instalação distintos nessas séries. |
| Inventário | Linhas sem número de série | Linhas da base oficial com algum dado e série vazia (não entram no total). |
| Inventário | Séries duplicadas | Séries que aparecem em mais de uma linha da base oficial (contam uma vez no total). |
| Última comparação | Data da comparação | Atualização de inventário mais recente do histórico até o corte do período (data atual para o mês atual; último dia para mês encerrado). Restaurações e a linha de base fixa ficam de fora. |
| Última comparação | Sem correspondência — no endpoint | `ausentes_no_endpoint` dessa atualização, com a classificação atual do histórico. |
| Última comparação | Sem correspondência — na Simpress | `ausentes_em_detalhes`, sem as séries do Sebrae (`BRJ135P5XS`, `BRJ142QKBQ`, `BRJ9435VMR`, `BRJ9435VMF`, `BRJ149SCJG`). |
| Última comparação | Localidade divergente | `divergencias_local`, sem os hostnames `PRNOTESJP*`, `PRNOTERL*` e `PRNOTEARC*` (instalados em Curitiba). |
| Última comparação | Atualizações registradas no mês | Atualizações de inventário do histórico com horário dentro do mês. |
| OS do mês | OS Oracle abertas no mês | OS distintas (pela `ordem_servico`, ou `solicitacao` quando não houver) cuja `data_criacao` cai no mês. |
| OS do mês | OS Oracle concluídas no mês | OS cuja `data_conclusao` cai no mês. |
| OS do mês | OS Oracle pendentes no fim do período | Criadas até o corte do período e sem conclusão até essa data. Uma OS com status encerrado e sem data de conclusão não conta como pendente. |
| OS do mês | Pedidos Simpress abertos no mês | Pedidos distintos cuja data do pedido cai no mês. |
| OS do mês | Pedidos Simpress entregues no mês | Pedidos cuja etapa `Pedido entregue` tem data no mês. |
| OS do mês | Pedidos Simpress em andamento no fim do período | Pedidos feitos até o corte do período e sem entrega até essa data. Pedido com status de entregue ou cancelado sem data não conta como em andamento. |
| OS do mês | Encerrados sem data | OS ou pedidos encerrados sem data de conclusão/entrega; ficam fora das contagens de conclusão do período. |

As OS e os pedidos vêm de `data/state/historico_chamados.json` (importado pela pasta `entrada_chamados` ou pela tela de chamados). São consideradas todas as importações guardadas no histórico; quando a mesma OS ou pedido aparece em mais de uma, vale a versão mais recente. O relatório agrupa o pedido Simpress pelo identificador, mesmo quando ele aparece associado a mais de uma série na mesma importação. Cada nova importação preserva os dados detalhados por pedido; a tela de acompanhamento continua destacando somente o pedido atual da série.

### Abas de detalhe

- `Inventário por tipo`: `Tipo | Equipamentos`, do maior para o menor; tipo vazio aparece como `Sem tipo`.
- `Inventário por unidade`: `Cidade | Endereço | Equipamentos`.
- `Comparação`: uma linha por pendência da última comparação: `Seção | Hostname | Série | Local previsto | Local na Simpress`. Seções: `Sem correspondência — no endpoint`, `Sem correspondência — na Simpress`, `Localidade divergente`.
- `OS do mês`: `Fonte | OS/Pedido | Série | Status | Criação | Conclusão | Situação no mês` (`Aberta no mês`, `Concluída no mês`, `Pendente no fim do mês`, combinadas por `; `). Um pedido aparece uma vez; a coluna Série reúne as séries associadas a ele na importação mais recente. Só entram as OS e pedidos com alguma situação no mês.
- `OS sem dados`: registros que não podem ser posicionados ou associados com segurança a um pedido, com identificadores candidatos, série, motivo e importação de origem. Eles ficam fora das contagens mensais.

## Regras

- O inventário reflete a base oficial **atual** (não há fotografia mensal da base); o resumo informa o arquivo de origem e quando foi carregado.
- As regras de `docs/operacao/regras-cadastro-historico.md` valem como no histórico: equivalência de séries de MacBook, séries do Sebrae fora de `ausentes_em_detalhes`, exceção de Curitiba para `PRNOTESJP`, `PRNOTERL` e `PRNOTEARC`. Os arquivos de origem e o histórico não são regravados.
- Rótulos de fonte: `no endpoint` e `na Simpress`.
- `mes` precisa ser `AAAA-MM` válido e não pode ser posterior ao mês atual (422). Base não carregada: 503 com mensagem clara. Histórico de chamados ilegível: 503.
- Mês sem dados: a planilha é gerada mesmo assim, com zeros e a observação `Sem registros no mês`.
- O inventário por unidade reflete a base atual, não uma fotografia histórica mensal. A prévia identifica isso e apresenta no máximo as três unidades com mais equipamentos.
- Transporte solicitado, tempo médio de fechamento e alterações de apelido não são fornecidos pelo serviço do relatório mensal; desde 07/11/2026 (decisão do usuário) não aparecem na tela nem na prévia, em vez de aparecer como indisponíveis. A XLSX não muda.

## Tela

Layout operacional aprovado pelo usuário em 07/11/2026 (mockups no canvas de Design da sessão; detalhes e textos em `docs/cockpit-prompts/10-relatorio-mensal.md`, seção "Layout operacional (07/11/2026)").

- Menu superior › `Ferramentas` (nove pontos) › `Relatório mensal` (`#btn-relatorio-mensal`, atalho F8).
- Barra: o mês atual e os dois anteriores como seletores rápidos, o campo `<input type="month">` (máximo = mês atual), o selo do período (`Parcial até dd/mm/aaaa` ou `Mês encerrado`, `#cockpit-monthly-period`), `Copiar resumo`, `Exportar planilha` e o status (`gerado em dd/mm/aaaa às hh:mm`).
- Sub-abas (12/11/2026, autorizadas pelo usuário; só navegação, nada é gravado): abaixo da barra, a tablist `Assuntos do relatório` com cinco abas (`#rel-aba-visao`, `#rel-aba-os`, `#rel-aba-comp`, `#rel-aba-sebrae`, `#rel-aba-base`), cada uma com o painel `#rel-painel-*`; só um painel fica visível. Abre em `Visão geral`; a aba escolhida e o filtro da OS ficam ao mudar o mês e ao recarregar em silêncio. Carregando e erro aparecem em `#cockpit-monthly-estado`, com as abas sempre à vista. Teclado: setas circulares, `Home`, `End`, `tabindex` rotativo. No celular a tablist rola sozinha na horizontal. Contadores nas abas, iguais às linhas da lista: `OS e pedidos do mês` (`os.linhas`) e `Pendências da comparação` (`comparacao.linhas`) com tom de alerta quando maiores que zero; `Chamados (F5)` (linhas da contagem do mês) neutro; ocultos quando a fonte não veio. Detalhes em `docs/cockpit-prompts/10-relatorio-mensal.md`, seção "Sub-abas (12/11/2026)".
- Conteúdo de cada aba, cada número uma vez só:
  - `Visão geral`:
    1. `Precisa de atenção` (`#cockpit-monthly-kpis`): `OS pendentes no fim do período` (Oracle e Simpress), `Comparação de inventário` (as três seções sem somar e a linha `Comparação usada`) e, só com registros fora das contagens, `Fora das contagens` com `Mostrar registros` / `Ocultar registros` (lista visível, não mais em tooltip).
    2. `Movimento do mês`: abertas, concluídas e encerradas sem data por fonte.
    3. Faixa `Chamados (F5)` (`#cockpit-monthly-chamados`): `Abertos no mês` e `Finalizados no mês` (contagem do servidor) e `Chamados novos` e `Antigos em aberto` (situação de hoje, mesma regra do F5), só com os números que existem; o botão `Ver chamados →` abre a aba `Chamados (F5)` do relatório. `Ver lista ↓` nos cartões de OS e de comparação também troca para a aba certa.
    4. `Prévia para a gestão`, recolhida.
  - `OS e pedidos do mês`: a tabela da aba `OS do mês` da XLSX, com filtro `Todas` / `Abertas` / `Concluídas` / `Pendentes` e 25 linhas por vez (`Carregar mais`).
  - `Pendências da comparação`: a tabela da aba `Comparação` da XLSX, 25 por vez.
  - `Chamados (F5)`: com o selo `Situação atual`: totais de hoje (chamados novos e antigos em aberto, de `GET /api/sebrae/novos`, só leitura, com a mesma regra do F5: chamado finalizado pelo site sai dos dois totais na hora, mesmo antes de reimportar) e, abaixo, `Com data em <mês>` com a contagem do servidor (`report.sebrae`, etapa 2 de 07/11/2026): `Abertos no mês`, `Finalizados no mês` e `Sem data de abertura ou de encerramento: N (fora da contagem)`, pelo Dashboard importado (abertura em P, encerramento em R), pelos chamados novos da busca (`Habilitada em`) e pelos finalizados pelo site, que vencem a coluna R. A tabela tem `Chamado`, `Título`, `Série`, `Abertura`, `Finalização` e `Situação no mês` (`Aberto no mês` / `Finalizado no mês`; aberto e finalizado no mesmo mês é uma linha só, com os dois selos), 25 por vez. Série vazia é completada pela coluna K do chamado novo; sem série, `—`. Chamado com número antigo de 5 dígitos conta pelas próprias datas, deduplicado pelo número; sem número, uma linha por linha do Dashboard. Sem Dashboard importado aparece a mensagem de vazio; falha na contagem mostra o erro só nessa subparte e falha ao consultar o Sebrae, só na situação atual; o restante do relatório continua.
  - `Base atual`: com o selo `Não muda com o mês`: totais, `Inventário por tipo` (com barra proporcional) e `Unidades com mais equipamentos` (8 primeiras; `Ver todas as N unidades` / `Ver menos`).
- Ligações (só navegação, nada é gravado): série → Home (F1); OS/Pedido → aba OS (F6) filtrada pela série (a busca da F6 não procura o número do pedido Simpress); `Ver na aba OS (F6)`; `Abrir no Resumo (F3)` abre exatamente a comparação usada (`comparacao.evento_id`); chamado → aba Chamados (F5) na linha dele (só quando a linha do mês casa com um chamado do F5); `Ver novos` / `Ver antigos` abrem a sub-aba. A aba OS mostra a situação de hoje, não a do fim de um mês passado.
- Sincronia: com o F8 aberto, importar OS (`simpress:chamados-atualizados`) ou uma nova comparação (`simpress:painel-atualizado`) recarrega o mês exibido sem piscar e sem perder filtro e páginas; fechado, o relatório é relido ao abrir.
- `Copiar resumo` copia apenas a prévia visível; `Exportar planilha` usa a rota XLSX existente, com o mesmo nome de arquivo e a mensagem exata `Planilha Exportada com Sucesso!`.
- Erros aparecem na região `role="status"` do painel e em toast. Temas claro e escuro usam os tokens existentes; abaixo de 1200px tudo fica em uma coluna e, no celular, as tabelas viram cartões, sem rolagem horizontal da página.

## Critérios de aceite

1. Com fixtures, o total de equipamentos é o número de séries únicas da base oficial; linhas sem série e séries duplicadas são sinalizadas e não alteram o total; registros só do Endpoint não entram.
2. A soma de `Inventário por tipo` e a de `Inventário por unidade` são iguais ao total.
3. Séries do Sebrae não aparecem em `Sem correspondência — na Simpress`; hostnames `PRNOTESJP`, `PRNOTERL` e `PRNOTEARC` não aparecem em `Localidade divergente`.
4. A comparação usada é a mais recente até o corte do período; no mês atual, atualizações posteriores à data local não entram.
5. OS abertas, concluídas e pendentes seguem as datas descritas acima; pedidos repetidos por série, por equipamento ou em várias importações contam uma vez e usam o estado mais recente.
6. Pedidos legados sem vínculo individual entre identificador, data e status aparecem em `OS sem dados` e não são atribuídos por inferência; a tela de chamados continua mostrando somente o pedido atual.
7. `mes` inválido ou futuro responde 422; o botão mostra `Planilha Exportada com Sucesso!` após o download.
8. `npm run verify` e `npm run test:ui:e2e` passam; nenhum dado real entra no Git.

## Limitações

- O inventário não é histórico: um relatório de um mês antigo mostra a base atual.
- As OS e os pedidos dependem das importações feitas; um identificador que nunca apareceu numa importação não é contado.
- Snapshots novos preservam uma linha detalhada para cada pedido e série. Pedidos repetidos entre equipamentos da mesma importação são consolidados por identificador; pedidos repetidos entre importações usam o estado da importação mais recente.
- Snapshots legados com um único pedido identificável podem ser usados quando as datas permitem associá-lo sem ambiguidade. Quando houver vários pedidos em listas paralelas sem vínculo individual, o relatório não combina listas por posição: registra a ocorrência em `OS sem dados` e não a inclui nas contagens. Datas inválidas, conflitantes ou ausentes também são sinalizadas quando impedem determinar o mês; status encerrado sem data de conclusão continua fora das contagens de conclusão e aparece no indicador `Encerrados sem data` quando há data do pedido conhecida.
