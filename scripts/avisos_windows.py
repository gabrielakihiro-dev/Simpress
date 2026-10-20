"""Avisos do Windows (notificação toast) para a automação das rotinas.

O aviso é melhor esforço: usa o PowerShell do próprio Windows, sem janela e com
tempo limite curto. Falha, timeout ou ambiente não-Windows só registram um aviso
no log; a rotina nunca é interrompida por causa dele.

Os textos vêm das páginas e de erros, então são tratados só como dados: o XML do
toast é montado e escapado aqui e chega ao PowerShell por variável de ambiente.
O script do PowerShell é fixo e não recebe nenhum texto interpolado.

Defina ``SIMPRESS_AVISOS=0`` para desligar os avisos.
"""

from __future__ import annotations

import base64
import os
import subprocess
import sys
from typing import Callable
from xml.sax.saxutils import escape

# AppId registrado do Windows PowerShell; o toast aparece em nome dele.
APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
TIMEOUT_S = 8
LIMITE_TITULO = 120
LIMITE_MENSAGEM = 400

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:SIMPRESS_AVISO_XML)
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:SIMPRESS_AVISO_APPID).Show($toast)
"""
_SCRIPT_CODIFICADO = base64.b64encode(_SCRIPT.encode("utf-16-le")).decode("ascii")


def avisos_ligados() -> bool:
    return os.environ.get("SIMPRESS_AVISOS", "1").strip() != "0"


def _encurtar(texto: str, limite: int) -> str:
    texto = " ".join(str(texto).split())
    return texto if len(texto) <= limite else texto[: limite - 1] + "…"


def montar_xml(titulo: str, mensagem: str) -> str:
    titulo = escape(_encurtar(titulo, LIMITE_TITULO), {'"': "&quot;", "'": "&apos;"})
    mensagem = escape(_encurtar(mensagem, LIMITE_MENSAGEM), {'"': "&quot;", "'": "&apos;"})
    return (
        '<toast><visual><binding template="ToastGeneric">'
        f"<text>{titulo}</text><text>{mensagem}</text>"
        "</binding></visual></toast>"
    )


def _log_padrao(mensagem: str) -> None:
    print(f"[Aviso do Windows] {mensagem}", flush=True)


def notificar(titulo: str, mensagem: str, log: Callable[[str], None] = _log_padrao) -> bool:
    """Mostra um toast do Windows; devolve ``True`` se o PowerShell confirmou."""
    if not avisos_ligados():
        return False
    if sys.platform != "win32":
        log("Aviso não enviado: disponível só no Windows.")
        return False
    try:
        env = {**os.environ, "SIMPRESS_AVISO_XML": montar_xml(titulo, mensagem), "SIMPRESS_AVISO_APPID": APP_ID}
        resultado = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-EncodedCommand", _SCRIPT_CODIFICADO],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_S,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        log(f"Aviso não enviado: o PowerShell não respondeu em {TIMEOUT_S} s.")
        return False
    except Exception as erro:  # o aviso nunca derruba a rotina
        log(f"Aviso não enviado: {type(erro).__name__}: {erro}")
        return False
    if resultado.returncode != 0:
        detalhe = (resultado.stderr or resultado.stdout or "").strip().splitlines()
        log(f"Aviso não enviado (código {resultado.returncode}): {detalhe[0] if detalhe else 'sem detalhe'}")
        return False
    return True
