---
name: improve-codebase-architecture
description: Encontra oportunidades de aprofundar módulos e melhorar a arquitetura, com relatório HTML.
disable-model-invocation: true
---

# Melhorar a arquitetura do código

O usuário pediu uma varredura de arquitetura. Você aponta atritos e propõe **oportunidades de aprofundamento** (*deepening*): refatorações que transformam módulos rasos em módulos profundos, para ganhar testabilidade e navegação por agentes. **Somente leitura: não edite código, dados, dependências nem o estado do Git.**

Use o vocabulário de [VOCABULARIO-DESIGN.md](./VOCABULARIO-DESIGN.md) (**módulo**, **interface**, **profundidade**, **seam**, **adapter**, **alavancagem**, **localidade**) em toda sugestão. Para o domínio, use os termos do `GLOSSARY.md`.

## Onde está o código

Confirme a estrutura listando a raiz antes de citar pastas. Hoje: backend FastAPI em `core/`, `domains/`, `routers/`, `scripts/` e `security/`; frontend em `static/js` (`features/`, `shared/`, `ui/`). As regras de negócio vivem no `AGENTS.md`: elas são o contrato que um módulo mais profundo precisa preservar, nunca um atrito a "simplificar".

## Passos

1. **Consultar o grafo primeiro.** Leia `graphify-out/GRAPH_REPORT.md`; depois `graphify query "<pergunta>" --budget 1500`, `graphify path "<A>" "<B>"` e `graphify explain "<nó>"`. Abra só os arquivos que o grafo citar. Defina *onde* olhar antes: se o usuário nomeou um módulo ou dor, siga-o; senão, priorize o que mudou recentemente (`git log --oneline`) e os arquivos que sempre reaparecem.
2. **Ler o que já foi decidido.** `GLOSSARY.md` (se existir), `docs/arquitetura/*` (`CONTRATOS_API_BACKEND.md`, `REFATORACAO_BACKEND_FASE_1.md`, `REFATORACAO_BACKEND_FASE_3.md`, `REFATORACAO_BACKEND_FASE_4.md`, `auditoria_arquitetura.md` e vizinhos), `docs/PROMPT_REFATORACAO_BACKEND_SIMPRESS.md` e os ADRs em `docs/arquitetura/adr/` (a pasta só existe depois do primeiro ADR). Não re-sugira o que um ADR ou fase de refatoração já decidiu, a menos que o atrito atual justifique reabrir; nesse caso, marque o candidato como tal.
3. **Procurar candidatos de aprofundamento.** Explore de forma orgânica e anote onde há atrito:
   - entender um conceito exige pular entre muitos módulos pequenos;
   - módulos **rasos**, com interface quase tão complexa quanto a implementação;
   - funções puras extraídas só para teste, enquanto os bugs moram em como são chamadas (sem **localidade**);
   - módulos fortemente acoplados vazando através do seam;
   - partes sem teste ou difíceis de testar pela interface atual.

   Aplique o **teste de remoção** (*deletion test*) a cada suspeito de ser raso: apagar o módulo concentraria a complexidade ou só a moveria? "Concentra" é o sinal que você procura.
4. **Gravar o relatório HTML** fora do repositório, seguindo [RELATORIO-HTML.md](./RELATORIO-HTML.md). Não proponha interfaces ainda. Abra o arquivo para o usuário (PowerShell: `Start-Process <caminho>`), informe o caminho absoluto e pergunte: "Qual destes você quer explorar?"
5. **Conversar sobre o candidato escolhido.** Leia e siga `../grill-with-docs/SKILL.md` (comando do usuário, que a ferramenta Skill não chama) para percorrer restrições, dependências, a forma do módulo aprofundado, o que fica atrás do seam e quais testes sobrevivem. Use a skill `domain-modeling` para manter o glossário e os ADRs em dia:
   - nome novo de conceito vira termo no `GLOSSARY.md` (crie o arquivo só quando houver o que escrever);
   - candidato rejeitado por motivo que um explorador futuro precisaria conhecer: ofereça um ADR ("Quer registrar como ADR para que revisões futuras não sugiram isso de novo?"). Pule motivos efêmeros ("agora não vale") e os autoevidentes. Formatos em `domain-modeling/FORMATO-ADR.md` e `domain-modeling/FORMATO-GLOSSARIO.md`.

A varredura termina quando o relatório existe, o caminho foi informado e a pergunta ao usuário foi feita. Informe também o que não foi verificado (por exemplo, módulos que o grafo não cobre).

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
