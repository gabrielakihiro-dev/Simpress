import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_secrets import scan_text  # noqa: E402


# Montadas em tempo de execução para o próprio arquivo não conter o padrão literal.
CORPO = "0123456789abcdef" * 2
OPENROUTER = "sk-or-v1-" + CORPO
DEEPSEEK = "sk-" + CORPO


class CheckSecretsTests(unittest.TestCase):
    def test_detecta_chaves_de_api_falsas(self):
        for line in (
            f"OPENROUTER_API_KEY={OPENROUTER}",
            f"DEEPSEEK_API_KEY={DEEPSEEK}",
            f"x = '{OPENROUTER}'",
        ):
            self.assertTrue(scan_text(line), line)

    def test_texto_limpo_e_placeholders_passam(self):
        for line in (
            "OPENROUTER_API_KEY=",
            "esta e a task-force-0123456789abcdefghijklmnop",
            "OPENROUTER_API_KEY=sk-or-v1-coloque-sua-chave",
        ):
            self.assertEqual(scan_text(line), [], line)


if __name__ == "__main__":
    unittest.main()
