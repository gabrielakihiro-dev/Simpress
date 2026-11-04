# Catálogo de baixo valor e pré-filtro mecânico

## Catálogo de testes de baixo valor

Um teste que casa com um item falha na barra de valor, a menos que a barra de retenção nomeie o contrato que ele guarda:

- sondas de cobertura sem asserção (o teste só executa o código);
- autocomparações e cópias de identidade (`assertEqual(x, x)`, comparar o resultado com a própria entrada);
- fixtures, inventários ou listas de exportação copiados do código (o teste repete a lista de produção);
- greps exatos de código-fonte, imports ou strings que não são contrato declarado (por exemplo, ler `static/js/*.js` ou `*.py` e procurar um trecho);
- testes de predicados privados ou da forma de uma chamada, duplicados numa fronteira real;
- invocações duplicadas do mesmo contrato;
- reexecução, por chamador, dos testes de um auxiliar compartilhado;
- testes cujo único objetivo é manter vivo um export, global ou wrapper existente só para teste;
- código de produção cujos únicos chamadores são testes.

Nos testes do Simpress, cuidado com falsos positivos: um teste que lê o código-fonte ou o HTML pode ser a guarda independente mais barata de um rótulo aprovado, de uma regra do `AGENTS.md` ou de um contrato de `docs/arquitetura/CONTRATOS_API_BACKEND.md`; nesse caso ele fica.

## Pré-filtro mecânico

Antes de ler qualquer teste com o modelo, monte a lista curta com comandos (Git Bash; ajuste `<escopo>` para os caminhos em escopo, ou `tests`). A saída fica na memória da sessão ou no relatório em `%TEMP%`, nunca no repositório.

```bash
FILES=$(git ls-files -- <escopo> | grep -E '^tests/(test_[^/]+\.py|frontend/test_[^/]+\.cjs|e2e/[^/]+\.spec\.cjs)$')
[ -n "$FILES" ] || { echo "SEM_TESTES"; exit 0; }
# sem nenhuma asserção reconhecível
echo "$FILES" | xargs grep -L -E 'assert|expect|raises|fail\(' | sed 's/^/SEM_ASSERCAO:/'
# lê código-fonte do projeto (pode ser o contrato declarado: confirmar)
echo "$FILES" | xargs grep -l -E 'read_text\(|readFileSync\(|open\(' | sed 's/^/LE_FONTE:/'
# compara listas exportadas ou chaves
echo "$FILES" | xargs grep -l -E 'Object\.keys\(|\.keys\(\)|__all__' | sed 's/^/LISTA_DE_EXPORTS:/'
# quase duplicados (mesmo conteúdo sem espaços)
printf '%s\n' "$FILES" | while IFS= read -r f; do [ -n "$f" ] || continue; printf '%s %s\n' "$(tr -d '[:space:]' < "$f" | cksum | cut -d' ' -f1)" "$f"; done | sort | awk '$1==p{print "QUASE_DUPLICADO:" pf " " $2} {p=$1; pf=$2}'
```

Complementos úteis: arquivos de teste muito maiores que o módulo que testam; testes de `tests/frontend` e de `tests/e2e` que cobrem o mesmo rótulo ou fluxo (o e2e costuma ser o mais lento, então o duplicado mais barato de aposentar é o que o e2e já cobre melhor, nunca o contrário sem evidência).

Toda linha do pré-filtro entra no relatório como pista. Antes de propor algo, confirme se o teste é protegido (ver a seção "Testes protegidos" do `SKILL.md`).

Adaptado de garrytan/gstack (MIT, © 2026 Garry Tan).
