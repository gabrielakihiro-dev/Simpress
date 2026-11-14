Regras do Simpress para o Claude Code; a fonte única é o `AGENTS.md` (Codex, Cursor e Antigravity leem o mesmo arquivo).

@AGENTS.md

## Somente Claude Code

- Advisor: mantenha `/advisor opus` ativo em todo chat e consulte-o antes de concluir síntese, arquitetura ou verificação de segurança.
- Grafo (graphify): em pergunta de arquitetura ou relação entre arquivos, leia `graphify-out/GRAPH_REPORT.md` e use `graphify query "<pergunta>" --budget 1500`, `graphify path "A" "B"` ou `graphify explain "X"`; abra só os arquivos do `source_location`. Depois de mudar código, `graphify update .`; de mudar `.md`, `/graphify --update`. `graphify-out/` é local e fora do Git (exclusões em `.graphifyignore`).
- Ponytail (`/ponytail` e skills `ponytail-*`): resposta inteira em português, inclusive títulos e rótulos ("O que esta mudança faz", "Corrigir antes", "Deveria corrigir", "Opcional", "Veredito"); só código, comandos, caminhos e erros em inglês.
