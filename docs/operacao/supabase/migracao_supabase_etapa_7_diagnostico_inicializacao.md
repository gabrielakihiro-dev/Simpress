# Etapa 7 — Diagnóstico da inicialização local

**Data:** 09/10/2026.

## Falha apresentada

Os comandos de provisionamento e execução autenticada encerraram com `RuntimeError`, antes de solicitar e-mail/senha. A verificação do ambiente confirmou `Expected disposable database container missing`: o banco Supabase local estava parado. Ele havia sido encerrado ao final dos testes da Etapa 7, com volumes preservados.

## Procedimento

Com o Rancher Desktop ativo, o comando abaixo foi usado para retomar a instalação existente. Use-o novamente somente se o Supabase estiver parado:

```powershell
.\.venv\Scripts\python.exe -B scripts/supabase_local.py resume
```

Depois, executar **um comando por vez**, aguardando a conclusão do provisionamento antes de iniciar o aplicativo:

```powershell
.\.venv\Scripts\python.exe -B scripts/configure_auth_local.py --local-disposable
```

Digite e-mail e senha somente no terminal. A senha não aparece enquanto é digitada. Após a confirmação da conta:

```powershell
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py --auth
```

Acesse `http://127.0.0.1:8000`. O terminal do piloto deve permanecer aberto.

Não use `start` para substituir os volumes existentes nem `reset` para resolver essa falha. `resume` reaproveita a instalação reconhecida.

## Verificação da retomada, antes do provisionamento

Diagnóstico confirmado por leitura do ambiente. A instância `simpress-dev` foi retomada com PostgreSQL 17, identidade reconhecida e publicações somente em loopback; os volumes foram preservados. A conferência final encontrou zero usuários Auth e administrador ainda não configurado. O Supabase foi deixado ativo para permitir o provisionamento interativo pelo usuário.

Nenhuma credencial foi solicitada ao chat, nenhuma conta foi criada pelo agente e nenhum commit ou push foi realizado. `git diff --check` não encontrou erros. Não foi repetida a suíte de testes: esta intervenção retomou os serviços existentes e fez verificações de estado, sem alterar a implementação.

## Conflito da porta 8000 e inicialização concluída

Após provisionar a conta pelo terminal, o usuário recebeu `WinError 10048` ao iniciar o piloto. Outro servidor Simpress ocupava `127.0.0.1:8000`; a identidade foi conferida somente pelos metadados públicos da API, sem consultar inventário.

O usuário encerrou esse servidor e autorizou manter a porta 8000. A porta foi conferida livre e o piloto foi iniciado com:

```powershell
.\.venv\Scripts\python.exe -B scripts/run_postgres_pilot.py --auth --port 8000
```

Nesta intervenção o iniciador ficou em segundo plano, sem janela adicional. Os logs locais de inicialização ficam em `supabase/.temp/auth-pilot.stdout.log` e `supabase/.temp/auth-pilot.stderr.log`, fora do versionamento. A chave temporária de sessão permanece somente no processo; reiniciar exige novo login.

Conferências de disponibilidade, sem senha nem dados operacionais:

- Listener somente em `127.0.0.1:8000`.
- Formulário `/login`: HTTP 200.
- Estado público de sessão: autenticação habilitada e visitante ainda sem login.
- `/api/prontidao` e `/openapi.json` sem login: HTTP 401.

O aplicativo foi deixado ativo em `http://127.0.0.1:8000/login`, para o usuário entrar com a conta que acabou de cadastrar. O login com essa conta não foi executado pelo agente. Não houve alteração de implementação, criação de conta adicional, importação, commit ou push.

## Confirmação posterior do usuário

O usuário confirmou que o login funcionou e apresentou o painel autenticado. A disponibilidade de uma entre quatro funções é esperada nesta instalação: ainda não há lote de equipamentos nem modelos privados importados. A conta e os volumes locais devem ser preservados; os ensaios que exigem instalação vazia não devem ser repetidos nela.
