# 16 — Cobertura de equipamentos (F10, Entrega 1A)

Painel de ferramenta `cobertura` (`data-cockpit-tool-panel="cobertura"`), aberto pelo item `Cobertura` do menu Ferramentas (`#btn-cobertura`) ou pela tecla `F10`. Responde a uma pergunta: as necessidades de equipamento cadastradas vão ser atendidas, e com qual série?

Regras de negócio em `domains/coverage.py`, gravação em `domains/coverage_store.py`, rotas em `routers/coverage.py` (contratos 173–190 em `docs/arquitetura/CONTRATOS_API_BACKEND.md`, seção "Cobertura de equipamentos"), tela em `static/js/features/coverage.js` e `static/js/shared/coverage-model.js`.

## Regras

- `EquipamentosDetalhes` nunca é alterado: o cadastro só é lido (cidade padrão da série). Tudo o que a Cobertura grava fica em `data/state/operacao_cobertura.json` e `data/state/operacao_cobertura_arquivados.json` (locais, fora do Git).
- O Transporte é sempre enviado pelo operador: `Preparar Transporte` só preenche a tela Transporte (F2) com série, destino e observação; quem clica em gerar a planilha é o operador. A planilha só fica ligada à movimentação se a série e o destino ainda forem os preparados.
- A elegibilidade é recalculada dentro da transação: cada escrita relê o estado e confere de novo se a série ou a devolução continuam livres (`conflito_reserva` em caso de disputa).
- Arquivamento D6: casos fechados há mais de 30 dias e sem ligação com um caso aberto vão para o arquivo de arquivados na mesma transação de qualquer escrita. A leitura (`GET /api/cobertura`) não grava nada. Links antigos continuam abrindo (`GET /api/cobertura/casos/{caso_id}`).
- Nada é escrito em SoftExpert, SharePoint, UX, Endpoint ou outro sistema externo.

## Tela

- Abas: `Necessidades`, `Disponíveis`, `Reservas`, `Em movimento`, `Devoluções`.
- Situações das vagas: `Atendível`, `Condicionada`, `Sem cobertura`, `Entregue`. Selos: `Transferência` (a série está em outra cidade), `Prazo perdido`, `Kit pronto`, `Reserva vencida`, `Em movimento`, `Recebida com divergência`.
- Alertas: `Vagas sem cobertura: N`, `Reservas vencidas — revisar`, `Manutenção não verificada` e `Planilha baixada sem vínculo`.
- Cálculo das vagas (`build_coverage`): primeiro as reservas; depois cada vaga livre recebe uma série disponível (da mesma cidade antes de outra); se não houver, uma devolução prevista que chegue com 2 dias de preparo antes da data (vaga `Condicionada`); o resto fica `Sem cobertura`. Cada série ou devolução cobre no máximo uma vaga.

## Transporte (F2) a partir da Cobertura

- `Preparar Transporte` exige o kit completo e abre o Transporte com a série, a unidade de destino (`selecionarUnidadePorCidade`) e a observação.
- Depois que o operador baixa a planilha, a tela chama `POST /api/cobertura/movimentacoes/{id}/registrar-transferencia`. Se essa chamada falhar, a planilha fica sem vínculo: o Transporte guarda o pedido no navegador e mostra `Planilha baixada sem vínculo — Tentar de novo`; na Cobertura, `Vincular transferência já gerada` liga a movimentação a um registro já existente do histórico (`vincular-historico`).
- `Entregar sem Transporte` (movimentação `local`) vale só quando a série já está na cidade da vaga.

## Assistente

`listar_cobertura(cidade?, data?, ate?, perfil?)`, só leitura (autorizada pelo usuário em 07/11/2026): mesmos números da tela, sem os casos nem dados pessoais. Detalhes em `docs/cockpit-prompts/15-assistente.md`, seção "Cobertura pelo chat (07/11/2026)".

## Riscos conhecidos

Backlog, não regra: itens conferidos no código (07/11/2026) e ainda sem decisão ou correção.

1. O `localStorage` `simpress:cobertura:sem-vinculo` (`static/js/ui/transfer-history.js`) guarda o pedido da planilha, com nome, e-mail e telefone do destinatário, até a nova tentativa dar certo. É dado pessoal guardado no navegador (LGPD): a decidir se fica, se expira ou se guarda só o mínimo.
2. Com 409 ou 422 no `registrar-transferencia`, a planilha já baixada fica sem vínculo. A tela orienta usar `Vincular transferência já gerada`; nada é desfeito sozinho.
3. `selecionarUnidadePorCidade` (`static/js/features/transfer-form.js`) compara com `includes` sensível a acento: "Sao Jose" não acha "São José", e um nome contido em outro pode escolher a unidade errada. O operador confere o destino antes de gerar a planilha.
4. Rótulos criados no bloco 3 sem definição no plano aguardam aprovação do usuário: `Entregue`, `Vincular`, `Coletada`, `Em trânsito`, `Recebida`, `Recebida com divergência`, `Tentar de novo`, `Nova data`, `Recebido por`, `Data do recebimento`.
5. A rota `POST /api/cobertura/movimentacoes/{id}/estado` aceita `cancelada` (só a partir de `preparada`) e `encerrada` (a partir de `recebida`), mas a tela não oferece botão para esses dois estados; ela só usa a rota para `Coletada`, `Em trânsito`, `Recebida` e `Recebida com divergência`.

## Testes

`tests/test_coverage.py`, `tests/test_coverage_router.py`, `tests/test_coverage_transporte.py`, `tests/test_assistant_cobertura.py`, `tests/frontend/test_coverage_model.cjs`, `tests/frontend/test_cobertura_transporte.cjs` e `tests/e2e/cobertura.spec.cjs`.
