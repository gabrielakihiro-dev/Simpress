# Migração Supabase — Etapa 3: modelo de dados e mapeamento

**Data:** 09/10/2026, America/Sao_Paulo.

**Status:** proposta de esquema concluída para revisão e implementação na Etapa 4. Nenhuma migration SQL, banco, política RLS ou integração foi criada nesta etapa.

**Atualização posterior:** o usuário solicitou expressamente a implementação desse modelo na Etapa 4. O esquema físico e seus ajustes estão no [relatório da Etapa 4](migracao_supabase_etapa_4.md); as descrições de ambiente pendente abaixo correspondem ao momento da entrega original da Etapa 3.

**Referências:** [Etapa 1](migracao_supabase_etapa_1.md), [Etapa 2 aprovada](migracao_supabase_etapa_2.md), [pré-requisitos locais](migracao_supabase_pre_requisitos_locais.md), [escopo das etapas](prompts_migracao_supabase_etapas_2_a_8.md) e [AGENTS.md](../../../AGENTS.md).

## 1. Decisões incorporadas

- Uma conta administradora individual inicial; sem cadastro público, equipe ou multitenancy nesta migração.
- FastAPI e Supabase locais no piloto; publicação online adiada.
- PostgreSQL será o estado operacional após a troca validada. Storage privado conservará arquivos originais, modelos e artefatos de recuperação.
- Retenção operacional de 60 dias, com exceções para registros fixados, datas inválidas, anotações e referências necessárias à recuperação.
- `Backup_Banco/` é o destino local aprovado, criado e excluído do Git. Ainda não contém backup de banco. Não oferece recuperação independente de falha do computador; sincronização OneDrive não foi comprovada.
- Arquitetura aprovada não significa esquema aprovado nem ambiente pronto. A preparação de WSL/runtime/CLI permanece pendente, conforme o relatório específico.

O desenho preserva o comportamento encontrado no código. Não foram lidas em massa planilhas, anotações ou históricos reais; volumes, duplicidades efetivas e qualidade dos dados permanecem desconhecidos.

## 2. Regras de representação

### Identificadores e tipos

- Usar schema privado `simpress` para o domínio. `auth` e `storage` são schemas gerenciados pelo Supabase, acessados pelas interfaces suportadas.
- Chaves internas novas: `uuid`. IDs públicos legados de eventos e itens: `text`, preservados sem conversão obrigatória para UUID.
- IDs públicos de unidades: `bigint`, preservando os números atuais. Novos IDs devem respeitar o inteiro seguro do JavaScript, até 9.007.199.254.740.991, além da regra existente de identidade/colisão.
- CNPJ, CEP, série, contrato e IdCliente: `text`; não converter em números nem perder zeros à esquerda.
- Datas válidas: `timestamptz`, com texto original em coluna separada. Data ausente/inválida: valor interpretado nulo e texto preservado; não inventar uma data de migração para justificar exclusão.
- Contadores, ordens e revisões: `bigint` não negativo. SHA-256: `text` com validação de 64 caracteres hexadecimais. Tamanhos: `bigint` não negativo, medidos em bytes.
- Campos de domínio importados: `text`, sem truncar para caber nos limites atuais de formulários. As validações de novas gravações continuam no domínio e, quando não impedirem preservação legada, também nas constraints.
- `jsonb` atende filtros/projeções. Arquivos originais e representações canônicas em `text` atendem preservação exata. Não usar `jsonb::text` como substituto da serialização Python existente.

O PostgreSQL normaliza a representação em `jsonb`, inclusive ordem de chaves e certas representações numéricas. Isso impede recomputar fingerprints legados apenas a partir de sua representação textual. [Tipos JSON no PostgreSQL](https://www.postgresql.org/docs/current/datatype-json.html)

### Proveniência e precedência

- A planilha oficial mais recente `EquipamentosDetalhes` determina o inventário. `InvAll` é fonte auxiliar; ausência em qualquer uma não autoriza excluir ou incluir equipamento por inferência.
- Preservar cada linha de origem, sua aba, posição e arquivo, inclusive duplicadas ou inválidas. A projeção operacional pode seguir a precedência atual, mas não deve apagar as linhas que ficaram fora dela.
- Distinguir série bruta, chave atual de cache (`upper`) e chave normalizada de comparação. Nenhuma chave de série recebe unicidade global.
- Dados originais da comparação permanecem imutáveis. Resolução de divergências, anotações e estado de processamento ficam separados.
- A ordem original dos históricos deve ser importada. Para reaplicação, a precedência atual é a ordem dos eventos no array, lida do final para o início, e não somente a data informada.

## 3. Diagrama textual

```text
auth.users ── configuracao (administrador permitido)
                  └── estado_aplicacao ── lote ativo

operacoes ── lotes_inventario ── fontes_lote ── arquivos_origem
    │               │                 │              └── objetos_arquivo
    │               │                 └── linhas_fonte
    │               └── equipamentos_lote ── linha oficial de origem
    │                                          └── unidade opcional
    ├── eventos_comparacao ── linhas_comparacao ── anotacoes
    │         │                     └── pendencias_sincronizacao
    │         └── backup anterior / evento restaurado
    ├── backups_logicos ── referencias_backup ── objetos_arquivo
    └── conflitos_importacao

unidades_catalogo ── unidades_customizadas
apelidos_manuais (sem FK obrigatória para equipamento)
historico_apelidos (IDs e referências legadas preservados)
```

O ponteiro em `estado_aplicacao` define o único lote ativo. Não manter um segundo indicador independente de lote ativo. Arquivos são compartilháveis por referência, mas linhas de inventário e IDs de anotação continuam próprios de cada evento/lote.

## 4. Dicionário de dados proposto

Convenções: **PK** é a chave primária; **FK** é a referência entre tabelas. Toda FK precisa de índice no lado referenciador quando utilizada em busca/limpeza. Exclusão é `RESTRICT` como padrão; cascata só para dados temporários descartáveis identificados, nunca para histórico/anotações por conveniência. Não há SQL executável neste documento.

### 4.1 `configuracao`

- **PK:** `id smallint`, com único valor permitido `1`.
- `admin_user_id uuid`: único, FK para `auth.users.id`, obrigatório após provisionamento; exclusão restrita. Antes disso, nenhuma identidade tem acesso ao domínio.
- `admin_habilitado boolean`; `retencao_operacional_dias integer = 60`, positivo; `versao_formato integer`, positiva.
- `destino_backup_local text`: caminho configurado no servidor para `Backup_Banco`, sem credenciais; `atualizado_em timestamptz`.
- Uma linha por instalação. Senhas não são armazenadas nesta tabela. Alterações exigem função administrativa própria, sem escrita livre pela aplicação.
- Retenção: permanente enquanto a instalação existir.

O vínculo usa a PK pública `auth.users.id`. A conta é provisionada posteriormente pelo fluxo suportado de Auth; não inserir usuários ou senhas manualmente nas tabelas internas. [Dados de usuários no Supabase](https://supabase.com/docs/guides/auth/managing-user-data)

### 4.2 `estado_aplicacao`

- **PK:** `id smallint`, limitado a `1`.
- `lote_ativo_id uuid`, FK para `lotes_inventario`, nulo somente antes da primeira carga válida.
- `revisao_global bigint`, não negativa; `atualizado_em timestamptz`.
- `modelo_transferencia_id uuid` e `modelo_exportacao_id uuid`: FKs opcionais para `objetos_arquivo`; obrigatoriedade verificada antes da funcionalidade correspondente.
- Toda gravação operacional relevante incrementa a revisão na mesma transação. Leitura por PK e bloqueio dessa linha coordenam troca de lote e geração de snapshots.
- Retenção: permanente. A revisão fornece invalidação de caches, não substitui a verificação de versão da entidade editada.

### 4.3 `operacoes`

- **PK:** `id uuid`; `chave_idempotencia text` única, delimitada pelo tipo de operação e identidade do pedido.
- `tipo text`: importação legada, atualização de inventário, restauração, backup ou limpeza; `estado text`: preparada, arquivos pendentes, arquivos verificados, confirmada, falhou ou cancelada.
- `revisao_esperada bigint`, `revisao_confirmada bigint` opcionais; `autor_user_id uuid` opcional para legados, FK de Auth.
- `criado_em`, `atualizado_em`, `lease_ate`: `timestamptz`; `tentativas integer >= 0`; `erro_codigo text`, sem segredos.
- `manifesto_origem_sha256 text`, `versao_importador text`, `contagens jsonb` e referências de artefatos para reconciliação da carga legada.
- Índices: unicidade da chave; `(estado, atualizado_em)` para recuperação. A mesma chave com conteúdo diferente deve gerar conflito, nunca sucesso aparente.
- Retenção: pelo menos enquanto houver referência, falha pendente ou necessidade de auditoria; histórico concluído entra na política operacional de 60 dias se não protegido.

### 4.4 `objetos_arquivo`

- **PK:** `id uuid`; `bucket text`, `chave text`, com unicidade conjunta; `sha256 text`; `tamanho_bytes bigint`.
- `mime_type text`, `criado_em timestamptz`, `verificado_em timestamptz` opcional; `estado text`: pendente, verificado, exclusão pendente ou removido.
- `operacao_id uuid` FK; metadados mínimos de formato/versão. O nome original pertence à proveniência, não precisa ser a chave física do objeto.
- Índices: `(sha256, tamanho_bytes)` não único para deduplicação validada; `(estado, criado_em)` para recuperação/limpeza.
- Objeto verificado é imutável. Substituir conteúdo gera nova chave/referência; nunca sobrescrever um objeto referido por histórico.
- Retenção: por referências vivas, não por idade isolada. Atualizar metadados de negócio nesta tabela; manipular o conteúdo pelo Storage, sem DML manual em `storage.objects`.

### 4.5 `arquivos_origem`

- **PK:** `id uuid`; `objeto_id uuid` FK obrigatória para objeto verificado antes da ativação.
- `nome_original text`, `papel text` (detalhes, endpoint ou artefato legado), `recebido_em timestamptz`, `parser_versao text`.
- `estrutura_abas jsonb`: nomes, ordens de colunas e informações necessárias à interpretação; arquivo original conserva fórmulas/estilos e demais partes nativas.
- Índice em `objeto_id`. Diferentes recebimentos podem compartilhar bytes deduplicados, preservando proveniências distintas.
- Retenção: enquanto lote, evento, auditoria ou backup referenciar a origem.

### 4.6 `lotes_inventario`

- **PK:** `id uuid`; `operacao_id uuid` FK única; `anterior_id uuid` FK opcional para outro lote.
- `criado_em timestamptz`; `estado text` (preparado, validado, arquivado ou rejeitado); `versao_parser text`; `contagens jsonb`.
- Índices em `anterior_id` e `criado_em`. O lote ativo é determinado exclusivamente pelo ponteiro global.
- Linhas de origem são imutáveis. Projeções do lote ativo podem receber edições autorizadas; depois de arquivado, o lote fica congelado.
- Unicidade de `operacao_id` vale para a operação que cria o lote; edições posteriores referenciam suas próprias operações sem substituir esse vínculo de criação.
- Retenção: lote ativo e lotes referenciados são protegidos. Arquivados não referenciados podem ser elegíveis após 60 dias, mediante reconciliação de todas as dependências.

### 4.7 `fontes_lote`

- **PK composta:** `(lote_id uuid, papel text)`; papel restrito a `detalhes` ou `endpoint`.
- `lote_id` FK; `arquivo_id uuid` FK; `estado_validacao text`; `contagem_linhas bigint`.
- Uma fonte de cada papel por lote. A ativação de uma atualização normal exige o par validado, conforme o fluxo atual; origem legada incompleta precisa de classificação explícita, sem fabricar arquivo ausente.
- Retenção: acompanha o lote e impede remoção prematura do arquivo.

### 4.8 `linhas_fonte`

- **PK:** `id uuid`; FK composta `(lote_id, papel)` para `fontes_lote`.
- `aba text`, `numero_linha bigint > 0`, `ordem_aba integer >= 0`; unicidade `(lote_id, papel, aba, numero_linha)`.
- `celulas jsonb` como lista por posição, preservando colunas com nomes repetidos; `dados_interpretados jsonb`; `estado_validacao text`, `motivo_codigo text` opcional.
- `serie_bruta text`, `serie_normalizada text` opcionais; índice não único `(lote_id, papel, serie_normalizada)`.
- Todas as linhas lidas pelo importador são contabilizadas, inclusive descartes explícitos de cabeçalhos/vazias e casos ambíguos. O XLSX original continua sendo a prova dos bytes e elementos nativos.
- Retenção: acompanha lote/origem; registros inválidos não desaparecem silenciosamente.

### 4.9 `equipamentos_lote`

- **PK:** `id uuid`; `lote_id uuid` FK; `linha_origem_id uuid` FK opcional e única quando preenchida.
- `origem text`: importada ou manual. Importada exige linha do mesmo lote e papel `detalhes`; manual não inventa número de linha XLSX. Garantir essa relação por FK composta/constraint apropriada na Etapa 4, não só por convenção.
- `serie_bruta text`, `chave_api text`, `serie_normalizada text`; índices **não únicos** `(lote_id, chave_api)` e `(lote_id, serie_normalizada)`.
- Campos `text`: `modelo`, `tipo`, `apelido_base`, `id_cliente`, `contrato`, `razao_social`, `endereco_instalacao`, `retirada_cnpj`, `retirada_endereco`, `retirada_cidade`, `retirada_uf`, `retirada_cep`.
- `unidade_id bigint` FK opcional para catálogo; `versao bigint`; `revisao_legada text`; `atualizado_em timestamptz`.
- Projeção de compatibilidade reproduz a precedência atual da última linha por chave API, mantendo indicação de duplicidade e bloqueios de edição ambígua. Não há unicidade de série nem descarte das outras linhas no banco.
- Apelido efetivo e campos derivados de comparação não são uma segunda fonte independente: são calculados com a mesma regra de domínio a partir da base, ajustes manuais e fonte auxiliar.
- Retenção: acompanha lote; snapshots de backup devem capturar as edições atuais, pois o arquivo originalmente importado pode ter conteúdo anterior.

### 4.10 `unidades_catalogo`

- **PK pública:** `id bigint > 0`, no limite seguro do frontend para novos IDs.
- `source_key text` opcional; `origem_lote_id uuid` FK opcional; `ativa boolean`; `versao bigint`.
- `cidade`, `endereco`, `uf`, `cep`, `cnpj`: `text`; `origem text` distingue derivada/customizada.
- `source_key` é indexada, sem impor unicidade cega a legados. A geração e a resolução de colisões seguem o código existente.
- Catálogo preserva a identidade entre recargas; unidade ausente passa a inativa enquanto referenciada, sem reutilizar seu ID para outra identidade.
- Retenção: enquanto ativa/referenciada; não aplicar 60 dias automaticamente ao cadastro.

### 4.11 `unidades_customizadas`

- **PK/FK:** `unidade_id bigint` para `unidades_catalogo`.
- `source_key_legada text` opcional; `cidade`, `endereco`, `uf`, `cep`, `cnpj`: `text`; `registro_original text` ou artefato de importação; `versao bigint`, `atualizado_em timestamptz`.
- Mesclagem por `_source_key` quando presente; fallback legado por cidade/CNPJ conforme o domínio atual. Não substituir por uma nova identidade baseada apenas no nome exibido.
- Validações de novas unidades preservam UF/CNPJ e limites existentes. Duplicidades legadas entram em conflito documentado; não corrigir por aproximação.
- Retenção: cadastro persistente; sem expurgo automático por idade.

### 4.12 `apelidos_manuais`

- **PK:** `chave_serie_original text`, preservando cada chave do mapa JSON.
- `serie_normalizada text`, `apelido text NOT NULL`, `versao bigint`, `atualizado_em timestamptz`.
- Índice não único em `serie_normalizada`; sem FK obrigatória para equipamento, pois existem ajustes para séries ausentes no inventário atual.
- String vazia é valor legítimo. Havendo mais de uma chave original que normalize para a mesma série, preservar o bloqueio atual de aplicação do ajuste, mesmo se os valores coincidirem.
- Retenção: estado ativo persistente, independente dos 60 dias do histórico.

### 4.13 `historico_apelidos`

- **PK:** `evento_id text`; `ordem_evento bigint` única; `horario_original text`; `horario timestamptz` opcional.
- `tipo`, `serie_bruta`, `serie_normalizada`, `equipamento`, `apelido_anterior`, `apelido_novo`, `acao`, `referencia_id_original`: `text`.
- `referencia_evento_id text` FK opcional quando resolvida; referência bruta continua disponível se o evento já não existe. `autor_user_id uuid` opcional, sem atribuir ações legadas ao novo administrador.
- `registro_original text` ou referência para artefato intacto; índice `(serie_normalizada, ordem_evento)` e índice em `horario`.
- Preservar exclusão/desfazer previstos no fluxo atual, com concorrência controlada; o modelo não transforma silenciosamente um histórico editável em auditoria imutável.
- Retenção: 60 dias para registros classificáveis e não protegidos; data inválida e referência necessária impedem expurgo automático.

### 4.14 `eventos_comparacao`

- **PK:** `evento_id text`; `ordem_evento bigint` única, importada da ordem original e sequencial para novos eventos.
- `tipo text`: comparação ou restauração; `horario_original text`; `horario timestamptz` opcional; `completude text`: completo ou contexto parcial.
- `lote_id uuid`, `operacao_id uuid`, `backup_anterior_id uuid`: FKs opcionais conforme existência legada; `restauracao_de_original text` e FK resolvida opcional para outro evento.
- `resumo jsonb`, `payload_original text` ou artefato; `fixado boolean`; `protegido_retencao boolean` e motivo explícito.
- Índices em `ordem_evento`, `horario` e FKs. Evento parcial permite conservar anotações recebidas em clone sem histórico local; não é apresentado como comparação completa.
- Preservar contagens, nomes brutos dos arquivos e campos específicos de restauração. Resoluções posteriores ficam fora do payload original.
- Retenção: 60 dias, exceto fixados, datas inválidas, pendências e eventos/contextos necessários às anotações.

### 4.15 `linhas_comparacao`

- **PK interna:** `id uuid`; `evento_id text` FK; `item_id text`; unicidade `(evento_id, item_id)`.
- `categoria text`, `ordem_linha bigint`, `grupo_fonte text`, `grupo_tipo text`, `caminho_original text`: posição e agrupamento de origem, sem renomear categorias internas.
- `dados_consulta jsonb`; `payload_canonico text` opcional; `linha_hash text` opcional; `contexto_parcial boolean`.
- `estado_operacional jsonb` para resolução de divergências manuais e timestamps de resolução, separado dos dados originais usados no fingerprint.
- Na importação, todo campo original da linha entra na canonicalização, exceto os dois campos de anotação previstos. A separação de metadados não autoriza omitir campos originais; se uma resolução afetar categoria anotável no futuro, compor a linha efetiva segundo a regra do domínio antes de calcular o hash.
- Índice `(categoria, linha_hash, evento_id)` não único e índice `(evento_id, categoria, ordem_linha)`. Duplicatas iguais são válidas; nunca impor unicidade por fingerprint.
- Linha completa exige canonicalização e hash válidos; parcial legada pode não ter hash, sem autorização para reaplicação por similaridade. Hash legado com contexto incompleto não permite reconstruir dados completos por inferência.
- Retenção: acompanha evento e proteção das anotações; exclusão de evento não provoca cascata destrutiva.

### 4.16 `anotacoes`

- **PK/FK composta:** `(evento_id text, item_id text)` para a chave pública da linha de comparação.
- `texto text NOT NULL`, com `char_length(texto) <= 2000`, inclusive vazio; `versao bigint`; `atualizado_em timestamptz` opcional para legado inválido; `atualizado_em_original text`.
- `origem text`: local, compartilhada, legada ou reaplicada; referência bruta opcional à anotação anterior, sem forçar o apagamento/retorno do evento anterior.
- Sem múltiplas anotações ativas por linha. Controle de versão evita sobrescrita silenciosa entre autosaves e sincronização.
- Retenção: protegida durante a migração. Os 60 dias não autorizam apagar notas/contextos, nem converter ausência de anotação em permissão para buscar nota antiga.

### 4.17 `pendencias_sincronizacao`

- **PK:** `id uuid`; `(evento_id, item_id)` FK; `versao_alvo bigint`; `destino text`; chave idempotente única `(evento_id, item_id, versao_alvo, destino)`.
- `payload text`, `estado text`, `tentativas integer`, `proxima_tentativa_em timestamptz`, `erro_codigo text` sem dados sensíveis.
- Índice `(estado, proxima_tentativa_em)`. Preserva a ponte com a pasta compartilhada já configurada até a transição validada; não remover a sincronização nesta etapa.
- Comparação por versão/conteúdo e tratamento explícito de conflitos entre escritores antigos e novos. Timestamp sozinho não resolve empates ou relógios divergentes.
- Retenção: pendências e conflitos não expiram automaticamente; concluídas seguem retenção operacional sem perder dados ainda referenciados.

### 4.18 `backups_logicos`

- **PK:** `id uuid`; `operacao_id uuid` FK; `tipo text`: anterior à atualização, anterior à restauração ou desastre.
- `capturado_em timestamptz`; `revisao_global bigint`; `versao_esquema text`; `manifesto_objeto_id uuid` FK; `manifesto_sha256 text`.
- `estado text`: preparado, verificado, disponível, exclusão pendente ou removido; `protegido boolean`; `destino_local_relativo text` opcional, sem aceitar caminho arbitrário enviado pelo navegador.
- Índices `(tipo, capturado_em)` e `(estado, capturado_em)`. Disponibilidade exige manifesto e todos os objetos verificados, não apenas existência de uma pasta.
- Retenção operacional: 60 dias se sem referências/proteções. Política de backup de desastre e cópia independente precisa de definição operacional antes do uso oficial.

### 4.19 `referencias_backup`

- **PK composta:** `(backup_id uuid, objeto_id uuid, papel text)`; FKs para backup e objeto.
- `papel text` identifica fonte, snapshot lógico, modelo ou artefato legado; `ordem integer` quando relevante.
- Índice em `objeto_id` para impedir remoção de conteúdo compartilhado ainda necessário.
- Retenção: acompanha manifesto; sem apagar objeto enquanto outra referência estiver viva.

### 4.20 `conflitos_importacao`

- **PK:** `id uuid`; `operacao_id uuid` FK; `entidade text`, `chave_original text`, `local_origem text`, `motivo_codigo text`.
- `artefato_objeto_id uuid` FK opcional para evidência privada; `estado text`: pendente, resolvido ou aceito explicitamente; `resolucao text`, `resolvido_em timestamptz` opcionais.
- Índice `(operacao_id, estado)`. Não colocar conteúdo operacional completo em logs genéricos.
- Retenção: conflitos pendentes protegidos; evidências resolvidas seguem as referências e a política operacional.

Sessões e credenciais ficam sob responsabilidade de Auth e da implementação de autenticação da Etapa 7. Não criar agora um cadastro paralelo de usuários ou tabela de senhas. Se a estratégia de sessão do backend exigir estado próprio, seu modelo mínimo será documentado antes de implementá-lo.

## 5. Mapeamento das fontes existentes

### 5.1 Planilha oficial `EquipamentosDetalhes*.xlsx`

- **Origem:** seleção oficial já implementada, em `data/planilhas_entrada/`; não selecionar por conteúdo do Endpoint.
- **Destino:** objeto original privado, arquivo de origem, fonte `detalhes`, linhas de origem e equipamentos do lote.
- **Transformação:** usar sanitização e parser atuais. `Tipo`/`ClasseEquipamento` alimentam tipo; IdCliente e contrato permanecem texto. Manter a regra atual do contrato suportado e os tratamentos de endereço/Sede, sem criar equivalências adicionais no SQL.
- **Validação:** hash/tamanho, segurança do XLSX, abas/colunas necessárias, total lido, total aceito, inválidos e duplicados; conferir projeção atual por chave API sem perder linhas não selecionadas. CNPJ de retirada é o da instalação; não inferir CNPJ de faturamento.
- **Edição:** atualizar campos permitidos pela API no estado relacional. Campos de endereço enviados por compatibilidade e hoje ignorados não se tornam editáveis por terem coluna.

### 5.2 `InvAllComputersSummary_atual.xlsx`

- **Destino:** objeto, arquivo, fonte `endpoint` e linhas de origem; projeções de comparação calculadas pelo domínio.
- **Transformação:** preservar hostname, série, localidade, datas e valores brutos; normalizar somente nos pontos já utilizados para associação.
- **Validação:** contagens independentes, duplicidades e correspondências ambíguas; ausência em Endpoint não muda a composição do inventário oficial. Sem FK obrigatória de cada linha auxiliar para um equipamento.

### 5.3 `apelidos_modificados.json`

- **Origem:** mapa em `data/state/apelidos_modificados/`.
- **Destino:** `apelidos_manuais`, mais artefato original privado para reconciliação.
- **Transformação:** uma entrada por chave original, mantendo vazio e normalização existente.
- **Validação:** quantidade de chaves, igualdade de valores e colisões normalizadas. Não reunir duas chaves diferentes em uma única linha nem exigir equipamento presente.

### 5.4 `historico_alteracoes.json`

- **Destino:** `historico_apelidos`.
- **Transformação:** preservar ID, ordem, horário original, série, equipamento, antes/depois, ação e referência. Interpretar horário separadamente.
- **Validação:** igualdade campo a campo e ordem; IDs repetidos com payloads distintos são conflitos, não sobrescritas. Referência inexistente continua bruta. Não atribuir autoria legada ao usuário novo.

### 5.5 `unidades_custom.json`

- **Destino:** catálogo e ajustes customizados.
- **Transformação:** preservar IDs e `_source_key`; usar a identidade atual e fallback legado somente quando aplicável.
- **Validação:** unicidade de ID público, colisões de identidade, limites de novos IDs, igualdade de campos e mesclagem com unidades derivadas. Não preencher CNPJ/CEP ausentes por adivinhação.

### 5.6 `historico_comparacoes.json`

- **Destino:** eventos, linhas por categoria, resumo consultável e payload original privado.
- **Transformação:** preservar ordem, IDs existentes, nomes de arquivos, motivos, contagens e tipo. Linhas agrupadas por fonte/tipo viram linhas independentes, mantendo caminho/ordem.
- **Validação:** reconstrução de cada evento, seções e agrupamentos; duplicidades de IDs com conteúdo conflitante; hashes; diferenças entre comparação e restauração. A contagem resumida não substitui a contagem das linhas reais.
- **Resoluções:** extrair campos mutáveis de resolução para estado operacional, preservando o payload original e o comportamento de exibição/exportação.

### 5.7 Anotações compartilhadas e legadas

- **Origem:** diretório já configurado por `SIMPRESS_ANNOTATIONS_DIR` ou fallback; registros legados incorporados no histórico.
- **Destino:** linha/evento existentes ou contextos parciais, anotação e pendência de sincronização quando necessária.
- **Transformação:** preservar `evento_id`, `item_id`, `categoria`, `linha_hash`, horário e contexto disponíveis. Arquivo compartilhado é identificado por SHA-256 de `evento_id + NUL + item_id`; não identificar apenas pela série.
- **Validação:** limite de 2.000, igualdade de texto/IDs, conflitos de versão/data, notas vazias, clone sem evento local e falta de hash. Não gerar comparação fictícia completa para satisfazer uma FK.
- **Compatibilidade:** IDs legados de linhas devem ser calculados pelas funções existentes antes de filtragem; não regenerar com UUID nem mudar algoritmo por causa da normalização relacional.

### 5.8 Pendências em `anotacoes_historico_pendentes/`

- **Destino:** `pendencias_sincronizacao`, associadas a linhas/contextos válidos.
- **Validação:** não descartar uma nota só porque sua gravação compartilhada está pendente. Reexecução deve ser idempotente e conflitos devem permanecer visíveis.

### 5.9 Backups e modelos XLSX

- **Destino:** arquivos privados, manifests e referências de backup; modelos ativos referidos por `estado_aplicacao`.
- **Transformação:** preservar bytes, hashes, papéis e nomes originais. Hash idêntico permite deduplicar conteúdo verificado, não identidade de evento.
- **Validação:** conferir objetos contra manifestos e testar leitura futura pelo fluxo atual. XLSX com estilos, fórmulas, imagens ou partes nativas não é reconstruído a partir de simples linhas SQL.
- **Distinção:** backups legados de arquivos não são automaticamente backups completos do PostgreSQL/Auth/Storage. Registrar cobertura real. Exportações temporárias e formulário de transferência não exigem tabela permanente nova nesta etapa.

## 6. Identidade e reaplicação de anotações

Categorias internas preservadas:

```text
apelidos_sem_atualizacao
sem_acesso_14_dias
ausentes_no_endpoint
ausentes_em_detalhes
divergencias_local
correspondencias_ambiguas
registros_ambiguos
series_sem_mapeamento
```

Elas correspondem às seis seções detalhadas definidas no projeto, com subdivisões por fonte/tipo. Não reunir categorias internas diferentes apenas porque aparecem sob um mesmo título na interface.

O fingerprint existente é SHA-256 dos bytes UTF-8 da serialização Python de `[categoria, dados_da_linha]`, com `ensure_ascii=False`, `sort_keys=True` e `separators=(",", ":")`, removendo **somente** `anotacao` e `anotacao_id` do dicionário da linha. Metadados SQL, agrupamento e IDs internos ficam fora desse dicionário. Não adicionar normalizações de texto, datas, números ou nulos.

Contrato de reaplicação:

1. Preparar a nova linha e seu ID independente no novo evento, antes de filtrar para exibição.
2. Buscar candidatos da mesma categoria e fingerprint, verificando o payload canônico completo quando disponível. Hash é índice de candidatos, não licença para aproximação.
3. Considerar primeiro o evento igual mais recente pela ordem original, com todas as suas linhas iguais, inclusive linhas sem anotação.
4. Se houver ausência/vazio na ocorrência relevante ou notas conflitantes em duplicatas, bloquear a busca de notas de eventos mais antigos conforme a regra vigente.
5. Reaplicar somente valor permitido pela regra atual, criando registro próprio no novo evento. Não compartilhar PK da anotação original.
6. Registro compartilhado parcial só participa pelo hash válido e contexto confiável do protocolo atual. Sem hash, permanece acessível, mas não há reaplicação por hostname/série/motivo aproximados.
7. Preservar o comportamento atual de precedência da sincronização; empates/conflitos que não possam ser resolvidos com segurança ficam registrados para revisão.

Para eventos presentes apenas na pasta compartilhada, o algoritmo atual os considera depois dos eventos locais, ordenando pelos textos de horário do evento e atualização disponíveis. Essa precedência precisa ser portada explicitamente; não atribuir a um contexto parcial uma posição arbitrária que o faça superar um evento local completo.

Casos de revisão obrigatórios nas próximas implementações: números `1` versus `1.0`; nulo versus string vazia; Unicode; ordem de campos; duplicatas com notas iguais, diferentes ou vazias; nota antiga seguida de ocorrência vazia; eventos com horários empatados/inválidos; clone sem histórico; registro legado sem hash; duas seções com a mesma série; ID independente em novo evento.

### Rótulos de apresentação

Aplicar as regras do `AGENTS.md` ao exibir e exportar eventos novos e antigos: `na Simpress` e `no endpoint` nos contextos gerais; `Hostname no Endpoint` e `no Endpoint` na tabela de conferência; `Endpoint` sem preposição nas seções indicadas de ausência e ambiguidades. Manter nomes brutos de origem/arquivo e identificadores no armazenamento para auditoria/restauração. Não alterar esses dados para obter o rótulo visual.

## 7. Consultas e índices necessários

- **Inventário ativo:** ler ponteiro/revisão e equipamentos do mesmo lote; aplicar projeção de precedência e aliases. Evitar misturar revisões em consultas separadas; usar snapshot transacional quando necessário.
- **Busca/edição por série:** índices não únicos por lote/chave API e lote/série normalizada; detectar múltiplas correspondências antes de editar. Validar versão da entidade e revisão pública atual na mesma transação.
- **Pesquisa de texto:** conservar filtros atuais. Não adicionar índice GIN/trigram em todos os campos sem medir as consultas e o volume; a escolha física adicional fica para a validação local.
- **Unidades:** PK pública, busca de source key e mesclagem com customizações; não derivar ID da ordem exibida.
- **Históricos:** paginação estável pela ordem de evento, com filtro por série/categoria; datas não são desempate suficiente.
- **Detalhes/anotações:** `(evento_id, categoria, ordem_linha)` para montar seções; lookup por `(evento_id, item_id)` e join que mantenha linhas sem nota.
- **Reaplicação:** índice `(categoria, linha_hash, evento_id)` nas linhas e ordem nos eventos; escolher evento mais recente antes de avaliar todas as duplicatas. Nunca filtrar previamente apenas notas não vazias.
- **Restauração:** recuperar manifestos, fontes e hashes; validar preview/revisão e capturar backup do estado atual antes da troca.
- **Recuperação:** processar operações/outbox por estado e próxima tentativa, com lease e atualização condicional; reexecução não cria evento duplicado.
- **Limpeza:** listar candidatos por data válida, depois excluir qualquer referenciado/fixado/pendente. Índices nas FKs tornam essa verificação viável.

Unicidade e FKs compostas devem representar as relações efetivas, principalmente lote/fonte e evento/item. Índices de FK não são criados automaticamente pelo PostgreSQL no lado referenciador. [Constraints PostgreSQL](https://www.postgresql.org/docs/current/ddl-constraints.html)

## 8. Concorrência, arquivos e restauração

- Uma transação confirma entidades, evento, referências, revisão global e ponteiro ativo. Estado em memória só é publicado após commit; outra instância recarrega ao observar revisão diferente.
- A revisão legada de equipamento é um hash de um subconjunto dos campos. Preservá-la na API não dispensa `versao` relacional/CAS; endereço e outros campos não cobertos pelo hash precisam de proteção de concorrência.
- Upload de Storage e transação SQL são passos distintos. Preparar operação, enviar objetos privados imutáveis, verificar bytes/hashes, então confirmar referências e lote. Falha deixa estado recuperável; objeto não referenciado não é apagado sem prazo de segurança e rechecagem.
- Backup lógico captura uma revisão consistente, incluindo edições posteriores à importação. Só guardar o XLSX original não recupera alterações feitas exclusivamente no banco novo.
- Restauração operacional deve preservar o contrato atual: restaurar o par de fontes, recarregar pelo domínio, preservar/reconciliar ajustes manuais vigentes conforme o fluxo e registrar novo evento. O fluxo atual inclui o arquivo de apelidos no escopo transacional; isso não significa voltar automaticamente todo o cadastro de aliases a um snapshot antigo.
- Restauração de desastre recupera um conjunto coerente de banco, objetos e configurações necessárias; não se confunde com restaurar um inventário histórico. Credenciais e chaves de recuperação não pertencem ao Git nem ao manifesto público.
- Manifesto registra versão, cobertura, revisão e hashes. Antes de uso oficial, ensaiar falha parcial, restauração e rollback; existência da pasta `Backup_Banco` não comprova recuperabilidade.

## 9. Requisitos de autorização e RLS

- Schema de domínio fora da exposição automática da Data API no desenho inicial. Remover grants desnecessários e manter RLS nas tabelas que vierem a ser expostas; política ausente significa acesso fechado para papéis sem privilégio de bypass.
- A identidade autenticada só recebe acesso se coincidir com a conta administrativa habilitada da configuração. A condição genérica “usuário autenticado” é insuficiente.
- Backend de uso normal conecta com papel sem propriedade das tabelas, sem superuser e sem `BYPASSRLS`. Papéis de migrations, provisionamento e recuperação são separados.
- Conexão SQL direta não recebe automaticamente identidade de JWT. O backend valida a sessão e define contexto transacional confiável; pooling deve limpar contexto entre requisições. Não confiar em header ou parâmetro de usuário enviado pelo navegador.
- `operacoes`, outbox, conflitos, configurações e metadados internos não recebem escrita arbitrária via cliente. Transições e autorização devem ser verificadas no servidor e nas funções/políticas mínimas necessárias.
- Bucket privado; downloads mediados pelo backend autorizado ou URL assinada curta após autorização. Não permitir listagem ou leitura pública por conhecimento da chave.
- Chaves administrativas e de serviço ficam somente no servidor. Service role não deve ser o papel de consulta normal para contornar RLS.
- Desabilitar cadastro público e provisionar uma única conta inicial na Etapa 7; qualquer outra identidade, ainda que exista em Auth, não acessa inventário, histórico, notas ou arquivos.
- Na Etapa 4, acesso permanece fechado. Na Etapa 7, demonstrar cenários autorizados/negados, inclusive exportação, restauração, cache e acesso cruzado a objetos. Este documento não valida políticas implementadas.

Referências de implementação: [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [schemas privados e API](https://supabase.com/docs/guides/api/securing-your-api) e [controle de acesso no Storage](https://supabase.com/docs/guides/storage/security/access-control).

## 10. Política de retenção por entidade

- **Estado ativo:** configuração, ponteiro, inventário ativo, aliases e unidades não expiram aos 60 dias.
- **Históricos e backups operacionais:** 60 dias para eventos com data válida e candidatos não protegidos. Preservar evento fixado, referências de restauração, operações pendentes e datas inválidas.
- **Anotações/contextos:** protegidos durante migração. Não aplicar cascata de eventos/linhas nem apagar notas compartilhadas automaticamente. Política específica de expurgo exige definição anterior à ativação dessa rotina.
- **Arquivos:** duração da última referência viva, com deduplicação por conteúdo verificado. Objeto de 90 dias ainda referenciado por inventário ativo não é lixo.
- **Conflitos/outbox:** pendentes não expiram; concluídos podem seguir a janela operacional após eliminar dependências.
- **Backup de desastre:** frequência/meta de RPO/RTO são de planejamento; retenção e cópia independente precisam ser definidas e ensaiadas antes do uso oficial.

Limpeza em duas fases: marcar candidato e registrar operação; revalidar referências/estado antes de remover conteúdo pelo Storage; confirmar remoção e só então encerrar metadados compatíveis. Uma falha não pode deixar backup anunciado como disponível com arquivo ausente.

## 11. Ambiguidades e dependências registradas

- Quantidade real de registros, tamanho de arquivos e frequência de atualização não foram medidos. Não há estimativa de capacidade derivada de dados reais nesta etapa.
- IDs duplicados, colisões normalizadas, horários inválidos e campos inesperados serão reconciliados na importação. Não há decisão automática de sobrescrever registros conflitantes.
- `retirada_cnpj`, `endereco_instalacao` e `retirada_endereco` não são intercambiáveis por semelhança de nome. Preservar o mapeamento encontrado no parser.
- CNPJs e localidades não identificam sozinhos uma unidade; a regra atual inclui normalização e source key. Não migrar por fuzzy matching.
- Nem todo registro compartilhado contém dados completos para verificar igualdade; preservar o protocolo legado sem transformar contexto parcial em linha original reconstruída.
- Expurgo de anotações, backup de desastre independente e recuperação do computador inteiro permanecem requisitos de operação antes do uso oficial. Não bloqueiam a elaboração documental nem a criação futura do esquema fechado.
- A sessão não concluiu a preparação do WSL; sem runtime/CLI não há aplicação/validação local de migrations. Etapa 4 deverá tratar esse impedimento explicitamente.

## 12. Critérios de revisão e próximas etapas

Antes de fechar as migrations da Etapa 4, conferir:

- Cada fonte tem destino e artefato original preservado; nenhum campo operacional conhecido foi perdido.
- PKs/FKs representam lote/fonte e evento/item, sem tornar série normalizada única.
- Preservação de IDs, ordem e tipos legados; dados inválidos são isolados e reconciliados, sem truncar conteúdo.
- Casos de identidade/anotação da seção 6 estão representáveis; notas vazias e duplicatas não somem em joins.
- Estado ativo, arquivos e backups têm referências verificáveis; edições nativas do banco entram no snapshot.
- Todos os acessos começam fechados; papel normal não é dono nem contorna RLS.
- Retenção por entidade impede exclusão automática de notas, inventário ativo ou arquivos referenciados.
- O ambiente de execução é local, descartável e identificado antes de qualquer aplicação de SQL. Dados reais só entram na etapa autorizada de importação/ensaio.

A Etapa 4 traduz o esquema revisado em migrations e verifica estrutura local. As Etapas 5 a 7 implementam persistência, arquivos/anotações e autenticação. A Etapa 8 reconcilia importação, restauração e rollback. Nenhuma dessas implementações foi antecipada aqui.

## 13. Evidências e verificações desta entrega

Inspeção de fontes, sem abrir bases operacionais:

- `main.py`: revisão de equipamento, identidade e mesclagem de unidades, precedência de aliases, parser do inventário e retenção.
- `core/config.py`: caminhos, contrato, limites de upload e retenção de 60 dias.
- `domains/history_annotations.py`: serialização, hash, limite e contexto compartilhado.
- `domains/inventory_comparison.py`: IDs legados e identidade por evento/categoria.
- `domains/inventory_update.py`: reaplicação exata, precedência e preparação de novo evento/lote.
- `routers/inventory_history.py`: categorias anotáveis, resolução e restauração transacional.
- `routers/units.py`: campos, validação e atualização de unidades.

Resultados das verificações:

- `git diff --check`: passou para as alterações rastreadas.
- `git check-ignore`: confirmou `/Backup_Banco/` e a exclusão de seu `LEIA-ME.md`.
- Conferência documental: 20 entidades distintas; blocos fechados e links locais existentes nos quatro documentos criados/atualizados nesta entrega; requisitos textuais de identidade, retenção e acesso presentes.
- Estado final do Git: somente `.gitignore` modificado entre os arquivos rastreados; relatórios das Etapas 1, 2, 3, prompts e pré-requisitos ainda não rastreados. Nenhum arquivo da aplicação aparece modificado.

A implementação permanece baseada em XLSX/JSON. Não foram executados testes da aplicação para esta entrega documental; não existe esquema implementado para testar transações, RLS, importação ou recuperação. As limitações da suíte da Etapa 1 continuam registradas naquela etapa.

**Arquivos desta entrega:** este relatório; atualização da Etapa 2 com decisões aprovadas; relatório de pré-requisitos; `.gitignore`; instruções locais em `Backup_Banco/LEIA-ME.md` (arquivo ignorado pelo Git). Documentos anteriores preservados. Nenhum código da aplicação, dado operacional, recurso remoto, commit ou push alterado/criado.
