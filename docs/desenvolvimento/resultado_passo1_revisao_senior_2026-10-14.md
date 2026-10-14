# Passo 1 — Linha de base e tratamento de falhas

Data: 14/10/2026. Branch: `codex/passo-1-erros-silenciosos`. Base analisada: `0d518cb`.

## Escopo e resultado

Foram auditadas as 44 capturas `except Exception` em `main.py`, `core/`, `domains/`, `persistence/` e `routers/`; não havia `except:` nesses caminhos. A análise encontrou 31 capturas legítimas, 5 caminhos sem observabilidade garantida e 8 capturas excessivamente amplas.

Foram corrigidos 13 pontos: 12 passaram a capturar erros específicos e um recebeu log obrigatório mantendo a captura abrangente exigida pelo contrato de cancelamento. Restam 32 capturas abrangentes, justificadas na tabela abaixo; nenhuma das capturas auditadas converte uma falha em fallback silencioso sem log ou propagação.

As falhas previstas mantêm os retornos None/False, indicadores de indisponibilidade, códigos HTTP e mensagens já existentes. Falhas inesperadas de programação deixam de ser disfarçadas como planilha inválida. O formato inválido de um manifesto JSON passa a ser validado explicitamente antes do acesso às suas chaves.

## Ambiente e linha de base

- Python 3.14.6 na `.venv`; Node.js v24.21.0.
- `.venv/Scripts/python.exe -m pip install -r requirements-postgres.txt` concluído com código 0.
- `python-multipart==0.0.32` já estava em `requirements.txt` e instalado na `.venv`. Não foi necessário alterar dependências.
- A falha antiga de dependência não se reproduziu no ambiente preparado. Isso não comprova o estado do interpretador utilizado naquela execução antiga.
- A primeira tentativa Python no sandbox não avançou ao chegar aos testes assíncronos e foi interrompida; resultado inconclusivo. A repetição com as permissões necessárias, usando o runner de fixtures isoladas, passou.
- Linha de base Python: **373 testes aprovados**, em 125,745 s, código 0.
- Linha de base JS: **134 testes aprovados**, 0 falhas, código 0.
- As contagens atuais substituem a referência anterior de 354 testes Python no levantamento.

## Alterações

- `core/xlsx_safety.py` reúne os erros esperados dos leitores ZIP/XML/openpyxl em `WORKBOOK_READ_ERRORS`. Não inclui TypeError, AttributeError ou RuntimeError genérico.
- Os logs adicionados usam `logger.warning` e registram apenas operação, papel da planilha, nome do arquivo quando disponível e classe da exceção. Não registram conteúdo de células, anotações, mensagem bruta da exceção ou traceback.
- `core/integrity.py` preserva dados e journals em caso de leitura inválida e mantém os contratos de recuperação.
- `core/async_workers.py` registra falhas após cancelamento mesmo quando não foi fornecido callback. A captura ampla permanece necessária porque o helper aceita tarefas arbitrárias; a requisição continua terminando com CancelledError somente após o worker terminar.
- `tests/test_exception_observability.py` adiciona 17 testes de falhas previstas, proteção de logs, fechamento de workbook, cache anterior, preservação de JSON/journal, liberação de upload/semaphore e propagação de erro inesperado.
- Rotas, schemas, frontend, testes por regex e regras de rótulos/anotações do histórico não foram modificados.

## Classificação completa

As linhas abaixo são as da base `0d518cb`, antes das alterações.

- **A — legítima:** fronteira HTTP/worker/execução best effort com log, ou limpeza que relança a exceção para o chamador. Capturas de limpeza não recebem log duplicado porque não ocultam a falha.
- **B — silenciosa:** fallback sem log, ou log condicionado a callback opcional.
- **C — ampla demais:** operação de leitura/validação conhecida que capturava também falhas de programação.

| Local original | Função | Classe | Decisão e comportamento final |
| --- | --- | --- | --- |
| `core/async_workers.py:33` | `await_worker_completion` | B | Mantém captura genérica por contrato do worker; warning antes de callback/CancelledError. Antes, sem callback, a falha terminava apenas como cancelamento. |
| `core/integrity.py:195` | `_write_temp` | A | Mantido: limpeza de arquivo temporário/staging e relançamento da exceção original. |
| `core/integrity.py:328` | `_recover_transaction` | C | OSError/ValueError; valida formato do manifesto; warning; journal preservado e conflito propagado. |
| `core/integrity.py:476` | `_stage` | A | Mantido: limpeza de arquivo temporário/staging e relançamento da exceção original. |
| `core/integrity.py:504` | `update_json` | C | OSError/ValueError; warning; FileTransactionError preservado sem substituir JSON inválido. |
| `core/integrity.py:582` | `__exit__` | A | Mantido: preserva falha do rollback, libera locks e relança após a limpeza. |
| `domains/inventory_inbox.py:210` | `_process_stable_batch` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/inventory_inbox.py:250` | `_process_stable_batch` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/inventory_inbox.py:404` | `automatic_inventory_import_worker` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/inventory_update.py:504` | `update_inventory_files` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/ticket_inbox.py:211` | `_process_stable_batch` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/ticket_inbox.py:318` | `automatic_ticket_import_worker` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `domains/ticket_reconciliation.py:320` | `_source_table` | C | Erros conhecidos de XLSX; warning por fonte/tipo; TicketWorkbookError preservado. |
| `main.py:281` | `save_modified_apelido_record` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:583` | `find_details_sheet` | B | Erros conhecidos de XLSX; warning com arquivo/papel/tipo; None preservado. |
| `main.py:687` | `_check_ready_workbook` | B | Erros de leitura/validação, HTTPException e bloqueio; warning; estado invalid preservado. |
| `main.py:747` | `_get_startup_readiness_unlocked` | B | OSError na enumeração; warning; inventário indisponível preservado. |
| `main.py:752` | `_get_startup_readiness_unlocked` | B | OSError/FileBusyError na seleção; warning; ausência de inventário ativo preservada. |
| `main.py:897` | `_report_startup_readiness_best_effort` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `main.py:1003` | `read_workbook_tables` | C | Erros conhecidos de XLSX; warning; HTTP 400 existente preservado. |
| `main.py:1309` | `load_export_model_aliases` | C | Erros conhecidos de XLSX; warning; HTTP 500 existente preservado. |
| `main.py:1331` | `read_endpoint_alias_index` | C | OSError/HTTPException; warning; índice indisponível e apelidos preservados. |
| `main.py:1690` | `count` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:1809` | `prepare_local_state` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `main.py:1815` | `prepare_local_state` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:1853` | `_history_annotation_sync_worker` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `main.py:2085` | `__call__` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:2415` | `_load_database_unlocked` | C | Erros conhecidos de XLSX/FileBusyError; warning; False e cache anterior preservados. |
| `main.py:3444` | `aplicar_alteracao_apelido` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:3815` | `exportar_equipamentos` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |
| `main.py:3919` | `_import_automatic_inventory_batch` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `main.py:3961` | `atualizar_planilhas` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `persistence/files.py:219` | `run` | A | Mantido: registra estado falhou sem substituir confirmação e relança a falha. |
| `persistence/postgres.py:71` | `open` | A | Mantido: fecha pool e propaga PersistenceError sanitizado; não ativa fallback. |
| `routers/inventory_history.py:306` | `_sync_annotation_record` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:383` | `migrate_legacy_history_annotations` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:401` | `migrate_legacy_history_annotations` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:1010` | `salvar_anotacao_comparacao_historica` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:1133` | `restaurar_comparacao_historica` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:1248` | `restaurar_comparacao_historica` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/inventory_history.py:1440` | `excluir_comparacao_historica` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/local_setup.py:24` | `commit_model` | C | WorkbookSafetyError/erros conhecidos de XLSX; warning; HTTP 400 e liberação do upload preservados. |
| `routers/operations.py:224` | `sync_ticket_annotation` | A | Mantido: fronteira HTTP, sincronização ou tarefa best effort com log explícito. |
| `routers/transfers.py:294` | `_gerar_planilha_transferencia` | A | Mantido: fronteira com aviso no console; falha propagada ou funcionalidade marcada indisponível. |

## Validação após as mudanças

| Verificação | Resultado |
| --- | --- |
| Suíte Python completa | **390 testes aprovados**, 137,833 s, código 0 |
| Regressões novas isoladas | **17 testes aprovados**, código 0 |
| Suíte JS do workflow | **134 testes aprovados**, 0 falhas, código 0 |
| mypy com comando do CI | **40 arquivos sem problemas**, código 0 |
| Sintaxe JavaScript do CI | **18 arquivos aprovados**, código 0 |
| compileall nos caminhos do CI e teste novo | Aprovado, código 0 |
| Dependências (`pip check`) | Nenhuma dependência quebrada, código 0 |
| Verificação de credenciais | Aprovada nos arquivos da entrega |
| `git diff --check` | Aprovado |

A suíte Python cresceu de 373 para 390 testes, sem falhas. Uma execução intermediária com 389 testes também passou; foi repetida após a correção adicional de logging no worker.

Os testes Python foram executados com `.venv/Scripts/python.exe -B tests/run_tests.py`, que usa fixtures e bloqueia carregamento/recuperação de planilhas operacionais na descoberta. Os testes JS são os dez arquivos listados no passo `Run browser workflow tests` de `.github/workflows/ci.yml`. Também foi utilizado o comando mypy exato do workflow.

Os logs de diagnóstico locais ficam em `outputs/passo1/` (pasta ignorada pelo Git). Há avisos assíncronos de falhas sintéticas em Python 3.14 já presentes na linha de base; não são falhas da suíte. Os logs adicionados por este passo têm testes que rejeitam conteúdo sensível e exc_info.

Não foram executados E2E de navegador nem a matriz remota Python 3.12/3.14. A validação documentada é local em Python 3.14.6. Parsing em threads e migração dos carregamentos diretos permanecem no passo 2.

## Entrega

Um commit local com os seis arquivos de produção alterados, os testes novos e este relatório, na branch indicada. Os dois arquivos não rastreados preexistentes (`data/state/inventory_update_idempotency.json` e `docs/desenvolvimento/prompts_revisao_senior_2026-10-14.md`) ficam fora do commit. Nenhum push ou merge faz parte desta entrega.
