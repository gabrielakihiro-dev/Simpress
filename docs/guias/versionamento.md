# Versionamento e publicação de versões

Este guia explica como numerar as versões do Simpress, quando publicar uma versão nova e quais comandos usar. Ele vale para quem mantém o projeto; o operador só vê o resultado no `iniciar_servidor.bat`.

## Por que usar versões com tag

A atualização com um clique ([especificação](../operacao/atualizacao-um-clique.md)) **só oferece versões publicadas com uma tag `vX.Y.Z`**. Um commit novo no `main` não chega ao operador sozinho: ele precisa estar em uma versão publicada. Assim, o operador recebe apenas código que passou no CI, e não um `main` que pode estar quebrado temporariamente.

Uma tag é um nome fixo apontando para um commit. Exemplo: `v1.0.0` aponta para o commit exato que foi testado e aprovado como versão 1.0.0.

## Como numerar (SemVer simples)

O número tem três partes: `MAIOR.MENOR.CORREÇÃO`, sempre com `v` na frente da tag.

| Mudança | Parte que sobe | Exemplo |
| --- | --- | --- |
| Correção de erro, sem mudar o uso | CORREÇÃO | `v1.0.0` → `v1.0.1` |
| Função nova ou melhoria compatível com o uso atual | MENOR (zera a CORREÇÃO) | `v1.0.1` → `v1.1.0` |
| Mudança que exige outra forma de usar ou migração manual de dados | MAIOR (zera as outras) | `v1.4.2` → `v2.0.0` |

Regras:

- Use somente números: `v1.2.3`. Tags como `v1.2.3-rc1`, `teste` ou `1.2.3` (sem `v`) **não** são oferecidas pelo inicializador.
- Nunca reutilize nem mova uma tag já publicada. Se a versão tiver um problema, publique a próxima correção.
- A primeira versão proposta é `v1.0.0`.

## Quando criar uma tag

Crie a tag somente quando **todas** as condições forem verdadeiras:

1. O commit está no `main` do GitHub (`origin/main`), e não em outro branch.
2. O CI desse commit está **verde** (todas as verificações passaram).
3. O `CHANGELOG.md` desse commit já tem a seção da versão, por exemplo `## [1.0.0] - 2026-10-20`, com o que mudou escrito para o usuário final.

O inicializador confere a condição 1: uma tag fora do histórico do `origin/main` é ignorada. As condições 2 e 3 dependem de quem publica.

## Passo a passo para publicar

### 1. Preparar o CHANGELOG

Objetivo: deixar escritas as notas que o operador vai ler antes de atualizar.

Em um branch novo, renomeie a seção `## [Não lançado]` para a versão e a data, e crie uma seção `## [Não lançado]` vazia acima dela:

```markdown
## [Não lançado]

## [1.0.0] - 2026-10-20

### Adicionado
- ...
```

Abra um PR, espere o CI ficar verde e faça o merge no `main`.

### 2. Atualizar o `main` local

Objetivo: garantir que a tag vai apontar para o commit que está no GitHub.

```bash
git switch main
```

```bash
git pull --ff-only origin main
```

### 3. Conferir o commit e o CI

Objetivo: confirmar que o commit local é o mesmo do `origin/main` e que o CI dele passou.

```bash
git log -1 --oneline
```

```bash
gh run list --branch main --limit 3
```

O commit mostrado pelo `git log` deve ser o mesmo da execução mais recente, e ela deve estar como `completed success`. Se estiver vermelha ou ainda rodando, **não** crie a tag.

### 4. Criar a tag

Objetivo: dar um nome fixo ao commit testado. A opção `-a` cria uma tag anotada, que guarda autor, data e mensagem.

```bash
git tag -a v1.0.0 -m "Simpress v1.0.0"
```

Para conferir para qual commit a tag aponta:

```bash
git show --no-patch v1.0.0
```

Se errou antes de enviar, apague a tag **local** e crie de novo:

```bash
git tag -d v1.0.0
```

### 5. Enviar a tag para o GitHub

Objetivo: publicar a versão. Só depois deste comando os operadores passam a ver a atualização ao abrir o `iniciar_servidor.bat`.

```bash
git push origin v1.0.0
```

Envie sempre uma tag por vez, pelo nome. Não use `git push --tags`, que envia todas as tags locais, inclusive as de teste.

### 6. Conferir

Objetivo: confirmar que a tag chegou ao GitHub.

```bash
git ls-remote --tags origin v1.0.0
```

Em uma instalação de operador, o próximo `iniciar_servidor.bat` deve mostrar `Há uma versão nova (v1.0.0). Atualizar agora? (S/N)` junto com as notas do CHANGELOG.

## O que o inicializador faz com as tags

- Consulta as tags `vX.Y.Z` do `origin` e escolhe a maior.
- Considera como versão instalada a maior tag que já está no histórico local.
- Oferece a atualização só se a tag nova for maior que a instalada, estiver no `origin/main` e permitir fast-forward.
- Se o repositório não tiver nenhuma tag, não oferece atualização e explica que nenhuma versão foi publicada.
