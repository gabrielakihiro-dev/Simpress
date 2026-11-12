# Plano: ferramenta Lembretes substitui Termos

Especificação: `docs/cockpit-prompts/18-lembretes.md` (textos aprovados em 11/11/2026).

## Como executar

- Cada bloco roda numa **sessão nova**, cortada do branch do bloco anterior. O primeiro bloco sai do branch `claude/cockpit-lembretes-tab-design-e7b524`, que tem a especificação e este plano.
- Dentro da sessão, um `model-super-power:executor` faz o bloco.
- A sessão termina com commit local (sem push) e relatório: hash, arquivos, testes e linhas `AC: … — PROVEN BY …`. Depois para; não segue para o próximo bloco.
- Todo bloco termina com os testes verdes.
- Teto de 3 ciclos de correção por falha. Dúvida que muda o plano: parar e perguntar à sessão que escreveu o plano.

## Decisões fixadas

- **Migração sem dados:** Termos não grava nada; não há arquivo a migrar.
- **Formulários de termo:** mudam de painel com os mesmos IDs. Assim `termos.js`, `ck-termos.css`, o preenchimento da Home (`equipment-search.js:925`) e `tests/frontend/test_termos.cjs` seguem válidos.
- **Impressão do PDF:** não muda. `#termos-impressao` fica fora do painel (`static/index.html:731`), e a regra de impressão (`ck-termos.css:73`) usa `body > *`, não o painel.
- **Sub-abas:** um único dono, `termos.js`. `ORDEM_ABAS` passa a `["entrega", "devolucao", "lembretes"]`, mantendo o padrão `termos-aba-<nome>`. Assim as setas, Home e End seguem num lugar só. `lembretes.js` cuida só da lista e do diálogo.
- **Abertura do painel:** abre em `Lembretes`.
- **Testes na porta 8765:** a fixture `tests/support/serve_ui_motion_preview.py` monta o router real de `/api/lembretes` sobre uma pasta temporária, igual à Cobertura (`:530-566`).
- **Assistente:** só o texto da regra 37 (`domains/assistant_chat.py:118`) muda. Ele não lê `lembretes.json` e não ganha ferramenta.

## Bloco 1 — Backend

- **Objetivo:** guardar lembretes em `data/state/lembretes.json`.
- **Arquivos:** `domains/lembretes.py`, `routers/lembretes.py`, `main.py` (registro como `create_outlook_mail_router`, `main.py:1534`), `tests/test_lembretes.py`.
- **Contrato:**
  - Item: `{id, descricao, criado_em, alterado_em|null, concluido, concluido_em|null, origem: "entrega"|"devolucao"|null}`.
  - `GET /api/lembretes` → `{lembretes}`.
  - `POST` `{descricao, origem?}` → 201.
  - `PATCH /{id}` `{descricao?, concluido?}`.
  - `DELETE /{id}` → 204.
  - 404 para id desconhecido; 422 para descrição inválida (vazia, acima de 2000 caracteres ou com caractere de controle).
- **Critérios de aceite:**
  - Gravação com `lock_paths` + `atomic_write_json` (padrão de `domains/outlook_mail.py:207`).
  - `alterado_em` só muda se o texto mudar.
  - O log nunca leva a descrição.
  - Sem cookie → 401.
  - Contrato das 4 rotas em `docs/arquitetura/CONTRATOS_API_BACKEND.md` (rotas 206 a 209), exigido por `tests/test_api_contract_doc.py`; decidido em 11/11/2026 para o bloco terminar verde. O Bloco 4 só confere.
  - `\n` e `\t` na descrição dão 422, como qualquer caractere de controle (a lista e a edição usam campo de uma linha).
- **Verificar:** `pytest tests/test_lembretes.py` (CRUD, 404, 422, 401, editar igual, caplog sem a descrição).
- **Proibidos:** `static/**`, `frontend/**`, `domains/assistant*`.

## Bloco 2 — Painel Lembretes com os termos dentro

- **Objetivo:** criar a ferramenta `lembretes` e mover as sub-abas de termo para ela.
- **Arquivos:**
  - `frontend/partials/cockpit-tool-panels.html` (o conteúdo de :200-305 vai para `section[data-cockpit-tool-panel="lembretes"]`, mais a terceira pílula e a lista);
  - `static/index.html` (`#btn-lembretes`; `#btn-termos` passa a abrir `lembretes` na sub-aba Termo Entrega até o Bloco 4);
  - `cockpit-tool-panels.js` (`toolInfo`);
  - `termos.js` (`ORDEM_ABAS` e a abertura em Lembretes);
  - `static/js/features/lembretes.js` (novo; registrar em `static/app-entry.js:48` e `static/app.js:39`);
  - `static/styles/ck-lembretes.css` (novo);
  - `tests/support/serve_ui_motion_preview.py`;
  - `tests/e2e/lembretes.spec.cjs` (novo);
  - `tests/e2e/termos.spec.cjs`;
  - `tests/e2e/cockpit-layout.spec.cjs:365,372`.
- **Critérios de aceite:**
  - Pílulas e todos os estados e textos da especificação.
  - Chamadas via `app.apiFetch`.
  - Gerar PDF, Limpar e o preenchimento da Home funcionam como antes.
  - De 320 a 2560 px sem rolagem horizontal; claro e escuro; `prefers-reduced-motion` respeitado.
  - Nenhum `.md` nem dado pessoal em `static/**`.
- **Verificar:**
  - `npx playwright test tests/e2e/lembretes.spec.cjs tests/e2e/termos.spec.cjs tests/e2e/cockpit-layout.spec.cjs`.
  - `lembretes.spec.cjs` cobre: adicionar com Enter, vazio não adiciona, editar com Enter/Esc e "Alterado em", `Concluídos (n)`, excluir com confirmação, 320 px e tema escuro.
  - `node tests/frontend/test_termos.cjs`.
- **Proibidos:** outras ferramentas, `domains/**`, `routers/**` (exceto se o Bloco 1 tiver bug: parar e avisar).

## Bloco 3 — Termo → Lembrete

- **Objetivo:** botão `Criar lembrete` nos dois termos.
- **Arquivos:**
  - partial (botão nas barras);
  - `lembretes.js` (diálogo e função pura `montarDescricaoTermo(termo, dados)`);
  - `termos.js` (só expor a leitura dos campos já existentes, sem duplicar a lista);
  - `tests/frontend/test_lembretes.cjs` (novo);
  - `tests/e2e/lembretes.spec.cjs`.
- **Critérios de aceite:**
  - Modelo de texto exato, sem as partes vazias.
  - `montarDescricaoTermo` troca quebra de linha e tab (ex.: Observações, um `<textarea>`) por espaço e junta espaços repetidos, porque o backend recusa caractere de controle com 422 (decidido em 11/11/2026).
  - Sem nome ou série: só o aviso.
  - Nada é criado sem o clique; o POST leva `origem`.
  - Depois de criar: `Lembrete criado.` e `Ver em Lembretes`.
  - Gerar PDF segue igual.
- **Verificar:** `node tests/frontend/test_lembretes.cjs` (entrada, saída, campos vazios, limite) e o e2e do fluxo nos dois termos.
- **Proibidos:** a montagem do PDF (`termosMontarFolha`), `ck-termos.css`, `domains/**`.

## Bloco 4 — Assistente, docs e remoção de Termos

- **Objetivo:** concluir a migração removendo a ferramenta Termos.
- **Arquivos:**
  - `static/index.html` (remover `#btn-termos`);
  - `cockpit-tool-panels.js` (remover `termos` de `toolInfo`);
  - `tests/e2e/cockpit-layout.spec.cjs`;
  - `domains/assistant_chat.py:118` (regra 37: os termos ficam em Ferramentas > Lembretes) e `tests/test_assistant_termos.py`;
  - docs: `17-termos.md`, `AGENTS.md:93`, `14-cockpit-v2.md`, `14-responsividade-todas-resolucoes.md`, `15-assistente.md`, `CONTRATOS_API_BACKEND.md` (só conferir o contrato `/api/lembretes`, escrito no Bloco 1), `GLOSSARY.md` se citar Termos.
- **Critérios de aceite:**
  - `rg "btn-termos|tool-panel=\"termos\"" static frontend tests` vazio.
  - O Assistente não lê `lembretes.json`.
- **Verificar:** `pytest tests/test_assistant_termos.py`, o `rg` acima e o e2e de layout.
- **Proibidos:** `termos.js`, `lembretes.js`, partial (exceto remover o que sobrou do painel `termos`), demais regras do Assistente.

## Bloco 5 — Verificação final

- **Objetivo:** provar o conjunto.
- **Critérios de aceite:**
  - `npm run verify` e `npm run test:ui:e2e` verdes.
  - `model-super-power:revisor` sem achado grave em LGPD (descrição fora de log e do Assistente), escrita atômica e acessibilidade.
- **Verificar:** saídas dos dois comandos e relatório do revisor, no formato `AC: … — PROVEN BY …`.

## Bloco 6 — Assinatura do técnico no PDF (feito em 12/11/2026)

- **Objetivo:** o PDF dos termos traz a assinatura do técnico no bloco do técnico; o lado do colaborador não muda.
- **Arquivos:**
  - `routers/assinatura_tecnico.py` (novo) e `main.py` (registro);
  - `static/js/features/termos.js` (`termosGerarPdf` assíncrono) e `static/styles/ck-termos.css`;
  - `tests/test_assinatura_tecnico.py` (novo), `tests/support/serve_ui_motion_preview.py`, `tests/e2e/termos.spec.cjs`;
  - docs: `CONTRATOS_API_BACKEND.md` (rota 210), `17-termos.md`, `18-lembretes.md`.
- **Critérios de aceite:**
  - `GET /api/assinatura-tecnico` lê `data/state/assinatura_tecnico.svg` (fora do Git): 404 sem arquivo; 422 acima de 64 KB ou com `<script`, `on…=`, `javascript:`, `<foreignObject`, `href=` ou `<!ENTITY`; 200 `image/svg+xml` com `nosniff`, `no-store` e CSP `default-src 'none'`.
  - O PDF carrega a imagem por `<img>` (`decode()`, até 3 s); qualquer falha gera o PDF sem imagem. A requisição não leva nada do termo.
  - A imagem vai só no bloco do técnico, acima do rótulo, sem empurrar o layout. Segundo clique durante o carregamento é ignorado.
  - Assinatura real, nome do técnico e SVG real nunca entram em `static/**`, fixtures ou testes (só SVG sintético).
  - `test_termos.cjs` e as regras de privacidade seguem como estavam; a regra 37 do Assistente não muda (não descreve o PDF).
- **Verificar:** `python -m unittest tests.test_assinatura_tecnico`, `tests/test_api_contract_doc.py`, `npx playwright test tests/e2e/termos.spec.cjs`, `npm run verify` e `npm run test:ui:e2e`.
- **Proibidos:** assinatura real em qualquer arquivo versionado, `data/state` real, outros testes de privacidade.
