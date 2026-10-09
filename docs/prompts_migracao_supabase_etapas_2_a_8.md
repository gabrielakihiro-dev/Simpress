# Prompts para migração do Simpress ao Supabase — Etapas 2 a 8

**Referência:** [mapeamento da etapa 1](migracao_supabase_etapa_1.md)

**Objetivo:** prompts reutilizáveis para conduzir a migração por etapas, com modelo e nível de raciocínio recomendados.

## Orientações gerais

- Execute somente a etapa indicada em cada prompt. Não avance para a próxima sem solicitação.
- Use **GPT-6.1 Sol**. Os níveis indicados abaixo são recomendações por risco; níveis maiores consomem mais da franquia de uso e não garantem, sozinhos, um resultado melhor.
- Antes de editar, confira `git status` e preserve mudanças locais, inclusive os relatórios já criados.
- Não faça commit nem push.
- Não exponha segredos, chaves ou credenciais em código, logs, relatórios ou exemplos. Use apenas placeholders em arquivos de exemplo.
- Não envie dados operacionais reais ao Supabase, não aplique mudanças em projeto remoto e não crie recursos que possam gerar cobrança sem autorização explícita.
- Ao concluir uma etapa, crie ou atualize o relatório `docs/migracao_supabase_etapa_N.md`, descrevendo escopo, decisões, arquivos alterados, verificações executadas e limitações. Não inclua dados operacionais sensíveis.
- Aplique as instruções de `AGENTS.md` e as skills do Supabase disponíveis. Consulte a documentação oficial atual quando a etapa envolver APIs, segurança ou configuração do Supabase.

## Etapa 2 — Decisões e arquitetura-alvo

**Modelo e nível:** GPT-6.1 Sol — **Alto**.

**Por quê:** esta etapa compara decisões arquiteturais e resolve pendências de política antes de definir o banco.

```text
Execute somente a etapa 2 da migração do Simpress para o Supabase: definir e documentar a arquitetura-alvo e as decisões pendentes.

Leia `AGENTS.md`, `docs/migracao_supabase_etapa_1.md` e inspecione o código apenas o necessário para confirmar os fluxos citados. Não altere código, planilhas, JSON operacionais nem configurações remotas.

Documente alternativas e recomende uma abordagem para: hospedagem do FastAPI e do frontend; PostgreSQL versus Supabase Storage; acesso do backend e dos usuários; sincronização entre instâncias e invalidação de caches; recuperação de falhas entre banco e Storage; plano de desenvolvimento, homologação e produção; estratégia de rollback; retenção dos históricos e backups (o relatório da etapa 1 encontrou divergência entre 60 e 90 dias); e modelo de usuários/perfis, ainda não definido.

Não invente decisões de negócio. Separe recomendações técnicas de decisões que dependem do Gabriel. Para cada pendência, apresente opções concretas, impacto e uma recomendação. Não crie projeto Supabase nem recurso remoto.

Crie `docs/migracao_supabase_etapa_2.md` com a arquitetura proposta, decisões recomendadas, questões que exigem escolha do usuário, riscos, dependências e critérios de saída para a etapa 3. Preserve as mudanças existentes. Não faça commit nem push.
```

## Etapa 3 — Modelo de dados e mapeamento

**Modelo e nível:** GPT-6.1 Sol — **Alto**.

**Por quê:** requer modelar relações, identidade, proveniência e regras de auditoria sem perder o significado dos dados atuais.

```text
Execute somente a etapa 3 da migração do Simpress para o Supabase: propor o esquema relacional e o mapeamento de dados, com base nas decisões aprovadas da etapa 2.

Leia os relatórios das etapas 1 e 2, `AGENTS.md` e os modelos/domínios relevantes. Não leia em massa nem copie dados operacionais reais. Não altere código ou arquivos de dados.

Proponha tabelas, colunas, tipos, chaves, restrições, índices e relações para inventário oficial, referências auxiliares do InvAll, unidades, apelidos manuais e seu histórico, eventos e detalhes de comparação, anotações por linha/evento, metadados de arquivos e backups. Preserve a distinção entre inventário oficial e fonte auxiliar, séries brutas e normalizadas, proveniência, ordem de precedência, IDs de evento/linha e fingerprints. Considere duplicidades e a regra de reaplicar anotações somente quando os dados na mesma seção forem exatamente iguais, desconsiderando apenas `anotacao` e `anotacao_id`.

Para cada planilha/JSON, documente origem, transformação, destino e validações. Identifique campos ambíguos em vez de presumir equivalências. Defina consultas e padrões de acesso que o esquema precisa atender e indique requisitos de RLS sem criar políticas permissivas.

Crie `docs/migracao_supabase_etapa_3.md` com o diagrama textual do modelo, dicionário de dados, mapeamento, restrições, decisões pendentes e critérios para revisar o esquema. Não gere migration SQL ainda. Não faça commit nem push.
```

## Etapa 4 — Migrations SQL e ambiente local

**Modelo e nível:** GPT-6.1 Sol — **Alto**.

**Por quê:** traduz o modelo em estrutura executável e precisa começar com acesso seguro por padrão.

```text
Execute somente a etapa 4 da migração do Simpress para o Supabase: preparar migrations SQL versionadas e o ambiente local de desenvolvimento, usando o modelo aprovado na etapa 3.

Leia `AGENTS.md` e os relatórios das etapas 1 a 3. Use a skill do Supabase e documentação oficial atual. Confira `git status` antes de editar. Não conecte a projeto remoto, não crie recursos faturáveis, não aplique migrations fora do ambiente local e não inclua credenciais.

Crie apenas os arquivos necessários para representar o esquema aprovado, incluindo constraints, índices e políticas iniciais de acesso fechado. Nenhuma tabela exposta pode ficar sem RLS habilitado ou com política aberta. Se ainda faltar uma decisão necessária, pare nesse ponto, registre a pendência e não improvise. Preserve os contratos existentes da aplicação; não integre as rotas ainda.

Se as ferramentas locais estiverem disponíveis, valide a sintaxe e aplique as migrations somente no Supabase local descartável. Caso isso não seja possível, faça revisão estática e registre exatamente o que não foi validado. Não use dados operacionais reais.

Crie `docs/migracao_supabase_etapa_4.md` com migrations criadas, pré-requisitos, comandos locais seguros, resultados das verificações, limitações e instruções para revisão. Não faça commit nem push.
```

## Etapa 5 — Integração do FastAPI com PostgreSQL

**Modelo e nível:** GPT-6.1 Sol — **Alto**.

**Por quê:** altera o caminho de persistência e precisa manter a API e o comportamento existentes durante a transição.

```text
Execute somente a etapa 5 da migração do Simpress para o Supabase: integrar o FastAPI ao PostgreSQL segundo a arquitetura aprovada na etapa 2 e o esquema aprovado nas etapas 3 e 4.

Leia `AGENTS.md`, os relatórios das etapas anteriores e os fluxos atuais de leitura/gravação. Preserve mudanças locais e a operação atual baseada em arquivos. Não migre dados reais, não aplique alterações remotas, não remova o modo local e não faça commit/push.

Implemente uma camada de persistência no backend, com configuração por variáveis de ambiente e valores de exemplo sem segredos. Mantenha credenciais privilegiadas somente no servidor. Preserve contratos HTTP, validações, erros e regras de domínio. Trate transações, concorrência, idempotência e falhas de forma explícita; não publique caches ou estado em memória antes da confirmação do commit no banco. Não substitua fluxos de Storage, autenticação ou histórico de anotações que pertencem às etapas 6 e 7.

Faça uma mudança incremental e reversível, com seleção clara do backend por configuração. Execute verificações focadas já disponíveis para os módulos alterados e registre testes não executados; não use banco remoto nem arquivos operacionais.

Crie `docs/migracao_supabase_etapa_5.md` com fluxo implementado, configuração, compatibilidade, verificações e riscos residuais. Não faça commit nem push.
```

## Etapa 6 — Supabase Storage, backups, histórico e anotações

**Modelo e nível:** GPT-6.1 Sol — **Extra High**.

**Por quê:** envolve consistência entre PostgreSQL e Storage, restauração e identidade de anotações; falhas parciais precisam de recuperação segura.

```text
Execute somente a etapa 6 da migração do Simpress para o Supabase: projetar e implementar, de forma incremental, a integração de arquivos, backups, histórico de comparações e anotações com PostgreSQL e Supabase Storage, conforme decisões já aprovadas.

Leia `AGENTS.md` e os relatórios das etapas 1 a 5. Preserve proveniência, hashes, nomes/IDs de arquivos necessários à auditoria e restauração, rótulos contextuais do histórico, IDs estáveis por linha/evento, fingerprints e a regra de reaplicação exata de anotações. Mantenha a migração de anotações legadas sem reescrever dados brutos. Não faça upload de planilhas reais nem remova a sincronização atual nesta etapa.

Modele estados pendentes, retries idempotentes e recuperação para falhas entre upload, metadados, transação, restauração e exclusão. Não trate uma transação PostgreSQL como se incluísse o Storage. Preserve downloads e exportações atuais. Use bucket privado e acesso mediado pelo backend até a política de autorização da etapa 7 estar pronta; não crie políticas públicas.

Implemente apenas o escopo viável no ambiente local. Execute verificações focadas não destrutivas com fixtures/sanitizados, quando disponíveis; não use projeto remoto ou dados operacionais reais.

Crie `docs/migracao_supabase_etapa_6.md` com fluxos, estados de falha/recuperação, compatibilidade legada, verificações e pendências. Não faça commit nem push.
```

## Etapa 7 — Autenticação, autorização, RLS e operação hospedada

**Modelo e nível:** GPT-6.1 Sol — **Extra High**.

**Por quê:** erros de autorização podem expor inventário, histórico, anotações ou arquivos.

```text
Execute somente a etapa 7 da migração do Simpress para o Supabase: implementar e revisar autenticação, autorização, políticas RLS e configuração segura de operação hospedada, com base nas decisões aprovadas da etapa 2.

Leia `AGENTS.md`, as etapas 1 a 6 e a documentação oficial atual do Supabase. Não presuma que as rotas atuais já autenticam usuários. Defina claramente quais operações podem ser executadas por cada perfil aprovado. Restrinja cada endpoint e objeto de Storage; proteja também downloads, exportações, históricos, anotações e rotas administrativas.

Habilite e valide RLS em todas as tabelas expostas. Escreva políticas mínimas e testáveis, sem acesso anônimo permissivo. Mantenha service role e demais segredos exclusivamente no backend; nunca os envie ao navegador, ao Git ou aos relatórios. Revise CORS, URLs/origins permitidas, cookies/tokens, logs e configuração do listener para hospedagem. Trate caches entre instâncias sem depender de estado local compartilhado.

Teste cenários autorizados e negados com usuários/fixtures locais ou de teste. Não use credenciais reais, não altere projeto remoto e não exponha o serviço publicamente.

Crie `docs/migracao_supabase_etapa_7.md` com matriz perfil-operação, políticas, rotas protegidas, verificações negativas/positivas, configuração necessária e riscos residuais. Não faça commit nem push.
```

## Etapa 8 — Ensaio de migração, reconciliação e plano de entrada em produção

**Modelo e nível:** GPT-6.1 Sol — **Extra High**.

**Por quê:** exige reconciliar múltiplas fontes, demonstrar integridade e preparar rollback sem arriscar a base oficial.

```text
Execute somente a etapa 8 da migração do Simpress para o Supabase: preparar e executar um ensaio reproduzível em ambiente local descartável ou staging explicitamente autorizado; validar dados e preparar um plano de entrada em produção. Não faça o cutover de produção.

Leia `AGENTS.md` e todos os relatórios das etapas 1 a 7. Use somente fixtures, cópias sanitizadas ou dados de teste autorizados. Não faça upload da base oficial, não altere OneDrive/arquivos operacionais e não escreva em projeto de produção.

Prepare uma rotina de importação repetível e com modo dry-run. Verifique contagens por entidade e origem, campos obrigatórios, duplicidades, séries brutas/normalizadas, relações, hashes e referências a arquivos; confira regras de precedência Simpress/InvAll, histórico, backups e anotações por linha. Teste reexecução idempotente, falhas parciais, retomada, restauração e exportações. Compare resultados com o comportamento atual sem publicar estado novo automaticamente.

Execute os testes automatizados relevantes e registre comandos, resultados, divergências e limitações. Produza um checklist de cutover com pré-requisitos, backup imutável, janela, critérios objetivos de aceitação, observabilidade, plano de rollback e responsáveis/decisões pendentes. Não considere a migração pronta se houver divergência sem explicação ou se rollback não estiver validado.

Crie `docs/migracao_supabase_etapa_8.md` com evidências do ensaio, reconciliação, defeitos encontrados, critérios de aceite e plano de cutover/rollback. Não faça commit nem push, não publique e não execute o cutover.
```

## Referências para a escolha do modelo

- [Seleção de modelos e níveis de raciocínio — OpenAI](https://developers.openai.com/api/docs/guides/model-selection): Sol Médio é indicado para trabalho técnico complexo; níveis Extra High para análise e decisões mais exigentes.
- [Uso de modelos no Work e Codex — OpenAI](https://help.openai.com/en/articles/20001516-managing-usage-with-gpt-6-astra-in-work-and-codex): modelo e nível alteram o consumo da franquia; níveis maiores não garantem melhora automática.
