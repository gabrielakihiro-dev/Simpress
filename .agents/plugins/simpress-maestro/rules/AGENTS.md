# Regras do Simpress no Antigravity (`simpress-maestro`)

Espelho operacional do fluxo do Claude Code (`CLAUDE.md`) adaptado ao Antigravity para plano **AI Pro**, usando **exclusivamente** os modelos **Hydrogen**, **Neon** e **Carbon** (proibido usar Flash ou 3.1 Pro). Carregado automaticamente pelo plugin `.agents/plugins/simpress-maestro/`.

## 1. Pergunta inteligente de modelo e esforço no início da sessão

- Na primeira resposta de uma sessão nova no chat principal (nunca em subagente, nem quando o usuário já informou no pedido), classifique a complexidade e pergunte com `ask_question` qual par **Esforço — Modelo** usar, colocando a recomendação em primeiro com `(Recommended)`:
  - Leitura, log, `.md` ou ajuste mínimo → `Low — Hydrogen (Recommended)`
  - Execução direta padrão (feature delimitada, teste, bug comum, tela React, refatoração) → `Medium — Hydrogen (Recommended)`
  - Execução direta complexa (multiarquivo, depuração de causa raiz) → `High — Hydrogen (Recommended)`
  - Código crítico / revisão / segurança (portal/SharePoint/OS/Endpoint, revisão pré-PR, `/swarm` complexo) → `High — Neon (Recommended)`
  - Impasse que o Neon não resolveu / arquitetura crítica → `xHigh — Carbon (Recommended)`
  - Opções apresentadas: `Low — Hydrogen`, `Medium — Hydrogen`, `High — Hydrogen`, `High — Neon`, `xHigh — Carbon` (reordenando para pôr a recomendada em primeiro).
- Se a escolha diferir do modelo/esforço ativo na sessão, informe em uma linha como trocar no seletor do Antigravity (ou prossiga na sessão atual).

## 2. Maestro obrigatório e economia de tokens (AI Pro)

- A conversa principal coordena: resolve diretamente o que for pequeno (1 arquivo, 1 busca, 1 comando) e delega o restante aos 17 subagentes de `.agents/plugins/simpress-maestro/agents/` via `invoke_subagent(TypeName="<agente>", Model="inherit", ...)` (omitir ou usar `"inherit"` garante herdar Hydrogen/Neon/Carbon da sessão sem nunca acionar Flash ou 3.1 Pro):
  - **Hydrogen (Low)** *(equivalente Haiku 5.5)* — leitura, logs e checagens baratas: `batedor`, `leitor-logs`, `conferente-glossario`, `auditor-dependencias`, `testador-acessibilidade`.
  - **Hydrogen (Medium)** *(equivalente Sonnet 5.5 — execuções diretas padrão)*: `executor`, `testador`, `testador-e2e`, `front-react`, `refatorador`, `documentador`, `segunda-opiniao`.
  - **Hydrogen (High)** *(equivalente Sonnet 5.5 em esforço alto)*: `depurador` (causa raiz) e `executor` quando envolver vários arquivos ou lógica mais complexa.
  - **Neon (High)** *(equivalente Opus 5.5 — uso cirúrgico)*: `revisor`, `implementador`, `auditor-seguranca` e primeira passagem do `arquiteto`.
  - **Carbon (High / xHigh)** *(equivalente Fable 5.2 — escalonamento raro)*: `arquiteto` (ou impasse de `implementador`/`depurador`) **somente quando o Neon (High) não conseguir resolver**.
- Estilo enxuto: reaproveite código e helpers já existentes antes de criar código novo, sem cortar validações, tratamento de erro, segurança, acessibilidade ou testes.
- Em perguntas de arquitetura ou relação entre arquivos, se `graphify-out/GRAPH_REPORT.md` existir localmente, consulte-o ou use `graphify query "<pergunta>" --budget 1500` antes de abrir múltiplos arquivos.

## 3. Revisão pré-PR, abertura automática de #PR, acompanhamento da #CI, merge e `git pull`

- **Antes de abrir #PR:** em alterações de código, passe o diff pelo subagente `revisor` (Neon High) e corrija tudo o que vier em **Corrigir antes**. Respostas de revisão saem em português (`O que esta mudança faz`, `Corrigir antes`, `Deveria corrigir`, `Opcional`, `Veredito`).
- **Ciclo completo automático no Antigravity (autorização do usuário em 25/11/2026):** em toda conversa no Antigravity que finalizar entrega em branch de worktree (nunca direto na `main`) com `npm run verify` verde (e `npm run test:ui:e2e` quando houver mudança de interface):
  1. Confira `git branch --show-current` e revise `git status` (nunca inclua `data/planilhas_entrada`, `data/state`, `.transactions` nem segredos).
  2. Faça commit, `git push -u origin <branch>` e abra o PR automaticamente com `gh pr create` (sem precisar pedir confirmação a cada vez).
  3. **Acompanhe a #CI da #PR:** rode `gh pr checks <numero> --watch` até 100% verde e informe o resultado exato. Falha de infraestrutura conhecida re-executa com `gh run rerun <id> --failed`; falha real vira correção (teto de 3 ciclos).
  4. **Merge e `git pull`:** com a `#CI` do `#PR` 100% verde e respeitando a fila numérica (`gh pr list --state open`, nunca furando PR anterior aberto), faça o merge com `gh pr merge <numero> --merge`, acompanhe a CI do commit de merge na `main` (`gh run list --branch main`) até concluir verde e execute `git -C "<checkout-principal>" pull` (descobrindo o checkout principal pelo pai de `git rev-parse --path-format=absolute --git-common-dir`).

## 4. Integração com `/swarm` (trabalho paralelo inteligente)

- Use `invoke_subagent` para tarefas normais ou sequenciais; nunca inicie `/swarm` por conta própria em tarefas pequenas.
- Quando o usuário invocar `/swarm`, pedir equipe paralela ou houver 3+ frentes independentes, siga a skill `swarm-simpress` (`.agents/skills/swarm-simpress/SKILL.md`):
  - Consulte `swarm(action="models")` e selecione **exclusivamente** **Hydrogen**, **Neon** e **Carbon** (nunca Flash nem 3.1 Pro): Hydrogen (Low) para leitura/auditorias, Hydrogen (Medium/High) para execuções diretas (`executor`, `testador`, `testador-e2e`, `front-react`, `refatorador`, `depurador`), Neon (High) para revisão/segurança/implementador/1ª passagem do arquiteto, e Carbon (High/xHigh) só para escalonamento de `arquiteto` se Neon não resolver.
  - Use `workspace: "share"` para autores editando em paralelo e `workspace: "inherit"` para leitores/revisores.
  - Workers rodam apenas o teste focado da sua fatia; integre os commits dos workers antes de chamar `swarm(action="kill")` e execute um único `npm run verify` no coordenador antes de abrir o `#PR`.
