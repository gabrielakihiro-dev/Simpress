---
name: retro
description: Retrospectiva de uma sessão de código, propondo melhorias no ambiente do agente (sem editar nada).
disable-model-invocation: true
---

# Retrospectiva

O usuário pediu uma **retrospectiva**. Você propõe melhorias no **ambiente** do agente para tornar as próximas execuções melhores. **Somente proponha: não edite arquivos, skills, hooks nem configurações.**

## Passos

1. Chame a skill `writing-for-agents` para o guia de estilo.
2. Leia as fontes primárias da sessão indicada pelo usuário (pode exigir procurar os logs de sessão nesta máquina). Sem indicação, use a sessão atual.
3. Procure candidatos nestas categorias:
   - **Navegação:** o agente demorou para achar o arquivo certo? Há dependências escondidas? Um ponteiro de navegação (uma linha no `AGENTS.md` ou na skill) resolveria? Consulte o grafo (`graphify-out/GRAPH_REPORT.md`, `graphify query`). Use quando a sessão levou muito para achar uma informação.
   - **Checagens automáticas:** um linter, tipo, teste ou hook teria pego o erro? Leia antes o que já existe (`npm run verify`, `package.json`, `.claude/hooks`, `.claude/settings.json`); uma checagem que existe mas está desligada ou quebrada é o achado, não uma reinvenção. Erro mecânico (padrão sintático fixo, API proibida, local de arquivo) pede checagem determinística, não regra em texto. Use quando o agente cometeu um erro que uma checagem automática pegaria.
   - **Padrões de código:** uma regra nova ou removida/esclarecida para a revisão? Regras mecânicas viram checagem; só julgamento (consistência entre arquivos, "combina com o estilo ao redor") fica em texto.
   - **AGENTS.md grande:** o `AGENTS.md` (fonte única compartilhada com Codex e Cursor, hoje com dezenas de KB) e o `CLAUDE.md` carregam instruções que deveriam virar skill em `.claude/skills` e `.agents/skills` (conteúdo idêntico), documento em `docs/` ou checagem automática? Propor mudança no `AGENTS.md` sempre leva em conta que ele é compartilhado: mantenha uma só fonte e deixe o `CLAUDE.md` só com o que é do Claude Code.
   - **Economia de ferramentas:** houve chamadas caras que poderiam ser enxutas (leitura de arquivo inteiro em vez de grafo, saídas longas, ferramentas ineficientes)?
   - **No-ops:** instruções nos arquivos de direcionamento que não mudam o comportamento do agente. Use quando os arquivos forem grandes e pesados.
   - **Acesso à informação:** o que faltou ao agente (logs do servidor, leitura de serviços de terceiros, dados do ambiente) e como dar acesso somente leitura.
4. Apresente os candidatos ao usuário **em ordem de severidade**, cada um com evidência da sessão, a mudança proposta e onde ela entra. Informe também o que não foi possível verificar.

## Referência

### Implementação e revisão

Todo trabalho passa por duas etapas. O agente de implementação sofre a maior **pressão de contexto** (explora, escreve, depura). O revisor recebe um diff, sem exploração, e tem pouca pressão. Por isso cabe ao revisor impor padrões de código, não ao implementador.

### Onde cada coisa vive

- `AGENTS.md` e `CLAUDE.md`: entram no contexto de todo agente; use com extrema parcimônia, de preferência só como **ponteiros de navegação** para outros arquivos.
- Documentos em `docs/`: referência apontada por outros arquivos. Procure o que já existe antes de escrever novo.
- Skills (`.claude/skills`, `.agents/skills`): para documentação (a descrição entra no contexto) ou comandos do usuário. Siga `writing-for-agents`.
- Hooks (`.claude/hooks`) e `npm run verify`: onde moram as checagens determinísticas.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
