# 16 — Cobertura de equipamentos (F10, Entrega 1A)

Painel de ferramenta `cobertura` (`data-cockpit-tool-panel="cobertura"`), aberto pelo item `Cobertura` do menu Ferramentas (`#btn-cobertura`) ou pela tecla `F10`. Responde a uma pergunta: as necessidades de equipamento cadastradas vão ser atendidas, e com qual série?

Regras de negócio em `domains/coverage.py`, gravação em `domains/coverage_store.py`, rotas em `routers/coverage.py` (contratos 173–190 em `docs/arquitetura/CONTRATOS_API_BACKEND.md`, seção "Cobertura de equipamentos"), tela em `static/js/features/coverage.js` e `static/js/shared/coverage-model.js`.

## Regras

- `EquipamentosDetalhes` nunca é alterado: o cadastro só é lido (cidade padrão da série). Tudo o que a Cobertura grava fica em `data/state/operacao_cobertura.json` e `data/state/operacao_cobertura_arquivados.json` (locais, fora do Git).
- O Transporte é sempre enviado pelo operador: `Preparar Transporte` só preenche a tela Transporte (F2) com série, destino e observação; quem clica em gerar a planilha é o operador. A planilha só fica ligada à movimentação se a série e o destino ainda forem os preparados.
- A elegibilidade é recalculada dentro da transação: cada escrita relê o estado e confere de novo se a série ou a devolução continuam livres (`conflito_reserva` em caso de disputa).
- Preparar a movimentação reconfere todos os bloqueios da série (outra reserva, movimentação ou devolução, manutenção e disponibilidade manual), não só a manutenção.
- Numa escrita, 404, 409 e 503 recarregam a Cobertura antes de mostrar a mensagem do servidor, para o registro removido ou alterado sair da tela.
- Série com reserva ativa ou movimentação aberta não muda de situação nem de cidade na aba `Disponíveis`: a escrita é recusada com 409 `conflito_reserva` até a reserva ou a movimentação ser cancelada.
- Na divergência, `Corrigir série recebida` só aceita série livre: série do Sebrae ou em manutenção dá 422 `serie_indisponivel`; série com outra reserva, movimentação ou devolução, ou já entregue em outra vaga (`serie_entregue`), dá 409 `conflito_reserva`.
- Arquivamento D6: casos fechados há mais de 30 dias e sem ligação com um caso aberto vão para o arquivo de arquivados na mesma transação de qualquer escrita. A leitura (`GET /api/cobertura`) não grava nada. Links antigos continuam abrindo (`GET /api/cobertura/casos/{caso_id}`).
- Nada é escrito em SoftExpert, SharePoint, UX, Endpoint ou outro sistema externo.

## Tela

- Abas: `Necessidades`, `Disponíveis`, `Reservas`, `Em movimento`, `Devoluções`.
- Situações das vagas: `Atendível`, `Condicionada`, `Sem cobertura`, `Entregue`. Selos: `Transferência` (a série está em outra cidade), `Prazo perdido`, `Kit pronto`, `Reserva vencida`, `Em movimento`, `Recebida com divergência`.
- Alertas: `Vagas sem cobertura: N`, `Reservas vencidas — revisar`, `Manutenção não verificada` e `Planilha baixada sem vínculo`.
- Enquanto lê `GET /api/cobertura`, o status mostra `Carregando…` e os painéis das abas e a área de alertas ficam com `aria-busy="true"` (removido ao terminar, com sucesso ou erro; nunca no ancestral do status, que é `aria-live`).
- Cálculo das vagas (`build_coverage`): primeiro as reservas; depois cada vaga livre recebe uma série disponível (da mesma cidade antes de outra); se não houver, uma devolução prevista que chegue com 2 dias de preparo antes da data (vaga `Condicionada`); o resto fica `Sem cobertura`. Cada série ou devolução cobre no máximo uma vaga.

## Transporte (F2) a partir da Cobertura

- `Preparar Transporte` exige o kit completo e abre o Transporte com a série, a unidade de destino (`selecionarUnidadePorCidade`) e a observação.
- Depois que o operador baixa a planilha, a tela chama `POST /api/cobertura/movimentacoes/{id}/registrar-transferencia`. Se essa chamada falhar por rede ou arquivo ocupado (409 `arquivo_ocupado`), a planilha fica sem vínculo: o Transporte guarda o pedido no navegador e mostra `Planilha baixada sem vínculo — Tentar de novo`. Se a recusa for definitiva (404, 422 ou outro 409), a planilha é registrada no histórico genérico (`POST /api/historico-transferencias`), o operador recebe a mensagem do servidor com a orientação de usar `Vincular transferência já gerada`, e nada fica pendente no navegador. Na Cobertura, `Vincular transferência já gerada` liga a movimentação a um registro já existente do histórico (`vincular-historico`).
- `Entregar sem Transporte` (movimentação `local`) vale só quando a série já está na cidade da vaga.
- `Cancelar movimentação` aparece nas movimentações `preparada`, `gerada` e `coletada` (transporte), pede confirmação e devolve a reserva ao estado ativo com a validade original (se já passou, fica vencida em revisão). Em `gerada`/`coletada` a confirmação avisa que a planilha continua no histórico de transferências (em `coletada`, também que o Transporte já coletou a máquina e que o operador deve confirmar que ela voltou, pois a série fica livre para outra demanda): o registro do histórico não é apagado, fica ligado à movimentação cancelada (`historico_id` preservado) e não volta a ser candidato de vínculo. `em_transito` não cancela (a máquina pode estar na estrada): a saída é `Registrar divergência` e depois cancelar e reabrir a vaga.

## Assistente

`listar_cobertura(cidade?, data?, ate?, perfil?)`, só leitura (autorizada pelo usuário em 07/11/2026): mesmos números da tela, sem os casos nem dados pessoais. Detalhes em `docs/cockpit-prompts/15-assistente.md`, seção "Cobertura pelo chat (07/11/2026)".

## Riscos conhecidos

Backlog, não regra: itens conferidos no código (07/11/2026) e ainda sem decisão ou correção.

1. O `localStorage` `simpress:cobertura:sem-vinculo` (`static/js/ui/transfer-history.js`) guarda o pedido da planilha, com nome, e-mail e telefone do destinatário, até a nova tentativa dar certo. É dado pessoal guardado no navegador (LGPD): a decidir se fica, se expira ou se guarda só o mínimo.
2. (Corrigido em 08/11/2026) `selecionarUnidadePorCidade` (`static/js/features/transfer-form.js`) comparava com `includes` sensível a acento. Agora compara a cidade inteira, sem acento, sem caixa e com espaços aparados (`dobrarCidadeTransporte`): "Sao Jose" acha "São José", e "Campo" não escolhe "Campo Grande"; sem unidade igual, o destino não é escolhido e o que já estava no campo continua lá. O operador continua conferindo o destino antes de gerar a planilha.
3. (Resolvido em 08/11/2026) Rótulos aprovados pelo usuário: `Vincular esta planilha`, `Marcar coletada`, `Marcar em trânsito`, `Confirmar recebimento`, `Registrar divergência`, `Tentar vincular de novo` (alerta sem vínculo) e `Nova data prevista`; o `aria-label` repete o texto (por exemplo `Marcar coletada — SINT-001`). Os selos e situações (`Entregue`, `Coletada`, `Em trânsito`, `Recebida`, `Recebida com divergência`) e os rótulos `Recebido por`, `Data do recebimento` e `Cancelar movimentação` não mudam. A mensagem do erro 500 (`codigo` `falha_gravacao`, inalterado) passou a `Não foi possível salvar na Cobertura. Tente de novo; se o erro continuar, avise o suporte.`
4. (Corrigido em 07/11/2026) A transição `recebida` → `encerrada` foi removida: `recebida` já fecha o caso. O estado `encerrada` continua sendo lido (legado) como entregue e fechado, caso exista em dados antigos.

## Testes

`tests/test_coverage.py`, `tests/test_coverage_router.py`, `tests/test_coverage_transporte.py`, `tests/test_assistant_cobertura.py`, `tests/frontend/test_coverage_model.cjs`, `tests/frontend/test_cobertura_transporte.cjs` e `tests/e2e/cobertura.spec.cjs`.
