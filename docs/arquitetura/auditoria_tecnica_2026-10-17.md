# Auditoria técnica full-stack — 17/10/2026

**Escopo:** back-end, front-end, persistência, CI e conformidade com o `AGENTS.md`, sem alterar código. O conteúdo de planilhas e JSONs operacionais não foi aberto: só foram lidos nomes, tamanhos e datas dos arquivos em `data/state/`.
**Linha de base:** `main` em `a857364` (merge do PR #39).
**Evidência:** cada achado é **Confirmado** (código lido e caminho de execução seguido, ou reproduzido com dados sintéticos) ou **Suspeito** (precisa de verificação). Os achados das auditorias anteriores aparecem só na seção 2 e não se repetem como novos.

---

## 1. Resumo executivo da stack

| Camada | Tecnologia (versão fixada) | Origem |
| --- | --- | --- |
| Runtime | Python 3.12+ (CI: 3.12 e 3.14), Windows | `requirements.txt`, `.github/workflows/ci.yml` |
| API | FastAPI 0.141.1, Starlette 1.7.0, Uvicorn 0.54.0, Pydantic 2.13.5 | `requirements.txt` |
| Planilhas | openpyxl 3.1.5, defusedxml 0.7.1, validador próprio com `expat` | `requirements.txt`, `core/xlsx_safety.py` |
| Front-end | HTML, CSS e JavaScript sem framework (31 `<script>` clássicos), Tailwind 4.3.3 pré-compilado, Lucide 1.48.0 em subconjunto | `package.json`, `static/index.html` |
| Testes | `unittest` (410 testes), `node --test` (173 testes), Playwright 1.64.0 + axe-core 4.13.0 (6 specs) | `tests/` |
| Persistência | Arquivos XLSX (inventário) e JSON (estado, históricos), com locks de SO, diário de transações e pasta compartilhada (OneDrive) para anotações | `core/integrity.py`, `core/config.py` |

**Arquitetura.** Monólito local: um processo Uvicorn em `127.0.0.1` serve a API e os estáticos. O `main.py` concentra o estado global em memória (cache de equipamentos, unidades e índice de busca), monta os serviços e os injeta nos *routers* por *dataclasses* de serviços. As regras ficam em `domains/`, e a infraestrutura de arquivos e segurança em `core/` e `security/`. Não há banco de dados nem autenticação: o modelo de segurança é "só loopback, mesmo Host e mesma origem".

```
 navegador ──HTTP──▶ security/local_requests.py (peer, Host, Origin, limites, admissão)
                         │
                    main.py (estado global, 15 rotas, wiring) ──▶ routers/*.py (9 routers)
                         │                                            │
                         └────────────▶ domains/*.py (regras) ◀───────┘
                                              │
                                   core/integrity.py · core/xlsx_safety.py
                                              │
                          data/planilhas_entrada/*.xlsx · data/state/*.json · OneDrive
```

---

## 2. Status das auditorias anteriores

| Achado | Origem | Status | Evidência |
| --- | --- | --- | --- |
| M1 Desfazer apelido grava override permanente | backend 15/10 | Resolvido | `tinha_override` em `main.py` (3 ocorrências), testes `test_undo_*` |
| M2 Cache não percebe escrita de outro processo | backend 15/10 | Resolvido | `_external_change_reload_worker` (`main.py:1158`) |
| M3 Custo do parse perto do teto | backend 15/10 | **Agravado** | Os limites dobraram (`core/config.py:42`, `:47`; commit `35dc9c3`) sem otimizar o parse. O README já admite "mais de dois minutos" e "cerca de 900 MB" (`README.md:275`). Ver N7. |
| B1 Colisão de série no override | backend 15/10 | Resolvido | `domains/effective_alias.py`, `tests/test_effective_alias.py` |
| B2 Órfãos após restaurar | backend 15/10 | Resolvido | `apelidos_manuais_sem_equipamento` (`domains/history_restore.py:404`) |
| B3 `/docs` ativo | backend 15/10 | Resolvido | `main.py:1230-1239` |
| B4 WebSocket sem checagem | backend 15/10 | Resolvido | `security/local_requests.py:124-138` |
| B5 Requisições sem `Origin` | backend 15/10 | Aceito | Decisão registrada, sem mudança |
| B6 Fórmulas na exportação | backend 15/10 | Resolvido | `set_cell_value_as_text` (`core/xlsx_safety.py`), `tests/test_formula_text_cells.py` |
| B7 Dados pessoais em log e configuração | backend 15/10 | **Ainda presente (parcial)** | Contatos padrão continuam versionados em `core/config.py:72-76`. Os logs foram corrigidos. |
| B8 Junções NTFS | backend 15/10 | Resolvido | `is_link_or_junction` nas duas filas (`domains/inventory_inbox.py:163`, `domains/ticket_inbox.py:135`) |
| B9 Espera de lock nas leituras | backend 15/10 | Resolvido | `READ_LOCK_TIMEOUT_SECONDS = 3.0` (`main.py:199`) |
| B10 Acoplamento e tamanho do `main.py` | backend 15/10 | **Ainda presente; piorou** | O `main.py` passou de 3.268 para 3.356 linhas. Ver N4. |
| `app.js` com mais de 3 mil linhas | front-end 07/10 | Resolvido | `static/app.js` tem 109 linhas, com 12 módulos em `static/js/features/` |
| `build:ui` fora do CI | front-end 07/10 | Resolvido | `ci.yml` (passo "Rebuild local interface assets") |
| Service locator `sys.modules` | arquitetura 08/10 | Resolvido | *Dataclasses* de serviço (`main.py:3167-3321`) |
| CI sem todos os testes JS | arquitetura 08/10 | **Regrediu** | Um teste e cinco módulos estão fora do CI. Ver N6. |
| Função de comparação extensa | arquitetura 08/10 | Ainda presente | `domains/inventory_comparison.py` tem 1.130 linhas |

---

## 3. Diagnóstico técnico por eixo

### 3.1 Arquitetura e estrutura

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | *Routers* recebem serviços tipados por *dataclass*, sem localizar o módulo principal | `main.py:3167-3321` | — |
| Ponto forte | Front-end modular, com registro de ações que detecta colisões de nome | `static/app.js:58-65` | — |
| Ponto forte | Nenhum import de `main` ou de *routers* dentro de `domains/` e `core/` | grep de imports | — |
| Risco | **N4** — O `main.py` continua sendo o centro de gravidade: 3.356 linhas, 15 rotas e funções de 165 a 325 linhas: `_load_database_unlocked` (`main.py:1535-1859`), `exportar_equipamentos` (`:2725-2958`), `save_equipment_to_excel` (`:2135-2353`) e `aplicar_alteracao_apelido` (`:2432-2597`) | Confirmado | Média |
| Débito | **N3** — A camada de domínio depende do HTTP: são 52 usos de `HTTPException` em 8 módulos de `domains/` (18 em `inventory_update.py`, 13 em `uploaded_workbooks.py` e 10 em `local_setup.py`). Os *inboxes* capturam `HTTPException` para tratar erros de domínio (`domains/inventory_inbox.py:268`, `domains/ticket_inbox.py:208`). | Confirmado | Média |
| Débito | **N10** — O *wiring* devolve dicionários `_exports` com chaves em string, que são reatribuídos como globais do `main.py` (`main.py:3163`, `:3182-3184`, `:3296-3311`) e embrulhados em `lambda` para permitir *monkeypatch*. O `main.py` também importa funções privadas de `domains` (`_comparison_source_records`, `_record_value`, `_upload_serial_value` etc.). | Confirmado | Baixa |
| Débito | **N11** — Restos no repositório: `persistence/` só tem `__pycache__` (sobra do piloto de banco removido); `Backup_Banco/` está vazio; há *locks* antigos na raiz (`.apelidos_modificados.json.lock`, `.unidades_custom.json.lock`, `..atomic-transactions.lock`, de 11/10); e `.simpress-test-*`, criado por `tests/run_tests.py:22`, não está no `.gitignore`. | Confirmado | Baixa |

### 3.2 Qualidade de código e tipagem

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | O mypy com `--check-untyped-defs` passa nos **41** módulos, inclusive nos 18 que o CI não verifica | Execução local, mypy 2.4.0 | — |
| Ponto forte | Escape de HTML consistente em todos os templates de `innerHTML` revisados | `static/js/shared/dom-utils.js:7-15` | — |
| Débito | **N12** — Tipagem incompleta: `--disallow-untyped-defs` encontra 125 erros em 24 arquivos, e 42 de 91 funções em `routers/` não anotam o retorno. O JavaScript não tem nenhuma checagem de tipos (nem JSDoc com `// @ts-check`). | Confirmado | Baixa |
| Débito | **N2** — O normalizador de rótulos do histórico está duplicado e com defeito: as duas cópias são idênticas (`domains/history_export.py:35-49` e `domains/inventory_comparison.py:152-175`). | Confirmado (ver 3.7) | Média |
| Débito | Há 30 `print()` no código da aplicação (22 no `main.py`) em vez do *logger* já configurado. A saída polui o console do servidor e a da suíte de testes. | Confirmado | Baixa |

### 3.3 Segurança

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | O middleware exige peer loopback sem proxy, `Host` exato, `Origin` e `Sec-Fetch-Site` coerentes nas rotas `/api/`, limites de corpo e admissão única de upload | `security/local_requests.py:140-300` | — |
| Ponto forte | A CSP é estrita (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), e todas as respostas recebem `nosniff`, `DENY`, COOP e CORP | `domains/frontend_assets.py:11-15`, `security/local_requests.py:24-30` | — |
| Ponto forte | O tipo de modelo enviado é validado por lista fechada | `routers/local_setup.py:55` | — |
| Ponto forte | Exceções inesperadas viram 500 genérico, e o log guarda só os quadros da pilha | `security/local_requests.py:332-346` | — |
| Ponto forte | Mensagens de `FileTransactionError` repassadas ao usuário são montadas pelo próprio código (nome do arquivo e `strerror`), sem conteúdo de células | grep de `raise FileTransactionError(f"…{error}")`: um único caso, em `core/integrity.py:372` | — |
| Risco | B7 (ainda presente) — nome, e-mail e telefone de contato estão versionados como valores padrão | `core/config.py:72-76` | Baixa |
| Risco | **N1 (privacidade)** — cópias completas do histórico de comparações ficam em temporários órfãos dentro de `data/state/` (ver 3.6) | Confirmado | Média |

### 3.4 Tratamento de erros e observabilidade

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | O mapeamento de erros é consistente: `FileBusyError` → 409, `WorkbookSafetyError` → 409/400, `FileTransactionError` → 500 com mensagem montada pelo código | `main.py:2091-2096`, `routers/units.py:195-200` | — |
| Ponto forte | O `RedactingFormatter` remove as mensagens de exceção do log | `core/logging_setup.py` | — |
| Débito | **N8** — No front-end, `new Error(data.detail)` recebe a lista estruturada de um 422 do Pydantic e mostra "[object Object]". O padrão "`res.json().catch`, depois `throw new Error(detail)`" se repete em cerca de 44 chamadas de `fetch` sem *helper* comum. Só `inventory-upload.js:204-209` e `history-annotation-autosave.js:12` tratam a lista. Exemplo: `static/js/features/units-catalog.js:201-203`. | Confirmado por leitura | Baixa |
| Débito | `_cleanup_staged_files` engole `OSError` em silêncio, sem log, ao remover um *stage* | `core/integrity.py:393-399` | Baixa |

### 3.5 Comunicação e estado

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | O estado compartilhado do cliente é explícito e mínimo (`appState`), com contador de revisão contra gravação atrasada | `static/app.js:29-41` | — |
| Ponto forte | Idempotência do upload por `Idempotency-Key` com recibo durável; o token de prévia é assinado por HMAC e preso aos hashes | `security/local_requests.py:242-280`, `main.py:656-693` | — |
| Ponto forte | Buscas canceláveis com `AbortController` | `static/js/features/equipment-search.js:138`, `dashboard.js:93` | — |
| Débito | **N9** — O contrato documentado está desatualizado. `CONTRATOS_API_BACKEND.md` informa limites de 30 e 32 MiB, mas o código aceita 60 MB (`core/config.py:35`, `routers/operations.py:52`). Também faltam no documento `GET /api/painel` e `GET`/`POST /api/historico-transferencias`. | Confirmado | Baixa |
| Débito | O painel lê o histórico de comparações duas vezes por requisição (lista e evento detalhado), cerca de 0,5 MB de JSON cada | `main.py:3218-3230` | Baixa |

### 3.6 Persistência e concorrência

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | Transações com diário, hash por arquivo, *rollback* que não sobrescreve alteração externa, hierarquia de locks documentada e recuperação na subida | `core/integrity.py`, `docs/arquitetura/auditoria_backend/hierarquia_de_locks.md` | — |
| Ponto forte | Retenção de 60 dias e limpeza executada fora do *event loop* | `core/config.py:40`, `main.py:1349` | — |
| Risco | **N1** — Temporários órfãos se acumulam sem limite. Há **21** arquivos `.historico_comparacoes.json.*.tmp` (cerca de 12 MB, de 14/10 a 17/10, quatro deles criados hoje) ao lado de um arquivo ativo de 494 KB. O `cleanup_local_temps.py --apply`, que roda em toda subida, só remove temporários **idênticos** ao destino e preserva para sempre os diferentes (`scripts/cleanup_local_temps.py:134-137`). A causa da geração não foi isolada. As hipóteses são uma interrupção entre o *stage* e o *commit*, ou um `unlink` sem *backoff* engolido em `core/integrity.py:395-399` (OneDrive ou antivírus segurando o arquivo). | Confirmado (sintoma), causa suspeita | Média |
| Risco | **N7** — O parse pode passar de 2 minutos e de cerca de 900 MB perto do novo teto (512 MB descompactados e 10 M de células). A admissão de parse é única (`MAX_CONCURRENT_WORKBOOK_PARSERS = 1`). | Confirmado (documentado no `README.md:275`) | Média (Baixa no volume atual, de cerca de 1,4 mil linhas) |

### 3.7 Conformidade com o `AGENTS.md`

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | Anotações: limite de 2.000 no servidor e no cliente, ID por linha e evento, herança só de linha idêntica, migração de anotações legadas e inclusão na exportação, com testes dedicados | `domains/history_annotations.py:20`, `routers/inventory_history.py:37`, `domains/inventory_update.py:783-798`, `tests/test_annotation_revisions.py` | — |
| Ponto forte | A tela aplica as variantes de rótulo por seção: "no Endpoint" nos motivos de conferência e "Endpoint" sem preposição nas ausências e ambiguidades | `static/js/features/comparison-result.js:32-38`, `:198` | — |
| Risco | **N2** — O normalizador produz texto errado com preposição. Resultados da execução com strings sintéticas: "Equipamento da Simpress" vira "Equipamento da na Simpress"; "Dados do Endpoint" vira "Dados do no endpoint"; "pela Simpress" vira "pela na Simpress"; "Planilha Simpress EquipamentosDetalhes_atual.xlsx" vira "Planilha na Simpress na Simpress_atual.xlsx". As regex `\b(?:na\s+)?Simpress\b` e `(?:no\s+)?Endpoint` não consideram outras preposições. | Confirmado por execução | Média |
| Risco | **N5** — A exportação para Excel não aplica as variantes por seção que a tela aplica. Uma execução sintética de `build_history_export_workbook` gerou o motivo de "Para conferência" como "Série duplicada no **endpoint**", e a tela mostra "no **Endpoint**". Pela leitura do código, "Ausente em" e "Fontes" das Ambiguidades saem como "no endpoint" em vez de "Endpoint" (`domains/history_export.py:401-412`, `:432-441`). A tabela de conferência exportada usa o cabeçalho "Hostname/Apelido" em vez de "Hostname no Endpoint" (`:492`). | Confirmado (motivo); por leitura (demais) | Média |

### 3.8 Testes e CI

| Tipo | Item | Evidência | Sev. |
| --- | --- | --- | --- |
| Ponto forte | A suíte Python é isolada (bloqueia leitura de dados reais) e passa com **410 testes, OK, em 74 s** | `tests/run_tests.py`, execução de hoje | — |
| Ponto forte | O front-end passa com **173 testes e 173 aprovados** (`node --test tests/frontend/*.cjs`, Node 26.10) | Execução de hoje | — |
| Ponto forte | O CI cobre 3.12 e 3.14, `npm audit`, varredura de segredos, *build* da interface, e2e em desktop e mobile, e axe | `.github/workflows/*.yml` | — |
| Risco | **N6** — O CI usa listas fixas que ficam desatualizadas sem aviso. `test_recent_equipment.cjs` não roda. Cinco módulos ficam sem `node --check`: `shared/recent-equipment.js`, `shared/theme-preference.js`, `ui/data-panels.js`, `ui/transfer-history.js` e `ui/ux-enhancements.js`. O mypy cobre só 23 de 41 módulos, e o `compileall` deixa de fora `core/async_workers.py` e `core/local_paths.py`. | Confirmado | Média |
| Lacuna | Não há teste para o normalizador de rótulos com preposições (N2) nem para paridade de rótulos entre a tela e a exportação (N5) | grep em `tests/` | — |
| Não verificado | Os e2e com Playwright não foram executados nesta auditoria (exigem baixar o Chromium). O `npm audit` também não foi executado (exige rede). | — | — |

---

## 4. Top 10 riscos (severidade × probabilidade)

| # | Achado | Sev. | Prob. | Por quê |
| --- | --- | --- | --- | --- |
| 1 | N1 Temporários órfãos do histórico se acumulam e contêm dados | Média | Alta (já ocorre) | Quatro surgiram hoje; o disco cresce; são cópias de dados sincronizáveis |
| 2 | N5 Exportação do histórico fora da regra de rótulos do `AGENTS.md` | Média | Alta | Toda exportação com linhas de conferência, ausência ou ambiguidade |
| 3 | N2 Normalizador gera "da na Simpress" e "do no endpoint" | Média | Média | Depende de textos legados com outras preposições; está duplicado em dois lugares |
| 4 | N6 Listas fixas do CI deixam arquivos novos fora | Média | Média | Já aconteceu com um teste e cinco módulos |
| 5 | N4 `main.py` monolítico e crescendo | Média | Alta | Toda mudança de apelido, exportação ou carga passa por ele |
| 6 | N3 Domínio acoplado ao `HTTPException` | Média | Média | Scripts e *inboxes* tratam erro HTTP fora do HTTP |
| 7 | N7 Parse de até 900 MB e 2 min no teto atual | Média | Baixa | Inventário atual pequeno; o risco cresce com a base |
| 8 | N8 Erro 422 aparece como "[object Object]" | Baixa | Média | Qualquer validação de schema não antecipada pelo formulário |
| 9 | B7 Contatos pessoais versionados | Baixa | Alta | Estão no histórico do Git |
| 10 | N9 Contrato da API desatualizado | Baixa | Alta | Limites e rotas divergentes do código |

---

## 5. Plano de ação

Esforço: P (até meio dia), M (1 a 2 dias), G (3 dias ou mais).

### Fase 1 — Imediato

| # | Ação | Arquivos | Esf. | Critério de aceite | Dep. |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Investigar a origem dos `.historico_comparacoes.json.*.tmp`: registrar em log (sem conteúdo) cada `OSError` engolido em `_cleanup_staged_files` e usar `_unlink_with_backoff`. Na limpeza, mover os diferentes com mais de 7 dias para uma quarentena com relatório, em vez de preservá-los no lugar para sempre. | `core/integrity.py:386-399`, `scripts/cleanup_local_temps.py` | M | Teste que simula `PermissionError` no `unlink` e confere a remoção ou o log; contagem de temporários estável depois de 10 atualizações | — |
| 1.2 | Corrigir o normalizador: tratar todas as preposições antes de "Simpress" e "Endpoint", manter uma única implementação (em `inventory_comparison.py`) e reutilizá-la em `history_export.py` | `domains/inventory_comparison.py:152-175`, `domains/history_export.py:35-49` | P | Teste parametrizado com "da/do/pela/pelo/de" + Simpress/Endpoint, registros legados com InvAll/EquipamentosDetalhes e nomes de arquivo; valores brutos inalterados | — |
| 1.3 | Levar para a exportação as variantes por seção que a tela já aplica: "no Endpoint" nos motivos de conferência, "Endpoint" em ausências e ambiguidades, e o cabeçalho "Hostname no Endpoint" na conferência | `domains/history_export.py:368-441`, `:489-528` | P | Teste de paridade entre o rótulo da tela (`comparison-result.js:32-38`) e a célula exportada para cada seção | 1.2 |
| 1.4 | Trocar as listas fixas do CI por varredura: `node --test tests/frontend/`, um laço de `node --check` sobre `static/js/**/*.js`, mypy em `core domains routers security main.py` (já passa) e `compileall` em `core` | `.github/workflows/ci.yml` | P | CI verde, com `test_recent_equipment.cjs` e os cinco módulos incluídos | — |

### Fase 2 — Estrutural

| # | Ação | Arquivos | Esf. | Critério de aceite | Dep. |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Criar erros de domínio (`DomainValidationError`, `DomainConflictError`, `DomainBusyError` com código e mensagem) e convertê-los em HTTP em um único `exception_handler` | `domains/*.py` (52 usos), `main.py` | M | `grep HTTPException domains/` vazio; mensagens e códigos HTTP idênticos nos testes existentes | — |
| 2.2 | Continuar a extração do `main.py`: carga da base (`_load_database_unlocked`) para `domains/inventory_state.py`, exportação para `domains/equipment_export.py` e apelidos para `domains/alias_changes.py` e um *router* próprio | `main.py:1535-1859`, `:2135-2958` | G | `main.py` com menos de 1.500 linhas; rotas, DTOs e os 410 testes preservados | 2.1 |
| 2.3 | Substituir os dicionários `_exports` por objetos tipados (*dataclass* ou `Protocol`) e parar de importar funções `_privadas` entre módulos | `main.py:3163-3321`, `routers/*.py` | M | mypy aprovado; nenhum `_exports["…"]` restante | 2.2 |
| 2.4 | Criar um *helper* `apiFetch` no front-end (parse do JSON, `detail` como texto ou lista, `AbortSignal`) e migrar as cerca de 44 chamadas | `static/js/shared/`, `static/js/features/*.js` | M | Um 422 com lista mostra o texto das mensagens; testes `.cjs` cobrindo texto, lista e corpo vazio | — |
| 2.5 | Parse em passada única, materializando só a aba e as colunas usadas (M3), ou recuar os limites de `core/config.py` para o nível medido | `domains/uploaded_workbooks.py`, `core/config.py:42-47` | G | Planilha sintética de 70 mil × 50 em menos de 30 s e abaixo de 300 MB (teste lento opcional) | — |
| 2.6 | Guardar em cache o histórico de comparações lido pelo painel, por assinatura (tamanho e `mtime_ns`), como já é feito com as anotações | `main.py:3218-3230` | P | Uma leitura do disco por mudança do arquivo | — |

### Fase 3 — Boas práticas

| # | Ação | Arquivos | Esf. | Critério de aceite | Dep. |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Ativar `--disallow-untyped-defs` por pacote, começando por `core` e `security` | `.github/workflows/ci.yml`, `routers/*.py` | M | Os 125 erros zerados de forma gradual | 1.4 |
| 3.2 | Adicionar JSDoc com `// @ts-check` (sem *bundler*) nos módulos `shared/` e checar no CI com `tsc --noEmit --allowJs` | `static/js/shared/*.js`, `package.json` | M | CI aprovado | 1.4 |
| 3.3 | Trocar os `print()` por `logger` | `main.py` e mais 5 arquivos | P | Nenhum `print(` fora de `if __name__ == "__main__"` | — |
| 3.4 | Atualizar `CONTRATOS_API_BACKEND.md` (limites de 60 MB, `/api/painel`, `/api/historico-transferencias`) e gerar a tabela a partir das rotas registradas, com teste que falha quando divergir | `docs/arquitetura/CONTRATOS_API_BACKEND.md`, `tests/` | P | Teste de contrato aprovado | — |
| 3.5 | Limpar os restos (`persistence/`, `Backup_Banco/`, *locks* da raiz) e adicionar `.simpress-test-*/` ao `.gitignore` | raiz, `.gitignore` | P | `test_project_layout.py` cobrindo a ausência desses restos | — |
| 3.6 | Decidir sobre B7: tirar os contatos padrão do código para um arquivo local ignorado (com exemplo versionado) | `core/config.py:72-76` | P | Nenhum dado pessoal em `git grep`, ressalvado o histórico antigo | Decisão do responsável |
| 3.7 | Rodar os e2e do Playwright antes de cada *release* local, e não só quando `static/**` muda, porque mudanças de back-end também alteram a tela | `.github/workflows/ui-browser.yml` | P | O job roda também em mudanças de `domains/` e `routers/` | — |

---

## 6. Verificações executadas

| Comando | Resultado |
| --- | --- |
| `.venv/Scripts/python.exe -B tests/run_tests.py` | **Ran 410 tests in 74.013s — OK** |
| `node --test tests/frontend/*.cjs` (Node 26.10.0) | **173 testes, 173 aprovados, 0 falhas** |
| `python -m mypy --check-untyped-defs core domains routers security main.py` | **Success: no issues found in 41 source files** |
| idem, com `--disallow-untyped-defs` | 125 erros em 24 arquivos (meta da Fase 3) |
| Normalizador e exportação com strings e evento sintéticos | Defeitos N2 e N5 reproduzidos |
| `git status` antes e depois | Só este relatório foi adicionado |

**Não verificado:** e2e Playwright, `npm audit` e `npm run build:ui` (exigem rede ou reescrevem ativos versionados); comportamento sob OneDrive real; causa raiz dos temporários órfãos (N1).
