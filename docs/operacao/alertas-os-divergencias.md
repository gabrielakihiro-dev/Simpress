# Central de notificações: "OS paradas", "Divergências novas", "Sem acesso há 60 dias", "Chamados finalizados por outro técnico" e "Backups regionais"

Exibe cinco alertas da Trilha C no painel aberto pelo sino do cabeçalho. O alerta "Base desatualizada" continua no Home ([especificação](alerta-base-desatualizada.md)). Os cartões são preenchidos com os dados de `GET /api/painel`; cada um tem um botão que abre a tela onde o caso é tratado. Nenhum dos cinco grava nada: os históricos de OS e de planilhas, as marcas de OS finalizada e as confirmações de backup são apenas lidos (confirmar e desfazer backup acontecem na sub-aba Backups do Resumo, não no sino).

## 1. OS paradas

### Objetivo

Avisar quando há chamados abertos sem atualização há 7 dias ou mais, para que nenhuma OS fique esquecida entre uma importação e outra.

### Dados

- Fonte: o acompanhamento de chamados (`data/state/historico_chamados.json`), gravado pela importação de OS (Oracle e UX). Usa-se a versão mais recente (os `chamados` do relatório atual), com a mesma normalização da tela "Acompanhamento de chamados".
- Cada série do acompanhamento conta uma vez, como nos cartões dessa tela.
- Um chamado está **aberto** quando tem ao menos uma solicitação do Oracle cujo status/substatus não indica encerramento (concluído, encerrado, finalizado, cancelado, resolvido, fechado), a mesma regra de `ticket_attention`.
- A **última atualização** é a maior `ultima_atualizacao` entre as solicitações abertas do Oracle. Os dias são contados até hoje, em datas inteiras.
- **Parada**: 7 dias ou mais sem atualização (7 dias já conta). O limite padrão fica em `core/config.py` (`STALE_TICKET_ALERT_DAYS`).
- Chamados abertos sem data de atualização e registros só da Simpress não entram na contagem: não há data para medir. Continuam visíveis na tela de chamados.

### Quando aparece e quando some

- Aparece quando há pelo menos um chamado parado.
- Some quando não há chamados parados, quando não há acompanhamento importado ou quando o arquivo não pode ser lido (o resto do painel continua carregando).
- O alerta é atualizado na carga inicial e ao abrir o sino, além das atualizações normais do painel. Uma importação de OS aparece na próxima resposta de `/api/painel`.

### Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `paradas` (1) | OS paradas | 1 chamado aberto está sem atualização há 7 dias ou mais. O mais antigo está parado há 12 dias. | Ver chamados |
| `paradas` (n) | OS paradas | 3 chamados abertos estão sem atualização há 7 dias ou mais. O mais antigo está parado há 21 dias. | Ver chamados |

O botão abre a aba OS do Cockpit (`abrirPainelCockpit("chamados")`, o mesmo do menu e de `F6`), onde a triagem `3+ dias` e `Atenção · 3+ dias` destacam as OS paradas.

### Contrato da API

`GET /api/painel` ganha `os_paradas`, ou `null` quando o serviço não está configurado:

```json
{
  "estado": "paradas | em_dia | sem_dados | indisponivel",
  "limite_dias": 7,
  "total": 3,
  "maior_dias_sem_atualizacao": 21,
  "importado_em": "2026-10-18T09:00:00-03:00"
}
```

## 2. Divergências novas

### Objetivo

Mostrar quantas linhas de divergência apareceram na comparação de planilhas mais recente e não estavam na anterior, para que a conferência comece pelo que mudou.

### Dados

- Fonte: o Histórico de Planilhas (`data/state/historico_comparacoes/historico_comparacoes.json`).
- Comparam-se as duas atualizações mais recentes pelo `horario`. Restaurações e a linha de base fixada ficam de fora, como na comparação de `compare_updates`.
- Antes de comparar, as duas atualizações passam pela classificação atual do histórico (`comparison_history_for_display`), que aplica as regras de `docs/operacao/regras-cadastro-historico.md`:
  - as séries do Sebrae (`BRJ135P5XS`, `BRJ142QKBQ`, `BRJ9435VMR`, `BRJ9435VMF`, `BRJ149SCJG`) não contam como sem correspondência;
  - hostnames `PRNOTESJP*`, `PRNOTERL*` e `PRNOTEARC*` em Curitiba não contam como localidade divergente.
  O painel reaplica esses dois filtros por segurança, como o relatório mensal.
- Linhas de divergência são as das seções detalhadas do histórico: `Linhas mantidas para conferência`, `Sem acesso há 7 dias ou mais`, `Equipamentos sem correspondência por fonte` (Endpoint e Simpress), `Localidade divergente`, `Duplicidades e correspondências ambíguas` e `Séries sem local definido`.
- Uma linha é **nova** quando sua chave (série ou hostname, com a ocorrência para repetições) não existe na mesma seção da atualização anterior. É a mesma regra de `compare_updates` (`GET /api/operacoes/evolucao`, que hoje só o assistente consulta; a tela "Evolução das atualizações" foi removida em 31/10/2026).
- O histórico é apenas lido; nada é regravado.

### Quando aparece e quando some

- Aparece quando a comparação mais recente tem pelo menos uma linha nova.
- Some quando não há linhas novas, quando há menos de duas atualizações no histórico ou quando o histórico não pode ser lido.
- Some ou muda na próxima resposta de `/api/painel` depois de uma nova atualização de planilhas; abrir o sino solicita uma resposta atualizada.

### Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `novas` (1) | Divergências novas | A comparação de 18/10/2026 às 09:00 trouxe 1 linha de divergência que não estava na de 11/10/2026 às 08:00: 1 em Localidade divergente. | Ver evolução |
| `novas` (n) | Divergências novas | A comparação de 18/10/2026 às 09:00 trouxe 5 linhas de divergência que não estavam na de 11/10/2026 às 08:00: 3 em Localidade divergente e 2 em Séries sem local definido. | Ver evolução |

As seções aparecem na ordem do histórico, só as que têm linhas novas, com os rótulos do histórico (`Endpoint` e `Simpress` sem preposição). O botão `#btn-alerta-divergencias-novas` mantém o rótulo "Ver evolução" e, desde 31/10/2026, abre a aba Comparação (`abrirPainelCockpit` com `data-args` `["comparacao"]`); o painel Evolução e o modal `#modal-evolucao-atualizacoes` não existem mais.

### Contrato da API

`GET /api/painel` ganha `divergencias_novas`, ou `null` quando o serviço não está configurado:

```json
{
  "estado": "novas | sem_novas | sem_comparacao | indisponivel",
  "total": 5,
  "por_secao": [{"secao": "Localidade divergente", "total": 3}],
  "anterior": {"id": "…", "horario": "2026-10-11T08:00:00-03:00"},
  "atual": {"id": "…", "horario": "2026-10-18T09:00:00-03:00"}
}
```

## 3. Sem acesso há 60 dias

### Objetivo

Avisar, em dois níveis, quando um notebook/MacBook está perto de sumir do Endpoint por falta de acesso. Com 60 dias sem uso ele deixa a lista `Sem acesso há 7 dias ou mais` e passa a um campo que some dentro do Endpoint (`Ausentes no Endpoint`); o aviso evita que isso aconteça sem ninguém perceber (pedido do usuário, 07/11/2026).

### Dados

- Fonte: a atualização mais recente do Histórico de Planilhas (ignorando restaurações e a linha de base fixada), seção `sem_acesso_7_dias` (`dias_sem_verificacao`) e `ausentes_no_endpoint`. Séries do Sebrae ficam de fora, também no histórico antigo.
- **Limite** (`LONG_UNUSED_WARNING_DAYS = 55` em `core/config.py`): mais de 55 dias e menos de 60 sem acesso. **Passou** (`LONG_UNUSED_LIMIT_DAYS = 60`): 60 dias ou mais.
- **Saiu para Ausentes no Endpoint**: a série não está em `sem_acesso_7_dias` na atualização atual e aparece em `ausentes_no_endpoint`; o sistema volta pelo histórico até a última atualização em que ela estava em `sem_acesso_7_dias`, desde que tenha ficado em `ausentes_no_endpoint` em todas as atualizações seguintes. Conta como passou quando os dias daquela linha mais os dias desde aquela atualização chegam a 60 (09/11/2026: antes só a atualização anterior era olhada; por isso equipamentos que saíram há mais tempo também passam a aparecer no sino). A série do MacBook no Endpoint (sem `S` inicial) equivale à de `EquipamentosDetalhes` com `S`, só na comparação.
- Só leitura: nada é regravado. O filtro por categoria (notebook/MacBook) não é aplicado; vale para toda série que aparece nessas listas.

### Quando aparece e quando some

- Aparece com pelo menos um equipamento no limite ou que passou. Some quando não há nenhum, quando não há atualização no histórico ou quando o histórico não pode ser lido.
- O aviso de "saiu da lista" continua enquanto a série seguir em `Ausentes no Endpoint` sem voltar a `Sem acesso há 7 dias ou mais`.
- Estado `passou_60` tem prioridade (selo `Urgente`); `limite_55` mostra o selo `Atenção`.

### Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `passou_60` | Passou de 60 dias sem acesso | 2 notebooks/MacBooks passaram de 60 dias sem acesso. 1 já saiu da lista e foi para Ausentes no Endpoint. 1 notebook/MacBook está no limite, com mais de 55 dias sem acesso. | Ver Resumo |
| `limite_55` | Perto de 60 dias sem acesso | 2 notebooks/MacBooks estão no limite, com mais de 55 dias sem acesso. | Ver Resumo |

Singular: `1 notebook/MacBook passou`, `1 já saiu ... foi para`. O botão `#btn-alerta-sem-acesso-60` abre o Resumo já na sub-aba `Sem acesso` (`abrirPainelCockpit` com `["comparacao","sem-acesso"]`; bloco 1b, 09/11/2026). Título padrão do cartão oculto: `Notebooks sem acesso`.

### Lista no Resumo (F3) e verificação em Staged Computers (09/11/2026)

- Pedido do usuário de 09/11/2026: o resultado da comparação (Resumo/F3 e `Histórico e ações completas`) mostra, logo depois de `Sem acesso há 7 dias ou mais`, a seção `Passou de 60 dias sem acesso (n)` com Hostname/Apelido, Série, Dias sem acesso (`~` na estimativa de quem saiu), Situação (`Saiu para Ausentes no Endpoint` ou `Ainda em Sem acesso há 7 dias ou mais`) e Anotação, além de um link para o `Staged Computers` do Endpoint Central. Sem itens: `Nenhum notebook passou de 60 dias sem acesso nesta atualização.`
- A lista é calculada na leitura (`comparacao.sem_acesso_60_dias` em `GET /api/historico-comparacoes/{id}`, com `long_unused_status(..., event_id)`, tratando aquele evento como o mais recente) e nunca é gravada no histórico. A anotação de cada linha usa um identificador estável por evento e série (com índice de ocorrência: a primeira linha de cada série usa 0, e séries vazias ou repetidas não colidem), salva como as das outras seções (pasta compartilhada, limite de 2.000 caracteres) e entra na exportação Excel do histórico. Como os dias mudam a cada atualização, ela não é reaplicada em históricos novos. Limite conhecido: se o evento for apagado, ou se `LONG_UNUSED_*` mudar e a linha deixar de aparecer, a anotação fica guardada na pasta compartilhada sem linha visível (não é apagada).
- Na rotina `inventarios` da Automação (F4), e portanto em `ambas`, depois de uma importação bem-sucedida, `scripts/staged_computers_endpoint.py` abre uma aba própria em `Staged Computers` (só leitura; nunca fecha a aba nem o Chrome; login sempre do usuário) e procura os hostnames que saíram para Ausentes no Endpoint. Cada linha recebe a anotação `[Staged Computers dd/mm/aaaa HH:MM] Encontrado em Staged Computers do Endpoint: ...` (escritório, status e último contato) ou `Não encontrado em Staged Computers do Endpoint.`; o "não encontrado" só é escrito quando a grade foi lida por inteiro (paginação `1 - N` igual às linhas lidas e menor que o `Rows per page` da tela, botão de próxima página desativado, nenhuma busca com texto e, com a grade vazia, "Nenhum dado disponível"; o filtro avançado não é detectado). Anotação em conflito ou com integridade inválida não é tocada, e as linhas são relidas logo antes de gravar. Falha nessa etapa vira `[AVISO]` e não reprova a rotina. Usuários logados, IP e MAC não são gravados.

### Contrato da API

`GET /api/painel` ganha `sem_acesso_60_dias`, ou `null` quando o serviço não está configurado:

```json
{
  "estado": "passou_60 | limite_55 | em_dia | sem_dados | indisponivel",
  "limite_aviso_dias": 55,
  "limite_dias": 60,
  "total_limite": 1,
  "total_passou": 2,
  "total_saiu_endpoint": 1,
  "maior_dias": 72,
  "horario": "2026-10-18T09:00:00-03:00",
  "equipamentos": [
    {"serie": "BRJ111AAAA", "computador": "PRNOTE001", "dias": 72, "situacao": "passou"},
    {"serie": "BRJ222BBBB", "computador": "PRNOTE002", "dias": 61, "situacao": "saiu_endpoint"},
    {"serie": "BRJ333CCCC", "computador": "PRNOTE003", "dias": 57, "situacao": "limite"}
  ]
}
```

`equipamentos` lista os notebooks/MacBooks do alerta, do mais antigo para o mais recente (`situacao`: `limite`, `passou` ou `saiu_endpoint`). Em `saiu_endpoint`, `dias` é estimado: dias da atualização anterior mais os dias entre as duas atualizações. O cartão mostra até 5 linhas (`série · hostname — N dias`, com `~` na estimativa) e "e mais N" para o resto.

## 4. Chamados finalizados por outro técnico

### Objetivo

Avisar quando um chamado da lista do Dashboard foi finalizado no SoftExpert por outra pessoa, e não pelo site, para que o usuário confira e marque `Conferido` na aba OS (F6). Pedido do usuário, 08/11/2026.

### Dados

- Fonte: `chamados_outro_tecnico` em `GET /api/painel`, montado por `_other_technician_summary` (`routers/dashboard.py`) a partir das marcas de OS finalizada (`domains/os_marcas_finalizacao.py`). Entram as marcas ativas de origem `outro_tecnico` que ainda não têm `conferido_em`.
- Cada item traz `chamado`, `serie`, `os` e `motivo` (`saiu_do_dashboard` ou `nao_encontrado_softexpert`). `total` é o número de itens.
- Só leitura: nada é regravado. `Conferido` e `Desfazer` são feitos na aba OS (F6) e tiram o chamado do aviso.

### Quando aparece e quando some

- Aparece com `total` maior que zero. Some com a lista vazia, quando o campo falta ou quando vem `indisponivel: true` (falha ao ler as marcas); o resto do painel continua carregando.
- Selo `Atenção` (`data-gravidade="atencao"`). Não há nível `Urgente`.

### Texto

| Título | Texto | Botão |
| --- | --- | --- |
| Chamados finalizados por outro técnico | Confira no SoftExpert e marque Conferido na aba OS (F6). | Ver na aba OS |

O texto é o mesmo para um ou vários chamados. O cartão é `#alerta-chamados-outro-tecnico` (`data-state` `outro_tecnico`, `vazio` ou `indisponivel`; texto em `#alerta-chamados-outro-tecnico-texto`). O botão `#btn-alerta-chamados-outro-tecnico` abre a aba OS (`abrirPainelCockpit` com `["chamados"]`). Título padrão do cartão oculto: `Chamados finalizados por outro técnico`.

### Contrato da API

```json
{
  "total": 2,
  "itens": [
    {"chamado": "UTIC-2026-1378", "serie": "BRJ111AAAA", "os": "1234567", "motivo": "saiu_do_dashboard"},
    {"chamado": "UTIC-2026-1379", "serie": "BRJ222BBBB", "os": "7654321", "motivo": "nao_encontrado_softexpert"}
  ]
}
```

Com falha ao ler as marcas: `{"total": 0, "itens": [], "indisponivel": true}`. Sem a fonte configurada: `{"total": 0, "itens": []}`. Implementação do cartão: `renderizarAlertaChamadosOutroTecnico` em `static/js/features/dashboard.js`.

## 5. Backups regionais

### Objetivo

Avisar quando uma regional prioritária está sem notebook de backup disponível ou tem só candidatos para o usuário conferir, sem precisar abrir o Resumo (F3). Cálculo e regras em `docs/arquitetura/CONTRATOS_API_BACKEND.md`, seção "Backups regionais (Resumo F3)".

### Dados

- Fonte: `backups_regionais.pendencias` em `GET /api/painel`, que o front recebe pelo evento `simpress:painel-atualizado` (`sem_backup` e `conferir` são listas de cidades).
- Só leitura: o cartão não grava nada. `Confirmar disponível por 7 dias` e `Desfazer confirmação` ficam na sub-aba Backups do Resumo.

### Quando aparece e quando some

- Aparece com pelo menos uma cidade em `pendencias.sem_backup` (selo `Urgente`, `data-gravidade="urgente"`) ou, sem nenhuma, com pelo menos uma em `pendencias.conferir` (selo `Atenção`, `data-gravidade="atencao"`).
- Some com as duas listas vazias, com o campo `null` (serviço desligado), com `indisponivel: true` ou quando o campo falta; o resto do painel continua carregando.
- Entra no contador do sino: um aviso a mais, não uma unidade por cidade.
- Depois de confirmar ou desfazer na sub-aba, o front pede a atualização do painel (`simpress:atualizar-notificacoes`) e o cartão acompanha o novo cálculo.

### Texto

| Título | Quando | Botão |
| --- | --- | --- |
| Sem backup disponível | há cidade em `pendencias.sem_backup` | Ver backups no Resumo |
| Conferir possível backup | só há cidade em `pendencias.conferir` | Ver backups no Resumo |

O cartão é `#alerta-backups-regionais` (`data-state` `sem_backup`, `conferir`, `vazio` ou `indisponivel`; lista `#alerta-backups-regionais-lista` com uma linha por cidade e situação, por exemplo `Cascavel — sem backup disponível`). O botão `#btn-alerta-backups-regionais` abre a sub-aba Backups do Resumo (`abrirPainelCockpit` com `["comparacao","backups"]`). O cartão nunca traz apelido nem série. Implementação: `renderizarAlertaBackupsRegionais` em `static/js/features/dashboard.js`.

## Interface

- Botão `#btn-notificacoes` no cabeçalho abre `#notification-center-panel`, com contador de 0 a 5 alertas ativos. O painel é atualizado ao abrir, fecha com `Escape` ou clique fora e não mantém estado de leitura, dispensa ou histórico.
- Os cartões `#alerta-sem-acesso-60`, `#alerta-os-paradas`, `#alerta-divergencias-novas`, `#alerta-chamados-outro-tecnico` e `#alerta-backups-regionais` ficam no painel do sino, preservam classes (`stale-base-alert*`), IDs, ARIA, `data-*`, ações, tokens `--ux-warning-*` e animação de entrada de 220 ms desligada em movimento reduzido. No celular, os botões têm no mínimo 48 px de altura.
- Os toasts de operações continuam independentes e temporários.

## Critérios de aceite

1. Com chamados abertos cuja última atualização tem 7 dias ou mais, o painel mostra "OS paradas" com a quantidade e os dias do mais antigo; com 6 dias, sem data ou encerrados, não conta.
2. Sem acompanhamento importado, com todos em dia ou com arquivo ilegível, o cartão de OS fica oculto e o painel carrega.
3. Com linhas novas entre as duas atualizações mais recentes, o painel mostra "Divergências novas" com o total, as datas e as seções; restaurações e a linha de base fixada são ignoradas.
4. Séries do Sebrae e PRNOTE* em Curitiba nunca contam como divergência nova.
5. Com menos de duas atualizações, sem linhas novas ou com histórico ilegível, o cartão de divergências fica oculto.
6. Os botões abrem a aba OS e a aba Comparação (Resumo); o sino fecha com `Escape` ou clique fora e devolve o foco ao ser fechado por teclado.
7. Os avisos não aparecem no Home; "Base desatualizada" permanece no Home.
8. Nenhum histórico é regravado e o contador mostra a quantidade de avisos ativos, não a quantidade de chamados ou linhas divergentes.
9. Funciona nos temas claro e escuro, no desktop e no celular; testes em Python cobrem as regras e testes e2e cobrem a lista, o contador, os botões e o fechamento.
10. Com equipamento com mais de 55 dias (e menos de 60) sem acesso, o sino mostra "Perto de 60 dias sem acesso"; com 60 dias ou mais, ou depois de sair para Ausentes no Endpoint, mostra "Passou de 60 dias sem acesso"; com tudo em dia, sem atualização ou histórico ilegível, o cartão fica oculto.
11. Com pelo menos uma marca `Finalizado por outro técnico` ativa e sem `Conferido`, o sino mostra "Chamados finalizados por outro técnico" com `Atenção` e o botão "Ver na aba OS" abre a aba OS; depois de `Conferido` ou `Desfazer` na aba OS, ou com a lista vazia ou `indisponivel`, o cartão fica oculto e o contador não conta o aviso. Marcas de chamados finalizados pelo site nunca entram.
12. Com pelo menos uma regional prioritária em `pendencias.sem_backup`, o sino mostra "Sem backup disponível" com `Urgente`; só com `pendencias.conferir`, mostra "Conferir possível backup" com `Atenção`; o botão "Ver backups no Resumo" abre a sub-aba Backups; com as listas vazias, `null` ou `indisponivel`, o cartão fica oculto e o contador não conta o aviso.
