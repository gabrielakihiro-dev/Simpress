"""Download callbacks through Playwright's real event adapter, without a browser."""

import unittest
from pathlib import Path
from unittest.mock import ANY, Mock, patch

from scripts import automacao_rotinas_chrome as automacao

try:
    from playwright._impl._sync_base import SyncBase
    from pyee import EventEmitter
except ImportError:
    SyncBase = None


@unittest.skipIf(SyncBase is None, "Playwright is an optional automation dependency")
class DownloadCallbackTests(unittest.TestCase):
    def setUp(self):
        # Use the same callback wrapping as Page.once/remove_listener. No driver,
        # external site, download, login or operational file is accessed.
        class PageEvents(SyncBase):
            def __init__(self):
                self._impl_obj = EventEmitter()
                self.wait_for_timeout = Mock()

        self.page = PageEvents()
        self.download = object()
        self.saved_path = Path("synthetic.xlsx")
        cancel = patch.object(automacao, "verificar_cancelamento")
        self.cancel = cancel.start()
        self.addCleanup(cancel.stop)
        save = patch.object(automacao, "salvar_download", return_value=self.saved_path)
        self.save = save.start()
        self.addCleanup(save.stop)

    def assert_no_listener(self):
        self.assertEqual(self.page._impl_obj.listeners("download"), [])

    def test_download_is_registered_before_single_click(self):
        click = Mock(side_effect=lambda: self.page._impl_obj.emit("download", self.download))
        result = automacao.exportar_com_download(self.page, "Oracle", click)
        self.assertEqual(result, self.saved_path)
        click.assert_called_once_with()
        self.save.assert_called_once_with(self.download, "Oracle", ANY)
        self.assert_no_listener()

    def test_download_waits_without_repeating_export(self):
        click = Mock()
        self.page.wait_for_timeout.side_effect = lambda _ms: self.page._impl_obj.emit("download", self.download)
        automacao.exportar_com_download(self.page, "UX", click)
        click.assert_called_once_with()
        self.page.wait_for_timeout.assert_called_once_with(500)
        self.save.assert_called_once_with(self.download, "UX", ANY)
        self.assert_no_listener()

    def test_click_failure_removes_listener_and_does_not_save(self):
        click = Mock(side_effect=RuntimeError("blocked export"))
        with self.assertRaisesRegex(RuntimeError, "blocked export"):
            automacao.exportar_com_download(self.page, "Endpoint", click)
        click.assert_called_once_with()
        self.save.assert_not_called()
        self.assert_no_listener()

    def test_timeout_removes_listener_without_repeating_click(self):
        click = Mock()
        with patch.object(automacao, "DOWNLOAD_MS", 0), self.assertRaises(automacao.RotinaErro):
            automacao.exportar_com_download(self.page, "Oracle", click)
        click.assert_called_once_with()
        self.save.assert_not_called()
        self.assert_no_listener()

    def test_cancellation_removes_listener_without_repeating_click(self):
        click = Mock()
        self.cancel.side_effect = [None, automacao.RotinaCancelada()]
        with self.assertRaises(automacao.RotinaCancelada):
            automacao.exportar_com_download(self.page, "Oracle", click)
        click.assert_called_once_with()
        self.save.assert_not_called()
        self.assert_no_listener()

    def test_save_failure_does_not_retry_export(self):
        click = Mock(side_effect=lambda: self.page._impl_obj.emit("download", self.download))
        self.save.side_effect = automacao.RotinaErro("download rejected")
        with self.assertRaisesRegex(automacao.RotinaErro, "download rejected"):
            automacao.exportar_com_download(self.page, "Endpoint", click)
        click.assert_called_once_with()
        self.assert_no_listener()


if __name__ == "__main__":
    unittest.main()
