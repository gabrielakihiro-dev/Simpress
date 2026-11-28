"""Remoção do hostname mais antigo nas duplicidades do Endpoint."""

import copy
import dataclasses
import json
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import openpyxl

import main
from core.errors import DomainConflictError, DomainError
from core.integrity import FileTransactionError
from domains import endpoint_removals, inventory_state
from domains.effective_alias import build_endpoint_alias_index
from domains.history_annotations import history_annotation_row_fingerprint
from domains.inventory_comparison import compare_uploaded_workbooks
import test_integrity_workflows as base
from test_integrity_workflows import make_details, make_model

REFERENCE = datetime(2026, 10, 19, 12, 0, tzinfo=timezone(timedelta(hours=-3)))


def endpoint_record(serial, hostname, verified=None):
    record = {"SERIAL": serial, "NOMEDOCOMPUTADOR": hostname}
    if verified is not None:
        record["ULTIMAVERIFICACAOCOMEXITO"] = verified.isoformat()
    return record


def source_table(records):
    return {"sheet": "Inventario", "headers": set(), "records": records}


def make_endpoint(path: Path, rows):
    workbook = openpyxl.Workbook()
    worksheet = workbook.active
    worksheet.title = "InvAllComputersSummary"
    worksheet.append(["ROTULODESERVICONUMERODESERIE", "NOMEDOCOMPUTADOR", "ULTIMAVERIFICACAOCOMEXITO"])
    for row in rows:
        worksheet.append(list(row))
    workbook.save(path)
    workbook.close()


class IndexTests(unittest.TestCase):
    def test_removed_pair_makes_the_remaining_hostname_unique(self):
        records = [endpoint_record("SN-1", "HOST-OLD"), endpoint_record("SN-1", "HOST-NEW")]
        self.assertIn("SN1", build_endpoint_alias_index(records)["duplicates"])

        index = build_endpoint_alias_index(records, endpoint_removals.removal_keys([
            {"serie": "sn-1", "hostname": "host old"},
        ]))

        self.assertEqual(index["unique"], {"SN1": "HOST-NEW"})
        self.assertEqual(index["duplicates"], {})

    def test_malformed_entries_never_match(self):
        keys = endpoint_removals.removal_keys([None, "x", {"serie": "SN-1"}, {"hostname": "H"}, {}])
        self.assertEqual(keys, frozenset())


class ComparisonTests(unittest.TestCase):
    def _records(self):
        return [
            endpoint_record("SN-1", "PRNOTE-OLD", REFERENCE - timedelta(days=30)),
            endpoint_record("SN-1", "PRNOTE-NEW", REFERENCE - timedelta(hours=2)),
        ]

    def test_ambiguous_record_flags_only_the_single_oldest_hostname(self):
        result = compare_uploaded_workbooks(source_table(self._records()), source_table([]), {}, as_of=REFERENCE)

        rows = result["registros_ambiguos"][0]["registros_endpoint"]
        self.assertEqual({row["computador"]: row["mais_antigo"] for row in rows}, {"PRNOTE-OLD": True, "PRNOTE-NEW": False})
        self.assertTrue(all(row["ultima_verificacao"] for row in rows))

    def test_ambiguous_record_marks_the_applied_hostname_only_when_resolved(self):
        result = compare_uploaded_workbooks(source_table(self._records()), source_table([]), {}, as_of=REFERENCE)
        rows = result["registros_ambiguos"][0]["registros_endpoint"]
        self.assertEqual({row["computador"]: row["aplicado"] for row in rows}, {"PRNOTE-OLD": False, "PRNOTE-NEW": True})

        same = REFERENCE - timedelta(days=3)
        tied = [endpoint_record("SN-1", "PRNOTE-A", same), endpoint_record("SN-1", "PRNOTE-B", same)]
        result = compare_uploaded_workbooks(source_table(tied), source_table([]), {}, as_of=REFERENCE)
        rows = result["registros_ambiguos"][0]["registros_endpoint"]
        self.assertFalse(any(row["aplicado"] for row in rows))

    def test_no_button_when_dates_are_missing_tied_or_hostnames_repeat(self):
        same = REFERENCE - timedelta(days=3)
        cases = {
            "missing": [endpoint_record("SN-1", "PRNOTE-A", same), endpoint_record("SN-1", "PRNOTE-B")],
            "tied": [endpoint_record("SN-1", "PRNOTE-A", same), endpoint_record("SN-1", "PRNOTE-B", same)],
            "same host": [
                endpoint_record("SN-1", "PRNOTE-A", same - timedelta(days=1)),
                endpoint_record("SN-1", "prnote-a", same),
            ],
        }
        for name, records in cases.items():
            with self.subTest(name):
                result = compare_uploaded_workbooks(source_table(records), source_table([]), {}, as_of=REFERENCE)
                rows = result["registros_ambiguos"][0]["registros_endpoint"]
                self.assertFalse(any(row["mais_antigo"] for row in rows))

    def test_removed_hostname_leaves_the_comparison_but_not_the_total(self):
        removed = endpoint_removals.removal_keys([{"serie": "SN-1", "hostname": "PRNOTE-OLD"}])

        result = compare_uploaded_workbooks(
            source_table(self._records()), source_table([]), {}, as_of=REFERENCE,
            removed_endpoint_hostnames=removed,
        )

        self.assertEqual(result["total_endpoint"], 2)
        self.assertEqual(result["registros_ambiguos"], [])
        self.assertEqual(result["sem_acesso_7_dias"], [])

    def test_annotation_fingerprint_ignores_the_volatile_ambiguity_fields(self):
        base_row = {"computador": "H", "serie": "S", "motivo": "m"}
        enriched = {
            **base_row,
            "ultima_verificacao": "2026-10-19T10:00",
            "registros_endpoint": [{"computador": "H", "mais_antigo": True}],
        }
        self.assertEqual(
            history_annotation_row_fingerprint("registros_ambiguos", base_row),
            history_annotation_row_fingerprint("registros_ambiguos", enriched),
        )
        self.assertNotEqual(
            history_annotation_row_fingerprint("sem_acesso_7_dias", base_row),
            history_annotation_row_fingerprint("sem_acesso_7_dias", enriched),
        )

    def test_annotation_fingerprint_ignores_the_administrator_signal(self):
        row = {"computador": "H", "serie": "S"}
        for category in ("registros_ambiguos", "divergencias_local"):
            self.assertEqual(
                history_annotation_row_fingerprint(category, row),
                history_annotation_row_fingerprint(category, {**row, "usuario_administrador": True}),
            )


class RemovalWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_context = tempfile.TemporaryDirectory(prefix=".endpoint-removal-test-", dir=tempfile.gettempdir())
        self.root = Path(self.temp_context.name)
        self.input_dir = self.root / "planilhas_entrada"
        self.input_dir.mkdir()
        self.state_dir = self.root / "state"
        self.state_dir.mkdir()
        self.details = self.input_dir / "EquipamentosDetalhes_atual.xlsx"
        self.endpoint = self.input_dir / "InvAllComputersSummary_atual.xlsx"
        self.model = self.input_dir / "modelo-ficticio.xlsx"
        self.removed = self.root / "hostnames_removidos.json"
        self.pending = self.root / "endpoint_remocoes_pendentes.json"
        self.stack = ExitStack()
        for name, value in (
            ("BASE_DIR", self.root), ("STATE_DIR", self.state_dir), ("INPUT_DIR", self.input_dir),
            ("DETAILS_UPLOAD_FILE", self.details), ("ENDPOINT_UPLOAD_FILE", self.endpoint),
            ("EXPORT_MODEL_FILE", self.model), ("UPLOAD_BACKUPS_DIR", self.input_dir / "_backups"),
            ("MODIFIED_APELIDOS_FILE", self.root / "apelidos_modificados.json"),
            ("MANUAL_USERS_FILE", self.root / "usuarios_manuais.json"),
            ("REMOVED_ENDPOINT_HOSTNAMES_FILE", self.removed),
            ("ENDPOINT_REMOVAL_PENDING_FILE", self.pending),
            ("ALIAS_HISTORY_FILE", self.root / "historico_alteracoes.json"),
            ("COMPARISON_HISTORY_FILE", self.root / "historico_comparacoes.json"),
            ("CUSTOM_UNIDADES_FILE", self.root / "unidades_custom.json"), ("TRANSACTION_ROOT", self.root),
        ):
            self.stack.enter_context(patch.object(main, name, value))
        self.old_state = (
            copy.deepcopy(inventory_state.equipamentos_cache),
            copy.deepcopy(inventory_state.unidades_cache),
            copy.deepcopy(inventory_state.stats_cache),
        )
        inventory_state.equipamentos_cache = {}
        inventory_state.unidades_cache = []
        inventory_state.stats_cache = {}
        (self.root / "apelidos_modificados.json").write_text("{}", encoding="utf-8")
        (self.root / "unidades_custom.json").write_text("[]", encoding="utf-8")
        (self.root / "historico_alteracoes.json").write_text("[]", encoding="utf-8")
        (self.root / "historico_comparacoes.json").write_text("[]", encoding="utf-8")
        make_details(self.details, [("SN-1", "ALIAS-1", "Modelo A", "Maringá", "Notebook", "87000000")])
        make_endpoint(self.endpoint, [
            ("SN-1", "HOST-OLD", "2026-09-01T10:00:00"),
            ("SN-1", "HOST-NEW", "2026-10-19T10:00:00"),
        ])
        make_model(self.model)
        self.assertTrue(main.load_database())
        self.services = main._endpoint_removal_services

    def tearDown(self):
        inventory_state.equipamentos_cache, inventory_state.unidades_cache, inventory_state.stats_cache = self.old_state
        self.stack.close()
        self.temp_context.cleanup()

    def test_removed_hostname_is_the_one_exported_and_can_be_restored(self):
        # Série repetida com datas distintas: o hostname da verificação mais recente nomeia o equipamento,
        # mas a série continua duplicada (fora de "unique").
        self.assertEqual(main.load_endpoint_aliases(), {})
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["apelido"], "HOST-NEW")
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["invall_alias_status"], "aplicado_mais_recente")

        result = endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "HOST-OLD")

        self.assertEqual(result["mantidos"], ["HOST-NEW"])
        self.assertEqual(main.load_endpoint_aliases(), {"SN1": "HOST-NEW"})
        self.assertEqual(main.equipment_export.get_export_aliases(main._equipment_export_services, main.read_endpoint_alias_index())["SN1"], "HOST-NEW")
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["apelido"], "HOST-NEW")
        stored = json.loads(self.removed.read_text(encoding="utf-8"))
        self.assertEqual([(item["serie"], item["hostname"]) for item in stored], [("SN-1", "HOST-OLD")])
        # A planilha de origem continua com as duas linhas.
        self.assertEqual(openpyxl.load_workbook(self.endpoint).active.max_row, 3)

        # Repetir a remoção (por exemplo, um duplo clique) não grava uma segunda entrada.
        with self.assertRaises(DomainConflictError):
            endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "host-old")
        self.assertEqual(len(json.loads(self.removed.read_text(encoding="utf-8"))), 1)

        endpoint_removals.restore_endpoint_hostname(self.services, "SN-1", "HOST-OLD")
        self.assertEqual(main.load_endpoint_aliases(), {})
        self.assertEqual(inventory_state.equipamentos_cache["SN-1"]["apelido"], "HOST-NEW")
        self.assertEqual(json.loads(self.removed.read_text(encoding="utf-8")), [])

    def test_the_last_remaining_hostname_and_unknown_pairs_are_refused(self):
        endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "HOST-OLD")

        with self.assertRaises(DomainConflictError):
            endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "HOST-NEW")
        with self.assertRaises(DomainConflictError):
            endpoint_removals.remove_endpoint_hostname(self.services, "SN-9", "HOST-X")
        with self.assertRaises(DomainError):
            endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "   ")
        self.assertEqual(
            [item["hostname"] for item in json.loads(self.removed.read_text(encoding="utf-8"))],
            ["HOST-OLD"],
        )

    def test_concurrent_removals_of_the_same_series_keep_one_hostname(self):
        # Duas requisições leem o índice antes de qualquer gravação (corrida intercalada).
        stale_index = main.read_endpoint_alias_index()
        self.assertEqual(len(stale_index["duplicates"]["SN1"]), 2)
        stale = dataclasses.replace(self.services, read_endpoint_alias_index=lambda: copy.deepcopy(stale_index))

        first = endpoint_removals.remove_endpoint_hostname(stale, "SN-1", "HOST-OLD")
        self.assertEqual(first["mantidos"], ["HOST-NEW"])

        with self.assertRaises(DomainConflictError) as raised:
            endpoint_removals.remove_endpoint_hostname(stale, "SN-1", "HOST-NEW")
        self.assertEqual(raised.exception.detail, "Ao menos um hostname da série precisa permanecer.")
        self.assertEqual(
            [item["hostname"] for item in json.loads(self.removed.read_text(encoding="utf-8"))],
            ["HOST-OLD"],
        )
        self.assertEqual(main.load_endpoint_aliases(), {"SN1": "HOST-NEW"})

    def _remover(self, resultado):
        chamadas = []

        def remover(hostname, confirmado, corte, antes_do_clique=None, apos_trava=None):
            chamadas.append((hostname, confirmado, corte))
            if apos_trava is not None:
                apos_trava()
            if resultado in ("removido", "incerto") and antes_do_clique is not None:
                antes_do_clique()  # o clique só acontece depois do marcador
            return {"resultado": resultado, "mensagem": "sintético"}

        return remover, chamadas

    def _stored(self):
        return json.loads(self.removed.read_text(encoding="utf-8")) if self.removed.exists() else []

    def _pending(self):
        return json.loads(self.pending.read_text(encoding="utf-8")) if self.pending.exists() else []

    def test_remove_in_endpoint_guards_never_open_the_chrome(self):
        remover, chamadas = self._remover("removido")
        index = main.read_endpoint_alias_index()
        empate = copy.deepcopy(index)
        empate["resolved_by_recency"].pop("SN1")
        outra_unica = copy.deepcopy(index)
        outra_unica["unique"]["SN9"] = "host-old"
        outra_duplicada = copy.deepcopy(index)
        outra_duplicada["duplicates"]["SN8"] = [{"hostname": "HOST OLD"}, {"hostname": "HOST-Z"}]
        sem_serie = copy.deepcopy(index)
        sem_serie["blank_serials"] = [{"serie": "", "hostname": "host-old"}]
        removido_em_outra = dataclasses.replace(
            self.services, load_removals=lambda: [{"serie": "SN-7", "hostname": "HOST-OLD", "removido_em": "x"}])
        casos = [
            (self.services, "SN-9", "HOST-X"),  # par fora das duplicidades
            (self.services, "SN-1", "host new"),  # o hostname vivo nunca é removido
            (dataclasses.replace(self.services, read_endpoint_alias_index=lambda: empate), "SN-1", "HOST-OLD"),
            # o nome antigo também aparece em outra série (única ou duplicada)
            (dataclasses.replace(self.services, read_endpoint_alias_index=lambda: outra_unica), "SN-1", "HOST-OLD"),
            (dataclasses.replace(self.services, read_endpoint_alias_index=lambda: outra_duplicada), "SN-1", "HOST-OLD"),
            # linha sem série com o mesmo nome e linha de outra série escondida por uma remoção local
            (dataclasses.replace(self.services, read_endpoint_alias_index=lambda: sem_serie), "SN-1", "HOST-OLD"),
            (removido_em_outra, "SN-1", "HOST-OLD"),
        ]
        for services, serie, hostname in casos:
            with self.subTest(hostname=hostname), self.assertRaises(DomainConflictError):
                endpoint_removals.remove_in_endpoint(services, serie, hostname, True, remover)
        self.assertEqual(chamadas, [])
        self.assertEqual(self._stored(), [])

    def test_automation_gets_the_raw_index_name_and_the_winner_cut(self):
        remover, chamadas = self._remover("cancelado_sem_confirmacao")
        endpoint_removals.remove_in_endpoint(self.services, "SN-1", "host old", False, remover)
        corte = main.read_endpoint_alias_index()["verified_by_serial"]["SN1"]
        self.assertTrue(corte.startswith("2026-10-19"))  # a verificação do vencedor (HOST-NEW)
        self.assertEqual(chamadas, [("HOST-OLD", False, corte)])

    def test_remove_in_endpoint_writes_locally_only_after_removido(self):
        for resultado in ("nao_encontrado", "cancelado_sem_confirmacao", "contato_recente"):
            remover, chamadas = self._remover(resultado)
            with self.subTest(resultado=resultado):
                saida = endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", False, remover)
                self.assertEqual((saida["resultado"], saida["gravado_local"]), (resultado, False))
                self.assertEqual(len(chamadas), 1)
                self.assertEqual((self._stored(), self._pending()), ([], []))

        remover, chamadas = self._remover("removido")
        saida = endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, remover)
        self.assertEqual((saida["resultado"], saida["gravado_local"], saida["mantidos"]), ("removido", True, ["HOST-NEW"]))
        self.assertEqual([(item["serie"], item["hostname"]) for item in self._stored()], [("SN-1", "HOST-OLD")])
        self.assertEqual(self._pending(), [])

    def test_incerto_is_pending_refuses_a_new_click_and_local_record_clears_it(self):
        remover, chamadas = self._remover("incerto")
        saida = endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, remover)
        self.assertEqual((saida["resultado"], saida["gravado_local"], saida["pendente"]), ("incerto", False, True))
        self.assertEqual([(item["serie"], item["hostname"], item["resultado"]) for item in self._pending()],
                         [("SN-1", "HOST-OLD", "incerto")])
        self.assertEqual(endpoint_removals.list_removals(self.services)["pendentes"][0]["hostname"], "HOST-OLD")

        with self.assertRaises(DomainConflictError) as raised:
            endpoint_removals.remove_in_endpoint(self.services, "sn 1", "host old", True, remover)
        self.assertIn("Gravar só no cockpit", raised.exception.detail)
        self.assertEqual(len(chamadas), 1)  # o Endpoint não foi acionado de novo

        endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "HOST-OLD")  # "Gravar só no cockpit"
        self.assertEqual(self._pending(), [])
        self.assertEqual([(item["serie"], item["hostname"]) for item in self._stored()], [("SN-1", "HOST-OLD")])

    def test_local_write_failure_after_removido_becomes_pending(self):
        remover, chamadas = self._remover("removido")
        original = self.services.atomic_file_transaction

        def falha_no_registro(root, targets):
            if self.removed in targets:
                raise FileTransactionError("disco cheio")
            return original(root, targets)

        broken = dataclasses.replace(self.services, atomic_file_transaction=falha_no_registro)
        saida = endpoint_removals.remove_in_endpoint(broken, "SN-1", "HOST-OLD", True, remover)
        self.assertEqual((saida["resultado"], saida["gravado_local"], saida["pendente"]), ("removido", False, True))
        self.assertIn("Gravar só no cockpit", saida["mensagem"])
        self.assertEqual(len(chamadas), 1)
        self.assertEqual(self._stored(), [])
        self.assertEqual([item["resultado"] for item in self._pending()], ["removido_sem_gravacao_local"])

    def test_exception_after_the_marker_keeps_the_pair_pending(self):
        chamadas = []

        def cai_depois_do_clique(hostname, confirmado, corte, antes_do_clique=None, apos_trava=None):
            chamadas.append(hostname)
            antes_do_clique()
            raise RuntimeError("driver morreu depois do Sim")

        with self.assertRaises(DomainConflictError) as raised:
            endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, cai_depois_do_clique)
        self.assertIn("confira no Endpoint", raised.exception.detail)
        self.assertEqual([item["resultado"] for item in self._pending()], ["em_andamento"])
        with self.assertRaises(DomainConflictError):  # o próximo pedido é recusado sem abrir o Chrome
            endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, cai_depois_do_clique)
        self.assertEqual(len(chamadas), 1)

    def test_marker_becomes_incerto_and_the_lock_rereads_pending(self):
        remover, _ = self._remover("incerto")
        endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, remover)
        self.assertEqual([item["resultado"] for item in self._pending()], ["incerto"])

        # Outro pedido passou pela guarda antes da pendência existir: a releitura depois da trava recusa.
        self.pending.write_text("[]", encoding="utf-8")
        recusas = []

        def outro_pedido(hostname, confirmado, corte, antes_do_clique=None, apos_trava=None):
            self.pending.write_text(json.dumps([{"serie": "SN-1", "hostname": "HOST-OLD", "resultado": "incerto"}]))
            try:
                apos_trava()
            except DomainConflictError:
                recusas.append(True)
                raise
            return {"resultado": "cancelado_sem_confirmacao", "mensagem": "sintético"}

        with self.assertRaises(DomainConflictError):
            endpoint_removals.remove_in_endpoint(self.services, "SN-1", "HOST-OLD", True, outro_pedido)
        self.assertEqual(recusas, [True])

    def test_reload_failure_after_local_record_is_not_a_missing_record(self):
        remover, _ = self._remover("removido")

        def falha_no_reload():
            raise RuntimeError("base ocupada")

        broken = dataclasses.replace(self.services, reload_database=falha_no_reload)
        saida = endpoint_removals.remove_in_endpoint(broken, "SN-1", "HOST-OLD", True, remover)
        self.assertEqual((saida["resultado"], saida["gravado_local"]), ("removido", True))
        self.assertNotIn("falhou", saida["mensagem"])
        self.assertEqual([(item["serie"], item["hostname"]) for item in self._stored()], [("SN-1", "HOST-OLD")])
        self.assertEqual(self._pending(), [])

    def test_marker_write_failure_never_clicks(self):
        cliques = []

        def como_a_automacao(hostname, confirmado, corte, antes_do_clique=None, apos_trava=None):
            try:
                antes_do_clique()
            except Exception:
                return {"resultado": "marcador_nao_gravado", "mensagem": "sintético"}  # fecha pelo Cancel, sem Sim
            cliques.append("sim")
            return {"resultado": "removido", "mensagem": "sintético"}

        def falha(*_args):
            raise FileTransactionError("disco cheio")

        broken = dataclasses.replace(self.services, atomic_file_transaction=falha)
        saida = endpoint_removals.remove_in_endpoint(broken, "SN-1", "HOST-OLD", True, como_a_automacao)
        self.assertEqual((saida["resultado"], saida["gravado_local"]), ("marcador_nao_gravado", False))
        self.assertEqual(cliques, [])
        self.assertEqual((self._stored(), self._pending()), ([], []))

    def test_route_maps_chrome_errors_and_passes_confirmado(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from domains import endpoint_remocao
        from routers.endpoint_removals import create_endpoint_removals_router

        recebido = []

        def remover(hostname, confirmado, **_):
            recebido.append(confirmado)
            return {"resultado": "cancelado_sem_confirmacao", "mensagem": "sintético"}

        def ocupado(hostname, confirmado, **_):
            raise endpoint_remocao.automation.TravaOcupada("ocupado")

        def invalido(hostname, confirmado, **_):
            raise ValueError("erro interno qualquer")  # só a validação do hostname vira 422

        def driver_caiu(hostname, confirmado, **_):
            raise RuntimeError("driver")

        rota = "/api/endpoint/hostnames-removidos/remover-no-endpoint"
        corpo_ok = {"serie": "SN-1", "hostname": "HOST-OLD", "confirmado": True}
        for fake, corpo, status in (
            (remover, {"serie": "SN-1", "hostname": "HOST-OLD"}, 200),
            (remover, {"serie": "SN-1", "hostname": "HOST-OLD", "confirmado": "true"}, 422),
            (ocupado, corpo_ok, 409),
            (invalido, corpo_ok, 503),
            (driver_caiu, corpo_ok, 503),
        ):
            app = FastAPI()
            app.include_router(create_endpoint_removals_router(self.services, remover_no_endpoint=fake))
            with self.subTest(fake=fake.__name__, corpo=corpo):
                resposta = TestClient(app).post(rota, json=corpo)
                self.assertEqual(resposta.status_code, status)
                if status == 503:
                    self.assertIn("clique em Cancel", resposta.json()["detail"])
        self.assertEqual(recebido, [False])
        self.assertEqual(self._stored(), [])

        # Nome cru do índice inválido (caractere de controle): 422 antes de abrir o Chrome.
        index = copy.deepcopy(main.read_endpoint_alias_index())
        index["duplicates"]["SN1"] = [{"hostname": "HOST\x07OLD"}, {"hostname": "HOST-NEW"}]
        services = dataclasses.replace(self.services, read_endpoint_alias_index=lambda: index)
        app = FastAPI()
        app.include_router(create_endpoint_removals_router(services, remover_no_endpoint=remover))
        self.assertEqual(TestClient(app).post(rota, json=corpo_ok).status_code, 422)
        self.assertEqual(recebido, [False])

    def test_listing_returns_the_stored_pairs(self):
        endpoint_removals.remove_endpoint_hostname(self.services, "SN-1", "HOST-OLD")
        listed = endpoint_removals.list_removals(self.services)["removidos"]
        self.assertEqual([(item["serie"], item["hostname"]) for item in listed], [("SN-1", "HOST-OLD")])


if __name__ == "__main__":
    unittest.main()
