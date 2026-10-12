# Análise da reorganização e refatoração do Simpress

Data: 12/10/2026. Fase 1, concluída antes de alterar código.

## Estado inicial e escopo

- Checkout inicial: `main`, commit `f11c3f0`.
- Alterações preexistentes: `static/app.js`, `static/app.css`, `static/index.html` e `data/state/inventory_update_idempotency.json` não rastreado.
- O fetch encontrou três commits adicionais em `origin/main`, até `fd70a26`, que também alteram o painel de disponibilidade. A branch de trabalho parte do checkout inicial; não haverá merge sobre essas alterações locais sobrepostas.
- Branch de entrega: `codex/reorganizacao-frontend-20261012`. Commit e push por fase foram autorizados posteriormente pelo usuário, com acompanhamento do CI.
- Dados, modelos, estado, históricos, backups, arquivos ignorados, dependências e caches ficam nos caminhos atuais. O trabalho local permanece fora dos commits da refatoração.

## Inventário e arquitetura confirmada

O inventário de `git ls-files` contém 210 arquivos: 18 na raiz, 30 em `static`, 39 em `tests`, 32 em `docs`, 21 em `scripts`, 13 em `domains`, 13 em `persistence`, 9 em `routers`, 7 em `security`, 9 em `supabase`, 12 em `data`, um modelo legado em `planilhas_entrada` e seis arquivos nas pastas de ferramentas. Dependências e dados locais não entram na reorganização.

O servidor é Python/FastAPI, com inicialização em `main.py` e caminhos em `app_config.py`. `routers/` delimita HTTP, `domains/` contém regras de comparação/importação/relatórios, `persistence/` oferece arquivos e o piloto PostgreSQL, e `security/` implementa sessão, CSRF e restrição local. Esses limites já são úteis e serão mantidos.

O front-end usa scripts clássicos sem framework, duas páginas HTML e CSS próprio sobre Tailwind. `package.json` usa Tailwind 4 e copia Lucide/fontes para `static/vendor`; os assets de terceiros são locais. `playwright.config.cjs` executa Chromium desktop/mobile e um perfil de desempenho, com servidor de dados sintéticos. A CI também executa unittest, testes Node, sintaxe, mypy e verificação de credenciais.

| Área | Arquivos/funções atuais | Responsabilidade e contratos |
| --- | --- | --- |
| Entrada | `static/index.html`, `inicializarAplicacao` | 200 IDs e 94 handlers inline; scripts carregados em ordem, antes de `app.js` |
| Busca | `handleSerialInput`, `buscarSerial`, `carregarResultadosPesquisaCompleta` | `/api/buscar-expandida`, `/api/equipamento/{serial}`; gates de requisição, seleção de série e paginação |
| Transferência | `construirPayload`, `validarCamposObrigatoriosPlanilha`, `gerarPlanilhaExcel`, `transfer-utils.js` | `/api/config/transferencia`, `/api/gerar-planilha`; telefone, CNPJ, contatos, rascunho e download |
| Disponibilidade | `carregarProntidao`, `abrirImportacaoModelo` | `/api/prontidao`, `/api/modelos/{tipo}/importar`; painel modificado localmente pelo usuário |
| Inventários | `previsualizarPlanilhas`, `enviarPlanilhas`, `restaurarHistoricoComparacao` | preview, confirmação, idempotência, atualização e restauração transacional |
| Histórico | `abrirModalComparacaoPlanilhas`, `renderizarTabelaComparacao`, `formatarNomeFonteHistorico` | rótulos normalizados, cards/tabelas responsivos e dados de auditoria preservados |
| Anotações | `history-annotation-autosave.js`, `conectarAnotacoesOperacionais` | 2.000 caracteres, revisão causal, conflito, retry, rascunho e sincronização compartilhada |
| Operações | `abrirCentralPendencias`, `compararEvolucaoSelecionada` | `/api/operacoes/pendencias`, `/api/operacoes/evolucao`; notas por ocorrência |
| Chamados | `selecionarVersaoChamados`, `carregarEvolucaoChamados`, `carregarLinhaDoTempoChamado` | snapshots, filtros, triagem, exportação e linha do tempo por série |
| Acessibilidade | `accessible-dialogs.js`, `ui-motion.js`, `sidebar-navigation.js` | foco inicial/restaurado, Escape, teclado, `inert`, estados ocupados e movimento reduzido |
| Autenticação | `login.html`, `login.js`, `auth-session.js`, `security/routes.py` | `/login`, `/api/auth/session`, login/logout e CSRF; nenhuma credencial no browser |

## Achados comprovados e decisões

1. **Responsabilidades concentradas**: `static/app.js` tem 4.856 linhas e 263.815 bytes, misturando renderização, formatação, estado e transporte. `escapeHtml`, `createTextElement`, `createIcon` e `highlightMatch` são utilitários reutilizáveis sem dependência das regras de negócio. Extraí-los mantém os nomes globais por wrappers e reduz o acoplamento ao controlador principal.
2. **Respostas fora de ordem em chamados**: `selecionarVersaoChamados`, `carregarAcompanhamentoChamados` e `carregarEvolucaoChamados` aplicam respostas após `await` sem verificar se outra seleção já começou. Uma resposta antiga pode substituir a seleção mais recente, inclusive com uma mensagem de erro. Reutilizar `createRequestGate` já existente, com canais independentes para snapshot e evolução, evita a inconsistência sem mudar endpoints ou mensagens.
3. **Estado vinculado a DOM substituído**: `carregarLinhaDoTempoChamado` pode continuar após o card ser reconstruído. É necessário impedir que respostas de um card desconectado instalem autosave/listeners e permitir retry após falha.
4. **Organização plana dos assets**: páginas, fontes CSS e módulos JS auxiliares dividem `static/`. Agrupar os auxiliares por papel facilita navegação. Os três arquivos alterados localmente permanecem como entradas estáveis, evitando mover trabalho preexistente.
5. **Utilitários Python na raiz**: `integrity.py`, `xlsx_safety.py`, `openpyxl_compat.py` e `app_config.py` são infraestrutura compartilhada, não inicializadores. Agrupá-los em `core/` mantém os limites entre domínio, HTTP e persistência.
6. **Documentação dispersa**: relatório de auditoria na raiz e documentos de operação, desenvolvimento e Supabase na mesma pasta. Agrupar por assunto e usar o README como índice melhora a localização sem alterar conteúdo operacional.
7. **Dependência explícita de caminhos nos testes**: `tests/test_maintenance_contracts.py`, testes Node, `tests/serve_ui_motion_preview.py`, Tailwind, cópia de assets, CI e autenticação referenciam caminhos físicos. Cada movimento precisa atualizar essas referências; testes de contrato não serão removidos nem relaxados.

Não há evidência nesta etapa de gargalo que justifique memoização, novo gerenciador de estado, framework, migração TypeScript ou alterações de animação/design. O perfil existente será medido na verificação, sem alegação antecipada de melhoria de desempenho.

## Árvore anterior relevante

```text
/
  main.py, app_config.py, integrity.py, openpyxl_compat.py, xlsx_safety.py
  README.md, AGENTS.md, RELATORIO_AUDITORIA_FRONTEND.md
  package.json, package-lock.json, playwright.config.cjs, tailwind.config.cjs
  iniciar_servidor.bat, requirements*.txt, .env.*.example
  domains/, routers/, persistence/, security/
  static/ [index.html, login.html, app.js, auxiliares JS, CSS, vendor/, favicon.svg]
  tests/ [testes Python e Node, run_tests.py, serve_ui_motion_preview.py, fixtures/, e2e/]
  scripts/ [CLIs operacionais, validação, piloto e copy_ui_assets.cjs]
  docs/ [documentos de vários assuntos, ui-motion/]
  supabase/ [configuração, migrations/, tests/]
  data/, planilhas_entrada/, modelos/ [preservados]
```

## Árvore de destino proposta

```text
/
  main.py, iniciar_servidor.bat, README.md, AGENTS.md
  package.json, package-lock.json, playwright.config.cjs, requirements*.txt
  .env.*.example, .gitignore, .github/, .cursor/, .vscode/
  core/ [__init__.py, config.py, integrity.py, openpyxl_compat.py, xlsx_safety.py]
  config/ [tailwind.config.cjs]
  domains/, routers/, persistence/, security/ [limites mantidos]
  static/
    index.html, app.js, app.css [entradas com alterações locais preservadas]
    pages/ [login.html]
    styles/ [login.css, ui-motion.css, sidebar-navigation.css, tailwind.input.css]
    js/
      shared/ [DOM, busca de catálogo, rascunho, transferência, autosave]
      ui/ [diálogos, movimento, notificações, navegação]
      auth/ [auth-session.js, login.js]
    vendor/, favicon.svg [processo de build mantido]
  tests/
    test_*.py, run_tests.py [discovery/fixtures Python mantidos]
    frontend/ [testes Node]
    support/ [serve_ui_motion_preview.py]
    fixtures/, e2e/ [contratos mantidos]
  scripts/
    *.py [CLIs estáveis usados pelo iniciador e integrações externas]
    build/ [copy_ui_assets.cjs]
  docs/
    arquitetura/ [análise, arquitetura, auditorias]
    desenvolvimento/ [UI, CI, resultados e relatório final]
    operacao/ [histórico, idempotência, supabase/]
    guias/ [primeiro acesso]
    ui-motion/ [evidência visual existente]
  supabase/, data/, planilhas_entrada/, modelos/ [preservados]
```

Na raiz permanecem o entrypoint Python e o BAT para execução documentada e VS Code; manifestos npm/lock e Playwright pela descoberta padrão das ferramentas; requirements pelo bootstrap/CI; README/AGENTS e arquivos ocultos por suas convenções. `scripts/*.py` permanece como interface CLI estável, inclusive para procedimentos fora do repositório. `supabase/` mantém a convenção da CLI. Nenhum arquivo operacional será tratado como código a mover.

## Plano de compatibilidade e validação

- Atualizar imports Python, patches de testes e `BASE_DIR` ao mover infraestrutura. Manter reexports de `main.py` usados pelos testes e fábricas de rotas.
- Atualizar HTML, rota `/login`, Tailwind, scripts npm, fixture HTTP, CI, testes e links Markdown. `/`, `/login` e APIs públicas permanecem iguais; URLs dos auxiliares mudam com o HTML e recebem hash de conteúdo.
- Preservar IDs, classes, ARIA, `data-*`, handlers inline, estado e mensagens. Utilitários extraídos seguem o padrão UMD/CommonJS já usado pelo projeto.
- Não alterar regras de comparação, normalização, anotação, exportação, persistência ou dados brutos.
- Executar build, sintaxe, Python isolado, Node, mypy, scanner de credenciais, E2E desktop/mobile, acessibilidade, foco/teclado, movimento reduzido, caminhos e perfil de desempenho. Acrescentar casos reproduzíveis de concorrência e repetir E2E conforme solicitação do usuário.
- Verificar o CI por SHA após cada push; comparar hashes dos dados protegidos e comprovar que o diff local preexistente continua fora dos commits.

## Linha de base disponível

`node --test tests/test_*.cjs`: 120 testes aprovados antes de editar código. A execução Python isolada foi iniciada e será registrada com resultado e eventuais limitações no relatório final. Os resultados das fases seguintes não são antecipados neste documento.
