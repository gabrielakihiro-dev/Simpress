# Estrutura do frontend

## Carregamento

`static/app-entry.js` declara, em ordem, os scripts compartilhados, as fábricas das funcionalidades, `static/app.js` e os aprimoramentos de página. A página carrega somente esse ponto de entrada como módulo; os testes de fonte leem a mesma lista para manter a ordem alinhada.

`static/js/features/` contém funcionalidades com estado e ações da aplicação. `static/js/shared/` reúne utilitários usados por mais de uma funcionalidade. `static/js/ui/` contém infraestrutura de interface e renderizadores sem estado de domínio, como os renderizadores de busca e comparação.

`static/app.js` monta o contexto comum, cria as funcionalidades na mesma ordem declarada no `FEATURE_ORDER` e publica as ações esperadas pelos atributos `data-on-*` e pelos diálogos acessíveis.

## Estilos e cascata

A ordem dos estilos em `static/index.html` é deliberada:

1. fontes e utilitários compilados do Tailwind;
2. tokens do tema;
3. estilos da aplicação em `static/app.css`;
4. motion, navegação lateral, tema e refinamentos de UX.

Os estilos de tela e componente ficam em `static/styles/`. Antes de mover regras ou mudar camadas, confira os seletores concorrentes, ambos os temas, os breakpoints e os estados de foco. Os `!important` que representam estados temporários devem ser avaliados no contexto antes de qualquer remoção.

## Verificação

Os testes de frontend usam a ordem de `app-entry.js` para avaliar as fábricas no harness Node. A verificação completa do projeto continua centralizada em `npm run verify`; as mudanças visuais também dependem da suíte Playwright de interface.
