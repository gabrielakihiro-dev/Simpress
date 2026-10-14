# Prompts da revisão sênior — 14/10/2026

Seis prompts independentes, para executar em ordem, um por sessão. Cada um assume que o anterior foi mergeado.

## Regras gerais

- Seguir o `AGENTS.md`; rótulos e anotações do Histórico de Planilhas não podem regredir.
- Um commit por prompt, em branch própria, com testes passando antes do commit.
- Não alterar testes baseados em regex sem migrar o código correspondente.
- Se algo divergir do descrito, parar e relatar antes de seguir.

## Modelo e esforço de raciocínio recomendados

Use GPT-6.1 Sol nos seis prompts e ajuste o esforço conforme a dificuldade:

| Passo | Nível recomendado | Motivo |
| --- | --- | --- |
| 1 — Linha de base e exceções | Média (`medium`) | Dá margem para classificar falhas e corrigir casos sem elevar o custo em tarefas de diagnóstico. |
| 2 — XLSX, event loop e caches | Alta (`high`) | Exige raciocínio cuidadoso sobre I/O, concorrência, rollback e testes de não bloqueio. |
| 3 — Linters e CI | Leve (`low`) | Predomina configuração mecânica e mudanças delimitadas; aumente para média se surgirem conflitos no CI. |
| 4 — Modularização | Alta (`high`) | Coordena mudanças de frontend, backend, contratos e testes sem alterar comportamento. |
| 5 — CSP e XSS | Extra alta (`xhigh`) | É uma revisão de segurança com várias superfícies e validação de payloads; priorize cobertura e análise cuidadosa. |
| 6 — Funcionalidades | Média (`medium`) para filtros salvos; alta (`high`) para linha do tempo, diff e perfis; extra alta (`xhigh`) para concorrência multiusuário ou integração direta por API. | Ajuste o esforço à funcionalidade específica, mantendo uma por PR. |

GPT-6.1 Sol aceita `low`, `medium`, `high` e `xhigh`; `medium` é o padrão. Os níveis mais altos favorecem análise mais completa, com maior latência e uso de tokens. A recomendação segue o [guia oficial de raciocínio da OpenAI](https://developers.openai.com/api/docs/guides/reasoning).

## Passo 1 — Linha de base de testes e erros silenciosos

**Contexto:** projeto Simpress (FastAPI + `static/app.js`). Antes de refatorar, é necessária uma linha de base confiável e o fim das falhas silenciosas.

**Tarefas:**

1. Prepare o ambiente com `python -m pip install -r requirements-postgres.txt`. Em uma sessão anterior, `python -B tests/run_tests.py` falhou com “Form data requires python-multipart”; confirme se é apenas dependência ausente no ambiente local e, se `python-multipart` não estiver em `requirements*.txt`, adicione. Depois rode `python -B tests/run_tests.py` e os testes JS listados em `.github/workflows/ci.yml`. Registre resultado (passou/falhou, contagens) como linha de base.
2. Liste todos os `except Exception` e `except:` em `main.py`, `core/`, `domains/`, `persistence/` e `routers/` (há cerca de 44). Classifique cada um: (a) legítimo e já registra o erro, (b) engole o erro (`pass`, `return None`, `continue`), (c) amplo demais. Exemplo conhecido de (b): `main.py` por volta da linha 583 (`return None` ao localizar a aba da planilha).
3. Para cada caso (b) e (c), troque por exceções específicas (`OSError`, `KeyError`, `zipfile.BadZipFile`, `ValueError` etc.) e use `logger.warning/exception` com contexto (nome do arquivo, papel da planilha), sem dados pessoais nem conteúdo de células. Se o retorno `None` fizer parte do contrato, mantenha-o, mas registre o motivo.
4. Para cada alteração, adicione um teste que force a falha e verifique o log e o comportamento.

**Critérios de aceite:** suíte igual ou maior que a linha de base; nenhum `except Exception` que engula erro sem log; tabela de classificação anexada em `docs/desenvolvimento/`. Não mude comportamento visível ao usuário.

## Passo 2 — Parsing de planilhas fora do event loop e carregamento seguro

**Contexto:** `main.py` chama `openpyxl.load_workbook` diretamente em vários pontos (linhas aproximadas 506, 563, 966, 1280, 1602, 1620 e 3640), em vez de `core.xlsx_safety.load_workbook_safely`. Rotas `async def` (por exemplo, `atualizar_planilhas` e `atualizar_planilhas_endpoint`) podem executar parsing pesado e síncrono no event loop. Existe `core/async_workers.py`.

**Tarefas:**

1. Leia `core/xlsx_safety.py` e `core/async_workers.py` e documente o que cada um garante (limite de tamanho, entradas descompactadas, XML externo, comentários encadeados).
2. Substitua todos os `openpyxl.load_workbook` diretos em código de produção por `load_workbook_safely` (ou por um wrapper único em `core/`), preservando os parâmetros `read_only` e `data_only` usados em cada ponto. Se algum ponto não puder usar o wrapper, justifique em comentário.
3. Garanta que nenhuma rota `async def` execute parsing ou I/O pesado de planilha no event loop: mova-o para `asyncio.to_thread`/`async_workers` ou converta a rota para `def` quando não houver `await` necessário. Preserve a idempotência (`idempotency_key`) e o token de preview.
4. Troque o `deepcopy` dos três caches em `main.py` (por volta da linha 241) por troca atômica de referência a um snapshot imutável, mantendo o rollback atual em caso de falha.
5. Adicione testes: planilha malformada/zip bomb rejeitada e um teste que prove que uma atualização longa não bloqueia uma requisição de busca concorrente.

**Critérios de aceite:** suíte verde (Python, JS, E2E), mypy do CI verde, sem `openpyxl.load_workbook` fora do wrapper e uma nota curta com medição antes/depois da latência de busca durante uma atualização.

## Passo 3 — Linters e escopo de tipos no CI

**Contexto:** o CI (`.github/workflows/ci.yml`) roda testes, mypy com lista explícita de arquivos e `node --check`, mas não tem linter nem formatador.

**Tarefas:**

1. Adicione `ruff` (configuração em `pyproject.toml` ou `ruff.toml`): comece com regras E, F, B, S (bandit), UP e I; ignore apenas o necessário e justifique cada ignore. Rode `ruff check` e corrija somente o que for seguro e mecânico; o restante entra em baseline (`per-file-ignores`) para evitar um diff gigante.
2. Adicione ESLint (configuração flat) para `static/**/*.js` com `no-undef`, `no-unused-vars`, `eqeqeq` e `no-implied-eval`; defina os globals do navegador e do lucide. Use a mesma política de baseline.
3. Inclua os dois como passos do job `verify` no CI, antes dos testes.
4. Amplie a lista do mypy para arquivos ainda fora dela, sem exigir correção total; use `# type: ignore[codigo]` pontual apenas onde inevitável.
5. Documente os comandos locais no README.

**Critérios de aceite:** CI verde nas matrizes 3.12 e 3.14, sem reformatar arquivos inteiros e com diff de código de produção mínimo.

## Passo 4 — Modularizar app.js e main.py incrementalmente

**Contexto:** `static/app.js` tem cerca de 5.000 linhas (41 `fetch`, 53 `innerHTML`), `main.py` cerca de 4.200 linhas com caches globais. Já existem `routers/`, `domains/` e `static/js/shared/`. O `index.html` tem 79 handlers `onclick` inline. Parte dos testes lê `app.js` por regex.

**Regra de execução:** uma área por PR, na ordem busca → transferência → chamados → histórico. Não faça tudo de uma vez.

**Tarefas por área:**

1. **Frontend:** extraia o código da área para `static/js/<area>/*.js` (ES modules ou o padrão que o build `scripts/build/copy_ui_assets.cjs` já suporte; verifique antes). Crie um helper único `fetchJson` em `static/js/shared/` (CSRF, erros padronizados, `AbortSignal`) e use-o na área. Troque os `onclick` da área por `addEventListener` com `data-action`.
2. Atualize em conjunto os testes que leem `app.js` por regex (migrando para testar comportamento ou apontar para o novo arquivo) e acrescente os novos arquivos ao `node --check` do CI.
3. **Backend:** para a área equivalente, mova funções de `main.py` para `domains/` (regra de negócio) e `routers/` (HTTP), sem mudar rotas, schemas ou respostas (consulte `docs/arquitetura/CONTRATOS_API_BACKEND.md`). Substitua `global` mutável por um objeto de estado injetado.
4. Preserve as regras do `AGENTS.md` (rótulos e anotações do histórico) e os fluxos já corrigidos em 12/10 (request gate de prontidão, exportação por snapshot).

**Critérios de aceite por PR:** suíte Python, JS e E2E (desktop e mobile) verdes; zero mudança de comportamento; `app.js`/`main.py` menores; atualização da memória de backlog estrutural.

## Passo 5 — Content-Security-Policy e redução de innerHTML

**Contexto:** `security/middleware.py` já define `cache-control: no-store` e `x-content-type-options: nosniff`, mas não há `Content-Security-Policy`. O frontend usa `innerHTML` em cerca de 53 pontos e dados de planilha/anotação são entrada não confiável. Pré-requisito: passo 4 concluído (sem `onclick` inline).

**Tarefas:**

1. Audite cada `innerHTML`/`insertAdjacentHTML` em `static/`: classifique como template estático, dado escapado ou dado não escapado. Corrija os não escapados e prefira `textContent`/`createElement`. Adicione teste com payloads (`<img onerror>`, `"><script>`) em hostname, série, local, apelido e anotação, no app e nas exportações.
2. Remova scripts e estilos inline restantes; se algum for inevitável (por exemplo, tema antes do paint), use nonce por resposta.
3. Adicione CSP no middleware, primeiro em modo `Content-Security-Policy-Report-Only` com `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'` e as origens estritamente necessárias (verifique CDNs/lucide/fontes). Depois de rodar o E2E sem violações, ative o modo de bloqueio. Acrescente `Referrer-Policy`, `Permissions-Policy` e `X-Frame-Options` se ainda faltarem.
4. Estenda `scripts/check_hosted_security.py` para validar esses cabeçalhos e adicione testes no CI.

**Critérios de aceite:** E2E e testes de acessibilidade verdes, sem violações de CSP no console; teste de XSS passando; documento curto com as origens permitidas e o motivo de cada uma.

## Passo 6 — Funcionalidades complementares, uma por vez

**Contexto:** com o código estabilizado (passos 1–5), implementar as funcionalidades abaixo, uma por PR, nesta ordem. Cada uma deve respeitar o `AGENTS.md` (rótulos e anotações), ter testes e documentação em `docs/`.

**Fila por complexidade:**

1. **Baixa:** filtros salvos e busca por localidade com contador de resultados.
2. **Baixa:** exportação do histórico em PDF/CSV, com os rótulos padronizados e as anotações incluídas.
3. **Baixa:** painel de saúde (data do último import, idade dos dados e falhas recentes).
4. **Média:** linha do tempo por série (mudanças de local e status entre importações).
5. **Média:** diff visual entre dois snapshots do histórico.
6. **Média:** alertas de “sem acesso há 7 dias ou mais” (e-mail ou webhook), com agendamento e opt-in.
7. **Média:** perfis (leitor/operador/admin) e trilha de auditoria de anotações e alterações.
8. **Alta:** concorrência multiusuário nas anotações com resolução de conflito.
9. **Alta:** integração direta por API em vez de planilhas e dashboard analítico.

Para a funcionalidade indicada (começando pela 1), proponha primeiro um desenho curto (rotas, modelo de dados, impacto no frontend e riscos) e espere aprovação antes de codar. Depois implemente com testes unitários, de contrato de API e E2E, e atualize o README.
