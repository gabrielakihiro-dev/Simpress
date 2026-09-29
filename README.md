# Simpress — Transferência de Equipamentos

Aplicação web local para consultar equipamentos por número de série, preparar transferências Simpress e gerar a planilha oficial em Excel. O projeto usa FastAPI no servidor, uma interface em `static/index.html` e arquivos `.xlsx` na pasta `planilhas_entrada`.

## O que o sistema faz

- Busca equipamentos pelo número de série ou por leitor de código de barras.
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

Na inicialização, o terminal informa quais arquivos locais foram encontrados e quais funções ficam indisponíveis quando uma dependência está ausente ou inválida.

### 6. Abra a aplicação

No navegador, acesse:

- Aplicação: <http://127.0.0.1:8000>
- Documentação da API: <http://127.0.0.1:8000/docs>

Para encerrar o servidor, volte à janela em que ele está rodando e pressione `Ctrl+C`.

## Passo a passo: gerar uma transferência

1. Inicie o servidor e abra a aplicação.
2. Na área **Entrada Rápida de Equipamento**, leia o código de barras ou digite o número de série e pressione `Enter`.
3. Confira os dados do equipamento encontrados na base.
4. Preencha e revise as informações de retirada e entrega.
5. Clique em **Gerar e Baixar Planilha Oficial (.xlsx)**.
6. Abra o arquivo baixado e confira os dados antes de encaminhá-lo.

## Atualizar e comparar inventários

1. Na aplicação, abra **Atualizar Planilhas**.
2. Selecione os arquivos `.xlsx` do Endpoint e do EquipamentosDetalhes.
3. Confira as listas de ausências por fonte, as divergências de local e os registros ambíguos apresentados pelo sistema. A comparação usa somente essas duas fontes; a base principal de equipamentos continua disponível para gerar as planilhas pelo botão de exportação.
4. Consulte **Histórico planilhas** para rever comparações anteriores.

O limite de envio é de 30 MB por arquivo. Cada atualização substitui integralmente os dois inventários ativos pelos arquivos validados enviados; séries ausentes no novo relatório deixam de compor a base carregada. Antes de enviar, confirme que são as versões corretas. O sistema guarda cópias anteriores em `planilhas_entrada/_backups` para recuperação manual.

O apelido alterado manualmente fica associado à série e prevalece nas pesquisas, na entrada rápida e na exportação, mesmo após recarregar ou atualizar as planilhas. Sem override manual, o hostname único da InvAll prevalece sobre o valor de EquipamentosDetalhes. Ao atualizar os arquivos, endereço e localidade são sincronizados a partir de EquipamentosDetalhes. O Histórico planilhas registra divergências entre apelidos manuais e as duas fontes, permitindo manter o override ou removê-lo para uma série. A exportação altera somente a coluna `Apelido`; abas, linhas, colunas, dimensões, demais valores e formatação do modelo são preservados.

## Interface e acessibilidade

- **Atualizar planilhas** e **Nova transferência** ficam entre as ações principais. Histórico de alterações, Histórico planilhas, Exportar Excel e Catálogo de unidades ficam agrupados no menu secundário.
- Use **Pular para o conteúdo principal** para ignorar o cabeçalho. A entrada de série recebe o foco inicial; na lista de resultados, use `↑` e `↓` para navegar, `Enter` para preencher e `Esc` para fechar.
- Os diálogos recebem o foco ao abrir, mantêm a navegação por `Tab` dentro do conteúdo, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas.
- Tabelas largas podem ser percorridas horizontalmente sem ocultar colunas. O cabeçalho, os botões e as ações rápidas se reorganizam em telas menores; animações respeitam `prefers-reduced-motion`.

Esta etapa não adiciona dependências, endpoints ou serviços remotos.

## Apelidos, unidades e histórico

- Edições manuais de apelido ficam em `apelidos_modificados.json` e no histórico `historico_alteracoes.json`.
- Mudanças de hostname identificadas ao atualizar planilhas ficam no `historico_comparacoes.json`, separado do histórico manual.
- Divergências com apelidos manuais também ficam no Histórico planilhas, com ações para manter o override ou removê-lo por série.
- Endereço e localidade do cadastro são atualizados pelas planilhas EquipamentosDetalhes; o formulário de edição do equipamento não altera esses campos.
- O cadastro de unidades personalizadas é salvo em `unidades_custom.json` quando houver alterações.
- Use **Histórico** para consultar alterações de apelido e, quando disponível, desfazer a alteração mais recente.
- Use **Exportar Excel** para baixar a planilha com os apelidos atualizados.

## Arquivos, backups e recuperação

- Os uploads validados substituem os inventários ativos em `planilhas_entrada`, com os nomes definidos em `app_config.py`.
- Antes de substituir inventários, a aplicação copia os arquivos atuais para `planilhas_entrada/_backups/<data-hora>-<identificador>/`, separados em `endpoint` e `detalhes`. Os backups são mantidos para recuperação manual.
- Gravações relacionadas usam temporários validados, bloqueios por arquivo e transações. Se uma operação falhar, a transação restaura os destinos afetados e o cache anterior.
- Uma transação interrompida deixa estado em `.transactions`. Na próxima inicialização, `integrity.py` tenta recuperar esse estado antes de carregar os arquivos. Não apague essa pasta enquanto houver uma recuperação pendente.
- A planilha de transferência é preparada para download; não é mantida como arquivo permanente pelo servidor.
- Históricos, apelidos, unidades, planilhas locais e `_backups` são ignorados pelo Git. Inclua esses dados no backup local se precisar preservar o uso da aplicação; não os adicione ao Git.

Se for necessário recuperar um inventário de um backup antigo, confira a pasta de backup e os arquivos ativos antes de qualquer substituição. A recuperação automática cobre transações interrompidas; a restauração de um backup antigo é manual.

## Testes automatizados

Execute a suíte com o Python do ambiente local:

```powershell
.\.venv\Scripts\python.exe -B tests\run_tests.py
```

O executor bloqueia a leitura de planilhas locais e a recuperação de transações durante a importação de main.py; em seguida, direciona os testes de integridade a um diretório temporário exclusivo dentro do projeto e o remove ao terminar. Os testes usam dados fictícios. Não use planilhas operacionais como origem ou destino de testes.

## Estrutura principal

```text
main.py                 ponto de entrada compatível, rotas e fluxo da aplicação
app_config.py           caminhos relativos ao projeto e limites de upload
integrity.py            bloqueios, transações, validação e gravação segura
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
