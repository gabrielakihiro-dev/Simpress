"""Session and history for preparing the UX "Gerar ticket" from the Transporte tab.

Two kinds: "Transporte" (Atualização Cadastral with the transfer workbook attached) and "Alterar Endereço"
(Transporte / Transferência Fisica de Equipamentos, no workbook, CNPJ, CEP or Nº interno)."""
from __future__ import annotations

from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
from datetime import datetime
import json
from pathlib import Path
import re
from threading import Lock
from time import monotonic
from typing import Any, Callable, Protocol
import unicodedata
from uuid import uuid4

from core.integrity import atomic_write_json
from domains.ux_chamados import (
    MSG_SEM_ENVIO, MSG_SERIE_TESTE, PLACEHOLDER, PROFILE_NAME, SERIES_SEM_ENVIO_REAL, ErroUX, envio_desativado,
    perfil_solicitante_ou_padrao,
)

SESSION_TTL = 30 * 60
HISTORY_NAME = "ux_tickets_historico.json"
# Single backend source of the billing CNPJ (static/js/features/transfer-form.js keeps a copy for the form).
CNPJ_FATURAMENTO = "75.110.585/0001-00"
CONTRATO = "16467"
INCIDENTE = "Atualização Cadastral"
MOTIVO = "Alteração de Endereço ou Razão Social"
TIPO_ATUALIZACAO = "atualizacao"  # button "Transporte" (workbook + Atualização Cadastral)
TIPO_ENDERECO = "endereco"  # button "Alterar Endereço"
# Incidente and Motivo per kind, exact UX labels ("Fisica" without accent, as the portal lists it).
ESCOLHAS = {
    TIPO_ATUALIZACAO: (INCIDENTE, MOTIVO),
    TIPO_ENDERECO: ("Transporte", "Transferência Fisica de Equipamentos"),
}
DESCRICAO_MAX = 2500  # maxlength of the portal's "Registro" textarea
CHAMADO_INTERNO_MAX = 10  # maxlength of input#InputNumeroChamado
ANEXO_MAX = 5 * 1024 * 1024  # "arquivo ... com até 5MB"
CAMPOS_SOLICITANTE = ("nome", "email", "telefone")
INCERTO = "O UX não confirmou o ticket. Confira se ele foi criado antes de tentar novamente."


class PortalTicket(Protocol):
    def preparar(self, serial: str, aba: str, cep: str) -> tuple[str, list[str]]: ...
    def preparar_transferencia(self, serial: str, aba: str) -> str: ...
    def escolher_endereco(self, serial: str, modelo: str, aba: str, endereco: str, cep: str) -> None: ...
    def preencher(self, serial: str, modelo: str, aba: str, cep: str, formulario: "Formulario") -> None: ...
    def enviar(self, aba: str, antes_do_clique: Callable[[], None]) -> str: ...
    def fechar(self, aba: str) -> None: ...


@dataclass(frozen=True)
class Formulario:
    endereco: str
    cnpj_instalacao: str
    cnpj_faturamento: str
    descricao: str
    nome: str
    email: str
    telefone: str
    chamado_interno: str
    arquivo_nome: str
    arquivo: bytes
    tipo: str = TIPO_ATUALIZACAO


@dataclass(frozen=True)
class Sessao:
    serial: str
    modelo: str
    aba: str
    cep: str  # "85504-000", as typed in the portal
    cnpj_instalacao: str
    opcoes: tuple[str, ...]
    endereco: str | None
    arquivo_nome: str
    arquivo: bytes
    expira: float
    tipo: str = TIPO_ATUALIZACAO


def _chave(texto: str) -> str:
    sem_acento = "".join(c for c in unicodedata.normalize("NFKD", texto.casefold()) if not unicodedata.combining(c))
    palavras = re.sub(r"[^a-z0-9]+", " ", sem_acento).split()
    # "nº 333" / "n° 333" / "no 333" are the same number as "333".
    return " ".join(p for i, p in enumerate(palavras) if not (
        p in ("n", "no", "numero") and i + 1 < len(palavras) and palavras[i + 1][:1].isdigit()
    ))


def enderecos_correspondentes(opcoes: list[str], endereco: str, cidade: str, cep: str) -> list[str]:
    """Options matching street + number, city and CEP digits. Portal format:
    "<LOGRADOURO>, <NÚMERO>[ , <COMPLEMENTO>] - <BAIRRO>, <Cidade> - <UF>, <CEP>";
    the unit: "<endereco>[ - <complemento>] - <cidade>/<UF> - CEP <cep>".
    Among street matches, the option whose complement equals the unit's wins (Barracão "SALA 02", Maringá "TERREO");
    without one, only options with no complement count (the rule before 08/11/2026). Two records that differ only by an
    abbreviated neighbourhood (Londrina "AER"/"AEROPORTO") are one address: the full form is picked."""
    partes = endereco.split(" - ")
    logradouro = _chave(partes[0])
    cidade_chave = _chave(cidade)
    digitos_cep = re.sub(r"\D", "", cep)
    if not logradouro or not cidade_chave or len(digitos_cep) != 8:
        return []
    complemento = " ".join(
        _chave(p) for p in partes[1:]
        if not re.match(r"\s*cep\b", p, re.IGNORECASE) and not re.fullmatch(rf"{re.escape(cidade_chave)} [a-z]{{2}}", _chave(p))
    )

    def campos(opcao: str) -> tuple[str, str, str]:
        primeiro, _, resto = opcao.partition(" - ")
        rua, _, compl = primeiro.partition(" , ")
        return _chave(rua), _chave(compl), _chave(resto.split(",", 1)[0])

    base = [
        opcao for opcao in opcoes
        if campos(opcao)[0] == logradouro
        and f" {cidade_chave} " in f" {_chave(opcao)} "
        and re.sub(r"\D", "", opcao.rsplit(",", 1)[-1]) == digitos_cep
    ]
    achados = [o for o in base if complemento and campos(o)[1] == complemento] or [o for o in base if not campos(o)[1]]
    if len(achados) > 1 and len({_chave(o) for o in achados}) == 1:
        # Only case/accents differ (Toledo "AV Parigot de Souza" / "AV PARIGOT DE SOUZA"): one address; prefer the unit's spelling.
        return [next((o for o in achados if o.startswith(partes[0].strip() + " ")), achados[0])]
    if len(achados) > 1:
        bairros = [campos(o)[2] for o in achados]
        maior = max(bairros, key=len)
        # Word by word ("aer" -> "aeroporto"), so "BORTOT" is never read as "BORTOT II".
        abrevia = lambda curto, longo: len(curto.split()) == len(longo.split()) and all(
            l.startswith(c) for c, l in zip(curto.split(), longo.split()))
        if len({campos(o)[1] for o in achados}) == 1 and all(abrevia(b, maior) for b in bairros) and bairros.count(maior) == 1:
            return [achados[bairros.index(maior)]]
    return achados


def validar_descricao_ticket(descricao: str) -> str:
    texto = descricao.replace("\r\n", "\n").strip()
    if not texto or len(texto) > DESCRICAO_MAX or PLACEHOLDER.search(texto):
        raise ErroUX(422, f"Preencha o registro (até {DESCRICAO_MAX} caracteres) e substitua os campos em branco ou entre colchetes.")
    return texto


class TicketsUX:
    def __init__(
        self,
        state_dir: Path,
        conectar: Callable[[], AbstractContextManager[PortalTicket]],
        *,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._history = state_dir / HISTORY_NAME
        self._profile = state_dir / PROFILE_NAME
        self._conectar = conectar
        self._clock = clock
        self._lock = Lock()
        self._sessoes: dict[str, Sessao] = {}
        self._a_fechar: list[str] = []  # tabs of cancelled/expired/replaced sessions, closed at the next Chrome connection

    def solicitante_padrao(self) -> dict[str, str]:
        """Default requester of the modal: the local profile (data/state/ux_solicitante.json), blank when there is none."""
        perfil = perfil_solicitante_ou_padrao(self._profile)
        return {campo: perfil[campo] for campo in CAMPOS_SOLICITANTE}

    def _historico(self) -> list[dict[str, Any]]:
        try:
            historico = json.loads(self._history.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError):
            raise ErroUX(503, "Não foi possível ler o histórico local de tickets do UX.") from None
        if not isinstance(historico, list) or any(not isinstance(item, dict) for item in historico):
            raise ErroUX(503, "O histórico local de tickets do UX está inválido.")
        return historico

    @staticmethod
    def _ultimo(historico: list[dict[str, Any]], serial: str, estado: str) -> dict[str, Any]:
        return next((r for r in reversed(historico) if r.get("serie") == serial and r.get("estado") == estado), {})

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
    def _fechar(portal: PortalTicket, aba: str) -> None:
        try:
            portal.fechar(aba)
        except Exception:
            pass  # best effort: a failed close must never mask the result of the request

    def _fechar_pendentes(self, portal: PortalTicket) -> None:
        with self._lock:
            abas, self._a_fechar = self._a_fechar, []
        for aba in abas:
            self._fechar(portal, aba)

    def _fechar_abas(self) -> None:
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
            raise ErroUX(409, "A sessão do ticket expirou, foi cancelada ou pertence a outro equipamento. Prepare o ticket novamente.")
        return sessao

    def _sessao_valida(self, session_id: str, serial: str) -> Sessao:
        try:
            with self._lock:
                return self._sessao(session_id, serial)
        except ErroUX:
            self._fechar_abas()  # the session may have just expired
            raise

    def preparar(
        self, *, serial: str, entrega_endereco: str, entrega_cidade: str, entrega_cep: str, entrega_cnpj: str,
        arquivo_nome: str, arquivo: bytes, conferido: bool = False,
    ) -> dict[str, Any]:
        serial = serial.strip().upper()
        cep = re.sub(r"\D", "", entrega_cep)
        if len(cep) != 8:
            raise ErroUX(422, "Informe o CEP da unidade de entrega com 8 dígitos.")
        no_endereco = re.search(r"CEP\s*(\d{5})-?(\d{3})", entrega_endereco, re.IGNORECASE)
        if no_endereco and "".join(no_endereco.groups()) != cep:
            raise ErroUX(422, "O CEP informado não confere com o endereço da unidade de entrega.")
        if len(re.sub(r"\D", "", entrega_cnpj)) != 14:
            raise ErroUX(422, "Informe o CNPJ da unidade de entrega.")
        if not arquivo or len(arquivo) > ANEXO_MAX:
            raise ErroUX(422, "A planilha gerada passa de 5 MB, o limite de anexo do UX.")
        aba = f"simpress-gerar-ticket-{uuid4().hex}"
        with self._conectar() as portal:
            historico = self._liberar_incerto(serial, conferido)
            cep_ux = f"{cep[:5]}-{cep[5:]}"
            modelo, opcoes = portal.preparar(serial, aba, cep_ux)
            if not modelo.strip():
                raise ErroUX(409, "O UX não mostrou o modelo do equipamento.")
            # Only a single option matching street + number (+ complement), city and CEP is chosen automatically.
            achados = enderecos_correspondentes(opcoes, entrega_endereco, entrega_cidade, cep)
            endereco = achados[0] if len(achados) == 1 else None
            if endereco is not None:
                portal.escolher_endereco(serial, modelo, aba, endereco, cep_ux)
            session_id = self._nova_sessao(Sessao(
                serial, modelo, aba, cep_ux, entrega_cnpj.strip(), tuple(opcoes), endereco,
                arquivo_nome, arquivo, self._clock() + SESSION_TTL,
            ))
            self._fechar_pendentes(portal)
            ultimo = self._ultimo(historico, serial, "enviado")
            return {
                "status": "preparado" if endereco else "endereco_ambiguo", "tipo": TIPO_ATUALIZACAO,
                "session_id": session_id, "serial": serial, "modelo": modelo,
                "endereco": endereco, "opcoes_endereco": list(opcoes),
                "cnpj_instalacao": entrega_cnpj.strip(), "cnpj_faturamento": CNPJ_FATURAMENTO,
                "arquivo": arquivo_nome,
                "solicitante": self.solicitante_padrao(),
                "ultimo_envio": {"ticket": ultimo["ticket"], "data": ultimo["data"]} if ultimo else None,
            }

    def preparar_alterar_endereco(self, *, serial: str, conferido: bool = False) -> dict[str, Any]:
        """"Alterar Endereço": Transporte / Transferência Fisica in the UX; no workbook, CNPJ, CEP or address choice."""
        serial = serial.strip().upper()
        aba = f"simpress-gerar-ticket-{uuid4().hex}"
        with self._conectar() as portal:
            historico = self._liberar_incerto(serial, conferido)
            modelo = portal.preparar_transferencia(serial, aba)
            if not modelo.strip():
                raise ErroUX(409, "O UX não mostrou o modelo do equipamento.")
            session_id = self._nova_sessao(Sessao(
                serial, modelo, aba, "", "", (), "", "", b"", self._clock() + SESSION_TTL, TIPO_ENDERECO,
            ))
            self._fechar_pendentes(portal)
            ultimo = self._ultimo(historico, serial, "enviado")
            return {
                "status": "preparado", "tipo": TIPO_ENDERECO, "session_id": session_id, "serial": serial,
                "modelo": modelo,
                "solicitante": self.solicitante_padrao(),
                "ultimo_envio": {"ticket": ultimo["ticket"], "data": ultimo["data"]} if ultimo else None,
            }

    def _liberar_incerto(self, serial: str, conferido: bool) -> list[dict[str, Any]]:
        """An unchecked "incerto" send blocks a new ticket for the same série until the user says it was checked."""
        historico = self._historico()
        incerto = self._ultimo(historico, serial, "incerto")
        if incerto and not incerto.get("conferido_em"):
            if not conferido:
                raise ErroUX(409, INCERTO, codigo="envio_incerto")
            incerto["conferido_em"] = datetime.now().astimezone().isoformat()
            atomic_write_json(self._history, historico)
        return historico

    def _nova_sessao(self, sessao: Sessao) -> str:
        """One live session at a time: older tabs are queued to close."""
        session_id = uuid4().hex
        with self._lock:
            self._a_fechar += [anterior.aba for anterior in self._sessoes.values()]
            self._sessoes.clear()
            self._sessoes[session_id] = sessao
        return session_id

    def escolher_endereco(self, *, session_id: str, serial: str, endereco: str) -> dict[str, Any]:
        serial = serial.strip().upper()
        sessao = self._sessao_valida(session_id, serial)
        if sessao.tipo != TIPO_ATUALIZACAO or sessao.opcoes.count(endereco) != 1:
            raise ErroUX(422, "Escolha um dos endereços listados pelo UX para esta sessão.")
        with self._conectar() as portal:
            try:
                portal.escolher_endereco(serial, sessao.modelo, sessao.aba, endereco, sessao.cep)
                with self._lock:
                    atual = self._sessao(session_id, serial)
                    self._sessoes[session_id] = replace(atual, endereco=endereco)
            finally:
                self._fechar_pendentes(portal)
        return {"status": "preparado", "session_id": session_id, "serial": serial, "endereco": endereco}

    def cancelar(self, session_id: str) -> dict[str, str]:
        with self._lock:
            self._limpar_expiradas()
            sessao = self._sessoes.pop(session_id, None)
            if sessao is not None:
                self._a_fechar.append(sessao.aba)
        self._fechar_abas()
        if sessao is None:
            raise ErroUX(409, "A sessão do ticket já expirou, foi cancelada ou teve um envio iniciado.")
        return {"status": "cancelado"}

    def executar(
        self, *, session_id: str, serial: str, descricao: str, solicitante: dict[str, str], chamado_interno: str,
        enviar: bool, confirmado: bool,
    ) -> dict[str, Any]:
        serial = serial.strip().upper()
        if enviar and not confirmado:
            raise ErroUX(422, "O envio real do ticket exige confirmação.")
        if enviar and serial in SERIES_SEM_ENVIO_REAL:
            raise ErroUX(422, MSG_SERIE_TESTE)
        if enviar and envio_desativado():
            raise ErroUX(422, MSG_SEM_ENVIO)
        descricao = validar_descricao_ticket(descricao)
        dados = {campo: str(solicitante.get(campo) or "").strip() for campo in CAMPOS_SOLICITANTE}
        if any(not valor or any(ord(c) < 32 for c in valor) for valor in dados.values()):
            raise ErroUX(422, "Preencha nome, e-mail e telefone do solicitante.")
        interno = chamado_interno.strip()
        if len(interno) > CHAMADO_INTERNO_MAX or any(ord(c) < 32 for c in interno):
            raise ErroUX(422, f"O Nº do chamado interno aceita até {CHAMADO_INTERNO_MAX} caracteres.")
        sessao = self._sessao_valida(session_id, serial)
        if sessao.tipo == TIPO_ENDERECO:
            interno = ""  # "Alterar Endereço" never fills the Nº do chamado interno
        if sessao.endereco is None:
            raise ErroUX(409, "Escolha o endereço em Meus Endereços antes de continuar.", codigo="endereco_ambiguo")
        formulario = Formulario(
            sessao.endereco, sessao.cnpj_instalacao, CNPJ_FATURAMENTO, descricao,
            dados["nome"], dados["email"], dados["telefone"], interno, sessao.arquivo_nome, sessao.arquivo, sessao.tipo,
        )
        with self._conectar() as portal:
            try:
                return self._executar_no_portal(portal, sessao, session_id, serial, formulario, enviar)
            finally:
                self._fechar_pendentes(portal)

    def _executar_no_portal(
        self, portal: PortalTicket, sessao: Sessao, session_id: str, serial: str, formulario: Formulario, enviar: bool,
    ) -> dict[str, Any]:
        # The adapter re-checks the tab, header and every field inside its contingency (route guard + final re-read).
        portal.preencher(serial, sessao.modelo, sessao.aba, sessao.cep, formulario)
        with self._lock:
            self._sessao(session_id, serial)
        if not enviar:
            return {"status": "preenchido", "serial": serial}
        historico: list[dict[str, Any]] = []
        registro: dict[str, Any] = {}
        liberado: list[bool] = []  # set only once "incerto" is on disk and the session is gone

        def antes_do_clique() -> None:
            """Called by the adapter right before Finalizar, after its final re-read passed."""
            with self._lock:
                self._sessao(session_id, serial)
                historico[:] = self._historico()
                incerto = self._ultimo(historico, serial, "incerto")
                if incerto and not incerto.get("conferido_em"):
                    raise ErroUX(409, INCERTO, codigo="envio_incerto")
                registro.update(serie=serial, data=datetime.now().astimezone().isoformat(), ticket=None, estado="incerto")
                # Persist before the click, so an interrupted process cannot silently allow a retry.
                historico.append(registro)
                atomic_write_json(self._history, historico)
                del self._sessoes[session_id]
                liberado.append(True)

        try:
            ticket = portal.enviar(sessao.aba, antes_do_clique)
            if not re.fullmatch(r"[0-9]{1,24}", ticket):
                raise ValueError()
            registro.update(ticket=ticket, estado="enviado")
            atomic_write_json(self._history, historico)
        except Exception:
            if not liberado:
                raise  # failed before the click: nothing was sent, the session stays for a new try
            return {"status": "incerto", "serial": serial, "mensagem": INCERTO}
        finally:
            if liberado:
                self._fechar(portal, sessao.aba)  # the session is over, whatever the outcome; never clicks again
        return {"status": "enviado", "serial": serial, "ticket": ticket}
