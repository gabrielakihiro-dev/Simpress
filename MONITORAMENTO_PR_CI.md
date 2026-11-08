# Procedimento de Monitoramento Automático de Sessões, PRs e CI (Simpress)

Este documento define o protocolo oficial que o **Antigravity** deve seguir automaticamente quando o usuário solicitar:
*"acompanhe as conversas"*, *"faça o monitoramento"*, *"acompanhe a CI"*, *"siga o mesmo fluxo"*, *"monitore as PRs"* ou qualquer variação desse fluxo.

---

## 1. Princípios Fundamentais (Regras de Ouro)

1. **Sem Correção Manual de Código:**
   - **NUNCA altere arquivos de código para tentar corrigir falhas de CI.**
   - O Claude Code (em suas respectivas sessões em background) está configurado com `auto_fix: true` e fará as correções necessárias de forma autônoma.
   - O papel do Antigravity é exclusivamente de **orquestrador e monitorador**.

2. **Critério Rígido de Merge:**
   - Execute o merge (`gh pr merge <numero> --merge`) **SOMENTE** quando **100% dos checks de CI estiverem verdes**:
     - `verify (3.12)` (aprovado)
     - `verify (3.14)` (aprovado)
     - `ui-browser` (aprovado)
   - Se o PR estiver com status `CONFLICTING` ou `DIRTY`, aguarde a respectiva sessão do Claude mesclar a `main` e reenviar os testes.

3. **Monitoramento do Commit de Merge na `main`:**
   - Após cada merge, capture o hash do commit resultante na `main` (`gh pr view <numero> --json mergeCommit`).
   - Acompanhe a execução da CI disparada na `main` (`gh run list --commit <hash>`).

4. **Finalização com `git pull`:**
   - Quando todos os PRs pendentes tiverem sido mesclados e a CI dos commits de merge na `main` estiver 100% verde:
     ```powershell
     cd Simpress
     git checkout main
     git pull
     ```
   - Confirme que a working tree está limpa e sincronizada com `origin/main`.

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
2. **Se houver PR aberto:**
   - Checar checks: `gh pr checks <numero>`
   - Se os 3 checks (`verify 3.12`, `verify 3.14`, `ui-browser`) estiverem `pass`/`success`:
     - Conferir se está mesclável: `gh pr view <numero> --json mergeable,mergeStateStatus`
     - Se `MERGEABLE` e `CLEAN`: executar `gh pr merge <numero> --merge`
     - Identificar o commit de merge: `gh pr view <numero> --json mergeCommit`
     - Monitorar os novos runs na `main`: `gh run list --commit <hash>`
   - Se algum check falhar: **NÃO altere o código**. Registre a falha e aguarde a nova rodada enviada pelo Claude Code.
3. **Se nenhum PR estiver aberto:**
   - Verificar status da CI dos commits de merge na `main` (`gh run list --branch main --limit 3`).
   - Se a CI na `main` tiver terminado verde e não houver mais tarefas ativas: executar `git checkout main; git pull`.
   - Se ainda aguardando novas tarefas das sessões do Claude, manter o ciclo normal de **10 minutos**.
4. **Relatório ao Usuário:**
   - Enviar um resumo conciso com: tempo decorrido dos jobs, status dos checks e horário do próximo despertar.
