# Refatoração incremental do back-end Simpress

## Modelo e nível de raciocínio recomendados

**A recomendação geral para análise/refatoração complexa é GPT-6.1 Sol (`gpt-6.1-sol`) com raciocínio Máximo (`max`), se estiver disponível. Para esta execução, use GPT-6 Luna (`gpt-6-luna`) com raciocínio Máximo (`max`) nas Fases 2 e 3, conforme definido pelo usuário, devido à indisponibilidade atual do GPT-6.1 Sol. Use também GPT-6 Luna Máximo na Fase 4 para revisar as falhas das fases anteriores.** São recomendações de configuração para este roteiro, não requisitos gerais de programação.

A documentação oficial posiciona GPT-6.1 Sol para trabalho complexo com equilíbrio entre capacidade e custo, e GPT-6 Luna para tarefas focadas e de alto volume. Ambos oferecem o nível `max` no catálogo da API; a disponibilidade e os rótulos no chat dependem do produto e da versão. [Fonte: catálogo oficial de modelos](https://developers.openai.com/api/docs/models).

Se quiser ajustar o esforço por fase:

| Etapa | Modelo recomendado | Nível recomendado | Motivo da escolha para este roteiro |
| --- | --- | --- | --- |
| Fase 1 — Inspeção, contratos e plano | GPT-6.1 Sol | Máximo (`max`) | Cruzar código, testes e persistência antes de escolher mudanças compatíveis. |
| Fase 2 — Refatoração e regressões | GPT-6 Luna | Máximo (`max`) | Configuração definida pelo usuário durante a indisponibilidade atual do GPT-6.1 Sol; avaliar efeitos entre módulos, rollback, cancelamentos e preservação dos contratos. |
| Fase 3 — Validação e CI | GPT-6 Luna | Máximo (`max`) | Configuração definida pelo usuário; verificar regressões, matriz da workflow, evidências e o SHA publicado. |
| Fase 4 — Revisão de falhas | GPT-6 Luna | Máximo (`max`) | Revisar falhas das Fases 2 e 3 e dos respectivos jobs de CI, classificar causas e confirmar correções. |
| Tarefa auxiliar pequena e isolada | GPT-6 Luna | Alto (`high`) ou Máximo (`max`) | Alternativa para documentação pontual, levantamento simples ou correção com escopo e critérios claros. |

O nível Máximo aumenta o esforço de raciocínio do modelo selecionado; ele não garante equivalência de capacidade entre modelos. A recomendação geral de Sol para refatoração profunda e a escolha operacional do usuário de Luna para as Fases 2 e 3 são decisões distintas. Não troque o modelo dessas fases sem orientação do usuário. [Fontes: seleção de modelos](https://developers.openai.com/api/docs/guides/model-selection) e [níveis de raciocínio](https://developers.openai.com/api/docs/guides/reasoning).

Selecione o modelo e o nível no chat antes de iniciar a execução. O texto deste arquivo apenas recomenda a configuração; não muda automaticamente as configurações do chat nem autoriza delegação a subagentes. Mais raciocínio não substitui os testes, a revisão do diff e a CI exigidos neste roteiro.

Referências oficiais consultadas em **12/10/2026**. Reconfirme as opções disponíveis no seletor ao executar o roteiro.

Atue como Engenheiro de Software Back-End Sênior e Arquiteto de Soluções. Analise e refatore o back-end deste repositório Simpress com foco em segurança, confiabilidade, desempenho e manutenção, preservando os contratos existentes.

O projeto é descrito como Python/FastAPI, com interface estática em JavaScript, HTML e CSS, armazenamento local em arquivos e testes Python/Playwright. Confirme essa arquitetura no checkout atual antes de tomar decisões; não trate estas informações como substitutas da inspeção do código.

## Objetivo

Melhorar o back-end de forma incremental e comprovável, sem reescritas amplas, mudanças de produto ou incompatibilidades. Use os padrões e dependências já presentes no projeto. Não introduza camadas ou padrões arquiteturais apenas por convenção: faça cada mudança resolver um problema identificado.

## Fase 1 — Inspeção e análise, antes de editar

1. Verifique o estado do repositório, a branch, alterações locais e as instruções aplicáveis, como `AGENTS.md`.
2. Mapeie os arquivos relevantes: documentação, configuração, dependências, inicialização, rotas, domínios/serviços, persistência, autenticação, importação/exportação e testes. Use a estrutura real do projeto, sem presumir que nomes de pastas ou camadas já existem.
3. Mapeie os contratos por endpoint:
   - método, caminho e autenticação;
   - parâmetros, formatos de entrada e validações;
   - formato da resposta, campos, códigos HTTP e mensagens esperadas;
   - consumidores no front-end e dependências entre endpoints.
4. Descreva os fluxos de negócio e armazenamento encontrados, incluindo os modos de persistência que realmente existem no código.
5. Identifique riscos ou problemas concretos de segurança, consistência, desempenho e acoplamento. Para cada achado, informe evidências com arquivo, função e trecho ou linha, impacto e prioridade.
6. Consulte os testes e a CI existentes para entender os critérios atuais. Não conclua que há um problema apenas por preferência arquitetural.

Não leia, exiba ou publique segredos de `.env`, credenciais ou dados operacionais reais. Não altere planilhas, históricos, backups, catálogos ou estado local. Preserve todas as mudanças preexistentes no diretório de trabalho.

Antes de modificar qualquer arquivo, apresente um resumo da arquitetura, dos contratos relevantes, dos achados e de um plano de mudanças incremental. Depois dessa apresentação, registre a análise e o plano em um documento Markdown versionável, sem dados operacionais ou segredos, para compor o commit da Fase 1. Em seguida, implemente somente melhorias claramente compatíveis. Se uma solução exigir mudança de API, migração de dados, exclusão de estado, alteração de autenticação ou nova infraestrutura, pare nesse ponto, explique a decisão necessária e aguarde autorização.

## Fase 2 — Refatoração

### Arquitetura e responsabilidades
- Separe validação, regras de negócio, acesso a dados e respostas HTTP quando isso reduzir acoplamento no código existente.
- Mantenha as rotas finas e evite duplicação, sem criar abstrações genéricas sem uso real.
- Preserve a lógica de negócio, inicialização e funcionamento nos modos de armazenamento suportados pelo projeto.

### Validação e erros
- Valide body, path e query com os mecanismos já adotados pelo projeto.
- Preserve nomes de campos, formatos, códigos HTTP e mensagens de erro que façam parte dos contratos atuais.
- Centralize o tratamento de erros quando isso simplificar o código sem alterar a resposta observável pelo cliente.
- Não esconda exceções nem converta falhas inesperadas em respostas de sucesso.

### Persistência e consistência
- Preserve arquivos, históricos, inventários, modelos, anotações e demais dados existentes.
- Em operações com arquivos, mantenha as garantias atuais de atomicidade, backup e rollback. Não substitua um arquivo válido antes de validar completamente a nova entrada.
- Preserve valores de planilhas que podem ter significado como texto, incluindo números de série, identificadores e CNPJs.
- Não execute migrações nem reescreva dados operacionais durante testes ou refatorações.

### Uploads e segurança
- Para arquivos XLSX, ZIP ou outros formatos aceitos, mantenha os limites, validações e mensagens compatíveis com o comportamento existente.
- Em ZIPs, verifique com segurança os nomes e caminhos internos, o número e o tipo de arquivos aceitos e os limites de tamanho/conteúdo. Não extraia caminhos sem validação.
- Proteja consultas ao banco contra injeção usando os mecanismos existentes; aplique validação e escape conforme o contexto, sem sanitizações genéricas que corrompam dados.
- Não registre senhas, tokens, credenciais ou conteúdo sensível em logs. Preserve a autenticação e autorização atuais.

### Desempenho e qualidade
- Corrija gargalos identificados por evidência; evite otimizações especulativas, concorrência arriscada ou cache sem invalidação definida.
- Mantenha tipagem consistente, nomes claros e tratamento explícito dos casos excepcionais.
- Remova código morto somente após confirmar que não há referências, contratos indiretos ou uso em testes e scripts.

## Restrições obrigatórias

- Não quebre contratos de API ou regras de negócio existentes.
- Não altere a interface, os identificadores, atributos de acessibilidade ou seletores de teste, salvo se uma dependência direta da API exigir ajuste; nesse caso, preserve o comportamento observável.
- Não adicione frameworks, ORMs ou dependências pesadas sem demonstrar necessidade e avaliar impacto.
- Não altere testes apenas para fazê-los aceitar uma regressão. Acrescente ou ajuste testes para documentar comportamento compatível e cobrir a correção.
- Commit e push estão explicitamente autorizados ao final de cada fase, somente para arquivos e trechos produzidos nesta tarefa, seguindo o protocolo Git e CI abaixo. Deploy, merge de pull request, publicação em produção, force push e alterações de infraestrutura continuam exigindo solicitação explícita.

## Fase 3 — Verificação

1. Execute primeiro os testes focados nos módulos alterados e depois os comandos de validação definidos pelo próprio projeto e pela CI.
2. Use dados sintéticos e diretórios temporários. Não teste importações ou migrações com arquivos operacionais reais.
3. Verifique também sintaxe, tipagem, auditorias e formatação exigidas pela CI, além de `git diff --check`, quando aplicável.
4. Informe exatamente o que passou, o que falhou e o que não pôde ser executado. Não declare a mudança pronta para produção sem evidências de validação; não confunda teste local com CI concluída.

## Fase 4 — Revisão de falhas

Execute esta fase depois de terminar e verificar a CI da Fase 3. Use GPT-6 Luna com raciocínio Máximo (`max`), conforme a configuração operacional definida para este roteiro enquanto GPT-6.1 Sol estiver indisponível.

1. Reúna os resultados locais, relatórios de teste e jobs de CI das Fases 2 e 3. Relacione cada falha ao SHA e ao job que a produziu; use logs sem divulgar credenciais, tokens ou dados sensíveis.
2. Classifique cada ocorrência como regressão da tarefa, falha preexistente, flutuação/rede, divergência de ambiente ou teste insuficiente. Confirme a classificação com uma reprodução pequena, determinística e baseada em dados sintéticos. Compare com a linha de base ou commit anterior relevante quando isso for possível.
3. Corrija somente causas confirmadas dentro do escopo autorizado. Para cada correção, adicione ou ajuste uma regressão que documente o comportamento compatível. Não remova testes, reduza verificações ou altere a CI para silenciar falhas.
4. Se a correção exigir mudança de contrato/API, autenticação/autorização, migração de dados, nova infraestrutura ou exclusão de estado, pare essa mudança, registre a evidência e aguarde decisão do usuário.
5. Execute os testes focalizados das correções, as verificações locais pertinentes e então faça revisão de diff, commit e push seletivos. Acompanhe todos os jobs da CI do novo SHA; se falharem, repita a análise e a validação até passarem ou até identificar um bloqueio externo comprovado.
6. Registre em documentação versionável, para cada falha, sintoma, prioridade, evidência/reprodução, causa, estado, correção ou motivo para não alterar e resultado da CI. Se nenhuma alteração versionável for necessária, não crie commit vazio; registre a conclusão e confira branch, upstream e CI do commit vigente.

## Entrega

Apresente:
1. **Resumo da análise:** arquitetura, contratos examinados e problemas encontrados, com referências a arquivos e funções.
2. **Mudanças realizadas:** o que mudou e por quê, organizado por área.
3. **Compatibilidade:** como os contratos e regras de negócio foram preservados.
4. **Verificações:** comandos executados e resultados, incluindo limitações.
5. **Débitos e recomendações:** riscos remanescentes e decisões de infraestrutura ou produto, com prioridade e justificativa.
6. **Revisão de falhas (Fase 4):** classificação, evidências, correções ou limitações e situação de CI por SHA.

## Protocolo obrigatório de Git e CI em cada fase

Execute commit e push ao final de cada uma das quatro fases, com validação local prévia e acompanhamento da CI. A fase só pode ser considerada concluída depois que os testes e verificações da CI passarem no commit efetivamente enviado.

A ordem obrigatória é: executar as verificações locais pertinentes à fase, revisar o diff, criar o commit, fazer push, acompanhar a CI desse commit, corrigir eventuais falhas e repetir as verificações afetadas até obter aprovação. A verificação da CI faz parte da conclusão dos testes; ela não substitui os testes locais anteriores ao push.

1. Antes de qualquer operação Git de escrita ou rede, confira branch, status, remoto e upstream. Registre as alterações preexistentes e preserve-as integralmente. Não leia credenciais de remotos nem exponha tokens em saídas.
2. Use uma branch de trabalho com o prefixo `codex/`, respeitando uma branch já indicada pelo usuário ou apropriada à tarefa. Evite publicar diretamente na branch principal. Criar a branch não autoriza descartar ou incorporar alterações preexistentes.
3. Se a branch remota tiver avançado ou houver conflitos com alterações locais, examine a situação antes de integrar. Não use reset destrutivo, clean, stash ou force push para contornar o problema. Se a integração exigir uma decisão do usuário ou ameaçar trabalho preexistente, interrompa somente a etapa dependente e explique o impedimento.
4. Faça staging seletivo por arquivo ou trecho. Não use `git add .` nem `git add -A`. Revise `git diff --cached` e execute `git diff --cached --check` antes de cada commit. Inclua apenas código, testes e documentação desta tarefa; não inclua planilhas, históricos, backups, catálogos, estado local, segredos ou mudanças preexistentes de terceiros.
5. Na **Fase 1**, publique somente a análise, o mapa de contratos e o plano incremental já apresentados. Execute as verificações de linha de base aplicáveis antes do commit e acompanhe a CI após o push. Não altere o back-end antes da apresentação exigida.
6. Na **Fase 2**, publique as correções compatíveis e seus testes de regressão. Execute primeiro os testes focados e as verificações locais exigidas pela CI. Organize mudanças maiores em commits pequenos e coerentes, mantendo um checkpoint de commit, push e CI aprovada ao final da fase.
7. Na **Fase 3**, execute a validação ampliada e registre seus resultados e limites em documentação versionável. Publique esse registro e eventuais correções necessárias. Após o último push, acompanhe novamente todos os jobs exigidos pela CI.
8. Na **Fase 4**, revise as falhas registradas nas Fases 2 e 3 e na CI conforme os critérios da seção própria. Documente cada classificação e correção; publique somente alterações versionáveis desta revisão, então acompanhe todos os jobs obrigatórios do SHA dessa revisão.
9. Se uma fase não produzir nenhuma alteração versionável, explique o motivo; não crie commit vazio apenas para cumprir a sequência. Confira a sincronização e a CI do commit vigente e registre o checkpoint na entrega.
10. Depois de cada push, confirme o SHA publicado e acompanhe a execução correspondente. Verifique todos os jobs obrigatórios e a matriz configurada. Uma execução verde de um commit anterior não comprova o estado do commit atual. Jobs pendentes, cancelados, ausentes ou ignorados não comprovam sucesso dos testes esperados.
11. Se a CI falhar, analise os logs sem divulgar segredos, corrija o que estiver no escopo, rode os testes afetados, faça novo commit e push e verifique a CI do novo SHA. Não remova testes, reduza verificações ou altere a CI apenas para obter aprovação.
12. Não publique alterações com falhas locais conhecidas causadas pela tarefa. Se a linha de base já estiver falhando, registre a evidência, diferencie o que é preexistente e pare antes de uma publicação que não possa ser validada com segurança.
13. Se a rede, autenticação, permissões, proteção de branch ou acesso ao provedor de CI impedirem o processo, preserve o trabalho local e informe exatamente o que não pôde ser confirmado. Não declare a fase concluída nem a CI aprovada. O acompanhamento da execução deve ocorrer nesta tarefa; não crie automações recorrentes sem solicitação.

A autorização de commit e push não altera os limites de produto, API, dados, autenticação ou infraestrutura definidos neste pedido. Mudanças nesses limites continuam dependendo de autorização específica.

## Testes extensivos e verificação adicional

Faça testes extensivos, com profundidade acima da validação mínima, para os riscos concretos e os módulos afetados. Use casos distintos, limites e falhas controladas; a repetição de um mesmo teste sem nova hipótese não constitui cobertura adicional. Todos os dados devem ser sintéticos e todas as gravações devem ocorrer em diretórios temporários isolados.

Antes de executar cada comando, confirme que a descoberta/importação dos testes, o startup e as fixtures não carregam, recuperam, migram, limpam ou alteram dados operacionais. Não inicie o servidor operacional para testar. Use o executor isolado e as fixtures do projeto, depois de inspecionar suas garantias. Não execute scripts de migração ou manutenção contra o checkout operacional.

Amplie a cobertura conforme a mudança justificar:

- **Contratos HTTP:** métodos, caminhos, body, path, query, campos obrigatórios e opcionais, valores padrão, limites, formatos, códigos HTTP, mensagens e formato de respostas. Preserve também os consumidores JavaScript e as dependências entre endpoints.
- **Uploads XLSX e ZIP:** arquivos válidos, vazios, truncados e corrompidos; extensões e cabeçalhos inválidos; múltiplas abas candidatas; entradas ZIP duplicadas ou com caminhos inseguros; ZIP com senha; número de membros e tamanhos no limite, abaixo e acima dele; conteúdo descompactado excessivo e limites estruturais de XML. Não descompacte entradas inseguras no disco nem gere cargas que comprometam a máquina.
- **Persistência:** validação completa antes da substituição, atomicidade, backups, rollback e recuperação em ambiente temporário; falhas de leitura, gravação e substituição; estado JSON inválido; conflitos externos e bloqueios concorrentes. Confirme que falhas não retornam sucesso nem deixam cache incompatível com os arquivos.
- **Concorrência e idempotência:** solicitações simultâneas, cancelamentos durante processamento, repetição de uma operação com a mesma chave, chave repetida com conteúdo diferente, conflitos de revisão e recursos liberados após erros. Use sincronização determinística e timeouts, evitando testes dependentes de atrasos arbitrários.
- **Preservação de dados:** séries e identificadores com zeros iniciais, CNPJs como texto, valores vazios, Unicode, fórmulas e recursos de planilha que o fluxo promete preservar. Não invente zeros ou converta valores por sanitização genérica.
- **Histórico de Planilhas:** padronização dos rótulos de fontes em registros novos e antigos; preservação dos dados brutos e identificadores de auditoria/restauração; anotação por linha e evento; limite de 2.000 caracteres; exportação; migração legada e sincronização pela pasta já configurada. Verifique reaproveitamento apenas de linhas exatamente iguais na mesma seção, com identificador independente no novo evento; ausência mais recente ou conflito entre duplicadas deve impedir reaproveitamento de anotação antiga. Cubra clones sem histórico local com fixtures.
- **Segurança:** restrições de conexão local, Host e Origin, limites do corpo da requisição, autenticação/autorização e CSRF já existentes, consultas parametrizadas e respostas/logs sem credenciais ou conteúdo sensível. Não altere a política de autenticação.
- **Modos de armazenamento:** exercite os modos realmente suportados com testes isolados e simuladores existentes. Uma validação de PostgreSQL/Supabase real só pode ocorrer em infraestrutura de testes já autorizada, com dados sintéticos e sem migração operacional. Se ela estiver indisponível, registre a limitação; mocks não comprovam integração real.
- **Desempenho:** para gargalos confirmados, compare antes e depois com a mesma carga sintética e registre tamanho, método e resultados. Não faça testes de estresse contra o servidor ou dados operacionais, nem altere limites de produto sem autorização.
- **Interface consumidora:** execute os testes JavaScript relevantes e os cenários Playwright existentes para os fluxos afetados, usando servidor e dados de fixture. Amplie para a suíte definida pela CI, incluindo desktop e mobile, sem modificar a interface para acomodar uma regressão do back-end.

Execute os testes focados antes das suítes completas. Execute também os comandos de sintaxe, tipagem, auditoria de dependências, verificação de segredos, build e demais verificações definidos pela CI, quando aplicáveis. Builds que escrevem em arquivos preexistentes devem rodar em ambiente isolado ou preservar essas alterações; não sobrescreva trabalho local para validar a tarefa.

Se um teste falhar ou uma mudança posterior afetar seu resultado, reexecute os testes pertinentes e as verificações que dependem deles. Após uma correção de CI, confirme a execução no novo SHA. Não declare uma suíte completa aprovada com base em testes focados, nem uma auditoria de vulnerabilidades aprovada com base apenas em consistência de dependências.

## Complemento obrigatório da entrega

Além dos cinco itens de entrega acima, apresente uma tabela por fase contendo:

| Fase | Arquivos e mudanças da tarefa | Verificações locais e resultados | Branch e SHA do commit | Push confirmado | Link e resultado da CI do SHA |
| --- | --- | --- | --- | --- | --- |
| 1 — Análise | Preencher | Preencher | Preencher | Preencher | Preencher |
| 2 — Refatoração | Preencher | Preencher | Preencher | Preencher | Preencher |
| 3 — Verificação ampliada | Preencher | Preencher | Preencher | Preencher | Preencher |

Informe também a quantidade e os tipos de testes executados, falhas preexistentes, verificações não executadas, limitações de ambiente e riscos remanescentes. Se qualquer checkpoint Git/CI estiver incompleto, identifique-o explicitamente. Não confunda commit local, push confirmado, testes locais aprovados e CI aprovada.
