# Estrutura do frontend

## Carregamento

Todo o código da interface fica em `frontend/src/` (TypeScript) e é empacotado pelo Vite em `static/dist/react-entry.js`, o único módulo que `static/index.html` carrega (a migração terminou na react-final-3). Fora do bundle só ficam `static/js/shared/theme-preference.js`, que aplica o tema antes da pintura, e os ícones Lucide em `static/vendor/`.

O bundle sai dividido em `static/dist/` (`vite.config.mts`, desde 18/11/2026); nenhum arquivo dali se edita à mão, e em conflito de merge se gera de novo com `npm run build:react`:

- `react-entry.js`: a entrada, único arquivo citado no HTML (com `?v=` de `versioned_html`). Importa os dois abaixo, que o navegador baixa em paralelo.
- `aplicacao-<hash>.js`: o resto de `frontend/src` fora de `paineis/` (arranque, aplicação, comum, ui, api) e os painéis montados na partida. `react-<hash>.js`: React e React DOM, que só mudam quando a versão sobe.
- `<painel>-<hash>.js`: os painéis sob demanda, listados em `frontend/src/paineis.ts`. A ponte (`waitForReactPanel` em `frontend/src/aplicacao/app.ts`) chama `window.SimpressReactSobDemanda[painel]()` na primeira ação; `main.tsx` baixa o arquivo, monta o painel e devolve as ações. Quem chama um painel sem passar por essa ponte precisa do mesmo recurso: o `ponteReact` próprio de `frontend/src/paineis/cartao-equipamento/montar.tsx` (abre `editar-equipamento` e `editar-apelido`) consulta `SimpressReactSobDemanda` quando o painel ainda não está em `window.SimpressReact`. Só entra nessa lista painel com ponte toda assíncrona, container escondido na partida e nada que precise rodar antes de abrir.

Os demais ficam na partida (avaliação de 23/11/2026, quando `ux-ticket` entrou na lista): `sebrae-dashboard`, `ferramentas-cockpit`, `resultado-comparacao`, `transporte`, `contatos-regionais`, `pesquisa-equipamento`, `importacao-planilhas`, `cartao-equipamento`, `historico-apelidos` e `indicadores-home` têm ponte síncrona; `regras-chamados` e `ux-chamados` são lidos direto em `window.SimpressReact`; `unidades`, `entra-users`, `historico-comparacoes`, `chrome-automation`, `sebrae-historico` e `sebrae-conflitos` são chamados no arranque; `paineis-dados` e `backups-regionais` registram ouvintes no `document` ao montar; `historico-transferencias` libera ações no `SimpressActionDispatcher` ao montar; `cockpit-chamados` desenha na Home visível; `relatorio-mensal` precisa do campo do mês no DOM antes de abrir.

O hash no nome troca o endereço de cada pedaço a cada build (o `?v=` só existe na entrada). Nenhum pedaço importa `react-entry.js`: sem o `?v=` seria outro módulo e a partida rodaria duas vezes. `tests/test_frontend_assets.py` confere isso, a falta de arquivos órfãos e as regras do CSP em todos os arquivos.

`frontend/src/arranque/entrada.ts` declara, em ordem, os utilitários compartilhados, as fábricas das funcionalidades, o início da aplicação e os aprimoramentos de página; `frontend/src/main.tsx` importa essa lista primeiro e só depois monta os painéis React. Os testes de fonte leem a mesma lista para manter a ordem alinhada.

`frontend/src/aplicacao/` contém as funcionalidades com estado e ações da aplicação; as pontes para os painéis React ficam em `pontes.ts`. `frontend/src/comum/` reúne utilitários usados por mais de uma funcionalidade. `frontend/src/ui/` contém infraestrutura de interface e renderizadores sem estado de domínio, como os renderizadores de busca e comparação. `frontend/src/paineis/` tem um painel React por pasta.

`frontend/src/aplicacao/app.ts` monta o contexto comum, cria as funcionalidades na mesma ordem declarada no `FEATURE_ORDER` e publica as ações esperadas pelos atributos `data-on-*` e pelos diálogos acessíveis.

## Estilos e cascata

A ordem dos estilos em `static/index.html` é deliberada:

1. fontes e utilitários compilados do Tailwind;
2. tokens do tema;
3. estilos da aplicação em `static/app.css`;
4. motion, navegação lateral, tema e refinamentos de UX.

Os estilos de tela e componente ficam em `static/styles/`. Antes de mover regras ou mudar camadas, confira os seletores concorrentes, ambos os temas, os breakpoints e os estados de foco. Os `!important` que representam estados temporários devem ser avaliados no contexto antes de qualquer remoção.

## Verificação

Os testes de frontend usam a ordem de `frontend/src/arranque/entrada.ts` para avaliar as fábricas no harness Node. A verificação completa do projeto continua centralizada em `npm run verify`; as mudanças visuais também dependem da suíte Playwright de interface.
