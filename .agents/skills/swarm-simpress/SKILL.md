---
name: swarm-simpress
description: Orquestra trabalhos paralelos grandes no Simpress com `/swarm`, distribuindo papéis do `simpress-maestro` exclusivamente entre Hydrogen, Neon e Carbon com isolamento `workspace: share` para economizar cota no AI Pro.
---

# Swarm Simpress (`/swarm`)

## Quando usar `/swarm` vs `invoke_subagent`

- **Tarefas normais ou sequenciais:** use `invoke_subagent` (mais leve e sem custo de coordenação em quadro compartilhado). Nunca inicie `/swarm` por conta própria em tarefas pequenas.
- **Quando usar `/swarm`:** somente quando o usuário invocar `/swarm`, pedir equipe/paralelismo explícito, ou quando houver **3+ frentes independentes** (ex.: back-end + front-end + testes + docs, ou auditoria fatiada).

## Setup do coordenador (AI Pro — zero Flash, zero 3.1 Pro)

1. Carregue a skill `swarm_pane` para preencher o Overview da UI do Swarm.
2. Nomeie o swarm com `swarm(action="title", title="<objetivo curto>")`.
3. Liste os modelos reais disponíveis com `swarm(action="models")` e escolha **exclusivamente** **Hydrogen**, **Neon** e **Carbon**:

| Modelo e esforço | Papel no `simpress-maestro` | `workspace` | Uso no `/swarm` |
|---|---|---|---|
| **Hydrogen (Low)** | `batedor`, `leitor-logs`, `conferente-glossario`, `auditor-dependencias`, `testador-acessibilidade` | `"inherit"` | Busca em volume, logs, glossário, auditoria de pacotes e acessibilidade |
| **Hydrogen (Medium)** | `executor`, `testador`, `testador-e2e`, `front-react`, `refatorador`, `documentador`, `segunda-opiniao` | `"share"` (autores em paralelo); `"inherit"` (`segunda-opiniao`) | Execuções diretas padrão (como Sonnet), testes focados, React, refatoração e `.md` |
| **Hydrogen (High)** | `depurador`, `executor` (multiarquivo complexo) | `"share"` | Depuração de causa raiz e execuções diretas mais complexas |
| **Neon (High)** | `revisor`, `auditor-seguranca`, `implementador`, `arquiteto` (1ª tentativa) | `"inherit"` (leitores); `"share"` (`implementador`) | Revisão pré-PR, segurança/LGPD, automações delicadas e arquitetura |
| **Carbon (High / xHigh)** | `arquiteto` (ou impasse de `implementador`/`depurador`) | `"inherit"` (`"share"` se editar) | **Somente escalonamento** quando o Neon (High) não conseguir resolver |

4. Para varrer ou migrar N arquivos/telas independentes com o mesmo papel, use sharding com `tasks`:
   `swarm(action="add", name="<papel>", tasks=["<alvo-1>", "<alvo-2>", ...], model="<Hydrogen|Neon|Carbon>", workspace="...", brief="...")`.
5. Dê no `brief` apenas os arquivos de propriedade do worker, as restrições do `AGENTS.md` e o critério de pronto.

## Proteção do notebook, integração e verificação única

- **Sem concorrência pesada:** cada worker roda apenas o teste focado da sua fatia (1 arquivo ou 1 spec por vez). **Nunca** rode `npm run verify` nem `npm run test:ui:e2e` em paralelo dentro de vários workers.
- **Integre antes de matar (`kill`):** `swarm(action="kill", name="...")` apaga o workspace `"share"`/`"branch"` do worker. Sempre integre (merge/cherry-pick) os commits do worker na branch principal do worktree **antes** de encerrar o worker.
- **Escalonamento ou troca sem perder histórico:** se um worker em `Neon` travar num problema muito difícil ou ficar sem cota, use `swarm(action="model", name="...", model="<Carbon|...>")` em vez de `kill` + `add`.
- **Fechamento no coordenador:** após integrar tudo, passe o diff pelo `revisor` (`Neon`), rode **um único** `npm run verify` (e `npm run test:ui:e2e` se mexeu em UI), faça commit/push, abra o `#PR` automaticamente, acompanhe a `#CI` da `#PR` até ficar verde, faça `gh pr merge` (respeitando a ordem numérica de PRs abertos), acompanhe a CI na `main` e execute `git pull` na `main` do checkout principal.
