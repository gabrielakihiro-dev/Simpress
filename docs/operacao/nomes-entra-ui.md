# Nomes do Microsoft Entra no Simpress

## Fluxo de importação

Na tela **Atualizar planilhas**, uma seção própria aceita o CSV de usuários exportado do Microsoft Entra. A importação mostra a quantidade de contas `@pr.sebrae.com.br` válidas, a data da última atualização e um botão para baixar o XLSX compacto com as colunas **Login** e **Display Name**. O mesmo processamento aceita um CSV em `data/state/entrada_usuarios_entra/pendentes/<lote>/`; o resultado e o arquivo original ficam em `processadas` ou `falhas` com `_resultado.json`. Um login que aparece com nomes diferentes no CSV é ambíguo: fica fora do cadastro, as demais contas são importadas e a contagem `logins_ignorados` aparece no resumo (tela, estado e `_resultado.json`) somente quando maior que zero. Linha inválida (login ou nome vazio, nome longo) também é ignorada e contada em `logins_ignorados`; o CSV só é rejeitado quando nenhuma conta válida sobra. A atualização do Entra é independente dos inventários e não altera a base oficial de equipamentos.

## Painel de disponibilidade

O painel **Disponibilidade das funções** da Home conta o cadastro do Entra (`files.nomes_entra` em `/api/prontidao`) como mais um arquivo e mostra o cartão **Nomes do Microsoft Entra** com o estado Pendente, Disponível ou Inválido e o botão **Importar**, que abre **Atualizar planilhas**. Nenhuma função depende dele: sem importação, o painel apenas indica pendência e as telas continuam mostrando só o login. Importar o CSV pela tela atualiza o painel.

## Identificação da pessoa

O login da InvAll continua visível como valor original. Quando há correspondência exata e única entre o login individual e a parte anterior a `@pr.sebrae.com.br`, o nome exibido é o `displayName` do Entra, incluindo prefixos de desligamento. Séries ou logins ambíguos não recebem nome automaticamente. Para notebook ou MacBook da base oficial sem nome do Entra, o operador pode informar ou limpar um nome manual por série; o nome manual está vinculado ao login vigente e deixa de aparecer se o login mudar. A chegada de um nome do Entra tem prioridade.

Na Home, o cartão do equipamento e as listas de pesquisa mostram login e nome separados. A busca rápida e a completa aceitam partes do nome, ignorando maiúsculas e acentos, sem mudar a prioridade de série e hostname. Transporte, históricos de planilhas e alterações, histórico de transferências e cartões de chamados mostram o mesmo nome resolvido. Históricos consultam o cadastro de nomes vigente sem alterar eventos armazenados; em mudanças de usuário, os logins anterior e novo são resolvidos separadamente.
