---
name: domain-modeling
description: "Terminologia do domínio do Simpress: use ao discutir termos do código, editar o GLOSSARY.md ou registrar um ADR."
---

# Modelagem de domínio

Disciplina *ativa*: desafiar termos, inventar cenários de borda e registrar glossário e decisões no momento em que se firmam. Só ler o `GLOSSARY.md` para consultar vocabulário não exige esta skill; ela vale quando o modelo está mudando.

## Onde ficam os arquivos

- `GLOSSARY.md` na raiz do repositório (contexto único; sem `GLOSSARY-MAP.md`).
- ADRs em `docs/arquitetura/adr/`, numerados `0001-slug.md`. Crie a pasta só quando houver o primeiro ADR.
- As regras de negócio ficam no `AGENTS.md` (fonte única compartilhada com Codex e Cursor). O glossário define termos e aponta para a regra; não a repete.

Crie arquivos só quando houver o que escrever.

## Durante a conversa

- **Confrontar com o glossário.** Se o usuário usar um termo que conflita com o `GLOSSARY.md`, diga na hora: "O glossário define X como A, mas você parece querer dizer B. Qual vale?"
- **Afinar linguagem vaga.** Para termos soltos ou sobrecarregados, proponha um termo canônico.
- **Testar com cenários concretos.** Invente casos de borda que forcem o usuário a precisar os limites entre conceitos.
- **Cruzar com o código.** Quando o usuário descrever como algo funciona, confira se o código concorda e aponte contradições.
- **Atualizar o `GLOSSARY.md` na hora.** Termo resolvido entra no arquivo imediatamente, sem acumular. Formato em [FORMATO-GLOSSARIO.md](./FORMATO-GLOSSARIO.md).
- **Preservar os rótulos aprovados do projeto literalmente**, como `na Simpress`, `no Endpoint`, `Endpoint` e `Hostname no Endpoint`. Nunca "normalize" a grafia.

O `GLOSSARY.md` traz definições, nunca regras, especificações, rascunhos nem detalhes de implementação. Para cada termo, ponha no máximo um link para a seção que traz a regra, no doc que o índice do `AGENTS.md` indica (as regras detalhadas saíram da raiz em 10/11/2026); assim não nasce uma segunda fonte de verdade.

## ADRs com parcimônia

Ofereça um ADR só quando as três condições valerem: difícil de reverter, surpreendente sem contexto e resultado de um trade-off real. Faltando uma, não registre. Formato em [FORMATO-ADR.md](./FORMATO-ADR.md).

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
