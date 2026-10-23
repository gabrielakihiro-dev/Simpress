# Resumo de OS por equipamento

## Objetivo

Exibir na aba Resumo os registros da importação atual do Acompanhamento de Chamados, associados ao equipamento pela série.

## Conteúdo e comportamento

- Incluir OS da Simpress e do Oracle, abertas ou encerradas, removendo linhas sem série ou sem número de OS.
- Mostrar fonte, série, número da OS, usuário logado, hostname, descrição da respectiva solicitação Oracle e número de chamado informado manualmente.
- Exibir tabela em desktop e cartões em telas pequenas. Escapar conteúdo de planilhas como texto.
- Buscar usuário e hostname em lote; aplicar a correspondência de Mac já existente e não escolher candidatos ambíguos.
- Mostrar o prefixo `UTIC-AAAA-` com o ano corrente para novos vínculos. Guardar somente os dígitos digitados junto ao prefixo completo; manter ano e valor anteriores nos vínculos existentes.
- Salvar o número associado à chave fonte + série normalizada + número da OS em arquivo local dentro de `data/state`, de forma atômica, sem inserir o dado nas planilhas nem no histórico importado.
- Carregar ao abrir Resumo e atualizar após nova importação de chamados, alteração do usuário/hostname ou recarga explícita da aba. Não deixar uma resposta antiga substituir dados de atualização mais recente.
- Diferenciar carregamento, falta de OS, chamado não informado, dados de usuário/hostname ausentes ou ambíguos e falha de consulta.

## Verificação

Cobrir ambas as fontes, múltiplas solicitações e OS, OS encerradas, vínculos UTIC, ausência e ambiguidade, associação Mac única, erros de carregamento, persistência após recarga e atualização após importação. Verificar temas claro/escuro e larguras desktop/mobile.
