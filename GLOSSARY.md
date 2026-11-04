# Glossário do Simpress

O Simpress é um sistema local que compara o cadastro de equipamentos da Simpress com o inventário do Endpoint e acompanha os chamados e as OS do Sebrae. Este glossário define os termos do domínio; as regras ficam no `AGENTS.md`.

## Linguagem

### Fontes de dados

**EquipamentosDetalhes**:
Cadastro oficial de equipamentos, vindo do ZIP fornecido mais recentemente pelo usuário; no Histórico de Planilhas aparece como `na Simpress`.
_Regra_: [AGENTS.md, "Fonte oficial do cadastro de equipamentos"](./AGENTS.md)

**InvAll**:
Planilha `InvAllComputersSummary` exportada do Endpoint, fonte auxiliar de hostname e de comparação.
_Regra_: [AGENTS.md, "Fonte oficial do cadastro de equipamentos"](./AGENTS.md)

**Endpoint**:
O Endpoint Central, sistema de inventário de onde vêm o hostname e o usuário do último logon dos computadores; nome visível da fonte: `No Endpoint`.
_Regra_: [AGENTS.md, "Textos aprovados da interface"](./AGENTS.md)

**Hostname no Endpoint**:
Nome do computador registrado no Endpoint, usado como cabeçalho na tabela `Linhas mantidas para conferência` do Histórico de Planilhas.
_Regra_: [AGENTS.md, "Rótulos do Histórico de Planilhas"](./AGENTS.md)

**UX Simpress**:
Sistema da Simpress onde ficam os apelidos e o id dos equipamentos do contrato do Sebrae e de onde se exporta inventário.
_Regra_: [AGENTS.md, "Rotina de exportação de inventários"](./AGENTS.md)

**Oracle**:
Sistema cuja planilha de Gestão de Solicitações alimenta o acompanhamento de OS.
_Regra_: [AGENTS.md, "Rotina de OS (Oracle e UX)"](./AGENTS.md)

**SoftExpert**:
Sistema do Sebrae onde os chamados são abertos, lidos e finalizados.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**Entra**:
Microsoft Entra, diretório de onde se importam nomes de usuários.
_Regra_: [AGENTS.md, "Importação de nomes do Microsoft Entra"](./AGENTS.md)

### Equipamentos e comparação

**Série**:
Identificador de um equipamento, usado para cruzar as fontes.

**Série equivalente de MacBook**:
Série de MacBook do Endpoint sem o `S` inicial, tratada como a mesma série de EquipamentosDetalhes com o `S`.
_Regra_: [AGENTS.md, "Fonte oficial do cadastro de equipamentos"](./AGENTS.md)

**Comparação**:
Confronto entre o cadastro EquipamentosDetalhes e o inventário do Endpoint, na aba Comparação (F7).
_Regra_: [AGENTS.md, "Equipamentos do Sebrae nas comparações Simpress"](./AGENTS.md)

**ausentes_em_detalhes**:
Notebooks do Endpoint sem correspondência em EquipamentosDetalhes.
_Regra_: [AGENTS.md, "Equipamentos do Sebrae nas comparações Simpress"](./AGENTS.md)

**Notebook próprio do Sebrae**:
Notebook que pertence ao Sebrae e não ao inventário da Simpress.
_Regra_: [AGENTS.md, "Equipamentos do Sebrae nas comparações Simpress"](./AGENTS.md)

**Histórico de Planilhas**:
Registro das comparações salvas a cada atualização de planilhas, consultável e exportável com anotações.
_Regra_: [AGENTS.md, "Rótulos do Histórico de Planilhas"](./AGENTS.md)

**Anotação**:
Texto livre ligado a uma linha das seções detalhadas do Histórico de Planilhas.
_Regra_: [AGENTS.md, "Anotações do Histórico de Planilhas"](./AGENTS.md)

**Planilha Exportada com Sucesso!**:
Texto exato que confirma somente o download da planilha exportada.
_Regra_: [AGENTS.md, "Textos aprovados da interface"](./AGENTS.md)

### Chamados e OS

**Dashboard Operacional_SEBRAE**:
Planilha do Excel, guardada na pasta `DASHBOARD SEBRAE` do SharePoint, que lista os chamados do Sebrae na aba `CHAMADOS`.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**UTIC**:
Número de um chamado, no formato `UTIC-AAAA-N`.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**Chamado novo**:
Chamado do SoftExpert cujo número ainda não está na coluna C do Dashboard.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**Chamado antigo**:
Chamado já presente no Dashboard com status `EM ABERTO` ou vazio.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**Chamado finalizado**:
Chamado que o site finalizou no SoftExpert com sucesso.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

**Chamados**:
Aba F5 do Cockpit, com os chamados do Sebrae.
_Evitar_: `Chamados Sebrae` (rótulo antigo da aba)
_Regra_: [AGENTS.md, "Navegação do Cockpit e atalhos (31/10/2026)"](./AGENTS.md)

**OS**:
Solicitação de atendimento acompanhada na aba F6, vinda das planilhas da Simpress (Acompanhamento de Pedidos) e do Oracle.
_Evitar_: `Chamados` (rótulo antigo da aba F6)
_Regra_: [AGENTS.md, "Aba OS (acompanhamento de OS)"](./AGENTS.md)

**Vínculo UTIC ↔ OS**:
Ligação automática entre um chamado e uma OS que têm a mesma série.
_Regra_: [AGENTS.md, "Chamados novos do Sebrae"](./AGENTS.md)

### Interface e automação

**Cockpit**:
Interface do site, com as abas F1 a F10 e o menu Ferramentas.
_Regra_: [AGENTS.md, "Navegação do Cockpit e atalhos (31/10/2026)"](./AGENTS.md)

**Home**:
Aba F1 do Cockpit, onde se pesquisa e se seleciona um equipamento.
_Regra_: [AGENTS.md, "Consulta ao vivo do Endpoint na Home (03/11/2026)"](./AGENTS.md)

**Controle remoto**:
Conexão remota ao computador de um equipamento, aberta no Endpoint por ação explícita do usuário.
_Regra_: [AGENTS.md, "Consulta ao vivo do Endpoint na Home (03/11/2026)"](./AGENTS.md)

**Assistente**:
Chat do Cockpit (F10) que responde sobre os dados do Simpress usando ferramentas.
_Regra_: [AGENTS.md, "Assistente (OpenRouter)"](./AGENTS.md)

**Rotina**:
Fluxo automatizado no Chrome de automação, iniciado na aba Automação (F4), como `login`, `inventarios`, `os`, `sebrae` ou `dashboard`.
_Regra_: [AGENTS.md, "Rotina de exportação de inventários"](./AGENTS.md)

**Chrome de automação**:
Chrome controlado pelas rotinas por CDP na porta 9333.
_Regra_: [AGENTS.md, "Consulta ao vivo do Endpoint na Home (03/11/2026)"](./AGENTS.md)

**Trava**:
Bloqueio que impede duas rotinas de usar o Chrome de automação ao mesmo tempo.
_Regra_: [AGENTS.md, "Consulta ao vivo do Endpoint na Home (03/11/2026)"](./AGENTS.md)

## Relações

- EquipamentosDetalhes define quais equipamentos existem; InvAll e Endpoint só auxiliam hostname e comparação.
- Um chamado (UTIC) e uma OS se ligam pela mesma série.
- Toda Rotina usa o Chrome de automação sob a Trava.
