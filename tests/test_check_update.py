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
    changelog_notes,
    check_for_update,
    parse_remote_tags,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_GIT_COMMANDS = {"reset", "clean", "stash", "checkout", "restore", "rebase", "pull", "tag"}
GIT_IDENTITY = [
    "-c", "user.name=Teste",
    "-c", "user.email=teste@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.hooksPath=",
]
MAX_TEMPORARY_ROOT_LENGTH = 60
CHANGELOG_TEMPLATE = """# Changelog

## [Não lançado]

- algo ainda sem versão

{sections}
"""


def short_temporary_root():
    """Base curta para os repositórios de teste.

    Com TEMP em caminho longo (sandbox, worktrees), o Git do Windows falha com "Filename too long"
    ao criar o repositório bare, mesmo com core.longpaths. Devolve None quando o TEMP já é curto.
    """
    if len(tempfile.gettempdir()) <= MAX_TEMPORARY_ROOT_LENGTH:
        return None
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidate = Path(local_app_data) / "Temp"
    if local_app_data and len(str(candidate)) <= MAX_TEMPORARY_ROOT_LENGTH and candidate.is_dir():
        return str(candidate)
    return None


def git(cwd, *args):
    # encoding explícito: no Windows, text=True decodifica em cp1252 e esconde a mensagem real do Git.
    result = subprocess.run(
        ["git", *GIT_IDENTITY, *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detalhes = "\n".join([
            f"git {' '.join(args)} falhou em {cwd} (código {result.returncode})",
            f"stdout: {result.stdout}",
            f"stderr: {result.stderr}",
        ])
        raise AssertionError(detalhes)
    return result.stdout.strip()


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
        self.temporary_directory = tempfile.TemporaryDirectory(prefix=".check-update-test-", dir=short_temporary_root())
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
        self.changelog_sections = []
        self.release("1.0.0", "- primeira versão")
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
            if "merge" in call:
                self.assertIn("--ff-only", call)

    def recording_runner(self, command, **kwargs):
        self.git_calls.append(list(command))
        return subprocess.run(command, **kwargs)

    def publish(self, relative="README.md", content="v2\n", message="commit sem versão"):
        commit_file(self.publisher, relative, content, message)
        git(self.publisher, "push", "-q", "origin", "main")

    def release(self, version, notes, files=None):
        """Commit the CHANGELOG section (plus optional files) on main and push tag vX.Y.Z."""
        for relative, content in (files or {}).items():
            (self.publisher / relative).write_text(content, encoding="utf-8")
            git(self.publisher, "add", relative)
        self.changelog_sections.insert(0, f"## [{version}] - 2026-10-20\n\n{notes}\n")
        commit_file(
            self.publisher,
            "CHANGELOG.md",
            CHANGELOG_TEMPLATE.format(sections="\n".join(self.changelog_sections)),
            f"versão {version}",
        )
        git(self.publisher, "tag", "-a", f"v{version}", "-m", f"Simpress v{version}")
        git(self.publisher, "push", "-q", "origin", "main", f"v{version}")
        return git(self.publisher, "rev-parse", "HEAD")

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

    def ran(self, subcommand):
        return any(subcommand in call for call in self.git_calls)

    def test_fast_forwards_to_new_tag_and_shows_changelog(self):
        released = self.release("1.1.0", "- relatório novo", files={"README.md": "v2\n"})

        self.assertEqual(self.run_check(), EXIT_CONTINUE)

        self.assertEqual(self.head(), released)
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "v2\n")
        self.prompt.assert_called_once_with("Há uma versão nova (v1.1.0). Atualizar agora? (S/N) ")
        self.assertIn("Versão nova disponível: v1.1.0 (instalada: v1.0.0).", self.output())
        self.assertIn("## [1.1.0] - 2026-10-20", self.output())
        self.assertIn("- relatório novo", self.output())
        self.assertNotIn("primeira versão", self.output())
        self.assertNotIn("algo ainda sem versão", self.output())
        self.assertIn("Atualização concluída: Simpress v1.1.0.", self.output())
        self.assertNotIn("requirements.txt mudou", self.output())

    def test_untagged_commits_on_main_are_not_offered(self):
        self.publish()
        before = self.head()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertIn("Você já está na versão mais recente (v1.0.0).", self.output())

    def test_stops_at_the_tag_even_when_main_is_ahead(self):
        released = self.release("1.1.0", "- correção")
        self.publish(message="commit depois da tag, ainda sem CI")

        self.run_check()

        self.assertEqual(self.head(), released)
        self.assertNotEqual(self.head(), git(self.publisher, "rev-parse", "HEAD"))

    def test_shows_every_skipped_version_in_the_changelog(self):
        self.release("1.1.0", "- novidade da 1.1")
        self.release("1.2.0", "- novidade da 1.2")
        self.prompt.return_value = "N"

        self.run_check()

        self.prompt.assert_called_once_with("Há uma versão nova (v1.2.0). Atualizar agora? (S/N) ")
        self.assertIn("- novidade da 1.1", self.output())
        self.assertIn("- novidade da 1.2", self.output())
        self.assertNotIn("primeira versão", self.output())

    def test_without_any_tag_explains_and_does_not_update(self):
        git(self.publisher, "push", "-q", "origin", ":refs/tags/v1.0.0")
        self.publish()
        before = self.head()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertFalse(self.ran("fetch"))
        self.assertIn("Nenhuma versão publicada foi encontrada", self.output())
        self.assertIn("commits novos sem tag não são oferecidos", self.output())
        self.assertIn("Iniciando com a versão atual.", self.output())

    def test_ignores_tags_that_are_not_plain_versions(self):
        git(self.publisher, "push", "-q", "origin", ":refs/tags/v1.0.0")
        self.publish()
        for name in ("v2.0.0-rc1", "teste", "2.0.0"):
            git(self.publisher, "tag", name)
            git(self.publisher, "push", "-q", "origin", name)

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("Nenhuma versão publicada foi encontrada", self.output())

    def test_ignores_local_tags_that_are_not_on_origin(self):
        git(self.checkout, "switch", "-q", "-c", "experimento")
        commit_file(self.checkout, "x.txt", "x\n", "experimento local")
        git(self.checkout, "tag", "v9.0.0")
        git(self.checkout, "switch", "-q", "main")

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("Você já está na versão mais recente (v1.0.0).", self.output())

    def test_offers_first_tag_to_checkout_without_installed_version(self):
        git(self.publisher, "push", "-q", "origin", ":refs/tags/v1.0.0")
        released = self.release("1.1.0", "- primeira tag publicada")

        self.run_check()

        self.assertEqual(self.head(), released)
        self.assertIn("(instalada: nenhuma versão publicada)", self.output())

    def test_refuses_tag_outside_origin_main(self):
        git(self.publisher, "switch", "-q", "-c", "experimento")
        commit_file(self.publisher, "README.md", "experimento\n", "fora do main")
        git(self.publisher, "tag", "-a", "v2.0.0", "-m", "tag errada")
        git(self.publisher, "push", "-q", "origin", "experimento", "v2.0.0")
        before = self.head()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertIn("A versão v2.0.0 não está no histórico de origin/main", self.output())

    def test_keeps_current_version_when_user_declines_or_input_is_closed(self):
        self.release("1.1.0", "- novidade")
        before = self.head()
        for answer in ("N", "", "talvez"):
            self.prompt.return_value = answer
            self.run_check()
            self.assertEqual(self.head(), before)
        self.prompt.side_effect = EOFError
        self.run_check()
        self.assertEqual(self.head(), before)
        self.assertIn("Atualização adiada. Iniciando com a versão atual.", self.output())

    def test_refuses_with_tracked_local_changes(self):
        self.release("1.1.0", "- novidade")
        before = self.head()
        (self.checkout / "README.md").write_text("editado localmente\n", encoding="utf-8")

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertEqual((self.checkout / "README.md").read_text(encoding="utf-8"), "editado localmente\n")
        self.assertIn("Há uma versão nova (v1.1.0), mas existem alterações locais", self.output())
        self.assertIn("README.md", self.output())
        self.assertIn("Iniciando com a versão atual.", self.output())

    def test_refuses_outside_main_without_contacting_origin(self):
        git(self.checkout, "switch", "-q", "-c", "outro")
        self.release("1.1.0", "- novidade")

        self.run_check()

        self.prompt.assert_not_called()
        self.assertFalse(self.ran("fetch") or self.ran("ls-remote"))
        self.assertIn("só no branch main (atual: outro)", self.output())

    def test_refuses_detached_head(self):
        git(self.checkout, "switch", "-q", "--detach")
        self.release("1.1.0", "- novidade")

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("HEAD destacado", self.output())

    def test_refuses_when_local_history_diverged(self):
        commit_file(self.checkout, "local.txt", "x\n", "commit local")
        self.release("1.1.0", "- novidade")
        before = self.head()

        self.run_check()

        self.prompt.assert_not_called()
        self.assertEqual(self.head(), before)
        self.assertIn("commits que não estão na versão v1.1.0", self.output())

    def test_reports_failed_fast_forward_without_touching_untracked_file(self):
        self.release("1.1.0", "- arquivo que colide", files={"anotacao_local.txt": "remoto\n"})
        before = self.head()

        self.run_check()

        self.assertEqual(self.head(), before)
        self.assertIn("o fast-forward para v1.1.0 falhou", self.output())

    def test_reports_missing_network_or_origin(self):
        git(self.checkout, "remote", "set-url", "origin", str(Path(self.temporary_directory.name) / "inexistente.git"))

        self.run_check()

        self.prompt.assert_not_called()
        self.assertIn("Não foi possível consultar o servidor Git", self.output())

    def test_warns_when_requirements_change(self):
        self.release("1.1.0", "- dependências", files={"requirements.txt": "fastapi==2.0\n"})

        self.assertEqual(self.run_check(), EXIT_CONTINUE)

        self.assertIn("O requirements.txt mudou; as dependências serão reinstaladas a seguir.", self.output())

    def test_signals_launcher_restart_when_launcher_changes(self):
        self.release("1.1.0", "- inicializador", files={"iniciar_servidor.bat": "@echo off\necho novo\n"})

        self.assertEqual(self.run_check(), EXIT_LAUNCHER_CHANGED)

        self.assertIn("O inicializador foi atualizado e será reiniciado.", self.output())

    def test_disabled_by_environment_variable(self):
        self.release("1.1.0", "- novidade")
        before = self.head()

        self.run_check({DISABLE_VARIABLE: "0"})

        self.assertEqual(self.git_calls, [])
        self.assertEqual(self.head(), before)
        self.assertIn("desativada", self.output())


class VersionParsingTests(unittest.TestCase):
    def test_parse_remote_tags_prefers_peeled_commit_and_ignores_other_names(self):
        output = "\n".join([
            "aaa\trefs/tags/v1.0.0",
            "bbb\trefs/tags/v1.0.0^{}",
            "ccc\trefs/tags/v1.10.0",
            "ddd\trefs/tags/v1.2.0",
            "eee\trefs/tags/v2.0.0-rc1",
            "fff\trefs/tags/versao",
        ])

        self.assertEqual(
            parse_remote_tags(output),
            [((1, 0, 0), "bbb"), ((1, 2, 0), "ddd"), ((1, 10, 0), "ccc")],
        )

    def test_changelog_notes_keep_only_versions_after_installed(self):
        text = "\n".join([
            "# Changelog",
            "## [Não lançado]",
            "- futuro",
            "## [1.2.0] - 2026-11-01",
            "- dois",
            "",
            "## [1.1.0]",
            "- um",
            "## [1.0.0]",
            "- zero",
            "[1.2.0]: https://example.invalid",
        ])

        self.assertEqual(
            changelog_notes(text, (1, 0, 0), (1, 2, 0)),
            ["## [1.2.0] - 2026-11-01", "- dois", "", "## [1.1.0]", "- um"],
        )
        self.assertEqual(changelog_notes(text, None, (1, 0, 0)), ["## [1.0.0]", "- zero"])
        self.assertEqual(changelog_notes("", (1, 0, 0), (1, 1, 0)), [])

    def test_changelog_notes_are_truncated(self):
        text = "## [1.1.0]\n" + "\n".join(f"- item {index}" for index in range(100))

        notes = changelog_notes(text, (1, 0, 0), (1, 1, 0))

        self.assertEqual(len(notes), 41)
        self.assertIn("continua no CHANGELOG.md", notes[-1])


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

    def test_network_timeout_is_reported(self):
        def runner(command, **kwargs):
            if "ls-remote" in command:
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

    def test_project_changelog_has_unreleased_section(self):
        changelog = (PROJECT_ROOT / "CHANGELOG.md").read_text(encoding="utf-8")

        self.assertIn("## [Não lançado]", changelog)
        self.assertIn("v1.0.0", changelog)


if __name__ == "__main__":
    unittest.main()
