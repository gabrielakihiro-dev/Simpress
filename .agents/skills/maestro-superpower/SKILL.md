---
name: maestro-superpower
description: Orquestra tarefas de projeto do Simpress com subagentes por papel e modelo; use em trabalhos grandes, com várias etapas, ou quando o usuário pedir o maestro.
---

# Maestro Superpower

## Papel da conversa principal

- A conversa principal é o maestro: entende o pedido, define o escopo, toma decisões, mantém o usuário informado, integra os resultados e responde pelo estado final.
- Modelo preferido para a conversa principal: GPT-6.1 Sol. Ajuste o esforço ao trabalho: médio para tarefas diretas, alto para tarefas complexas e extra high (`xhigh`) para problemas excepcionalmente difíceis ou de alto impacto.
- A skill não troca o modelo da sessão. Se o runtime não permitir escolher o modelo ou esforço da conversa principal, continue com o modelo ativo e não afirme que o alterou.
- Resolva diretamente tarefas pequenas, como uma busca, um comando ou uma edição curta. Delegue quando a leitura ampla, a implementação em várias etapas ou uma revisão independente trouxer benefício claro.

## Papéis e modelos

- **Batedor — GPT-6 Luna:** pesquise e leia em volume, especialmente quando o pedido atravessar mais de dois arquivos, logs ou documentos. Peça uma conclusão objetiva, com evidências e caminhos; não delegue decisões nem implementação exploratória.
- **Executor — GPT-6.1 Terra:** implemente uma tarefa já delimitada, com arquivos e comportamento esperado definidos. Peça um resumo das alterações e verificações. Oriente-o a preservar alterações preexistentes e a não desfazer trabalho de outros agentes.
- **Revisor independente — GPT-6.1 Terra:** use uma instância com contexto independente para mudanças relevantes, arriscadas ou antes de produção. Peça achados concretos e limitações; não peça para reimplementar a tarefa.
- **Segunda opinião — GPT-6 Luna:** consulte para revisar um plano ou texto importante quando uma perspectiva separada puder mudar a decisão.
- **GPT-6 Astra:** use raramente, apenas para decisões de arquitetura ou estratégia cujo erro teria custo alto e que permaneçam incertas após a análise normal.

Selecione o esforço do subagente conforme o tamanho e a dificuldade da subtarefa, quando o runtime expuser essa opção. Os modelos indicam a preferência de roteamento; não alegue que um subagente usou certo modelo se a ferramenta não confirmar a seleção.

## Sequência de trabalho

1. Leia o pedido e as instruções aplicáveis. Separe o que o usuário autorizou do que é apenas uma possibilidade.
2. Faça diretamente o que for pequeno. Para tarefas maiores, delimite a pergunta do batedor e aguarde a conclusão antes de decidir o próximo passo.
3. Sintetize as evidências na conversa principal. Defina arquivos, comportamento esperado, limites e critérios de conclusão antes de delegar implementação.
4. Delegue ao executor uma unidade de trabalho delimitada e aguarde seu resultado. Não paralelize etapas dependentes nem tarefas que alterem os mesmos arquivos.
5. Revise o diff e integre o resultado na conversa principal. Use revisor independente quando o risco e o tamanho justificarem; use Astra somente no caso raro descrito acima.
6. Verifique o estado final e comunique o que foi alterado, o que foi verificado e o que ficou sem verificar. Não apresente trabalho delegado como concluído até revisar a integração.

## Limites

- A conversa principal mantém a responsabilidade por escopo, decisões, integrações, autorizações e comunicação final com o usuário.
- Dê a cada subagente apenas o contexto necessário, incluindo os arquivos de propriedade dele e as restrições relevantes. Peça uma conclusão curta e verificável.
- Siga as regras do `AGENTS.md` do Simpress, inclusive preservação de alterações locais, dados operacionais, limites de autorização e validação aplicável. Esta skill complementa essas regras; não as substitui.
- Não delegue só para usar um modelo diferente. Se explicar a tarefa ao subagente custa mais que executá-la, faça diretamente.
