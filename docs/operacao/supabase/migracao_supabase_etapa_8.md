# Migração Supabase — Etapa 8

Data: 09/10/2026.

## Escopo

Ensaio de importação, reconciliação, recuperação integral do serviço e rollback com dados fictícios. A instalação `simpress-dev`, a conta local existente e os arquivos operacionais foram preservados. O uso oficial e a publicação online exigem uma solicitação posterior e os critérios abaixo.

**Resultado:** ensaio local aprovado com 37 verificações de integração, reconciliação sem diferenças e recuperação/rollback demonstrados com fixtures. O aplicativo permanece em piloto, sem importação de dados reais ou entrada em uso oficial.

## Implementação

- `persistence/migration.py`: pacote explícito com manifesto, identidade UUID, hashes SHA-256, validação anterior à gravação, simulação offline, importação por etapas e reconciliação.
- `persistence/recovery.py`: recuperação criptografada de uma conta de e-mail/senha, das 20 tabelas do domínio, migrations e objetos privados. Preserva UUID do administrador e hash de senha; exige novo login.
- `scripts/rehearsal_stack.py`: projetos novos com identidade, rede, diretório e volumes próprios; recusa adotar qualquer projeto existente.
- `scripts/rehearsal_fixtures.py`: gera exclusivamente planilhas, históricos, unidades, apelidos e modelos fictícios.
- `scripts/migrate_supabase_bundle.py`: simulação de pacote explicitamente informado, sem conexão ao banco ou Storage.
- `scripts/verify_migration_pilot.py`: executa importação, falhas controladas, recuperação em instalação nova e retorno ao ponto anterior.
- `tests/test_migration_rehearsal.py`: validações offline e negativas; incorporadas à descoberta da suíte Python.
- Configuração PostgreSQL, Storage e Auth: perfil interno de ensaio com portas fixas alternativas. Variáveis de ambiente comuns não habilitam esse perfil nem aceitam portas arbitrárias.
- CI: inclui os novos scripts na verificação de tipos, além dos módulos descobertos pelos testes.

### Isolamento

Projetos `simpress-rehearsal-<identificador>-source`, `-restore` e `-rollback` são executados sequencialmente. Usam API `127.0.0.1:55421`, PostgreSQL `127.0.0.1:55422` e reserva de validação `55420`. A instalação existente continua nas portas `54321`/`54322`.

Antes de iniciar, o executor confere conflitos de portas e ausência de diretórios, containers e volumes anteriores com a mesma identidade. Após iniciar, confere labels, rede e todos os endereços publicados. A conexão administrativa exige também marcador próprio no banco e endereço local fixo. Nenhuma URL remota é aceita pelo executor.

Os serviços criados são encerrados ao final, inclusive após falha. Os volumes e recibos são preservados para inspeção. Não há exclusão automática de volumes nem alteração do servidor FastAPI existente na porta 8000.

## Pacote e importação

O manifesto `simpress-migration-bundle-v1` exige `synthetic: true`, `bundle_id` e entradas com caminho relativo e SHA-256. São obrigatórios os papéis `detalhes`, `endpoint`, `historico` e `estado`; modelos de exportação e transferência são opcionais. Aceita somente diretórios explícitos dentro de `supabase/.temp/etapa8/`, ignorada pelo Git.

Cada arquivo tem limite de 30 MiB. Caminhos externos, redirecionamentos, hashes divergentes, chaves JSON duplicadas e números não finitos são recusados. Eventos, identidades de linhas, anotações, unidades e apelidos são validados antes de iniciar a importação.

A simulação calcula contagens por origem, grupos de séries duplicadas, quantidade de eventos, entidades legadas e hashes/tamanhos. Não inicia containers, não lê a base oficial e não grava em banco/Storage; o gerador salva apenas fixtures e o plano no diretório isolado.

Na aplicação autenticada do ensaio, a identidade do pacote fica vinculada ao seu fingerprint. A mesma identidade com conteúdo diferente é recusada. As etapas de inventário, modelos, histórico/anotações e estado têm chaves idempotentes próprias. A confirmação de uma etapa não representa a conclusão de toda a migração: conflitos ou falhas interrompem o processo e impedem declarar reconciliação.

A importação reutiliza a saga SQL/Storage da Etapa 6. Uploads não ativam o lote; a visibilidade muda após confirmação SQL. A aplicação do lote ocorre exclusivamente no ensaio, depois da chamada explícita ao importador. O modo padrão do aplicativo continua sendo arquivos.

### Reconciliação

São conferidos:

- Contagens e linhas completas por origem, aba, posição, série bruta/normalizada, células tipadas e estado de validação.
- Campos dos equipamentos e vínculos com a linha oficial do mesmo lote; a fonte auxiliar Endpoint não cria equipamento oficial.
- Referências aos arquivos originais e seus hashes, além de leitura/verificação dos bytes de todos os objetos confirmados.
- Payloads originais dos eventos, horários originais e ordem de importação.
- Categoria, ordem, ID, payload canônico, fingerprint e anotação por linha; inclui nota vazia, limite de 2.000 caracteres e contexto parcial.
- Unidades personalizadas, apelidos manuais e histórico de apelidos com registro original e ordem.
- Ausência de conflitos pendentes. As FKs, checks e triggers permanecem habilitadas.

Os rótulos de exibição seguem as regras existentes do histórico. O importador preserva nomes e payloads necessários à auditoria; a normalização visual não reescreve o documento original.

## Recuperação e rollback

O backup do domínio já existente contém as 20 tabelas, migrations e bytes dos objetos. Ele continua **sem identidades Auth**. A Etapa 8 acrescenta um envelope de recuperação próprio para o ensaio, com `auth.users` e `auth.identities`, suportando exatamente uma conta de e-mail/senha, sem MFA e sem outro provedor.

O envelope usa criptografia autenticada Fernet. Hash de senha, identidade e conteúdo Auth ficam dentro do arquivo criptografado; a chave permanece somente na memória do processo. Não são incluídos sessões BFF/Auth, refresh tokens de sessão, credenciais de infraestrutura ou desafios pendentes de alteração de credenciais. Os arquivos do domínio intermediários contêm apenas dados fictícios e permanecem no diretório isolado.

O snapshot bloqueia alterações do estado global e da identidade durante a captura. A recuperação exige migrations e assinatura estrutural de Auth/domínio compatíveis, domínio vazio e nenhum usuário/sessão anterior. Não sobrescreve instalação em uso. O limite do envelope e do conteúdo expandido é 256 MiB; volumes reais maiores exigem outra estratégia previamente ensaiada.

Primeiro os objetos são enviados e verificados. Depois uma transação restaura identidade e domínio na ordem das FKs, sem desabilitar restrições; as sequências de ordenação são ajustadas. Interrupção no upload permite retomar o mesmo arquivo. Um recibo vincula o destino ao hash do envelope. Se o commit ocorreu mas a confirmação se perdeu, a repetição compara domínio completo, identidade e objetos antes de reconhecer sucesso. Alterações posteriores no destino impedem a repetição.

O rollback ensaiado restaura o ponto anterior em outra instalação vazia. Não há exportador reverso completo de SQL para o formato operacional Excel/JSON. Após novas gravações no PostgreSQL, alternar para arquivos antigos perderia essas alterações; o caminho demonstrado é recuperar o ambiente PostgreSQL e escolher conscientemente o ponto de recuperação.

**Chaves do ensaio não são salvas.** Ao encerrar o processo, seus envelopes fictícios deixam de ser recuperáveis com as ferramentas entregues. Isso é deliberado para o teste; uma rotina de backup oficial precisa guardar a chave fora do repositório e do computador ativo, em destino aprovado, e comprovar sua recuperação antes do uso oficial. Este executor não é uma ferramenta autorizada de importação de dados reais.

## Reproduzir localmente

Pré-requisitos: Rancher Desktop iniciado, Docker acessível, dependências de `requirements-postgres.txt`, dependências npm instaladas e portas `55420`–`55422` livres. O CLI fixado no projeto é Supabase 2.120.0; PostgreSQL 17. As mesmas seis migrations são aplicadas desde o início em cada instalação nova.

```powershell
# Gerar fixtures e plano offline, sem iniciar o banco:
.\.venv\Scripts\python.exe -B scripts/verify_migration_pilot.py --local-disposable --dry-run

# Recalcular o plano do pacote informado pelo comando anterior:
.\.venv\Scripts\python.exe -B scripts/migrate_supabase_bundle.py --bundle "supabase/.temp/etapa8/fixtures-<identificador>" --dry-run

# Ensaio completo em três instalações novas e separadas:
.\.venv\Scripts\python.exe -B scripts/verify_migration_pilot.py --local-disposable

# Suíte isolada e testes JavaScript existentes:
.\.venv\Scripts\python.exe -B tests/run_tests.py
node --test tests/frontend/test_transfer_workflows.cjs tests/frontend/test_inventory_ui_flows.cjs tests/frontend/test_history_annotation_retries.cjs tests/frontend/test_history_annotations.cjs tests/frontend/test_form_draft_guard.cjs tests/frontend/test_catalog_search_utils.cjs tests/frontend/test_ui_motion.cjs tests/frontend/test_auth_session.cjs

# Mesmo ensaio de interface usado pelo job ui-browser:
$env:PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
npm run test:ui:e2e
```

Cada execução completa usa uma nova identidade e preserva seus próprios volumes. Confira os recibos em `supabase/.temp/etapa8/` antes de qualquer manutenção manual. Não use reset, ferramentas da Etapa 7 para banco vazio ou remoção ampla de containers/volumes na instalação com conta já cadastrada.

## Evidências e resultados

Execução aprovada `90490dc686de`, em `supabase/.temp/etapa8/fixtures-90490dc686de/results.json`, com `validated: true`. Seus três projetos foram encerrados preservando volumes. Os metadados dos containers da instalação `simpress-dev` — identidade, início, volumes e publicações — permaneceram iguais antes e depois.

Versões locais: Python **3.14.6**, Node.js **24.21.0**, Supabase CLI **2.120.0** e PostgreSQL **17**. A matriz Python 3.12/3.14 será verificada pelo CI remoto; os testes locais registrados usaram Python 3.14.6.

- Ensaio completo: **37 verificações aprovadas**, incluindo importação idempotente, falha parcial, resposta de commit perdida, recuperação, reexecução e rollback.
- Reconciliação inicial: **quatro equipamentos oficiais, quatro linhas oficiais e quatro auxiliares**, um grupo de série duplicada, 13 eventos legados, uma nota compartilhada com contexto parcial, uma unidade personalizada, um apelido manual e um evento legado de apelido. Seis objetos verificados; **zero diferenças e zero conflitos pendentes**.
- No ponto final de recuperação: 20 tabelas conferidas integralmente por digest, 14 objetos privados, quatro lotes com 12 registros de equipamento no total, oito fontes com 24 linhas, 22 eventos de comparação, 37 linhas de comparação e 17 anotações. São contagens de todas as versões preservadas, não somente do lote ativo.
- Retorno ao ponto anterior: digest completo do domínio igual ao snapshot anterior e login da mesma conta fictícia demonstrado. O snapshot inicial mantém as duplicidades; o final contém um lote ativo com duas séries distintas.
- Segurança recuperada: **22 tabelas com RLS habilitada e forçada**, bucket privado, UUID/autoria preservados, nenhuma sessão antiga restaurada e cookie BFF antigo recusado.
- Ensaio completo: **349,841 segundos**. Recuperação retomada, incluindo falha de recibo e reconhecimento do commit: **9,016 segundos**, com ambiente de destino já iniciado e arquivos pequenos. Não são metas operacionais nem incluem recriar o computador ou baixar imagens.
- Suíte Python isolada: **202 testes passaram**, incluindo **21 novos testes** de importação/recuperação offline.
- JavaScript: 72 testes passaram.
- Playwright/Chromium: 17 testes passaram em desktop, mobile e perfil de desempenho; o job `ui-browser` foi reproduzido localmente.
- Mypy: 39 arquivos passaram com os argumentos do CI e os novos scripts.
- Compilação/sintaxe Python, busca por padrões conhecidos de credenciais e `git diff --check`: aprovados. A verificação de credenciais foi repetida após incluir os arquivos novos no índice Git.

O teste HTTP da suíte ficou parado quando executado no sandbox restrito. Sua execução isolada com permissão adequada passou; a suíte completa foi então repetida nessa condição e terminou sem falhas. Há aviso de depreciação já existente de Starlette/HTTPX; não houve atualização de dependências nesta etapa.

As primeiras execuções do ensaio identificaram dois ajustes na própria fixture: o endpoint de exportação exige uma data e a lista de conferência filtra motivos não reconhecidos. A fixture passou a usar data explícita e motivo válido. Nenhuma regra de apresentação da aplicação foi alterada para acomodar o teste.

A recuperação criada nesta etapa foi reforçada para reconhecer commit confirmado mesmo quando seu recibo final não chegou a ser salvo. O teste interrompe essa confirmação, retoma o mesmo envelope e exige igualdade de todas as tabelas, identidade e objetos. Chave incorreta, destino ocupado e perda parcial de upload também foram exercitados.

O ensaio completo usa serviços locais reais; os testes de navegador usam o servidor de fixtures existente. Não foi executado um fluxo visual com dados reais, nem importada a base operacional. CI remoto não é tratado como aprovado apenas pelo sucesso local; o envio Git foi solicitado pelo usuário após os testes.

## Checklist para entrada em uso oficial local

### Preparação — responsável: Gabriel

- [ ] Autorizar em solicitação específica a importação de uma cópia da base real e definir qual instalação receberá o estado oficial. O executor desta etapa aceita apenas fixtures.
- [ ] Conferir e aprovar o inventário dos arquivos de origem, planilhas auxiliares, históricos, anotações compartilhadas/pendentes, unidades, apelidos, modelos e backups legados que serão migrados. Não omitir registros cuja relação esteja incompleta.
- [ ] Validar o adaptador desses arquivos para um pacote real, com IDs/ordem preservados e relatório de conflitos. O pacote sintético comprova o protocolo; não comprova todas as variações dos arquivos reais.
- [ ] Aprovar destino independente para cópias de desastre e chave. `Backup_Banco/` no mesmo computador é somente uma cópia local; OneDrive não foi validado como restauração independente.
- [ ] Aprovar frequência, retenção dos backups de desastre e metas. Proposta anterior: RPO de até 24 horas e RTO de até quatro horas; continuam metas pendentes de aceite e medição em volume representativo.
- [ ] Implementar e testar rotina oficial de backup criptografado, guarda de chave, agendamento, alertas e restauração fora do computador ativo. Preservar retenção operacional de 60 dias e proteções de anotações/referências.
- [ ] Identificar versão da aplicação, CLI/imagens, migrations, configuração não secreta e procedimento para recriar credenciais SQL/Storage/Auth na instalação nova.

### Janela de migração — execução técnica assistida, decisão: Gabriel

- [ ] Definir janela posterior ao expediente, responsável presente e horário limite para abortar. Fazer uma cópia imutável das fontes e do estado anterior com hashes, data, versão e manifesto.
- [ ] Suspender gravações no modo antigo e a sincronização de notas durante a captura final; garantir apenas uma fonte de gravação.
- [ ] Executar simulação e revisar todos os conflitos/duplicidades. Repetir importação na instalação separada autorizada, sem ativar o uso oficial até aprovação.
- [ ] Exigir zero divergências inexplicadas de contagem, IDs, payloads, notas, arquivos e relações. Duplicidades existentes devem permanecer registradas; bloqueios de exportação devem ser resolvidos explicitamente.
- [ ] Testar login, negação anônima, busca, ajustes manuais, comparação, todas as seções anotáveis, exportações, transferência e restauração com as cópias autorizadas.
- [ ] Gerar ponto de recuperação final e restaurá-lo em instalação vazia; conferir hashes, UUID do administrador, notas e novo login. Medir tempo total incluindo criação do ambiente e serviços.
- [ ] Gabriel aprovar o relatório final e a mudança da fonte oficial antes de liberar gravações no PostgreSQL. Não manter ambos os backends recebendo alterações.

### Observação e abortar

- [ ] Conferir após a troca: identidade da instalação, listener local, login, prontidão, lote ativo, revisão, contagens e saúde de PostgreSQL/Storage. Não interpretar somente resposta HTTP 200 como aceite.
- [ ] Registrar e revisar erros 401/403/409/503, operações pendentes/falhas, divergências de hash, conflitos, espaço livre e resultado/idade do último backup. Não registrar tokens, DSNs ou senhas.
- [ ] Suspender gravações se houver identidade incorreta, objeto ausente, perda de nota, divergência inexplicada ou falha de backup. Guardar evidências e o estado posterior antes de recuperar.
- [ ] Antes de novas gravações, manter o modo antigo com as fontes intactas é o retorno possível. Depois delas, restaurar o ponto PostgreSQL aprovado em instalação separada e reconciliar o intervalo perdido dentro do RPO aceito. Escolher ponto anterior significa aceitar a perda posterior, nunca silenciosamente.
- [ ] Só redirecionar o aplicativo após verificar restauração, hashes, identidade, RLS e login. Preservar volumes anteriores até aprovação; não executar exclusões automáticas.

## Limitações e evolução online

O ensaio usa poucos registros fictícios no mesmo computador. Não dimensiona carga, rede, concorrência de equipe, disponibilidade, tempo de download de imagens ou recuperação após perda física do equipamento. O tempo medido da restauração não demonstra o RTO de produção, e o snapshot exato não demonstra cumprimento contínuo do RPO.

Hospedagem continua futura: seleção e orçamento do provedor, homologação remota autorizada, listener, HTTPS, cookies seguros, certificados do PostgreSQL, origens, Auth, e-mail, guarda de segredos, monitoramento e backup externo precisam de implementação e testes próprios. O verificador de configuração hospedada da Etapa 7 continua apenas estático. Não houve criação de recurso faturável.

## Referências oficiais

- [Múltiplos projetos locais Supabase](https://supabase.com/docs/guides/local-development/running-multiple-local-projects): identidades e portas separadas.
- [Desenvolvimento local Supabase](https://supabase.com/docs/guides/local-development): CLI e execução local.
- [Escopo de backups Supabase](https://supabase.com/docs/guides/platform/backups): backups de banco não incluem bytes dos objetos Storage.
- [Restauração de plataforma para ambiente próprio](https://supabase.com/docs/guides/self-hosting/restore-from-platform): identidade Auth, configurações e objetos têm requisitos próprios. O procedimento restrito deste ensaio foi validado nas versões locais registradas; não presume compatibilidade com qualquer versão futura.
