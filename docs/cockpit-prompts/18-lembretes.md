# Lembretes (Ferramentas)

Especificação da ferramenta **Lembretes**, que substitui a ferramenta **Termos**. Os termos de entrega e devolução continuam existindo, agora como sub-abas dentro de Lembretes.

Referência visual aprovada (11/11/2026): canvas https://claude.ai/artifact/14zj369oGQoYmw5inWncGh, artboards "Lembretes — 5 estados" e "Termo → Lembrete".

## Estrutura

- Painel `section[data-cockpit-tool-panel="lembretes"]`, aberto pelo botão `#btn-lembretes` no menu Ferramentas. Sem atalho de teclado (Termos também não tinha).
- Sub-abas (pílulas, `role="tab"`), nesta ordem: `Termo Entrega`, `Termo Devolução` e `Lembretes <n pendentes>`. O painel abre em `Lembretes`.
- `Termo Entrega` e `Termo Devolução` são os formulários de `17-termos.md`, movidos sem mudança: IDs, campos, `Gerar PDF`, `Limpar`, nome do PDF `<Série> - <Nome>` e o preenchimento automático da Home (`app.termosPreencherDoEquipamento(eq)`).
- A ferramenta **Termos** (`#btn-termos`, painel `termos`) é removida ao final da migração.

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
- API `/api/lembretes` (exige o cookie de sessão local; sem ele, 401): `GET /`, `POST /`, `PATCH /{id}`, `DELETE /{id}`. Contrato em `docs/arquitetura/CONTRATOS_API_BACKEND.md`.

## Interface

- De 320 a 2560 px, sem rolagem horizontal. Abaixo de 480 px de largura do painel: cards com ações sempre visíveis e alvos de 44 px.
- Temas claro e escuro, só com os tokens de `ck-tokens.css`.
- Animações de 180–260 ms; com `prefers-reduced-motion`, sem movimento.
- Foco visível, navegação por teclado, foco devolvido ao item ou ao campo depois de fechar diálogo ou edição.
