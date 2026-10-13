# Revisão de código — 12/10/2026

## Resultado

A revisão confirmou três falhas funcionais no acompanhamento de chamados e na consulta de disponibilidade. As correções e regressões foram publicadas em `origin/main` no commit [`3fb21ed`](https://github.com/gabrielakihiro-dev/Simpress/commit/3fb21edb78a8115ef475c4e36eafff63f06f9e40). O CI desse commit terminou com sucesso.

## Achados corrigidos

### Exportação durante a troca de versão

Ao selecionar outro snapshot, o objeto da versão anterior permanecia carregado durante a requisição. A interface podia exportar esse snapshot antigo enquanto o seletor já mostrava o novo.

A seleção agora desabilita a exportação até carregar a versão correspondente. A renderização só habilita o botão quando o identificador carregado coincide com o seletor, e a função de exportação verifica esse contrato antes de fazer a requisição. O teste E2E mantém a resposta pendente, confirma que nenhuma exportação é enviada e valida que, após o carregamento, a exportação usa o novo `snapshot_id`.

### Comparação após limpar a seleção

Selecionar “Nenhuma importação” limpava os dados do snapshot, mas mantinha na tela a comparação da versão anterior. A seleção vazia agora cancela as leituras relacionadas, limpa o modelo e mostra “Nenhuma importação selecionada.” no painel de evolução. O teste confirma que a contagem antiga deixa de aparecer.

### Respostas concorrentes de disponibilidade

Uma consulta antiga de prontidão podia terminar depois da mais recente e sobrescrever seu resultado. Seu bloco `finally` também podia remover `aria-busy` enquanto a consulta atual ainda estivesse em andamento.

A consulta agora usa um request gate e um `AbortSignal`. Respostas, erros e `finally` só atualizam a interface se ainda pertencerem à requisição atual. O E2E retém duas respostas, libera primeiro a antiga e confirma que o estado permanece ocupado e pronto até a resposta atual terminar.

## Validação

- `python -B tests/run_tests.py`: 354 testes aprovados.
- Testes JS do workflow do CI: 134 aprovados. Uma fixture antiga de exportação foi alinhada para selecionar o snapshot carregado e fornecer uma linha exportável; a suíte foi reexecutada e passou integralmente.
- E2E focados de prontidão e chamados: 16 aprovados em desktop e mobile.
- Suíte E2E completa: 49 aprovados, incluindo acessibilidade, responsividade e perfil de transições.
- `npm run build:ui`: aprovado; os assets gerados não apresentaram alterações.
- Mypy: aprovado em 40 arquivos; `compileall`, sintaxe JavaScript e verificação de credenciais também passaram.
- `npm audit --audit-level=moderate`: zero vulnerabilidades.
- `git diff --check`: aprovado.
- GitHub Actions [run 38285200994](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/38285200994): `ui-browser`, `verify (3.12)` e `verify (3.14)` concluídos com sucesso.

## Escopo e limites

O commit de correção alterou `static/app.js` e adicionou cobertura em `tests/e2e/first-access.spec.cjs`, `tests/e2e/ticket-requests.spec.cjs` e `tests/frontend/test_inventory_ui_flows.cjs`. Dados dos testes são sintéticos; esta revisão não incluiu autenticação real, banco conectado, deploy, Firefox/WebKit ou aparelho físico. Não restaram falhas reproduzidas neste escopo.
