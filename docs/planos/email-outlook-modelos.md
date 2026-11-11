# Plano: e-mails por modelo na Home (F1) via Outlook (classic), começando pelo "Modelo 1 - Cabo"

## Context

Hoje o pedido de instalação do cabo de segurança é escrito à mão no Outlook. O plano do Antigravity propôs um botão na Home que monta esse e-mail. Este plano refaz o desenho no padrão do Simpress e o amplia com o que o usuário pediu em 09/11/2026:

- **Modelos de e-mail:** um select `Modelo` carrega um modelo inteiro (conta, Para, Cc, Assunto, Mensagem). "Modelo 1 - Cabo" traz o texto do cabo; "Modelo 2 - Gestor" (criado depois pelo usuário) traz o texto que ele editar; e assim por diante. Toda edição no modal é salva automaticamente no modelo selecionado, inclusive os padrões (Para/Cc/conta podem ser trocados no futuro).
- **Autocompletar no Para e no Cc:** sugere pessoas da base do Microsoft Entra já importada (`@pr.sebrae.com.br`) por nome ou login, e transforma um nome digitado no e-mail real quando há só uma pessoa possível.
- **Dois modos:** `Abrir no Outlook` (`Display`, o usuário revisa e envia) e `Enviar pelo Outlook` (`Send`, com confirmação).
- **Duas contas remetentes:** `gakihiro@pr.sebrae.com.br` (padrão, a mais usada) e `gansouza@simpress.com.br`, escolhidas via `SendUsingAccount`. Conta ausente no Outlook dá erro claro; nunca cai em outra conta em silêncio.
- **Só Outlook (classic)** via COM. O Outlook novo (`olk.exe`) não tem COM: erro claro.
- **"Faça vários testes reais"**: matriz de testes reais no passo 5.

Escritas novas (autorizadas pelo usuário em 09/11/2026):
- Externa: criar ou enviar um e-mail no Outlook do usuário, só por clique explícito.
- Local: `data/state/outlook_email_modelos.json` (modelos de e-mail; fora do Git; gravação atômica sob trava). Nenhum histórico de envio e nenhum log com conteúdo.

## Desenho

### Backend

`domains/outlook_mail.py` (novo) e `routers/outlook_mail.py` (novo, factory `create_outlook_mail_router()` registrada em `main.py`). Erros JSON `{detail, codigo}` como em `routers/ux_chamados.py:76-89`; `confirmado: StrictBool` como em `routers/ux_ticket.py:47-53`.

**Contas** (`CONTAS_REMETENTE`, constante do backend): `sebrae` = `gakihiro@pr.sebrae.com.br` (padrão), `simpress` = `gansouza@simpress.com.br`. O front recebe as contas só pela API (o teste de privacidade `tests/test_maintenance_contracts.py:333-347` proíbe esses domínios no HTML/JS).

**Modelos** (`data/state/outlook_email_modelos.json`):
- Formato `{version: 1, modelos: [{id, nome, conta, para, cc, assunto, corpo, atualizado_em}]}`.
- Arquivo ausente: semente "Modelo 1 - Cabo" (id `cabo`, conta `sebrae`) gerada das constantes do backend; só é gravado na primeira edição.
- Semente do Cabo: Para `Allex Fernando Deretti;`, Cc `Fabio Neves; Robinson Luiz de Souza Kriki Silvestre;`, Assunto `Instalação do Cabo de Segurança`, corpo literal (espaços finais preservados como na fonte):
  ```
  Allex, 
  Solicito a instalação de um cabo de segurança para o(a) {nome} - {setor}
  O cabo já está com o(a) colaborador(a).
  Qualquer dúvida estarei à disposição. 
  Att. Gabriel Akihiro
  ```
- Limites: nome ≤ 80 (único, sem distinguir maiúsculas), até 50 modelos, Para/Cc ≤ 1000, Assunto ≤ 200, Corpo ≤ 4000; caracteres de controle recusados (exceto `\n` e `\t` no corpo). Conta tem de ser um id de `CONTAS_REMETENTE`.
- Gravação atômica (arquivo temporário + replace) sob trava de arquivo, reaproveitando o padrão já usado para estado local (ex.: `domains/os_observacoes.py`). Arquivo ilegível: 503, sem sobrescrever.

**Diretório para autocompletar** (só leitura de `domains/entra_users.py`): `read_directory()` dá `users[login_key(upn)] = displayName`; e-mail = `<chave>@pr.sebrae.com.br`; chaves terminadas em `$` (contas de máquina) e contas convidadas (`#EXT#` no UPN ou na chave) ficam fora do autocompletar e do resolver. Busca por `normalize_search_term` (sem acento nem maiúscula) no nome e no login; prefixo de palavra vem antes de "contém".
- **Nome exato no resolver (aprovado pelo usuário em 10/11/2026, após o Passo 0):** se o termo, depois de `normalize_search_term`, for idêntico ao `displayName` de uma única pessoa, o resultado é `unico`, mesmo que outras pessoas combinem por prefixo ou por "contém". Mais de um nome idêntico continua `ambiguo`. Motivo: na base real, "Fabio Neves" combina com 3 pessoas por palavras e "Robinson Luiz de Souza Kriki Silvestre" com 2, mas cada um tem só um nome idêntico. Sem a regra, o Cc da semente bloquearia o `enviar`.

**Rotas:**
| Rota | Função |
|---|---|
| `GET /api/outlook/email/configuracao` | `{contas:[{id,email,rotulo,padrao}], modelos:[…], diretorio:{disponivel,total}}` |
| `POST /api/outlook/email/modelos` | `{nome?, copiar_de?}` cria modelo novo (vazio, conta `sebrae`) ou duplicado; devolve o modelo |
| `PUT /api/outlook/email/modelos/{id}` | atualização parcial (nome, conta, para, cc, assunto, corpo) — usada pelo autosave |
| `DELETE /api/outlook/email/modelos/{id}` | exclui; último modelo → 422 `ultimo_modelo` |
| `POST /api/outlook/email/modelos/{id}/restaurar` | só o `cabo`: volta conta, Para, Cc, Assunto e corpo à semente (nome fica) |
| `GET /api/outlook/contatos?q=` | `q` ≥ 2 caracteres; até 8 `{nome, email}` |
| `POST /api/outlook/contatos/resolver` | `{tokens:[…]}` → por token `{status: unico\|ambiguo\|nenhum, email?, nome?, opcoes?}`; token que já é e-mail volta como está |
| `POST /api/outlook/email` | `{conta, para, cc, assunto, corpo, nome?, setor?, modo:"abrir"\|"enviar", confirmado}` → 200 `{status:"aberto"\|"enviado"\|"incerto", conta, aviso?}` |

**Substituição de `{nome}` e `{setor}`** (no servidor, em `POST /api/outlook/email`): vale no Assunto e no corpo; valor vazio vira o marcador `[Nome da pessoa]` / `[Setor]`. No `abrir` o marcador é aceito (o usuário edita no Outlook); no `enviar`, marcador restante no Assunto ou no corpo bloqueia (422).

**Proteções:** trava em processo (ocupado → 409); `enviar` sem `confirmado: true` → 422; `SIMPRESS_OUTLOOK_SEM_ENVIO=1` recusa o envio real (o `abrir` continua). Log só com modo, id da conta e classe do erro ou código — nunca corpo, destinatários, nomes, nome do modelo ou termo buscado no autocompletar.

**PowerShell 5.1 em subprocesso** (runner injetável, padrão de `domains/chrome_automation.py:231-261`, com a mesma guarda de `CREATE_NO_WINDOW`; nada específico de Windows no import; sem pywin32/comtypes):
- Script fixo e versionado `domains/outlook_mail.ps1`, executado com `powershell.exe -NoProfile -NonInteractive -File`, sem interpolação de dados no texto do script nem nos argumentos.
- Dados só por stdin em JSON UTF-8; script começa com `[Console]::InputEncoding/OutputEncoding = UTF8`; timeout ~60 s.
- `enviar`: antes de tudo confere `Get-Process OUTLOOK`; Outlook fechado → `outlook_fechado`, sem criar item. O `abrir` pode iniciar o Outlook.
- `New-Object -ComObject Outlook.Application` → conta em `Session.Accounts` por `SmtpAddress` (ausente → `conta_ausente`) → `CreateItem(0)` → `SendUsingAccount` (fallback `InvokeMember` `SetProperty`) → To, CC, Subject, Body → `Recipients.ResolveAll()`.
- `abrir`: `Display($false)`. `enviar`: imprime `PASSO:antes_send`, depois `Send()` sem `try/catch` próprio; exceção no `Send()` → `incerto` (decisão do usuário, 10/11/2026).

**Mapeamento de resultado:**
- `conta_ausente` → 422.
- `destinatario_nao_resolvido` → 422 só no `enviar`; no `abrir` abre assim mesmo e devolve `aviso`.
- COM indisponível, Outlook novo ou sistema não Windows → 503 `outlook_indisponivel`.
- Outlook fechado no `enviar` → 503 `outlook_fechado`, nada criado.
- Exceção no `Send()` → 200 `incerto` (conferir Itens Enviados antes de repetir), como qualquer resultado depois de `PASSO:antes_send` que não seja `OK:enviado` (decisão do usuário, 10/11/2026; antes era 502 `envio_recusado`, nada enviado).
- Timeout sem `PASSO:antes_send` → erro simples, nada enviado. Só timeout depois do marcador → `incerto` (conferir Itens Enviados antes de repetir). Timeout no `abrir` → aviso de que a janela pode aparecer em instantes.

### Front

- Botão `Enviar e-mail` em `.ck-eq-cab__acoes` (`static/index.html:291-311`), ao lado de Consultar no Endpoint, Controle remoto, Transporte e Editar; habilitado só com equipamento selecionado (`appState.currentEquipamento`); sem atalho de teclado.
- `static/js/features/outlook-email.js` (novo), registrado em `FEATURE_ORDER` (`static/app-entry.js`/`static/app.js`) e no `SimpressActionDispatcher.allow` (`static/js/ui/action-dispatcher.js`).
- Modal `[data-accessible-modal]` com `abrirModalAcessivel`/`fecharModalAcessivel` (Esc fecha, foco no primeiro campo):
  - Linha de modelo: select `Modelo` + `Nome do modelo` + ações `Novo modelo`, `Duplicar modelo`, `Excluir modelo`, `Restaurar padrão` (este só aparece no `cabo`).
  - Campos do modelo (autosave): `Enviar de` (select das contas), `Para`, `Cc`, `Assunto`, `Mensagem`.
  - Campos do envio (não salvos): `Nome da pessoa` (pré-preenchido com `nome_pessoa` do equipamento) e `Setor`.
  - Ajudas: `Use {nome} e {setor} no assunto ou na mensagem para preencher com os campos Nome da pessoa e Setor.` e `As alterações no modelo são salvas automaticamente.`
  - Ações: `Abrir no Outlook`, `Enviar pelo Outlook` (com `app.confirmarAcao`), `Copiar Texto` (`app.copiarTextoParaAreaTransferencia`, Assunto e Mensagem já com `{nome}`/`{setor}` substituídos no front só para a cópia), `Cancelar`.
- **Autosave:** 800 ms após a última tecla e na hora no `change`/`blur`, com `Alteração ainda não salva…`, `Salvando…`, `Salva.`, `Não foi possível salvar: …` (mesmo padrão das observações F5/F6). Trocar de modelo grava o pendente antes de carregar o outro. Último modelo escolhido fica no `localStorage` (try/catch), só conveniência.
- **Autocompletar (Para e Cc):** combobox ARIA (`role="combobox"`, `aria-expanded`, `aria-activedescendant`, lista `role="listbox"`) sobre o token após o último `;`; debounce 200 ms; setas, Enter e Esc; escolher insere `Nome <email>; `. Sem resultado: `Nenhum contato encontrado no Entra.`
- **Resolução inteligente:** no `blur` de Para/Cc e antes de cada ação, tokens sem `@` vão a `/contatos/resolver`: `unico` vira `Nome <email>` no campo (e o autosave grava); `ambiguo` mostra `Escolha o destinatário certo para "<texto>":` com as opções e bloqueia o `enviar` (`Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.`); `nenhum` fica como está para o `ResolveAll` do Outlook (pega contatos fora do Entra, como Simpress).
- Base do Entra não importada: aviso `A base do Microsoft Entra não foi importada; digite o e-mail completo.` e texto livre.
- Mensagens por `textContent`. CSS em `static/styles/ck-cockpit.css`, temas claro e escuro, campos em coluna abaixo de 768 px, sem rolagem horizontal em 320 px, animações 150–300 ms com movimento reduzido.

### Assistente
- Sem ferramenta nova (nada de envio de e-mail pelo Assistente, como já diz o AGENTS.md).
- Próxima regra livre do `SYSTEM_PROMPT` (hoje 37), em `domains/assistant_chat.py`: os e-mails por modelo (ex.: cabo de segurança) ficam na Home (F1), botão `Enviar e-mail`; o Assistente nunca diz que enviou nem cria modelos.
- Conferir o roteamento do `Abrir chamado no UX` (~linhas 230-236): se "e-mail do cabo" puder cair lá, excluir `cabo`/`e-mail` como já se faz com `ticket|cadastral`.

## Textos para aprovação (exatos; aprovar o plano aprova estes textos)

- **Botão na Home:** `Enviar e-mail`. **Título do modal:** `E-mail pelo Outlook`.
- **Campos:** `Modelo`, `Nome do modelo`, `Enviar de`, `Para`, `Cc`, `Assunto`, `Nome da pessoa`, `Setor`, `Mensagem`.
- **Ações de modelo:** `Novo modelo`, `Duplicar modelo`, `Excluir modelo`, `Restaurar padrão`. **Nome do modelo da semente:** `Modelo 1 - Cabo`.
- **Ações do e-mail:** `Abrir no Outlook`, `Enviar pelo Outlook`, `Copiar Texto`, `Cancelar`.
- **Ajudas:** as duas frases acima.
- **Confirmação do envio:** título `Enviar o e-mail pelo Outlook?`; texto `O e-mail será enviado de <conta> para <Para>, com cópia para <Cc>. Depois de enviado, não há como desfazer.`; botões `Enviar` / `Cancelar`. O trecho `, com cópia para <Cc>` só aparece se o Cc tiver conteúdo (só `;` e espaços não contam); sem Cc, vale o texto sem esse trecho (`O e-mail será enviado de <conta> para <Para>. Depois de enviado, não há como desfazer.`). Decisão do usuário, 10/11/2026.
- **Excluir modelo:** título `Excluir o modelo?`; texto `O modelo <nome> será excluído deste site. Não há como desfazer.`; botões `Excluir` / `Cancelar`.
- **Restaurar padrão:** título `Restaurar o padrão?`; texto `Para, Cc, Assunto, Mensagem e conta do Modelo 1 - Cabo voltam ao texto original.`; botões `Restaurar` / `Cancelar`.
- **Sucesso:** `E-mail aberto no Outlook. Revise e envie por lá.`, `E-mail enviado pelo Outlook.`, `Texto copiado.`
- **Autosave:** `Alteração ainda não salva…`, `Salvando…`, `Salva.`, `Não foi possível salvar: …`
- **Avisos e erros:**
  - `Mantenha ao menos um modelo.`
  - `Já existe um modelo com esse nome.`
  - `Nenhum contato encontrado no Entra.`
  - `Escolha o destinatário certo para "<texto>":`
  - `Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.`
  - `A base do Microsoft Entra não foi importada; digite o e-mail completo.`
  - `A conta <conta> não está configurada no Outlook. Escolha outra conta ou adicione-a no Outlook.`
  - `Alguns destinatários não foram reconhecidos no Outlook. Confira os nomes antes de enviar.`
  - `Outlook (classic) indisponível. Abra o Outlook clássico e tente de novo.`
  - `O Outlook (classic) não está aberto. Abra o Outlook e tente enviar de novo.`
  - `O Outlook não respondeu e nada foi enviado. Tente de novo.`
  - `Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.`
  - `O Outlook demorou a responder. A janela do e-mail pode aparecer em instantes; confira antes de tentar de novo.`
  - `Preencha o nome da pessoa e o setor antes de enviar.`
  - `Já há um e-mail sendo preparado. Aguarde.`
  - `O envio real está desativado neste computador.`

## Execução

Por regra do usuário, a execução roda numa sessão nova (`start_session`) com brief completo, usando `model-super-power:executor` em blocos sequenciais; cada bloco é conferido (arquivos, diff, testes) antes do próximo.

**Dependência:** outra sessão está enxugando `CLAUDE.md`/`AGENTS.md` (raiz ≤ 100 linhas, regras por subpasta). A execução começa depois do merge dessa branch, ou ao menos o Passo 3 espera por ele, para não gerar conflito no `AGENTS.md`.

### Passo 0: sondagem real (só leitura; para se falhar)
- **Objetivo:** provar as premissas antes de codar. Script PowerShell avulso no scratchpad, sem criar nem enviar e-mail.
- **Verificar:**
  1. `Outlook.Application` sobe e é o classic (não `olk.exe`).
  2. As duas contas aparecem em `Session.Accounts` com `SmtpAddress`. Se a Sebrae for só caixa delegada, o desenho muda para `SentOnBehalfOfName` (perguntar ao usuário).
  3. `ResolveAll()` num item não salvo: os 3 nomes da semente resolvem sem ambiguidade, e o formato `Nome <email>` também resolve (senão o autocompletar insere só o e-mail).
  4. Ler `SmtpAddress` não dispara o aviso "um programa está tentando…".
  5. A base do Entra importada reconstrói e-mails reais: `login_key` + `@pr.sebrae.com.br` bate com o UPN de 3 pessoas conhecidas (só leitura do arquivo local).
  6. Object Model Guard (só leitura, Trust Center → Programmatic Access): se estiver em "warn" (aviso a cada acesso), parar e perguntar ao usuário, porque o aviso do `Send()` pode virar `incerto` e um "Permitir" tardio ainda envia.
- **Critério:** item falho → parar e perguntar ao usuário; o plano não muda sozinho.

### Passo 1: backend e testes
- **Objetivo:** modelos, contatos e envio pelo Outlook funcionando no servidor, testados com runner falso.
- **Arquivos:** `domains/outlook_mail.py`, `domains/outlook_mail.ps1`, `routers/outlook_mail.py`, `main.py`, `tests/test_outlook_mail.py`, `scripts/verify.cjs` (mypy/compileall, se a lista precisar), `.gitignore` (confirmar que `data/state/` já cobre o arquivo).
- **Critérios de aceite** (runner falso, diretório temporário):
  - semente do Cabo com corpo literal e espaços finais; arquivo só criado na primeira edição;
  - CRUD de modelos: criar, duplicar, PUT parcial, nome duplicado 422, excluir o último 422, restaurar só o `cabo`, limite de 50;
  - gravação atômica; arquivo corrompido → 503 sem sobrescrever;
  - contatos: ≥ 2 caracteres, sem acento/maiúscula, chaves `$` fora, até 8; resolver `unico`/`ambiguo`/`nenhum`/e-mail;
  - envio: validação e limites, `confirmado`, substituição de `{nome}`/`{setor}`, marcador bloqueia só o `enviar`, cada código de erro, timeout com e sem marcador, `SIMPRESS_OUTLOOK_SEM_ENVIO`, 409 na trava;
  - stdin UTF-8 com `Instalação`/`Segurança` intactos; `.ps1` fixo com `-File -NoProfile` e dados fora dos argumentos;
  - Outlook fechado no `enviar` → 503 `outlook_fechado` sem criar item; exceção no `Send()` → `incerto` (nunca "nada enviado");
  - contas `#EXT#` fora do autocompletar e do resolver;
  - marcador restante no Assunto bloqueia o `enviar`;
  - log sem corpo, destinatários, nomes ou termo buscado (captura de log no teste).
- **Verificar:** teste focado + `npm run verify`.
- **Proibidos:** `requirements.txt`, `domains/entra_users.py` (só leitura), outros routers.

### Passo 2: front e testes
- **Objetivo:** botão `Enviar e-mail` e modal na Home usando só as rotas do Passo 1.
- **Arquivos:** `static/index.html`, `static/js/features/outlook-email.js`, `static/app-entry.js`, `static/app.js`, `static/js/ui/action-dispatcher.js`, `static/styles/ck-cockpit.css`, `tests/frontend/test_outlook_email_ui.cjs`, `tests/e2e/outlook-email.spec.cjs`, `tests/test_maintenance_contracts.py` (estender a checagem de privacidade ao JS novo).
- **Critérios:** botão desabilitado sem equipamento; trocar `Modelo` carrega o modelo inteiro; autosave (debounce, change/blur, pendente gravado antes de trocar); Nome pré-preenchido; autocompletar com teclado e ARIA; nome único vira `Nome <email>`; ambíguo bloqueia o enviar; confirmação só no enviar e `confirmado: true` só após o Sim; confirmações de excluir e restaurar; textos exatos; nenhum `@simpress.com.br`/`@pr.sebrae.com.br` no HTML/JS; 320 px sem rolagem horizontal; temas claro e escuro.
- **Verificar:** `npm run verify` + `npm run test:ui:e2e`.
- **Proibidos:** `domains/entra_users.py` e os arquivos de backend do Passo 1 (`domains/outlook_mail.py`, `domains/outlook_mail.ps1`, `routers/outlook_mail.py`); se o front precisar de mudança neles, parar e devolver o problema.

### Passo 3: Assistente e docs
- **Objetivo:** Assistente e documentação alinhados à nova função, sem ferramenta de envio.
- **Arquivos:** `domains/assistant_chat.py` (próxima regra livre do `SYSTEM_PROMPT`, hoje 37, e, se preciso, exclusão no roteamento UX), `tests/test_assistant*.py`, `AGENTS.md` (regra curta "E-mails por modelo pelo Outlook (Home F1, 09/11/2026)": autorização, escrita externa e local, LGPD; gravada onde o índice novo do enxugamento puser as regras da Home/F1, respeitando o limite de 100 linhas), `docs/cockpit-prompts/03-home-split-view.md` (detalhe e textos aprovados), `docs/arquitetura/CONTRATOS_API_BACKEND.md`, `docs/cockpit-prompts/15-assistente.md`.
- **Critérios de aceite:** a regra nova do prompt aponta a Home e proíbe dizer que enviou ou criou modelo; "e-mail do cabo" não cai no roteamento do `Abrir chamado no UX`; AGENTS.md dentro do limite de linhas; os `.md` citam rotas, arquivo local e textos aprovados.
- **Verificar:** testes do Assistente + `wc -l` dos AGENTS.md + pergunta ao Assistente real no servidor local ("como mando o e-mail do cabo de segurança?"): deve apontar a Home e não dizer que enviou.

### Passo 4: revisão
- **Objetivo:** revisão independente do conjunto antes dos testes reais.
- **Critérios de aceite:** `model-super-power:revisor` sem achado grave aberto em segurança, LGPD (logs, autocompletar), envio duplicado, encoding e corrida do autosave; achados corrigidos dentro do teto de 3 ciclos.
- **Verificar:** relatório do revisor + `npm run verify` e `npm run test:ui:e2e` verdes depois das correções.

### Passo 5: testes reais no Outlook (classic), pelo site local
- **Objetivo:** provar no Outlook real os 16 cenários abaixo.
- **Critérios de aceite:** cada linha da tabela com o resultado esperado.
- **Verificar:** captura do modal e da janela do Outlook por teste; nos envios reais, o item em Itens Enviados e na caixa de destino.

| # | Teste | Esperado |
|---|---|---|
| 1 | `Abrir no Outlook` com o modelo de teste (endereços do próprio usuário), conta Sebrae | Janela com remetente Sebrae, acentos certos, destinatários resolvidos; fechar sem enviar (descartar) |
| 2 | `Abrir` trocando `Enviar de` para Simpress | Remetente Simpress |
| 3 | `Abrir` sem nome/setor (modelo de teste) | Abre com os marcadores (permitido); fechar sem enviar (descartar) |
| 4 | `Enviar` sem nome/setor | Recusado antes do Outlook |
| 5 | `Enviar` com `SIMPRESS_OUTLOOK_SEM_ENVIO=1` | Recusado, nada enviado |
| 6 | Conta inexistente via POST manual | 422 `conta_ausente`, nada aberto |
| 7a | Outlook fechado ao clicar `Abrir` (modelo de teste) | Outlook sobe e abre o e-mail; fechar sem enviar (descartar) |
| 7b | Outlook fechado ao clicar `Enviar` | Recusado com `O Outlook (classic) não está aberto…`; nada enviado |
| 8 | `Copiar Texto` | Texto igual ao corpo com nome e setor |
| 9 | Autocompletar: digitar parte de um nome do Entra no Para | Sugestões; escolher vira `Nome <email>`; `Abrir` resolve no Outlook |
| 10 | Nome com duas pessoas possíveis | Lista de opções; `Enviar` bloqueado até escolher |
| 11 | Criar `Modelo 2 - Gestor`, editar texto, recarregar a página | Texto preservado; trocar entre Modelo 1 e 2 carrega cada um |
| 12 | Editar Para do Modelo 1, depois `Restaurar padrão` | Volta ao texto original |
| 13 | `Excluir modelo` no Modelo 2; tentar excluir o último | Some; último recusado com `Mantenha ao menos um modelo.` |
| 14 | `Enviar` real Sebrae → **caixa Simpress do próprio usuário** | Chega com acentos; está em Itens Enviados da Sebrae |
| 15 | `Enviar` real Simpress → **caixa Sebrae do próprio usuário** | Idem, conta Simpress |
| 16 | Cancelar a confirmação | Nada enviado |

- Nos testes 14 e 15, Para/Cc ficam só com o e-mail do próprio usuário (num modelo de teste, excluído no fim; o Modelo 1 - Cabo é restaurado ao padrão).
- Cada envio real só ocorre após o "pode enviar" do usuário no chat, porque é irreversível.
- Nunca enviar a Allex, Fabio ou Robinson em teste.

## Verificação final
- Cada critério numa linha `AC: <critério> — PROVEN BY <evidência>` (saída de teste, `npm run verify`, `npm run test:ui:e2e`, captura do Outlook e do modal).
- Teto de 3 ciclos de correção por falha.
- O relatório diz o que não foi verificado e quais `.md` foram atualizados.
- Commit local só com OK do usuário; push e PR (com `bind_pr` + auto-fix) só com autorização.
