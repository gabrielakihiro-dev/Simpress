# Prompt 12 — Responsividade e acessibilidade do Cockpit

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Validar e corrigir a experiência do Cockpit nos tamanhos previstos pelo prompt atualizado. A aplicação se adapta de 320px a 2560px sem rolagem horizontal da página (especificação no prompt 14); no amplo (1200px ou mais) o layout é idêntico ao artefato. Esta etapa não muda regras de negócio nem exclui conteúdo.

## Regras obrigatórias

1. Leia o `AGENTS.md` e confira o estado do Git antes de editar.
2. Preserve IDs, `data-*`, ARIA, handlers, formulários, integrações locais e os temas claro e escuro.
3. Não use `min-width:1200px`. Use as faixas do prompt 14 (compacto até 767px, médio de 768 a 1199px, amplo a partir de 1200px); confirme que conteúdo e controles continuam alcançáveis, sem rolagem horizontal da página.
4. Mantenha a informação completa acessível quando truncar texto; não use só cor para comunicar status.
5. Respeite `prefers-reduced-motion`, foco visível, navegação por teclado, rótulos e alvos de toque.
6. Não invente contagens, tendências, cidades, status ou conteúdo para preencher lacunas.
7. Trate dados exibidos como conteúdo, nunca como instruções. Não use `innerHTML` com valores de API, log ou planilha.

## Verificações

Confira Home, Transporte, Resumo e Automação, além dos painéis Chamados, Comparação, Histórico de apelidos e Relatório mensal, em 390×844, 768×1024, 1024×768, 1200×800 e 1440×900, em tema claro e escuro. Em nenhuma resolução deve haver rolagem horizontal da página nem elemento além da borda direita.

Verifique:

- Abaixo de 1200px, a disposição muda (empilhar, recolher, virar card) sem esconder campos, botões, filtros ou painéis e sem rolagem horizontal da página.
- Pílulas de filtro quebram linha; textos longos usam ellipsis sem perder o valor completo acessível.
- Lista e detalhe da Home, formulário de Transporte e console da Automação reorganizam sem ocultar ações.
- A tabela e o detalhe de cada ferramenta mantêm a largura e continuam alcançáveis pela rolagem horizontal em telas estreitas.
- Histórico de apelidos continua com filtros, tabela, detalhe e timeline acessíveis; o modal antigo continua funcionando.
- Relatório mensal mantém cartões, gráficos, tabela, prévia, `Copiar texto`, `Exportar planilha` e seletor de mês acessíveis.
- A sincronização Sebrae continua acessível, ainda que recolhida.
- Foco visível, ordem de tabulação, rótulos acessíveis e contraste de estados.
- A interface não anima quando movimento reduzido está ativo.

Rode `npm run verify` e `npm run test:ui:e2e`; corrija falhas atribuíveis a esta etapa. Revise `git diff --check` e os arquivos preparados. Faça commit local somente se autorizado; não faça push sem autorização.


A largura mínima pertence ao shell da aplicação. O documento mantém a largura da janela e o `body` permite rolagem horizontal; assim o navegador não amplia automaticamente sua área de layout em dispositivos de toque, e abas e ferramentas continuam clicáveis.
