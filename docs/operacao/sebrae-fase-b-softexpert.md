# Fase B — leitura do SoftExpert (Sincronizar chamados Sebrae)

Escopo: `scripts/sebrae_softexpert.py`, só leitura. A especificação geral está em `docs/operacao/sincronizar-chamados-sebrae.md`; a ligação com `rodar_rotina_sebrae` (triagem, decisão, Excel) é da Fase E.

## O que o módulo faz

Todas as funções recebem o `context`/`page` do Playwright já conectado ao Chrome de automação.

| Função | Papel |
| --- | --- |
| `abrir_softexpert(context)` | Abre `https://sebraepr.softexpert.app/softexpert/workspace?page=taskCenter` em aba nova, espera o login (se faltar) e a lista carregar. Devolve a aba. |
| `softexpert_logado(page)` / `tela_de_login(page)` | Sessão ativa = host do SoftExpert, sem campo de senha/URL de login e com a lista visível. |
| `garantir_login(page)` | No primeiro acesso, usa `aguardar_login` da rotina e deixa o login manual. Após uma sessão já ativa expirar, pode clicar uma vez no botão `SSO` visível no domínio do SoftExpert; se não concluir, pede login manual. Não digita credenciais. |
| `listar_chamados(page)` / `coletar_numeros(page)` | Percorre **toda** a lista (botão "Próxima" até desabilitar, ou rolagem até três voltas sem número novo) e devolve `ItemLista(numero, texto)` / só os números `UTIC-AAAA-N`, sem repetidos. Lista que não termina (`MAX_RODADAS_LISTA`) é falha, nunca resultado parcial. |
| `extrair_chamado(context, page, numero)` | Executar → Registro de Chamados, captura da janela PHP, confirmação "Sim", conferência de número e título, espera dos campos condicionais, releitura de campos vazios. Devolve `ChamadoSoftExpert` (descrição, solicitante, "Habilitada em", título). |
| `extrair_chamados(context, page, numeros)` | Vários chamados, um por vez; `ChamadoNaoConfere` e `ChamadoNaoEncontrado` ficam no resultado (o chamador os registra como pendência com `erro.motivo`); `SessaoExpirada` espera novo login e refaz o chamado uma vez. Confere o cancelamento entre chamados. |

Uso previsto pela Fase E:

```python
page = abrir_softexpert(context)
numeros = coletar_numeros(page)
t = triagem(numeros, numeros_do_dashboard(coluna_c))      # domains/sebrae_chamados.py
lidos = extrair_chamados(context, page, list(t.a_extrair))  # dict numero -> ChamadoSoftExpert | SoftExpertErro
```

Erros (`SoftExpertErro` deriva de `RotinaErro` do runner, mesmo se o runner for o `__main__`): `SessaoExpirada` (`sessao_expirada`), `ChamadoNaoConfere` (`numero_nao_confere`, `titulo_nao_confere`), `ChamadoNaoEncontrado` (`nao_encontrado_na_lista`), `SoftExpertErro` (`formulario_indisponivel`, `confirmacao_inesperada`). Cada um traz `.motivo`. Nenhum deixa a janela PHP aberta; a captura de tela do erro vai para `data/logs/automacao_chrome` pelo `registrar_erro` existente.

## Garantias de somente leitura

- O único clique que grava algo no SoftExpert é o **Sim** da confirmação de associar o chamado, dado uma única vez e só se o texto da pergunta falar de associar/vincular/assumir. Outra pergunta, ou a mesma voltando depois do Sim, interrompe com `confirmacao_inesperada` sem clicar; esse motivo encerra a execução inteira imediatamente, sem tentar outros chamados.
- `clicar()` recusa qualquer botão ou item de menu cujo rótulo case com `ROTULOS_PROIBIDOS` (finalizar, enviar, salvar, concluir, encerrar, reatribuir, atribuir, aprovar, reprovar, registrar atendimento, excluir, descartar…). Os únicos cliques da rotina são: linha da lista, Próxima, Executar, Registro de Chamados e Sim.
- O formulário nunca é preenchido nem enviado; a janela PHP é fechada sem salvar. Conteúdo lido (descrição, título) é dado: não é interpretado e não vai para o log (só números de chamado).
- Na recuperação de uma sessão expirada, o botão `SSO` só é acionado uma vez quando a tela de login do próprio SoftExpert mostra exatamente esse botão. A rotina espera a sessão; se o SSO não concluir, pede login manual. Nenhum dado de autenticação é armazenado.
- Sem senhas, tokens, cookies ou API: o login é do usuário, na janela do Chrome de automação.

## O que foi presumido (a validar com a sessão logada)

Tudo isto está no bloco `SELETORES` no topo do módulo; foi testado só na bancada.

1. **Lista** (cartões `rctCardBase` confirmados na tela real; o restante segue como hipótese): contêiner `[role=grid]`/`table.task-list`/`#taskCenterList`; linhas `tbody tr` ou `[role=row]` com `[role=gridcell]`; indicador de carregamento `.carregando/.loading/.spinner/[aria-busy]`; lista vazia com texto "Nenhum registro/resultado…".
2. **Identificador**: o primeiro `UTIC-AAAA-N` do texto da linha é o número do chamado (um título que cite outro número não o substitui).
3. **Paginação/rolagem**: botão ou link chamado "Próxima"/"Próxima página"; sem ele, a lista rola dentro do contêiner (ou da janela) e carrega lotes. Não há leitura de "total de registros" para conferir a contagem.
4. **Seleção e menu**: clicar na linha a seleciona e habilita o botão **Executar** (canto inferior direito); o menu mostra o item **Registro de Chamados**.
5. **Formulário**: `form#formulario`/`form[name=formulario]`/`.form-chamado`, em janela PHP nova (`context.on("page")`) ou na própria aba, inclusive dentro de iframes. Campos lidos pelo rótulo (`label for`, célula/irmão seguinte): *Número do chamado*, *Título*, *Descrição*, *Solicitante*, *Habilitada em* (variações em `ROTULOS_CAMPOS`). Não use *Iniciador* como fallback para *Solicitante*.
6. **Confirmação**: modal (`[role=dialog]` com botão "Sim") ou `window.confirm`, com texto contendo "associar/vincular/assumir".
7. **Login**: campo `input[type=password]` visível, ou URL com `/login`, `/signin`, `/sso` ou `login.microsoftonline.com`.
8. **Título**: o título do formulário precisa aparecer na linha da lista (a lista pode abreviá-lo com reticências).

## Leitura assistida da lista real (22/10/2026, somente leitura)

Feita pela extensão Claude in Chrome no Chrome do usuário (não no Chrome de automação), sem clicar em nada que altere estado: só abrir a URL, ler texto/DOM e rolar a lista.

- **Sessão**: a URL da central abriu em `/softexpert/login?page=taskCenter` (sessão expirada) com os botões `SSO` e `Usuário e senha`. Poucos segundos depois, o próprio SoftExpert concluiu o acesso e abriu `workspace?page=taskCenter` ("Central de tarefas"); o clique no `SSO` falhou porque o botão já tinha sumido, então **nenhum clique foi dado**. Ou seja, a retomada pode terminar sozinha; o código já espera a lista aparecer depois de acionar o SSO.
- **Lista (aba Execução, 35 tarefas)**: cada tarefa é um cartão `[data-test-selector="rctCardBase"]` com `task-title` (texto "Execução de atividade" + "NÚMERO - título"), `task-main-extra-info`, `task-deadline` e `task-extra-infos` (Habilitada em). Não há `role=grid`, `<table>` nem botão "Próxima": os cartões vão sendo carregados por rolagem do contêiner (um `div` com `overflow-y:auto`), em lotes: 8 cartões iniciais, 29 e depois 35 (a altura rolável passou de 1216 para 3892 e 4694 px). Depois de rolar até o fim, o DOM tinha 35 cartões, sem virtualização.
- **Conteúdo**: 33 chamados `UTIC-AAAA-N` e 2 tarefas `PRT-NNNNNN/AA` ("UTIC - Registrar Protocolo"), que não são chamados e ficam fora pelo padrão UTIC. `UTIC-2026-1253` e `UTIC-2026-1177` aparecem na lista. "Habilitada em" pode vir como "Ontem, 13:20:02" em vez de data completa; a hora completa deve vir do formulário.
- **Outros seletores vistos**: `taskCenterRefreshButton`, `GeneralSearchInput`, `rctAddFilterBtn`, `rctEmptyState-InfoMessage` (o elemento existe no DOM mesmo com a lista cheia, por isso não foi usado como aviso de lista vazia).
- **Aplicado no código**: `SEL_LISTA` e `SEL_LINHA` passam a incluir o cartão `rctCardBase`; a bancada ganhou o layout em cartões e um teste com 35 cartões em lotes de 8, 2 tarefas `PRT` e 33 chamados.
- **Continua não validado**: botão **Executar** e menu **Registro de Chamados** (inclusive onde ficam nos cartões, que têm dois botões sem rótulo no canto direito), janela PHP, confirmação de associar, rótulos reais dos campos do formulário e o indicador de carregamento. Tudo isso exige abrir um chamado, o que não foi feito nesta leitura.

## Sessão assistida necessária (com o usuário logado)

A lista real foi lida (seção acima). Falta o restante: abrir um chamado já conhecido. Para fechar a fase:

1. Com o usuário logado no Chrome de automação, abrir a central de tarefas e anotar o HTML da lista (contêiner, linha, paginação ou rolagem, indicador de carregamento) e da coluna que traz o número.
2. Escolher **um chamado já conhecido** e acompanhar manualmente Executar → Registro de Chamados: se abre janela PHP ou iframe, se há confirmação (modal ou nativa) e o texto exato, e os rótulos reais dos campos. Não finalizar, não registrar atendimento.
3. Ajustar as constantes do bloco `SELETORES` (e `ROTULOS_CAMPOS`) e repetir a leitura desse chamado conferindo número, título, descrição, solicitante e "Habilitada em".
4. Conferir se campos condicionais mudam a descrição depois de alguma seleção (a rotina só relê, nunca altera campos) e se `RELEITURAS_CAMPOS`/`ESPERA_RELEITURA_MS` bastam.
5. Conferir a contagem da lista com o total que a tela informar, se existir (candidato a verificação extra).

A execução controlada real (todas as fases juntas) continua sendo a Fase E.

## Testes

`tests/test_sebrae_softexpert_browser.py` roda a bancada local (HTTP em `127.0.0.1`, Chrome headless pela porta CDP própria, como em `tests/test_automacao_telas_browser.py`); pulado sem Chrome/Chromium/Playwright. Cobre: lista paginada (com linha sem número e título que cita outro número), lista com rolagem, lista vazia, tela de login e espera do login, sessão expirada na janela do chamado (com e sem novo login), janela PHP, mesma aba, confirmação modal, nativa e ausente, descrição tardia, descrição que nunca vem (usa o título), número e título que não conferem, chamado fora da lista, números com prefixo igual, falha isolada em lote, conteúdo hostil lido como dado e nenhum clique em ação de escrita. Nenhum chamado real é tocado.

```powershell
.venv\Scripts\python.exe -B -m unittest discover -s tests -p "test_sebrae_softexpert_browser.py" -v
```
