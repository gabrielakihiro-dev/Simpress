"""Session and history for opening tickets in UX through the automation Chrome."""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from typing import Any, Callable, Iterable, Protocol
import unicodedata
from uuid import uuid4

from core.integrity import atomic_write_json

SESSION_TTL = 30 * 60
HISTORY_NAME = "ux_chamados_historico.json"
PROFILE_NAME = "ux_solicitante.json"
PROFILE_FIELDS = ("nome", "email", "telefone", "ramal", "departamento_cargo")
# Default Solicitante when data/state/ux_solicitante.json does not exist: blank on purpose (the repository is public, so
# the real data lives only in that git-ignored file). A blank requester never goes to the portal on a real send.
SOLICITANTE_PADRAO = {"nome": "", "email": "", "telefone": "", "ramal": "", "departamento_cargo": ""}
EDITAVEIS = ("nome", "email", "telefone", "departamento_cargo")  # shown in the modal; ramal is not
EXCLUDED_STEMS = (
    "impress", "digitaliza", "atolament", "scanner", "printer", "mfp", "licenciament", "diverg", "toner",
    "nao reconhece chip", "bloqueio na conta ou aparelho", "falha na temperatura do fusor",
)
EXCLUDED_PREFIXES = ("hardware", "celular", "tablet")
# Same pattern as the check in static/js/features/ux-chamados.js (abrirChamadoUX): keep both in sync.
PLACEHOLDER = re.compile(r"\[[^\]\n]*\]|:[ \t]*$", re.MULTILINE)
SERIES_SEM_ENVIO_REAL = frozenset({"BRM551RN1Y"})
VAR_SEM_ENVIO = "SIMPRESS_UX_SEM_ENVIO"
MSG_SERIE_TESTE = "Esta série é de teste: só a simulação é permitida."
MSG_SEM_ENVIO = f"O envio real está desativado ({VAR_SEM_ENVIO}). Só a simulação é permitida."
MSG_SOLICITANTE_FALTANDO = (
    "O envio não foi feito: faltam dados do solicitante no formulário do UX. Preencha no Chrome de automação "
    "(ou crie data/state/ux_solicitante.json) e envie de novo. Faltando: "
)
MSG_SOLICITANTE_VAZIO = (
    "O envio não foi feito: o solicitante do UX não está definido. Preencha nome, e-mail, telefone e departamento/cargo "
    "no modal da Home (ou crie data/state/ux_solicitante.json) e envie de novo."
)
INCERTO = "O UX não confirmou o envio. Confira se o chamado foi criado antes de tentar novamente."


def envio_desativado() -> bool:
    """Test switch: with SIMPRESS_UX_SEM_ENVIO=1 the real submit is refused; dry runs still work."""
    return os.environ.get(VAR_SEM_ENVIO, "").strip().lower() in ("1", "true", "sim", "yes")


class ErroUX(Exception):
    def __init__(self, status: int, mensagem: str, *, codigo: str = "") -> None:
        super().__init__(mensagem)
        self.status = status
        self.codigo = codigo


class PortalUX(Protocol):
    def preparar(self, serial: str, aba: str) -> tuple[str, list[str]]: ...
    def validar(self, serial: str, modelo: str, aba: str) -> None: ...
    def preencher(
        self, serial: str, modelo: str, aba: str, problema: str, descricao: str, solicitante: dict[str, str],
    ) -> list[str] | None: ...
    def enviar(self, aba: str) -> str: ...
    def fechar(self, aba: str) -> None: ...


@dataclass(frozen=True)
class Sessao:
    serial: str
    modelo: str
    aba: str
    opcoes: tuple[str, ...]
    expira: float


def filtrar_opcoes(opcoes: Iterable[str]) -> list[str]:
    resultado: list[str] = []
    for texto in opcoes:
        texto = texto.strip()
        chave = "".join(c for c in unicodedata.normalize("NFD", texto.casefold()) if not unicodedata.combining(c))
        if chave and not chave.startswith(EXCLUDED_PREFIXES) and not any(termo in chave for termo in EXCLUDED_STEMS):
            if texto not in resultado:
                resultado.append(texto)
    return resultado


def validar_descricao(descricao: str) -> str:
    texto = descricao.strip()
    if not texto or len(texto) > 8000 or PLACEHOLDER.search(texto):
        raise ErroUX(422, "Preencha a descrição e substitua os campos em branco ou entre colchetes.")
    return texto


def ler_perfil_solicitante(caminho: Path) -> dict[str, str]:
    """Requester from the local profile file; without the file, the blank default. A broken file is a 503."""
    try:
        perfil = json.loads(caminho.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return dict(SOLICITANTE_PADRAO)
    except (OSError, ValueError):
        raise ErroUX(503, "O perfil local do solicitante do UX está inválido. Corrija ou apague data/state/ux_solicitante.json.") from None
    try:
        if not isinstance(perfil, dict):
            raise ValueError()
        dados = {campo: perfil.get(campo) for campo in PROFILE_FIELDS}
        if any(
            not isinstance(valor, str) or (not valor.strip() and campo != "ramal")
            or any(ord(c) < 32 for c in valor)
            for campo, valor in dados.items()
        ):
            raise ValueError()
    except (OSError, ValueError):
        raise ErroUX(503, "O perfil local do solicitante do UX está incompleto. Corrija ou apague data/state/ux_solicitante.json.") from None
    return {campo: str(valor).strip() for campo, valor in dados.items()}


def perfil_solicitante_ou_padrao(caminho: Path) -> dict[str, str]:
    # A broken local profile must not block flows where the Home sends the editable fields itself.
    try:
        return ler_perfil_solicitante(caminho)
    except ErroUX:
        return dict(SOLICITANTE_PADRAO)


class ChamadosUX:
    def __init__(
        self,
        state_dir: Path,
        conectar: Callable[[], AbstractContextManager[PortalUX]],
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._profile = state_dir / PROFILE_NAME
        self._history = state_dir / HISTORY_NAME
        self._conectar = conectar
        self._clock = clock
        self._lock = Lock()
        self._sessoes: dict[str, Sessao] = {}
        self._a_fechar: list[str] = []  # tabs of cancelled/expired/replaced sessions, closed at the next Chrome connection

    def _historico(self) -> list[dict[str, Any]]:
        try:
            historico = json.loads(self._history.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            raise ErroUX(503, "Não foi possível ler o histórico local do UX.") from None
        if not isinstance(historico, list) or any(not isinstance(item, dict) for item in historico):
            raise ErroUX(503, "O histórico local do UX está inválido.")
        return historico

    def _solicitante(self) -> dict[str, str]:
        return ler_perfil_solicitante(self._profile)

    def _perfil_ou_padrao(self) -> dict[str, str]:
        return perfil_solicitante_ou_padrao(self._profile)

    def _limpar_expiradas(self) -> None:
        agora = self._clock()
        self._a_fechar += [sessao.aba for sessao in self._sessoes.values() if sessao.expira <= agora]
        self._sessoes = {sid: sessao for sid, sessao in self._sessoes.items() if sessao.expira > agora}

    def tem_sessao_viva(self) -> bool:
        """True while a prepared session may still be finished in its Chrome tab (keeps the idle Chrome open)."""
        with self._lock:
            self._limpar_expiradas()
            return bool(self._sessoes)

    @staticmethod
    def _fechar(portal: PortalUX, aba: str) -> None:
        try:
            portal.fechar(aba)
        except Exception:
            pass  # best effort: a failed close must never mask the result of the request

    def _fechar_pendentes(self, portal: PortalUX) -> None:
        with self._lock:
            abas, self._a_fechar = self._a_fechar, []
        for aba in abas:
            self._fechar(portal, aba)

    def _fechar_abas(self) -> None:
        """Close pending tabs through a short connection of its own (cancel/expiry paths with no portal open)."""
        with self._lock:
            if not self._a_fechar:
                return
        try:
            with self._conectar() as portal:
                self._fechar_pendentes(portal)
        except Exception:
            pass  # Chrome busy or closed: the tabs stay listed for the next connection

    def _sessao(self, session_id: str, serial: str) -> Sessao:
        self._limpar_expiradas()
        sessao = self._sessoes.get(session_id)
        if sessao is None or sessao.serial != serial:
            raise ErroUX(409, "A sessão do UX expirou, foi cancelada ou pertence a outro equipamento. Prepare o chamado novamente.")
        return sessao

    def preparar(self, serial: str, *, conferido: bool = False) -> dict[str, Any]:
        aba = f"simpress-abrir-chamado-{uuid4().hex}"
        with self._conectar() as portal:
            historico = self._historico()
            incerto = self._ultimo(historico, serial, "incerto")
            if incerto and not incerto.get("conferido_em"):
                if not conferido:
                    raise ErroUX(409, INCERTO, codigo="envio_incerto")
                incerto["conferido_em"] = datetime.now().astimezone().isoformat()
                atomic_write_json(self._history, historico)
            modelo, opcoes_lidas = portal.preparar(serial, aba)
            opcoes = filtrar_opcoes(opcoes_lidas)
            if not modelo.strip() or not opcoes:
                raise ErroUX(409, "O UX não mostrou um modelo e problemas disponíveis para esta série.")
            session_id = uuid4().hex
            with self._lock:
                self._a_fechar += [anterior.aba for anterior in self._sessoes.values()]
                self._sessoes.clear()
                self._sessoes[session_id] = Sessao(
                    serial, modelo, aba, tuple(opcoes), self._clock() + SESSION_TTL,
                )
            self._fechar_pendentes(portal)
            ultimo_envio = self._ultimo(historico, serial, "enviado")
            padrao = self._perfil_ou_padrao()
            return {
                "status": "preparado", "serial": serial, "modelo": modelo, "opcoes": opcoes, "session_id": session_id,
                "solicitante": {campo: padrao[campo] for campo in EDITAVEIS},
                "ultimo_envio": {"os": ultimo_envio["os"], "data": ultimo_envio["data"]} if ultimo_envio else None,
            }

    @staticmethod
    def _ultimo(historico: list[dict[str, Any]], serial: str, estado: str) -> dict[str, Any]:
        return next((r for r in reversed(historico) if r.get("serie") == serial and r.get("estado") == estado), {})

    def cancelar(self, session_id: str) -> dict[str, str]:
        with self._lock:
            self._limpar_expiradas()
            sessao = self._sessoes.pop(session_id, None)
            if sessao is not None:
                self._a_fechar.append(sessao.aba)
        self._fechar_abas()
        if sessao is None:
            raise ErroUX(409, "A sessão do UX já expirou, foi cancelada ou teve um envio iniciado.")
        return {"status": "cancelado"}

    def _proposta(self, session_id: str, serial: str, problema: str) -> Sessao:
        with self._lock:
            sessao = self._sessao(session_id, serial)
            if problema not in sessao.opcoes:
                raise ErroUX(422, "Escolha um problema da lista preparada para este equipamento.")
            return sessao

    def executar(
        self, *, session_id: str, serial: str, problema: str, descricao: str, enviar: bool, confirmado: bool,
        solicitante: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if enviar and not confirmado:
            raise ErroUX(422, "O envio real do chamado exige confirmação.")
        if enviar and serial in SERIES_SEM_ENVIO_REAL:
            raise ErroUX(422, MSG_SERIE_TESTE)
        if enviar and envio_desativado():
            raise ErroUX(422, MSG_SEM_ENVIO)
        descricao = validar_descricao(descricao)
        try:
            sessao = self._proposta(session_id, serial, problema)
        except ErroUX:
            self._fechar_abas()  # the session may have just expired
            raise
        # Edited in the Home modal: it overrides only the editable fields; ramal still comes from the profile/default.
        dados = self._solicitante() if solicitante is None else self._perfil_ou_padrao()
        if solicitante is not None:
            dados.update({campo: solicitante[campo].strip() for campo in EDITAVEIS})
            if any(not dados[campo] or any(ord(c) < 32 for c in dados[campo]) for campo in EDITAVEIS):
                raise ErroUX(422, "Preencha nome, e-mail, telefone e departamento/cargo do solicitante.")
        solicitante = dados
        if any(not dados.get(campo) for campo in EDITAVEIS):
            # No profile file and a blank default: refuse before touching the portal (no click, no history record).
            # A dry run keeps the portal's own Solicitante and reports what is still empty (`faltando`).
            if enviar:
                raise ErroUX(422, MSG_SOLICITANTE_VAZIO)
            solicitante = {}
        with self._conectar() as portal:
            try:
                return self._executar_no_portal(
                    portal, sessao, session_id, serial, problema, descricao, solicitante, enviar,
                )
            finally:
                self._fechar_pendentes(portal)

    def _executar_no_portal(
        self, portal: PortalUX, sessao: Sessao, session_id: str, serial: str, problema: str, descricao: str,
        solicitante: dict[str, str], enviar: bool,
    ) -> dict[str, Any]:
        with self._lock:
            self._sessao(session_id, serial)
        portal.validar(serial, sessao.modelo, sessao.aba)
        faltando = portal.preencher(serial, sessao.modelo, sessao.aba, problema, descricao, solicitante) or []
        with self._lock:
            self._sessao(session_id, serial)
        if not enviar:
            return {"status": "preenchido", "serial": serial, "faltando": faltando}
        if faltando:
            raise ErroUX(409, MSG_SOLICITANTE_FALTANDO + ", ".join(faltando) + ".")
        portal.validar(serial, sessao.modelo, sessao.aba)
        with self._lock:
            self._sessao(session_id, serial)
            historico = self._historico()
            incerto = self._ultimo(historico, serial, "incerto")
            if incerto and not incerto.get("conferido_em"):
                raise ErroUX(409, INCERTO, codigo="envio_incerto")
            registro = {"serie": serial, "data": datetime.now().astimezone().isoformat(), "os": None, "estado": "incerto"}
            # Persist before the click, so an interrupted process cannot silently allow a retry.
            historico.append(registro)
            atomic_write_json(self._history, historico)
            del self._sessoes[session_id]
        try:
            os = portal.enviar(sessao.aba)
            if not re.fullmatch(r"[0-9]{1,24}", os):
                raise ValueError()
            registro.update(os=os, estado="enviado")
            atomic_write_json(self._history, historico)
        except Exception:
            return {"status": "incerto", "serial": serial, "mensagem": INCERTO}
        finally:
            self._fechar(portal, sessao.aba)  # the session is over, whatever the outcome; never clicks again
        return {"status": "enviado", "serial": serial, "os": os}

