# Anotações do Histórico de Planilhas

As anotações são associadas a uma linha de um resultado específico. Elas não são copiadas para atualizações futuras. Cada linha mantém sua própria anotação nas seções **Linhas mantidas para conferência**, **Sem acesso há 14 dias ou mais**, **Equipamentos sem correspondência por fonte**, **Localidade divergente**, **Duplicidades e correspondências ambíguas** e **Séries sem local definido**. Em seções com mais de uma lista, a anotação continua vinculada à linha e à fonte correspondentes.

As anotações são salvas automaticamente e podem ter até 2.000 caracteres. A exportação do Histórico de Planilhas inclui as anotações em cada aba de registros correspondente.

## Sincronização entre notebooks

Quando o OneDrive corporativo ou pessoal está conectado, o aplicativo grava as anotações em:

`<pasta do OneDrive>/Aplicativos/Simpress/AnotacoesHistorico`

O aplicativo procura primeiro `OneDriveCommercial` e depois `OneDrive`. Para usar outra pasta já sincronizada, configure `SIMPRESS_ANNOTATIONS_DIR` nos notebooks envolvidos.

Cada notebook precisa estar conectado à mesma conta do OneDrive e aguardar a sincronização da pasta. Um `git clone` traz o código, mas não traz as anotações. Ao abrir resultados antigos que ainda guardam anotações no histórico local, o aplicativo as copia para essa pasta compartilhada.

Se o OneDrive não estiver configurado, as anotações ficam em `anotacoes_historico` dentro do projeto e só estarão disponíveis naquele dispositivo. Esse diretório é ignorado pelo Git.

## Dados e uso simultâneo

Os arquivos compartilhados contêm somente a anotação, a seção, os identificadores e os dados mínimos da linha necessários para mostrá-la em um clone sem histórico local. As planilhas e o histórico completo não são copiados para essa pasta.

O OneDrive sincroniza arquivos entre dispositivos, mas não coordena edições simultâneas como um serviço transacional. Para evitar conflitos na mesma anotação, edite em um notebook por vez e aguarde o OneDrive concluir a sincronização antes de continuar no outro.
