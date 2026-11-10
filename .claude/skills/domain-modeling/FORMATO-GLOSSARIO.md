# Formato do GLOSSARY.md

O arquivo fica na raiz do repositório (`GLOSSARY.md`). Um único contexto; não há `GLOSSARY-MAP.md`.

## Estrutura

```md
# Glossário do Simpress

{Uma ou duas frases sobre o que é o sistema e por que o glossário existe.}

## Linguagem

**Endpoint**:
{Definição de uma ou duas frases: o que o termo É.}
_Evitar_: {sinônimos descartados}
_Regra_: [docs/operacao/automacao-chrome.md, "Consulta ao vivo do Endpoint na Home (03/11/2026)"](./docs/operacao/automacao-chrome.md)

**Hostname no Endpoint**:
{Definição.}
```

## Regras

- **Seja opinativo.** Havendo várias palavras para o mesmo conceito, escolha a melhor e liste as outras em `_Evitar_`.
- **Definições curtas.** Uma ou duas frases; defina o que o termo É, não o que faz.
- **Só termos do domínio do Simpress.** Conceitos gerais de programação (timeouts, tipos de erro, utilitários) não entram, mesmo bastante usados.
- **Sem regras nem implementação.** Regra de negócio mora no `AGENTS.md`. Para cada termo, no máximo um link `_Regra_` para a seção que a traz; nunca copie o conteúdo.
- **Rótulos aprovados, literalmente.** `na Simpress`, `no Endpoint`, `Endpoint` e `Hostname no Endpoint` mantêm a grafia e a caixa exatas definidas no `AGENTS.md`.
- **Agrupe em subtítulos** quando surgirem conjuntos naturais; se tudo for coeso, lista simples.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
