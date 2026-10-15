# Hierarquia de locks

Passo 5 do [roteiro da auditoria](auditoria_backend.md#roteiro-priorizado) (14/10/2026).

## Ordem de aquisição

Toda thread adquire locks nesta ordem. Ela pode pular níveis, mas nunca voltar a um nível acima enquanto segura um nível abaixo.

| Nível | Lock | Onde | Como é adquirido |
| :--- | :--- | :--- | :--- |
| 1 | Global `.atomic-transactions` | `AtomicFileTransaction.__enter__`, `recover_pending_transactions`, `load_database()` (`core/integrity.py`, `main.py`) | `lock_paths([root / ".atomic-transactions"])` |
| 2 | Locks de arquivo | `lock_paths(...)`: `RLock` por caminho e `.<arquivo>.lock` do sistema operacional | Uma única chamada com todos os caminhos, em ordem canônica. Fora de transação, só leitura (prévia, modelo de transferência) |
| 3 | Locks Python (folha) | `STATE_LOCK`, `ALIAS_HISTORY_LOCK`, `COMPARISON_HISTORY_LOCK`, `MODIFIED_APELIDOS_LOCK`, `_READINESS_VALIDATION_LOCK` e o lock de `ReadinessReportCache` (`domains/readiness.py`), `_TRANSACTION_RECOVERY_BLOCK_LOCK`, `_EXPORT_STATUS_LOCK`, `_EXPORT_COUNTS_LOCK` (`main.py`); `_PATH_CACHE_LOCK` (`core/xlsx_safety.py`); `_equipment_search_index_lock` (`persistence/postgres.py`) | `with LOCK:` em volta de memória ou de uma única leitura de arquivo |

`AtomicFileTransaction.add_target` pega mais locks de arquivo depois dos primeiros. Isso é seguro porque só acontece com o lock global preso, que serializa todas as transações.

## Regras

1. **Folha é folha.** Com um lock Python preso, não abra transação, não chame `lock_paths`, `load_database()` nem `get_startup_readiness()`, e não chame código que faça isso.
2. **Nenhum lock Python envolve uma transação.** Pegue o lock Python dentro da transação, só pelo tempo de copiar ou publicar estado (como `inventory_state_transaction` e `aplicar_alteracao_apelido` fazem com `STATE_LOCK`).
3. **Exclusão entre escritores vem dos níveis 1 e 2.** Os históricos JSON só são gravados dentro de `AtomicFileTransaction`, que segura o lock global e o lock do arquivo. Leitores (`load_alias_history`, `load_comparison_history`) leem um arquivo trocado por `os.replace` atômico e veem a versão anterior ou a nova, nunca um arquivo parcial.
4. **Guardas sem espera ficam fora da hierarquia.** `UPLOAD_ADMISSION`, a admissão de parse em `routers/local_setup.py` e as guardas de execução única dos inboxes (`_PROCESS_WORKER_LOCK`, `_WORKER_LOCK`) usam `acquire(blocking=False)` antes de qualquer lock e nunca esperam, então não fecham ciclo. A única espera em `WORKBOOK_PARSE_ADMISSION` (validação da prévia) acontece sem nenhum lock preso.

## Inversões corrigidas

| Local | Antes | Agora |
| :--- | :--- | :--- |
| `prune_expired_histories` (`main.py`) | Segurava `ALIAS_HISTORY_LOCK` e `COMPARISON_HISTORY_LOCK` e depois pedia o lock global. Quem já segurava o global e chamava `load_alias_history()` (alteração de apelido) esperava até 15 s, e a retenção falhava com `FileBusyError` | Abre a transação sem lock Python |
| Salvar anotação (`PUT /api/historico-comparacoes/{evento_id}/anotacoes/{item_id}`) | `comparison_history_lock` em volta da transação | Só a transação |
| Excluir evento (`DELETE /api/historico-comparacoes/{evento_id}`) | `comparison_history_lock` em volta da transação; o `FileBusyError` virava HTTP 500 | Só a transação |

O campo `comparison_history_lock` saiu de `InventoryHistoryServices`, porque ficou sem uso. As rotas, os DTOs e as respostas HTTP não mudaram.

Efeito colateral aceito: antes, um leitor do histórico de comparações esperava a anotação ou a exclusão terminar. Agora ele lê a versão já gravada. É o mesmo comportamento que a atualização de inventário e a alteração de apelido já tinham, porque nunca seguraram esse lock.

## Código removido

`save_modified_apelido_record`, `append_alias_history_entry`, `delete_alias_history_entry`, `append_comparison_history_entry`, `delete_comparison_history_entry` e o auxiliar `_atomic_json_update` não tinham chamadores no código. O único uso em teste (`save_modified_apelido_record`, no teste de JSON corrompido) passou a usar `AtomicFileTransaction.update_json`, o mesmo caminho dos escritores reais.

## Teste de regressão

`tests/test_lock_hierarchy.py` abre uma transação numa thread, que segura o lock global, e roda a operação concorrente em outra. Quando a operação pede o lock global, a primeira thread lê o histórico pelo lock Python. Só a operação testada tem o tempo de espera reduzido para 2 s.

- Com a inversão, a leitura espera a operação liberar o lock Python, e a operação espera o lock global. O impasse sempre termina em `FileBusyError` (ou HTTP 500 na exclusão) depois de 2 s.
- Com a hierarquia, a leitura termina na hora, a transação fecha e a operação conclui.

O resultado não depende do escalonamento das threads, porque a sincronização é feita por eventos. Cada thread tem limite de 10 s.

## Prontidão sem lock global

Passo 7 do roteiro (15/10/2026). `get_startup_readiness()` não pega mais o lock global. Os escritores trocam arquivos com `os.replace`, então a prontidão lê a versão anterior ou a nova. O relatório fica em `ReadinessReportCache` por até 2 s, e só enquanto a assinatura dos arquivos lidos (caminho, tamanho, `mtime` e `ctime`), o estado carregado em memória e o bloqueio de gravação forem os mesmos. A assinatura é tirada antes de montar o relatório, e o relatório é montado fora do lock do cache. Uma importação em andamento não gera mais `FileBusyError` (HTTP 500) em `/api/prontidao`.
