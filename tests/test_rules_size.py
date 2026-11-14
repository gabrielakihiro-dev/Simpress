"""Tetos de tamanho dos arquivos de regras (docs/desenvolvimento/regras-agentes.md, "Tamanho das regras")."""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KB = 1024
DICA = "mova o detalhe para o AGENTS.md da pasta ou para o doc do tema e deixe só gatilho e caminho"


def tamanho(path: Path) -> int:
    return path.stat().st_size


class TamanhoDasRegrasTest(unittest.TestCase):
    def assert_teto(self, nome: str, bytes_: int, teto: int) -> None:
        self.assertLessEqual(bytes_, teto, f"{nome}: {bytes_} B, teto {teto} B; {DICA}.")

    def test_raiz(self) -> None:
        agents = tamanho(ROOT / "AGENTS.md")
        self.assert_teto("AGENTS.md", agents, 8 * KB)
        self.assert_teto("CLAUDE.md + AGENTS.md", agents + tamanho(ROOT / "CLAUDE.md"), 10 * KB)

    def test_pastas(self) -> None:
        pastas = sorted(ROOT.glob("*/AGENTS.md"))
        self.assertTrue(pastas, "nenhum AGENTS.md de pasta encontrado")
        for agents in pastas:
            pasta = agents.parent.name
            self.assert_teto(f"{pasta}/AGENTS.md", tamanho(agents), 6 * KB)
            claude = agents.with_name("CLAUDE.md")
            self.assertTrue(claude.exists(), f"{pasta}/CLAUDE.md ausente: o Claude Code não lê AGENTS.md sozinho")
            self.assert_teto(f"{pasta}/CLAUDE.md", tamanho(claude), 512)

    def test_cursor_e_claude_rules(self) -> None:
        regras = [*(ROOT / ".cursor" / "rules").glob("*.mdc"), *(ROOT / ".claude" / "rules").rglob("*.md")]
        for regra in sorted(regras):
            self.assert_teto(regra.relative_to(ROOT).as_posix(), tamanho(regra), KB)


if __name__ == "__main__":
    unittest.main()
