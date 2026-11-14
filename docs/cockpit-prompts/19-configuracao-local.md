# 19. Configuração local pelo site (Prontidão da base)

Especificação aprovada para implementar, de 14/11/2026. Ainda **não implementada**: a Fase 3 depende do merge da branch `claude/dados-reais-config-local-19c87f`, que cria `config/cliente.json` e mexe em `core/config.py` e `domains/local_setup.py`.

## Objetivo

Depois de um `git clone`, o usuário configura pelo site, no painel **Prontidão da base**, tudo o que hoje exige copiar e editar arquivos à mão em `config/` ou no `.env`. Ele não precisa abrir nenhuma pasta.

## Onde fica

- Painel: `#readiness-panel` (`static/index.html`); cartões montados em `static/js/features/dashboard.js` (Inventários, OS, Modelo de exportação, Regionais).
- Status: `GET /api/prontidao` (`routers/system.py`), calculado em `domains/readiness.py` (`build_readiness_report`).
- Lógica nova: módulo novo `domains/configuracao_local.py` e router novo `routers/configuracao_local.py`, sem duplicar o que `domains/local_setup.py` já faz.
- Gravação: `core/integrity.py` (`atomic_write_json`, `atomic_write_bytes`), que já faz troca atômica com `os.replace`.

## Cartão novo "Configuração local"

- Entra no fim da lista do painel, com o mesmo componente dos outros cartões: ícone, título, linha de status e botão à direita.
- Status:
  - **Em dia**: as três contas preenchidas e `config/cliente.json` válido.
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
| Pasta do Dashboard (endereço do SharePoint) | `https://empresa.sharepoint.com/sites/...` | Usada para: exportação do Dashboard | `dashboard_pasta_url` |

Quem lê cada chave (conferido em 14/11/2026):

- `dashboard_email`, `softexpert_email`, `endpoint_usuario`, `dashboard_pasta_url`: `scripts/automacao_rotinas_chrome.py:76-85`.
- `outlook_email_sebrae`, `outlook_email_simpress`: `domains/outlook_mail.py:41-42`.
- Os logins do Dashboard, do UX Simpress e do Oracle usam `EMAIL_DASHBOARD` (`scripts/automacao_rotinas_chrome.py:1047-1231`, `2185`, `2590-2591`).

Regras:

- Senha e MFA **nunca** são pedidos nem gravados. O modal diz: "Senha e MFA você digita no Chrome de automação."
- Variável de ambiente vence o arquivo (`core/config.py`, `local_setting`). Se `SIMPRESS_DASHBOARD_EMAIL` (ou outra) estiver definida, o campo aparece **só leitura** com o aviso `Definido por variável de ambiente`.
- Validação no servidor: e-mail com formato válido; `endpoint_usuario` sem `@`, sem `\` e sem espaço; `dashboard_pasta_url` começando com `https://`.

### Seção 2: Dados do cliente (`config/cliente.json`)

Usa o arquivo e o leitor criados pela branch `dados-reais-config`, sem duplicar.

| Campo | Validação |
|---|---|
| Contrato | só dígitos, de 1 a 10 |
| CNPJ de faturamento | 14 dígitos com dígito verificador válido; mostrado com máscara `00.000.000/0000-00` |
| Séries do Sebrae fora das comparações | lista, uma por linha; letras e dígitos maiúsculos |

O cabeçalho do painel ("Contrato 16467") passa a ler este arquivo.

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
| `PUT /api/config/local/cliente` | grava `config/cliente.json` |
| `PUT /api/config/local/assistente` | grava as chaves no `.env`; corpo vazio numa chave mantém o valor |
| `DELETE /api/config/local/assistente/{chave}` | remove a chave do `.env` |

Erros de validação: 422 com o campo e a mensagem, sem repetir o valor recebido.

## Gravação e backup

- Gravação atômica com `core/integrity.py`.
- Antes de sobrepor, copia o arquivo anterior para `data/state/config_backups/<arquivo>.<AAAAMMDD-HHMMSS>.bak` e mantém os 5 mais recentes. A pasta precisa entrar no `.gitignore`.
- O log registra só `configuracao_local: <seção> gravada`, sem valores.

## Quando a automação passa a usar o valor novo

Hoje as contas são lidas na importação do módulo (`scripts/automacao_rotinas_chrome.py:76-85`, `domains/outlook_mail.py:41-42`):

- A rotina de automação roda como subprocesso (`domains/chrome_automation.py`) e lê o arquivo novo na próxima execução.
- `domains/endpoint_lookup.py` e `domains/outlook_mail.py` são importados pelo servidor e guardam o valor antigo até reiniciar.

A implementação troca essas constantes por leitura na hora do uso (função que chama `local_setting`), para não exigir reinício. Se isso não for possível, o modal mostra `Reinicie o Simpress para aplicar`.

O `.env` é lido em cada carga de `OpenRouterSettings.load` (`read_env_file`), sem cache: vale na próxima mensagem ao Assistente.

## LGPD e repositório público

- Nenhum e-mail, nome ou CNPJ real em código, testes, docs, PR ou log. Testes usam `@exemplo.invalid`.
- Nada de dado pessoal em `static/**`; o front recebe os valores só pela API.
- `git status` não pode mostrar `config/*.json`, `.env` nem os backups.

## Assistente (F9)

`MSG_SEM_CHAVE` (`domains/assistant_chat.py`) passa a dizer: "Configure a chave em Prontidão da base > Configuração local." O Assistente não grava configuração e não tem ferramenta para isso.

## Testes previstos

- Backend: validação (CNPJ, contrato, e-mail, usuário, URL), gravação atômica com backup, segredo nunca devolvido nem logado, chave vazia mantém a atual, variável de ambiente deixa o campo só leitura, 401 sem cookie, status Pendente lista o que falta.
- Front (node): cartão e modal com os mesmos IDs e ARIA do painel.
- E2E: clone sem `config/*.json` mostra Pendente; preencher deixa Em dia; capturas nos temas claro e escuro.

## Pendente para depois do merge da `dados-reais-config`

- Linha deste doc no Índice do `AGENTS.md`.
- README e `docs/guias/PRIMEIRO_ACESSO.md`: a instalação passa a dizer "configure em Prontidão da base".
- `docs/arquitetura/CONTRATOS_API_BACKEND.md`: os endpoints acima.
