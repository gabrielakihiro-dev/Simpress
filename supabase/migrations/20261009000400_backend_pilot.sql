-- Stage 5: trusted backend for a disposable LOOPBACK pilot, not user authorization.
-- Runtime/Auth roles remain closed. Stage 7 must replace/revoke this pilot role.
do $role$
begin
    if not exists(select 1 from pg_roles where rolname='simpress_piloto') then
        create role simpress_piloto nologin nosuperuser nocreatedb nocreaterole
            noinherit noreplication nobypassrls;
    elsif exists(select 1 from pg_roles where rolname='simpress_piloto' and
        (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls))
        or exists(select 1 from pg_auth_members where member='simpress_piloto'::regrole) then
        raise exception 'Existing simpress_piloto role is unsafe';
    end if;
end
$role$;
revoke all on schema simpress from simpress_piloto;
grant usage on schema simpress to simpress_piloto;

alter table simpress.operacoes add column resultado jsonb
    check (resultado is null or jsonb_typeof(resultado) = 'object');

grant select on simpress.configuracao, simpress.estado_aplicacao,
    simpress.lotes_inventario, simpress.fontes_lote, simpress.linhas_fonte,
    simpress.arquivos_origem, simpress.equipamentos_lote,
    simpress.unidades_catalogo, simpress.unidades_customizadas,
    simpress.apelidos_manuais, simpress.historico_apelidos, simpress.operacoes
    to simpress_piloto;
grant update (revisao_global, atualizado_em) on simpress.estado_aplicacao to simpress_piloto;
grant insert on simpress.equipamentos_lote, simpress.operacoes to simpress_piloto;
grant update (modelo, tipo, id_cliente, versao, atualizado_em) on simpress.equipamentos_lote to simpress_piloto;
grant insert, update on simpress.unidades_catalogo,
    simpress.unidades_customizadas, simpress.apelidos_manuais to simpress_piloto;
grant delete on simpress.apelidos_manuais to simpress_piloto;
grant insert, delete on simpress.historico_apelidos to simpress_piloto;
grant usage on sequence simpress.historico_apelidos_ordem_evento_seq to simpress_piloto;

do $policies$
declare t text;
begin
    foreach t in array array['configuracao', 'estado_aplicacao', 'lotes_inventario',
        'fontes_lote', 'linhas_fonte', 'arquivos_origem', 'equipamentos_lote',
        'unidades_catalogo', 'unidades_customizadas', 'apelidos_manuais',
        'historico_apelidos', 'operacoes'] loop
        execute format('create policy piloto_local on simpress.%I to simpress_piloto
            using (current_setting(''simpress.piloto_local'', true) = ''on'')
            with check (current_setting(''simpress.piloto_local'', true) = ''on'')', t);
    end loop;
end
$policies$;

-- No login/password, identity, source data, active batch, or Storage grant here.
