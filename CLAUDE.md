Regras do Simpress para o Claude Code; a fonte única é o `AGENTS.md` (Codex, Cursor e Antigravity leem o mesmo arquivo).

@AGENTS.md

## Somente Claude Code

- Maestro: delegue pelos agentes de `.claude/agents/` (batedor, executor, revisor, segunda-opiniao, arquiteto e especialistas como testador, depurador, implementador); no início de toda sessão nova, pergunte o esforço (`low`/`medium`/`high`/`xhigh`) recomendando um pela dificuldade; toda sessão que abrir recebe `effort` pela dificuldade; depois do planejamento, a execução sempre vai para sessão nova na pasta Simpress; opcionais ou revisão pendentes em chat lotado vão para sessão nova, nunca `/clear` nem handoff; blocos em código diferente, uma sessão cada; blocos dependentes, em sequência sem perguntar. Detalhe: "Delegação em subagentes" em `docs/desenvolvimento/regras-agentes.md`.
- Nuvem (claude.ai/code): ambiente `simpress` e ferramentas equivalentes em "Sessões na nuvem" de `docs/desenvolvimento/regras-agentes.md`.
- Antes de abrir PR: rode `/ponytail-review` na mudança e corrija o que vier em "Corrigir antes" (regra do usuário, 24/11/2026).
- PR aberto (regra do usuário, 24/11/2026): ligue o Auto-fix na hora (`ccd_pr` `set_monitor`, `auto_fix: true`), sem perguntar; só não mescle.
- Advisor: mantenha `/advisor opus` ativo em todo chat e consulte-o antes de concluir síntese, arquitetura ou verificação de segurança.
- Grafo (graphify): em pergunta de arquitetura ou relação entre arquivos, leia `graphify-out/GRAPH_REPORT.md` e use `graphify query "<pergunta>" --budget 1500`, `graphify path "A" "B"` ou `graphify explain "X"`; abra só os arquivos do `source_location`. Depois de mudar código, `graphify update .`; de mudar `.md`, `/graphify --update`. `graphify-out/` é local e fora do Git (exclusões em `.graphifyignore`).
- Ponytail (`/ponytail` e skills `ponytail-*`): resposta inteira em português, inclusive títulos e rótulos ("O que esta mudança faz", "Corrigir antes", "Deveria corrigir", "Opcional", "Veredito"); só código, comandos, caminhos e erros em inglês.
