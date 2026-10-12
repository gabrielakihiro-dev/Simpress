# Migração Supabase — Etapa 7

> Este relatório registra a implementação e os ensaios anteriores ao provisionamento pelo usuário. A publicação posterior das Etapas 6 e 7 está registrada em [publicação da migração](publicacao_migracao_supabase_etapas_6_e_7.md), e a retomada com login confirmado em [diagnóstico da inicialização](migracao_supabase_etapa_7_diagnostico_inicializacao.md).

**Data:** 09/10/2026. **Escopo aprovado:** uma conta administradora, Supabase Auth local, autorização no FastAPI e no PostgreSQL, Storage privado e preparação segura da hospedagem. Sem dados operacionais, projeto remoto, commit ou push.

## Modelo mínimo de sessão, definido antes da implementação

O navegador receberá somente um identificador opaco em cookie HttpOnly e um token CSRF. Access/refresh tokens do Supabase ficarão cifrados no servidor, com chave fornecida ao processo. O schema privado `simpress_auth`, fora da Data API, terá sessões do aplicativo e contadores de tentativa de login; não conterá senhas nem outro cadastro de usuários. A identidade continuará em `auth.users`.

Uma sessão registrará hash do identificador, usuário, sessão Auth, tokens cifrados, CSRF, expiração absoluta de oito horas, limite de inatividade de 30 minutos e revogação. O banco coordenará renovação concorrente entre instâncias. O contexto SQL será definido por transação a partir da identidade validada pelo servidor. As políticas verificarão conta administradora habilitada, sessão do aplicativo vigente e sessão Auth existente.

O papel normal de aplicação será `simpress_runtime`, sem login, propriedade ou bypass de RLS; um login temporário específico do iniciador poderá assumir esse papel e o papel separado de sessão. O papel legado do piloto somente funcionará enquanto nenhum administrador estiver provisionado. Clientes `anon`/`authenticated` e `service_role` não receberão acesso ao schema de domínio.

O provisionamento permanente será interativo, com senha digitada no computador, pelo fluxo administrativo suportado do Auth. Nesta execução serão criadas apenas contas sintéticas, removidas após os testes. A configuração hospedada será validada sem conexão remota; a aplicação permanecerá em loopback.

## Implementação

- `security/config.py`: configuração fechada do piloto e pré-verificador estático de hospedagem; segredos omitidos do `repr`.
- `security/auth.py`: login/renovação pelo Auth, verificação de JWT pelo servidor Auth, validação adicional de emissor, audiência, identidade, algoritmo e validade; sessões cifradas com Fernet; limites de tentativa compartilhados no banco.
- `security/context.py`, `middleware.py` e `routes.py`: identidade por requisição, proteção global das rotas, origem exata, CSRF, login/logout e cabeçalhos de segurança.
- Sexta migration `20261009000600_authenticated_runtime.sql`: tabelas de sessão/tentativas, RLS, funções de autorização com `search_path` fixo, grants mínimos e políticas restritivas do Storage.
- `persistence/config.py`, `postgres.py` e `boundary.py`: login SQL próprio para Auth, contexto definido somente dentro da transação, remoção automática do contexto no pooling e rotas de sessão no limite do piloto.
- `static/pages/login.html`, `login.css`, `login.js` e `auth-session.js`: acesso em português, tratamento de falhas, envio automático de CSRF nas mutações e opção **Sair** no menu **Ações**. Sem JWT, senha ou refresh token em local/sessionStorage. Uma operação não é reenviada automaticamente após erro de sessão.
- `scripts/configure_auth_local.py`, `run_postgres_pilot.py`, `backup_postgres_pilot.py`, `check_hosted_security.py` e `verify_auth_pilot.py`: provisionamento controlado, execução local, backup autorizado, pré-verificação e ensaio sintético.
- README, pré-requisitos, exemplo local, exemplo hospedado e CI atualizados. As alterações anteriores da Etapa 6 foram preservadas.

## Matriz de acesso por perfil e operação

- **Visitante sem sessão:** pode abrir o formulário, assets públicos da interface e obter o desafio de login. Login exige Origin exata e desafio CSRF assinado. Inventário, buscas, catálogo, histórico, notas, arquivos, exportações, restauração, diário de operações, retenção, documentação da API e demais rotas são bloqueados antes de acessar o domínio.
- **Usuário Auth não aprovado:** ter senha válida ou JWT `authenticated` não libera acesso. O identificador precisa corresponder a `configuracao.admin_user_id` com `admin_habilitado=true`. Não há perfil de equipe, leitura compartilhada ou multitenancy.
- **Administrador habilitado com sessão válida:** pode consultar e editar inventário/catálogo/apelidos, atualizar planilhas, administrar modelos privados, consultar histórico, anotar linhas, exportar, baixar arquivos, solicitar restauração e executar as operações administrativas já habilitadas no piloto. Mutações também exigem CSRF e Origin válidas; limites, revisões, idempotência e vínculos de evento/linha continuam aplicados.
- **Administrador desabilitado, usuário banido, sessão revogada/expirada ou Auth indisponível:** acesso fechado. Não há fallback para Excel/JSON. Uma transação já iniciada conserva as garantias e o snapshot PostgreSQL; revogação não cancela retroativamente uma operação em andamento.
- **Papéis de cliente `anon`/`authenticated`:** sem schema/grants no domínio, sem acesso ao estado de sessão, sem acesso direto aos objetos do bucket, mesmo usando JWT do administrador.
- **`simpress_runtime`:** NOLOGIN, NOINHERIT, sem propriedade ou bypass de RLS. Recebe somente DML necessário aos fluxos implementados; configuração administrativa é apenas consultável. Sem contexto de sessão verificado não vê registros nem pode gravar.
- **`simpress_session_gateway`:** NOLOGIN e sem acesso ao domínio; opera exclusivamente sessões cifradas/contadores e a função de validação de identidade. É um papel confiável do servidor, nunca um papel de cliente.
- **`simpress_piloto`:** a exceção das etapas anteriores só funciona enquanto não há administrador provisionado e ele permanece desabilitado. Depois do provisionamento, nem definir o indicador do piloto manualmente contorna as políticas.
- **Provisionamento/migrations/recuperação:** realizados pelo operador local com credencial administrativa separada; nenhum endpoint público permite trocar o administrador ou escrever livremente a configuração.

## Políticas e proteção das rotas

As 20 tabelas do domínio têm RLS habilitado e forçado. `administrator_session` exige simultaneamente administrador habilitado, sessão do aplicativo vigente e não revogada, identidade correspondente, sessão Auth existente/vigente e usuário ativo/não banido. `piloto_local` exige instalação ainda não provisionada. Não existe política pública permissiva de domínio.

As duas tabelas privadas de `simpress_auth` também têm RLS forçado. Suas políticas são exclusivas do gateway do servidor. `simpress` e `simpress_auth` ficam fora dos schemas publicados pela Data API. Funções de autorização usam `SECURITY DEFINER` com nomes qualificados e `search_path=pg_catalog`; execução pública foi revogada.

`simpress_runtime_login` é efêmero, NOINHERIT, sem criação de papéis/bancos, superuser ou bypass; pode assumir apenas runtime e gateway. O backend verifica essas propriedades, propriedade de objetos, RLS, versão PostgreSQL e marcador descartável. A identidade é definida com `SET LOCAL` a partir da sessão verificada; headers e parâmetros de usuário não são fontes de identidade. Quem possui credenciais SQL do servidor é parte dessa fronteira confiável e não deve recebê-las no navegador.

O middleware protege todas as rotas por padrão. As exceções são `GET/HEAD /login`, `/static/*` e `GET /api/auth/session`, além de `POST /api/auth/login` com sua própria validação. O domínio de arquivos não é montado como diretório estático. `/docs`, `/openapi.json`, downloads e exportações ficam atrás da mesma autenticação. Rotas não implementadas continuam devolvendo o limite do piloto, depois da autorização.

Endpoints de sessão:

- `GET /api/auth/session`: estado seguro e CSRF; nunca retorna tokens do Supabase. Também informa quando Auth não está habilitado no modo de arquivos.
- `POST /api/auth/login`: e-mail/senha em JSON, desafio de pré-login, origem exata e limite de tentativas. Erros não ecoam a senha nem a resposta bruta do provedor.
- `POST /api/auth/logout`: revoga a sessão atual no banco e pede encerramento local ao Auth.
- `POST /api/auth/logout-all`: revoga as sessões do aplicativo do usuário e pede encerramento global ao Auth.

As políticas restritivas `simpress_backend_objects` e `simpress_backend_bucket` recusam o bucket `simpress-pilot` para `anon`/`authenticated`. Elas continuam restringindo acesso mesmo se outra aplicação adicionar uma política permissiva genérica. O backend usa a credencial de serviço exclusivamente para a API de Storage, após a autorização da requisição. O domínio SQL normal não usa service role. Não são geradas URLs públicas ou assinadas para o navegador.

## Sessões, origens, caches e logs

- Cookie opaco de 32 bytes aleatórios, hash SHA-256 no banco, `HttpOnly`, `SameSite=Strict`, `Path=/`, validade máxima de oito horas e inatividade de 30 minutos. `Secure=false` é aceito exclusivamente no HTTP de loopback aprovado. Hospedagem exige HTTPS e Secure; o runtime remoto ainda não está habilitado.
- Access/refresh tokens ficam cifrados e vinculados ao hash da sessão e usuário. A chave nunca é devolvida ao cliente. A renovação bloqueia somente a linha da sessão, coordenando processos distintos.
- Cada requisição protegida valida o access token com `GET /auth/v1/user`, além dos claims; as políticas consultam a sessão Auth para não confiar somente no prazo de um JWT após logout. [Verificação oficial de usuário](https://supabase.com/docs/reference/python/auth-getuser), [sessões Auth](https://supabase.com/docs/guides/auth/sessions).
- Pré-login assinado expira em 15 minutos. Origin e Host são exatos, valores duplicados são recusados, todas as mutações exigem CSRF. Sem CORS externo, wildcard ou confiança em `X-Forwarded-*` nos iniciadores.
- Limite compartilhado de cinco tentativas por combinação e-mail/IP e 20 por IP a cada cinco minutos, com chaves HMAC em vez de e-mail/IP em texto no contador. Contadores de recusas são confirmados.
- Respostas usam `Cache-Control: no-store`, `nosniff`, bloqueio de frames, política de referência e CSP. Caches e estado de identidade não são compartilhados globalmente entre requisições; snapshots de domínio são obtidos do banco.
- Exceções SQL/HTTP não devolvem headers, JWT, senha, DSN ou resposta privilegiada. Testes de navegador não geram trace com credenciais. Não foi habilitada telemetria nem criado log de conteúdo de login.

## Uso local após revisar esta entrega

O Supabase foi encerrado ao final, com volumes preservados. Para retomar e aplicar migrations somente na instalação descartável reconhecida:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-postgres.txt
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
.\.venv\Scripts\python.exe -B scripts/supabase_local.py migrate
```

O CLI usa `[auth.email].enable_signup=true` para habilitar o provedor de senha. O cadastro público permanece bloqueado por `[auth].enable_signup=false`; configurar ambos como `false` impede o login. Isso foi confirmado no [código/documentação oficial do Supabase](https://github.com/supabase/supabase/issues/40582). O helper valida as duas condições e o teste tenta um signup real com fixture, esperando `signup_disabled`. Se atualizar uma instalação com a configuração antiga, encerre e retome seus containers para aplicar o ajuste; não remova volumes.

Para criar a conta inicial, digite as credenciais exclusivamente no terminal local. A senha não é argumento de comando e não vai para o chat, Git ou arquivo de configuração:

```powershell
.\.venv\Scripts\python.exe -B scripts/configure_auth_local.py --local-disposable
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py --auth
```

O provisionador recusa contas ou administrador existentes e utiliza a API administrativa suportada do Auth, sem inserir senhas em tabelas internas. Nenhuma conta real foi provisionada nesta execução. O iniciador abre `http://127.0.0.1:8000`, inclui Storage e remove o login SQL temporário ao encerrar normalmente. `--port` aceita 8000–8099 e atualiza a origem/Host correspondente. Encerramento abrupto pode deixar o login efêmero; o próximo início recusa adotá-lo e exige inspeção local.

Sem `SIMPRESS_SESSION_KEY` no processo, o iniciador gera uma chave temporária: reiniciar exige novo login. Instâncias simultâneas precisam da mesma chave protegida e da mesma origem pública fixa; o ensaio validou coordenação pelo banco. Não salve essa chave no repositório. O modelo hospedado requer chave persistente fornecida por armazenamento seguro de segredos.

Para backup de domínio/objetos com administrador, encerre o iniciador que usa o login fixo e execute:

```powershell
.\.venv\Scripts\python.exe -B scripts/backup_postgres_pilot.py --local-disposable --auth
```

O fluxo exige login interativo, sessão verificada e RLS. O manifesto marca `auth_included=false`, `sessions_included=false` e `auth_reprovision_required=true` quando há administrador. O arquivo contém as 20 tabelas, objetos verificados e migrations; **não é backup integral de Auth**. Identidades referenciadas precisam de recuperação/reconciliação própria na Etapa 8. Sessões, tokens e chaves de sessão não entram no arquivo. Nesta etapa o backup foi gerado apenas em pasta temporária com fixtures, depois removida; os arquivos operacionais em `Backup_Banco` foram preservados.

## Preparação de hospedagem e riscos residuais

`.env.supabase.production.example` e `scripts/check_hosted_security.py` registram pré-requisitos: backend PostgreSQL, origem e provedor HTTPS exatos, cookie Secure, chave de sessão válida, login normal de aplicação, TLS PostgreSQL com `sslmode=verify-full`, sem CORS externo ou confiança automática em proxy. O verificador lê o ambiente, suprime valores e **não faz conexão, deploy ou habilitação remota**. Passar na verificação estática não comprova credenciais, DNS, certificado, grants, RLS remoto ou infraestrutura.

Antes de hospedagem/uso oficial, a Etapa 8 deve ensaiar migração/reconciliação e recuperação integral, incluindo identidades Auth e referências de autor, sem restaurar sessões antigas. Também deve preparar conta definitiva, segredo persistente/rotação, HTTPS real, cadeia de confiança do PostgreSQL, rede/proxy e procedimentos operacionais.

Limites adicionais:

- Excel/JSON continua padrão sem autenticação de usuário; use exclusivamente no computador. Não houve migração automática, alteração de dados reais, sincronização OneDrive ou liberação de acesso pela rede.
- A chave de serviço do Storage e o login/gateway SQL são credenciais confiáveis do servidor; comprometê-las ultrapassa essa fronteira. RLS não protege um backend administrativo comprometido.
- CSP ainda permite scripts/estilos inline compatíveis com handlers existentes; não representa eliminação completa de risco de XSS. Extensões maliciosas, malware e outros serviços do mesmo computador também não são isolados pelo cookie HTTP local.
- Sessões exigem Auth e PostgreSQL disponíveis. Uma falha de verificação impede o acesso, inclusive a entrada normal no logout; o operador pode desativar a conta por procedimento administrativo local. Quando uma requisição de logout já autorizada é aceita, a revogação do aplicativo fica confirmada mesmo que o pedido posterior ao Auth falhe; revogação do JWT no provedor pode aguardar disponibilidade/expiração.
- O ensaio cria e remove contas apenas em instalação vazia marcada descartável. Após provisionamento permanente, ele recusa execução. Contadores/sessões da aplicação ainda precisam de política operacional de limpeza; isso não altera a retenção de 60 dias dos registros de domínio.
- Esta entrega não inclui MFA, recuperação por e-mail, perfis de equipe, multitenancy, agendamento de backups ou cutover.

## Validação executada

Ambiente: Windows/PowerShell, Python **3.14.6**, Supabase CLI **2.120.0**, PostgreSQL **17.11**, imagem Auth **gotrue:v2.197.0**. Dependências opcionais fixadas: psycopg **3.3.6**, psycopg-pool **3.3.3**, HTTPX **0.28.1**, PyJWT **2.15.1**, cryptography **50.0.2**, cffi **2.1.1** e pycparser **3.11**. `pip check` não encontrou incompatibilidades.

Resultados aprovados:

- **181 testes Python** da suíte isolada, incluindo oito testes focados de Auth e o teste adicional de configuração do provedor. Os oito testes de Auth também foram repetidos após o ajuste final de configuração.
- **72 testes JavaScript**, incluindo cinco de sessão/CSRF, preservação do modo de arquivos, ausência de token em requests externos e não repetição de mutações ao expirar a sessão. Os cinco testes novos foram repetidos após o ajuste do botão de saída.
- **73 verificações do ensaio Auth local**, repetidas após reconstruir o banco e endurecer a checagem dos papéis SQL. Cobrem login válido/inválido, usuário não aprovado, signup bloqueado, cabeçalhos falsos, Host/Origin/CSRF, uploads, anotação, exportações, download, restauração, backup, RLS sem identidade, flag legada, Storage privado/restritivo, tokens cifrados, duas instâncias, renovação concorrente, desativação, indisponibilidade de Auth, logout local/global/no provedor, expiração e limite compartilhado de tentativas.
- O ensaio inclui **Chromium real**: redirecionamento ao login, entrada com fixture, dashboard, consulta autorizada, cookie HttpOnly/SameSite, recarregamento da página, saída pelo menu e bloqueio posterior. O Chromium do Playwright existente no projeto foi instalado para essa execução; não houve navegação em projeto remoto.
- **32 verificações PostgreSQL/HTTP da Etapa 5** em banco temporário próprio; **48 da Etapa 6** em outro banco temporário, incluindo preservação XLSX, falhas de upload/COMMIT/exclusão, recuperação, notas, restauração e backup. Os bancos e objetos temporários foram removidos.
- **Seis migrations reconstruídas do zero** somente no `simpress-dev`, após a guarda de ausência de dados/contas/Storage. Validação posterior: **63 verificações SQL e quatro HTTP**. O total SQL mudou em relação à Etapa 4 porque runtime agora tem grants condicionados por sessão; três afirmações antigas de ausência total de grants foram retiradas, mantendo os testes de RLS sem sessão.
- **33 arquivos** na análise estática completa, sem erros. Checagem focada final de `main`, `persistence` e `security`: 18 arquivos sem erros. Compilação Python, sintaxe JavaScript, dependências e `git diff --check` aprovados.
- Verificação de padrões de credenciais nos arquivos rastreados e também nos alterados/novos: **zero achados**. Isso complementa a revisão dos fluxos; não é uma prova absoluta de ausência de qualquer tipo de segredo.

Os testes não acessaram planilhas operacionais. Não foram usados usuários ou credenciais reais, OneDrive como destino de mutações, projeto remoto, commit ou push. Os avisos de depreciação do TestClient/HTTPX e normalização LF/CRLF não impediram os testes. GitHub Actions e Python 3.12 não foram executados nesta máquina; a validação relatada é local em Python 3.14.6.

Durante o trabalho, o HEAD local avançou de `0fa7954` para `a238809` (`Fix Windows bootstrap project path quoting`) por uma ação externa a esta execução. Essa alteração foi preservada. Não executei commit/push nem preparei arquivos no índice; as mudanças das Etapas 6 e 7 continuam locais.

Conferência de encerramento: 20 tabelas de domínio e duas de sessão, todas com RLS habilitado e forçado; seis migrations, revisão zero e retenção de 60 dias. Nenhum administrador provisionado; zero usuários Auth, sessões/tentativas do aplicativo, buckets/objetos, logins efêmeros e bancos de validação. As portas publicadas foram conferidas em loopback e os serviços foram encerrados com seus volumes preservados.

Para repetir o ensaio, **antes de provisionar qualquer conta**:

```powershell
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
.\.venv\Scripts\python.exe -B scripts/verify_auth_pilot.py --local-disposable --browser
.\.venv\Scripts\python.exe -B scripts/supabase_local.py stop
```

Não execute `reset` nem apague contas, sessões, bucket ou volumes para contornar a guarda de uma instalação já utilizada. O ensaio recusa esses recursos para preservar dados existentes. A limpeza usa somente os recursos sintéticos criados depois da conferência inicial de banco vazio.

Referências adicionais: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [controle de acesso no Storage](https://supabase.com/docs/guides/storage/security/access-control), [segurança de schemas](https://supabase.com/docs/guides/database/secure-data), [PyJWT](https://pyjwt.readthedocs.io/en/stable/api.html), [Fernet](https://cryptography.io/en/latest/fernet/).
