# Changelog

Todas as mudanças relevantes do Simpress ficam registradas aqui, da mais nova para a mais antiga.

O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [Versionamento Semântico](https://semver.org/lang/pt-BR/) simples (`MAIOR.MENOR.CORREÇÃO`). Como numerar e publicar uma versão está em [docs/guias/versionamento.md](docs/guias/versionamento.md).

O inicializador mostra a seção da versão nova antes de perguntar se você quer atualizar.

## [Não lançado]

### Adicionado

- **Cobertura de equipamentos (Entrega 1A):** o painel **Cobertura** (F10, menu Ferramentas) cadastra necessidades por data e cidade e mostra quais vagas são **Atendível**, **Condicionada** ou **Sem cobertura**, com disponíveis, reservas e kit, movimentações e devoluções. **Preparar Transporte** só preenche a aba **Transporte (F2)**; a planilha continua sendo gerada pelo seu clique e fica ligada à movimentação. Tudo é gravado só em `data/state/operacao_cobertura*.json`; `EquipamentosDetalhes` não muda. O assistente responde perguntas como "vai faltar notebook na Cidade A dia 20?" pela consulta `listar_cobertura`.
- **Ativos por regional com filtros:** no **Resumo (F3)**, o cartão **Ativos por regional** ganhou filtros por categoria (**Todos**, **Notebooks**, **MacBooks**, **Monitores**, **Fones**, cada um com a contagem), barras em duas colunas no computador, todas as regionais visíveis por padrão e o botão **Ver menos** para recolher às 8 maiores. A tabela **Total de ativos** foi removida do Resumo; a busca de equipamentos continua na Home (F1). Só muda a tela, nada é gravado.
- **Editar a descrição do chamado:** na aba **Chamados (F5)**, o bloco **Descrição** do cartão ganha um ícone de lápis que abre um campo com **Salvar**, **Cancelar** e **Restaurar original**. Vale para chamado novo e para chamado antigo já lido; o finalizado continua só leitura. O texto fica salvo só neste site (CPF e senhas são mascarados): no chamado novo vira a coluna H no próximo **Atualizar Dashboard**, e nada é escrito no SoftExpert, no SharePoint nem em linhas que já estão no Dashboard. O Assistente também edita a descrição, com cartão de confirmação.
- **Padrões do API SEBRAE nos chamados novos:** quando o solicitante é **API SEBRAE**, o cartão do chamado novo já vem com Responsável (A) `CLIENTE`, B `OUTRO`, Status (D) `EM ABERTO`, Tipo do chamado (J) `INCIDENTE`, Tipo SLA (S) `DISPONIBILIDADE` e a descrição **Revisado.** salva uma única vez. Nada é finalizado sozinho: você ainda clica em **Finalizar no SoftExpert**. Os outros solicitantes continuam só com D e S preenchidos.
- **Pendências de usuário logado:** quando um novo InvAll informa usuário onde há um usuário manual, ou deixa de informar um usuário que já existia, nada muda sozinho. O usuário atual continua valendo e a pendência aparece em **Mudanças de usuário logado** (e marcada na pesquisa) com os botões **Permitir substituição / Manter usuário manual** ou **Confirmar remoção / Manter usuário**. A decisão fica gravada e a mesma situação não é perguntada de novo. A troca de um usuário do Endpoint por outro, sem usuário manual, continua aplicada automaticamente.
- **Equipamentos sem usuário:** a lista da Home tem os filtros **Todos**, **Sem usuário**, **7+ dias** e **Divergentes**, e o selo **Sem usuário** de um notebook ou MacBook leva à seção **Sem usuário** do **Resumo (F3)**, que lista os notebooks sem usuário do Endpoint nem manual mesmo sem comparação salva. A janela de resultados ganhou o filtro **Usuário** (**Sem usuário** e **Com usuário**), que também vale para qualquer pesquisa.
- **Usuário na exportação do histórico:** a planilha do **Histórico de Planilhas** traz as colunas **Usuário logado** e **Origem do usuário** (Endpoint ou Manual) nas abas Apelidos, Ausências, Sem acesso e Localidades. A exportação de EquipamentosDetalhes continua no formato do modelo, sem coluna nova.
- **Consultar no Endpoint:** na Home, com um equipamento selecionado, **Consultar no Endpoint** lê ao vivo no Endpoint Central, pelo Chrome de automação, o `Usuário do último logon` daquela série. É só leitura: nada é gravado no Endpoint, nas planilhas nem nos históricos.
- **Controle remoto:** o botão **Controle remoto**, ao lado, abre a conexão remota do Endpoint Central para o equipamento selecionado (motivo `acesso`, **Conectar**). Só acontece pelo seu clique ou por um pedido ao Assistente confirmado no cartão.
- **Apelidos no UX Simpress:** depois do download da exportação de equipamentos, a rotina `ux_apelidos` envia a mesma planilha ao UX Simpress, confirma o contrato `16467` e clica uma única vez em **Salvar edições**. Um resultado incerto pede conferência manual e nunca é repetido sozinho.
- **Repetir a cada 30 minutos:** na aba **Automação**, liga o agendamento de **Baixar, importar e buscar** do Dashboard do Sebrae. Vem pausado, só roda com o servidor ligado, pula a tentativa quando há cópia gerada ainda não enviada e não envia nada ao SharePoint nem finaliza chamados.
- **Representantes regionais editáveis:** o botão **Editar** (Retirada e Entrega) altera o representante regional do SEBRAE/PR de uma cidade, sem reiniciar o servidor. As alterações ficam só neste computador, em `config/representantes_regionais.json`, e **Restaurar padrão** volta ao cadastro original.
- **Chamados do Sebrae:** a rotina `sebrae` lê no SoftExpert os chamados que o Dashboard importado ainda não tem, e **Baixar, importar e buscar** baixa o Dashboard da pasta `DASHBOARD SEBRAE` antes. A aba **Chamados (F5)** separa **Chamados novos**, **Chamados antigos em aberto** e **Chamados finalizados**, liga cada UTIC à OS automaticamente e gera a cópia do Dashboard em **Atualizar Dashboard**. Gravam fora do computador só **Enviar ao SharePoint** e **Finalizar no SoftExpert**; finalizar é irreversível e pede confirmação.
- **Assistente (F9):** chat no canto da tela que consulta o próprio Simpress pelo OpenRouter, ou pelo DeepSeek com `DEEPSEEK_API_KEY`. Aceita anexos, mensagem de voz, instruções, lembretes, histórico com **Exportar PDF**, relatórios para baixar e busca na web (desligada por padrão). Toda alteração passa por um cartão de confirmação; CPFs, nomes, e-mails, telefones e senhas são mascarados antes do envio do texto.
- **Nomes do Microsoft Entra:** em **Atualizar planilhas**, o CSV de usuários do Entra mostra o nome da pessoa ao lado do login, na busca e no cartão do equipamento, sem alterar a base oficial.
- **Verificar usuários:** rotina da aba **Automação** que confere no Endpoint Central as pendências de usuário logado e registra as decisões no Simpress local.
- **Hostname duplicado do Endpoint:** quando a mesma série tem dois hostnames, **Remover mais antigo** descarta o mais antigo depois da confirmação, e **Desfazer** devolve a duplicidade. A planilha do Endpoint não é alterada.
- **Instalação em máquina nova:** `instalar_primeira_vez.bat` instala o Python 3.12 se faltar, cria o `.venv`, instala as dependências e o Chromium do Playwright e confere o Google Chrome da automação.

### Alterado

- **Interface Cockpit:** as telas foram reorganizadas em abas com atalhos (**Home** F1, **Transporte** F2, **Resumo** F3, **Automação** F4, **Chamados** F5, **OS** F6), com **Histórico de apelidos** (F7) e **Relatório mensal** (F8) no menu de ferramentas e o **Assistente** em F9. A Home ganhou o cartão **Chamados abertos** do equipamento selecionado.

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
