"""Connection policy shared by the file backend and local PostgreSQL pilot."""

import ipaddress
from typing import Any, Mapping


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
    if not peer.is_loopback:
        return False
    return not any(
        name.lower() in {b"forwarded", b"x-real-ip"}
        or name.lower().startswith(b"x-forwarded-")
        for name, _ in scope.get("headers", [])
    )
