# Contrato de movimento bento

Vale para todo o Simpress, exceto o Assistente (`#assistente-widget`). Neste projeto o contrato bento prevalece sobre a preferência global de 150–300 ms, e toda tela nova segue o mesmo contrato. Origem: `docs/planos/visual-bento.md` ("Especificação visual"). Referência visual aprovada: https://claude.ai/artifact/1MBeThmaD94YS5L4fCV3vp (canvas "Simpress Bento", 14/11/2026).

## Valores

| Movimento | Valor |
|---|---|
| Entrada de blocos | `opacity` 0→1 e `translateY(14px)`→0, 700 ms, `cubic-bezier(.2,.7,.2,1)` |
| Entrada de cartões | igual, 760 ms, escalonada de 80 ms por cartão |
| Brilho da borda, holofote e grade | aparecem em 500 ms no hover ou toque e seguem o ponteiro |
| Contagem de números | 0 até o valor, 900 ms, curva `1-(1-t)^3` |
| Anel | 1200 ms, mesma curva |
| Barras | 700 ms, mesma curva, começam 200 ms depois |
| Botões | `translateY(-3px)` e sombra `0 10px 30px -10px rgba(129,140,248,.5)`, 300 ms |
| Sub-abas | `translateY(-2px)` |
| Ícone do cartão | `translateY(-2px) rotate(-6deg)`, 500 ms |
| Seta "abrir" | `translate(3px,-3px)`, 300 ms |
| Ponto pulsante | 1.6 s, só em status real "ao vivo" (Chrome livre) |

- Clicar em sub-aba ou filtro repete contagem, anel e barras.
- Quadros-chave só com `opacity` e `transform`.

## Regras

- `prefers-reduced-motion: reduce`: nada anima; os números aparecem direto no valor final.
- Brilho só em cartões, painéis e blocos de KPI; nunca em linha de tabela.
- Nunca `overflow:hidden` no cartão real (cortaria menus, ⓘ, cabeçalhos fixos e tabelas roláveis); as camadas de brilho ficam em pseudo-elementos ou filhos `aria-hidden`.
- Sem dado inventado: o pulso e as contagens só mostram estado e números reais.
- Assistente (`#assistente-widget`, `.ck-assist*`) fica fora: não recebe brilho, entrada nem contagem do bento.

## Onde ficam

- `static/styles/ck-bento.css`: durações, curvas e quadros-chave.
- `static/js/ui/bento.js`: `iniciarBrilho()` (segue o ponteiro, ignora o Assistente) e `contarAte(el, alvo, formatar)` (termina com o texto final exato; no movimento reduzido, escreve o final na hora).
- `SimpressMotion` (`static/js/ui/ui-motion.js`, 160 e 220 ms) continua valendo para modais, gavetas e trocas de conteúdo; não é substituído por este contrato.
