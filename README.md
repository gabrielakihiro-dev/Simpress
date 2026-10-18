# Simpress — Transferência e Inventário de Equipamentos

Aplicação web local para consultar equipamentos, preparar transferências Simpress, comparar inventários e exportar uma planilha de equipamentos atualizada. O servidor usa FastAPI; a interface e os dados operacionais ficam no computador em que o projeto está instalado.

## Recursos

- Busca por número de série, código de barras, apelido/hostname, modelo ou cidade. A busca completa pode ser filtrada por categoria e cidade.
- Geração e download da planilha oficial de transferência a partir do modelo local.
- Acompanhamento de Chamados que relaciona as séries e as OS das exportações Simpress e Oracle, com conferência de divergências.
- Importação automática desse par de planilhas por lotes em pastas locais, com validação, histórico, proteção contra reimportação e recibos de processamento.
- Textos prontos para solicitações de transporte, kit de teclado e mouse e defeitos, com opções para copiar o texto e abrir os links correspondentes.
- Edição de apelidos e de outros campos permitidos do equipamento, com histórico e opção de desfazer alterações de apelido.
- Comparação e atualização conjunta dos inventários Endpoint e Simpress, com histórico, backups locais e prévia de restauração.
- Central de pendências e comparação da evolução entre atualizações.
- Exportação de `Apelido` e, quando disponível, `IdCliente` para um modelo Excel local.
- Catálogo de unidades, endereços, CNPJ e CEP, incluindo unidades personalizadas.

## Requisitos

- Windows 10 ou superior.
- Python 3.12 ou superior.
- O servidor usa os arquivos locais já compilados da interface. Node.js e npm são necessários para reconstruir esses arquivos, executar os testes JavaScript.
- Não é necessário ter acesso à internet para abrir a aplicação e carregar a interface. Os links para os sistemas de chamados da Simpress abrem páginas externas.

O repositório é privado; a conta usada para cloná-lo precisa ter acesso.

## Instalação

Clone o projeto ou abra o PowerShell na pasta existente:

```powershell
git clone https://github.com/gabrielakihiro-dev/Simpress.git
cd Simpress
```

O inicializador `iniciar_servidor.bat` prepara automaticamente o ambiente na primeira execução: cria `.venv` e instala as dependências fixadas. Isso requer Python 3.12 ou superior e conexão com a internet na primeira instalação. Nas próximas inicializações, a instalação só se repete quando os arquivos de dependências mudarem.

Se o `pip` estiver ausente na `.venv`, o inicializador tenta recuperá-lo automaticamente com `ensurepip` e reinstala as dependências. A recuperação do `pip` usa os arquivos incluídos no Python; a instalação das dependências requer internet.

Para preparar o ambiente manualmente — por exemplo, se for iniciar o servidor diretamente pelo Python — use Python 3.12 ou superior. No Windows, use o Python Launcher:

```powershell
py -3 -m venv .venv
```

Se o comando `py` não estiver instalado, use `python` — confirme que aponta para Python 3.12 ou superior:

```powershell
python -m venv .venv
```

Confira a versão do ambiente:

```powershell
.\.venv\Scripts\python.exe --version
```

Instale as dependências fixadas pelo projeto:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

No VS Code, o interpretador configurado para este workspace é `.venv\Scripts\python.exe`. Se necessário, selecione esse caminho manualmente.

## Planilhas e arquivos locais

Os caminhos são relativos à pasta do projeto e estão definidos em [core/config.py](core/config.py). Dados operacionais ficam em `data/`, e o modelo de exportação continua em `modelos/`. Não é necessário criar um arquivo `.env`; o programa não o carrega.

Na primeira inicialização após atualizar uma instalação existente, o inicializador move os arquivos das pastas antigas para `data/`. A migração primeiro tenta concluir recuperações registradas em `.transactions`; se a recuperação falhar ou houver um upload temporário, ela interrompe sem mover os arquivos. Ela preserva os caminhos relativos dos backups e não sobrescreve destinos diferentes. Feche qualquer outro servidor antes de executar `scripts/migrate_local_data.py` manualmente.

Antes de iniciar o servidor, a limpeza recupera transações e considera temporários com pelo menos 24 horas. Ela remove apenas cópias com o mesmo conteúdo do arquivo de destino, enquanto mantém versões diferentes para revisão. Para visualizar o relatório sem remover nada, execute `scripts/cleanup_local_temps.py` sem `--apply`.

| Arquivo | Local | Uso |
| --- | --- | --- |
| `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` | `data/planilhas_entrada` | Modelo da planilha oficial, versionado no Git. É necessário para gerar transferências, mas sua ausência não impede o servidor de iniciar. |
| `EquipamentosDetalhes*.xlsx` | `data/planilhas_entrada` | Inventário principal da busca. Na inicialização, o sistema usa o arquivo válido mais recente. |
| `EquipamentosDetalhes_atual.xlsx` | `data/planilhas_entrada` | Destino da atualização Simpress, extraído do workbook contido no ZIP `EquipamentosDetalhes` enviado para a atualização. É a fonte oficial da composição e contagem do cadastro; não some registros da InvAll nem de snapshots anteriores. |
| `InvAllComputersSummary_atual.xlsx` | `data/planilhas_entrada` | Fonte auxiliar de hostname por série e comparação. Não adiciona equipamentos à base oficial. |
| `EquipamentosDetalhes-exportacao.xlsx` | `modelos` | Modelo local de exportação. Não é distribuído pelo Git. |
| `apelidos_modificados.json` | `data/state/apelidos_modificados` | Apelidos personalizados locais. O arquivo, temporários e bloqueios não são versionados. |
| `historico_comparacoes.json` | `data/state/historico_comparacoes` | Histórico local de comparações. O arquivo, temporários e bloqueios não são versionados. |
| `historico_chamados.json` | `data/state` | Até 50 versões importadas da relação Simpress/Oracle, com comparação, fila de atenção e exportação filtrada; o arquivo, temporários e bloqueios não são versionados. |
| Lotes para atualização automática | `data/state/entrada_automatica` | Fila local de entrada, arquivos processados e lotes com falha; não é versionada. |
| Lotes para chamados Simpress/Oracle | `data/state/entrada_chamados` | Fila local para importar automaticamente o par de planilhas de chamados; os arquivos e resultados ficam fora do Git. |
| Catálogo de unidades e histórico de apelidos | `data/state` | Estado local da aplicação; não é distribuído pelo Git. |

As planilhas operacionais e o modelo de exportação precisam ser fornecidos localmente. Se estiverem ausentes, somente as funções que dependem desses arquivos ficam indisponíveis; o servidor e as demais áreas continuam acessíveis. Não coloque dados reais no repositório.

### Cabeçalhos dos inventários

Os cabeçalhos devem estar na primeira linha de uma aba com dados. O sistema normaliza espaços, acentos e pontuação e recusa cabeçalhos repetidos ou ambíguos.

- **EquipamentosDetalhes:** número de série (`NumeroSerie`, `Numero de Serie` ou `Serial`), apelido/hostname (`Apelido`, `Hostname`, `Nome do Computador` ou `ComputerName`), `Modelo` e `Cidade`.
- **Endpoint:** nome do computador (`Nome do Computador`, `ComputerName` ou `Hostname`) e número de série/rótulo de serviço (`Rotulo de Servico Numero de Serie`, `NumeroSerie`, `Numero de Serie`, `Serial` ou `ServiceTag`).
- **Modelo de exportação:** precisa ter colunas de número de série e `Apelido`. A coluna `IdCliente` é atualizada quando existe nos dois arquivos.

Para escolher a aba automaticamente, o arquivo enviado deve conter somente uma aba que corresponda aos cabeçalhos exigidos para aquele inventário. Se mais de uma aba for compatível, a atualização é recusada para evitar comparar a tabela errada.

Quando o CNPJ da unidade de instalação estiver disponível em `CNPJ Instalacao` ou `CNPJ de Instalacao`, esse valor pode ser usado. O CNPJ de faturamento não é usado como substituto.

### Contato padrão da retirada

O contato de retirada (nome, e-mail e celular) é dado pessoal e não fica no código. Cada campo é lido nesta ordem:

1. variável de ambiente (`SIMPRESS_TRANSFER_ORIGIN_CONTACT`, `SIMPRESS_TRANSFER_ORIGIN_EMAIL`, `SIMPRESS_TRANSFER_ORIGIN_PHONE`);
2. arquivo local `config/contato_origem.json`, ignorado pelo Git;
3. vazio.

Sem dados, a aba **Transporte** mostra um aviso com o botão **Configurar contato de origem**, que grava `config/contato_origem.json` sem reiniciar o servidor. Para criar o arquivo manualmente, copie o exemplo com dados fictícios e edite os valores:

```powershell
Copy-Item config\contato_origem.exemplo.json config\contato_origem.json
```

As variáveis de ambiente têm prioridade sobre o arquivo. Defina-as no PowerShell antes de iniciar o servidor; reinicie o processo depois de alterá-las.

```powershell
$env:SIMPRESS_TRANSFER_ORIGIN_CONTACT = "Nome do contato"
$env:SIMPRESS_TRANSFER_ORIGIN_EMAIL = "contato@empresa.com"
$env:SIMPRESS_TRANSFER_ORIGIN_PHONE = "(41) 00000-0000"
```

## Iniciar e abrir a aplicação

Execute:

```powershell
.\iniciar_servidor.bat
```

O inicializador cria ou atualiza o ambiente `.venv` quando necessário, executa a migração e a recuperação/limpeza seguras dos dados locais e abre o servidor. A prontidão das funções é informativa e a ausência de planilhas ou modelos locais não impede o startup. Para iniciar sem o arquivo `.bat`, prepare manualmente o ambiente como descrito em **Instalação** e use:

```powershell
.\.venv\Scripts\python.exe scripts\migrate_local_data.py
.\.venv\Scripts\python.exe scripts\cleanup_local_temps.py --apply
.\.venv\Scripts\python.exe main.py
```

Abra no navegador:

- Aplicação (porta padrão): <http://127.0.0.1:8000>
- Documentação interativa da API: desligada por padrão. Para desenvolvimento, defina `$env:SIMPRESS_ENABLE_DOCS = "1"` antes de iniciar e abra <http://127.0.0.1:8000/docs>.

Se o iniciador escolher outra porta, use o endereço que ele mostrar no terminal.

O iniciador usa `127.0.0.1:8000` quando disponível. Se outra aplicação ocupar essa porta, ele escolhe uma porta livre entre `8001` e `8099`; se o Simpress já estiver ativo nesse intervalo, abre a instância existente em vez de iniciar outra. O servidor continua restrito ao computador local. Para encerrar uma instância, volte à janela que a iniciou e pressione `Ctrl+C`.

Na inicialização, o terminal e a aplicação mostram quais arquivos locais estão disponíveis e quais funções dependem deles. O painel **Ver detalhes de arquivos e funções** informa o impacto de cada ausência; **Atualizar status** repete a verificação. Esse botão verifica disponibilidade e formato do arquivo, mas não recarrega os equipamentos na memória. Para carregar arquivos alterados manualmente, reinicie o servidor; no uso normal, atualize os inventários pela própria aplicação.

| Função | Dependências principais |
| --- | --- |
| Busca de equipamentos | Um `EquipamentosDetalhes*.xlsx` válido e os catálogos locais. |
| Geração de transferência | Modelo `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`. |
| Comparação/atualização | Inventários Endpoint e Simpress enviados no fluxo. |
| Exportação Excel | Inventário principal válido e `modelos/EquipamentosDetalhes-exportacao.xlsx`. |

## Como usar

### Pesquisar equipamento

Na aba **Home**, pesquise por série, código de barras, apelido/hostname, modelo ou cidade. Pressione `Enter` ou clique em **Buscar Equipamento**. A lista rápida mostra até 15 resultados; **Mostrar mais** abre a pesquisa completa, que apresenta o total e carrega até 50 resultados por vez com **Carregar mais**.

Na pesquisa completa, combine os filtros de categoria e cidade. As categorias são **Notebooks**, **MacBooks**, **Monitores** e **Fones**. A classificação considera o tipo e o modelo da planilha; por exemplo, monitores também são identificados pelo modelo e MacBooks aparecem separados dos outros notebooks.

### Gerar transferência

1. Pesquise o equipamento na aba **Home** e confira os dados encontrados.
2. Abra manualmente a aba **Retirada e Entrega**.
3. Revise a origem e o destino, incluindo CNPJ, endereço e contatos. O catálogo de unidades pode ajudar a preencher os dados.
4. Preencha os campos obrigatórios e clique em **Gerar Planilha** no rodapé.
5. Abra o arquivo baixado e confira os dados antes de encaminhá-lo.

Para gerar a planilha, são obrigatórios: série do equipamento; CNPJ e endereço de retirada e entrega; nome, e-mail e telefone do contato de retirada; observações da retirada; nome, e-mail e telefone do destinatário; horário, almoço e observações da entrega. A duração da pausa da unidade de entrega também é obrigatória, exceto quando o horário de almoço indica que o escritório não fecha. O arquivo é preparado para download e não fica guardado como arquivo permanente pelo servidor.

Em **Acompanhamento de Chamados**, confira o histórico da relação entre o Excel **Acompanhamento de Pedidos** da Simpress e o Excel **Gestão de Solicitações** do Oracle. A aplicação relaciona as linhas pelo número de série e apresenta a OS de cada fonte, a solicitação Oracle e seus status. Quando as fontes tiverem OS diferentes para a mesma série, o registro é marcado para conferência. Para executar a importação operacional, use a fila local de pastas descrita a seguir; ela não depende do envio de arquivos pelo navegador nem de uma chamada HTTP.

Na aba **Home**, **Mostrar textos para chamados** apresenta textos editáveis relacionados ao equipamento. Use **Copiar** para levar o texto ao chamado; os botões **Link** abrem os sistemas externos correspondentes.

#### Importar chamados pela pasta do projeto

Para executar uma OS, use a fila local em vez do formulário web ou de uma rota HTTP/HTTPS. Crie um lote com identificador exclusivo em `data/state/entrada_chamados/pendentes` e coloque exatamente um arquivo `.xlsx` em cada subpasta `simpress` e `oracle`. Preserve os arquivos de origem; o importador verifica se o par permaneceu estável em duas leituras, valida e reconcilia os workbooks, registra um novo evento no histórico de chamados e move o lote completo para `processadas`. Lotes recusados ficam em `falhas` com `_resultado.json`; nada é apagado. Lotes interrompidos são recuperados na inicialização, e um lote já registrado não é importado novamente.

```text
data/state/entrada_chamados/pendentes/2026-10-10_os-simpress/
├── simpress/
│   └── Acompanhamento_de_pedidos.xlsx
└── oracle/
    └── Gestao_de_Solicitacoes.xlsx
```

O servidor verifica a pasta a cada 10 segundos; com ele ativo, a importação começa após duas verificações estáveis (cerca de 20 segundos). Confirme `status: concluido` em `processadas/<lote>/_resultado.json` e a nova versão no histórico visual. Se o servidor não estiver ativo, processe uma vez pela rotina local:

```powershell
.\.venv\Scripts\python.exe scripts\process_ticket_inbox.py
```

O comando usa a mesma validação sem enviar requisições HTTP. Se o site estiver aberto, ele percebe em até 10 segundos as planilhas trocadas pelo comando e recarrega a base sozinho. Consulte `data/state/entrada_chamados/README.md` para ver o modelo de lote e um exemplo no PowerShell. A variável `SIMPRESS_TICKET_IMPORT_INBOX_DIR` permite definir outra raiz local. A fila funciona no modo de arquivos; não inclui os lotes operacionais no Git.

### Comparar e atualizar inventários

Use **Pendências** para revisar e anotar as linhas da atualização mais recente; **Evolução das atualizações** conta casos novos, contínuos e resolvidos entre duas atualizações completas.

1. Abra **Atualizar Planilhas**.
2. Selecione um arquivo `.xlsx` do **Endpoint** e um `.xlsx` ou `.zip` do **Simpress**.
3. Clique em **Pré-visualizar impacto** e confira as contagens de séries novas, removidas e duplicadas antes de **Confirmar substituição**. A prévia vale por dez minutos e precisa ser refeita se os arquivos ou a base ativa mudarem.
4. Cada atualização substitui integralmente os dois inventários ativos pelos arquivos validados; séries ausentes no novo relatório deixam de compor a base carregada. Após confirmar, confira ausências em cada fonte, notebooks sem verificação com êxito há 7 dias ou mais, divergências de local, correspondências ambíguas, mudanças de hostname e casos que precisam de revisão.
5. Consulte **Histórico planilhas** para rever comparações e, se houver um backup completo válido, pré-visualize os arquivos e datas antes de restaurar.

A prévia também funciona na primeira importação, quando ainda não há inventário local. O processamento automático pela pasta de entrada mantém seu fluxo próprio.

#### Processar atualizações pela pasta de entrada

Para preparar automaticamente o par recém-exportado de Downloads, registre o horário de início **antes** das exportações e execute o preparador depois de acionar os dois downloads:

```powershell
$inicioInventarios = (Get-Date).ToString("o")
# Exporte UX Simpress (contrato 16467) e Endpoint Central no Chrome.
& .\.venv\Scripts\python.exe scripts\prepare_inventory_downloads.py --since $inicioInventarios
```

O preparador seleciona o download mais recente de cada fonte posterior ao horário informado: `InvAllComputersSummary*.xlsx` ou `.zip` para Endpoint e `EquipamentosDetalhes*.xlsx` ou `.zip` para Simpress. Um ZIP precisa conter exatamente um XLSX. Os originais permanecem em Downloads; a cópia do par completo é publicada de uma só vez na fila, com `_origem.json` contendo nomes, datas e hashes SHA-256. Sem os dois arquivos recentes, nenhum lote é publicado. Repetir o comando com o mesmo horário e par retorna o lote existente, inclusive se estiver em `falhas`, sem criar outra atualização.

Se o servidor estiver parado, processe a fila diretamente, sem upload HTTP:

```powershell
& .\.venv\Scripts\python.exe scripts\process_inventory_inbox.py
```

O comando usa o importador e a transação existentes. Confira `processadas/<lote>/_resultado.json` com `status: concluido` e o evento com `importacao_automatica_id` no histórico; a contagem do comando também inclui lotes arquivados por falha e não substitui o recibo. Prefira o importador do servidor quando ele estiver ativo, para manter seus dados em memória atualizados. A sincronização das anotações continua usando a pasta compartilhada já configurada e sua fila de pendências; os comandos não publicam planilhas em serviços externos.

Procedimento de exportação e importação: [Exportações de planilhas — UX Simpress + Endpoint Central](https://app.notion.com/p/Exporta-es-de-planilhas-UX-Simpress-Endpoint-Central-3f5922a10077801f99e2e26a4fee14b9). Acione cada exportação uma vez e prossiga; confira Downloads depois das duas ações. Autenticação de dois fatores e bloqueios do navegador podem exigir intervenção do usuário.

Com o servidor local em execução, também é possível colocar os dois arquivos em um lote na pasta `data/state/entrada_automatica/pendentes`. O sistema verifica a fila a cada 10 segundos e usa a mesma validação, comparação, backups, histórico e transação da atualização manual.

Crie uma pasta de lote com nome exclusivo e esta estrutura. Os nomes dos arquivos `.xlsx` podem ser os originais:

```text
data/state/entrada_automatica/pendentes/2026-10-09_lote-001/
├── endpoint/
│   └── InvAllComputersSummary.xlsx
├── simpress/
│   └── EquipamentosDetalhes.xlsx
```

Copie um arquivo para cada pasta de origem. Assim que os dois `.xlsx` aparecerem e permanecerem estáveis em duas verificações consecutivas, o importador processará o lote; cada pasta deve conter exatamente um `.xlsx` e cada arquivo respeitar o limite de 60 MB. Depois do processamento, o lote completo vai para `processadas`; arquivos recusados vão para `falhas`, junto de `_resultado.json` com o motivo. Nada é apagado. Lotes em `processando` são recuperados na inicialização, e um lote que já consta no histórico não é aplicado novamente.

Exemplo no PowerShell, substituindo os caminhos e o nome do lote:

```powershell
$lote = "data\state\entrada_automatica\pendentes\2026-10-09_lote-001"
New-Item -ItemType Directory -Force "$lote\endpoint", "$lote\simpress"
Copy-Item "C:\caminho\InvAllComputersSummary.xlsx" "$lote\endpoint\"
Copy-Item "C:\caminho\EquipamentosDetalhes.xlsx" "$lote\simpress\"
```

Para usar outra pasta como raiz, defina `SIMPRESS_IMPORT_INBOX_DIR` antes de iniciar o servidor. O caminho pode ser absoluto ou relativo à pasta do projeto; dentro dele, use as mesmas subpastas `pendentes`, `processando`, `processadas` e `falhas`. O importador é local ao servidor. Para reenviar um lote com falha, corrija a causa e crie uma pasta com outro nome exclusivo.

O sistema cria cópias dos inventários anteriores antes de substituí-los. A restauração também salva o conjunto que está ativo naquele momento e registra a operação no histórico, permitindo desfazê-la se esse backup também for completo e válido.

A cada atualização, o histórico identifica notebooks do Endpoint cuja coluna **Última verificação com êxito** indica 7 dias ou mais sem verificação. O resultado inclui hostname/apelido, série, data, dias decorridos e linha de origem; valores vazios ou inválidos nessa coluna não são contados como inatividade confirmada.

### Apelidos, edição e precedência das fontes

Um apelido alterado manualmente fica associado ao número de série e prevalece nas pesquisas, no formulário e na exportação. Sem alteração manual, um hostname único do Endpoint prevalece sobre o apelido de EquipamentosDetalhes. Quando uma associação do Endpoint não é única, o sistema a apresenta para revisão em vez de escolher uma linha arbitrariamente.

O **Histórico** registra alterações manuais de apelido e permite desfazer a alteração mais recente quando os dados ainda correspondem ao evento. O **Histórico planilhas** também mostra diferenças entre apelidos manuais e os valores das duas fontes; para cada série, é possível manter o apelido manual ou remover o override. Endereço e localidade vêm de EquipamentosDetalhes e não são alterados manualmente pelo formulário de edição.

### Exportar equipamentos

**Exportar Excel** baixa uma cópia do modelo local atualizada com os dados do inventário principal. O sistema processa somente séries com correspondência única, atualiza células graváveis de `Apelido` e, quando a coluna existe nos dois arquivos, `IdCliente`. Fórmulas não são sobrescritas; as demais abas e formatações do modelo são preservadas. Se a exportação for parcial, a notificação informa os motivos e exemplos para conferência.

### Catálogo de unidades e acessibilidade

O **Catálogo de Unidades** permite consultar unidades e manter unidades personalizadas. Os botões ao lado do CNPJ e do CEP copiam os valores; a interface informa sucesso ou falha.

**Atualizar planilhas** e **Nova transferência** ficam entre as ações principais. Histórico de alterações, Histórico planilhas, Exportar Excel e Catálogo de unidades ficam agrupados no menu secundário.

A aba **Home** concentra a busca por série, apelido/hostname, modelo ou cidade. Após selecionar um equipamento, a tela permanece nela; abra **Retirada e Entrega** manualmente para preencher a transferência e acessar as ações do rodapé.

No cartão do equipamento pesquisado, os atalhos compactos copiam o CEP e o CNPJ de instalação da localidade de retirada, além do CNPJ de faturamento fixo. Na aba **Retirada e Entrega**, o atalho **CNPJ Inst.** só é habilitado após escolher um destino; a confirmação da cópia identifica a cidade selecionada. O rodapé inclui **Copiar Série** para copiar a série pesquisada.

Use **Pular para o conteúdo principal** para ignorar o cabeçalho. Na lista rápida, `↑` e `↓` navegam, `Enter` seleciona ou abre os resultados completos e `Esc` fecha. Na pesquisa completa, refine por categoria e cidade ou carregue mais resultados. Diálogos mantêm o foco dentro do conteúdo enquanto estão abertos, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas. Tabelas largas podem ser percorridas horizontalmente e a interface se adapta a telas menores e à preferência por movimento reduzido.

## Limites de planilhas

Cada arquivo enviado pode ter até **60 MB**. Para manter a leitura previsível, cada arquivo também pode ter até **128 abas**, **250.000 linhas por aba** e **10.000.000 de posições usadas no total**. O pacote XLSX descompactado é limitado a 512 MB. Na prática, esse é o limite que costuma valer primeiro: a exportação completa da Simpress, com 50 colunas, cabe com cerca de 140 mil linhas (estimado a partir da medição de 15/10/2026 com o limite anterior de 256 MB), e as 250.000 linhas por aba só cabem em planilhas com até 40 colunas. Perto desse teto, a leitura leva mais de dois minutos e pode usar cerca de 900 MB de memória. Os limites se aplicam aos arquivos enviados e às planilhas locais processadas.

Arquivos precisam ser `.xlsx` válidos. Planilhas vazias, corrompidas, com cabeçalhos ausentes/ambíguos ou sem linhas utilizáveis podem ser recusadas. Se duas abas de um arquivo forem compatíveis com o mesmo tipo de inventário, selecione ou prepare um arquivo que contenha apenas a aba correta.

## Histórico, backups e recuperação

- Os backups de atualizações ficam em `data/planilhas_entrada/_backups/<data-hora>-<identificador>/`, separados em Endpoint e Simpress. Um backup incompleto ou inválido não pode ser restaurado pelo histórico.
- O histórico de comparações fica em `data/state/historico_comparacoes/historico_comparacoes.json`; os arquivos temporários e de bloqueio usados nas gravações ficam nessa mesma pasta.
- Históricos de apelidos, comparações e backups vencem após **60 dias**. A limpeza automática ocorre na inicialização e após atualizações de planilhas ou gravações de apelido. Backups antigos sem referência no histórico também podem ser removidos.
- A comparação fixada é preservada. Registros com data inválida são mantidos porque não há um prazo confiável para removê-los.
- Backups e históricos são locais; eles não são enviados à nuvem. Faça uma cópia externa das pastas e arquivos locais se precisar mantê-los além do prazo de retenção ou recuperá-los após perda do computador.
- Gravações relacionadas usam arquivos temporários validados, bloqueios e transações. Se uma operação for interrompida, o sistema tenta recuperar o estado na próxima inicialização.
- `.transactions` contém informações de recuperação pendente. Não apague essa pasta enquanto houver uma recuperação pendente.

Se uma cópia antiga estiver ausente ou inválida, confira manualmente os arquivos ativos e a pasta de backup antes de qualquer substituição. A restauração pelo histórico exige os dois inventários válidos e mostra os nomes, as datas e as contagens antes da confirmação.

## Solução de problemas

| Situação | O que conferir |
| --- | --- |
| O inicializador informa que não encontrou Python 3.12 ou superior | Instale Python 3.12 ou superior e execute o inicializador novamente. |
| A geração de transferência está indisponível | Confira o modelo `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` em `data/planilhas_entrada`; a ausência dele não impede iniciar o servidor. |
| O servidor iniciou, mas algumas funções estão indisponíveis | Confira o painel de prontidão e forneça localmente os arquivos listados para as funções necessárias. |
| A migração não consegue concluir uma recuperação ou encontra upload em andamento | Preserve os arquivos indicados. Confira `.transactions`; aguarde o upload terminar e execute a migração novamente quando a operação estiver resolvida. |
| A migração informa que já existe um arquivo diferente no destino | Compare os dois arquivos e resolva o conflito manualmente antes de repetir `scripts/migrate_local_data.py`. A migração não substitui nenhum deles. |
| A busca não encontra equipamentos ou escolheu dados antigos | Confira os cabeçalhos e a data de modificação dos arquivos `EquipamentosDetalhes*.xlsx` em `data/planilhas_entrada`. O sistema seleciona o mais recente que contém uma aba válida. Reinicie após substituir um arquivo manualmente. |
| Atualização ou comparação está indisponível | Envie os dois inventários `.xlsx` pelo fluxo **Atualizar Planilhas** e confira se cada um tem uma única aba com os cabeçalhos exigidos. |
| A exportação está indisponível | Confira `modelos/EquipamentosDetalhes-exportacao.xlsx` e se ele contém as colunas de série e `Apelido`. |
| Não é possível restaurar uma atualização | O histórico precisa ter o backup dos dois inventários, e ambos devem passar novamente pela validação. |
| O painel de status continua desatualizado | Clique em **Atualizar status** para repetir a verificação; para carregar dados de inventário substituídos manualmente, reinicie o servidor. |
| Uma ação mostrou “Falha interna do servidor” | Consulte `data/logs/simpress.log` (ou `simpress.log.1` a `.5`, os anteriores). O registro mostra a rota e o ponto do código da falha, sem o conteúdo das planilhas. |
| A interface informa que um arquivo está em uso ou ocupado | Feche a planilha no Excel ou aguarde a sincronização do OneDrive e tente de novo. A resposta 409 não altera nenhum arquivo. |
| Uma chamada a `/api/` feita de outra página ou porta retorna 403 | É esperado: a API aceita só chamadas da própria interface ou de endereços digitados no navegador. Use a interface em `http://127.0.0.1:<porta>`. |
| O visual continua antigo após `git pull` | Confirme a branch com `git switch main` e atualize com `git pull --ff-only origin main`. Encerre o servidor anterior e execute `iniciar_servidor.bat` da pasta atualizada. Recarregue com `Ctrl+F5` uma vez. As páginas passam a usar URLs de CSS e JavaScript vinculadas ao conteúdo dos arquivos para evitar versões antigas no cache. |

## Desenvolvimento

### Reconstruir os arquivos da interface

Os arquivos distribuídos em `static/vendor` são servidos localmente. Depois de alterar fontes, ícones ou estilos utilitários, reconstrua-os com Node.js e npm:

```powershell
npm ci
npm run build:ui
```

O servidor Python usa os arquivos gerados e não precisa de um processo Node.js em execução.

### Executar testes

Suíte Python:

```powershell
.\.venv\Scripts\python.exe -B tests\run_tests.py
```

Testes da interface JavaScript:

```powershell
node --test "tests/frontend/*.cjs"
```

O executor Python usa dados fictícios em uma pasta temporária, bloqueia a leitura das planilhas operacionais durante a descoberta dos testes e isola os testes de transação. Não use planilhas de produção como fixtures ou destinos.

## Estrutura do projeto

```text
main.py                              Aplicação FastAPI, inicialização e rotas principais
core/config.py                       Caminhos locais, limites e padrões de configuração
core/integrity.py                        Bloqueios, transações e recuperação de arquivos
core/xlsx_safety.py                      Validação estrutural e limites de pacotes XLSX
core/openpyxl_compat.py                  Compatibilidade com arquivos lidos/escritos por openpyxl
core/logging_setup.py                    Logs do servidor no console e em data/logs/simpress.log
domains/inventory_comparison.py     Normalização e regras de comparação de inventários
domains/inventory_update.py         Validação, atualização e histórico de inventários
domains/ticket_inbox.py             Entrada estável, validação e arquivamento de lotes Simpress/Oracle
domains/equipment_search.py         Normalização, categorização e indexação de equipamentos
domains/effective_alias.py          Precedência do apelido: manual, hostname do Endpoint, Simpress
domains/uploaded_workbooks.py       Leitura e validação das planilhas enviadas
domains/readiness.py                Painel de prontidão dos arquivos locais
domains/history_annotations.py      Anotações do histórico de planilhas
security/local_requests.py          Acesso só local, cabeçalhos de segurança e limites de envio
routers/transfers.py                Validação e geração da planilha de transferência
routers/inventory_history.py        Histórico, resolução e restauração de inventários
routers/equipment_search.py         Rotas de busca e estatísticas de equipamentos
routers/system.py                    Rotas de status e configuração do sistema
routers/units.py                     Rotas e esquema do catálogo de unidades
static/                              Interface web, scripts e arquivos locais de estilo/fonte/ícone
static/js/features/                  Módulos da interface por funcionalidade
scripts/build/copy_ui_assets.cjs           Cópia dos recursos locais para a interface
scripts/migrate_local_data.py        Migração segura dos dados locais para data/
scripts/cleanup_local_temps.py       Limpeza conservadora de arquivos temporários locais
scripts/process_ticket_inbox.py      Processamento local imediato da fila de chamados Simpress/Oracle
data/planilhas_entrada/               Modelo de transferência e planilhas locais
data/planilhas_entrada/_backups/      Cópias locais anteriores dos inventários
data/state/                           Estado e históricos locais, ignorados pelo Git
data/state/entrada_chamados/          Modelo e instruções versionados; lotes e recibos operacionais ignorados pelo Git
modelos/                              Modelo local de exportação de equipamentos
data/logs/                            Registros locais do servidor, ignorados pelo Git
docs/                                 Relatórios de revisão e desempenho
tests/                                Testes Python e JavaScript
requirements.txt                     Dependências Python fixadas
package.json / package-lock.json     Dependências de desenvolvimento da interface
iniciar_servidor.bat                  Inicializador local para Windows
```

## Índice da documentação

- [Relatório final da reorganização e refatoração](docs/desenvolvimento/relatorio-refatoracao-2026-10-12.md)
- [Revisão e correções pós integração](docs/desenvolvimento/revisao-refatoracao-frontend-2026-10-12.md)
- [Arquitetura e plano da refatoração](docs/arquitetura/analise-refatoracao-frontend.md)
- [Primeiro acesso](docs/guias/PRIMEIRO_ACESSO.md)
- [Anotações do histórico](docs/operacao/ANOTACOES-HISTORICO.md)
- [Idempotência dos inventários](docs/operacao/idempotencia-atualizacao-inventario.md)
- [Microinterações e acessibilidade](docs/desenvolvimento/MICROINTERACOES.md)
- [Arquitetura e auditoria](docs/arquitetura/auditoria_arquitetura.md)
- [Auditoria do backend e situação do roteiro](docs/arquitetura/auditoria_backend/README.md)

As entradas `static/index.html`, `static/app.js` e `static/app.css` conservam os caminhos atuais e as alterações locais. Fontes de estilo ficam em `static/styles`, JavaScript em `static/js/{shared,ui,features}`, testes Node em `tests/frontend` e o servidor de fixtures em `tests/support`. A configuração e a segurança dos workbooks ficam em `core`; domínios, rotas e segurança conservam seus limites. Os scripts Python mantêm seus comandos públicos usados pelo inicializador e pelas filas locais.

## Dados e privacidade

O servidor atende somente `127.0.0.1` em uma porta local entre `8000` e `8099`. Os dados são persistidos em arquivos Excel/JSON locais, com acesso direto à aplicação no próprio computador. A documentação `/docs` só fica disponível com `SIMPRESS_ENABLE_DOCS=1`, e o log de acesso do servidor fica desligado para não registrar buscas por série ou hostname. Mensagens de exceção não entram no log, porque podem conter caminhos com o nome do usuário do Windows; as séries citadas no log aparecem como uma referência curta (`ref-...`). As páginas usam uma política de conteúdo que só permite scripts do próprio servidor, e todas as respostas trazem cabeçalhos que impedem a exibição dentro de outros sites. A API recusa chamadas que o navegador identifica como vindas de outro site.

Planilhas operacionais, backups, logs, exportações, históricos, apelidos e unidades personalizadas ficam no computador local e são ignorados pelo Git. O modelo vazio de transferência permanece versionado. Inclua os dados locais em uma rotina de backup apropriada se precisar preservá-los; não force a inclusão deles em commits nem compartilhe cópias com dados operacionais.

Arquivos operacionais que já foram versionados continuam recuperáveis no histórico Git local. As regras atuais de `.gitignore` impedem novos rastreamentos, mas não reescrevem o histórico existente.
