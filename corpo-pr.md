## O que muda
Redesenho visual da aba Chamados (F5), sem mudar fluxo, rotinas, endpoints nem regras de negócio.

- CSS: bloco `.sebrae-*` de `ck-cockpit.css` (linhas 1008–1046) trocado pelo CSS do artefato.
- HTML: topo `.sebrae-topo` e seção "Chamados novos". "Ler chamados antigos" saiu da Automação (F4) para o topo da F5, com os mesmos IDs.
- JS: cartão em três zonas, lista "Para finalizar:", selos nos antigos, `placeholder=" "` na descrição e ganchos de estado (`data-estado`, `aria-busy`). Antigos e finalizados continuam nascendo recolhidos.
- Guarda de `carregarNovosSebrae` aceita o painel F5 sozinho.
- Testes e `AGENTS.md` / `docs/operacao/sincronizar-chamados-sebrae.md` atualizados.

## Verificado
`node --check`, `tsc`, `tests/frontend` (324 ok) e e2e de sebrae-dashboard, cockpit-tools e cockpit-layout (143 ok, 1 ignorado; Chrome no Linux, desktop e mobile). Axe sem violações no painel F5. Sem rolagem horizontal de 320 a 2560 px.

## Não verificado
- pytest, mypy e compileall (a máquina tem Python 3.10; o projeto pede 3.12).
- Comparação visual lado a lado com o protótipo.
- Visual no Chrome do Windows.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01Etk6cG8LuTWTWoigJ61vbq
