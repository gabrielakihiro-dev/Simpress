# 17 — Termos de entrega e devolução (Ferramentas, 09/11/2026)

**Desde 12/11/2026 (Lembretes, Bloco 4):** a ferramenta `Termos` (botão `#btn-termos`, painel `termos`) foi removida. Os dois termos continuam iguais, agora como as sub-abas `Termo Entrega` e `Termo Devolução` do painel `Lembretes` (botão `#btn-lembretes`, `data-cockpit-tool-panel="lembretes"`); a ferramenta e o botão `Criar lembrete` de cada termo estão em `docs/cockpit-prompts/18-lembretes.md`. Onde este texto diz "painel `Termos`" ou cita `#btn-termos`, leia o painel `Lembretes` e `#btn-lembretes`.

Os termos são dois formulários no painel Lembretes do menu Ferramentas do Cockpit, que o operador preenche (nome, modelo, série e Notebook vêm da busca de série da Home; o resto à mão) e salva em PDF para colher assinaturas: `Termo Entrega` e `Termo Devolução`. O termo em si não grava nada no computador, no servidor nem em sistema externo e não envia nada ao servidor (a única gravação é o lembrete que o usuário cria pelo botão `Criar lembrete`, descrito em `18-lembretes.md`). A única requisição de rede do termo é o `GET /api/assinatura-tecnico`, só para ler a imagem da assinatura do técnico no `Gerar PDF` (seção "Assinatura do técnico").

Autorização: pedido do usuário de 09/11/2026 (painel novo, sem atalho de teclado). No mesmo dia o usuário trocou o botão `Imprimir` por `Gerar PDF` (só quer salvar o PDF numa pasta) e definiu o nome sugerido do arquivo. Em 10/11/2026 o usuário aprovou os textos novos `Sim/Não` (cabeçalho das listas de verificação) e `Limpar o termo?` (confirmação do `Limpar`).

## Regras

- Dados pessoais (nome do colaborador, série do equipamento) existem só na memória da página enquanto ela estiver aberta. Não há `localStorage`, `sessionStorage`, IndexedDB, cookie, rota do servidor que receba o termo, log nem arquivo para o termo. Recarregar a página apaga tudo. A única rota usada é o `GET /api/assinatura-tecnico` (sem corpo, sem query), que só lê a assinatura do técnico. Exceção única: o botão `Criar lembrete` (`18-lembretes.md`) grava em `data/state/lembretes.json` só o texto que o usuário revisou e confirmou no diálogo.
- O painel não tem atalho de teclado: o botão `#btn-lembretes` não tem `<kbd>` nem `aria-keyshortcuts`, e `lembretes` fica em `toolInfo` mas não em `toolKeys` (`static/js/features/cockpit-tool-panels.js`); `termos` saiu de `toolInfo` junto com o botão.
- O Assistente (F9) não tem ferramenta para os termos nem para os lembretes da ferramenta Lembretes; a regra 37 do `SYSTEM_PROMPT` só explica onde ficam (Ferramentas > Lembretes) e que tudo acontece na tela.
- Os rótulos abaixo são os textos aprovados e saem exatamente assim na tela e na folha impressa. As listas de itens são separadas por termo, porque diferem (Termo Entrega tem `Headset (modelo 8225 ou 3220)`; Termo Devolução tem `Headset` e `Case headset (modelo 8225)`).

## Tela

Menu Ferramentas, grupo `Painéis`, botão `Lembretes` (sem tecla). O painel `section[data-cockpit-tool-panel="lembretes"]` traz as sub-abas (`.ck-pilulas`, `role="tablist"`, setas, `Home` e `End` trocam de aba): `Termo Entrega`, `Termo Devolução` e `Lembretes` (a lista, em `18-lembretes.md`); o painel abre em `Lembretes`. Cada sub-aba é um formulário (campos com `<label>` associado, `autocomplete="off"`) e uma barra com os botões `Gerar PDF` e `Limpar` (não existe botão `Imprimir`), mais o aviso visível `Na janela que abrir, escolha Salvar como PDF e a pasta.` e uma linha de aviso de erro (`role="status"`) para o bloqueio descrito abaixo.

### Termo Entrega

Título impresso `Termo de Entrega`, cabeçalho `SEBRAE/PR`, marca `Interno` no canto superior direito.

- `Dados do colaborador`: `Nome do colaborador`, `Unidade / Departamento`, `Data da entrega / troca`.
- `Identificação do equipamento`: tabela com colunas `Campo`, `Equipamento anterior`, `Equipamento entregue` e linhas `Modelo do computador` e `Número de série / Service Tag` (quatro campos). Abaixo de 768 px a tabela vira cartões com os mesmos dados.
- `Equipamentos e acessórios entregues`, com a dica `Assinale Sim ou Não para cada item apresentado no ato da entrega.` Itens, cada um com `Sim` / `Não`: 01 Mochila; 02 Notebook; 03 Teclado; 04 Mouse; 05 Hub USB; 06 Suporte notebook; 07 Headset (modelo 8225 ou 3220); 08 Case headset; 09 Mousepad; 10 Monitor (HDMI / DisplayPort / Cabo de força / USB); 11 Cabo de Segurança.
- `Observações`, com a dica `Registre avarias no equipamento anterior ou itens pendentes.`
- `Validação do recebimento`: `Declaro que conferi as informações deste termo e recebi os equipamentos e acessórios assinalados acima.`
- Assinaturas: `Assinatura do colaborador` e `Assinatura do técnico responsável`.
- Sem rodapé (removido a pedido do usuário em 10/11/2026: ficava colado às assinaturas).

### Termo Devolução

Na tela, `Dados do colaborador`: `Nome do colaborador`, `Unidade`, `Data`, `Modelo do computador`, `Número de série`; lista `Equipamento / Acessório` com `Sim` / `Não`: 1 - Mochila; 2 - Notebook; 3 - Teclado; 4 - Mouse; 5 - Hub USB; 6 - Suporte notebook; 7 - Headset; 8 - Case headset (modelo 8225); 9 - Mousepad; 10 - Monitor (HDMI / DisplayPort / Cabo de força / USB); 11 - Cabo de Segurança (abaixo de 768 px a lista vira cartões); `Observações`.

Folha impressa no mesmo padrão do Termo Entrega (pedido do usuário de 10/11/2026), mudando só os textos e o destaque visual:

- Título `Termo de Devolução de Equipamentos`, cabeçalho `SEBRAE/PR`, marca `Interno`.
- `Dados do colaborador`: `Nome do colaborador`, `Unidade`, `Data`, `Modelo do computador`, `Número de série`.
- Sem a tabela `Identificação do equipamento` (só existe na entrega, a pedido do usuário em 10/11/2026).
- `Equipamentos e acessórios devolvidos`, dica `Assinale Sim ou Não para cada item apresentado no ato da devolução.`, tabela `Equipamento / Acessório` / `Sim / Não`.
- `Observações`.
- `Validação da devolução`: `Declaro que conferi as informações deste termo e devolvi os equipamentos e acessórios assinalados acima.`
- Assinaturas: `Assinatura do colaborador` e `Assinatura do Técnico`.
- Destaque em vinho (`#7a1f2b`, classe `tp--devolucao`): faixa à esquerda e fundo claro no cabeçalho, faixa à esquerda nos títulos de seção. A entrega usa o mesmo esquema em azul (`#1f4e8c`), sem as faixas: título, títulos de seção e marca na cor do termo, bordas das tabelas na cor e cabeçalho das tabelas com fundo claro.

Sim e Não são um par de botões de rádio por item (só um pode ficar marcado; item não respondido sai com as duas caixas vazias na folha).

### Preenchimento pela Home (pedido do usuário de 10/11/2026)

Cada equipamento exibido na Home (busca por `#input-serial` ou clique na lista) chama `app.termosPreencherDoEquipamento(eq)` dentro de `exibirEquipamento` (`static/js/features/equipment-search.js`). A função preenche os dois termos com os dados já carregados na página, sem rota nova nem gravação:

- Termo Entrega: `Nome do colaborador` (`eq.nome_pessoa`), `Modelo do computador` e `Número de série / Service Tag` da coluna `Equipamento entregue` (`eq.modelo`, `eq.serial`) e `02 Notebook` = `Sim`.
- Termo Devolução: `Nome do colaborador` (`eq.nome_pessoa`), `Modelo do computador` (`eq.modelo`), `Número de série` (`eq.serial`) e `2 - Notebook` = `Sim`.
- O resto (unidade, data, coluna `Equipamento anterior`, demais itens, observações) continua manual.
- Todos os campos preenchidos continuam editáveis (sem `readonly` nem `disabled`); o Notebook pode ser trocado para Não.
- Campo sem valor no equipamento só é apagado se tinha sido preenchido pela própria Home (`data-preenchido-home`); o que o usuário digitou à mão fica. Equipamento sem série não altera nada.
- Só preenche quando a série muda (`data-serie-home` no formulário): salvar a edição cadastral reexibe a mesma série e não desfaz o que o usuário alterou, inclusive um Notebook = Não. `Limpar` zera essa marca.

## PDF

O formulário da tela nunca é impresso. `Gerar PDF` monta, por `textContent`, a folha `#termos-impressao` (filho direto de `<body>`, vazio e oculto na tela) com o layout do termo:

- datas em `dd/mm/aaaa` (o valor `aaaa-mm-dd` do campo é fatiado, nunca passa por `new Date`, para não deslocar o dia por fuso);
- Sim/Não como caixas de marcação (`[X]` e `[ ]`);
- Observações completas, com quebras de linha preservadas (`white-space: pre-wrap`, sem altura fixa nem corte);
- linhas de assinatura (a do técnico leva a imagem da assinatura; ver "Assinatura do técnico" abaixo).

Em seguida a página recebe a classe `termos-imprimindo` no `<html>`, o título da página (`document.title`) muda para o nome do arquivo e o programa chama `window.print()`. O usuário escolhe `Salvar como PDF` e a pasta na janela do navegador. No `afterprint` a classe sai, a folha é esvaziada e o título original volta. O CSS de impressão (`@media print`, em `static/styles/ck-termos.css`) esconde tudo o que não for `#termos-impressao`, força fundo branco e texto preto mesmo no tema escuro (exceto a cor de destaque de cada termo) e usa `@page { margin: 0 }` com o respiro no `padding` da folha: assim o Chrome não imprime data/hora, título (nome do arquivo) nem endereço no topo e no pé da página. Não há dependência nova nem gravação: o PDF é gerado pelo próprio navegador. `Gerar PDF` é assíncrono: espera a assinatura do técnico (até 3 s) antes de chamar `window.print()`; um segundo clique durante a espera é ignorado e `Limpar` cancela o PDF pendente.

### Assinatura do técnico (12/11/2026)

- Só o lado do técnico muda: no bloco `Assinatura do técnico responsável` (entrega) e `Assinatura do Técnico` (devolução) a folha mostra a imagem da assinatura sobre a linha, acima do rótulo: o corpo das letras apoia na linha e só o G de Gabriel e o traço final de Souza passam dela (CSS desce a imagem 39/122,3 da altura, fração medida no `viewBox` do SVG atual). O bloco do colaborador fica em branco.
- A imagem vem de `GET /api/assinatura-tecnico` (`routers/assinatura_tecnico.py`; contrato na rota 210 de `docs/arquitetura/CONTRATOS_API_BACKEND.md`), que lê `data/state/assinatura_tecnico.svg`. Esse arquivo é do operador, fica fora do Git e nunca é copiado para `static/**`, fixtures ou testes (os testes usam um SVG sintético).
- A requisição não leva nada do termo (sem corpo, sem query) e só ocorre ao clicar em `Gerar PDF`, com os dados já validados.
- Para trocar a assinatura, substitua o arquivo `data/state/assinatura_tecnico.svg`. Sem o arquivo, ou se ele for recusado (acima de 64 KB, sem `<svg`, com script, atributo `on…=`, `javascript:`, `<foreignObject`, `href=` ou `<!ENTITY`), o PDF sai com a linha em branco, como antes; a tela não mostra aviso. SVG exportado de editor que traga `href`/`xlink:href` precisa ser limpo antes. Recorte a `viewBox` rente ao traço (sem margem embaixo) e recalcule a fração 39/122,3 em `static/styles/ck-termos.css` (onde termina o corpo das letras ÷ altura da `viewBox`); sem isso, a assinatura sobe ou desce em relação à linha.
- A `<img>` (classe `tp__assinatura-img`, `alt` vazio, 14 mm de altura) é criada por `createElement` e posicionada sobre a margem, sem empurrar o layout. Se não carregar em até 3 s, o PDF sai sem ela.

### Nome sugerido do arquivo

O navegador usa o título da página como nome do arquivo em `Salvar como PDF`. O formato é `<Número de série> - <Nome completo>`, por exemplo `BRJ54925DN - Janaina do Rocio Santos Rocha`.

- Termo Devolução: campos `Número de série` e `Nome do colaborador`. Termo Entrega: o número de série da coluna `Equipamento entregue` e `Nome do colaborador`.
- Cada valor é limpo: espaços nas pontas cortados, acentos mantidos, só letras Unicode, dígitos, espaços e hífens (qualquer outro caractere sai, regex `/[^\p{L}\p{N} -]/gu`), espaços repetidos viram um, no máximo 100 caracteres por parte. O número de série vai em maiúsculas.
- Série ou nome vazio (inclusive depois da limpeza): `Gerar PDF` não abre a janela de impressão e mostra `Preencha o número de série e o nome do colaborador.`
- O título original da página volta no `afterprint`.

`Limpar` esvazia a sub-aba ativa e a folha, depois de `app.confirmarAcao` (título `Limpar o termo?`, mensagem `Todos os campos do termo serão apagados. Nada foi guardado em outro lugar.`, botões `Limpar` e `Cancelar`). Só segue com o clique em `Limpar`; `Cancelar`, Esc e fechar o diálogo não apagam nada.

## Interface

- Temas claro e escuro, de 320 px a 2560 px sem rolagem horizontal da página.
- Animação de entrada do painel de 200 ms (dentro de 150 a 300 ms), desligada em `prefers-reduced-motion`.
- Reaproveita as classes do kit do Cockpit (`.ck-pilulas`, `.ck-campo`, `.ck-entrada`, `.ck-btn--*`, `.ck-cartao`); `static/styles/ck-termos.css` só traz o layout e a folha impressa.

## Assistente

Regra 37 do `SYSTEM_PROMPT` (`domains/assistant_chat.py`): os termos ficam no menu Ferramentas, no botão `Lembretes` (sub-abas `Termo Entrega`, `Termo Devolução` e `Lembretes`); a busca de série na Home já preenche nome, modelo, série e Notebook = Sim; o resto do preenchimento e o `Gerar PDF` (nome sugerido `<série> - <nome>`) acontecem só na tela; o botão `Criar lembrete` de cada termo só cria o lembrete depois da confirmação do usuário na tela; não há ferramenta para os termos nem para os lembretes dessa ferramenta (o Assistente não lê nem cria os lembretes dela e não acessa `data/state/lembretes.json`; as notas `criar_lembrete` e `listar_lembretes` da regra 23 são outro armazenamento, `assistente_notas.json`) e nada do termo é guardado. `tests/test_assistant_termos.py` confere o texto da regra e que nenhum `domains/assistant*.py` nem `routers/assistant*.py` cita `lembretes.json`.

## Testes

- `tests/frontend/test_termos.cjs`: formato de data, nome do arquivo (`<série> - <nome>`, limpeza, maiúsculas, limite de 100, partes vazias), montagem da folha, preenchimento pela Home (`termosPreencherDoEquipamento`, sem apagar o que foi digitado nem desfazer alterações quando a mesma série é reexibida) e presença dos rótulos aprovados em `static/index.html`.
- `tests/e2e/termos.spec.cjs`: abre pelo menu (`#btn-lembretes` e a pílula `Termo Entrega`), troca de sub-aba, preenche, marca itens, simula `window.print`, confere em mídia `print` que só a folha aparece com a Observação longa completa, que não há `<kbd>` nem botão `Imprimir`, que `Gerar PDF` existe, que `document.title` vale `BRJ54925DN - Janaina do Rocio Santos Rocha` durante a impressão (Devolução) e volta no `afterprint`, que sem série ou sem nome o PDF é bloqueado com o aviso, e que buscar uma série na Home (API simulada) preenche nome, modelo, série e Notebook = Sim nos dois termos, e que esses campos continuam editáveis. Assinatura do técnico (a fixture da porta 8765 responde `/api/assinatura-tecnico` com um SVG sintético): a folha tem a `<img>` carregada só no bloco do técnico, em entrega e devolução, e a única requisição é um `GET` sem corpo; com 404, 422 ou demora acima de 3 s o PDF sai sem imagem; o segundo clique durante a espera não imprime duas vezes. `tests/test_assinatura_tecnico.py`: 404, 200 com os três cabeçalhos, 422 (script, `on…=`, `javascript:`, `<foreignObject`, `href`, `<!ENTITY`, acima de 64 KB, não UTF-8) e 401 sem cookie.
- `tests/e2e/cockpit-layout.spec.cjs`: `#btn-lembretes` na lista de botões de ferramenta (sem atalho); `#btn-termos` saiu da lista.
- `tests/e2e/lembretes.spec.cjs`: o menu Ferramentas não tem mais o botão `Termos`; os termos abrem pela pílula de `Lembretes`.

## Regras movidas do AGENTS.md (10/11/2026)

Texto integral das seções que ficavam no `AGENTS.md` da raiz até 10/11/2026. O resumo e o índice continuam no `AGENTS.md`.

### Termos de entrega e devolução (Ferramentas, 09/11/2026)

Painel `Termos` (`data-cockpit-tool-panel="termos"`, botão `#btn-termos`; removido em 12/11/2026 e substituído pelas sub-abas do painel `Lembretes`, botão `#btn-lembretes`) criado a pedido do usuário em 09/11/2026: preenche e salva em PDF os termos de entrega e de devolução de equipamentos.

- Fica no menu Ferramentas, sem atalho de teclado (não ocupa F-tecla; `#btn-lembretes` não tem `aria-keyshortcuts` nem `<kbd>`).
- Sub-abas com os rótulos exatos `Termo Entrega` e `Termo Devolução` (`role="tablist"`; clique e setas trocam de aba).
- Preenchimento manual, com os campos e as listas de verificação dos PDFs originais. Nada é preenchido a partir de planilhas, do cadastro, do Endpoint ou de outro sistema.
- `Gerar PDF` usa o `Salvar como PDF` do navegador (`window.print()`). O nome sugerido do arquivo é `<SÉRIE> - <Nome completo>`, por exemplo `BRJ54925DN - Janaina do Rocio Santos Rocha`: série em maiúsculas, caracteres proibidos em nome de arquivo removidos e no máximo 100 caracteres por parte. Sem série ou sem nome, o botão é bloqueado e a tela mostra `Preencha o número de série e o nome do colaborador.`. O título da página volta ao normal e a folha de impressão (`#termos-impressao`) é esvaziada no `afterprint`. Não existe botão `Imprimir`.
- `Limpar` pede confirmação (`Limpar o termo?`) e só então apaga os campos da aba.
- Textos aprovados pelo usuário em 10/11/2026: `Sim/Não` (cabeçalho das listas de verificação) e `Limpar o termo?`.
- LGPD: nada é guardado. Os dados do colaborador ficam só na memória da página (sem `localStorage`, `sessionStorage`, IndexedDB, cookie, log nem arquivo no servidor, e sem rota de API que receba o termo) e somem ao recarregar. Única requisição: `GET /api/assinatura-tecnico`, que só lê a assinatura do técnico e não envia nada do termo (12/11/2026). A folha é montada por `textContent`.
- Nada é lido nem escrito em SoftExpert, SharePoint, UX, Endpoint, Excel ou outro sistema externo, e nenhum dado local em `data/` é criado ou alterado.
- Assistente: não há ferramenta para os Termos nem para os lembretes; ele só explica onde ficam (Ferramentas > Lembretes) e como gerar o PDF na tela (regra 37 do `SYSTEM_PROMPT`).

Detalhes (campos, listas, impressão e testes): `docs/cockpit-prompts/17-termos.md`.
