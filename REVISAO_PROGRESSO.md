# Revisão e progresso de correções — Simpress

Atualizado em 2026-10-03. Este documento registra a linha de base e o andamento das correções autorizadas.

## Escopo e entendimento inicial

- **Objetivo:** aplicação web local para pesquisar equipamentos, preparar transferências Simpress em Excel, atualizar e comparar inventários, manter apelidos e unidades, consultar históricos e exportar dados.
- **Tecnologias:** Python 3.12.14, FastAPI, pandas e openpyxl; interface em HTML, CSS e JavaScript; Tailwind, ícones e fontes locais; npm apenas para reconstruir os recursos da interface.
- **Áreas revisadas na auditoria anterior:** instruções e documentação, configuração, servidor e rotas, módulos de domínio, interface, planilhas e transações, testes e dependências.
- **Regras locais:** `.cursor/rules/simpress-sebrae-owned-series.mdc` estabelece cinco números de série de equipamentos do SEBRAE que devem ser excluídos das comparações e regras de classificação de hostnames de Curitiba. Os testes devem preservar essas regras.

## Estado inicial do repositório

Antes desta etapa, `git status --short --untracked-files=all` mostrou:

- Modificado: `planilhas_entrada/(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`.
- Não rastreados: `planilhas_entrada/.InvAllComputersSummary_atual.xlsx.5u17gu6j.tmp` e `planilhas_entrada/.InvAllComputersSummary_atual.xlsx.r2nuxxg7.tmp`.

Essas alterações e arquivos já existiam antes da criação deste registro e devem ser preservados. Também existem planilhas operacionais, históricos, cópias de segurança e dados locais ignorados pelo Git. Eles não devem ser usados como destinos de testes nem regravados durante correções.

## Linha de base das verificações

O executor `tests/run_tests.py` foi inspecionado antes da execução. Ele bloqueia a leitura de valores de planilhas e a recuperação de transações durante a descoberta/importação dos testes e direciona os testes de gravação para diretórios temporários. Os testes de fluxo criam planilhas fictícias e as pastas temporárias de teste foram removidas ao final. O teste de prontidão verifica a estrutura dos arquivos locais durante o ciclo de vida da aplicação; não testa nem altera valores operacionais.

| Verificação | Resultado |
| --- | --- |
| `.venv/Scripts/python.exe -B tests/run_tests.py` | **Passou:** 34 testes em 4,653 s. |
| Reexecução após o Prompt 1 | **Passou:** 36 testes em 4,787 s, incluindo dois novos testes de entrada de transação. |
| `.venv/Scripts/python.exe -B -m pip check` | **Passou:** nenhuma dependência quebrada. |
| `node --check static/app.js` | **Passou.** |
| `node --check scripts/copy_ui_assets.cjs` | **Passou.** |
| `node --check tailwind.config.cjs` | **Passou.** |
| Python do ambiente | Python 3.12.14. |
| Estado Git depois dos testes | Permaneceu igual ao estado inicial listado acima. |
| Diretórios temporários do executor e `.transactions` | Nenhum resíduo de teste ou transação pendente encontrado. |

Não foi executado `npm run build:ui`, pois ele reconstrói arquivos estáticos versionados e não é necessário para a linha de base. Não foram executados testes com navegador real, leitores de tela, carga extrema ou exploração de segurança.

## Achados da revisão — falhas existentes

“Confirmado” significa que a auditoria anterior reproduziu o comportamento com fixtures ou sondas isoladas, ou que o comportamento é diretamente demonstrado pelo código. “Suspeita/limite” identifica impacto ou condição de exploração que ainda precisa de validação específica. A suíte inicial passou, mas não contém testes de regressão dedicados para a maior parte destes achados.

| # | Gravidade | Achado e evidência | Estado inicial e teste associado |
| ---: | --- | --- | --- |
| 1 | Alta | A busca da transferência pode enviar o texto digitado, em vez da série completa do equipamento escolhido; uma busca parcial pode selecionar a primeira correspondência. A interface também pode manter seleção antiga após alteração, falha ou limpeza. Evidência: `static/app.js` e rota de consulta em `main.py`. | **Corrigido no Prompt 6.** A busca exata não retorna mais correspondências parciais; a geração exige que o texto corresponda ao serial completo do equipamento carregado; alteração, erro e limpeza invalidam buscas e limpam os dados de origem derivados da seleção. Testes cobrem consulta parcial, serial completo, texto alterado, respostas fora de ordem e cancelamento ao limpar. |
| 2 | Alta | A gravação de equipamento pode alterar vários `EquipamentosDetalhes*.xlsx`, e a seleção do arquivo ativo depende da data de modificação. Evidência: leitura e salvamento em `main.py`. | **Corrigido no Prompt 4.** A consulta registra em cache o arquivo e a aba que forneceram o equipamento. A edição bloqueia as fontes candidatas, revalida a fonte ativa e grava somente nela; mudança concorrente da fonte resulta em 409 antes da gravação. Fixture confirma que uma edição e recarga mantêm os outros equipamentos da fonte ativa e não alteram a cópia mais antiga. |
| 3 | Alta | A gravação de apelido pode não reconhecer o cabeçalho `Hostname` e escrever em uma coluna alternativa. Evidência: rota de edição em `main.py`. | **Reproduzido** com fixture: a rota informou sucesso, deixou o hostname original e gravou o novo valor na coluna de tipo. |
| 4 | Alta | Se a entrada de `AtomicFileTransaction` falha depois de adquirir o bloqueio global, recursos anteriores do `ExitStack` podem não ser liberados. Evidência: `integrity.py`, `AtomicFileTransaction.__enter__`. | **Corrigido no Prompt 1.** A entrada agora fecha recursos adquiridos, remove diretório parcial criado e preserva a exceção original; falhas secundárias de limpeza são anexadas como nota. Testes cobrem entrada normal, falha no bloqueio posterior, erro do callback de limpeza e nova aquisição por outra thread. |
| 5 | Alta | A atualização/restauração podia capturar o cache antes do bloqueio e restaurar uma cópia obsoleta após uma falha. Evidência: `domains/inventory_update.py`, `routers/inventory_history.py` e publicação do cache em `main.py`. | **Corrigido no Prompt 2.** Testes determinísticos intercalam uma gravação válida de apelido com falha de upload e com uma prévia de restauração desatualizada; ambos confirmam que o cache acompanha os arquivos. |
| 6 | Alta | Com série duplicada, a consulta pode exibir uma linha e a edição salvar outra. Evidência: construção e salvamento do cache em `main.py`. | **Corrigido no Prompt 4.** A gravação confirma que a série aparece uma única vez na aba e na fonte vinculadas ao cache. Registros duplicados, removidos desde a carga ou já existentes durante um novo cadastro recebem erro 409 antes de gravar. |
| 7 | Alta | A leitura do inventário com inferência automática de tipos pode remover zeros iniciais de séries numéricas. Evidência: `pandas.read_excel` no carregamento em `main.py`. | **Corrigido no Prompt 3.** A coluna identificada como série é lida sem inferência numérica; testes confirmam que o texto `001234` permanece intacto. Células armazenadas como números continuam sem zeros inferidos, pois eles não podem ser recuperados sem informação adicional. |
| 8 | Média | Remover um alias manual após a atualização do inventário pode retornar 409 quando a planilha já contém o valor da fonte, em vez do valor manual. Evidência: `routers/inventory_history.py`, fluxo de remoção de override. | **Reproduzido** com fixture: o fluxo rejeitou a remoção. A suíte existente cobre precedência de override em undo, não este ciclo de atualização e remoção. |
| 9 | Média | O processamento de tabelas Excel estruturadas pode tratar o valor de `ws.tables.items()` como se tivesse o atributo `ref`. Evidência: validação/gravação em `integrity.py`. | **Confirmado** para planilha com tabela estruturada. A suíte atual cobre recursos embutidos recusados, não tabelas estruturadas suportadas. |
| 10 | Média | A normalização de cabeçalhos do upload difere da seleção da planilha ativa; um cabeçalho acentuado pode ser aceito e depois não carregado. Evidência: validação e seleção de abas/cabeçalhos em `main.py`. | **Corrigido no Prompt 3.** Upload, seleção da aba ativa e extração de campos agora aplicam a mesma normalização de caixa, acentos e separadores. Testes cobrem variantes e a passagem da validação de upload para o carregamento normal. |
| 11 | Média | IDs de unidades podem ser derivados da posição ordenada, enquanto a gravação procura o ID persistido. Evidência: listagem e salvamento de unidades em `main.py`. | **Reproduzido** com unidade de ID não sequencial; a interface mostrou outro ID e a gravação podia criar duplicata. Sem teste de regressão específico. |
| 12 | Média | Depois de restaurar inventários, a interface recarrega histórico e estatísticas, mas pode conservar unidades, equipamento e origem antigos. Evidência: fluxo de restauração em `static/app.js`. | **Confirmado pela implementação**, sem teste em navegador real. A suíte não verifica invalidação do estado da interface após restauração. |
| 13 | Média | A exportação pode ficar indisponível quando não há mudanças de apelido, apesar de existirem mudanças de `IdCliente` que a exportação aplica. Evidência: disponibilidade e exportação em `static/app.js` e `main.py`. | **Reproduzido** com fixture de exportação. Os testes cobrem alterações de apelido, mas não o caso isolado de `IdCliente`. |
| 14 | Média | O contrato de transferência permite campos essenciais vazios e a validação do servidor não os rejeita. Evidência: modelo e validação em `routers/transfers.py`. | **Corrigido no Prompt 6.** O servidor rejeita serial, CNPJ e endereço de origem/destino vazios ou compostos por espaços antes de abrir o modelo. Teste confirma as cinco rejeições e a geração normal fictícia continua coberta. |
| 15 | Média | A formatação de telefone assume celular com nove dígitos e pode deslocar DDD/dígitos em linhas fixas ou valores com +55. Evidência: `routers/transfers.py` e `static/app.js`. | **Corrigido no Prompt 6.** As máscaras do cliente e servidor diferenciam telefones fixos de celulares e removem prefixos `+55`, `0055` e `55` nos comprimentos nacionais correspondentes; ramais explícitos são preservados. Testes cobrem fixos e celulares com e sem prefixo. |
| 16 | Média | A atualização assíncrona executa validação, I/O e recarga síncronos dentro de função `async`, podendo bloquear outras requisições. Evidência: `domains/inventory_update.py`. | **Confirmado pelo fluxo de execução**; não foi feito teste de carga ou medida de latência. A suíte não testa responsividade durante atualização. |
| 17 | Média | Limites do pacote XLSX não limitam suficientemente linhas e colunas anunciadas; a leitura pode percorrer dimensões excessivas. Evidência: validação e percurso de planilha em `main.py`. | **Parcialmente confirmado:** arquivo sintético pequeno com dimensão extrema foi aceito na checagem estrutural. O custo de varredura e saturação não foi medido; risco de impacto permanece suspeito. |
| 18 | Média | Middleware verifica `Origin` apenas quando presente e não restringe `Host`. Evidência: middleware em `main.py`. | **Comportamento reproduzido** com host arbitrário e sem `Origin`, que recebeu 200 em sonda isolada. Cenários completos de DNS rebinding/exploração não foram testados. |
| 19 | Média | Cabeçalho da página pode ficar acima dos diálogos modais pela ordem de `z-index`, deixando controles do fundo interativos. Evidência: `static/app.css` e diálogos em `static/index.html`. | **Confirmado pelo CSS/HTML**, sem inspeção visual, teste de foco ou leitor de tela em navegador real. |

## Sugestões de melhoria — não são falhas confirmadas

| Gravidade | Sugestão e evidência | Estado inicial |
| --- | --- | --- |
| Média | Exibir na interface a prontidão das funções e dos arquivos locais. A verificação já existe no início do servidor e tem testes em `main.py` e `tests/test_maintenance_contracts.py`; a sugestão é torná-la visível na interface. | Melhoria opcional, depende do fluxo de produto desejado. |
| Média | Ampliar os testes de regressão para concorrência, restauração, casos de erro e estado da interface. | Recomendado para reduzir regressões; não é um defeito por si só. |
| Baixa | Consolidar normalizações repetidas de cabeçalhos, identificadores e telefones, somente quando as regras forem realmente equivalentes. | Melhor avaliar após corrigir e testar os fluxos atuais. |
| Baixa | Tornar portável o caminho do interpretador Python configurado no editor. Evidência: `.vscode/settings.json`. | Melhoria de manutenção; não impede a aplicação de funcionar. |

## Limitações da revisão

- Não foi feita validação em navegador real de acessibilidade, foco, interação modal ou seleção assíncrona.
- Não foram feitos testes de carga, varredura integral de exploração de segurança nem auditoria completa de vulnerabilidades das dependências. `pip check` verifica consistência instalada, não vulnerabilidades.
- A aceitação de dimensões XLSX extremas foi demonstrada; não foi executada uma leitura que pudesse consumir recursos excessivos.
- Parte dos comportamentos de segurança tem condições de exploração que permanecem por validar em ambiente representativo.
- Recomendações de novas regras de negócio devem continuar limitadas ao comportamento e às regras documentadas, incluindo as exceções do SEBRAE.

## Acompanhamento

### Prompt 1 — liberação de bloqueios durante a entrada

- **Arquivos alterados:** `integrity.py` e `tests/test_integrity_transactions.py`.
- **Correção:** `AtomicFileTransaction.__enter__` agora trata exceções em toda a sequência de aquisição e inicialização. Fecha o `ExitStack` em falhas, registra eventuais erros de limpeza sem substituir a exceção original e remove a pasta parcial da transação se ela já tiver sido criada.
- **Testes adicionados:** entrada/saída normal e falha simulada ao adquirir o bloqueio do destino depois do bloqueio global. O teste injeta também uma falha secundária de limpeza, verifica que o erro original continua sendo lançado e confirma que outra thread consegue abrir uma nova transação.
- **Verificações:** suíte completa passou (36 testes); `git diff --check` passou. O executor removeu suas pastas temporárias e não deixou transações pendentes.
- **Dados operacionais e mudanças preexistentes:** os arquivos de modelo e temporários listados no estado inicial foram preservados; nenhum arquivo de aplicação além dos dois arquivos de código acima foi alterado.

### Prompt 2 — consistência de cache e transações de inventário

- **Arquivos alterados:** `main.py`, `domains/inventory_update.py`, `routers/inventory_history.py`, `tests/test_integrity_workflows.py` e este registro.
- **Correção:** o cache anterior agora é capturado somente depois que a transação adquire os bloqueios dos arquivos. Em caso de falha, a reversão do cache ocorre ainda sob esses bloqueios. A gravação de equipamento e a edição de apelido também publicam o cache antes de liberar o bloqueio da transação.
- **Testes adicionados:** uma gravação manual de apelido concluída enquanto um upload aguarda o bloqueio, seguida de falha no histórico do upload; e uma restauração cuja prévia fica desatualizada enquanto ela aguarda o bloqueio. Os testes usam apenas arquivos fictícios dentro de diretórios temporários.
- **Verificações:** compilação Python passou; suíte completa passou com 38 testes; `git diff --check` passou. O servidor local foi reiniciado em `127.0.0.1:8000`; `GET /`, `GET /api/stats` e `GET /openapi.json` responderam corretamente. As chamadas da verificação foram somente de leitura.
- **Dados operacionais e mudanças preexistentes:** upload e restauração não foram executados contra as planilhas locais. As verificações no servidor foram somente de leitura; o modelo de transferência alterado e os arquivos temporários preexistentes foram preservados.

### Prompt 3 — preservar séries e unificar cabeçalhos

- **Arquivos alterados:** `main.py`, `tests/test_integrity_workflows.py` e este registro.
- **Correção:** reconhecimento de cabeçalhos agora remove diferenças de caixa, acentos e separadores de forma consistente no upload, na escolha da aba ativa e na extração dos campos. A leitura normal aplica tipo `object` somente às colunas reconhecidas como número de série, preservando séries que já estão armazenadas como texto e mantendo a inferência de tipos das demais colunas.
- **Limitação documentada:** quando a célula da série já está armazenada como número e não contém informação sobre zeros à esquerda, o carregamento não tenta inventá-los. Por exemplo, o número `1234` continua `1234`; não é convertido em `001234`.
- **Testes adicionados:** variantes de cabeçalho com diferenças de caixa, acentos e separadores; planilha aceita pelo upload e carregada pelo fluxo normal; série textual `001234`, série vazia, série numérica `1234` e tipo numérico mantido em `IdCliente`.
- **Verificações:** `.venv/Scripts/python.exe -B tests/run_tests.py` passou com 40 testes. Os testes criaram planilhas fictícias em diretórios temporários; não leram nem alteraram planilhas operacionais.
- **Dados operacionais e mudanças preexistentes:** o arquivo de modelo de transferência já modificado e os dois arquivos temporários listados no estado inicial foram preservados; nenhum upload ou gravação operacional foi executado.

### Prompt 4 — selecionar e gravar a fonte correta de equipamentos

- **Entendimento das fontes:** `README.md` define como fonte ativa o inventário válido mais recente em `planilhas_entrada`; backups das atualizações ficam em `_backups`, fora da busca das fontes. O carregador consulta somente essa fonte ativa.
- **Arquivos alterados:** `main.py`, `static/app.js`, `tests/test_integrity_workflows.py` e este registro.
- **Correção:** o cache agora guarda o caminho e a aba da fonte que carregou cada equipamento. A edição bloqueia as fontes candidatas, confirma que a origem armazenada ainda corresponde à fonte ativa e altera somente essa planilha e essa aba. A seleção por data continua coerente porque uma gravação só atualiza a data da fonte que já era ativa. A gravação exige que séries editadas existam uma única vez; cadastros novos precisam ser identificados explicitamente e só são incluídos se a série não existir. Mudança da fonte, ausência do registro ou ambiguidade retorna erro 409 antes de gravar.
- **Testes adicionados:** duas planilhas fictícias com registros diferentes; edição seguida de recarga sem troca da fonte ativa nem desaparecimento dos demais registros; preservação byte a byte da cópia antiga; recusa de série duplicada, registro removido após a carga e fonte ativa mudada; cadastro novo explícito; falha simulada de gravação preservando arquivo e cache.
- **Verificações:** `.venv/Scripts/python.exe -B tests/run_tests.py` passou com 46 testes; `node --check static/app.js` e `git diff --check` passaram. Os testes usaram arquivos temporários e dados fictícios, sem ler ou alterar planilhas operacionais.
- **Dados operacionais e mudanças preexistentes:** o modelo de transferência alterado e os dois temporários preexistentes foram preservados; nenhuma gravação foi feita em inventário operacional.

### Prompt 5 — corrigir edição e remoção de apelidos e preservar tabelas Excel

- **Arquivos alterados:** `main.py`, `routers/inventory_history.py`, `integrity.py`, `tests/test_integrity_workflows.py` e este registro.
- **Achado 3:** a gravação de apelidos agora usa os cabeçalhos suportados para número de série e alias, incluindo `Hostname`, sem presumir números de coluna. Se faltar um cabeçalho válido, a operação retorna erro 409 antes de salvar.
- **Achado 8:** ao remover um override depois de atualizar o inventário, a conferência compara a célula com o alias de EquipamentosDetalhes registrado na atualização, em vez de compará-la com o override manual antigo. A remoção aplica o alias efetivo da fonte respeitando a prioridade do hostname único da InvAll sobre EquipamentosDetalhes.
- **Achado 9:** a captura das referências de tabelas estruturadas agora consulta objetos Table da API do openpyxl; edições não falham ao inspecionar `ws.tables.items()` e mantêm a referência da tabela.
- **Testes adicionados:** gravação de `Hostname` em diferentes posições sem alterar `Tipo` ou outros campos; rejeição clara de planilha sem coluna de alias reconhecida; fluxo completo de definir alias manual, atualizar as fontes e remover o override com prioridade da InvAll, preservando a tabela estruturada e sua referência.
- **Verificações:** `.venv/Scripts/python.exe -B tests/run_tests.py` passou com 49 testes. Os testes usaram apenas planilhas fictícias temporárias; não alteraram inventários, históricos ou backups operacionais.
- **Dados operacionais e mudanças preexistentes:** o modelo de transferência modificado e os dois temporários listados no início foram preservados.

Os achados 1 a 10, 14 e 15 estão concluídos. Os achados 11, 12, 13, 16, 17, 18 e 19 continuam abertos até serem corrigidos, refutados com evidência ou explicitamente aceitos como pendência. Antes de cada etapa, confirme o estado do repositório e preserve as alterações preexistentes listadas acima.

### Prompt 6 — corrigir seleção e validação das transferências

- **Arquivos alterados:** `main.py`, `routers/transfers.py`, `static/app.js`, `static/index.html`, novo `static/transfer-utils.js`, `tests/test_integrity_workflows.py`, `tests/test_maintenance_contracts.py`, novo `tests/test_transfer_workflows.cjs` e este registro.
- **Correção:** a rota de equipamento agora aceita apenas série exata; a busca textual continua retornando opções para seleção explícita. O navegador invalida requisições e seleção anterior ao editar ou limpar a pesquisa, ignora respostas fora de ordem e só monta a transferência se o serial completo corresponder ao equipamento selecionado. O servidor valida serial, CNPJ e endereço de origem e destino antes de abrir o modelo. A formatação diferencia telefones fixos e móveis, aceita códigos de país brasileiros e preserva ramais explícitos.
- **Regras de negócio:** não foram alteradas as exceções de pausa do SEBRAE, nem as regras dos seriais pertencentes ao SEBRAE ou classificações de hostname.
- **Testes:** adicionados testes para busca parcial/exata, seleção somente do serial completo, texto de pesquisa alterado, respostas fora de ordem, limpeza durante uma busca, cinco campos essenciais vazios, telefones nacionais/internacionais e a montagem normal do documento com dados fictícios.
- **Verificações:** `.venv/Scripts/python.exe -B tests/run_tests.py` passou com 52 testes; `node --test tests/test_transfer_workflows.cjs` passou com 5 testes; `node --check static/app.js`, `node --check static/transfer-utils.js` e `git diff --check` passaram. Não foi feita validação visual em navegador nesta etapa.
- **Dados preexistentes:** o modelo Excel modificado e os dois temporários existentes foram preservados e ficaram fora das alterações desta etapa.
