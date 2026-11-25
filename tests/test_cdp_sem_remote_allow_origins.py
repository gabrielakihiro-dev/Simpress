"""Guarda do risco aceito da porta CDP 9333 (docs/operacao/automacao-chrome.md, "Porta CDP 9333")."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PASTAS = ("scripts", "domains", "core", "routers", "security")
FLAG = "--remote-allow-" + "origins"


def arquivos_py(raiz: Path = ROOT) -> list[Path]:
    achados = [raiz / "main.py"]
    for pasta in PASTAS:
        achados.extend((raiz / pasta).rglob("*.py"))
    return [p for p in achados if p.is_file()]


def usos_da_flag(raiz: Path = ROOT) -> list[str]:
    return [
        p.relative_to(raiz).as_posix()
        for p in arquivos_py(raiz)
        if FLAG in p.read_text(encoding="utf-8", errors="ignore")
    ]


class CdpSemRemoteAllowOriginsTest(unittest.TestCase):
    def test_codigo_nao_usa_a_flag(self) -> None:
        self.assertEqual(usos_da_flag(), [], f"{FLAG} abriria o CDP 9333 a páginas web; reavalie o risco aceito")

    def test_varredura_detecta_a_flag(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            (raiz / "scripts").mkdir()
            (raiz / "scripts" / "x.py").write_text(f'ARGS = ["{FLAG}=*"]\n', encoding="utf-8")
            self.assertEqual(usos_da_flag(raiz), ["scripts/x.py"])


if __name__ == "__main__":
    unittest.main()
