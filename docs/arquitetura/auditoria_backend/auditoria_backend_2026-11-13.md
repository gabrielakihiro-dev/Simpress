# Auditoria do backend: 13/11/2026

Terceira rodada sobre o backend, depois de [auditoria_backend_2026-10-15.md](auditoria_backend_2026-10-15.md) e da [auditoria técnica de 17/10/2026](../auditoria_tecnica_2026-10-17.md). Esta rodada é só de leitura: nenhum arquivo de código, dependência ou dado foi alterado.

## 1. Escopo, método e limites

- **Linha de base:** commit `5fbc124` (`main`, 13/11/2026).
- **Áreas revisadas:** `main.py`, `core/`, `domains/`, `routers/`, `security/`, os scripts maiores de `scripts/`, `scripts/verify.cjs`, `.github/workflows/ci.yml`, `package.json` e os documentos de arquitetura.
- **Método:**
  - leitura dirigida dos módulos citados;
  - busca por padrões (`grep`) e métricas por AST (tamanho de funções, `except Exception` sem log nem `raise`, chamadas bloqueantes dentro de `async def`), com um script local que não foi versionado;
  - releitura, no código atual, de cada item pendente das auditorias de 15/10 e 17/10.
- **Não verificado nesta rodada:**
  - `npm run test:ui:e2e`;
  - `npm audit` e `pip-audit` (vulnerabilidades de dependências);
  - o comportamento com uma pasta do OneDrive real;
  - os testes próprios de `motor_ia/`;
  - o corpo completo de alguns helpers de `routers/sebrae_dashboard.py` e de `build_readiness_report`, lidos só por amostragem.

## 2. Resumo

O backend está mais saudável do que em 17/10:

- `main.py` caiu de 3.356 para 2.454 linhas.
- O código passou a remover os temporários órfãos do histórico.
- O normalizador de rótulos é único.
- A camada de domínio não usa mais `HTTPException`.
- Toda chamada a `/api/` passou a exigir o cookie da sessão local.

Não há falha crítica ou alta confirmada. Os pontos que mais pesam agora são estruturais:

- um módulo de domínio voltou a importar routers;
- três fábricas de router concentram de 549 a 998 linhas cada;
- 29 blocos `except Exception` não registram nada;
- e-mails corporativos, um login pessoal e o endereço de um OneDrive pessoal continuam como padrão no código;
- os scripts maiores, que tocam sistemas externos, ficam fora do mypy;
- a CI não roda em PR que só mexe em documentação.

## 3. Situação dos itens anteriores

| Item | Situação em 13/11 | Evidência |
| --- | --- | --- |
| N1 Temporários órfãos do histórico | Corrigido no código | `core/integrity.py:428-441` e `scripts/cleanup_local_temps.py` removem os órfãos (commit `23136ee`); o `logger.warning` só aparece quando a remoção falha. Não observado em uso real. |
| N2 Normalizador de rótulos duplicado | Resolvido | `domains/history_export.py:10` importa `_comparison_source_text_for_display` de `domains/inventory_comparison.py`; não há segunda cópia. |
| N3 `HTTPException` em `domains/` | Resolvido | Nenhum uso; resta só uma menção em docstring (`domains/ticket_import.py:6`). Os erros de domínio ficam em `core/errors.py`. |
| N4 / B10 `main.py` monolítico | Parcial | 2.454 linhas (eram 3.356). Parte da lógica migrou para as fábricas de router, que cresceram (achado 3 abaixo). |
| N5 Exportação sem as variantes de rótulo | Resolvido | A exportação usa o mesmo normalizador da tela (ver N2). |
| N6 Listas fixas na CI | Resolvido | `scripts/verify.cjs` varre `tests/frontend/test_*.cjs` e faz `node --check` por varredura. |
| N7 / M3 Custo do parse perto do teto | Parcial | Limites recalibrados: `MAX_XLSX_UNCOMPRESSED_BYTES = 192 MB` (`core/config.py:62`) e `MAX_XLSX_WORKSHEETS = 128` (`:64`), com um parse por vez (`MAX_CONCURRENT_WORKBOOK_PARSERS = 1`, `:51`). Ler só a aba e as colunas usadas continua pendente. |
| N8 `[object Object]` nos erros do front | Resolvido | `static/js/shared/api-errors.js` centraliza a leitura do `detail`; o padrão `new Error(data.detail)` não aparece mais em `static/js`. |
| N9 Contrato da API desatualizado | Não reconferido | `main.py` e `routers/` têm 175 decoradores de rota; a comparação rota a rota com `docs/arquitetura/CONTRATOS_API_BACKEND.md` não foi refeita nesta rodada. |
| N10 Wiring por dicionários e imports entre camadas | Resolvido em parte | O wiring por `_exports` saiu, mas ainda há imports de funções privadas e um domínio que importa routers (achado 1). |
| N11 Restos no repositório | Resolvido | `persistence/` e `Backup_Banco/` não existem mais. Sobra nova: achado 9. |
| N12 Tipagem incompleta | Parcial | O mypy estrito cobre `core/`, `domains/` e `security/`; `routers/` e `main.py` ficam no modo gradual; os scripts maiores, fora (achado 5). |
| M1, M2, B1 a B4, B6, B8, B9 (15/10) | Seguem resolvidos | Situação da seção 7 de 15/10 reconferida no código atual. |
| B5 (15/10) | Aceito | Sem mudança. |
| B7 (15/10) Dados pessoais no código | Parcial | O contato da retirada saiu do código (`core/config.py:102-105`: variáveis `SIMPRESS_TRANSFER_ORIGIN_*` ou `config/contato_origem.json`, ignorado pelo Git). Os e-mails das contas de login e de envio, o login padrão do Endpoint Central e a URL da pasta do Dashboard continuam fixos (achado 4). |
| Passo 6 do roteiro (anotações) | Resolvido | `AnnotationReadError` separa "ilegível" de "inválido" (`domains/history_annotations.py:332`) e `_load_cache` guarda a listagem por tamanho e `mtime_ns` (`:339`). |
| Passo 7 do roteiro (prontidão sem lock global) | Resolvido | `domains/readiness.py:3` lê sem o lock `.atomic-transactions`, com cache por assinatura de arquivos. |
| 409 para `FileBusyError` | Confirmado | `security/local_requests.py:381` converte a exceção em 409 nas rotas sem mapeamento próprio. |

## 4. Métricas (código de produção)

Contagem feita em `main.py`, `core/`, `domains/`, `routers/` e `security/`.

| Medida | Valor |
| --- | --- |
| Funções e métodos | 2.374, dos quais 40 passam de 100 linhas |
| Maiores funções | `create_sebrae_dashboard_router` 998 linhas (`routers/sebrae_dashboard.py:176`), `create_inventory_history_router` 798, `create_operations_router` 549, `load_database_unlocked` 358 (`domains/inventory_state.py:229`), `build_history_export_workbook` 334, `comparison_history_for_display` 316, `LocalRequests.__call__` 250 |
| `except Exception` | 125 pela AST (126 por busca de texto); 29 sem log nem `raise` |
| Anotações no estilo antigo (`Dict[`, `List[`, `Optional[`) | 1.995 linhas, contra 48 com `X \| None` |
| `global` / `type: ignore` / `TODO` | 17 / 10 / 0 |
| `print(` / `except:` sem tipo / E/S bloqueante dentro de `async def` | 0 / 0 / 0 |

## 5. Achados

Gravidade: alta, média ou baixa, pelo impacto se o problema se manifestar. Certeza: confirmado (visto no código) ou provável.

### 5.1 Confirmados

**1. Domínio importa routers (regressão de camadas).** Média, confirmado.
- Evidência: `domains/assistant_api.py:37-38` importa `routers.local_setup` e `routers.transfers`. Em 17/10 nenhum módulo de `domains/` dependia de `routers/`.
- `domains/` também carrega `scripts/` por `import_module` (`domains/endpoint_lookup.py:14-15`, `domains/ux_chamados_browser.py:13` e `domains/chrome_ocioso.py:75`), o que liga a camada de domínio às rotinas do Chrome de automação.
- Também: `routers/inventory_history.py:13` importa `_history_display_files` e `routers/operations.py:43` importa `_serial_key`, funções privadas de outros módulos.
- Impacto: mudar uma rota pode quebrar o Assistente (F9); cria risco de import circular.
- Solução: mover para `domains/` as funções que o Assistente usa desses routers e tornar públicas (sem `_`) as funções importadas de fora.

**2. Exceções engolidas sem registro.** Média, confirmado.
- Evidência:
  - `routers/sebrae_dashboard.py:259`, `:823`, `:1019` e `:1078` engolem a exceção sem log (valor padrão, `return`, valor alternativo e `pass`, respectivamente), todos com `noqa: BLE001`;
  - `domains/endpoint_lookup.py` tem nove fallbacks sem log (`:27`, `:36`, `:100`, `:212`, `:328`, `:346`, `:396`, `:404` e `:448`);
  - os módulos `domains/ux_*` repetem o padrão.
- Impacto: uma falha real na importação do Dashboard ou numa consulta ao Endpoint some sem rastro, e o diagnóstico depende de reproduzir o erro.
- Solução: `logger.debug` (ou `warning`, quando muda o resultado) com o tipo da exceção, sem mensagem nem dado pessoal, como `core/logging_setup.py` já faz. Nos fallbacks do Playwright, um `debug` basta.

**3. Fábricas de router gigantes.** Média, confirmado.
- Evidência: `create_sebrae_dashboard_router` com 998 linhas, `create_inventory_history_router` com 798 e `create_operations_router` com 549 (seção 4).
- Impacto: as funções internas não são testáveis isoladamente, e toda mudança no Sebrae (F5) mexe num bloco de quase mil linhas. É a continuação natural do passo 10, que tirou peso do `main.py` mas o levou para as rotas.
- Solução: extrair para `domains/` a lógica que não depende de HTTP, como já foi feito com `domains/history_restore.py`, e deixar na fábrica só a validação do payload e a conversão de erros.

**4. E-mails, login padrão e URL de OneDrive pessoal fixos no código.** Média, confirmado.
- Evidência (os valores não são repetidos aqui):
  - padrões de `SIMPRESS_DASHBOARD_EMAIL` e `SIMPRESS_SOFTEXPERT_EMAIL` em `scripts/automacao_rotinas_chrome.py:82-83`;
  - padrão de `SIMPRESS_ENDPOINT_USUARIO` com um login pessoal em `scripts/automacao_rotinas_chrome.py:71`;
  - `DASHBOARD_PASTA_URL` em `scripts/automacao_rotinas_chrome.py:74-77` aponta para o OneDrive pessoal de outra pessoa, sem variável de ambiente;
  - `CONTAS_REMETENTE` em `domains/outlook_mail.py:38-39`;
  - os mesmos endereços aparecem em testes e em `docs/operacao/automacao-chrome.md`, `docs/planos/email-outlook-modelos.md` e `docs/guias/manual_usuario.md:158`.
- Impacto: dado pessoal versionado, contra a regra de LGPD do projeto. Também prende a rotina a pessoas específicas: outro operador precisa definir as variáveis, e a lista de remetentes do Outlook e a pasta do Dashboard não têm variável.
- Solução: o mesmo caminho do contato da retirada (B7): variável de ambiente ou arquivo local em `config/` ignorado pelo Git, com exemplo versionado, e padrão vazio no código. Trocar nos testes e nos docs por endereços fictícios. É decisão do responsável, porque muda o comportamento de quem não definir nada.

**5. Scripts grandes fora do mypy.** Baixa, confirmado.
- Evidência (`scripts/verify.cjs:86-98`): o mypy gradual cobre `core/`, `domains/`, `routers/`, `security/`, `main.py` e três scripts; o estrito (`--disallow-untyped-defs`) só `core/`, `domains/` e `security/`. Ficam fora do mypy (só passam pelo `compileall`) `automacao_rotinas_chrome.py` (2.759 linhas), `sebrae_softexpert.py` (1.816), `sebrae_excel.py` (922) e `verificar_usuarios_endpoint.py` (760), que tocam sistemas externos.
- Impacto: erros de tipo nas rotinas do Chrome de automação só aparecem em execução, em geral diante do sistema externo.
- Solução: incluir esses scripts no modo gradual; depois levar `routers/` ao modo estrito.

**6. CI não roda em PR só de documentação.** Baixa, confirmado.
- Evidência: `.github/workflows/ci.yml` tem `paths-ignore: ["docs/**", "**/*.md"]`, mas `tests/test_project_layout.py:67-78` confere os links relativos do `README.md` e de `docs/**/*.md`.
- Impacto: um link quebrado num PR só de docs passa sem aviso e quebra a CI do PR seguinte.
- Solução: tirar o `paths-ignore` ou criar um job leve que rode só `test_project_layout` quando mudarem `.md`.

**7. `motor_ia/` fora da verificação.** Baixa, confirmado.
- Evidência: o pipeline tem testes em `motor_ia/tests/`, mas nem `npm run verify` nem a CI os executam, e nenhum módulo do servidor importa `motor_ia`.
- Impacto: o código pode deixar de funcionar sem que ninguém perceba.
- Solução: incluir os testes no verify ou criar um `README.md` na pasta dizendo que é experimental e não mantido.

**8. Documento de locks cita módulo que não existe.** Baixa, confirmado.
- Evidência: `docs/arquitetura/auditoria_backend/hierarquia_de_locks.md:13` cita `_equipment_search_index_lock` em `persistence/postgres.py`, removido com o piloto de banco.
- Solução: atualizar a linha para o lock atual ou removê-la.

**9. Script sem uso.** Baixa, confirmado.
- Evidência: `scripts/_replace_sidebar.py` vem de um único commit (`baf17f0`) e nada o referencia.
- Solução: remover, depois de confirmar que não é usado à mão.

**10. Dependência sem versão exata.** Baixa, confirmado.
- Evidência: `package.json` declara `typescript` como `^6.0.3`; as demais dependências têm versão exata.
- Solução: fixar `6.0.3`.

**11. Link de documentação que dá 404.** Baixa, confirmado.
- Evidência: `iniciar_servidor.bat:95` mostra o endereço `/docs`, que responde 404 sem `SIMPRESS_ENABLE_DOCS=1`.
- Solução: mostrar o link só quando a variável estiver ligada.

### 5.2 Melhorias (sem falha)

- **Tipagem moderna:** trocar `Dict`, `List` e `Optional` por `dict`, `list` e `X | None` aos poucos, junto com mudanças no mesmo arquivo; ferramentas como `ruff --select UP` fazem isso de forma mecânica.
- **Estado global:** os 17 `global` e os 10 `type: ignore` merecem revisão no passo de tipagem (não foram analisados um a um nesta rodada).
- **Funções longas de domínio:** `load_database_unlocked` (358 linhas) e `comparison_history_for_display` (316) são as próximas candidatas a divisão, com testes de caracterização antes.

### 5.3 Pontos positivos de segurança (conferidos)

- Segredo da sessão local gerado com `secrets.token_urlsafe(32)` a cada início e comparado com `hmac.compare_digest` (`security/sessao_local.py`).
- Cookie `HttpOnly` e `SameSite=Strict`; sem cookie, 401; `Sec-Fetch-Site` de outro site, 403.
- Assistente: chave guardada com `repr=False`, máscara LGPD aplicada antes do envio, timeout de 60 s, três tentativas para 408, 429, 500, 502, 503 e 504 (`domains/assistant_openrouter.py:54`), e logs sem prompt nem resposta.
- Limite por minuto nas rotas que gastam créditos ou abrem o Chrome (`security/limite_taxa.py`).

## 6. Roteiro sugerido

Ordem por custo e risco. Cada passo é uma mudança pequena, com teste.

1. Achados 8, 9, 10 e 11 (limpeza; minutos cada).
2. Achado 2: log nos `except Exception` silenciosos de `routers/sebrae_dashboard.py` e `domains/endpoint_lookup.py`.
3. Achado 1: tirar de `domains/assistant_api.py` a dependência de `routers/` e tornar públicas as funções importadas.
4. Achado 6: CI também para PR só de documentação.
5. Achado 4: e-mails, login padrão e URL da pasta do Dashboard para configuração local, depois da decisão do responsável.
6. Achado 3: extrair a lógica de `create_sebrae_dashboard_router` para `domains/`, uma área por vez.
7. Achados 5 e 7: ampliar o mypy e decidir o destino de `motor_ia/`.
8. Pendência antiga N7/M3: ler só a aba e as colunas usadas, quando o inventário passar de uns 20 mil equipamentos.
