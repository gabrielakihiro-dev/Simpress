---
name: maestro-superpower
description: Orquestra tarefas de projeto do Simpress com subagentes por papel e modelo; use em trabalhos grandes, com várias etapas, ou quando o usuário pedir o maestro.
---

# Maestro Superpower

## Papel da conversa principal

- A conversa principal é o maestro: entende o pedido, define o escopo, toma decisões, mantém o usuário informado, integra os resultados e responde pelo estado final.
- Resolva diretamente tarefas pequenas, como uma busca, um comando ou uma edição curta em 1 arquivo. Delegue quando a leitura ampla, a implementação em várias etapas ou uma revisão independente trouxer economia de tokens ou qualidade clara.

## Maestro no Antigravity (AI Pro: exclusivamente Hydrogen, Neon e Carbon)

Use **exclusivamente** **Hydrogen**, **Neon** e **Carbon** (nunca use Flash nem 3.1 Pro). No `invoke_subagent`, passe `Model: "inherit"` (ou omita) para herdar o modelo ativo da sessão sem acionar Flash/3.1 Pro; no `/swarm`, selecione explicitamente os nomes reais via `swarm(action="models")`:

| Modelo e esforço | Equivalente Claude | Subagentes e uso |
|---|---|---|
| **Hydrogen (Low)** | Haiku 5.5 (leitura/busca) | `batedor`, `leitor-logs`, `conferente-glossario`, `auditor-dependencias`, `testador-acessibilidade`, `research` |
| **Hydrogen (Medium)** | Sonnet 5.5 (execuções diretas padrão) | `executor`, `testador`, `testador-e2e`, `front-react`, `refatorador`, `documentador`, `segunda-opiniao`, `browser` |
| **Hydrogen (High)** | Sonnet 5.5 (esforço alto) | `depurador` (causa raiz) e `executor` em execuções diretas multiarquivo ou lógica complexa |
| **Neon (High)** | Opus 5.5 (cirúrgico) | `revisor` (pré-PR), `implementador` (portal/SharePoint/OS/Endpoint), `auditor-seguranca`, 1ª passagem do `arquiteto` |
| **Carbon (High / xHigh)** | Fable 5.2 (escalonamento raro) | `arquiteto` (ou impasse de `implementador`/`depurador`) **somente quando o Neon (High) não conseguir resolver** |

- **Economia no plano AI Pro sem perder eficiência:**
  - Use **Hydrogen (Medium/High)** como motor das execuções diretas (mesmo papel do Sonnet no Claude) e **Hydrogen (Low)** para leituras, logs e checagens baratas.
  - Reserve **Neon (High)** para revisão crítica, segurança e código delicado, e acione **Carbon (xHigh)** apenas quando o Neon não resolver.
  - Reaproveite helpers e componentes existentes antes de criar código novo (estilo enxuto), sem cortar validações, segurança, acessibilidade ou testes.
  - Envie no `Prompt` apenas o recorte necessário (arquivos-alvo, restrições e critério de conclusão) e peça resposta curta e verificável.
  - Use `Workspace: "branch"` apenas quando houver risco de conflito de edição; mantenha `"inherit"` para leitores e revisores; não aninhe subagentes.

## Escala paralela com `/swarm`

- Para trabalhos grandes com 3+ frentes independentes ou quando o usuário invocar `/swarm`, siga a skill `swarm-simpress` (`.agents/skills/swarm-simpress/SKILL.md`): mapeie os modelos com `swarm(action="models")` usando apenas **Hydrogen**, **Neon** e **Carbon**, use `workspace: "share"` para autores paralelos e `"inherit"` para leitores, integre antes de `kill` e centralize o `npm run verify` no coordenador.

## Maestro no Codex

- Modelo preferido para a conversa principal no Codex: GPT-6.1 Sol (esforço médio, alto ou `xhigh` conforme complexidade; a skill não troca o modelo da sessão).
- Papéis e modelos Codex:
  - **Batedor — GPT-6 Luna:** leitura em volume (>2 arquivos/logs); conclusão objetiva com evidências e caminhos.
  - **Executor — GPT-6.1 Terra:** implementação delimitada; resumo de alterações e verificações; preservar alterações preexistentes.
  - **Revisor independente — GPT-6.1 Terra:** achados concretos e limitações em mudanças relevantes.
  - **Segunda opinião — GPT-6 Luna:** revisar plano ou texto importante.
  - **GPT-6 Astra:** apenas decisões raras de arquitetura/estratégia com alto custo de erro.

## Sequência de trabalho

1. Leia o pedido e as instruções aplicáveis. Separe o que o usuário autorizou do que é apenas uma possibilidade.
2. Faça diretamente o que for pequeno. Para tarefas maiores, delimite a pergunta do `batedor` e aguarde a conclusão antes de decidir o próximo passo.
3. Sintetize as evidências na conversa principal. Defina arquivos, comportamento esperado, limites e critérios de conclusão antes de delegar implementação.
4. Delegue ao `executor` ou especialista adequado uma unidade de trabalho delimitada e aguarde seu resultado. Não paralelize etapas dependentes nem tarefas que alterem os mesmos arquivos.
5. Revise o diff e integre o resultado na conversa principal. Use `revisor` ou `auditor-seguranca` (Neon High) quando o risco e o tamanho justificarem; use `arquiteto` (Neon High → Carbon xHigh se Neon não resolver) somente no caso raro de alto custo de erro.
6. Verifique o estado final e comunique o que foi alterado, o que foi verificado e o que ficou sem verificar. Não apresente trabalho delegado como concluído até revisar a integração.
7. No Antigravity, após `npm run verify` verde (e `npm run test:ui:e2e` se mexeu em UI) e revisão pelo `revisor`, faça commit, push e abra `#PR` automaticamente, acompanhe a `#CI` da `#PR` até ficar verde, faça `gh pr merge` (respeitando a ordem numérica de PRs abertos), acompanhe a CI da `main` e execute `git pull` na `main` do checkout principal.

## Limites

- A conversa principal mantém a responsabilidade por escopo, decisões, integrações, autorizações e comunicação final com o usuário.
- Siga as regras do `AGENTS.md` do Simpress, inclusive preservação de alterações locais, dados operacionais, limites de autorização e validação aplicável. Esta skill complementa essas regras; não as substitui.
- Não delegue só para usar um modelo diferente: se explicar a tarefa ao subagente custa mais que executá-la, faça diretamente.
