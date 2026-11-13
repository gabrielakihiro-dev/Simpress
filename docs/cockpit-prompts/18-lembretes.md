# Lembretes (Ferramentas)

Especificação da ferramenta **Lembretes**, que substitui a ferramenta **Termos**. Os termos de entrega e devolução continuam existindo, agora como sub-abas dentro de Lembretes.

Referência visual aprovada (11/11/2026): canvas https://claude.ai/artifact/14zj369oGQoYmw5inWncGh, artboards "Lembretes — 5 estados" e "Termo → Lembrete".

## Estrutura

- Painel `section[data-cockpit-tool-panel="lembretes"]`, aberto pelo botão `#btn-lembretes` no menu Ferramentas. Sem atalho de teclado (Termos também não tinha).
- Sub-abas (pílulas, `role="tab"`), nesta ordem: `Termo Entrega`, `Termo Devolução` e `Lembretes <n pendentes>`. O painel abre em `Lembretes`.
- `Termo Entrega` e `Termo Devolução` são os formulários de `17-termos.md`, movidos sem mudança: IDs, campos, `Gerar PDF`, `Limpar`, nome do PDF `<Série> - <Nome>` e o preenchimento automático da Home (`app.termosPreencherDoEquipamento(eq)`).
- A ferramenta **Termos** (`#btn-termos`, painel `termos`) foi removida em 12/11/2026 (Bloco 4 da migração): o menu Ferramentas só tem `#btn-lembretes`.

## Lista de lembretes

- Item: um campo, `Descrição`. Tamanho máximo de 2000 caracteres; não pode ser vazia nem conter caractere de controle.
- Uma data por item: `Criado em dd/mm/aaaa hh:mm`. Depois de editar a descrição, passa a ser `Alterado em dd/mm/aaaa hh:mm`. Editar sem mudar o texto não altera a data.
- Ordem: o mais recente no topo, pela data exibida.
- Topo: campo com placeholder `O que você precisa fazer?` e botão `Adicionar`. Enter adiciona. Com o campo vazio, o botão fica desabilitado e Enter não faz nada.
- Cada item tem: círculo de concluir (`aria-label` `Concluir: <descrição>` / `Desmarcar: <descrição>`), descrição, data, `Editar lembrete` e `Excluir lembrete`.
- Edição inline: Enter salva e Esc cancela. Dica: `Enter salva · Esc cancela`. Botões `Cancelar` e `Salvar`. Rótulo oculto: `Editar descrição`.
- Concluídos vão para a seção recolhível `Concluídos (n)` (`aria-expanded`).
- Excluir pede confirmação em `role="alertdialog"`: título `Excluir este lembrete?`, a descrição do item, `Esta ação não pode ser desfeita.`, botões `Cancelar` e `Excluir`. Esc cancela.
- Estado vazio: `Nenhum lembrete. Anote o que precisa fazer.`

## Chamado e OS no texto (12/11/2026)

Pedido do usuário (12/11/2026). Só leitura: nenhum endpoint novo, nada é gravado e o texto do lembrete não muda no arquivo.

- No texto de um lembrete (lista de pendentes e de concluídos), `UTIC-AAAA-N` (ex.: `UTIC-2026-0833`) e um número de OS de exatamente 7 dígitos (ex.: `1234567`) viram botões (`button.ck-link-btn.lembretes__ref`, `aria-haspopup="dialog"`, `aria-label` `Abrir o chamado <número> na janela Chamado × OS` ou `Abrir a OS <número> na janela Chamado × OS`). Na edição inline o texto volta a ser o campo, sem links.
- O clique chama `abrirReferenciaLembrete({tipo, numero}, gatilho)` (`static/js/features/cockpit-tool-panels.js`), que abre o modal `#modal-chamado-os` por cima do painel, sem trocar de aba. A janela é a de `07-chamados-operacional.md` (cartão do F5 à esquerda, tabela da OS do F6 à direita), com os mesmos botões `Abrir na aba OS (F6)` e `Fechar`. Esc fecha e o foco volta ao link (ou ao link equivalente, se a lista se redesenhou).
- Casamento exato (`referenciasNoTexto` em `static/js/shared/chamados-os-model.js`, modelo puro e testado):
  - `UTIC-AAAA-N` vale sem diferença de maiúsculas e minúsculas; o número é aberto em maiúsculas.
  - Não vira link número colado a letra, dígito, `_` ou hífen (`X1234567`, `UTIC-2026-0833X`, `41 99999-1234`).
  - OS também não vira link se estiver colada a `/` (data ou fração, ex.: `12/11/2026`, `1234567/2`) nem a `.` ou `,` quando o caractere do outro lado é dígito (valores, ex.: `1.234.567,89`, `1234567,89`). Decisão registrada: pontuação de fim de frase não impede o link; `OS 1234567.` e `(OS 1234567)` ligam.
  - Mais de 7 dígitos seguidos, ou menos de 7, não ligam.
- Link de chamado: a OS do cartão do F5 vence; só sem ela vale o vínculo salvo (`GET /api/operacoes/chamados/vinculos-os`). OS `—` no cartão conta como sem OS, e a série do cartão só acompanha a OS do próprio cartão. Prioridade dos vínculos, a mesma da aba OS: digitado à mão (sem origem ou origem desconhecida) > `finalizacao` > `dashboard`. Só a melhor prioridade conta.
- Link de OS: o chamado vem dos vínculos (mesma prioridade) e, sem vínculo, dos chamados abertos da F5 (`GET /api/sebrae/novos`, sem finalizados). Se uma das duas leituras falhar, a janela segue com a outra e nunca quebra.
- Ambiguidade nunca escolhe: com mais de um valor na melhor prioridade, a janela mostra o aviso em vez de adivinhar.
- Avisos exatos (aprovados em 12/11/2026, a pedido do usuário):
  - `Mais de uma OS ligada a este chamado (<OS>, <OS>). Abra pela aba OS (F6).`
  - `OS ligada a mais de um chamado (<UTIC>, <UTIC>).`
  - `Chamado não encontrado na aba Chamados (F5).` (já existia)
  - `Nenhuma OS vinculada por série na importação atual.` (já existia; aparece à direita quando o chamado existe na F5 mas não tem OS)
  - `OS não encontrada na importação atual.` (só nos links de lembrete, quando a OS pedida sem série não está no relatório da aba OS; nos gatilhos do F5 e do F6 continua `Série não encontrada na importação atual.`)
- Lado sem conteúdo (OS pedida sem chamado, ou chamado inexistente sem OS) some e o outro lado ocupa a largura toda (`.chamado-os-janela__lado:empty` em `ck-cockpit.css`).
- Visual: o link segue o tamanho e a quebra do texto (`overflow-wrap: anywhere`), sublinhado pontilhado que vira sólido no hover, riscado junto no lembrete concluído, foco visível; só tokens de cor existentes. Alvo de toque de 44 px não se aplica a link dentro de frase.
- LGPD: o texto do lembrete continua fora de log, histórico e Assistente; o clique só envia o número da OS ou do chamado às leituras já existentes.
- Testes: `tests/frontend/test_chamados_os.cjs` (casamento e prioridade), `tests/frontend/test_lembretes.cjs` (links na lista), `tests/frontend/test_cockpit_tool_panels.cjs` (abertura, avisos, foco), `tests/frontend/test_data_panels_os_table.cjs` (`OS não encontrada na importação atual.`).

## Termo → Lembrete

- Barra de cada termo: novo botão `Criar lembrete`, ao lado de `Gerar PDF` e `Limpar`.
- Sem `Nome do colaborador` ou sem número de série, aparece `Preencha o número de série e o nome do colaborador.` e nada abre.
- Com os dois preenchidos, abre o diálogo `Criar lembrete` com o campo `Descrição` já montado e a dica `Texto montado com os dados do termo. Revise antes de criar.` Botões `Cancelar` e `Criar lembrete`. Esc cancela. Nada é criado sem o clique.
- Depois de criar: `Lembrete criado.` com o link `Ver em Lembretes`.
- Modelo da descrição (as partes vazias ficam de fora):
  - Entrada: `Entrada: <Nome> (<Unidade>) recebeu <Modelo>, série <Série> em <dd/mm/aaaa>. Itens: <itens marcados Sim>. Anterior: <Modelo>, série <Série>. Obs.: <Observações>`
  - Saída: `Saída: <Nome> (<Unidade>) devolveu <Modelo>, série <Série> em <dd/mm/aaaa>. Itens: <itens marcados Sim>. Obs.: <Observações>`
- Nada é cortado. Acima de 2000 caracteres (em qualquer campo de descrição), o botão de confirmar fica desabilitado e aparece `A descrição pode ter até 2000 caracteres.` (texto proposto em 11/11/2026, aguardando aprovação).

## Dados e privacidade (LGPD)

- Grava só `data/state/lembretes.json` (`{"version": 1, "lembretes": [...]}`), com `lock_paths` e `atomic_write_json`.
- O arquivo contém dado pessoal (nome do colaborador). A descrição nunca vai para log, histórico, Assistente ou conteúdo enviado ao modelo. Log só com a classe do erro.
- Não há escrita em sistema externo.
- Bloco 6 (12/11/2026): o `Gerar PDF` dos termos mostra a assinatura do técnico (`GET /api/assinatura-tecnico`, lê `data/state/assinatura_tecnico.svg`, só leitura; nada do termo é enviado). Detalhe em `17-termos.md`, seção "Assinatura do técnico".
- API `/api/lembretes` (exige o cookie de sessão local; sem ele, 401): `GET /`, `POST /`, `PATCH /{id}`, `DELETE /{id}`. Contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md`.

## Interface

- De 320 a 2560 px, sem rolagem horizontal. Abaixo de 480 px de largura do painel: cards com ações sempre visíveis e alvos de 44 px.
- Temas claro e escuro, só com os tokens de `ck-tokens.css`.
- Animações de 180–260 ms; com `prefers-reduced-motion`, sem movimento.
- Foco visível, navegação por teclado, foco devolvido ao item ou ao campo depois de fechar diálogo ou edição.
