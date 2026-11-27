"""Theme mixins of `SimpressApi` stay leaf modules and never shadow each other or the class."""

import subprocess
import sys
import unittest
from pathlib import Path

from domains.assistant_api import SimpressApi

RAIZ = Path(__file__).resolve().parent.parent
# Every base of `SimpressApi` except `object`: a new mixin is covered without editing this file.
MIXINS = [cls for cls in SimpressApi.__mro__[1:] if cls is not object]
FOLHAS = {"domains.assistant_api_comum", *(cls.__module__ for cls in MIXINS)}


class MixinsFolhaTests(unittest.TestCase):
    def test_mixins_estao_em_modulos_proprios(self):
        self.assertGreaterEqual(len(MIXINS), 3)
        self.assertEqual(len({cls.__module__ for cls in MIXINS}), len(MIXINS))
        self.assertNotIn(SimpressApi.__module__, {cls.__module__ for cls in MIXINS})

    def test_folha_nao_carrega_fachada_nem_outro_mixin(self):
        # A fresh interpreter per module, so an indirect import (through another module) is caught too.
        for modulo in sorted(FOLHAS):
            proibidos = sorted({"domains.assistant_api", *FOLHAS} - {modulo, "domains.assistant_api_comum"})
            codigo = f"import sys, {modulo}; print(sorted(set({proibidos!r}) & set(sys.modules)))"
            with self.subTest(modulo=modulo):
                saida = subprocess.run([sys.executable, "-c", codigo], cwd=RAIZ, capture_output=True, text=True, timeout=60)
                self.assertEqual(saida.returncode, 0, saida.stderr)
                self.assertEqual(saida.stdout.strip(), "[]")

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
