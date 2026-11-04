---
name: writing-for-agents
description: "Escrever documentos para agentes: use ao criar ou editar skills, AGENTS.md ou CLAUDE.md."
---

# Escrever para agentes

Vale para qualquer documento que um agente consome: skill, `AGENTS.md`, `CLAUDE.md` ou um doc alcançado por ponteiro. A embalagem muda; a escrita não.

## Skills (essencial)

- Frontmatter com `name` (igual à pasta) e `description`. A descrição fica no contexto todo turno: uma frase curta.
- `disable-model-invocation: true` para comandos que só o usuário chama; a descrição vira resumo humano e não custa contexto.
- Skill que o agente deve achar sozinho (ou que outra skill chama) mantém descrição com os gatilhos.
- Corte por invocação só quando uma palavra-gatilho própria justificar a descrição sempre carregada.

## Ponteiro de contexto

Referência mantida no contexto que nomeia material fora dele e codifica a condição para alcançá-lo (descrição de skill, linha do `AGENTS.md` que cita um doc). A *redação* do ponteiro decide quando e com que confiabilidade o agente chega ao material. Alvo essencial atrás de ponteiro fraco é bug de variância: afie a redação antes; só embuta o material se afiar falhar.

- Ponha a palavra-líder no começo.
- Um gatilho por ramo; sinônimos do mesmo ramo se fundem.
- Corte a identidade que o corpo já carrega.

## Duas cargas

- **Carga de contexto:** custo do que está sempre carregado (linha do `AGENTS.md`, descrição de skill).
- **Carga cognitiva:** custo para o humano saber quais documentos existem e quando usar cada um. Gaste onde o julgamento humano importa.

## Hierarquia de informação

Um documento tem **passos** (ações em ordem) e **referência** (regras e fatos consultados sob demanda). Escada, do mais imediato ao mais distante: passo no arquivo; referência no arquivo; referência divulgada em arquivo separado, alcançada por ponteiro.

**Divulgação progressiva** é descer na escada para o topo continuar legível. Teste de ramo: embuta o que todo ramo precisa; empurre atrás de ponteiro o que só alguns ramos usam. **Co-localização:** definição, regras e ressalvas de um conceito sob um só título. **Excesso:** documento longo demais dilui a atenção, mesmo com toda linha viva; a cura é divulgar e dividir por ramo ou sequência.

## Critérios de conclusão

Todo passo termina com um critério que diz quando acabou. **Clareza:** dá para distinguir feito de não feito? Critério vago ("entendimento alcançado") convida conclusão prematura. Afie o limite primeiro; só se for irredutivelmente difuso e houver pressa observada, esconda os passos seguintes dividindo a sequência (só funciona entre contextos reais: subagente ou passagem). **Exigência:** "todo modelo alterado contabilizado" força mais trabalho que "produza uma lista". Os melhores critérios são verificáveis e exaustivos.

## Quando dividir

Dividir gasta uma das cargas; só corte se compensar. Por sequência: quando os passos seguintes tentam o agente a correr no atual. Cuidado com o inverso: unir sequências expõe cada passo ao que vem depois.

## Palavras-líder

Conceito compacto já presente no pré-treino do modelo (*lição*, *tracer bullets*, *tight*, *red*), repetido como token, nunca como frase. Ancora o comportamento com poucos tokens, no corpo (execução) e no ponteiro (invocação). Prefira palavra existente a cunhar uma nova. Procure trechos que se resumem a uma palavra.

**Negação:** proibir arrasta o comportamento proibido para o contexto e o torna mais disponível ("não pense em elefante"). Escreva o positivo ("escreva comentários de uma linha"). Proibição só entra como guarda rígida sem forma positiva, e mesmo assim junto do alvo positivo.

## Poda

- **Fonte única:** cada significado em um só lugar; duplicar custa manutenção e infla a proeminência.
- **Ambiente como fonte de verdade:** scripts do `package.json`, configs, layout de pastas, `--help`. Documento que os repete é um cache; só vale se a consulta for cara. Registre o que o agente não acha olhando: convenção tácita, motivo, pegadinha.
- **Relevância:** toda linha ainda importa? Sem poda, o destino é o **sedimento**: camadas velhas que se acumulam porque acrescentar é seguro e remover parece arriscado.
- **No-ops:** instrução que o modelo já obedece por padrão paga carga para nada. Teste: muda o comportamento em relação ao padrão? Falhou, apague a frase inteira. Palavra-líder fraca demais é no-op; troque por uma mais forte.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
