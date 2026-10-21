"""Reuse a running local Simpress server or select an available local port."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from urllib.request import ProxyHandler, build_opener


HOST = "127.0.0.1"
FIRST_PORT = 8000
LAST_PORT = 8099
EXPECTED_TITLE = "Simpress Transferência de Equipamentos - SEBRAE/PR"
EXPECTED_PATHS = {"/api/prontidao", "/api/stats"}
# Routes added after the first releases; a Simpress answering without them is an old server.
CURRENT_PATHS = {"/api/automacao/estado", "/api/automacao/executar"}
PORT_PROBE_TIMEOUT = 0.1
HTTP_PROBE_TIMEOUT = 0.75


def _probe_simpress(port: int) -> dict | None:
    """Return the OpenAPI document when a Simpress server answers on the port."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            connection.settimeout(PORT_PROBE_TIMEOUT)
            if connection.connect_ex((HOST, port)) != 0:
                return False
    except OSError:
        return None

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
        return None

    info = document.get("info", {})
    paths = document.get("paths", {})
    if (
        info.get("title") == EXPECTED_TITLE
        and EXPECTED_PATHS.issubset(paths)
        and isinstance(stats, dict)
    ):
        return document
    return None


def _is_simpress_running(port: int) -> bool:
    return _probe_simpress(port) is not None


def _is_outdated(document: dict) -> bool:
    return not CURRENT_PATHS.issubset(document.get("paths", {}))


def _listening_pid(port: int) -> str | None:
    """PID listening on the port (Windows netstat), or None when it cannot be found."""
    try:
        output = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, timeout=5
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in output.splitlines():
        columns = line.split()
        if len(columns) >= 5 and columns[3].upper() == "LISTENING" and columns[1].endswith(f":{port}"):
            return columns[4]
    return None


def _describe_port(port: int) -> str:
    pid = _listening_pid(port)
    return f"porta {port}" + (f" (PID {pid})" if pid else "")


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

        document = _probe_simpress(port)
        if document is not None:
            if _is_outdated(document):
                print(
                    f"AVISO: o servidor Simpress em execucao na {_describe_port(port)} esta desatualizado "
                    "(sem as rotas /api/automacao). Feche essa janela do servidor e abra o iniciar_servidor.bat de novo.",
                    file=sys.stderr,
                )
                print(f"OUTDATED:{port}")
                return 0
            print(f"RUNNING:{port}")
            return 0
        if first_available_port is None:
            print(
                f"AVISO: a {_describe_port(port)} esta ocupada por outro programa (nao e o Simpress); "
                "o servidor usara a proxima porta livre.",
                file=sys.stderr,
            )

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
