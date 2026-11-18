# 19. Configuração local pelo site (Prontidão da base)

Especificação de 14/11/2026. A branch `dados-reais-config` (que criou `config/cliente.json`) já foi mesclada no `main`.

## Objetivo

Depois de um `git clone`, o usuário configura pelo site, no painel **Prontidão da base**, tudo o que hoje exige copiar e editar arquivos à mão em `config/` ou no `.env`. Ele não precisa abrir nenhuma pasta.

## Onde fica

- Painel: `#readiness-panel` (`static/index.html`); cartões (Inventários, OS, Modelo de exportação, Regionais) montados em `frontend/src/paineis/indicadores-home/estado.ts`; `frontend/src/aplicacao/dashboard.ts` é a ponte desde o BF3 (16/11/2026).
- Status: `GET /api/prontidao` (`routers/system.py`), calculado em `domains/readiness.py` (`build_readiness_report`).
- Lógica nova: módulo novo `domains/configuracao_local.py` e router novo `routers/configuracao_local.py`, sem duplicar o que `domains/local_setup.py` já faz.
- Gravação: `core/integrity.py` (`atomic_write_json`, `atomic_write_bytes`), que já faz troca atômica com `os.replace`.

## Cartão novo "Configuração local"

- Entra no fim da lista do painel, com o mesmo componente dos outros cartões: ícone, título, linha de status e botão à direita.
- Status:
  - **Em dia**: as três contas e o link da pasta do Dashboard preenchidos e `config/cliente.json` válido.
  - **Pendente**: a linha diz exatamente o que falta, por exemplo `Pendente · Falta: Conta Sebrae (e-mail), Usuário do Endpoint Central`.
  - **Inválido**: arquivo existe, mas não é JSON válido ou tem valor recusado pela validação.
- Botão: `Configurar`. Ele abre o modal descrito abaixo.
- A chave de IA é opcional e não deixa o cartão Pendente; aparece como `Assistente sem IA` em texto secundário.
- Contagem `N de N fontes em dia` passa a incluir o cartão novo.
- Visual: mesmo padrão do painel e do artefato https://claude.ai/artifact/DGgv5VBXhu4NrZ9DbxFQhC, temas claro e escuro, de 320px a 2560px, animação de 150 a 300 ms com `prefers-reduced-motion`.

No `/api/prontidao`, o status entra como chave nova `configuracao_local`:

```json
{ "configuracao_local": { "state": "ready|pending|invalid", "faltando": ["conta_sebrae"], "reason": "" } }
```

A lista `faltando` traz só identificadores, nunca o valor.

## Modal "Configuração local"

Um modal com seções. Cada seção salva sozinha (botão `Salvar` por seção). O foco volta ao botão `Configurar` ao fechar.

### Seção 1: Contas das automações (`config/contas_automacao.json`)

Cada conta é pedida **uma vez**, com o texto de onde é usada. O formato do arquivo lido pelas automações não muda: o formulário grava o mesmo valor em todas as chaves do grupo.

| Campo | Placeholder | Ajuda | Chaves gravadas |
|---|---|---|---|
| Conta Simpress (e-mail) | `nome@simpress.com.br` | Usada para: Dashboard, UX Simpress, Oracle | `dashboard_email`; `outlook_email_simpress` se "Usar também no Outlook" estiver marcado (padrão marcado) |
| Conta Sebrae (e-mail) | `nome@sebrae.com.br` | Usada para: SoftExpert | `softexpert_email`; `outlook_email_sebrae` se "Usar também no Outlook" estiver marcado (padrão marcado) |
| Usuário do Endpoint Central (login, sem domínio) | `nome.usuario` | Usada para: Endpoint Central | `endpoint_usuario` |
| Link da pasta do Dashboard (SharePoint) | `https://exemplo.invalid/sites/pasta-do-dashboard` | Usado para: Dashboard | `dashboard_pasta_url` |
| Link do Endpoint Central (Computadores), opcional (18/11/2026) | `https://exemplo.invalid/webclient#/uems/inventory/computers` | Usado para: Endpoint Central (em branco usa o link padrão) | `endpoint_url` |

O usuário confirmou em 15/11/2026 que os e-mails do Outlook são as mesmas contas Simpress e Sebrae; por isso "Usar também no Outlook" vem marcado.

Os links ficam numa subseção "Links internos", montada a partir de uma lista de campos no servidor (`chave`, `rotulo`, `placeholder`, `usado_para`). Um link novo (UX, Endpoint, Oracle, SoftExpert, Notion) entra só com uma linha nessa lista, com a mesma validação `https://`.

Quem lê cada chave (conferido em 14/11/2026):

- `dashboard_email`, `softexpert_email`, `endpoint_usuario`, `dashboard_pasta_url`: `scripts/automacao_rotinas_chrome.py:76-85`.
- `outlook_email_sebrae`, `outlook_email_simpress`: `domains/outlook_mail.py:41-42`.
- `endpoint_url` (`SIMPRESS_ENDPOINT_URL`): `ENDPOINT_URL` em `scripts/automacao_rotinas_chrome.py`; dele saem a tela de login, Staged Computers (`scripts/staged_computers_endpoint.py`) e a checagem de login pelo host.
- Os logins do Dashboard, do UX Simpress e do Oracle usam `EMAIL_DASHBOARD` (`scripts/automacao_rotinas_chrome.py:1047-1231`, `2185`, `2590-2591`).

Regras:

- Senha e MFA **nunca** são pedidos nem gravados. O modal diz: "Senha e MFA você digita no Chrome de automação."
- Variável de ambiente vence o arquivo (`core/config.py`, `local_setting`). Se `SIMPRESS_DASHBOARD_EMAIL` (ou outra) estiver definida, o campo aparece **só leitura** com o aviso `Definido por variável de ambiente`.
- Validação no servidor: e-mail com formato válido; `endpoint_usuario` sem `@`, sem `\` e sem espaço; `dashboard_pasta_url` começando com `https://`.

### Seção 2: Dados do cliente (`config/cliente.json`)

Reaproveita o que já existe: `GET` e `PUT /api/config/cliente` (`routers/local_setup.py`, `load_client_config` e `save_client_config` em `domains/local_setup.py`). Nada é duplicado; o modal só chama essas rotas.

| Campo | Validação |
|---|---|
| Contrato | só dígitos, até 12, sem zero à esquerda (já existe) |
| CNPJ de faturamento | formato `00.000.000/0000-00` (já existe) e, novo, dígito verificador válido |
| Séries do Sebrae fora das comparações | lista, uma por linha; letras e dígitos maiúsculos (já existe) |

### Seção 3: Assistente com IA (`.env`)

| Campo | Comportamento |
|---|---|
| Chave do OpenRouter (`OPENROUTER_API_KEY`) | opcional |
| Chave do DeepSeek (`DEEPSEEK_API_KEY`) | opcional; se preenchida, vale no lugar do OpenRouter |

Regras de segredo:

- O servidor nunca devolve a chave. Devolve só `{"configurada": true, "final": "…a1b2"}` (4 últimos caracteres).
- O campo vem **vazio**, com a máscara como placeholder. Salvar com o campo vazio **mantém** a chave atual. Remover é um botão explícito `Remover chave`.
- A chave nunca vai para log, histórico, resposta de erro nem conteúdo enviado ao modelo.
- Gravação do `.env`: troca só as linhas `CHAVE=` afetadas e preserva comentários e as demais linhas, em UTF-8. Se a linha não existir, acrescenta no fim.

### Seções já existentes (só atalho)

- Contato de origem da transferência (`config/contato_origem.json`) e representantes regionais: já têm formulário e `PUT` em `routers/local_setup.py`. O modal só mostra o status deles e leva ao formulário atual.
- Solicitante do UX (`data/state/ux_solicitante.json`): já tem tela no modal do UX; o modal só mostra o status.

## Fora do escopo, com motivo

- `SIMPRESS_UX_SEM_ENVIO` e `SIMPRESS_OUTLOOK_SEM_ENVIO`: travas de segurança. Desligá-las pelo site seria regressão.
- `SIMPRESS_PORT`, `SIMPRESS_CHROME_*`, `SIMPRESS_ENABLE_DOCS`, `SIMPRESS_AVISOS`, `SIMPRESS_TESTE_*` e demais flags de dev e teste.
- `data/state/outlook_modelo_cabo_padrao.json`: o invariante do Outlook no `AGENTS.md` diz que o sistema só **lê** esse arquivo. Gravá-lo pelo site muda o invariante e exige aprovação do usuário antes.
- Pastas de entrada (`SIMPRESS_IMPORT_INBOX_DIR`, `SIMPRESS_TICKET_IMPORT_INBOX_DIR`, `SIMPRESS_ANNOTATIONS_DIR`): hoje só existem como variável de ambiente em `core/config.py`. Gravá-las por arquivo exige mexer nesse arquivo; fica para depois do merge da `dados-reais-config`. Quando entrar, a validação exige pasta existente.

## API

Todos os endpoints exigem o cookie `simpress_sessao_<porta>` (401 sem ele).

| Método e rota | Faz |
|---|---|
| `GET /api/config/local` | status de cada seção; e-mails e usuário voltam inteiros (são do próprio usuário, na máquina dele); chaves só como `configurada` e `final` |
| `PUT /api/config/local/contas` | grava `config/contas_automacao.json` |
| `GET` e `PUT /api/config/cliente` (já existem) | lê e grava `config/cliente.json` |
| `PUT /api/config/local/assistente` | grava as chaves no `.env`; corpo vazio numa chave mantém o valor |
| `DELETE /api/config/local/assistente/{chave}` | remove a chave do `.env` |

Erros de validação: 422 com o campo e a mensagem, sem repetir o valor recebido.

## Gravação e backup

- Gravação atômica com `core/integrity.py`.
- Antes de sobrepor, copia o arquivo anterior para `data/state/config_backups/<arquivo>.<AAAAMMDD-HHMMSS>.bak` e mantém os 5 mais recentes. A pasta precisa entrar no `.gitignore`.
- `Remover chave` não faz backup: a cópia guardaria a chave removida. Cópias feitas por gravações anteriores continuam na pasta e não são apagadas; apague-as à mão se a chave removida vazou.
- Chave de IA vinda de variável de ambiente não é gravada nem removida pelo site (422, nada muda; a mensagem traz só o rótulo): altere a variável.
- `Usar também no Outlook` desmarcado remove o espelho `outlook_email_*` quando ele é igual à conta, mesmo com o campo em branco; espelho diferente da conta (escolhido à mão) fica. Caixa ausente no pedido, com o campo em branco, não mexe no espelho. Conta vinda de variável de ambiente nunca é copiada para o espelho do arquivo com o campo em branco.
- O log registra só `configuracao_local: <seção> gravada`, sem valores.

## Quando a automação passa a usar o valor novo

Leitura na hora do uso (função que chama `local_setting`), sem reiniciar o servidor:

- A rotina de automação roda como subprocesso (`domains/chrome_automation.py`) e lê o arquivo novo na próxima execução.
- `domains/endpoint_lookup.py` (e-mail da consulta ao vivo), `domains/outlook_mail.py` (e-mail do Outlook) e o usuário do login do Endpoint (`usuario_endpoint()` em `scripts/automacao_rotinas_chrome.py`, que a consulta ao vivo chama dentro do servidor) leem a cada uso. A constante `ENDPOINT_USUARIO` só serve para os testes forçarem um valor: `None` (padrão) lê na hora, texto (inclusive vazio) vale como está.
- As demais contas lidas na importação estão em "Limites conhecidos".

O `.env` é lido em cada carga de `OpenRouterSettings.load` (`read_env_file`), sem cache: vale na próxima mensagem ao Assistente.

## LGPD e repositório público

- Nenhum e-mail, nome ou CNPJ real em código, testes, docs, PR ou log. Testes usam `@exemplo.invalid`.
- Nada de dado pessoal em `static/**`; o front recebe os valores só pela API.
- `git status` não pode mostrar `config/*.json`, `.env` nem os backups.

## Assistente (F9)

`MSG_SEM_CHAVE` (`domains/assistant_chat.py`) passa a dizer: "Configure a chave em Prontidão da base > Configuração local." O Assistente não grava configuração e não tem ferramenta para isso.

## Front implementado (14/11/2026)

- Cartão: `#readiness-configuracao-local`, montado em `frontend/src/paineis/indicadores-home/estado.ts` (`carregarProntidao`; ponte: `frontend/src/aplicacao/dashboard.ts`) com o mesmo componente dos outros cartões (ícone `i-pencil`, linha de status, botão `#btn-configuracao-local` com o texto `Configurar`). O cartão só aparece quando `/api/prontidao` traz `configuracao_local`; servidor antigo e a fixture da interface não mostram o cartão. Estados: `Em dia`, `Pendente · <reason>` (o `reason` do servidor já vem como `Falta: <rótulos>`) e `Inválido`. `Assistente sem IA` entra em texto secundário (`.ck-pront__secundario`) quando `assistente_ia` é falso. A contagem `N de N fontes em dia` vem dos itens `[data-pendencia]` e já inclui o cartão; o resumo `Tudo disponível` do cabeçalho continua contando só os cinco arquivos.
- Modal: `#modal-configuracao-local` em `frontend/partials/modais.html`, corpo `#cfg-local-corpo` e lógica em React (`frontend/src/paineis/configuracao-local/`: `estado.ts`, `acoes.ts`, `corpo.tsx`, `montar.tsx`; migração React, Dia 2, G2). `frontend/src/aplicacao/pontes.ts` (entrada `configuracaoLocal`) ficou só como ponte (`context.ponteReact`), com os mesmos nomes em `window` e na `FEATURE_ORDER` de `frontend/src/aplicacao/app.ts`; cabeçalho e rodapé do modal seguem no partial. Usa o casco `ckp-*` e o kit `ck-*` dos outros modais, `abrirModalAcessivel` e `confirmarAcao`; não criou componente novo. Ao fechar, o foco volta a `#btn-configuracao-local` (o painel se redesenha, então o foco é reaplicado no quadro seguinte).
- Seções, cada uma com o próprio `Salvar` (`#cfg-local-salvar-contas|links|cliente|assistente`) e uma linha de status própria (`#cfg-local-status-<seção>`, `role="status"`):
  - Contas e Links internos: campos gerados de `contas` e `links` da API (nada fixo no código), placeholder e ajuda vindos do servidor, `Usar também no Outlook` nas contas de e-mail, `Definido por variável de ambiente` nos campos `somente_leitura`. As duas seções usam o mesmo `PUT /api/config/local/contas`; ao salvar uma, só ela é redesenhada, então o que foi digitado na outra não se perde. Campo em branco mantém o valor atual.
  - Dados do cliente: reaproveita `GET`/`PUT /api/config/cliente` (contrato, CNPJ, séries uma por linha); a validação do formato é feita antes de enviar e o foco vai ao campo com erro. Campo vindo de variável de ambiente segue como em `#modal-cliente-config`: vai `""` (e `null` nas séries) no corpo.
  - Assistente com IA: campo `type="password"`, `autocomplete="new-password"`, sempre vazio, com `final` como placeholder. Campo vazio mantém a chave e não faz requisição. A chave digitada é apagada do campo em qualquer resultado (sucesso ou erro) e nunca aparece na tela nem no aviso. `Remover chave` (`aria-label` `Remover chave do <nome>`) só existe para chave própria configurada, pede confirmação (`Remover chave?`) e chama `DELETE /api/config/local/assistente/{chave}`.
  - Outros formulários: botão para o contato de origem da transferência (`app.abrirConfiguracaoContatoOrigem`), que abre por cima do modal; some se a ação não existir.
- Depois de cada gravação o front chama `app.carregarProntidao()` e o cartão muda sem recarregar a página.
- Desvios desta entrega em relação ao que a spec previa:
  - Os atalhos mostram só o botão, sem a linha de status do contato de origem (a API não devolve esse status).
  - Representantes regionais ficaram sem atalho: editar um representante exige uma cidade escolhida no formulário de transferência.
  - O Solicitante do UX não aparece (já tem tela no modal do UX e a API não devolve status).
  - O artefato de referência (`DGgv5VBXhu4NrZ9DbxFQhC`) não pôde ser lido; o visual segue o painel e os modais atuais.
  - `Usar também no Outlook` usa o `.ckp-alternar` existente, que marcado fica em âmbar como nos outros interruptores.

## Testes

- Backend: validação (CNPJ, contrato, e-mail, usuário, URL), gravação atômica com backup, segredo nunca devolvido nem logado, chave vazia mantém a atual, variável de ambiente deixa o campo só leitura, 401 sem cookie, status Pendente lista o que falta.
- Front (Playwright): `tests/e2e/react-g2.spec.cjs`, "Configuração local em React: comportamento" (campos gerados da API, chave vazia e nunca exibida, payloads, 422 sem toast, foco ao fechar, duplo clique, `Remover chave` com confirmação) e baselines de screenshot em 390 e 1366 px, claro e escuro. Substitui o antigo `tests/frontend/test_configuracao_local.cjs` (DOM falso).
- E2E: `tests/e2e/configuracao-local.spec.cjs` com a API simulada e com estado: Pendente lista o que falta, preencher e salvar deixa Em dia, a chave some do campo, validação do cliente, `Remover chave` com confirmação, auditoria axe do modal e ausência de rolagem horizontal de 320 a 2560 px nos dois temas. As capturas (painel e modal, claro e escuro) saem só com `SIMPRESS_CAPTURAS_DIR=<pasta fora de static/>` definida; o teste que as salva é pulado sem ela.

## Documentos alinhados

- Índice do `AGENTS.md`, `README.md` e `docs/guias/PRIMEIRO_ACESSO.md` apontam para **Prontidão da base > Configuração local**.
- `docs/arquitetura/CONTRATOS_API_BACKEND.md` descreve as rotas acima.
- `MSG_SEM_CHAVE` e o aviso de assistente desligado no front (`frontend/src/paineis/assistant-chat/`) dizem "Configure a chave em Prontidão da base > Configuração local.".

## Limites conhecidos

- `domains/ux_ticket_browser.py`, `scripts/sebrae_softexpert.py` e, em `scripts/automacao_rotinas_chrome.py`, `EMAIL_DASHBOARD`, `EMAIL_SOFTEXPERT` e `DASHBOARD_PASTA_URL` ainda leem as contas ao importar o módulo: nas rotinas que rodam dentro do servidor, a conta nova vale depois de reiniciar o Simpress. O usuário do Endpoint já não entra aqui. O link do Endpoint (`endpoint_url`) também é lido ao importar: a rotina usa o novo na próxima execução; a consulta ao vivo da Home, depois de reiniciar o Simpress.
- Salvar a seção Links envia também o estado das caixas `Usar também no Outlook`; com a conta em branco, uma caixa desmarcada passa a valer nesse salvamento.
- Conta em branco no formulário mantém o valor atual; para limpar, edite o arquivo.
