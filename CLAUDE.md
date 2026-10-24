Regras do projeto Simpress para o Claude Code; a fonte única é o AGENTS.md, compartilhado com Codex e Cursor.

@AGENTS.md

## Protocolo e Advisor (somente Claude Code)

- Em todos os chats e sessões, aplique o comando `/advisor opus` para manter o modelo Opus ativo como advisor.
- Para síntese, arquitetura e verificação de segurança, consulte o modelo Opus via advisor antes de finalizar o relatório ou conclusões de tarefas.

## Auto-fix de PR (somente Claude Code)

- Depois de vincular o PR da sessão (`bind_pr`), ative o auto-fix com `set_monitor` (`auto_fix: true`) para acompanhar falhas de CI, conflitos e comentários de revisão.
- Não ative o auto-merge sem pedido explícito.
