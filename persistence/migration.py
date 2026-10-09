"""Explicit synthetic bundles, offline dry-run and resumable staged imports."""

from collections import Counter
import hashlib
import json
import re
from pathlib import Path
from uuid import UUID

from psycopg.types.json import Jsonb
from domains.inventory_update import _legacy_annotation

from persistence.comparison_history import CATEGORIES, parsed_time
from persistence.config import PersistenceError
from persistence.inventory_projection import equipment_rows, source_rows
from persistence.postgres import canonical

MAX_FILE = 30 * 1024 * 1024
ROLES = {"detalhes", "endpoint", "historico", "estado", "modelo_exportacao", "modelo_transferencia"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def parse_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError):
        raise PersistenceError(422, "JSON inválido ou com chaves duplicadas no pacote de migração.") from None


class MigrationBundle:
    def __init__(self, directory, domain):
        self.root = Path(directory).resolve()
        allowed = Path(__file__).resolve().parents[1] / "supabase/.temp/etapa8"
        if not self.root.is_relative_to(allowed.resolve()) or self.root == allowed.resolve():
            raise PersistenceError(422, "O ensaio aceita somente pacote explícito na pasta isolada da Etapa 8.")
        manifest_path = self.root / "manifest.json"
        if manifest_path.is_symlink() or manifest_path.stat().st_size > MAX_FILE:
            raise PersistenceError(422, "Manifesto inválido.")
        self.manifest_bytes = manifest_path.read_bytes()
        self.manifest = parse_json(self.manifest_bytes)
        if (not isinstance(self.manifest, dict) or self.manifest.get("format") != "simpress-migration-bundle-v1"
                or self.manifest.get("synthetic") is not True or not isinstance(self.manifest.get("files"), dict)
                or not {"detalhes", "endpoint", "historico", "estado"} <= set(self.manifest["files"])
                or not set(self.manifest["files"]) <= ROLES):
            raise PersistenceError(422, "Formato de pacote sintético inválido.")
        try:
            self.identifier = str(UUID(self.manifest["bundle_id"]))
        except (ValueError, KeyError, TypeError, AttributeError):
            raise PersistenceError(422, "Identidade do pacote inválida.") from None
        self.domain = domain
        self.data = {}
        self.names = {}
        for role, entry in self.manifest["files"].items():
            name = entry.get("path") if isinstance(entry, dict) else None
            if not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts:
                raise PersistenceError(422, "Caminho inválido no pacote.")
            path = self.root / name
            if path.is_symlink() or not path.resolve().is_relative_to(self.root) or not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE:
                raise PersistenceError(422, "Arquivo ausente, redirecionado ou acima do limite no pacote.")
            content = path.read_bytes()
            if sha(content) != entry.get("sha256"):
                raise PersistenceError(409, "Hash divergente no pacote; nenhuma importação iniciada.")
            self.data[role], self.names[role] = content, path.name
        self.staged = {r: {"name": self.names[r], "bytes": self.data[r],
                          "table": domain.validate_uploaded_workbook(self.data[r], r)} for r in ("detalhes", "endpoint")}
        self.equipment = equipment_rows(self.staged["detalhes"]["table"], domain)
        self.sources = list(source_rows(self.staged, domain))
        self.history = parse_json(self.data["historico"])
        self.state = parse_json(self.data["estado"])
        self.validate_legacy()
        for role in ("modelo_exportacao", "modelo_transferencia"):
            if role in self.data:
                domain.validate_xlsx_package(self.data[role])
        self.fingerprint = sha(canonical({"manifest": self.manifest,
            "files": {r: sha(b) for r, b in self.data.items()}}).encode())

    def validate_legacy(self):
        if not isinstance(self.history, dict) or not isinstance(self.state, dict):
            raise PersistenceError(422, "Histórico e estado devem ser objetos JSON.")
        for obj, keys in ((self.history, ("historico", "anotacoes")), (self.state, ("unidades", "apelidos", "historico_apelidos"))):
            if any(not isinstance(obj.get(key, []), list) for key in keys):
                raise PersistenceError(422, "Lista legada inválida.")
        events = self.history.get("historico", [])
        event_ids = set()
        for event in events:
            if (not isinstance(event, dict) or not isinstance(event.get("id"), str) or not event["id"].strip()
                    or event["id"] in event_ids or not isinstance(event.get("comparacao"), dict)):
                raise PersistenceError(422, "Evento inválido ou duplicado.")
            event_ids.add(event["id"])
            row_ids = set()
            for category in CATEGORIES:
                items = event["comparacao"].get(category, [])
                if not isinstance(items, list):
                    raise PersistenceError(422, "Seção de comparação inválida.")
                for index, item in enumerate(items):
                    if not isinstance(item, dict):
                        raise PersistenceError(422, "Linha legada inválida.")
                    item_id = self.domain.comparison_annotation_item_id(event["id"], category, index, item)
                    note = item.get("anotacao", _legacy_annotation(event["comparacao"], category, index))
                    if item_id in row_ids or (note is not None and (not isinstance(note, str) or len(note) > 2000)):
                        raise PersistenceError(422, "Identidade duplicada ou anotação inválida.")
                    row_ids.add(item_id)
        note_ids = set()
        for note in self.history.get("anotacoes", []):
            if not isinstance(note, dict):
                raise PersistenceError(422, "Anotação legada inválida.")
            identity = (note.get("evento_id"), note.get("item_id"))
            if (any(not isinstance(v, str) or not v for v in identity) or identity in note_ids
                    or note.get("categoria", "apelidos_sem_atualizacao") not in CATEGORIES[:-1]
                    or not isinstance(note.get("anotacao"), str) or len(note["anotacao"]) > 2000):
                raise PersistenceError(422, "Anotação legada inválida ou duplicada.")
            if note.get("linha_hash") is not None and (not isinstance(note["linha_hash"], str) or not re.fullmatch(r"[0-9a-f]{64}", note["linha_hash"])):
                raise PersistenceError(422, "Assinatura legada inválida.")
            note_ids.add(identity)
        for key, field in (("unidades", "id"), ("apelidos", "serie"), ("historico_apelidos", "id")):
            records = self.state.get(key, [])
            if any(not isinstance(r, dict) or field not in r for r in records):
                raise PersistenceError(422, "Identidade legada ausente.")
            ids = [r[field] for r in records]
            if any(not isinstance(i, (int, str)) or isinstance(i, bool) for i in ids) or len(set(ids)) != len(ids):
                raise PersistenceError(422, "Identidade legada duplicada ou inválida.")
        for record in self.state.get("apelidos", []):
            if not isinstance(record["serie"], str) or not self.domain.normalize_reference_value(record["serie"]) or not isinstance(record.get("apelido"), str):
                raise PersistenceError(422, "Apelido legado inválido.")
        for unit in self.state.get("unidades", []):
            if not isinstance(unit["id"], int) or isinstance(unit["id"], bool) or not 0 < unit["id"] <= 9_007_199_254_740_991:
                raise PersistenceError(422, "ID da unidade legada inválido.")
            if any(not isinstance(unit.get(k, ""), str) for k in ("cidade", "endereco", "uf", "cep", "cnpj")):
                raise PersistenceError(422, "Campo de unidade legada inválido.")
        for event in self.state.get("historico_apelidos", []):
            if not isinstance(event["id"], str) or not event["id"].strip() or any(
                    event.get(k) is not None and not isinstance(event[k], str)
                    for k in ("horario", "tipo", "serie", "apelido_anterior", "apelido_novo", "acao")):
                raise PersistenceError(422, "Evento de apelido legado inválido.")

    def dry_run(self):
        counts = Counter(r["serie_normalizada"] for r in self.equipment)
        return {"format": "simpress-migration-plan-v1", "bundle_id": self.identifier, "fingerprint": self.fingerprint,
            "writes": False, "equipment": len(self.equipment),
            "source_rows": dict(Counter(r["papel"] for r in self.sources)),
            "duplicate_serial_groups": sum(n > 1 for n in counts.values()),
            "legacy_events": len(self.history.get("historico", [])), "shared_notes": len(self.history.get("anotacoes", [])),
            "legacy_entities": {k: len(self.state.get(k, [])) for k in ("unidades", "apelidos", "historico_apelidos")},
            "files": {r: {"sha256": sha(b), "size": len(b)} for r, b in self.data.items()}}

    def apply(self, backend):
        if not getattr(backend, "rehearsal", False) or not backend.authenticated:
            raise PersistenceError(403, "Importação permitida somente no ensaio autenticado separado.")
        base = "migration:" + self.identifier
        # The bundle guard commits first. A changed bundle cannot silently resume
        # already committed stages of the same migration identity.
        with backend.transaction(write=True) as conn:
            conn.execute("select id from simpress.estado_aplicacao where id=1 for update")
            previous = conn.execute("select pedido_sha256 from simpress.operacoes where chave_idempotencia=%s", (base,)).fetchone()
            if previous and previous["pedido_sha256"] != self.fingerprint:
                raise PersistenceError(409, "Pacote alterado com a mesma identidade; retomada recusada.")
            if not previous:
                conn.execute("""insert into simpress.operacoes(chave_idempotencia,tipo,estado,pedido_sha256,versao_importador,contagens)
                    values (%s,'importacao_legada','confirmada',%s,'etapa8-v1',%s)""", (base, self.fingerprint, Jsonb(self.dry_run())))
        results = {"inventory": backend.files.update(self.staged, base + ":inventory")}
        for role, kind in (("modelo_exportacao", "exportacao"), ("modelo_transferencia", "transferencia")):
            if role in self.data:
                results[role] = backend.files.template(kind, self.names[role], self.data[role], base + ":" + role)
        results["history"] = backend.files.annotations(self.names["historico"], self.data["historico"], base + ":history")
        if results["history"].get("conflitos"):
            raise PersistenceError(409, "Conflitos de histórico exigem revisão; importação não reconciliada.")
        self.apply_state(backend, base + ":state")
        return results

    def apply_state(self, backend, key):
        with backend.transaction(write=True) as conn:
            state = conn.execute("select revisao_global from simpress.estado_aplicacao where id=1 for update").fetchone()
            if conn.execute("select id from simpress.operacoes where chave_idempotencia=%s", (key,)).fetchone():
                return
            for unit in self.state.get("unidades", []):
                uid = unit["id"]
                if not isinstance(uid, int) or not 0 < uid <= 9_007_199_254_740_991:
                    raise PersistenceError(422, "ID da unidade legada inválido.")
                values = [str(unit.get(k, "")) for k in ("cidade", "endereco", "uf", "cep", "cnpj")]
                conn.execute("insert into simpress.unidades_catalogo(id,origem,cidade,endereco,uf,cep,cnpj) values (%s,'customizada',%s,%s,%s,%s,%s)", (uid, *values))
                conn.execute("insert into simpress.unidades_customizadas(unidade_id,cidade,endereco,uf,cep,cnpj,registro_original) values (%s,%s,%s,%s,%s,%s,%s)", (uid, *values, canonical(unit)))
            for alias in self.state.get("apelidos", []):
                conn.execute("insert into simpress.apelidos_manuais(chave_serie_original,serie_normalizada,apelido) values (%s,%s,%s)",
                    (alias["serie"], self.domain.normalize_reference_value(alias["serie"]), alias["apelido"]))
            for event in self.state.get("historico_apelidos", []):
                raw = event.get("serie", "")
                conn.execute("""insert into simpress.historico_apelidos(evento_id,horario_original,horario,tipo,serie_bruta,
                    serie_normalizada,apelido_anterior,apelido_novo,acao,registro_original,autor_user_id)
                    values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,nullif(current_setting('request.jwt.claim.sub',true),'')::uuid)""",
                    (event["id"], event.get("horario"), parsed_time(event.get("horario")), event.get("tipo"), raw,
                     self.domain.normalize_reference_value(raw), event.get("apelido_anterior"), event.get("apelido_novo"), event.get("acao"), canonical(event)))
            conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1,atualizado_em=now() where id=1")
            conn.execute("""insert into simpress.operacoes(chave_idempotencia,tipo,estado,pedido_sha256,revisao_esperada,revisao_confirmada)
                values (%s,'importacao_legada','confirmada',%s,%s,%s)""", (key, self.fingerprint, state["revisao_global"], state["revisao_global"] + 1))

    def reconcile(self, backend):
        errors = []
        with backend.transaction() as conn:
            state = conn.execute("select * from simpress.estado_aplicacao where id=1").fetchone()
            sources = conn.execute("select * from simpress.linhas_fonte where lote_id=%s order by papel,numero_linha", (state["lote_ativo_id"],)).fetchall()
            expected = sorted(self.sources, key=lambda r: (r["papel"], r["numero_linha"]))
            for columns in [("papel", "aba", "serie_bruta", "serie_normalizada", "numero_linha", "celulas", "dados_interpretados", "estado_validacao")]:
                if [{k: r[k] for k in columns} for r in sources] != [{k: r[k] for k in columns} for r in expected]:
                    errors.append("source_rows_or_provenance")
            rows = conn.execute("select * from simpress.equipamentos_lote where lote_id=%s", (state["lote_ativo_id"],)).fetchall()
            by_id = {r["id"]: r for r in sources}
            expected_equipment = {r["source_row"]: r for r in self.equipment}
            if len(rows) != len(self.equipment):
                errors.append("official_equipment_counts")
            for row in rows:
                origin = by_id.get(row["linha_origem_id"])
                expected_row = expected_equipment.get(origin["numero_linha"]) if origin else None
                if (not origin or origin["papel"] != "detalhes" or row["papel_origem"] != "detalhes"
                        or row["origem"] != "importada" or not expected_row
                        or any(row[k] != v for k, v in expected_row.items() if k != "source_row")):
                    errors.append("official_fields_or_relations")
            linked = conn.execute("""select f.papel,f.contagem_linhas,o.sha256 from simpress.fontes_lote f
                join simpress.arquivos_origem a on a.id=f.arquivo_id join simpress.objetos_arquivo o on o.id=a.objeto_id
                where f.lote_id=%s""", (state["lote_ativo_id"],)).fetchall()
            if ({r["papel"]: (r["contagem_linhas"], r["sha256"]) for r in linked}
                    != {r: (sum(s["papel"] == r for s in self.sources), sha(self.data[r])) for r in ("detalhes", "endpoint")}):
                errors.append("source_file_references")
            event_order = []
            for event in self.history.get("historico", []):
                actual = conn.execute("select * from simpress.eventos_comparacao where evento_id=%s", (event["id"],)).fetchone()
                if not actual or actual["payload_original"] != canonical(event) or actual["horario_original"] != event.get("horario"):
                    errors.append("legacy_event_payload")
                    continue
                event_order.append(actual["ordem_evento"])
                for category in CATEGORIES:
                    for index, item in enumerate(event["comparacao"].get(category, [])):
                        item_id = self.domain.comparison_annotation_item_id(event["id"], category, index, item)
                        line = conn.execute("""select l.*,a.texto from simpress.linhas_comparacao l
                            left join simpress.anotacoes a using(evento_id,item_id) where evento_id=%s and item_id=%s""", (event["id"], item_id)).fetchone()
                        payload = canonical([category, {k: v for k, v in item.items() if k not in {"anotacao", "anotacao_id"}}])
                        if (not line or line["ordem_linha"] != index or line["categoria"] != category
                                or line["payload_canonico"] != payload or line["linha_hash"] != sha(payload.encode())
                                or ("anotacao" in item and line["texto"] != item["anotacao"])):
                            errors.append("legacy_line_identity_payload_or_note")
            if event_order != sorted(event_order):
                errors.append("legacy_event_order")
            for note in self.history.get("anotacoes", []):
                actual = conn.execute("""select l.*,a.texto,a.atualizado_em_original from simpress.linhas_comparacao l
                    join simpress.anotacoes a using(evento_id,item_id) where evento_id=%s and item_id=%s""", (note["evento_id"], note["item_id"])).fetchone()
                if (not actual or actual["texto"] != note["anotacao"] or actual["categoria"] != note.get("categoria", "apelidos_sem_atualizacao")
                        or actual["atualizado_em_original"] != note.get("atualizado_em")):
                    errors.append("shared_note_identity_or_original_date")
            for unit in self.state.get("unidades", []):
                actual = conn.execute("select * from simpress.unidades_customizadas where unidade_id=%s", (unit["id"],)).fetchone()
                if not actual or actual["registro_original"] != canonical(unit) or any(actual[k] != unit.get(k, "") for k in ("cidade", "endereco", "uf", "cep", "cnpj")):
                    errors.append("custom_unit")
            for alias in self.state.get("apelidos", []):
                actual = conn.execute("select * from simpress.apelidos_manuais where chave_serie_original=%s", (alias["serie"],)).fetchone()
                if not actual or actual["apelido"] != alias["apelido"] or actual["serie_normalizada"] != self.domain.normalize_reference_value(alias["serie"]):
                    errors.append("manual_alias")
            alias_order = []
            for event in self.state.get("historico_apelidos", []):
                actual = conn.execute("select * from simpress.historico_apelidos where evento_id=%s", (event["id"],)).fetchone()
                if not actual or actual["registro_original"] != canonical(event):
                    errors.append("alias_history")
                else:
                    alias_order.append(actual["ordem_evento"])
            if alias_order != sorted(alias_order):
                errors.append("alias_history_order")
            if conn.execute("select count(*) as n from simpress.conflitos_importacao where estado='pendente'").fetchone()["n"]:
                errors.append("unresolved_import_conflicts")
            objects = conn.execute("select * from simpress.objetos_arquivo where estado='verificado'").fetchall()
            for obj in objects:
                backend.files.storage.get(obj)
        return {"reconciled": not errors, "differences": sorted(set(errors)), "source_rows": len(sources),
                "equipment": len(rows), "verified_objects": len(objects), "bundle_id": self.identifier}
