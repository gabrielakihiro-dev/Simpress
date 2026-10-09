-- Domain only. Original files remain private Storage objects; no operational seed.
create schema simpress;

create table simpress.configuracao (
    id smallint primary key default 1 check (id = 1),
    admin_user_id uuid unique,
    admin_habilitado boolean not null default false,
    retencao_operacional_dias integer not null default 60 check (retencao_operacional_dias > 0),
    versao_formato integer not null default 1 check (versao_formato > 0),
    destino_backup_local text not null default 'Backup_Banco',
    atualizado_em timestamptz not null default now(),
    constraint administrador_habilitado_exige_identidade check (not admin_habilitado or admin_user_id is not null)
);

create table simpress.estado_aplicacao (
    id smallint primary key default 1 check (id = 1),
    lote_ativo_id uuid,
    revisao_global bigint not null default 0 check (revisao_global >= 0),
    modelo_transferencia_id uuid,
    modelo_exportacao_id uuid,
    atualizado_em timestamptz not null default now()
);

create table simpress.operacoes (
    id uuid primary key default gen_random_uuid(),
    chave_idempotencia text not null unique check (length(chave_idempotencia) > 0),
    tipo text not null check (tipo in ('importacao_legada', 'atualizacao_inventario', 'restauracao', 'backup', 'limpeza', 'edicao')),
    estado text not null default 'preparada' check (estado in ('preparada', 'arquivos_pendentes', 'arquivos_verificados', 'confirmada', 'falhou', 'cancelada')),
    revisao_esperada bigint check (revisao_esperada >= 0),
    revisao_confirmada bigint check (revisao_confirmada >= 0),
    autor_user_id uuid,
    criado_em timestamptz not null default now(),
    atualizado_em timestamptz not null default now(),
    lease_ate timestamptz,
    tentativas integer not null default 0 check (tentativas >= 0),
    erro_codigo text,
    manifesto_origem_sha256 text check (manifesto_origem_sha256 ~ '^[0-9a-f]{64}$'),
    pedido_sha256 text check (pedido_sha256 ~ '^[0-9a-f]{64}$'),
    versao_importador text,
    contagens jsonb not null default '{}'::jsonb check (jsonb_typeof(contagens) = 'object'),
    artefatos_origem jsonb not null default '[]'::jsonb check (jsonb_typeof(artefatos_origem) = 'array')
);

create table simpress.objetos_arquivo (
    id uuid primary key default gen_random_uuid(),
    bucket text not null check (length(bucket) > 0),
    chave text not null check (length(chave) > 0),
    sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    tamanho_bytes bigint not null check (tamanho_bytes >= 0),
    mime_type text,
    criado_em timestamptz not null default now(),
    verificado_em timestamptz,
    estado text not null default 'pendente' check (estado in ('pendente', 'verificado', 'exclusao_pendente', 'removido')),
    operacao_id uuid,
    metadados jsonb not null default '{}'::jsonb check (jsonb_typeof(metadados) = 'object'),
    unique (bucket, chave),
    check (estado <> 'verificado' or verificado_em is not null)
);

create table simpress.arquivos_origem (
    id uuid primary key default gen_random_uuid(),
    objeto_id uuid not null,
    nome_original text not null,
    papel text not null check (papel in ('detalhes', 'endpoint', 'artefato_legado')),
    recebido_em timestamptz not null default now(),
    parser_versao text not null,
    estrutura_abas jsonb not null default '[]'::jsonb check (jsonb_typeof(estrutura_abas) = 'array'),
    unique (id, papel)
);

create table simpress.lotes_inventario (
    id uuid primary key default gen_random_uuid(),
    operacao_id uuid not null unique,
    anterior_id uuid,
    criado_em timestamptz not null default now(),
    estado text not null default 'preparado' check (estado in ('preparado', 'validado', 'arquivado', 'rejeitado')),
    versao_parser text not null,
    contagens jsonb not null default '{}'::jsonb check (jsonb_typeof(contagens) = 'object'),
    check (anterior_id is distinct from id)
);

create table simpress.fontes_lote (
    lote_id uuid not null,
    papel text not null check (papel in ('detalhes', 'endpoint')),
    arquivo_id uuid not null,
    estado_validacao text not null default 'pendente' check (estado_validacao in ('pendente', 'valido', 'invalido', 'legado_incompleto')),
    contagem_linhas bigint not null default 0 check (contagem_linhas >= 0),
    primary key (lote_id, papel)
);

create table simpress.linhas_fonte (
    id uuid primary key default gen_random_uuid(),
    lote_id uuid not null,
    papel text not null,
    aba text not null,
    numero_linha bigint not null check (numero_linha > 0),
    ordem_aba integer not null default 0 check (ordem_aba >= 0),
    celulas jsonb not null default '[]'::jsonb check (jsonb_typeof(celulas) = 'array'),
    dados_interpretados jsonb not null default '{}'::jsonb check (jsonb_typeof(dados_interpretados) = 'object'),
    estado_validacao text not null check (estado_validacao in ('valida', 'invalida', 'duplicada', 'descartada', 'ambigua')),
    motivo_codigo text,
    serie_bruta text,
    serie_normalizada text,
    unique (lote_id, papel, aba, numero_linha),
    unique (id, lote_id, papel)
);

create table simpress.equipamentos_lote (
    id uuid primary key default gen_random_uuid(),
    lote_id uuid not null,
    linha_origem_id uuid unique,
    papel_origem text not null default 'detalhes' check (papel_origem = 'detalhes'),
    origem text not null check (origem in ('importada', 'manual')),
    serie_bruta text not null,
    chave_api text not null,
    serie_normalizada text not null,
    modelo text,
    tipo text,
    apelido_base text,
    id_cliente text,
    contrato text,
    razao_social text,
    endereco_instalacao text,
    retirada_cnpj text,
    retirada_endereco text,
    retirada_cidade text,
    retirada_uf text,
    retirada_cep text,
    unidade_id bigint,
    versao bigint not null default 0 check (versao >= 0),
    revisao_legada text check (revisao_legada ~ '^[0-9a-f]{64}$'),
    atualizado_em timestamptz not null default now(),
    constraint equipamento_origem_coerente check (
        (origem = 'importada' and linha_origem_id is not null)
        or (origem = 'manual' and linha_origem_id is null)
    )
);

create table simpress.unidades_catalogo (
    id bigint primary key check (id > 0),
    source_key text,
    origem_lote_id uuid,
    ativa boolean not null default true,
    versao bigint not null default 0 check (versao >= 0),
    cidade text,
    endereco text,
    uf text,
    cep text,
    cnpj text,
    origem text not null check (origem in ('derivada', 'customizada'))
);

create table simpress.unidades_customizadas (
    unidade_id bigint primary key,
    source_key_legada text,
    cidade text,
    endereco text,
    uf text,
    cep text,
    cnpj text,
    registro_original text,
    versao bigint not null default 0 check (versao >= 0),
    atualizado_em timestamptz not null default now()
);

create table simpress.apelidos_manuais (
    chave_serie_original text primary key,
    serie_normalizada text not null,
    apelido text not null,
    versao bigint not null default 0 check (versao >= 0),
    atualizado_em timestamptz not null default now()
);

create table simpress.historico_apelidos (
    evento_id text primary key check (length(evento_id) > 0),
    ordem_evento bigint generated by default as identity unique check (ordem_evento >= 0),
    horario_original text,
    horario timestamptz,
    tipo text,
    serie_bruta text,
    serie_normalizada text,
    equipamento text,
    apelido_anterior text,
    apelido_novo text,
    acao text,
    referencia_id_original text,
    referencia_evento_id text,
    autor_user_id uuid,
    registro_original text not null
);

create table simpress.eventos_comparacao (
    evento_id text primary key check (length(evento_id) > 0),
    ordem_evento bigint generated by default as identity unique check (ordem_evento >= 0),
    tipo text not null check (tipo in ('comparacao', 'restauracao')),
    horario_original text,
    horario timestamptz,
    completude text not null check (completude in ('completo', 'contexto_parcial')),
    lote_id uuid,
    operacao_id uuid,
    backup_anterior_id uuid,
    restauracao_de_original text,
    restauracao_de_evento_id text,
    resumo jsonb not null default '{}'::jsonb check (jsonb_typeof(resumo) = 'object'),
    payload_original text,
    fixado boolean not null default false,
    protegido_retencao boolean not null default false,
    motivo_protecao text,
    check (completude <> 'completo' or payload_original is not null),
    check (not protegido_retencao or motivo_protecao is not null)
);

create table simpress.linhas_comparacao (
    id uuid primary key default gen_random_uuid(),
    evento_id text not null,
    item_id text not null check (length(item_id) > 0),
    categoria text not null check (length(categoria) > 0),
    ordem_linha bigint not null check (ordem_linha >= 0),
    grupo_fonte text,
    grupo_tipo text,
    caminho_original text,
    dados_consulta jsonb not null default '{}'::jsonb check (jsonb_typeof(dados_consulta) = 'object'),
    payload_canonico text,
    linha_hash text check (linha_hash ~ '^[0-9a-f]{64}$'),
    contexto_parcial boolean not null default false,
    estado_operacional jsonb not null default '{}'::jsonb check (jsonb_typeof(estado_operacional) = 'object'),
    unique (evento_id, item_id),
    constraint linha_completa_exige_payload check (
        contexto_parcial or (payload_canonico is not null and linha_hash is not null)
    ),
    constraint assinatura_payload_exato check (
        payload_canonico is null or (
            linha_hash is not null
            and linha_hash = encode(sha256(convert_to(payload_canonico, 'UTF8')), 'hex')
        )
    ),
    constraint payload_secao_coerente check (
        payload_canonico is null or (
            jsonb_typeof(payload_canonico::jsonb) = 'array'
            and jsonb_array_length(payload_canonico::jsonb) = 2
            and jsonb_typeof(payload_canonico::jsonb -> 0) = 'string'
            and payload_canonico::jsonb ->> 0 = categoria
            and jsonb_typeof(payload_canonico::jsonb -> 1) = 'object'
            and not ((payload_canonico::jsonb -> 1) ?| array['anotacao', 'anotacao_id'])
        )
    )
);

create table simpress.anotacoes (
    evento_id text not null,
    item_id text not null,
    texto text not null check (char_length(texto) <= 2000),
    versao bigint not null default 0 check (versao >= 0),
    atualizado_em timestamptz,
    atualizado_em_original text,
    origem text not null check (origem in ('local', 'compartilhada', 'legada', 'reaplicada')),
    referencia_anterior_original text,
    primary key (evento_id, item_id)
);

create table simpress.pendencias_sincronizacao (
    id uuid primary key default gen_random_uuid(),
    evento_id text not null,
    item_id text not null,
    versao_alvo bigint not null check (versao_alvo >= 0),
    destino text not null,
    payload text not null,
    estado text not null default 'pendente' check (estado in ('pendente', 'processando', 'concluida', 'conflito', 'falhou')),
    tentativas integer not null default 0 check (tentativas >= 0),
    proxima_tentativa_em timestamptz,
    erro_codigo text,
    unique (evento_id, item_id, versao_alvo, destino)
);

create table simpress.backups_logicos (
    id uuid primary key default gen_random_uuid(),
    operacao_id uuid not null,
    tipo text not null check (tipo in ('anterior_atualizacao', 'anterior_restauracao', 'desastre')),
    capturado_em timestamptz not null default now(),
    revisao_global bigint not null check (revisao_global >= 0),
    versao_esquema text not null,
    manifesto_objeto_id uuid,
    manifesto_sha256 text check (manifesto_sha256 ~ '^[0-9a-f]{64}$'),
    estado text not null default 'preparado' check (estado in ('preparado', 'verificado', 'disponivel', 'exclusao_pendente', 'removido')),
    protegido boolean not null default false,
    destino_local_relativo text,
    check (estado not in ('verificado', 'disponivel') or (manifesto_objeto_id is not null and manifesto_sha256 is not null))
);

create table simpress.referencias_backup (
    backup_id uuid not null,
    objeto_id uuid not null,
    papel text not null,
    ordem integer check (ordem >= 0),
    primary key (backup_id, objeto_id, papel)
);

create table simpress.conflitos_importacao (
    id uuid primary key default gen_random_uuid(),
    operacao_id uuid not null,
    entidade text not null,
    chave_original text,
    local_origem text not null,
    motivo_codigo text not null,
    artefato_objeto_id uuid,
    estado text not null default 'pendente' check (estado in ('pendente', 'resolvido', 'aceito_explicitamente')),
    resolucao text,
    resolvido_em timestamptz,
    check (estado = 'pendente' or (resolucao is not null and resolvido_em is not null))
);
