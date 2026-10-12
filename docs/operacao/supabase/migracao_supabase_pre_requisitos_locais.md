# Migração Supabase — execução dos pré-requisitos locais

**Data:** 09/10/2026. **Escopo:** item 4 da decisão da Etapa 2, autorizado por Gabriel junto da execução da Etapa 3.

## Destino de backup realizado

Gabriel escolheu uma pasta dentro do Simpress, sugerindo `Backup_Banco`. Foi criada `Backup_Banco/`, com instruções em `LEIA-ME.md`, e adicionada a exclusão `/Backup_Banco/` ao `.gitignore`.

Esse é o destino local aprovado. Não foi produzido dump, criado banco nem copiado dado operacional. A pasta está no mesmo computador do estado ativo; uma falha desse computador/disco pode atingir ambos. A localização sob OneDrive não comprova sincronização, retenção independente ou restauração. Essa limitação foi registrada sem substituir o destino escolhido pelo usuário.

As metas de referência da arquitetura são backup diário, RPO de até 24 horas e RTO de até 4 horas. A aprovação da arquitetura mantém essas metas como referência de planejamento; elas dependem da implementação e de ensaio, e não representam desempenho medido. Retenção de backup de desastre e cópia independente ainda precisam ser definidas antes do uso oficial; os 60 dias aprovados correspondem ao histórico e aos backups operacionais.

## Ambiente verificado inicialmente, antes da instalação pelo usuário

- Windows: build `10.0.26300.0`, arquitetura X64, obtidos por APIs do processo. Não foram coletados identificadores do equipamento.
- `node` e `npm` disponíveis no PATH.
- `supabase` e `docker` não encontrados no PATH. Executáveis não encontrados nos caminhos usuais consultados de Docker Desktop, Rancher Desktop e Podman.
- `wsl --status` informou que o Subsistema do Windows para Linux não está instalado.
- A consulta CIM para RAM/hipervisor não pôde acessar o recurso nesta sessão. Capacidade e virtualização permanecem sem validação.

## Preparação tentada e pendência real

Foi tentado `wsl.exe --install --no-distribution`, com execução fora do sandbox autorizada pela ferramenta. O comando terminou com código 1 e informou novamente que o WSL não está instalado; não confirmou instalação nem informou um reinício pendente. A verificação `winget --version` não conseguiu iniciar o executável do gerenciador de pacotes nesta sessão.

Portanto, **o ambiente local não está pronto**. Não houve rejeição da revisão automática de aprovação; a limitação foi a execução dos componentes do Windows nesta sessão. Nenhum computador foi reiniciado e nenhum instalador de runtime foi executado. O procedimento documentado pela Microsoft requer uma sessão de administrador e pode exigir reinício. Essa parte deve ser concluída pelo usuário/TI em sessão Windows apropriada, antes de aplicar migrations localmente. [Instalação WSL](https://learn.microsoft.com/en-us/windows/wsl/install) · [Opção sem distribuição](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)

## Runtime escolhido para a preparação

Proponho **Rancher Desktop com engine Moby/Docker e Kubernetes desabilitado** para este piloto Windows, após habilitar WSL e verificar virtualização. É uma alternativa compatível citada pelo Supabase e distribuída sob Apache 2.0; evita pressupor uma assinatura Docker Desktop aplicável ao ambiente corporativo. A versão estável deve ser fixada na instalação, conforme compatibilidade naquele momento. Não foi instalado nesta rodada. [Supabase local](https://supabase.com/docs/guides/local-development) · [Instalação Rancher Desktop](https://docs.rancherdesktop.io/getting-started/installation/) · [Licença](https://github.com/rancher-sandbox/rancher-desktop/blob/main/LICENSE)

Depois de resolver o WSL, a preparação deverá conferir a engine Docker em execução, fixar a versão do Supabase CLI, isolar as portas em loopback e separar volumes de desenvolvimento e homologação. A inicialização e as migrations pertencem à Etapa 4; o impedimento atual não bloqueia o desenho documental da Etapa 3.

## Etapas futuras

Provedor, região, orçamento e eventual envio de dados para nuvem continuam adiados conforme a decisão de uso local inicial. A autorização para preparar pré-requisitos não foi interpretada como solicitação de publicação online.

**Estado ao fim da tentativa inicial:** destino local preparado e protegido contra inclusão no Git; WSL/runtime/CLI pendentes; nenhuma cópia de banco ou configuração remota criada; sem commit ou push.

## Revalidação após instalação pelo usuário — 09/10/2026

Gabriel informou que concluiu a instalação e configuração. Foram realizadas consultas de leitura para verificar o novo estado:

- Rancher Desktop: `rdctl` versão `1.24.0`; engine configurada como `moby`; Kubernetes desabilitado.
- Docker: cliente `29.6.2-rd` e servidor `29.5.3` responderam à consulta de versão; `docker info` confirmou servidor Linux em execução.
- WSL: versão padrão 2; distribuição `rancher-desktop` em execução com versão 2. A distribuição de dados foi listada como parada, sem impedir a resposta do servidor Docker. O aviso sobre WSL 1 não impede este uso com WSL 2.
- Recursos informados pela engine: 12 CPUs e 8.167.866.368 bytes de memória total. Isso é uma observação da engine, não um ensaio de capacidade do Supabase completo.
- O PATH persistido do usuário contém o diretório do Docker do Rancher. A sessão existente do Codex estava com PATH anterior; as consultas funcionaram pelo caminho direto e em processo com PATH atualizado.
- A primeira consulta ao WSL dentro do sandbox retornou `Wsl/E_ACCESSDENIED`. Repetida fora do sandbox, com autorização da ferramenta, respondeu normalmente. Não se trata de falha de instalação comprovada nem de rejeição da revisão automática.
- Supabase CLI não foi encontrado no PATH atualizado nem como dependência local do projeto. `package.json` não o declara; `supabase/config.toml` ainda não existe. Isso não exclui outras instalações fora dos locais consultados.

**Estado atual:** WSL 2 e runtime Docker confirmados. Falta preparar o Supabase CLI com versão fixada e inicializar/validar o projeto local na Etapa 4. O impedimento anterior de WSL/runtime foi superado.

O próximo passo é a **Etapa 4**, após revisão do modelo da Etapa 3: preparar o CLI, criar configuração e migrations do esquema com acesso fechado, iniciar somente a instância local descartável e validar a estrutura com dados sintéticos. A documentação oficial admite Rancher Desktop como runtime compatível e recomenda fixar a versão do CLI quando instalado como dependência do projeto. [Supabase CLI e preparação local](https://supabase.com/docs/guides/local-development/cli/getting-started)

Nesta revalidação não foram instaladas dependências, iniciados contêineres adicionais, criadas migrations nem lidos dados operacionais. Não foram executados testes da aplicação. A pasta `Backup_Banco` continua sendo apenas o destino preparado; nenhum backup de banco foi produzido. Sem commit ou push.

## Implementação local na Etapa 4 — 09/10/2026

O usuário autorizou a implementação do plano da Etapa 4. O CLI **2.120.0** foi instalado como dependência de desenvolvimento fixada, com lockfile atualizado. O projeto **simpress-dev** iniciou com PostgreSQL **17.11**, Auth, Storage e API, em rede/volumes próprios e publicação conferida somente em loopback.

As três migrations foram aplicadas e o banco vazio foi reconstruído localmente sem seed. Cadastro e acesso ao domínio permanecem fechados; nenhum administrador ou bucket foi criado e não houve importação de dados reais. Os resultados detalhados e o encerramento dos serviços estão no [relatório da Etapa 4](migracao_supabase_etapa_4.md).

O impedimento de CLI/runtime está resolvido para o desenvolvimento local validado. Isso não declara o ambiente pronto para uso oficial, nem comprova backup de desastre. `Backup_Banco` continua sem dump de banco. Nenhuma configuração remota, commit ou push realizado.

## Revalidação na Etapa 6 — 09/10/2026

O piloto passou a integrar Storage privado, histórico, anotações e backups lógicos. As cinco migrations foram aplicadas e a instância primária descartável foi reconstruída somente após a conferência de ausência de dados e identidade. A validação passou em 66 verificações SQL e quatro HTTP; o ensaio específico de arquivos passou em 48 verificações com fixtures sintéticas em banco separado.

A conferência final encontrou 20 tabelas com RLS forçado, revisão zero, nenhum lote/modelo ativo, zero usuários Auth, buckets, objetos Storage, bancos temporários ou login efêmero. API e PostgreSQL permaneceram em loopback. Os serviços foram encerrados com volumes preservados.

Foi implementado um gerador de arquivo do domínio e objetos para o destino aprovado `Backup_Banco/`. Nesta execução o backup foi ensaiado somente em pasta temporária com dados sintéticos, depois removidos. Backup diário, cópia independente e recuperação integral do serviço ainda dependem das próximas etapas. Consulte os procedimentos, resultados e limites no [relatório da Etapa 6](migracao_supabase_etapa_6.md). Nenhuma configuração remota, commit ou push foi executado nesta etapa.

## Evolução de segurança na Etapa 7 — 09/10/2026

A sexta migration acrescenta duas tabelas privadas de sessão e políticas para a única conta administradora aprovada. O piloto autenticado requer as dependências de `requirements-postgres.txt`, incluindo PyJWT 2.15.1 e cryptography 50.0.2. O modo de arquivos mantém suas dependências e operação local anteriores.

Foi necessário habilitar `[auth.email].enable_signup` para permitir login por senha: no CLI, esse campo controla o provedor de e-mail. `[auth].enable_signup=false` continua bloqueando cadastro público. O helper verifica ambas as condições; o ensaio também tenta o cadastro diretamente na API. Alterar essa configuração exige encerrar e retomar o projeto local preservando seus volumes.

`scripts/configure_auth_local.py --local-disposable` prepara a conta inicial interativamente. Ele não foi usado com credenciais reais nesta execução. `scripts/run_postgres_pilot.py --auth` mantém listener em loopback, desabilita confiança em proxy e usa login SQL efêmero sem bypass de RLS. O ensaio `scripts/verify_auth_pilot.py --local-disposable` aceita somente instalação vazia; não deve ser executado após provisionar a conta permanente.

O exemplo hospedado e seu verificador são referências estáticas: não habilitam acesso remoto, não verificam TLS real e não fazem deploy. Backup de Auth, recuperação completa, cópia independente e entrada em produção continuam sujeitos à Etapa 8. Resultados e limites estão no [relatório da Etapa 7](migracao_supabase_etapa_7.md).
