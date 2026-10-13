-- One approved administrator. No identity, credential, bucket or public policy seed.
create schema simpress_auth;
revoke all on schema simpress_auth from public, anon, authenticated, service_role;
alter default privileges in schema simpress_auth revoke all on functions from public;

do $$ begin
    if not exists(select 1 from pg_roles where rolname='simpress_session_gateway') then
        create role simpress_session_gateway nologin noinherit nosuperuser nocreatedb
            nocreaterole noreplication nobypassrls;
    elsif exists(select 1 from pg_roles where rolname='simpress_session_gateway' and
        (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) then
        raise exception 'Unsafe existing session gateway';
    end if;
end $$;

create table simpress_auth.sessions (
    session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
    user_id uuid not null references auth.users(id) on delete restrict,
    auth_session_id uuid not null,
    tokens_encrypted text not null,
    csrf_hash text not null check (csrf_hash ~ '^[a-f0-9]{64}$'),
    access_expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    last_seen_at timestamptz not null default now(),
    revoked_at timestamptz,
    check (expires_at > created_at)
);
create index sessions_user_idx on simpress_auth.sessions(user_id);
create index sessions_expiry_idx on simpress_auth.sessions(expires_at);
create table simpress_auth.login_attempts (
    key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
    window_start timestamptz not null default now(),
    attempts integer not null check (attempts > 0)
);
alter table simpress_auth.sessions enable row level security;
alter table simpress_auth.sessions force row level security;
alter table simpress_auth.login_attempts enable row level security;
alter table simpress_auth.login_attempts force row level security;
grant usage on schema simpress_auth to simpress_session_gateway, simpress_runtime, simpress_piloto;
grant select,insert,update,delete on simpress_auth.sessions,simpress_auth.login_attempts to simpress_session_gateway;
create policy server_sessions on simpress_auth.sessions to simpress_session_gateway using (true) with check (true);
create policy server_attempts on simpress_auth.login_attempts to simpress_session_gateway using (true) with check (true);

create function simpress_auth.pilot_unconfigured() returns boolean
language sql stable security definer set search_path=pg_catalog as $$
    select exists(select 1 from simpress.configuracao where id=1 and admin_user_id is null and not admin_habilitado)
$$;

create function simpress_auth.is_admin() returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
declare uid uuid; sid uuid; app_sid text; configured uuid;
begin
    uid := nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    sid := nullif(current_setting('simpress.auth_session_id',true),'')::uuid;
    app_sid := current_setting('simpress.app_session_hash',true);
    if uid is null or sid is null or app_sid is null then return false; end if;
    select admin_user_id into configured from simpress.configuracao where id=1 and admin_habilitado;
    if configured is distinct from uid then return false; end if;
    return exists(select 1 from simpress_auth.sessions s where s.session_hash=app_sid
        and s.user_id=uid and s.auth_session_id=sid and s.revoked_at is null
        and s.expires_at>now() and s.last_seen_at>now()-interval '30 minutes')
        and exists(select 1 from auth.sessions s where s.id=sid and s.user_id=uid
            and (s.not_after is null or s.not_after>now()))
        and exists(select 1 from auth.users u where u.id=uid and u.deleted_at is null
            and (u.banned_until is null or u.banned_until<=now()));
exception when invalid_text_representation then return false;
end $$;

create function simpress_auth.allowed_identity(uid uuid,sid uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog as $$
begin
    return exists(select 1 from simpress.configuracao where id=1 and admin_habilitado and admin_user_id=uid)
        and exists(select 1 from auth.sessions where id=sid and user_id=uid and (not_after is null or not_after>now()))
        and exists(select 1 from auth.users where id=uid and deleted_at is null and (banned_until is null or banned_until<=now()));
end $$;
revoke all on all functions in schema simpress_auth from public,anon,authenticated,service_role;
grant execute on function simpress_auth.pilot_unconfigured() to simpress_piloto;
grant execute on function simpress_auth.is_admin() to simpress_runtime;
grant execute on function simpress_auth.allowed_identity(uuid,uuid) to simpress_session_gateway;

do $policies$
declare t text;
begin
    for t in select tablename from pg_tables where schemaname='simpress' loop
        execute format('drop policy if exists piloto_local on simpress.%I',t);
        execute format('create policy piloto_local on simpress.%I to simpress_piloto
            using (current_setting(''simpress.piloto_local'',true)=''on'' and simpress_auth.pilot_unconfigured())
            with check (current_setting(''simpress.piloto_local'',true)=''on'' and simpress_auth.pilot_unconfigured())',t);
        execute format('create policy administrator_session on simpress.%I to simpress_runtime
            using (simpress_auth.is_admin()) with check (simpress_auth.is_admin())',t);
    end loop;
end $policies$;
grant usage on schema simpress to simpress_runtime;
grant select on all tables in schema simpress to simpress_runtime;
grant insert on simpress.operacoes,simpress.equipamentos_lote,simpress.objetos_arquivo,
    simpress.arquivos_origem,simpress.lotes_inventario,simpress.fontes_lote,simpress.linhas_fonte,
    simpress.eventos_comparacao,simpress.linhas_comparacao,simpress.anotacoes,
    simpress.backups_logicos,simpress.referencias_backup,simpress.conflitos_importacao,
    simpress.unidades_catalogo,simpress.unidades_customizadas,simpress.apelidos_manuais,
    simpress.historico_apelidos to simpress_runtime;
grant update on simpress.operacoes,simpress.objetos_arquivo,simpress.anotacoes,
    simpress.lotes_inventario,simpress.unidades_catalogo,simpress.unidades_customizadas,
    simpress.apelidos_manuais to simpress_runtime;
grant update (revisao_global,atualizado_em,lote_ativo_id,modelo_transferencia_id,modelo_exportacao_id)
    on simpress.estado_aplicacao to simpress_runtime;
grant update (modelo,tipo,id_cliente,versao,atualizado_em) on simpress.equipamentos_lote to simpress_runtime;
grant update (excluido_em,fixado,restauracao_de_original,restauracao_de_evento_id)
    on simpress.eventos_comparacao to simpress_runtime;
grant update (estado_operacional) on simpress.linhas_comparacao to simpress_runtime;
grant delete on simpress.apelidos_manuais,simpress.historico_apelidos to simpress_runtime;
grant usage on sequence simpress.eventos_comparacao_ordem_evento_seq,
    simpress.historico_apelidos_ordem_evento_seq to simpress_runtime;

create function simpress_auth.stamp_operation_author() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
    if current_user='simpress_runtime' then
        new.autor_user_id := nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    end if;
    return new;
end $$;
revoke all on function simpress_auth.stamp_operation_author() from public,anon,authenticated,service_role;
create trigger operation_verified_author before insert on simpress.operacoes
    for each row execute function simpress_auth.stamp_operation_author();

-- Restrictive policies also deny this bucket if another application adds a
-- permissive authenticated policy later. No client receives a permissive policy.
do $$ begin
    if to_regclass('storage.objects') is not null then
        execute 'create policy simpress_backend_objects on storage.objects as restrictive
            to anon,authenticated using (bucket_id<>''simpress-pilot'') with check (bucket_id<>''simpress-pilot'')';
        execute 'create policy simpress_backend_bucket on storage.buckets as restrictive
            to anon,authenticated using (id<>''simpress-pilot'') with check (id<>''simpress-pilot'')';
    end if;
end $$;
