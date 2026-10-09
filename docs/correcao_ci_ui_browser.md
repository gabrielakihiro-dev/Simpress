# Correção do CI `ui-browser` e situação da hospedagem

## Falha analisada

- Execução que falhou: [GitHub Actions 37989267874](https://github.com/gabrielakihiro-dev/Simpress/actions/runs/37989267874), no commit `d1b96815c260621a1992caaccaf7f04a46c71606`.
- Os jobs `verify (3.12)` e `verify (3.14)` passaram. O job `ui-browser` falhou no cenário móvel de salvamento automático de anotação.
- O teste esperou que o contador de equipamentos saísse de “Carregando…”, mas a inicialização da página não havia solicitado `/api/stats` naquela navegação. O problema estava na inicialização da interface e na sincronização do teste com a API.

## Correção aplicada

- `static/app.js` agora inicializa a interface quando `DOMContentLoaded` ainda está pendente ou imediatamente quando o documento já está pronto. Isso evita perder a inicialização caso o evento já tenha ocorrido.
- `tests/e2e/ui.spec.cjs` agora aguarda as respostas de sessão e estatísticas da navegação atual antes de verificar o contador.

## Verificações locais

- Repetição do cenário móvel afetado: **8 de 8 aprovadas**.
- Suíte completa `npm run test:ui:e2e`: **17 de 17 aprovadas**, incluindo desktop, mobile e perfil de desempenho.
- `node --check static/app.js`: aprovado.
- `node --check tests/e2e/ui.spec.cjs`: aprovado.
- `git diff --check`: aprovado.
- A confirmação definitiva do CI remoto depende da nova execução após o push.

## Estado atual do Supabase remoto

O Simpress ainda não está pronto para ser executado online ligado ao Supabase hospedado. O backend aceita somente o PostgreSQL local `127.0.0.1:54322`; a autenticação do piloto exige URLs locais. `.env.supabase.production.example` contém nomes de variáveis de referência, e `scripts/check_hosted_security.py` apenas verifica configurações — nenhum dos dois habilita uma conexão remota. Nenhum dado real foi importado para um projeto remoto.

O Supabase Dashboard hospeda e administra o projeto de banco, Auth e Storage. O sistema atual também precisa da aplicação FastAPI; para ficar acessível por um site, esse serviço Python precisa ser hospedado em um ambiente que execute a aplicação. As Edge Functions do Supabase usam o runtime Deno/TypeScript, então não executam este backend FastAPI sem uma reimplementação.

## Caminho para uma implantação hospedada

1. Criar ou escolher um projeto Supabase hospedado e um ambiente de teste separado. Não conectar uma base com dados operacionais nesta fase.
2. Revisar as migrations e a configuração do projeto para o destino remoto. Autenticar e vincular a CLI ao projeto apenas depois de confirmar o `project-ref`:

   ```powershell
   supabase login
   supabase link --project-ref <project-ref-confirmado>
   supabase migration list
   supabase db push --dry-run
   ```

   O `--dry-run` mostra as migrations previstas sem aplicá-las. Após revisar o destino, a diferença e o plano de reversão, `supabase db push` aplicaria as migrations pendentes. Não execute `db reset --linked`: ele pode apagar objetos e dados do projeto remoto.
3. Hospedar a aplicação FastAPI em um serviço compatível com Python, com HTTPS e domínio próprio. Configurar o endereço externo autorizado, cookies `Secure`, encaminhamento de proxy validado e limites de conexão.
4. Implementar e testar um perfil remoto específico no Simpress. A configuração atual rejeita hosts remotos e ainda não foi ensaiada com TLS, Auth hospedado, sessões/cookies online ou o papel de banco de produção.
5. Definir privilégios e políticas RLS necessárias para a aplicação. As tabelas do piloto permanecem fora da Data API e com RLS forçado sem políticas permissivas; portanto, não se deve expor as chaves ou tentar contornar essas restrições.
6. Guardar senha do banco, chaves de Auth/Storage e chave de sessão somente no cofre de segredos do serviço de hospedagem. Chaves secretas do Supabase não podem ir para JavaScript no navegador, Git ou arquivo público.
7. Validar autenticação, permissões, Storage privado, backup e restauração com dados sintéticos em homologação. A importação de dados reais fica para uma etapa posterior com reconciliação e autorização próprias.

Para um backend persistente, o método de conexão ao PostgreSQL depende da rede do provedor (conexão direta em rede IPv6 ou pooler de sessão quando necessário). A string deve vir de **Connect** no Dashboard, e a conexão precisa validar TLS. O código atual não aceita essa string remota.

## Referências oficiais

- [Migrations e implantação no Supabase](https://supabase.com/docs/guides/deployment/database-migrations)
- [Fluxo de CLI local e remoto, incluindo `db push --dry-run`](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Métodos de conexão ao PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Segurança dos dados e chaves](https://supabase.com/docs/guides/database/secure-data)
- [Runtime das Edge Functions](https://supabase.com/docs/guides/functions)
