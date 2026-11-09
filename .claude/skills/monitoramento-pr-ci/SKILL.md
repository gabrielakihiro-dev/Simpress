---
name: monitoramento-pr-ci
description: >-
  Workflow automatizado de monitoramento contínuo de conversas do Claude Code,
  pull requests (PRs) e pipelines de CI no repositório Simpress. Ative sempre que
  o usuário pedir para acompanhar conversas, monitorar PRs, acompanhar a CI,
  seguir o mesmo fluxo de monitoramento, mesclar PRs verdes e fazer git pull ao final.
---

# Monitoramento de Sessões, PRs e CI no Simpress

Use esta skill quando o usuário solicitar o acompanhamento de sessões ativas do Claude Code, monitoramento de PRs abertos e pipelines de integração contínua (CI) no repositório `Simpress`.

Consulte o documento completo em [`Simpress/MONITORAMENTO_PR_CI.md`](file:///c:/Users/Gabriel/Desktop/Empresa/Simpress/MONITORAMENTO_PR_CI.md).

## Protocolo de Execução

### 1. Intervalos de Polling (Economia de Tokens e Calibragem Dinâmica)
- **A regra de tempo é flexível e pode mudar:** O usuário pode redefinir os intervalos a qualquer momento.
- **Ciclo Normal (Ocioso/Esperando PR):** **10 minutos** (`schedule` tool com `DurationSeconds: 600`).
- **Ciclo Ativo Padrão (com PR ou CI rodando):** **8 minutos** (`schedule` tool com `DurationSeconds: 480`).
- **Redução pelo Tempo Estimado de Término (Regra Fundamental):**
  - Sempre que for possível estimar o término de uma rodada de CI (ex.: `verify` leva ~12–13m e `ui-browser` leva ~20–24m), **o agente deve diminuir o tempo de espera do ciclo para o tempo estimado restante** (ex.: 2 min, 3 min ou 5 min).
  - Isso garante que a aprovação do PR seja capturada e o merge seja efetuado imediatamente, sem deixar o PR ocioso aguardando o ciclo completo de 8 minutos.
- **NUNCA** usar loops de `sleep` no terminal; use **SEMPRE** a ferramenta `schedule`.

### 2. Regra Fundamental de Correção
- **NUNCA modifique o código da aplicação por conta própria para resolver erros de CI.**
- As sessões do Claude Code contam com auto-fix habilitado e farão as alterações necessárias autonomamente.
- O Antigravity atua apenas como monitorador e orquestrador dos merges.

### 3. Critérios de Merge, Ordem Numérica e Sequenciamento (NUNCA fure a ordem nem mescle ao mesmo tempo)
- **Ordem Numérica Rigorosa de #PR (NUNCA fure a ordem):** Siga sempre e rigorosamente a ordem crescente de numeração das #PRs (ex.: #166 antes de #167, #168, etc.). **NUNCA faça o merge de uma #PR de número maior sem antes ter feito o merge de todas as #PRs anteriores de numeração menor**, mesmo que o PR de número maior termine os checks primeiro ou não tenha checks de código. A fila de merge deve aguardar rigorosamente a resolução e merge das PRs anteriores.
- **Merge estritamente sequencial:** Se houver múltiplos PRs prontos e verdes, mescle **um PR por vez**, sempre respeitando a ordem numérica. NUNCA efetue merges simultâneos ou em sequência sem aguardar o ciclo da `main`.
- Apenas efetuar o merge (`gh pr merge <numero> --merge`) quando for a vez da PR pela ordem numérica E **100% dos checks de CI estiverem verdes**:
  - `verify (3.12)` (aprovado)
  - `verify (3.14)` (aprovado)
  - `ui-browser` (aprovado)
- Se houver conflito de merge (`DIRTY` ou `CONFLICTING`), não mexa: a sessão do Claude resolverá o merge com a `main`.

### 4. Acompanhamento Pós-Merge e `git pull` a CADA #PR
- Capture o commit de merge gerado na `main` (`gh pr view <numero> --json mergeCommit`) e acompanhe a CI desse commit (`gh run list --commit <hash>`).
- **Aguarde o ciclo completo da `main` antes do próximo PR:** Aguarde 100% dos checks disparados na `main` concluírem com sucesso verde.
- **Sincronize a cada PR:** Imediatamente após a CI na `main` concluir verde:
  ```powershell
  cd Simpress
  git checkout main
  git pull
  ```
- Confirme a working tree limpa e sincronizada com `origin/main` a cada #PR concluído antes de prosseguir com qualquer outro merge.
