"""Connection policy for the local application."""

import ipaddress
import os
import socket
from typing import Any, Mapping


def acesso_rede_ativo() -> bool:
    """Opt-in (SIMPRESS_ACESSO_REDE=1): also accept peers on the private LAN, e.g. a phone on the same Wi-Fi."""
    return os.environ.get("SIMPRESS_ACESSO_REDE") == "1"


def ip_da_rede() -> str | None:
    """IPv4 this PC uses on the LAN (no packet is sent); None when offline."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("10.255.255.255", 1))
            return sock.getsockname()[0]
    except OSError:
        return None


def is_direct_loopback_request(scope: Mapping[str, Any]) -> bool:
    """Trust only the ASGI peer; local profiles do not support forwarded headers.

    Accept IPv4 127/8, IPv6 ::1, and IPv4-mapped IPv6 whose IPv4 is loopback.
    Reject missing/malformed peers, hostnames, scoped addresses, and proxy headers.
    Uvicorn must also run with proxy_headers=False to preserve the socket peer.
    """
    client = scope.get("client")
    if not isinstance(client, (tuple, list)) or len(client) != 2:
        return False
    address, port = client
    if (not isinstance(address, str) or "%" in address
            or type(port) is not int or not 0 <= port <= 65535):
        return False
    try:
        peer = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped is not None:
        peer = peer.ipv4_mapped
    if not peer.is_loopback and not (
        acesso_rede_ativo() and peer.is_private and not peer.is_link_local
    ):
        return False
    return not any(
        name.lower() in {b"forwarded", b"x-real-ip"}
        or name.lower().startswith(b"x-forwarded-")
        for name, _ in scope.get("headers", [])
    )
