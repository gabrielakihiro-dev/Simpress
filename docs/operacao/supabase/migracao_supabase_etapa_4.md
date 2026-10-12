# Migração Supabase — Etapa 4: migrations e ambiente local

**Data:** 09/10/2026, America/Sao_Paulo.

**Escopo autorizado:** implementar o plano da Etapa 4; somente ambiente local descartável, dados sintéticos e acesso fechado. Sem integração com FastAPI, dados reais, recursos remotos, commit ou push.

**Referências:** [modelo da Etapa 3](migracao_supabase_etapa_3.md), [arquitetura aprovada](migracao_supabase_etapa_2.md), [pré-requisitos](migracao_supabase_pre_requisitos_locais.md) e [regras do projeto](../../../AGENTS.md).

**Atualização posterior — Etapa 5:** uma quarta migration acrescenta o resultado de operações idempotentes e acesso exclusivo de um papel separado para o piloto local. As três migrations e o acesso fechado descritos abaixo correspondem à entrega original da Etapa 4. Os papéis públicos e `simpress_runtime` permanecem fechados. A fixture estrutural passou a aceitar somente políticas do papel do piloto; veja o [relatório da Etapa 5](migracao_supabase_etapa_5.md).

## 1. Implementação

### CLI e configuração

- Dependência de desenvolvimento `supabase` fixada em **2.120.0**, com atualização de `package-lock.json`. Demais dependências diretas preservadas.
- Node.js observado: **24.21.0**. Docker cliente/servidor observado anteriormente: **29.6.2-rd / 29.5.3**; servidor **29.5.3** reconfirmado nesta etapa.
- Projeto **simpress-dev**, PostgreSQL **17.11**, imagem `public.ecr.aws/supabase/postgres:17.11.0.004`.
- Serviços locais: PostgreSQL, Auth, Storage, PostgREST e gateway Kong. Studio, Realtime, SMTP local, Analytics, funções, pooler e serviços opcionais desabilitados/excluídos.
- API em `127.0.0.1:54321`; banco em `127.0.0.1:54322`; porta `54320` reservada na configuração para banco temporário de comparação. Nenhum banco temporário de comparação foi necessário nesta entrega.
- Rede dedicada `simpress-dev-loopback`, com opção de publicação padrão `127.0.0.1` e rótulo de desenvolvimento descartável. Endereços publicados conferidos nos contêineres efetivos.
- Volumes próprios `supabase_db_simpress-dev` e `supabase_storage_simpress-dev`. Não ficam em `Backup_Banco`; essa pasta continua sendo o destino de backups futuros, sem dump produzido nesta etapa.
- Cadastro público, cadastro por e-mail/SMS e login anônimo desabilitados. Seeds automáticos desabilitados. Nenhuma conta criada.
- Configuração local sem segredo literal. Cache/recibo local e chaves de assinatura ficam ignorados pelo Git.

A primeira execução do CLI dentro do sandbox não conseguiu criar seu diretório no perfil do usuário. Repetida com autorização da ferramenta fora do sandbox, concluiu. As operações Docker também exigiram essa execução; não houve rejeição de aprovação automática.

### Estrutura relacional

Três migrations, na ordem:

1. [Tabelas do domínio](../../../supabase/migrations/20261009000100_domain_tables.sql): 20 tabelas e checks de tipos, estados, hashes, versões e limites.
2. [Relações e índices](../../../supabase/migrations/20261009000200_relations_indexes.sql): 32 FKs com exclusão restrita e índices para referências/consultas.
3. [Acesso fechado e inicialização](../../../supabase/migrations/20261009000300_closed_access_bootstrap.sql): papel sem login, remoção de grants, privilégios futuros restritos, RLS habilitado/forçado e duas linhas de configuração.

Tabelas implementadas:

```text
configuracao, estado_aplicacao, operacoes, objetos_arquivo,
arquivos_origem, lotes_inventario, fontes_lote, linhas_fonte,
equipamentos_lote, unidades_catalogo, unidades_customizadas,
apelidos_manuais, historico_apelidos, eventos_comparacao,
linhas_comparacao, anotacoes, pendencias_sincronizacao,
backups_logicos, referencias_backup, conflitos_importacao
```

O banco começa sem lote ativo, com revisão zero, retenção de 60 dias e administrador ausente/desabilitado. Não há registros de inventário, histórico, anotações, operações ou arquivos reais.

### Segurança

- Schema `simpress` fora da Data API e de seus schemas expostos.
- RLS habilitado e forçado nas 20 tabelas, **sem políticas de liberação**. A ausência de política mantém acesso fechado para papéis sem bypass.
- Sem grants de schema/tabelas/sequências/funções para `PUBLIC`, `anon`, `authenticated`, `service_role` ou `simpress_runtime`.
- `simpress_runtime` sem login, superuser, criação de papéis/bancos, replicação, herança ou bypass; não é proprietário das tabelas.
- O Supabase cria automaticamente um vínculo administrativo de `postgres` ao papel novo, com `ADMIN=true`, `INHERIT=false` e `SET=false`. A migration permite somente esse vínculo administrativo esperado e recusa outros vínculos. Não confundir a conta administrativa de migrations com o futuro papel de execução do backend.
- As fixtures permitem temporariamente `SET ROLE` e grants de teste para comprovar o bloqueio por RLS independentemente dos grants. Tudo é revertido na mesma transação; a configuração final permanece fechada.
- Nenhum bucket criado nem DML manual em tabelas gerenciadas de Storage/Auth. Autenticação funcional e policies de acesso autorizado pertencem às etapas posteriores.

## 2. Detalhes físicos definidos a partir do modelo

- Equipamento importado possui `papel_origem='detalhes'` e FK composta para `(linha_origem_id, lote_id, papel)`. O banco rejeita referência ao lote errado ou à fonte auxiliar.
- `fontes_lote` referencia também o papel do arquivo. Um arquivo Endpoint não pode ser cadastrado como fonte oficial por engano.
- IDs legados de evento/item continuam `text`; série bruta/normalizada e fingerprints não recebem unicidade que descarte duplicatas.
- Uma anotação ativa por `(evento_id,item_id)`, com limite de 2.000 caracteres e texto vazio permitido. FKs não apagam notas por cascata.
- Payload original/canônico em `text`; projeções em `jsonb`. O banco confere SHA-256 dos bytes UTF-8 do texto fornecido e a categoria, sem gerar canonicalização a partir de JSONB.
- Contexto compartilhado parcial pode existir sem hash/payload completo, mantendo seus IDs e notas. Isso não implementa reaplicação por aproximação.
- Estados usam `text` com checks para novas operações. A operação inclui `edicao` para futuras gravações nativas e `pedido_sha256` opcional para detectar reuso de chave idempotente com outro conteúdo na futura camada de persistência.
- Originais de eventos/histórico usam texto; sua cópia integral como artefato privado será responsabilidade da importação. Arquivos XLSX não são reconstruídos a partir das linhas SQL.
- Ordem de evento usa identidade `GENERATED BY DEFAULT`, permitindo importação da ordem original. O futuro importador deve ajustar a sequência ao maior valor importado antes de criar eventos novos; não há importador nesta etapa.
- IDs de unidades usam `bigint > 0`, sem rejeitar silenciosamente um legado por um limite novo de formulário. O limite seguro do JavaScript para novos IDs permanece uma validação da futura camada de domínio.
- O marcador de banco descartável é escrito pelo script somente na instância local identificada, e não embutido nas migrations reutilizáveis.

Expurgo, imutabilidade por transição de estado, ativação transacional de lote, reaplicação de notas, reconciliação de aliases e atomicidade entre banco/Storage não foram implementados. As etapas seguintes usarão a estrutura com as regras de domínio já documentadas.

## 3. Operação local segura

[Script de operação](../../../scripts/supabase_local.py) aceita somente ações predefinidas e este projeto/checkout. Não aceita URL de banco, referência remota ou nomes arbitrários de projeto.

Ele confere versão do CLI, configuração, ausência de vínculo remoto, rede, rótulos de projeto/checkout, versão do PostgreSQL e endereços publicados. O recibo ignorado em `supabase/.temp/` contém apenas nomes/datas dos volumes e o checkout; não contém chaves.

Comandos a executar na raiz do Simpress, com Rancher Desktop aberto:

```powershell
# Após instalar as dependências do projeto, retomar os volumes já reconhecidos:
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume

# Conferir a instância e executar as verificações sintéticas:
.\.venv\Scripts\python.exe -B scripts/supabase_local.py check
.\.venv\Scripts\python.exe -B scripts/supabase_local.py validate

# Encerrar somente este projeto, preservando os volumes:
.\.venv\Scripts\python.exe -B scripts/supabase_local.py stop
```

`start` é reservado para uma primeira instância sem contêineres/volumes existentes; `resume` retoma somente os volumes reconhecidos. Não apagar volumes para fazer esses comandos passarem.

`reset` existe exclusivamente para este ambiente descartável: exige marcador, recibo compatível, ausência de conta/buckets, estado inicial e todas as tabelas operacionais vazias. Usa explicitamente `--local --no-seed`. Não usar reset após iniciar a importação/uso real. A configuração e os registros reais não são inspecionados para autorizar exclusão de dados externos.

Saídas de status do CLI podem conter credenciais; o script as mantém apenas em memória e apresenta resultados resumidos. Não colar status completo em relatórios/chat. O código não solicita login na plataforma nem vincula um projeto remoto.

## 4. Validações executadas

### Aplicação e reprodução das migrations

- Primeira inicialização aplicou as três migrations em banco novo.
- Reconstrução do banco vazio identificado como descartável concluiu, reaplicando as três migrations sem seed.
- PostgreSQL respondeu como **17.11**; registro local confirmou as três versões de migration.
- Endereços publicados efetivos: API `127.0.0.1:54321`, PostgreSQL `127.0.0.1:54322`; demais serviços sem porta pública própria.

### SQL — 66 verificações aprovadas

[Fixtures SQL](../../../supabase/tests/etapa_4.sql), executadas depois da reconstrução:

- Exatamente 20 tabelas; RLS forçado em todas, sem policies permissivas.
- 32 FKs com exclusão restrita e índices compatíveis no lado referenciador.
- Estado inicial, retenção de 60 dias, nenhuma conta Auth ou bucket Storage.
- Duplicatas de série, colisões normalizadas de aliases e IDs não UUID preservados.
- CNPJ/CEP/IdCliente mantêm zeros à esquerda.
- Referências cruzadas entre lote/fonte e evento/item rejeitadas.
- Datas inválidas e referências legadas não resolvidas representáveis.
- Notas vazias e de 2.000 caracteres aceitas; 2.001 rejeitada.
- Contexto compartilhado sem histórico completo/hash permanece representável.
- Payloads `1` e `1.0` mantêm textos/hashes diferentes; hash incorreto rejeitado.
- Categoria nula/divergente e metadados de anotação no payload canônico são rejeitados; Unicode e nulos nos dados originais são preservados.
- O limite da nota conta caracteres Unicode, não bytes UTF-8.
- Arquivos, lotes, eventos e linhas referenciados não são apagados por cascata.
- Chave idempotente e versão/destino de outbox não permitem duplicação.
- Grants fechados para quatro papéis; com grants temporários, RLS impede leitura/escrita para `anon`, `authenticated` e `simpress_runtime`.

As fixtures terminam em `ROLLBACK`. Em caso de erro, o encerramento da conexão também reverte a transação. Não ficam dados de teste ou permissões temporárias.

### HTTP — 4 verificações aprovadas

- Auth saudável.
- Configuração pública de Auth confirma cadastro desabilitado.
- Requisição sem API key não resolve a tabela de domínio em `public`: `404/PGRST205`.
- Requisição com API key anônima e `Accept-Profile: simpress` é rejeitada: `406/PGRST106`.

O gateway local permite certas requisições sem API key; não foi presumido que ausência de chave gera sempre 401. A proteção demonstrada é schema privado, grants fechados e RLS. Nenhuma sessão de usuário foi criada/testada nesta etapa.

### Script — 9 testes aprovados

[Testes focados](../../../tests/test_supabase_local.py): configuração aprovada, bloqueio de vínculo remoto/projeto alterado, binds de loopback, rejeição de outros binds, rótulos/rede corretos, identidade de volumes, redação de erros sensíveis e parada restrita ao projeto preservando volumes.

```powershell
.\.venv\Scripts\python.exe -B -m unittest tests.test_supabase_local -v
```

Esses testes não invocam Docker/CLI. Os casos de arquivos temporários foram substituídos por mocks após restrição do sandbox na primeira tentativa; a versão final não grava arquivos temporários nesses testes.

### Conferências finais e limites

- Sintaxe Python/TOML passou; links locais e blocos Markdown conferidos.
- Scanner de padrões conhecidos de credenciais passou em 13 arquivos do escopo, incluindo arquivos ainda não rastreados. Isso é uma verificação de padrões, não uma garantia absoluta de ausência de segredo.
- `git diff --check` passou. Arquivos novos foram conferidos separadamente quanto a espaços finais, pois ainda não estão no índice do Git.
- Conferência após a transação confirmou ausência de fixtures, contas, buckets e associações temporárias de papel.
- Parada e retomada dos mesmos volumes concluíram, mantendo acesso fechado. Depois disso, o reforço da constraint de categoria canônica foi reaplicado por reconstrução limpa e passou nas 66 verificações finais.

A suíte completa da aplicação não foi repetida. Os testes desta etapa não demonstram autenticação de usuário, migração de dados reais, reaplicação de notas, backup recuperável, desempenho de uso oficial ou comportamento de um projeto remoto. As limitações da suíte da Etapa 1 continuam naquela etapa.

## 5. Entrega e próximo passo

- Arquivos principais: configuração/ignore do Supabase; três migrations; fixtures SQL; script e testes focados; dependência/lockfile; este relatório e atualização dos pré-requisitos.
- A aplicação continua usando XLSX/JSON; listener, rotas, frontend, planilhas e estado operacional preservados.
- Banco preparado com acesso fechado. A Etapa 5 fará a integração incremental do FastAPI, mediante solicitação.
- Na conclusão original desta etapa, nenhum commit ou push havia sido realizado. A publicação posterior do conjunto das Etapas 1 a 4 foi autorizada pelo usuário, com atualização do README.

**Conclusão de operação:** esquema local reproduzido e validado; retomada dos mesmos volumes demonstrada. Os serviços são encerrados ao final desta entrega, preservando os volumes, a rede dedicada e o recibo local sem segredos. Nenhum backup de banco foi produzido e nenhum dado operacional foi migrado.
