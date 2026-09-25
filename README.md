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

A planilha EquipamentosDetalhes precisa ter, na primeira linha, colunas equivalentes a número de série, apelido ou hostname, modelo e cidade. O arquivo `EquipamentosDetalhes_atual.xlsx` incluído no projeto atende a esse papel.

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
2. Selecione o arquivo `.xlsx` do Endpoint e o arquivo `.xlsx` do EquipamentosDetalhes.
3. Confira o resultado da comparação apresentado pelo sistema.
4. Consulte **Histórico planilhas** para rever comparações anteriores.

O limite de envio é de 30 MB por arquivo. Antes de substituir os relatórios, confirme que são as versões corretas. O sistema guarda cópias anteriores em `planilhas_entrada/_backups`.

## Apelidos, unidades e histórico

- As alterações de apelido ficam registradas em `apelidos_modificados.json` e nos arquivos de histórico.
- O cadastro de unidades personalizadas é salvo em `unidades_custom.json` quando houver alterações.
- Use **Histórico** para consultar alterações de apelido e, quando disponível, desfazer a alteração mais recente.
- Use **Exportar Excel** para baixar a planilha com os apelidos atualizados.

Esses arquivos ficam na pasta do projeto. Inclua-os no backup se precisar preservar alterações feitas durante o uso.

## Estrutura principal

```text
main.py                 servidor FastAPI e regras do sistema
static/index.html       interface web
planilhas_entrada/      modelos, bases e cópias de segurança
requirements.txt        dependências Python
iniciar_servidor.bat    inicializador para Windows
```

## Dados e privacidade

Este repositório contém planilhas de inventário operacional. Mantenha-o privado e confira os arquivos antes de compartilhar ou publicar uma cópia. O servidor atual atende somente `127.0.0.1` e não possui autenticação de usuário.
