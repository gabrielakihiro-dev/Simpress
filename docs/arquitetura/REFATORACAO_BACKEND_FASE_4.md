# Fase 4 — Revisão de falhas do back-end

**Data:** 12/10/2026.
**Base revisada:** `8f3e1c65b8536029edecce2783e37eea9dc3b9ec`, já publicada em `origin/main`.
**Branch:** `codex/backend-fase4-20261012`.
**Commit das correções e regressões:** `8e15245b844b7225ef37e4eadb5786484ab23709`.
**Main incorporado antes da publicação final:** `5ae79b2e098db0a4b055f9968960114ccfa77705`.

## Resultado da revisão

Os cinco runs de CI das Fases 2 e 3 consultados terminaram com sucesso em todos os jobs esperados. A revisão adicional identificou uma falha preexistente no tratamento de compressão LZMA, que não era coberta pela regressão de DEFLATE da Fase 2. Essa causa foi reproduzida antes e depois da Fase 2 e corrigida nesta fase.

Foram acrescentados oito testes, além da ampliação de uma regressão existente. Os novos cenários confirmam o comportamento dos consumidores do helper assíncrono, a conclusão de commit/rollback antes da liberação de recursos, a preservação de arquivos/histórico/cache após entradas inválidas e a leitura de identificadores textuais com zeros iniciais.

**CI das correções:** aprovada, com 3/3 jobs — [run 38284932160](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38284932160), vinculado ao SHA acima. O checkpoint final de publicação do relatório deve ser conferido no SHA efetivamente enviado antes de encerrar a fase.

## Integração do avanço de main

Durante a revisão, main recebeu `3fb21ed` (prontidão/snapshots de chamados) e `5ae79b2` (relatório dessa revisão de código). Ambos foram preservados pela integração no worktree da Fase 4, sem conflitos. O [relatório recebido de main](../desenvolvimento/revisao-codigo-2026-10-12.md) descreve essas mudanças e a CI do commit de correção.

A validação foi repetida sobre o conjunto integrado: 362 testes Python, 134 JavaScript e 49 Playwright passaram. Os seis cenários Playwright adicionais vieram dos três testes desktop/mobile recebidos de main. Sintaxe e build foram conferidos novamente. O diff da Fase 4 sobre esse main permaneceu limitado aos seis arquivos de código, testes e documentação desta tarefa.

## Arquitetura e contratos examinados

A aplicação usa FastAPI local, rotas de modelos em `routers/local_setup.py`, domínio de inventário em `domains/inventory_update.py`, validação de pacotes em `core/xlsx_safety.py` e transações recuperáveis em `core/integrity.py`. O piloto PostgreSQL continua opt-in; seus consumidores de workers foram exercitados com simuladores.

Foram revisados `await_worker_completion`, os quatro consumidores alterados na Fase 2, a leitura protegida do snapshot da prévia e a normalização de erros de ZIP/XLSX. Os contratos HTTP exercitados incluem `POST /api/planilhas/previsualizar`, `POST /api/planilhas/atualizar` e a importação local de modelos. O [mapa de contratos](CONTRATOS_API_BACKEND.md) e o [diagnóstico da Fase 1](REFATORACAO_BACKEND_FASE_1.md) continuam sendo as referências de escopo.

## Evidência de CI das Fases 2 e 3

Em cada run abaixo, `verify (3.12)`, `verify (3.14)` e `ui-browser` foram consultados e estavam `completed / success`, na primeira tentativa.

| Fase e publicação | SHA | Run | Resultado |
| --- | --- | --- | --- |
| 2 — Push das correções | `e62f75c8bf217789f19ca56ac30d3649a17edcc2` | [38277899024](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38277899024) | 3/3 jobs aprovados |
| 2 — Pull request | `e62f75c8bf217789f19ca56ac30d3649a17edcc2` | [38278690700](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38278690700) | 3/3 jobs aprovados |
| 2 — Merge em main | `81520a45d59d2f3f257fe0ba4440ee8ae5a8523a` | [38279041073](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38279041073) | 3/3 jobs aprovados |
| 3 — Push do relatório | `8f3e1c65b8536029edecce2783e37eea9dc3b9ec` | [38280504095](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38280504095) | 3/3 jobs aprovados |
| 3 — Push em main | `8f3e1c65b8536029edecce2783e37eea9dc3b9ec` | [38281083987](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38281083987) | 3/3 jobs aprovados |

Nenhuma falha de CI foi encontrada nesses cinco runs. A aprovação anterior serviu como linha de base; a correção desta fase tem seu próprio checkpoint de CI.

## Ocorrências e classificação

| Ocorrência | Prioridade e classificação | Evidência e causa | Correção ou decisão |
| --- | --- | --- | --- |
| LZMA corrompido escapa como exceção inesperada | P2 — falha preexistente e teste insuficiente | ZIP/XLSX LZMA válidos eram aceitos; ao invalidar as propriedades de um membro, surgia `LZMAError`. O ZIP externo gerava HTTP 500 na prévia e na atualização. Reproduzido em memória no pai de `e62f75c` e em `8f3e1c6`. Os handlers cobriam erros de ZIP/DEFLATE, mas não essa exceção específica. | Capturar `lzma.LZMAError` nos mesmos pontos de normalização, mantendo os tipos e mensagens de arquivo inválido. Regressões e CI vinculadas ao commit desta fase. |
| Consumidores de workers sem regressão própria de cancelamento repetido | P2 — teste insuficiente; nenhuma regressão funcional reproduzida | A suíte anterior cobria o helper e inventário, mas não exercitava diretamente os recursos do importador de modelos e do consumidor do piloto após vários cancelamentos. | Acrescentar cenários determinísticos com eventos, commit/rollback de arquivos sintéticos, semáforo, uploads e propagação do contexto de idempotência. Os seis testes do novo módulo passaram. |
| Aviso `allowScripts` de `@parcel/watcher@2.6.0` | P3 — divergência de ambiente, sem falha funcional reproduzida | O npm local advertiu sobre o script opcional de instalação. `npm ci`, auditoria, build e os 49 testes de navegador finais passaram. A política local permaneceu como estava. | Registrar o aviso; nenhuma alteração em dependências, política de scripts ou CI. |
| Aviso de depreciação de `httpx` no TestClient | P3 — aviso de dependência/ambiente | O runtime local emitiu `StarletteDeprecationWarning`; os testes HTTP concluíram com sucesso. | Registrar para manutenção futura das dependências, fora desta correção de back-end. |
| Execução assíncrona parada no sandbox Windows | P3 — limitação do ambiente de teste | A rodada restrita parou ao iniciar um teste assíncrono; a mesma regressão concluiu em cerca de um segundo fora do sandbox. Os testes seguintes foram executados na cópia isolada com a permissão necessária. | Ajustar somente a execução local. Nenhuma mudança na aplicação ou na workflow. |
| Falhas do executor/cópia temporários desta revisão | P3 — falha do ambiente de validação preparado nesta tarefa | Faltava o guard `__main__` no executor focado, fazendo o spawn do Windows reexecutar a suíte. A primeira cópia também omitiu BAT/SQL e alvos de links; o modelo sintético não continha o texto de instruções esperado. | Corrigir apenas o executor e as fixtures temporárias. A rodada focada final passou 144 testes; os três testes afetados da cópia passaram antes da repetição completa, que passou 362 testes. |

### Reprodução e regressão de LZMA

1. Gerar em memória uma planilha pequena com dados fictícios e reempacotá-la com `zipfile.ZIP_LZMA`. Confirmar a aceitação do pacote válido.
2. Localizar um membro pelo cabeçalho local do ZIP e substituir a primeira propriedade de filtro LZMA por `0xFF`, sem mudar tamanho, nome ou CRC declarado.
3. Repetir em `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml`, `docProps/core.xml` e no XLSX de um ZIP externo.
4. Antes da correção, a rodada de nove testes selecionados produziu cinco erros de `LZMAError` e duas falhas HTTP 500 versus 400. Os consumidores de workers e os controles válidos já passavam.
5. Após a correção, os pacotes inválidos produzem os erros de validação existentes. As duas rotas de inventário retornam HTTP 400; arquivos ativos, histórico, aliases e caches da fixture permanecem iguais.

A regressão ampliada também cobre corrupção de DEFLATE e BZIP2. Os controles positivos cobrem ZIP sem compressão, DEFLATE, BZIP2 e LZMA, incluindo `000123` como texto, Unicode e o tamanho permitido exato do XLSX descompactado.

## Alterações versionadas

- [core/xlsx_safety.py](../../core/xlsx_safety.py): normalização específica de LZMA em metadados, XML auxiliar, abas e validação externa do pacote.
- [domains/local_setup.py](../../domains/local_setup.py): erro de descompressão LZMA do ZIP Simpress convertido para HTTP 400 com a mensagem existente.
- [tests/test_first_access.py](../../tests/test_first_access.py): regressão de corrupção ampliada e dois testes novos de compatibilidade e preservação via HTTP.
- [tests/test_async_worker_consumers.py](../../tests/test_async_worker_consumers.py): seis testes novos de conclusão/cancelamento e consumidores de modelos/piloto.
- Este relatório e [roteiro operacional](../PROMPT_REFATORACAO_BACKEND_SIMPRESS.md): evidências da revisão e linha da Fase 4 na tabela de checkpoints.

As correções usam a biblioteca padrão. Métodos, caminhos, campos, limites, validações de arquivos válidos e mensagens existentes foram preservados. As transações continuam concluindo ou revertendo antes da liberação dos recursos testados. As regras de rótulos, IDs e anotações do Histórico de Planilhas continuam cobertas pela suíte existente.

## Verificações locais finais

| Verificação | Resultado |
| --- | --- |
| Suíte focada: workers, consumidores, primeiro acesso, integridade, transações e simuladores de persistência | 144 testes aprovados em 25,3 s |
| `python -B tests/run_tests.py` | 362 testes aprovados em 51,7 s após integrar main; oito testes novos em relação à Fase 3 |
| `node --test` nos dez arquivos da workflow | 134 testes aprovados |
| `npm run test:ui:e2e` | 49 cenários aprovados após integrar main, em desktop, mobile e perfil de animação; a rodada anterior tinha 43 |
| `node --check` nos alvos da workflow e no spec de primeiro acesso recebido de main | 19 arquivos aprovados |
| `python -m compileall -q core main.py domains routers persistence security scripts tests` | Aprovado |
| `mypy` com os parâmetros e alvos da workflow | Sem problemas em 40 arquivos |
| `scripts/check_secrets.py` | Nenhum padrão conhecido no código copiado dos arquivos rastreados, incluindo os arquivos preparados para o commit |
| `npm ci` e `npm audit --audit-level=moderate` | Instalação concluída; zero vulnerabilidades reportadas |
| `npm run build:ui` | Aprovado; os 31 arquivos estáticos comparados ficaram idênticos à base do worktree |
| `git diff --check` e `git diff --cached --check` | Aprovados antes do commit das correções |

Os 144 testes focados são um subconjunto da suíte Python; não representam 144 testes adicionais aos 362. As rodadas iniciais que falharam para demonstrar a regressão ou ajustar o ambiente não contam como validação aprovada.

## Isolamento e limites

A validação local usou Python 3.12.14 e Node 26.10.0. A workflow confirma Python 3.12/3.14 e Node 24 em Windows. As verificações da matriz remota são vinculadas ao SHA das correções.

A cópia de validação continha código e arquivos auxiliares versionados selecionados, sem planilhas, históricos, backups, catálogos ou estado operacionais. O modelo de transferência foi gerado com dados sintéticos. Os alvos `.env.*.example` usados apenas pelo teste de existência de links receberam placeholders sem configurações; arquivos `.env` reais e seu conteúdo não foram copiados ou lidos.

As inboxes e a pasta de anotações apontaram para a fixture local. A descoberta bloqueou a leitura de workbooks e a recuperação transacional. O teste HTTP novo não iniciou lifespan. Os demais testes utilizaram os executores/fixtures do projeto na cópia isolada. Scripts BAT e SQL foram copiados para inspeção/links, sem inicialização operacional ou execução de migrações.

O modelo oficial de transferência não foi validado localmente nesta revisão; esse ponto foi exercitado com a fixture sintética. Os testes do piloto usaram simuladores, sem conexão real a PostgreSQL/Supabase ou armazenamento remoto. Não houve benchmark operacional nem teste de carga; esta correção trata confiabilidade da validação, sem alegar ganho de desempenho.

## Checkpoints por fase

| Fase | Arquivos e mudanças | Verificação local registrada | Branch e SHA de referência | Push | CI do SHA |
| --- | --- | --- | --- | --- | --- |
| 1 — Análise | Diagnóstico, mapa de contratos e roteiro | Relatório da Fase 1: 347 Python, 131 JavaScript, 43 Playwright e verificações complementares | `codex/backend-fase1-20261012`, `808712c` | Confirmado pela execução do evento push | [38274299372](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38274299372), 3/3 jobs aprovados |
| 2 — Refatoração | Workers, descompressão DEFLATE e snapshot da prévia, com regressões | Revalidada na Fase 3 sobre o merge `81520a4`: 354 Python, 134 JavaScript e 43 Playwright | `codex/backend-fase1-20261012`, `e62f75c`; merge em main `81520a4` | Branch e main confirmados | [38277899024](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38277899024) e [38279041073](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38279041073), 3/3 em cada run |
| 3 — Verificação | [Relatório ampliado](REFATORACAO_BACKEND_FASE_3.md) | 354 Python, 134 JavaScript, 43 Playwright e checks da workflow | `codex/backend-fase3-20261012`, `8f3e1c6`, publicado em main | Confirmado | [38280504095](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38280504095) e [38281083987](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38281083987), 3/3 em cada run |
| 4 — Revisão de falhas | LZMA e cobertura dos consumidores; relatório e checklist; integração do main vigente | 144 focados; 362 Python, 134 JavaScript, 49 Playwright e checks complementares | `codex/backend-fase4-20261012`, correções `8e15245`; main `5ae79b2` incorporado; relatório em commit subsequente | Correções publicadas; SHA final conferido na entrega | [38284932160](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38284932160), 3/3 jobs aprovados no checkpoint das correções; CI do conjunto integrado conferida na entrega |

O relatório é publicado após a verificação da CI das correções. O último push deve ter sua própria CI acompanhada; uma execução do commit anterior não substitui essa verificação.

## Débitos e decisões futuras

- **P2 — Integração real do piloto:** depende de infraestrutura de teste explicitamente autorizada. Os simuladores confirmam os caminhos exercitados, sem comprovar banco/storage reais.
- **P3 — Dependências e ambiente:** acompanhar os avisos de TestClient e `allowScripts` em manutenção própria, preservando a matriz e as auditorias atuais.
- **P3 — Arquitetura e documentação de respostas:** os débitos de composição em `main.py` e respostas sem `response_model`, registrados na Fase 1, continuam fora desta correção delimitada.

Nenhuma regressão adicional das alterações de workers ou do snapshot foi reproduzida pelos cenários examinados. Essa conclusão está limitada à revisão, às cargas sintéticas e aos jobs identificados neste relatório.
