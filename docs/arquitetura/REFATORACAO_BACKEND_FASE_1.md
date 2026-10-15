# Diagnóstico do back-end Simpress — Fase 1

**Data da inspeção:** 12/10/2026

**Checkout de referência:** branch codex/reorganizacao-frontend-20261012, commit 6da3aea811cb513321a5579a8b71a66f1460720f

**Escopo desta fase:** inspeção e documentação. Nenhum arquivo de aplicação, teste ou dado operacional foi alterado.

## Resultado

O projeto é uma aplicação local FastAPI com interface JavaScript/CSS servida pelo próprio processo. main.py ainda concentra a composição e várias operações da aplicação, mas o código já tem rotas em routers/, lógica em domains/, transações e validação XLSX em core/, e um piloto opt-in em persistence/. O modo padrão usa arquivos locais. O piloto PostgreSQL usa explicitamente um PostgreSQL local e armazenamento privado de objetos; não há fallback automático para arquivos.

Foram mapeadas as 54 operações HTTP do OpenAPI — 53 rotas da API e a página / —, autenticação e barreira de funcionalidades do piloto, principais formatos de entrada/saída, limites e consumidores da interface. Como muitas respostas não têm response_model, o OpenAPI não descreve seus campos; o mapa complementar em CONTRATOS_API_BACKEND.md registra os contratos encontrados nos handlers e serviços. Mensagens exatas são indicadas onde o código as define de modo estável; mensagens de validação do Pydantic e detalhes variáveis não são tratados como strings imutáveis.

## Arquitetura e fluxos confirmados

| Área | Responsabilidade observada | Pontos de entrada |
| --- | --- | --- |
| Composição e ciclo de vida | Cria a aplicação, injeta serviços, registra rotas, middleware e política de inicialização. A inicialização do modo de arquivos recupera transações pendentes, tenta migrar anotações legadas, inicia trabalhadores de importação/sincronização e aplica retenção. Importar main para a suíte não inicia esse ciclo de vida. | [main.py](../../main.py), lifespan (aprox. linha 1683), configuração e rotas (linhas 3900–4080) |
| Configuração e estado local | Determina pastas de entrada/saída, retenção e limites: 30 MiB por arquivo, 61 MiB para dois uploads de inventário com margem, 33 MiB para dois arquivos de chamados e 1 MiB para demais escritas HTTP. Há um XLSX de inventário ativo e modelos locais. | [core/config.py](../../core/config.py), prontidão em main.py (linhas 600–825) |
| HTTP | Adaptadores FastAPI separados para sistema, pesquisa, unidades, transferência, histórico, operações e importação de modelos. Algumas rotas e o middleware permanecem em main.py. | [routers/](../../routers/), [main.py](../../main.py) |
| Inventário | Recebe Endpoint XLSX e Simpress XLSX ou ZIP; valida arquivos e limites, compara fontes, constrói resposta/histórico e prepara atualizações de alias/anotações. O commit grava XLSX, histórico e recibos de idempotência em uma transação recuperável; depois publica os caches derivados. A prévia usa token ligado aos uploads e ao estado atual. | [domains/inventory_update.py](../../domains/inventory_update.py), [domains/inventory_comparison.py](../../domains/inventory_comparison.py) |
| XLSX e integridade | Pré-valida pacote ZIP, XML e estruturas da planilha; limita conteúdo descompactado, entradas e dimensões; controla acesso aos arquivos; implementa journal, backup, rollback, hash e recuperação. A gravação valida as células editáveis. | [core/xlsx_safety.py](../../core/xlsx_safety.py), [core/integrity.py](../../core/integrity.py), [core/openpyxl_compat.py](../../core/openpyxl_compat.py) |
| Histórico e anotações | Mantém resultados de comparação, exportações, restaurações verificadas contra backup/estado corrente, aliases e chamados. Anotações são identificadas por evento/linha e revisões; sincronização usa outbox local. A cópia entre atualizações compara conteúdo da linha sem anotacao/anotacao_id e cria revisão independente. | [routers/inventory_history.py](../../routers/inventory_history.py), [routers/operations.py](../../routers/operations.py), [domains/history_annotations.py](../../domains/history_annotations.py), [domains/history_export.py](../../domains/history_export.py) |
| Chamados | Importa dois arquivos para conciliação Simpress/Oracle, cria snapshot transacional e recibo local; produz relatórios, evolução, linha do tempo e exportação anotada. | [domains/ticket_reconciliation.py](../../domains/ticket_reconciliation.py), [domains/ticket_inbox.py](../../domains/ticket_inbox.py), [routers/operations.py](../../routers/operations.py) |
| PostgreSQL local piloto | Usa PostgreSQL somente com opt-in local, pool limitado, operações parametrizadas, transações/revisões e uma barreira explícita de rotas. Arquivos passam por uma saga recuperável para storage privado, com hash e verificação. Rota fora da barreira responde 501 ainda que tenha handler em modo de arquivos. Prévia de inventário e importação de modelos não estão habilitadas nesse modo. | `persistence/` (removido com o piloto), `persistence/boundary.py` (removido com o piloto), `security/config.py` (removido com o piloto) |
| Segurança | Autenticação é desativada no padrão local. Ativada, exige PostgreSQL local, sessão BFF, cookie opaco, CSRF e mesma origem. Middleware restringe rede/Host local, recusa cabeçalhos de proxy encaminhado, limita corpos e normaliza erros internos. A configuração recusa execução hospedada. | [security/](../../security/), [main.py](../../main.py) |
| Interface e testes | static/app.js consome os endpoints; scripts compartilhados cuidam de sessão, utilidades, autosave e interações. Playwright usa servidor de prévia com respostas sintéticas, sem inicializar aplicação ou dados. | [static/app.js](../../static/app.js), [static/js/](../../static/js/), [tests/](../../tests/), [tests/support/serve_ui_motion_preview.py](../../tests/support/serve_ui_motion_preview.py) |

As instruções do projeto para rótulos e anotações do Histórico de Planilhas foram consideradas. Valores brutos, nomes de origem para auditoria/restauração, IDs estáveis, limite de 2.000 caracteres e comportamento de sincronização são requisitos de compatibilidade.

## Achados priorizados

### 1. Cancelamentos repetidos podem liberar o limite antes de a thread terminar — P1

Em domains/inventory_update.read_uploaded_xlsx (linhas 344–396), o parser usa asyncio.to_thread e aguarda shield. Um cancelamento leva a uma segunda espera protegida; outro cancelamento nessa espera escapa do except Exception, enquanto o finally libera o semáforo de admissão. A thread nativa continua executando.

Reprodução determinística, com asyncio.Event, threading.Event, validador falso e sem arquivos: iniciou o parser, cancelei a coroutine, enviei outro cancelamento durante a espera e confirmei parser_finished=False enquanto admission_available=True. Isso viola o limite que impede parsers XLSX concorrentes; não prova corrupção de transação ou falha de rollback. O mesmo formato de espera merece revisão em routers/local_setup.py (worker de modelo), domains/inventory_update.py (commit) e persistence/routes.py (worker piloto); nesses pontos a evidência desta fase é inspeção estática.

**Proposta:** manter a thread e a vaga do semáforo sob acompanhamento mesmo com vários cancelamentos, liberando recursos só após a thread concluir e preservando a propagação do cancelamento. Adicionar teste determinístico com dois ou mais cancelamentos, encerramento normal/excepcional, falha do parser e vaga liberada somente após a thread. Não alterar a resposta HTTP.

### 2. Corrupção durante descompressão escapa aos erros de arquivo inválido — P2

domains/local_setup.unpack_simpress_zip (linhas 26–60) converte erros conhecidos do ZIP, mas não captura zlib.error. core/xlsx_safety.py (linhas 79–110 e 250–365) também não normaliza uma falha do descompressor para WorkbookSafetyError.

Reprodução em memória: criei ZIP/XLSX com entrada deflate sintética e alterei o campo do bloco de compressão para inválido, sem extrair conteúdo. A abertura do ZIP Simpress e a leitura de XML interno propagaram zlib.error; a falha não se tornou o HTTP 400 de arquivo inválido esperado. No request atual, pode chegar ao tratamento genérico 500. Nenhum workbook operacional foi lido.

**Proposta:** converter somente as exceções esperadas do descompressor para os tipos de erro de entrada existentes, preservando mensagens/códigos para tamanho, extensão, caminho, senha e layout. Cobrir ZIP externo e membro interno, stream truncado, deflate inválido, limites abaixo/no/acima, senha e ausência de extração insegura. Um except Exception genérico ocultaria defeitos.

### 3. Leitura e lock síncronos na coroutine de prévia — P2

domains/inventory_update.preview_inventory_files (linhas 411–430) chama lock_paths e Path.read_bytes diretamente dentro da função async. core/integrity.py implementa o lock com aquisição síncrona, polling e timeout. Um lock disputado pode esperar vários segundos; os arquivos ativos podem chegar a 30 MiB cada. Outras tarefas do event loop esperam enquanto o snapshot é adquirido e lido.

**Evidência e limite:** chamada síncrona observada no código e mecanismo de lock inspecionado. Não foi executado benchmark sob carga, portanto não afirmo latência de produção.

**Proposta:** mover aquisição do lock e leitura para uma única operação worker, mantendo seção crítica, ordem, limite, snapshot consistente e cancelamento seguro. Acrescentar regressão com lock disputado, heartbeat/segunda requisição, timeout e cancelamento. Não repartir a seção crítica entre workers.

### Dívida de arquitetura, sem refatoração automática

main.py tem aproximadamente 4 mil linhas e compõe rotas, middleware, estado, carregamento, mutação e respostas. Ainda assim, factories e serviços já existem em módulos adjacentes. O tamanho isolado não demonstra uma regressão concreta nem justifica extração ampla. As três propostas delimitam mudanças por mecanismo e teste.

Handlers não declaram response_model uniformemente, então alguns contratos não aparecem no OpenAPI. O mapa registra respostas reais do código; adicionar modelos ou mudar o schema deve ficar separado das correções até verificar consumidores e comportamento.

## Plano incremental para as próximas fases

1. **Fase 2:** aplicar as três correções delimitadas e regressões, na ordem: vida útil dos workers; normalização de erros deflate; snapshot da prévia. Rodar testes focados após cada mudança. Se a exceção exigir alterar política HTTP, parar para decidir.
2. **Fase 3:** executar suíte ampla, verificações da workflow e CI do SHA enviado; conferir recuperação transacional, uploads, cancelamentos, limites, modo de arquivos e rotas PostgreSQL cobertas pela barreira, sem ativar infraestrutura externa ou migrar estado real. Publicar relatório de validação em commit da fase.
Mudanças de API/autorização, esquema/migração, autenticação ou infraestrutura não foram propostas como correção implícita. PostgreSQL permanece piloto opt-in e limitado pela allowlist da barreira.

## Linha de base e limites

O runner tests/run_tests.py foi inspecionado antes de executar. Ele isola tempfile em pasta temporária e bloqueia openpyxl.load_workbook durante descoberta. A cópia de validação contém caminhos Git de código/teste/documentação permitida; diretórios de dados, arquivos .env, planilhas reais e backups não foram copiados. Variáveis de inbox/anotações apontaram para caminhos sintéticos nessa cópia.

| Verificação local na cópia | Resultado |
| --- | --- |
| tests/run_tests.py | 347 testes passaram. Um modelo XLSX sintético serviu aos testes que requerem a fixture versionada; o modelo oficial não foi lido nesta inspeção. |
| node --test — 10 arquivos em tests/frontend/ | 131 testes passaram. |
| npm run test:ui:e2e | 43 testes Playwright passaram em desktop, perfil de animação e mobile; o servidor é sintético. |
| mypy com parâmetros e 40 caminhos da workflow | Sucesso, sem problemas nos 40 arquivos. |
| node --check em JavaScript/CJS | 31 arquivos passaram. |
| compileall | core, main.py, domains, routers, persistence, security, scripts e tests passaram. |
| npm ci e npm audit --audit-level=moderate | 44 pacotes auditados; zero vulnerabilidades relatadas. |
| npm run build:ui | Passou na cópia temporária. |
| scripts/check_secrets.py | Nenhum padrão conhecido nos arquivos Git rastreados da cópia selecionada. Segredos e valores de .env não foram lidos. |

O Node local era v26, enquanto a workflow pede v24. A matriz Python 3.12/3.14 e Node 24 precisa da CI remota do SHA publicado. A suíte Python local usou fixtures isoladas; o modelo oficial versionado de transferência não foi lido. Não houve conexão a PostgreSQL, migrations, importação real ou inicialização operacional.

A workflow .github/workflows/ci.yml executa suíte Python e mypy em windows-latest com Python 3.12 e 3.14, testes/sintaxe JavaScript com Node 24 e job de navegador com npm ci, auditoria, build, Chromium e Playwright. Também executa scanner de segredos e compilação Python. Critério final da Fase 1: workflow vinculada ao SHA após push; linha de base local não a substitui.

## Arquivos complementares

- [Mapa de contratos HTTP, parâmetros, autenticação, erros, armazenamento e consumidor](CONTRATOS_API_BACKEND.md).
- Prompt operacional atualizado após a primeira verificação verde da CI: [PROMPT_REFATORACAO_BACKEND_SIMPRESS.md](../PROMPT_REFATORACAO_BACKEND_SIMPRESS.md).
