# Plano: visual bento em todas as abas (menos o Assistente)

Pedido do usuário (14/11/2026): imitar em todas as abas e sub-abas o layout do componente "Interactive tech stack bento grid with hover effects" (https://21st.dev/@themeocean/components/interactive-tech-stack-bento-grid-with-hover-effects), adaptado aos dados do Simpress, com animações mais destacadas. O Assistente (F9) não muda.

## Decisões já tomadas (14/11/2026)

- **Sem React, sem shadcn, sem build novo.** O front continua JS puro + Tailwind; o visual do componente é recriado em CSS e num módulo JS pequeno. TypeScript via JSDoc fica para depois deste plano. Etapa 3 (futura, plano próprio a escrever quando o usuário pedir): React + TypeScript com Next.js, aba por aba, pelo usuário (pedido de 14/11/2026). Ponto a decidir nesse plano: Next.js com exportação estática servida pelo FastAPI local, sem servidor Node novo, mantendo CSP, cookie de sessão e dados só locais.
- **Paleta do componente** (o usuário escolheu "as novas cores"), com versão adaptada no tema claro. Substitui o artefato do Cockpit (DGgv5VBXhu4NrZ9DbxFQhC) como referência de cores; a disposição responsiva (320px a 2560px) continua valendo.
- **Animações acima de 300 ms liberadas nesta reformulação.** O teste que trava 150–300 ms é ajustado ao novo contrato, não apagado. O `~/.claude/CLAUDE.md` do usuário não muda.
- **Regras novas de animação do projeto (pedido de 14/11/2026, "crie novas regras depois de animações, para manter desse projeto"):** o Bloco 1 troca a regra antiga de 150–300 ms pelo contrato de movimento bento (seção "Especificação visual") em `frontend/AGENTS.md` (regra curta + caminho), `docs/design/DESIGN.md` (checklist de Motion), `docs/ui-motion/` (contrato completo), `.claude/skills/ajuste-visual-ui/SKILL.md` e `.agents/skills/ajuste-visual-ui/SKILL.md`. A regra diz que, neste projeto, o contrato bento prevalece sobre a preferência global de 150–300 ms, e que toda tela nova segue o mesmo contrato.
- **Referência visual aprovada (14/11/2026):** canvas "Simpress Bento", https://claude.ai/artifact/1MBeThmaD94YS5L4fCV3vp — piloto Resumo › Visão geral em 1366 px e 390 px, escuro e claro. A implementação imita esse desenho (cores, cartões, brilho, grade, ordem dos cartões, adaptação ao celular); números, regionais e categorias do desenho são ilustrativos e vêm dos dados reais.
- **Desenho antes de cada bloco seguinte (pedido de 14/11/2026):** terminado o Bloco 1, cada bloco (2, 3, 4) começa com o desenho das suas abas e sub-abas no mesmo canvas. O usuário decide depois do desenho se e quando implementar; a implementação se baseia sempre no desenho aprovado. Nenhuma sessão de bloco abre antes desse "aprovado".
- **Decisões do usuário sobre a Visão geral do Resumo (14/11/2026):**
  1. Os 6 contadores ficam nos dois lugares: Visão geral em grade bento e Divergências mantém a faixa (substitui a decisão de 11/11/2026, "contadores só em Divergências").
  2. "Ativos por regional" fica só na Visão geral, como último cartão da grade, e sai das outras sub-abas.
  3. O anel tem a legenda "com correspondência nas duas bases" e a conta (total_endpoint − "Sem correspondência — na Simpress") / total_endpoint.
  4. Opção A: sem comparação, a Visão geral fica habilitada e mostra só o cartão "Ativos por regional"; a grade completa aparece com comparação.
- **Base:** branch `claude/tech-stack-bento-grid-67b90e`, que parte de `claude/limpeza-textos-b4` (limpeza dos textos explicativos já aplicada).

## Especificação visual (valores do componente)

| Item | Escuro | Claro (adaptado) |
|---|---|---|
| Fundo da página | `#07080d` | `#f4f5fa` |
| Face do cartão | `#0b0d15` | `#ffffff` |
| Borda apagada | `rgba(255,255,255,.10)` | `rgba(15,23,42,.10)` |
| Brilho da borda | `radial-gradient(240px circle at var(--mx) var(--my), rgba(<accent>,.95), transparent 70%)` | alfa `.75` |
| Holofote interno | `radial-gradient(380px circle …, rgba(<accent>,.14), transparent 65%)` | alfa `.10` |
| Grade do cursor | linhas `rgba(255,255,255,.08)` 1px, passo 26px, máscara `radial-gradient(220px circle …, black, transparent 75%)` | linhas `rgba(15,23,42,.06)` |
| Texto | título do cartão 14px/500 `#cbd5e1`; número grande 36–48px semibold `#fff` `tabular-nums`; secundário `#94a3b8`; apagado `#64748b` | tons equivalentes com contraste AA |

- Destaques (`r, g, b`): índigo `129,140,248`; ciano `34,211,238`; esmeralda `52,211,153`; fúcsia `232,121,249`; âmbar `251,191,36`. Cada cartão de uma grade bento recebe um destaque em ciclo (`nth-child`), sem mudar o markup; no claro, textos em destaque usam a variante mais escura que passe AA.
- Cartão: raio 24px (face 23px, recuo 1px); preenchimento 20px (24px a partir de 640px). Camadas de brilho em pseudo-elementos ou filhos `aria-hidden`; **nunca `overflow:hidden` no cartão real** (cortaria menus, ⓘ, cabeçalhos fixos e tabelas roláveis).
- Grade bento: espaço 16px; a partir de 1024px, 4 colunas e linhas de 210px (cartão grande 2×2, alto 1×2, largo 4 colunas); 640–1023px, 2 colunas; abaixo de 640px, 1 coluna. Tabela continua tabela no desktop e vira cartões no celular (regra existente).
- Movimento **idêntico ao desenho** (pedido de 14/11/2026: "idêntico até as animações"), valores exatos de `Main.dc.html` do canvas:
  - entrada dos blocos e cartões: `opacity` 0→1 + `translateY(14px)`→0, 700 ms (cartões 760 ms), `cubic-bezier(.2,.7,.2,1)`, escalonada de 80 ms por cartão;
  - brilho da borda, holofote e grade: aparecem em 500 ms no hover/toque e seguem o ponteiro;
  - números: contam de 0 ao valor em 900 ms com `1-(1-t)^3`; anel: 1200 ms com a mesma curva; barras: 700 ms com a mesma curva, começando 200 ms depois;
  - clicar em sub-aba ou filtro repete contagem, anel e barras;
  - botões sobem 3 px com sombra `0 10px 30px -10px rgba(129,140,248,.5)` em 300 ms; sub-abas sobem 2 px; ícone do cartão sobe 2 px e gira -6° em 500 ms; seta "abrir" anda 3 px em diagonal em 300 ms;
  - ponto pulsante 1.6 s só onde há status real "ao vivo" (Chrome livre).
  Quadros só com `opacity` e `transform`.
- Ordem dos cartões: "Ativos por regional" sempre por último (depois de "Séries sem mapeamento"), em todas as larguras.

## Contratos entre arquivos

- `static/styles/ck-bento.css`: paleta, cartão com brilho, grade bento, quadros-chave. Carregado por último em `static/index.html` (depois de `ck-lembretes.css`).
- `static/js/ui/bento.js`, importado em `static/app-entry.js`:
  - `iniciarBrilho()`: um único `pointermove`/`pointerdown` delegado no `document`, limitado por `requestAnimationFrame`; grava `--mx`/`--my` com `el.style.setProperty` só no cartão sob o ponteiro (CSSOM, permitido pela CSP); ignora `#assistente-widget`.
  - `contarAte(el, alvo, formatar)`: anima o número e termina com `el.textContent === formatar(alvo)`, exatamente o texto que o renderizador já escrevia (pt-BR); com `prefers-reduced-motion`, escreve o final na hora; cancela a animação anterior do mesmo elemento.

## Regras para todas as sessões

- Ler `AGENTS.md`, `frontend/AGENTS.md` e este plano antes de editar. Preservar IDs, ARIA, `data-*`, manipuladores, rótulos aprovados, o componente ⓘ (`info-tip`) e os dois temas.
- **Assistente intocado:** nada em `#assistente-widget`, `.ck-assist*`, `assistant-chat.js` nem nas regras dele em `ck-cockpit.css`. Se a paleta nova vier por tokens globais, fixe os valores antigos no escopo do Assistente. Prova: `getComputedStyle` (fundo, cor, borda, sombra) dos elementos principais do Assistente igual antes e depois, mais captura.
- Sem dado inventado: nada de `Math.random`, selo "Live", latência ou terminal fictício; só números reais do sistema. Sem texto novo (sobretítulo, subtítulo, explicação): a limpeza de textos acabou de tirá-los.
- Brilho só em cartões, painéis e blocos de KPI; nunca em linhas de tabela.
- CSP (`domains/frontend_assets.py`): sem `<style>` nem `style=` no HTML.
- `prefers-reduced-motion` continua zerando durações (`ck-tokens.css`); contagem e entrada mostram o estado final na hora.
- 320px a 2560px sem rolagem horizontal; nenhum `min-width:1200px`; não remover `!important` mecanicamente.
- Markup em partial se edita no partial (`frontend/partials/*.html`); o resto em `static/index.html`, sem tocar nos marcadores `<!-- include: ... -->`. Classe Tailwind nova em HTML ou JS pede `npm run build:ui`.
- Playwright só na fixture (porta 8765), pelo fluxo da skill `playwright-teste`; capturas pela skill `ajuste-visual-ui` em `.claude/prints/visual-bento/` (fora do Git).
- Mudou tela: atualizar o `.md` da aba (`docs/cockpit-prompts/`) no mesmo bloco.
- Cada bloco termina com `npm run verify` e `npm run test:ui:e2e` verdes (e2e duas vezes seguidas, para pegar instabilidade da contagem); teto de 3 ciclos de correção sobre a mesma falha.
- Cada bloco roda numa sessão nova, cortada da branch do bloco anterior (o Bloco 1 parte de `claude/tech-stack-bento-grid-67b90e`). Fim do bloco: `ponytail:ponytail-review` no diff, commit, push só da branch do bloco (sem force), PR para `main`, `bind_pr` e `set_monitor` com `auto_fix: true`; sem merge nem auto-merge. A sessão roda testes, capturas, commit, push e PR sem pedir confirmação e para ao fim do bloco; quem abre o próximo é a conversa que escreveu o plano.
- Bloco que esgotar os 3 ciclos ou ficar bloqueado: commite o que estiver verde, faça push, abra o PR como rascunho dizendo o que falta e qual falha ficou, e relate. A cadeia para aí. Dúvida de design que muda o plano vai para a conversa do plano por `SendMessage`, sem decidir sozinha.
- Cada critério dado como pronto: `AC: <critério> — PROVEN BY <evidência>`.

## Bloco 1: fundação e piloto (Resumo F3 › Visão geral)

- **Objetivo:** paleta nova nos dois temas, cartão com brilho em `.ck-cartao` e `.ck-kpi` em todo o site, abas (`.ck-aba`) no estilo novo, entrada dos painéis, `bento.js`, e a sub-aba Visão geral do Resumo em grade bento com contagem nos KPIs (`cartaoMetricaComparacao`, `static/js/ui/comparison-result-renderer.js`).
- **Arquivos:** `static/styles/ck-bento.css` (novo), `static/js/ui/bento.js` (novo), `static/index.html`, `static/app-entry.js`, `static/js/ui/comparison-result-renderer.js`, `frontend/partials/cockpit-tool-panels.html` só se o CSS não bastar, `tests/frontend/test_ui_motion.cjs`, teste novo de `contarAte`, `frontend/AGENTS.md` (referência visual e regra de movimento novas), `docs/design/DESIGN.md` e `docs/ui-motion/` (novo contrato de movimento), as duas cópias de `ajuste-visual-ui/SKILL.md`, `docs/cockpit-prompts/` da Comparação.
- **Critérios de aceite:** visual da Visão geral idêntico ao desenho do canvas, inclusive animações e ordem dos cartões (1366px, 800px e 390px, claro e escuro); regras de animação novas gravadas nos arquivos acima; brilho segue o mouse e o toque; números terminam com o texto exato; Assistente igual ao de antes; sem rolagem horizontal de 320px a 2560px; testes verdes.
- **Verificar:** capturas antes/depois na fixture; `npm run verify`; `npm run test:ui:e2e` duas vezes.
- **Proibidos:** `static/js/features/assistant-chat.js`, regras `.ck-assist*`, `~/.claude/CLAUDE.md`.
- **Parada para aprovação:** ao fim do Bloco 1, a conversa do plano mostra as capturas ao usuário. Depois, cada bloco seguinte passa por: desenho no canvas, aprovação do usuário, implementação. Aprovadas, as capturas do Bloco 1 e o desenho de cada bloco viram a referência visual obrigatória dele (critério "igual ao desenho aprovado", por captura).

## Bloco 2: Resumo, Histórico de apelidos e Relatório mensal

- **Objetivo:** grade bento e contagem nas sub-abas restantes do Resumo F3 (Divergências, Apelidos, Usuários, Sem acesso, Backups), no Histórico de apelidos F7 e no Relatório mensal F8 (Visão, OS, Comparação, Sebrae, Base).
- **Arquivos:** `frontend/partials/cockpit-tool-panels.html`, `static/styles/ck-bento.css`, `static/js/features/cockpit-tool-panels.js`, `comparison-result.js`, `resumo-ativos.js`, `entra-users.js`, `backups-regionais.js`, `alias-history.js`, `monthly-report.js`, docs das abas.
- **Critérios e verificação:** os do Bloco 1, por sub-aba.

## Bloco 3: Chamados, OS e Cobertura

- **Objetivo:** o mesmo em Chamados F5 (Novos, Antigos, Destaques, Finalizados), OS F6 (Abertas, Finalizadas) e Cobertura F10 (Necessidades, Disponíveis, Reservas, Movimento, Devoluções).
- **Arquivos:** `sebrae-dashboard.js`, `sebrae-historico.js`, `sebrae-conflitos.js` (e o partial `sebrae-conflitos.html`), `cockpit-chamados.js`, `ux-chamados.js`, `coverage.js`, `ck-cobertura.css`, `ck-bento.css`, `cockpit-tool-panels.html` e docs das abas.
- **Critérios e verificação:** os do Bloco 1, por sub-aba. Fluxos de envio (UX, finalizar chamado) com cartões de confirmação intactos.

## Bloco 4: Home, Transporte, Automação, Termos, Lembretes, Pendências e entrega

- **Objetivo:** o mesmo em Home F1, Transporte F2, Automação F4, Termos (Entrega, Devolução), Lembretes (Hoje, Em breve) e Pendências; revisão final do conjunto.
- **Arquivos:** `static/index.html`, `card-equipamento.html`, `equipment-search.js`, `dashboard.js`, `transfer-form.js`, `chrome-automation.js`, `termos.js`, `lembretes.js`, `ck-termos.css`, `ck-lembretes.css`, `ck-pendencias.css`, `ck-bento.css`, docs das abas.
- **Critérios e verificação:** os do Bloco 1. Campo do PowerShell do Endpoint segue sem Enter (`tests/frontend/test_endpoint_powershell.cjs`). Revisão do `model-super-power:revisor` sobre o diff inteiro desde `claude/limpeza-textos-b4`.

## Status

- Bloco 1: desenho aprovado (14/11/2026); implementação em andamento.
- Bloco 2: pendente (desenhar primeiro).
- Bloco 3: pendente (desenhar primeiro).
- Bloco 4: pendente (desenhar primeiro).
