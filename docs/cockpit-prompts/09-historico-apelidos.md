# Prompt 9 — Histórico de apelidos (painel operacional)

Cole este prompt no agente de código com o repositório Simpress aberto.

> **Desvio aprovado pelo usuário (31/10/2026):** o modal `#modal-historico-apelidos` e o handler `abrirModalHistoricoApelidos` foram removidos. O painel F8 absorveu filtros, **Somente com ação disponível**, **Limpar filtros** e as ações **Restaurar anterior**, **Excluir aviso** e **Restaurar e excluir**; o botão da Home abre o painel. A regra 6 abaixo deixou de valer; a paginação do modal também saiu (a lista rola).

## Objetivo

Criar o painel `Histórico de apelidos` no grupo Ferramentas dos nove pontos, com atalho `F7`, seguindo o mesmo molde das outras ferramentas: KPIs, filtros, tabela densa e detalhe lateral. O modal atual continua disponível nos controles que já o abrem.

## Regras obrigatórias

1. Leia `AGENTS.md`, confira o estado do Git e inspecione `domains/alias_changes.py`, `static/js/features/alias-history.js`, `#modal-historico-apelidos` e `routers/aliases.py` antes de editar.
2. Reaproveite o endpoint local `/api/historico-alteracoes`, os eventos existentes e suas regras. Não crie um cadastro paralelo nem um endpoint novo para duplicar o histórico.
3. Calcule `Alterações neste mês` e `Equipamentos afetados` por evento/série únicos, usando a data e o tipo reais. `Fora do padrão` e `Apelidos duplicados` saíram do painel em 11/11/2026 (ver "Desvio aprovado (11/11/2026)"); não crie uma regex ou regra de negócio visual para eles. Se faltar evidência, mostre `—`/indisponível.
4. Preserve os tipos de evento existentes: apelido/hostname, usuário logado, endereço de instalação e aviso do Endpoint. O painel pode priorizar apelidos, mas filtros/timeline não podem ocultar outras categorias que hoje aparecem no histórico.
5. Mantenha a regra atual que só permite desfazer ou restaurar o evento mais recente e reversível do campo; avisos do Endpoint e registros de endereço seguem suas regras específicas. `Restaurar anterior` deve chamar a ação existente apropriada, pedir confirmação quando o fluxo atual pede e atualizar a tela apenas após sucesso.
6. Preserve `#modal-historico-apelidos`, seus IDs, filtros, paginação, carregamento, erros, vazio, ações e o handler `abrirModalHistoricoApelidos` para botões antigos, inclusive o controle do detalhe na Home. O novo item do menu usa ID próprio e abre o painel; não duplique IDs nem quebre o retorno de foco do modal.
7. A ação `Exportar` exporta os registros atualmente filtrados. Reaproveite exportação existente se houver; caso contrário, faça download local no cliente, sem gravar histórico ou chamar serviço remoto, escapando valores que poderiam ser interpretados como fórmulas por uma planilha.
8. Séries, nomes e apelidos são dados não confiáveis. Renderize valores por APIs seguras do DOM; nunca interpole conteúdo do histórico em HTML.

## Adaptação visual

- Cabeçalho do painel (`#cockpit-alias-kpis`, `role="group"`): KPIs `Alterações neste mês` e `Equipamentos afetados`, mais o botão `Exportar CSV` (`#cockpit-alias-export`), que baixa o conjunto filtrado. Não exiba números fixos nem classifique sem regra confirmada.
- Abas por tipo (`#cockpit-alias-tabs`, `role="tablist"`): Todos, Apelido, Usuário, Endereço e Avisos do Endpoint (`#cockpit-alias-tab-<tipo>`, `data-alias-type`), cada uma com a contagem. A contagem das abas acompanha a busca, o `Somente com ação disponível` e o período. As abas comandam o filtro de tipo: o `<select id="cockpit-alias-type">` continua oculto e sincronizado, e é a fonte da verdade. `←`/`→` (com volta ao fim ou ao início) e `Home`/`End` movem entre as abas.
- Barra de filtros: busca `#cockpit-alias-search`, período como controle segmentado (`#cockpit-alias-filters`, `.ck-segmentado`, botões `data-alias-period` = `todos` ou `7dias`, com `aria-pressed` e contagens `#cockpit-alias-count-all` e `#cockpit-alias-count-7days`), `Somente com ação disponível` (`#cockpit-alias-actions-only`) e `Limpar filtros` (`#cockpit-alias-clear`, que também devolve a aba para Todos).
- Uma cor por tipo, sempre com o rótulo em texto, nos temas claro e escuro: Apelido azul, Usuário roxo, Endereço verde-água, Aviso laranja.
- Lista à esquerda (`#cockpit-alias-list`), agrupada por dia: `Hoje · quarta, 11/11`, `Ontem · terça, 10/11` e depois `Segunda, 09/11`, cada título com a contagem do grupo; registros de data inválida vão por último em `Data indisponível`. Cada linha mostra a etiqueta do tipo, a série, a hora `HH:MM`, o valor antigo riscado → o novo, `Origem`, `Autor` e o selo `Ação disponível`; a linha de aviso do Endpoint mostra `motivo · valor`. Use apenas valores presentes ou classificações existentes; fontes possíveis incluem Simpress, Manual, Rotina de OS, Sincronização e Endpoint Central somente se o evento identificá-las. Em desktop, o detalhe ocupa 380–420px à direita.
- O detalhe (`#cockpit-alias-detail`) tem, em ordem: cabeçalho (etiqueta, data, série e ações: `Abrir na Home`, `Restaurar anterior`, `Restaurar e excluir` / `Excluir aviso`, ou a nota de que não há ação); `O que mudou`, com `Antes` e `Depois` lado a lado (o aviso mostra uma caixa com o motivo); `Cadastro atual`, com `Apelido atual`, `Modelo`, `Local` e o botão `Copiar apelido atual`; `Detalhes do registro`, só com os campos preenchidos; e `Histórico deste equipamento (n)`, do mais novo para o mais antigo, com o registro selecionado marcado.
- Ações `Abrir na Home` e `Restaurar anterior` usam navegação/handlers atuais. Se o evento não for restaurável, deixe a ação indisponível com explicação acessível. Não altere histórico automaticamente ao selecionar linha.
- O item Ferramentas `Histórico de apelidos` abre o painel e fica ativo com F7; o modal legado continua aberto pelos botões que já dependem dele. A tela usa os tokens Nocturne, tema claro/escuro, seleção visível e texto além da cor.
- O menu dos nove pontos mantém Chamados `F5`, Comparação `F6`, Histórico de apelidos `F7` e Relatório mensal `F8`; badge opcional só quando o contrato fornecer contagem correta.

## Validação e entrega

1. Confirme que `F7` e o clique no menu abrem o painel e focam o título; confirme separadamente que os acionadores antigos ainda abrem o modal e devolvem o foco à origem.
2. Valide KPIs, filtros, exportação filtrada, seleção/detalhe, timeline, copiar, abrir na Home, restauração elegível, estados vazio/erro e paginação com fixtures locais.
3. Abaixo de 1200px, mantenha `min-width:1200px` no app e rolagem horizontal para o layout completo, conforme o prompt Cockpit atualizado. Não corte controles nem dados.
4. Atualize os testes pertinentes sem usar ou modificar o histórico operacional real. Rode `npm run verify` e `npm run test:ui:e2e`; revise `git diff --check`.
5. Revise o diff e faça commit local apenas se houver autorização na conversa atual. Não faça push sem autorização explícita.

## Relato final

Informe as mudanças visuais e o acesso pelo menu, confirme que os filtros e ações originais foram preservados e liste os testes realmente executados. Indique qualquer comportamento que dependa de dados locais indisponíveis.

## Desvio aprovado pelo usuário (etapa A, item 7)

`#cockpit-alias-refresh` (botão só ícone `Atualizar histórico`) foi removido em 31/10/2026: o histórico de apelidos recarrega sozinho sempre que a aba é aberta (e ao restaurar o estado salvo), igual à Comparação.

## Desvio aprovado pelo usuário (etapa E, item 8)

O modal legado `Histórico de alterações` ocupa até 90vw × 90vh (`min(90rem, 100vw − 2rem)` × `min(90vh, 60rem)`); só a lista rola. A regra `.ck-veu > .ck-dialogo.alias-history-panel` em `ck-cockpit.css` vence o `height:auto` genérico dos diálogos. Em telas estreitas (< 480px) ou baixas (< 600px) o diálogo inteiro rola e a lista deixa de ter rolagem própria (mínimo 12rem), sem cortar toolbar nem rodapé.

## Desvio aprovado (11/11/2026)

O painel F7 foi reorganizado por pedido do usuário em 11/11/2026 ("Sim, aplicar sempre com base no artefato"), seguindo o artefato https://claude.ai/artifact/6wWuMH8a7VhKDBjPyFnxf9. Só mudou a apresentação; o conteúdo dos registros e as regras não mudaram.

**O que mudou**

1. Abas por tipo `#cockpit-alias-tabs` (Todos, Apelido, Usuário, Endereço, Avisos do Endpoint), cada uma com a contagem. Decisão deliberada: a contagem de cada aba segue a busca, o `Somente com ação disponível` **e** o período. As abas comandam o filtro de tipo; o `<select id="cockpit-alias-type">` fica oculto e sincronizado, e continua sendo a fonte da verdade. As setas `←`/`→` (com volta) e `Home`/`End` navegam entre as abas.
2. Uma cor por tipo, sempre acompanhada do rótulo em texto, nos temas claro e escuro: Apelido azul, Usuário roxo, Endereço verde-água, Aviso laranja.
3. Lista agrupada por dia (`Hoje · quarta, 11/11`, `Ontem · terça, 10/11`, `Segunda, 09/11`, com a contagem do grupo; data inválida por último, em `Data indisponível`), no lugar da tabela. A linha traz etiqueta do tipo, série, hora `HH:MM`, antigo riscado → novo, `Origem`, `Autor` e o selo `Ação disponível`; o aviso do Endpoint mostra `motivo · valor`.
4. Detalhe em blocos: cabeçalho com ações, `O que mudou` (`Antes` e `Depois`), `Cadastro atual` (com `Copiar apelido atual`), `Detalhes do registro` (só campos preenchidos) e `Histórico deste equipamento (n)` (mais novo primeiro, com o registro selecionado marcado).
5. O cabeçalho do painel tem os KPIs `Alterações neste mês` e `Equipamentos afetados` e o botão `Exportar CSV` (`#cockpit-alias-export`).
6. O período `Todas` / `Últimos 7 dias` virou controle segmentado (`.ck-segmentado`, `data-alias-period`). `Limpar filtros` também devolve a aba para Todos.

**DESVIO em relação ao que este prompt exigia (aprovado em 11/11/2026):** saíram os KPIs `Fora do padrão` e `Apelidos duplicados`, as 2 pílulas desabilitadas dessas classificações e a nota `#cockpit-alias-data-note`. Eles só existiam como indisponíveis, porque o projeto não tem regra nem fonte confiável para classificar apelido fora do padrão ou duplicado; não recrie essas peças nem invente a regra.

**IDs novos ou alterados:** `cockpit-alias-tabs` e `cockpit-alias-tab-todos|apelido|usuario|endereco|aviso_endpoint`; `cockpit-alias-kpis` (agora só com 2 KPIs); `cockpit-alias-filters` (agora `.ck-segmentado`); `cockpit-alias-type` (oculto, sincronizado). **Removido:** `cockpit-alias-data-note`. Os demais IDs (`cockpit-alias-search`, `-count-all`, `-count-7days`, `-actions-only`, `-clear`, `-export`, `-list`, `-detail`, `-heading`) seguem iguais.

**O que não mudou:** as regras e confirmações das ações (`Restaurar anterior`, `Restaurar e excluir`, `Excluir aviso`); o CSV dos registros filtrados, com escape de fórmulas; o recarregamento ao abrir a aba; a ocultação das séries `VMWARE` e `GOOGLECLOUD`; o atalho F7; o DOM seguro (sem `innerHTML`); a API `/api/historico-alteracoes`.
