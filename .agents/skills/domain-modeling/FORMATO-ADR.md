# Formato de ADR

ADRs ficam em `docs/arquitetura/adr/`, com numeração sequencial: `0001-slug.md`, `0002-slug.md`. Crie a pasta só quando o primeiro ADR for necessário. Para numerar, procure o maior número existente e some um.

## Modelo

```md
# {Título curto da decisão}

{1 a 3 frases: qual era o contexto, o que se decidiu e por quê.}
```

Um ADR pode ser um parágrafo. O valor está em registrar *que* houve uma decisão e *por quê*, não em preencher seções.

## Seções opcionais

Só quando agregarem valor real:

- **Status** no cabeçalho (`proposta | aceita | obsoleta | substituída pelo ADR-NNNN`): útil quando decisões são revistas.
- **Alternativas consideradas**: só se as alternativas rejeitadas valem ser lembradas.
- **Consequências**: só se houver efeitos não óbvios a destacar.

## Quando oferecer

As três condições juntas:

1. **Difícil de reverter**: mudar de ideia depois tem custo relevante.
2. **Surpreendente sem contexto**: um leitor futuro vai estranhar "por que fizeram assim?".
3. **Resultado de um trade-off real**: havia alternativas genuínas e uma foi escolhida por motivos específicos.

Se é fácil de reverter, basta reverter. Se não surpreende, ninguém vai perguntar. Se não havia alternativa, não há o que registrar.

## O que qualifica

- Forma da arquitetura.
- Integrações entre partes do sistema.
- Tecnologias com lock-in (as que levariam um trimestre para trocar).
- Decisões de fronteira e escopo; os "nãos" explícitos valem tanto quanto os "sins".
- Desvios deliberados do caminho óbvio, para que ninguém "conserte" algo proposital.
- Restrições invisíveis no código (conformidade, contrato com terceiros, limites da fonte oficial).
- Alternativas rejeitadas quando a rejeição não é óbvia.

Decisões que já são regra de negócio do `AGENTS.md` continuam lá; o ADR registra o *porquê* e aponta para a regra, sem copiá-la.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
