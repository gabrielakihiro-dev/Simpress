# Anotações do Histórico de Planilhas

As anotações são associadas a uma linha de um resultado específico. Ao gerar um novo histórico por atualização, a aplicação reaplica a anotação mais recente somente se encontrar, na mesma seção, uma linha com todos os dados exatamente iguais. A comparação desconsidera apenas os campos `anotacao` e `anotacao_id`; qualquer diferença nos demais campos impede a cópia. O novo evento recebe um identificador de anotação próprio, e a anotação anterior permanece no evento original. Se a ocorrência igual mais recente não tiver anotação, ou se linhas duplicadas e idênticas tiverem anotações conflitantes, uma anotação mais antiga não é reutilizada.

Cada linha mantém sua própria anotação nas seções **Linhas mantidas para conferência**, **Sem acesso há 7 dias ou mais**, **Equipamentos sem correspondência por fonte**, **Localidade divergente**, **Duplicidades e correspondências ambíguas** e **Séries sem local definido**. Em seções com mais de uma lista, a anotação continua vinculada à linha e à fonte correspondentes.

As anotações são salvas automaticamente e podem ter até 2.000 caracteres. A exportação do Histórico de Planilhas inclui as anotações em cada aba de registros correspondente.

No modal **Atualizar planilhas**, é possível marcar **Baixar o Histórico de Planilhas automaticamente**. Quando ativada, a preferência fica salva no navegador e, após uma atualização concluída, o aplicativo baixa o Excel com os registros e as anotações daquele dia. Se a exportação falhar, a atualização permanece concluída e o histórico continua disponível para exportação manual.

## Sincronização entre notebooks

Quando o OneDrive corporativo ou pessoal está conectado, o aplicativo grava as anotações em:

`<pasta do OneDrive>/Aplicativos/Simpress/AnotacoesHistorico`

O aplicativo procura primeiro `OneDriveCommercial` e depois `OneDrive`. Para usar outra pasta já sincronizada, configure `SIMPRESS_ANNOTATIONS_DIR` nos notebooks envolvidos.

Cada notebook precisa estar conectado à mesma conta do OneDrive e aguardar a sincronização da pasta. Um `git clone` traz o código, mas não traz as anotações. Na inicialização, a aplicação migra as anotações legadas ainda sem registro independente. As consultas não reescrevem os resultados antigos.

Se o OneDrive não estiver configurado, as anotações ficam em `anotacoes_historico` dentro do projeto e só estarão disponíveis naquele dispositivo. Esse diretório é ignorado pelo Git.

## Dados e uso simultâneo

Os arquivos compartilhados contêm somente a anotação, a seção, os identificadores, os dados mínimos da linha necessários para mostrá-la em um clone sem histórico local e uma assinatura da linha usada para confirmar igualdade exata em futuras atualizações. A assinatura não contém o conteúdo completo da linha. As planilhas e o histórico completo não são copiados para essa pasta.

Cada edição usa um arquivo JSON imutável de versão 2, com identificador de revisão próprio e a lista de revisões-base lidas pelo usuário. Os identificadores da linha e do evento permanecem os mesmos. O horário é informativo: a aplicação não escolhe uma anotação vencedora pelo relógio ou pela ordem de chegada dos arquivos.

Edições simultâneas da mesma base ficam preservadas como alternativas. A tela mostra **Conflito de anotação**. Escolha **Usar esta versão**, ou **Editar texto para resolução**, e confirme em **Resolver conflito com este texto**. Apenas escolher uma alternativa não confirma nem salva a resolução. Uma anotação vazia também pode ser escolhida. As exportações identificam o conflito e incluem suas alternativas.

Se alguma revisão-base ainda não chegou, a resolução fica indisponível: aguarde a sincronização e reabra o resultado. Uma edição atrasada que não foi observada durante a resolução pode apresentar outro conflito; ela continua preservada.

As pendências locais também usam arquivos distintos por revisão. A aplicação só remove uma pendência depois de publicar e reler a revisão correspondente. Uma nova edição criada durante a publicação mantém sua própria pendência. A confirmação significa publicação na pasta configurada deste computador; não comprova entrega ao OneDrive ou a outro dispositivo.

Rascunhos recuperados no navegador conservam as revisões-base observadas e o identificador da tentativa de envio. Assim, reabrir a tela após uma falha não transforma um rascunho antigo em substituição de uma anotação mais recente. Rascunhos legados sem essa informação são tratados como edições independentes e podem exigir resolução de conflito.

Arquivos de versão 1 continuam sendo lidos e são preservados. A migração cria cópias com identificadores determinísticos, sem apagar originais nem alterar a comparação bruta. Conteúdos legados distintos sem relação causal comprovada podem gerar conflito para revisão manual. Um texto antigo incorporado ao histórico não substitui uma anotação que já possui registro independente.

Atualize o aplicativo em todos os notebooks antes de retomar edições compartilhadas. Clientes antigos não enviam revisões-base; suas edições podem gerar alternativas concorrentes, em vez de substituir silenciosamente um texto. Não remova arquivos de revisão manualmente: eles também guardam a relação entre as versões. O OneDrive continua responsável pelo transporte dos arquivos; o protocolo preserva conflitos observados, mas não oferece confirmação de entrega nem lock distribuído.
