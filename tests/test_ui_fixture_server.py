"""The UI fixture accepts a burst of module requests before its next accept cycle."""

from contextlib import ExitStack
import socket
import threading
import unittest

from support.serve_ui_motion_preview import Handler, UIFixtureServer


class QuietHandler(Handler):
    def log_message(self, *_args):
        pass


class UIFixtureServerTests(unittest.TestCase):
    def test_module_burst_is_queued_until_the_server_can_accept_it(self):
        with UIFixtureServer(("127.0.0.1", 0), QuietHandler) as server, ExitStack() as clients:
            connections = []
            # Hold the accept loop until all imports have arrived. This reproduces
            # a busy runner without relying on thread timing or arbitrary sleeps.
            for _ in range(32):
                connection = clients.enter_context(socket.create_connection(server.server_address, timeout=1))
                connection.settimeout(10)
                connection.sendall(b"GET /static/app-entry.js HTTP/1.0\r\nHost: localhost\r\n\r\n")
                connections.append(connection)

            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                for connection in connections:
                    response = bytearray()
                    while chunk := connection.recv(8192):
                        response.extend(chunk)
                    self.assertTrue(response.startswith(b"HTTP/1.0 200"))
                    self.assertIn(b'import "./app.js";', response)
            finally:
                server.shutdown()
                worker.join(timeout=10)
                self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()
