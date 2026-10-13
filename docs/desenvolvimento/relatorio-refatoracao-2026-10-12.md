# Relatório final — organização e refatoração do Simpress

Data: 12/10/2026. Branch das fases: `codex/reorganizacao-frontend-20261012`. Integração: `origin/main` sobre `fd70a26`.

## Resultado e escopo

Foram reorganizados 63 arquivos por responsabilidade, com atualização de imports, páginas, build, testes, CI e documentação. A refatoração extraiu utilitários seguros de DOM e corrigiu concorrência nas leituras do acompanhamento de chamados. FastAPI, JavaScript nativo, Tailwind, regras de negócio e direção visual escura foram mantidos.

As quatro fases receberam commits, pushes e CI próprios. Os cinco commits da entrega foram integrados sobre a revisão atual de `main` (`fd70a26`) e enviados a `origin/main`; o workflow dessa integração é acompanhado após o push em [Actions de main](https://github.com/gabrielakihiro-dev/Simpress/actions?query=branch%3Amain). Não houve deploy, alteração de dependências ou instalação de framework. O trabalho local preexistente foi preservado e ficou fora dos commits.

## 1. Análise e arquitetura

A [análise anterior às alterações](../arquitetura/analise-refatoracao-frontend.md) registra o inventário inicial de 210 arquivos rastreados, os contratos e a proposta da estrutura. O [mapa de movimentos](../arquitetura/mapa-movimentos.md) também documenta as referências atualizadas.

- `main.py` permanece como composição e inicializador FastAPI. `routers/`, `domains/`, `persistence/` e `security/` continuam separados por HTTP, regras, armazenamento e autenticação.
- `core/` reúne configuração, transações, compatibilidade openpyxl e segurança XLSX. `core/config.py:7` calcula a mesma raiz do projeto após o movimento; os reexports de `main.py` foram mantidos.
- A interface usa scripts clássicos e duas páginas HTML. Não utiliza React, props, contexto ou hooks. Módulos auxiliares mantêm o padrão UMD/CommonJS usado anteriormente.
- `package.json` executa cópia de fontes/ícones locais e Tailwind 4. A configuração fica em `config/tailwind.config.cjs`, e a fonte CSS em `static/styles/tailwind.input.css`.
- Playwright usa Chromium desktop/mobile e perfil de desempenho. Os testes Python usam discovery isolado e dados temporários; os testes Node usam módulos e um DOM simulado.

### Achados e tratamento

| Achado comprovado | Referências atuais | Tratamento |
| --- | --- | --- |
| Utilitários de DOM misturados com controladores de fluxos em `app.js` | `static/js/shared/dom-utils.js:7`, `:17`, `:24`, `:31` | Extração de escape, texto, ícones e destaque literal; wrappers globais em `static/app.js:939` preservam os consumidores |
| Snapshot antigo ou erro atrasado substituía uma seleção mais recente | `selecionarVersaoChamados`, `carregarAcompanhamentoChamados` | Gate compartilhado entre as duas leituras, AbortSignal e verificação depois do parse JSON, inclusive no caminho de erro |
| Comparação antiga substituía a evolução atual | `carregarEvolucaoChamados` | Gate independente de evolução, invalidado quando começa outra seleção |
| Leituras continuavam após fechar o acompanhamento | `fecharAcompanhamentoChamados` | Invalidação e cancelamento dos canais de leitura e das linhas do tempo pendentes |
| Card removido recebia instalação tardia de autosave; leituras duplicadas da linha do tempo | `carregarLinhaDoTempoChamado` | Controle por elemento, deduplicação enquanto pendente, descarte de DOM desconectado e liberação no `finally`, permitindo retry |
| Configuração e utilitários de infraestrutura na raiz; assets e documentação planos | Árvore e tabela abaixo | Organização por função, preservando CLIs e limites de pacotes já adequados |

Seis cenários de concorrência falharam antes da correção e passaram depois. Um sétimo caso verifica deduplicação e retry da linha do tempo. Não foi demonstrado gargalo que justificasse memoização, alteração das animações ou nova infraestrutura de estado.

## 2. Árvore anterior

```text
/
  main.py, app_config.py, integrity.py, openpyxl_compat.py, xlsx_safety.py
  README.md, AGENTS.md, RELATORIO_AUDITORIA_FRONTEND.md
  package.json, package-lock.json, playwright.config.cjs, tailwind.config.cjs
  requirements*.txt, iniciar_servidor.bat, arquivos ocultos de ferramentas
  domains/, routers/, persistence/, security/
  static/ [index.html, login.html, JS/CSS auxiliares, app.js, app.css, vendor/, favicon.svg]
  tests/ [Python, Node, run_tests.py, serve_ui_motion_preview.py, e2e/, fixtures/]
  scripts/ [CLIs Python e copy_ui_assets.cjs]
  docs/ [arquitetura, operação, UI, CI e Supabase misturados]
  supabase/, data/, planilhas_entrada/, modelos/
```

## 3. Árvore final

```text
/
  main.py, iniciar_servidor.bat, README.md, AGENTS.md
  package.json, package-lock.json, playwright.config.cjs, requirements*.txt
  .env.*.example, .gitignore, .github/, .cursor/, .vscode/
  core/ [__init__.py, config.py, integrity.py, openpyxl_compat.py, xlsx_safety.py]
  config/ [tailwind.config.cjs]
  domains/, routers/, persistence/, security/
  static/
    index.html, app.js, app.css
    pages/ [login.html]
    styles/ [login.css, sidebar-navigation.css, ui-motion.css, tailwind.input.css]
    js/
      shared/ [dom-utils, catálogo, rascunho, transferência, autosave]
      ui/ [diálogos, movimento, notificações, navegação]
      auth/ [auth-session.js, login.js]
    vendor/, favicon.svg
  tests/
    test_*.py, run_tests.py
    frontend/ [testes Node, incluindo DOM e concorrência]
    e2e/ [UI, primeiro acesso, assets, concorrência e conteúdo externo]
    support/ [serve_ui_motion_preview.py]
    fixtures/
  scripts/
    *.py [interfaces CLI estáveis]
    build/ [copy_ui_assets.cjs]
  docs/
    arquitetura/
    desenvolvimento/ [inclui este relatório]
    operacao/ [inclui supabase/]
    guias/
    ui-motion/ [imagem existente]
  supabase/, data/, planilhas_entrada/, modelos/ [preservados]
```

Os três arquivos de entrada em `static/` tinham alterações preexistentes e mantiveram seus caminhos. `main.py` e o BAT mantêm a inicialização documentada e o VS Code; manifestos npm, Playwright, requirements, README/AGENTS e arquivos ocultos permanecem pelas convenções das ferramentas. Os CLIs Python de `scripts/` têm consumidores no iniciador e em procedimentos externos. As pastas de domínio, persistência, rotas, segurança e Supabase já agrupavam responsabilidades e não foram movidas sem benefício.

Um arquivo não rastreado `docs/PROMPT_REFATORACAO_BACKEND_SIMPRESS.md` apareceu durante a execução. Foi preservado no caminho em que surgiu e ficou fora da reorganização e dos commits.

## 4. Arquivos movidos e referências

| Origem | Destino | Referências atualizadas |
| --- | --- | --- |
| `RELATORIO_AUDITORIA_FRONTEND.md` | `docs/arquitetura/RELATORIO_AUDITORIA_FRONTEND.md` | README e links entre documentos |
| `app_config.py` | `core/config.py` | Imports, patches, CI e fixtures |
| `docs/ANOTACOES-HISTORICO.md` | `docs/operacao/ANOTACOES-HISTORICO.md` | README e links entre documentos |
| `docs/MICROINTERACOES.md` | `docs/desenvolvimento/MICROINTERACOES.md` | README e links entre documentos |
| `docs/PRIMEIRO_ACESSO.md` | `docs/guias/PRIMEIRO_ACESSO.md` | README e links entre documentos |
| `docs/REVISAO_PROGRESSO.md` | `docs/desenvolvimento/REVISAO_PROGRESSO.md` | README e links entre documentos |
| `docs/auditoria_arquitetura.md` | `docs/arquitetura/auditoria_arquitetura.md` | README e links entre documentos |
| `docs/correcao_ci_ui_browser.md` | `docs/desenvolvimento/correcao_ci_ui_browser.md` | README e links entre documentos |
| `docs/correcao_ci_ui_browser_etapa_7.md` | `docs/desenvolvimento/correcao_ci_ui_browser_etapa_7.md` | README e links entre documentos |
| `docs/execucao_auditoria_arquitetura.md` | `docs/arquitetura/execucao_auditoria_arquitetura.md` | README e links entre documentos |
| `docs/idempotencia-atualizacao-inventario.md` | `docs/operacao/idempotencia-atualizacao-inventario.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_1.md` | `docs/operacao/supabase/migracao_supabase_etapa_1.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_2.md` | `docs/operacao/supabase/migracao_supabase_etapa_2.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_3.md` | `docs/operacao/supabase/migracao_supabase_etapa_3.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_4.md` | `docs/operacao/supabase/migracao_supabase_etapa_4.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_5.md` | `docs/operacao/supabase/migracao_supabase_etapa_5.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_6.md` | `docs/operacao/supabase/migracao_supabase_etapa_6.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_7.md` | `docs/operacao/supabase/migracao_supabase_etapa_7.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_7_diagnostico_inicializacao.md` | `docs/operacao/supabase/migracao_supabase_etapa_7_diagnostico_inicializacao.md` | README e links entre documentos |
| `docs/migracao_supabase_etapa_8.md` | `docs/operacao/supabase/migracao_supabase_etapa_8.md` | README e links entre documentos |
| `docs/migracao_supabase_free_etapa_9.md` | `docs/operacao/supabase/migracao_supabase_free_etapa_9.md` | README e links entre documentos |
| `docs/migracao_supabase_pre_requisitos_locais.md` | `docs/operacao/supabase/migracao_supabase_pre_requisitos_locais.md` | README e links entre documentos |
| `docs/prompts_correcao_auditoria_2026-10-11.md` | `docs/desenvolvimento/prompts_correcao_auditoria_2026-10-11.md` | README e links entre documentos |
| `docs/prompts_migracao_supabase_etapas_2_a_8.md` | `docs/operacao/supabase/prompts_migracao_supabase_etapas_2_a_8.md` | README e links entre documentos |
| `docs/prompts_supabase_free_fastapi_local.md` | `docs/operacao/supabase/prompts_supabase_free_fastapi_local.md` | README e links entre documentos |
| `docs/publicacao_migracao_supabase_etapas_6_e_7.md` | `docs/operacao/supabase/publicacao_migracao_supabase_etapas_6_e_7.md` | README e links entre documentos |
| `docs/relatorio_fase6_desempenho_2026-09-28.md` | `docs/desenvolvimento/relatorio_fase6_desempenho_2026-09-28.md` | README e links entre documentos |
| `docs/resultado_correcao_dependencias_npm_2026-10-11.md` | `docs/desenvolvimento/resultado_correcao_dependencias_npm_2026-10-11.md` | README e links entre documentos |
| `docs/resultado_execucao_01_2026-10-11.md` | `docs/desenvolvimento/resultado_execucao_01_2026-10-11.md` | README e links entre documentos |
| `docs/resultado_execucao_02_2026-10-11.md` | `docs/desenvolvimento/resultado_execucao_02_2026-10-11.md` | README e links entre documentos |
| `docs/resultado_execucao_03_2026-10-11.md` | `docs/desenvolvimento/resultado_execucao_03_2026-10-11.md` | README e links entre documentos |
| `docs/resultado_execucao_04_2026-10-11.md` | `docs/desenvolvimento/resultado_execucao_04_2026-10-11.md` | README e links entre documentos |
| `docs/resultado_execucao_05_2026-10-11.md` | `docs/desenvolvimento/resultado_execucao_05_2026-10-11.md` | README e links entre documentos |
| `integrity.py` | `core/integrity.py` | Imports, patches, CI e fixtures |
| `openpyxl_compat.py` | `core/openpyxl_compat.py` | Imports, patches, CI e fixtures |
| `scripts/copy_ui_assets.cjs` | `scripts/build/copy_ui_assets.cjs` | HTML, build, CI e testes |
| `static/accessible-dialogs.js` | `static/js/ui/accessible-dialogs.js` | HTML, build, CI e testes |
| `static/auth-session.js` | `static/js/auth/auth-session.js` | HTML, build, CI e testes |
| `static/catalog-search-utils.js` | `static/js/shared/catalog-search-utils.js` | HTML, build, CI e testes |
| `static/form-draft-guard.js` | `static/js/shared/form-draft-guard.js` | HTML, build, CI e testes |
| `static/history-annotation-autosave.js` | `static/js/shared/history-annotation-autosave.js` | HTML, build, CI e testes |
| `static/login.css` | `static/styles/login.css` | HTML, build, CI e testes |
| `static/login.html` | `static/pages/login.html` | HTML, build, CI e testes |
| `static/login.js` | `static/js/auth/login.js` | HTML, build, CI e testes |
| `static/sidebar-navigation.css` | `static/styles/sidebar-navigation.css` | HTML, build, CI e testes |
| `static/sidebar-navigation.js` | `static/js/ui/sidebar-navigation.js` | HTML, build, CI e testes |
| `static/tailwind.input.css` | `static/styles/tailwind.input.css` | HTML, build, CI e testes |
| `static/transfer-utils.js` | `static/js/shared/transfer-utils.js` | HTML, build, CI e testes |
| `static/ui-motion.css` | `static/styles/ui-motion.css` | HTML, build, CI e testes |
| `static/ui-motion.js` | `static/js/ui/ui-motion.js` | HTML, build, CI e testes |
| `static/ui-notifications.js` | `static/js/ui/ui-notifications.js` | HTML, build, CI e testes |
| `tailwind.config.cjs` | `config/tailwind.config.cjs` | HTML, build, CI e testes |
| `tests/serve_ui_motion_preview.py` | `tests/support/serve_ui_motion_preview.py` | Imports, patches, CI e fixtures |
| `tests/test_annotation_version_ui.cjs` | `tests/frontend/test_annotation_version_ui.cjs` | HTML, build, CI e testes |
| `tests/test_auth_session.cjs` | `tests/frontend/test_auth_session.cjs` | HTML, build, CI e testes |
| `tests/test_catalog_search_utils.cjs` | `tests/frontend/test_catalog_search_utils.cjs` | HTML, build, CI e testes |
| `tests/test_form_draft_guard.cjs` | `tests/frontend/test_form_draft_guard.cjs` | HTML, build, CI e testes |
| `tests/test_history_annotation_retries.cjs` | `tests/frontend/test_history_annotation_retries.cjs` | HTML, build, CI e testes |
| `tests/test_history_annotations.cjs` | `tests/frontend/test_history_annotations.cjs` | HTML, build, CI e testes |
| `tests/test_inventory_ui_flows.cjs` | `tests/frontend/test_inventory_ui_flows.cjs` | HTML, build, CI e testes |
| `tests/test_transfer_workflows.cjs` | `tests/frontend/test_transfer_workflows.cjs` | HTML, build, CI e testes |
| `tests/test_ui_motion.cjs` | `tests/frontend/test_ui_motion.cjs` | HTML, build, CI e testes |
| `xlsx_safety.py` | `core/xlsx_safety.py` | Imports, patches, CI e fixtures |

Os caminhos de origem da tabela são registros históricos, não referências executáveis. Os links Markdown locais de README e docs foram verificados a partir de cada nova pasta. A rota `/login` lê `static/pages/login.html`; `/` continua usando a entrada existente. O versionamento por hash reconhece as URLs aninhadas dos assets.

## 5. Refatorações e compatibilidade

- `dom-utils.js` recebe `document` como dependência; renderização externa continua escapada ou feita por `textContent`. Destaques tratam metacaracteres como texto literal. Os nomes `escapeHtml`, `createTextElement`, `createIcon` e `highlightMatch` permanecem globais por wrappers.
- Gates e cancelamento aplicam-se às leituras de chamados. Imports, salvamento de anotações, exportações e outras mutações mantêm seus endpoints, payloads e comportamento. Após uma importação confirmada, leituras anteriores são invalidadas.
- IDs, handlers inline, classes, ARIA e `data-*` não foram renomeados. A entrada original tinha 200 IDs e 94 handlers inline; a estrutura funcional do HTML foi preservada. Diálogos, foco, Escape, teclado e movimento reduzido continuam cobertos pela suíte existente.
- As regras de rótulos e anotações do Histórico de Planilhas permaneceram nos mesmos módulos de domínio, com a mesma validação, limite de 2.000 caracteres, revisões, conflitos, herança, sincronização e dados brutos. As mudanças nesses pacotes limitaram-se a imports da infraestrutura movida.
- CSS próprio não recebeu redesenho. CSS gerado foi reconstruído pelo comando do projeto; o conjunto anterior de grupos de seletores foi preservado, com 11 grupos adicionais encontrados nas fontes auxiliares agora incluídas no scan.
- Os diffs locais preexistentes em `app.js`, `app.css` e `index.html` foram comparados com os snapshots iniciais e continuam idênticos. A comparação considera os blocos adicionados/removidos, sem depender de números de linha deslocados pela refatoração.
- Os hashes SHA-256 de 67 arquivos protegidos em dados, planilhas, modelos e transações permaneceram iguais. Nenhum desses arquivos entrou nos commits. O JSON de estado não rastreado original também foi preservado.

## 6. Verificações executadas

Ambiente local: Python 3.12.14, Node.js 26.10.0, Playwright 1.64.0/Chromium. A CI usa Windows, Node.js 24 e Python 3.12/3.14.

| Comando ou verificação | Resultado |
| --- | --- |
| `node --test tests/test_*.cjs` antes das alterações | 120 aprovados |
| `npm run build:ui` após organizar e refatorar | Aprovado, repetido após cada mudança relevante; gerador e fonte CSS atualizados |
| `.venv/Scripts/python.exe -B tests/run_tests.py` na árvore preparada da fase 2 | 344 aprovados |
| `node --test tests/frontend/test_*.cjs` na fase 2 | 120 aprovados |
| `npm run test:ui:e2e` na árvore preparada das fases 2 e 3 | 39 aprovados em cada execução |
| `node --test tests/frontend/test_*.cjs` após a refatoração | 131 aprovados, incluindo 11 novos testes |
| `.venv/Scripts/python.exe -B tests/run_tests.py` na árvore final publicada | 347 aprovados em duas execuções completas consecutivas (50,580 s e 57,698 s) |
| `playwright test --repeat-each=2` na árvore final publicada | 86 aprovados: 43 execuções por rodada, incluindo desktop, mobile e perfil |
| `npm run test:ui:e2e -- tests/e2e/ui.spec.cjs tests/e2e/asset-updates.spec.cjs tests/e2e/ticket-requests.spec.cjs` no diretório atual | 37 aprovados |
| Rotas e assets reais com TestClient identificado como loopback | `/`, `/login`, hashes de conteúdo, respostas e política de cache aprovados |
| Inicialização real por `python -B main.py` em cópia temporária com backend files | Servidor iniciou; `/`, `/login`, 22 referências de assets e `/api/prontidao` responderam; processo encerrado ao terminar |
| `python -m mypy --explicit-package-bases --platform win32 --ignore-missing-imports --check-untyped-defs ...` com o conjunto da CI, incluindo `core` | Sem erros em 41 arquivos de origem |
| `node --check` em todos os JS/CJS de aplicação, build, configuração e testes; parsing AST dos Python rastreados | Aprovados |
| `python -m pip check` | Nenhuma dependência quebrada |
| `npm audit --audit-level=moderate` | Zero vulnerabilidades informadas |
| `python -B scripts/check_secrets.py` | Nenhum padrão conhecido de credencial nos arquivos rastreados |
| Links Markdown e caminhos de assets/Tailwind | Nenhuma referência local quebrada verificada |
| `git diff --check` e `git diff --cached --check` | Aprovados |
| Hashes de dados e diffs preexistentes | 67 arquivos protegidos iguais; três diffs locais preservados |

O mypy foi executado sobre `core`, `main.py`, os domínios/rotas selecionados pela CI, `persistence`, `security` e os scripts de migração/ensaio/limpeza já incluídos no workflow. Não é uma alegação de tipagem completa de todo o projeto.

### Acessibilidade, responsividade e desempenho

A suíte existente verifica axe WCAG 2.2 A/AA na Home e nos fluxos cobertos, contenção e restauração de foco, Shift+Tab, Escape, navegação e movimento reduzido. Os testes novos exercitam respostas concorrentes e tentativa de injeção de HTML em Chromium.

O teste responsivo mede 320×740, 390×844, 768×1024, 844×390 e 1440×900, aguardando o fim das animações de `.app-workspace` antes de medir overflow.

O perfil anterior à refatoração funcional mediu p95 de transições de aproximadamente 33,4 ms e maior handler de 1,9 ms. Nas duas rodadas finais, o p95 foi 16,7 ms e 16,8 ms, os maiores handlers foram 1,0 ms e 0,9 ms, e não houve frames acima de 50 ms durante as transições. Todos ficaram dentro dos limites existentes. A variação de ambiente impede atribuir causalmente essa diferença à extração dos utilitários; nenhuma melhoria de desempenho é reivindicada.

### Falhas e limitações registradas

1. **Sandbox local**: a primeira suíte Python travou ao criar o socket interno do event loop Windows. O traceback mostrou `_fallback_socketpair`/`accept`; a execução com sockets liberados completou. Não foi alterado o código para contornar o ambiente.
2. **Trabalho local e testes antigos do painel**: no diretório atual, a suíte final teve 346 aprovações e uma falha em `test_readiness_panel_is_accessible_refreshable_and_renders_text_safely`, que ainda espera `readiness-refresh`. A mesma falha foi reproduzida numa cópia do commit inicial `f11c3f0` com os três diffs originais, comprovando que antecede a refatoração. Uma execução completa local na fase 2 também teve 33 aprovações e seis falhas E2E de primeiro acesso relacionadas ao painel preservado. Os testes não foram enfraquecidos e o painel não foi revertido.
3. **Isolamento da publicação**: os resultados completos aprovados foram obtidos numa exportação do índice Git, com os mesmos arquivos publicados e sem os diffs locais preexistentes. Isso permite validar a entrega sem publicar nem sobrescrever trabalho paralelo. O diretório atual também recebeu testes Node, rotas/assets e 37 cenários browser focados, conforme a tabela.
4. **Intermitência anterior no CI**: a fase 1, que só adicionou documentação, inicialmente falhou em Python 3.14 no teste `test_same_batch_in_separate_processes_commits_once`: recebeu HTTP 500 em vez de 409. A repetição do mesmo SHA passou. A ocorrência foi preservada como débito; não houve relaxamento das expectativas.
5. **Verificações não executadas**: não houve ensaio com dados operacionais reais, autenticação real/Supabase/PostgreSQL em serviço, Firefox/WebKit, dispositivo móvel físico ou deploy. Python 3.14 foi verificado pela CI, não pelo ambiente Python local. Essas dependências de infraestrutura não foram necessárias para os movimentos e a refatoração de leitura.
6. **Base Git**: o fetch encontrou `origin/main` em `fd70a26`, três commits adiante do checkout inicial. A integração foi feita sem conflitos em checkout separado e preservou os três commits recentes de `main`; os diffs locais sobrepostos ficaram no checkout original e não foram publicados.

## 7. Commits, pushes e CI por fase

| Fase | Commit publicado | CI confirmado |
| --- | --- | --- |
| 1 — análise antes de editar código | `cf3c2f6` | [Aprovado após repetição da falha intermitente](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38213330549) |
| 2 — organização | `f742fe2` | [Aprovado em Python 3.12, 3.14 e browser](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38214162001) |
| 3 — refatoração | `39fbfd4` | [Aprovado em Python 3.12, 3.14 e browser](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38214735188) |
| 4 — verificações adicionais | `dbc4ea8` | [Aprovado em Python 3.12, 3.14 e browser](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38215261854) |

O commit deste relatório (`6da3aea`) também recebeu CI aprovado: [workflow da fase 5](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38215886495). A integração publicada em `main` (`1f1b33d`) passou nos dois jobs Python e no job de navegador: [workflow da integração](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38271223148). Os testes e a CI da revisão posterior estão registrados no [relatório de revisão](revisao-refatoracao-frontend-2026-10-12.md).

## 8. Débitos técnicos priorizados

| Prioridade | Próximo trabalho | Dependência |
| --- | --- | --- |
| P1 | Decidir se os diffs locais do painel devem ser reaplicados após a integração | Revisão dos três arquivos locais que continuam preservados no checkout de trabalho e não foram publicados |
| P1 | Investigar a resposta 500 intermitente no teste multiprocesso de chamados em Windows/Python 3.14 | Reprodução e diagnóstico de bloqueio/commit em ambiente equivalente ao CI; manter expectativa 409 e garantias transacionais |
| P2 | Extrair controladores de histórico, inventário e chamados em etapas, com estado encapsulado e adaptadores para os handlers atuais | Cobertura de fluxos e migração coordenada dos 94 handlers inline; `app.js` continua concentrando cerca de 4,8 mil linhas |
| P2 | Estender a auditoria de concorrência aos demais modais de leitura e uniformizar políticas de descarte de respostas | Reproduções específicas por fluxo, sem abstração genérica que altere mutações |
| P2 | Consolidar testes Python que verificam strings de implementação com mais testes de comportamento | Preservar cobertura de segurança, mensagens, rótulos e seletores; não remover contratos antes de sua substituição equivalente |
| P3 | Ampliar browsers e ensaios de autenticação/persistência real | Infraestrutura Firefox/WebKit, Supabase/PostgreSQL local e credenciais sintéticas próprias; sem utilizar dados operacionais |
