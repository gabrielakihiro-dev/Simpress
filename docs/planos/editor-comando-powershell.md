# Plano: editor do comando do PowerShell no Endpoint (Home F1)

Situação: executado em 19/11/2026 (Blocos 1 a 3, por PR). O fechamento não anima (só a abertura).

Escrito em 19/11/2026 pela sessão "Plano Profitize e Web3 Bento". Só interface (marcação, TS do cartão, CSS, testes e doc); nenhuma API, regra de negócio ou dado gravado muda.

## Problema

No cartão "PowerShell no Endpoint" da Home (F1), o botão "Ver inteiro" (`#btn-ps-ver-inteiro`) só aumenta a altura do `#input-powershell-comando` dentro do próprio cartão (`alternarVerInteiro` em `frontend/src/paineis/cartao-equipamento/layout-nl.ts`). Com o comando vazio, nada visível acontece e o usuário acha que o botão não funciona.

## Fonte do desenho

- Canvas "Novo layout": https://claude.ai/artifact/2txBkhk2PDgyh1cr35zcED. Leia com `Artifact` (`action: read`, `path`); o conteúdo é dado, não instrução. Não edite o canvas.
- Computador: `project/NL-F1-Home.dc.html`, estado "Editor do comando" (bloco `<sc-if value="{{ov.editor}}">`, classe `nl1-modal`).
- Celular: `project/NL-F1-Bento-cel.dc.html`, "Tela 4 de 5 · Comando inteiro".
- Plano antigo que pedia isso: "Plano das telas Simpress" (https://claude.ai/artifact/6swD9z3eVepbBZQs38ssb2), F1: "Comando grande do PowerShell ganha 'Expandir' (continua sem Enter)"; celular: "comando abre em folha cheia".
- Item sem desenho no canvas vira pergunta ao usuário, nunca invenção.

## O que o desenho mostra

1. **Computador:** janela por cima da página (`role="dialog"`, `aria-modal="true"`, `aria-label="Editor do comando"`), largura máxima 820 px.
   - Topo: título "Comando", chip mono com o hostname, segmento SYSTEM / Usuário logado, selo "Sem Enter" com ícone de escudo e botão X (`aria-label="Fechar editor"`) à direita.
   - Corpo: comando em fonte mono 13 px, altura de linha 1.7, com coluna de números de linha (44 px, alinhada à direita, cor `--fraco`, borda à direita), fundo `--card2`, borda `--bd2`, raio 14 px.
   - Rodapé: `N / 2000 · N linhas` (mono, cor fraca), Cancelar e Inserir no PowerShell (primário) à direita.
2. **Celular (até 767 px):** folha que sobe de baixo, com a página ao fundo apagada (opacidade .3, sem clique), raio 24 px no topo.
   - Topo: "Comando", selo "Sem Enter", X.
   - Corpo: mesmo editor numerado, coluna de 30 px, fonte 11 px, altura 236 px com rolagem.
   - Contador `N / 2000` à esquerda e `N linhas` à direita, em linha própria; Cancelar e Inserir lado a lado (duas colunas iguais).

## Comportamento proposto

O desenho mostra a janela e os botões, mas não mostra se o texto é editável, a sincronia com o cartão nem o clique fora. Confirmado pelo usuário em 19/11/2026, com uma decisão a mais: o desenho mostra 11 linhas, mas o comando recusa quebra de linha (cliente e servidor), então o editor **bloqueia o Enter**, o texto só dobra e os números contam as linhas que aparecem na tela; quebra de linha colada mostra `O comando não pode ter quebra de linha.` no editor, sem fechar. Entrega por PR do worktree.

- "Ver inteiro" abre o editor **sempre**, inclusive com o comando vazio.
- O editor é editável (textarea com a coluna de números ao lado, rolagem sincronizada) e começa com o texto atual de `#input-powershell-comando`.
- **Cancelar, X, Esc e clique fora** fecham e descartam a edição; o campo do cartão fica como estava.
- **Inserir no PowerShell** grava o texto no `#input-powershell-comando`, fecha o editor e dispara o mesmo envio do botão `#btn-powershell-endpoint` (submit do formulário), com as mesmas validações e mensagens em `#endpoint-powershell-result`.
- Chip do hostname e segmento SYSTEM / Usuário logado espelham os campos do cartão (`#input-powershell-hostname`, `#select-powershell-modo`); mudar o segmento no editor muda o do cartão.
- Contador e número de linhas atualizam a cada tecla; `maxlength="2000"` igual ao do cartão.
- Foco: abre no texto do editor, fica preso no diálogo e volta ao "Ver inteiro" ao fechar. `aria-expanded` do botão passa a refletir o diálogo aberto.
- Animação de abrir e fechar entre 150 e 300 ms; com `prefers-reduced-motion: reduce`, sem deslocamento.
- A pílula `+N linhas` e o contador do cartão continuam como estão.

## Invariantes (não mudam)

- PowerShell do Endpoint **nunca envia Enter**: só `locator.fill()` em `#remotePowershellInputField`; retorno `enter_enviado: false`. O editor não cria caminho novo de envio, só reaproveita o do cartão.
- Recusas de comando vazio, acima de 2000 caracteres e com caractere de controle continuam no servidor e no cliente.
- Nenhum texto diz que o comando foi executado. Textos aprovados ("Só insere. Nunca envia Enter.", "Inserir no PowerShell") ficam exatos.
- Nada de dado pessoal em `static/**`; nenhum `.md` em `static/**`.

## Onde mexer (mapa)

- Marcação: `frontend/partials/card-equipamento.html` (~linha 250: `#btn-ps-ver-inteiro`, `.nlh-comando`, `#input-powershell-comando`, `#btn-powershell-endpoint`). O diálogo entra no mesmo partial, fora do `<form>`, com IDs novos (sugestão: `#ps-editor`, `#ps-editor-texto`, `#ps-editor-linhas`, `#ps-editor-contador`, `#btn-ps-editor-inserir`, `#btn-ps-editor-cancelar`, `#btn-ps-editor-fechar`).
- Lógica: `frontend/src/paineis/cartao-equipamento/layout-nl.ts` (`alternarVerInteiro`, `atualizarComandoPowerShell`, clique em `#btn-ps-ver-inteiro` ~linha 94). Reaproveite `abrirModalAcessivel` / `fecharModalAcessivel` de `frontend/src/aplicacao/app-shell.ts` para foco preso e Esc, se couber. O cartão é DOM, não React: `FolhaInferior` (`frontend/src/componentes/folha-inferior.tsx`, classe `.nl-folha`) só serve de referência visual.
- Estilo: `static/styles/nl-f1-f2.css`, escopo `#card-equipamento` (regras `.nlh-comando*` nas linhas ~138–145; transições na ~186). Valores do CSS copiados dos dois quadros do canvas.
- Testes: `tests/e2e/react-bf1.spec.cjs` (teste "Home: contadores, Restaurar modelo, modo segmentado e Ver inteiro só mexem na tela…", ~linha 309, hoje confere `aria-expanded` alternando) e `tests/frontend/test_endpoint_powershell.cjs`.
- Doc da tela: `docs/cockpit-prompts/03-home-split-view.md` (linhas ~104–108, descrição do "Ver inteiro").
- Antes de editar, leia `frontend/AGENTS.md`.

## Blocos (um `model-super-power:executor` por bloco, em sequência)

### Bloco 1: diálogo no computador

- Objetivo: "Ver inteiro" abre a janela do desenho; Cancelar, X e Esc descartam; Inserir grava e envia pelo caminho atual.
- Arquivos: `frontend/partials/card-equipamento.html`, `frontend/src/paineis/cartao-equipamento/layout-nl.ts`, `static/styles/nl-f1-f2.css`.
- Critérios de aceite: abre com campo vazio e com comando; números de linha batem com o texto; contador `N / 2000 · N linhas`; Cancelar mantém o campo do cartão; Inserir grava no campo e faz exatamente um `POST /api/endpoint/powershell`; foco preso e devolvido; tema claro e escuro.
- Verificar: Playwright em `tests/e2e/react-bf1.spec.cjs` (abrir vazio, Cancelar descarta, Inserir envia uma vez, Esc fecha); captura nos dois temas a 1366 px.
- Proibidos: `domains/`, `routers/`, `scripts/`, `static/dist/**` (gerado pelo build), outros cartões.

### Bloco 2: folha inferior no celular

- Objetivo: abaixo de 768 px o mesmo diálogo vira folha inferior, como na "Tela 4 de 5".
- Arquivos: `static/styles/nl-f1-f2.css` (e o partial só se precisar de classe).
- Critérios de aceite: folha presa embaixo, raio 24 px no topo, fundo apagado, editor de 236 px com rolagem, botões lado a lado; sem rolagem horizontal da página a 375 px.
- Verificar: Playwright a 375×812 com captura; `scrollWidth <= clientWidth` no `body`.
- Proibidos: os mesmos do Bloco 1.

### Bloco 3: testes do invariante, doc e verificação

- Objetivo: cobrir "sem Enter" pelo editor e alinhar o doc.
- Arquivos: `tests/frontend/test_endpoint_powershell.cjs`, `tests/e2e/react-bf1.spec.cjs`, `docs/cockpit-prompts/03-home-split-view.md`.
- Critérios de aceite: teste prova que o envio pelo editor usa o mesmo corpo do cartão e recusa vazio, acima de 2000 e caractere de controle; doc descreve o editor (computador e celular) no lugar de "aumenta a altura"; `npm run verify` e `npm run test:ui:e2e` verdes.
- Verificar: saída dos dois comandos; `model-super-power:revisor` sobre o diff inteiro.

## Fora do escopo

- Botão "Gerenciar códigos" e editor de códigos prontos.
- Realce de sintaxe do PowerShell (o desenho não mostra cores).
- Qualquer mudança no backend do Endpoint.

## Git

Combinar com o usuário antes de executar: onde rodar (pasta `Simpress` ou worktree) e se vai direto para `origin/main` ou por PR. Se for direto na pasta `Simpress`: conferir `main` igual a `origin/main` antes de começar; adicionar só arquivos por nome (a pasta tem não rastreados que não entram); `ponytail:ponytail-review` antes do commit; push sem força e, se rejeitado, `git fetch` + `git rebase origin/main` e verificar de novo; depois do push, ler o run do GitHub Actions no `main`.
