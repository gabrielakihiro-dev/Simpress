import re
import unittest
from pathlib import Path

from domains.inventory_comparison import SEBRAE_OWNED_NOTEBOOK_SERIALS

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RENDERER = PROJECT_ROOT / "static" / "js" / "ui" / "comparison-result-renderer.js"


class SebraeSeriesParityTests(unittest.TestCase):
    def test_js_and_python_sebrae_series_lists_match(self):
        source = RENDERER.read_text(encoding="utf-8")
        block = re.search(r"SERIES_SEBRAE\s*=\s*new Set\(\[(.*?)\]\)", source, re.S)
        self.assertIsNotNone(block, "SERIES_SEBRAE não encontrada em comparison-result-renderer.js")
        js_series = set(re.findall(r"[\"']([A-Z0-9]+)[\"']", block.group(1)))
        python_series = set(SEBRAE_OWNED_NOTEBOOK_SERIALS)

        self.assertTrue(js_series, "SERIES_SEBRAE do JS está vazia")
        self.assertTrue(python_series, "SEBRAE_OWNED_NOTEBOOK_SERIALS do Python está vazia")
        self.assertEqual(
            js_series,
            python_series,
            f"Listas de séries Sebrae divergem. Só no JS: {sorted(js_series - python_series)}; "
            f"só no Python: {sorted(python_series - js_series)}",
        )


if __name__ == "__main__":
    unittest.main()
