"""Automation accounts and folder: environment, then the git-ignored local file, then empty."""

import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from core import config as app_config
from core.config import local_setting

EXAMPLE_KEYS = {
    "endpoint_usuario",
    "dashboard_email",
    "softexpert_email",
    "dashboard_pasta_url",
    "outlook_email_sebrae",
    "outlook_email_simpress",
}


class LocalSettingTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / "contas_automacao.json"

    def test_environment_wins_then_file_then_empty(self):
        self.path.write_text(json.dumps({"dashboard_email": " arquivo@exemplo.invalid "}), encoding="utf-8")
        with patch.dict("os.environ", {"SIMPRESS_TESTE_EMAIL": "ambiente@exemplo.invalid"}):
            self.assertEqual(local_setting("SIMPRESS_TESTE_EMAIL", "dashboard_email", self.path), "ambiente@exemplo.invalid")
        with patch.dict("os.environ", {"SIMPRESS_TESTE_EMAIL": "  "}):  # blank variable counts as missing
            self.assertEqual(local_setting("SIMPRESS_TESTE_EMAIL", "dashboard_email", self.path), "arquivo@exemplo.invalid")
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(local_setting("SIMPRESS_TESTE_EMAIL", "softexpert_email", self.path), "")

    def test_missing_unreadable_or_wrong_shape_file_gives_empty(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertEqual(local_setting("SIMPRESS_TESTE_EMAIL", "dashboard_email", self.path), "")
            for conteudo in ("{não é json", "[]", json.dumps({"dashboard_email": 123})):
                with self.subTest(conteudo=conteudo):
                    self.path.write_text(conteudo, encoding="utf-8")
                    self.assertEqual(local_setting("SIMPRESS_TESTE_EMAIL", "dashboard_email", self.path), "")

    def test_versioned_example_is_fictitious_and_local_file_is_ignored(self):
        example = json.loads((app_config.BASE_DIR / "config" / "contas_automacao.exemplo.json").read_text(encoding="utf-8"))
        self.assertEqual(set(example), EXAMPLE_KEYS)
        for chave, valor in example.items():
            with self.subTest(chave=chave):
                self.assertTrue("exemplo" in valor)
        self.assertEqual(app_config.AUTOMATION_ACCOUNTS_FILE, app_config.BASE_DIR / "config" / "contas_automacao.json")
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", "config/contas_automacao.json"],
            cwd=app_config.BASE_DIR, check=False,
        )
        self.assertEqual(ignored.returncode, 0)


if __name__ == "__main__":
    unittest.main()
