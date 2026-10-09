# Migração Supabase — Etapa 5: integração incremental do FastAPI

**Data:** 09/10/2026, America/Sao_Paulo.

**Status:** backend PostgreSQL implementado para o piloto local descartável. O modo de arquivos continua sendo o padrão e a operação vigente. Não houve importação real, cutover, configuração remota, commit ou push nesta etapa.

**Referências:** [escopo aprovado](prompts_migracao_supabase_etapas_2_a_8.md), [arquitetura](migracao_supabase_etapa_2.md), [modelo](migracao_supabase_etapa_3.md), [esquema inicial](migracao_supabase_etapa_4.md) e [AGENTS.md](../AGENTS.md).

## 1. Fluxos implementados

- Seleção explícita de persistência por processo: `files` ou `postgres`. Ausência de configuração mantém o modo de arquivos; valor inválido interrompe a inicialização. Falha no PostgreSQL não ativa arquivos como fallback.
- Ciclo de vida do FastAPI abre/fecha o pool opcional. No modo PostgreSQL, não executa recuperação, limpeza, migração de anotações ou carregamento de planilhas/JSON locais.
- Consultas de equipamento, busca rápida/expandida, estatísticas, unidades, aliases e histórico de apelidos leem snapshots SQL consistentes.
- Cadastro/edição de equipamento, cadastro/edição de unidade, alteração de apelido, desfazer e exclusão/restauração do último evento de apelido usam transações PostgreSQL.
- IDs públicos numéricos de unidades e textuais de eventos permanecem nos contratos. Campos textuais preservam zeros à esquerda; override vazio de apelido é aceito.
- Apelido manual prevalece sobre hostname único da fonte auxiliar, que prevalece sobre a base. Colisões normalizadas de overrides não são aplicadas por aproximação. Todas as linhas de equipamentos continuam no banco; a projeção de consulta mantém a regra da última linha, e edição de série duplicada é bloqueada.
- Validações Pydantic, nomes das rotas, métodos e campos das respostas existentes foram mantidos. Mensagens de gravação do piloto mencionam banco local, sem afirmar que houve escrita em Excel. O campo legado `salvo_no_disco` permanece na resposta de apelido como confirmação de persistência durável.
- A revisão opaca de equipamento continua tendo 64 caracteres. No piloto incorpora identidade do lote/equipamento e versão relacional, além do hash de campos, evitando reaproveitamento de uma revisão depois de alterações que devolvam o mesmo conteúdo.

Não há migração automática, escrita dupla ou cópia de arquivos operacionais para o banco. Sem lote validado ativo, cadastro/edição de equipamento retorna `409`. A criação de lote e sua ativação continuam reservadas aos fluxos de importação/arquivos posteriores.

## 2. Limite entre as etapas

No modo PostgreSQL, atualização de planilhas, transferência/exportação Excel, comparação, restauração de inventário e histórico/anotações de comparações retornam `501`, indicando a integração pendente da Etapa 6. Esses endpoints mantêm o funcionamento existente no modo de arquivos.

O bloqueio impede que uma instalação PostgreSQL leia um histórico JSON de outra base ou exporte uma planilha desatualizada como se refletisse gravações SQL. Rotas estáticas e documentação continuam disponíveis. O painel de prontidão informa as funções ainda indisponíveis.

Nenhuma regra de igualdade, identidade, sincronização compartilhada ou reaplicação de anotações foi substituída. Não foram criados buckets, contas Auth, expurgo SQL ou backups de banco.

## 3. Transações, concorrência e falhas

### Gravação

1. Obter uma conexão do pool e iniciar transação explícita.
2. Validar login limitado, identidade do banco descartável, PostgreSQL 17 e RLS. Definir papel/contexto somente dentro da transação.
3. Bloquear `estado_aplicacao` com `FOR UPDATE`, coordenando gravações e IDs do catálogo.
4. Conferir idempotência e, para equipamento existente, revisão opaca e versão da entidade. Lote ativo precisa estar validado.
5. Executar todas as mudanças de entidades/histórico; atualizar a revisão global com condição e conferir a linha afetada.
6. Preparar a projeção e a resposta completa antes do commit. Persistir resultado e hash do pedido em `operacoes` na mesma transação.
7. Retornar sucesso somente após sair do bloco transacional com commit confirmado.

Falha ao preparar a projeção reverte DML e revisão. Conflitos de revisão, unicidade, FK, deadlock e espera de bloqueio retornam `409`; falhas SQL/conexão retornam `503` com mensagem sem detalhes internos. Não há retry automático de uma gravação cujo commit possa ter ocorrido.

### Idempotência

Rotas de gravação aceitam o cabeçalho opcional `Idempotency-Key`: 1 a 128 caracteres ASCII entre letras, números, ponto, hífen, dois-pontos e sublinhado. A chave é delimitada pelo comando; um hash canônico do payload inclui campos explicitamente fornecidos no cadastro/edição de equipamento.

- Mesmo comando/chave/pedido confirmado: retorna a resposta persistida, sem novo evento ou incremento de revisão.
- Mesma chave com outro pedido: `409`.
- Cabeçalho inválido/duplicado: `422`.
- Sem cabeçalho: identidade nova por execução; o frontend atual ainda não envia uma chave reutilizável. Portanto, retries de transporte do cliente atual não têm deduplicação garantida entre requisições.
- Se a conexão cair durante o commit, conferir/repetir com a mesma chave permite descobrir o resultado confirmado sem presumir que a falha significa rollback.

### Leitura e estado em memória

Leituras usam `REPEATABLE READ READ ONLY`. O piloto não publica snapshots no cache global do modo de arquivos: cada requisição prepara uma visão própria do banco. Outra instância observa gravações confirmadas na próxima leitura. Isso evita publicação antecipada e sobrescrita de cache por uma resposta antiga, ao custo de consultas/projeções completas por requisição.

Catálogo e apelidos preservam a semântica atual de gravação serializada. A API dessas entidades não fornece revisão de edição ao cliente; duas edições distintas válidas seguem a ordem dos commits. Edição de equipamento possui controle otimista explícito.

Pool: padrão quatro conexões, configurável de uma a oito; fila limitada a 16, aquisição de até cinco segundos, conexão de três segundos, comando de cinco segundos e espera de lock de três segundos. Papel, search path e contexto são definidos com `SET LOCAL`, sem identidade de usuário compartilhada entre requisições. SQL usa parâmetros para os valores.

## 4. Segurança do piloto e ajuste do esquema

[Quarta migration](../supabase/migrations/20261009000400_backend_pilot.sql):

- Acrescenta `operacoes.resultado JSONB` para replay durável de resposta idempotente.
- Cria `simpress_piloto` como papel separado, `NOLOGIN`, sem superusuário, propriedade, criação de papéis/bancos, replicação ou bypass de RLS.
- Concede leitura somente nas 12 tabelas necessárias e DML nos registros operacionais integrados. Atualização de equipamento fica limitada a modelo, tipo, IdCliente, versão e horário. Não permite ao piloto trocar lote ativo, manipular anotações, Storage ou configuração administrativa.
- Mantém RLS habilitado e forçado nas 20 tabelas. Políticas do piloto exigem contexto transacional explícito. `anon`, `authenticated`, `service_role` e `simpress_runtime` continuam sem grants de domínio e sem políticas de liberação.
- Não cria login/senha, conta Auth, fontes, lotes ativos ou dados operacionais.

O login temporário `simpress_piloto_login` tem somente vínculo de `SET ROLE` com o piloto, sem herança ou administração desse papel. A aplicação verifica os atributos, vínculos, propriedade e RLS em cada transação. Também recusa uma instalação com administrador já provisionado, mesmo desabilitado.

**Este papel é acesso confiável do backend para ensaio local; não implementa autorização de usuários.** O contexto do piloto não é prova de identidade. A Etapa 7 deverá retirar/substituir esse caminho antes de autenticar/liberar a operação oficial. O schema permanece fora da Data API.

A configuração aceita somente `127.0.0.1:54322/postgres`, login próprio e PostgreSQL 17 com marcador descartável. Não aceita parâmetros extras na URL, hosts alternativos ou credenciais administrativas. O driver fixa endereço/porta locais também nas opções de conexão, evitando redirecionamento por variáveis libpq herdadas. O middleware aceita somente clientes loopback e mantém as verificações existentes de Host/Origin.

## 5. Configuração e comandos locais

Dependências opcionais: **Psycopg 3.3.6**, distribuição binária da mesma versão, e **psycopg_pool 3.3.3**. O modo de arquivos não importa nem exige esses pacotes. Ver [requirements-postgres.txt](../requirements-postgres.txt) e [exemplo sem credenciais reais](../.env.supabase.example).

Com Rancher Desktop aberto, na raiz do projeto:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-postgres.txt
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
.\.venv\Scripts\python.exe -B scripts/supabase_local.py migrate
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py
```

Use `start` em uma instalação nova sem volumes; use `resume` somente para os volumes reconhecidos. Se os serviços já estiverem ativos, use `check` em vez de `resume`.

O iniciador do piloto gera senha aleatória só em memória, cria o login SQL limitado em transação, passa a configuração apenas ao processo filho e abre `127.0.0.1:8000`. `--port 8001` permite outra porta entre 8000 e 8099. A senha não é exibida, salva ou passada na linha de comando. O login é removido ao encerrar normalmente. Um login já existente é recusado, sem redefinir sua senha ou assumir sua propriedade. Encerramento forçado do computador/processo pode deixar o login pendente; requer inspeção administrativa local antes de repetir o iniciador.

Configuração manual por ambiente, documentada no exemplo:

- `SIMPRESS_PERSISTENCE_BACKEND`: `files` por padrão; `postgres` para o piloto.
- `SIMPRESS_POSTGRES_LOCAL_PILOT=1`: habilitação explícita.
- `SIMPRESS_DATABASE_URL`: URL privada do login limitado; nunca usar `postgres`/service role.
- `SIMPRESS_DATABASE_POOL_SIZE`: inteiro entre 1 e 8, padrão 4.

Arquivos dotenv não são carregados automaticamente. O iniciador fornece essas variáveis somente ao filho; não altera PATH/configuração global nem a sessão do modo de arquivos. Se `iniciar_servidor.bat` receber a seleção PostgreSQL manualmente, encaminha ao iniciador do piloto antes de executar qualquer manutenção de arquivos.

Para voltar ao modo de arquivos, encerrar o piloto, remover variáveis PostgreSQL definidas manualmente ou selecionar `files` e iniciar normalmente. Isso não copia gravações SQL para XLSX/JSON; o modo de arquivos conserva seu estado independente. Não usar essa seleção como estratégia de reconciliação após um futuro cutover.

## 6. Verificações e evidências

### Ensaios locais

[Ensaio reproduzível](../scripts/verify_postgres.py):

```powershell
.\.venv\Scripts\python.exe -B scripts/verify_postgres.py --local-disposable
```

Cria exclusivamente o banco novo `simpress_etapa5_validation` no contêiner local já identificado. Recusa se esse nome existir; aplica as quatro migrations, gera login temporário, usa apenas fixtures sintéticas e remove o banco criado e o login no final. Não reinicializa nem importa dados no banco principal.

O banco isolado usa uma tabela mínima `auth.users(id)` como suporte às FKs do domínio; isso não é instalação nem teste de Supabase Auth. As 66 verificações estruturais adicionais foram executadas no Supabase principal real, com suas fixtures revertidas.

**Resultados:**

- 31 verificações reais de PostgreSQL/HTTP: base vazia sem importação implícita; unidades/IDs; equipamentos/revisões/zeros à esquerda; override vazio; desfazer/excluir; idempotência/reuso incompatível; concorrência de pedidos iguais e distintos; rollback após DML; segundo backend sem cache antigo; isolamento do pool; privilégios negativos; duplicatas; evento antigo; recusa de administrador provisionado; validação Pydantic e bloqueio de fluxos mistos.
- 66 verificações SQL estruturais e de segurança + quatro HTTP da Etapa 4, repetidas após a migration. A asserção sobre policies aceita exclusivamente as do papel separado do piloto.
- 22 testes focados: dez novos de configuração/isolamento/limite de commit, nove do helper local e três de histórico de apelidos.
- 36 testes existentes de contratos/rotas/inicialização.
- Sete regressões existentes do modo de arquivos: IDs de unidades, concorrência, rollback, edição da fonte correta, preparação do índice antes do commit, override e desfazer.
- Verificação gradual de tipos com mypy 2.4.0 passou nos oito módulos selecionados, usando `--explicit-package-bases` para resolver os scripts como pacote. Quatro inconsistências de anotação identificadas na primeira análise foram corrigidas; não houve alteração de comportamento para satisfazer o verificador.
- Sintaxe Python/TOML, links locais de oito documentos e scanner de padrões conhecidos de credenciais passaram, incluindo os arquivos novos ainda não rastreados. `git diff --check` passou; arquivos novos foram conferidos separadamente quanto a espaços finais.
- Conferência final confirmou banco principal sem linhas operacionais, sem contas Auth/buckets, revisão zero e nenhum lote ativo; banco e login sintéticos ausentes. Identidade do contêiner, rede e publicações de loopback foram conferidas novamente antes da parada.

Na primeira execução de testes, a criação de loop `asyncio` travou no sandbox Windows. Somente os processos identificados dessa execução foram encerrados. A fixture nova de middleware, sem I/O, passou a executar sua coroutine diretamente; a repetição dos 22 testes concluiu. Os testes existentes de contratos e os sete fluxos foram executados fora dessa restrição, com fixtures temporárias.

As dependências foram instaladas no `.venv`; o primeiro acesso PyPI no sandbox falhou por DNS e a instalação com permissão de rede concluiu. Não houve consulta a banco remoto.

### Limites de validação

Não foram executadas a suíte completa Python, a suíte JavaScript, avaliação visual do navegador, carga/performance, importação real, queda real de conexão durante COMMIT, recuperação após falha de energia ou testes de Auth/Storage. A falha de confirmação de commit foi simulada em teste isolado. Esses resultados não declaram o sistema pronto para uso oficial.

Sem inventário importado, o banco principal permanece com configuração/estado iniciais; as gravações do ensaio ficam somente no banco sintético removido. Serviços locais são encerrados ao final, preservando volumes e rede. Nenhum backup de banco é produzido nesta etapa.

## 7. Arquivos e próximos passos

- [Camada de persistência](../persistence/postgres.py), [configuração](../persistence/config.py) e [limite de requisições](../persistence/boundary.py).
- [FastAPI](../main.py), [catálogo](../routers/units.py) e [inicializador Windows](../iniciar_servidor.bat).
- [Helper local](../scripts/supabase_local.py), [iniciador do piloto](../scripts/run_postgres_pilot.py), [ensaio](../scripts/verify_postgres.py) e [testes focados](../tests/test_postgres_persistence.py).
- Quarta migration, fixture estrutural atualizada, dependências/exemplo, README e relatórios.

Etapa 6: implementar arquivos/Storage, importação de lotes, comparações, backups, restauração e anotações preservando os protocolos existentes. Etapa 7: autenticação/autorização, substituição do papel de piloto e cenários positivos/negativos. Etapa 8: reconciliação, recuperação e ensaio de cutover autorizado.

Referências oficiais consultadas para implementação: [conexão SQL no Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres), [proteção dos dados](https://supabase.com/docs/guides/database/secure-data), [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [transações Psycopg](https://www.psycopg.org/psycopg3/docs/basic/transactions.html), [pool Psycopg](https://www.psycopg.org/psycopg3/docs/advanced/pool.html), [versão do driver](https://www.psycopg.org/psycopg3/docs/news.html) e [versão do pool](https://www.psycopg.org/psycopg3/docs/news_pool.html).
