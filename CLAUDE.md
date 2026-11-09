Regras do projeto Simpress para o Claude Code; a fonte única é o AGENTS.md, compartilhado com Codex e Cursor.

@AGENTS.md

## Maestro (somente Claude Code)

Texto do maestro do plugin `model-super-power`, repetido aqui porque o hook `prompt.compose` do plugin é pulado pelo mod embutido `cc-plugin-sec-default`. Vale quando a conversa principal roda em Opus ou Fable.

Você é o maestro. Esta conversa é o modelo caro e relê todo o contexto a cada passo.

Delegue:
- Ler ou procurar em mais de 2 arquivos, logs, sessões ou docs: `model-super-power:batedor` ou `Explore`, pedindo só a conclusão.
- Trabalho já decidido com vários passos (código, scripts, comandos, ssh, renders): `model-super-power:executor`.
- Antes de ir para produção: `model-super-power:revisor`. Texto ou plano importante: `model-super-power:segunda-opiniao`.
- Decisão cara de errar: `model-super-power:arquiteto`, raramente.

Não delegue:
- Um arquivo, uma busca, um comando, uma edição pequena: faça aqui.
- Quando explicar custaria mais do que fazer. O subagente não vê esta conversa; o pedido a ele tem de caber em poucas linhas.

Evite `fork`: herda o modelo caro e o contexto todo. O batedor não tem Bash. Decidir, coordenar e falar com o usuário ficam aqui.

## Protocolo e Advisor (somente Claude Code)

- Em todos os chats e sessões, aplique o comando `/advisor opus` para manter o modelo Opus ativo como advisor.
- Para síntese, arquitetura e verificação de segurança, consulte o modelo Opus via advisor antes de finalizar o relatório ou conclusões de tarefas.

## Nível de esforço por conversa (somente Claude Code)

- Escala: Baixo (trivial, sem ler nem alterar arquivos), Médio (dia a dia: ajustes, testes, commit, PR, perguntas que exigem ler código), Alto (bug difícil, plano de feature com vários arquivos, escolha entre abordagens, revisão antes de mesclar) e Extra high (raro; problema que o alto já errou ou decisão cara de errar). Padrão: Opus 5.5 Médio. No início de cada pedido, diga em uma linha o nível indicado.
- Nível real: o agente não enxerga o próprio seletor. Consulte-o com `mcp__ccd_session_mgmt__get_session` (`session_id: "self"`; carregue com `ToolSearch` se estiver adiada). Nunca deduza o nível pelo título ou nome da sessão; se a consulta falhar, diga que não conseguiu ler o nível.
- Nível acima do necessário: no início de toda conversa ou sessão nova aberta à mão pelo usuário, se o nível atual for mais alto que o indicado (ex.: Opus 5.5 Alto quando Médio basta; Extra high quando Alto basta), pare antes de qualquer busca, leitura, delegação ou edição, peça para descer o seletor e encerre a resposta.
- Nível abaixo do necessário: se o pedido merecer nível acima do atual (inclusive leitura, plano ou análise), pare do mesmo jeito e peça para subir. Terminada a parte difícil, avise que pode voltar ao Médio.
- Aviso: o app não deixa a sessão mudar o próprio nível. Faça o pedido de subir ou descer como cartão `AskUserQuestion`, com o nível atual, o indicado e o motivo, e as opções `Já troquei o seletor` e `Seguir no nível atual`. Depois da resposta, confira com `get_session` (`self`). Se o usuário mandar seguir no nível atual, não pergunte de novo.
- Sessões abertas pelo agente (`start_session`) já nascem no nível certo e não param para pedir troca: até o nível do agente, passe `effort` no `start_session`; acima dele, abra com o nível do agente e um pedido neutro, suba com `set_session_effort` (cartão de aprovação para o usuário) e só então envie a tarefa por `SendMessage`. No brief, diga que o nível já foi definido. Subagentes mantêm o próprio esforço.

## Auto-fix de PR (somente Claude Code)

- Depois de vincular o PR da sessão (`bind_pr`), ative o auto-fix com `set_monitor` (`auto_fix: true`) para acompanhar falhas de CI, conflitos e comentários de revisão.
- Não ative o auto-merge sem pedido explícito.

## Grafo do código (graphify, somente Claude Code)

- Antes de explorar o código para responder perguntas de arquitetura ou de relações entre arquivos, consulte `graphify-out/GRAPH_REPORT.md` e use `graphify query "<pergunta>" --budget 1500`, `graphify path "A" "B"` ou `graphify explain "X"`. Abra só os arquivos citados no resultado (`source_location`).
- Depois de mudanças em código, atualize com `graphify update .` (sem LLM). Para documentos (`.md`), rode `/graphify --update` no Claude Code.
- `graphify-out/` é local e ignorado pelo Git; a configuração de pastas excluídas fica em `.graphifyignore`.

## Idioma das respostas do ponytail (somente Claude Code)

Ao executar qualquer comando ou skill do ponytail (`/ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`), escreva a resposta inteira em português, inclusive títulos e rótulos do relatório (por exemplo, "O que esta mudança faz", "Corrigir antes", "Deveria corrigir", "Opcional", "Veredito"). Mantenha em inglês só código, comandos, caminhos e mensagens de erro.
