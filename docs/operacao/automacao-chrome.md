# Tela Automação (rotinas do Chrome pelo site)

Objetivo: executar pelo site local as rotinas de `scripts/automacao_rotinas_chrome.py` (as mesmas do `executar_automacao.bat`), acompanhar o andamento ao vivo e consultar as últimas execuções, sem abrir o terminal.

O site **só inicia** o script. As exportações continuam sendo feitas no Chrome de automação (perfil próprio, porta CDP 9333) e os arquivos continuam sendo importados pelas pastas locais `data/state/entrada_chamados` e `data/state/entrada_automatica`, nunca por upload ou HTTP (regra do `AGENTS.md`).

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
| `GET /api/automacao/historico?limite=N` | `limite` de 1 a 50 (padrão 15). | `{execucoes: [{id, rotina, origem, inicio, fim, status, codigo, mensagem, lotes, capturas: [{nome, url}]}]}`, mais recentes primeiro. | 422 limite fora da faixa. |
| `GET /api/automacao/capturas/{nome}` | Nome de um `.png` da pasta de logs (sem caminho). | Imagem PNG. | 404 nome inválido ou inexistente. |

- `log.linhas` traz até 64 KB por chamada e só linhas completas; `offset` é o próximo ponto de leitura. Se o arquivo mudou (outra execução) ou encolheu, `reiniciado: true` e a leitura recomeça do zero.
- Status no histórico: `em_andamento`, `concluido`, `falha`, `cancelado`, `ocupada` (código 2) e `interrompido` (o servidor foi reiniciado e o processo não existe mais).
- As rotas passam pelo `LocalRequestSafetyMiddleware` como todas as outras: conexão local direta, Host local, `Origin` igual ao Host quando presente e `Sec-Fetch-Site` `same-origin`/`none`. Não há exceção para elas.

## Tela

- Menu lateral › `Navegação` › aba `Automação` (`#tab-automacao`, painel `#tab-panel-automacao`), depois de `Resumo`. Mesmo comportamento das outras abas (setas, `Home`/`End`, `aria-selected`).
- Cartão **Rotinas**: botões `Rotina de OS`, `Inventários`, `Ambas`, `Abrir Chrome para login` e `Cancelar`. Com uma rotina em andamento, os quatro primeiros ficam desabilitados e só `Cancelar` fica ativo; livre, `Cancelar` fica desabilitado. Texto curto lembrando que os logins são feitos na janela do Chrome de automação e que a importação é pelas pastas locais.
- **Estado atual** (`role="status"`): `Livre` ou `Em andamento`, com rotina, horário de início e origem (`pelo site` ou `fora do site`). Durante o cancelamento: `Cancelamento pedido…`.
- **Aviso de login** (`#automacao-aviso-login`, `role="alert"`): visível só enquanto a rotina espera login: `Faça o login no Chrome de automação (<sistema>). A rotina continua sozinha depois do login.`
- **Andamento**: área de log monoespaçada (`role="log"`, `aria-live="polite"`) com as linhas novas a cada 1,5 s enquanto houver execução e a cada 5 s quando livre; rolagem automática só quando o usuário já está no fim. Até 2.000 linhas na tela.
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

## Ajustes depois de integrar os branches da automação

- Conferir em `ScriptContract` os nomes reais da trava, do sinal, da pasta de logs, dos códigos `2`/`130` e das frases de login.
- Com o log do script em arquivo, a captura do stdout (`.site.log`) pode continuar (é a fonte das linhas ao vivo) ou ser trocada pela leitura do `.log` do script.
