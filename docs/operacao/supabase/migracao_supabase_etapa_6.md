# Migração Supabase — Etapa 6

> Registro histórico da Etapa 6. A [Etapa 7](migracao_supabase_etapa_7.md) acrescenta autenticação e altera as permissões do runtime. As descrições abaixo de acesso sem autenticação representam o estado anterior a essa evolução.

**Data:** 09/10/2026. **Escopo:** piloto local de arquivos privados, importação de inventário, backups lógicos, histórico e anotações. Execução solicitada por Gabriel; sem commit ou push.

## Resultado e limites de uso

A integração foi implementada no backend PostgreSQL opcional. Excel/JSON continua sendo o modo padrão, com sua sincronização de anotações pela pasta compartilhada. O piloto usa o projeto descartável `simpress-dev`, banco privado `simpress` e bucket privado `simpress-pilot`.

Os ensaios usam exclusivamente planilhas geradas em memória, modelos sintéticos e bancos temporários criados pela própria execução. Nenhuma planilha operacional foi importada, nenhum projeto remoto foi acessado e nenhuma conta administradora foi criada. A aplicação ainda não autentica usuários: permanece restrita a loopback, com autorização de usuários prevista para a Etapa 7.

O esquema mantém as 20 tabelas, com RLS habilitado e forçado. A quinta migration acrescenta o diário de execução de arquivos, a exclusão lógica do histórico e as permissões específicas do papel local `simpress_piloto`. Os papéis `anon`, `authenticated`, `service_role` e `simpress_runtime` continuam sem acesso ao domínio SQL. A credencial privilegiada usada na API local de Storage permanece somente no servidor.

## Fluxo de atualização e confirmação

1. O backend valida os dois uploads com os validadores existentes. A Simpress determina o inventário; o Endpoint fornece contexto e hostnames. Todas as ocorrências de séries duplicadas são armazenadas, sem deduplicação da fonte.
2. Uma transação curta bloqueia a revisão global e registra a operação, a revisão esperada, a identidade do pedido, os hashes, os nomes originais e as chaves dos objetos. Para atualização/restauração, registra também o estado lógico anterior.
3. Fora da transação SQL, o backend envia os objetos imutáveis ao Storage e os baixa para conferir tamanho e SHA-256. Não usa sobrescrita de objeto. Uma resposta de duplicidade só é aceita depois dessa conferência.
4. Outra transação verifica executor, reserva e revisão. Registra as fontes e linhas, cria o lote, guarda o backup lógico, calcula comparação/anotações e prepara a resposta antes de confirmar o novo estado ativo.
5. O resultado confirmado fica no diário. Repetir a mesma `Idempotency-Key` com os mesmos bytes devolve esse resultado; conteúdo diferente com a mesma chave retorna conflito.

SQL e Storage têm confirmações independentes. Um upload completo sozinho não ativa lote nem publica uma nova revisão. As transações SQL de leitura usam snapshots consistentes, sem depender de cache global em memória entre processos.

### Identidade e proveniência

- Objetos recebem chaves geradas pelo servidor, com UUID da operação, papel e hash; nomes enviados pelo usuário não se tornam caminhos de Storage.
- Os bytes originais de cada XLSX são preservados. Fontes registram nome original, parser, aba, papel, contagem e objeto; linhas registram posição, células com tipo, dados interpretados, série bruta/normalizada e estado de validação.
- Equipamentos importados apontam para a linha oficial do mesmo lote por FK composta. Séries repetidas continuam representáveis. A projeção da aplicação mantém as regras de ambiguidade e precedência existentes.
- Modelos de exportação e transferência são objetos versionados. Sua troca altera um ponteiro SQL; o objeto anterior continua disponível para backups referenciados.
- Eventos e linhas têm identidades independentes. Payload original e payload canônico permanecem em texto; JSONB é usado para consultas. O texto canônico distingue `1` de `1.0`.
- Rótulos de apresentação passam pelas funções já existentes: `na Simpress`, `no endpoint` e os rótulos específicos de cada seção. Os nomes e valores brutos para auditoria não são reescritos.

## Falhas, repetição e recuperação

O diário guarda plano, artefatos, tentativa, executor, reserva e revisões esperada/confirmada. O fluxo de arquivos usa os estados `arquivos_pendentes`, `arquivos_verificados`, `confirmada`, `falhou` e `cancelada`. Objetos usam `pendente`, `verificado`, `exclusao_pendente` e `removido`.

- **Falha antes de completar o upload:** o estado ativo permanece anterior. Reenvie os mesmos arquivos com a mesma chave. A recuperação sem os arquivos originais exige que todos os objetos necessários já tenham sido enviados.
- **Upload completo e falha antes do commit:** os objetos permanecem associados à intenção. A recuperação relê os objetos, confere hashes e retoma a confirmação se a revisão ainda corresponder.
- **Resposta perdida depois do commit:** a operação continua confirmada. A repetição devolve o resultado gravado, sem criar outro lote ou avançar novamente a revisão. O tratamento de erro não sobrescreve uma confirmação existente.
- **Revisão alterada por outra edição:** a confirmação é recusada. Confira o diário, cancele a tentativa e inicie outro pedido; não existe sobrescrita silenciosa do estado mais recente.
- **Executor ativo:** uma reserva de dois minutos, renovada antes das operações de rede, impede retomada/cancelamento concorrente. Após perda da reserva, o executor antigo não pode confirmar.
- **Cancelamento:** operações confirmadas, reservadas ou com objetos referenciados são recusadas. Para órfãos, a intenção de exclusão é confirmada em SQL antes de enviar DELETE ao Storage. Apenas os objetos enumerados naquela operação são visitados.
- **Resposta de DELETE perdida:** repetir o cancelamento aceita objeto já ausente e conclui o estado `removido`. Não há limpeza indiscriminada de bucket.
- **Hash divergente, objeto ausente ou bucket público:** a operação falha com mensagem controlada, preservando as referências e o estado ativo.

A interface mantém uma chave por tentativa de atualização e restauração enquanto a página estiver aberta. Na restauração, uma resposta incerta mantém também o token original da prévia. Recarregar a página perde esse estado do navegador; use o diário de operações para conferir o resultado antes de enviar uma nova tentativa.

## Backups e restauração

### Backup lógico anterior a cada alteração de lote

Atualização e restauração guardam um manifesto privado com equipamentos, incluindo edições feitas em SQL, fontes/linhas, catálogo, unidades customizadas, apelidos manuais e ponteiros dos modelos. O registro SQL relaciona os objetos necessários ao snapshot e protege essas referências.

A prévia de restauração verifica o manifesto e os arquivos referenciados. Seu token vincula evento, backup, hash e revisão global. Uma edição posterior invalida a prévia. A confirmação cria um novo lote com linhas de origem relacionadas corretamente, restaura valores lógicos e registra outro evento, guardando o conjunto substituído para desfazer. Histórico e anotações continuam associados aos resultados originais.

A resposta HTTP mantém o contrato da interface, incluindo contagens, arquivos restaurados e disponibilidade de desfazer. A prévia informa também as fontes atuais e identifica uma ação de desfazer restauração.

### Arquivo completo do domínio e Storage

`scripts/backup_postgres_pilot.py --local-disposable` cria um ZIP em `Backup_Banco/`. Ele contém:

- snapshot consistente das 20 tabelas do domínio;
- migrations versionadas;
- bytes de todos os objetos verificados;
- manifesto com revisão, tamanho e SHA-256 de cada entrada.

O arquivo só recebe seu nome definitivo após verificação das entradas, hashes, migrations, revisão e referências de objetos, seguida de sincronização do arquivo no disco. Operações pendentes impedem o backup completo. O destino deve resolver para a pasta aprovada dentro do projeto; redirecionamento para outra pasta é recusado.

Não contém senhas, papéis PostgreSQL nem identidades Auth. Não é um dump integral da instalação Supabase e não substitui um ensaio de recuperação do serviço. O ensaio desta etapa criou e removeu um arquivo sintético em pasta temporária; não produziu backup de dados operacionais em `Backup_Banco/`.

O backup diário, RPO de 24 horas, RTO de quatro horas e cópia independente continuam pendentes de implementação/medição. A recuperação integral será ensaiada na Etapa 8. O destino aprovado está no mesmo computador; sua presença sob OneDrive não comprova recuperação após perda do computador.

## Histórico, anotações e compatibilidade legada

As seis seções anotáveis continuam usando identificadores estáveis por evento/linha, salvamento de texto vazio e limite de 2.000 caracteres. A anotação fica em tabela própria e é sobreposta à apresentação; editar a nota não reescreve o payload original.

A reaplicação consulta a mesma seção e compara o payload canônico completo, excluindo somente `anotacao` e `anotacao_id`. Examina a ocorrência igual mais recente por ordem do evento. Uma nota só é copiada quando todas as linhas iguais dessa ocorrência têm a mesma nota não vazia. Nota vazia, ausência de nota ou conflito entre duplicadas impedem ressuscitar versões anteriores. O novo evento ganha identidade independente.

O endpoint de importação aceita um JSON explícito com listas `historico` e `anotacoes`. Cada evento preserva seu `id`, horário original e comparação. Cada anotação legada preserva `evento_id`, `item_id`, `categoria`, texto, contexto disponível, horário original e fingerprint quando existente. O JSON original também é guardado como artefato privado.

Anotações sem histórico local criam contexto parcial, sem inventar payload completo. Datas inválidas permanecem em texto com interpretação temporal opcional. Identidades incompatíveis, payload divergente ou notas antigas/conflitantes são registradas para conferência; não sobrescrevem silenciosamente uma edição mais recente. Uma nota acima do limite interrompe a importação daquela operação, sem confirmação parcial.

Não houve leitura automática da pasta compartilhada para alimentar o piloto. O modo de arquivos mantém sua sincronização atual. No piloto, clientes conectados ao mesmo backend leem as anotações SQL; não há sincronização bidirecional automática entre SQL e os JSON do OneDrive nesta etapa. A importação em escala, com dry-run e reconciliação, pertence à Etapa 8.

### Retenção

`POST /api/piloto/retencao` aplica explicitamente os 60 dias configurados à visibilidade de eventos elegíveis. Eventos fixados/protegidos, qualquer evento com anotação e datas sem interpretação válida permanecem acessíveis. Não existe execução agendada.

A retenção é lógica: não apaga payloads, proveniência, backups protegidos ou objetos referenciados. Exclusão manual de um evento também mantém tombstone e os dados brutos; limpa a projeção da nota para impedir reaplicação de texto excluído. A política de expurgo físico do histórico/backups operacionais deverá ser concluída antes do uso oficial, após definir proteção, recuperação e autorizações.

## Downloads e exportações

Downloads privados são mediados por `/api/arquivos/{objeto_id}` e conferem hash/tamanho antes da resposta. Não são emitidas URLs públicas ou assinadas ao navegador.

Exportação do histórico usa as rotas e os geradores existentes, incluindo anotações SQL. Exportação de equipamentos usa o inventário ativo e um modelo privado compatível, alterando apenas as células previstas de apelido/cliente. Preserva fórmulas alheias à edição e partes nativas suportadas pelo validador de pacote. Duplicidades na base ativa ou séries incompatíveis com o modelo impedem a exportação; fórmulas nas células alvo permanecem para conferência.

Transferências usam o gerador e o contrato existentes, com modelo privado baixado para uma pasta temporária isolada. O arquivo resultante fica em memória e a pasta temporária é removida. As planilhas operacionais locais não são usadas como fallback.

A indicação de disponibilidade em `/api/prontidao` verifica a configuração e os ponteiros necessários; o conteúdo do modelo e a disponibilidade efetiva do Storage são novamente validados na operação. Não representa um monitor contínuo de conectividade.

## Execução local

Preparação com o ambiente Python já criado, Rancher Desktop/Moby em execução e volumes locais reconhecidos:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-postgres.txt
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
.\.venv\Scripts\python.exe -B scripts/supabase_local.py migrate
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py --storage
```

Para uma instalação ainda sem volumes, use `start` no lugar de `resume`. O helper recusa apropriar uma instalação existente não reconhecida. O piloto abre em `http://127.0.0.1:8000`; o iniciador aceita outra porta local entre 8000 e 8099. O login SQL tem senha aleatória em memória e é removido no encerramento normal. Não mantenha dois iniciadores usando esse mesmo login.

O iniciador consulta a chave do Storage local em memória com `--storage`; não é necessário preencher um dotenv. `.env.supabase.example` contém somente os nomes de configuração e um campo de chave vazio.

As rotas existentes de atualização, histórico, anotações, exportação, prévia/restauração e transferência atendem ao piloto. As rotas adicionais, acessíveis pela documentação local `/docs`, são:

- `POST /api/piloto/modelos/exportacao` e `/api/piloto/modelos/transferencia`: formulário `upload` com modelo sintético XLSX.
- `POST /api/piloto/anotacoes/importar`: formulário `upload` com JSON sintético de histórico/anotações.
- `GET /api/piloto/operacoes`: últimas 50 operações de arquivos, com chave e estado, sem credenciais.
- `GET /api/piloto/operacoes/{id}`: resultado, revisões e estado de uma operação.
- `POST /api/piloto/operacoes/{id}/recuperar`: retomada pelos artefatos já enviados.
- `POST /api/piloto/operacoes/{id}/cancelar`: cancelamento e limpeza restrita de órfãos.
- `POST /api/piloto/retencao`: retenção lógica explícita.
- `GET /api/arquivos/{objeto_id}`: bytes de um objeto verificado.

Para repetir um envio, preserve a mesma `Idempotency-Key` e os bytes exatos. Regerar um XLSX com os mesmos valores pode mudar seus metadados internos e, portanto, seu hash.

Ensaio completo com fixtures e banco temporário separado:

```powershell
.\.venv\Scripts\python.exe -B scripts/verify_storage_pilot.py --local-disposable
```

Backup do piloto primário e encerramento dos serviços, após encerrar o FastAPI:

```powershell
.\.venv\Scripts\python.exe -B scripts/backup_postgres_pilot.py --local-disposable
.\.venv\Scripts\python.exe -B scripts/supabase_local.py stop
```

## Verificações executadas

Verificações concluídas durante a implementação:

- Ensaio SQL/Storage/HTTP da Etapa 6: **48 verificações aprovadas**, com as cinco migrations aplicadas do zero no banco temporário `simpress_etapa6_validation`. Incluiu hashes dos originais, downloads negados, exportações, restauração lógica, retomada, respostas perdidas de COMMIT/DELETE, séries duplicadas, reaplicação exata, notas legadas/conflitantes, evento excluído, retenção e backup adulterado.
- Suíte Python isolada: **172 testes aprovados**, em Python **3.14.6**.
- Suítes JavaScript: **67 testes aprovados**, incluindo repetição de upload/restauração após resposta perdida.
- Testes unitários de Storage: **8 aprovados**, incluindo corrupção, bucket público, caminhos inválidos, credenciais nas exceções e DELETE repetido.
- Tipagem gradual: **27 arquivos sem erros**, incluindo todo o pacote `persistence`.
- Regressão do piloto PostgreSQL/HTTP: **31 verificações aprovadas**, com concorrência, isolamento de transações, contratos HTTP e bloqueios administrativos. As expectativas históricas de indisponibilidade de anotações/arquivos foram atualizadas para os recursos habilitados pela Etapa 6.
- Sintaxe Python e JavaScript: sem erros. Verificação de whitespace dos arquivos rastreados e novos: sem problemas. Varredura dos padrões conhecidos de credenciais: sem achados, incluindo os arquivos novos.

As primeiras execuções identificaram diferenças no retorno de objeto ausente do Storage local, compatibilidade das partes XML do modelo, formato do índice de duplicidades e contrato HTTP de restauração. Foram corrigidas e os ensaios finais passaram. O teste de resposta perdida usa os mesmos bytes; regenerar a fixture XLSX a cada tentativa produz um pedido diferente e é corretamente recusado.

O banco primário foi reconstruído somente após o helper conferir sua identidade descartável, ausência de dados, Auth, buckets e estado ativo. As cinco migrations foram reaplicadas do zero. A validação estrutural passou em **66 verificações SQL e quatro verificações HTTP**; suas fixtures foram revertidas.

Conferência final antes do encerramento: PostgreSQL **17.11**; cinco migrations; 20 tabelas com RLS habilitado e forçado; zero usuários Auth, buckets, objetos Storage e bancos temporários de ensaio; login efêmero ausente; revisão global zero, sem lote ou modelos ativos. API e PostgreSQL tiveram publicação conferida apenas em loopback. Os serviços `simpress-dev` foram encerrados, preservando os volumes.

Comandos principais usados na validação:

```powershell
.\.venv\Scripts\python.exe -B tests/run_tests.py
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p test_storage_persistence.py -v
.\.venv\Scripts\python.exe -B scripts/verify_postgres.py --local-disposable
.\.venv\Scripts\python.exe -B scripts/verify_storage_pilot.py --local-disposable
.\.venv\Scripts\python.exe -B scripts/supabase_local.py validate
node --test tests/frontend/test_transfer_workflows.cjs tests/frontend/test_inventory_ui_flows.cjs tests/frontend/test_history_annotation_retries.cjs tests/frontend/test_history_annotations.cjs tests/frontend/test_form_draft_guard.cjs tests/frontend/test_catalog_search_utils.cjs tests/frontend/test_ui_motion.cjs
node --check static/app.js
.\.venv\Scripts\python.exe -B scripts/check_secrets.py
git diff --check
```

Também foram executados os comandos de compilação e tipagem declarados em `.github/workflows/ci.yml`, a conferência de dependências (`pip check`), a verificação de whitespace dos arquivos novos e a varredura dos arquivos novos/alterados com o mesmo detector de credenciais do projeto. Os logs das suítes locais ficaram em `supabase/.temp/`, ignorado pelo Git; não contêm a saída privilegiada de status do CLI.

A CI foi atualizada para instalar as dependências opcionais e verificar o pacote de persistência. Nenhuma execução remota da CI foi disparada ou confirmada nesta etapa. Python 3.12 e navegador real não foram exercitados nesta execução; os testes de interface são os testes automatizados locais do projeto.

## Arquivos da implementação

- `supabase/migrations/20261009000500_files_history_pilot.sql`: evolução incremental, grants e políticas do piloto.
- `persistence/storage.py`: acesso privado local, uploads imutáveis e conferência de conteúdo.
- `persistence/files.py`: intenção, reserva, confirmação, importação, backup lógico, restauração, recuperação e retenção.
- `persistence/comparison_history.py`: eventos imutáveis, projeções e mutações de notas/resoluções.
- `persistence/inventory_projection.py`: projeção das fontes e catálogo.
- `persistence/exports.py`: exportações e transferências com modelos privados.
- `persistence/backup.py`: arquivo consistente do domínio e objetos, manifesto e verificação.
- `persistence/routes.py`: endpoints de arquivos e execução do upload fora do loop assíncrono.
- `persistence/postgres.py`, `config.py` e `boundary.py`: integração, configuração e limite local das rotas.
- `main.py`, `routers/inventory_history.py` e `routers/transfers.py`: seleção incremental do backend.
- `scripts/run_postgres_pilot.py`, `backup_postgres_pilot.py`, `verify_storage_pilot.py` e `verify_postgres.py`: iniciador, backup e ensaios.
- `static/app.js`: identidade de tentativas de atualização/restauração.
- `tests/test_storage_persistence.py`, `test_postgres_persistence.py` e `test_inventory_ui_flows.cjs`: verificações locais.
- `requirements-postgres.txt`, `.env.supabase.example`, `.github/workflows/ci.yml`, `README.md` e relatórios: dependências, exemplo e documentação.

Durante a execução apareceram alterações simultâneas no inicializador Windows, bootstrap, prontidão e testes associados. Foram preservadas; não foram revertidas ou publicadas como parte desta etapa. A suíte Python final verificou o estado disponível do workspace naquele momento.

## Pendências para as próximas etapas

- **Etapa 7:** autenticação real, autorização por operação/objeto, revisão de RLS/Storage, proteção de origem e configuração para hospedagem. O papel local e a chave privilegiada de desenvolvimento não devem se tornar a autorização da produção.
- **Etapa 8:** importação repetível com dry-run, reconciliação com cópias autorizadas, restauração integral do arquivo de backup, ensaio de perda de serviço e plano de cutover/rollback. Nenhuma entrada em produção foi executada.
- Definir retenção física, descarte dos backups protegidos, agendamento, cópia independente e medição de RPO/RTO antes de uso oficial.
- Validar volumes, desempenho e limites com tamanho representativo, modelos reais autorizados e formatos legados adicionais. Os ensaios atuais são sintéticos.

## Referências oficiais consultadas

- [Storage: API de upload em ambiente próprio](https://supabase.com/docs/reference/self-hosting-storage/upload-a-new-object).
- [Storage: controle de acesso e credenciais de serviço](https://supabase.com/docs/guides/storage/security/access-control).
- [Backups Supabase: o backup do banco não inclui os bytes dos objetos Storage](https://supabase.com/docs/guides/platform/backups).
- [HTTPX: pacote e versão consultada](https://pypi.org/project/httpx/).

**Versões de execução:** Supabase CLI 2.120.0; PostgreSQL 17; Python 3.14.6; Node.js 24.21.0; psycopg 3.3.6; psycopg-pool 3.3.3; HTTPX 0.28.1; httpcore 1.0.9; certifi 2026.7.22.

**Estado da entrega:** alterações locais revisáveis e relatório gerado; sem importação operacional, ativação de produção, commit ou push executados por esta etapa.
