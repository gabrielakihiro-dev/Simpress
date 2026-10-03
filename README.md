# Simpress — Transferência de Equipamentos

Aplicação web local para consultar equipamentos por número de série, preparar transferências Simpress e gerar a planilha oficial em Excel. O projeto usa FastAPI no servidor, uma interface em `static/index.html` e arquivos `.xlsx` na pasta `planilhas_entrada`.

## O que o sistema faz

- Pesquisa equipamentos por série, código de barras, apelido/hostname, modelo ou cidade e permite refinar os resultados por categoria e cidade.
- Preenche os dados de retirada e entrega e gera a planilha oficial de transferência.
- Permite ajustar apelidos, consultar o histórico e exportar a base com os apelidos atualizados.
- Compara arquivos de inventário do Endpoint e do EquipamentosDetalhes.
- Mantém o catálogo de unidades e endereços usado no formulário.

## Requisitos

- Windows 10 ou superior.
- Python 3.12 ou superior. O ambiente local verificado nesta fase usa Python 3.14.7; a versão fixada de NumPy requer Python 3.12 ou superior.
- Fontes, estilos utilitários e ícones da interface são servidos por arquivos locais; não é necessária conexão externa para carregá-los.
- As versões diretas e transitivas do ambiente validado estão fixadas em `requirements.txt`.
- As dependências usadas para reconstruir os arquivos da interface estão fixadas em `package-lock.json`; Node.js/npm só são necessários para reconstruí-los.

## Instalação e inicialização

### 1. Baixe o projeto

O repositório é privado; sua conta precisa ter acesso.

```powershell
git clone https://github.com/gabrielakihiro-dev/Simpress.git
cd Simpress
```

Se a pasta já está no computador, abra o PowerShell nela e comece pelo passo 2.

### 2. Crie o ambiente Python

Execute uma vez, na pasta do projeto:

```powershell
py -3 -m venv .venv
```

Confira se a versão exibida é 3.12 ou superior:

```powershell
.\.venv\Scripts\python.exe --version
```

### 3. Instale as dependências

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 4. Confira as planilhas necessárias

Na pasta `planilhas_entrada`, confirme que existem:

- `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`, usado para gerar a planilha final.
- Pelo menos uma planilha `EquipamentosDetalhes*.xlsx` válida. No início, o sistema carrega a planilha válida mais recente dessa pasta.
- `InvAllComputersSummary_atual.xlsx`, usada como fonte de hostname por série quando não há apelido manual.
- `modelos/EquipamentosDetalhes-exportacao.xlsx`, modelo local usado pela exportação da base com apelidos. Esse arquivo pode conter dados operacionais e não é distribuído pelo Git.

A planilha EquipamentosDetalhes precisa ter, na primeira linha, colunas equivalentes a número de série, apelido ou hostname, modelo e cidade. Para preencher CNPJs de retirada e entrega, a coluna `CNPJ Instalacao` (ou `CNPJ de Instalacao`) fornece o CNPJ da unidade; o CNPJ de faturamento não é usado como substituto. As bases operacionais não são distribuídas pelo Git: coloque a cópia local necessária em `planilhas_entrada` e o modelo de exportação em `modelos`.

Os caminhos e limites locais ficam em `app_config.py` e são calculados a partir da pasta do projeto. Não há arquivo `.env`: mantenha os nomes de arquivo e diretórios configurados nesse módulo ou ajuste ali a constante correspondente quando substituir um modelo local.

Para reconstruir os estilos, ícones e fontes locais depois de alterar a interface, execute `npm ci` e `npm run build:ui`. O servidor Python usa os arquivos já gerados em `static/vendor` e não precisa iniciar um processo Node.js.

### 5. Inicie o servidor

```powershell
.\iniciar_servidor.bat
```

O arquivo inicializador usa o ambiente `.venv` criado nos passos anteriores. Mantenha a janela aberta enquanto usar o sistema.

Na inicialização, o terminal informa se os arquivos locais necessários estão disponíveis e quais funções são afetadas quando um arquivo está ausente ou o pacote XLSX é inválido. Essa verificação estrutural não substitui a validação de abas, cabeçalhos e registros feita durante o uso; ela também não grava dados das planilhas no relatório.

As dependências verificadas por função são:

| Função | Arquivos necessários |
| --- | --- |
| Consulta de equipamentos | Inventário EquipamentosDetalhes ativo e válido. |
| Geração de transferência | `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`. |
| Comparação e atualização de inventários | Inventários ativos de Endpoint e EquipamentosDetalhes usados pelo fluxo de atualização. |
| Exportação de equipamentos | Inventário EquipamentosDetalhes ativo e `modelos/EquipamentosDetalhes-exportacao.xlsx`. |

Se uma dependência estiver ausente ou inválida, confira o nome do arquivo indicado no terminal, restaure a planilha local correspondente e reinicie o servidor para repetir a verificação.

### 6. Abra a aplicação

No navegador, acesse:

- Aplicação: <http://127.0.0.1:8000>
- Documentação da API: <http://127.0.0.1:8000/docs>

O servidor aceita apenas `localhost`, `127.0.0.1` ou `[::1]` na porta 8000. Para chamadas de API feitas pelo navegador, a origem deve corresponder ao mesmo host local.

Para encerrar o servidor, volte à janela em que ele está rodando e pressione `Ctrl+C`.

## Passo a passo: gerar uma transferência

1. Inicie o servidor e abra a aplicação.
2. Na aba **Home**, leia o código de barras ou pesquise por série, apelido/hostname, modelo ou cidade. Pressione `Enter` ou clique em **Buscar Equipamento**.
3. Confira os dados do equipamento encontrados na base. A busca permanece na aba **Home**.
4. Clique manualmente na aba **Retirada e Entrega** e preencha ou revise os dados de origem e destino.
5. Use o rodapé da aba **Retirada e Entrega** para clicar em **Gerar Planilha**.
6. Abra o arquivo baixado e confira os dados antes de encaminhá-lo.

## Pesquisa de equipamentos

A busca da aba **Home** aceita série, código de barras, apelido/hostname, modelo e cidade. A lista rápida mostra até 15 resultados. Quando houver mais correspondências, use **Mostrar mais** para abrir a janela de resultados; ela informa o total e carrega os itens em páginas de até 50 pelo botão **Carregar mais**.

Na janela de resultados, combine o filtro de categoria com o de cidade. As categorias são **Notebooks**, **MacBooks**, **Monitores** e **Fones**. A classificação considera o tipo e o modelo da planilha ativa: MacBooks ficam separados dos demais notebooks; monitores também são reconhecidos pelo modelo, mesmo quando o tipo está registrado como `Micro Computador`; e Fones inclui registros identificados como Headset, Headphone, Fone, Earphone ou Earbud. A contagem ao lado de cada categoria considera as correspondências da busca atual.

Códigos como `3CK38` não são associados manualmente a uma categoria. Para aparecer em **Fones**, o código precisa existir na planilha ativa e o tipo ou modelo do registro precisa indicar um fone/headset.

## Atualizar e comparar inventários

1. Na aplicação, abra **Atualizar Planilhas**.
2. Selecione os arquivos `.xlsx` do Endpoint e do EquipamentosDetalhes.
3. Confira as listas de ausências por fonte, as divergências de local e os registros ambíguos apresentados pelo sistema. A comparação usa somente essas duas fontes; a base principal de equipamentos continua disponível para gerar as planilhas pelo botão de exportação.
4. Consulte **Histórico planilhas** para rever comparações anteriores. Em uma atualização com backup válido, use **Restaurar versão anterior** para conferir os arquivos e as datas antes de substituir os inventários; a restauração pode ser desfeita pelo próprio histórico quando o conjunto substituído também está completo e válido.

O limite de envio é de 30 MB por arquivo. Para manter a leitura previsível, cada XLSX também pode ter até 128 abas, 250.000 linhas por aba e 5.000.000 de posições no total, considerando o retângulo usado de cada aba. Cada atualização substitui integralmente os dois inventários ativos pelos arquivos validados enviados; séries ausentes no novo relatório deixam de compor a base carregada. Antes de enviar, confirme que são as versões corretas. O sistema guarda cópias anteriores em `planilhas_entrada/_backups`; pelo histórico, é possível pré-visualizar e restaurar um par válido de inventários.

O apelido alterado manualmente fica associado à série e prevalece nas pesquisas, na entrada rápida e na exportação, mesmo após recarregar ou atualizar as planilhas. Sem override manual, o hostname único da InvAll prevalece sobre o valor de EquipamentosDetalhes. Ao atualizar os arquivos, endereço e localidade são sincronizados a partir de EquipamentosDetalhes. O Histórico planilhas registra divergências entre apelidos manuais e as duas fontes, permitindo manter o override ou removê-lo para uma série. A exportação altera somente a coluna `Apelido`; abas, linhas, colunas, dimensões, demais valores e formatação do modelo são preservados.

## Interface e acessibilidade

- **Atualizar planilhas** e **Nova transferência** ficam entre as ações principais. Histórico de alterações, Histórico planilhas, Exportar Excel e Catálogo de unidades ficam agrupados no menu secundário.
- A aba **Home** concentra a busca por série, apelido/hostname, modelo ou cidade. Após selecionar um equipamento, a tela permanece nela; abra **Retirada e Entrega** manualmente para preencher a transferência e acessar as ações do rodapé.
- Use **Pular para o conteúdo principal** para ignorar o cabeçalho. Na lista rápida, use `↑` e `↓` para navegar, `Enter` para selecionar ou abrir os resultados completos e `Esc` para fechar. Na pesquisa completa, refine por categoria e cidade ou carregue mais resultados.
- Os diálogos recebem o foco ao abrir, mantêm a navegação por `Tab` dentro do conteúdo, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas.
- Tabelas largas podem ser percorridas horizontalmente sem ocultar colunas. O cabeçalho, os botões e as ações rápidas se reorganizam em telas menores; animações respeitam `prefers-reduced-motion`.

A interface carrega estilos, fontes e ícones do servidor local; os botões de cópia usam as APIs do navegador e não dependem de endpoints externos.

## Apelidos, unidades e histórico

- Edições manuais de apelido ficam em `apelidos_modificados.json` e no histórico `historico_alteracoes.json`.
- Mudanças de hostname identificadas ao atualizar planilhas ficam no `historico_comparacoes.json`, separado do histórico manual.
- Divergências com apelidos manuais também ficam no Histórico planilhas, com ações para manter o override ou removê-lo por série.
- Endereço e localidade do cadastro são atualizados pelas planilhas EquipamentosDetalhes; o formulário de edição do equipamento não altera esses campos.
- O cadastro de unidades personalizadas é salvo em `unidades_custom.json` quando houver alterações.
- No catálogo de unidades, use os botões ao lado do CNPJ e do CEP para copiar esses dados. A interface informa sucesso, ausência do dado ou falha de cópia; se a API de área de transferência do navegador não estiver disponível, tenta um método de compatibilidade.
- Use **Histórico** para consultar alterações de apelido e, quando disponível, desfazer a alteração mais recente.
- Use **Exportar Excel** para baixar a planilha com os apelidos atualizados.

## Arquivos, backups e recuperação

- Os uploads validados substituem os inventários ativos em `planilhas_entrada`, com os nomes definidos em `app_config.py`.
- Antes de substituir inventários, a aplicação copia os arquivos atuais para `planilhas_entrada/_backups/<data-hora>-<identificador>/`, separados em `endpoint` e `detalhes`. Pelo Histórico planilhas, um backup completo pode ser validado e restaurado; o conjunto substituído é salvo em outro backup e a restauração entra no histórico, permitindo desfazê-la quando esse backup também está completo e válido.
- Gravações relacionadas usam temporários validados, bloqueios por arquivo e transações. Se uma operação falhar, a transação restaura os destinos afetados e o cache anterior.
- Uma transação interrompida deixa estado em `.transactions`. Na próxima inicialização, `integrity.py` tenta recuperar esse estado antes de carregar os arquivos. Não apague essa pasta enquanto houver uma recuperação pendente.
- A planilha de transferência é preparada para download; não é mantida como arquivo permanente pelo servidor.
- Históricos, apelidos, unidades, planilhas locais e `_backups` são ignorados pelo Git. Inclua esses dados no backup local se precisar preservar o uso da aplicação; não os adicione ao Git.

Se um backup antigo estiver ausente ou inválido, a recuperação continua manual: confira a pasta de backup e os arquivos ativos antes de qualquer substituição. A restauração pelo histórico exige os dois inventários válidos e mostra os arquivos, as datas e as contagens antes de confirmar.

## Testes automatizados

Execute a suíte com o Python do ambiente local:

```powershell
.\.venv\Scripts\python.exe -B tests\run_tests.py
```

O executor bloqueia a leitura de planilhas locais e a recuperação de transações durante a importação de main.py; em seguida, direciona os testes de integridade a um diretório temporário exclusivo dentro do projeto e o remove ao terminar. Os testes usam dados fictícios. Não use planilhas operacionais como origem ou destino de testes.

## Estrutura principal

```text
main.py                 ponto de entrada, rotas restantes e inicialização da aplicação
app_config.py           caminhos relativos ao projeto e limites de upload
integrity.py            bloqueios, transações, validação e gravação segura
domains/inventory_comparison.py normalização, comparação e apresentação do histórico de inventários
domains/inventory_update.py transação de substituição dos inventários e gravação do histórico
routers/transfers.py    contrato e geração da planilha de transferência
routers/inventory_history.py rotas de histórico e restauração de inventários
static/index.html       estrutura da interface
static/app.css          estilos locais
static/app.js           comportamento da interface
planilhas_entrada/      modelos, bases locais, baseline e cópias de segurança
tests/run_tests.py      executor seguro da suíte de testes com arquivos fictícios
requirements.txt        dependências Python fixadas
iniciar_servidor.bat    inicializador local para Windows
```

## Dados e privacidade

As bases, backups, exportações e históricos operacionais ficam locais e são ignorados pelo Git; o modelo vazio de transferência permanece versionado. Não force a inclusão desses arquivos em commits nem compartilhe cópias com dados operacionais. O servidor atende somente `127.0.0.1`, aceita chamadas da própria origem da aplicação e não possui autenticação de usuário.

Arquivos operacionais que já foram versionados permanecem recuperáveis no histórico Git local. Esta configuração impede novos rastreamentos, mas não reescreve esse histórico.
