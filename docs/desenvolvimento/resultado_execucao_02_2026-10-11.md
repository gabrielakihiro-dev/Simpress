# Resultado da Execução 02 — Concorrência na importação de chamados

Data: 11/10/2026. Escopo: somente a etapa 02 do roteiro de correções.

## Defeito confirmado

O relatório anterior era lido antes da transação. O callback de `update_json` ignorava o estado bloqueado e substituía o arquivo por um relatório montado sobre uma leitura antiga. Antes da correção, dois testes determinísticos reproduziram:

- Duas importações distintas retornaram sucesso, mas restou apenas um snapshot.
- Duas tentativas concorrentes do mesmo lote retornaram sucesso, em vez de uma confirmação e uma rejeição por duplicidade.

## Correção implementada

- A reconciliação dos arquivos continua fora do bloqueio. A leitura do relatório corrente, a verificação do identificador do lote, o acréscimo da versão e a inclusão do comprovante acontecem no callback de `transaction.update_json`, dentro da mesma transação.
- A posição na lista de snapshots representa a ordem de confirmação das transações. Horários iguais ou um relógio que retrocede não reordenam versões. A resposta de cada importação descreve o estado confirmado por ela.
- As revisões iniciais das anotações são preparadas com os snapshots realmente anteriores, lidos sob o bloqueio. O relatório, o comprovante e as revisões na fila local são confirmados juntos. Outra importação encontra essas revisões mesmo antes da publicação na pasta compartilhada.
- A publicação das anotações ocorre depois da confirmação, usando o protocolo imutável da Execução 01. Falhas de publicação mantêm a pendência local. Anotação vazia ou em conflito no predecessor impede a reutilização de uma anotação mais antiga.
- O limite existente de snapshots foi preservado. Comprovantes antigos continuam impedindo a reimportação de lotes, inclusive depois da expiração de seus snapshots.
- A duplicidade continua retornando HTTP 409; relatório existente inválido ou ilegível retorna HTTP 503; falha transacional de gravação retorna HTTP 500.
- O importador automático em `main.py` já chama a mesma rota usada pela importação manual; não precisou de alteração.

## Arquivos desta execução

| Arquivo | Alteração |
| --- | --- |
| `routers/operations.py` | Atualização a partir do estado bloqueado; fila de anotações na mesma transação; publicação posterior. |
| `tests/test_ticket_import_concurrency.py` | Quinze testes de regressão, com barreiras/eventos e processos separados. |
| `docs/desenvolvimento/resultado_execucao_02_2026-10-11.md` | Registro da implementação e da validação. |

Alterações preexistentes no checkout foram preservadas. Não houve commit, push, deploy, instalação de dependências, limpeza de dados nem reinicialização do servidor operacional.

## Validação realizada

- **78 testes Python aprovados**, em Python **3.12.14**, somando concorrência de importação, operações, relatórios de chamados, limpeza do histórico de chamados, revisões de anotações e transações de arquivos.
- **15 novos testes aprovados**, incluindo três disputas entre processos Windows separados (`multiprocessing` com `spawn`) e um teste do `AutomaticTicketInbox` real concorrendo com a rota manual. A reconciliação nesses testes de concorrência usa dados simulados; os testes existentes de operações exercitam XLSX gerados em memória.
- Cobertura de lotes distintos e iguais, manual/automático, ordem por confirmação, regressão do relógio, predecessor correto, nota vazia/conflitante, revisão pendente de publicação, retenção, relatório inválido, falha antes da confirmação e falha após aplicação parcial com rollback.
- As corridas usam barreiras/eventos, sem `sleep` para reproduzir a concorrência. Os bloqueios de arquivos e as transações são reais; todos os relatórios e diretórios de escrita são fixtures temporárias.
- **mypy aprovado em 40 arquivos**, incluindo os alvos da CI e `routers/operations.py`.
- `git diff --check` aprovado.

Comando dos testes:

```powershell
& .\.venv\Scripts\python.exe -B -X utf8 -c "import unittest; patterns=['test_ticket_import_concurrency.py','test_operations.py','test_ticket_reporting.py','test_ticket_history_cleanup.py','test_annotation_revisions.py','test_integrity_transactions.py']; suite=unittest.TestSuite(unittest.defaultTestLoader.discover('tests',pattern=p) for p in patterns); result=unittest.TextTestRunner(verbosity=1).run(suite); raise SystemExit(not result.wasSuccessful())"
```

## Limites e riscos restantes

Não foram executados a suíte completa, Python 3.14, navegador, PostgreSQL, OneDrive real ou testes entre computadores. A concorrência verificada usa processos sobre a mesma pasta local e os bloqueios existentes; não estabelece um bloqueio distribuído entre clones sincronizados.

A preparação e a gravação das revisões iniciais agora integram a transação de importação. Lotes grandes podem manter o bloqueio por mais tempo; o tempo de espera e a resposta de recurso ocupado permanecem os existentes. Não foi realizado benchmark com dados operacionais.

A Execução 03 não foi iniciada.
