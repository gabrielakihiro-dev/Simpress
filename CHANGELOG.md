# Changelog

Todas as mudanças relevantes do Simpress ficam registradas aqui, da mais nova para a mais antiga.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/) simples (`MAIOR.MENOR.CORREÇÃO`). Como numerar e publicar uma versão está em [docs/guias/versionamento.md](docs/guias/versionamento.md).

O inicializador mostra a seção da versão nova antes de perguntar se você quer atualizar.

## [Não lançado]

## [1.0.0] - 2026-10-19

Primeira versão publicada do Simpress.

### Adicionado

- **Aba Resumo:** o **Resumo do parque** e o **Uso nos últimos 30 dias** ficam numa aba própria, aberta já maximizada.
- **Alertas no painel inicial:** avisos de **Base desatualizada**, de **OS paradas** (chamados abertos sem atualização há 7 dias ou mais) e de **Divergências novas** desde a comparação anterior, cada um com um botão que leva à tela onde o caso é tratado.
- **Relatório mensal automático:** no começo de cada mês, o servidor guarda sozinho o relatório do mês anterior em `data/relatorios_mensais/`, sem substituir um relatório já salvo.
- **Relatório mensal:** o botão **Relatório mensal**, em **Históricos e Análises**, baixa uma planilha do mês com o inventário oficial por tipo e por unidade, a última comparação do mês, as OS e os pedidos abertos, concluídos e pendentes, e o uso do sistema no mês.
- **Usuário logado informado à mão:** quando o Endpoint não traz o usuário de um equipamento, você pode digitá-lo no cartão do equipamento (**Salvar usuário**, **Editar**, **Limpar**). O usuário do Endpoint sempre prevalece, e a mudança fica no **Histórico de alterações**, com opção de desfazer.
- **Busca por usuário:** a pesquisa também encontra equipamentos pelo nome do usuário logado.
- **Avisos do Endpoint:** ao atualizar as planilhas, um equipamento que perdeu o usuário ou o hostname no Endpoint gera um aviso no **Histórico de alterações**.
- **Uso nos últimos 30 dias:** o painel inicial mostra quantas transferências, comparações, exportações, OS conciliadas e buscas foram feitas, com uma estimativa das horas poupadas.
- **Contato de origem configurável:** o contato de origem das transferências (nome, e-mail e celular) agora é salvo pela própria tela de Transporte, em **Configurar contato de origem**, sem mexer no código.
- **Atualização com um clique:** ao abrir o `iniciar_servidor.bat`, o Simpress avisa quando há uma versão nova, mostra o que mudou e pergunta se você quer atualizar. A atualização é opcional e não mexe nos seus dados.
- **Manual do usuário:** um guia passo a passo para o dia a dia, em [docs/guias/manual_usuario.md](docs/guias/manual_usuario.md).

### Alterado

- **Só versões testadas:** a atualização com um clique oferece apenas versões publicadas (com número, como `v1.0.0`) e aprovadas nos testes automáticos, e não qualquer alteração recente.
- **Destinos recentes removidos:** a tela de entrega não guarda mais o histórico de destinos recentes.
- **Mensagens de erro mais claras:** quando uma planilha ou um formulário é recusado, a tela explica o motivo em vez de mostrar um erro genérico.

### Interno

Melhorias sem mudança visível no uso, que deixam o sistema mais fácil de manter e mais seguro de alterar:

- organização do servidor em partes menores;
- verificação de tipos ampliada;
- registro de mensagens técnicas padronizado;
- remoção de arquivos e modelos antigos sem uso.
