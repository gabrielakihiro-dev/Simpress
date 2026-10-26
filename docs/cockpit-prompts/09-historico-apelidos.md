# Prompt 9 — Histórico de apelidos (painel operacional)

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Criar o painel `Histórico de apelidos` no grupo Ferramentas dos nove pontos, com atalho `F7`, seguindo o mesmo molde das outras ferramentas: KPIs, filtros, tabela densa e detalhe lateral. O modal atual continua disponível nos controles que já o abrem.

## Regras obrigatórias

1. Leia `AGENTS.md`, confira o estado do Git e inspecione `domains/alias_changes.py`, `static/js/features/alias-history.js`, `#modal-historico-apelidos` e `routers/aliases.py` antes de editar.
2. Reaproveite o endpoint local `/api/historico-alteracoes`, os eventos existentes e suas regras. Não crie um cadastro paralelo nem um endpoint novo para duplicar o histórico.
3. Calcule `Alterações no mês` e `Equipamentos afetados` por evento/série únicos, usando a data e o tipo reais. `Fora do padrão` e `Apelidos duplicados` só aparecem se o projeto já tiver uma regra e uma fonte confiável para isso; não crie uma regex ou regra de negócio visual. Se faltar evidência, mostre `—`/indisponível.
4. Preserve os tipos de evento existentes: apelido/hostname, usuário logado, endereço de instalação e aviso do Endpoint. O painel pode priorizar apelidos, mas filtros/timeline não podem ocultar outras categorias que hoje aparecem no histórico.
5. Mantenha a regra atual que só permite desfazer ou restaurar o evento mais recente e reversível do campo; avisos do Endpoint e registros de endereço seguem suas regras específicas. `Restaurar anterior` deve chamar a ação existente apropriada, pedir confirmação quando o fluxo atual pede e atualizar a tela apenas após sucesso.
6. Preserve `#modal-historico-apelidos`, seus IDs, filtros, paginação, carregamento, erros, vazio, ações e o handler `abrirModalHistoricoApelidos` para botões antigos, inclusive o controle do detalhe na Home. O novo item do menu usa ID próprio e abre o painel; não duplique IDs nem quebre o retorno de foco do modal.
7. A ação `Exportar` exporta os registros atualmente filtrados. Reaproveite exportação existente se houver; caso contrário, faça download local no cliente, sem gravar histórico ou chamar serviço remoto, escapando valores que poderiam ser interpretados como fórmulas por uma planilha.
8. Séries, nomes e apelidos são dados não confiáveis. Renderize valores por APIs seguras do DOM; nunca interpole conteúdo do histórico em HTML.

## Adaptação visual

- KPIs no topo: Alterações no mês, Equipamentos afetados, Fora do padrão e Apelidos duplicados. Não exiba números fixos nem classifique sem regra confirmada.
- Filtros em pílulas: Todas, Fora do padrão, Duplicados e Últimos 7 dias, com contagens reais. À direita, mostre a dica do padrão `PR + tipo + cidade + nº` somente se ela corresponder à regra já existente; `Exportar` baixa o conjunto filtrado.
- Tabela à esquerda: Data, Série, Apelido anterior → Novo apelido, Origem e Situação. Use apenas valores presentes ou classificações existentes; fontes possíveis incluem Simpress, Manual, Rotina de OS, Sincronização e Endpoint Central somente se o evento identificá-las. Em desktop, o detalhe ocupa 380–420px à direita.
- O detalhe mostra série, badge, modelo e local, apelido atual com ação de copiar, linha do tempo de todas as alterações do equipamento (anterior → novo, data, autor e origem) e nota quando estiver fora do padrão ou duplicado.
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
