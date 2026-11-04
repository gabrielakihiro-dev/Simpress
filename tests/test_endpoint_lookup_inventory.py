"""The official workbook's duplicate count must survive unavailable Endpoint and refresh."""
import copy
import unittest
from unittest.mock import patch, MagicMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from domains import endpoint_lookup, inventory_state, inventory_update
from routers.endpoint_lookup import create_endpoint_lookup_router
from scripts import verificar_usuarios_endpoint as grid
from tests import test_integrity_workflows as workflows
from tests.test_endpoint_lookup import grade


class EndpointInventoryUniquenessTests(unittest.TestCase):
    def setUp(self):
        self.fixture = workflows.WorkflowIntegrityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.rows = [
            ("SABC", "LOCAL-A", "MacBook Air", "Curitiba", "MacBook", "80000000"),
            ("SABC", "LOCAL-B", "MacBook Air", "Curitiba", "MacBook", "80000000"),
        ]
        workflows.make_details(self.fixture.details, self.rows)
        workflows.make_model(self.fixture.model)

    def test_real_load_without_endpoint_retains_duplicate_fact_and_blocks_mac_route(self):
        self.assertTrue(workflows.main.load_database())
        equipment = inventory_state.equipamentos_cache["SABC"]
        self.assertEqual(equipment["invall_alias_status"], "indisponivel")
        self.assertTrue(equipment.get("serie_detalhes_duplicada"))
        self.assertEqual(len(inventory_state.equipamentos_cache), 1)
        app = FastAPI()
        def lookup(serial, macbook, serials):
            return endpoint_lookup.consultar_grade(MagicMock(), MagicMock(), serial, macbook, serials)
        app.include_router(create_endpoint_lookup_router(
            get_snapshot=workflows.main._endpoint_lookup_snapshot, lookup=lookup,
        ))
        with patch.object(grid, "aplicar_filtro", side_effect=[grade([]), grade([("ABC", "wrong", "other-machine")])]) as search:
            result = TestClient(app).post("/api/endpoint/consultar", json={"serial": "SABC"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), {"status": "ambiguous", "serial": "SABC", "origem": "base_local"})
        self.assertEqual(search.call_count, 1)

    def test_import_refresh_does_not_reconstruct_duplicate_from_unavailable_alias_status(self):
        self.assertTrue(workflows.main.load_database())
        cached = copy.deepcopy(inventory_state.equipamentos_cache["SABC"])
        # This is the state that comes from a valid local load while InvAll cannot be read.
        cached["serie_detalhes_duplicada"] = True
        cached["invall_alias_status"] = "indisponivel"
        inventory_update._apply_held_aliases(
            workflows.main._inventory_update_services, {"equipamentos_cache": {"SABC": cached}},
            {"available": True, "unique": {"SABC": "PRMAC-LIVE"}}, {},
            self.fixture.state_dir / "manual.json",
            {"SABC": {"tipo": "usuario_ausente", "usuario_atual": "User", "estado": "pendente"}}, {},
        )
        self.assertTrue(cached["serie_detalhes_duplicada"])
        self.assertEqual(cached["invall_alias_status"], "serie_detalhes_duplicada")
        self.assertNotEqual(cached["apelido"], "PRMAC-LIVE")

    def test_full_inventory_import_retains_the_official_duplicate_fact(self):
        self.assertTrue(workflows.main.load_database())
        result = self.fixture._submit_inventory_update(
            workflows._endpoint_bytes([("ABC", "PRMAC-LIVE")]),
            workflows._details_bytes(self.rows), "endpoint-duplicate-fact",
        )
        self.assertTrue(result["sucesso"])
        self.assertTrue(inventory_state.equipamentos_cache["SABC"].get("serie_detalhes_duplicada"))

    def test_snapshot_contains_only_relevant_collision_and_equipment_facts(self):
        self.assertTrue(workflows.main.load_database())
        with workflows.main.STATE_LOCK:
            inventory_state.equipamentos_cache["UNRELATED"] = {"serial": "UNRELATED", "usuarios_logados": "private"}
            inventory_state.equipamentos_cache["ABC"] = {"serial": "ABC", "modelo": "Other"}
        snapshot = workflows.main._endpoint_lookup_snapshot("SABC")
        self.assertEqual(snapshot["details_serials"], ("ABC", "SABC"))
        self.assertTrue(snapshot["serie_detalhes_duplicada"])
        self.assertEqual(snapshot["modelo"], "MacBook Air")
        self.assertNotIn("private", str(snapshot))

    def test_snapshot_reads_equipment_and_collision_keys_inside_one_lock(self):
        self.assertTrue(workflows.main.load_database())
        held = []
        case = self
        class GuardedCache(dict):
            def get(self, *args):
                case.assertTrue(held, "equipment read escaped STATE_LOCK")
                return super().get(*args)
            def __iter__(self):
                case.assertTrue(held, "collision keys escaped STATE_LOCK")
                return super().__iter__()
        gate = MagicMock()
        gate.__enter__.side_effect = lambda: held.append(True)
        gate.__exit__.side_effect = lambda *args: held.pop()
        cache = GuardedCache(inventory_state.equipamentos_cache)
        with patch.object(workflows.main, "STATE_LOCK", gate), patch.object(inventory_state, "equipamentos_cache", cache):
            snapshot = workflows.main._endpoint_lookup_snapshot("SABC")
        self.assertEqual(snapshot["details_serials"], ("SABC",))
        gate.__enter__.assert_called_once()
        self.assertFalse(held)

    def test_import_during_long_mac_lookup_discards_pre_import_user(self):
        workflows.make_details(self.fixture.details, self.rows[:1])
        self.assertTrue(workflows.main.load_database())
        app = FastAPI()
        def lookup(serial, macbook, serials):
            self.assertTrue(macbook)
            self.assertEqual(serials, ("SABC",))
            result = endpoint_lookup.consultar_grade(MagicMock(), MagicMock(), serial, macbook, serials)
            imported = self.fixture._submit_inventory_update(
                workflows._endpoint_bytes([("ABC", "PRMAC-LIVE")]),
                workflows._details_bytes(self.rows), "import-during-endpoint-read",
            )
            self.assertTrue(imported["sucesso"])
            return result
        app.include_router(create_endpoint_lookup_router(get_snapshot=workflows.main._endpoint_lookup_snapshot, lookup=lookup))
        with patch.object(grid, "limpar_filtro"), patch.object(grid, "aplicar_filtro", side_effect=[grade([]), grade([("ABC", "wrong", "must-not-escape")])]):
            result = TestClient(app).post("/api/endpoint/consultar", json={"serial": "SABC"})
        self.assertEqual(result.json(), {"status": "ambiguous", "serial": "SABC", "origem": "base_local"})
        self.assertNotIn("must-not-escape", result.text)
