import types
import unittest

from domains import history_comparisons


class HistoryComparisonsTests(unittest.TestCase):
    def test_event_summary_uses_stored_summary_copy(self):
        stored = {"total_endpoint": 3}
        result = history_comparisons.history_event_summary({"resumo": stored})
        self.assertEqual(result, stored)
        self.assertIsNot(result, stored)

    def test_event_summary_counts_categories_without_stored_summary(self):
        result = history_comparisons.history_event_summary(
            {"comparacao": {"total_endpoint": 5, "sem_acesso_7_dias": [{}, {}], "mudancas_usuarios": "x"}}
        )
        self.assertEqual(result["total_endpoint"], 5)
        self.assertEqual(result["sem_acesso_7_dias"], 2)
        self.assertEqual(result["mudancas_usuarios"], 0)
        self.assertEqual(history_comparisons.history_event_summary({})["total_endpoint"], 0)

    def test_synthetic_event_is_none_without_records(self):
        services = types.SimpleNamespace(history_annotations_sync_enabled=lambda: False)
        self.assertIsNone(history_comparisons.synthetic_annotation_event(services, "evt", {}))
        self.assertIsNone(history_comparisons.synthetic_annotation_event(
            services, "evt", {("outro", "i1"): {"item_id": "i1", "anotacao": "x"}},
        ))

    def test_synthetic_event_unknown_category_falls_back(self):
        services = types.SimpleNamespace(history_annotations_sync_enabled=lambda: False)
        records = {("evt", "i1"): {"item_id": "i1", "anotacao": "nota", "categoria": "desconhecida", "serie": "S1"}}
        event = history_comparisons.synthetic_annotation_event(services, "evt", records)
        self.assertEqual(event["resumo"], {"apelidos_sem_atualizacao": 1})
        self.assertEqual(event["comparacao"]["apelidos_sem_atualizacao"][0]["anotacao_id"], "i1")


if __name__ == "__main__":
    unittest.main()
