import unittest
from pathlib import Path

from domains.regras_negocio import series_sebrae

PROJECT_ROOT = Path(__file__).resolve().parents[1]
RENDERER = PROJECT_ROOT / "static" / "js" / "ui" / "comparison-result-renderer.js"


class SebraeSeriesSingleSourceTests(unittest.TestCase):
    def test_renderer_keeps_no_copy_of_the_sebrae_series_list(self):
        # A fonte única é domains/regras_negocio.py; o JS só usa as listas como o backend as entrega.
        source = RENDERER.read_text(encoding="utf-8")
        series = series_sebrae()
        self.assertTrue(series, "series_sebrae() do Python está vazia (config/cliente.exemplo.json)")
        self.assertNotIn("SERIES_SEBRAE", source)
        self.assertNotIn("filtrarSeriesSebrae", source)
        for serie in series:
            self.assertNotIn(serie, source, f"Série do Sebrae {serie} copiada no JS")


if __name__ == "__main__":
    unittest.main()
