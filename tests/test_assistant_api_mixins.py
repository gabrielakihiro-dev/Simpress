"""Theme mixins of `SimpressApi` stay leaf modules and never shadow each other or the class."""

import ast
import unittest
from pathlib import Path

from domains.assistant_api import SimpressApi
from domains.assistant_api_historico import HistoricoMixin
from domains.assistant_api_regionais import RegionaisMixin
from domains.assistant_api_sebrae import SebraeMixin

RAIZ = Path(__file__).resolve().parent.parent
MIXINS = {
    "domains/assistant_api_sebrae.py": SebraeMixin,
    "domains/assistant_api_historico.py": HistoricoMixin,
    "domains/assistant_api_regionais.py": RegionaisMixin,
}
# The facade and the other mixins; `assistant_api_comum` is the shared leaf every mixin may import.
PROIBIDOS = {"domains.assistant_api", *(caminho[:-3].replace("/", ".") for caminho in MIXINS)}


def _modulos_importados(caminho: str) -> set:
    arvore = ast.parse((RAIZ / caminho).read_text(encoding="utf-8"))
    nomes = set()
    for no in ast.walk(arvore):
        if isinstance(no, ast.Import):
            nomes.update(alias.name for alias in no.names)
        elif isinstance(no, ast.ImportFrom) and no.module:
            nomes.add(no.module)
            nomes.update(f"{no.module}.{alias.name}" for alias in no.names)
    return nomes


class MixinsFolhaTests(unittest.TestCase):
    def test_mixin_nao_importa_fachada_nem_outro_mixin(self):
        for caminho in MIXINS:
            with self.subTest(caminho=caminho):
                self.assertEqual(_modulos_importados(caminho) & PROIBIDOS, set())

    def test_nenhum_nome_se_repete_entre_classe_e_mixins(self):
        def proprios(cls):
            return {n for n in vars(cls) if not n.startswith("__")}

        classes = [SimpressApi, *MIXINS.values()]
        for i, a in enumerate(classes):
            for b in classes[i + 1:]:
                with self.subTest(a=a.__name__, b=b.__name__):
                    self.assertEqual(proprios(a) & proprios(b), set())


if __name__ == "__main__":
    unittest.main()
