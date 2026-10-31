# Changelog

Todas as mudanças relevantes do Simpress ficam registradas aqui, da mais nova para a mais antiga.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/) simples (`MAIOR.MENOR.CORREÇÃO`). Como numerar e publicar uma versão está em [docs/guias/versionamento.md](docs/guias/versionamento.md).

O inicializador mostra a seção da versão nova antes de perguntar se você quer atualizar.

## [Não lançado]

### Adicionado

- **Pendências de usuário logado:** quando um novo InvAll informa usuário onde há um usuário manual, ou deixa de informar um usuário que já existia, nada muda sozinho. O usuário atual continua valendo e a pendência aparece em **Mudanças de usuário logado** (e marcada na pesquisa) com os botões **Permitir substituição / Manter usuário manual** ou **Confirmar remoção / Manter usuário**. A decisão fica gravada e a mesma situação não é perguntada de novo. A troca de um usuário do Endpoint por outro, sem usuário manual, continua aplicada automaticamente.
- **Equipamentos sem usuário:** o botão **Equipamentos sem usuário**, abaixo da pesquisa da Home, lista os equipamentos da base Simpress sem usuário do Endpoint nem manual. A janela de resultados ganhou o filtro **Usuário** (**Sem usuário** e **Com usuário**), que também vale para qualquer pesquisa.
- **Usuário na exportação do histórico:** a planilha do **Histórico de Planilhas** traz as colunas **Usuário logado** e **Origem do usuário** (Endpoint ou Manual) nas abas Apelidos, Ausências, Sem acesso e Localidades. A exportação de EquipamentosDetalhes continua no formato do modelo, sem coluna nova.

## [1.0.0] - 2026-10-19

Primeira versão publicada do Simpress.

### Adicionado

- **Aba Resumo:** o **Resumo do parque** fica em uma aba própria, aberta já maximizada.
- **Alertas no painel inicial:** avisos de **Base desatualizada**, de **OS paradas** (chamados abertos sem atualização há 7 dias ou mais) e de **Divergências novas** desde a comparação anterior, cada um com um botão que leva à tela onde o caso é tratado.
- **Relatório mensal automático:** no começo de cada mês, o servidor guarda sozinho o relatório do mês anterior em `data/relatorios_mensais/`, sem substituir um relatório já salvo.
- **Relatório mensal:** o botão **Relatório mensal**, em **Históricos e Análises**, baixa uma planilha do mês com o inventário oficial por tipo e por unidade, a última comparação do mês, as OS e os pedidos abertos, concluídos e pendentes.
- **Usuário logado informado à mão:** quando o Endpoint não traz o usuário de um equipamento, você pode digitá-lo no cartão do equipamento (**Salvar usuário**, **Editar**, **Limpar**). O usuário do Endpoint sempre prevalece, e a mudança fica no **Histórico de apelidos**, com opção de desfazer.
- **Busca por usuário:** a pesquisa também encontra equipamentos pelo nome do usuário logado.
- **Avisos do Endpoint:** ao atualizar as planilhas, um equipamento que perdeu o usuário ou o hostname no Endpoint gera um aviso no **Histórico de apelidos**.
- **Contato de origem configurável:** o contato de origem das transferências (nome, e-mail e celular) agora é salvo pela própria tela de Transporte, em **Configurar contato de origem**, sem mexer no código.
- **Atualização com um clique:** ao abrir o `iniciar_servidor.bat`, o Simpress avisa quando há uma versão nova, mostra o que mudou e pergunta se você quer atualizar. A atualização é opcional e não mexe nos seus dados.
- **Manual do usuário:** um guia passo a passo para o dia a dia, em [docs/guias/manual_usuario.md](docs/guias/manual_usuario.md).

### Alterado

- **Histórico de alterações dentro do Histórico de apelidos:** o painel **Histórico de apelidos** (F8) agora traz tudo o que ficava na janela **Histórico de alterações**: busca, tipo, **Somente com ação disponível**, **Limpar filtros** e as ações **Restaurar anterior**, **Excluir aviso** e **Restaurar e excluir** no detalhe do registro. A janela antiga foi removida, e o botão de histórico na Home abre o painel. A lista não tem mais páginas: ela rola. Os dados e a API não mudaram.
- **Só versões testadas:** a atualização com um clique oferece apenas versões publicadas (com número, como `v1.0.0`) e aprovadas nos testes automáticos, e não qualquer alteração recente.
- **Destinos recentes removidos:** a tela de entrega não guarda mais o histórico de destinos recentes.
- **Mensagens de erro mais claras:** quando uma planilha ou um formulário é recusado, a tela explica o motivo em vez de mostrar um erro genérico.

### Interno

Melhorias sem mudança visível no uso, que deixam o sistema mais fácil de manter e mais seguro de alterar:

- organização do servidor em partes menores;
- verificação de tipos ampliada;
- registro de mensagens técnicas padronizado;
- remoção de arquivos e modelos antigos sem uso.
