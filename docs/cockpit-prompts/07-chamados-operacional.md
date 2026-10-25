# Prompt 7 — Chamados (painel operacional)

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Preencher o painel `Chamados` preparado no Prompt 2 e aberto em `Ferramentas` (`F5`) com um painel operacional inspirado na captura: indicadores no topo, lista filtrável à esquerda e detalhe do chamado selecionado à direita. Chamados não aparece como aba na navegação principal.

## Regras obrigatórias

1. Leia `AGENTS.md`, verifique `git status` e localize o fluxo atual de acompanhamento de chamados antes de editar.
2. Reaproveite os registros, APIs locais, snapshots, histórico e handlers já existentes. Não crie um segundo cadastro nem uma fonte paralela.
3. A captura define a composição visual. Os números, séries, nomes, cidades, prazos, técnicos, estados e textos nela são exemplos; nunca os grave como dados do produto.
4. Não invente um prazo de 5 dias, contagem de atrasados, média de fechamento, total concluído no mês ou outra métrica. Calcule cada uma apenas se os campos e a regra de negócio existentes permitirem. Se não houver dados suficientes, mostre `—` e explique que a métrica não está disponível, ou omita o indicador.
5. Mantenha o fluxo local FastAPI e os contratos atuais. Não adicione chamadas remotas, gravação em portal, alteração de status, novos endpoints de escrita ou mudanças de agendamento.
6. Os botões da referência, como `Copiar cobrança` e `Marcar concluído`, só podem acionar uma função local já existente e autorizada. Se não houver ação equivalente, não simule sucesso nem altere o status; oculte o controle ou deixe-o indisponível com uma explicação acessível.
7. Preserve a tela/modal atual de acompanhamento, importações Simpress e Oracle, histórico, filtros, exportação, linha do tempo, anotações e integrações Sebrae. O novo painel é outra forma de consultar os mesmos dados.
8. Mantenha todos os IDs, `data-*`, ARIA e handlers existentes. Use texto seguro (`textContent` ou helpers de texto) para conteúdo vindo de chamados, logs ou planilhas.

## Layout do painel

- Use o painel de ferramenta preparado no Prompt 2. O item `Chamados` do menu funciona como `menuitem`, fecha o menu ao abrir o painel e move o foco para seu título; `F5` aciona o mesmo destino. Não crie uma segunda navegação de abas no cabeçalho.
- No topo, use KPIs para Abertos, Atrasados 5+ dias, Tempo médio até fechar e Concluídos no mês. Só calcule atrasos/tempo se a regra de prazo e as datas reais estiverem confirmadas; não some categorias sobrepostas.
- Na barra de filtros, apresente Todos, Atrasados 5+ d, Aguardando, Em atendimento e Concluídos com contagens reais. À direita, mostre `Atualizar do portal` e `Novo chamado`: use o fluxo local existente para atualização; `Novo chamado` leva à Home, sem criar um chamado automaticamente.
- A área principal tem uma lista à esquerda e o detalhe do registro selecionado à direita. Na lista, apresente apenas campos que existam nos registros atuais: número do chamado/OS, tipo, série, unidade, abertura, tempo desde atualização e estado.
- Os filtros `Todos`, `Atrasados`, `Aguardando`, `Em atendimento` e `Concluídos` devem refletir os estados reais e a classificação usada pelo projeto. Não crie estados novos para fazer a captura parecer completa.
- O detalhe mostra cabeçalho com ID, status e link de portal somente quando já houver URL no registro. A grade apresenta apenas campos existentes (Série, Aberto em, Colaborador, Técnico, Parado há e Prazo); `Andamento` usa eventos do histórico em ordem cronológica.
- Exiba o aviso de atraso somente quando confirmado. `Copiar cobrança` monta texto a partir do ID, tipo, série, unidade e dias parado do registro atual. `Marcar concluído` só aparece se já houver handler local autorizado e confirmação adequada; não escreva em portal nem altere status por aparência.
- A seleção de linha deve ser visível, acessível por teclado e abrir o detalhe correspondente. Estados sem registro mostram uma mensagem clara, não uma tabela preenchida com dados fictícios.
- Preserve o tema escuro e o tema claro. Use os tokens Nocturne; badges usam as cores semânticas existentes para estados.

## Responsividade e acessibilidade

- Mantenha `min-width:1200px` no app. Abaixo disso, a página pode rolar horizontalmente para preservar a composição completa; não esconda colunas ou ações.
- Em desktop, mantenha lista e detalhe lado a lado; a coluna de detalhe segue o padrão de 380–420px.
- Dê nomes acessíveis aos filtros, à seleção atual, aos estados e aos botões. Preserve foco visível, navegação por teclado e `prefers-reduced-motion`.

## Integração e validação

1. Confirme no código qual endpoint/modelo abastece cada indicador e coluna; anote o mapeamento. Se um campo não existir, não o derive de um texto aproximado.
2. Reaproveite o histórico real para preencher a linha do tempo. Confirme que registros antigos sem evento continuam legíveis.
3. Adicione testes para filtros, valores ausentes, seleção/detalhe, estados vazios e ausência de ações de escrita fictícias.
4. Rode `npm run verify` e `npm run test:ui:e2e`. Verifique o painel em tema claro/escuro em 1200px ou mais e confirme rolagem horizontal acessível abaixo desse limite.
5. Revise o diff e `git diff --check`. Faça commit local apenas se autorizado na conversa atual; não faça push sem autorização explícita.

## Relato final

Informe os arquivos alterados, o mapeamento de dados usado, quais indicadores ficaram disponíveis ou indisponíveis e os testes executados. Distinga o que foi confirmado do que depende de um campo ou ação ainda inexistente.
