# Supabase Free com FastAPI no computador local

## Recomendação

Sim, é viável manter o FastAPI no PC e usar o PostgreSQL, o Auth e o Storage do Supabase Free pela internet. A interface e o processamento de Excel continuam locais; os dados centrais ficam na nuvem. É uma boa fase de transição para uma pessoa usando um computador ligado e conectado. Se o PC desligar, a aplicação local para. Se a conexão cair, operações que dependem do Supabase devem falhar com segurança.

O plano Free consultado oferece 500 MB de banco, 1 GB de Storage, 5 GB de tráfego de saída e pode pausar projetos após sete dias de baixa atividade. Não oferece backups automáticos diários. Consulte os [limites e preços atuais](https://supabase.com/pricing) antes de ativar o uso. A cópia independente do banco, dos objetos de Storage e das chaves de recuperação precisa ser planejada e verificada.

O painel consultado em 09/10/2026 mostra o projeto [Projeto Simpress](https://supabase.com/dashboard/project/weuqeergonkcxwzflxdo) saudável, no plano Free e na região Oregon. Informa nenhuma migration aplicada e nenhum backup. O Table Editor não mostra tabelas de negócio no schema `public`; o Storage ainda oferece criar o primeiro bucket. O nome da branch é `main PRODUCTION`, portanto trate o projeto como produção, mesmo que atualmente pareça vazio. A opção Supabase Compute não está disponível para esta organização e está em alfa privada; ela não faz parte do plano recomendado.

Os relatórios das Etapas 1 a 8 cobrem um piloto local com Supabase CLI, migrations, FastAPI, Auth, Storage e ensaios com fixtures. Eles não conectam o aplicativo ao projeto remoto. Os prompts abaixo são uma continuação específica para o cenário remoto Free; não substituem nem reescrevem os relatórios anteriores.

### Limites importantes desta escolha

- Os dados trafegam do PC até a região Oregon. Antes de enviar planilhas ou históricos reais de uma organização, confira a autorização e a política aplicável ao uso desse provedor/região.
- O modo atual por arquivos continua útil para desenvolvimento e recuperação, mas não sincroniza automaticamente gravações entre arquivos locais e o banco remoto. Mantenha apenas uma fonte ativa de gravação após um cutover.
- As anotações precisam continuar sincronizadas pela pasta compartilhada configurada e também acessíveis por clones sem histórico local. A integração com PostgreSQL precisa preservar esse contrato, detectar conflitos e nunca ressuscitar uma nota antiga indevidamente.
- O aplicativo continua no PC e só fica acessível enquanto ele estiver ligado. O Supabase remoto centraliza os dados; não hospeda por si só a interface FastAPI neste plano.
- O Free não oferece o backup diário do Pro. Não use como única estratégia de recuperação os backups do próprio Supabase: os backups do banco não incluem os bytes dos objetos do Storage.

## Modelos sugeridos

Use estas correspondências se esses nomes estiverem disponíveis no seletor do Codex. `Luna Máximo` significa GPT-6 Luna com esforço de raciocínio máximo; `Terra` significa GPT-5.6 Terra; `Sol` significa GPT-6.1 Sol. O esforço de raciocínio é uma configuração separada do modelo.

| Etapa | Escolha sugerida | Uso do esforço máximo |
|---|---|---|
| 9 — Plano e auditoria remota | GPT-6 Luna, Máximo | Adequado para diagnóstico bem delimitado e comparação de opções. |
| 10 — PostgreSQL remoto e configuração | GPT-6.1 Sol, Alto | Melhor equilíbrio para alterações coordenadas no backend. |
| 11 — Auth, sessão e segurança local | GPT-6.1 Sol, Máximo | Requer revisão cuidadosa de identidade, cookies, CSRF, limites e RLS. |
| 12 — Storage, anotações e recuperação | GPT-6.1 Sol, Máximo | Trata consistência entre SQL, Storage e a pasta compartilhada. |
| 13 — Ensaios sintéticos e prontidão remota | GPT-5.6 Terra, Alto; revisão em Sol Alto | Terra atende à execução delimitada; use Sol para revisar conclusões e lacunas. |
| 14 — Mudança de schema no projeto Supabase | GPT-6.1 Sol, Máximo | Alto risco operacional: revise o plano antes de alterar o remoto. |
| 15 — Importar dados reais e ativar uso | GPT-6.1 Sol, Máximo | Mudança com dados organizacionais e reversão que exige evidências. |

O GPT-6.1 Sol é a escolha padrão para implementar as etapas críticas; o GPT-6 Luna favorece tarefas focadas, e o GPT-5.6 Terra é uma alternativa para trabalho delimitado quando a opção estiver disponível. Nenhum nome elimina a necessidade de revisar o resultado. [Orientação oficial da OpenAI para seleção de modelos](https://developers.openai.com/api/docs/guides/model-selection) · [Modelos GPT-6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol).

## Regras comuns a todos os prompts

- Execute somente a etapa solicitada e não avance automaticamente.
- Leia `AGENTS.md`, verifique `git status` e preserve mudanças existentes. Não faça commit nem push.
- Use a documentação Supabase atual para decisões sobre conexão, Auth, Storage, RLS, quotas e backup.
- Preserve o modo padrão Excel/JSON e o piloto local; a configuração remota deve ser explícita. Uma falha de conexão não pode ativar silenciosamente dados antigos nem gravar em dois backends.
- Não exponha senha do banco, service-role key, chaves Auth, cookies ou tokens no frontend, Git, logs, relatórios ou saída do terminal. Leia segredos somente do ambiente protegido do processo e masque-os nas mensagens de erro.
- Não leia em massa nem transmita planilhas operacionais, históricos, anotações ou dados pessoais sem autorização explícita para a etapa e o destino. Use fixtures sintéticas na preparação e homologação.
- Não execute `supabase db reset`, `supabase db push`, SQL Editor, limpeza de tabelas/buckets, configuração de Auth nem exclusão no projeto remoto fora do escopo da Etapa 14. A Etapa 15 trata separadamente a cópia dos dados reais e o cutover.
- Mantenha as regras de rótulos e anotações do `AGENTS.md`, sem reescrever os payloads brutos de comparação.
- Ao terminar, crie/atualize o relatório indicado na etapa com escopo, decisões, arquivos, validações e limitações, sem segredos nem conteúdo de planilhas.

## Etapa 9 — Confirmar a arquitetura PC local + Supabase Free

**Modelo sugerido:** GPT-6 Luna, Máximo.

```text
Execute somente a Etapa 9: confirme a viabilidade e o plano de implantação para manter o FastAPI e a interface no computador local e usar o projeto Supabase Free weuqeergonkcxwzflxdo pela internet.

Leia AGENTS.md, README.md e os relatórios existentes das Etapas 1 a 8. Inspecione somente o código necessário. Não altere código, dados operacionais ou o projeto remoto.

Considere o estado observado do painel em 09/10/2026: projeto saudável, região Oregon, branch main PRODUCTION, sem migrations de negócio ou backups informados e primeiro bucket de Storage ainda não criado. Refaça a verificação no painel se estiver acessível; se a informação tiver mudado, use o estado atual e registre a diferença. Não mostre segredos.

Compare esta arquitetura com o piloto Supabase local já implementado. Descreva fluxo da aplicação, dependência de internet, pausa do plano Free, limites de banco/Storage/tráfego, região, política de backup, acesso local, sincronização da pasta de anotações e possíveis falhas. Não trate o Supabase como hospedagem do FastAPI. Apresente riscos, pré-requisitos, estimativa por etapa e critérios objetivos para decidir continuar ou voltar ao modo de arquivos.

Crie docs/operacao/supabase/migracao_supabase_free_etapa_9.md. Não altere recursos remotos, não importe dados e não faça commit ou push.
```

## Etapa 10 — Adaptar configuração e conexão PostgreSQL hospedada

**Modelo sugerido:** GPT-6.1 Sol, Alto.

```text
Execute somente a Etapa 10: prepare o código do Simpress para que o FastAPI continue executando no PC local e possa se conectar ao PostgreSQL hospedado no projeto Supabase Free, sem ainda conectar nem alterar o projeto remoto.

Leia AGENTS.md e os relatórios das Etapas 1 a 9. Confira o git status. Inspecione persistence/config.py, persistence/postgres.py, scripts de inicialização, migrations e testes de configuração. O backend atual limita o Postgres ao piloto em loopback; não remova essa proteção por uma substituição ampla.

Implemente uma configuração explícita e separada para arquivos, piloto Supabase local e modo hospedado. Preserve files como padrão. Para o modo hospedado, valide scheme/host/porta, TLS com validação de certificado, limites do pool, credenciais e secrets. Não sobrescreva o host remoto com 127.0.0.1 nem fixe as portas locais do piloto. Considere conexão direta versus pooler de sessão conforme suporte IPv4/IPv6 do computador e use a cadeia de conexão fornecida pelo painel, sem registrá-la. Não use pooler de transação sem validar as exigências de sessão do psycopg atual.

Inclua exemplo de ambiente apenas com placeholders, nunca carregado automaticamente se isso mudar a operação existente. Configure variáveis em runtime no servidor. A interface continuará acessível apenas por 127.0.0.1 no PC e o tráfego do backend para o Supabase usará TLS. Uma indisponibilidade remota deve falhar com mensagem segura; nunca faça fallback de leitura/gravação para um estado local desatualizado. Não altere planilhas nem migre dados.

Execute validações focadas que não leiam arquivos operacionais. Crie docs/migracao_supabase_free_etapa_10.md. Não conecte ao Supabase remoto, não aplique migrations e não faça commit ou push.
```

## Etapa 11 — Auth, sessões e segurança da aplicação local

**Modelo sugerido:** GPT-6.1 Sol, Máximo.

```text
Execute somente a Etapa 11: adapte Auth e autorização para o cenário em que o FastAPI local atende em loopback e valida a conta administradora pelo Supabase Auth remoto. Não altere o painel remoto nem cadastre usuários.

Leia AGENTS.md e os relatórios das Etapas 1 a 10. Revise security/auth.py, security/config.py, security/middleware.py, security/routes.py, security/context.py, as migrations de Auth e as rotas protegidas. Verifique a documentação oficial atual sobre chaves, assinatura/JWKS e configuração do Auth.

Preserve a política de conta administradora única e sem cadastro público já estabelecida no projeto. Implemente validação de token com issuer e assinatura corretos para o projeto, sessões do backend em cookies HttpOnly, limitação de tentativas, logout/revogação e proteção CSRF adequada ao fluxo local. Separe a origem local da aplicação da URL HTTPS do Auth. Não relaxe host/origin, não aceite JWT apenas decodificando claims, não coloque token ou credencial administrativa no JavaScript e não confie em service_role para provar autorização de usuário.

Revise as conexões PostgreSQL por requisição e RLS: o principal deve ser estabelecido em transação e limpo antes de devolver a conexão ao pool. Garanta que serviço não autenticado, rota, download ou exportação não escape do middleware. Preserve segurança padrão e modo files. Use somente usuários fictícios nos ensaios locais.

Crie docs/migracao_supabase_free_etapa_11.md com matriz rota/permissão e resultados de verificações positivas/negativas. Não abra o painel remoto, não crie usuários e não faça commit ou push.
```

## Etapa 12 — Storage remoto, anotações compartilhadas e recuperação

**Modelo sugerido:** GPT-6.1 Sol, Máximo.

```text
Execute somente a Etapa 12: prepare o backend local para usar Storage privado do projeto Supabase Free e compatibilize o estado centralizado com a pasta compartilhada já configurada para anotações. Use fixtures locais. Não carregue arquivos ao projeto remoto.

Leia AGENTS.md, os relatórios das Etapas 1 a 11, persistence/storage.py, persistence/files.py, persistence/backup.py, persistence/recovery.py, persistence/comparison_history.py e domains/history_annotations.py.

Implemente a configuração de Storage hospedado separada do cliente Storage do Supabase local. Exija HTTPS, bucket privado, autorização no backend, caminhos produzidos pelo servidor e confirmação de SHA-256 e tamanho em leitura/gravação. Mantenha operações idempotentes e recuperáveis entre Storage e transações SQL; não exponha URLs públicas nem chaves administrativas no navegador.

Mantenha registros brutos e IDs de auditoria. Implemente leitura, gravação, fila pendente, reprocessamento e reconciliação das anotações entre PostgreSQL e a pasta compartilhada, incluindo clones sem histórico local e instalações offline. Respeite as seis seções, ID independente por linha/evento, auto-save de até 2.000 caracteres, inclusão nas exportações e reaplicação somente quando o payload completo da mesma seção for idêntico, excluindo apenas anotacao e anotacao_id. Notas vazias recentes e conflitos de duplicadas não podem reviver uma nota antiga. Normalize rótulos apenas na apresentação.

Revise limites Free de tamanho de upload e cota de Storage contra os limites atuais do aplicativo. Documente um backup próprio que contenha SQL, bytes de Storage e material necessário à recuperação, com a chave guardada separadamente. Não afirme que backup SQL inclui Storage ou Auth. Crie docs/migracao_supabase_free_etapa_12.md. Não faça upload remoto ou commit/push.
```

## Etapa 13 — Ensaio local e pré-verificação do remoto

**Modelo sugerido:** GPT-5.6 Terra, Alto; revisão final com GPT-6.1 Sol, Alto.

```text
Execute somente a Etapa 13: valide em ambiente local descartável a conexão, o comportamento e a recuperação do backend no modo hospedado, usando somente fixtures sintéticas.

Leia AGENTS.md e os relatórios das Etapas 9 a 12. Confira o estado do repositório e preserve Supabase local e volumes existentes. Não use reset amplo nem modifique o projeto remoto.

Rode testes e ensaios isolados existentes para config, autenticação, acesso negado, queries PostgreSQL, commits, idempotência, arquivos, anotações, exportação e recuperação. Simule offline, timeout, pool exaurido, sessão inválida e resposta incerta após commit. Confira que app local permanece no loopback, secrets não aparecem nos logs e o backend files continua sendo o padrão.

Faça somente uma pré-verificação remota de leitura: identidade/ref do projeto, região, estado, existência de schemas/tabelas/buckets/migrations e conectividade. Use credenciais do ambiente protegido; não as imprima. Se o projeto tiver qualquer estado diferente do esperado ou a identity não corresponder ao projeto autorizado, pare e documente. Não rode db push, SQL Editor, upload, criação de bucket/usuário ou alteração de Auth.

Crie docs/migracao_supabase_free_etapa_13.md com comandos reproduzíveis, resultados, limite de cota observado e falhas. Não faça commit ou push.
```

## Etapa 14 — Homologar migrations e fixtures sintéticas no Supabase Free

**Modelo sugerido:** GPT-6.1 Sol, Máximo.

```text
Execute somente a Etapa 14: prepare o plano de implantação do schema Simpress no projeto Supabase Free weuqeergonkcxwzflxdo e, se a autorização explícita deste pedido cobrir a escrita remota, execute apenas o escopo de homologação descrito abaixo.

Leia AGENTS.md e todos os relatórios das Etapas 9 a 13. Reconfirme o projeto e o estado remoto por leitura antes de qualquer ação. O painel identificou a branch main PRODUCTION; trate-a como produção. Revise todas as migrations e adapte-as ao Supabase Cloud, sem supor que o sucesso no Supabase CLI local prova compatibilidade remota. Confira roles gerenciadas, schema privado, grants, RLS, Auth, Storage e as permissões reais do plano.

Primeiro produza um plano explícito com migrations, statements, schemas, roles, bucket, permissões, objetos e efeitos. Preserve outras aplicações/recursos. Não use db reset nem DROP, TRUNCATE, REPLACE de bucket ou exclusão. Se houver recursos existentes, incompatibilidade com o plano ou efeito fora do escopo, pare sem alteração remota e reporte.

Somente execute as migrations remotas se o usuário pedir diretamente esta etapa e o alvo estiver confirmado como weuqeergonkcxwzflxdo. Limite-se às migrations auditadas, a um bucket dedicado privado e a dados artificiais claramente identificados. Não envie planilhas, JSON, backups nem anotações reais. Depois confirme esquema, acesso negado anonimamente, RLS e upload/download/hash de um artefato sintético pequeno; remova apenas os próprios registros/objeto de fixture se a limpeza for reversível e estiver no plano aprovado.

Se houver qualquer dúvida sobre alvo ou impacto, não escreva: entregue o plano revisável. Crie docs/migracao_supabase_free_etapa_14.md com evidência e custos/limites. Não faça commit ou push e não ative uso operacional.
```

## Etapa 15 — Importar os dados reais e ativar o uso local

**Modelo sugerido:** GPT-6.1 Sol, Máximo, com revisão humana do relatório de reconciliação.

```text
Execute somente a Etapa 15: migrar a cópia dos dados operacionais necessários ao Simpress local para o projeto Supabase Free weuqeergonkcxwzflxdo e ativar o FastAPI local usando o Supabase como fonte central.

Antes de transmitir qualquer conteúdo, confirme que o usuário autorizou diretamente nesta conversa o envio dos arquivos operacionais do Simpress, do histórico e das anotações para este projeto. Se autorização explícita, destino, ou aceitação da região Oregon estiverem ausentes, não leia nem envie esses arquivos; prepare somente dry-run e inventário local anonimizado.

Leia AGENTS.md e os relatórios anteriores. Faça cópia imutável e manifesto de hashes. Inventarie planilhas Simpress/Endpoint, modelos, dados JSON de unidades/apelidos, histórico inteiro, anotações locais/pendentes e backups relevantes. Construa pacote que preserve valores brutos, ordem, IDs, proveniência e arquivos; aplique os rótulos de exibição sem reescrever os dados de origem. Reproduza regra de anotação para ocorrências novas com igualdade canônica e conflitos.

Rode dry-run e mostre contagem por origem/entidade, tamanhos, hashes, duplicidades, anotações sem contexto e conflitos. Não grave nem troque o backend até a reconciliação explicar todas as diferenças e backup criptografado de banco e objetos ter restauração comprovada. Preserve chave em local independente.

Após autorização direta para esta etapa, importe com operações idempotentes e reconcilie integralmente SQL, Storage, anotações e estado visível no aplicativo. Mantenha apenas um backend gravável. Faça uma verificação funcional local completa. Se houver divergência, falta de quota ou rollback sem prova, pare com as fontes antigas preservadas e não declare cutover.

Crie docs/migracao_supabase_free_etapa_15.md sem conteúdo de células, notas, credenciais ou PII. Registre migração, hashes, reconciliação, restauração, estado operacional e limitações. Não faça commit nem push.
```

## Ordem sugerida

Execute as etapas 9 a 13 no desenvolvimento local, uma de cada vez. Revise e aprove o relatório da Etapa 13 antes de preparar a Etapa 14. O remoto observado chama-se produção; a Etapa 14 precisa de autorização específica antes de aplicar qualquer migration, e a Etapa 15 exige autorização específica para enviar dados reais e ativar gravações centralizadas.

## Referências oficiais

- [Planos e cotas Supabase](https://supabase.com/pricing)
- [Pausa de projetos Free](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Conectar ao PostgreSQL Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Backups do banco e exclusões de Storage](https://supabase.com/docs/guides/platform/backups)
- [Modelos GPT e seleção — OpenAI Docs](https://developers.openai.com/api/docs/guides/model-selection)
- [Família GPT-6 — OpenAI Docs](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol)
