# Auditoria do backend — segunda rodada (15/10/2026)

**Escopo:** segurança local, planilhas, integridade dos dados entre XLSX e JSON, concorrência e desempenho. Complementa [auditoria_backend.md](auditoria_backend.md) (13/10) e não a substitui. As seções 1 a 6 registram a análise, feita sem alterar código. A seção 7 traz a situação depois das correções.
**Evidência:** cada achado é **Confirmado** (leitura inequívoca, script ou medição) ou **Inferido**. Exemplos usam dados fictícios.

## 1. Limites da análise

- Ambiente: Windows 11, Python 3.12.14 (`.venv`), openpyxl 3.1.5, FastAPI 0.141.1. O Python global (3.15.0) não tem as dependências e não foi usado.
- Linha de base: `python -B tests/run_tests.py` → **380 testes, OK** (52 s).
- Medições com planilhas sintéticas geradas fora do repositório. Dados reais não foram abertos.
- Não verificados: comportamento sob OneDrive real (sincronização, placeholders), Excel aberto durante a gravação, carga concorrente de requisições, `domains/ticket_reconciliation.py` e `domains/inventory_comparison.py` em profundidade, e o frontend.
- Nenhuma rota foi chamada por HTTP. A leitura de `security/local_requests.py` e do `main.py` sustenta os achados de segurança.

## 2. Resumo executivo

**Pontos fortes (confirmados)**
- Proteção local em camadas: só peer loopback sem cabeçalhos de proxy, `Host` exato com a porta, `Origin` igual ao `Host`, `Sec-Fetch-Site` restrito a `same-origin`/`none` em `/api/`, limites de corpo e `uvicorn` ligado a `127.0.0.1` com `proxy_headers=False`.
- ZIP de entrada lido em memória, sem extração em disco, com recusa de `..`, caminho absoluto, `:` e NUL, ZIP com senha e candidatos duplicados. A leitura real é limitada ao tamanho permitido.
- Validação estrutural do XLSX com `expat`: rejeita DTD e entidades, duplicidade de partes, relações fora de `xl/worksheets/` e áreas acima dos limites.
- Gravações transacionais com diário, hash por arquivo, rollback que recusa sobrescrever arquivo alterado por fora e caminhos do manifesto confinados à raiz.
- Token de prévia assinado por HMAC com segredo do processo, preso aos hashes dos arquivos enviados e dos ativos, com validade de 10 min.
- Logs sem conteúdo de células: a middleware registra apenas quadros da pilha e o tipo da exceção.

**Cinco riscos principais**
1. Desfazer um apelido grava um override manual permanente (M1).
2. O servidor não percebe importações feitas pelo script de linha de comando (M2).
3. Os limites reais de planilha são mais baixos que o anunciado e o parse é lento e pesado perto do teto (M3).
4. A normalização de série colide e descarta overrides ambíguos em silêncio (B1).
5. Restaurar um backup antigo deixa overrides e histórico apontando para séries ausentes (B2).

**Não há achado de criticidade Alta.** Nada indica perda ou corrupção de dados, execução de código, vazamento de dados sensíveis ou ação disparada por outro site.

## 3. Status dos pendentes de 13/10

O `README.md` desta pasta está desatualizado em relação ao código.

| Passo | Situação no código atual |
| --- | --- |
| 1 Falha fechada em `find_details_sheet` | Concluído: `ensure_workbook_readable` levanta `FileBusyError` (`domains/uploaded_workbooks.py:140-151`). |
| 2 Event loop | Concluído: `process_pending_once` usa `asyncio.to_thread` (`domains/inventory_inbox.py:131-139`) e o `lifespan` prepara o estado em uma thread (`main.py:1068-1103`). |
| 3 Subida resiliente | Concluído: conflito de diário vira modo somente leitura (`main.py:558`, `:591`, `:1079`). |
| 4 Backoff de `PermissionError` | Concluído: orçamento de 8 s com jitter (`core/integrity.py:57-62`). |
| 5 Hierarquia de locks | Concluído e documentada (`main.py:186-188`). |
| 6 Anotações | Concluído: `AnnotationReadError` e cache por (tamanho, mtime) (`domains/history_annotations.py:323-402`). |
| 7 Prontidão sem lock global | Aparentemente concluído (cache por assinatura de arquivos, `main.py:471-502`); não testado sob carga. |
| 8 Memória do parse | **Pendente e medido** (M3). |
| 9 Logging | Concluído (`core/logging_setup.py`). |
| 10 Extrações de `main.py` | **Pendente**: `main.py` tem 3.268 linhas (o README fala em cerca de 4.150). |
| 11 Tipagem | Não verificado. |

## 4. Achados

### Média

**M1. Desfazer ou excluir um evento de apelido grava um override manual permanente** — Confirmado
- Evidência: `aplicar_alteracao_apelido` sempre faz `aliases[target_serial] = novo_apelido` e `_apelido_manual_override = True` (`main.py:2458`, `:2478`). `desfazer_alteracao_apelido` e `excluir_evento_historico_apelido` chamam essa função com o apelido **local** anterior (`main.py:2576`, `:2624`).
- Risco prático: equipamento com apelido `ANT` na Simpress e hostname `PR-NB-01` no Endpoint. O usuário edita para `X` (override) e desfaz. O resultado é um override `ANT`, e o hostname do Endpoint deixa de valer mesmo quando o Endpoint mudar. O "desfazer" não volta ao estado original.
- Solução: registrar no evento se havia override antes (`tinha_override`). Ao desfazer ou excluir, remover a chave do JSON quando não havia. Só gravar valor quando havia.
- Teste: editar, desfazer e conferir que o JSON de overrides volta idêntico e que o hostname do Endpoint reaparece em `apelido`.

**M2. O servidor não percebe escritas de outro processo** — Confirmado por leitura
- Evidência: `load_database()` só roda na subida (`main.py:1096`), em `/api/recarregar-base` (`:2875`) e depois de gravações do próprio processo. Nenhuma rota de leitura compara assinatura de arquivo. O README de `data/state/entrada_chamados/` orienta rodar `scripts/process_*_inbox.py` também com o servidor ligado.
- Risco prático: o script troca os XLSX e o histórico, mas busca, painel e exportação continuam mostrando o inventário antigo até o botão de recarregar ou reinício. As gravações são protegidas (`_source_file`, hash de revisão e locks entre processos geram 409), então o risco é de **leitura obsoleta**, não de corrupção.
- Solução: reaproveitar `readiness.file_signature` e a assinatura de `_export_files_signature` (`main.py:857`). Um tick leve de 10 s no worker existente compara (caminho, tamanho, `mtime_ns`) dos arquivos ativos e chama `load_database()` sob o lock quando mudar. Alternativa: documentar que o script exige o servidor parado.
- Teste: simular troca de arquivo por fora e verificar que o cache é recarregado ou que a rota responde 409 com orientação.

**M3. Limites reais de planilha e custo do parse** — Confirmado por medição
- O teto efetivo é o de **256 MB descompactados** (`core/config.py:42`), não 30 MB nem 250.000 linhas. O limite de 5 M de células na caixa envolvente (`MAX_XLSX_TOTAL_CELLS`) também restringe: 250.000 linhas só cabem com até 20 colunas, e uma planilha com 50 colunas (o formato completo da Simpress) cabe com no máximo 100.000 linhas.
- Teste: 100.000 × 50 → 23 MB compactados e 346 MB de XML, **rejeitado**. A compressão chega a cerca de 15:1.

| Cenário (sintético) | Arquivo | Validação | `read_workbook_tables` | Pico de memória |
| --- | --- | --- | --- | --- |
| 1.400 × 50 (ordem do inventário atual) | 0,3 MB | 0,2 s | 1,3 s | 64 MB |
| 70.000 × 50 | 16 MB | 10,9 s | **70 s** | **451 MB** |
| 170.000 × 20 | 16 MB | 10,0 s | **68 s** | **406 MB** |

- Risco prático: hoje (cerca de 1,4 mil linhas) é irrelevante. Perto do teto, um envio ocupa a admissão de parse única (`MAX_CONCURRENT_WORKBOOK_PARSERS = 1`) por mais de 1 min e consome centenas de MB. O fluxo de atualização lê dois pares de planilhas, então o pico real é maior (inferido).
- Solução: (1) materializar só a aba e as colunas usadas, em tuplas, em vez de um `dict` por linha com todas as abas; (2) validar e ler em uma única passada de ZIP; (3) alinhar a mensagem de erro com o limite real e documentá-lo. Reavaliar os limites só se o inventário passar de uns 20 mil equipamentos.
- Teste: manter a planilha sintética como teste opcional, marcado como lento, com teto de memória.

### Baixa

**B1. Normalização de série agressiva e override ambíguo ignorado** — Confirmado por leitura
`normalize_reference_value` remove tudo que não é A–Z/0–9 e passa para maiúsculas (`domains/inventory_comparison.py:14-20`). Séries que diferem só por pontuação ou caixa colidem. Com dois overrides na mesma chave normalizada, `manual_aliases_by_serial` descarta ambos sem aviso (`domains/effective_alias.py:199-210`) e a série volta ao apelido da planilha. `manual_alias_for_serial` percorre todos os overrides a cada chamada (O(N)).
Solução: dar preferência à chave exata e listar a colisão entre os itens "para conferência". Indexar uma vez em vez de varrer.

**B2. Restaurar backup antigo e registros órfãos** — Confirmado por leitura
A restauração troca os dois XLSX e acrescenta um evento (`routers/inventory_history.py:1061-1260`). `apelidos_modificados.json` entra só como alvo de lock, e as anotações ficam presas aos eventos originais (correto). Overrides de séries que não existem no inventário restaurado ficam invisíveis, e `desfazer` desses eventos responde 404 (`main.py:2551-2552`). Nada é podado.
Solução: ao restaurar, calcular quantos overrides e eventos de apelido ficaram sem série e registrá-los no evento de restauração. Não apagar automaticamente.

**B3. `/docs`, `/redoc` e `/openapi.json` ativos** — Confirmado (`main.py:1182`)
O `Host` exato bloqueia DNS rebinding, e os cabeçalhos CORP/COOP impedem leitura por outro site. O risco é só exposição de contrato a outro usuário local.
Solução: `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)` por padrão e habilitar com `SIMPRESS_ENABLE_DOCS=1`.

**B4. Escopo WebSocket passa pela middleware** — Inferido
`if scope["type"] != "http": await self.app(...)` (`security/local_requests.py:125-127`). Não há rotas WebSocket hoje; se surgirem, ficam sem checagem de Host e Origin.
Solução: aplicar a checagem de peer, Host e Origin também a `websocket` e deixar passar apenas `lifespan`.

**B5. Requisições sem `Origin` e sem `Sec-Fetch-Site` são aceitas** — Confirmado
É coerente para `curl` e testes, mas qualquer processo ou usuário Windows na mesma máquina pode usar a API. Faz parte do modelo local sem login. Opcional: exigir `Origin` ou `Sec-Fetch-Site` em métodos de escrita, com variável de ambiente para o modo de scripts.

**B6. Neutralização de fórmulas é implícita e sem teste** — Confirmado por script
Em `set_template_cell` (`routers/transfers.py`) e `set_value` (`main.py:1927-1934`), o openpyxl marca uma string iniciada por `=` como fórmula (`data_type == "f"`). O arquivo final sai como `t="inlineStr"` porque `serialize_workbook_validated` reescreve o XML da célula. O mesmo vale para o histórico (`_safe_export_cell`, `domains/history_export.py:113-118`) e para chamados (`_safe_cell`, `domains/ticket_reporting.py:777-785`). Nenhum teste cobre isso. O prefixo `'` dos chamados aparece literalmente no Excel.
Solução: testes de regressão com `=HYPERLINK(...)`, `+cmd`, `@SUM` e `\t=` nos três caminhos, e um helper único de escape.

**B7. Dados pessoais e rastros nos logs e na configuração** — Confirmado
- `logger.exception` com a série do chamado e mensagem completa da exceção (`routers/operations.py:227`, `:270`); a mensagem de um `OSError` traz o caminho absoluto, incluindo o usuário do Windows.
- A busca por série e hostname usa `?q=` e entra no log de acesso do `uvicorn` (somente console).
- `core/config.py:60-65` traz nome, e-mail e telefone de contato como valores padrão versionados.
Solução: logar `type(error).__name__` e hash curto da série; `access_log=False`; mover os contatos para variável de ambiente ou arquivo ignorado pelo Git.

**B8. Junções do Windows nas pastas de entrada** — Inferido
Os inboxes recusam links simbólicos (`is_symlink()`), mas junções NTFS não são detectadas por ele (`domains/inventory_inbox.py:160`, `:188`, `:191`). Quem coloca arquivos na fila já é o usuário local.
Solução: usar também `Path.is_junction()` (disponível no Python 3.12).

**B9. Espera de lock ocupa threads do pool** — Inferido
`lock_paths` espera até 15 s por thread (`core/integrity.py:136`). Rotas síncronas bloqueadas pelo lock global podem esgotar o pool padrão de 40 threads durante uma importação longa. Uso de uma ou poucas pessoas torna isso improvável. Solução: orçamento menor nas rotas de leitura ou 503 imediato.

**B10. Acoplamento** — Confirmado
Rotas limpas: `dashboard`, `equipment_search`, `system`, `transfer_history`, `transfers`, `units` e `frontend` não mexem em arquivos. `routers/inventory_history.py` (1.467 linhas) concentra restauração com cópias de backup, hash, `shutil` e `mkdir`, e a montagem da planilha de exportação (`:795-856`). `main.py` ainda mistura estado global, regras de apelido, retenção e prontidão. Mover restauração e exportação para `domains/` e continuar o passo 10.

## 5. Matriz de riscos

| Arquivo | Criticidade | Problema | Impacto | Solução |
| --- | --- | --- | --- | --- |
| `main.py:2458, 2478, 2576, 2624` | Média | Desfazer grava override permanente | Hostname do Endpoint deixa de valer | Registrar `tinha_override` e remover a chave |
| `main.py:1096, 2875`; `scripts/process_*` | Média | Cache não vê escrita de outro processo | Leitura obsoleta até recarregar | Assinatura de arquivos num tick de 10 s |
| `domains/uploaded_workbooks.py:219-255`; `core/config.py:42-45` | Média (Baixa hoje) | Parse de 70 s e 450 MB perto do teto; limites reais menores | Admissão ocupada, memória alta | Ler só a aba e as colunas usadas; passada única |
| `domains/effective_alias.py:199-210` | Baixa | Colisão de série descarta override | Apelido manual some sem aviso | Chave exata primeiro e item para conferência |
| `routers/inventory_history.py:1061` | Baixa | Órfãos após restaurar backup | Overrides invisíveis, desfazer 404 | Contar e registrar no evento |
| `main.py:1182` | Baixa | Documentação interativa ativa | Exposição de contrato | Desligar por padrão |
| `security/local_requests.py:125` | Baixa | WebSocket sem checagem | Risco futuro | Aplicar as checagens também a WebSocket |
| `routers/transfers.py`, `main.py:1933` | Baixa | Escape de fórmula implícito e sem teste | Regressão silenciosa | Testes e helper único |
| `routers/operations.py:227,270`; `core/config.py:60` | Baixa | Série, caminho e contatos em log e configuração | Vazamento local | Hash, `access_log=False` e variáveis de ambiente |
| `domains/inventory_inbox.py:160` | Baixa | Junções não detectadas | Leitura fora da fila | `is_junction()` |
| `core/integrity.py:136` | Baixa | Espera de 15 s por thread | Pool esgotado em importação longa | 503 imediato nas leituras |
| `routers/inventory_history.py`, `main.py` | Baixa | Regra de negócio e arquivos nas rotas | Manutenção | Mover para `domains/` |

## 6. Roteiro sugerido (um PR por passo, preservando rotas, DTOs e `tests/run_tests.py`)

1. M1: `tinha_override` no evento e teste de ida e volta (eventos antigos ficam como estão).
2. M2: tick de assinatura de arquivos (ou orientação de servidor parado) com teste de troca externa.
3. B6 e B3: testes de fórmula nos três caminhos, helper único e `/docs` desligado por padrão.
4. M3: leitura de uma aba em tuplas, passada única e teste lento opcional.
5. B1 e B2: indexação das chaves, item de colisão no "para conferência" e contagem de órfãos na restauração, respeitando as regras de rótulos e anotações do `AGENTS.md`.
6. B4, B7, B8, B9: endurecimentos pequenos.
7. B10 (passo 10): extrações de `routers/inventory_history.py` e `main.py`.

## 7. Situação após as correções (15/10/2026)

M1 foi corrigido na branch `fix-desfazer-apelido-override`. Os demais itens estão na branch `fix-auditoria-pendentes`, cada um com teste de regressão.

| Achado | Situação | Correção e teste |
| --- | --- | --- |
| M1 | Corrigido | Evento guarda `tinha_override`. Desfazer ou excluir sem override anterior remove a chave (`tests/test_integrity_workflows.py`, testes `test_undo_*`). |
| M2 | Corrigido | `publish_database_state` guarda a assinatura (caminho, tamanho, `mtime_ns`) dos arquivos da base. O worker `_external_change_reload_worker` confere a cada 10 s e chama `load_database()` quando outro processo alterou os arquivos. Gravações do próprio site não disparam recarga (`test_cache_reloads_after_another_process_replaces_the_active_files`). |
| M3 | Parcial | A mensagem de recusa e o `README.md` informam o limite real (256 MB descompactados, cerca de 70 mil linhas com 50 colunas). Ler só a aba e as colunas usadas fica para quando o inventário passar de uns 20 mil equipamentos. |
| B1 | Corrigido | Chaves que colidem com o mesmo apelido são mantidas. Conflitos continuam ignorados, mas são registrados no log sem a série, uma vez por mudança de contagem. Editar o apelido resolve o conflito (`tests/test_effective_alias.py`). |
| B2 | Corrigido | A restauração grava `apelidos_manuais_sem_equipamento` no evento e na resposta, sem apagar overrides (`test_restore_counts_manual_aliases_left_without_equipment_and_keeps_them`). |
| B3 | Corrigido | `/docs`, `/redoc` e `/openapi.json` respondem 404, salvo com `SIMPRESS_ENABLE_DOCS=1` (`test_interactive_docs_are_disabled_by_default`). |
| B4 | Corrigido | O handshake WebSocket exige peer loopback, `Host` autorizado e `Origin` igual ao `Host`. Sem isso, a conexão é fechada antes do aceite (`test_websocket_handshake_requires_loopback_host_and_same_origin`). |
| B5 | Aceito | Não muda. Um processo local sem cabeçalhos de navegador já consegue ler `data/` diretamente, então exigir `Origin` não protege nada no modelo local sem login. Chamadas de outro site continuam bloqueadas. |
| B6 | Corrigido | Também confirmado: na edição de equipamento, um texto iniciado por `=` era **recusado** pela validação (falha fechada, sem injeção). O helper `set_cell_value_as_text` (`core/xlsx_safety.py`) grava esses textos como texto literal em edição, transferência e histórico. A exportação de chamados mantém o prefixo `'`, já coberto por teste (`tests/test_formula_text_cells.py`, `test_equipment_text_starting_with_formula_marker_is_saved_as_literal_text`). |
| B7 | Parcial | `RedactingFormatter` remove a mensagem das exceções no log e mantém tipo e pilha. As séries dos chamados aparecem como `ref-<hash>`. O log de acesso do `uvicorn` foi desligado (`tests/test_logging_setup.py`). Os contatos padrão em `core/config.py` continuam versionados: tirá-los muda as planilhas de transferência de quem não definir as variáveis `SIMPRESS_TRANSFER_ORIGIN_*`, e isso é decisão do responsável. |
| B8 | Corrigido e confirmado | O teste comprovou a falha: uma junção NTFS fazia o importador ler um arquivo fora da fila. `is_link_or_junction` (`core/local_paths.py`) é aplicado às duas filas de entrada (`test_junction_*`). |
| B9 | Corrigido | As leituras consultadas pela página (contagem da exportação e índice do Endpoint) esperam no máximo 3 s pelo lock e depois respondem 409. O painel mantém os números anteriores (`tests/test_read_lock_timeouts.py`). |
| B10 | Pendente | Extrair a restauração e a exportação de `routers/inventory_history.py` e continuar o passo 10 em `main.py`. É uma refatoração sem mudança de comportamento, melhor feita em PR próprio. |
