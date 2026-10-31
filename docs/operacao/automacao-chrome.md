# Tela Automação (rotinas do Chrome pelo site)

Objetivo: executar pelo site local as rotinas de `scripts/automacao_rotinas_chrome.py` (as mesmas do `executar_automacao.bat`), acompanhar o andamento ao vivo e consultar as últimas execuções, sem abrir o terminal.

O site **só inicia** o script. As exportações continuam sendo feitas no Chrome de automação (perfil próprio, porta CDP 9333) e os arquivos continuam sendo importados pelas pastas locais `data/state/entrada_chamados` e `data/state/entrada_automatica`, nunca por upload ou HTTP (regra do `AGENTS.md`).

Rotina `sebrae` (Chamados novos Sebrae: lê o SoftExpert e grava `data/state/sebrae_novos.json`; sem agendamento na tela): [especificação](sincronizar-chamados-sebrae.md). Ela usa este mesmo contrato, a mesma trava e o mesmo histórico.

Rotina `dashboard` (botão `Baixar, importar e buscar`): no Chrome de automação (porta 9333, login do SharePoint manual) abre a pasta `DASHBOARD SEBRAE`, clica nos três pontos (`Mais ações`/`More actions`) da linha `Dashboard Operacional_SEBRAE.xlsx` e em `Baixar`/`Download` (só leitura; vai para Downloads; `.zip` é recusado), importa o `.xlsx` baixado no site local (`POST /api/sebrae/dashboard`, porta `SIMPRESS_PORT`) e em seguida roda a rotina `sebrae`. Os rótulos reais do menu precisam ser confirmados no ensaio supervisionado.

Rotina `enviar` (botão `Enviar ao SharePoint`, ao lado de `Atualizar Dashboard`): abre a pasta `DASHBOARD SEBRAE` do SharePoint no Chrome de automação (porta 9333; só o e-mail é digitado, senha e MFA são do usuário) e, nesta ordem: faz `Mais ações › Duplicata` do `Dashboard Operacional_SEBRAE.xlsx` e espera a cópia aparecer (sem ela, não sobrepõe); baixa o arquivo atual e confere com o Dashboard importado (mudou: aborta e pede nova importação); guarda o baixado em `data/state/sebrae_backups/` (20 mais recentes); sobe `data/state/sebrae_dashboard_saida/Dashboard Operacional_SEBRAE.xlsx` por `Create or upload › Files upload` (ou `Upload › Files`) e escolhe `Replace`/`Substituir` (só `Keep both`: recusa; arquivo em uso: erro claro); confirma só pelo aviso de envio concluído (o texto da linha muda sozinho com a data relativa e não prova o envio; sem o aviso em 90 s, erro). Falha se o site ainda não gerou o arquivo (`Atualizar Dashboard`).

## Contrato com o script

O servidor depende do script somente pela linha de comando e por arquivos; não importa o módulo. Todos os nomes ficam num só lugar, `ScriptContract` em `domains/chrome_automation.py`.

| Item | Valor | Uso pelo servidor |
| --- | --- | --- |
| Script | `scripts/automacao_rotinas_chrome.py --rotina <os\|inventarios\|ambas\|login>` | Iniciado por `subprocess.Popen` com lista de argumentos, sem shell. |
| Python | `.venv/Scripts/python.exe` (ou o Python do servidor, se não houver `.venv`) | Mesmo interpretador do `.bat`. |
| Ambiente | `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`, `PYTHONUNBUFFERED=1` | As duas primeiras são as do `.bat`; a terceira garante as linhas ao vivo. |
| Janela | `CREATE_NO_WINDOW`, stdin nulo | Sem console; o script não lê o teclado. |
| Trava | `data/state/automacao_chrome.lock` (JSON `pid`, `rotina`, `inicio`) | Execução iniciada fora do site (`.bat`) aparece como "em andamento" quando o PID está vivo. |
| Código "ocupada" | `2` | O script recusou porque já havia outra execução. |
| Cancelamento | `--cancelar` (sinal `data/state/automacao_chrome.cancelar`), código `130` | Usado quando o `--help` do script lista `--cancelar`. |
| Log do script | `data/logs/automacao_chrome/<AAAAMMDD_HHMMSS>_<rotina>.log` + `.json` irmão (`rotina`, `inicio`, `fim`, `status`, `codigo`, `mensagem`, `lotes`, `capturas`) | Entra no histórico; o `.log` mais recente é lido quando a execução veio de fora do site. |
| Capturas de erro | `data/logs/automacao_chrome/*.png` | Linha `Captura da tela no erro: <caminho>` no log. |
| Espera de login | Linha `AÇÃO NECESSÁRIA: faça o login…`; termina com `Login detectado` ou `Sessão ativa` | Mostra o aviso para ir ao Chrome. |
| Lote | Linha `Lote <id> em <estado>` e `status=<status>` | Lotes e status da importação no histórico. |

### Compatibilidade com o script atual

Enquanto a trava, o log em arquivo e o `--cancelar` não estiverem no script:

- O servidor **sempre** grava a saída do processo que ele iniciou em `data/logs/automacao_chrome/<AAAAMMDD_HHMMSS>_<rotina>.site.log` e o resumo em `.site.json` (`origem: "site"`). As linhas ao vivo vêm desse arquivo. Quando o `.json` do próprio script existir para a mesma execução (mesma rotina, início a até 10 s), os dois aparecem como uma única linha no histórico, com lotes e capturas do script.
- Sem trava, o servidor só enxerga as execuções que ele mesmo iniciou; uma execução aberta pelo `.bat` não é detectada.
- Sem `--cancelar`, **Cancelar** encerra somente o processo Python filho (`TerminateProcess`). O Chrome da porta 9333 não é filho dele (é iniciado destacado) e continua aberto com os logins; o driver do Playwright sai quando o processo pai termina. Um `process_*_inbox.py` que já estiver importando continua até o fim e grava o `_resultado.json` normalmente.

## Concorrência com as pastas de entrada

Com o servidor ativo, as inboxes do próprio servidor também processam os lotes. O script chamar `process_ticket_inbox.py`/`process_inventory_inbox.py` ao mesmo tempo é seguro:

- Cada inbox usa `.importador.lock` (trava de arquivo do sistema operacional, não bloqueante, `domains/inventory_inbox.py` e `domains/ticket_inbox.py`). Quem não obtém a trava sai sem processar (`0` lotes) e o script continua esperando o `_resultado.json`.
- O lote é reivindicado por renomeação de `pendentes/` para `processando/`; só um processo vence.
- O script confirma o lote pelo `_resultado.json` em `processadas/` ou `falhas/`, seja quem for que o processou.

## API

| Método e caminho | Entrada | Resposta | Erros |
| --- | --- | --- | --- |
| `POST /api/automacao/executar` | JSON `{rotina}`; só `os`, `inventarios`, `ambas`, `login`. | 202 com o mesmo corpo do estado. | 409 `Já há uma rotina em andamento: <rotina> desde <hora>.`; 422 rotina fora da lista; 503 script ausente ou falha ao iniciar. |
| `POST /api/automacao/cancelar` | Sem corpo. | 202 `{metodo: "sinal"\|"processo", mensagem, estado}`. | 409 nenhuma rotina em andamento, ou execução de fora do site sem `--cancelar`. |
| `GET /api/automacao/estado?offset=N` | `offset` em bytes do log (0 = início). | `{estado: "livre"\|"em_andamento", rotina, inicio, origem, pid, cancelamento_pedido, aguardando_login, login_origem, log: {arquivo, offset, linhas, reiniciado}, ultima}`. | 422 offset negativo. |
| `GET /api/automacao/historico` | `limite` de 1 a 50 (padrão 15), `pagina`, `data_inicio`, `data_fim`, `rotina` e `status`. | `{execucoes: [{id, rotina, origem, inicio, fim, status, codigo, mensagem, lotes, capturas: [{nome, url}]}]}`, mais recentes primeiro. | 422 limite fora da faixa. |
| `GET /api/automacao/capturas/{nome}` | Nome de um `.png` da pasta de logs (sem caminho). | Imagem PNG. | 404 nome inválido ou inexistente. |

- `log.linhas` traz até 64 KB por chamada e só linhas completas; `offset` é o próximo ponto de leitura. Se o arquivo mudou (outra execução) ou encolheu, `reiniciado: true` e a leitura recomeça do zero.
- Status no histórico: `em_andamento`, `concluido`, `falha`, `cancelado`, `ocupada` (código 2) e `interrompido` (o servidor foi reiniciado e o processo não existe mais).
- As rotas passam pelo `LocalRequestSafetyMiddleware` como todas as outras: conexão local direta, Host local, `Origin` igual ao Host quando presente e `Sec-Fetch-Site` `same-origin`/`none`. Não há exceção para elas.

## Tela

- Menu lateral › `Navegação` › aba `Automação` (`#tab-automacao`, painel `#tab-panel-automacao`), depois de `Resumo`. Mesmo comportamento das outras abas (setas, `Home`/`End`, `aria-selected`).
- Cartão **Rotinas**: botões `Rotina de OS`, `Inventários`, `Verificar usuários`, `Ambas`, `Abrir Chrome para login` e `Cancelar`. Com uma rotina em andamento, os cinco primeiros ficam desabilitados e só `Cancelar` fica ativo; livre, `Cancelar` fica desabilitado. Texto curto lembrando que os logins são feitos na janela do Chrome de automação e que a importação é pelas pastas locais.
- **Estado atual** (`role="status"`): `Livre` ou `Em andamento`, com rotina, horário de início e origem (`pelo site` ou `fora do site`). Durante o cancelamento: `Cancelamento pedido…`.
- **Aviso de login** (`#automacao-aviso-login`, `role="alert"`): visível só enquanto a rotina espera login: `Faça o login no Chrome de automação (<sistema>). A rotina continua sozinha depois do login.`
- **Andamento**: área de log monoespaçada (`role="log"`, `aria-live="polite"`) com as linhas novas a cada 1,5 s enquanto houver execução e a cada 5 s quando livre; rolagem automática só quando o usuário já está no fim. Até 500 linhas em memória, com 200 linhas visíveis por padrão (opções 100/200/500).
- **Últimas execuções**: tabela `Rotina | Início | Duração | Status | Lotes | Capturas` no desktop; no celular, cada execução vira um cartão com os mesmos dados. As capturas abrem em aba nova pelo link `/api/automacao/capturas/<nome>`.
- Erros da API aparecem em toast; o 409 mostra a mensagem do servidor.
- Temas claro e escuro pelos tokens existentes; no celular, botões em duas colunas, 16 px de margem e sem rolagem horizontal; animações respeitam `prefers-reduced-motion`.

## Critérios de aceite

1. Rotina fora da whitelist responde 422 e não inicia processo.
2. Com processo vivo ou trava com PID vivo, `executar` responde 409 com a mensagem clara.
3. O processo é iniciado com lista de argumentos, sem shell, com o Python da `.venv`, `PYTHONUTF8`/`PYTHONIOENCODING`, `CREATE_NO_WINDOW` e stdin nulo.
4. `estado` com `offset` devolve só as linhas novas; o aviso de login aparece com a linha `AÇÃO NECESSÁRIA` e some com `Login detectado`.
5. `cancelar` usa `--cancelar` quando o script o oferece; senão encerra só o processo filho.
6. Pedidos com `Origin` ou `Sec-Fetch-Site` de outro site recebem 403 nas rotas novas.
7. `npm run verify` e `npm run test:ui:e2e` passam; nenhuma rotina real de OS ou inventários é executada nos testes.

## Rotina `login` (Abrir Chrome para login)

Abre três abas no Chrome de automação e adianta tudo o que não é senha nem autenticador:

- **Endpoint Central** (`/client#/login`): preenche `gakihiro` só se o campo estiver vazio (`SIMPRESS_ENDPOINT_USUARIO` troca o usuário) e escolhe `pr-sebrae` na lista "Autenticação local". Clica em "Fazer login" apenas se a lista ficou confirmada **e** o Chrome já preencheu a senha; sem senha salva (primeiro acesso), para antes do clique e o usuário termina. O código do autenticador é sempre do usuário. A exportação do Endpoint (Inventários e Ambas) usa o mesmo preenchimento ao encontrar a tela de login.
- **UX Simpress** (`/ng/autenticacao/login`): clica em "Acesso Time Simpress" e na conta `gansouza@simpress.com.br`; se a conta não aparecer, digita só o e-mail e clica em Avançar.
- **Oracle** (`/AgentWeb/`): mesmo fluxo da UX.
- **Login compartilhado:** UX e Oracle usam a mesma conta Microsoft. Quando uma conclui, a outra aba é reaberta pelo endereço do sistema (nunca com recarregar, que quebra a tela da Microsoft com o erro AADSTS750054) para aproveitar a sessão.
- **Espera:** um único aviso `AÇÃO NECESSÁRIA: faça o login… (<abas pendentes>)`; termina com `Login detectado`. Tempo máximo de 10 min; uma aba fechada pelo usuário é ignorada.

## Aviso "New Hotfix Available" do Endpoint

O Endpoint Central mostra um aviso de atualização que cobre a tela e derruba cliques com `Locator.click: Timeout 30000ms exceeded` (visto na verificação de usuários). `endpoint_vigiar_avisos` registra um `add_locator_handler` do Playwright na aba do Endpoint: sempre que o aviso (`.server-update--notification`) bloqueia uma ação, a automação clica em "Do it Later" (ou, sem o botão, passa o mouse e clica no X) e a ação segue. Vale para Inventários, Ambas (`exportar_endpoint`) e `--rotina usuarios`.

## Janela pequena e downloads

Vale igual para o painel e para o `executar_automacao.bat`, porque os dois rodam o mesmo `scripts/automacao_rotinas_chrome.py`.

- **Janela pequena:** se a área da aba for menor que 1440×720 px (`TELA_MINIMA`), a rotina desenha a página nesse tamanho, sem redimensionar a janela. Assim os sites mantêm o layout de desktop (menus, saudação "Olá," e botões de exportação). O ajuste é desfeito enquanto a rotina espera o login, para o usuário ver a tela no tamanho real, e some quando a rotina termina, mesmo após erro. A sessão do UX conta como ativa quando a saudação existe na página, mesmo oculta.
- **Download vazio:** se outra conexão à porta 9333 trocar o destino dos downloads, o Chrome grava o arquivo direto na pasta dele e o Playwright recebe 0 bytes ou nenhum aviso. A rotina confere o arquivo (não vazio; XLSX/ZIP com assinatura de ZIP) e, nesses casos, usa a cópia gravada pelo Chrome a partir do clique, sem repetir a exportação. O arquivo vazio é apagado, e um arquivo inválido com conteúdo é renomeado para `.invalido`. A preparação dos lotes também ignora downloads de 0 bytes.
- **Testes:** `tests/test_automacao_telas_browser.py` roda as exportações reais do UX e do Endpoint contra uma bancada local, num Chrome iniciado como o de automação, em janelas pequenas, médias e grandes. `SIMPRESS_TESTE_TODAS_TELAS=1` roda as 15 resoluções (de 500×400 a 3840×2160, com escalas de 125%, 150% e 200%), e `SIMPRESS_TESTE_COM_JANELA=1` mostra o Chrome em vez do modo headless.

## Ajustes depois de integrar os branches da automação

- Conferir em `ScriptContract` os nomes reais da trava, do sinal, da pasta de logs, dos códigos `2`/`130` e das frases de login.
- Com o log do script em arquivo, a captura do stdout (`.site.log`) pode continuar (é a fonte das linhas ao vivo) ou ser trocada pela leitura do `.log` do script.

## Consulta compacta de logs e execuções

Últimas execuções mostra cinco linhas por página (opções 5/10/20), total e navegação. Filtros recolhíveis por período inclusivo, rotina e status preservam a consulta aplicada. Cada linha oferece Ver log. O Andamento permite escolher uma data e uma execução, mantendo o log histórico separado do polling ao vivo; Voltar ao vivo restaura a execução atual. Os dois painéis permitem recolher, ampliar a área útil e restaurar com Escape. A ampliação mantém os outros controles acessíveis pela navegação da página. Nenhum desses controles apaga registros.

Detalhes e análise de melhorias: [especificação](automacao-historico-especificacao.md). GET /api/automacao/historico agora inclui paginação e filtros; GET /api/automacao/execucoes/{execucao_id}/log consulta somente um log conhecido, com até 500 linhas e 64 KB. Arquivos removidos pela retenção já existente podem ficar indisponíveis; os resumos disponíveis continuam consultáveis.

## Verificar usuários (`--rotina usuarios`)

`scripts/verificar_usuarios_endpoint.py` confere, na grade "Todos os computadores" do Endpoint Central, cada pendência de usuário logado sem decisão. Também roda no fim de `Inventários` e `Ambas`; nesses casos uma falha dela vira `[AVISO]` e não desfaz a importação já confirmada.

- Pesquisa por série, série sem o `S` inicial (MacBook) e hostname, sempre com correspondência exata, e limpa cada filtro depois. O filtro é digitado tecla a tecla e só vale quando o campo mantém o valor e as linhas batem com ele (ou a grade vazia é confirmada); sem confirmação a rotina para com `[FALHA]` e nada é decidido.
- Abre o detalhe do computador e prioriza "Usuário do último logon" (o "Horário da última inicialização" colado ao nome é descartado). Sem um valor válido, usa a coluna "Usuários logados" da grade: uma única conta válida pode fundamentar a decisão; múltiplas contas válidas deixam a pendência aberta e anotada. A coluna pode trazer contas separadas por vírgula. Se não houver conta válida na grade, consulta Sistema > Usuários, onde a primeira linha válida vence. Ignoram-se vazios, `NA`, `Administrador`, `Convidado`, `DefaultAccount`, `WDAGUtilityAccount`, `root`, contas `CodexSandbox*`, `Default*` e UI Flow Service. Aba ou tabela que não carrega interrompe a rotina sem decidir, e a grade é restaurada mesmo com erro.
- Decisão (`usuario_ausente` / `substituicao_manual`): mesmo usuário → `manter` / `permitir`; outro usuário → decide (`remover` / `recusar`) e grava o novo usuário por `POST /api/equipamento/atualizar-usuario`; sem usuário válido após os três recursos ou computador não encontrado → `remover` / `recusar` com `[AVISO]`. Se a grade apresentar mais de um usuário válido, não decide e mantém a pendência aberta com anotação. A decisão sai por `POST /api/usuarios/pendencias/{id}/decidir` e a anotação da linha de "Mudanças de usuário logado" por `PUT /api/historico-comparacoes/{evento}/anotacoes/{id}` (servidor em `SIMPRESS_PORT`, padrão 8000).
- Pendência: o texto "Usuário do último logon" na aba aberta por padrão do detalhe e os seletores de Sistema > Usuários precisam ser confirmados no teste ao vivo.
