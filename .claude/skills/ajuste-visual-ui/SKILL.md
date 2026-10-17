---
name: ajuste-visual-ui
description: Ajustes visuais pontuais na interface do Simpress com prints antes/depois nos temas claro e escuro, em desktop e mobile, usando o fixture ui-fixture. Use para mudanças de CSS, layout, ícones, cores ou microinterações.
---

# Ajuste visual da interface

## Regras

- Mudanças pequenas e revisáveis; não substitua o design de forma ampla. Respeite medidas em pixels literalmente.
- Preserve IDs, atributos ARIA e `data-*`, manipuladores, regras de negócio, foco, acessibilidade, responsividade e os temas claro e escuro.
- Use os tokens de cor existentes; não introduza cores soltas. Não remova `!important` mecanicamente: corrija a causa.
- Para telas novas, escreva ou atualize a especificação antes. Se o usuário disser "Exclua o JavaScript por enquanto", fique em HTML/CSS.
- Animações sutis (150–300 ms) e com suporte a `prefers-reduced-motion`.
- Em telas menores, tabelas viram cards com os mesmos dados e ações; o desktop mantém a tabela.
- Textos visíveis seguem o `AGENTS.md` (por exemplo `Planilha Exportada com Sucesso!`, `No Endpoint`, `na Simpress`).

## Fluxo

1. Inicie o fixture isolado com a configuração `ui-fixture` de `.claude/launch.json` (porta 8765, `tests/support/serve_ui_motion_preview.py`). Ele não usa dados operacionais.
2. Tire os prints **antes**, em quatro combinações: desktop (1366×900) e mobile (390×844), cada um nos temas claro e escuro. Salve em `.claude/prints/<assunto>/antes-<tela>-<desktop|mobile>-<light|dark>.png` (pasta ignorada pelo Git).
3. Faça a alteração. Se o CSS do Tailwind mudar, rode `npm run build:ui`.
4. Tire os prints **depois** com os mesmos nomes, trocando `antes` por `depois`, e compare lado a lado.
5. Verifique o console do navegador, o foco por teclado e o contraste. Rode `npm run verify` e, quando a mudança afetar fluxos, `npm run test:ui:e2e`.
6. Relate o que mudou, os prints e o que não foi validado (por exemplo, navegador real com dados operacionais).
