# Alertas "OS paradas" e "Divergências novas" no painel inicial

Estende o painel inicial (Home) com dois alertas da Trilha C, no mesmo padrão do alerta "Base desatualizada" ([alerta-base-desatualizada.md](alerta-base-desatualizada.md)): cartão no topo da Home, oculto até o painel responder, preenchido pelo evento `simpress:painel-atualizado`, com um botão que abre a tela onde o caso é tratado. Nenhum dos dois grava nada: os históricos de OS e de planilhas são apenas lidos.

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
- O painel é recarregado ao voltar para a aba Home ou recarregar a página; uma nova importação de OS atualiza o alerta na próxima resposta de `/api/painel`.

### Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `paradas` (1) | OS paradas | 1 chamado aberto está sem atualização há 7 dias ou mais. O mais antigo está parado há 12 dias. | Ver chamados |
| `paradas` (n) | OS paradas | 3 chamados abertos estão sem atualização há 7 dias ou mais. O mais antigo está parado há 21 dias. | Ver chamados |

O botão abre o "Acompanhamento de chamados" (`abrirAcompanhamentoChamados`), o mesmo do menu.

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
- Comparam-se as duas atualizações mais recentes pelo `horario`. Restaurações e a linha de base fixada ficam de fora, como em "Evolução das atualizações".
- Antes de comparar, as duas atualizações passam pela classificação atual do histórico (`comparison_history_for_display`), que aplica as regras do `AGENTS.md`:
  - as séries do Sebrae (`BRJ135P5XS`, `BRJ142QKBQ`, `BRJ9435VMR`, `BRJ9435VMF`, `BRJ149SCJG`) não contam como sem correspondência;
  - hostnames `PRNOTESJP*`, `PRNOTERL*` e `PRNOTEARC*` em Curitiba não contam como localidade divergente.
  O painel reaplica esses dois filtros por segurança, como o relatório mensal.
- Linhas de divergência são as das seções detalhadas do histórico: `Linhas mantidas para conferência`, `Sem acesso há 7 dias ou mais`, `Equipamentos sem correspondência por fonte` (Endpoint e Simpress), `Localidade divergente`, `Duplicidades e correspondências ambíguas` e `Séries sem local definido`.
- Uma linha é **nova** quando sua chave (série ou hostname, com a ocorrência para repetições) não existe na mesma seção da atualização anterior. É a mesma regra de `compare_updates`, usada por "Evolução das atualizações", então o número do alerta coincide com "Novos" nessa tela.
- O histórico é apenas lido; nada é regravado.

### Quando aparece e quando some

- Aparece quando a comparação mais recente tem pelo menos uma linha nova.
- Some quando não há linhas novas, quando há menos de duas atualizações no histórico ou quando o histórico não pode ser lido.
- Some ou muda na próxima resposta de `/api/painel` depois de uma nova atualização de planilhas.

### Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `novas` (1) | Divergências novas | A comparação de 18/10/2026 às 09:00 trouxe 1 linha de divergência que não estava na de 11/10/2026 às 08:00: 1 em Localidade divergente. | Ver evolução |
| `novas` (n) | Divergências novas | A comparação de 18/10/2026 às 09:00 trouxe 5 linhas de divergência que não estavam na de 11/10/2026 às 08:00: 3 em Localidade divergente e 2 em Séries sem local definido. | Ver evolução |

As seções aparecem na ordem do histórico, só as que têm linhas novas, com os rótulos do histórico (`Endpoint` e `Simpress` sem preposição). O botão abre "Evolução das atualizações" (`abrirEvolucaoAtualizacoes`), que já seleciona as duas atualizações mais recentes.

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

## Interface

- Cartões `#alerta-os-paradas` e `#alerta-divergencias-novas`, logo abaixo de `#alerta-base-desatualizada`, com as mesmas classes (`stale-base-alert*`), tokens `--ux-warning-*` (temas claro e escuro), `role="status"`, animação de entrada de 220 ms desligada em movimento reduzido e botão com largura total e 48 px de altura no celular.
- IDs, ARIA e `data-*` existentes não mudam.

## Critérios de aceite

1. Com chamados abertos cuja última atualização tem 7 dias ou mais, o painel mostra "OS paradas" com a quantidade e os dias do mais antigo; com 6 dias, sem data ou encerrados, não conta.
2. Sem acompanhamento importado, com todos em dia ou com arquivo ilegível, o cartão de OS fica oculto e o painel carrega.
3. Com linhas novas entre as duas atualizações mais recentes, o painel mostra "Divergências novas" com o total, as datas e as seções; restaurações e a linha de base fixada são ignoradas.
4. Séries do Sebrae e PRNOTE* em Curitiba nunca contam como divergência nova.
5. Com menos de duas atualizações, sem linhas novas ou com histórico ilegível, o cartão de divergências fica oculto.
6. Os botões abrem "Acompanhamento de chamados" e "Evolução das atualizações".
7. Nenhum histórico é regravado.
8. Funciona nos temas claro e escuro, no desktop e no celular; testes em Python cobrem as regras e um teste e2e cobre a exibição e os botões.
