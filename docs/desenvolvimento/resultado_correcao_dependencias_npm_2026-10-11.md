# Correção das vulnerabilidades npm — 11/10/2026

## Resultado

O `npm audit` passou de **2 vulnerabilidades moderadas e 6 altas para zero**,
incluindo dependências de desenvolvimento. O resultado foi confirmado depois de
uma instalação limpa com `npm ci`. Esses números representam pacotes afetados
na árvore de dependências, incluindo os efeitos de vulnerabilidades transitivas.

## Alterações

| Dependência | Situação anterior | Correção |
| --- | --- | --- |
| `tailwindcss` | 3.4.17, com a cadeia de ferramentas afetada | Atualizado para 4.3.3 |
| `@tailwindcss/cli` | CLI integrada ao Tailwind 3 | CLI própria na versão 4.3.3 |
| `@parcel/watcher` | A CLI nova ainda fixava 2.5.1, que dependia de `micromatch`/`braces` | Override restrito à CLI para 2.6.0, que usa `picomatch` |
| `braces` | 3.0.3, sem versão corrigida disponível na auditoria realizada | Removido da árvore de dependências |
| `postcss-selector-parser` | 6.1.4, afetado pelo aviso de segurança | Removido da árvore de dependências |
| `source-map-js` | 1.2.1, afetado pelo aviso de segurança | Resolvido em 1.2.2 no lockfile |

O arquivo `package-lock.json` registra a árvore corrigida. Não foram usados
`npm audit fix --force`, exclusão de dependências da auditoria ou supressão dos
avisos. O override deve ser revisto quando a CLI adotar uma versão segura do
monitor de arquivos diretamente.

O build usa a CLI nova e gera `static/vendor/tailwind-4.3.3.css`; o HTML e o
contrato de assets apontam para esse arquivo. O CSS gerado pela versão antiga
foi removido.

Foram preservados os defaults de sombra, desfoque, foco e bordas usados pela
interface. As utilities continuam sem camada CSS para manter sua precedência
sobre regras de elementos em `app.css`. O espaçamento entre irmãos conserva o
comportamento anterior com painéis ocultos. Um teste de navegador protege a
tipografia do campo de série, o peso do botão de busca e o espaçamento da Home.

O CI agora executa `npm audit --audit-level=moderate` em etapas próprias, nos
jobs `verify` e `ui-browser`. O job de navegador também recompila os assets
antes dos testes. Avisos moderados ou superiores passam a interromper o job.

## Validação local

- `npm ci`: instalação limpa concluída; zero vulnerabilidades.
- `npm audit --json`: zero informações, baixas, moderadas, altas ou críticas.
- `npm run build:ui`: compilação concluída com Tailwind 4.3.3.
- Testes JavaScript: 114 aprovados.
- Testes Python isolados (`tests/run_tests.py`): 299 aprovados.
- Chromium: 37 testes aprovados, incluindo desktop, mobile, acessibilidade,
  responsividade, perfil de desempenho e a nova regressão de compatibilidade.
- Monitor nativo `@parcel/watcher` 2.6.0: inscrição, detecção de alteração em
  arquivo temporário e encerramento aprovados no Windows.
- `git diff --check`: sem erros.

## Compatibilidade e limites

A migração para Tailwind 4 requer Safari 16.4+, Chrome/Edge 111+ ou Firefox
128+, conforme o [guia oficial de migração](https://tailwindcss.com/docs/upgrade-guide).
Os testes de navegador locais usam Chromium; Safari e Firefox não foram
executados. Os testes utilizam dados fictícios e não alteram as planilhas
operacionais.

Zero vulnerabilidades significa zero avisos conhecidos pelo `npm audit` na
árvore verificada nesta data. Esta correção cobre as dependências npm; não
substitui a auditoria de segurança do restante da aplicação.

As alterações estão locais, sem commit ou push nesta execução. O workflow foi
atualizado, mas o CI remoto desta correção ainda não foi executado. As alterações
preexistentes fora deste escopo foram preservadas.

## Referências

- [Aviso de segurança de braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- [Aviso de segurança de postcss-selector-parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
- [Aviso de segurança de source-map-js](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
- [Release de @parcel/watcher 2.6.0](https://github.com/parcel-bundler/watcher/releases/tag/v2.6.0).
- [Personalização de utilities do Tailwind](https://tailwindcss.com/docs/adding-custom-styles).
