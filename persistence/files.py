"""Recoverable SQL/Storage saga for the disposable local pilot.

SQL prepares intent, Storage verifies immutable bytes, SQL commits visibility.
The same request/key resumes an interrupted upload. Recovery never guesses a
rollback after a lost COMMIT reply, and deletion only visits journaled orphans.
"""

from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
from pathlib import Path
import re
import uuid
from typing import Any

from psycopg.types.json import Jsonb

from persistence.comparison_history import ComparisonHistory
from persistence.comparison_history import parsed_time
from persistence.config import PersistenceError
from persistence.inventory_projection import derived_units, equipment_rows, source_rows
from persistence.postgres import canonical
from persistence.storage import BUCKET, LocalStorage, XLSX

EQUIPMENT = ("serie_bruta", "chave_api", "serie_normalizada", "modelo", "tipo", "apelido_base", "id_cliente",
    "contrato", "razao_social", "endereco_instalacao", "retirada_cnpj", "retirada_endereco", "retirada_cidade", "retirada_uf", "retirada_cep", "unidade_id", "revisao_legada")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def ready(value):
    return json.loads(json.dumps(value, default=str))


class PostgresFiles:
    def __init__(self, backend, storage=None):
        self.backend = backend
        self.storage = storage
        self.history = ComparisonHistory(backend)

    def require_storage(self):
        if self.storage is None:
            raise PersistenceError(503, "Ative o Storage do piloto pelo iniciador local com --storage.")
        self.storage.ensure_private_bucket()
        return self.storage

    def capture(self, conn, state):
        batch = state["lote_ativo_id"]
        sources = conn.execute("""select f.*,a.nome_original,a.objeto_id,o.chave,o.sha256,o.tamanho_bytes,o.mime_type,o.bucket,o.estado
            from simpress.fontes_lote f join simpress.arquivos_origem a on a.id=f.arquivo_id
            join simpress.objetos_arquivo o on o.id=a.objeto_id where f.lote_id=%s order by f.papel""", (batch,)).fetchall()
        objects = [dict(s,id=s["objeto_id"]) for s in sources]
        for column in ("modelo_transferencia_id", "modelo_exportacao_id"):
            if state[column]:
                objects.extend(conn.execute("select * from simpress.objetos_arquivo where id=%s", (state[column],)).fetchall())
        return ready({"version": 1, "state": state,
            "equipment": conn.execute("select * from simpress.equipamentos_lote where lote_id=%s order by atualizado_em,id", (batch,)).fetchall(),
            "lines": conn.execute("select * from simpress.linhas_fonte where lote_id=%s order by ordem_aba,numero_linha", (batch,)).fetchall(),
            "sources": sources, "objects": objects,
            "units": conn.execute("select * from simpress.unidades_catalogo order by id").fetchall(),
            "customs": conn.execute("select * from simpress.unidades_customizadas order by unidade_id").fetchall(),
            "aliases": conn.execute("select * from simpress.apelidos_manuais order by chave_serie_original").fetchall()})

    def update(self, staged, key=None):
        # Validation happens before journaling, even for programmatic callers.
        d = self.backend.domain
        staged = {role: {**staged[role], "table": d.validate_uploaded_workbook(staged[role]["bytes"],role)} for role in ("endpoint", "detalhes")}
        equipment_rows(staged["detalhes"]["table"],d)
        request = {r:{"name":s["name"],"sha256":digest(s["bytes"])} for r,s in staged.items()}
        blobs = {r:s["bytes"] for r,s in staged.items()}
        return self.run("update", request, blobs, key)

    def template(self, kind, name, data, key=None):
        if kind not in {"transferencia", "exportacao"}:
            raise PersistenceError(422, "Tipo de modelo inválido.")
        self.backend.domain.validate_xlsx_package(data)
        return self.run("template", {"kind":kind,"name":name,"sha256":digest(data)}, {"modelo":data}, key)

    def annotations(self, name, data, key=None):
        try:
            document = json.loads(data)
            if not isinstance(document,dict) or not isinstance(document.get("historico",[]),list) or not isinstance(document.get("anotacoes",[]),list):
                raise ValueError
        except (ValueError,UnicodeError):
            raise PersistenceError(422, "Use um JSON com listas historico e anotacoes.") from None
        return self.run("annotations",{"name":name,"sha256":digest(data)},{"anotacoes":data},key)

    def import_annotations(self, conn, op, blobs):
        document = json.loads(blobs["anotacoes"])
        obj = next(o for o in op["artefatos_origem"] if o["role"] == "anotacoes")
        conn.execute("""insert into simpress.arquivos_origem(objeto_id,nome_original,papel,parser_versao)
            values (%s,%s,'artefato_legado','etapa6-v1')""",(obj["id"],op["plano"]["request"]["name"]))
        conflicts = 0
        def conflict(event,item,reason):
            nonlocal conflicts
            conflicts += 1
            conn.execute("""insert into simpress.conflitos_importacao(operacao_id,entidade,chave_original,
                local_origem,motivo_codigo,artefato_objeto_id) values (%s,'anotacao',%s,%s,%s,%s)""",
                (op["id"],str(event)+":"+str(item),op["plano"]["request"]["name"],reason,obj["id"]))
        for event in document.get("historico",[]):
            if not isinstance(event,dict) or not isinstance(event.get("id"),str) or not event["id"].strip() or not isinstance(event.get("comparacao"),dict):
                raise PersistenceError(422, "Evento legado inválido; nenhum registro importado.")
            previous = conn.execute("select payload_original from simpress.eventos_comparacao where evento_id=%s",(event["id"],)).fetchone()
            if previous:
                if previous["payload_original"] != canonical(event):
                    conflict(event["id"],"","EVENT_PAYLOAD_CONFLICT")
                continue
            self.history.insert(conn,event,operation=op["id"])
        for record in document.get("anotacoes",[]):
            if not isinstance(record,dict):
                raise PersistenceError(422, "Registro de anotação inválido.")
            event,item,text = record.get("evento_id"),record.get("item_id"),record.get("anotacao")
            category = record.get("categoria","apelidos_sem_atualizacao")
            from domains.inventory_update import _ANNOTATABLE_COMPARISON_CATEGORIES
            if (not isinstance(event,str) or not event.strip() or not isinstance(item,str) or not item.strip()
                    or not isinstance(text,str) or len(text)>2000 or category not in _ANNOTATABLE_COMPARISON_CATEGORIES):
                raise PersistenceError(422, "Identidade, seção ou texto inválido na anotação legada.")
            fingerprint = record.get("linha_hash")
            if fingerprint is not None and (not isinstance(fingerprint,str) or not re.fullmatch(r"[0-9a-f]{64}",fingerprint)):
                raise PersistenceError(422, "Assinatura inválida na anotação legada.")
            target_event = conn.execute("select excluido_em from simpress.eventos_comparacao where evento_id=%s",(event,)).fetchone()
            if target_event and target_event["excluido_em"] is not None:
                conflict(event,item,"EVENT_DELETED")
                continue
            previous = conn.execute("select categoria,linha_hash from simpress.linhas_comparacao where evento_id=%s and item_id=%s",(event,item)).fetchone()
            if previous and (previous["categoria"] != category or (fingerprint and previous["linha_hash"] != fingerprint)):
                conflict(event,item,"ROW_IDENTITY_CONFLICT")
                continue
            if not previous:
                event_row = conn.execute("select completude from simpress.eventos_comparacao where evento_id=%s",(event,)).fetchone()
                if event_row and event_row["completude"] == "completo":
                    conflict(event,item,"ROW_NOT_IN_EVENT")
                    continue
                conn.execute("""insert into simpress.eventos_comparacao(evento_id,tipo,horario_original,horario,completude,operacao_id,protegido_retencao,motivo_protecao)
                    values (%s,'comparacao',%s,%s,'contexto_parcial',%s,true,'anotacao legada sem historico local') on conflict(evento_id) do nothing""",
                    (event,record.get("horario"),parsed_time(record.get("horario")),op["id"]))
                order = conn.execute("select count(*) as n from simpress.linhas_comparacao where evento_id=%s and categoria=%s",(event,category)).fetchone()["n"]
                context = {k:record.get(k,"") for k in ("serie","computador","motivo")}
                conn.execute("""insert into simpress.linhas_comparacao(evento_id,item_id,categoria,ordem_linha,dados_consulta,linha_hash,contexto_parcial)
                    values (%s,%s,%s,%s,%s,%s,true)""",(event,item,category,order,Jsonb(context),fingerprint))
            existing = conn.execute("select * from simpress.anotacoes where evento_id=%s and item_id=%s",(event,item)).fetchone()
            timestamp = parsed_time(record.get("atualizado_em"))
            if existing:
                if existing["texto"] == text:
                    continue
                if existing["atualizado_em"] is None or timestamp is None or timestamp <= existing["atualizado_em"]:
                    conflict(event,item,"ANNOTATION_VERSION_CONFLICT")
                    continue
            conn.execute("""insert into simpress.anotacoes(evento_id,item_id,texto,origem,atualizado_em,atualizado_em_original)
                values (%s,%s,%s,'compartilhada',%s,%s) on conflict(evento_id,item_id) do update set
                texto=excluded.texto,origem=excluded.origem,atualizado_em=excluded.atualizado_em,
                atualizado_em_original=excluded.atualizado_em_original,versao=simpress.anotacoes.versao+1""",
                (event,item,text,timestamp,record.get("atualizado_em")))
        return {"sucesso":True,"conflitos":conflicts,"operacao_id":str(op["id"])}

    def run(self, kind, request, blobs, key=None):
        storage = self.require_storage()
        if key is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", key):
            raise PersistenceError(422, "Idempotency-Key inválida.")
        identity = "files_" + kind + ":" + (key or uuid.uuid4().hex)
        owner = uuid.uuid4()
        request_hash = digest(canonical(request).encode())
        with self.backend.transaction(write=True) as conn:
            state = conn.execute("select * from simpress.estado_aplicacao where id=1 for update").fetchone()
            op = conn.execute("select *,lease_ate>now() as leased from simpress.operacoes where chave_idempotencia=%s for update", (identity,)).fetchone()
            if op and op["pedido_sha256"] != request_hash:
                raise PersistenceError(409, "Idempotency-Key já usada com outro pedido.")
            if op and op["estado"] == "confirmada":
                result = op["resultado"]
                return_after_commit = True
            else:
                return_after_commit = False
                if op and (op["estado"] == "cancelada" or op["leased"]):
                    raise PersistenceError(409, "Operação cancelada ou em execução; confira seu estado antes de repetir.")
                if not op:
                    plan = {"kind":kind,"request":request,"event_id":uuid.uuid4().hex,
                        "time":datetime.now().astimezone().isoformat(timespec="seconds")}
                    if kind in {"update", "restore"}:
                        plan["before"] = self.capture(conn,state)
                    op = conn.execute("""insert into simpress.operacoes(chave_idempotencia,tipo,estado,pedido_sha256,revisao_esperada,plano)
                        values (%s,%s,'arquivos_pendentes',%s,%s,%s) returning *""", (identity,
                        {"update":"atualizacao_inventario","restore":"restauracao","template":"edicao","annotations":"importacao_legada"}[kind],
                        request_hash,state["revisao_global"],Jsonb(plan))).fetchone()
                    extra = {"backup":canonical(plan["before"]).encode()} if "before" in plan else {}
                    artifacts = []
                    for role,data in {**blobs,**extra}.items():
                        sha = digest(data)
                        obj = {"id":str(uuid.uuid4()),"bucket":BUCKET,"chave":str(op["id"])+"/"+role+"-"+sha,
                            "sha256":sha,"tamanho_bytes":len(data),"mime_type":"application/json" if role in {"backup","restauracao","anotacoes"} else XLSX,"role":role}
                        conn.execute("""insert into simpress.objetos_arquivo(id,bucket,chave,sha256,tamanho_bytes,mime_type,operacao_id)
                            values (%s,%s,%s,%s,%s,%s,%s)""", (*[obj[k] for k in ("id","bucket","chave","sha256","tamanho_bytes","mime_type")],op["id"]))
                        artifacts.append(obj)
                    conn.execute("update simpress.operacoes set artefatos_origem=%s where id=%s",(Jsonb(artifacts),op["id"]))
                    op["artefatos_origem"] = artifacts
                if op["revisao_esperada"] != state["revisao_global"]:
                    raise PersistenceError(409, "O estado mudou após a preparação; cancele a operação e envie um novo pedido.")
                if kind == "restore" and request["revision"] != state["revisao_global"]:
                    raise PersistenceError(409, "O estado mudou desde a prévia de restauração.")
                conn.execute("""update simpress.operacoes set executor_id=%s,lease_ate=now()+interval '2 minutes',
                    tentativas=tentativas+1,erro_codigo=null,atualizado_em=now() where id=%s""",(owner,op["id"]))
        if return_after_commit:
            return result
        try:
            if "before" in op["plano"]:
                blobs = {**blobs,"backup":canonical(op["plano"]["before"]).encode()}
                for obj in op["plano"]["before"]["objects"]:
                    if obj["estado"] != "verificado":
                        raise PersistenceError(409, "Uma referência do estado anterior não está verificada.")
                    self.renew(op["id"],owner)
                    storage.get(obj)
            for obj in op["artefatos_origem"]:
                self.renew(op["id"],owner)
                storage.put(obj,blobs[obj["role"]])
            return self.finish(op,owner,blobs)
        except Exception:
            # Never overwrite confirmed status after an uncertain COMMIT.
            with self.backend.transaction(write=True) as conn:
                conn.execute("""update simpress.operacoes set estado='falhou',erro_codigo='RETRY_SAME_REQUEST',
                    lease_ate=null,executor_id=null,atualizado_em=now() where id=%s and executor_id=%s
                    and estado not in ('confirmada','cancelada')""",(op["id"],owner))
            raise

    def renew(self, operation, owner):
        with self.backend.transaction(write=True) as conn:
            result = conn.execute("""update simpress.operacoes set lease_ate=now()+interval '2 minutes'
                where id=%s and executor_id=%s and lease_ate>now()
                and estado not in ('confirmada','cancelada')""",(operation,owner))
            if result.rowcount != 1:
                raise PersistenceError(409, "O executor da operação perdeu sua reserva; confira o estado antes de repetir.")

    def finish(self, op, owner, blobs):
        with self.backend.transaction(write=True) as conn:
            state = conn.execute("select * from simpress.estado_aplicacao where id=1 for update").fetchone()
            live = conn.execute("select *,lease_ate>now() as leased from simpress.operacoes where id=%s for update",(op["id"],)).fetchone()
            if live["estado"] == "confirmada":
                result = live["resultado"]
            else:
                if live["executor_id"] != owner or not live["leased"] or state["revisao_global"] != op["revisao_esperada"]:
                    raise PersistenceError(409, "A revisão ou o executor mudou; nenhum lote foi ativado.")
                for obj in op["artefatos_origem"]:
                    conn.execute("update simpress.objetos_arquivo set estado='verificado',verificado_em=now() where id=%s and estado='pendente'",(obj["id"],))
                conn.execute("update simpress.operacoes set estado='arquivos_verificados' where id=%s",(op["id"],))
                backup = self.record_backup(conn,op) if "before" in op["plano"] else None
                kind = op["plano"]["kind"]
                if kind == "template":
                    obj = next(a for a in op["artefatos_origem"] if a["role"] == "modelo")
                    column = {"exportacao":"modelo_exportacao_id","transferencia":"modelo_transferencia_id"}[op["plano"]["request"]["kind"]]
                    conn.execute("update simpress.estado_aplicacao set " + column + "=%s where id=1",(obj["id"],))
                    result = {"sucesso":True,"objeto_id":obj["id"]}
                elif kind == "update":
                    result = self.activate_upload(conn,op,blobs,backup)
                elif kind == "annotations":
                    result = self.import_annotations(conn,op,blobs)
                else:
                    result = self.activate_restore(conn,op,blobs,backup)
                conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1,atualizado_em=now() where id=1")
                # Prepare response/projection before COMMIT. No process-global cache.
                if kind in {"update", "restore"}:
                    result["stats"] = self.backend.project(self.backend._snapshot(conn))["stats_cache"]
                conn.execute("""update simpress.operacoes set estado='confirmada',resultado=%s,revisao_confirmada=%s,
                    executor_id=null,lease_ate=null,erro_codigo=null,atualizado_em=now() where id=%s""",
                    (Jsonb(result),state["revisao_global"]+1,op["id"]))
        return result

    def record_backup(self, conn, op):
        obj = next(a for a in op["artefatos_origem"] if a["role"] == "backup")
        backup = conn.execute("""insert into simpress.backups_logicos(operacao_id,tipo,revisao_global,
            versao_esquema,manifesto_objeto_id,manifesto_sha256,estado,protegido)
            values (%s,%s,%s,'etapa6-v1',%s,%s,'disponivel',true) returning id""",
            (op["id"],"anterior_restauracao" if op["plano"]["kind"] == "restore" else "anterior_atualizacao",
             op["revisao_esperada"],obj["id"],obj["sha256"])).fetchone()["id"]
        refs = {o["id"]:o for o in op["plano"]["before"]["objects"]}
        refs[obj["id"]] = obj
        for index,oid in enumerate(refs):
            conn.execute("insert into simpress.referencias_backup(backup_id,objeto_id,papel,ordem) values (%s,%s,'snapshot',%s)", (backup,oid,index))
        return backup

    def new_batch(self, conn, op):
        return conn.execute("""insert into simpress.lotes_inventario(operacao_id,anterior_id,estado,versao_parser)
            values (%s,(select lote_ativo_id from simpress.estado_aplicacao where id=1),'validado','etapa6-v1') returning id""", (op["id"],)).fetchone()["id"]

    def insert_equipment(self, conn, batch, row, origin=None):
        columns = ",".join(EQUIPMENT)
        conn.execute("insert into simpress.equipamentos_lote(lote_id,origem,linha_origem_id," + columns + ") values (" + ",".join(["%s"]*(len(EQUIPMENT)+3)) + ")",
            (batch,"importada" if origin else "manual",origin,*[row.get(k) for k in EQUIPMENT]))

    def activate_upload(self, conn, op, blobs, backup):
        d = self.backend.domain
        names = {r:s["name"] for r,s in op["plano"]["request"].items()}
        staged = {r:{"name":names[r],"bytes":blobs[r],"table":d.validate_uploaded_workbook(blobs[r],r)} for r in ("endpoint","detalhes")}
        rows = equipment_rows(staged["detalhes"]["table"],d)
        previous = self.backend.project(self.backend._snapshot(conn))
        comparison = d.compare_uploaded_workbooks(staged["endpoint"]["table"],staged["detalhes"]["table"],names,as_of=datetime.fromisoformat(op["plano"]["time"]))
        batch = self.new_batch(conn,op)
        for role in ("endpoint","detalhes"):
            obj = next(o for o in op["artefatos_origem"] if o["role"] == role)
            source = conn.execute("""insert into simpress.arquivos_origem(objeto_id,nome_original,papel,parser_versao,estrutura_abas)
                values (%s,%s,%s,'etapa6-v1',%s) returning id""", (obj["id"],names[role],role,Jsonb([staged[role]["table"]["sheet"]]))).fetchone()["id"]
            conn.execute("insert into simpress.fontes_lote(lote_id,papel,arquivo_id,estado_validacao,contagem_linhas) values (%s,%s,%s,'valido',%s)",
                (batch,role,source,len(staged[role]["table"]["records"])))
        origins = {}
        for row in source_rows(staged,d):
            origin = conn.execute("""insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,serie_bruta,
                serie_normalizada,dados_interpretados,estado_validacao,celulas) values (%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                (batch,row["papel"],row["aba"],row["numero_linha"],row["serie_bruta"],row["serie_normalizada"],Jsonb(row["dados_interpretados"]),row["estado_validacao"],Jsonb(row["celulas"]))).fetchone()["id"]
            origins[(row["papel"],row["numero_linha"])] = origin
        for row in rows:
            self.insert_equipment(conn,batch,row,origins[("detalhes",row["source_row"])])
        self.merge_units(conn,batch,derived_units(rows,d))
        conn.execute("update simpress.estado_aplicacao set lote_ativo_id=%s where id=1",(batch,))
        after_snapshot = self.backend._snapshot(conn)
        after = self.backend.project(after_snapshot)
        comparison["apelidos_atualizados"] = d.compare_equipment_aliases(d.snapshot_equipment_aliases(previous["equipamentos_cache"]), d.snapshot_equipment_aliases(after["equipamentos_cache"]))
        comparison["total_equipamentos_carregados"] = after["stats_cache"]["total_equipamentos"]
        counts = Counter(r["serie_normalizada"] for r in rows)
        endpoint = self.endpoint_index(staged["endpoint"]["table"]["records"])
        comparison["apelidos_sem_atualizacao"] = d.endpoint_alias_review_items(endpoint,set(counts),{s for s,n in counts.items() if n>1})
        for record in staged["detalhes"]["table"]["records"]:
            alias = d._upload_alias_value(record,"detalhes")
            if alias and not d.normalize_reference_value(d._upload_serial_value(record,"detalhes")):
                comparison["apelidos_sem_atualizacao"].append({"serie":"","computador":alias,"motivo":"Número de série vazio na Simpress; nenhum hostname foi associado."})
        manual = d._manual_alias_source_snapshots(previous["aliases"],staged["endpoint"]["table"],staged["detalhes"]["table"])
        comparison["fontes_apelidos_manuais"] = manual
        comparison["divergencias_apelidos_manuais"] = [r for r in manual if r["diverge_detalhes"] or r["diverge_invall"]]
        refreshed = [d.normalize_reference_value(r["serie"]) for r in manual if r.get("detalhes_encontrado") or r.get("invall_encontrado")]
        if refreshed:
            prior = conn.execute("""select id,dados_consulta from simpress.linhas_comparacao
                where categoria='divergencias_apelidos_manuais' and
                coalesce(estado_operacional->>'resolucao',dados_consulta->>'resolucao','pendente')='pendente'""").fetchall()
            for row in prior:
                if d.normalize_reference_value(row["dados_consulta"].get("serie")) in refreshed:
                    conn.execute("update simpress.linhas_comparacao set estado_operacional=%s where id=%s",
                        (Jsonb({"resolucao":"substituida","horario_resolucao":op["plano"]["time"]}),row["id"]))
        return self.record_event(conn,op,batch,backup,comparison,names)

    def merge_units(self, conn, batch, units):
        d = self.backend.domain
        existing = conn.execute("select id,source_key,origem from simpress.unidades_catalogo").fetchall()
        reserved = {u["id"] for u in existing}
        conn.execute("update simpress.unidades_catalogo set ativa=false where origem='derivada'")
        for unit in units:
            selected = next((r for r in existing if r["source_key"] == unit["_source_key"]),None)
            if selected and selected["origem"] == "customizada":
                continue
            uid = selected["id"] if selected else d._stable_unit_id(unit,reserved)
            reserved.add(uid)
            conn.execute("""insert into simpress.unidades_catalogo(id,source_key,origem_lote_id,origem,cidade,endereco,uf,cep,cnpj)
                values (%s,%s,%s,'derivada',%s,%s,%s,%s,%s) on conflict(id) do update set ativa=true,
                origem_lote_id=excluded.origem_lote_id,cidade=excluded.cidade,endereco=excluded.endereco,
                uf=excluded.uf,cep=excluded.cep,cnpj=excluded.cnpj,versao=simpress.unidades_catalogo.versao+1""",
                (uid,unit["_source_key"],batch,*[unit[k] for k in ("cidade","endereco","uf","cep","cnpj")]))

    def endpoint_index(self, records):
        groups: dict[str,list[dict[str,str]]] = {}
        blank_serials = []
        d = self.backend.domain
        for record in records:
            raw_serial = str(d._upload_serial_value(record,"endpoint") or "").strip()
            serial = d.normalize_reference_value(raw_serial)
            item = {"serie":raw_serial,"hostname":d._upload_alias_value(record,"endpoint")}
            if serial:
                groups.setdefault(serial,[]).append(item)
            elif item["hostname"]:
                blank_serials.append(item)
        return {"available":True,"unique":{s:a[0]["hostname"] for s,a in groups.items() if len(a)==1 and a[0]["hostname"]},
            "duplicates":{s:a for s,a in groups.items() if len(a)>1},"blank_serials":blank_serials,
            "blank_hostnames":{s:a[0] for s,a in groups.items() if len(a)==1 and not a[0]["hostname"]}}

    def record_event(self, conn, op, batch, backup, comparison, names, *, restoration=None):
        eid, time = op["plano"]["event_id"],op["plano"]["time"]
        comparison.update(evento_id=eid,horario_comparacao=time,arquivos_enviados=names,
            backup_diretorio="storage:"+str(backup),historico_salvo=True)
        for change in comparison.get("apelidos_atualizados",[]):
            change.update(arquivos_origem=names,horario=time)
        summary = {k:len(v) for k,v in comparison.items() if isinstance(v,list)}
        summary["total_endpoint"] = comparison.get("total_endpoint",0)
        event = {"id":eid,"horario":time,"arquivos_enviados":names,"resumo":summary,"comparacao":comparison}
        if restoration:
            event["tipo"] = "restauracao"
            event["restauracao_de"] = restoration
            event["arquivos_restaurados"] = names
            comparison.update(tipo_operacao="restauracao",restauracao_de=restoration,arquivos_restaurados=names)
        self.history.insert(conn,event,batch=batch,operation=op["id"],backup=backup,reapply=not restoration)
        if restoration:
            conn.execute("update simpress.eventos_comparacao set restauracao_de_original=%s,restauracao_de_evento_id=%s where evento_id=%s",
                (restoration["id"],restoration["id"],eid))
        if restoration:
            conn.execute("update simpress.linhas_comparacao set estado_operacional=%s where evento_id=%s and categoria='divergencias_apelidos_manuais' and coalesce(estado_operacional->>'resolucao','pendente')='pendente'",
                (Jsonb({"resolucao":"substituida","horario_resolucao":time}),eid))
        event_view = next(e for e in self.history.events(conn) if e["id"] == eid)
        result = {"sucesso":True,"comparacao":self.backend.domain.comparison_history_for_display(event_view)["comparacao"],
            "historico_salvo":True,"operacao_id":str(op["id"])}
        if restoration:
            result["evento"] = {"id":eid,"tipo":"restauracao","horario":time,
                "restauracao_de":restoration,"arquivos_restaurados":names,
                "desfazer_disponivel":bool(backup),
                **{k:comparison[k] for k in ("total_endpoint_restaurado","total_detalhes_restaurado","total_equipamentos_carregados")}}
        return result

    def restorable(self, event_id):
        with self.backend.transaction() as conn:
            row = conn.execute("""select b.estado from simpress.eventos_comparacao e
                join simpress.backups_logicos b on b.id=e.backup_anterior_id
                where e.evento_id=%s and e.excluido_em is null""",(event_id,)).fetchone()
        return bool(row and row["estado"] == "disponivel")

    def restore_context(self, event_id):
        storage = self.require_storage()
        with self.backend.transaction() as conn:
            record = conn.execute("""select e.tipo,e.horario_original,b.id as backup_id,b.estado,o.* from simpress.eventos_comparacao e
                join simpress.backups_logicos b on b.id=e.backup_anterior_id
                join simpress.objetos_arquivo o on o.id=b.manifesto_objeto_id
                where e.evento_id=%s and e.excluido_em is null and b.estado='disponivel'""",(event_id,)).fetchone()
            state = conn.execute("select * from simpress.estado_aplicacao where id=1").fetchone()
            current_sources = conn.execute("""select f.papel,a.nome_original,o.tamanho_bytes from simpress.fontes_lote f
                join simpress.arquivos_origem a on a.id=f.arquivo_id join simpress.objetos_arquivo o on o.id=a.objeto_id
                where f.lote_id=%s""",(state["lote_ativo_id"],)).fetchall()
        if not record or record["estado"] != "verificado":
            raise PersistenceError(409, "Esta atualização não possui um backup lógico disponível.")
        content = storage.get(record)
        snapshot = json.loads(content)
        for obj in snapshot["objects"]:
            storage.get(obj)
        token = digest(canonical([event_id,str(record["backup_id"]),record["sha256"],state["revisao_global"]]).encode())
        files = {s["papel"]:{"nome":s["nome_original"],"registros":s["contagem_linhas"],"tamanho_bytes":s["tamanho_bytes"],"modificado_em":None} for s in snapshot["sources"]}
        current = {s["papel"]:{"presente":True,"nome":s["nome_original"],"tamanho_bytes":s["tamanho_bytes"],"modificado_em":None} for s in current_sources}
        return {"evento_id":event_id,"evento_horario":record["horario_original"],"tipo_evento":"restauracao" if record["tipo"] == "restauracao" else "atualizacao",
            "arquivos_backup":files,"arquivos_atuais":current,"preview_token":token,"snapshot":snapshot,"revision":state["revisao_global"]}

    def restore(self, event_id, token, key=None):
        if key is not None:
            with self.backend.transaction() as conn:
                previous = conn.execute("select plano,estado,resultado from simpress.operacoes where chave_idempotencia=%s",("files_restore:"+key,)).fetchone()
            if previous and previous["estado"] == "confirmada":
                request = previous["plano"]["request"]
                if request["event"] != event_id or request["token"] != token:
                    raise PersistenceError(409, "Idempotency-Key já usada com outro pedido.")
                return previous["resultado"]
        context = self.restore_context(event_id)
        if not hmac.compare_digest(token,context["preview_token"]):
            raise PersistenceError(409, "O estado mudou desde a prévia; atualize-a antes de restaurar.")
        # Preserve exact logical edited values, not only the original XLSX.
        content = canonical(context["snapshot"]).encode()
        return self.run("restore",{"event":event_id,"token":token,"snapshot_sha256":digest(content),"revision":context["revision"]}, {"restauracao":content}, key)

    def activate_restore(self, conn, op, blobs, backup):
        snapshot = json.loads(blobs["restauracao"])
        batch = self.new_batch(conn,op)
        for source in snapshot["sources"]:
            conn.execute("insert into simpress.fontes_lote(lote_id,papel,arquivo_id,estado_validacao,contagem_linhas) values (%s,%s,%s,%s,%s)",
                (batch,*[source[k] for k in ("papel","arquivo_id","estado_validacao","contagem_linhas")]))
        origins = {}
        for line in snapshot["lines"]:
            origins[line["id"]] = conn.execute("""insert into simpress.linhas_fonte(lote_id,papel,aba,numero_linha,ordem_aba,
                celulas,dados_interpretados,estado_validacao,motivo_codigo,serie_bruta,serie_normalizada)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""", (batch,
                *[Jsonb(line[k]) if k in ("celulas","dados_interpretados") else line[k] for k in
                ("papel","aba","numero_linha","ordem_aba","celulas","dados_interpretados","estado_validacao","motivo_codigo","serie_bruta","serie_normalizada")])).fetchone()["id"]
        for row in snapshot["equipment"]:
            self.insert_equipment(conn,batch,row,origins.get(row["linha_origem_id"]))
        conn.execute("delete from simpress.apelidos_manuais")
        for row in snapshot["aliases"]:
            conn.execute("insert into simpress.apelidos_manuais(chave_serie_original,serie_normalizada,apelido,versao,atualizado_em) values (%s,%s,%s,%s,%s)",
                tuple(row[k] for k in ("chave_serie_original","serie_normalizada","apelido","versao","atualizado_em")))
        conn.execute("update simpress.unidades_catalogo set ativa=false")
        for row in snapshot["units"]:
            conn.execute("""insert into simpress.unidades_catalogo(id,source_key,origem_lote_id,origem,ativa,cidade,endereco,uf,cep,cnpj)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(id) do update set ativa=excluded.ativa,
                source_key=excluded.source_key,origem_lote_id=excluded.origem_lote_id,
                origem=excluded.origem,cidade=excluded.cidade,endereco=excluded.endereco,
                uf=excluded.uf,cep=excluded.cep,cnpj=excluded.cnpj,versao=simpress.unidades_catalogo.versao+1""",
                tuple(row[k] for k in ("id","source_key","origem_lote_id","origem","ativa","cidade","endereco","uf","cep","cnpj")))
        for row in snapshot["customs"]:
            conn.execute("""insert into simpress.unidades_customizadas(unidade_id,source_key_legada,cidade,endereco,uf,cep,cnpj,registro_original)
                values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict(unidade_id) do update set
                source_key_legada=excluded.source_key_legada,cidade=excluded.cidade,endereco=excluded.endereco,
                uf=excluded.uf,cep=excluded.cep,cnpj=excluded.cnpj,registro_original=excluded.registro_original,
                versao=simpress.unidades_customizadas.versao+1,atualizado_em=now()""",
                tuple(row[k] for k in ("unidade_id","source_key_legada","cidade","endereco","uf","cep","cnpj","registro_original")))
        conn.execute("update simpress.estado_aplicacao set lote_ativo_id=%s,modelo_exportacao_id=%s,modelo_transferencia_id=%s where id=1",
            (batch,snapshot["state"]["modelo_exportacao_id"],snapshot["state"]["modelo_transferencia_id"]))
        names = {s["papel"]:s["nome_original"] for s in snapshot["sources"]}
        counts = {s["papel"]:s["contagem_linhas"] for s in snapshot["sources"]}
        source_event = conn.execute("select horario_original,tipo from simpress.eventos_comparacao where evento_id=%s",
            (op["plano"]["request"]["event"],)).fetchone()
        comparison = {"total_endpoint_restaurado":counts.get("endpoint",0),"total_detalhes_restaurado":counts.get("detalhes",0),
            "total_equipamentos_carregados":self.backend.project(self.backend._snapshot(conn))["stats_cache"]["total_equipamentos"]}
        return self.record_event(conn,op,batch,backup,comparison,names,restoration={"id":op["plano"]["request"]["event"],
            "horario":source_event["horario_original"],"tipo":"restauracao" if source_event["tipo"] == "restauracao" else "atualizacao"})

    def status(self, operation):
        with self.backend.transaction() as conn:
            row = conn.execute("select id,estado,tentativas,erro_codigo,revisao_esperada,revisao_confirmada,resultado from simpress.operacoes where id=%s",(operation,)).fetchone()
        if not row:
            raise PersistenceError(404, "Operação não encontrada.")
        return ready(row)

    def recover(self, operation):
        storage = self.require_storage()
        with self.backend.transaction() as conn:
            op = conn.execute("select * from simpress.operacoes where id=%s",(operation,)).fetchone()
        if not op or not op["plano"]:
            raise PersistenceError(404, "Operação de arquivos não encontrada.")
        if op["estado"] == "confirmada":
            return op["resultado"]
        if op["estado"] == "cancelada":
            raise PersistenceError(409,"Operação cancelada; seus objetos não podem ser recuperados para ativação.")
        blobs = {o["role"]:storage.get(o) for o in op["artefatos_origem"] if o["role"] != "backup"}
        key = op["chave_idempotencia"].split(":",1)[1]
        return self.run(op["plano"]["kind"],op["plano"]["request"],blobs,key)

    @staticmethod
    def referenced(conn, oid):
        return conn.execute("""select exists(select 1 from simpress.arquivos_origem where objeto_id=%s)
            or exists(select 1 from simpress.referencias_backup where objeto_id=%s)
            or exists(select 1 from simpress.backups_logicos where manifesto_objeto_id=%s)
            or exists(select 1 from simpress.estado_aplicacao where modelo_transferencia_id=%s or modelo_exportacao_id=%s) as used""",
            (oid,oid,oid,oid,oid)).fetchone()["used"]

    def cancel(self, operation):
        with self.backend.transaction(write=True) as conn:
            conn.execute("select id from simpress.estado_aplicacao where id=1 for update")
            op = conn.execute("select *,lease_ate>now() as leased from simpress.operacoes where id=%s for update",(operation,)).fetchone()
            if not op or not op["plano"]:
                raise PersistenceError(404, "Operação de arquivos não encontrada.")
            if op["estado"] == "confirmada" or op["leased"]:
                raise PersistenceError(409, "Operação confirmada ou com executor ativo; cancelamento recusado.")
            for obj in op["artefatos_origem"]:
                if self.referenced(conn,obj["id"]):
                    raise PersistenceError(409, "Objeto referenciado; exclusão recusada.")
                conn.execute("update simpress.objetos_arquivo set estado='exclusao_pendente' where id=%s and estado<>'removido'",(obj["id"],))
            conn.execute("update simpress.operacoes set estado='cancelada',executor_id=null,lease_ate=null where id=%s",(operation,))
        return self.clean(operation)

    def clean(self, operation):
        storage = self.require_storage()
        with self.backend.transaction() as conn:
            objects = conn.execute("""select o.* from simpress.objetos_arquivo o join simpress.operacoes p on p.id=o.operacao_id
                where p.id=%s and p.estado='cancelada' and o.estado in ('exclusao_pendente','removido')""",(operation,)).fetchall()
            if any(self.referenced(conn,o["id"]) for o in objects):
                raise PersistenceError(409, "Objeto referenciado; limpeza recusada.")
        for obj in objects:
            storage.delete(obj)
            with self.backend.transaction(write=True) as conn:
                conn.execute("update simpress.objetos_arquivo set estado='removido' where id=%s and estado='exclusao_pendente'",(obj["id"],))
        return {"sucesso":True,"removidos":len(objects)}

    def object(self, oid):
        with self.backend.transaction() as conn:
            obj = conn.execute("select * from simpress.objetos_arquivo where id=%s and estado='verificado'",(oid,)).fetchone()
        if not obj:
            raise PersistenceError(404, "Objeto verificado não encontrado.")
        return self.require_storage().get(obj),obj

    def template_bytes(self, kind):
        column = {"exportacao":"modelo_exportacao_id","transferencia":"modelo_transferencia_id"}[kind]
        with self.backend.transaction() as conn:
            oid = conn.execute("select " + column + " as id from simpress.estado_aplicacao where id=1").fetchone()["id"]
        if not oid:
            raise PersistenceError(409, "Importe um modelo de " + kind + " no Storage do piloto antes de gerar a planilha.")
        return self.object(oid)[0]

    def prune(self, now=None):
        now = now or datetime.now(timezone.utc)
        with self.backend.transaction(write=True) as conn:
            state = conn.execute("select revisao_global from simpress.estado_aplicacao where id=1 for update").fetchone()
            days = conn.execute("select retencao_operacional_dias from simpress.configuracao where id=1").fetchone()["retencao_operacional_dias"]
            # Visibility retention only. Never remove provenance or blobs that
            # backups/restoration can still reference. Any annotation protects.
            result = conn.execute("""update simpress.eventos_comparacao e set excluido_em=%s
                where excluido_em is null and horario<%s and not fixado and not protegido_retencao
                and not exists(select 1 from simpress.anotacoes a where a.evento_id=e.evento_id)
                returning evento_id""",(now,now-timedelta(days=days))).fetchall()
            if result:
                conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1,atualizado_em=now() where id=1")
                conn.execute("""insert into simpress.operacoes(chave_idempotencia,tipo,estado,revisao_esperada,revisao_confirmada,resultado)
                    values (%s,'limpeza','confirmada',%s,%s,%s)""",("retention:"+uuid.uuid4().hex,state["revisao_global"],state["revisao_global"]+1,Jsonb({"ocultados":len(result)})))
        return {"ocultados":len(result),"objetos_removidos":0}
