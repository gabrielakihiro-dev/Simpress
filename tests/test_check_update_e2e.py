"""End-to-end check of the one-click update as ``iniciar_servidor.bat`` runs it.

Unlike ``test_check_update.py``, which calls ``check_for_update`` in-process with a recording
runner, these tests start ``scripts/check_update.py --project-root <pasta>\\.`` as a separate
process, answer the prompt through stdin, read the exit code the launcher reacts to and record
every Git command actually executed (``GIT_TRACE``), including the ones Git spawns itself.
Everything happens in a temporary folder: a bare "origin", a publisher clone that pushes the
tags v1.0.0 and v1.1.0, and the operator checkout. No network and no tag in the real repository.
The ``.bat`` itself is not executed; see docs/operacao/atualizacao-um-clique.md.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.check_update import EXIT_CONTINUE, EXIT_LAUNCHER_CHANGED
from tests.test_check_update import _make_writable_and_retry, commit_file, git

PROJECT_ROOT = Path(__file__).resolve().parents[1]
UPDATER = PROJECT_ROOT / "scripts" / "check_update.py"
# Commands that change the operator checkout's branch, index or files. Only "merge" may run.
CHANGING_COMMANDS = {
    "merge", "pull", "reset", "clean", "stash", "checkout", "switch", "restore",
    "rebase", "tag", "commit", "cherry-pick", "revert", "am", "apply", "update-ref",
}
_TRACED_COMMAND = re.compile(r"trace: (?:built-in|exec|run_command): (?:git )?(.*)$")


@unittest.skipUnless(shutil.which("git"), "Git não está instalado")
class LauncherUpdateEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(prefix=".check-update-e2e-")
        base = Path(self.temporary_directory.name)
        self.real_tags = git(PROJECT_ROOT, "tag", "--list")
        self.trace = base / "git-trace.log"
        self.origin = base / "origin.git"
        self.publisher = base / "publisher"
        self.checkout = base / "checkout"
        git(base, "init", "-q", "--bare", "--initial-branch=main", str(self.origin))
        git(base, "clone", "-q", str(self.origin), str(self.publisher))
        git(self.publisher, "symbolic-ref", "HEAD", "refs/heads/main")
        commit_file(self.publisher, "iniciar_servidor.bat", "@echo off\n", "inicializador")
        self.v1_0_0 = self.release("1.0.0", "README.md", "v1\n")
        git(base, "clone", "-q", str(self.origin), str(self.checkout))
        (self.checkout / "data").mkdir()
        (self.checkout / "data" / "historico.json").write_text("{}", encoding="utf-8")

    def tearDown(self):
        try:
            self.assertEqual((self.checkout / "data" / "historico.json").read_text(encoding="utf-8"), "{}")
            # The real repository never gets the temporary tags.
            self.assertEqual(git(PROJECT_ROOT, "tag", "--list"), self.real_tags)
        finally:
            shutil.rmtree(self.temporary_directory.name, onexc=_make_writable_and_retry)
            self.temporary_directory.cleanup()

    def release(self, version, relative, content):
        commit_file(self.publisher, relative, content, f"versão {version}")
        git(self.publisher, "tag", "-a", f"v{version}", "-m", f"Simpress v{version}")
        git(self.publisher, "push", "-q", "origin", "main", f"v{version}")
        return git(self.publisher, "rev-parse", "HEAD")

    def run_launcher_step(self, answer="S\n"):
        """Run the updater exactly as the .bat does: separate process, %PROJECT_DIR%. as root."""
        environment = dict(os.environ)
        environment.pop("SIMPRESS_VERIFICAR_ATUALIZACAO", None)
        environment.update({"GIT_TRACE": str(self.trace), "PYTHONIOENCODING": "utf-8"})
        if self.trace.exists():
            self.trace.unlink()
        completed = subprocess.run(
            [sys.executable, "-B", str(UPDATER), "--project-root", f"{self.checkout}{os.sep}."],
            cwd=str(PROJECT_ROOT),
            input=answer,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            timeout=120,
        )
        self.assertEqual(completed.stderr.strip(), "")
        return completed

    def git_commands(self):
        commands = []
        for line in self.trace.read_text(encoding="utf-8", errors="replace").splitlines():
            match = _TRACED_COMMAND.search(line)
            if match:
                commands.append(match[1].split())
        return commands

    def changing_commands(self):
        return [command for command in self.git_commands() if command and command[0] in CHANGING_COMMANDS]

    def head(self):
        return git(self.checkout, "rev-parse", "HEAD")

    def test_detects_and_applies_newer_tag_with_fast_forward_only(self):
        v1_1_0 = self.release("1.1.0", "README.md", "v2\n")

        completed = self.run_launcher_step()

        self.assertEqual(completed.returncode, EXIT_CONTINUE)
        self.assertIn("Versão nova disponível: v1.1.0 (instalada: v1.0.0).", completed.stdout)
        self.assertIn("Atualizar agora? (S/N)", completed.stdout)
        self.assertIn("Atualização concluída: Simpress v1.1.0.", completed.stdout)
        self.assertEqual(self.head(), v1_1_0)
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "v2\n")
        # The only command that changes the checkout is one fast-forward to the tag commit.
        self.assertEqual(self.changing_commands(), [["merge", "--ff-only", "--quiet", v1_1_0]])
        for command in self.git_commands():
            self.assertNotIn("--force", command)
            self.assertNotIn("-f", command)

    def test_nothing_is_offered_without_a_newer_tag(self):
        commit_file(self.publisher, "README.md", "sem tag\n", "commit sem versão")
        git(self.publisher, "push", "-q", "origin", "main")

        completed = self.run_launcher_step()

        self.assertEqual(completed.returncode, EXIT_CONTINUE)
        self.assertIn("Você já está na versão mais recente (v1.0.0).", completed.stdout)
        self.assertNotIn("Atualizar agora?", completed.stdout)
        self.assertEqual(self.head(), self.v1_0_0)
        self.assertEqual(self.changing_commands(), [])

    def test_local_changes_block_the_update(self):
        v1_1_0 = self.release("1.1.0", "README.md", "v2\n")
        (self.checkout / "README.md").write_text("editado localmente\n", encoding="utf-8")

        completed = self.run_launcher_step()

        self.assertEqual(completed.returncode, EXIT_CONTINUE)
        self.assertIn("Há uma versão nova (v1.1.0), mas existem alterações locais", completed.stdout)
        self.assertIn("M README.md", completed.stdout)
        self.assertNotIn("Atualizar agora?", completed.stdout)
        self.assertEqual(self.head(), self.v1_0_0)
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "editado localmente\n")
        self.assertEqual(self.changing_commands(), [])

    def test_declined_answer_keeps_current_version(self):
        v1_1_0 = self.release("1.1.0", "README.md", "v2\n")

        completed = self.run_launcher_step(answer="N\n")

        self.assertIn("Atualização adiada. Iniciando com a versão atual.", completed.stdout)
        self.assertEqual(self.head(), self.v1_0_0)
        self.assertEqual(self.changing_commands(), [])

    def test_exit_code_three_when_launcher_changes(self):
        v1_1_0 = self.release("1.1.0", "iniciar_servidor.bat", "@echo off\necho novo\n")

        completed = self.run_launcher_step()

        # The .bat restarts itself only for errorlevel 3 ("if errorlevel 3 if not errorlevel 4").
        self.assertEqual(completed.returncode, EXIT_LAUNCHER_CHANGED)
        self.assertIn("O inicializador foi atualizado e será reiniciado.", completed.stdout)
        self.assertEqual(self.head(), v1_1_0)


if __name__ == "__main__":
    unittest.main()
