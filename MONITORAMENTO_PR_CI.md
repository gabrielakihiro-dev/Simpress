# Procedimento de Monitoramento Automático de Sessões, PRs e CI (Simpress)

Este documento define o protocolo oficial que o **Antigravity** deve seguir automaticamente quando o usuário solicitar:
*"acompanhe as conversas"*, *"faça o monitoramento"*, *"acompanhe a CI"*, *"siga o mesmo fluxo"*, *"monitore as PRs"* ou qualquer variação desse fluxo.

---

## 1. Princípios Fundamentais (Regras de Ouro)

1. **Sem Correção Manual de Código:**
   - **NUNCA altere arquivos de código para tentar corrigir falhas de CI.**
   - O Claude Code (em suas respectivas sessões em background) está configurado com `auto_fix: true` e fará as correções necessárias de forma autônoma.
   - O papel do Antigravity é exclusivamente de **orquestrador e monitorador**.

2. **Critério Rígido de Merge, Ordem Numérica e Sequenciamento Estrito (NUNCA fure a ordem nem mescle ao mesmo tempo):**
   - **Ordem Numérica Rigorosa de #PR (NUNCA pule ou fure a ordem):** Siga sempre e rigorosamente a ordem numérica crescente das #PRs (ex.: #166 antes de #167, #168, etc.). **NUNCA faça o merge de uma #PR de número maior sem antes ter feito o merge de todas as #PRs anteriores de numeração menor**, mesmo que o PR de número maior termine os checks primeiro ou não tenha checks de código. A fila de merge deve aguardar rigorosamente a resolução e merge das PRs anteriores.
   - Execute o merge (`gh pr merge <numero> --merge`) **SOMENTE** quando for a vez do menor número de PR pendente E **100% dos checks de CI estiverem verdes**:
     - `verify (3.12)` (aprovado)
     - `verify (3.14)` (aprovado)
     - `ui-browser` (aprovado)
   - **NUNCA faça merge de mais de um PR simultaneamente ou em sequência imediata:** Havendo múltiplos PRs aprovados, mescle rigorosamente **um PR por vez**, sempre respeitando a ordem crescente de numeração.
   - **Aguarde o término completo do ciclo na `main` antes do próximo merge:** Sempre aguarde a CI disparada na `main` pelo commit de merge (`verify 3.12`, `verify 3.14`, `ui-browser`) concluir 100% verde antes de mesclar o PR seguinte. Isso evita cancelamento automático de workflows por concorrência e divergências de commit na `origin/main`.
   - Se o PR estiver com status `CONFLICTING` ou `DIRTY`, não mexa: aguarde a respectiva sessão do Claude mesclar a `main` e reenviar os testes.

3. **Monitoramento do Commit de Merge na `main`:**
   - Após cada merge, capture o hash do commit resultante na `main` (`gh pr view <numero> --json mergeCommit`).
   - Acompanhe a execução da CI disparada na `main` (`gh run list --commit <hash>`).

4. **Sincronização com `git pull` a CADA #PR:**
   - Assim que a CI na `main` de um commit de merge concluir 100% verde, execute **imediatamente**:
     ```powershell
     cd Simpress
     git checkout main
     git pull
     ```
   - Confirme que a working tree está limpa e sincronizada com `origin/main` a cada #PR concluído, antes de autorizar ou efetuar o próximo merge.

---

## 2. Regras de Intervalo, Economia de Tokens e Estimativa Dinâmica

Para não desperdiçar tokens com polling desnecessário, utilize **SEMPRE** a ferramenta `schedule` (nunca use comandos como `Start-Sleep` ou loop de shell como temporizadores de ciclo):

| Situação | Intervalo Padrão | Duração (`schedule`) | Justificativa |
| :--- | :--- | :--- | :--- |
| **Ciclo Normal (Ocioso)** | **10 minutos** | `DurationSeconds: 600` | Nenhum PR aberto nem CI rodando; aguardando criação de PR pelo Claude. |
| **Ciclo Ativo (PR / CI)** | **8 minutos** | `DurationSeconds: 480` | PR aberto ou CI em execução na `main`. O pipeline completo leva de 20 a 24 minutos. |
| **Reta Final Estimada** | **Tempo Estimado** | `DurationSeconds: 120-300` | Ajustado dinamicamente quando o término for iminente. |

### Regra de Flexibilidade e Calibragem Dinâmica por Estimativa:
- **As regras e intervalos podem ser alterados pelo usuário a qualquer momento.**
- **Ajuste Dinâmico pelo Término Estimado:** O agente **deve diminuir o tempo de espera do ciclo para o tempo estimado de término** assim que puder calcular quanto falta para a conclusão dos jobs:
  - O job `CI` (`verify 3.12` e `verify 3.14`) costuma levar entre **12 e 13 minutos**.
  - O job `UI browser` (`ui-browser`) costuma levar entre **20 e 24 minutos**.
  - *Exemplo prático:* Se o `ui-browser` estiver com 18 minutos decorridos, o término está previsto para daqui a 2–3 minutos; portanto, o próximo ciclo do `schedule` deve ser agendado para **2 ou 3 minutos** (e não 8 minutos), viabilizando o merge imediato e evitando que o PR fique ocioso após ser aprovado.

---

## 3. Mapeamento de Sessões do Claude Code e Repositórios

- **Diretório das sessões do Claude Code:**
  `C:\Users\Gabriel\.claude\projects\C--Users-Gabriel-Desktop-Empresa\*.jsonl`
  - Ordene por data de modificação (`LastWriteTime`) para identificar as sessões ativas.
  - Subagentes ficam em: `<session_id>\subagents\*.jsonl`.
- **Worktrees do Git:**
  - Execute `git worktree list` dentro da pasta `Simpress`.
- **Listar PRs Abertos:**
  - Execute `cd Simpress; gh pr list`.

---

## 4. Checklist de Cada Ciclo de Verificação

A cada despertar do `schedule`, execute a seguinte rotina:

1. **Listar PRs abertos:**
   ```powershell
   cd Simpress; gh pr list
   ```
2. **Se houver PR aberto (respeitando a ordem numérica estrita):**
   - **Ordem Numérica Rigorosa:** Sempre identifique o PR aberto de **menor número** (ex.: #166 antes de #167, #168, etc.). **NUNCA faça o merge de um PR de numeração maior sem antes ter feito o merge de todos os anteriores**, mesmo que o posterior esteja pronto ou não tenha CI.
   - **Regra de 1 PR por vez:** Se já houver uma CI rodando na `main` decorrente de merge anterior, **aguarde ela terminar 100% verde e faça o `git pull` antes de mesclar qualquer outro PR**.
   - Checar checks do PR da vez (o de menor numeração): `gh pr checks <numero>`
   - Se os 3 checks (`verify 3.12`, `verify 3.14`, `ui-browser`) estiverem `pass`/`success`:
     - Conferir se está mesclável: `gh pr view <numero> --json mergeable,mergeStateStatus`
     - Se `MERGEABLE` e `CLEAN`: executar o merge de **apenas esse PR** (`gh pr merge <numero> --merge`)
     - Identificar o commit de merge: `gh pr view <numero> --json mergeCommit`
     - Monitorar os novos runs na `main`: `gh run list --commit <hash>`
   - Se algum check falhar: **NÃO altere o código**. Registre a falha e aguarde a nova rodada enviada pelo Claude Code.
3. **Acompanhamento da CI na `main` e `git pull` a cada PR:**
   - Acompanhar a CI na `main` até a conclusão total (`gh run list --branch main --limit 3`).
   - Assim que a CI na `main` concluir 100% verde: executar imediatamente `git checkout main; git pull`.
   - Havendo outro PR pendente na fila, avançar para ele somente após este passo.
   - Se não houver novos PRs e as sessões ainda estiverem ativas, manter o ciclo normal de **10 minutos**.
4. **Relatório ao Usuário:**
   - Enviar um resumo conciso com: tempo decorrido dos jobs, status dos checks e horário do próximo despertar.
