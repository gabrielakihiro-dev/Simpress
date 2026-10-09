-- Synthetic fixtures only. ON_ERROR_STOP must be enabled by the caller.
-- The transaction rolls back fixtures, temporary grants and functions.
begin;
set local client_min_messages = warning;
create temporary table etapa_4_results (name text primary key);

create function pg_temp.ok(condition boolean, name text) returns void
language plpgsql as $$
begin
    if condition is distinct from true then
        raise exception 'FAIL: %', name;
    end if;
    insert into etapa_4_results values (name);
end $$;

create function pg_temp.reject(statement text, expected_state text, name text) returns void
language plpgsql as $$
declare
    rejected boolean := false;
begin
    begin
        execute statement;
    exception when others then
        if sqlstate <> expected_state then
            raise exception 'FAIL: %, expected SQLSTATE %, got %', name, expected_state, sqlstate;
        end if;
        rejected := true;
    end;
    perform pg_temp.ok(rejected, name);
end $$;

select pg_temp.ok(
    (select array_agg(tablename::text order by tablename) from pg_tables where schemaname='simpress') = array[
        'anotacoes','apelidos_manuais','arquivos_origem','backups_logicos','configuracao',
        'conflitos_importacao','equipamentos_lote','estado_aplicacao','eventos_comparacao',
        'fontes_lote','historico_apelidos','linhas_comparacao','linhas_fonte','lotes_inventario',
        'objetos_arquivo','operacoes','pendencias_sincronizacao','referencias_backup',
        'unidades_catalogo','unidades_customizadas'
    ]::text[], 'exactly the 20 expected domain tables');

select pg_temp.ok(
    (select bool_and(c.relrowsecurity and c.relforcerowsecurity)
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='simpress' and c.relkind='r'), 'RLS enabled and forced on every domain table');
select pg_temp.ok(not exists(select 1 from pg_policies where schemaname='simpress'
    and roles <> array['simpress_piloto']::name[]), 'no allow policies for public or non-pilot roles');
select pg_temp.ok(
    (select not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreatedb
      and not rolcreaterole and not rolinherit and not rolreplication
     from pg_roles where rolname='simpress_runtime'), 'runtime role cannot login or bypass security');
select pg_temp.ok(not exists(
    select 1 from pg_auth_members where member='simpress_runtime'::regrole
      or (roleid='simpress_runtime'::regrole
        and (member<>'postgres'::regrole or inherit_option or set_option))
), 'runtime has no memberships except isolated postgres administration');
select pg_temp.ok(not exists(
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='simpress' and c.relowner='simpress_runtime'::regrole
), 'runtime owns no domain objects');
select pg_temp.ok(
    (select count(*)=1 and bool_and(admin_user_id is null and not admin_habilitado
      and retencao_operacional_dias=60) from simpress.configuracao), 'disabled account bootstrap and 60 days');
select pg_temp.ok(
    (select count(*)=1 and bool_and(lote_ativo_id is null and revisao_global=0
      and modelo_transferencia_id is null and modelo_exportacao_id is null) from simpress.estado_aplicacao),
    'empty active state bootstrap');
select pg_temp.ok(not exists(select 1 from auth.users), 'no Auth account provisioned');
select pg_temp.ok(not exists(select 1 from storage.buckets), 'no Storage bucket provisioned');
select pg_temp.ok(
    (select count(*)=32 and bool_and(confdeltype='r') from pg_constraint
     where connamespace='simpress'::regnamespace and contype='f'), 'all 32 foreign keys restrict deletion');
select pg_temp.ok(not exists(
    select 1 from pg_constraint fk
    where fk.connamespace='simpress'::regnamespace and fk.contype='f'
      and not exists (
        select 1 from pg_index ix where ix.indrelid=fk.conrelid and ix.indisvalid
        and (select array_agg(k order by position) from unnest(ix.indkey::smallint[]) with ordinality as a(k,position)
             where position<=cardinality(fk.conkey)) = fk.conkey
      )
), 'each foreign key has a matching leading index');

do $$
declare
    op_a uuid;
    op_b uuid;
    obj uuid;
    file_details uuid;
    file_endpoint uuid;
    lot_a uuid;
    lot_b uuid;
    row_a uuid;
    row_a2 uuid;
    row_b uuid;
    row_endpoint uuid;
    canonical_a text := '["sem_acesso_14_dias",{"valor":1}]';
    canonical_b text := '["sem_acesso_14_dias",{"valor":1.0}]';
    bad_canonical text;
    unicode_canonical text := '["series_sem_mapeamento",{"serie":"Á-01","valor":null}]';
begin
    insert into simpress.operacoes(chave_idempotencia,tipo) values ('synthetic-a','importacao_legada') returning id into op_a;
    insert into simpress.operacoes(chave_idempotencia,tipo) values ('synthetic-b','importacao_legada') returning id into op_b;
    perform pg_temp.reject($q$insert into simpress.operacoes(chave_idempotencia,tipo)
        values ('synthetic-a','importacao_legada')$q$, '23505', 'idempotency key is unique');
    insert into simpress.objetos_arquivo(bucket,chave,sha256,tamanho_bytes,operacao_id)
      values ('synthetic-private','synthetic.xlsx',repeat('a',64),0,op_a) returning id into obj;
    insert into simpress.arquivos_origem(objeto_id,nome_original,papel,parser_versao)
      values (obj,'synthetic-details.xlsx','detalhes','fixture-v1') returning id into file_details;
    insert into simpress.arquivos_origem(objeto_id,nome_original,papel,parser_versao)
      values (obj,'synthetic-endpoint.xlsx','endpoint','fixture-v1') returning id into file_endpoint;
    insert into simpress.lotes_inventario(operacao_id,versao_parser) values (op_a,'fixture-v1') returning id into lot_a;
    insert into simpress.lotes_inventario(operacao_id,versao_parser) values (op_b,'fixture-v1') returning id into lot_b;
    insert into simpress.fontes_lote(lote_id,papel,arquivo_id) values
      (lot_a,'detalhes',file_details),(lot_b,'detalhes',file_details),(lot_a,'endpoint',file_endpoint);
    perform pg_temp.reject(format('update simpress.fontes_lote set arquivo_id=%L where lote_id=%L and papel=''detalhes''',
      file_endpoint,lot_b), '23503', 'source role cannot point to the wrong file role');
    insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,estado_validacao,serie_bruta,serie_normalizada)
      values (lot_a,'detalhes','sheet',2,'duplicada','S-01','S01') returning id into row_a;
    insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,estado_validacao,serie_bruta,serie_normalizada)
      values (lot_a,'detalhes','sheet',3,'duplicada','S-01','S01') returning id into row_a2;
    insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,estado_validacao)
      values (lot_b,'detalhes','sheet',2,'valida') returning id into row_b;
    insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,estado_validacao)
      values (lot_a,'endpoint','sheet',2,'valida') returning id into row_endpoint;
    insert into simpress.equipamentos_lote(lote_id,linha_origem_id,origem,serie_bruta,chave_api,serie_normalizada,id_cliente,retirada_cnpj,retirada_cep)
      values (lot_a,row_a,'importada','S-01','S-01','S01','00012','00123456000100','01234000'),
             (lot_a,row_a2,'importada','S-01','S-01','S01','00012','00123456000100','01234000');
    perform pg_temp.ok((select count(*)=2 from simpress.equipamentos_lote where lote_id=lot_a), 'duplicate raw and normalized serials preserved');
    perform pg_temp.ok((select bool_and(id_cliente='00012' and retirada_cnpj='00123456000100' and retirada_cep='01234000')
      from simpress.equipamentos_lote where lote_id=lot_a), 'identifiers preserve leading zeroes');
    perform pg_temp.reject(format($q$insert into simpress.equipamentos_lote(lote_id,linha_origem_id,origem,serie_bruta,chave_api,serie_normalizada)
      values (%L,%L,'importada','x','x','x')$q$,lot_a,row_b), '23503', 'equipment cannot reference another batch');
    perform pg_temp.reject(format($q$insert into simpress.equipamentos_lote(lote_id,linha_origem_id,origem,serie_bruta,chave_api,serie_normalizada)
      values (%L,%L,'importada','x','x','x')$q$,lot_a,row_endpoint), '23503', 'equipment cannot originate from Endpoint');
    perform pg_temp.reject(format($q$insert into simpress.equipamentos_lote(lote_id,origem,serie_bruta,chave_api,serie_normalizada)
      values (%L,'importada','x','x','x')$q$,lot_a), '23514', 'imported equipment requires original row');
    perform pg_temp.reject(format('delete from simpress.objetos_arquivo where id=%L',obj), '23503', 'referenced original file cannot be deleted');
    perform pg_temp.reject(format('delete from simpress.lotes_inventario where id=%L',lot_a), '23503', 'referenced batch cannot be deleted');

    insert into simpress.apelidos_manuais(chave_serie_original,serie_normalizada,apelido)
      values ('S-01','S01',''),('S01','S01','same normalization');
    perform pg_temp.ok((select count(*)=2 from simpress.apelidos_manuais where serie_normalizada='S01'), 'alias normalization collisions preserved');
    insert into simpress.historico_apelidos(evento_id,ordem_evento,horario_original,registro_original,referencia_id_original)
      values ('legacy/not-a-uuid',0,'invalid legacy date','{}','missing-older-event');
    perform pg_temp.ok((select horario is null and referencia_id_original='missing-older-event'
      from simpress.historico_apelidos where evento_id='legacy/not-a-uuid'), 'invalid date and unresolved legacy reference preserved');

    insert into simpress.eventos_comparacao(evento_id,ordem_evento,tipo,completude,payload_original)
      values ('legacy-event/A',0,'comparacao','completo','{}'),('legacy-event/B',1,'comparacao','completo','{}');
    insert into simpress.eventos_comparacao(evento_id,ordem_evento,tipo,completude,horario_original,protegido_retencao,motivo_protecao)
      values ('shared-only',2,'comparacao','contexto_parcial','invalid date',true,'annotation context');
    insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,payload_canonico,linha_hash)
      values ('legacy-event/A','legacy-item','sem_acesso_14_dias',0,canonical_a,encode(sha256(convert_to(canonical_a,'UTF8')),'hex')),
             ('legacy-event/A','duplicate-data','sem_acesso_14_dias',1,canonical_a,encode(sha256(convert_to(canonical_a,'UTF8')),'hex')),
             ('legacy-event/B','new-item','sem_acesso_14_dias',0,canonical_b,encode(sha256(convert_to(canonical_b,'UTF8')),'hex'));
    insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,contexto_parcial)
      values ('shared-only','partial-item','series_sem_mapeamento',0,true);
    perform pg_temp.ok((select count(*)=2 from simpress.linhas_comparacao where evento_id='legacy-event/A'), 'equal fingerprints do not merge separate rows');
    perform pg_temp.ok((select count(distinct linha_hash)=2 from simpress.linhas_comparacao where payload_canonico is not null), '1 and 1.0 retain different canonical hashes');
    perform pg_temp.ok((select count(distinct payload_canonico)=2 from simpress.linhas_comparacao where payload_canonico is not null), 'canonical text is not rewritten through JSONB');
    perform pg_temp.reject($q$insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,payload_canonico,linha_hash)
      values ('legacy-event/A','bad-hash','sem_acesso_14_dias',2,'["sem_acesso_14_dias",{}]',repeat('0',64))$q$,
      '23514', 'canonical hash mismatch rejected');
    perform pg_temp.reject($q$insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha)
      values ('legacy-event/A','missing-payload','sem_acesso_14_dias',2)$q$, '23514', 'complete row requires canonical payload');
    foreach bad_canonical in array array['[null,{}]','["different-category",{}]','["sem_acesso_14_dias",{"anotacao":"excluded metadata"}]'] loop
      perform pg_temp.reject(format($q$insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,payload_canonico,linha_hash)
        values ('legacy-event/A','bad-category','sem_acesso_14_dias',2,%L,%L)$q$,
        bad_canonical,encode(sha256(convert_to(bad_canonical,'UTF8')),'hex')),
        '23514', 'invalid category or annotation metadata rejected: ' || bad_canonical);
    end loop;
    insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,payload_canonico,linha_hash)
      values ('legacy-event/B','unicode-item','series_sem_mapeamento',1,unicode_canonical,encode(sha256(convert_to(unicode_canonical,'UTF8')),'hex'));
    perform pg_temp.ok((select payload_canonico=unicode_canonical from simpress.linhas_comparacao where item_id='unicode-item'),
      'UTF-8 and null values preserved in canonical text');
    insert into simpress.anotacoes(evento_id,item_id,texto,origem) values
      ('legacy-event/A','legacy-item','','legada'),
      ('legacy-event/A','duplicate-data',repeat('x',2000),'local'),
      ('shared-only','partial-item','shared note','compartilhada'),
      ('legacy-event/B','new-item','independent annotation','reaplicada');
    perform pg_temp.ok((select texto='' from simpress.anotacoes where evento_id='legacy-event/A' and item_id='legacy-item'), 'empty note preserved');
    perform pg_temp.ok((select char_length(texto)=2000 from simpress.anotacoes where item_id='duplicate-data'), '2000-character note accepted');
    update simpress.anotacoes set texto=repeat('é',2000) where item_id='duplicate-data';
    perform pg_temp.ok((select char_length(texto)=2000 and octet_length(texto)=4000 from simpress.anotacoes where item_id='duplicate-data'),
      'note limit counts Unicode characters rather than UTF-8 bytes');
    perform pg_temp.ok((select linha_hash is null from simpress.linhas_comparacao where evento_id='shared-only'), 'legacy shared context without hash remains representable');
    perform pg_temp.reject($q$update simpress.anotacoes set texto=repeat('x',2001) where item_id='duplicate-data'$q$,
      '23514', '2001-character note rejected');
    perform pg_temp.reject($q$insert into simpress.anotacoes(evento_id,item_id,texto,origem)
      values ('legacy-event/B','legacy-item','wrong event','local')$q$, '23503', 'annotation cannot attach to an item from another event');
    perform pg_temp.reject($q$insert into simpress.anotacoes(evento_id,item_id,texto,origem)
      values ('legacy-event/A','legacy-item','duplicate','local')$q$, '23505', 'one active annotation per event and item');
    perform pg_temp.reject($q$delete from simpress.linhas_comparacao where evento_id='legacy-event/A' and item_id='legacy-item'$q$,
      '23503', 'annotated row cannot be deleted');
    perform pg_temp.reject($q$delete from simpress.eventos_comparacao where evento_id='shared-only'$q$,
      '23503', 'shared-only event cannot cascade away its annotation');
    insert into simpress.pendencias_sincronizacao(evento_id,item_id,versao_alvo,destino,payload)
      values ('shared-only','partial-item',1,'shared-folder','{}');
    perform pg_temp.reject($q$insert into simpress.pendencias_sincronizacao(evento_id,item_id,versao_alvo,destino,payload)
      values ('shared-only','partial-item',1,'shared-folder','{}')$q$, '23505', 'outbox target and version are idempotent');
end $$;

-- First prove grants are closed, independently of RLS.
-- Supabase grants postgres ADMIN but not SET on newly created roles.
-- Permit this test administrator to impersonate runtime only inside this rollback.
grant simpress_runtime to postgres with set true;
do $$
declare
    role_name text;
    denied boolean;
    t record;
begin
    foreach role_name in array array['anon','authenticated','service_role','simpress_runtime'] loop
        perform pg_temp.ok(not has_schema_privilege(role_name,'simpress','USAGE'), role_name || ' has no schema usage');
        for t in select tablename from pg_tables where schemaname='simpress' loop
            if has_table_privilege(role_name,format('simpress.%I',t.tablename),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
                raise exception 'Unexpected privilege for role % on %',role_name,t.tablename;
            end if;
        end loop;
        perform pg_temp.ok(true,role_name || ' has no domain table privileges');
        denied := false;
        begin
            execute format('set local role %I',role_name);
            perform * from simpress.configuracao;
        exception when insufficient_privilege then
            denied := true;
        end;
        reset role;
        perform pg_temp.ok(denied,role_name || ' direct query denied');
    end loop;
end $$;

-- Temporary grants isolate the RLS behavior. They are rolled back at the end.
grant usage on schema simpress to anon, authenticated, simpress_runtime;
grant select, insert, update, delete on all tables in schema simpress to anon, authenticated, simpress_runtime;
do $$
declare
    role_name text;
    t record;
    n bigint;
    denied boolean;
begin
    foreach role_name in array array['anon','authenticated','simpress_runtime'] loop
        for t in select tablename from pg_tables where schemaname='simpress' loop
            execute format('set local role %I',role_name);
            execute format('select count(*) from simpress.%I',t.tablename) into n;
            reset role;
            if n <> 0 then raise exception 'RLS leak for % on %',role_name,t.tablename; end if;
        end loop;
        perform pg_temp.ok(true,role_name || ' RLS hides all domain rows');
        denied := false;
        begin
            execute format('set local role %I',role_name);
            insert into simpress.apelidos_manuais(chave_serie_original,serie_normalizada,apelido) values ('denied','denied','denied');
        exception when insufficient_privilege then
            denied := true;
        end;
        reset role;
        perform pg_temp.ok(denied,role_name || ' RLS rejects insert');
        execute format('set local role %I',role_name);
        update simpress.configuracao set retencao_operacional_dias=1;
        get diagnostics n = row_count;
        reset role;
        perform pg_temp.ok(n=0,role_name || ' RLS prevents update');
        execute format('set local role %I',role_name);
        delete from simpress.apelidos_manuais;
        get diagnostics n = row_count;
        reset role;
        perform pg_temp.ok(n=0,role_name || ' RLS prevents delete');
    end loop;
end $$;

select 'PASS: ' || count(*) || ' structural, integrity and access assertions; fixtures will roll back.' as result from etapa_4_results;
rollback;
