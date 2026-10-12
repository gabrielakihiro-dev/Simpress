# Resultado da Execução 03 — Confirmação correta do autosave

Data: 11/10/2026. Escopo: somente a etapa 03 do roteiro de correções.

## Defeito confirmado

Antes da correção, testes com promises e timers controlados reproduziram a sequência A → enviar A → B → A → falha da requisição original. O componente removia o rascunho e informava sucesso sem confirmar a edição atual. O mesmo problema acontecia com sucesso obsoleto. Um teste antigo aceitava essa falsa confirmação; foi substituído por regressões que exigem uma nova requisição e sua confirmação.

Também foram reproduzidas alterações de estado causadas por uma resposta antiga de outro campo e por uma resposta recebida depois de `dispose()` ou da remoção do elemento do DOM. Uma falha adicional da guarda de navegação na execução inicial era consequência das pendências deixadas pelos testes que reproduziam esses defeitos.

## Correção implementada

- Cada edição recebe uma revisão local monotônica por anotação. A igualdade do texto com uma requisição anterior não confirma essa revisão.
- A revisão atual tem um proprietário por anotação. Respostas e timers de outro campo, de um controlador descartado ou de um elemento removido não alteram o rascunho compartilhado, o estado de salvamento ou a guarda de navegação.
- A conclusão de uma operação obsoleta mantém o rascunho e dispara o envio da edição atual, inclusive A → B → A quando o debounce já terminou durante a operação anterior.
- Uma resposta válida de uma operação anterior do mesmo campo pode fornecer as revisões-base da próxima edição. Ela não confirma a edição mais recente. Respostas inválidas não fornecem essas bases.
- O corpo JSON é lido e validado antes da confirmação. Em campos com protocolo de revisões, a resposta precisa incluir a revisão enviada entre as revisões reconhecidas ou apresentar um conflito com suas revisões. JSON inválido, confirmação vazia, falha explícita e confirmação de outra revisão preservam o rascunho. Conflitos não aparecem como sucesso.
- Novas edições geram novas tentativas imutáveis; retries de uma mesma edição e recuperação de uma tentativa persistida mantêm seu identificador, conforme a Execução 01.
- O reenvio automático depende de uma edição posterior à requisição concluída. Falhas definitivas da edição atual mantêm o botão de retry e não criam loops de reenvio.
- Foram preservados o debounce de 500 ms, o envio imediato no blur, três retries com intervalos de 500/1.000/2.000 ms, mensagens de salvamento local/sincronização pendente, resolução explícita de conflitos e guarda de navegação.

## Arquivos desta execução

| Arquivo | Alteração |
| --- | --- |
| `static/js/shared/history-annotation-autosave.js` | Controle da revisão atual, proprietário, ciclo de vida, confirmação e reenvio. |
| `tests/frontend/test_history_annotation_retries.cjs` | Regressões determinísticas de A → B → A, atraso no JSON, campos duplicados, desmontagem, debounce, HTTP 409 e confirmações inválidas. |
| `tests/frontend/test_annotation_version_ui.cjs` | A confirmação simulada da resolução de conflito retorna o identificador efetivamente enviado. |
| `tests/support/serve_ui_motion_preview.py` | A fixture de PUT retorna confirmação explícita e a revisão recebida, compatíveis com o contrato do backend. Escrita permanece somente em memória. |
| `tests/e2e/ui.spec.cjs` | Regressões de A → B → A com requisições controladas e relógio do navegador. |
| `docs/desenvolvimento/resultado_execucao_03_2026-10-11.md` | Registro da implementação, validação e limites. |

Alterações preexistentes e arquivos não rastreados foram preservados. Não houve commit, push, deploy, instalação de dependências, limpeza de dados nem reinicialização do servidor operacional. O backend e os rótulos do histórico não foram alterados.

## Validação realizada

- **114 testes JavaScript aprovados**, abrangendo todos os nove arquivos `tests/test_*.cjs`. Incluem retries, falha definitiva, retry manual, sucesso, sincronização pendente, conflitos, recuperação de rascunhos, bases causais, respostas fora de ordem, dois campos para a mesma anotação, componentes descartados/removidos e ausência de loops.
- **21 testes Python aprovados** em `test_annotation_revisions.py`, validando o protocolo existente com fixtures temporárias.
- **10 testes Playwright aprovados**, em Chromium desktop e mobile. Quatro execuções cobrem as novas regressões A → B → A: falha de rede e sucesso obsoleto em cada viewport. As demais cobrem autosave na fixture, Central de Pendências e exibição de anotações na evolução. A Central de Pendências também passou pela auditoria axe prevista no teste existente.
- Os testes de navegador usam o frontend real, a fixture isolada na porta 8765 e respostas fictícias/interceptadas. As regressões inspecionam rascunho em `localStorage`, estado pendente, bases da nova requisição e remoção somente após a confirmação atual. O relógio avança mais cinco segundos após o sucesso para verificar ausência de reenvio adicional.
- `node --check` aprovado no módulo de autosave e no arquivo E2E alterado; `git diff --check` aprovado.

Comandos:

```powershell
$jsTests = @(Get-ChildItem tests/test_*.cjs | ForEach-Object { $_.FullName })
node --test --test-reporter=dot @jsTests
& .\.venv\Scripts\python.exe -B -X utf8 -m unittest discover -s tests -p test_annotation_revisions.py
$env:PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
& .\node_modules\.bin\playwright.cmd test tests/e2e/ui.spec.cjs --grep 'annotation|central pending' --project=desktop --project=mobile
node --check static/js/shared/history-annotation-autosave.js
node --check tests/e2e/ui.spec.cjs
git diff --check
```

A tentativa inicial do Playwright no ambiente restrito não produziu saída e foi interrompida. A execução com permissão para iniciar Chromium e a fixture local terminou com os dez testes aprovados.

## Limites e riscos restantes

Não foram executados a suíte Python completa, a suíte E2E completa, PostgreSQL, sincronização real com OneDrive ou testes entre computadores. A disputa entre campos foi verificada no controlador com elementos simulados; as regressões E2E exercitam a sequência A → B → A na interface real.

O proprietário local coordena campos dentro da mesma instância do módulo. Abas e computadores distintos continuam dependendo do protocolo de revisões e conflitos do backend. Falhas de acesso ao armazenamento local continuam sujeitas ao tratamento já existente; esta etapa não altera a política de persistência do navegador.

A Execução 04 não foi iniciada.
