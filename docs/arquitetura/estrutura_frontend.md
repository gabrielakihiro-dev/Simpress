# Estrutura do frontend

## Carregamento

Todo o código da interface fica em `frontend/src/` (TypeScript) e é empacotado pelo Vite em `static/dist/react-entry.js`, o único módulo que `static/index.html` carrega (a migração terminou na react-final-3). Fora do bundle só ficam `static/js/shared/theme-preference.js`, que aplica o tema antes da pintura, e os ícones Lucide em `static/vendor/`.

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
