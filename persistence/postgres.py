"""SQL backend for the explicit local pilot. No XLSX/JSON reads or writes.

Every request reads a fresh consistent snapshot. Writes serialize on the global
revision row, prepare the HTTP result, and return it only after the SQL COMMIT.
"""

from collections import Counter
from contextlib import contextmanager
from datetime import datetime
import hashlib
import hmac
import json
import logging
import re
import uuid
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool, PoolTimeout

from persistence.config import PersistenceError

MARKER = "simpress-dev: disposable synthetic development; no operational data"
MAX_UNIT_ID = 9_007_199_254_740_991
logger = logging.getLogger(__name__)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


class PostgresBackend:
    def __init__(self, settings, domain):
        self.domain = domain
        self.authenticated = settings.auth_enabled
        self.pool = ConnectionPool[psycopg.Connection[dict[str, Any]]](
            settings.database_url, min_size=1, max_size=settings.pool_size,
            timeout=5, max_waiting=16, open=False, reconnect_timeout=5,
            kwargs={"autocommit": True, "row_factory": dict_row,
                    "connect_timeout": 3, "application_name": "simpress-local-pilot",
                    "host": "127.0.0.1", "hostaddr": "127.0.0.1", "port": 54322,
                    "user": "simpress_runtime_login" if self.authenticated else "simpress_piloto_login",
                    "options": "", "gssencmode": "disable"},
            check=ConnectionPool.check_connection,
        )
        from persistence.files import PostgresFiles
        from persistence.storage import LocalStorage
        self.files = PostgresFiles(self, LocalStorage(settings.storage_key) if settings.storage_key else None)
        self.auth = None
        if self.authenticated:
            from security.auth import AuthService
            self.auth = AuthService(self,domain.AUTH_SETTINGS)

    def open(self):
        try:
            self.pool.open(wait=True, timeout=8)
            if self.auth is not None:
                self.auth.open()
            else:
                self.state()
        except Exception:
            self.pool.close()
            raise PersistenceError(503, "PostgreSQL local indisponível ou não autorizado; modo de arquivos não foi ativado.") from None

    def close(self):
        self.pool.close()
        if self.auth is not None:
            self.auth.close()
        if self.files.storage is not None:
            self.files.storage.close()

    @contextmanager
    def transaction(self, *, write=False):
        try:
            with self.pool.connection() as conn:
                with conn.transaction():
                    if not write:
                        conn.execute("set transaction isolation level repeatable read read only")
                    conn.execute("set local statement_timeout = '5s'")
                    conn.execute("set local lock_timeout = '3s'")
                    conn.execute("set local idle_in_transaction_session_timeout = '10s'")
                    self._check_login(conn,self.authenticated)
                    conn.execute("set local search_path = pg_catalog, simpress")
                    if self.authenticated:
                        from security.context import principal
                        identity = principal.get()
                        if identity is None:
                            raise PersistenceError(401,"Entre na sua conta para continuar.")
                        conn.execute("set local role simpress_runtime")
                        for name,value in (("request.jwt.claim.sub",identity.user_id),
                            ("simpress.auth_session_id",identity.auth_session_id),("simpress.app_session_hash",identity.session_hash)):
                            conn.execute("select set_config(%s,%s,true)",(name,value))
                        authorized = conn.execute("select simpress_auth.is_admin() as allowed").fetchone()
                        if not authorized or not authorized["allowed"]:
                            raise PersistenceError(403,"A conta ou sessão não tem acesso a esta instalação.")
                    else:
                        conn.execute("set local role simpress_piloto")
                        conn.execute("set local simpress.piloto_local = 'on'")
                        cfg = conn.execute("select admin_user_id, admin_habilitado from simpress.configuracao where id=1").fetchone()
                        if not cfg or cfg["admin_user_id"] or cfg["admin_habilitado"]:
                            raise PersistenceError(503, "O piloto sem autenticação não pode acessar uma instalação com administrador provisionado.")
                    yield conn
        except (psycopg.errors.SerializationFailure, psycopg.errors.DeadlockDetected,
                psycopg.errors.LockNotAvailable, psycopg.errors.UniqueViolation,
                psycopg.errors.ForeignKeyViolation):
            raise PersistenceError(409, "Conflito de gravação; atualize os dados antes de repetir a operação.") from None
        except (psycopg.Error, PoolTimeout):
            # SQL errors can include values and credentials: never forward/log str(error).
            logger.warning("Falha de persistência PostgreSQL; resposta detalhada suprimida.")
            raise PersistenceError(503, "PostgreSQL indisponível; confira o resultado antes de repetir com a mesma Idempotency-Key.") from None

    @staticmethod
    def _check_login(conn, authenticated=False):
        login = "simpress_runtime_login" if authenticated else "simpress_piloto_login"
        roles = {"simpress_runtime","simpress_session_gateway"} if authenticated else {"simpress_piloto"}
        row = conn.execute("""select session_user as login, rolsuper, rolcreatedb,
            rolcreaterole, rolreplication, rolbypassrls, rolinherit,
            obj_description('simpress'::regnamespace, 'pg_namespace') as marker,
            current_setting('server_version_num')::int as version
            from pg_roles where rolname=session_user""").fetchone()
        if (not row or row["login"] != login or row["marker"] != MARKER
                or not 170000 <= row["version"] < 180000
                or any(row[k] for k in ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolinherit"))):
            raise PersistenceError(503, "A conexão não pertence ao piloto local com privilégios limitados.")
        unsafe = conn.execute("""select exists(select 1 from pg_class c join pg_namespace n
            on n.oid=c.relnamespace where n.nspname in ('simpress','simpress_auth') and
            (pg_has_role(session_user,c.relowner,'MEMBER') or
             (c.relkind='r' and (not c.relrowsecurity or not c.relforcerowsecurity)))) as unsafe""").fetchone()
        memberships = conn.execute("""select r.rolname,m.inherit_option,m.set_option,m.admin_option
            from pg_auth_members m join pg_roles r on r.oid=m.roleid
            where m.member=(select oid from pg_roles where rolname=session_user)""").fetchall()
        if (unsafe["unsafe"] or {r["rolname"] for r in memberships} != roles
                or any(r["inherit_option"] or r["admin_option"] or not r["set_option"] for r in memberships)):
            raise PersistenceError(503, "Propriedade, RLS ou vínculos do papel PostgreSQL não correspondem ao piloto.")
        unsafe_roles = conn.execute("""select count(*) as n,bool_or(rolcanlogin or rolsuper or rolcreatedb or rolcreaterole
            or rolreplication or rolbypassrls or rolinherit
            or exists(select 1 from pg_auth_members where member=r.oid)) as unsafe
            from pg_roles r where rolname=any(%s)""",(list(roles),)).fetchone()
        if not unsafe_roles or unsafe_roles["n"] != len(roles) or unsafe_roles["unsafe"]:
            raise PersistenceError(503, "O papel do piloto foi alterado; conexão recusada.")

    def _snapshot(self, conn, *, lock=False):
        state = conn.execute("select * from simpress.estado_aplicacao where id=1" + (" for update" if lock else "")).fetchone()
        if not state:
            raise PersistenceError(503, "Estado global do banco ausente.")
        batch = state["lote_ativo_id"]
        if batch is not None:
            active = conn.execute("select estado from simpress.lotes_inventario where id=%s", (batch,)).fetchone()
            if not active or active["estado"] != "validado":
                raise PersistenceError(409, "O lote ativo não está validado; nenhuma operação foi aplicada.")
        rows = conn.execute("""select e.*, f.ordem_aba, f.numero_linha, f.dados_interpretados as source_data
            from simpress.equipamentos_lote e left join simpress.linhas_fonte f on f.id=e.linha_origem_id
            where e.lote_id=%s order by f.ordem_aba nulls last, f.numero_linha nulls last, e.atualizado_em, e.id""", (batch,)).fetchall()
        sources = conn.execute("select papel,estado_validacao from simpress.fontes_lote where lote_id=%s", (batch,)).fetchall()
        endpoint = conn.execute("""select serie_bruta,dados_interpretados from simpress.linhas_fonte
            where lote_id=%s and papel='endpoint' order by ordem_aba,numero_linha""", (batch,)).fetchall()
        units = conn.execute("""select u.*, c.registro_original from simpress.unidades_catalogo u
            left join simpress.unidades_customizadas c on c.unidade_id=u.id and u.origem='customizada'
            where u.ativa order by u.id""").fetchall()
        aliases = conn.execute("select chave_serie_original,apelido from simpress.apelidos_manuais order by chave_serie_original").fetchall()
        history = conn.execute("select registro_original from simpress.historico_apelidos order by ordem_evento").fetchall()
        return {"global": state, "rows": rows, "sources": sources, "endpoint": endpoint,
                "units": units, "aliases": {r["chave_serie_original"]: r["apelido"] for r in aliases},
                "history": [json.loads(r["registro_original"]) for r in history]}

    def project(self, snapshot):
        d = self.domain
        counts = Counter(d.normalize_reference_value(r["serie_bruta"]) for r in snapshot["rows"])
        index = self.files.endpoint_index([r["dados_interpretados"] for r in snapshot["endpoint"]])
        index["available"] = any(r["papel"] == "endpoint" and r["estado_validacao"] == "valido" for r in snapshot["sources"])
        manual = d._manual_aliases_by_serial(snapshot["aliases"])
        cache = {}
        for row in snapshot["rows"]:
            if self.domain.normalize_contract_value(row["contrato"]) != str(d.SUPPORTED_CONTRACT):
                raise PersistenceError(409, "O lote contém contrato não suportado; os dados foram preservados.")
            item: dict[str, Any] = {k: str(row[k] or "") for k in ("modelo", "tipo", "contrato", "razao_social", "endereco_instalacao",
                "retirada_cnpj", "retirada_endereco", "retirada_cidade", "retirada_uf", "retirada_cep")}
            serial = row["serie_bruta"]
            normalized = d.normalize_reference_value(serial)
            base = str(row["apelido_base"] or "")
            # Opaque 64-character revision also covers batch/version and avoids ABA.
            revision = hashlib.sha256(canonical([str(row["lote_id"]), str(row["id"]), row["versao"],
                d._equipment_revision(serial, row["modelo"], row["tipo"], base, row["id_cliente"]) ]).encode()).hexdigest()
            item.update(serial=serial, idCliente=str(row["id_cliente"] or ""),
                descricao_sugerida=d.get_suggested_description(row["tipo"], row["modelo"]),
                _apelido_base=base, _apelido_local=manual.get(normalized, base),
                _apelido_manual_override=normalized in manual, _revisao=revision, _db_id=row["id"], _db_version=row["versao"])
            d._apply_effective_alias(item, index, details_duplicate=counts[normalized] > 1)
            cache[row["chave_api"]] = item
        units = []
        for row in snapshot["units"]:
            # Keep unknown legacy fields when a full custom record was preserved.
            item = json.loads(row["registro_original"]) if row["registro_original"] else {}
            item.update({k: str(row[k] or "") for k in ("cidade", "endereco", "uf", "cep", "cnpj")})
            item["id"] = row["id"]
            if row["source_key"]:
                item["_source_key"] = row["source_key"]
            item.setdefault("is_sede", "sede" in (item["cidade"] + item["endereco"]).lower())
            item["endereco_completo"] = f'{item["endereco"]} - {item["cidade"]}/{item["uf"]} - CEP {item["cep"]}'
            item["label"] = f'{item["cidade"]} - {item["endereco"]} ({item["cnpj"]})'
            units.append(item)
        units.sort(key=lambda u: (not u.get("is_sede", False), u["cidade"], u["endereco"]))
        alias_changes = sum(cache[r["chave_api"]]["apelido"] != str(r["apelido_base"] or "") for r in snapshot["rows"])
        client_changes = sum(str(r["id_cliente"] or "") != str(d._record_value(r.get("source_data") or {},"IdCliente") or "") for r in snapshot["rows"])
        export_available = self.files.storage is not None and bool(snapshot["global"]["modelo_exportacao_id"]) and bool(cache) and all(n==1 for n in counts.values())
        stats = {"total_equipamentos": len(cache), "total_unidades": len(units),
            "total_apelidos_modificados": alias_changes, "total_id_clientes_modificados": client_changes,
            "total_alteracoes_exportaveis": alias_changes+client_changes, "exportacao_disponivel": export_available,
            "exportacao_motivo": "OK" if export_available else "Importe um modelo privado compatível e confira duplicidades antes de exportar.",
            "tipos": dict(Counter(r["tipo"] or "" for r in snapshot["rows"])),
            "arquivo_origem": "PostgreSQL local", "ultima_atualizacao": snapshot["global"]["atualizado_em"].strftime("%d/%m/%Y %H:%M")}
        return {**d.prepare_database_state(cache, units, stats), "aliases": snapshot["aliases"],
                "history": snapshot["history"], "revision": snapshot["global"]["revisao_global"],
                "transfer_available": self.files.storage is not None and bool(snapshot["global"]["modelo_transferencia_id"])}

    def state(self):
        with self.transaction() as conn:
            result = self.project(self._snapshot(conn))
        return result

    def execute(self, command, payload, idempotency_key=None):
        if idempotency_key is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", idempotency_key):
            raise PersistenceError(422, "Idempotency-Key deve conter de 1 a 128 letras, números, ponto, hífen, dois-pontos ou sublinhado.")
        key = command + ":" + (idempotency_key or uuid.uuid4().hex)
        digest = hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()
        with self.transaction(write=True) as conn:
            snapshot = self._snapshot(conn, lock=True)
            previous = conn.execute("select pedido_sha256,estado,resultado from simpress.operacoes where chave_idempotencia=%s", (key,)).fetchone()
            if previous:
                if previous["pedido_sha256"] != digest or previous["estado"] != "confirmada" or previous["resultado"] is None:
                    raise PersistenceError(409, "A chave de idempotência já foi usada com outro pedido ou operação incompleta.")
                result = previous["resultado"]
            else:
                current = self.project(snapshot)
                handler = {"equipment": self._save_equipment, "unit": self._save_unit,
                           "alias": self._save_alias, "undo": self._undo_alias, "delete_history": self._delete_history}[command]
                result = handler(conn, payload, snapshot, current)
                revision = snapshot["global"]["revisao_global"]
                updated = conn.execute("update simpress.estado_aplicacao set revisao_global=revisao_global+1,atualizado_em=now() where id=1 and revisao_global=%s", (revision,))
                if updated.rowcount != 1:
                    raise PersistenceError(409, "A revisão global mudou; nenhuma gravação foi confirmada.")
                # Prepare all derived data before commit; do not publish a global cache.
                after = self.project(self._snapshot(conn))
                if command == "unit":
                    result["unidades"] = [{k:v for k,v in u.items() if k != "_source_key"} for u in after["unidades_cache"]]
                else:
                    serial = result.pop("_serial")
                    result["equipamento"] = self.domain._public_equipment(after["equipamentos_cache"][serial])
                    if command != "delete_history":
                        result["total_modificados"] = len(after["aliases"])
                conn.execute("""insert into simpress.operacoes
                    (chave_idempotencia,tipo,estado,revisao_esperada,revisao_confirmada,pedido_sha256,resultado)
                    values (%s,'edicao','confirmada',%s,%s,%s,%s)""", (key, revision, revision+1, digest, Jsonb(result)))
        return result

    @staticmethod
    def _require_equipment(current, serial):
        item = current["equipamentos_cache"].get(serial)
        if item is None:
            raise PersistenceError(404, f"Equipamento com serial '{serial}' não encontrado na base de dados.")
        return item

    def _save_equipment(self, conn, payload, snapshot, current):
        data = payload["data"]
        fields = set(payload["fields"])
        serial = data["serial"].strip().upper()
        normalized = self.domain.normalize_reference_value(serial)
        item = current["equipamentos_cache"].get(serial)
        if item and data["novo"]:
            raise PersistenceError(409, "A série já está cadastrada; atualize a base antes de criar um novo equipamento.")
        if item is None and not data["novo"]:
            raise PersistenceError(409, "Este equipamento não está mais na base carregada; recarregue o inventário antes de editar.")
        if item and (not data["revisao"] or not hmac.compare_digest(data["revisao"], item["_revisao"])):
            raise PersistenceError(409, "O equipamento foi alterado desde a leitura; recarregue os dados antes de salvar.")
        if any(self.domain.normalize_reference_value(r["serie_bruta"]) == normalized
               and (item is None or r["id"] != item["_db_id"]) for r in snapshot["rows"]):
            raise PersistenceError(409, "A série está duplicada na base ativa; nenhum registro foi alterado.")
        batch = snapshot["global"]["lote_ativo_id"]
        valid = conn.execute("select estado from simpress.lotes_inventario where id=%s", (batch,)).fetchone()
        if not valid or valid["estado"] != "validado":
            raise PersistenceError(409, "Nenhum lote validado está ativo; a importação pertence às próximas etapas.")
        def value(field, cache_key):
            return str(item.get(cache_key) or "").strip() if item and field not in fields else str(data.get(field) or "").strip()
        model, kind, client = value("modelo", "modelo"), value("tipo", "tipo"), value("idCliente", "idCliente")
        if item:
            # Dedicated alias route owns overrides; equipment edits retain base alias.
            updated = conn.execute("""update simpress.equipamentos_lote set modelo=%s,tipo=%s,id_cliente=%s,
                versao=versao+1,atualizado_em=now() where id=%s and versao=%s""",
                (model, kind, client, item["_db_id"], item["_db_version"]))
            if updated.rowcount != 1:
                raise PersistenceError(409, "O equipamento mudou durante a gravação; nenhuma alteração foi confirmada.")
        else:
            alias = str(data.get("apelido") or "").strip()
            conn.execute("""insert into simpress.equipamentos_lote
                (lote_id,origem,serie_bruta,chave_api,serie_normalizada,modelo,tipo,apelido_base,id_cliente,contrato,razao_social,
                 retirada_uf,retirada_endereco) values (%s,'manual',%s,%s,%s,%s,%s,%s,%s,%s,%s,'PR','/PR')""",
                (batch, serial, serial, normalized, model, kind, alias, client,
                 str(self.domain.SUPPORTED_CONTRACT), self.domain.SUPPORTED_CONTRACT_LEGAL_NAME))
            if alias:
                self._put_alias(conn, serial, alias)
        return {"sucesso": True, "mensagem": f"Equipamento {serial} atualizado com sucesso no banco local!", "_serial": serial}

    def _save_unit(self, conn, data, snapshot, current):
        d = self.domain
        uid = data.get("id")
        units = current["unidades_cache"]
        selected = next((u for u in units if uid and u["id"] == uid), None)
        if uid and not selected:
            raise PersistenceError(409, "A unidade selecionada não está mais no catálogo. Atualize a lista antes de editar.")
        if not uid:
            same = next((u for u in units if d._unit_identity_key(u) == d._unit_identity_key(data)), None)
            if same and any(r["id"] == same["id"] and r["origem"] == "customizada" for r in snapshot["units"]):
                return {"sucesso": True, "mensagem": f"Unidade '{data['cidade']}' cadastrada/atualizada com sucesso!"}
            uid = conn.execute("select coalesce(max(id),0)+1 as id from simpress.unidades_catalogo").fetchone()["id"]
        if not 0 < uid <= MAX_UNIT_ID:
            raise PersistenceError(409, "O identificador da unidade excede o limite seguro do catálogo.")
        values = tuple(data[k] for k in ("cidade", "endereco", "uf", "cep", "cnpj"))
        conn.execute("""insert into simpress.unidades_catalogo(id,source_key,origem,cidade,endereco,uf,cep,cnpj)
            values (%s,%s,'customizada',%s,%s,%s,%s,%s) on conflict(id) do update set
            cidade=excluded.cidade,endereco=excluded.endereco,uf=excluded.uf,cep=excluded.cep,cnpj=excluded.cnpj,
            origem='customizada',versao=simpress.unidades_catalogo.versao+1""",
            (uid, selected.get("_source_key") if selected else None, *values))
        record = {**(selected or {}), **data, "id": uid}
        conn.execute("""insert into simpress.unidades_customizadas(unidade_id,source_key_legada,cidade,endereco,uf,cep,cnpj,registro_original)
            values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict(unidade_id) do update set
            cidade=excluded.cidade,endereco=excluded.endereco,uf=excluded.uf,cep=excluded.cep,cnpj=excluded.cnpj,
            registro_original=excluded.registro_original,versao=simpress.unidades_customizadas.versao+1,atualizado_em=now()""",
            (uid, record.get("_source_key"), *values, canonical(record)))
        return {"sucesso": True, "mensagem": f"Unidade '{data['cidade']}' cadastrada/atualizada com sucesso!"}

    def _put_alias(self, conn, serial, alias):
        normalized = self.domain.normalize_reference_value(serial)
        conn.execute("delete from simpress.apelidos_manuais where serie_normalizada=%s", (normalized,))
        conn.execute("insert into simpress.apelidos_manuais(chave_serie_original,serie_normalizada,apelido) values (%s,%s,%s)",
                     (serial, normalized, alias))

    def _change_alias(self, conn, serial, alias, item, action="alteracao", reference=None, history=True):
        before = str(item.get("_apelido_local") or "").strip()
        self._put_alias(conn, serial, alias)
        conn.execute("""update simpress.equipamentos_lote set versao=versao+1,atualizado_em=now()
            where lote_id=(select lote_ativo_id from simpress.estado_aplicacao where id=1)
            and serie_normalizada=%s""", (self.domain.normalize_reference_value(serial),))
        if history and before != alias:
            event = {"id": uuid.uuid4().hex, "tipo": "apelido", "serial": serial,
                "equipamento": item.get("modelo") or item.get("tipo") or "Equipamento", "apelido_anterior": before,
                "apelido_novo": alias, "horario": datetime.now().astimezone().isoformat(timespec="seconds"),
                "acao": action, "referencia_id": reference}
            conn.execute("""insert into simpress.historico_apelidos(evento_id,horario_original,horario,tipo,serie_bruta,
                serie_normalizada,equipamento,apelido_anterior,apelido_novo,acao,referencia_id_original,registro_original)
                values (%s,%s,%s,'apelido',%s,%s,%s,%s,%s,%s,%s,%s)""",
                (event["id"], event["horario"], datetime.fromisoformat(event["horario"]), serial,
                 self.domain.normalize_reference_value(serial), event["equipamento"], before, alias, action, reference, canonical(event)))
        return {"sucesso": True, "_serial": serial, "apelido_anterior": before, "apelido_novo": alias,
                "salvo_no_disco": True, "mensagem": "Apelido salvo no banco local para as próximas pesquisas e exportações."}

    def _save_alias(self, conn, data, snapshot, current):
        serial = data["serial"].strip().upper()
        item = self._require_equipment(current, serial)
        return self._change_alias(conn, serial, data["apelido"].strip(), item)

    def _restore_alias(self, conn, data, current, *, remove):
        event = next((e for e in current["history"] if e.get("id") == data["evento_id"]), None)
        if not event:
            raise PersistenceError(404, "A alteração selecionada não existe no histórico.")
        serial = str(event.get("serial") or "").strip().upper()
        item = self._require_equipment(current, serial)
        if event.get("tipo") == "endereco":
            raise PersistenceError(409, "Endereços são atualizados pela planilha da Simpress e não podem mais ser restaurados manualmente.")
        latest = next((e for e in reversed(current["history"]) if str(e.get("serial") or "").strip().upper() == serial and e.get("tipo") != "endereco"), None)
        aliases = [v for k,v in current["aliases"].items() if self.domain.normalize_reference_value(k) == self.domain.normalize_reference_value(serial)]
        if (not latest or latest["id"] != event["id"] or len(aliases) != 1
                or str(aliases[0] or "").strip() != str(event.get("apelido_novo") or "").strip()
                or str(item.get("_apelido_local") or "").strip() != str(event.get("apelido_novo") or "").strip()):
            raise PersistenceError(409, "Só é possível restaurar a alteração manual mais recente e ainda vigente deste equipamento.")
        result = self._change_alias(conn, serial, str(event.get("apelido_anterior") or "").strip(), item,
                                    action="desfazer", reference=event["id"], history=not remove)
        if remove:
            conn.execute("delete from simpress.historico_apelidos where evento_id=%s", (event["id"],))
            return {"sucesso": True, "_serial": serial, "evento_id": event["id"], "tipo": "apelido",
                    "mensagem": "Valor anterior restaurado para pesquisas e exportações; registro removido do histórico."}
        result["mensagem"] = "Apelido restaurado; a reversão foi registrada no histórico."
        return result

    def _undo_alias(self, conn, data, snapshot, current):
        return self._restore_alias(conn, data, current, remove=False)

    def _delete_history(self, conn, data, snapshot, current):
        return self._restore_alias(conn, data, current, remove=True)
