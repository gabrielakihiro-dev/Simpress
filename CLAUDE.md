Regras do projeto Simpress para o Claude Code; a fonte única é o AGENTS.md, compartilhado com Codex e Cursor.

@AGENTS.md

## Protocolo e Advisor (somente Claude Code)

- Em todos os chats e sessões, aplique o comando `/advisor opus` para manter o modelo Opus ativo como advisor.
- Para síntese, arquitetura e verificação de segurança, consulte o modelo Opus via advisor antes de finalizar o relatório ou conclusões de tarefas.

## Grafo do código (graphify, somente Claude Code)

- Antes de explorar o código para responder perguntas de arquitetura ou de relações entre arquivos, consulte `graphify-out/GRAPH_REPORT.md` e use `graphify query "<pergunta>" --budget 1500`, `graphify path "A" "B"` ou `graphify explain "X"`. Abra só os arquivos citados no resultado (`source_location`).
- Depois de mudanças em código, atualize com `graphify update .` (sem LLM). Para documentos (`.md`), rode `/graphify --update` no Claude Code.
- `graphify-out/` é local e ignorado pelo Git; a configuração de pastas excluídas fica em `.graphifyignore`.

## Idioma das respostas do ponytail (somente Claude Code)

Ao executar qualquer comando ou skill do ponytail (`/ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain`, `ponytail-help`), escreva a resposta inteira em português, inclusive títulos e rótulos do relatório (por exemplo, "O que esta mudança faz", "Corrigir antes", "Deveria corrigir", "Opcional", "Veredito"). Mantenha em inglês só código, comandos, caminhos e mensagens de erro.
