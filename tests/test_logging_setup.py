"""Server logging reaches a rotating local file once, without duplicate handlers."""

import logging
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from core import logging_setup


class LoggingSetupTests(unittest.TestCase):
    def setUp(self):
        self.root = logging.getLogger()
        self.previous_level = self.root.level
        self.previous_handlers = list(self.root.handlers)
        self.log_dir = Path(self.enterContext(tempfile.TemporaryDirectory())) / "logs"
        # Registered last so it runs first: Windows cannot delete an open log file.
        self.addCleanup(self.restore_root)
        for name in logging_setup.HTTP_CLIENT_LOGGERS:
            self.addCleanup(logging.getLogger(name).setLevel, logging.getLogger(name).level)

    def restore_root(self):
        for handler in self.root.handlers:
            if handler not in self.previous_handlers:
                handler.close()
        self.root.handlers[:] = self.previous_handlers
        self.root.setLevel(self.previous_level)

    def added_handlers(self):
        return [handler for handler in self.root.handlers if handler not in self.previous_handlers]

    def test_info_messages_from_domain_loggers_reach_the_local_file(self):
        log_file = logging_setup.configure_logging(self.log_dir)
        logging.getLogger("domains.inventory_inbox").info("Entrada automática ativa.")
        for handler in self.added_handlers():
            handler.flush()

        self.assertEqual(log_file, self.log_dir / "simpress.log")
        text = log_file.read_text(encoding="utf-8")
        self.assertIn("[INFO] domains.inventory_inbox: Entrada automática ativa.", text)

    def test_repeated_configuration_keeps_a_single_set_of_handlers(self):
        logging_setup.configure_logging(self.log_dir)
        first = self.added_handlers()
        logging_setup.configure_logging(self.log_dir)

        self.assertEqual(len(first), 2)
        self.assertEqual(self.added_handlers(), first)

    def test_unavailable_log_folder_keeps_console_logging(self):
        with patch.object(Path, "mkdir", side_effect=PermissionError("locked")):
            logging_setup.configure_logging(self.log_dir)

        handlers = self.added_handlers()
        self.assertEqual(len(handlers), 1)
        self.assertIsInstance(handlers[0], logging.StreamHandler)

    def test_logged_exceptions_keep_frames_but_drop_messages_with_paths(self):
        log_file = logging_setup.configure_logging(self.log_dir)
        # Built outside the raising line: frames quote source lines, not exception messages.
        path = "C:/Users/" + "Fulano" + "/OneDrive/EquipamentosDetalhes.xlsx"
        try:
            raise PermissionError(path)
        except PermissionError:
            logging.getLogger("domains.example").exception("Falha ao gravar.")
        for handler in self.added_handlers():
            handler.flush()

        text = log_file.read_text(encoding="utf-8")
        self.assertIn("Falha ao gravar.", text)
        self.assertIn("test_logged_exceptions_keep_frames_but_drop_messages_with_paths", text)
        self.assertIn("PermissionError", text)
        self.assertNotIn("Fulano", text)

    def test_redacted_reference_is_stable_and_hides_the_value(self):
        token = logging_setup.redact_reference("SERIE-FICTICIA-01")
        self.assertEqual(token, logging_setup.redact_reference("SERIE-FICTICIA-01"))
        self.assertNotIn("FICTICIA", token)
        self.assertEqual(logging_setup.redact_reference(""), "-")


    def test_http_client_request_urls_with_personal_data_stay_out_of_the_log(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()

        @app.get("/api/buscar")
        def buscar(q: str):
            logging.getLogger("domains.busca").info("Busca concluída.")
            return {}

        log_file = logging_setup.configure_logging(self.log_dir)
        resposta = TestClient(app).get("/api/buscar", params={"q": "Fulano 123.456.789-00"})
        for name in logging_setup.HTTP_CLIENT_LOGGERS:
            logging.getLogger(name).warning("falha de conexão")
        for handler in self.added_handlers():
            handler.flush()

        self.assertEqual(resposta.status_code, 200)
        text = log_file.read_text(encoding="utf-8")
        self.assertIn("Busca concluída.", text)
        self.assertNotIn("Fulano", text)
        self.assertNotIn("123.456.789-00", text)
        for name in logging_setup.HTTP_CLIENT_LOGGERS:
            self.assertIn(f"[WARNING] {name}: falha de conexão", text)


if __name__ == "__main__":
    unittest.main()
