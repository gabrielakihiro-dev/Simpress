import unittest
from types import SimpleNamespace

from domains import alias_changes

DIRECTORY = {"users": {"ana.lima": "Ana Lima"}}
HISTORY = [{"id": "1", "tipo": "usuario", "usuario_anterior": "ana.lima", "usuario_novo": "sem.cadastro"}]


class AliasHistoryDirectoryReadTests(unittest.TestCase):
    def test_names_come_from_directory_without_building_endpoint_index(self):
        def forbidden_index():
            raise AssertionError("o índice completo do Endpoint não deve ser lido")

        reads = []
        services = SimpleNamespace(
            load_alias_history=lambda: HISTORY,
            read_endpoint_alias_index=forbidden_index,
            read_entra_directory=lambda: reads.append(1) or DIRECTORY,
        )
        event = alias_changes.alias_history_listing(services)["eventos"][0]
        self.assertEqual(event["nome_pessoa_anterior"], "Ana Lima")
        self.assertEqual(event["nome_pessoa_novo"], "")
        self.assertEqual(len(reads), 1)

    def test_listing_without_user_events_reads_nothing(self):
        def forbidden():
            raise AssertionError("não deve ler nomes")

        services = SimpleNamespace(
            load_alias_history=lambda: [{"id": "1", "tipo": "apelido"}],
            read_endpoint_alias_index=forbidden,
            read_entra_directory=forbidden,
        )
        self.assertEqual(alias_changes.alias_history_listing(services)["total"], 1)

    def test_unreadable_directory_returns_events_unchanged(self):
        def broken():
            raise ValueError("JSON corrompido")

        services = SimpleNamespace(
            load_alias_history=lambda: HISTORY,
            read_endpoint_alias_index=lambda: {},
            read_entra_directory=broken,
        )
        self.assertEqual(alias_changes.alias_history_listing(services)["eventos"], HISTORY)


if __name__ == "__main__":
    unittest.main()
