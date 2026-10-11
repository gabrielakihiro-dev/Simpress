# Prompts para correção da auditoria do Simpress

Data: 11/10/2026
Projeto: C:\Users\Gabriel\Desktop\Simpress
Origem: auditoria desta conversa, com 13 apontamentos.

Este arquivo prepara as execuções futuras. A geração deste documento não executa as correções. Cada bloco é um prompt independente para implementação local e validação, com escopo limitado.

## Modelos, versões e níveis

As versões consideradas, presentes na lista de modelos exposta por este ambiente, são:

| Família | Versão utilizada | Identificador |
| --- | --- | --- |
| Sol | GPT-6.1 Sol | gpt-6.1-sol |
| Terra | GPT-5.6 Terra | gpt-5.6-terra |
| Luna | GPT-6 Luna | gpt-6-luna |

A documentação oficial apresenta GPT-6.1 Sol para trabalho complexo de código, GPT-6 Luna para tarefas focadas e GPT-5.6 Terra como opção de equilíbrio entre capacidade e custo. A atribuição de um modelo a cada correção é minha recomendação técnica, não um benchmark destes prompts. [Guia oficial das famílias de modelos](https://developers.openai.com/api/docs/guides/latest-model).

“Nível” significa esforço de raciocínio. medium = médio; high = alto. Comece pelos níveis indicados. Não pressupus ganho comprovado com xhigh, max ou ultra; avalie um nível superior somente se os testes representativos mostrarem necessidade e benefício. [Orientação oficial sobre esforço de raciocínio](https://developers.openai.com/api/docs/guides/deployment-checklist).

Selecione modelo e nível na interface antes de enviar o prompt. Escrever o nome do modelo no texto não muda a configuração da execução. Se a opção não estiver disponível no seu seletor, registre a diferença antes de usar uma alternativa; não invente “GPT-6 Terra”. As opções podem mudar após a data deste documento.

## Matriz de execução

| Execução | Correção | Modelo recomendado | Nível |
| --- | --- | --- | --- |
| 1 | [CRÍTICO] Versionar anotações e impedir sobrescritas na sincronização | GPT-6.1 Sol | high |
| 2 | [ALTO] Tornar a importação de chamados segura contra concorrência | GPT-6.1 Sol | high |
| 3 | [ALTO] Corrigir a falsa confirmação do autosave | GPT-6.1 Sol | high |
| 4 | [ALTO] Impedir fórmulas nos textos do resumo exportado | GPT-5.6 Terra | high |
| 5 | [ALTO] Validar o cliente real no modo local | GPT-6.1 Sol | high |
| 6 | [ALTO] Centralizar a anotação efetiva para herança e exibição | GPT-6.1 Sol | high |
| 7 | [MÉDIO] Enfileirar anotações herdadas na mesma transação do histórico | GPT-6.1 Sol | high |
| 8 | [MÉDIO] Uniformizar a validação do endpoint de apelidos | GPT-6 Luna | medium |
| 9 | [MÉDIO] Rejeitar cabeçalhos ambíguos na importação de chamados | GPT-5.6 Terra | high |
| 10 | [MÉDIO] Eliminar buscas quadráticas nas linhas do tempo | GPT-5.6 Terra | high |
| 11 | [MÉDIO] Evitar reconstrução integral do estado nas buscas PostgreSQL | GPT-6.1 Sol | high |
| 12 | [MÉDIO] Implementar idempotência na atualização local de inventário | GPT-6.1 Sol | high |
| 13 | [BAIXO] Corrigir a resolução de cabeçalhos das estatísticas por tipo | GPT-6 Luna | medium |
| 14 | Revisão final das 13 correções, sem implementar alterações | GPT-6.1 Sol | high |

Use somente o modelo recomendado de cada linha; não é necessário executar a mesma correção nos três modelos. Luna foi reservado a ajustes localizados, Terra às tarefas intermediárias e Sol às mudanças com maior risco de integridade, concorrência e segurança.

## Ordem e dependências

Execute uma etapa por vez, revisando seu resultado antes da seguinte. A numeração corresponde aos achados da auditoria, não a uma obrigação de ordem estritamente numérica.

Ordem sugerida: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 12 → 10 → 11 → 13 → 14**.

Se houver exposição do servidor pela rede, antecipe a etapa 5. As dependências obrigatórias são: 6 depende de 1; 7 depende de 1 e 6; 12 depende de 1, 6 e 7; 10 deve consumir os contratos estabilizados de 1, 2 e 6.

Não execute simultaneamente etapas que editam main.py, routers/operations.py ou domains/inventory_update.py no mesmo checkout. Estes prompts não autorizam criar chats, enviar mensagens a outros chats ou acionar agentes automaticamente.

Cada prompt repete as restrições essenciais para funcionar em uma conversa separada. Se executar em outro chat, forneça o projeto e os resultados das etapas dependentes; o arquivo não transfere automaticamente o histórico da conversa.

## Limites da auditoria de origem

Os resultados informados foram 92 testes JavaScript e 41 testes Python focados aprovados. A suíte Python completa ficou bloqueada na criação de sockets do ambiente. Não houve validação real de navegador, PostgreSQL/Storage ativo, entrega pelo OneDrive ou CVEs. Esses resultados são contexto da auditoria, não comprovam as futuras correções. Cada execução deve produzir sua própria evidência.

## Execução 01 — Versionar anotações e impedir sobrescritas na sincronização

- Achado: 1, [CRÍTICO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma. Deve preceder as etapas 6 e 7.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Versionar anotações e impedir sobrescritas na sincronização.

Pontos de partida:
routers/inventory_history.py (_sync_annotation_record, aproximadamente linha 298); domains/history_annotations.py (save_history_annotation, aproximadamente linha 82); routers/operations.py (_persist_ticket_annotation, aproximadamente linha 227).
Problema observado:
Uma pendência local antiga sobrescreveu uma anotação compartilhada mais recente e foi removida como sincronizada. A escrita atômica atual não possui controle de revisão.

Implemente:
- Um protocolo de revisões imutáveis por evento/linha, incluindo a revisão-base que o usuário editou. Preserve os IDs estáveis atuais da linha e crie um ID distinto para cada revisão.
- Detecção explícita de revisões concorrentes; não escolha silenciosamente a última gravação ou o maior horário. Considere relógios divergentes entre máquinas e arquivos recebidos fora de ordem.
- Migração compatível e idempotente dos registros legados, sem apagar originais nem reescrever comparações brutas.
- Publicação idempotente da mesma revisão. Confirme a revisão publicada antes de remover a pendência e preserve uma pendência substituída durante a sincronização.
- Uso do mesmo protocolo nas anotações de chamados e do Histórico de Planilhas. Um lock local isolado não resolve concorrência entre clones.
- Uma forma mínima de sinalizar conflito e preservar as alternativas para resolução explícita, sem redesenhar a interface.

Critérios de aceite e testes:
1. Pendência antiga nunca elimina revisão mais recente.
2. Dois clones editando a mesma revisão preservam ambas as alterações e sinalizam conflito.
3. Edição durante a sincronização, repetição da publicação e falha de rede não perdem versões.
4. Anotação vazia é uma revisão válida.
5. Um clone sem histórico local consegue ler as anotações sincronizadas.
6. Registros legados e limite de 2.000 caracteres continuam funcionando.
Use duas raízes temporárias para simular clones. Não prometa provar a entrega do OneDrive com testes locais.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 02 — Tornar a importação de chamados segura contra concorrência

- Achado: 2, [ALTO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma. Revalidar a integração com a etapa 1, caso ela já esteja aplicada.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Tornar a importação de chamados segura contra concorrência.

Pontos de partida:
routers/operations.py (save_ticket_report, aproximadamente linha 110, e importação, aproximadamente linha 485); main.py (importador automático de chamados).
Problema observado:
Duas importações concorrentes retornaram sucesso, mas somente uma versão e um comprovante de importação automática permaneceram. O relatório anterior é lido fora da transação e substitui o conteúdo corrente.

Implemente:
- Leitura do estado corrente, verificação do lote automático, acréscimo do snapshot, atualização do relatório corrente e comprovante dentro da mesma transação.
- Uso real do conteúdo fornecido por transaction.update_json; não substitua um estado corrente por um relatório montado sobre leitura antiga.
- Uma definição consistente da ordem das versões pela confirmação das transações.
- Inicialização das anotações com os snapshots realmente anteriores à importação confirmada, respeitando a etapa 1 se disponível.
- Preservação dos limites de retenção, respostas existentes e caminhos de importação manual/automática.

Critérios de aceite e testes:
1. Duas importações distintas concorrentes preservam duas versões e dois comprovantes.
2. Duas tentativas do mesmo lote não criam duplicação.
3. Falha antes da confirmação não altera o relatório anterior.
4. Uma confirmação nunca perde versões já confirmadas.
5. Cubra concorrência entre caminhos manual e automático. Teste processos separados quando o ambiente permitir; se impedir, descreva o limite.
Use barreiras/eventos determinísticos no teste, sem depender de sleeps para reproduzir a corrida.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 03 — Corrigir a falsa confirmação do autosave

- Achado: 3, [ALTO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma. Manter compatibilidade com o protocolo de revisões da etapa 1.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Corrigir a falsa confirmação do autosave.

Pontos de partida:
static/history-annotation-autosave.js (requestWithRetries, aproximadamente linha 39, e tratamento de result.stale, aproximadamente linha 174); testes JavaScript do autosave.
Problema observado:
Na sequência editar A, enviar A, editar B, voltar para A e falhar a requisição original, o componente informou “Salvo automaticamente”, apagou o rascunho e não confirmou uma nova gravação.

Implemente:
- Separação entre igualdade do texto e confirmação da revisão enviada.
- Resposta obsoleta ou erro de rede nunca confirma salvamento nem remove o rascunho.
- Reenvio da revisão atual quando uma operação obsoleta termina, inclusive quando o texto atual voltou a ser igual ao texto enviado anteriormente.
- Proteção contra respostas fora de ordem, componentes desmontados e dois campos mostrando a mesma anotação.
- Preservação do debounce, política de retries, mensagens de sincronização pendente, acessibilidade e guarda de navegação.
- Remoção do rascunho somente após confirmação inequívoca da revisão atual. Conflitos do backend não devem aparecer como sucesso.

Critérios de aceite e testes:
1. Reproduza A → B → A com falha de rede usando promises e relógio controlados.
2. Verifique rascunho preservado, estado pendente e nova tentativa.
3. Cubra respostas fora de ordem, falha definitiva, retry manual, sucesso e sincronização pendente.
4. Não crie loops de reenvio nem apague uma edição posterior.
Execute os testes existentes do autosave e acrescente testes comportamentais para esses cenários.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 04 — Impedir fórmulas nos textos do resumo exportado

- Achado: 4, [ALTO].
- Modelo recomendado: **GPT-5.6 Terra**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Impedir fórmulas nos textos do resumo exportado.

Pontos de partida:
domains/ticket_reporting.py (build_ticket_workbook, aproximadamente linhas 724–732, e _safe_cell); tests/test_ticket_reporting.py.
Problema observado:
Nomes de arquivos e filtros iniciados por “=” foram exportados como células de fórmula no resumo dos chamados. As abas detalhadas já possuem proteção que não é aplicada nesse trecho.

Implemente:
- Proteção de todos os textos externos inseridos no resumo: nomes de arquivos, filtros, datas recebidas como texto e quaisquer metadados equivalentes.
- Reutilização consistente do mecanismo de escrita segura existente, ou escrita explicitamente textual quando apropriado.
- Preservação de números e datas legítimos nos tipos esperados, sem converter toda a planilha indiscriminadamente para texto.
- Auditoria restrita das demais entradas externas desse mesmo exportador para eliminar o mesmo padrão.

Critérios de aceite e testes:
1. Exporte nomes e filtros com =, +, -, @ e texto comum.
2. Reabra o XLSX com data_only=False e confirme que os textos não possuem data_type “f”.
3. Confira resumo, detalhes e anotações, preservando contagens numéricas e layout.
4. Não execute fórmulas, links externos ou o Excel para validar.
O risco demonstrado é interpretação de fórmula no cliente; não descreva isso como execução comprovada de código no servidor.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 05 — Validar o cliente real no modo local

- Achado: 5, [ALTO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma. Se houver exposição pela rede, execute esta etapa com prioridade imediata.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Validar o cliente real no modo local.

Pontos de partida:
main.py (LocalRequestSafetyMiddleware, aproximadamente linha 1727, e configuração Uvicorn); persistence/boundary.py (aproximadamente linha 40); testes de segurança.
Problema observado:
No modo de arquivos, um cliente não local ultrapassa o middleware ao enviar um Host permitido. A checagem do IP existe somente no modo PostgreSQL. A inicialização padrão em 127.0.0.1 mitiga o risco; não presuma exposição remota atual.

Implemente:
- Validação de scope.client para restringir todos os perfis locais a loopback, com falha fechada para cliente ausente ou IP inválido.
- Preservação das verificações de Host, Origin, tamanho do corpo e autenticação.
- Tratamento correto de IPv4, IPv6 e formas IPv4 mapeadas, documentando a política escolhida.
- Revisão de proxy_headers e cabeçalhos encaminhados para impedir que informação não confiável substitua o endereço real.
- Compatibilidade com os perfis documentados. Não crie acesso remoto ou bypass de autenticação para acomodar um teste.

Critérios de aceite e testes:
1. 127.0.0.1 e ::1 são aceitos conforme a política.
2. Cliente remoto com Host local é rejeitado no modo de arquivos e PostgreSQL.
3. Cliente ausente/inválido e cabeçalhos encaminhados falsos não contornam a proteção.
4. Host e Origin inválidos continuam rejeitados.
5. Login, arquivos estáticos e APIs locais continuam acessíveis.
Se o ambiente bloquear sockets, use também testes ASGI sem rede e registre quais verificações HTTP reais ficaram indisponíveis.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 06 — Centralizar a anotação efetiva para herança e exibição

- Achado: 6, [ALTO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Concluir a etapa 1 e consumir seu protocolo, sem criar outro mecanismo de revisão.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça commit, push, deploy, limpeza de dados nem instale dependências. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Centralizar a anotação efetiva para herança e exibição.

Pontos de partida:
domains/inventory_update.py (_copy_matching_history_annotations, aproximadamente linha 158); routers/inventory_history.py (sobreposição de anotações); routers/operations.py (pendências/evolução, aproximadamente linha 62); composição dos serviços em main.py.
Problema observado:
A herança reutiliza texto antigo incorporado no histórico local mesmo quando existe uma edição compartilhada mais recente. Pendências e evolução também podem mostrar uma anotação diferente do detalhe do histórico.

Implemente:
- Um serviço único que resolva revisões compartilhadas, pendências locais, conflitos e compatibilidade legada conforme a etapa 1.
- Uso desse serviço na herança, detalhe, exportações, Central de Pendências e evolução, sem modificar a comparação bruta.
- Anotação vazia recente bloqueia reaplicação de texto antigo. Conflito não pode ser resolvido silenciosamente.
- Herança somente na mesma seção e com dados exatamente iguais, ignorando apenas anotacao e anotacao_id.
- Novo evento recebe identificador próprio; a anotação original continua vinculada ao evento original.
- Preservação da leitura em clones sem histórico local e dos rótulos definidos no AGENTS.md.

Critérios de aceite e testes:
1. Edição compartilhada recente substitui a visão local antiga.
2. Limpeza recente impede reaproveitamento de texto antigo.
3. Linha modificada ou movida para outra seção não herda anotação.
4. Duplicatas conflitantes e ocorrência igual mais recente sem anotação bloqueiam a herança.
5. Todas as telas e exportações mostram a mesma anotação efetiva.
6. Compare os dados brutos antes/depois para demonstrar que não foram reescritos.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 07 — Enfileirar anotações herdadas na mesma transação do histórico

- Achado: 7, [MÉDIO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Concluir as etapas 1 e 6.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Enfileirar anotações herdadas na mesma transação do histórico.

Pontos de partida:
domains/inventory_update.py (confirmação do histórico e publicação das anotações, aproximadamente linha 535); main.py (_history_annotation_sync_worker, aproximadamente linha 1650); fila local de anotações.
Problema observado:
A importação confirma o histórico e tenta publicar anotações herdadas diretamente na pasta compartilhada. Quando essa publicação falha, não cria uma entrada na fila processada pelo worker.

Implemente:
- Preparação das revisões herdadas e das respectivas pendências antes da confirmação.
- Inclusão do histórico e das pendências na mesma AtomicFileTransaction, com todos os destinos bloqueados adequadamente.
- Publicação posterior pelo fluxo único da etapa 1, com retries idempotentes.
- Recuperação após interrupção da aplicação em qualquer ponto, sem exigir que o usuário abra o evento ou reinicie para redescobrir uma pendência.
- Preservação da importação confirmada quando a rede estiver indisponível; a resposta deve distinguir gravação local de sincronização.

Critérios de aceite e testes:
1. Pasta compartilhada indisponível mantém a anotação no histórico e na fila durável.
2. Retorno da disponibilidade permite publicação pelo worker.
3. Interrupção antes da confirmação não deixa histórico incompleto.
4. Interrupção depois da confirmação mantém pendências recuperáveis.
5. Reprocessamento não duplica revisões nem remove uma edição mais recente.
6. Valide a recuperação transacional com dados sintéticos e confira que não depende de uma requisição GET.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 08 — Uniformizar a validação do endpoint de apelidos

- Achado: 8, [MÉDIO].
- Modelo recomendado: **GPT-6 Luna**.
- Nível de raciocínio: **medium**.
- Dependências: Nenhuma.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Uniformizar a validação do endpoint de apelidos.

Pontos de partida:
main.py (ApelidoUpdatePayload, aproximadamente linha 2489; EquipamentoUpdatePayload; atualizar_apelido, aproximadamente linha 3193); validadores de comandos PostgreSQL relacionados.
Problema observado:
O endpoint específico de apelidos aceita serial e apelido sem os limites de 128 e 160 caracteres utilizados na edição geral do equipamento.

Implemente:
- serial com tamanho de 1 a 128 e validação semântica compatível com a edição geral.
- apelido com limite de 160, preservando texto vazio se ele representa limpar o apelido.
- Normalização e validação coerentes entre os caminhos arquivos/PostgreSQL e os endpoints equivalentes, reutilizando um validador pequeno quando necessário.
- Respostas de validação consistentes, sem truncamento silencioso e sem alterar apelidos já armazenados.

Critérios de aceite e testes:
1. Limites exatos são aceitos; valores acima deles são rejeitados.
2. Serial vazio ou composto apenas por caracteres sem significado é rejeitado.
3. Limpar o apelido continua funcionando conforme o contrato atual.
4. Entrada inválida não modifica arquivos, banco ou histórico.
5. Os dois endpoints aplicam as mesmas regras.
Faça apenas esse ajuste de contrato; preserve o formulário e as demais regras de negócio.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 09 — Rejeitar cabeçalhos ambíguos na importação de chamados

- Achado: 9, [MÉDIO].
- Modelo recomendado: **GPT-5.6 Terra**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Rejeitar cabeçalhos ambíguos na importação de chamados.

Pontos de partida:
domains/ticket_reconciliation.py (_source_table, aproximadamente linhas 236–249); testes do importador de chamados.
Problema observado:
Quando duas colunas correspondem ao mesmo campo lógico, o importador escolhe a primeira silenciosamente. O cenário Serie, Serie, OS com séries distintas foi aceito.

Implemente:
- Detecção de mais de uma coluna física candidata para cada campo lógico, obrigatório ou opcional.
- Rejeição explícita tanto de cabeçalhos repetidos quanto de aliases diferentes que representam o mesmo campo.
- Deduplicação das referências ao mesmo índice físico para não gerar falso conflito.
- Mensagem objetiva com campo e contexto da aba/linha do cabeçalho, sem expor conteúdo desnecessário.
- Preservação da busca por cabeçalhos válidos em múltiplas abas e das regras atuais de seleção da tabela; não deixe um cabeçalho ambíguo passar por fallback silencioso.

Critérios de aceite e testes:
1. Cabeçalho duplicado com valores diferentes é rejeitado antes de gravar.
2. Dois aliases do mesmo campo em colunas distintas são rejeitados.
3. Um mesmo índice reconhecido por aliases equivalentes não gera falso positivo.
4. Arquivos válidos de ambas as fontes continuam aceitos.
5. Planilha inválida não modifica relatório, histórico nem comprovantes.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 10 — Eliminar buscas quadráticas nas linhas do tempo

- Achado: 10, [MÉDIO].
- Modelo recomendado: **GPT-5.6 Terra**.
- Nível de raciocínio: **high**.
- Dependências: Executar após as etapas 1, 2 e 6 para preservar os contratos já corrigidos.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Eliminar buscas quadráticas nas linhas do tempo.

Pontos de partida:
domains/ticket_reporting.py (build_ticket_timeline, aproximadamente linha 441); routers/operations.py (inicialização, localização da anotação e exportação, aproximadamente linhas 182, 366 e 429).
Problema observado:
Para cada série, o código percorre novamente os chamados de cada snapshot. Importação, salvamento de anotação e exportação repetem esse padrão, aproximando-se de O(H × N²).

Implemente:
- Índices por série normalizada e por item_id construídos uma vez por operação, a partir dos snapshots imutáveis selecionados.
- Uso desses índices na construção das linhas do tempo, inicialização de anotações, localização da linha editada e exportação.
- Preservação da ordem cronológica, checkpoints sem mudança, IDs e regras de comparação/herança.
- Ciclo de vida limitado à operação ou cache com invalidação demonstrável; não crie um cache global sem limite.
- Tratamento explícito de séries repetidas sem descartar evidência ou mudar silenciosamente a semântica.

Critérios de aceite e testes:
1. Compare resultados completos antes/depois com fixtures contendo mudanças, ausências e duplicatas.
2. Demonstre redução das varreduras por contagem de operações; evite testes dependentes de tempo exato.
3. Faça uma medição sintética simples, informando volume, ambiente e duração.
4. Anotações e exportações continuam ligadas ao mesmo evento/linha.
5. Não recrie o índice dentro do loop de cada série.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 11 — Evitar reconstrução integral do estado nas buscas PostgreSQL

- Achado: 11, [MÉDIO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Nenhuma dependência funcional; executar após estabilizar as correções de integridade.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Evitar reconstrução integral do estado nas buscas PostgreSQL.

Pontos de partida:
main.py (_buscar_equipamentos_por_termo, aproximadamente linha 3703); persistence/postgres.py (_snapshot e state, aproximadamente linhas 145 e 219); domains/equipment_search.py; routers/equipment_search.py.
Problema observado:
Cada busca PostgreSQL chama backend.state(), carregando e projetando todo o inventário, Endpoint, unidades, apelidos e histórico antes de pesquisar.

Implemente:
- Uma busca específica no banco com parâmetros e índices adequados, ou um índice reutilizável invalidado pela revisão global existente. Escolha a menor mudança que preserve o contrato e justifique a decisão.
- Preservação de normalização, campos pesquisáveis, prioridade da série, ordenação, limite e paginação atuais.
- Isolamento por lote ativo e validações de segurança existentes. Não reutilize cache entre contextos incompatíveis.
- Invalidação após mutações relevantes e após mudanças feitas por outro processo. Não use só uma variável local como sinal de atualização.
- Limites de memória, liberação de conexões e proteção contra cache obsoleto após falha.

Critérios de aceite e testes:
1. Buscas repetidas sem alteração não recarregam todo o estado.
2. Alterar inventário/apelido atualiza o resultado, inclusive a partir de outro processo simulado.
3. Resultados e ordenação equivalem aos do mecanismo atual para fixtures representativas.
4. Consulta inválida ou sem resultado mantém respostas coerentes.
5. Se houver SQL novo, use parâmetros e verifique o plano em banco descartável quando disponível.
Se PostgreSQL não estiver acessível, execute testes unitários pertinentes e registre a integração como não verificada, sem usar produção.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 12 — Implementar idempotência na atualização local de inventário

- Achado: 12, [MÉDIO].
- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependências: Executar depois das etapas 1, 6 e 7, pois modifica a mesma transação de atualização.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Implementar idempotência na atualização local de inventário.

Pontos de partida:
static/app.js (envio de Idempotency-Key, aproximadamente linha 2068); main.py (atualizar_planilhas, aproximadamente linha 3651); persistence/boundary.py; domains/inventory_update.py; entrada automática de inventário.
Problema observado:
O frontend reutiliza Idempotency-Key após falha, mas o modo de arquivos ignora a chave. Uma resposta perdida pode levar à criação de outro evento e backup para a mesma operação.

Implemente:
- Captura e validação de uma única chave, com contrato compatível com o modo PostgreSQL.
- Identidade da requisição baseada nos bytes efetivos dos dois arquivos e no papel de cada fonte, sem depender da ordem multipart ou somente do nome.
- Registro durável de chave, hash e resultado na mesma transação dos arquivos, histórico e pendências.
- Mesma chave com mesmo conteúdo retorna o resultado confirmado, inclusive em concorrência. Mesma chave com conteúdo diferente retorna conflito.
- Recuperação de interrupções sem confirmação falsa e sem uma chave ficar bloqueada permanentemente.
- Retenção explícita e limitada dos comprovantes, com comportamento documentado para expiração. Preserve compatibilidade com clientes sem chave e os lote_ids automáticos.

Critérios de aceite e testes:
1. Simule confirmação seguida de perda da resposta e repetição: um único evento e backup.
2. Cubra duas requisições concorrentes com a mesma chave.
3. Conteúdo diferente com chave igual não modifica o estado.
4. Falha antes da confirmação permite tentativa segura posterior.
5. Ordem multipart/nome diferente não altera indevidamente a identidade definida.
6. Reiniciar o processo não elimina a proteção para comprovantes válidos.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 13 — Corrigir a resolução de cabeçalhos das estatísticas por tipo

- Achado: 13, [BAIXO].
- Modelo recomendado: **GPT-6 Luna**.
- Nível de raciocínio: **medium**.
- Dependências: Nenhuma. Executar por último entre as correções para evitar misturar refatoração com integridade.

Copie o bloco completo:

~~~text
Atue como Engenheiro de Software Senior e Especialista em Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Leia o AGENTS.md e confira o estado atual do código e do Git antes de agir. Os achados vieram da auditoria de 11/10/2026; linhas são aproximadas e podem ter mudado. Confirme o defeito antes de corrigi-lo. Se já estiver corrigido, valide e relate, sem recriar a solução.

Implemente somente o escopo abaixo, incluindo os testes de regressão necessários. Preserve alterações preexistentes, arquivos não rastreados, dados operacionais, IDs, contratos, regras e rótulos do AGENTS.md. Use fixtures e diretórios temporários. Não faça deploy, limpeza de dados nem instale dependências. Ao concluir e validar esta etapa, faça commit e push somente dos arquivos dela; preserve alterações preexistentes fora do escopo. Acompanhe a CI do commit enviado até o resultado final. Se falhar por causa desta etapa, corrija, rode os testes pertinentes, faça novo commit e push e acompanhe a nova execução da CI. Registre o commit, a execução e o resultado real; se a CI não puder ser consultada, informe a limitação sem declarar sucesso. Não reinicie o servidor operacional. Execute autonomamente as alterações locais e testes autorizados, sem parar apenas na proposta.

Ao concluir, informe arquivos alterados, comportamento corrigido, testes e resultados reais, limitações e riscos restantes. Não declare verificação de navegador, PostgreSQL ou sincronização real sem executá-la.

Escopo desta execução:
Corrigir a resolução de cabeçalhos das estatísticas por tipo.

Pontos de partida:
main.py (norm_cols, aproximadamente linha 2175, e type_counts, aproximadamente linha 2425); persistence/inventory_projection.py.
Problema observado:
O mapa de cabeçalhos usa chaves normalizadas, mas type_counts consulta a chave literal “tipo”. O fallback “Tipo” falha para outras formas válidas, como TIPO e ClasseEquipamento.

Implemente:
- Resolução do tipo pelo mecanismo de aliases e normalização já utilizado para ler equipamentos.
- Preservação da semântica atual de contagem de linhas/equipamentos; não altere como duplicatas são contadas sem evidência e justificativa.
- Reutilização de um auxiliar pequeno caso haja duplicação direta entre os backends. Evite reescrever main.py ou criar uma nova camada arquitetural para esta correção.
- Comparação do comportamento com persistence/inventory_projection.py. Documente duplicações maiores como trabalho futuro, sem implementá-las nesta execução.

Critérios de aceite e testes:
1. Tipo, TIPO, espaços externos e ClasseEquipamento produzem as mesmas contagens quando representam a mesma entrada.
2. Células ausentes e tipos vazios mantêm o comportamento definido.
3. Não muda o inventário armazenado, rótulos do histórico, dados brutos nem regras de apelidos.
4. Cubra a regressão em teste localizado e verifique as estatísticas resultantes.

Execute apenas esta etapa. Não inicie automaticamente a próxima.
~~~

## Execução 14 — Revisão final integrada

- Modelo recomendado: **GPT-6.1 Sol**.
- Nível de raciocínio: **high**.
- Dependência: execuções 1 a 13 concluídas ou explicitamente marcadas como pendentes.

Copie o bloco completo:

~~~text
Atue como revisor Senior de Software e Segurança no projeto C:\Users\Gabriel\Desktop\Simpress.

Faça uma revisão final das correções correspondentes aos 13 achados da auditoria de 11/10/2026. Leia AGENTS.md, docs/prompts_correcao_auditoria_2026-10-11.md, o estado do Git e os resultados disponíveis das etapas. Confira o código atual; não presuma que tudo foi executado porque está no documento.

Esta execução é de revisão e validação: não implemente correções, não instale dependências, não altere dados operacionais, não faça deploy nem reinicie serviços operacionais. Confira o resultado final da CI do último commit publicado. Como a revisão não altera arquivos, não crie commit vazio; se houver alterações autorizadas e necessárias no documento de revisão, publique somente essas alterações e acompanhe a CI até a conclusão. Testes devem utilizar dados sintéticos e recursos descartáveis. Preserve todas as alterações preexistentes.

Verifique:
1. Revisões de anotação preservam conflitos, legado, texto vazio e clones sem histórico local.
2. Importações concorrentes de chamados preservam versões e comprovantes.
3. Autosave só confirma a revisão efetivamente salva.
4. Exportação trata textos externos como dados.
5. Proteção local valida cliente, Host e Origin.
6. Herança, telas e exportações usam a mesma anotação efetiva e respeitam igualdade exata por seção.
7. Histórico e fila de anotações são confirmados atomicamente.
8. Validação de apelidos é consistente.
9. Cabeçalhos ambíguos são rejeitados.
10. Linhas do tempo evitam varreduras quadráticas sem alterar resultados.
11. Busca PostgreSQL evita reconstrução integral por consulta e invalida corretamente.
12. Idempotência local resiste a resposta perdida, concorrência e reinicialização.
13. Estatísticas resolvem corretamente os aliases de tipo.

Execute os testes apropriados às mudanças e os checks exigidos pelo projeto. Amplie para a suíte integrada quando o ambiente permitir. Não repita testes sem motivo. Se sockets, dependências nativas ou serviços impedirem verificações, separe bloqueio do ambiente de defeito do código.

Entregue:
- Uma tabela com os 13 itens: corrigido e testado; corrigido com validação parcial; pendente; ou não confirmado.
- Evidência com arquivo/linha, comandos executados e resultados reais.
- Regressões ou riscos restantes por criticidade.
- Conclusão sobre o que está validado e o que ainda precisa ser validado antes de publicação.
- Commit e push apenas quando houver alterações autorizadas; informe SHA, execução da CI e resultado final verificados. Nenhuma afirmação de browser, banco ou sincronização real sem evidência.

Se encontrar defeitos novos, apenas registre-os com reprodução e sugestão; esta execução não autoriza corrigi-los.
~~~
