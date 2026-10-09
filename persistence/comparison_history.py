"""SQL history with immutable raw payloads and independent annotation overlays."""

from datetime import datetime
import hashlib
import json
import re
import uuid
from typing import Any

from psycopg.types.json import Jsonb

from domains.inventory_update import _ANNOTATABLE_COMPARISON_CATEGORIES, _legacy_annotation
from persistence.config import PersistenceError
from persistence.postgres import canonical

CATEGORIES = (*_ANNOTATABLE_COMPARISON_CATEGORIES, "divergencias_apelidos_manuais")


def parsed_time(value):
    try:
        result = datetime.fromisoformat(str(value))
        return result if result.tzinfo else None
    except (ValueError, TypeError):
        return None


class ComparisonHistory:
    def __init__(self, backend):
        self.backend = backend

    def events(self, conn):
        events = conn.execute("select * from simpress.eventos_comparacao where excluido_em is null order by ordem_evento").fetchall()
        rows = conn.execute("""select l.*, a.texto from simpress.linhas_comparacao l
            left join simpress.anotacoes a using(evento_id,item_id) order by l.ordem_linha""").fetchall()
        by_event: dict[str,list[Any]] = {}
        for row in rows:
            by_event.setdefault(row["evento_id"], []).append(row)
        result = []
        for record in events:
            event = json.loads(record["payload_original"]) if record["payload_original"] is not None else {
                "id": record["evento_id"], "horario": record["horario_original"], "arquivos_enviados": {},
                "resumo": record["resumo"], "somente_anotacoes_sincronizadas": True, "comparacao": {}}
            comparison = event.setdefault("comparacao", {})
            for row in by_event.get(record["evento_id"], []):
                category = row["categoria"]
                if record["payload_original"] is None:
                    comparison.setdefault(category, []).append(dict(row["dados_consulta"]))
                items = comparison.get(category, [])
                if row["ordem_linha"] >= len(items):
                    continue
                item = items[row["ordem_linha"]]
                if not isinstance(item, dict):
                    continue
                item["anotacao_id"] = row["item_id"]
                if row["texto"] is not None:
                    item["anotacao"] = row["texto"]
                item.update(row["estado_operacional"])
            result.append(event)
        return result

    def load(self):
        with self.backend.transaction() as conn:
            result = self.events(conn)
        return result

    def insert(self, conn, event, *, batch=None, operation=None, backup=None, reapply=False):
        event_id = event["id"]
        comparison = event.get("comparacao", {})
        kind = "restauracao" if event.get("tipo") == "restauracao" else "comparacao"
        conn.execute("""insert into simpress.eventos_comparacao
            (evento_id,tipo,horario_original,horario,completude,lote_id,operacao_id,backup_anterior_id,resumo,payload_original)
            values (%s,%s,%s,%s,'completo',%s,%s,%s,%s,%s)""",
            (event_id, kind, event.get("horario"), parsed_time(event.get("horario")), batch, operation,
             backup, Jsonb(event.get("resumo", {})), canonical(event)))
        if event_id == getattr(self.backend.domain,"PINNED_COMPARISON_EVENT_ID",None):
            conn.execute("update simpress.eventos_comparacao set fixado=true where evento_id=%s",(event_id,))
        for category in CATEGORIES:
            for index, item in enumerate(comparison.get(category, [])):
                if not isinstance(item, dict):
                    continue
                item_id = self.backend.domain.comparison_annotation_item_id(event_id, category, index, item)
                row_data = {k:v for k,v in item.items() if k not in {"anotacao", "anotacao_id"}}
                payload = canonical([category, row_data])
                fingerprint = hashlib.sha256(payload.encode()).hexdigest()
                note = item.get("anotacao", _legacy_annotation(comparison, category, index))
                origin = "legada"
                if reapply and category in _ANNOTATABLE_COMPARISON_CATEGORIES:
                    # Compare canonical TEXT, never JSONB equality (1 != 1.0).
                    matches = conn.execute("""select l.evento_id,a.texto,e.ordem_evento
                        from simpress.linhas_comparacao l join simpress.eventos_comparacao e using(evento_id)
                        left join simpress.anotacoes a using(evento_id,item_id)
                        where l.categoria=%s and l.payload_canonico=%s and not l.contexto_parcial
                        and e.evento_id<>%s order by e.ordem_evento desc""", (category,payload,event_id)).fetchall()
                    latest = [m["texto"] for m in matches if m["ordem_evento"] == matches[0]["ordem_evento"]] if matches else []
                    if latest and isinstance(latest[0],str) and latest[0] and all(n == latest[0] for n in latest):
                        note, origin = latest[0], "reaplicada"
                conn.execute("""insert into simpress.linhas_comparacao
                    (evento_id,item_id,categoria,ordem_linha,dados_consulta,payload_canonico,linha_hash,caminho_original)
                    values (%s,%s,%s,%s,%s,%s,%s,%s)""", (event_id,item_id,category,index,Jsonb(row_data),payload,
                    fingerprint,f"comparacao.{category}[{index}]"))
                if isinstance(note, str):
                    if len(note) > 2000:
                        raise PersistenceError(422, "Uma anotação legada excede 2.000 caracteres; importação cancelada.")
                    conn.execute("""insert into simpress.anotacoes(evento_id,item_id,texto,origem,atualizado_em)
                        values (%s,%s,%s,%s,now())""", (event_id,item_id,note,origin))

    def mutate(self, command, data, key=None):
        if key is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", key):
            raise PersistenceError(422, "Idempotency-Key inválida.")
        identity = "history_" + command + ":" + (key or uuid.uuid4().hex)
        digest = hashlib.sha256(canonical(data).encode()).hexdigest()
        with self.backend.transaction(write=True) as conn:
            state = conn.execute("select * from simpress.estado_aplicacao where id=1 for update").fetchone()
            previous = conn.execute("select * from simpress.operacoes where chave_idempotencia=%s", (identity,)).fetchone()
            if previous:
                if previous["pedido_sha256"] != digest or previous["estado"] != "confirmada":
                    raise PersistenceError(409, "Idempotency-Key já usada com outro pedido.")
                result = previous["resultado"]
            else:
                event = conn.execute("select * from simpress.eventos_comparacao where evento_id=%s and excluido_em is null", (data["event"],)).fetchone()
                if not event:
                    raise PersistenceError(404, "O resultado selecionado não existe no histórico de planilhas.")
                if command == "note":
                    row = conn.execute("select categoria from simpress.linhas_comparacao where evento_id=%s and item_id=%s", (data["event"],data["item"])).fetchone()
                    if not row or row["categoria"] not in _ANNOTATABLE_COMPARISON_CATEGORIES:
                        raise PersistenceError(404, "A linha selecionada não existe neste resultado.")
                    if not isinstance(data["note"], str) or len(data["note"]) > 2000:
                        raise PersistenceError(422, "A anotação excede 2.000 caracteres.")
                    conn.execute("""insert into simpress.anotacoes(evento_id,item_id,texto,origem,atualizado_em)
                        values (%s,%s,%s,'local',now()) on conflict(evento_id,item_id) do update set
                        texto=excluded.texto,origem='local',versao=simpress.anotacoes.versao+1,atualizado_em=now()""",
                        (data["event"],data["item"],data["note"]))
                    result = {"sucesso": True, "anotacao": data["note"], "sincronizacao": "sincronizada"}
                elif command == "delete":
                    # Keep raw history/provenance; tombstones prevent resurrection.
                    conn.execute("update simpress.eventos_comparacao set excluido_em=now() where evento_id=%s", (data["event"],))
                    conn.execute("update simpress.anotacoes set texto='',versao=versao+1,atualizado_em=now() where evento_id=%s", (data["event"],))
                    total = conn.execute("select count(*) as n from simpress.eventos_comparacao where excluido_em is null").fetchone()["n"]
                    result = {"sucesso": True, "total": total, "sincronizacao": "sincronizada"}
                else:
                    result = self.resolve(conn, data)
                conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1,atualizado_em=now() where id=1")
                conn.execute("""insert into simpress.operacoes(chave_idempotencia,tipo,estado,pedido_sha256,
                    revisao_esperada,revisao_confirmada,resultado) values (%s,'edicao','confirmada',%s,%s,%s,%s)""",
                    (identity,digest,state["revisao_global"],state["revisao_global"]+1,Jsonb(result)))
        return result

    def resolve(self, conn, data):
        action = data["action"]
        if action not in {"manter", "excluir"}:
            raise PersistenceError(400, "Escolha manter ou excluir a alteração manual.")
        serial = self.backend.domain.normalize_reference_value(data["serial"])
        rows = conn.execute("select * from simpress.linhas_comparacao where evento_id=%s and categoria='divergencias_apelidos_manuais'", (data["event"],)).fetchall()
        row = next((r for r in rows if self.backend.domain.normalize_reference_value(r["dados_consulta"].get("serie")) == serial), None)
        if not row:
            raise PersistenceError(404, "A divergência de apelido não existe neste registro.")
        if row["estado_operacional"].get("resolucao", row["dados_consulta"].get("resolucao", "pendente")) != "pendente":
            raise PersistenceError(409, "Esta divergência já foi resolvida no histórico.")
        aliases = conn.execute("select apelido from simpress.apelidos_manuais where serie_normalizada=%s", (serial,)).fetchall()
        if len(aliases) != 1 or aliases[0]["apelido"] != row["dados_consulta"].get("apelido_manual"):
            raise PersistenceError(409, "O apelido manual mudou desde esta comparação.")
        if action == "excluir":
            conn.execute("delete from simpress.apelidos_manuais where serie_normalizada=%s", (serial,))
            conn.execute("""update simpress.equipamentos_lote set versao=versao+1,atualizado_em=now()
                where serie_normalizada=%s and lote_id=(select lote_ativo_id from simpress.estado_aplicacao where id=1)""",(serial,))
        conn.execute("update simpress.linhas_comparacao set estado_operacional=%s where id=%s",
            (Jsonb({"resolucao": "mantida" if action == "manter" else "excluida", "horario_resolucao": datetime.now().astimezone().isoformat()}),row["id"]))
        return {"sucesso": True, "mensagem": "Divergência de apelido resolvida no banco local."}
