import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from scripts.check_update import (
    DISABLE_VARIABLE,
    EXIT_CONTINUE,
    EXIT_LAUNCHER_CHANGED,
    check_for_update,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_GIT_COMMANDS = {"reset", "clean", "stash", "checkout", "restore", "merge", "rebase"}
GIT_IDENTITY = [
    "-c", "user.name=Teste",
    "-c", "user.email=teste@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=",
]


def git(cwd, *args):
    return subprocess.run(
        ["git", *GIT_IDENTITY, *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _make_writable_and_retry(function, path, _error):
    os.chmod(path, stat.S_IWRITE)
    function(path)


def commit_file(repo, relative, content, message):
    path = Path(repo) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    git(repo, "add", relative)
    git(repo, "commit", "-q", "-m", message)


@unittest.skipUnless(shutil.which("git"), "Git não está instalado")
class CheckUpdateWithRealRepositoriesTests(unittest.TestCase):
    """Simulates the operator checkout against a local bare origin; no network involved."""

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(prefix=".check-update-test-")
        base = Path(self.temporary_directory.name)
        self.origin = base / "origin.git"
        self.publisher = base / "publisher"
        self.checkout = base / "checkout"
        git(base, "init", "-q", "--bare", "--initial-branch=main", str(self.origin))
        git(base, "clone", "-q", str(self.origin), str(self.publisher))
        git(self.publisher, "symbolic-ref", "HEAD", "refs/heads/main")
        commit_file(self.publisher, "README.md", "v1\n", "versão inicial")
        commit_file(self.publisher, "requirements.txt", "fastapi==1.0\n", "dependências")
        commit_file(self.publisher, "iniciar_servidor.bat", "@echo off\n", "inicializador")
        git(self.publisher, "push", "-q", "origin", "main")
        git(base, "clone", "-q", str(self.origin), str(self.checkout))
        # Operational data and untracked files must survive every scenario.
        (self.checkout / "data").mkdir()
        (self.checkout / "data" / "historico.json").write_text("{}", encoding="utf-8")
        (self.checkout / "anotacao_local.txt").write_text("local", encoding="utf-8")

        self.git_calls = []
        self.messages = []
        self.prompt = Mock(return_value="S")

    def tearDown(self):
        try:
            self.assert_untracked_preserved()
        finally:
            # Git marks its objects read-only on Windows; clear the flag before removing.
            shutil.rmtree(self.temporary_directory.name, onexc=_make_writable_and_retry)
            self.temporary_directory.cleanup()

    def assert_untracked_preserved(self):
        self.assertEqual((self.checkout / "data" / "historico.json").read_text(encoding="utf-8"), "{}")
        self.assertEqual((self.checkout / "anotacao_local.txt").read_text(encoding="utf-8"), "local")
        for call in self.git_calls:
            self.assertFalse(FORBIDDEN_GIT_COMMANDS & set(call), call)
            self.assertNotIn("--force", call)
            if "pull" in call:
                self.assertIn("--ff-only", call)

    def recording_runner(self, command, **kwargs):
        self.git_calls.append(list(command))
        return subprocess.run(command, **kwargs)

    def publish(self, relative="README.md", content="v2\n", message="versão nova"):
        commit_file(self.publisher, relative, content, message)
        git(self.publisher, "push", "-q", "origin", "main")

    def run_check(self, environ=None):
        return check_for_update(
            self.checkout,
            runner=self.recording_runner,
            prompt=self.prompt,
            report=self.messages.append,
            environ=environ or {},
        )

    def head(self):
        return git(self.checkout, "rev-parse", "HEAD")

    def output(self):
        return "\n".join(self.messages)

    def test_applies_fast_forward_when_user_accepts(self):
        self.publish()

        self.assertEqual(self.run_check(), EXIT_CONTINUE)

        self.assertEqual(self.head(), git(self.publisher, "rev-parse", "HEAD"))
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "v2\n")
        self.prompt.assert_called_once_with("Há uma versão nova. Atualizar agora? (S/N) ")
        self.assertIn("versão nova", self.output())
        self.assertIn("Atualização concluída.", self.output())
        self.assertNotIn("requirements.txt mudou", self.output())

    def test_keeps_current_version_when_user_declines_or_input_is_closed(self):
        self.publish()
        before = self.head()
        for answer in ("N", "", "talvez"):
            self.prompt.return_value = answer
            self.run_check()
            self.assertEqual(self.head(), before)
        self.prompt.side_effect = EOFError
        self.run_check()
        self.assertEqual(self.head(), before)
        self.assertIn("Atualização adiada. Iniciando com a versão atual.", self.output())

    def test_reports_when_already_up_to_date(self):
        self.run_check()
        self.prompt.assert_not_called()
        self.assertIn("Você já está na versão mais recente.", self.output())

    def test_refuses_with_tracked_local_changes(self):
        self.publish()
        before = self.head()
        (self.checkout / "README.md").write_text("editado localmente\n", encoding="utf-8")

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "editado localmente\n")
        self.assertIn("existem alterações locais", self.output())
        self.assertIn("README.md", self.output())
        self.assertIn("Iniciando com a versão atual.", self.output())

    def test_refuses_outside_main_without_fetching(self):
        git(self.checkout, "switch", "-q", "-c", "outro")
        self.publish()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertFalse(any("fetch" in call for call in self.git_calls))
        self.assertIn("só no branch main (atual: outro)", self.output())

    def test_refuses_detached_head(self):
        git(self.checkout, "switch", "-q", "--detach")
        self.publish()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("HEAD destacado", self.output())

    def test_refuses_when_local_history_diverged(self):
        commit_file(self.checkout, "local.txt", "x\n", "commit local")
        self.publish()
        before = self.head()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertIn("commits que não estão em origin/main", self.output())

    def test_reports_failed_fast_forward_without_touching_untracked_file(self):
        self.publish("anotacao_local.txt", "remoto\n", "arquivo que colide")
        before = self.head()

        self.run_check()

        self.assertEqual(self.head(), before)
        self.assertIn("git pull --ff-only falhou", self.output())

    def test_reports_missing_network_or_origin(self):
        git(self.checkout, "remote", "set-url", "origin", str(Path(self.temporary_directory.name) / "inexistente.git"))

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("Não foi possível consultar o servidor Git", self.output())

    def test_warns_when_requirements_change(self):
        self.publish("requirements.txt", "fastapi==2.0\n", "atualiza dependências")

        self.assertEqual(self.run_check(), EXIT_CONTINUE)

        self.assertIn("O requirements.txt mudou; as dependências serão reinstaladas a seguir.", self.output())

    def test_signals_launcher_restart_when_launcher_changes(self):
        self.publish("iniciar_servidor.bat", "@echo off\necho novo\n", "novo inicializador")

        self.assertEqual(self.run_check(), EXIT_LAUNCHER_CHANGED)

        self.assertIn("O inicializador foi atualizado e será reiniciado.", self.output())

    def test_disabled_by_environment_variable(self):
        self.publish()
        before = self.head()

        self.run_check({DISABLE_VARIABLE: "0"})

        self.assertEqual(self.git_calls, [])
        self.assertEqual(self.head(), before)
        self.assertIn("desativada", self.output())


class CheckUpdateWithoutGitTests(unittest.TestCase):
    def run_check(self, runner):
        messages = []
        prompt = Mock()
        result = check_for_update(
            PROJECT_ROOT, runner=runner, prompt=prompt, report=messages.append, environ={},
        )
        prompt.assert_not_called()
        self.assertEqual(result, EXIT_CONTINUE)
        return "\n".join(messages)

    def test_missing_git_is_reported_and_startup_continues(self):
        output = self.run_check(Mock(side_effect=FileNotFoundError("git")))
        self.assertIn("Git não encontrado", output)

    def test_folder_outside_repository_is_reported(self):
        output = self.run_check(Mock(return_value=subprocess.CompletedProcess([], 128, "", "fatal")))
        self.assertIn("não é um repositório Git", output)

    def test_fetch_timeout_is_reported(self):
        def runner(command, **kwargs):
            if "fetch" in command:
                raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))
            if "symbolic-ref" in command:
                return subprocess.CompletedProcess(command, 0, "main\n", "")
            return subprocess.CompletedProcess(command, 0, "true\n", "")

        output = self.run_check(runner)
        self.assertIn("demorou demais", output)
        self.assertIn("Iniciando com a versão atual.", output)

    def test_git_never_prompts_for_credentials(self):
        runner = Mock(return_value=subprocess.CompletedProcess([], 128, "", ""))
        self.run_check(runner)
        self.assertEqual(runner.call_args.kwargs["env"]["GIT_TERMINAL_PROMPT"], "0")


class LauncherContractTests(unittest.TestCase):
    def test_launcher_runs_update_check_before_bootstrap_and_never_forces(self):
        launcher = (PROJECT_ROOT / "iniciar_servidor.bat").read_text(encoding="utf-8")

        self.assertIn('set "UPDATER=%PROJECT_DIR%scripts\\check_update.py"', launcher)
        self.assertLess(launcher.index('"%UPDATER%"'), launcher.index('"%BOOTSTRAPPER%" --project-root'))
        self.assertIn("if not defined SIMPRESS_ATUALIZACAO_VERIFICADA", launcher)
        self.assertIn('call "%~f0"', launcher)
        for forbidden in ("git reset", "git clean", "git stash", "--force"):
            self.assertNotIn(forbidden, launcher)


if __name__ == "__main__":
    unittest.main()
