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
- `endpoint_url` (`SIMPRESS_ENDPOINT_URL`): `endpoint_url()` em `core/config.py` (fonte única com o link padrão); dele saem `ENDPOINT_URL` em `scripts/automacao_rotinas_chrome.py`, a tela de login, Staged Computers (`scripts/staged_computers_endpoint.py`), a checagem de login pelo host e os links da interface (`GET /api/config/local/endpoint/{tela}`, sem reiniciar).
- Os logins do Dashboard, do UX Simpress e do Oracle usam `EMAIL_DASHBOARD` (`scripts/automacao_rotinas_chrome.py:1047-1231`, `2185`, `2590-2591`).

Regras:

- Senha e MFA **nunca** são pedidos nem gravados. O modal diz: "Senha e MFA você digita no Chrome de automação."
- Variável de ambiente vence o arquivo (`core/config.py`, `local_setting`). Se `SIMPRESS_DASHBOARD_EMAIL` (ou outra) estiver definida, o campo aparece **só leitura** com o aviso `Definido por variável de ambiente`.
- Validação no servidor: e-mail com formato válido; `endpoint_usuario` sem `@`, sem `\` e sem espaço; `dashboard_pasta_url` começando com `https://`.

### Seção 2: Dados do cliente (`config/cliente.json`)

Reaproveita o que já existe: `GET` e `PUT /api/config/cliente` (`routers/local_setup.py`, `load_client_config` e `save_client_config` em `domains/local_setup.py`). Nada é duplicado; o modal só chama essas rotas.

Arquivo ilegível (26/11/2026): se `config/cliente.json` ou `config/representantes_regionais.json` estiver com JSON inválido, o `PUT` copia o original para `<nome>.corrompido-AAAAMMDD-HHMMSS.json` na mesma pasta (fora do Git) logo antes de regravar e segue com os valores recebidos; arquivo travado não grava nem copia, e se a cópia falhar nada é gravado.

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
| `GET /api/config/local/endpoint/{tela}` | redireciona os links da interface para o Endpoint (`computadores`, `som-computadores`, `staged-computers`) no host do link configurado, lido a cada clique |
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

## Pacote local (aprovado em 26/11/2026)

Exporta e restaura, num arquivo `.zip` deste computador, configurações, históricos e planilhas atuais. Chaves de IA, senhas e marcas de ações irreversíveis ficam de fora. O nome da função é sempre "Pacote local"; a palavra "backup" não aparece em rótulo, rota ou arquivo (ela é de Backups (F3), outra coisa).

### Onde fica

- Último bloco do modal `Configuração local` (`Prontidão da base > Configuração local`), depois de "Assistente com IA". Sem aba nem atalho novo.
- Seção `#cfg-local-secao-pacote`, em `frontend/src/paineis/configuracao-local/pacote.tsx` (montada por `corpo.tsx`). Usa `Cabecalho`, `ckp-secao`, `ck-campo`, `ck-entrada` e `ck-btn`.
- Domínio: `domains/pacote_local.py`. Rotas: `routers/pacote_local.py` (`/api/pacote-local`), montadas em `main.py`. Contrato: `docs/arquitetura/CONTRATOS_API_BACKEND.md`, seção "Pacote local".

### Pasta do pacote

- Padrão: `data/pacotes_locais/` (criada se faltar). Fora do Git (`/data/pacotes_locais/` no `.gitignore`; `pacote-local-*.zip`, `desfazer-*.zip` e `.pacote-local-*.tmp` também, em qualquer pasta).
- A pasta escolhida fica em `config/pacote_local.json` (`{"pasta": "<caminho absoluto>"}`; vazio ou ausente = padrão). Fora do Git (`/config/pacote_local.json`). Esse arquivo **nunca** entra no pacote e nunca é restaurado.
- Validação ao salvar **e** ao usar a pasta: sem caractere de controle; absoluta, existente, pasta de verdade, gravável (cria e apaga um arquivo temporário); nem ela nem nenhum pai é link ou junção; dentro do repositório só a pasta padrão (fora dela o zip, com dado pessoal, poderia ir ao Git; isso já exclui `static/` e `.transactions/`). Nuvem, rede e repositório são conferidos no caminho resolvido, então `..` não contorna.
- Recusa rede e unidade removível: caminhos `\\` ou `//` (também depois de resolver, o que pega unidade de rede mapeada); no Windows, só unidade fixa (`DRIVE_FIXED`). Em outros sistemas essa checagem é pulada.
- Recusa pastas sincronizadas: dentro das variáveis `OneDrive`, `OneDriveCommercial` ou `OneDriveConsumer` (raiz também resolvida), dentro de um ponto de sincronização do OneDrive/SharePoint registrado no Windows (`HKCU\Software\SyncEngines\Providers\OneDrive\*\MountPoint`; sem a chave, nada muda), ou com um componente de caminho que contenha `onedrive`, `dropbox`, `google drive` ou `icloud` (sem diferenciar maiúsculas).
- Mensagens de erro (textos exatos; a tela mostra a do servidor em `role="alert"`):
  - `A pasta não existe ou não aceita escrita.` (inexistente ou sem escrita)
  - `Use uma pasta deste computador (sem OneDrive, rede ou unidade removível).` (rede, sincronizada ou removível)
  - `Pasta não permitida.` (dentro do repositório fora da padrão, link ou caractere de controle)
- Salvar a pasta: 422 com a mensagem acima, nada gravado. Gravação atômica com trava (409 `Arquivos ocupados; tente de novo em instantes.`; 503 `Não foi possível salvar a pasta; tente de novo.` se o disco recusar). Pasta configurada que sumiu: a lista mostra `erro_pasta` e nenhum pacote.

### Textos aprovados da tela

- Título `Pacote local`; descrição `Guarda configurações, históricos e planilhas atuais num arquivo .zip nesta máquina. Chaves de IA e senhas ficam de fora.`; aviso `Contém dados pessoais; não compartilhe.`
- Campo `Pasta do pacote` com o botão `Salvar pasta`; ajuda `Vazio = padrão data/pacotes_locais/. Só pasta deste computador (sem OneDrive, rede ou unidade removível).`; linha `Pasta: <pasta configurada>`.
- Botão `Exportar pacote` / `Exportando…`; status `Pacote exportado: <arquivo>` (também vai ao toast).
- Vazio: `Nenhum pacote na pasta. Exporte um pacote ou copie um .zip para a pasta.`
- Prévia: título `Prévia da restauração`; `<arquivo> · criado em <data> · versão <x.y.z>`; contagens `Substituir`, `Criar`, `Igual`, `Manter` e `Apagar` (só se maior que zero); `Mostrar todos (Igual e Manter)`; `Atenção: este pacote muda links e contas das automações. Confira antes de confirmar.` (só se `muda_links`); `Antes de restaurar, um pacote de desfazer do estado atual é criado automaticamente.`; botões `Confirmar restauração` / `Restaurando…` (perigo) e `Cancelar`.
- Sucesso: `Restauração concluída. Pacote de desfazer: <arquivo>` com o botão `Recarregar página`.
- Recusas: `Pacote recusado: <motivo>` (na prévia) e `Restauração recusada: <motivo>` (a prévia continua na tela).
- Quadro `O que entra e o que fica de fora` (`<details>`), com o texto aprovado da spec.

### Estados da tela

- **Lista:** tabela no desktop (Arquivo, Tipo `Exportação`/`Desfazer`, Criado em `dd/mm/aaaa hh:mm`, Tamanho e `Restaurar…`); em tela estreita, o mesmo conteúdo em cartões. Mais recente primeiro. Recarrega a cada abertura do modal.
- **Exportando:** botão desabilitado com `Exportando…`.
- **Prévia:** o título recebe o foco. Por padrão só aparecem Substituir, Criar e Apagar; `Mostrar todos` inclui Igual e Manter.
- **Restaurando:** a seção tem `aria-busy="true"`; os botões ficam desabilitados.
- **Já igual:** se a restauração voltar 409 `Este pacote já corresponde ao estado atual.`, a tela mostra essa frase e esconde `Confirmar restauração`.
- **Concluído:** `Recarregar página` (faz `location.reload()`). A página não recarrega sozinha.
- **Erros:** 422 da prévia vira `Pacote recusado`; 409 da restauração vira `Restauração recusada` (role `alert`, com foco na mensagem); 500 vira `Falha ao restaurar. Os arquivos anteriores foram recuperados.` Quando a volta automática também falha, a mensagem diz para conferir `.transactions` antes de usar o app.

### Exportar

1. `POST /api/pacote-local/exportar`, sem corpo. Lê todos os itens da allowlist numa só trava (`lock_paths`), então a cópia é coerente.
2. Grava `pacote-local-AAAAMMDD-HHMMSS.zip` com um `manifesto.json` (formato 1, tipo, versão do app, data, lista de arquivos com tamanho e SHA-256, lista de ausentes). Grava num temporário `.pacote-local-*.tmp` com fsync, reserva o nome (criação exclusiva), troca com `os.replace` e faz fsync da pasta.
3. Reabre o zip e o confere com a mesma validação da prévia. Se não passar (por exemplo, um arquivo atual inválido), apaga o zip e responde 422 `Pacote recusado: <motivo>`.
4. Nunca sobrescreve: se o nome já existe, espera um segundo e tenta outro; se mesmo assim colidir, 409.
5. Limites: 60 MB por arquivo (o `MAX_UPLOAD_BYTES` do app) e 300 MB no total. Acima disso, 422.

### Restaurar (ordem do código)

1. Sem `confirmado: true` no corpo: 422, nada acontece. A tela envia `true` só no clique de `Confirmar restauração`.
2. Guardas, sem espera (409 se alguma estiver ocupada): importação em andamento, por upload ou por caixa de entrada (`uma importação está em andamento`); automação do Chrome em andamento (`uma automação está em execução`); gravação pendente em `.transactions` (`há uma gravação pendente para conferir em .transactions`). Logo depois da guarda de upload liga a trava `RESTAURANDO`: até o fim da restauração, iniciar uma rotina do Chrome pelo site (ou pelo agendamento) responde 409 `Uma restauração do Pacote local está em andamento; tente de novo em instantes.`
3. Valida o zip inteiro (ver "Validação" abaixo) sem gravar nada.
4. Recalcula o `preview_token` (SHA-256 do zip e dos hashes atuais dos itens da allowlist, comparados com `hmac.compare_digest`). Se mudou: 409 `o estado mudou desde a prévia; abra a prévia de novo`. Se nada muda: 409 `Este pacote já corresponde ao estado atual.`
5. Abre a transação `inventory_state_transaction` sobre a allowlist (nível 1 e 2 numa chamada só). Dentro dela, reconfere os hashes.
6. **Antes de gravar**, cria o pacote de desfazer `desfazer-AAAAMMDD-HHMMSS.zip` na mesma pasta com o estado atual, reabre e valida. Se falhar, apaga o desfazer e para com 409 `o pacote de desfazer do estado atual não passou na conferência (...)`. Nada é gravado.
7. Prepara cada arquivo `criar` ou `substituir` (com a conferência dos bytes) e apaga só o que o desfazer manda apagar. Confere de novo a automação (uma rotina iniciada fora do site): se houver, 409 e nada é gravado. Aplica, carrega o banco para provar que o conjunto abre (se o cadastro deixou de existir, publica o estado vazio, como um app sem planilhas), faz commit e publica o estado.
8. Falha: rollback pela transação, e o desfazer criado no passo 6 é apagado (o estado não mudou). Se a gravação já tinha sido feita e só o recarregamento falhou: 500 `A restauração foi gravada, mas o site não recarregou os dados; reinicie o app.`
9. Log: só ação, contagens, SHA-256 do pacote e o tipo do erro. Nunca conteúdo, valores ou nomes de pessoas.

Regra da restauração: arquivo da allowlist que existe hoje e não está no pacote fica **mantido** (`manter`). A única exceção é o `ausentes` de um pacote de desfazer, que é apagado.

### Como desfazer

- Cada restauração cria um pacote `desfazer-*.zip` com o estado de antes. Ele aparece na lista com o tipo `Desfazer`.
- Para desfazer, escolha esse pacote, abra a prévia e confirme. O desfazer também cria o seu próprio desfazer antes de gravar, então a volta pode ser refeita.
- Ida e volta testada: exportar, alterar, restaurar e desfazer volta ao estado exato, inclusive apagando o que não existia antes.

### Validação do zip (prévia, restauração e conferência do desfazer)

Qualquer falha é 422 `Pacote recusado: <motivo>`, sem gravar nada. Motivos: `manifesto ausente ou inválido`; `arquivo fora da lista permitida`; `arquivo não confere com o manifesto`; `caminho inválido no pacote`; `pacote grande demais (limite <N> MB)`; `pacote de uma versão mais nova do app`; `conteúdo inválido em <caminho>`.

- Zip sem cifra, sem pasta, sem link, sem caminho absoluto, sem `..`, sem letra de unidade, sem `\`, sem caractere de controle, sem nome reservado do Windows, sem duplicado (sem diferenciar maiúsculas).
- Manifesto de esquema estrito; entradas iguais ao manifesto; cada caminho igual a um item da allowlist. **O destino vem da allowlist, nunca do nome dentro do zip.**
- Tamanho e SHA-256 conferem, lidos em streaming: a leitura para em `tamanho + 1` e nos limites de 60 MB por arquivo e 300 MB no total (sem limite de razão de compressão: JSON repetitivo comprime mais de 100 vezes).
- O tipo do manifesto bate com o nome (`pacote-local-` = exportação, `desfazer-` = desfazer); senão, `manifesto ausente ou inválido`.
- `.json` precisa ser JSON válido; `.xlsx` passa pelo validador de arquivo seguro e não pode ter macro (`vbaProject`); as duas planilhas de entrada passam pelo validador de upload. `config/contas_automacao.json` e `config/cliente.json` têm os valores revalidados (e-mail, usuário, link, contrato e CNPJ). `historico_chamados.json` precisa ter a lista `chamados`.
- Pacote de versão mais nova que o app é recusado. Versão igual ou mais antiga entra.

### Só neste computador

- Todas as rotas (lista, pasta, exportar, prévia e restaurar) só aceitam pedido direto de `127.0.0.1` ou `::1`. Com acesso pela rede ou pelo Tailscale ligado, a resposta é 403 `Disponível só neste computador.` Todas exigem o cookie de sessão (401 sem ele).

### O que entra e o que fica de fora

Entra (allowlist fixa em `domains/pacote_local.py`, `ALLOWLIST`):

- **Configurações** (`config/`): `cliente.json`, `contas_automacao.json` (contas e links das automações, sem senha), `contato_origem.json`, `representantes_regionais.json`.
- **Planilhas atuais:** `EquipamentosDetalhes_atual.xlsx`, `InvAllComputersSummary_atual.xlsx`, `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`, `data/planilhas_entrada/_modelos/transferencia.xlsx` (modelo importado, vence o modelo padrão) e `modelos/EquipamentosDetalhes-exportacao.xlsx` (se existir).
- **Dados do estado** (`data/state/`): unidades, apelidos modificados, usuários manuais e a pendência de usuário (`usuarios_pendencias.json`, par dos manuais), usuários do Entra, nomes manuais, hostnames removidos, histórico de alterações, histórico de comparações (o que o Resumo usa), histórico de transferências, cobertura e cobertura arquivada, backups regionais (decisões), configurações do Assistente (instruções, notas, busca na web), representantes e modelo de cabo padrão, solicitante do UX, observações de OS, vínculos de chamados e OS, códigos de PowerShell, lembretes, observações do Sebrae, chamados do Sebrae já encerrados (sem texto nem nome) e `historico_chamados.json` (relatório de chamados e OS).

Fica de fora (tupla `FORA`, com motivo):

- `.env` e chaves de IA: segredo.
- `data/state/sebrae_credenciais.json`: senha do chamado.
- Sessão do site (`%LOCALAPPDATA%`) e perfil do Chrome de automação: login, cookies e MFA do usuário.
- `data/state/config_backups/`: cópias antigas de contas, com segredo possível.
- `config/pacote_local.json`: aponta a pasta do próprio pacote.
- `.transactions/` e `.atomic-transactions`: gravação em andamento.
- Marcas de ações irreversíveis (envios, finalizações, agendamentos): chamados Sebrae em andamento, finalizações, agendamentos, fechamentos, o estado do Dashboard e do SharePoint (`sebrae_*`, `dashboard_agendamento.json`, `inventory_update_idempotency.json`), `ux_chamados_historico.json`, `ux_tickets_historico.json`, `os_marcas_finalizacao.json`, `outlook_email_modelos.json`. Restaurar uma versão antiga repetiria um envio ou uma finalização.
- Travas (`automacao_chrome.lock`, `.cancelar`, `**/.*.lock`) e caixas de entrada (`entrada_automatica`, `entrada_chamados`, `entrada_usuarios_entra`): pertencem ao processo que está rodando.
- `data/state/sebrae_anexos/`, `assistente_conversas.json`, `_backups` das importações, relatórios mensais e anotações do histórico (pastas grandes ou compartilhadas).

Nota: a tupla `FORA` existe para documentar. A inclusão no pacote é decidida só pela `ALLOWLIST`; um arquivo novo fica de fora até entrar nela.

### Seletores e ids

- Seção: `#cfg-local-secao-pacote`; título `#cfg-local-titulo-pacote`.
- Pasta: `#cfg-local-pacote-form-pasta`, `#cfg-local-pacote-pasta`, `#cfg-local-pacote-salvar-pasta`, `#cfg-local-pacote-pasta-ajuda`, `#cfg-local-pacote-pasta-erro` (`role="alert"`), `#cfg-local-pacote-pasta-atual`.
- Exportar: `#cfg-local-pacote-exportar`; mensagem: `#cfg-local-pacote-mensagem` (`role` `status` ou `alert`); `#cfg-local-pacote-recarregar`.
- Lista: `#cfg-local-pacote-vazio`, `#cfg-local-pacote-lista`, linhas `data-arquivo="<nome>"`, botão `[data-pacote-restaurar="<nome>"]`.
- Prévia: `#cfg-local-pacote-previa`, `#cfg-local-pacote-previa-titulo`, `#cfg-local-pacote-previa-resumo`, `#cfg-local-pacote-previa-totais` (`li[data-acao]`), `#cfg-local-pacote-previa-itens`, `#cfg-local-pacote-mostrar-todos`, `#cfg-local-pacote-previa-links`, `#cfg-local-pacote-confirmar`, `#cfg-local-pacote-cancelar`.
- Quadro: `#cfg-local-pacote-detalhes`.

### Testes que provam

- `tests/test_pacote_local.py` (Python, dados sintéticos em pasta temporária): allowlist igual às constantes de `core/config.py` (toda constante `*_FILE`/`*_DIR` sob `STATE_DIR` ou `config/` está na allowlist ou em `FORA`; só `.json` e `.xlsx`; sem sobreposição); exporta só a allowlist; `.env`, `config_backups`, `sebrae_credenciais.json` e `config/pacote_local.json` nunca entram; nunca sobrescreve pacote; hash errado, `..`, caminho absoluto, arquivo que sobra, entrada fora da allowlist, symlink, sem manifesto, versão mais nova, limite de tamanho e conteúdo inválido dão 422; 404 para nome fora do padrão; sem `confirmado` nada acontece; token velho dá 409; automação e importação dão 409; desfazer criado antes de gravar, e falha do desfazer aborta; falha depois de gravar volta os arquivos; ida e volta com desfazer; arquivo ausente no pacote é mantido; pastas UNC, OneDrive, inexistente e `static/` são recusadas; salvar pasta válida volta ao padrão; prompt do Assistente diz que ele não mexe no pacote; pedido fora de 127.0.0.1 dá 403; rota sem cookie dá 401.
- `tests/e2e/pacote-local.spec.cjs` (Playwright, API simulada): sem pacotes (texto de vazio, aviso e quadro); lista em tabela no desktop e em cartões a 375 px sem rolagem horizontal; exportar mostra o arquivo e atualiza a lista; prévia, confirmação com o corpo exato e conclusão; prévia sem mudança de links não mostra o aviso e `Apagar` só aparece se maior que zero; 409 mostra alerta e mantém a prévia; pacote igual esconde `Confirmar`; 500 mostra a falha com recuperação; 422 na prévia mostra `Pacote recusado`; pasta inválida mostra o erro do servidor; `Cancelar` não envia restauração; temas claro e escuro sem erro de console nem rolagem horizontal.

### Limites conhecidos

- O conteúdo do pacote fica em memória durante a validação (até 300 MB). Se os pacotes crescerem, trocar por releitura do zip.
- Restaurar não devolve marcas de ações irreversíveis: o que ficou de fora continua como está hoje. Depois de restaurar, confira o Sebrae e a OS antes de agir.
- Os tipos da tela vêm de `frontend/src/api-tipos.gerado.d.ts` (`PacoteLocal*`); regenere com `python scripts/gerar_tipos_api.py` ao mudar o contrato.

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
