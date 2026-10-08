"""Reuse a running local Simpress server or select an available local port."""

from __future__ import annotations

import json
import socket
import sys
from urllib.request import ProxyHandler, build_opener


HOST = "127.0.0.1"
FIRST_PORT = 8000
LAST_PORT = 8099
EXPECTED_TITLE = "Simpress Transferência de Equipamentos - SEBRAE/PR"
EXPECTED_PATHS = {"/api/prontidao", "/api/stats"}
PORT_PROBE_TIMEOUT = 0.1
HTTP_PROBE_TIMEOUT = 0.75


def _is_simpress_running(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(PORT_PROBE_TIMEOUT)
            if connection.connect_ex((HOST, port)) != 0:
                return False
    except OSError:
        return False

    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(
            f"http://{HOST}:{port}/openapi.json", timeout=HTTP_PROBE_TIMEOUT
        ) as response:
            document = json.load(response)
        with opener.open(
            f"http://{HOST}:{port}/api/stats", timeout=HTTP_PROBE_TIMEOUT
        ) as response:
            stats = json.load(response)
    except Exception:
        return False

    info = document.get("info", {})
    paths = document.get("paths", {})
    return (
        info.get("title") == EXPECTED_TITLE
        and EXPECTED_PATHS.issubset(paths)
        and isinstance(stats, dict)
    )


def _is_port_available(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind((HOST, port))
        return True
    except OSError:
        return False


def main() -> int:
    first_available_port: int | None = None

    for port in range(FIRST_PORT, LAST_PORT + 1):
        if _is_port_available(port):
            if first_available_port is None:
                first_available_port = port
            continue

        if _is_simpress_running(port):
            print(f"RUNNING:{port}")
            return 0

    if first_available_port is not None:
        print(f"PORT:{first_available_port}")
        return 0

    print(
        f"ERRO: nenhuma porta local entre {FIRST_PORT} e {LAST_PORT} está disponível.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
