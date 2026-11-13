# Plano: Lembretes com data agendada (13/11/2026)

Referência visual: Claude Design https://claude.ai/artifact/WP3qFuXR22iGdEsG74pk8Q (pranchetas "Vista Hoje", "Vista Em breve", "Agendar ao criar e editar"), aprovada pelo usuário em 13/11/2026.
Base: branch `claude/lembretes-data-agendada`, criada de `claude/gifted-bell-48751a` (PR #218, visual estilo Todoist). O PR depende do #218.
Fora do escopo: subtarefas, projetos, etiquetas, recorrência, calendário externo, Assistente (as ferramentas `*_lembrete` do Assistente usam outro arquivo, `NotasStore`, e não leem `data/state/lembretes.json`).

## Contrato entre arquivos

- Item ganha dois campos opcionais: `data_agendada` (`"AAAA-MM-DD"` ou `null`) e `hora_agendada` (`"HH:MM"` ou `null`). Hora só existe com data. Hora local de America/Sao_Paulo, sem fuso no texto.
- Arquivo continua `{"version": 1, ...}`; item antigo sem os campos é lido como `null` (compatível).
- `POST /api/lembretes` aceita `data_agendada` e `hora_agendada` opcionais.
- `PATCH /api/lembretes/{id}` aceita os dois; `data_agendada: null` remove a data e a hora. Mudar a data não altera `alterado_em` (que continua sendo só da descrição).
- `POST /api/lembretes/reagendar-atrasados`: numa transação, todo pendente com `data_agendada` anterior a hoje (America/Sao_Paulo) passa para hoje, mantendo a hora. Resposta `{"lembretes": [...lista completa], "reagendados": n}`.
- Erros 422 novos: `data_invalida` (formato ou data inexistente, ex. `2026-02-30`), `hora_invalida` (formato ou hora sem data).
- Front: função pura `agruparLembretes(pendentes, hoje)` (exportada para teste) devolve `{atrasados, porDia: Map<"AAAA-MM-DD", itens>, semData}`; `hojeEm(fuso, instante)` devolve `"AAAA-MM-DD"` em America/Sao_Paulo via `Intl.DateTimeFormat`.

## Decisões (após segunda opinião e advisor, 13/11/2026)

Backend:
- Formato estrito: `data_agendada` casa `^\d{4}-\d{2}-\d{2}$` e é data real (`date.fromisoformat`); `hora_agendada` casa `^([01]\d|2[0-3]):[0-5]\d$`. `20261113`, `2026-W46-5`, `09:00:30`, `0900` dão 422. Valor que não é texto cai no 422 do pydantic (sem `codigo`), como `origem` hoje.
- A regra "hora só com data" vale para o estado final, dentro da transação:
  - PATCH `{hora_agendada:"10:00"}` em item com data: OK.
  - `{hora_agendada:"10:00"}` em item sem data: 422 `hora_invalida`.
  - `{data_agendada:null}`: limpa data e hora.
  - `{data_agendada:null, hora_agendada:"10:00"}`: 422.
  - `{hora_agendada:null}`: limpa só a hora.
  - Trocar só a data mantém a hora.
- POST aceita data passada (necessário para o e2e criar atrasado).
- `CAMPOS` e `_item_valido` incluem os dois campos; `_item_valido` confere só o tipo (`str | None`), nunca o formato. Assim um item editado à mão não torna o arquivo inteiro ilegível; o front trata data fora do formato como sem data.
- Reagendar: atrasado = pendente com `data_agendada < hoje` (America/Sao_Paulo, `FUSO` de `domains/sebrae_observacoes.py`), "hoje" injetável no construtor. Mantém a hora. Sem atrasados, não grava o arquivo (nem o cria). Sem confirmação, como no Todoist.
- Rollback: o código antigo (mesma `version: 1`) descarta os campos novos na próxima gravação. Registrado na spec.

Front:
- Datas `AAAA-MM-DD` são calculadas como texto e com `Date.UTC(a, m-1, d)`/`getUTCDay()`, nunca com `new Date("AAAA-MM-DD")` local nem `toISOString`. Rótulos com `Intl` em `timeZone: "UTC"`. Só `hojeEm(instanteMs)` usa `America/Sao_Paulo`. "Hoje" é recalculado a cada `renderizar()`.
- DOM: `#lembretes-lista` vira `div` (mesmo ID); cada grupo é `section.lembretes__grupo` com `h3` e `ul.lembretes__itens` contendo `li.lembretes__item[data-lembrete-id]`. Índice/foco após exclusão usa `querySelectorAll("[data-lembrete-id]")`. A data agendada usa `span.lembretes__agenda` (não `<time>`), para não colidir com o `<time>` de `Criado em`.
- Ordem: Atrasada por data e hora crescentes; dentro de um dia, com hora crescente, depois sem hora; empates e `Sem data` pela regra atual (mais recente no topo).
- Contadores: `#lembretes-pendentes` continua igual ao total de pendentes; a pílula `Hoje <n>` conta atrasados + hoje.
- Em breve: semana domingo–sábado; `Semana anterior` desabilitado na semana atual (nunca mostra semana passada). Na semana atual: `Atrasada`, depois cada dia de hoje até sábado; nas próximas semanas, os 7 dias. Dias sem item aparecem com `+ Adicionar lembrete`. `Sem data` no fim. Clique num dia da faixa leva o foco ao grupo daquele dia.
- Rótulo: `13 nov`; com ano diferente do atual, `13 nov 2027`. Hoje e amanhã: `Hoje`, `Amanhã` (com ` · HH:MM` se houver hora).
- `Próxima segunda` numa segunda = +7 dias.
- Edição: compara descrição, data e hora; envia só o que mudou; nada mudou, nenhum PATCH. O rascunho preservado no `renderizar()` guarda também data e hora.
- Item criado para dia fora da vista atual: toast `Lembrete agendado para <rótulo>.`

Fixture: `tests/support/serve_ui_motion_preview.py` passa a repassar `POST /api/lembretes/reagendar-atrasados`. O e2e monta ontem/amanhã a partir de hoje em America/Sao_Paulo e não usa `page.clock`.

Textos novos copiados do design aprovado em 13/11/2026: `Hoje`, `Em breve`, `Atrasada`, `Reagendar para hoje`, `Sem data`, `Adicionar lembrete`, `Data`, `Data agendada`, `Hoje`, `Amanhã`, `Próxima segunda`, `Hora (opcional)`, `Remover data`, `Semana anterior`, `Próxima semana`, cabeçalho `12 nov · Hoje · quinta-feira`.

## Passo 1: especificação e contrato

- Objetivo: documentar antes de codar.
- Arquivos: `docs/cockpit-prompts/18-lembretes.md` (seção "Data agendada", vistas, grupos, textos, dado gravado com a data 13/11/2026), `docs/arquitetura/CONTRATOS_API_BACKEND.md` (campos e rota nova).
- Critérios de aceite: textos visíveis definidos (abaixo); rota e códigos no doc de contratos.
- Verificar: `python -m pytest tests/test_api_contract_doc.py -q`.

## Passo 2: backend

- Objetivo: gravar, validar e reagendar.
- Arquivos: `domains/lembretes.py`, `routers/lembretes.py`, `tests/test_lembretes.py`.
- Critérios de aceite: data/hora inválidas dão 422 com código; hora sem data dá 422; arquivo antigo sem os campos lê com `null`; PATCH com `data_agendada: null` limpa os dois; reagendar move só pendentes atrasados (concluídos e futuros intactos) usando "hoje" injetável; descrição nunca vai a log.
- Verificar: `python -m pytest tests/test_lembretes.py -q`.
- Proibidos: `domains/assistant_*`, `data/`.

## Passo 3: front

- Objetivo: vistas Hoje e Em breve, grupos, seletor de data, Reagendar.
- Arquivos: `frontend/partials/cockpit-tool-panels.html` (bloco `#termos-painel-lembretes`), `static/js/features/lembretes.js`, `static/styles/ck-lembretes.css`, `tests/frontend/test_lembretes.cjs`.
- Critérios de aceite:
  - Pílulas `Hoje <n>` e `Em breve` (`role="tab"`); Hoje = `Atrasada`, `<d mmm> · Hoje · <dia da semana>`, `Sem data`; Em breve = navegação `‹ Hoje ›` (`Semana anterior`, `Próxima semana`), mês e ano, faixa de 7 dias (domingo a sábado, hoje com `aria-current="date"`), `Atrasada` (só na semana atual), um grupo por dia de hoje em diante, `Sem data`.
  - Grupo `Atrasada` com botão `Reagendar para hoje`; data atrasada em cor de erro.
  - `+ Adicionar lembrete` em cada dia: preenche a data do formulário com aquele dia e põe o foco na descrição.
  - Formulário: botão `Data` abre o painel `Data agendada` com atalhos `Hoje`, `Amanhã`, `Próxima segunda`, campos nativos `Data` e `Hora (opcional)` e `Remover data`; o botão mostra a data escolhida (ex.: `Amanhã · 09:00`).
  - Edição inline com `Data`, `Hora (opcional)`, `Remover data`, mantendo `Enter salva · Esc cancela`.
  - Item mostra a data agendada (`Hoje · 14:00`, `10 nov · 17:00`) e a meta `Criado em`/`Alterado em` já existente.
  - IDs, ARIA e `data-*` existentes preservados; `#lembretes-lista` continua sendo o contêiner dos pendentes; `Concluídos (n)` igual; temas claro e escuro só com tokens; 320–2560 px sem rolagem horizontal; animações 150–300 ms com `prefers-reduced-motion`.
- Verificar: `node --test tests/frontend/test_lembretes.cjs` (agrupamento na virada do dia em UTC-3, atrasado, sem data, semana) e `npm run verify`.
- Proibidos: `.mcp.json`, `static/**/*.md`.

## Passo 4: e2e e teste real

- Objetivo: provar no navegador.
- Arquivos: `tests/e2e/lembretes.spec.cjs`.
- Critérios de aceite: criar com data de amanhã aparece em Em breve; reagendar move atrasado para Hoje; remover data leva a Sem data; tema escuro e 320 px sem rolagem horizontal.
- Verificar: `npm run test:ui:e2e` (fixture 8765) e teste no app local pelo navegador embutido, apagando os lembretes de teste ao final.
