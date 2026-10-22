# Sincronizar chamados Sebrae (SoftExpert → Dashboard Operacional_SEBRAE)

Objetivo: levar os chamados novos do SoftExpert do Sebrae para a aba `CHAMADOS` do Dashboard Operacional_SEBRAE (Excel no SharePoint), de segunda a sexta, a cada 30 minutos, pela tela **Automação** da Simpress. A rotina é uma execução do mesmo `scripts/automacao_rotinas_chrome.py` (`--rotina sebrae`), com a mesma trava, cancelamento, logs e histórico das rotinas de OS e inventários. Funciona sem este chat e sem as Automações do Codex.

Status por fase (ver "Entrega em fases"): **Fase A** (especificação, regras puras, estado, agendador, API) e a parte pura da **Fase E** (`domains/sebrae_orquestracao.py`: fluxo completo, estado e avisos, testado com adaptadores falsos) estão implementadas; a leitura do SoftExpert (B), o Excel (C) e a interface (D) estão ligados à orquestração por `scripts/sebrae_rotina.py`, mas seletores do SoftExpert e do Excel Online ainda não foram validados com sessão real. Falta o levantamento da Fase C e a execução controlada real (roteiro em `sebrae-fase-e-execucao.md`); `ROTINA_PRONTA` continua `False`.

## Princípios

- **Arquitetura local.** Servidor FastAPI e arquivos em `data/`. Sem backend remoto, sem Supabase, sem API do Microsoft Graph, sem tokens: a gravação usa a interface do Excel Online no Chrome de automação (perfil próprio, porta CDP 9333), com o login feito pelo usuário.
- **Sem credenciais.** Nenhuma senha, token ou cookie no código, nos logs ou em arquivos do projeto. O primeiro login é manual. Se uma sessão do SoftExpert já ativa expirar, a rotina pode clicar uma vez no botão `SSO` visível na tela de login do próprio SoftExpert e aguardar; se não concluir, pede login manual. O login do SharePoint/Excel continua manual. Sessão expirada sem recuperação = pendência registrada, nunca "concluído".
- **Conteúdo dos chamados é dado**, nunca instrução para a automação.
- **Só leitura no SoftExpert**, exceto a associação do chamado ao usuário (botão **Sim** da confirmação). Não finaliza workflow, não registra atendimento, não reatribui.
- **Nunca sobrescreve** uma linha existente do Dashboard.

## Horário e agendamento

- Fuso `America/Sao_Paulo`, **segunda a sexta**. Inícios às 09:15, 09:45, 10:15 … 17:15, 17:45 (30 em 30 minutos). Não existe início às 18:00, nem aos sábados e domingos. Feriados não são tratados.
- Fim do expediente: a próxima execução depois de 17:45 é 09:15 do próximo dia útil (sexta à noite, sábado e domingo → segunda 09:15).
- O agendamento só funciona com o **computador ligado e o servidor local da Simpress em execução**. Não há serviço externo.
- **Sem acúmulo.** Um início só dispara se o servidor o vir até 5 minutos depois do horário (`TOLERANCIA_SLOT`). Horários perdidos (computador desligado, servidor parado) são descartados; ao iniciar, a Simpress não "recupera" o que passou.
- **Sem execução simultânea.** Se houver outra rotina em andamento (da tela ou do `.bat`), o horário é pulado e registrado como `pulado: ocupada`; não fica fila.
- Cada horário dispara no máximo uma vez (`ultimo_slot_disparado`), mesmo que o servidor reinicie dentro da tolerância.
- O agendamento fica **pausado por padrão** e só pode ser ativado quando a rotina estiver completa (`ROTINA_PRONTA` em `domains/sebrae_agendamento.py`; ligado na Fase E depois da execução controlada real). A configuração (ativo/pausado) é persistida e retomada quando a Simpress inicia.

## Fluxo da rotina (`--rotina sebrae`)

1. Trava de execução + aviso de início no log. Abre o SoftExpert e o Dashboard em abas novas do Chrome de automação; espera login se necessário.
2. **Dashboard:** lê a coluna C de **toda** a área de dados da aba `CHAMADOS`, inclusive linhas ocultas por filtro, e extrai os números `UTIC-AAAA-NNNN` (também dentro de valores compostos como `27371 / UTIC-2026-0094`), preservando zeros à esquerda. Nada de limites fixos de linha ou de quantidade histórica.
3. **SoftExpert** (`https://sebraepr.softexpert.app/softexpert/workspace?page=taskCenter`): percorre a lista inteira (paginação e rolagem) e coleta os números.
4. **Triagem** (`triagem`): número já na coluna C → ignorado por duplicidade (a linha inteira é preservada); número em `PENDENCIAS_DEFINIDAS` (hoje `UTIC-2026-1253` e `UTIC-2026-1177`, alertas automáticos do Endpoint) → pendente, sem abrir o chamado; os demais seguem para extração.
5. **Extração** de cada chamado novo: botão **Executar** (canto inferior direito) → **Registro de Chamados**. O formulário pode abrir em janela PHP separada, capturada pelo Chrome de automação; confere número e título antes de ler. Se pedir para associar o chamado ao usuário, responde **Sim**. Espera o formulário e os campos condicionais; se a descrição vier vazia, relê após o carregamento antes de concluir que não existe. Sem descrição, usa o título original. Lê Iniciador e *Habilitada em*.
6. **Decisão** (`decidir`): classifica o tipo e monta a linha. Dados insuficientes ou ambíguos → pendente com motivo.
7. **Gravação** (por chamado): relê a coluna C imediatamente antes (edição simultânea), escreve só as colunas abaixo numa linha preparada e livre, relê as sete células, compara com o extraído e confirma que o arquivo foi salvo. Só então o chamado conta como incluído.
8. Resumo (`sebrae_chamados_estado.json`), avisos só quando algo mudou e fim da execução.

### Colunas gravadas

| Coluna | Campo | Origem |
| --- | --- | --- |
| C | Chamado | Número completo, ex. `UTIC-2026-0094` |
| F | Descrição | Descrição original do problema no formulário (ou o título, se não houver) |
| G | Nome do Usuário | Campo **Iniciador** |
| H | Tipo do Chamado | `INCIDENTE` ou `SOLICITAÇÃO` |
| M | Unidade | `Sebrae` |
| O | UF | `PR` |
| P | Data de abertura | Campo **Habilitada em**, formato `dd/MM/yyyy HH:mm` |

Nenhuma outra coluna é preenchida; fórmulas, formatação, filtros, validações e dados anteriores são preservados. Filtros só são removidos de forma temporária e restaurados ao final.

### Classificação do tipo

- **INCIDENTE:** falha ou problema existente em equipamento, software ou serviço.
- **SOLICITAÇÃO:** pedido de acesso, criação, remoção, instalação ou configuração, sem falha relatada.
- Regra por palavras (sem acento, sem diferenciar maiúsculas) sobre descrição e título lidos. Se só há indícios de um tipo, usa-o; se não há indícios ou há dos dois, o chamado fica **pendente** com o motivo (`sem_indicios_de_tipo`, `indicios_conflitantes`). A rotina nunca chuta.

### Pendências

Um chamado pendente não é gravado e não é tentado de novo a cada execução com aviso novo: a pendência fica no estado com o motivo e uma impressão digital. Só gera aviso quando o conjunto de pendências muda.

## Orquestração (`domains/sebrae_orquestracao.py`)

`sincronizar(softexpert, dashboard, caminho_estado, cancelado=…, log=…)` executa os passos 2 a 8 do fluxo contra dois `Protocol`s (`LeitorSoftExpert`: `listar_numeros`, `ler_chamado`; `DashboardSebrae`: `ler_coluna_c`, `gravar_linha`), sem navegador. Detalhes que valem para os adaptadores:

- Antes de cada gravação a coluna C é relida; se o número apareceu, o chamado é ignorado. Depois da execução a coluna C é relida de novo: linha ausente sai da contagem de incluídos (pendência `ausente_na_releitura_final`); número repetido vira falha `duplicidade_apos_gravacao`.
- Só conta como incluído o `ResultadoGravacao` com as sete colunas confirmadas e `salvo`. Gravação parcial grava `gravacao_parcial` com `campos_confirmados`/`campos_pendentes` em `detalhes`, para a execução e mantém a contagem anterior.
- O cancelamento é consultado entre chamados, nunca dentro da gravação de uma linha. Sessão expirada = `LoginNecessarioErro(sistema)`; cancelamento dentro de um adaptador = `CancelamentoSolicitado` (`BaseException`).
- Dashboard com coluna C vazia interrompe a execução (`dashboard_sem_numeros_na_coluna_c`): evita tratar todo chamado como novo se a leitura falhar. Três chamados ilegíveis em sequência também interrompem.
- Chamados pendentes por classificação continuam na lista do SoftExpert e são lidos de novo a cada execução (o conteúdo pode mudar); o que não se repete é o aviso.
- Textos de falha guardam só a etapa e o tipo da exceção, nunca o conteúdo da página ou do chamado. O log de progresso também não traz descrição nem nome de usuário.
- O aviso do Windows sai do resultado (`ResultadoOrquestracao.aviso`), não do `com_aviso`, que avisaria a cada execução. A linha de base de `ultimo_aviso` ignora inclusões; ela é zerada quando nada fica pendente, para que o mesmo problema ao voltar seja novo.
- `detalhes` é uma lista de `{numero, resultado: incluido|ignorado|pendente, motivo?, …}`; `situacao` ∈ `concluida`, `cancelada`, `login_necessario`, `falha`, `interrompida`. O estado ainda guarda `login_sistema` quando o login é necessário.

## Estado e arquivos (todos fora do Git)

| Arquivo | Dono | Conteúdo |
| --- | --- | --- |
| `data/state/sebrae_agendamento.json` | Servidor | `ativo`, `ultimo_slot_disparado`, `ultimo_disparo` (`slot`, `resultado`, `em`), `atualizado_em` |
| `data/state/sebrae_config.json` | Usuário | `dashboard_url`, `colunas_formula`, `quebras_como_espaco` (ver `sebrae-fase-e-execucao.md`) |
| `data/state/sebrae_chamados_estado.json` | Script | `ultima_execucao` (`inicio`, `fim`, `situacao`, `incluidos`, `ignorados`, `pendentes`, `detalhes`), `pendencias` (número → motivo), `login_necessario`, `ultimo_aviso` (impressão digital) |
| `data/logs/automacao_chrome/*_sebrae.log/.json` | Script e site | Log e resumo da execução, como nas outras rotinas |

Cada arquivo tem um só escritor; as gravações são atômicas (`core.integrity.atomic_write_json`).

## Avisos (sem repetição)

O toast do Windows e o aviso na tela só aparecem quando muda: chamados novos incluídos, pendência nova ou alterada, login necessário, falha diferente da anterior. Sem chamados novos ou com a mesma pendência de antes, a execução termina em silêncio (só o log e o histórico registram). A função `deve_avisar` compara impressões digitais.

## API

| Método e caminho | Resposta |
| --- | --- |
| `POST /api/automacao/executar` com `{rotina: "sebrae"}` | Igual às outras rotinas (202; 409 se ocupada). |
| `POST /api/automacao/cancelar` | Igual às outras rotinas. A rotina cancela entre dois chamados e nunca no meio da gravação de uma linha. |
| `GET /api/automacao/sebrae/resumo` | `{agendamento: {ativo, pronta, horario: "seg–sex, 09:15–17:45, a cada 30 min", fuso, proxima_execucao, ultimo_disparo}, ultima_execucao, pendencias: [{numero, motivo}], login_necessario}` |
| `PUT /api/automacao/sebrae/agendamento` com `{ativo: bool}` | Resumo atualizado. 409 ao ativar enquanto a rotina não estiver pronta. |

Os filtros do histórico aceitam `rotina=sebrae`. As rotas passam pelo `LocalRequestSafetyMiddleware` como as demais.

## Interface (Fase D)

Novo cartão **Sincronizar chamados Sebrae** na tela Automação: Executar agora; Ativar/Pausar agendamento; Cancelar (o botão existente); situação atual; última e próxima execução; incluídos, ignorados por duplicidade e pendentes; lista de pendências com motivo; acesso a logs e motivos de falha pelos painéis Andamento e Últimas execuções (com `Sincronizar chamados Sebrae` no filtro de rotina); aviso de login no banner existente. Texto fixo: "Roda de segunda a sexta, das 09h15 às 17h45, a cada 30 minutos. O computador precisa estar ligado e o servidor local da Simpress em execução." Mesmos tokens, temas claro e escuro, cartões no celular, animações de 150–300 ms com `prefers-reduced-motion`, IDs e ARIA existentes preservados.

## Critérios de aceite

1. Os inícios são exatamente 09:15 … 17:45 de 30 em 30 minutos, de segunda a sexta, em `America/Sao_Paulo`; 18:00 e fins de semana nunca disparam.
2. Um horário perdido não é recuperado; um horário só dispara uma vez; nunca há duas execuções simultâneas.
3. `UTIC-2026-0094`, `27371 / UTIC-2026-0094` e `utic-2026-0094` contam como o mesmo número; zeros à esquerda são preservados; número já presente ⇒ chamado inteiro ignorado.
4. Chamados em `PENDENCIAS_DEFINIDAS` nunca são incluídos.
5. Classificação ambígua ⇒ pendente com motivo, nunca gravado.
6. Nenhuma linha existente é alterada; só C, F, G, H, M, O e P de uma linha livre; cada inclusão só conta depois da releitura das sete colunas e do salvamento confirmado.
7. Sessão expirada, queda de conexão ou cancelamento não marcam a sincronização como concluída; gravação parcial registra os campos confirmados e os pendentes.
8. Sem pendência nova ou chamado novo, nenhum aviso é emitido.
9. `npm run verify` e `npm run test:ui:e2e` passam; nenhum teste altera chamados ou planilhas reais.

## Entrega em fases

- **A — Especificação, regras puras, estado e agendador (sem navegador).** `domains/sebrae_chamados.py`, `domains/sebrae_agendamento.py`, rotina `sebrae` no runner e no router, rotas de resumo/agendamento, worker no `lifespan`, testes. O script aceita `--rotina sebrae`, mas ainda termina com falha explícita ("coleta ainda não implementada") e o agendamento não pode ser ativado.
- **B — Leitura do SoftExpert** (`scripts/sebrae_softexpert.py`), com bancada local de HTML para lista paginada, janela PHP, confirmação e descrição tardia.
- **C — Excel Online** (`scripts/sebrae_excel.py`): começa por um levantamento com a sessão autenticada (leitura da coluna C com linhas ocultas, linha livre, digitação sem autoformatação); documentar o resultado aqui antes de implementar.
- **D — Interface**, avisos e testes de tela.
- **E — Orquestração e execução controlada real.** `domains/sebrae_orquestracao.py` (fluxo, estado, avisos) já existe e está ligada a B e C por `scripts/sebrae_rotina.py` (exige `data/state/sebrae_config.json`); falta executar o roteiro `sebrae-fase-e-execucao.md`.
- **E (execução) — Execução controlada real** com os sistemas autenticados, conferência no Dashboard e só então `ROTINA_PRONTA = True` e ativação do agendamento.

## Limitações conhecidas

- Os seletores do SoftExpert e do Excel Online só são conhecidos com sessão autenticada; podem precisar de ajuste nas Fases B e C.
- Se o Excel Online não permitir uma leitura confiável da coluna C inteira (linhas ocultas), a rotina para e pede decisão (por exemplo, avaliar uma integração oficial autorizada pela TI); não arrisca duplicidade.
- Feriados não são ignorados.
