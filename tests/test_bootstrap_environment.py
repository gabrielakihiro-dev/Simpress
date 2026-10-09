import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from scripts.bootstrap_environment import ensure_environment

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class BootstrapEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory(
            prefix=".bootstrap-test-",
            dir=PROJECT_ROOT,
        )
        self.project_root = Path(self.temporary_directory.name)
        (self.project_root / "requirements.txt").write_text("fastapi==1.2.3\n", encoding="utf-8")

    def tearDown(self):
        self.temporary_directory.cleanup()

    def create_virtual_environment(self, path):
        python = path / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True)
        python.write_bytes(b"fixture executable")

    def test_creates_environment_installs_requirements_once_and_updates_changed_manifest(self):
        command_runner = Mock(return_value=SimpleNamespace(returncode=0))
        environment_creator = Mock(side_effect=self.create_virtual_environment)
        report = Mock()

        python_path = ensure_environment(
            self.project_root,
            python_version=(3, 14, 7),
            command_runner=command_runner,
            environment_creator=environment_creator,
            report=report,
        )

        self.assertEqual(python_path, self.project_root / ".venv" / "Scripts" / "python.exe")
        self.assertEqual(command_runner.call_count, 1)
        self.assertEqual(environment_creator.call_count, 1)

        ensure_environment(
            self.project_root,
            python_version=(3, 14, 7),
            command_runner=command_runner,
            environment_creator=environment_creator,
            report=report,
        )
        self.assertEqual(command_runner.call_count, 1)
        self.assertEqual(environment_creator.call_count, 1)

        (self.project_root / "requirements.txt").write_text("fastapi==1.2.4\n", encoding="utf-8")
        ensure_environment(
            self.project_root,
            python_version=(3, 14, 7),
            command_runner=command_runner,
            environment_creator=environment_creator,
            report=report,
        )
        self.assertEqual(command_runner.call_count, 2)

    def test_rejects_python_older_than_project_minimum(self):
        with self.assertRaisesRegex(RuntimeError, "Python 3.12 ou superior"):
            ensure_environment(
                self.project_root,
                python_version=(3, 11, 9),
                command_runner=Mock(),
                environment_creator=Mock(),
                report=Mock(),
            )

    def test_postgres_mode_installs_optional_manifest(self):
        (self.project_root / "requirements-postgres.txt").write_text(
            "-r requirements.txt\npsycopg[binary]==3.3.6\n",
            encoding="utf-8",
        )
        self.create_virtual_environment(self.project_root / ".venv")
        command_runner = Mock(return_value=SimpleNamespace(returncode=0))

        ensure_environment(
            self.project_root,
            postgres_pilot=True,
            python_version=(3, 14, 7),
            command_runner=command_runner,
            report=Mock(),
        )

        command = command_runner.call_args.args[0]
        self.assertEqual(command[-1], str(self.project_root / "requirements-postgres.txt"))

    def test_does_not_write_install_marker_when_pip_fails(self):
        self.create_virtual_environment(self.project_root / ".venv")
        command_runner = Mock(return_value=SimpleNamespace(returncode=1))

        with self.assertRaisesRegex(RuntimeError, "terminou com código 1"):
            ensure_environment(
                self.project_root,
                python_version=(3, 14, 7),
                command_runner=command_runner,
                report=Mock(),
            )

        self.assertFalse((self.project_root / ".venv" / ".simpress-requirements-sha256").exists())


if __name__ == "__main__":
    unittest.main()
