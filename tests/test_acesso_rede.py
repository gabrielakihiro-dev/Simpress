"""Opt-in LAN access (SIMPRESS_ACESSO_REDE=1): phone peers pass only when enabled."""

import os
import unittest
from unittest.mock import patch

from security import local_requests
from security import network
from security.network import is_direct_loopback_request


def scope(peer, headers=()):
    return {"client": (peer, 50000), "headers": list(headers)}


class AcessoRedeTests(unittest.TestCase):
    def test_lan_peer_blocked_by_default(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIMPRESS_ACESSO_REDE", None)
            self.assertFalse(is_direct_loopback_request(scope("192.168.15.20")))
            self.assertTrue(is_direct_loopback_request(scope("127.0.0.1")))

    def test_lan_peer_allowed_when_enabled_but_not_public_or_proxied(self):
        with patch.dict(os.environ, {"SIMPRESS_ACESSO_REDE": "1"}):
            self.assertTrue(is_direct_loopback_request(scope("192.168.15.20")))
            self.assertTrue(is_direct_loopback_request(scope("10.0.0.5")))
            self.assertFalse(is_direct_loopback_request(scope("8.8.8.8")))
            self.assertFalse(is_direct_loopback_request(scope("169.254.1.1")))
            self.assertFalse(is_direct_loopback_request(
                scope("192.168.15.20", [(b"x-forwarded-for", b"1.1.1.1")])))

    def test_lan_host_authorized_only_when_enabled(self):
        with patch("security.local_requests.ip_da_rede", return_value="192.168.15.9"):
            with patch.dict(os.environ, {"SIMPRESS_ACESSO_REDE": "1"}):
                self.assertIn(("192.168.15.9", 8000), local_requests.allowed_local_authorities(8000))
            os.environ.pop("SIMPRESS_ACESSO_REDE", None)
            self.assertNotIn(("192.168.15.9", 8000), local_requests.allowed_local_authorities(8000))


class AcessoTailscaleTests(unittest.TestCase):
    def test_tailnet_peer_only_when_tailscale_enabled(self):
        with patch.dict(os.environ, {"SIMPRESS_ACESSO_TAILSCALE": "1"}):
            self.assertTrue(is_direct_loopback_request(scope("100.101.102.103")))
            self.assertFalse(is_direct_loopback_request(scope("192.168.15.20")))
            self.assertFalse(is_direct_loopback_request(scope("100.128.0.1")))
        with patch.dict(os.environ, {"SIMPRESS_ACESSO_REDE": "1"}):
            self.assertFalse(is_direct_loopback_request(scope("100.101.102.103")))
        os.environ.pop("SIMPRESS_ACESSO_TAILSCALE", None)
        self.assertFalse(is_direct_loopback_request(scope("100.101.102.103")))

    def test_tailscale_host_from_env_and_rejects_non_tailnet_ip(self):
        with patch.dict(os.environ, {"SIMPRESS_ACESSO_TAILSCALE": "1", "SIMPRESS_IP_TAILSCALE": "100.70.1.2"}):
            self.assertEqual(network.ip_tailscale(), "100.70.1.2")
            self.assertIn(("100.70.1.2", 8000), local_requests.allowed_local_authorities(8000))
        with patch.dict(os.environ, {"SIMPRESS_IP_TAILSCALE": "8.8.8.8"}):
            self.assertIsNone(network.ip_tailscale())


if __name__ == "__main__":
    unittest.main()
