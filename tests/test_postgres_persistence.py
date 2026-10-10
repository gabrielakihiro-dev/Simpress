"""Focused configuration, dispatch and isolation checks; no operational files/DB."""

from contextlib import contextmanager
import importlib.util
import unittest
from unittest.mock import Mock, patch

from persistence.config import PersistenceError, PersistenceSettings
from persistence.boundary import PersistenceBoundaryMiddleware, idempotency_key, pilot_route_allowed
import main


class PersistenceConfigurationTests(unittest.TestCase):
    def environment(self):
        return {"SIMPRESS_PERSISTENCE_BACKEND": "postgres", "SIMPRESS_POSTGRES_LOCAL_PILOT": "1",
                "SIMPRESS_DATABASE_URL": "postgresql://simpress_piloto_login:synthetic@127.0.0.1:54322/postgres"}

    def test_files_is_default_and_ignores_unused_credentials(self):
        self.assertEqual(PersistenceSettings.from_environment({}).backend, "files")
        self.assertEqual(PersistenceSettings.from_environment({"SIMPRESS_DATABASE_URL": "invalid"}).backend, "files")

    def test_unknown_backend_fails_closed(self):
        with self.assertRaises(PersistenceError):
            PersistenceSettings.from_environment({"SIMPRESS_PERSISTENCE_BACKEND": "typo"})

    def test_pilot_requires_explicit_opt_in(self):
        env = self.environment()
        env.pop("SIMPRESS_POSTGRES_LOCAL_PILOT")
        with self.assertRaises(PersistenceError):
            PersistenceSettings.from_environment(env)

    def test_local_config_and_secret_redaction(self):
        cfg = PersistenceSettings.from_environment(self.environment())
        self.assertEqual(cfg.pool_size, 4)
        self.assertNotIn("synthetic", repr(cfg))

    def test_remote_admin_hosts_options_and_invalid_limits_rejected(self):
        for replacement in ("@example.org:54322", "@localhost:54322", "@127.0.0.1:5432",
                            "@127.0.0.1,example.org:54322"):
            env = self.environment()
            env["SIMPRESS_DATABASE_URL"] = env["SIMPRESS_DATABASE_URL"].replace("@127.0.0.1:54322", replacement)
            with self.subTest(replacement=replacement), self.assertRaises(PersistenceError):
                PersistenceSettings.from_environment(env)
        for suffix in ("?host=example.org", "?options=-crole=postgres", "#fragment"):
            env = self.environment()
            env["SIMPRESS_DATABASE_URL"] += suffix
            with self.subTest(suffix=suffix), self.assertRaises(PersistenceError):
                PersistenceSettings.from_environment(env)
        for name in ("postgres", "service_role", "supabase_admin"):
            env = self.environment()
            env["SIMPRESS_DATABASE_URL"] = env["SIMPRESS_DATABASE_URL"].replace("simpress_piloto_login", name)
            with self.subTest(name=name), self.assertRaises(PersistenceError):
                PersistenceSettings.from_environment(env)
        for size in ("0", "9", "invalid"):
            env = {**self.environment(), "SIMPRESS_DATABASE_POOL_SIZE": size}
            with self.subTest(size=size), self.assertRaises(PersistenceError):
                PersistenceSettings.from_environment(env)

    def test_route_boundary_enables_stage_6_with_exact_methods(self):
        for method,path in (("POST","/api/planilhas/atualizar"),("GET","/api/exportar-equipamentos"),
                            ("POST","/api/gerar-planilha"),("GET","/api/historico-comparacoes"),
                            ("PUT","/api/historico-comparacoes/a/anotacoes/b"),
                            ("GET","/api/operacoes/pendencias"),
                            ("GET","/api/operacoes/evolucao")):
            self.assertTrue(pilot_route_allowed(method,path))
        for path in ("/api/piloto/unknown","/api/historico-comparacoes/a/anotacao"):
            self.assertFalse(pilot_route_allowed("POST", path))
            self.assertFalse(pilot_route_allowed("GET", path))
        self.assertTrue(pilot_route_allowed("GET", "/api/equipamento/SN1"))
        self.assertTrue(pilot_route_allowed("POST", "/api/unidade/salvar"))
        for method, path in (
            ("GET", "/api/operacoes/chamados"),
            ("GET", "/api/operacoes/chamados/historico"),
            ("DELETE", "/api/operacoes/chamados/historico/antigas"),
            ("GET", "/api/operacoes/chamados/snapshot/version-1"),
            ("GET", "/api/operacoes/chamados/evolucao"),
            ("GET", "/api/operacoes/chamados/exportar"),
            ("POST", "/api/operacoes/chamados/importar"),
        ):
            self.assertFalse(pilot_route_allowed(method, path))

    def test_request_context_is_reset_and_nonlocal_requests_denied(self):
        observations, messages = [], []
        async def app(scope, receive, send):
            observations.append(idempotency_key.get())
        async def receive():
            return {"type": "http.request", "body": b""}
        async def send(message):
            messages.append(message)
        middleware = PersistenceBoundaryMiddleware(app, lambda: True)
        scope = {"type": "http", "client": ("127.0.0.1", 1234), "path": "/api/stats",
                 "method": "GET", "headers": [(b"idempotency-key", b"synthetic-request")]}
        # These coroutines perform no I/O or suspension. Drive them directly to
        # avoid the Windows sandbox's unrelated asyncio socketpair hang.
        def run_immediate(coroutine):
            try:
                coroutine.send(None)
            except StopIteration:
                return
            finally:
                coroutine.close()
            self.fail("Unexpected asynchronous suspension in the middleware fixture")
        run_immediate(middleware(scope, receive, send))
        self.assertEqual(observations, ["synthetic-request"])
        self.assertIsNone(idempotency_key.get())
        run_immediate(middleware({**scope, "client": ("192.0.2.1", 1234)}, receive, send))
        self.assertEqual(messages[0]["status"], 403)
        self.assertEqual(len(observations), 1)

    def test_uninitialized_postgres_does_not_fall_back(self):
        with patch.object(main, "PERSISTENCE_SETTINGS", PersistenceSettings("postgres")), patch.object(main, "_POSTGRES_BACKEND", None):
            with self.assertRaises(PersistenceError):
                main.get_equipamento("SYNTHETIC")

    def test_postgres_routes_do_not_access_legacy_files(self):
        backend = Mock()
        backend.execute.return_value = {"sucesso": True}
        backend.state.return_value = {"aliases": {}, "history": [], "equipamentos_cache": {},
                                      "unidades_cache": [], "stats_cache": {"total_equipamentos": 0}}
        with (patch.object(main, "PERSISTENCE_SETTINGS", PersistenceSettings("postgres")),
              patch.object(main, "_POSTGRES_BACKEND", backend),
              patch.object(main, "get_details_files", side_effect=AssertionError("legacy read")),
              patch.object(main, "_read_json_object", side_effect=AssertionError("legacy read")),
              patch.object(main, "AtomicFileTransaction", side_effect=AssertionError("legacy write"))):
            self.assertEqual(main.load_modified_apelidos(), {})
            self.assertEqual(main.load_alias_history(), [])
            self.assertTrue(main.salvar_equipamento(main.EquipamentoUpdatePayload(serial="SYNTHETIC", novo=True))["sucesso"])
            self.assertTrue(main.salvar_unidade(main.UnidadePayload(cidade="Teste", endereco="Rua", cnpj="00000000000000"))["sucesso"])
            self.assertEqual(main.get_stats()["total_equipamentos"], 0)


@unittest.skipUnless(importlib.util.find_spec("psycopg") and importlib.util.find_spec("psycopg_pool"), "optional PostgreSQL dependencies not installed")
class CommitBoundaryTests(unittest.TestCase):
    def test_commit_failure_never_returns_prepared_success(self):
        from persistence.postgres import PostgresBackend
        backend = object.__new__(PostgresBackend)
        conn = Mock()
        conn.execute.return_value.fetchone.return_value = {"pedido_sha256": "unused"}
        @contextmanager
        def transaction(**kwargs):
            yield conn
            raise PersistenceError(503, "synthetic commit failure")
        backend.transaction = transaction
        backend._snapshot = lambda *args, **kwargs: {}
        # Exercise the idempotent response path: even it must wait for tx exit.
        from persistence.postgres import canonical
        import hashlib
        conn.execute.return_value.fetchone.return_value = {"pedido_sha256": hashlib.sha256(canonical({}).encode()).hexdigest(),
                                                         "estado": "confirmada", "resultado": {"sucesso": True}}
        with self.assertRaisesRegex(PersistenceError, "commit failure"):
            backend.execute("unit", {}, "synthetic")


if __name__ == "__main__":
    unittest.main()
