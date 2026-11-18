# Plano: migração da interface para TypeScript + React com Vite

Pedido do usuário (14/11/2026): migrar o site para TypeScript + React. Escolha do usuário na mesma data: **Vite + React**, não Next.js (o app é local, o FastAPI já é o servidor; Next.js exigiria exportação estática e não traria ganho). Substitui a "Etapa 3" citada em `docs/planos/visual-bento.md:7`.

## Decisões

- **Ordem:** TypeScript em `shared/` e `ui/` (sem build) → infraestrutura Vite → piloto em React → um painel por bloco → remoção do código antigo. Nunca tudo junto.
- **Visual bento primeiro.** Em 14/11/2026: bento Bloco 1 mesclado (PR #247; o "Status" de `docs/planos/visual-bento.md` ainda diz "em andamento"); Bloco 2 em sessão aberta, sem PR (branch `claude/nervous-agnesi-e0c73d`); Blocos 3 e 4 pendentes. **Nova ordem (usuário, 14/11/2026):** o bento para no Bloco 2 (Resumo F3, F7 e F8); com ele mesclado, o usuário libera a migração definitiva de todo o código, inclusive dos painéis que o bento ainda não redesenhou; os Blocos 3 e 4 do bento voltam depois, já sobre o React. Regra: o Bloco 2 deste plano e os painéis só começam com o bento Bloco 2 **mesclado no `main`**; painel ainda sem bento migra com o visual atual dele; "bloco bento aberto" = sessão ou PR do bento ainda não mesclado. Os Blocos 1 e 2 deste plano não tocam painéis, mas tocam arquivos comuns (`static/index.html`, `tailwind.input.css`, `static/js/ui/`, `AGENTS.md`, `frontend/AGENTS.md`, `visual-bento.md`): no início, a sessão compara com `git diff --stat origin/main...<branch do bento aberto>` e só segue se não houver arquivo em comum; havendo, espera o PR do bento mesclar.
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
- **HTML:** `static/index.html` carrega só `<script type="module" src="/static/dist/react-entry.js">`. Antes da react-final-3 ele vinha depois de `/static/app-entry.js` e `app.js:139-141` chamava `inicializarAplicacao()` antes do React; hoje `main.tsx` importa `frontend/src/arranque/entrada.ts` antes dos painéis, e `frontend/src/aplicacao/app.ts` chama `inicializarAplicacao()` no mesmo bundle.
- **Montagem:** como o piloto fez (ver "Resultado do piloto"): `main.tsx` acha os painéis sozinho e monta cada um no elemento `[data-react-painel="<painel>"]` do partial; a fábrica antiga fica em `FEATURE_ORDER` como ponte. O código antigo fala com o React só por `window` (`window.SimpressReact`, pela ponte `context.ponteReact`) ou `CustomEvent`. Texto original, substituído pelo piloto: contêiner `<div id="<painel>-react-root">` e fábrica fora de `FEATURE_ORDER`.
- **DOM com um dono só:** dentro de um contêiner React, nada do código antigo escreve no DOM. Ícones viram componente lido de `lucide.icons` (sem `lucide.createIcons` lá dentro); a contagem dos números vira hook; os aprimoramentos globais (`ux-enhancements`, `ck-cockpit-visual`, `paineis-dados`, `app-entry.js:56-59`) ganham versão por painel quando o painel migra.
- **API:** `frontend/src/api.ts` guarda a implementação do `apiFetch` (antes `api-fetch.js`; porte 1:1 para TypeScript na react-final-2) e publica `window.SimpressApiFetch` para a aplicação (`frontend/src/aplicacao/app.ts` lê dali); mantém o evento `simpress:servidor-offline`, o `detail` do 422 e `error.status` (409 de `versao_importacao`). Sem `fetch` cru.
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

- **Pré-requisito:** pelo menos um bloco bento mesclado com um painel pequeno e isolado. A sessão monta a tabela "painel × estado do bento × acoplamento" (a partir de `docs/planos/visual-bento.md` e de `FEATURE_ORDER`) e confirma o painel com o usuário antes de começar. No modo rápido sem o usuário acordado, a sessão escolhe o painel mais isolado e manda a escolha a quem a abriu, por `SendMessage`.
- **Objetivo:** provar o caminho completo: dados reais, temas, movimento bento, atalhos, celular e desktop.
- **Arquivos:** `frontend/src/paineis/<painel>/`; o partial do painel (conteúdo vira contêiner); o módulo antigo em `static/js/features/` (removido ou reduzido à ponte); `static/app.js`; testes do painel; doc da tela em `docs/cockpit-prompts/`.
- **Antes de codar:** baseline `toHaveScreenshot` do painel atual na fixture (390 px e 1366 px, claro e escuro) e inventário nomeado dos testes que tocam o painel, incluindo os que usam `tests/frontend/support/app-sources.cjs`, `test_feature_modules.cjs` e `test_action_registry.cjs`.
- **Proibidos:** outros painéis; backend (`routers/`, `domains/`), salvo aprovação do usuário.
- **Critérios de aceite:** mesmos IDs, ARIA, `data-*`, textos e atalhos; screenshots iguais ao baseline (tolerância definida no teste) e `getComputedStyle` dos tokens bento; `prefers-reduced-motion` zera o movimento; cada teste do inventário passa ou foi movido para o Playwright com a mesma checagem; doc da tela atualizado.
- **Verificar:** `npm run verify`; `npm run test:ui:e2e`; app real aberto com dados locais.
- **Saída extra:** ordem dos painéis restantes (do mais isolado ao mais acoplado; Home/busca, Transferência e Comparação por último) registrada neste arquivo.
- **Saída extra (modo rápido):** o mecanismo de painéis independentes descrito em "Modo rápido", provado no próprio piloto, e a tabela de grupos conferida (acoplamento real, invariantes) e registrada neste arquivo.

### Resultado do piloto (15/11/2026)

- **Painel:** `resumo-ativos` (cartão `Ativos por regional`, Resumo F3). Motivo: um módulo só, sem estado compartilhado (`appState`), sem invariante de envio, só leitura de `GET /api/painel`, já no visual bento. Doc da tela: `docs/cockpit-prompts/08-comparacao-operacional.md`, "Piloto React". Spec modelo para os grupos: `tests/e2e/react-piloto.spec.cjs`.
- **Build:** o arquivo real é `vite.config.mts` (o contrato acima cita `vite.config.ts`).
- **Bundle dividido (18/11/2026):** o bundle único do contrato acima (`inlineDynamicImports: true`) deixou de valer. `static/dist/` tem a entrada `react-entry.js` (única no HTML), `aplicacao-<hash>.js`, `react-<hash>.js` e um `<painel>-<hash>.js` por painel sob demanda (lista em `frontend/src/paineis.ts`). Detalhe em `docs/arquitetura/estrutura_frontend.md`, "Carregamento".
- **Mecanismo de painéis independentes (os 4 pontos do "Modo rápido"):**
  1. `frontend/src/main.tsx` acha os painéis com `import.meta.glob("./paineis/*/montar.tsx", { eager: true })`. Cada `montar(container)` recebe o elemento `[data-react-painel="<painel>"]` do partial e devolve as ações que o código antigo chama. O registro fica congelado em `window.SimpressReact`, e o evento `simpress:react-pronto` avisa que terminou. Painel que falha dentro de `montar()` não derruba os outros; erro no topo de um `montar.tsx` (na importação) derruba o bundle inteiro, então cada `montar.tsx` só importa e não executa nada no topo. Painel novo = pasta nova; ninguém edita `main.tsx`.
  2. **Desvio:** em vez de uma marca que pula a fábrica, o módulo antigo continua em `FEATURE_ORDER` e em `app-entry.js`, reduzido a ponte: `context.ponteReact("<painel>", ["acao"])` (`static/app.js`) devolve funções assíncronas que esperam o painel React (evento `simpress:react-pronto` ou, se o bundle falhar, o `load` da janela) e rejeitam com `O painel React "<painel>" não carregou.` se ele faltar. Motivo: as ações continuam publicadas em `window` como antes, os chamadores antigos (por exemplo `cockpit-tool-panels.js`) não mudam e `FEATURE_ORDER`, `app-entry.js` e os testes que os leem ficam intactos. Cada grupo edita só o próprio módulo-ponte. Regra: ação que o código antigo chama sem tratar erro captura a rejeição na ponte (como `resumo-ativos.js`), para a tela antiga não quebrar.
  3. Estado compartilhado: `frontend/src/estado-app.ts` (`lerEstado`/`gravarEstado` sobre `window.SimpressApp.state`), com as chaves de `appState` (`currentEquipamento`, `equipamentoSelectionRevision`, `retiradaCidadeSelecionada`, `unidadesList`, `previaPlanilhasAtual`). O piloto não usa estado compartilhado, então o adaptador ainda não rodou em tela: o primeiro grupo que o usar prova com teste próprio. `movimentacaoPendente` fica fora: só `transfer-form` (G4) a usa.
  4. Testes compartilhados: nenhuma edição necessária. `tests/frontend/test_feature_modules.cjs` e `tests/frontend/support/app-sources.cjs` derivam a lista de `FEATURE_ORDER` e dos imports de `app-entry.js`, que a ponte mantém.
- **Desvio no contêiner:** a seção que já existe no partial ganha `data-react-painel="<painel>"` e fica vazia, em vez de um `<div id="<painel>-react-root">` novo. Assim ID e ARIA da seção ficam iguais e não entra um elemento a mais (screenshots iguais ao baseline).
- **Edições compartilhadas** (só na revisão de integração ou no Bloco final):
  - `static/styles/tailwind.input.css`: `@source "../../frontend/src";` quando um painel React usar classe utilitária do Tailwind que não exista no HTML nem no JS antigo (o piloto usa só classes `ck-*` existentes e não precisou);
  - remoção das pontes, das fábricas em `FEATURE_ORDER` e dos imports em `app-entry.js`: Bloco final.
- **Dono de cada arquivo compartilhado:** `frontend/src/main.tsx`, `frontend/src/estado-app.ts`, `static/app.js`, `static/app-entry.js`, `static/index.html`, `static/js/shared/`, `static/js/ui/`, `tailwind.input.css` e `tests/frontend/support/`, `frontend/types/globais.d.ts`: piloto (feito) e Bloco final; a revisão de integração faz só a lista "Edições compartilhadas". Nenhum grupo os edita.
- **Arquivos compartilhados que o piloto tocou e que têm outro dono** (edição restrita ao trecho do `resumo-ativos`; o dono não precisa mudar nada por causa do piloto):
  - `frontend/partials/cockpit-tool-panels.html`: cada grupo edita só a seção do próprio painel; o piloto mudou só `#resumo-ativos-secao` (ganhou `data-react-painel`, ficou vazia);
  - `tests/frontend/test_cockpit_tool_panels.cjs`: dono G2; o piloto trocou só a lista de IDs do painel Resumo (os `resumo-regionais*` saíram para `react-piloto.spec.cjs`, entrou `resumo-ativos-secao`);
  - `static/dist/`: gerado, sem dono; em conflito de merge, gere de novo com `npm run build:react` e commite, nunca resolva à mão.
- **`cockpit-tool-panels.js` (G2) não mudou:** a ponte mantém o nome `carregarResumoAtivos`, o registro em `FEATURE_ORDER` e o efeito (promessa que nunca rejeita, como no cartão antigo).
- **Grupos conferidos** (linhas de `static/js/features/` em 15/11/2026; estado = chaves de `appState` usadas; invariante = trata `confirmado`, `enviar` ou recusa de envio):

  | Grupo | Arquivos (linhas) | Estado compartilhado | Invariante |
  |---|---|---|---|
  | G1 | `sebrae-dashboard` 2443, `cockpit-chamados` 421, `sebrae-conflitos` 204, `sebrae-historico` 104 (3172) | nenhum | sim |
  | G2 | `cockpit-tool-panels` 2512 (saiu para o Bloco final na revisão de integração, 15/11/2026), `inventory-upload` 427, `configuracao-local` 401, `units-catalog` 154 (3494) | `currentEquipamento`, `previaPlanilhasAtual`, `unidadesList` | não |
  | G3 | `equipment-search` 1402, `equipment-editor` 502, `full-equipment-search` 221, `equipment-dossier` 217, `alias-history` 139 (2481) | `currentEquipamento`, `equipamentoSelectionRevision`, `retiradaCidadeSelecionada` | sim |
  | G4 | `transfer-form` 893, `regional-contacts` 708, `ux-chamados` 202, `entra-users` 89 (1892) | `currentEquipamento`, `equipamentoSelectionRevision`, `retiradaCidadeSelecionada`, `unidadesList` | sim |
  | G5 | `comparison-result` 850, `dashboard` 674, `comparison-history` 563, `backups-regionais` 349, `monthly-report` 87 (2523) | `currentEquipamento` | sim |
  | G6 | `lembretes` 990, `coverage` 569, `termos` 451 (2010) | nenhum | sim |
  | G7 | `chrome-automation` 837, `outlook-email` 720, `ux-ticket` 421, `ticket-rules` 234 (2212) | `currentEquipamento`, `unidadesList` | sim |
  | G7b | `assistant-chat` 1446 (widget global e cartão de confirmação; saiu do G7 por tamanho) | nenhum | sim |
  | Bloco final | `app-shell` 140, `cockpit-tool-panels` 2426 (revisão de integração, 15/11/2026), `sebrae-dashboard` 2443 e `inventory-upload` 427 (G8, 15/11/2026) | `previaPlanilhasAtual`, `currentEquipamento` (`inventory-upload`) | sim (SharePoint `enviar`, já gravado no G8) |
  | Piloto (já migrado, Bloco 3) | `resumo-ativos` (ponte de 19 linhas; cartão em `frontend/src/paineis/resumo-ativos/`) | nenhum | não |

  Todo arquivo de `static/js/features/` tem um dono só. Acoplamento entre grupos: só pelo `appState` (pelo adaptador, nunca cópia) e pelas ações publicadas em `window` (pela ponte). `cockpit-tool-panels` (Bloco final; era do G2 até a revisão de integração de 15/11/2026) chama ações de painéis de outros grupos ao abrir cada ferramenta; como as pontes mantêm os nomes, isso não cria edição cruzada.
- **Ordem dos painéis restantes** (modo normal; no modo rápido, a ordem sugerida dentro de cada grupo), do mais isolado ao mais acoplado:
  1. sem estado compartilhado nem envio: `monthly-report`, `sebrae-historico`, `configuracao-local`, `cockpit-chamados`, `dashboard`, `comparison-history`;
  2. com invariante, sem estado compartilhado (teste Playwright do invariante antes): `termos`, `coverage`, `lembretes`, `sebrae-conflitos`, `backups-regionais`, `sebrae-dashboard`;
  3. com `unidadesList` ou `previaPlanilhasAtual`: `units-catalog`, `inventory-upload`;
  4. com `currentEquipamento`: `alias-history`, `entra-users`, `equipment-dossier`, `regional-contacts`, `ux-chamados`, `equipment-editor`;
  5. envio real e Assistente: `ticket-rules`, `ux-ticket`, `outlook-email`, `chrome-automation`, `assistant-chat`;
  6. por último: `comparison-result` (Comparação), `transfer-form` (Transferência), `full-equipment-search` e `equipment-search` (Home/busca);
  7. `app-shell` e `cockpit-tool-panels`: Bloco final.

## Modo rápido (escolha do usuário, 14/11/2026)

Meta: de 2 a 4 dias em vez de semanas. Substitui "um painel por bloco" pelos grupos abaixo, rodando em paralelo depois do piloto.

- **Cronograma:**
  - Dia 1: Bloco 2 e piloto, em sequência.
  - Dia 2: grupos G1 a G6, uma sessão por grupo, em paralelo. Só começa depois que o Dia 1 terminar, com os PRs do Bloco 2 e do piloto mesclados no `main`.
  - Fim do Dia 2: revisão de integração (ver abaixo), só depois que todas as sessões de grupo abrirem PR e o Antigravity mesclar os PRs.
  - Dia 3: grupo final (G7) sozinho; depois o G7b (Assistente); depois G8, G9 e G10 (módulos adiados do Dia 2, ver "Adiados do Dia 2"), um de cada vez; depois o Bloco final.
  - Dia 4: revisão geral e correção (ver "Dia 4").
- **Pendências:** todo PR da migração tem no corpo a seção "Pendências para o Dia 4" (ou "nenhuma"). Ela lista: falha de CI ou teste que apareceu no caminho, item da revisão ponytail ou do revisor não corrigido, falha que bateu o teto de 3 ciclos e atalho com limite conhecido.
- **Merge:** feito pelo **Antigravity**, não pelas sessões do Claude. As sessões nunca fazem merge nem ligam auto-merge. Cada PR deixa no corpo `Depende de: #N` (ou "nenhum") e só é marcado pronto (fora de rascunho) com a CI verde. O Antigravity mescla só PR verde, sem conflito, depois das dependências.
- **Painéis independentes (o piloto cria; nenhum grupo edita depois):** nenhum grupo toca arquivo compartilhado (`frontend/src/main.tsx`, `static/app.js`, `static/app-entry.js`, `static/index.html`, `tailwind.input.css`, `tests/frontend/support/`). O piloto faz:
  - `main.tsx` achar os painéis sozinho (por exemplo, `import.meta.glob` eager em `frontend/src/paineis/*/montar.tsx`, que cabe no bundle único);
  - o código antigo pular a fábrica de um painel migrado por uma marca no arquivo do próprio painel, sem editar `FEATURE_ORDER`;
  - o estado compartilhado (`appState` de `static/app.js`) ser lido e gravado pelo React por um adaptador em `frontend/src/`, que só o piloto e o Bloco final alteram;
  - os testes compartilhados que hoje listam painéis (`tests/frontend/test_feature_modules.cjs`, `test_action_registry.cjs`, `tests/frontend/support/app-sources.cjs` e outros que o piloto achar) lerem a lista de painéis migrados dos arquivos de cada painel, para nenhum grupo editá-los. O que não couber vai para a lista "Edições compartilhadas", feitas só na revisão de integração.

  Se algum desses pontos não couber, a sessão do piloto pergunta a quem escreveu o plano antes de seguir.
- **Ordem e espera:** cada sessão parte do `main` com as dependências já mescladas. O piloto espera o bento Bloco 2 e o Bloco 2 deste plano; os grupos esperam o piloto. Quem orquestra espera o merge do Antigravity antes de abrir a sessão seguinte.
- **Dono de cada arquivo (Dia 2):** o brief de cada grupo lista os arquivos dele: os módulos do grupo em `static/js/features/`, os partials deles, `frontend/src/paineis/<painel>/` e `tests/e2e/react-<grupo>.spec.cjs`. Arquivo fora da lista não se edita. Se precisar, a sessão manda por `SendMessage` a quem a abriu, e a edição vai para "Edições compartilhadas".
- **Revisão de integração (fim do Dia 2):** sessão nova a partir do `main` com G1 a G6 mesclados. Faz as "Edições compartilhadas", roda `npm run verify` e `npm run test:ui:e2e` completos, roda `ponytail:ponytail-review` no diff do Dia 2, usa o `model-super-power:revisor`, abre o app real com dados locais em cada aba migrada e corrige o que falhar. Termina em PR. O Dia 3 só começa com esse PR mesclado.
- **Grupos:** proposta por arquivo de `static/js/features/`, de cerca de 2 a 3 mil linhas cada. O piloto confere e ajusta. Os arquivos não se repetem entre grupos.
  - G1 Sebrae: `sebrae-dashboard`, `sebrae-historico`, `sebrae-conflitos`, `cockpit-chamados`.
  - G2 Ferramentas: `cockpit-tool-panels` (saiu para o Bloco final na revisão de integração, 15/11/2026), `inventory-upload`, `units-catalog`, `configuracao-local` (este entrou no piloto: não tinha dono).
  - G3 Equipamentos: `equipment-search`, `equipment-editor`, `equipment-dossier`, `full-equipment-search`, `alias-history`.
  - G4 Transporte e contatos: `transfer-form`, `regional-contacts`, `ux-chamados`, `entra-users`.
  - G5 Resumo e comparação: `dashboard`, `backups-regionais`, `comparison-result`, `comparison-history`, `monthly-report` (`resumo-ativos` saiu: migrou no piloto).
  - G6 Cobertura e agenda: `coverage`, `termos`, `lembretes`.
  - G7 final (envio real): `outlook-email`, `ux-ticket`, `ticket-rules`, `chrome-automation`.
  - G7b Assistente: `assistant-chat` (saiu do G7 por tamanho; vem depois do G7 e antes do G8, sozinho, porque trata o cartão de confirmação de envio).
  - `app-shell` vai para o Bloco final (decisão do piloto: é a casca da página, que o React só assume no fim).
  - `cockpit-tool-panels` também vai para o Bloco final (revisão de integração, 15/11/2026): é o roteador das ferramentas e chama ações de quase todos os grupos; o G2 só tirou dele o bloco de Unidades.
  - **Adiados do Dia 2** (decisão da revisão de integração, 15/11/2026; motivos nas "Pendências para o Dia 4" de cada PR). Os grupos do Dia 2 deixaram estes módulos no código antigo porque outros módulos antigos leem IDs deles ou chamam funções síncronas deles. Vão para o Dia 3, depois do G7, em três grupos, **um de cada vez** (cada um parte do `main` com o anterior mesclado), porque os IDs e as funções cruzam os grupos e o G7 usa `currentEquipamento` e `unidadesList`:
    - G8 Sebrae e importação (#258, #257): `sebrae-dashboard` 2443, `cockpit-chamados` 421, `inventory-upload` 427 (3291). Estado: `previaPlanilhasAtual`, `currentEquipamento` (`inventory-upload`). Invariante: sim (SharePoint `enviar`). `cockpit-chamados` depende dos contêineres no partial do G2 e em `card-equipamento.html`; `inventory-upload` mistura o modal com Entra e tem o botão `#btn-exportar-equipamentos`, lido pelo `dashboard`. Resultado (15/11/2026): o G8 migrou só o `cockpit-chamados` e gravou no código antigo os invariantes e as baselines dos três (`tests/e2e/react-g8.spec.cjs`). Foram para o Bloco final: `sebrae-dashboard` (o `mostrarChamadoSebrae` é síncrono e chamado por outros módulos, tem a raiz React aninhada `#sebrae-historico-resumo` e contêineres em 2 lugares) e `inventory-upload` (depende do `modais.html` compartilhado, do harness compartilhado e da ligação `app.*` com o `comparison-history` do G9).
    - G9 Resumo e comparação (#260): `comparison-result` 850, `dashboard` 674, `comparison-history` 563, `monthly-report` 87 (2174). Estado: `currentEquipamento` (`comparison-result`). Invariante: não. `monthly-report` é chamado por `cockpit-tool-panels`. `comparison-history` é chamado por `static/app.js` e por `inventory-upload` (G8), e `frontend/src/paineis/paineis-dados/paineis.ts` (antes `data-panels.js`) põe um `MutationObserver` em `#total-historico-comparacoes` uma vez, na instalação: o React precisa manter esse nó desde a instalação e atualizá-lo no lugar (ou trocar o observer por um evento), senão o painel e o sino param de atualizar sem erro. Outros módulos leem IDs do `dashboard` (`alerta-backups-regionais`, `btn-exportar-equipamentos`, `readiness-panel`) e do `comparison-result`: a ponte mantém os nomes e os IDs. Resultado (16/11/2026, BF3, em PR): `dashboard` e `comparison-result` migraram para `frontend/src/paineis/indicadores-home/` e `frontend/src/paineis/resultado-comparacao/`, com pontes finas que mantêm os nomes e os IDs (`tests/e2e/react-bf3.spec.cjs`, gravado no código antigo).
    - G10 Equipamento e transporte (#261, #259): `equipment-search` 1402, `transfer-form` 893, `regional-contacts` 708, `equipment-editor` 502, `full-equipment-search` 221, `alias-history` 139 (3865). Estado: `currentEquipamento`, `equipamentoSelectionRevision`, `retiradaCidadeSelecionada`, `unidadesList`. Invariante: sim. Ficam juntos porque `transfer-form` chama `limparSelecaoEquipamento` de `equipment-search`, `cockpit-tool-panels` chama `acoesEventoHistorico` de `alias-history` sem esperar, `ui/ck-cockpit-visual.js` chama `window.cancelarDadosCadastrais` de `equipment-editor`, e `transfer-form` tem 25 IDs lidos por outros módulos. `equipment-editor` ganha o teste Playwright do invariante antes de mudar.
    - Andamento do G8, `sebrae-dashboard` (16/11/2026, branch `claude/react-bf2-adb76b`, PR #272 mesclado): migrado para `frontend/src/paineis/sebrae-dashboard/` (`estado.ts` com a fábrica `criarDashboardSebrae`, `tipos.ts`, `montar.tsx`); `static/js/features/sebrae-dashboard.js` virou ponte com as mesmas 7 ações. `mostrarChamadoSebrae` é síncrona (`ponteReactSincrona`), porque `cockpit-chamados.js` usa o cartão devolvido no mesmo turno; as outras seis são assíncronas (`ponteReact`) e, sem o painel, registram `O painel React "sebrae-dashboard" não carregou.` e resolvem `undefined`. O contêiner `<div data-react-painel="sebrae-dashboard" hidden>` fica depois de `#sebrae-novos-avisos`, e o painel não recria, move nem esvazia `#sebrae-historico-resumo` nem `#sebrae-conflitos` (teste `tests/frontend/test_bf2_sebrae_bridge.cjs`). Mudança de momento de execução: `instalarVisao()` e o listener `storage` passam a rodar no `montar()` (depois de `app-entry.js`), e não mais na criação do módulo em `static/app.js`. Sem rotina, dado gravado, endpoint nem escrita em sistema externo novos.
    - Andamento do G8, `inventory-upload` e `ticket-rules` (16/11/2026, mesma branch): `inventory-upload` foi para `frontend/src/paineis/importacao-planilhas/` (`estado.ts`, `montar.tsx`) e `ticket-rules` para `frontend/src/paineis/regras-chamados/` (`regras.ts` com a fábrica `criarRegrasChamados`, `montar.tsx`). `static/js/features/inventory-upload.js` virou ponte: `abrirImportacaoModelo`, `fecharImportacaoModelo`, `abrirModalAtualizarPlanilhas`, `fecharModalAtualizarPlanilhas` e `limparPreviaUploadPlanilhas` síncronas; `inicializarExportacaoAutomaticaHistorico`, `inicializarArquivosAtualizacaoPlanilhas`, `enviarModeloLocal`, `previsualizarPlanilhas`, `enviarPlanilhas` e `exportarEquipamentosAtualizados` assíncronas. `static/js/features/ticket-rules.js` virou ponte síncrona das 20 regras, lidas de `window.SimpressReact["regras-chamados"]` a cada chamada (o `static/app.js` monta `context.ticketRules` antes de o bundle publicar as ações). `frontend/src/paineis/cockpit-chamados/` passa a importar `regras.ts` direto. Contêineres escondidos em `frontend/partials/cockpit-tool-panels.html` e `frontend/partials/modais.html`. Mudança de momento de execução: os dois `inicializar*` rodam depois de `simpress:react-pronto` (antes, na carga do `app.js`); sem o bundle, não rodam e o console registra `O painel React "importacao-planilhas" não carregou.`. Mesmos endpoints, corpos de `POST`, `preview_token`, `Idempotency-Key`, IDs e textos. Testes: `tests/frontend/test_bf2_importacao_bridge.cjs`, `tests/frontend/test_bf2_regras_bridge.cjs`, `tests/e2e/react-bf2.spec.cjs`.
    - Nível: alto nos três. Se um grupo não couber numa sessão, o que sobrar vai para o Bloco final, registrado no PR.
  - Conferência do piloto: ver "Grupos conferidos" em "Resultado do piloto".
- **Invariantes:** grupo com arquivo que trata `confirmado`, `enviar` ou recusa de envio (G1, G3, G4, G5 e G6 hoje) escreve o teste Playwright do invariante **antes** de trocar o código. O revisor é obrigatório nesses grupos. G7 não roda em paralelo.
- **Testes:** cada grupo cria spec próprio (`tests/e2e/react-<grupo>.spec.cjs`) e baseline próprio, sem editar spec de outro grupo.
- **Riscos aceitos pelo usuário:** custo alto de tokens em pouco tempo e PRs maiores. Conflito entre grupos volta para a sessão do grupo, pelo Auto-fix.

## Dia 4 — revisão geral e correção (pedido do usuário, 15/11/2026)

- **Objetivo:** revisar todas as alterações da migração com `ponytail:ponytail-review` e corrigir tudo que deu erro no processo. O usuário exige a correção: nada fica só anotado.
- **Quando:** sessão nova, depois que o Antigravity mesclar todos os PRs dos Dias 1 a 3. Parte do `main` atualizado, em branch própria.
- **Entrada:**
  - o diff inteiro da migração, do último commit do `main` antes do Bloco 2 até o `main` atual;
  - a seção "Pendências para o Dia 4" de cada PR da migração (`gh pr view <N>`);
  - as execuções de CI que falharam nesses PRs (`gh run list`).
- **Passos:**
  1. Revisão ponytail do diff inteiro, por grupo (Bloco 2, piloto, G1 a G7, Bloco final), porque o diff todo não cabe numa leitura.
  2. Uma lista única: achados "Corrigir antes" e "Deveria corrigir", pendências dos PRs e falhas de CI que voltaram.
  3. Corrigir todos. "Opcional" só se for pequeno; o resto vai para o relatório.
  4. Nova revisão ponytail no diff das correções, até o veredito "pode enviar".
- **Nível:** alto (ver "Nível de cada sessão"). Falha que resistir a 3 ciclos sobe para extra high e ganha mais 3 ciclos. Se ainda falhar, a sessão para e devolve o que tentou e o que falha.
- **Critérios de aceite:** lista única zerada, ou cada item restante com o motivo; `npm run verify` e `npm run test:ui:e2e` verdes; veredito ponytail "pode enviar"; `model-super-power:revisor` no conjunto; invariantes do `AGENTS.md` intactos (Endpoint sem Enter, envio real só com `confirmado: true`, SharePoint, Outlook, UX).
- **Verificar:** as linhas `AC: <critério> — PROVEN BY <evidência>`; app real com dados locais em cada aba.
- **Proibido:** mudar o visual bento aprovado, ligar auto-merge, fazer merge.

## Blocos 4 em diante — um painel por bloco (modo normal)

- Usado só se o modo rápido for abandonado. Mesmo formato do Bloco 3 (baseline, inventário de testes, critérios), um painel por sessão e por PR, na ordem registrada no piloto (depois do bento Bloco 2 mesclado, sem esperar os Blocos 3 e 4 do bento).
- JSDoc em `static/js/features/` acompanha: o módulo de um painel que ainda não migrou ganha JSDoc no bloco anterior ao dele.
- Bloco do Assistente e dos cartões de confirmação: testes Playwright das recusas e dos envios reais primeiro; revisão obrigatória do `model-super-power:revisor`.

### Resultado do BF4 (17/11/2026)

- **Painel:** `ferramentas-cockpit`, em `frontend/src/paineis/ferramentas-cockpit/` (`estado.ts` com `criarFerramentasCockpit(contexto)`, `montar.tsx` e `tipos.ts`). Porta fiel de `static/js/features/cockpit-tool-panels.js` (2426 linhas): mesmos ids, textos, eventos e atalhos. A seção `#cockpit-tool-panels` do partial ganhou o contêiner `<div data-react-painel="ferramentas-cockpit" hidden></div>`; `static/index.html` não mudou, porque inclui o partial.
- **Ponte:** `static/js/features/cockpit-tool-panels.js` ficou só com `context.ponteReactSincrona("ferramentas-cockpit", [...])` para as 11 ações (`abrirPainelCockpit`, `fecharPainelCockpit`, `abrirComparacaoDaSerie`, `abrirChamadosDoEquipamento`, `abrirChamadoDaOs`, `abrirJanelaChamadoOs`, `abrirReferenciaLembrete`, `fecharJanelaChamadoOs`, `destacarLinhaCockpit`, `filterTicketRecords`, `mostrarResultadoNaAbaComparacao`). `FEATURE_ORDER`, a lista do dispatcher e `test_feature_modules` seguem iguais. Ela só sai no Bloco final.
- **Sem o bundle:** `abrirPainelCockpit` abre a casca das 9 ferramentas de `toolInfo` (título, atalho, subtítulo, foco no título, menu Ferramentas fechado, `aria-pressed`/`aria-selected` dos botões, `data-active-tool` e skip-link), a partir de uma cópia mínima de `toolInfo` e `toolKeys` na ponte (sem os loaders do painel; a única chamada para fora é `carregarResumoAtivos` no Resumo, para o cartão de ativos registrar a própria falha no console), e o Voltar devolve o foco a quem abriu. Chamados, Comparação, Histórico de apelidos, Relatório mensal e Planilhas mostram também o texto de erro que já existia, e a Comparação grava `data-estado="erro"` em `#comparacao-planilhas-conteudo` (o cartão do Resumo espera `pronto`, `vazio` ou `erro`). Cobertura, Lembretes, Unidades e Chamados Sebrae não tinham texto de erro próprio: abrem a casca vazia e só registram o erro no console. Ferramenta desconhecida não abre nada. O Escape também fecha a casca (mesma regra de `estado.ts`: sem `defaultPrevented` e sem modal aberto), e o Voltar fecha direto, sem reabrir a ferramenta anterior. `test_bf4_ferramentas_bridge.cjs` confere a cópia contra `estado.ts`.
- **Mudança de comportamento:** o envio automático da anotação de chamado (`PUT` da linha do tempo) usa `apiFetch` em vez de `fetch` direto. Mesmo endpoint, mesmo corpo e sem `keepalive` (como antes). O erro HTTP volta ao autosave no mesmo formato (`ok`, `status`, `json`, então 409 não repete e 5xx repete); a falha de rede passa intacta e agora também dispara o evento `simpress:servidor-offline`. Coberto em `test_bf4_ferramentas_bridge.cjs`.
- **Testes:** os testes que liam ou importavam o módulo antigo (`test_cockpit_tool_panels`, `test_inline_equipment_edit`, `test_cockpit_andamento`, `test_bf2_regras_bridge`) passaram a usar `estado.ts`, sem asserção removida nem afrouxada. Novo: `tests/frontend/test_bf4_ferramentas_bridge.cjs`; o harness ganhou `mountReactPanelsBf4`.
- **Fica para o Dia 4:** `data-panels.js`, `app-shell.js` e as teclas F de `ux-enhancements` continuam legados. Resultado (17/11/2026, react-final-a): `data-panels.js` e `chamados-os-model.js` viraram TypeScript em `frontend/src/paineis/paineis-dados/` (`paineis.ts`, `tabela-os.ts`, `chamados-os.ts`, `utilitarios.ts`); o `montar.tsx` do painel `paineis-dados` instala os ouvintes de documento, e `SimpressDataPanels` e `SimpressChamadosOsModel` deixaram de existir em `window`. `app-shell.js` e as teclas F de `ux-enhancements` seguem legados. Concluído na react-final-3 (ver "Resultado da react-final-3").

## Bloco final — remoção do código antigo

- **Objetivo:** o React assume a página inteira.
- **Arquivos:** `static/js/features/app-shell.js` e `static/js/features/cockpit-tool-panels.js` (migram aqui), `static/app.js`, `static/app-entry.js`, `static/js/` restantes, `frontend/partials/` e a montagem em `assembled_html` (o `index.html` vira casca com o contêiner raiz); `tsconfig.ui.json`; `@source` mortos em `tailwind.input.css`; harness `tests/frontend/support/` e testes que liam o HTML montado; `frontend/AGENTS.md` e docs que citam partials.
- **Critérios de aceite:** nenhum arquivo em `static/js/`; suíte completa verde; CSP e cookie inalterados.
- **Verificar:** `npm run verify`; `npm run test:ui:e2e`; `git grep "app-entry\|partials/"` sem referências vivas; app real com dados locais.

### Resultado da react-final-3 (17/11/2026)

- **Concluído:** `frontend/src/legado/` foi removida e todo o código da interface está em TypeScript e React, em `frontend/src/`. Portes 1:1: `legado/app.js` para `frontend/src/aplicacao/app.ts`; `legado/app-entry.js` para `frontend/src/arranque/entrada.ts` (o `main.tsx` o importa antes dos painéis); `legado/ui/{action-dispatcher,ux-enhancements,ck-cockpit-visual,cromo-marca}.js` para `frontend/src/ui/*.ts`; `legado/features/*` para `frontend/src/aplicacao/*.ts` (fábricas em `registro.ts`, pontes para os painéis em `pontes.ts`).
- **Deixaram de existir em `window`:** `SimpressFeatures`, `SimpressTicketRules`, `SimpressUxEnhancements` e `SimpressFilePicker`.
- **Fora do bundle:** só `static/js/shared/theme-preference.js` (aplica o tema no `<head>`, antes do bundle) e os ícones em `static/vendor/` (`lucide-*-subset.js`). Não há outro arquivo em `static/js/`.
- **Do desenho original do Bloco final não foi feito:** `static/index.html` continua montado a partir de `frontend/partials/`; não virou casca com um contêiner raiz.

## Execução

- Cada bloco roda numa sessão nova, com este plano como brief, e termina em PR próprio (push da branch da sessão; o merge fica com o Antigravity, ver "Modo rápido").
- **Nível de cada sessão (decisão do usuário, 15/11/2026):** quem abre a sessão escolhe o nível pela complexidade e o define na abertura (`effort` no `start_session`; acima do próprio nível, `set_session_effort`). A sessão já nasce no nível certo e não pede troca ao usuário. Para subir no meio do trabalho (falha que resiste a 3 ciclos), a sessão avisa quem a abriu por `SendMessage`, e quem a abriu sobe o nível. Escolha inicial, revista na abertura de cada sessão:
  - Grupo G2 (sem invariante de envio): médio.
  - Bloco 2 (CSP, bundle e `verify`), piloto, grupos com invariante (G1, G3, G4, G5 e G6), Bloco final e Dia 4: alto.
  - G7 (envio real e Assistente): alto; extra high se o piloto achar acoplamento difícil.
- **Sem o usuário acordado (pedido do usuário, 15/11/2026: "não quero parar de jeito nenhum"):** a sessão não usa `AskUserQuestion` nem espera resposta do usuário. Dúvida de design vai para quem a abriu, por `SendMessage`; sem resposta, segue a opção mais conservadora (a que não muda tela, texto nem regra) e registra a escolha no PR. Falha que bate o teto de ciclos vira item de "Pendências para o Dia 4", e a sessão segue com o resto. Termina sempre em PR, mesmo com pendências.
- Dentro da sessão: `model-super-power:batedor` para leitura, `executor` para o código, `revisor` antes do PR.
- **Não erre, mesmo com PR grande (exigência do usuário):** PR grande não desculpa erro. Revise o diff inteiro, arquivo por arquivo, sem amostragem; cada achado com o trecho e o caso que falha. Antes do PR, confira cada arquivo alterado contra o original (mesma regra, mesmo texto aprovado, mesmo invariante). Na dúvida, pare e pergunte.
- Relatório final de cada bloco: uma linha `AC: <critério> — PROVEN BY <evidência>` por critério; sem evidência, não verificado.
- Teto de 3 ciclos de correção sobre a mesma falha; depois, a sessão para e devolve o que tentou.
- Dúvida de design que muda o plano: a sessão pergunta a quem escreveu o plano, sem decidir sozinha.
