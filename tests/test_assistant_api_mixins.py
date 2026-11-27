"""Theme mixins of `SimpressApi` stay leaf modules and never shadow each other or the class."""

import ast
import sys
import unittest
from pathlib import Path

from domains.assistant_api import SimpressApi

# Every base of `SimpressApi` except `object`: a new mixin is covered without editing this file.
MIXINS = [cls for cls in SimpressApi.__mro__[1:] if cls is not object]
# The facade and the other mixins; `assistant_api_comum` is the shared leaf every mixin may import.
PROIBIDOS = {"domains.assistant_api", *(cls.__module__ for cls in MIXINS)}


def _modulos_importados(cls: type) -> set:
    arvore = ast.parse(Path(sys.modules[cls.__module__].__file__ or "").read_text(encoding="utf-8"))
    nomes: set = set()
    for no in ast.walk(arvore):
        if isinstance(no, ast.Import):
            nomes.update(alias.name for alias in no.names)
        elif isinstance(no, ast.ImportFrom) and no.module:
            nomes.add(no.module)
            nomes.update(f"{no.module}.{alias.name}" for alias in no.names)
    return nomes


class MixinsFolhaTests(unittest.TestCase):
    def test_mixins_estao_em_modulos_proprios(self):
        self.assertGreaterEqual(len(MIXINS), 3)
        self.assertEqual(len({cls.__module__ for cls in MIXINS}), len(MIXINS))
        self.assertNotIn(SimpressApi.__module__, {cls.__module__ for cls in MIXINS})

    def test_mixin_nao_importa_fachada_nem_outro_mixin(self):
        for cls in MIXINS:
            with self.subTest(mixin=cls.__name__):
                self.assertEqual(_modulos_importados(cls) & PROIBIDOS, set())

    def test_nenhum_nome_se_repete_entre_classe_e_mixins(self):
        def proprios(cls):
            return {n for n in vars(cls) if not n.startswith("__")}

        classes = [SimpressApi, *MIXINS]
        for i, a in enumerate(classes):
            for b in classes[i + 1:]:
                with self.subTest(a=a.__name__, b=b.__name__):
                    self.assertEqual(proprios(a) & proprios(b), set())


if __name__ == "__main__":
    unittest.main()
