# Sincronizar chamados Sebrae (SoftExpert → Dashboard Operacional_SEBRAE)

Objetivo: levar os chamados novos do SoftExpert do Sebrae para a aba `CHAMADOS` do Dashboard Operacional_SEBRAE (Excel no SharePoint), de segunda a sexta, a cada 30 minutos, pela tela **Automação** da Simpress. A rotina é uma execução do mesmo `scripts/automacao_rotinas_chrome.py` (`--rotina sebrae`), com a mesma trava, cancelamento, logs e histórico das rotinas de OS e inventários. Funciona sem este chat e sem as Automações do Codex.

Status por fase (ver "Entrega em fases"): **Fase A** (especificação, regras puras, estado, agendador, API) e a parte pura da **Fase E** (`domains/sebrae_orquestracao.py`: fluxo completo, estado e avisos, testado com adaptadores falsos) estão implementadas; leitura do SoftExpert (B), Excel (C) e interface (D) estão ligadas pela orquestração. Em 23/10/2026 houve leitura assistida real do chamado no SoftExpert e inspeção somente leitura dos cabeçalhos/fórmulas da aba `CHAMADOS`; isso não valida o fluxo de automação completo nem todos os itens V0–V10. A escrita automatizada do Excel e a execução controlada real continuam pendentes; `ROTINA_PRONTA` permanece `False`.

## Modelo atual: Dashboard importado → linhas para colar (28/10/2026)

Substitui a gravação no Excel Online. O usuário importa no site o `.xlsx` do Dashboard (só a aba `CHAMADOS` é lida), o site compara com o SoftExpert e mostra um formulário por chamado novo. A saída são linhas para o usuário colar no Dashboard ou uma **cópia** atualizada do `.xlsx` para baixar; **o site nunca grava no Excel Online nem no SharePoint** (só no arquivo gerado `Dashboard Operacional_SEBRAE.xlsx`; a rotina `enviar` é a única que sobrepõe o arquivo da pasta, ver "Enviar ao SharePoint"; no SoftExpert a única escrita permitida, além de associar o chamado, é finalizá-lo, ver "Finalizar chamado no SoftExpert"). O código está em `domains/sebrae_dashboard.py` (regras puras, sem navegador).

1. **Importar** o Dashboard. Lê a coluna C da tabela `Tabela3` (números `UTIC-AAAA-NNNN`, inclusive em valores compostos). `Sem chamado` e números antigos só contam como "não é UTIC".
2. **Triagem:** lista do SoftExpert (rolada até o fim: a lista carrega mais linhas ao descer) menos a coluna C. `PENDENCIAS_DEFINIDAS` e alertas do Endpoint (título `Endpoint Central - …`) ficam pendentes, nunca viram linha.
3. **Leitura** de cada chamado novo (sem Salvar/Finalizar; a única ação de escrita é a confirmação de associar o chamado ao usuário (botão **Sim**), que o SoftExpert pede ao abrir o formulário).
4. **Cruzamento** pelo nome do Solicitante (coluna I) em `EquipamentosDetalhes`, `InvAll` (Endpoint) e Microsoft Entra, para Série (K), Modelo (L) e Cidade (N). Resultado ausente ou ambíguo = vazio, sinalizado; nunca se escolhe um. Valem as regras do `AGENTS.md` (equivalência de série de MacBook com `S`, séries próprias do Sebrae ignoradas, prefixos de Curitiba).
5. **Formulário** com os campos manuais (no painel **Chamados Sebrae**, ver "Tela no site"); **exportar** as linhas com o texto exato `Planilha Exportada com Sucesso!`.

**Regra de gravação (atualizada):** **Atualizar Dashboard** grava **todos** os chamados novos, mesmo com Responsável (A), Status (D) e Tipo (J) em branco: as células ficam vazias para o usuário preencher depois, e o chamado passa a aparecer em "Chamados antigos em aberto" quando D fica vazio. Valor preenchido continua validado: D `EM ABERTO`/`FINALIZADO`; J `INCIDENTE`/`SOLICITAÇÃO`; R `dd/MM/aaaa HH:mm`; A e B conforme a aba LISTAS. **Exportar linhas** (colar) continua exigindo A, D e J. D vem pré-selecionado com `EM ABERTO` nos chamados novos (o usuário pode trocar). S vem pré-preenchido com `DISPONIBILIDADE` e portanto é gravado em todo chamado novo. **Mudança de comportamento:** antes, chamados incompletos ficavam fora da cópia e reapareciam na próxima busca; agora todo Atualizar grava todos os novos. Reimporte o Dashboard atualizado antes da próxima atualização, para os chamados já gravados não serem tratados como novos de novo.

### Colunas do Dashboard (aba `CHAMADOS`, `Tabela3` A:W)

Em 28/10/2026 foi criada a coluna **G (Título)**; o que vinha de G em diante deslocou uma coluna para a direita.

| Coluna | Cabeçalho | Quem preenche |
| --- | --- | --- |
| A | RESPONSÁVEL | Manual no site |
| B | Categoria | Manual no site |
| C | CHAMADO | SoftExpert (número completo) |
| D | STATUS CHAMADO | Manual no site (`EM ABERTO` / `FINALIZADO`) |
| E | OS | Só se a série em K já estiver vinculada a um chamado/OS; senão vazio. Ver "Ligação UTIC ↔ OS pela série" abaixo |
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
| Q | Mês | Fórmula do Excel; na cópia o site só replica a fórmula em linha nova e limpa o valor guardado |
| R | DT ENCERRAMENTO | Manual no site |
| S | TIPO SLA | Manual no site |
| T | DIAS ABERTOS | Fórmula; o site mantém a fórmula e limpa o valor guardado, nunca grava valor |
| U | AGING | Fórmula; o site mantém a fórmula e limpa o valor guardado, nunca grava valor |
| V | HR CONSUMIDA | Fórmula; o site mantém a fórmula e limpa o valor guardado, nunca grava valor |
| W | PRODUZINDO | Não tocar |

### Leitura do SoftExpert na interface atual

- Executar é o botão **✓** do cartão (dica "Executar"), sem texto. O formulário abre em outra janela PHP (`wf_gen_instance_data.php`), às vezes com atraso de dezenas de segundos.
- Nessa janela, a aba **Registro de Chamados** mostra número, data, hora, título, solicitante e descrição como `input`/`textarea` somente leitura: o valor está no atributo, não no texto da página. **Detalhes do Atendimento Realizado** (bloco do atendimento anterior, somente leitura) está na aba **Atendimento - Chamados TI**.
- A janela tem Salvar, Finalizar, Alterar executor etc.: a leitura nunca clica nesses botões e fecha a janela sem salvar.

### Tela no site (Automação → cartão "Chamados novos do SoftExpert")

O cartão antigo "Sincronizar chamados Sebrae" (agendamento, contadores, pendências) foi removido da tela em 28/10/2026; o agendamento e as rotas `/api/automacao/sebrae/*` continuam no servidor, sem tela. Só HTML/CSS e o JS de `static/js/features/sebrae-dashboard.js` e `static/js/features/sebrae-historico.js`; segue os tokens `ck-*` e os temas claro e escuro. Fluxo na tela:

**Onde fica cada coisa (rótulos exatos):**

- **Automações** (cartão "Chamados novos do SoftExpert") mantém: `Importar Dashboard`, `Buscar chamados novos`, `Atualizar lista`, status, resumo e avisos, o resumo do histórico e o botão `#btn-sebrae-abrir-chamados` com o rótulo exato `Chamados Sebrae`, que abre o painel.
- **Menu de ferramentas:** novo item `Chamados Sebrae` (`#btn-sebrae-chamados-menu`, chave de painel `sebrae-chamados`, ícone `#i-file-check`, sem atalho e sem badge), no grupo "Planilhas", logo abaixo de `Histórico planilhas`. É um painel de trabalho; não confundir com `Histórico do Dashboard Sebrae` (log de importações e buscas), que não muda.
- **Painel Chamados Sebrae** recebe: a lista de chamados novos, `Chamados antigos em aberto` (`details`), os datalists de sugestões, `Exportar linhas`, `Atualizar Dashboard`, o status e os blocos A:P e R:S. Todos os IDs existentes são preservados (só mudam de lugar).
- O painel **não tem botão de recarga**: a lista só muda por importar, buscar ou `Atualizar lista`, feitos em Automações. Abrir o painel **não recarrega** a lista, porque recarregar zeraria as edições já feitas nos chamados antigos.

1. **Importar Dashboard** (`POST /api/sebrae/dashboard`): escolher o `.xlsx` e importar. O site guarda só os números UTIC já lançados (`data/state/sebrae_dashboard_existentes.json`, fora do Git), mostra "N chamados já lançados" e registra o que mudou em `data/state/sebrae_historico.json` (ver "Histórico de importações do Dashboard Sebrae" abaixo). Antes de trocar o Dashboard anterior, grava no arquivo de encerrados os chamados que saíram da lista de abertos (ver "Arquivo de chamados encerrados"); a resposta traz `arquivo_ok: true`. Se essa gravação falhar, a importação é bloqueada (503) e o Dashboard anterior fica preservado; D ilegível devolve 422.
2. **Buscar chamados novos**: o botão `Buscar chamados novos` do próprio cartão inicia a rotina `sebrae` (o cancelamento é o `Cancelar execução` geral da tela Automação), que agora só **lê** (SoftExpert, Chrome de automação, login manual) e grava `data/state/sebrae_novos.json` (CPF mascarado). No SoftExpert só a confirmação de associar (**Sim**) é aceita; a rotina não grava no Excel.
3. **Lista** (`GET /api/sebrae/novos`), exibida no painel **Chamados Sebrae**: um bloco por chamado novo com os campos automáticos somente leitura (C, E, F, G, H, I, K, L, M, N, O, P) e os manuais: A, B, D, J, R, S. D e J são listas fechadas (`EM ABERTO`/`FINALIZADO`; `INCIDENTE`/`SOLICITAÇÃO`); A, B e S aceitam texto livre com sugestões do Dashboard atual; R é data e hora (`dd/MM/yyyy HH:mm`). Série, modelo e cidade vazios com o aviso "não encontrado" ou "mais de um equipamento" quando o cruzamento não é único. Alertas do Endpoint e `PENDENCIAS_DEFINIDAS` aparecem numa lista à parte, sem formulário.
4. **Exportar** (`POST /api/sebrae/exportar`): gera dois blocos para colar, A:P e R:S (a coluna Q, de fórmula, fica entre eles e não é escrita), copiados para a área de transferência. Confirmação com o texto exato `Planilha Exportada com Sucesso!`. O usuário cola A:P na primeira linha livre da tabela e R:S ao lado, deixando as fórmulas Q, T, U, V e a coluna W intactas.
5. A exportação (`Exportar linhas`) inclui só os chamados com A, D e J preenchidos (B, R e S podem ficar vazios); a tela mostra quantos estão prontos e mantém o botão desabilitado até haver pelo menos um. Essa exigência vale só para exportar; **Atualizar Dashboard** não a tem (item 6).
6. **Atualizar Dashboard** (`POST /api/sebrae/dashboard/atualizar`, botão ao lado de `Exportar linhas`): devolve para download uma **cópia** do Dashboard importado, `Dashboard Operacional_SEBRAE.xlsx` (também guardado em `data/state/sebrae_dashboard_saida/`, de onde a rotina `enviar` o sobe), com (a) **todos** os chamados novos escritos nas primeiras linhas livres da Tabela3 (aba CHAMADOS), mesmo com A, D e J em branco (células vazias, para preencher depois; valor preenchido continua validado; S, pré-preenchido com `DISPONIBILIDADE`, é gravado em todos) e (b) as alterações feitas nos chamados antigos em aberto. O arquivo importado (por exemplo o de Downloads) nunca é tocado; a cópia importada em `data/state/sebrae_dashboard_importado.xlsx` também não muda. Para testar, abra o arquivo no Excel antes de usar `Enviar ao SharePoint`, que sobrepõe o do SharePoint.
   - **A e B** são listas de seleção (aba LISTAS do Dashboard: A vem de `RESPONSAVEL`, B de `CATEGORIA`). Se o Dashboard importado não tiver essas listas, voltam a ser texto livre.
   - **Chamados antigos:** a seção `Chamados antigos em aberto` lista os chamados já na planilha com D `EM ABERTO` ou vazio. Só as colunas manuais A, B, D, J, R e S podem mudar; um campo em branco nunca apaga o que já existe; só as células que realmente mudam são regravadas. Os valores preenchidos (atuais + enviados) seguem a mesma validação dos chamados novos; A, D e J podem ficar em branco. Um chamado novo gravado com D vazio passa a aparecer aqui na importação seguinte, onde o usuário o completa. **Espelho completo (29/10/2026):** a lista traz **todas** as linhas com D `EM ABERTO` (ou vazio), inclusive as sem UTIC (`Sem chamado`, números antigos como `27011`). A chave do chamado é o UTIC quando a coluna C tem exatamente um e nenhuma outra linha o repete; senão é `linha:<n>` (n = linha da planilha), mostrada como `texto da C (linha n)`. As edições valem sobre a cópia importada (conferida por sha256), por isso a linha é estável. Os campos A, B, J, R e S só ficam editáveis no painel quando a célula está vazia (D continua sempre editável); o bloqueio é só da tela, o servidor aceita a edição. A célula C nunca é reescrita. **Preenchimento automático:** ao clicar em Atualizar Dashboard, para cada chamado antigo em aberto, o nome completo da coluna I é cruzado (mesma regra do cruzamento dos novos: único preenche; ausente ou ambíguo fica vazio) para preencher Série (K), Modelo (L) e Cidade (N), e a OS (E) passa a ser a OS mais recente da série (a de K, ou a recém-cruzada), quando houver. Só células **vazias** são preenchidas; valor existente nunca é trocado, e K já preenchida com outra série não recebe L/N do cruzamento. Só linhas em aberto são preenchidas (FINALIZADO não). **Exceção — chamado aberto para outra pessoa:** se a descrição (coluna H) cita o nome completo de outra pessoa da base (diferente do Solicitante), K, L e N ficam vazios, tanto nos novos quanto nos antigos, para o usuário preencher à mão (a OS (E) ainda vem da série que a linha já tem em K), e o painel mostra o aviso "Aberto para outra pessoa (nome)". Só reconhece nomes completos que existam na base; a tela dos antigos só enxerga a descrição depois de reimportar o Dashboard. **Reimporte o Dashboard** depois de atualizar o sistema: a lista de chamados antigos mostrada no painel vem do estado gravado na importação, então só reflete essa regra depois de uma nova importação.
   - **Quando o botão habilita:** o Dashboard importado é atualizável e há pelo menos um chamado novo, uma edição de chamado antigo ou um preenchimento automático (K, L, N, E) sugerido.
   - **Mudança de comportamento:** antes, chamados incompletos ficavam fora e reapareciam na próxima busca; agora todo `Atualizar Dashboard` grava todos os novos. Reimporte o Dashboard atualizado antes da próxima atualização.
   - **Como grava:** edição direta do XML do `.xlsx` (nada de reescrever o arquivo inteiro): as demais partes do arquivo ficam idênticas byte a byte. Fórmulas Q, T, U e V perdem o valor guardado, o arquivo pede recálculo ao abrir (`fullCalcOnLoad`) e a tabela dinâmica da Tabela3 atualiza ao abrir (`refreshOnLoad`). Recusa chamado já existente, repetido ou Tabela3 sem linhas livres.
   - **Importe antes:** a cópia é baseada no Dashboard importado (a tela mostra data e hora). Outras pessoas podem ter editado o arquivo do SharePoint depois; importe a versão atual antes de atualizar para não perder essas edições.
   - **Rascunho automático (30/10/2026):** tudo o que o usuário seleciona ou digita nos campos manuais (A, B, D, J, R, S dos chamados novos e dos antigos em aberto) é guardado sozinho no navegador (`localStorage`, chave `simpress:sebrae-rascunho`), sem clicar em `Atualizar Dashboard`, para não perder o preenchimento se a internet cair, a aba fechar ou o navegador travar. O rascunho vale só para o Dashboard importado em que foi feito (compara `importado_em`; outra importação o ignora), é restaurado ao recarregar a página (aviso `Rascunho restaurado (salvo em ...). Passe por Atualizar Dashboard para gravar no arquivo.`) e sobrevive a `Atualizar lista` e a `Atualizar Dashboard`. Só restaura chamado novo que ainda está no formulário e, nos antigos, campos que continuam vazios no Dashboard (D sempre). Só números `UTIC-AAAA-N` ou `linha:<n>`, letras A, B, D, J, R, S e textos de até 80 caracteres são aceitos; qualquer falha do `localStorage` (bloqueado, cheio, JSON ruim) é ignorada e a tela funciona sem rascunho. O botão `Descartar rascunho` (pede confirmação) apaga o rascunho e volta os campos ao padrão. **O rascunho não escreve no SoftExpert, no SharePoint nem no arquivo do Dashboard**; é só um backup local e nunca finaliza nada. A descrição de finalização continua salva no servidor (800 ms), fora do rascunho. Código: `lerRascunho`/`gravarRascunho`/`apagarRascunho`/`aplicarRascunho` em `static/js/features/sebrae-dashboard.js`; blocos `#sebrae-rascunho`, `#sebrae-rascunho-status`, `#btn-sebrae-descartar-rascunho`; testes em `tests/frontend/test_sebrae_dashboard_ui.cjs` e `tests/e2e/sebrae-dashboard.spec.cjs`.
   - **Ainda não verificado no Excel real:** ausência de aviso de reparo ao abrir, validações de dados mantidas, atualização das tabelas dinâmicas e se o Excel Online respeita `refreshOnLoad` e `fullCalcOnLoad`. Fazer esse teste manual com o arquivo gerado antes de usar `Enviar ao SharePoint`.

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

### Arquivo de chamados encerrados

Chamado que estava aberto na importação anterior e agora está `FINALIZADO` (D) ou sumiu da coluna C vai para um arquivo próprio, separado do histórico de importações (que expira em 200 entradas). Código: `domains/sebrae_arquivo.py`; arquivo: `data/state/sebrae_chamados_encerrados.json` (fora do Git, só local).

- Um registro por número UTIC (upsert) e uma entrada em `ciclos` por saída; chamado reaberto que fecha de novo ganha outro ciclo. A mesma importação (mesmo SHA-256) nunca soma um segundo ciclo ao chamado.
- Guarda só: número, categoria (B), tipo (J), SLA (S) e, por ciclo, `saida_em`, `motivo` (`finalizado` ou `saiu_do_dashboard`), status, encerramento (R), `visto_aberto_em` e SHA-256. Não guarda responsável (A), texto, nome de usuário nem CPF.
- Sem limite de retenção: nada expira.
- Na primeira importação com esta versão o arquivo ainda não existe: os chamados já `FINALIZADO` do Dashboard são semeados. Antes disso não há registro de saídas passadas.
- Chamados sem UTIC único (chave `linha:<n>`) não dá para acompanhar entre importações; só são contados (`nao_rastreaveis`).
- Falha ao gravar bloqueia a importação (503, mensagem em português), para a saída não se perder; arquivo ilegível nunca é sobrescrito. Chamados ainda abertos (`sebrae_dashboard_existentes.json`) também ficam com CPF e senha mascarados.

### Enviar ao SharePoint (rotina `enviar`)

Único ponto em que algo é gravado no SharePoint, autorizado pelo usuário em 29/10/2026. Passos e salvaguardas (Duplicata, conferência, backup dos 20 últimos em `data/state/sebrae_backups/`, `Replace`) estão em `docs/operacao/automacao-chrome.md`. Nome fixo do arquivo: `Dashboard Operacional_SEBRAE.xlsx` (sem "(atualizado)"). Antes de duplicar, a rotina registra no log quantas cópias já existem na pasta e, se passar de 5, avisa para apagar as antigas à mão (nunca bloqueia o envio nem apaga nada).

**Conferência no segundo envio:** depois de um envio concluído, a rotina guarda o hash do arquivo enviado em `data/state/sebrae_dashboard_enviado.json`. No envio seguinte, o arquivo baixado do SharePoint também é aceito se tiver esse hash (é o que o próprio site subiu); qualquer outro arquivo diferente do importado continua passando pela comparação de valores.

**Finalizar chamados e coluna R (rotina `fechar`):** descrição (até 4.000 caracteres) e PDF opcional de cada chamado ficam em `data/state/sebrae_finalizacao.json` e `data/state/sebrae_anexos/<chamado>/`. `POST /api/sebrae/finalizar-softexpert` (um chamado) e o disparo em massa de `Atualizar Dashboard` gravam o pedido em `data/state/sebrae_fechar_job.json` (vale por 2 h e é consumido uma vez) e chamam a rotina `fechar` (`.venv\Scripts\python.exe scripts\automacao_rotinas_chrome.py --rotina fechar [--sem-finalizar]`; `--sem-finalizar` preenche e confere sem clicar em `Finalizar`). O resultado fica em `data/state/sebrae_fechar_resultado.json` (`GET /api/sebrae/finalizar-softexpert`). Para cada chamado com status `ok`, a rotina grava a data/hora de encerramento (`dd/mm/aaaa HH:mm`, America/Sao_Paulo) na coluna R da linha achada pela coluna C da saída e, junto, `D` = `FINALIZADO` (só se R estiver vazia e só se exatamente uma linha tiver o UTIC; R já preenchida ou UTIC repetido não gravam nada). `nao_encontrado`, `ja_finalizado`, `pronto` e `erro` não gravam R nem D e não disparam o SharePoint; havendo ao menos um `ok`, sobe a saída pela rotina `enviar`. Se a `enviar` falhar, a cópia fica em `data/state/sebrae_dashboard_pendente/` com um JSON de registro e a rotina tenta subi-la à pasta com o nome `Dashboard Operacional_SEBRAE (pendente AAAA-MM-DD HHMM).xlsx`, sem substituir o original; o resultado traz `sharepoint = {falhou, motivo, copia_local, copia_sharepoint, sugestoes}` e `POST /api/sebrae/dashboard/pendente/reenviar` reenvia a cópia pela `enviar`. Depois de qualquer envio bem-sucedido (da `fechar` ou do reenvio), todas as cópias pendentes locais (`.xlsx` e `.json`) são apagadas: o que subiu é mais novo, então `Tentar substituir de novo` nunca sobrescreve um dado mais novo com um mais velho (sem cópia pendente não há o que reenviar). A cópia "(pendente ...)" subida ao SharePoint deve ser apagada à mão depois que o Dashboard for substituído.

Importar um Dashboard novo (inclusive por `Baixar, importar e buscar`) **apaga** a saída guardada em `data/state/sebrae_dashboard_saida/`: ela vinha da importação anterior e subi-la sobreporia chamados que entraram no SharePoint depois. Sem arquivo, `Enviar ao SharePoint` recusa com "Use Atualizar Dashboard antes"; gere a saída de novo.

**Verificado em ensaio real (29/10/2026, interface em português):** botão `Criar ou carregar` e item `Carregamento de arquivos` (só o menu foi aberto, sem enviar nada); linha > `Mais Ações` > `Baixar` salva em Downloads (hash igual em duas execuções); `Duplicata` cria `Dashboard Operacional_SEBRAE Copiar.xlsx` em ~10 s, e o Baixar seguinte continua escolhendo o original. A cópia de teste ficou na pasta e não foi mexida.

**Verificado também no Replace (30/10/2026, pasta de teste `ENSAIO_TESTE_APAGAR` com `Ensaio_Replace.xlsx`; o Dashboard real não foi tocado):** segundo envio com o mesmo nome mostra um aviso (toast) "Já existe um arquivo com este nome…" com os botões `Substituir` e `Manter ambos`; `Substituir` conclui com o aviso "… carregado para <pasta>". Com o mesmo conteúdo a linha do arquivo não muda (tamanho igual, "Há alguns segundos"), então o aviso é o sinal confiável. `enviar_arquivo_para_pasta` rodou inteira nessa pasta.

**Ainda não verificado:** o aviso de arquivo em uso/bloqueado; o histórico de versões da pasta (confirmar com a TI); o primeiro `enviar` no Dashboard real; e o comportamento no Excel real descrito acima. Os testes usam Playwright simulado. A conferência prévia, quando o hash difere, compara os valores de todas as colunas de dado (A:P, R e S) das linhas da `Tabela3` com a cópia importada (estilos, ordem do zip e metadados são ignorados; fórmulas contam como vazias, como no leitor de gravação): edição de terceiros em A, B, J, S etc. faz a rotina parar com "O Dashboard no SharePoint mudou depois da importação; importe de novo." Q, T, U, V e W não são comparadas.

### Finalizar chamado no SoftExpert (exceção de escrita, 30/10/2026)

Única exceção à regra "o SoftExpert só é lido", autorizada pelo usuário em 30/10/2026: a automação pode **finalizar** um chamado, mas só quando o usuário o marcou `FINALIZADO` no site e pediu para finalizá-lo. A função é `finalizar_chamado(page, numero, descricao, *, pdf=None, enviar_email=None, confirmar_final=True)` em `scripts/sebrae_softexpert.py`; a ligação com a rotina `fechar` e com o site vem em etapa separada.

Passos, nesta ordem (a interface real foi descrita pelo usuário em imagens; os seletores só foram validados na bancada local):

1. Abre a central de tarefas, acha o cartão cujo título começa com o número e clica no ícone **Executar** (o mesmo fluxo da leitura, inclusive a confirmação de associar a atividade).
2. Na janela PHP `wf_gen_instance_data.php`, fica no item de menu **Atendimento - Chamados TI** e preenche: **Selecione a Categoria de Solução** = `Infraestrutura`; **Selecione a Solução** = `Rede e conectividade`; **Detalhes do Atendimento Realizado** = a descrição informada (vazia: recusa antes de qualquer clique); a caixa **Enviar Detalhes por e-mail ao solicitante** vem marcada e fica **desmarcada** quando o `Solicitante` é `API SEBRAE` (ou conforme o parâmetro `enviar_email`) e marcada nos demais casos. Cada valor é conferido depois de preenchido.
3. Em **Alterar Equipe de Atendimento**, **Selecione a Equipe** = `UTIC - N1` (conferido).
4. Com PDF: menu **Anexo** > botão `+` (dica **Incluir**) > escolhe o arquivo > espera o item aparecer na lista > clica **Enviar** (confirmação do upload) > espera concluir.
5. Clica o botão azul **Finalizar** (só com `confirmar_final=True`; com `False` para antes e devolve os valores conferidos e uma captura de tela), trata a confirmação, e confere o resultado: janela fecha ou o cartão sai da central de tarefas. Resultado por chamado: `ok`, `nao_encontrado` (fora da central de tarefas: não prova que está finalizado, não é erro, nada é gravado e o usuário pode tentar de novo; só `ok` bloqueia uma nova finalização), `erro`, `sem_descricao` ou `pronto` (`ja_finalizado` só aparece em registros antigos e também não bloqueia). O nome do PDF anexado perde caracteres fora de `A-Za-z0-9._() -` e, se for nome reservado do Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, com ou sem extensão extra, como `com1.x.pdf`), ganha `_` na frente.

Detalhes confirmados no SoftExpert real (30/10/2026, chamado `UTIC-2026-1253`): **Categoria de Solução** e **Solução** são combos de texto pesquisável (`input` que abre uma lista; o código digita e escolhe a opção exata, nunca a primeira parecida). Antes de preencher, a função confere o cabeçalho do formulário (número do chamado e `Solicitante`); para chamados criados por API (`API SEBRAE`) o `Solicitante` do cabeçalho pode vir vazio ou só no `Iniciador`, e o texto do cabeçalho é lido sem acento e sem diferença de maiúsculas, com as quebras de linha mantidas. Nesse teste o e-mail ao solicitante ficou desmarcado (solicitante API SEBRAE), a finalização foi concluída e a coluna R não foi gravada porque a máquina não tinha Dashboard importado (`Não há Dashboard importado utilizável; a coluna R não foi gravada.`).

Proibido e sem nenhum clique: **Solicitar Complemento**, **Enviar para outra equipe**, **Mais ações**, **Salvar**, **Reatribuir** e qualquer outro botão de escrita. `ROTULOS_PROIBIDOS` e o guarda de `clicar` continuam valendo para todo o restante do módulo; só os rótulos `Finalizar` e o `Enviar` do anexo são liberados, por um escopo estreito que existe somente durante `finalizar_chamado`. Finalizar é irreversível: o primeiro teste real para antes do `Finalizar` e só conclui depois do "pode finalizar" do usuário no chat. Com `confirmar_final=False` e PDF, o anexo **é enviado de verdade** (o `Enviar` do upload persiste no chamado); só o `Finalizar` fica de fora. Os testes da bancada (SoftExpert falso, Chrome headless) cobrem o fluxo; **nada disso foi executado no SoftExpert real**.

### Ligação UTIC ↔ OS pela série (31/10/2026)

Ao importar o Dashboard e rodar a busca, o chamado e a OS da mesma série ficam ligados nos dois sentidos, sem digitação:

- **Dashboard → tabela de OS.** Cada linha com UTIC completo em C (`UTIC-AAAA-N`) e série em K propõe um vínculo. A OS-alvo é a de E, se a série a tem; senão a única OS da série no relatório de chamados. Zero ou várias OS é ambíguo e não gera vínculo. Cada vínculo carrega `origem: "dashboard"`, aparece na coluna `Chamado` da tabela de OS (Chamados e Resumo) e é montado em `domains/sebrae_vinculos.py` (`vinculos_derivados`).
- **Tabela de OS → Dashboard.** Em `Atualizar Dashboard` e nas sugestões, E recebe a OS do vínculo desse UTIC (`os_do_chamado`; com várias, a maior), sempre só em célula vazia. Vínculo manual do UTIC vale antes da série.
- **Regras.** O vínculo manual de `os_chamados_vinculos.json` vence o derivado da mesma fonte, série e OS. Vínculos derivados **não são gravados**: `GET /api/operacoes/chamados/vinculos-os` os calcula a cada leitura; limpar um derivado no editor não o remove, ele reaparece. Se o mesmo UTIC reivindicar a mesma fonte, série e OS por dois chamados diferentes, nenhum dos dois entra. Falha no cálculo é registrada no log (só o tipo do erro) e a rota devolve só os manuais. Nada é escrito no SoftExpert, no SharePoint nem no Dashboard além da célula E já descrita.
- **Testes.** `tests/test_sebrae_vinculos.py`, `tests/test_sebrae_novos.py`, `tests/test_operations.py`.

### Integração na Automação do site (30/10/2026)

Regra: finalizar chamado faz parte da tela Automação. Quem alterar qualquer etapa abaixo atualiza, no mesmo trabalho, backend, tela, testes e este documento (e o `AGENTS.md`).

| Etapa | Onde |
|---|---|
| Campos `Descrição para Finalizar o Chamado` (até 4000; salva sozinho 800 ms depois de parar de digitar) e `Anexo PDF (opcional)` (botão `Remover PDF`) por chamado antigo em aberto, na seção de finalização do cartão. A seção só existe para chamado com número UTIC (`UTIC-AAAA-N`); chamado sem UTIC (`Sem chamado`, `linha:<n>`) não a mostra | `PUT /api/sebrae/chamados/{numero}/finalizacao`, `POST`/`DELETE .../anexo`; `static/js/features/sebrae-dashboard.js` (`secaoFinalizar`); estado em `data/state` |
| Rascunho automático das seleções dos campos A, B, D, J, R e S (`localStorage`, por Dashboard importado, botão `Descartar rascunho`); não toca no SoftExpert, no SharePoint nem no Dashboard | `static/js/features/sebrae-dashboard.js` (`lerRascunho`, `aplicarRascunho`); sem endpoint |
| Botão `Finalizar no SoftExpert` (um chamado). Pede confirmação (`Confirmar finalização` / `Cancelar`) dizendo que não tem volta e se o PDF será enviado; salva a descrição antes e só então chama com `confirmado: true` (sem ele o servidor responde 422 e nada é disparado) | `POST /api/sebrae/finalizar-softexpert` |
| Em massa: `Atualizar Dashboard` finaliza os com D `FINALIZADO` e descrição (os sem descrição, já finalizados ou sem número são pulados e avisados). Antes de enviar, a tela lista os números e abre o diálogo `Atualizar Dashboard e finalizar no SoftExpert` com `Atualizar e finalizar` e `Só atualizar`: só `Atualizar e finalizar` manda `finalizar_softexpert: true`; `Só atualizar`, Esc e fechar o diálogo atualizam e baixam o Dashboard sem finalizar nada (nunca finalizam). Sem a flag (padrão `false`) o servidor não dispara a rotina `fechar` | `POST /api/sebrae/dashboard/atualizar`, campos `finalizar_softexpert` e `fechar` |
| Rotina `fechar` | `domains/chrome_automation.py`, `routers/automation.py`, `scripts/automacao_rotinas_chrome.py --rotina fechar [--sem-finalizar]`, `scripts/sebrae_fechar.py` |
| Acompanhamento do resultado por chamado: a tela consulta a cada 1,5 s (`INTERVALO_FECHAR_MS`) enquanto a rotina roda e mostra o resultado no cartão de cada chamado | `GET /api/sebrae/finalizar-softexpert`; `data/state/sebrae_fechar_resultado.json` |
| Data/hora do encerramento na coluna R, com D `FINALIZADO` na mesma linha | `domains/sebrae_dashboard_gravacao.py` (`registrar_encerramentos`) |
| Substituição do Dashboard no SharePoint; falha vira cópia pendente e o aviso `O Dashboard não foi substituído no SharePoint.` (motivo, caminho da cópia local, se a cópia foi ao SharePoint com outro nome e a lista "O que fazer") com o botão `Tentar substituir de novo` | rotina `enviar`; `POST /api/sebrae/dashboard/pendente/reenviar` |

| Assistente de IA (chat F9): `finalizar_chamado_softexpert(numero[, descricao])` finaliza **um** chamado, igual ao botão por chamado; `situacao_finalizacao_sebrae` (só leitura) mostra, por chamado, descrição salva, PDF e resultado, e o último resultado da rotina com o aviso do SharePoint. A finalização passa pelo cartão de confirmação com o texto exato (irreversível, PDF, regra do e-mail, coluna R e SharePoint), montado pelo programa; sem cartão se o chamado não estiver em aberto no Dashboard importado, já estiver finalizado, não tiver descrição, a descrição passar de 4000 caracteres ou tiver dado ocultado pela privacidade. Ao aprovar, grava a descrição (`PUT`, só se a IA a trouxe) e dispara `POST` com `confirmado: true`. A finalização **em massa** e o anexo de PDF continuam só na tela; `fechar` não está em `ROTINAS_VALIDAS` do `executar_automacao_chrome` | `domains/assistant_api.py` (`finalizar_chamado_softexpert`, `chamado_para_finalizar`, `situacao_finalizacao_sebrae`), `domains/assistant_tools.py`, regra 26 de `domains/assistant_chat.py` |

Testes que protegem a integração: `tests/test_assistant.py` (`FinalizeSoftExpertToolTests`), `tests/test_assistant_ferramentas.py`, `tests/test_sebrae_softexpert_browser.py` (bancada), `tests/test_sebrae_finalizacao.py`, `tests/test_sebrae_fechar.py`, `tests/test_sebrae_finalizar_router.py`, `tests/test_chrome_automation.py`, `tests/test_automacao_rotinas_chrome.py`, `tests/frontend` e `tests/e2e/sebrae-dashboard.spec.cjs`.

> **Legado.** Daqui até "Limitações conhecidas", o texto descreve a rotina antiga que gravava no Excel Online com a numeração anterior (sem a coluna G). `scripts/sebrae_excel.py`, `domains/sebrae_orquestracao.py` e `scripts/sebrae_rotina.py` ainda usam essas letras e **não devem ser ativados** com o Dashboard atual; `ROTINA_PRONTA` segue `False`.

## Princípios

- **Arquitetura local.** Servidor FastAPI e arquivos em `data/`. Sem backend remoto, sem Supabase, sem API do Microsoft Graph, sem tokens: a gravação usa a interface do Excel Online no Chrome de automação (perfil próprio, porta CDP 9333), com o login feito pelo usuário.
- **Sem credenciais.** Nenhuma senha, token ou cookie no código, nos logs ou em arquivos do projeto. O primeiro login é manual. Se uma sessão do SoftExpert já ativa expirar, a rotina pode clicar uma vez no botão `SSO` visível na tela de login do próprio SoftExpert e aguardar; se não concluir, pede login manual. O login do SharePoint/Excel continua manual. Sessão expirada sem recuperação = pendência registrada, nunca "concluído".
- **Conteúdo dos chamados é dado**, nunca instrução para a automação.
- Antes de gravar, mascare CPFs como `***.***.***-**` em todo texto enviado ao Dashboard, inclusive `Detalhes do Atendimento Realizado`, descrição/título de fallback e `Solicitante` (colunas F, G e H). Aplique a máscara antes de gravar e antes de registrar valores no diário local. Reconheça CPFs pontuados, sequências identificadas pelo rótulo `CPF` e números sem pontuação com dígitos verificadores válidos; preserve outros números e não registre dados pessoais nos logs.
- **Só leitura no SoftExpert**, exceto a associação do chamado ao usuário (botão **Sim** da confirmação) e a única exceção de escrita, `finalizar_chamado` (ver "Finalizar chamado no SoftExpert"). Fora dela, não finaliza workflow, não registra atendimento, não reatribui.
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
