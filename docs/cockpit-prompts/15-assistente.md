# 15 — Painel Assistente (Jarvis leve)

Painel de conversa com o Jarvis leve local, aberto como as demais ferramentas do Cockpit.

## Acesso

- Botão `Assistente` (`#btn-assistente`, `ck-aba--painel`, ícone `#i-bot`) na barra superior, ao lado de `Chamados`; abaixo de 1200px, item `Assistente` no menu Ferramentas (`#btn-assistente-menu`).
- Atalho `F9`.
- Usa o painel de ferramentas do Cockpit (`data-cockpit-tool-panel="assistente"`): mesma área de trabalho, Esc fecha e o foco volta ao botão; em telas estreitas ocupa a tela toda.

## Contrato (`routers/assistant.py`)

- `GET /api/assistente/estado` → `{online, modelo, aguardando_confirmacao}`.
- `POST /api/assistente/mensagem` `{texto}` (até 4000 caracteres) → `{texto, ferramentas, pendente: {descricao} | null}`.
- `POST /api/assistente/confirmar` `{confirmado}` → mesmo formato.
- `POST /api/assistente/limpar` → `{ok: true}`.
- Erros trazem `{detail}`; 503 indica Jarvis leve desligado. Respostas podem levar até ~90 s.

## Comportamento

- Ao abrir, consulta o estado. Desligado: mostra exatamente `Assistente desligado. Abra iniciar_jarvis_leve.bat na pasta do Jarvis.`, bloqueia a entrada e oferece `Tentar novamente`.
- Balões do usuário (à direita, cor de destaque) e do Assistente (à esquerda, superfície); linha discreta `Ferramentas: …` quando houver.
- Campo `Mensagem` com contador `N / 4000`; Enter envia, Shift+Enter quebra a linha. Durante a resposta, status `Pensando…` e entrada bloqueada.
- Ação pendente: cartão de alerta com a descrição e os botões `Confirmar e executar` e `Cancelar`; o foco vai para o cartão, Esc cancela (sem fechar o painel) e a entrada fica bloqueada até a resposta.
- `Nova conversa` limpa a conversa no Jarvis e na tela.
- Respostas novas são anunciadas por uma região `aria-live="polite"` separada.

## Segurança

Todo texto do usuário e do Assistente entra por `textContent` (nunca `innerHTML`), com `white-space: pre-wrap`.
