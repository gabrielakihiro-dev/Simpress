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
- Python 3.10 ou superior, disponível pelo comando `py`.
- Acesso à internet para carregar fontes, estilos e ícones usados pela interface.

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
py -m venv .venv
```

### 3. Instale as dependências

```powershell
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 4. Confira as planilhas necessárias

Na pasta `planilhas_entrada`, confirme que existem:

- `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`, usado para gerar a planilha final.
- Pelo menos uma planilha `EquipamentosDetalhes*.xlsx` válida. No início, o sistema carrega a planilha válida mais recente dessa pasta.

A planilha EquipamentosDetalhes precisa ter, na primeira linha, colunas equivalentes a número de série, apelido ou hostname, modelo e cidade. As bases operacionais não são distribuídas pelo Git: coloque a cópia local necessária em `planilhas_entrada`.

### 5. Inicie o servidor

```powershell
.\iniciar_servidor.bat
```

O arquivo inicializador usa o ambiente `.venv` criado nos passos anteriores. Mantenha a janela aberta enquanto usar o sistema.

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

O limite de envio é de 30 MB por arquivo. Antes de substituir os relatórios, confirme que são as versões corretas. O sistema guarda cópias anteriores em `planilhas_entrada/_backups`.

O hostname vigente da InvAll é associado pelo número de série normalizado e prevalece sobre o apelido de EquipamentosDetalhes no site, na entrada rápida e na exportação. A exportação altera somente a coluna `Apelido`; abas, linhas, colunas, dimensões, demais valores e formatação do modelo são preservados. O Histórico planilhas registra, por série, o apelido anterior e o novo, separado do histórico de alterações manuais.

## Interface e acessibilidade

- **Atualizar planilhas** e **Nova transferência** ficam entre as ações principais. Histórico de alterações, Histórico planilhas, Exportar Excel e Catálogo de unidades ficam agrupados no menu secundário.
- Use **Pular para o conteúdo principal** para ignorar o cabeçalho. A entrada de série recebe o foco inicial; na lista de resultados, use `↑` e `↓` para navegar, `Enter` para preencher e `Esc` para fechar.
- Os diálogos recebem o foco ao abrir, mantêm a navegação por `Tab` dentro do conteúdo, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas.
- Tabelas largas podem ser percorridas horizontalmente sem ocultar colunas. O cabeçalho, os botões e as ações rápidas se reorganizam em telas menores; animações respeitam `prefers-reduced-motion`.

Esta etapa não adiciona dependências, endpoints ou serviços remotos.

## Apelidos, unidades e histórico

- As alterações de apelido ficam registradas em `apelidos_modificados.json` e nos arquivos de histórico.
- O cadastro de unidades personalizadas é salvo em `unidades_custom.json` quando houver alterações.
- Use **Histórico** para consultar alterações de apelido e, quando disponível, desfazer a alteração mais recente.
- Use **Exportar Excel** para baixar a planilha com os apelidos atualizados.

Esses arquivos ficam na pasta do projeto e são ignorados pelo Git. Inclua-os no backup local se precisar preservar alterações feitas durante o uso.

## Estrutura principal

```text
main.py                 servidor FastAPI e regras do sistema
static/index.html       interface web
planilhas_entrada/      modelos, bases e cópias de segurança
requirements.txt        dependências Python
iniciar_servidor.bat    inicializador para Windows
```

## Dados e privacidade

As bases, backups, exportações e históricos operacionais ficam locais e são ignorados pelo Git; o modelo vazio de transferência permanece versionado. Não force a inclusão desses arquivos em commits nem compartilhe cópias com dados operacionais. O servidor atende somente `127.0.0.1`, aceita chamadas da própria origem da aplicação e não possui autenticação de usuário.

Arquivos operacionais que já foram versionados permanecem recuperáveis no histórico Git local. Esta configuração impede novos rastreamentos, mas não reescreve esse histórico.
