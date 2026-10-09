-- No account, password, allow policy, or operational data is provisioned here.
do $migration$
begin
    if not exists (select 1 from pg_roles where rolname = 'simpress_runtime') then
        create role simpress_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
    elsif exists (
        select 1 from pg_roles where rolname = 'simpress_runtime'
        and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls)
    ) or exists (
        select 1 from pg_auth_members
        where member = 'simpress_runtime'::regrole
           or (roleid = 'simpress_runtime'::regrole
               and (member <> 'postgres'::regrole or inherit_option or set_option))
    ) then
        raise exception 'Existing simpress_runtime role is not the expected isolated NOLOGIN role';
    end if;
end
$migration$;

revoke all on schema simpress from public, anon, authenticated, service_role, simpress_runtime;
revoke all on all tables in schema simpress from public, anon, authenticated, service_role, simpress_runtime;
revoke all on all sequences in schema simpress from public, anon, authenticated, service_role, simpress_runtime;
revoke all on all functions in schema simpress from public, anon, authenticated, service_role, simpress_runtime;
alter default privileges in schema simpress revoke all on tables from public, anon, authenticated, service_role, simpress_runtime;
alter default privileges in schema simpress revoke all on sequences from public, anon, authenticated, service_role, simpress_runtime;
alter default privileges in schema simpress revoke all on functions from public, anon, authenticated, service_role, simpress_runtime;

do $migration$
declare
    domain_table record;
begin
    for domain_table in select tablename from pg_tables where schemaname = 'simpress' loop
        execute format('alter table simpress.%I enable row level security', domain_table.tablename);
        execute format('alter table simpress.%I force row level security', domain_table.tablename);
    end loop;
end
$migration$;

insert into simpress.configuracao (id) values (1);
insert into simpress.estado_aplicacao (id) values (1);
