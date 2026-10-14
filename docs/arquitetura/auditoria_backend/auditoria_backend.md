# Auditoria técnica do backend

**Projeto:** Simpress
**Data da análise:** 13 de outubro de 2026
**Escopo:** revisão analítica do backend (`main.py`, `routers/`, `domains/`, `core/`). Nenhum código ou dado foi alterado.
**Relação com a auditoria anterior:** [auditoria_arquitetura.md](../auditoria_arquitetura.md) e [execucao_auditoria_arquitetura.md](../execucao_auditoria_arquitetura.md). Os itens corrigidos lá (publicação de estado antes do commit, anotações locais e compartilhadas, retenção fora do loop, injeção de dependências nos routers) foram tratados como resolvidos. Este documento cobre o que ficou de fora.

## Limites da análise

- A suíte `python tests/run_tests.py` **não foi executada**: o interpretador global (Python 3.14.6) não tem `python-multipart` e o worktree não tem `.venv`. Nada foi instalado. Não há baseline próprio; a documentação anterior registra 139 testes aprovados, sem reprodução aqui.
- Não foram lidos a fundo: `domains/inventory_comparison.py`, `ticket_reporting.py`, `ticket_reconciliation.py`, `persistence/` e `security/`.
- Memória, uso de GIL e desempenho de E/S em OneDrive são riscos deduzidos da leitura do código, **não medidos**.

## Resumo executivo

**Pontos fortes**

- Locks adquiridos em ordem estável; escrita atômica com temporário no mesmo volume, `fsync` e `os.replace` com retry.
- Transação em lote com diário em `.transactions`, hash por arquivo e rollback idempotente que recusa sobrescrever arquivo alterado por fora (`core/integrity.py:287-340`).
- Todos os `load_workbook(read_only=True)` fecham no `finally`.
- Validação de XLSX rejeita DTD/entidades e aplica os limites do projeto; o tamanho descompactado declarado também limita a leitura real (`core/xlsx_safety.py`).
- `await_worker_completion` impede que o cancelamento de uma requisição libere recursos enquanto a thread ainda trabalha.
- O inbox de lotes devolve o lote à fila em respostas 409/503.

**Principais pontos de atenção**

- Nenhum defeito que corrompa dados foi encontrado nos trechos lidos. O risco principal é de disponibilidade e diagnóstico.
- O inbox automático de inventário e a prévia de atualização fazem E/S de disco no event loop.
- A fonte ativa do inventário pode trocar silenciosamente, porque erro de leitura é tratado como "planilha inválida".
- O orçamento de retry para arquivo ocupado (≈0,85 s) é curto para uma pasta sob OneDrive.
- Locks Python e lock global de transação não seguem uma hierarquia única.

## Diagnóstico por pilar

### Pilar A: concorrência, locks e Windows

1. **Retry curto para OneDrive.** `_RETRY_DELAYS = (0.1, 0.25, 0.5)` com 4 tentativas soma ≈0,85 s (`core/integrity.py:54-55`, `:200-215`). `TRANSACTION_ROOT = BASE_DIR` (`core/config.py:55`) e o projeto fica sob `OneDrive - SEBRAE`, então `.transactions`, `.*.lock` e `.tmp` ficam em pasta sincronizada. Sync ou antivírus segurando um arquivo por 1 a 3 s gera `FileBusyError` (HTTP 409) em operação legítima.
2. **Fail-closed sem saída operacional.** `AtomicFileTransaction.__enter__` chama `_recover_pending_locked` (`core/integrity.py:398`), que levanta `TransactionConflictError` quando o diário não bate com o hash esperado (`:296`). Na subida, `recover_pending_transactions` roda no `lifespan` sem proteção (`main.py:1696`): um conflito pendente impede o servidor de subir, sem mensagem na UI. A recusa em sobrescrever está correta; falta um modo degradado de leitura.
3. **Lock global durante trabalho pesado.** Toda transação segura `.atomic-transactions` até o fim (`core/integrity.py:397`). Dentro dela rodam `load_database` (reparse completo do XLSX), serialização com validação de roundtrip e `get_primary_equipment_file()`. Quem espera mais de 15 s recebe `FileBusyError`. `/api/prontidao` também pega esse lock (`main.py:692-697`) e o erro não é mapeado em `routers/system.py:19`, virando 500 genérico na middleware.
4. **Hierarquia de locks inconsistente.** `prune_expired_histories` segura `ALIAS_HISTORY_LOCK` e `COMPARISON_HISTORY_LOCK` e depois pede o lock global (`main.py:2123-2125`). `aplicar_alteracao_apelido` faz o inverso: segura o global e chama `load_alias_history()` (`main.py:3251`). O resultado é uma espera cruzada de até 15 s, que termina em `FileBusyError`. É estreito (desfazer concorrente com retenção) e se resolve sozinho. As funções `save_modified_apelido_record`, `append_*` e `delete_*` (`main.py:263-383`) não têm chamadores fora dos testes.
5. **Leitura transitória vira "anotação ausente".** `load_history_annotations` ignora `OSError` (`domains/history_annotations.py:322-325`). Um arquivo travado pelo sync ou ainda placeholder do OneDrive some da visão, e a herança de anotações (`domains/inventory_update.py:203-244`) pode deixar de reaplicar uma anotação existente.
6. **Menor.** `_write_temp` captura `Exception`, não `BaseException`; um Ctrl+C no meio deixa um `.tmp` órfão (mitigado por `cleanup_local_temps`).

### Pilar B: performance e event loop

1. **Inbox de inventário.** `process_pending_once` é `async def` e executa `mkdir`, `iterdir`, `lstat`, `rename`, `_archive` e o lock de arquivo direto no loop, a cada 10 s (`domains/inventory_inbox.py:113-151`, `:177-245`). Só a leitura dos bytes e do histórico vai para thread. O equivalente de chamados está correto (`domains/ticket_inbox.py:116-118`). Com a pasta de entrada em OneDrive ou rede (`SIMPRESS_IMPORT_INBOX_DIR`), um `stat` lento congela a API.
2. **Prévia de atualização.** `preview_inventory_files` chama `services.get_primary_equipment_file()` dentro da coroutine (`domains/inventory_update.py:404-407`), que faz `validate_xlsx` e `load_workbook` por candidato no loop.
3. **`lifespan`.** `recover_pending_transactions`, `prune_expired_histories`, `load_database()` e o relatório de prontidão rodam síncronos (`main.py:1696-1719`). Afeta só a subida. Se `load_database()` levantar algo além de `LocalJsonCorruptionError`, as três tarefas de fundo já criadas ficam vazando.
4. **Memória e GIL.** `read_workbook_tables` materializa todas as abas não vazias antes de escolher a aba (`main.py:876-912`). Perto dos limites (5 M de células) o pico de memória é alto, e o parse em thread disputa o GIL com o loop. Não medido.
5. **Anotações.** Cada listagem, exportação e `flush` a cada 60 s relê todos os `*.json` do diretório compartilhado (`domains/history_annotations.py:312`). Cada pendência abre uma transação global própria; com o OneDrive offline, há log por registro por minuto.
6. **Edição de apelido.** Cada edição faz `deepcopy` de três caches e reconstrói o índice de busca (`main.py:3216-3311`). É O(N) por edição; baixa prioridade sem medição.
7. **O que está correto.** Rotas `def` caem no threadpool; os writers usam `to_thread` com `await_worker_completion`; `UPLOAD_ADMISSION` e `WORKBOOK_PARSE_ADMISSION` (1 cada) limitam a concorrência.

### Pilar C: arquitetura e domínio

1. **`main.py` com 4092 linhas.** Concentra índice de apelidos do Endpoint, apelido efetivo, unidades, stores JSON, prontidão e a middleware de segurança local. Há mais de uma dúzia de bifurcações `postgres_backend()` / `postgres_command()` espalhadas.
2. **`routers/inventory_history.py` (1475 linhas).** Contém montagem de linhas do Excel (≈280 linhas inline, `:578-855`), validação de backup por SHA-256, restauração e migração de anotações.
3. **Duplicação.** O wrapper de sincronização de anotações existe em `inventory_history.py:297` e `operations.py:217`; a herança de anotação existe em `inventory_update.py` e `operations.py:165`, com regras parecidas e implementação diferente.
4. **Precedência de hostname.** Override manual > hostname único do Endpoint > Simpress está em `_apply_effective_alias` (`main.py:1401-1439`) e é coerente, mas não está isolada em domínio testável.
5. **Estado global.** Os caches são variáveis de módulo mutadas por `global`. A publicação troca referências (seguro), mas obriga `inventory_state_transaction` a copiar os caches.

### Pilar D: qualidade, tipagem e erros

1. **Falha de leitura vira "inválido".** `find_details_sheet` tem `except Exception: return None` (`main.py:564-565`). `get_primary_equipment_file` então cai para o próximo `EquipamentosDetalhes*.xlsx` (`main.py:586-591`), escolhido por mtime (`main.py:572-583`), que o OneDrive pode alterar. Com um único arquivo, o comportamento é falha fechada. Com legados na pasta, a base ativa pode trocar sem aviso. As escritas têm guardas por `_source_file`; as leituras não.
2. **Logging.** Não há `basicConfig` nem `dictConfig`; os `logger.info` dos domínios provavelmente não saem. `main.py` tem 26 `print(` e a middleware devolve 500 sem traceback (`main.py:1970-1974`).
3. **Exceções largas.** 42 ocorrências de `except Exception` (19 em `main.py`).
4. **Tipagem.** Cerca de 520 linhas usam `Dict/List/Optional/Tuple/Set` de `typing` (146 em `main.py`); `X | None` aparece em um único arquivo. Pydantic v2 está correto, sem resíduos de v1.
5. **Documentação.** A docstring de `prune_expired_histories` diz 90 dias; a constante é `HISTORY_RETENTION_DAYS = 60` (`main.py:2115`).

## Matriz de riscos e oportunidades

| Arquivo / Módulo | Severidade | Problema | Impacto operacional | Solução recomendada |
| :--- | :--- | :--- | :--- | :--- |
| `domains/inventory_inbox.py:113-245` | Média | E/S síncrona em `async def` | API congela com pasta de entrada lenta | Varredura e reserva do lote em método síncrono via `to_thread`; só `await import_batch` no loop |
| `domains/inventory_update.py:404-407` | Média | `get_primary_equipment_file()` no loop da prévia | Prévia trava a API ao abrir XLSX | Resolver os alvos dentro de `to_thread` |
| `main.py:539-591` | Média | Erro de leitura tratado como inválido; fallback por mtime | Base ativa pode trocar silenciosamente | Propagar `OSError`; não usar candidato mais antigo |
| `core/integrity.py:54-55,200-215` | Média | Retry de ≈0,85 s | 409 espúrios com sync/antivírus | Backoff maior só para `PermissionError` (≈8-10 s, com jitter); excluir pastas de trabalho do sync |
| `core/integrity.py:296,398`; `main.py:1696` | Média | Conflito de recuperação impede subir e bloqueia escritas | Sistema indisponível sem mensagem | Capturar no `lifespan`; modo leitura com 503 explicativo; nunca apagar o diário |
| `main.py:692-697`; `routers/system.py` | Média | Prontidão pega lock global; `FileBusyError` vira 500 | Erro genérico durante importação | Ler sem o lock global, com cache; mapear erro só com decisão explícita (muda contrato) |
| `domains/history_annotations.py:312-344` | Média | Ignora `OSError`; relê o diretório inteiro | Anotação "some" no carry-over; custo O(N) | Separar "ilegível" de "inválido"; cachear por (nome, tamanho, mtime) |
| `main.py`; `routers/inventory_history.py` | Média | Regra de negócio em main e routers; anotações duplicadas | Manutenção difícil | Extrair para `domains/`; unificar herança de anotação |
| `main.py:876-912` | Média | Todas as abas em memória | Pico de RAM e pausas de GIL | Materializar só a aba escolhida, após medir |
| `main.py:2123` vs `:3251` | Baixa | Ordem inversa entre locks | Espera de até 15 s e `FileBusyError` | Documentar a hierarquia; remover helpers mortos |
| `main.py:1696-1719` | Baixa | Síncrono no `lifespan`; tarefas fora de `try/finally` | Subida lenta; tarefas vazam | `to_thread`; criar tarefas dentro do `try` |
| Logging (`main.py`, middleware) | Baixa | Sem configuração; 26 `print` | `logger.info` perdido; 500 sem causa | Configurar uma vez; `logger.exception` na middleware |
| Tipagem | Baixa | ~520 linhas com `typing.Dict/List/Optional` | Estilo pré-3.12 | `ruff --select UP006,UP007,UP035,UP045 --fix`; rodar testes |
| `main.py:2115` | Baixa | Docstring diz 90 dias; constante é 60 | Documentação enganosa | Corrigir o texto |

## Roteiro priorizado

Todas as etapas devem preservar rotas, DTOs e a suíte `tests/run_tests.py`.

0. **Baseline.** Criar o `.venv` (`iniciar_servidor.bat` ou `scripts/bootstrap_environment.py`) e rodar `python tests/run_tests.py`.
1. **Falha fechada em `find_details_sheet`.** Propagar `OSError`; não cair para o candidato mais antigo.
   ```python
   except OSError:
       raise   # indisponível ≠ inválido
   ```
2. **Event loop.** `to_thread` na varredura do inbox de inventário, na resolução de alvos da prévia e nas chamadas síncronas do `lifespan`. Reaproveitar o padrão do teste de regressão do loop da retenção.
   ```python
   claimed = await asyncio.to_thread(self._scan_and_claim)  # só filesystem
   for batch in claimed:
       await self.import_batch(...)
   ```
3. **Subida resiliente.** Tratar `TransactionConflictError` no `lifespan` com modo leitura e mensagem (requer decisão de produto).
4. **Backoff de `PermissionError`** em `os.replace` e `unlink`; documentar a exclusão das pastas de trabalho do sync do OneDrive. Ver [onedrive_pastas_de_trabalho.md](onedrive_pastas_de_trabalho.md).
5. **Hierarquia de locks.** Documentar global → arquivo → lock Python folha; remover os helpers mortos de `main.py:263-383`; não segurar lock Python durante a transação. Ver [hierarquia_de_locks.md](hierarquia_de_locks.md).
6. **E/S de anotações.** Distinguir "ilegível" de "inválido"; cachear a listagem.
7. **Prontidão** sem lock global, com cache.
8. **Memória do parse.** Materializar só a aba selecionada, depois de medir.
9. **Logging.** Configuração única; `logger.exception` na middleware.
10. **Extrações de `main.py` e `routers/`** em passos pequenos, pois os testes de integridade dependem da estrutura atual.
11. **Tipagem automática** (`ruff UP`) e correção da docstring de 90 para 60 dias.
