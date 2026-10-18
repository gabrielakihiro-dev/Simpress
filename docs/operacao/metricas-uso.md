# Métricas locais de uso

Objetivo: gerar dados reais de uso do Simpress para mostrar à empresa quanto trabalho o sistema absorve. Tudo fica no computador local; nada é enviado para fora.

## Dados

Arquivo: `data/state/metricas_uso.json` (estado operacional, fora do Git).

```json
{
  "versao": 1,
  "dias": {
    "2026-10-17": {"transferencias": 3, "comparacoes": 1, "exportacoes": 2, "os_conciliadas": 40, "buscas": 25}
  },
  "tempos_minutos": {"transferencias": 15, "comparacoes": null, "exportacoes": null, "os_conciliadas": null, "buscas": null}
}
```

- Só há datas (dia local, `AAAA-MM-DD`), contagens inteiras e os tempos configurados. Nunca são gravados séries, hostnames, termos pesquisados, nomes de arquivo nem dados pessoais.
- Cada incremento usa `AtomicFileTransaction` de `core/integrity.py` (lock + journal em `.transactions`). Dias com mais de 730 dias são descartados na gravação seguinte.
- Falhas ao gravar uma métrica (arquivo ocupado, JSON inválido) são registradas no log e **não** interrompem a operação do usuário. Um JSON inválido é preservado, sem sobrescrita.

### O que conta

| Métrica | Quando incrementa |
| --- | --- |
| `transferencias` | `POST /api/gerar-planilha` respondeu 2xx (planilha de transferência gerada). |
| `comparacoes` | Atualização de inventário confirmada (manual em `/api/planilhas/atualizar` ou pela entrada automática). Repetições da mesma confirmação (mesmo `evento_id`, por `Idempotency-Key`) contam uma vez enquanto o servidor estiver aberto. |
| `exportacoes` | 2xx em `GET /api/exportar-equipamentos`, `GET /api/historico-comparacoes/exportar/excel` ou `GET /api/operacoes/chamados/exportar`. |
| `os_conciliadas` | Importação de chamados confirmada (manual ou pela pasta `entrada_chamados`): soma `resumo.series_total` do relatório conciliado. |
| `buscas` | 2xx em `GET /api/buscar` ou `GET /api/buscar-expandida` (somente `offset=0`). Termos que só estendem ou encurtam o termo anterior em até 30 s (digitação do autocompletar, troca de filtros) contam como a mesma busca. O termo fica só em memória. |

## API

- `GET /api/painel` ganha `uso_30_dias`: `periodo` (`inicio`, `fim`, `dias`), `totais` por métrica, `por_dia` (30 entradas, inclusive dias zerados), `registro_desde`, `tempos_minutos`, `tempos_configurados`, `minutos_economizados`, `horas_economizadas` e `disponivel`.
- `PUT /api/painel/tempos-manuais` com `{"tempos_minutos": {"transferencias": 15, ...}}`. Cada valor é `null` (não informado) ou um número de 0 a 480 minutos. Responde o novo `uso_30_dias`. Valores inválidos: 422.
- A janela de 30 dias inclui hoje e os 29 dias anteriores (data local do servidor).

## Tela

Cartão `Uso nos últimos 30 dias` na Home, logo abaixo de `Resumo do parque` (`#uso-30-dias`, `aria-labelledby="uso-30-dias-titulo"`).

- Cinco indicadores: `Transferências geradas`, `Comparações feitas`, `Exportações`, `OS conciliadas`, `Buscas`. Desktop: uma linha de cinco; telas estreitas: cards em duas colunas (uma coluna abaixo de 360 px), com os mesmos números.
- Linha `Horas economizadas (estimativa)`: aparece quando ao menos um tempo foi configurado; sem tempos, mostra o convite `Informe o tempo manual de cada tarefa para estimar as horas economizadas.`
- `Registrado desde DD/MM/AAAA` informa quando a contagem começou, para não sugerir que antes não houve uso.
- `<details>` `Tempo manual por tarefa` com cinco campos numéricos (minutos, 0–480, vazio = não informado) e botão `Salvar tempos`. Mensagem de status em região `aria-live="polite"`.
- Entrada do cartão com fade/translate de 200 ms; desativada em `prefers-reduced-motion: reduce`.
- Temas claro e escuro com os tokens `--ux-*` já existentes.

## Critérios de aceite

1. Gerar uma transferência, confirmar uma comparação, exportar, importar chamados e buscar incrementam a métrica do dia correspondente em `metricas_uso.json`.
2. O arquivo contém só datas, inteiros e os tempos configurados.
3. `uso_30_dias.totais` soma exatamente os 30 dias da janela; dias anteriores não entram.
4. Configurar tempos recalcula `horas_economizadas` = Σ(total × minutos) / 60, com uma casa decimal.
5. Uma falha ao gravar métricas não altera a resposta da operação original.
6. IDs, ARIA e `data-*` existentes da Home ficam inalterados; o cartão é legível no mobile (390 px) nos dois temas.
7. Testes cobrem incremento, agregação de 30 dias, validação dos tempos e a interface do cartão; `npm run verify` e `npm run test:ui:e2e` passam.

## Limitações

- A deduplicação de comparações repetidas e de buscas vale só enquanto o servidor estiver aberto.
- O histórico começa no dia em que esta versão entrou em uso; não há reconstrução retroativa.
- As horas economizadas são uma estimativa baseada nos tempos informados pelo usuário.
