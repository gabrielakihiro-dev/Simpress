---
name: grill-with-docs
description: Entrevista implacável para afinar um plano ou design, atualizando o GLOSSARY.md e os ADRs durante a conversa.
disable-model-invocation: true
---

# Grill com documentação

Entreviste o usuário sem trégua até chegar a um entendimento compartilhado. Mapeie o assunto como uma **árvore de decisão**: cada decisão se ramifica nas decisões que dependem dela.

**Não implemente nada** (nem código, nem arquivos do projeto além do `GLOSSARY.md` e dos ADRs) até o usuário confirmar o entendimento compartilhado.

## Rodadas

A **fronteira** é o conjunto de decisões cujos pré-requisitos já estão resolvidos: as perguntas que dá para fazer *agora* sem chutar respostas que você ainda não ouviu. Faça a fronteira inteira de uma vez, numerando cada pergunta e dando sua resposta recomendada. Depois espere as respostas antes da rodada seguinte.

Formato de uma rodada:

```
❓ **Q1** - **<título>**: <corpo da pergunta, pode ter vários parágrafos e alternativas>

➡️ <sua resposta recomendada>

---

❓ **Q2** - **<título>**: <corpo da pergunta>

➡️ <sua resposta recomendada>
```

Redija cada pergunta de modo que "sim" aceite a resposta recomendada.

Cada rodada respondida remodela a árvore: decisões resolvidas empurram a fronteira para fora e liberam perguntas que dependiam delas. Recalcule a fronteira e faça a próxima rodada. Pergunta que depende de outra ainda aberta nesta rodada pertence a uma rodada *posterior*.

## Fatos são com você

Descobrir *fatos* é trabalho seu, nunca do usuário. Quando uma pergunta da fronteira precisar de um fato do ambiente (código, arquivos, `AGENTS.md`, comandos de leitura), busque você mesmo, com um subagente de contexto novo se valer a pena; não pergunte o que dá para consultar. Não bloqueie por isso: só as perguntas que dependem do fato esperam o relatório; faça o resto da fronteira agora. As *decisões* são do usuário: apresente e espere.

## Documentação durante a conversa

Chame a skill `domain-modeling` e siga-a durante toda a entrevista: confronte termos com o `GLOSSARY.md`, afine linguagem vaga, teste com cenários concretos, cruze o que o usuário diz com o código e grave no `GLOSSARY.md` cada termo resolvido assim que ele se firma. Ofereça um ADR (em `docs/arquitetura/adr/`) só quando as três condições dela valerem. Regras de negócio continuam no `AGENTS.md`; o glossário só aponta para elas.

## Fim

A sessão termina quando a fronteira está vazia (todos os ramos visitados, nada assumido em silêncio) **e** o usuário confirma que o entendimento está compartilhado. Só então, e se ele pedir, passe à implementação.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
