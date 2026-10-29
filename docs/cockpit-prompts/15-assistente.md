# 15 — Painel Assistente

Painel de conversa com a IA do Simpress (OpenRouter, chamado pelo servidor local), aberto como as demais ferramentas do Cockpit.

## Acesso

- Botão `Assistente` (`#btn-assistente`, `ck-aba--painel`, ícone `#i-bot`) na barra superior, ao lado de `Chamados`; abaixo de 1200px, item `Assistente` no menu Ferramentas (`#btn-assistente-menu`).
- Atalho `F9`.
- Usa o painel de ferramentas do Cockpit (`data-cockpit-tool-panel="assistente"`): mesma área de trabalho, Esc fecha e o foco volta ao botão; em telas estreitas ocupa a tela toda.

## Contrato (`routers/assistant.py`)

- `GET /api/assistente/estado` → `{online, modelo, aguardando_confirmacao, pendente}`.
- `POST /api/assistente/mensagem` `{texto}` (até 4000 caracteres) → `{texto, ferramentas, pendente: {descricao} | null}`.
- `POST /api/assistente/confirmar` `{confirmado}` → mesmo formato.
- `POST /api/assistente/limpar` → `{ok: true}`.
- `POST /api/assistente/audio` corpo WAV bruto (`Content-Type: audio/wav`, até 5 MB) → `{texto}` com a transcrição. O botão `Gravar áudio` (ao lado de `Enviar`) grava até 120 s, converte para WAV mono de 16 kHz e coloca o texto na caixa de mensagem para revisão; não envia nada sozinho. Esc cancela a gravação. 413 áudio grande, 415 não é WAV, 502 falha do OpenRouter.
- Erros trazem `{detail}`; 503 indica chave do OpenRouter ausente (`OPENROUTER_API_KEY` no `.env`); 409, resposta anterior ainda em andamento. Respostas podem levar até ~1 min.

## Comportamento

- Ao abrir, consulta o estado. Desligado: mostra exatamente `Assistente desligado. Preencha OPENROUTER_API_KEY no arquivo .env da pasta do Simpress.`, bloqueia a entrada e oferece `Tentar novamente`.
- Balões do usuário (à direita, cor de destaque) e do Assistente (à esquerda, superfície); linha discreta `Ferramentas: …` quando houver.
- Campo `Mensagem` com contador `N / 4000`; Enter envia, Shift+Enter quebra a linha. Durante a resposta, status `Pensando…` e entrada bloqueada.
- Ação pendente: cartão de alerta com a descrição e os botões `Confirmar e executar` e `Cancelar`; o foco vai para o cartão, Esc cancela (sem fechar o painel) e a entrada fica bloqueada até a resposta.
- `Nova conversa` limpa a conversa no servidor e na tela.
- Respostas novas são anunciadas por uma região `aria-live="polite"` separada.
- Globo animado na barra (`#assistente-globo`, `data-estado`: `parado`, `ouvindo`, `pensando`, `falando`; parado com movimento reduzido). Botão `Voz` (`aria-pressed`, desligado por padrão, preferência em `localStorage`) lê as respostas com a voz local em português do computador; sem voz local avisa e não fala. A fala para ao enviar, gravar, `Nova conversa` ou fechar o painel (com movimento reduzido a fala segue até o fim).

## Segurança

Todo texto do usuário e do Assistente entra por `textContent` (nunca `innerHTML`), com `white-space: pre-wrap`.
