# Simpress — Transferência e Inventário de Equipamentos

Aplicação web local para consultar equipamentos, preparar transferências Simpress, comparar inventários e exportar uma planilha de equipamentos atualizada. O servidor usa FastAPI; a interface e os dados operacionais ficam no computador em que o projeto está instalado.

## Recursos

- Busca por número de série, código de barras, apelido/hostname, modelo ou cidade. A busca completa pode ser filtrada por categoria e cidade.
- Geração e download da planilha oficial de transferência a partir do modelo local.
- Textos prontos para solicitações de transporte, kit de teclado e mouse e defeitos, com opções para copiar o texto e abrir os links correspondentes.
- Edição de apelidos e de outros campos permitidos do equipamento, com histórico e opção de desfazer alterações de apelido.
- Comparação e atualização conjunta dos inventários Endpoint e Simpress, com histórico, backups locais e prévia de restauração.
- Exportação de `Apelido` e, quando disponível, `IdCliente` para um modelo Excel local.
- Catálogo de unidades, endereços, CNPJ e CEP, incluindo unidades personalizadas.

## Requisitos

- Windows 10 ou superior.
- Python 3.12 ou superior.
- O servidor usa os arquivos locais já compilados da interface. Node.js e npm são necessários para reconstruir esses arquivos, executar os testes JavaScript ou preparar o ambiente opcional de desenvolvimento Supabase.
- Não é necessário ter acesso à internet para abrir a aplicação e carregar a interface. Os links para os sistemas de chamados da Simpress abrem páginas externas.

O repositório é privado; a conta usada para cloná-lo precisa ter acesso.

## Instalação

Clone o projeto ou abra o PowerShell na pasta existente:

```powershell
git clone https://github.com/gabrielakihiro-dev/Simpress.git
cd Simpress
```

Crie o ambiente virtual com Python 3.12 ou superior. No Windows, use o Python Launcher:

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

Os caminhos são relativos à pasta do projeto e estão definidos em [app_config.py](app_config.py). Dados operacionais ficam em `data/`, e o modelo de exportação continua em `modelos/`. Não é necessário criar um arquivo `.env`; o programa não o carrega.

Na primeira inicialização após atualizar uma instalação existente, o inicializador move os arquivos das pastas antigas para `data/`. A migração primeiro tenta concluir recuperações registradas em `.transactions`; se a recuperação falhar ou houver um upload temporário, ela interrompe sem mover os arquivos. Ela preserva os caminhos relativos dos backups e não sobrescreve destinos diferentes. Feche qualquer outro servidor antes de executar `scripts/migrate_local_data.py` manualmente.

Antes de iniciar o servidor, a limpeza recupera transações e considera temporários com pelo menos 24 horas. Ela remove apenas cópias com o mesmo conteúdo do arquivo de destino, enquanto mantém versões diferentes para revisão. Para visualizar o relatório sem remover nada, execute `scripts/cleanup_local_temps.py` sem `--apply`.

| Arquivo | Local | Uso |
| --- | --- | --- |
| `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` | `data/planilhas_entrada` | Modelo da planilha oficial. É versionado no Git e exigido pelo inicializador `.bat`. |
| `EquipamentosDetalhes*.xlsx` | `data/planilhas_entrada` | Inventário principal da busca. Na inicialização, o sistema usa o arquivo válido mais recente. |
| `EquipamentosDetalhes_atual.xlsx` | `data/planilhas_entrada` | Destino da atualização Simpress, extraído do workbook contido no ZIP `EquipamentosDetalhes` enviado para a atualização. É a fonte oficial da composição e contagem do cadastro; não some registros da InvAll nem de snapshots anteriores. |
| `InvAllComputersSummary_atual.xlsx` | `data/planilhas_entrada` | Fonte auxiliar de hostname por série e comparação. Não adiciona equipamentos à base oficial. |
| `EquipamentosDetalhes-exportacao.xlsx` | `modelos` | Modelo local de exportação. Não é distribuído pelo Git. |
| `apelidos_modificados.json` | `data/state/apelidos_modificados` | Apelidos personalizados locais. O arquivo, temporários e bloqueios não são versionados. |
| `historico_comparacoes.json` | `data/state/historico_comparacoes` | Histórico local de comparações. O arquivo, temporários e bloqueios não são versionados. |
| Catálogo de unidades e histórico de apelidos | `data/state` | Estado local da aplicação; não é distribuído pelo Git. |

As planilhas operacionais e o modelo de exportação precisam ser fornecidos localmente. Não coloque dados reais no repositório.

### Cabeçalhos dos inventários

Os cabeçalhos devem estar na primeira linha de uma aba com dados. O sistema normaliza espaços, acentos e pontuação e recusa cabeçalhos repetidos ou ambíguos.

- **EquipamentosDetalhes:** número de série (`NumeroSerie`, `Numero de Serie` ou `Serial`), apelido/hostname (`Apelido`, `Hostname`, `Nome do Computador` ou `ComputerName`), `Modelo` e `Cidade`.
- **Endpoint:** nome do computador (`Nome do Computador`, `ComputerName` ou `Hostname`) e número de série/rótulo de serviço (`Rotulo de Servico Numero de Serie`, `NumeroSerie`, `Numero de Serie`, `Serial` ou `ServiceTag`).
- **Modelo de exportação:** precisa ter colunas de número de série e `Apelido`. A coluna `IdCliente` é atualizada quando existe nos dois arquivos.

Para escolher a aba automaticamente, o arquivo enviado deve conter somente uma aba que corresponda aos cabeçalhos exigidos para aquele inventário. Se mais de uma aba for compatível, a atualização é recusada para evitar comparar a tabela errada.

Quando o CNPJ da unidade de instalação estiver disponível em `CNPJ Instalacao` ou `CNPJ de Instalacao`, esse valor pode ser usado. O CNPJ de faturamento não é usado como substituto.

### Contato padrão da retirada

Os dados padrão do contato de retirada podem ser definidos nas variáveis de ambiente abaixo. Defina-as no PowerShell antes de iniciar o servidor; reinicie o processo depois de alterá-las.

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

O inicializador confere se existem o ambiente `.venv` e o modelo de transferência, abre o servidor e mantém a janela aberta. Para iniciar sem o arquivo `.bat`, use:

```powershell
.\.venv\Scripts\python.exe scripts\migrate_local_data.py
.\.venv\Scripts\python.exe scripts\cleanup_local_temps.py --apply
.\.venv\Scripts\python.exe main.py
```

Abra no navegador:

- Aplicação (porta padrão): <http://127.0.0.1:8000>
- Documentação interativa da API (porta padrão): <http://127.0.0.1:8000/docs>

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

Na aba **Home**, **Mostrar textos para chamados** apresenta textos editáveis relacionados ao equipamento. Use **Copiar** para levar o texto ao chamado; os botões **Link** abrem os sistemas externos correspondentes.

### Comparar e atualizar inventários

1. Abra **Atualizar Planilhas**.
2. Envie um arquivo `.xlsx` do **Endpoint** e um do **Simpress**.
3. Confira ausências em cada fonte, notebooks sem verificação com êxito há 14 dias ou mais, divergências de local, correspondências ambíguas, mudanças de hostname e casos que precisam de revisão.
4. Leia o resultado antes de continuar. Cada atualização substitui integralmente os dois inventários ativos pelos arquivos validados; séries ausentes no novo relatório deixam de compor a base carregada.
5. Consulte **Histórico planilhas** para rever comparações e, se houver um backup completo válido, pré-visualize os arquivos e datas antes de restaurar.

O sistema cria cópias dos inventários anteriores antes de substituí-los. A restauração também salva o conjunto que está ativo naquele momento e registra a operação no histórico, permitindo desfazê-la se esse backup também for completo e válido.

A cada atualização, o histórico identifica notebooks do Endpoint cuja coluna **Última verificação com êxito** indica 14 dias ou mais sem verificação. O resultado inclui hostname/apelido, série, data, dias decorridos e linha de origem; valores vazios ou inválidos nessa coluna não são contados como inatividade confirmada.

### Apelidos, edição e precedência das fontes

Um apelido alterado manualmente fica associado ao número de série e prevalece nas pesquisas, no formulário e na exportação. Sem alteração manual, um hostname único do Endpoint prevalece sobre o apelido de EquipamentosDetalhes. Quando uma associação do Endpoint não é única, o sistema a apresenta para revisão em vez de escolher uma linha arbitrariamente.

O **Histórico** registra alterações manuais de apelido e permite desfazer a alteração mais recente quando os dados ainda correspondem ao evento. O **Histórico planilhas** também mostra diferenças entre apelidos manuais e os valores das duas fontes; para cada série, é possível manter o apelido manual ou remover o override. Endereço e localidade vêm de EquipamentosDetalhes e não são alterados manualmente pelo formulário de edição.

### Exportar equipamentos

**Exportar Excel** baixa uma cópia do modelo local atualizada com os dados do inventário principal. O sistema processa somente séries com correspondência única, atualiza células graváveis de `Apelido` e, quando a coluna existe nos dois arquivos, `IdCliente`. Fórmulas não são sobrescritas; as demais abas e formatações do modelo são preservadas. Se a exportação for parcial, a notificação informa os motivos e exemplos para conferência.

### Catálogo de unidades e acessibilidade

O **Catálogo de Unidades** permite consultar unidades e manter unidades personalizadas. Os botões ao lado do CNPJ e do CEP copiam os valores; a interface informa sucesso ou falha.

**Atualizar planilhas** e **Nova transferência** ficam entre as ações principais. Histórico de alterações, Histórico planilhas, Exportar Excel e Catálogo de unidades ficam agrupados no menu secundário.

A aba **Home** concentra a busca por série, apelido/hostname, modelo ou cidade. Após selecionar um equipamento, a tela permanece nela; abra **Retirada e Entrega** manualmente para preencher a transferência e acessar as ações do rodapé.

No cartão do equipamento pesquisado, os atalhos compactos copiam o CEP e o CNPJ de instalação da localidade de retirada, além do CNPJ de faturamento fixo `75.110.585/0001-00`. Na aba **Retirada e Entrega**, o atalho **CNPJ Inst.** só é habilitado após escolher um destino; a confirmação da cópia identifica a cidade selecionada. O rodapé inclui **Copiar Série** para copiar a série pesquisada.

Use **Pular para o conteúdo principal** para ignorar o cabeçalho. Na lista rápida, `↑` e `↓` navegam, `Enter` seleciona ou abre os resultados completos e `Esc` fecha. Na pesquisa completa, refine por categoria e cidade ou carregue mais resultados. Diálogos mantêm o foco dentro do conteúdo enquanto estão abertos, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas. Tabelas largas podem ser percorridas horizontalmente e a interface se adapta a telas menores e à preferência por movimento reduzido.

## Limites de planilhas

Cada arquivo enviado pode ter até **30 MB**. Para manter a leitura previsível, cada arquivo também pode ter até **128 abas**, **250.000 linhas por aba** e **5.000.000 de posições usadas no total**. O pacote XLSX descompactado é limitado a 256 MB. Os limites se aplicam aos arquivos enviados e às planilhas locais processadas.

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
| O inicializador informa que não encontrou Python | Crie o ambiente `.venv` e confira se usa Python 3.12 ou superior. |
| O inicializador informa que falta o modelo de transferência | Restaure `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` em `data/planilhas_entrada`. |
| A migração não consegue concluir uma recuperação ou encontra upload em andamento | Preserve os arquivos indicados. Confira `.transactions`; aguarde o upload terminar e execute a migração novamente quando a operação estiver resolvida. |
| A migração informa que já existe um arquivo diferente no destino | Compare os dois arquivos e resolva o conflito manualmente antes de repetir `scripts/migrate_local_data.py`. A migração não substitui nenhum deles. |
| A busca não encontra equipamentos ou escolheu dados antigos | Confira os cabeçalhos e a data de modificação dos arquivos `EquipamentosDetalhes*.xlsx` em `data/planilhas_entrada`. O sistema seleciona o mais recente que contém uma aba válida. Reinicie após substituir um arquivo manualmente. |
| Atualização ou comparação está indisponível | Envie os dois inventários `.xlsx` pelo fluxo **Atualizar Planilhas** e confira se cada um tem uma única aba com os cabeçalhos exigidos. |
| A exportação está indisponível | Confira `modelos/EquipamentosDetalhes-exportacao.xlsx` e se ele contém as colunas de série e `Apelido`. |
| Não é possível restaurar uma atualização | O histórico precisa ter o backup dos dois inventários, e ambos devem passar novamente pela validação. |
| O painel de status continua desatualizado | Clique em **Atualizar status** para repetir a verificação; para carregar dados de inventário substituídos manualmente, reinicie o servidor. |

## Desenvolvimento

### Reconstruir os arquivos da interface

Os arquivos distribuídos em `static/vendor` são servidos localmente. Depois de alterar fontes, ícones ou estilos utilitários, reconstrua-os com Node.js e npm:

```powershell
npm ci
npm run build:ui
```

O servidor Python usa os arquivos gerados e não precisa de um processo Node.js em execução.

### Migração para Supabase: ambiente local opcional

As Etapas 1 a 5 estão documentadas. **Excel/JSON continua sendo o modo padrão.** A Etapa 5 adicionou um backend PostgreSQL opcional para consultas, catálogo, edição de equipamentos e apelidos em um piloto local descartável. A integração de arquivos, comparações e anotações pertence à Etapa 6; autenticação à Etapa 7. O Supabase não é necessário para executar o Simpress no modo atual.

O ambiente de desenvolvimento usa o Supabase CLI **2.120.0**, fixado nas dependências, e PostgreSQL **17** no projeto `simpress-dev`. São quatro migrations e 20 tabelas no schema privado `simpress`, fora da Data API, com RLS habilitado e forçado. A Etapa 5 permite somente o papel próprio do piloto nas tabelas necessárias; `anon`, `authenticated`, `service_role` e `simpress_runtime` continuam sem acesso ao domínio. Não houve importação de dados reais nem criação de conta administradora ou buckets. A aplicação FastAPI continua sem autenticação de usuário.

Para o ambiente Windows aprovado, use WSL2 e Rancher Desktop com engine **Moby** e Kubernetes desabilitado, além do ambiente Python do projeto e Node.js/npm (a validação usou Node.js 24). A primeira preparação requer internet para baixar dependências e imagens. Consulte os [pré-requisitos locais](docs/migracao_supabase_pre_requisitos_locais.md).

Na pasta do projeto, instale as dependências e crie uma instância nova:

```powershell
npm ci
.\.venv\Scripts\python.exe -B scripts/supabase_local.py start
```

Se esta instalação já tiver sido criada e encerrada pelo helper, retome seus volumes reconhecidos com:

```powershell
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
```

O helper localiza o Docker do Rancher no PATH do próprio processo e confere a identidade da instância e os endereços publicados. A API usa `127.0.0.1:54321` e o PostgreSQL usa `127.0.0.1:54322`; a porta `54320` está reservada para o banco temporário de validação. Os serviços opcionais, incluindo Studio, estão desabilitados.

Para conferir o ambiente, validar o banco de desenvolvimento vazio e encerrar os serviços preservando os volumes:

```powershell
.\.venv\Scripts\python.exe -B scripts/supabase_local.py check
.\.venv\Scripts\python.exe -B scripts/supabase_local.py validate
.\.venv\Scripts\python.exe -B scripts/supabase_local.py stop
```

A validação da Etapa 4 passou em **66 verificações SQL, quatro verificações HTTP e nove testes do helper**. Os dados sintéticos das verificações SQL foram revertidos. A suíte completa da aplicação não foi repetida nesta etapa. Os serviços foram encerrados após a validação, preservando os volumes locais.

Testes isolados do helper, sem iniciar o Supabase:

```powershell
.\.venv\Scripts\python.exe -B -m unittest tests.test_supabase_local -v
```

Volumes persistentes não substituem backups. A pasta local `Backup_Banco`, ignorada pelo Git, foi preparada como destino; nenhum backup do banco foi gerado nesta etapa. As instruções e restrições de reconstrução da instância descartável estão no relatório da Etapa 4.

Documentação da migração:

- [Etapa 1 — diagnóstico](docs/migracao_supabase_etapa_1.md)
- [Etapa 2 — decisões e escopo](docs/migracao_supabase_etapa_2.md)
- [Etapa 3 — modelo de dados](docs/migracao_supabase_etapa_3.md)
- [Etapa 4 — esquema SQL e validação local](docs/migracao_supabase_etapa_4.md)
- [Etapa 5 — integração incremental do FastAPI com PostgreSQL](docs/migracao_supabase_etapa_5.md)
- [Prompts das Etapas 2 a 8](docs/prompts_migracao_supabase_etapas_2_a_8.md)

#### Executar o piloto PostgreSQL da Etapa 5

Instale as dependências opcionais e, com o Supabase local já iniciado, aplique migrations pendentes somente na instância descartável reconhecida:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-postgres.txt
.\.venv\Scripts\python.exe -B scripts/supabase_local.py migrate
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py
```

O iniciador do piloto abre o FastAPI em `127.0.0.1:8000`, cria um login SQL limitado com senha aleatória somente em memória e remove esse login ao encerrar normalmente. Recusa um login já existente. Não modifica a configuração permanente do modo de arquivos. O exemplo de variáveis está em [.env.supabase.example](.env.supabase.example); arquivos dotenv não são carregados automaticamente.

O banco permanece sem inventário até a importação das próximas etapas. Sem lote validado ativo, cadastrar equipamento retorna conflito; o catálogo de unidades pode ser exercitado separadamente. No piloto PostgreSQL, funções de arquivos, comparação e anotações retornam indisponibilidade da Etapa 6. Para a operação atual completa, continue usando o modo de arquivos.

Ensaio reproduzível da integração, em um banco sintético separado criado e removido pela execução:

```powershell
.\.venv\Scripts\python.exe -B scripts/verify_postgres.py --local-disposable
```

O piloto não está liberado para dados reais, rede externa ou uso oficial. Para voltar ao modo padrão, encerre o piloto, remova as variáveis de configuração PostgreSQL do processo caso tenham sido definidas manualmente e execute `iniciar_servidor.bat`.

### Executar testes

Suíte Python:

```powershell
.\.venv\Scripts\python.exe -B tests\run_tests.py
```

Testes da interface JavaScript:

```powershell
node --test tests/test_inventory_ui_flows.cjs tests/test_transfer_workflows.cjs
```

O executor Python usa dados fictícios em uma pasta temporária, bloqueia a leitura das planilhas operacionais durante a descoberta dos testes e isola os testes de transação. Não use planilhas de produção como fixtures ou destinos.

## Estrutura do projeto

```text
main.py                              Aplicação FastAPI, inicialização e rotas principais
app_config.py                       Caminhos locais, limites e padrões de configuração
integrity.py                        Bloqueios, transações e recuperação de arquivos
xlsx_safety.py                      Validação estrutural e limites de pacotes XLSX
openpyxl_compat.py                  Compatibilidade com arquivos lidos/escritos por openpyxl
domains/inventory_comparison.py     Normalização e regras de comparação de inventários
domains/inventory_update.py         Validação, atualização e histórico de inventários
domains/equipment_search.py         Normalização, categorização e indexação de equipamentos
routers/transfers.py                Validação e geração da planilha de transferência
routers/inventory_history.py        Histórico, resolução e restauração de inventários
routers/equipment_search.py         Rotas de busca e estatísticas de equipamentos
routers/system.py                    Rotas de status e configuração do sistema
routers/units.py                     Rotas e esquema do catálogo de unidades
static/                              Interface web, scripts e arquivos locais de estilo/fonte/ícone
scripts/copy_ui_assets.cjs           Cópia dos recursos locais para a interface
scripts/migrate_local_data.py        Migração segura dos dados locais para data/
scripts/cleanup_local_temps.py       Limpeza conservadora de arquivos temporários locais
scripts/supabase_local.py            Controle e validação do Supabase local descartável
scripts/run_postgres_pilot.py        FastAPI local com login SQL temporário e limitado
scripts/verify_postgres.py           Ensaio sintético da integração PostgreSQL/HTTP
persistence/                        Configuração, transações e projeções do backend PostgreSQL
supabase/config.toml                 Configuração do projeto local simpress-dev
supabase/migrations/                 Esquema SQL versionado da migração
supabase/tests/                      Verificações SQL com dados sintéticos
data/planilhas_entrada/               Modelo de transferência e planilhas locais
data/planilhas_entrada/_backups/      Cópias locais anteriores dos inventários
data/state/                           Estado e históricos locais, ignorados pelo Git
modelos/                              Modelo local de exportação de equipamentos
logs/                                 Registros locais do servidor, ignorados pelo Git
docs/                                 Relatórios de revisão, desempenho e migração Supabase
tests/                                Testes Python e JavaScript
requirements.txt                     Dependências Python fixadas
requirements-postgres.txt            Dependências opcionais do piloto PostgreSQL
package.json / package-lock.json     Dependências da interface e Supabase CLI de desenvolvimento
iniciar_servidor.bat                  Inicializador local para Windows
```

## Dados e privacidade

O servidor atende somente `127.0.0.1` em uma porta local entre `8000` e `8099` e não possui autenticação de usuário; não o exponha diretamente à rede. A documentação `/docs` também fica disponível apenas enquanto o servidor local está em execução.

Planilhas operacionais, backups, exportações, históricos, apelidos e unidades personalizadas ficam no computador local e são ignorados pelo Git. O modelo vazio de transferência permanece versionado. Inclua os dados locais em uma rotina de backup apropriada se precisar preservá-los; não force a inclusão deles em commits nem compartilhe cópias com dados operacionais.

Arquivos operacionais que já foram versionados continuam recuperáveis no histórico Git local. As regras atuais de `.gitignore` impedem novos rastreamentos, mas não reescrevem o histórico existente.
