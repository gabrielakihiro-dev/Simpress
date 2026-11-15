# Plano: migração da interface para TypeScript + React com Vite

Pedido do usuário (14/11/2026): migrar o site para TypeScript + React. Escolha do usuário na mesma data: **Vite + React**, não Next.js (o app é local, o FastAPI já é o servidor; Next.js exigiria exportação estática e não traria ganho). Substitui a "Etapa 3" citada em `docs/planos/visual-bento.md:7`.

## Decisões

- **Ordem:** TypeScript em `shared/` e `ui/` (sem build) → infraestrutura Vite → piloto em React → um painel por bloco → remoção do código antigo. Nunca tudo junto.
- **Visual bento primeiro.** Em 14/11/2026: bento Bloco 1 mesclado (PR #247; o "Status" de `docs/planos/visual-bento.md` ainda diz "em andamento"); Bloco 2 em sessão aberta, sem PR (branch `claude/nervous-agnesi-e0c73d`); Blocos 3 e 4 pendentes. Juntos eles tocam quase todos os painéis. Regra: um painel só migra para React depois que o bloco bento dele foi **mesclado no `main`**; "bloco bento aberto" = sessão ou PR do bento ainda não mesclado. Os Blocos 1 e 2 deste plano não tocam painéis, mas tocam arquivos comuns (`static/index.html`, `tailwind.input.css`, `static/js/ui/`, `AGENTS.md`, `frontend/AGENTS.md`, `visual-bento.md`): no início, a sessão compara com `git diff --stat origin/main...<branch do bento aberto>` e só segue se não houver arquivo em comum; havendo, espera o PR do bento mesclar.
- **O bento manda (pedido do usuário, 14/11/2026).** O usuário segue mudando o visual bento em todas as abas, exceto o Assistente (F9). Toda sessão deste plano parte do `main` mais recente. Arquivo que o bento mudou desde este plano: a sessão adapta o bloco ao visual bento atual primeiro, em partes, e nunca reverte nem "corrige" o bento para caber no React. O React reproduz o bento como estiver no `main`, não como estava quando o plano foi escrito.
- **Um servidor só.** O FastAPI continua servindo tudo. Sem servidor Node e sem `vite dev` em outra porta (quebraria o cookie `simpress_sessao_<porta>`). No desenvolvimento, `vite build --watch` grava em `static/dist/` e o FastAPI serve; o `?v=` acompanha porque `_asset_digest` (`domains/frontend_assets.py:38-51`) recalcula quando o mtime ou o tamanho mudam.
- **Build commitado, igual a `static/vendor`.** `static/dist/` entra no Git; a CI refaz o build e falha se houver diferença. Quem só roda o app continua sem `npm`.
- **CSP intacto.** `CONTENT_SECURITY_POLICY` em `domains/frontend_assets.py:12-16` não muda (`script-src`, `style-src`, `img-src` e `font-src` só `'self'`, sem `data:`).
- **TypeScript:** código novo em `frontend/src/**/*.ts(x)` com `strict: true`. O JS antigo ganha checagem por JSDoc e só vira `.ts` quando o painel dele for reescrito; não há renomeação em massa.
- **Painéis preservam contratos:** IDs, ARIA, `data-*`, atalhos F1–F10, textos aprovados, temas claro e escuro, contrato de movimento bento (`docs/ui-motion/contrato-bento.md`).
- **Testes não são relaxados.** Teste que lê o HTML montado e deixa de achar um ID passa a checar o DOM renderizado no Playwright; nunca é apagado sem substituto. Invariantes de segurança (Enter no PowerShell do Endpoint, `confirmado: true`, `enviar: true`) ganham teste Playwright equivalente **antes** de o JS antigo sair.
- **Assistente (F9) e cartões de confirmação** (Outlook, UX, SharePoint, Endpoint) migram por último, em bloco próprio, com revisão do `model-super-power:revisor`.

## Contratos entre arquivos

- **Build** (`vite.config.ts`; confirmar cada opção na doc da versão instalada): entrada `frontend/src/main.tsx`; saída `static/dist/react-entry.js` com nome fixo e **bundle único** (`inlineDynamicImports: true`, sem chunks), porque `versioned_html` (`domains/frontend_assets.py:92-104`) só versiona o arquivo citado no HTML; `base: "/static/dist/"`; `assetsInlineLimit: 0` (nada de `data:`); polyfill de `modulePreload` desligado; nenhum script inline nem `eval`.
- **CSS:** `.tsx` não importa CSS (viraria `<style>` ou arquivo sem link). Estilo vem de classes Tailwind e de `static/app.css`/`ck-*.css`. `static/styles/tailwind.input.css` ganha `@source "../../frontend/src";` (hoje usa `source(none)` e só varre `index.html`, partials, `app.js` e `js`).
- **HTML:** `static/index.html` ganha `<script type="module" src="/static/dist/react-entry.js">` depois de `/static/app-entry.js`. Os dois são módulos diferidos e rodam nessa ordem; `app.js:139-141` chama `inicializarAplicacao()` antes do React.
- **Montagem:** `main.tsx` importa os painéis migrados e monta cada um no contêiner `<div id="<painel>-react-root">` do partial. Ao migrar um painel, a fábrica dele sai de `FEATURE_ORDER` (`static/app.js:14`) e de `inicializarAplicacao`. O código antigo fala com o React só por `window` (funções que `main.tsx` publica, chamadas no clique) ou `CustomEvent`.
- **DOM com um dono só:** dentro de um contêiner React, nada do código antigo escreve no DOM. Ícones viram componente lido de `lucide.icons` (sem `lucide.createIcons` lá dentro); a contagem dos números vira hook; os aprimoramentos globais (`ux-enhancements`, `ck-cockpit-visual`, `data-panels`, `app-entry.js:56-59`) ganham versão por painel quando o painel migra.
- **API:** `frontend/src/api.ts` chama `window.SimpressApiFetch.apiFetch` (`static/js/shared/api-fetch.js:69-91`), que mantém o evento `simpress:servidor-offline`, o `detail` do 422 e `error.status` (409 de `versao_importacao`). Sem `fetch` cru.
- **Marca de vida:** `main.tsx` põe `data-react-pronto` no `<html>` ao terminar; o e2e confere a marca e escuta `securitypolicyviolation`.

## Bloco 1 — TypeScript em `shared/` e `ui/` (sem build)

- **Objetivo:** checagem de tipos em `static/js/shared/` (já incluída) e `static/js/ui/`, sem mudar comportamento.
- **Arquivos:** `tsconfig.ui.json` (`include` ganha `static/js/ui/*.js` e `frontend/types/globais.d.ts`); `frontend/types/globais.d.ts` (globais `window.Simpress*`, fora de `static/`); JSDoc em `static/js/ui/*.js`.
- **Proibidos:** `static/js/features/` (fica para depois de cada bloco bento, uma pasta de cada vez); mudar lógica, nomes, textos ou markup; renomear para `.ts`; ativar `strict`; arquivo de `ui/` que um bloco bento aberto esteja editando.
- **Critérios de aceite:** `tsc --project tsconfig.ui.json` sem erros; o JS emitido não muda (prova mecânica: `tsc --allowJs --removeComments --outDir` antes e depois e `diff`, tolerando só parênteses de cast JSDoc).
- **Verificar:** `npm run verify`; `npm run test:ui:e2e`; o `diff` da prova mecânica.

## Bloco 2 — Infraestrutura Vite + React (sem mudança visível)

- **Objetivo:** o build existe, roda local e na CI, e carrega no app sem alterar a tela.
- **Arquivos:**
  - `package.json`: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `@types/react`, `@types/react-dom`; scripts `build:react` e `dev:react` (`vite build --watch`); `build:ui` chama `build:react`.
  - `vite.config.ts`, `tsconfig.json` (`frontend/src`, `strict: true`), `frontend/src/main.tsx` e `frontend/src/api.ts` (contratos acima), `static/dist/`, `static/index.html` (tag), `static/styles/tailwind.input.css` (`@source`).
  - `scripts/verify.cjs`: tsc do novo `tsconfig.json` e checagem de que `static/dist` está atualizado (para falhar local, não só na CI); `vite` resolvido como o `tsc` (`findInRootOrMain`, linha 53), porque os worktrees não têm `node_modules`. Depois do merge, o checkout principal precisa de `npm ci` (avisar no PR e no `README.md`), senão o `verify` quebra em todos os worktrees.
  - `.github/workflows/ci.yml` e `ui-browser.yml`: conferir `static/dist` como `static/vendor`; `paths` do `ui-browser.yml` ganham `frontend/**`, `vite.config.ts` e `tsconfig*.json`.
  - Testes: `tests/test_maintenance_contracts.py` e `tests/test_frontend_assets.py` (nova tag, CSP, bundle único sem `data:`); varreduras de privacidade de `tests/AGENTS.md` passam a cobrir `frontend/src` e `static/dist`.
  - Arquivo gerado fora da leitura dos agentes (gasta token sem informar nada): `.graphifyignore` ganha `static/dist/` e `static/vendor/`; `.gitattributes` marca `static/dist/** linguist-generated=true` (o GitHub recolhe o diff no PR); `frontend/AGENTS.md` diz "não ler nem editar `static/dist/`; a fonte é `frontend/src/`".
  - Regras e docs (regra "Documentação de mudanças"): `AGENTS.md` raiz ("Stack": front sem framework → JS antigo + React em migração), `frontend/AGENTS.md`, `README.md` (trechos sobre o front), `docs/cockpit-prompts/14-cockpit-v2.md`, `docs/planos/visual-bento.md:7` (troca Next.js por este plano).
- **Proibidos:** `frontend/partials/`, `static/js/features/`, `static/app.css`; mudar o CSP.
- **Critérios de aceite:** `npm run build:ui` gera só `static/dist/react-entry.js` (sem chunks, sem `data:`); o app abre com `data-react-pronto` presente e zero `securitypolicyviolation`; rebuild na CI sem diferença; `npm audit --audit-level=moderate` passa; `npm run verify` passa num worktree novo depois de `npm ci` no checkout principal.
- **Verificar:** `npm run verify`; `npm run test:ui:e2e` (com o teste da marca e da CSP); CI do PR verde.

## Bloco 3 — Piloto em React

- **Pré-requisito:** pelo menos um bloco bento mesclado com um painel pequeno e isolado. A sessão monta a tabela "painel × estado do bento × acoplamento" (a partir de `docs/planos/visual-bento.md` e de `FEATURE_ORDER`) e confirma o painel com o usuário antes de começar.
- **Objetivo:** provar o caminho completo: dados reais, temas, movimento bento, atalhos, celular e desktop.
- **Arquivos:** `frontend/src/paineis/<painel>/`; o partial do painel (conteúdo vira contêiner); o módulo antigo em `static/js/features/` (removido ou reduzido à ponte); `static/app.js`; testes do painel; doc da tela em `docs/cockpit-prompts/`.
- **Antes de codar:** baseline `toHaveScreenshot` do painel atual na fixture (390 px e 1366 px, claro e escuro) e inventário nomeado dos testes que tocam o painel, incluindo os que usam `tests/frontend/support/app-sources.cjs`, `test_feature_modules.cjs` e `test_action_registry.cjs`.
- **Proibidos:** outros painéis; backend (`routers/`, `domains/`), salvo aprovação do usuário.
- **Critérios de aceite:** mesmos IDs, ARIA, `data-*`, textos e atalhos; screenshots iguais ao baseline (tolerância definida no teste) e `getComputedStyle` dos tokens bento; `prefers-reduced-motion` zera o movimento; cada teste do inventário passa ou foi movido para o Playwright com a mesma checagem; doc da tela atualizado.
- **Verificar:** `npm run verify`; `npm run test:ui:e2e`; app real aberto com dados locais.
- **Saída extra:** ordem dos painéis restantes (do mais isolado ao mais acoplado; Home/busca, Transferência e Comparação por último) registrada neste arquivo.

## Blocos 4 em diante — um painel por bloco

- Mesmo formato do Bloco 3 (baseline, inventário de testes, critérios), um painel por sessão e por PR, na ordem registrada no piloto, cada um só depois do bloco bento do painel.
- JSDoc em `static/js/features/` acompanha: o módulo de um painel que ainda não migrou ganha JSDoc quando o bloco bento dele mesclar.
- Bloco do Assistente e dos cartões de confirmação: testes Playwright das recusas e dos envios reais primeiro; revisão obrigatória do `model-super-power:revisor`.

## Bloco final — remoção do código antigo

- **Objetivo:** o React assume a página inteira.
- **Arquivos:** `static/app.js`, `static/app-entry.js`, `static/js/` restantes, `frontend/partials/` e a montagem em `assembled_html` (o `index.html` vira casca com o contêiner raiz); `tsconfig.ui.json`; `@source` mortos em `tailwind.input.css`; harness `tests/frontend/support/` e testes que liam o HTML montado; `frontend/AGENTS.md` e docs que citam partials.
- **Critérios de aceite:** nenhum arquivo em `static/js/`; suíte completa verde; CSP e cookie inalterados.
- **Verificar:** `npm run verify`; `npm run test:ui:e2e`; `git grep "app-entry\|partials/"` sem referências vivas; app real com dados locais.

## Execução

- Cada bloco roda numa sessão nova, com este plano como brief, e termina em PR próprio (push da branch da sessão, sem merge automático).
- Dentro da sessão: `model-super-power:batedor` para leitura, `executor` para o código, `revisor` antes do PR.
- Relatório final de cada bloco: uma linha `AC: <critério> — PROVEN BY <evidência>` por critério; sem evidência, não verificado.
- Teto de 3 ciclos de correção sobre a mesma falha; depois, a sessão para e devolve o que tentou.
- Dúvida de design que muda o plano: a sessão pergunta a quem escreveu o plano, sem decidir sozinha.
