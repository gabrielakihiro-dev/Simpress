# Tela Automação (rotinas do Chrome pelo site)

## Consulta do Endpoint na Home

Na Home/F1, selecione um equipamento e clique em `Consultar no Endpoint`. Com o Chrome de automação aberto na porta 9333 e o login do Endpoint já feito pelo usuário, a aplicação abre uma aba própria, seleciona `Todos os computadores`, filtra a série e lê exatamente a coluna `Usuário do último logon`. A aba é fechada ao terminar, inclusive em falha; as outras abas permanecem abertas. A trava `data/state/automacao_chrome.lock` impede concorrência com as rotinas de exportação e com o agendamento. Chrome ocupado retorna 409; falta de login, conexão, coluna ou confirmação de todas as linhas retorna 503. Não inicia Chrome nem preenche senha.

Um resultado único mostra o usuário do último logon; se a célula estiver vazia, informa que o equipamento foi encontrado sem usuário informado. Ausência mostra exatamente `Equipamento não encontrado no Endpoint`; duplicidade mostra aviso específico, sem escolher um equipamento. A série exata tem prioridade; somente um MacBook identificado na base permite tentar a série sem o `S` inicial. A consulta não usa hostname como alternativa nem troca a coluna por `Usuários logados`. Se o total filtrado não puder ser confirmado ou houver linhas fora da área renderizada, a leitura é recusada para não esconder duplicatas.

Mudar a seleção apaga o resultado e invalida a resposta anterior. Nada é salvo no cadastro, em planilhas, pendências ou históricos e nada é escrito no Endpoint; apenas a trava transitória é criada/removida. O Assistente consulta a mesma rota com `consultar_endpoint`, ferramenta somente leitura; o campo `ultimo_logon` vai ao modelo como marcador de pessoa, e o texto exibido ao usuário restaura o valor. A validação real depende de Chrome/login e da configuração de colunas da instalação local; testes com fixture não comprovam esse acesso real.

O fallback MacBook também precisa ser único na base local: por exemplo, se existem `SABC` e outro equipamento `ABC`, a consulta não associa o usuário de `ABC` a `SABC`. Duplicidade da série selecionada na base também bloqueia esse fallback. A regra compartilhada `mac_endpoint_serial_key` exige ainda que a linha ao vivo tenha hostname `PRMAC` único. As recusas informam ambiguidade na base local ou correspondência Mac não confirmada, sem afirmar duplicidade do Endpoint. Entre a pesquisa exata e a sem `S`, a aplicação limpa o filtro e espera a grade cheia confirmada; uma tela vazia remanescente da primeira consulta não prova ausência na segunda.

Somente `POST /api/endpoint/consultar` dispõe de até 480 s no transporte interno do Assistente, cobrindo as esperas encadeadas de navegação, grade e filtros. O tempo dessa consulta não consome os 90 s do orçamento de resposta do modelo; todas as demais chamadas internas mantêm 30 s. O Chrome ocupado continua retornando 409 de imediato.

O Assistente faz no máximo uma consulta Endpoint por mensagem; para outra série, envie outra mensagem. A tela aguarda até 600 s para essa consulta e a resposta final do modelo, mantendo o botão `Cancelar`. Cancelar ou atingir o prazo restaura o texto digitado, e o servidor pode ainda estar concluindo a leitura. A duplicidade local é preservada em `serie_detalhes_duplicada`, calculado pela contagem das linhas da base oficial no carregamento e mantido no refresh/importação, inclusive quando o arquivo InvAll estiver indisponível. Assim, uma chave única no cache não oculta duas linhas da planilha com a mesma série.

Os fatos do equipamento e das possíveis colisões são capturados juntos sob a trava de memória `STATE_LOCK`. Se o usuário for encontrado retirando o `S` do MacBook, a rota confere de novo esses fatos antes de responder. Por exemplo, se uma importação tornar `SABC` duplicada enquanto o Chrome consulta `ABC`, o usuário lido é descartado e a tela informa ambiguidade na base local. A conferência compara apenas tipo/modelo/categoria, presença, duplicidade e chaves equivalentes da série, preservando consultas quando dados não relacionados mudam.

Objetivo: executar pelo site local as rotinas de `scripts/automacao_rotinas_chrome.py` (as mesmas do `executar_automacao.bat`), acompanhar o andamento ao vivo e consultar as últimas execuções, sem abrir o terminal.

O site **só inicia** o script. As exportações continuam sendo feitas no Chrome de automação (perfil próprio, porta CDP 9333) e os arquivos continuam sendo importados pelas pastas locais `data/state/entrada_chamados` e `data/state/entrada_automatica`, nunca por upload ou HTTP (regra do `AGENTS.md`).

Rotina `sebrae` (Chamados novos Sebrae: lê o SoftExpert e grava `data/state/sebrae_novos.json`; sem agendamento na tela): [especificação](sincronizar-chamados-sebrae.md). Ela usa este mesmo contrato, a mesma trava e o mesmo histórico.

Rotina `dashboard` (botão `Baixar, importar e buscar`): no Chrome de automação (porta 9333, login do SharePoint manual) abre a pasta `DASHBOARD SEBRAE`, clica nos três pontos (`Mais ações`/`More actions`) da linha `Dashboard Operacional_SEBRAE.xlsx` e em `Baixar`/`Download` (só leitura; vai para Downloads; `.zip` é recusado), importa o `.xlsx` baixado no site local (`POST /api/sebrae/dashboard`, porta `SIMPRESS_PORT`) e em seguida roda a rotina `sebrae`. Os rótulos reais do menu precisam ser confirmados no ensaio supervisionado.

Rotina `enviar` (botão `Enviar ao SharePoint`, ao lado de `Atualizar Dashboard`): abre a pasta `DASHBOARD SEBRAE` do SharePoint no Chrome de automação (porta 9333; só o e-mail é digitado, senha e MFA são do usuário) e, nesta ordem: faz `Mais ações › Duplicata` do `Dashboard Operacional_SEBRAE.xlsx` e espera a cópia aparecer (sem ela, não sobrepõe); baixa o arquivo atual e confere com o Dashboard importado (mudou: aborta e pede nova importação); guarda o baixado em `data/state/sebrae_backups/` (20 mais recentes); sobe `data/state/sebrae_dashboard_saida/Dashboard Operacional_SEBRAE.xlsx` por `Create or upload › Files upload` (ou `Upload › Files`) e escolhe `Replace`/`Substituir` (só `Keep both`: recusa; arquivo em uso: erro claro); confirma só pelo aviso de envio concluído (o texto da linha muda sozinho com a data relativa e não prova o envio; sem o aviso em 90 s, erro). Falha se o site ainda não gerou o arquivo (`Atualizar Dashboard`). Depois do envio o site guarda a cópia enviada (`data/state/sebrae_dashboard_enviado.xlsx`) e, no envio seguinte, confere o SharePoint por valores contra ela (o SharePoint reserializa o xlsx). Na rotina `fechar`, o checkbox `Enviar Detalhes por e-mail ao solicitante` é lido pela classe do `<span>` irmão e marcado com um único clique, conferido depois; a coluna R é gravada na cópia sem o limite de linhas de `validate_xlsx_archive`.

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
- **SoftExpert** (SSO): ao cair na tela "Entrar" da Microsoft com o campo de e-mail vazio, digita `gakihiro@pr.sebrae.com.br`, clica em Avançar e espera o login manual. O campo é achado por `CAMPO_EMAIL_MICROSOFT` (e-mail, `loginfmt`, `login`, texto genérico), para não depender do tipo do input. Se, após 10 s, a tela não for reconhecida, o log registra uma vez `Tela da Microsoft não reconhecida (campos visíveis: …)` e a rotina segue aguardando você.
- **Lista do SoftExpert:** logo após o login a lista aparece antes das linhas. `listar_chamados` espera até 20 s (`ESPERA_PRIMEIRAS_LINHAS_MS`) por uma linha com número de chamado, para não tratar "0 chamados" como sucesso.
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

## Agendamento do Dashboard (03/11/2026)

No cartão do Dashboard, `Repetir a cada 30 minutos` ativa ou pausa a rotina existente `Baixar, importar e buscar`. Começa pausado; ativar não executa imediatamente. A primeira tentativa ocorre em 30 minutos e o servidor consulta o relógio a cada 20 segundos. Não há restrição de dia ou horário. Computador e servidor precisam ficar ligados; fechar a página não pausa o agendamento. Pausar impede futuras tentativas, mas uma execução em andamento continua até concluir ou usar Cancelar execução.

Correção de 03/11/2026: o worker `_sebrae_scheduler_worker` (que também ticka o agendador do Dashboard) existia em `main.py`, mas não era iniciado no `lifespan`; por isso o `Repetir a cada 30 minutos` nunca disparava. Agora ele é iniciado com o servidor (teste `test_lifespan_starts_the_schedulers_worker`). Teste real em 03/11/2026: com `proxima_execucao` ajustada, o agendador disparou sozinho (`ultimo_disparo: iniciada`), a rotina `dashboard` baixou do SharePoint, importou 64 chamados, leu 9 novos no SoftExpert e o próximo horário foi rearmado em +30 min. Ao editar `dashboard_agendamento.json` à mão, grave em UTF-8 **sem BOM** (com BOM o servidor lê como vazio e o agendador volta a `ativo: false`).

O estado fica em `data/state/dashboard_agendamento.json`, fora do Git. Reiniciar o servidor preserva o controle e o próximo horário. Tentativas atrasadas em mais de um minuto são puladas; não há fila de horários perdidos. Se já houver uma automação, a tentativa é registrada como ocupada. Falhas aguardam o próximo intervalo. O mesmo runner mantém as travas e os limites de login: senha e MFA são do usuário. A rotina somente baixa e importa a base local e busca chamados; não envia ao SharePoint nem finaliza chamados.

Os campos manuais ficam no navegador em registros independentes, um por edição, sem substituir o rascunho inteiro de outra aba. A UTIC mantém a identidade entre importações e entre chamado novo e antigo. Campos já preenchidos divergentes no arquivo não são substituídos pelo rascunho; a tela mostra o conflito e mantém os registros originais. Chamados sem correspondência ficam preservados com aviso; linhas sem UTIC só são reaplicadas à mesma importação. Armazenamento cheio ou indisponível gera aviso para manter a aba aberta e copiar as edições. Descartar rascunho continua sendo uma ação manual confirmada e remove os registros locais.

Se outra aba editar o rascunho, a tela avisa e impede Atualizar Dashboard até recarregar para conferir. A edição mais recente de um mesmo campo é a exibida após a recarga; as versões anteriores permanecem no navegador até Descartar rascunho. O histórico de campos pode ocupar espaço local com o tempo; a aplicação avisa quando não consegue salvar.

O assistente tem `consultar_agendamento_dashboard` (só leitura) e `definir_agendamento_dashboard` (ativar/pausar, com cartão). O cartão informa intervalo, escrita local, login manual e ausência de envio/finalização. Não é usado o agendamento legado de sincronização `sebrae`, que continua bloqueado até o ensaio controlado previsto na especificação.

Atualização de segurança do agendamento (03/11/2026): cada importação recebe uma versão única (`importado.versao`). `POST /api/sebrae/dashboard/atualizar` e `POST /api/sebrae/finalizar-softexpert` exigem `versao_importacao` correspondente à tela/cartão confirmado; versão ausente ou antiga retorna 409 sem gerar saída nem disparar finalização. Uma trava de arquivo compartilhada entre processos cobre a conferência, gravação e disparo, e também protege a importação. Reimportar durante finalização pendente ou em andamento é recusado. O assistente conserva no cartão a versão consultada e a revalida ao confirmar. Status D divergente de outra importação também vira conflito explícito; alterações de D feitas na mesma versão continuam permitidas. A configuração oficial inicia um processo Uvicorn; o agendador usa trava de arquivo para impedir disparo duplicado mesmo entre instâncias.

Preservação da saída pendente (03/11/2026): `POST /api/sebrae/dashboard?automatico=true` é usado pela rotina `dashboard`; recusa a importação com 409 quando a cópia gerada difere do último arquivo confirmado enviado. O agendador também pula a tentativa antes de abrir o Chrome e informa `pulado: saída pendente`, com causa visível na tela. O resumo do agendamento inclui `bloqueio`. A ausência de saída ou uma saída idêntica à confirmada enviada permite prosseguir. Na importação manual (`automatico=false`, padrão), a cópia anterior é movida integralmente para `data/state/sebrae_dashboard_saida/preservados/<UUID>.xlsx`, fora do Git, e a resposta inclui `saida_anterior_preservada`; a tela informa a preservação. Nenhuma cópia é apagada pela reimportação. Importar, gerar saída e enviar o Dashboard compartilham `sebrae_dashboard_base.guard`, uma trava de arquivo entre processos; o envio a conserva até registrar os bytes enviados. Rascunhos de UTIC que passa de antigo para novo também são reaplicados; campos divergentes entre os dois grupos geram aviso e permanecem preservados sem escolha silenciosa.
