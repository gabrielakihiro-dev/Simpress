-- Stage 6 is still an unauthenticated, loopback-only disposable pilot.
-- No Storage/Auth policies, buckets, credentials or operational data here.
alter table simpress.operacoes add column plano jsonb not null default '{}'::jsonb
    check (jsonb_typeof(plano) = 'object');
alter table simpress.operacoes add column executor_id uuid;
alter table simpress.eventos_comparacao add column excluido_em timestamptz;

grant select on all tables in schema simpress to simpress_piloto;
grant insert on simpress.objetos_arquivo, simpress.arquivos_origem,
    simpress.lotes_inventario, simpress.fontes_lote, simpress.linhas_fonte,
    simpress.eventos_comparacao, simpress.linhas_comparacao, simpress.anotacoes,
    simpress.backups_logicos, simpress.referencias_backup, simpress.conflitos_importacao to simpress_piloto;
grant update on simpress.operacoes, simpress.objetos_arquivo,
    simpress.anotacoes, simpress.lotes_inventario to simpress_piloto;
grant update (lote_ativo_id, modelo_transferencia_id, modelo_exportacao_id)
    on simpress.estado_aplicacao to simpress_piloto;
grant update (excluido_em,fixado,restauracao_de_original,restauracao_de_evento_id) on simpress.eventos_comparacao to simpress_piloto;
grant update (estado_operacional) on simpress.linhas_comparacao to simpress_piloto;
grant usage on sequence simpress.eventos_comparacao_ordem_evento_seq to simpress_piloto;

do $policies$
declare t text;
begin
    foreach t in array array['objetos_arquivo','eventos_comparacao','linhas_comparacao',
        'anotacoes','pendencias_sincronizacao','backups_logicos','referencias_backup',
        'conflitos_importacao'] loop
        execute format('create policy piloto_local on simpress.%I to simpress_piloto
            using (current_setting(''simpress.piloto_local'', true) = ''on'')
            with check (current_setting(''simpress.piloto_local'', true) = ''on'')', t);
    end loop;
end
$policies$;

create index eventos_visiveis_idx on simpress.eventos_comparacao(ordem_evento)
    where excluido_em is null;
