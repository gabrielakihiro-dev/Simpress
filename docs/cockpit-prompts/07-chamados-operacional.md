# Especificação atual: tela Chamados com importação e gestão (30/10/2026)

Esta seção vale no lugar do layout "lista + detalhe" descrito mais abaixo. O painel `Chamados` (`section[data-cockpit-tool-panel="chamados"]`, `F5`) passa a concentrar o fluxo que antes vivia no modal `Acompanhamento de chamados`. Mantêm-se os KPIs, a busca, a `Relação` e a tabela de OS por série (cards no mobile) com a linha expansível `Andamento`.

## Composição (de cima para baixo)

1. Triagem diária (`#cockpit-tickets-triage`, a fila de trabalho) à esquerda e KPIs (`#cockpit-tickets-kpis`: Séries, Conferidas, Divergentes, Só Simpress, Só Oracle) à direita, como legenda `Relação entre as fontes`, na mesma altura a partir de 1200 px (redesenho de 01/11/2026); abaixo disso a triagem vem primeiro.
2. Triagem diária (`#cockpit-tickets-triage`): quatro botões-filtro com contagem da importação inteira (`Ativos`, `3+ dias`, `Sem data`, `Atualizados <3 dias`, mesma regra de `SimpressTicketRules.grupoTriagemChamado`) e uma linha de resumo (`N ativos de M séries · K sem chamado aberto no Oracle`). `aria-pressed` marca o filtro ativo; clicar de novo limpa. Fica à esquerda dos KPIs a partir de 1200 px.
3. Barra de ferramentas (`.ck-barra-ferr`): filtros à esquerda (`Buscar série ou OS`, `Relação`, `Atenção · 3+ dias`, `Limpar filtros`) e ações à direita (`Exportar Excel`, `Importar e gerenciar`).
4. Bloco recolhível `Importação e versões` (`details#cockpit-tickets-manage-panel`, fechado por padrão; resumo mostra a versão em uso). `Importar e gerenciar` abre o bloco, rola até ele e foca o primeiro campo de arquivo. Dentro: links `Oracle` e `Simpress` (abrem em nova aba), formulário com os dois arquivos (`Simpress · Acompanhamento de Pedidos`, `Oracle · Gestão de Solicitações`) e `Importar planilhas`, `Versão em uso`, `Excluir importações antigas` e `Comparação com a importação anterior`.
5. Tabela de OS por série. A linha expandida `Andamento` ganha o que só existia no modal: Fila/Fase, endereço, atendimento, status Simpress/Oracle, OS, previsão e etapas do pedido, linha do tempo da série e anotação com autosave (campo `Próxima ação ou o que já foi feito`, até 2.000 caracteres). Cada linha mostra, por CSS, a faixa e as etiquetas `3+ dias` e `Sem data` (de `data-triagem`) e a relação (de `data-relacao`); a coluna `Chamado` é a única marcada `Manual` (campo UTIC vazio, salvo ou `Automático · Dashboard`; `Salvar` e `Remover vínculo` recolhidos até o foco, o hover ou dispositivo sem hover, sempre no DOM); o `Andamento` abre em duas colunas (`.ck-os-andamento`) a partir de 1200 px; abaixo de 1200 px as linhas viram cartões que começam por Série e OS.

Espaçamento: blocos separados por `--espaco`/gap de 12 a 16 px; rótulos e valores em linhas distintas nos cards; nada de texto colado em botões ou KPIs. Abaixo de 760px os botões quebram em grade e a tabela vira cards; 320 a 2560px sem rolagem horizontal; temas claro e escuro pelos tokens existentes; transições de 150 a 300 ms com `prefers-reduced-motion`.

## Decisão: seletor `Versão em uso`

A tabela de OS sempre mostra a importação mais recente (é a fonte operacional). `Versão em uso` só escolhe qual importação alimenta `Exportar Excel` e a `Comparação com a importação anterior`; ele não troca KPIs, triagem nem tabela. A legenda do seletor deixa isso claro. Importar nova planilha seleciona a mais nova.

## Dados e efeitos

Mesmas APIs de antes (`/api/operacoes/chamados`, `/snapshot/{id}`, `/evolucao`, `/historico/antigas`, `/importar`, `/exportar`, `/linha-do-tempo/...`). Importar atualiza tabela, KPIs, triagem, Home (cartão de chamados abertos) e prontidão, e mostra o aviso `Acompanhamento de chamados atualizado.`. Exportar usa `Planilha Exportada com Sucesso!`. O modal antigo continua acessível só por `abrirChamadoDaOs` até ser removido no passo seguinte.

Correção na Home (02/11/2026): o cartão `Chamados abertos` combina as OS do Oracle com os chamados da série obtidos em `GET /api/sebrae/novos`. Uma falha apenas do Sebrae preserva as OS e mostra o alerta `Não foi possível consultar os chamados do Sebrae. Os resultados do Oracle foram preservados.`; a contagem recebe `consulta parcial` (`Consulta parcial` sem OS). A mensagem `Nenhum chamado aberto para esta série.` exige consulta bem-sucedida às duas fontes. A correção é somente de consulta e apresentação, sem escrita ou exclusão de dados locais/externos.

## Redesenho visual da aba OS (F6, 01/11/2026)

Autorizado pelo usuário em 01/11/2026. Hoje o painel `[data-cockpit-tool-panel="chamados"]` é a aba **OS** (F6); `Chamados` (F5) é o painel Sebrae (AGENTS.md, "Navegação do Cockpit e atalhos (31/10/2026)"). Escopo: só CSS e apresentação em `static/styles/ck-cockpit.css`, `static/js/ui/data-panels.js` e `static/js/features/cockpit-tool-panels.js` (classes e atributos); sem regra de negócio, endpoint, rotina nem escrita nova no SoftExpert, SharePoint ou Excel; `static/index.html` não muda.

- Composição: a triagem (`#cockpit-tickets-triage`) fica à esquerda e os KPIs (`#cockpit-tickets-kpis`) viram a legenda `Relação entre as fontes` à direita; a barra separa filtros (Buscar, Relação, Atenção, Limpar filtros) das ações (Exportar Excel, Importar e gerenciar). O cabeçalho da tabela fica fixo (`position: sticky`) a partir de 1200 px; abaixo de 1200 px as linhas viram cartões que começam por Série e OS. A coluna `Chamado` é a única marcada `Manual`.
- Textos novos aceitos pelo usuário em 01/11/2026 (gerados por CSS): `Relação entre as fontes`, `Conferida`, `Divergente`, `Só Simpress`, `Só Oracle` (iguais a `relationLabels`), `3+ dias`, `Sem data`, `Manual`, `Automático · Dashboard`, `Nenhuma OS importada. Use Importar e gerenciar para enviar as planilhas Simpress e Oracle.` e `Nenhuma OS corresponde aos filtros. Use Limpar filtros.`.
- Atributos novos, aditivos: `data-estado` no cartão `.ck-os` (`carregando`, `vazio`, `erro`, `pronto`); `data-origem` no `.ticket-os-link-editor` (valor de `origem` de `GET /api/operacoes/chamados/vinculos-os`); `aria-invalid` no campo UTIC quando o número é inválido.
- Compatibilidade: textos aprovados antes, IDs, `data-*` e handlers não mudam. A regra de 30/10/2026 continua valendo: série sem OS vinculada (nem na Simpress nem no Oracle) some por completo da aba (`#cockpit-tickets-os`), sem linha, KPI nem opção de filtro `Sem OS` e sem o sufixo de contagem; só a exibição muda, o relatório do servidor e o histórico seguem guardando `sem_os`.
- Escritas da aba, sem acréscimo: `PUT /api/operacoes/chamados/vinculos-os`, anotação com autosave e importação das planilhas; nada é escrito nem apagado em sistemas externos.

## Busca, paginação e toque na aba OS (F6, 07/11/2026)

Correção dos achados da auditoria da aba OS (07/11/2026). Só apresentação em `static/js/ui/data-panels.js`, `static/js/features/cockpit-tool-panels.js` e `static/styles/ck-cockpit.css`; sem regra de negócio, endpoint nem escrita nova; IDs, `data-*` e ARIA anteriores não mudam.

- Busca (`Buscar série ou OS`): procura em `data-busca` de cada linha, que traz série, número da OS, usuário, hostname, modelo (`simpress.modelos` do relatório) e o UTIC já vinculado (`UTIC-AAAA-N` e só o número), sem acento nem maiúscula. Descrição, fonte e rótulos de botões (`Salvar`, `Andamento`…) não entram mais na busca. O filtro espera 150 ms depois da última tecla, e a contagem anunciada (`aria-live`) só muda nessa hora.
- Paginação: sem termo de busca a tabela mostra 25 OS por vez, com `Carregar mais` e `Mostrando N de M` (os mesmos textos e classes `.sebrae-mais` da aba Chamados, F5; bloco `[data-os-mais]`); com termo, mostra todas as que casam. Mudar busca, Relação, Atenção ou triagem volta à primeira página; recriar a tabela (vínculo salvo) mantém a página. Quando o botão some, o foco vai para a primeira OS nova. A contagem do cabeçalho é sempre do total filtrado, e a linha `Andamento` só aparece para séries na página. Abrir uma OS pela Home ou pela aba Chamados (`abrirChamadoDaOs`) amplia a página até a linha (`revelarLinhaOs`); se ela estiver escondida pelo filtro, limpa os filtros antes.
- Números com separador de milhar (`1.000 OS · 1.000 séries`, `formatNumber`).
- Altura dos controles: a busca, a Relação, os botões da barra e os da tabela seguem a altura do desenho (`min-height: 0`, sem o mínimo global de 40/48 px); em tela de toque (`pointer: coarse`) eles, os botões `Andamento` e os números da OS têm alvo de 44 px.

---

# Histórico: prompt 7 original


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
