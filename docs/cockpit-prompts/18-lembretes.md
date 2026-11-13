# Lembretes (Ferramentas)

Especificação da ferramenta **Lembretes**, que substitui a ferramenta **Termos**. Os termos de entrega e devolução continuam existindo, agora como sub-abas dentro de Lembretes.

Referência visual aprovada (11/11/2026): canvas https://claude.ai/artifact/14zj369oGQoYmw5inWncGh, artboards "Lembretes — 5 estados" e "Termo → Lembrete".

Visual da aba Lembretes (12/11/2026): modelo estilo Todoist, artefato https://claude.ai/code/artifact/008ece32-67be-464b-bb80-7566cbb2e4b2 (artboard `Main.dc.html`). Só a camada visual mudou; textos, IDs, ARIA e regras seguem os desta especificação.

## Estrutura

- Painel `section[data-cockpit-tool-panel="lembretes"]`, aberto pelo botão `#btn-lembretes` no menu Ferramentas. Sem atalho de teclado (Termos também não tinha).
- Sub-abas (pílulas, `role="tab"`), nesta ordem: `Termo Entrega`, `Termo Devolução` e `Lembretes <n pendentes>`. O painel abre em `Lembretes`.
- `Termo Entrega` e `Termo Devolução` são os formulários de `17-termos.md`, movidos sem mudança: IDs, campos, `Gerar PDF`, `Limpar`, nome do PDF `<Série> - <Nome>` e o preenchimento automático da Home (`app.termosPreencherDoEquipamento(eq)`).
- A ferramenta **Termos** (`#btn-termos`, painel `termos`) foi removida em 12/11/2026 (Bloco 4 da migração): o menu Ferramentas só tem `#btn-lembretes`.

## Lista de lembretes

- Item: um campo de texto, `Descrição`, mais a data agendada opcional (seção "Data agendada (13/11/2026)"). Tamanho máximo da descrição: 2000 caracteres; não pode ser vazia nem conter caractere de controle.
- Uma data por item: `Criado em dd/mm/aaaa hh:mm`. Depois de editar a descrição, passa a ser `Alterado em dd/mm/aaaa hh:mm`. Editar sem mudar o texto não altera a data.
- Ordem: dentro de cada grupo, pela regra da seção "Data agendada (13/11/2026)" abaixo; empates e lembretes sem data agendada: o mais recente no topo, pela data exibida (`Criado em` ou `Alterado em`).
- Topo: campo com placeholder `O que você precisa fazer?` e botão `Adicionar`. Enter adiciona. Com o campo vazio, o botão fica desabilitado e Enter não faz nada.
- Cada item tem: círculo de concluir (`aria-label` `Concluir: <descrição>` / `Desmarcar: <descrição>`), descrição, data, `Editar lembrete` e `Excluir lembrete`.
- Edição inline: Enter salva e Esc cancela. Dica: `Enter salva · Esc cancela`. Botões `Cancelar` e `Salvar`. Rótulo oculto: `Editar descrição`.
- Concluídos vão para a seção recolhível `Concluídos (n)` (`aria-expanded`).
- Excluir pede confirmação em `role="alertdialog"`: título `Excluir este lembrete?`, a descrição do item, `Esta ação não pode ser desfeita.`, botões `Cancelar` e `Excluir`. Esc cancela.
- Estado vazio: `Nenhum lembrete. Anote o que precisa fazer.`

## Data agendada (13/11/2026)

Referência visual aprovada em 13/11/2026: Claude Design https://claude.ai/artifact/WP3qFuXR22iGdEsG74pk8Q (pranchetas "Vista Hoje", "Vista Em breve" e "Agendar ao criar e editar"). Plano: `docs/desenvolvimento/plano-lembretes-data-agendada.md`. Fora do escopo: subtarefas, projetos, etiquetas, recorrência, calendário externo e Assistente (as ferramentas `*_lembrete` do Assistente usam `NotasStore`, outro arquivo, e não leem `data/state/lembretes.json`).

### Campos e validação

- Dois campos opcionais por lembrete: `data_agendada` (`AAAA-MM-DD` ou `null`) e `hora_agendada` (`HH:MM` ou `null`). Hora local de America/Sao_Paulo, sem fuso no texto.
- A hora só existe com data. A regra vale para o estado final do item, dentro da transação do PATCH: `{hora_agendada:"10:00"}` em item com data é aceito; em item sem data, 422 `hora_invalida`; `{data_agendada:null}` limpa data e hora; `{data_agendada:null, hora_agendada:"10:00"}` dá 422; `{hora_agendada:null}` limpa só a hora; trocar só a data mantém a hora.
- Formato estrito: data casa `^\d{4}-\d{2}-\d{2}$` (dígitos ASCII) e precisa existir no calendário (`2026-02-30`, `20261113` e `2026-W46-5` dão 422 `data_invalida`); hora casa `HH:MM` de `00:00` a `23:59` (`09:00:30`, `0900` e `24:00` dão 422 `hora_invalida`). Valor que não é texto cai no 422 do corpo, sem `codigo`.
- O POST aceita data passada (o e2e precisa criar um lembrete atrasado).
- Mudar data ou hora não altera `alterado_em`, que continua sendo só da descrição. Editar sem mudar nada não envia PATCH.
- Ao ler o arquivo, só o tipo (`texto` ou `null`) é conferido, nunca o formato: um item editado à mão não torna o arquivo inteiro ilegível, e o front trata data fora do formato como sem data. Item antigo, sem os campos, é lido com `null` nos dois.

### Vistas

- Pílulas `Hoje <n>` e `Em breve` (`role="tab"`) ao lado do campo de adicionar. O contador `Hoje <n>` conta atrasados mais os de hoje; `Lembretes <n pendentes>` e `#lembretes-pendentes` continuam iguais ao total de pendentes.
- Vista `Hoje`: grupos `Atrasada` (só se houver), `<d mmm> · Hoje · <dia da semana>` (exemplo do design: `12 nov · Hoje · quinta-feira`) e `Sem data`.
- Vista `Em breve`: navegação `‹ Hoje ›` (botões `Semana anterior` e `Próxima semana`), mês e ano da semana mostrada, faixa de 7 dias de domingo a sábado (hoje com `aria-current="date"`; clicar num dia leva o foco ao grupo dele) e os grupos. `Semana anterior` fica desabilitado na semana atual: a vista nunca mostra semana passada. Na semana atual: `Atrasada`, depois cada dia de hoje até sábado. Nas semanas seguintes: os 7 dias. Dia sem lembrete aparece mesmo assim, com o botão `+ Adicionar lembrete`. `Sem data` fica no fim.
- "Hoje" é a data de America/Sao_Paulo e é recalculada a cada renderização (a virada do dia vale sem recarregar a página).
- Rótulo de dia: `13 nov`; com ano diferente do atual, `13 nov 2027`. Hoje e amanhã aparecem como `Hoje` e `Amanhã`, com ` · HH:MM` quando houver hora (ex.: `Hoje · 14:00`, `10 nov · 17:00`).
- `+ Adicionar lembrete` em cada dia preenche a data do formulário com aquele dia e leva o foco à descrição. Lembrete criado para um dia fora da vista atual mostra o aviso `Lembrete agendado para <rótulo>.`

### Grupos e ordem

- `Atrasada`: pendentes com data anterior a hoje, por data e hora crescentes, com a data em cor de erro e o botão `Reagendar para hoje`.
- Dentro de um dia: com hora crescente e, depois, sem hora. Empates e `Sem data`: pela regra da lista (o mais recente no topo).
- Cada grupo é uma `section.lembretes__grupo` com `h3` e `ul.lembretes__itens`; `#lembretes-lista` continua sendo o contêiner dos pendentes (agora um `div`). A data agendada do item usa `span.lembretes__agenda`, sem `<time>`, para não colidir com o `<time>` de `Criado em`.
- `Reagendar para hoje` (`POST /api/lembretes/reagendar-atrasados`): todo pendente atrasado passa para hoje, mantendo a hora; concluídos, futuros e sem data não mudam. Sem confirmação (como no Todoist) e sem gravar quando não há atrasados. Quem calcula "hoje" é o servidor, em America/Sao_Paulo. Depois, o aviso `1 lembrete reagendado para hoje.` ou `<n> lembretes reagendados para hoje.`
- Em breve: dias anteriores a hoje ficam desabilitados na faixa da semana; o botão de cada dia tem o nome acessível `Adicionar lembrete em <título do dia>`.

### Formulário e edição

- Formulário: botão `Data` abre o painel `Data agendada` com os atalhos `Hoje`, `Amanhã` e `Próxima segunda` (numa segunda, +7 dias), os campos nativos `Data` e `Hora (opcional)` e o botão `Remover data`. O botão `Data` passa a mostrar a escolha (ex.: `Amanhã · 09:00`).
- Edição inline: os mesmos controles (`Data`, `Hora (opcional)`, `Remover data`), mantendo `Enter salva · Esc cancela`. Só o que mudou (descrição, data, hora) vai no PATCH.
- Datas `AAAA-MM-DD` são calculadas como texto e com `Date.UTC`, nunca com `new Date("AAAA-MM-DD")` local nem `toISOString`; só "hoje" usa `Intl` em America/Sao_Paulo.

### Textos aprovados (design de 13/11/2026)

`Hoje`, `Em breve`, `Atrasada`, `Reagendar para hoje`, `Sem data`, `Adicionar lembrete` (com o `+` do botão), `Data`, `Data agendada`, `Amanhã`, `Próxima segunda`, `Hora (opcional)`, `Remover data`, `Semana anterior`, `Próxima semana` e o cabeçalho `<d mmm> · Hoje · <dia da semana>`. Mudou um texto, propague para a interface, a validação e os testes.

### Dado gravado e rollback

- Em 13/11/2026 o item de `data/state/lembretes.json` ganhou `data_agendada` e `hora_agendada` (ambos `null` sem agenda). O arquivo continua `{"version": 1, "lembretes": [...]}`, sem migração: o item antigo é lido com `null`, e o arquivo só é regravado numa escrita normal (criar, editar, concluir, excluir ou `Reagendar para hoje` com atrasados). Nada é escrito em sistema externo e a data agendada nunca vai a log, histórico, Assistente ou modelo.
- Rollback: o código anterior (mesma `version: 1`) descarta `data_agendada` e `hora_agendada` na próxima gravação, então voltar a versão faz as datas já gravadas se perderem. Faça cópia de `data/state/lembretes.json` antes de voltar.

## Termo → Lembrete

- Barra de cada termo: novo botão `Criar lembrete`, ao lado de `Gerar PDF` e `Limpar`.
- Sem `Nome do colaborador` ou sem número de série, aparece `Preencha o número de série e o nome do colaborador.` e nada abre.
- Com os dois preenchidos, abre o diálogo `Criar lembrete` com o campo `Descrição` já montado e a dica `Texto montado com os dados do termo. Revise antes de criar.` Botões `Cancelar` e `Criar lembrete`. Esc cancela. Nada é criado sem o clique.
- Depois de criar: `Lembrete criado.` com o link `Ver em Lembretes`.
- Modelo da descrição (as partes vazias ficam de fora):
  - Entrada: `Entrada: <Nome> (<Unidade>) recebeu <Modelo>, série <Série> em <dd/mm/aaaa>. Itens: <itens marcados Sim>. Anterior: <Modelo>, série <Série>. Obs.: <Observações>`
  - Saída: `Saída: <Nome> (<Unidade>) devolveu <Modelo>, série <Série> em <dd/mm/aaaa>. Itens: <itens marcados Sim>. Obs.: <Observações>`
- Nada é cortado. Acima de 2000 caracteres (em qualquer campo de descrição), o botão de confirmar fica desabilitado e aparece `A descrição pode ter até 2000 caracteres.` (texto proposto em 11/11/2026, aguardando aprovação).

## Lembrete do termo: dados salvos, PDF e preenchimento (12/11/2026)

Pedido do usuário (12/11/2026): o lembrete criado a partir de um termo continua igual, mas guarda os dados do termo como foram salvos e os mostra com a mesma formatação; nele é possível gerar o PDF ou preencher o termo de novo para editar.

- Ao clicar em `Criar lembrete` no termo, os dados do termo são copiados no momento em que o diálogo abre (o que se digitar no termo depois não entra). O lembrete grava, além da descrição, o campo `termo`: os campos do formulário (data crua `aaaa-mm-dd`), a resposta de cada um dos 11 itens (`sim`, `nao` ou vazio) e as observações, exatamente como digitados, dentro dos limites do backend: até 200 caracteres por campo e 2000 nas observações (o excesso é cortado na cópia, não no termo); caractere de controle vira espaço, exceto quebra de linha e tab nas observações. Abrir o app numa versão anterior a 12/11/2026 e editar um lembrete regrava o arquivo sem `termo`.
- No item da lista, abaixo da descrição, aparece o bloco recolhível `Dados do termo`, com os mesmos títulos e rótulos do termo: `Dados do colaborador`, `Identificação do equipamento` (só entrega: anterior e entregue), `Equipamentos e acessórios entregues`/`devolvidos` (cada item com `Sim`, `Não` ou `—`) e `Observações`. Campo vazio aparece como `—`. Abrir ou fechar o bloco não muda nada gravado.
- Duas ações no bloco:
  - `Gerar PDF`: gera o mesmo PDF do termo (mesma folha, mesmo nome `<Série> - <Nome>`, assinatura do técnico) a partir dos dados salvos, sem ler nem mudar o formulário do termo. Erro aparece como aviso (toast).
  - `Preencher no Termo`: abre a sub-aba do termo de origem com os campos preenchidos pelos dados salvos, para editar. Se o termo já tiver algo digitado, pede confirmação antes: título `Substituir o termo?`, mensagem `Os campos do termo serão trocados pelos dados do lembrete.`, botões `Substituir` e `Cancelar`. Depois de preencher aparece `Termo preenchido com os dados do lembrete.` no termo.
- Depois de editar o termo preenchido, `Criar lembrete` cria um lembrete novo, como antes; o lembrete original não muda (decisão de 12/11/2026, sem atualização do termo gravado).
- Lembretes antigos, com origem de termo mas sem dados salvos, e lembretes manuais não mostram o bloco nem as ações.
- Editar a descrição ou concluir o lembrete não altera os dados do termo gravados.
- Textos novos (`Dados do termo`, `Preencher no Termo`, `Substituir o termo?` e a mensagem, `Substituir`, `Termo preenchido com os dados do lembrete.`): aprovados pelo usuário em 12/11/2026. `Gerar PDF` é o mesmo texto do termo.

## Dados e privacidade (LGPD)

- Grava só `data/state/lembretes.json` (`{"version": 1, "lembretes": [...]}`), com `lock_paths` e `atomic_write_json`.
- Desde 12/11/2026, o lembrete criado a partir de um termo grava também `termo` (`{"campos": {...}, "itens": [11 respostas], "obs": "..."}`): nome do colaborador, unidade, data, modelos, séries, itens e observações, como digitados. Não há CPF no termo. Nada disso vai para log, Assistente ou sistema externo; o arquivo continua só local.
- O arquivo contém dado pessoal (nome do colaborador). A descrição nunca vai para log, histórico, Assistente ou conteúdo enviado ao modelo. Log só com a classe do erro.
- Não há escrita em sistema externo.
- Bloco 6 (12/11/2026): o `Gerar PDF` dos termos mostra a assinatura do técnico (`GET /api/assinatura-tecnico`, lê `data/state/assinatura_tecnico.svg`, só leitura; nada do termo é enviado). Detalhe em `17-termos.md`, seção "Assinatura do técnico".
- API `/api/lembretes` (exige o cookie de sessão local; sem ele, 401): `GET /`, `POST /`, `PATCH /{id}`, `DELETE /{id}` e `POST /reagendar-atrasados` (13/11/2026). Contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md`.

## Interface

- Painel em cartão (superfície, borda, `--raio-lg`, `--sombra-sm`), com o rótulo `Descrição` visível acima do campo e `Adicionar` preenchido com ícone `+`. Sem largura máxima: ocupa a área da ferramenta.
- Cada lembrete é um cartão separado: círculo de concluir (anel de 18 px; concluído fica preenchido na cor de destaque, com o texto riscado), descrição, data (`Alterado em` na cor de destaque) e `Editar`/`Excluir` sempre visíveis.
- Edição inline no próprio cartão: campo realçado, dica com as teclas em `<kbd>` e `Salvar` preenchido. Estado vazio com ícone em círculo. `Concluídos (n)` com linha superior e seta que gira 90°. No diálogo de exclusão, `Excluir` é preenchido na cor de erro.
- De 320 a 2560 px, sem rolagem horizontal. Abaixo de 480 px de largura do painel: as ações descem para uma linha própria no cartão e os alvos têm 44 px.
- Temas claro e escuro, só com os tokens de `ck-tokens.css`.
- Animações de 180–260 ms; com `prefers-reduced-motion`, sem movimento.
- Foco visível, navegação por teclado, foco devolvido ao item ou ao campo depois de fechar diálogo ou edição.
