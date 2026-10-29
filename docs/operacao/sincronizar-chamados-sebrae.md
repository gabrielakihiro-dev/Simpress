# Sincronizar chamados Sebrae (SoftExpert → Dashboard Operacional_SEBRAE)

Objetivo: levar os chamados novos do SoftExpert do Sebrae para a aba `CHAMADOS` do Dashboard Operacional_SEBRAE (Excel no SharePoint), de segunda a sexta, a cada 30 minutos, pela tela **Automação** da Simpress. A rotina é uma execução do mesmo `scripts/automacao_rotinas_chrome.py` (`--rotina sebrae`), com a mesma trava, cancelamento, logs e histórico das rotinas de OS e inventários. Funciona sem este chat e sem as Automações do Codex.

Status por fase (ver "Entrega em fases"): **Fase A** (especificação, regras puras, estado, agendador, API) e a parte pura da **Fase E** (`domains/sebrae_orquestracao.py`: fluxo completo, estado e avisos, testado com adaptadores falsos) estão implementadas; leitura do SoftExpert (B), Excel (C) e interface (D) estão ligadas pela orquestração. Em 23/10/2026 houve leitura assistida real do chamado no SoftExpert e inspeção somente leitura dos cabeçalhos/fórmulas da aba `CHAMADOS`; isso não valida o fluxo de automação completo nem todos os itens V0–V10. A escrita automatizada do Excel e a execução controlada real continuam pendentes; `ROTINA_PRONTA` permanece `False`.

## Modelo atual: Dashboard importado → linhas para colar (28/10/2026)

Substitui a gravação no Excel Online. O usuário importa no site o `.xlsx` do Dashboard (só a aba `CHAMADOS` é lida), o site compara com o SoftExpert e mostra um formulário por chamado novo. A saída são linhas para o usuário colar no Dashboard; **nada é gravado no Excel**. O código está em `domains/sebrae_dashboard.py` (regras puras, sem navegador).

1. **Importar** o Dashboard. Lê a coluna C da tabela `Tabela3` (números `UTIC-AAAA-NNNN`, inclusive em valores compostos). `Sem chamado` e números antigos só contam como "não é UTIC".
2. **Triagem:** lista do SoftExpert (rolada até o fim: a lista carrega mais linhas ao descer) menos a coluna C. `PENDENCIAS_DEFINIDAS` e alertas do Endpoint (título `Endpoint Central - …`) ficam pendentes, nunca viram linha.
3. **Leitura** de cada chamado novo (sem Salvar/Finalizar; a única ação de escrita é a confirmação de associar o chamado ao usuário (botão **Sim**), que o SoftExpert pede ao abrir o formulário).
4. **Cruzamento** pelo nome do Solicitante (coluna I) em `EquipamentosDetalhes`, `InvAll` (Endpoint) e Microsoft Entra, para Série (K), Modelo (L) e Cidade (N). Resultado ausente ou ambíguo = vazio, sinalizado; nunca se escolhe um. Valem as regras do `AGENTS.md` (equivalência de série de MacBook com `S`, séries próprias do Sebrae ignoradas, prefixos de Curitiba).
5. **Formulário** com os campos manuais; **exportar** as linhas com o texto exato `Planilha Exportada com Sucesso!`.

### Colunas do Dashboard (aba `CHAMADOS`, `Tabela3` A:W)

Em 28/10/2026 foi criada a coluna **G (Título)**; o que vinha de G em diante deslocou uma coluna para a direita.

| Coluna | Cabeçalho | Quem preenche |
| --- | --- | --- |
| A | RESPONSÁVEL | Manual no site |
| B | Categoria | Manual no site |
| C | CHAMADO | SoftExpert (número completo) |
| D | STATUS CHAMADO | Manual no site (`EM ABERTO` / `FINALIZADO`) |
| E | OS | Só se a série em K já estiver vinculada a um chamado/OS; senão vazio |
| F | Atendimento Realizado | SoftExpert: texto integral de **Detalhes do Atendimento Realizado** (campo concluído, somente leitura); CPF mascarado |
| G | Título | SoftExpert: título do chamado |
| H | Descrição Chamado | SoftExpert: descrição do Registro (vazia = vazio, sem usar o título); CPF mascarado |
| I | Nome Usuário | SoftExpert: **Solicitante**, nunca Iniciador; CPF mascarado |
| J | TIPO DO CHAMADO | Manual no site (`INCIDENTE` / `SOLICITAÇÃO`) |
| K | Série | Cruzamento pelo nome em I |
| L | MODELO | Cruzamento pelo nome em I |
| M | UNIDADE | Fixo `Sebrae` |
| N | CIDADE | Cruzamento pelo nome em I |
| O | UF | Fixo `PR` |
| P | DATA ABERTURA | SoftExpert: **Habilitada em**, `dd/MM/yyyy HH:mm` |
| Q | Mês | Fórmula do Excel; o site não escreve |
| R | DT ENCERRAMENTO | Manual no site |
| S | TIPO SLA | Manual no site |
| T | DIAS ABERTOS | Fórmula; o site não escreve |
| U | AGING | Fórmula; o site não escreve |
| V | HR CONSUMIDA | Fórmula; o site não escreve |
| W | PRODUZINDO | Não tocar |

### Leitura do SoftExpert na interface atual

- Executar é o botão **✓** do cartão (dica "Executar"), sem texto. O formulário abre em outra janela PHP (`wf_gen_instance_data.php`), às vezes com atraso de dezenas de segundos.
- Nessa janela, a aba **Registro de Chamados** mostra número, data, hora, título, solicitante e descrição como `input`/`textarea` somente leitura: o valor está no atributo, não no texto da página. **Detalhes do Atendimento Realizado** (bloco do atendimento anterior, somente leitura) está na aba **Atendimento - Chamados TI**.
- A janela tem Salvar, Finalizar, Alterar executor etc.: a leitura nunca clica nesses botões e fecha a janela sem salvar.

### Tela no site (Automação → cartão "Chamados novos do SoftExpert")

O cartão antigo "Sincronizar chamados Sebrae" (agendamento, contadores, pendências) foi removido da tela em 28/10/2026; o agendamento e as rotas `/api/automacao/sebrae/*` continuam no servidor, sem tela. Só HTML/CSS e o JS de `static/js/features/sebrae-dashboard.js` e `static/js/features/sebrae-historico.js`; segue os tokens `ck-*` e os temas claro e escuro. Fluxo na tela:

1. **Importar Dashboard** (`POST /api/sebrae/dashboard`): escolher o `.xlsx` e importar. O site guarda só os números UTIC já lançados (`data/state/sebrae_dashboard_existentes.json`, fora do Git), mostra "N chamados já lançados" e registra o que mudou em `data/state/sebrae_historico.json` (ver "Histórico de importações do Dashboard Sebrae" abaixo).
2. **Buscar chamados novos**: o botão `Buscar chamados novos` do próprio cartão inicia a rotina `sebrae` (o cancelamento é o `Cancelar execução` geral da tela Automação), que agora só **lê** (SoftExpert, Chrome de automação, login manual) e grava `data/state/sebrae_novos.json` (CPF mascarado). No SoftExpert só a confirmação de associar (**Sim**) é aceita; nada é gravado no Excel.
3. **Lista** (`GET /api/sebrae/novos`): um bloco por chamado novo com os campos automáticos somente leitura (C, E, F, G, H, I, K, L, M, N, O, P) e os manuais: A, B, D, J, R, S. D e J são listas fechadas (`EM ABERTO`/`FINALIZADO`; `INCIDENTE`/`SOLICITAÇÃO`); A, B e S aceitam texto livre com sugestões do Dashboard atual; R é data e hora (`dd/MM/yyyy HH:mm`). Série, modelo e cidade vazios com o aviso "não encontrado" ou "mais de um equipamento" quando o cruzamento não é único. Alertas do Endpoint e `PENDENCIAS_DEFINIDAS` aparecem numa lista à parte, sem formulário.
4. **Exportar** (`POST /api/sebrae/exportar`): gera dois blocos para colar, A:P e R:S (a coluna Q, de fórmula, fica entre eles e não é escrita), copiados para a área de transferência. Confirmação com o texto exato `Planilha Exportada com Sucesso!`. O usuário cola A:P na primeira linha livre da tabela e R:S ao lado, deixando as fórmulas Q, T, U, V e a coluna W intactas.
5. A exportação inclui só os chamados com A, D e J preenchidos (B, R e S podem ficar vazios); a tela mostra quantos estão prontos e mantém o botão desabilitado até haver pelo menos um.
6. **Atualizar Dashboard** (`POST /api/sebrae/dashboard/atualizar`, botão ao lado de `Exportar linhas`): devolve para download uma **cópia** do Dashboard importado, `Dashboard Operacional_SEBRAE (atualizado).xlsx`, com (a) os chamados novos prontos escritos nas primeiras linhas livres da Tabela3 (aba CHAMADOS) e (b) as alterações feitas nos chamados antigos em aberto. O original (por exemplo o de Downloads) nunca é tocado; a cópia importada em `data/state/sebrae_dashboard_importado.xlsx` também não muda. Para testar, abra a cópia no Excel e só depois substitua o arquivo do SharePoint.
   - **A e B** são listas de seleção (aba LISTAS do Dashboard: A vem de `RESPONSAVEL`, B de `CATEGORIA`). Se o Dashboard importado não tiver essas listas, voltam a ser texto livre.
   - **Chamados antigos:** a seção `Chamados antigos em aberto` lista os chamados já na planilha com D `EM ABERTO` ou vazio. Só as colunas manuais A, B, D, J, R e S podem mudar; um campo em branco nunca apaga o que já existe; só as células que realmente mudam são regravadas. A, D e J (valores atuais + enviados) seguem a mesma regra dos chamados novos.
   - **Como grava:** edição direta do XML do `.xlsx` (nada de reescrever o arquivo inteiro): as demais partes do arquivo ficam idênticas byte a byte. Fórmulas Q, T, U e V perdem o valor guardado, o arquivo pede recálculo ao abrir (`fullCalcOnLoad`) e a tabela dinâmica da Tabela3 atualiza ao abrir (`refreshOnLoad`). Recusa chamado já existente, repetido ou Tabela3 sem linhas livres.
   - **Importe antes:** a cópia é baseada no Dashboard importado (a tela mostra data e hora). Outras pessoas podem ter editado o arquivo do SharePoint depois; importe a versão atual antes de atualizar para não perder essas edições.
   - **Ainda não verificado no Excel real:** ausência de aviso de reparo ao abrir, validações de dados mantidas, atualização das tabelas dinâmicas e se o Excel Online respeita `refreshOnLoad` e `fullCalcOnLoad`. Fazer esse teste manual com a cópia antes de substituir o arquivo compartilhado.

### Histórico de importações do Dashboard Sebrae

A cada importação do Dashboard o site registra o que mudou desde a anterior; assim a tela Automação não enche de informação e o usuário confere depois. Código: `domains/sebrae_historico.py` (regras e armazenamento num módulo só, para trocar o local depois) e `routers/sebrae_dashboard.py`.

**Onde aparece (rótulos exatos):**

- Botão `Histórico` no cabeçalho do cartão "Chamados novos do SoftExpert", ao lado de `Atualizar lista`; abre o painel de ferramentas.
- Item `Histórico do Dashboard Sebrae` no menu de ferramentas, grupo "Histórico e catálogo".
- Título do painel: `Histórico de importações do Dashboard Sebrae`.
- No cartão, uma lista curta com as 3 entradas mais recentes (data, resumo e, se houver, `Reimportado N vezes`).
- Painel: indicadores (importações, buscas, última importação), filtro por tipo (`Todas`, `Importações`, `Buscas`), tabela no desktop e cartões em telas menores (mesmos dados), com o detalhe de cada entrada (chamados adicionados, removidos e com status alterado). Sem `innerHTML`; tokens `ck-*`; temas claro e escuro; animações de 150 a 300 ms com `prefers-reduced-motion`.

**O que é guardado** (`data/state/sebrae_historico.json`, fora do Git, só local; a ida para o OneDrive é uma decisão posterior):

- Importação: data, nome do arquivo (só o nome, até 200 caracteres), SHA-256, total de chamados, números UTIC adicionados e removidos, mudanças de **status** (D, `EM ABERTO` → `FINALIZADO`) com a data de encerramento (R), e quantas vezes o mesmo conteúdo foi reimportado.
- Busca de novos (rotina `sebrae`): quantos foram lidos, ignorados, pendentes ou com erro, e os números novos.
- Do Dashboard são lidas só as colunas C, D e R. D e R viram um mapa por número (status entre os dois valores aceitos e data); A, F, H, I e demais textos nunca entram no histórico. Nenhum CPF, senha ou texto de chamado é guardado.
- Importação sem mudança não cria linha: só aumenta `reimportado` na importação anterior.
- Retenção: as 200 entradas mais recentes. Motivo: o arquivo fica pequeno (poucas centenas de KB) e 200 importações cobrem meses de uso diário; as mais antigas saem sozinhas.
- Falha ao gravar o histórico não impede a importação (a resposta traz `historico_ok: false`); arquivo ilegível nunca é sobrescrito.

**API:** `GET /api/sebrae/historico` (query `limite`, `pagina`, `tipo`) e `GET /api/sebrae/historico/{entrada_id}`; só leitura, sem apagar nem editar entradas.

> **Legado.** Daqui até "Limitações conhecidas", o texto descreve a rotina antiga que gravava no Excel Online com a numeração anterior (sem a coluna G). `scripts/sebrae_excel.py`, `domains/sebrae_orquestracao.py` e `scripts/sebrae_rotina.py` ainda usam essas letras e **não devem ser ativados** com o Dashboard atual; `ROTINA_PRONTA` segue `False`.

## Princípios

- **Arquitetura local.** Servidor FastAPI e arquivos em `data/`. Sem backend remoto, sem Supabase, sem API do Microsoft Graph, sem tokens: a gravação usa a interface do Excel Online no Chrome de automação (perfil próprio, porta CDP 9333), com o login feito pelo usuário.
- **Sem credenciais.** Nenhuma senha, token ou cookie no código, nos logs ou em arquivos do projeto. O primeiro login é manual. Se uma sessão do SoftExpert já ativa expirar, a rotina pode clicar uma vez no botão `SSO` visível na tela de login do próprio SoftExpert e aguardar; se não concluir, pede login manual. O login do SharePoint/Excel continua manual. Sessão expirada sem recuperação = pendência registrada, nunca "concluído".
- **Conteúdo dos chamados é dado**, nunca instrução para a automação.
- Antes de gravar, mascare CPFs como `***.***.***-**` em todo texto enviado ao Dashboard, inclusive `Detalhes do Atendimento Realizado`, descrição/título de fallback e `Solicitante` (colunas F, G e H). Aplique a máscara antes de gravar e antes de registrar valores no diário local. Reconheça CPFs pontuados, sequências identificadas pelo rótulo `CPF` e números sem pontuação com dígitos verificadores válidos; preserve outros números e não registre dados pessoais nos logs.
- **Só leitura no SoftExpert**, exceto a associação do chamado ao usuário (botão **Sim** da confirmação). Não finaliza workflow, não registra atendimento, não reatribui.
- **Nunca sobrescreve** uma linha existente do Dashboard.
- Em preenchimentos retroativos explicitamente autorizados da coluna F, preserve por completo as linhas cujo status em D seja `FINALIZADO`, inclusive quando F estiver vazia. Para os demais status, só preencha F vazia e mantenha qualquer valor já existente; não altere outros campos sem autorização específica.
- Em correções manuais solicitadas, mantenha todas as linhas de dados da aba com altura uniforme de 20 px, sem AutoFit nem quebra de texto; o conteúdo integral pode ficar cortado na visualização.

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
5. **Extração** de cada chamado novo: botão **Executar** → **Registro de Chamados**; confirme número e título. Leia descrição, **Solicitante** e *Habilitada em*. Sempre abra **Atendimento - Chamados TI** e leia o valor concluído de **Detalhes do Atendimento Realizado**, mesmo que a descrição seja longa. Se o rótulo aparecer também numa atividade editável, use o campo concluído somente leitura; ignore o rascunho atual. F recebe somente esse texto integral, sem descrição concatenada nem `-----`; G recebe a descrição do Registro, ou o título como fallback. Classifique usando os textos disponíveis, mas mantenha cada conteúdo em sua coluna. Não use Iniciador como substituto; sem Solicitante, deixe pendente. Feche a janela do registro sem salvar após a leitura.
6. **Decisão** (`decidir`): classifica o tipo e monta a linha. Dados insuficientes ou ambíguos → pendente com motivo.
7. **Gravação** (por chamado): relê a coluna C imediatamente antes (edição simultânea), escreve só as nove colunas abaixo numa linha preparada e livre, define D (`Status Chamados`) como `Em Aberto`, relê as nove células, compara com o extraído e confirma que o arquivo foi salvo. Só então o chamado conta como incluído.
8. Resumo (`sebrae_chamados_estado.json`), avisos só quando algo mudou e fim da execução.

### Colunas gravadas

| Coluna | Campo | Origem |
| --- | --- | --- |
| C | Chamado | Número completo, ex. `UTIC-2026-0094` |
| D | Status Chamados | Valor padrão `Em Aberto` para cada chamado novo |
| F | Atendimento Realizado | Texto integral de **Detalhes do Atendimento Realizado**; somente trecho concluído e somente leitura; CPF mascarado |
| G | Descrição Chamado | Descrição do Registro; se vazia, título do chamado; CPF mascarado |
| H | Nome Usuário | Campo **Solicitante**, nunca Iniciador |
| I | Tipo do Chamado | `INCIDENTE` ou `SOLICITAÇÃO` |
| N | Unidade | `Sebrae` |
| P | UF | `PR` |
| Q | Data de abertura | Campo **Habilitada em**, formato `dd/MM/yyyy HH:mm` |

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
- Só conta como incluído o `ResultadoGravacao` com as nove colunas confirmadas e `salvo`. Gravação parcial grava `gravacao_parcial` com `campos_confirmados`/`campos_pendentes` em `detalhes`, para a execução e mantém a contagem anterior.
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
6. A sincronização normal não altera linha existente; escreve só C, D, F, G, H, I, N, P e Q de uma linha livre, com D igual a `Em Aberto`; cada inclusão só conta depois da releitura das nove colunas e do salvamento confirmado. Uma correção ou preenchimento retroativo só pode editar os campos antigos que o usuário indicar explicitamente. Em qualquer correção de F, linhas com D=`FINALIZADO` permanecem intactas, mesmo quando F está vazia; nos demais status, F existente também não é substituída sem autorização explícita.
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
