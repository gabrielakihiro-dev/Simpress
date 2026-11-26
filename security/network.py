"""Connection policy for the local application."""

import ipaddress
import os
import shutil
import socket
import subprocess
from typing import Any, Mapping


def acesso_rede_ativo() -> bool:
    """Opt-in (SIMPRESS_ACESSO_REDE=1): also accept peers on the private LAN, e.g. a phone on the same Wi-Fi."""
    return os.environ.get("SIMPRESS_ACESSO_REDE") == "1"


TAILSCALE_REDE = ipaddress.ip_network("100.64.0.0/10")


def acesso_tailscale_ativo() -> bool:
    """Opt-in (SIMPRESS_ACESSO_TAILSCALE=1): also accept peers from the Tailscale tailnet (100.64.0.0/10)."""
    return os.environ.get("SIMPRESS_ACESSO_TAILSCALE") == "1"


def ip_tailscale() -> str | None:
    """This PC's tailnet IPv4: SIMPRESS_IP_TAILSCALE, else `tailscale ip -4`; None when unavailable."""
    valor = os.environ.get("SIMPRESS_IP_TAILSCALE", "").strip()
    if not valor:
        exe = shutil.which("tailscale")
        if not exe:
            return None
        try:
            saida = subprocess.run([exe, "ip", "-4"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            return None
        valor = saida.split()[0] if saida.split() else ""
    try:
        return valor if ipaddress.ip_address(valor) in TAILSCALE_REDE else None
    except ValueError:
        return None


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
        (acesso_rede_ativo() and peer.is_private and not peer.is_link_local)
        or (acesso_tailscale_ativo() and peer in TAILSCALE_REDE)
    ):
        return False
    return not any(
        name.lower() in {b"forwarded", b"x-real-ip"}
        or name.lower().startswith(b"x-forwarded-")
        for name, _ in scope.get("headers", [])
    )
