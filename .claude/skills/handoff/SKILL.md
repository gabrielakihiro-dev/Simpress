---
name: handoff
description: Compacta a conversa atual em um documento de passagem para outro agente ou sessão continuar o trabalho.
argument-hint: "Para que a próxima sessão será usada?"
disable-model-invocation: true
---

# Passagem de trabalho (handoff)

Escreva um documento que resuma a conversa para que um agente novo continue o trabalho. Salve no diretório temporário do sistema (`%TEMP%` no Windows, `$TMPDIR` ou `/tmp` nos demais), **nunca no repositório**, e informe o caminho absoluto do arquivo.

Se o usuário passou argumentos, trate-os como o foco da próxima sessão e ajuste o documento a ele.

## Conteúdo

- **Objetivo e estado:** o que se pretende, o que já foi feito, o que falta e as decisões tomadas.
- **Git (somente leitura):** branch atual, worktree atual (caminho) e o resultado de `git status`. Não altere nada para obter isso.
- **Verificado e não verificado:** liste separadamente o que foi realmente conferido (comando, teste ou navegador, com o resultado) e o que não foi. Teste focado não significa suíte completa; `git diff --check` não é validação no navegador; commit local não prova push.
- **Skills sugeridas:** quais skills o próximo agente deve chamar com a ferramenta Skill.

## Referenciar, não duplicar

Não copie o que já existe em outros artefatos (specs, planos, ADRs, issues, commits, diffs). Cite por caminho ou URL, ou pelo hash do commit.

## Dados sensíveis

Redija chaves de API, senhas, tokens e dados pessoais. Não inclua conteúdo de planilhas operacionais nem de `data/`.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
