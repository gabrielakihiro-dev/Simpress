# Changelog

Todas as mudanças relevantes do Simpress ficam registradas aqui, da mais nova para a mais antiga.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/) simples (`MAIOR.MENOR.CORREÇÃO`). Como numerar e publicar uma versão está em [docs/guias/versionamento.md](docs/guias/versionamento.md).

O inicializador mostra a seção da versão nova antes de perguntar se você quer atualizar.

## [Não lançado]

Proposta: publicar estas mudanças como a primeira versão, **v1.0.0** (a data será definida quando a versão for criada).

### Adicionado

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
- **Mensagens de erro mais claras:** quando uma planilha ou um formulário é recusado, a tela explica o motivo em vez de mostrar um erro genérico.

### Interno

Melhorias sem mudança visível no uso, que deixam o sistema mais fácil de manter e mais seguro de alterar:

- organização do servidor em partes menores;
- verificação de tipos ampliada;
- registro de mensagens técnicas padronizado;
- remoção de arquivos e modelos antigos sem uso.
