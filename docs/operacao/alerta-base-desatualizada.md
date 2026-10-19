# Alerta "Base desatualizada" no painel inicial

Especificação do alerta de base desatualizada do painel inicial (Home). Os alertas "OS paradas" e "Divergências novas" seguem este padrão e estão em [alertas-os-divergencias.md](alertas-os-divergencias.md); o de equipamento sem acesso fica fora deste escopo.

## Objetivo

Avisar quando a base oficial `EquipamentosDetalhes` (`data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx`) está há mais de 7 dias sem atualização, para que consultas, transferências e comparações não usem um cadastro antigo sem que ninguém perceba.

## De onde vem a data da última atualização

1. **Histórico de Planilhas** (`data/state/historico_comparacoes/historico_comparacoes.json`), que o fluxo de importação grava a cada atualização confirmada, junto com o backup em `data/planilhas_entrada/_backups/`. A data é o `horario` do evento.
   - Atualização (manual ou pela pasta de entrada automática): a base passa a ter a data do evento.
   - Restauração: a base volta a ser a que estava ativa **antes** do evento restaurado (o backup guarda os arquivos anteriores à troca). A data passa a ser a da base daquela época. Se ela for anterior ao histórico disponível, usa-se o `horario` do evento restaurado, que é o limite mais recente possível.
2. **Data de modificação do arquivo**, somente como último recurso:
   - quando o histórico não tem nenhum evento (base colocada à mão, histórico apagado pela retenção de 60 dias ou ilegível);
   - quando o arquivo foi modificado mais de 10 minutos depois do último evento do histórico, sinal de que a base foi trocada fora do fluxo de importação (por exemplo, ao extrair um ZIP direto para a pasta).

**Por que o histórico primeiro:** ele registra a data em que a base foi confirmada pelo fluxo oficial, com backup. A data de modificação do arquivo muda com cópias, restaurações e ferramentas de sincronização sem que o conteúdo fique mais novo. Uma restauração, por exemplo, regrava o arquivo hoje com dados antigos, e o alerta sumiria indevidamente. A `ultima_atualizacao` de `/api/stats` também não serve: ela é a hora em que o servidor carregou a base, inclusive na inicialização.

## Quando aparece e quando some

- O limite padrão é de 7 dias, ajustável em `core/config.py` (`STALE_BASE_ALERT_DAYS`).
- **Aparece** quando o tempo desde a última atualização é maior que o limite (7 dias e 1 minuto já conta; exatamente 7 dias, não).
- **Some** na próxima resposta de `/api/painel` depois de uma atualização ou restauração que traga a data para dentro do limite. O painel já é recarregado quando o contador do histórico muda, o que acontece na própria aba depois de uma atualização pelo modal ou de uma restauração. Uma importação pela pasta de entrada automática roda em segundo plano: como os demais números do painel, o alerta de uma página já aberta só some ao voltar para a aba Home ou recarregar a página.
- **Base inexistente:** se o arquivo não existir, aparece o aviso "Base não encontrada" em vez do alerta, e a tela continua funcionando.
- Se a data não puder ser lida (erro inesperado), o alerta fica oculto e o resto do painel carrega normalmente.

## Texto

| Estado | Título | Texto | Botão |
| --- | --- | --- | --- |
| `desatualizada` | Base desatualizada | A base na Simpress foi atualizada pela última vez em 08/10/2026 às 20:15, há 9 dias. O limite é de 7 dias. | Atualizar base |
| `sem_base` | Base não encontrada | Nenhuma base na Simpress foi importada. Importe as planilhas para consultar e comparar equipamentos. | Importar base |

Quando a contagem de dias arredondada para baixo for igual ao limite (por exemplo, 7 dias e 3 horas), o texto diz "há mais de 7 dias".

## Link para a atualização

O botão abre o modal "Atualizar planilhas" (`abrirModalAtualizarPlanilhas`), o mesmo do botão `#btn-atualizar-planilhas` do menu. A aplicação não tem rotas próprias por tela, então o "link" é esse botão.

## Contrato da API

`GET /api/painel` ganha o campo `base_desatualizada`, ou `null` quando o serviço não está configurado:

```json
{
  "estado": "desatualizada | atualizada | sem_base | indisponivel",
  "limite_dias": 7,
  "dias_sem_atualizacao": 9,
  "ultima_atualizacao": "2026-10-08T20:15:00-03:00",
  "origem_data": "historico | arquivo | "
}
```

## Interface

- O cartão `#alerta-base-desatualizada` fica no topo da aba Home e segue o padrão do cartão "Uso nos últimos 30 dias": nasce `hidden`, é preenchido pelo evento `simpress:painel-atualizado` e entra com animação de 220 ms (`--motion-normal`), desligada com `prefers-reduced-motion`.
- Usa os tokens `--ux-warning-*`, que existem nos temas claro e escuro. No celular, o botão ocupa a largura toda e tem pelo menos 48 px de altura.
- `role="status"` para que leitores de tela anunciem o aviso quando ele aparecer.

## Critérios de aceite

1. Com a última atualização há mais de 7 dias, o painel mostra "Base desatualizada" com a data e os dias; com 7 dias ou menos, o cartão fica oculto.
2. A data vem do histórico; restauração usa a data da base restaurada; sem histórico ou com o arquivo trocado fora do fluxo, usa a data de modificação do arquivo.
3. Sem o arquivo da base, aparece "Base não encontrada" e o restante do painel continua carregando.
4. O botão abre o modal de atualização de planilhas.
5. O limite vem de `STALE_BASE_ALERT_DAYS` e pode ser alterado sem mexer no código do painel.
6. Funciona nos temas claro e escuro, no desktop e no celular, com animação de 150 a 300 ms e sem animação em movimento reduzido. IDs, ARIA e `data-*` existentes não mudam.
7. Testes em Python cobrem os estados e as origens da data; um teste e2e cobre a exibição e o botão.
