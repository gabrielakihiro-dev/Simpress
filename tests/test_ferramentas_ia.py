"""Conferencia de skills, agentes, MCP, hooks e instrucoes (scripts/conferir_ferramentas_ia.py)."""

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import conferir_ferramentas_ia as conferir  # noqa: E402


def falhas(resultados: list[conferir.Resultado]) -> list[str]:
    return [f"{r.area} {r.item}: {r.motivo}" for r in resultados if r.status == conferir.FALHA]


class RepoRealTest(unittest.TestCase):
    def test_sem_falha_no_repositorio(self) -> None:
        resultados = conferir.conferir_tudo(ROOT, instalado=False)
        self.assertTrue(resultados)
        self.assertEqual([], falhas(resultados))

    def test_plugins_vem_do_bat(self) -> None:
        plugins, origem = conferir.plugins_do_instalador(ROOT)
        self.assertIn("ponytail@ponytail", plugins)
        self.assertEqual("instalar_primeira_vez.bat", origem)


class RepoTemporarioTest(unittest.TestCase):
    def test_skill_sem_name_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            pasta = raiz / ".claude" / "skills" / "exemplo"
            pasta.mkdir(parents=True)
            (pasta / "SKILL.md").write_text("---\ndescription: algo\n---\ncorpo\n", encoding="utf-8")
            self.assertTrue(falhas(conferir.checar_skills(raiz)))

    def test_skill_valida_passa(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            pasta = raiz / ".claude" / "skills" / "exemplo"
            pasta.mkdir(parents=True)
            (pasta / "SKILL.md").write_text("---\nname: exemplo\ndescription: algo\n---\n", encoding="utf-8")
            self.assertEqual([], falhas(conferir.checar_skills(raiz)))

    def test_agente_com_agent_em_tools_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            pasta = raiz / ".claude" / "agents"
            pasta.mkdir(parents=True)
            (pasta / "x.md").write_text(
                "---\nname: x\ndescription: d\nmodel: sonnet\ntools: Read, Agent\n---\n", encoding="utf-8"
            )
            self.assertTrue(falhas(conferir.checar_agentes(raiz)))

    def test_agente_sem_tools_so_avisa(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            pasta = raiz / ".claude" / "agents"
            pasta.mkdir(parents=True)
            (pasta / "x.md").write_text("---\nname: x\ndescription: d\nmodel: opus\n---\n", encoding="utf-8")
            resultados = [r for r in conferir.checar_agentes(raiz) if r.item.endswith("/x.md")]
            self.assertEqual([], falhas(resultados))
            self.assertEqual(conferir.AVISO, resultados[0].status)

    def test_copia_instalada_diferente_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz, home = Path(tmp) / "repo", Path(tmp) / "home"
            pasta = raiz / ".claude" / "skills" / "exemplo"
            pasta.mkdir(parents=True)
            (pasta / "SKILL.md").write_text("---\nname: exemplo\ndescription: d\n---\n", encoding="utf-8")
            copia = home / ".claude" / "skills" / "exemplo"
            copia.mkdir(parents=True)
            (copia / "SKILL.md").write_text("outro conteudo", encoding="utf-8")
            self.assertTrue(falhas(conferir.checar_skills(raiz, instalado=True, home=home)))

    def test_hook_com_script_inexistente_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            (raiz / ".claude").mkdir()
            (raiz / ".claude" / "settings.json").write_text(
                '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command",'
                '"command":"node \\"$CLAUDE_PROJECT_DIR/.claude/hooks/nao-existe.cjs\\""}]}]}}',
                encoding="utf-8",
            )
            self.assertTrue(falhas(conferir.checar_hooks(raiz)))

    def test_agente_central_ausente_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz = Path(tmp)
            pasta = raiz / ".claude" / "agents"
            pasta.mkdir(parents=True)
            (pasta / "x.md").write_text("---\nname: x\ndescription: d\nmodel: opus\n---\n", encoding="utf-8")
            motivos = falhas(conferir.checar_agentes(raiz))
            self.assertEqual(len(conferir.AGENTES_CENTRAIS), len(motivos))
            self.assertTrue(all("agente central ausente" in m for m in motivos))

    def test_agente_com_task_em_tools_da_falha(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pasta = Path(tmp) / ".claude" / "agents"
            pasta.mkdir(parents=True)
            (pasta / "x.md").write_text(
                "---\nname: x\ndescription: d\nmodel: sonnet\ntools: Read, Task\n---\n", encoding="utf-8"
            )
            self.assertTrue(any("x.md" in m for m in falhas(conferir.checar_agentes(Path(tmp)))))

    def test_copia_instalada_so_com_crlf_passa(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            raiz, home = Path(tmp) / "repo", Path(tmp) / "home"
            pasta = raiz / ".claude" / "skills" / "exemplo"
            pasta.mkdir(parents=True)
            (pasta / "SKILL.md").write_bytes(b"---\nname: exemplo\ndescription: d\n---\ncorpo\n")
            copia = home / ".claude" / "skills" / "exemplo"
            copia.mkdir(parents=True)
            (copia / "SKILL.md").write_bytes(b"---\r\nname: exemplo\r\ndescription: d\r\n---\r\ncorpo\r\n")
            self.assertEqual([], falhas(conferir.checar_skills(raiz, instalado=True, home=home)))

    def test_mascarar_troca_perfil(self) -> None:
        home = str(Path.home())
        self.assertEqual("%USERPROFILE%/x", conferir.mascarar(home + "/x"))


if __name__ == "__main__":
    unittest.main()
