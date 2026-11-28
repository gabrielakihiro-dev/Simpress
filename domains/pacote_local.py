"""Pacote local: exporta e restaura, num .zip nesta máquina, configurações, históricos e planilhas atuais.

Só entram os arquivos de ``ALLOWLIST`` e os de dentro de ``PASTAS`` (``FORA`` diz o que fica de fora e por quê). O
destino de cada arquivo é a base mais um caminho conferido contra a allowlist ou o prefixo de uma das pastas. Nas pastas,
restaurar só cria o que falta: nunca substitui nem apaga (outros estados apontam para esses arquivos). Restaurar só por
clique (``confirmado: true``) e sempre cria antes um pacote de desfazer do estado atual. O log leva só ação, contagens,
sha256 do pacote e o tipo do erro: nunca conteúdo nem pasta.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
import zipfile
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, FrozenSet, List, Optional
from urllib.parse import urlsplit

from core import config
from core.config import BASE_DIR, STATE_DIR, format_size_limit
from core.errors import DomainBusyError, DomainError
from core.integrity import (
    FileBusyError, TransactionConflictError, WorkbookSafetyError, _fsync_directory, atomic_write_bytes, lock_paths,
)
from core.local_paths import is_link_or_junction
from core.xlsx_safety import validate_xlsx_archive
from domains.configuracao_local import _CONTRATO, CONTAS, LINKS, validar_valor
from domains.history_annotations import _validated_annotation_record
from domains.history_restore import sha256_file
from domains.local_setup import cnpj_valido
from domains.sebrae_finalizacao import validar_numero, validar_pdf
from domains.user_holds import holds_file

logger = logging.getLogger(__name__)


def _rel(path: Path) -> str:
    return path.relative_to(BASE_DIR).as_posix()


ALLOWLIST: tuple[str, ...] = tuple(_rel(path) for path in (
    config.CLIENT_CONFIG_FILE,
    config.AUTOMATION_ACCOUNTS_FILE,
    config.TRANSFER_ORIGIN_CONTACT_FILE,
    config.REGIONAL_REPRESENTATIVES_FILE,
    config.DETAILS_UPLOAD_FILE,
    config.ENDPOINT_UPLOAD_FILE,
    config.TEMPLATE_FILE,
    config.INPUT_DIR / "_modelos" / "transferencia.xlsx",  # modelo importado; vence TEMPLATE_FILE
    config.EXPORT_MODEL_FILE,
    config.CUSTOM_UNIDADES_FILE,
    config.MODIFIED_APELIDOS_FILE,
    config.MANUAL_USERS_FILE,
    holds_file(config.MANUAL_USERS_FILE),  # decisões pendentes de usuário, par de usuarios_manuais.json
    config.ENTRA_USERS_FILE,
    config.MANUAL_PERSON_NAMES_FILE,
    config.REMOVED_ENDPOINT_HOSTNAMES_FILE,
    config.ALIAS_HISTORY_FILE,
    config.COMPARISON_HISTORY_FILE,
    config.TICKET_REPORT_FILE,
    config.TRANSFER_HISTORY_FILE,
    config.COVERAGE_FILE,
    config.COVERAGE_ARCHIVE_FILE,
    config.BACKUPS_REGIONAIS_FILE,
    config.ASSISTANT_INSTRUCTIONS_FILE,
    config.ASSISTANT_NOTES_FILE,
    config.ASSISTANT_WEB_SEARCH_FILE,
    config.REGIONAL_REPRESENTATIVE_DEFAULTS_FILE,
    config.OUTLOOK_MODELO_CABO_DEFAULTS_FILE,
    # Sem constante em core/config.py: os mesmos nomes que main.py e os domínios usam.
    STATE_DIR / "ux_solicitante.json",
    STATE_DIR / "os_observacoes.json",
    STATE_DIR / "os_chamados_vinculos.json",
    STATE_DIR / "powershell_codigos.json",
    STATE_DIR / "lembretes.json",
    STATE_DIR / "sebrae_observacoes.json",
    STATE_DIR / "sebrae_chamados_encerrados.json",
))

_ANEXOS = _rel(STATE_DIR / "sebrae_anexos")  # PDFs dos chamados; sebrae_finalizacao.json aponta para eles
_ANOTACOES = _rel(config.LOCAL_HISTORY_ANNOTATION_OUTBOX_DIR)  # anotações ainda não publicadas
# Pastas que entram inteiras (recursivo): rótulo usado em erro no lugar do nome do arquivo (LGPD) e extensão aceita.
_ROTULOS_PASTA: Dict[str, str] = {_ANEXOS: "anexo do Sebrae", _ANOTACOES: "anotação do histórico"}
_EXTENSAO_PASTA: Dict[str, str] = {_ANEXOS: ".pdf", _ANOTACOES: ".json"}
PASTAS: tuple[str, ...] = tuple(_ROTULOS_PASTA)

FORA: tuple[str, ...] = (
    ".env",  # chaves de IA
    "config/pacote_local.json",  # aponta a pasta do próprio pacote
    "data/state/config_backups",  # cópias antigas de contas
    "data/state/sebrae_credenciais.json",  # senha do chamado
    "%LOCALAPPDATA%",  # sessão do site
    "perfil do Chrome de automação",  # login, cookies e MFA do usuário
    ".transactions",  # diário de gravação em andamento
    ".atomic-transactions",  # trava global das transações
    # Marcas de cliques irreversíveis: restaurar uma versão antiga faria repetir envio ou finalização.
    "data/state/sebrae_chamados_estado.json",
    "data/state/sebrae_finalizacao.json",
    "data/state/sebrae_agendamento.json",
    "data/state/sebrae_fechar_*",
    "data/state/sebrae_dashboard_*",
    "data/state/ux_chamados_historico.json",
    "data/state/ux_tickets_historico.json",
    "data/state/os_marcas_finalizacao.json",
    "data/state/outlook_email_modelos.json",
    "data/state/sebrae_config.json",
    "data/state/sebrae_novos.json",
    "data/state/dashboard_agendamento.json",  # agenda envio ao SharePoint (sistema externo)
    # Demais estados do Sebrae: ligados ao SharePoint e ao SoftExpert do momento.
    "data/state/sebrae_historico.json",
    "data/state/sebrae_os_recusadas.json",
    "data/state/sebrae_excel_diario.json",
    "data/state/sebrae_categoria_indice.json",
    "data/state/sebrae_antigos_resultado.json",
    "data/state/sebrae_antigos_softexpert.json",
    "data/state/sebrae_backups",
    "data/state/endpoint_hostnames_atualizados.json",  # derivado: a próxima importação do InvAll o recria
    "data/state/inventory_update_idempotency.json",  # controle interno contra importação repetida
    "data/state/assinatura_tecnico.svg",  # a allowlist leva só .json e .xlsx
    # Travas: pertencem ao processo que as criou.
    "data/state/automacao_chrome.lock",
    "data/state/automacao_chrome.cancelar",
    "**/.*.lock",
    # Caixas de entrada: lotes em processamento, não estado.
    _rel(config.AUTOMATIC_INVENTORY_INBOX_DIR) if config.AUTOMATIC_INVENTORY_INBOX_DIR.is_relative_to(BASE_DIR)
    else "data/state/entrada_automatica",
    _rel(config.AUTOMATIC_TICKET_INBOX_DIR) if config.AUTOMATIC_TICKET_INBOX_DIR.is_relative_to(BASE_DIR)
    else "data/state/entrada_chamados",
    _rel(config.ENTRA_INBOX_DIR),
    "data/state/assistente_conversas.json",  # conversas do Assistente
    _rel(config.UPLOAD_BACKUPS_DIR),  # cópias de cada importação (grandes)
    _rel(config.MONTHLY_REPORTS_DIR),  # relatórios gerados de novo a pedido
    "anotacoes_historico",  # pasta compartilhada (OneDrive) das anotações
)

NOME_PACOTE = re.compile(r"^(pacote-local|desfazer)-(\d{8}-\d{6})\.zip$")
LIMITE_TOTAL = 300 * 1024 * 1024
LIMITE_ZIP = 300 * 1024 * 1024
LIMITE_MANIFESTO = 1024 * 1024
LIMITE_ENTRADAS = 5000
_BLOCO = 1024 * 1024
_PAPEIS = {_rel(config.DETAILS_UPLOAD_FILE): "detalhes", _rel(config.ENDPOINT_UPLOAD_FILE): "endpoint"}
_LINKS_E_CONTAS = {
    _rel(config.AUTOMATION_ACCOUNTS_FILE), _rel(config.CLIENT_CONFIG_FILE),
    _rel(config.REGIONAL_REPRESENTATIVES_FILE), _rel(config.REGIONAL_REPRESENTATIVE_DEFAULTS_FILE),
    _rel(config.ASSISTANT_INSTRUCTIONS_FILE),
}
_CHAVES_MANIFESTO = {"formato", "tipo", "versao_app", "criado_em", "arquivos", "ausentes", "invalidos"}
_CHAVES_ARQUIVO = {"caminho", "tamanho_bytes", "sha256"}
_RESERVADOS = {"con", "prn", "aux", "nul", *(f"com{n}" for n in range(1, 10)), *(f"lpt{n}" for n in range(1, 10))}
_SINCRONIZADAS_ENV = ("OneDrive", "OneDriveCommercial", "OneDriveConsumer")
_SINCRONIZADAS_NOMES = ("onedrive", "dropbox", "google drive", "icloud")
_WINDOWS = sys.platform == "win32"
_DRIVE_FIXO = 3
# STORAGE_BUS_TYPE de HD externo, cartão e disco de rede: 1394, USB, iSCSI, SD e MMC (o Windows informa HD USB como
# unidade fixa).
_BARRAMENTOS_REMOVIVEIS = {4, 7, 9, 12, 13}
_SHA256 = re.compile(r"[0-9a-f]{64}")
# Rótulos da prévia (``links_alterados``): só o nome do campo; host só para links, nunca login, e-mail ou valor.
_ROTULOS_ARQUIVO = {
    _rel(config.REGIONAL_REPRESENTATIVES_FILE): "Representantes regionais",
    _rel(config.REGIONAL_REPRESENTATIVE_DEFAULTS_FILE): "Representantes regionais (padrão)",
    _rel(config.ASSISTANT_INSTRUCTIONS_FILE): "Instruções do Assistente",
}
# Mesmos rótulos da tela de Dados do cliente (routers/local_setup.py e corpo.tsx).
_ROTULOS_CLIENTE = (
    ("contrato", "Contrato"), ("cnpj_faturamento", "CNPJ de faturamento"),
    ("series_sebrae_fora", "Séries dos notebooks do próprio cliente"),
)

MSG_PASTA_INEXISTENTE = "A pasta não existe ou não aceita escrita."
MSG_PASTA_REDE = "Use uma pasta deste computador (sem OneDrive, rede ou unidade removível)."
MSG_PASTA_PROIBIDA = "Pasta não permitida."
MSG_FALHA = "Falha ao restaurar. Os arquivos anteriores foram recuperados."
MSG_OCUPADOS = "Arquivos ocupados; tente de novo em instantes."
# Ligado durante a restauração: ChromeAutomationRunner recusa iniciar rotina (main.py injeta ``RESTAURANDO.is_set``).
RESTAURANDO = threading.Event()
MOTIVO_MANIFESTO = "manifesto ausente ou inválido"
MOTIVO_FORA = "arquivo fora da lista permitida"
MOTIVO_NAO_CONFERE = "arquivo não confere com o manifesto"
MOTIVO_CAMINHO = "caminho inválido no pacote"
MOTIVO_VERSAO = "pacote de uma versão mais nova do app"


@dataclass(frozen=True)
class PacoteLocalServices:
    base_dir: Callable[[], Path]
    arquivo_config: Callable[[], Path]
    app_version: str
    max_upload_bytes: int
    inventory_state_transaction: Callable[..., Any]
    load_database: Callable[..., Any]
    publish_database_state: Callable[[Any], None]
    validate_uploaded_workbook: Callable[[bytes, str], Any]
    automacao_em_andamento: Callable[[], bool]
    upload_admission: Callable[[], Any]
    # Gerenciadores de contexto que entregam True quando a caixa de entrada está livre (sem esperar).
    travas_importacao: Callable[[], List[Any]]
    transacao_pendente: Callable[[], bool]
    # Estado publicado quando a restauração deixa o app sem cadastro (o mesmo de um app recém-aberto sem planilhas).
    estado_vazio: Callable[[], Any]
    # Chamados do Sebrae em aberto e não finalizados (só os PDFs deles vão para a exportação); DomainBusyError se o
    # histórico de finalização estiver ilegível.
    chamados_sebrae_abertos: Callable[[], FrozenSet[str]]


def _recusa(motivo: str) -> DomainError:
    return DomainError(f"Pacote recusado: {motivo}", status_code=422)


def _recusa_restauracao(motivo: str) -> DomainError:
    return DomainError(f"Restauração recusada: {motivo}", status_code=409)


def _pasta_de(rel: str) -> Optional[str]:
    return next((pasta for pasta in PASTAS if rel.startswith(pasta + "/")), None)


def _rotulo(rel: str) -> str:
    """O caminho para item da allowlist; para pasta ou arquivo dela, só o rótulo (o nome pode trazer nome de pessoa)."""
    pasta = _pasta_de(rel) or (rel if rel in PASTAS else None)
    return _ROTULOS_PASTA[pasta] if pasta else rel


def _conteudo_invalido(rel: str) -> DomainError:
    nome = _rotulo(rel) if _pasta_de(rel) else PurePosixPath(rel).name  # só o nome, nunca o caminho
    return _recusa(f"conteúdo inválido em {nome}")


def _grande_demais(limite: int) -> DomainError:
    return _recusa(f"pacote grande demais (limite {format_size_limit(limite)})")


# --- Pasta do pacote ------------------------------------------------------------------------------------------------

def _raizes_sincronizadas() -> List[Path]:
    """Raízes do OneDrive: variáveis de ambiente e, no Windows, os pontos de montagem do OneDrive/SharePoint."""
    raizes = [os.environ.get(variavel, "").strip() for variavel in _SINCRONIZADAS_ENV]
    if sys.platform == "win32":
        import winreg

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\SyncEngines\Providers\OneDrive") as chave:
                for indice in range(winreg.QueryInfoKey(chave)[0]):
                    try:
                        with winreg.OpenKey(chave, winreg.EnumKey(chave, indice)) as conta:
                            raizes.append(str(winreg.QueryValueEx(conta, "MountPoint")[0]).strip())
                    except OSError:
                        continue
        except OSError:
            pass
    return [Path(raiz).resolve() for raiz in raizes if raiz and "\0" not in raiz]


def _tipo_de_unidade(anchor: str) -> int:
    import ctypes

    return int(ctypes.windll.kernel32.GetDriveTypeW(anchor))


def _tipo_de_barramento(anchor: str) -> Optional[int]:
    """STORAGE_BUS_TYPE do volume (IOCTL_STORAGE_QUERY_PROPERTY, StorageDeviceProperty); None se a consulta falhar."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.DeviceIoControl.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
    ]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    # Acesso 0 basta para consultar propriedades; compartilha leitura e escrita; OPEN_EXISTING.
    handle = kernel32.CreateFileW("\\\\.\\" + anchor.rstrip("\\/"), 0, 3, None, 3, 0, None)
    if handle in (None, ctypes.c_void_p(-1).value):
        return None
    try:
        consulta = (wintypes.DWORD * 3)(0, 0, 0)  # PropertyId=StorageDeviceProperty, QueryType=Standard
        saida = ctypes.create_string_buffer(1024)
        lidos = wintypes.DWORD()
        if not kernel32.DeviceIoControl(
            handle, 0x002D1400, ctypes.byref(consulta), ctypes.sizeof(consulta), saida, ctypes.sizeof(saida),
            ctypes.byref(lidos), None,
        ) or lidos.value < 32:
            return None
        return int.from_bytes(saida.raw[28:32], "little")  # STORAGE_DEVICE_DESCRIPTOR.BusType
    finally:
        kernel32.CloseHandle(handle)


def _unidade_removivel(anchor: str) -> bool:
    """Windows: rede, unidade removível ou volume em USB/1394/SD/MMC; consulta que falha conta como removível."""
    if _tipo_de_unidade(anchor) != _DRIVE_FIXO:
        return True
    barramento = _tipo_de_barramento(anchor)
    return barramento is None or barramento in _BARRAMENTOS_REMOVIVEIS


def validar_pasta(base: Path, texto: str) -> Path:
    """A pasta resolvida, ou DomainError 422 com uma das três mensagens de pasta."""
    erro = lambda mensagem: DomainError(mensagem, status_code=422)  # noqa: E731
    if any(ord(caractere) < 0x20 for caractere in texto):
        raise erro(MSG_PASTA_PROIBIDA)
    if texto.startswith(("\\\\", "//")):
        raise erro(MSG_PASTA_REDE)
    try:
        pasta = Path(texto)
        if not pasta.is_absolute():
            raise erro(MSG_PASTA_INEXISTENTE)
        atual = Path(pasta.anchor)
        for parte in pasta.parts[1:]:  # antes de resolver: resolve() esconde o link
            atual = atual / parte
            if is_link_or_junction(atual):
                raise erro(MSG_PASTA_PROIBIDA)
        if not pasta.is_dir():
            raise erro(MSG_PASTA_INEXISTENTE)
        # Nuvem, rede e repositório conferidos no caminho resolvido: ``..`` não contorna.
        resolvida = pasta.resolve()
        if str(resolvida).startswith(("\\\\", "//")):
            raise erro(MSG_PASTA_REDE)
        if any(nome in parte.casefold() for parte in resolvida.parts for nome in _SINCRONIZADAS_NOMES):
            raise erro(MSG_PASTA_REDE)
        if any(raiz == resolvida or raiz in resolvida.parents for raiz in _raizes_sincronizadas()):
            raise erro(MSG_PASTA_REDE)
        # Dentro do repositório o zip (com dado pessoal) poderia ir ao Git; só a pasta padrão é aceita.
        base = base.resolve()
        if (resolvida == base or base in resolvida.parents) and resolvida != (base / "data" / "pacotes_locais"):
            raise erro(MSG_PASTA_PROIBIDA)
        if _WINDOWS and _unidade_removivel(resolvida.anchor):
            raise erro(MSG_PASTA_REDE)
        descritor, teste = tempfile.mkstemp(prefix=".pacote-local-teste-", suffix=".tmp", dir=resolvida)
        os.close(descritor)
        os.unlink(teste)
    except (OSError, ValueError):
        raise erro(MSG_PASTA_INEXISTENTE) from None
    return resolvida


def _ler_config(services: PacoteLocalServices) -> Dict[str, Any]:
    """``config/pacote_local.json``: ``pasta`` e ``desfazer_conhecidos``. Ausente ou ilegível = vazio."""
    try:
        dado = json.loads(services.arquivo_config().read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return dado if isinstance(dado, dict) else {}


def _desfazer_conhecidos(dado: Dict[str, Any]) -> List[str]:
    """SHA-256 dos desfazer-*.zip criados por este app; só eles podem trazer arquivo ``invalidos``."""
    lista = dado.get("desfazer_conhecidos")
    return [item for item in lista if isinstance(item, str) and _SHA256.fullmatch(item)] if isinstance(lista, list) else []


def _config_bytes(pasta: Any, conhecidos: List[str]) -> bytes:
    return json.dumps(
        {"pasta": pasta if isinstance(pasta, str) else "", "desfazer_conhecidos": conhecidos}, ensure_ascii=False, indent=2,
    ).encode("utf-8")


def _pasta_configurada(services: PacoteLocalServices) -> tuple[str, bool]:
    """(texto da pasta, é a padrão). Arquivo ausente, ilegível ou vazio = padrão."""
    texto = _ler_config(services).get("pasta")
    if isinstance(texto, str) and texto.strip():
        return texto.strip(), False
    return str(services.base_dir() / "data" / "pacotes_locais"), True


def _pasta_em_uso(services: PacoteLocalServices) -> Path:
    texto, padrao = _pasta_configurada(services)
    if padrao:
        try:
            Path(texto).mkdir(parents=True, exist_ok=True)
        except (OSError, ValueError):
            pass  # validar_pasta responde com a mensagem certa
    return validar_pasta(services.base_dir(), texto)


def listar(services: PacoteLocalServices) -> Dict[str, Any]:
    texto, padrao = _pasta_configurada(services)
    resposta: Dict[str, Any] = {"pasta": texto, "pasta_padrao": padrao, "pacotes": [], "erro_pasta": None}
    try:
        pasta = _pasta_em_uso(services)
        with os.scandir(pasta) as entradas:
            for entrada in entradas:
                achado = NOME_PACOTE.fullmatch(entrada.name)
                if not achado or not entrada.is_file(follow_symlinks=False):
                    continue
                try:
                    criado = datetime.strptime(achado.group(2), "%Y%m%d-%H%M%S").astimezone()
                except ValueError:
                    continue
                resposta["pacotes"].append({
                    "arquivo": entrada.name,
                    "tipo": "exportacao" if achado.group(1) == "pacote-local" else "desfazer",
                    "criado_em": criado.isoformat(timespec="seconds"),
                    "tamanho_bytes": entrada.stat(follow_symlinks=False).st_size,
                })
    except DomainError as error:
        resposta["erro_pasta"] = error.detail
    except (OSError, ValueError):
        resposta["erro_pasta"] = MSG_PASTA_INEXISTENTE
    resposta["pacotes"].sort(key=lambda item: (item["criado_em"], item["arquivo"]), reverse=True)
    return resposta


def salvar_pasta(services: PacoteLocalServices, texto: str) -> Dict[str, Any]:
    texto = texto.strip()
    valor = str(validar_pasta(services.base_dir(), texto)) if texto else ""
    arquivo = services.arquivo_config()
    try:
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        with lock_paths([arquivo]):  # preserva o registro de desfazer
            atomic_write_bytes(arquivo, _config_bytes(valor, _desfazer_conhecidos(_ler_config(services))))
    except FileBusyError:
        raise DomainError(MSG_OCUPADOS, status_code=409) from None
    except OSError:
        raise DomainError("Não foi possível salvar a pasta; tente de novo.", status_code=503) from None
    logger.info("pacote_local: pasta gravada (padrao=%s)", not valor)
    return listar(services)


# --- Exportação -----------------------------------------------------------------------------------------------------

def _sem_atalho(base: Path, rel: str) -> Path:
    """``base / rel``; recusa atalho (link/junção) nele ou numa pasta entre ele e a base."""
    atual = base
    for parte in PurePosixPath(rel).parts:
        atual = atual / parte
        if is_link_or_junction(atual):
            raise DomainError(f"Arquivo do app é um atalho: {_rotulo(rel)}", status_code=422)
    return atual


def _alvo(base: Path, rel: str) -> Path:
    """Destino do item da allowlist ou de pasta; recusa atalho e o que não for arquivo comum."""
    atual = _sem_atalho(base, rel)
    if atual.exists() and not atual.is_file():
        raise DomainError(f"Arquivo do app não é um arquivo comum: {_rotulo(rel)}", status_code=422)
    return atual


def _permitido(rel: str) -> bool:
    """Item da allowlist, ou arquivo dentro de uma das PASTAS (prefixo exato) com a extensão dela, nome seguro e sem
    parte oculta."""
    if rel in ALLOWLIST:
        return True
    pasta = _pasta_de(rel)
    return (
        pasta is not None and rel.casefold().endswith(_EXTENSAO_PASTA[pasta]) and _nome_seguro(rel)
        and not any(parte.startswith(".") for parte in rel.split("/"))
    )


def _arquivos_das_pastas(base: Path) -> List[str]:
    """Arquivos atuais das PASTAS (rel POSIX, ordenados). Ignora link/junção, nome oculto (o ``.x.lock`` de lock_paths),
    nome que a validação do zip recusaria e o segundo nome igual em NFC sem maiúsculas; pasta inexistente = nenhum."""
    achados: List[str] = []
    vistos = set()
    for pasta in PASTAS:
        raiz = _sem_atalho(base, pasta)
        pendentes = [raiz]
        while pendentes:
            try:
                with os.scandir(pendentes.pop()) as entradas:
                    for entrada in entradas:
                        caminho = Path(entrada.path)
                        if entrada.name.startswith(".") or is_link_or_junction(caminho):
                            continue
                        if entrada.is_dir(follow_symlinks=False):
                            pendentes.append(caminho)
                        elif entrada.is_file(follow_symlinks=False):
                            rel = f"{pasta}/{caminho.relative_to(raiz).as_posix()}"
                            chave = unicodedata.normalize("NFC", rel).casefold()  # a validação do zip recusaria o par
                            if _permitido(rel) and chave not in vistos:
                                vistos.add(chave)
                                achados.append(rel)
            except (FileNotFoundError, NotADirectoryError):
                continue
            except OSError:
                raise DomainError(MSG_OCUPADOS, status_code=409) from None
    return sorted(achados)


def _sem_anexos_fechados(services: PacoteLocalServices, rels: List[str]) -> List[str]:
    """Na exportação, ``sebrae_anexos`` só leva PDF de chamado em aberto e não finalizado (``<numero>/...``). Histórico
    de finalização ilegível (ou outra falha ao ler os chamados): nenhum anexo vai, e o resto do pacote segue."""
    try:
        abertos = services.chamados_sebrae_abertos()
    except Exception as erro:  # noqa: BLE001 - um arquivo do Sebrae ruim não derruba o pacote inteiro
        motivo = "histórico de finalização ilegível" if isinstance(erro, DomainBusyError) else type(erro).__name__
        logger.warning("pacote_local: anexos do Sebrae fora (%s)", motivo)
        abertos = frozenset()

    def entra(rel: str) -> bool:
        if _pasta_de(rel) != _ANEXOS:
            return True
        try:
            return validar_numero(rel[len(_ANEXOS) + 1:].split("/")[0]) in abertos
        except DomainError:
            return False

    return [rel for rel in rels if entra(rel)]


def _rels_do_pacote(manifesto: Dict[str, Any]) -> List[str]:
    """ALLOWLIST mais os caminhos de pasta que o pacote traz: prévia e restauração olham só eles (arquivo de pasta fora do
    pacote nunca muda, não aparece na prévia nem mexe no token)."""
    return [*ALLOWLIST, *(item["caminho"] for item in manifesto["arquivos"] if _pasta_de(item["caminho"]))]


def _hashes_atuais(base: Path, rels: List[str]) -> Dict[str, Optional[str]]:
    hashes: Dict[str, Optional[str]] = {}
    for rel in rels:
        alvo = _alvo(base, rel)
        try:
            hashes[rel] = sha256_file(alvo) if alvo.is_file() else None
        except OSError:  # aberto por outro programa (Excel) ou sem permissão
            raise DomainError(MSG_OCUPADOS, status_code=409) from None
    return hashes


def _gravar_pacote(services: PacoteLocalServices, pasta: Path, tipo: str, rels: List[str]) -> Dict[str, Any]:
    """Grava o zip do estado atual de ``rels``; quem chama segura as travas da allowlist. Arquivo de pasta é lido sem
    trava (cada versão é imutável) e, se sumir entre listar e ler, só fica de fora."""
    if len(rels) + 1 > LIMITE_ENTRADAS:
        raise DomainError(f"Arquivos demais para o pacote (limite {LIMITE_ENTRADAS}).", status_code=422)
    base = services.base_dir()
    prefixo = "pacote-local" if tipo == "exportacao" else "desfazer"
    agora = datetime.now().astimezone()
    if (pasta / f"{prefixo}-{agora:%Y%m%d-%H%M%S}.zip").exists():
        time.sleep(1.0)  # dois pacotes no mesmo segundo: espera o próximo nome em vez de sobrescrever
        agora = datetime.now().astimezone()
    nome = f"{prefixo}-{agora:%Y%m%d-%H%M%S}.zip"
    arquivos: List[Dict[str, Any]] = []
    ausentes: List[str] = []
    invalidos: List[str] = []
    conteudo: Dict[str, bytes] = {}
    total = 0
    for rel in rels:
        alvo = _alvo(base, rel)
        de_pasta = _pasta_de(rel) is not None
        if not alvo.is_file():
            if not de_pasta:  # arquivo de pasta ausente nunca vai para ausentes
                ausentes.append(rel)
            continue
        try:
            if alvo.stat().st_size > services.max_upload_bytes:
                raise DomainError(
                    f"{_rotulo(rel)} passa do limite de {format_size_limit(services.max_upload_bytes)}.", status_code=422,
                )
            dados = alvo.read_bytes()
        except (FileNotFoundError, NotADirectoryError):
            if de_pasta:  # removido entre listar e ler
                continue
            raise DomainError(MSG_OCUPADOS, status_code=409) from None
        except OSError:
            raise DomainError(MSG_OCUPADOS, status_code=409) from None
        total += len(dados)
        if total > LIMITE_TOTAL:
            raise DomainError(f"Os arquivos passam do limite de {format_size_limit(LIMITE_TOTAL)}.", status_code=422)
        arquivos.append({"caminho": rel, "tamanho_bytes": len(dados), "sha256": hashlib.sha256(dados).hexdigest()})
        conteudo[rel] = dados
        if not _conteudo_valido(services, rel, dados):
            if tipo == "exportacao":  # exportar segue bloqueado; o desfazer guarda o arquivo como está
                raise _conteudo_invalido(rel)
            invalidos.append(rel)
    manifesto = {
        "formato": 1, "tipo": tipo, "versao_app": services.app_version,
        "criado_em": agora.isoformat(timespec="seconds"), "arquivos": arquivos, "ausentes": ausentes,
        "invalidos": invalidos,
    }
    # Montado em memória: o SHA-256 e a conferência usam estes bytes, nunca uma releitura da pasta.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as pacote:
        pacote.writestr("manifesto.json", json.dumps(manifesto, ensure_ascii=False, indent=2))
        for rel, dados in conteudo.items():
            pacote.writestr(rel, dados)
    zip_bytes = buffer.getvalue()
    final = pasta / nome
    try:
        descritor, temporario = tempfile.mkstemp(prefix=".pacote-local-", suffix=".tmp", dir=pasta)
    except OSError:
        raise DomainError(MSG_PASTA_INEXISTENTE, status_code=422) from None
    try:
        with os.fdopen(descritor, "wb") as saida:
            saida.write(zip_bytes)
            saida.flush()
            os.fsync(saida.fileno())
        try:  # reserva o nome: os.replace sozinho sobrescreveria um pacote existente
            os.close(os.open(final, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            raise DomainError(
                "Já existe um pacote com este nome; tente de novo em instantes.", status_code=409,
            ) from None
        try:
            os.replace(temporario, final)
        except BaseException:
            final.unlink(missing_ok=True)
            raise
        _fsync_directory(pasta)
    except OSError:
        raise DomainError(MSG_PASTA_INEXISTENTE, status_code=422) from None
    finally:
        try:
            os.unlink(temporario)
        except FileNotFoundError:
            pass
    return {
        "arquivo": nome, "tamanho_bytes": len(zip_bytes), "arquivos": len(arquivos),
        "ausentes": len(ausentes), "criado_em": manifesto["criado_em"], "dados": zip_bytes,
    }


def exportar(services: PacoteLocalServices) -> Dict[str, Any]:
    pasta = _pasta_em_uso(services)
    base = services.base_dir()
    rels = [*ALLOWLIST, *_sem_anexos_fechados(services, _arquivos_das_pastas(base))]
    try:
        # Trava só a allowlist (leitura coerente; uma chamada só): travar os arquivos de pasta recriaria pasta de versão
        # apagada e seguraria o arquivo contra a remoção do PDF.
        with lock_paths([base / rel for rel in ALLOWLIST]):
            resultado = _gravar_pacote(services, pasta, "exportacao", rels)
    except (FileBusyError, OSError):
        raise DomainError(MSG_OCUPADOS, status_code=409) from None
    try:  # o pacote só fica na pasta se a prévia e a restauração o aceitarem
        _validar_bytes(services, resultado["dados"], resultado["arquivo"])
    except DomainError:
        (pasta / resultado["arquivo"]).unlink(missing_ok=True)
        raise
    logger.info("pacote_local: exportado (arquivos=%d, ausentes=%d)", resultado["arquivos"], resultado["ausentes"])
    return {chave: valor for chave, valor in resultado.items() if chave != "dados"}


# --- Validação do zip (prévia, restauração e conferência do desfazer) -----------------------------------------------

def _nome_seguro(nome: str) -> bool:
    if not nome or "\\" in nome or ":" in nome or nome.startswith("/") or any(ord(c) < 0x20 for c in nome):
        return False
    return all(
        parte not in ("", ".", "..") and parte[-1] not in ". " and parte.split(".")[0].casefold() not in _RESERVADOS
        for parte in nome.split("/")
    )


def _manifesto_valido(dados: bytes) -> Optional[Dict[str, Any]]:
    try:
        manifesto = json.loads(dados.decode("utf-8"))
        if not isinstance(manifesto, dict) or set(manifesto) != _CHAVES_MANIFESTO:
            return None
        arquivos, ausentes = manifesto["arquivos"], manifesto["ausentes"]
        criado_em = manifesto["criado_em"]
        if (
            type(manifesto["formato"]) is not int or manifesto["formato"] != 1
            or manifesto["tipo"] not in ("exportacao", "desfazer")
            or not isinstance(manifesto["versao_app"], str)
            or not re.fullmatch(r"\d{1,6}(\.\d{1,6}){0,3}", manifesto["versao_app"])
            or not isinstance(criado_em, str) or datetime.fromisoformat(criado_em).tzinfo is None
            or not isinstance(arquivos, list) or not isinstance(ausentes, list)
            or any(not isinstance(item, str) for item in ausentes)
            or not isinstance(manifesto["invalidos"], list) or any(not isinstance(item, str) for item in manifesto["invalidos"])
            or (manifesto["tipo"] == "exportacao" and manifesto["invalidos"])
        ):
            return None
        for item in arquivos:
            if (
                not isinstance(item, dict) or set(item) != _CHAVES_ARQUIVO or not isinstance(item["caminho"], str)
                or type(item["tamanho_bytes"]) is not int or item["tamanho_bytes"] < 0
                or not isinstance(item["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
            ):
                return None
    except (UnicodeError, ValueError, TypeError):
        return None
    caminhos = [item["caminho"] for item in arquivos]
    invalidos = manifesto["invalidos"]
    if len(set(caminhos)) != len(caminhos) or len(set(ausentes)) != len(ausentes) or set(caminhos) & set(ausentes):
        return None
    if len(set(invalidos)) != len(invalidos) or not set(invalidos) <= set(caminhos):
        return None
    return manifesto


def _ler(pacote: zipfile.ZipFile, info: zipfile.ZipInfo, limite: int) -> Optional[bytes]:
    """Conteúdo descompactado contando bytes reais; None se passar de ``limite``."""
    partes: List[bytes] = []
    lidos = 0
    with pacote.open(info) as entrada:
        while bloco := entrada.read(_BLOCO):
            lidos += len(bloco)
            if lidos > limite:
                return None
            partes.append(bloco)
    return b"".join(partes)


def _json_valido(rel: str, valor: Any) -> bool:
    if rel == _rel(config.AUTOMATION_ACCOUNTS_FILE):
        if not isinstance(valor, dict):
            return False
        regras = [(chave, conta["tipo"]) for conta in CONTAS for chave, _ in conta["chaves"]]
        regras += [(conta["outlook"][0], "email") for conta in CONTAS if conta["outlook"]]
        regras += [(link["chave"], "link") for link in LINKS]
        for chave, tipo in regras:
            campo = valor.get(chave)
            if campo is None:
                continue
            if not isinstance(campo, str) or (campo.strip() and validar_valor(tipo, campo.strip())):
                return False
    elif rel == _rel(config.CLIENT_CONFIG_FILE):
        if not isinstance(valor, dict):
            return False
        contrato, cnpj = valor.get("contrato", ""), valor.get("cnpj_faturamento", "")
        if not isinstance(contrato, str) or not isinstance(cnpj, str):
            return False
        if contrato.strip() and not _CONTRATO.fullmatch(contrato.strip()):
            return False
        if cnpj.strip() and not cnpj_valido(cnpj.strip()):
            return False
        if not isinstance(valor.get("series_sebrae_fora", []), list):
            return False
    elif rel == _rel(config.TICKET_REPORT_FILE):
        # Mesma checagem de check_startup_ticket_report (domains/readiness.py).
        return isinstance(valor, dict) and isinstance(valor.get("chamados"), list)
    return True


def _conteudo_valido(services: PacoteLocalServices, rel: str, dados: bytes) -> bool:
    try:
        if _pasta_de(rel) == _ANEXOS:  # mesma conferência do PDF anexado ao chamado (nome que o app geraria)
            nome = PurePosixPath(rel).name
            return validar_pdf(nome, dados) == nome
        if _pasta_de(rel) == _ANOTACOES:  # mesmo registro que a sincronização publica
            return _validated_annotation_record(json.loads(dados.decode("utf-8"))) is not None
        if rel.endswith(".json"):
            return _json_valido(rel, json.loads(dados.decode("utf-8-sig")))
        with zipfile.ZipFile(io.BytesIO(dados)) as planilha:
            validate_xlsx_archive(planilha)
            if any("vbaproject" in nome.lower() for nome in planilha.namelist()):  # planilha com macro
                return False
        if rel in _PAPEIS:
            services.validate_uploaded_workbook(dados, _PAPEIS[rel])
        return True
    except Exception:  # qualquer falha de leitura ou validação de dado não confiável = conteúdo inválido
        return False


def validar_pacote(
    services: PacoteLocalServices, caminho: Path, confiaveis: FrozenSet[str] = frozenset(),
) -> Dict[str, Any]:
    """Confere o zip inteiro sem gravar nada: {"manifesto", "conteudo": {rel: bytes}, "sha256"}.

    Arquivo listado em ``invalidos`` só passa sem validar o conteúdo se o SHA-256 do zip estiver no registro de
    desfazer criados por este app (ou em ``confiaveis``, o desfazer recém-gravado); senão o manifesto é recusado.

    O zip é lido uma vez só: o SHA-256 e a validação usam os mesmos bytes (o arquivo pode mudar no disco).

    shortcut: zip e conteúdo ficam em memória ao mesmo tempo (pico de até 600 MB no limite de 300 MB); trocar por
    cópia privada em disco se os pacotes crescerem.
    """
    if is_link_or_junction(caminho) or not caminho.is_file():
        raise _recusa(MOTIVO_CAMINHO)
    try:
        with caminho.open("rb") as entrada:
            dados = entrada.read(LIMITE_ZIP + 1)
    except OSError:
        raise DomainError("Não foi possível ler o pacote; tente de novo.", status_code=503) from None
    return _validar_bytes(services, dados, caminho.name, confiaveis)


def _validar_bytes(
    services: PacoteLocalServices, dados: bytes, nome: str, confiaveis: FrozenSet[str] = frozenset(),
) -> Dict[str, Any]:
    """``validar_pacote`` sobre bytes já lidos (zip na pasta ou recém-montado em memória)."""
    if len(dados) > LIMITE_ZIP:
        raise _grande_demais(LIMITE_ZIP)
    sha256 = hashlib.sha256(dados).hexdigest()
    try:
        pacote = zipfile.ZipFile(io.BytesIO(dados))
    except (zipfile.BadZipFile, ValueError):
        raise _recusa(MOTIVO_MANIFESTO) from None
    conhecido = sha256 in {*_desfazer_conhecidos(_ler_config(services)), *confiaveis}
    with pacote:
        manifesto, conteudo = _validar_entradas(services, pacote, conhecido)
    achado = NOME_PACOTE.fullmatch(nome)
    if achado and (achado.group(1) == "desfazer") != (manifesto["tipo"] == "desfazer"):
        raise _recusa(MOTIVO_MANIFESTO)  # o tipo do manifesto precisa bater com o prefixo do nome
    return {"manifesto": manifesto, "conteudo": conteudo, "sha256": sha256}


def _validar_entradas(
    services: PacoteLocalServices, pacote: zipfile.ZipFile, conhecido: bool,
) -> tuple[Dict[str, Any], Dict[str, bytes]]:
    infos = pacote.infolist()
    if len(infos) > LIMITE_ENTRADAS:
        raise _recusa(MOTIVO_FORA)
    vistos = set()
    for info in infos:
        if (
            info.flag_bits & 1 or info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000
            or not _nome_seguro(info.filename)
        ):
            raise _recusa(MOTIVO_CAMINHO)
        chave = unicodedata.normalize("NFC", info.filename).casefold()
        if chave in vistos:
            raise _recusa(MOTIVO_CAMINHO)
        vistos.add(chave)

    por_nome = {info.filename: info for info in infos}
    info_manifesto = por_nome.pop("manifesto.json", None)
    if info_manifesto is None or info_manifesto.file_size > LIMITE_MANIFESTO:
        raise _recusa(MOTIVO_MANIFESTO)
    try:
        dados_manifesto = _ler(pacote, info_manifesto, LIMITE_MANIFESTO)
    except Exception:  # zip corrompido ou método de compressão estranho
        dados_manifesto = None
    manifesto = _manifesto_valido(dados_manifesto) if dados_manifesto is not None else None
    if manifesto is None:
        raise _recusa(MOTIVO_MANIFESTO)

    versao = lambda texto: tuple(int(parte) for parte in texto.split("."))  # noqa: E731
    if versao(manifesto["versao_app"]) > versao(services.app_version):
        raise _recusa(MOTIVO_VERSAO)

    declarados = {item["caminho"]: item for item in manifesto["arquivos"]}
    if (
        any(not _permitido(rel) for rel in (*por_nome, *declarados))
        or any(rel not in ALLOWLIST for rel in manifesto["ausentes"])  # pasta nunca tem ausentes
    ):
        raise _recusa(MOTIVO_FORA)
    invalidos = set(manifesto["invalidos"])
    if invalidos and not conhecido:  # desfazer forjado não pula a validação de conteúdo
        raise _recusa(MOTIVO_MANIFESTO)
    if set(por_nome) != set(declarados):
        raise _recusa(MOTIVO_NAO_CONFERE)
    if any(item["tamanho_bytes"] > services.max_upload_bytes for item in declarados.values()):
        raise _grande_demais(services.max_upload_bytes)
    if sum(item["tamanho_bytes"] for item in declarados.values()) > LIMITE_TOTAL:
        raise _grande_demais(LIMITE_TOTAL)

    conteudo: Dict[str, bytes] = {}
    for rel, item in declarados.items():
        info = por_nome[rel]
        try:
            dados = _ler(pacote, info, item["tamanho_bytes"])
        except Exception:  # CRC, zlib ou compressão não suportada
            dados = None
        if dados is None or len(dados) != item["tamanho_bytes"] or hashlib.sha256(dados).hexdigest() != item["sha256"]:
            raise _recusa(MOTIVO_NAO_CONFERE)
        if rel not in invalidos and not _conteudo_valido(services, rel, dados):
            raise _conteudo_invalido(rel)
        conteudo[rel] = dados
    return manifesto, conteudo


# --- Prévia e restauração -------------------------------------------------------------------------------------------

def _caminho_pacote(pasta: Path, arquivo: str) -> Path:
    caminho = pasta / arquivo
    if not NOME_PACOTE.fullmatch(arquivo) or is_link_or_junction(caminho) or not caminho.is_file():
        raise DomainError("Pacote não encontrado na pasta.", status_code=404)
    return caminho


def _acoes(manifesto: Dict[str, Any], atuais: Dict[str, Optional[str]]) -> List[tuple[str, str]]:
    """``atuais`` vem de ``_hashes_atuais(base, _rels_do_pacote(manifesto))``: allowlist e caminhos de pasta do pacote."""
    no_pacote = {item["caminho"]: item["sha256"] for item in manifesto["arquivos"]}
    apagar = set(manifesto["ausentes"]) if manifesto["tipo"] == "desfazer" else set()
    acoes = []
    for rel, atual in atuais.items():
        if _pasta_de(rel):
            # Pasta: só cria o que falta; o atual vence e nunca é apagado (sebrae_finalizacao.json aponta os anexos).
            if atual is None:
                if rel in no_pacote:
                    acoes.append((rel, "criar"))
            else:
                acoes.append((rel, "igual" if no_pacote.get(rel) == atual else "manter"))
        elif rel in no_pacote:
            acoes.append((rel, "criar" if atual is None else "igual" if atual == no_pacote[rel] else "substituir"))
        elif atual is not None:
            acoes.append((rel, "apagar" if rel in apagar else "manter"))
    return acoes


def _token(sha256_pacote: str, atuais: Dict[str, Optional[str]]) -> str:
    material = {"pacote": sha256_pacote, "atuais": atuais}
    return hashlib.sha256(
        json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _totais(acoes: List[tuple[str, str]]) -> Dict[str, int]:
    totais = dict.fromkeys(("substituir", "criar", "igual", "manter", "apagar"), 0)
    for _, acao in acoes:
        totais[acao] += 1
    return totais


def _host(valor: Any) -> Optional[str]:
    """Só o domínio do link (sem esquema, porta, caminho, query, usuário ou token); vazio ou inválido = None."""
    if not isinstance(valor, str) or not valor.strip():
        return None
    try:
        # O Chrome lê ``\`` como ``/``: sem isso, ``https://a.com\@b.com`` mostraria b.com e abriria a.com.
        return urlsplit(valor.strip().replace("\\", "/")).hostname or None
    except ValueError:
        return None


def _json_ou_vazio(dados: Optional[bytes]) -> Dict[str, Any]:
    try:
        valor = json.loads(dados.decode("utf-8-sig")) if dados is not None else {}
    except (UnicodeError, ValueError):
        return {}
    return valor if isinstance(valor, dict) else {}


def _links_alterados(base: Path, conteudo: Dict[str, bytes], acoes: List[tuple[str, str]]) -> List[Dict[str, Any]]:
    """O que muda em links, contas, cliente, representantes e instruções do Assistente, sem valor pessoal."""
    itens: List[Dict[str, Any]] = []
    vazio = lambda rotulo: {"rotulo": rotulo, "antes": None, "depois": None}  # noqa: E731
    for rel, acao in acoes:
        if rel not in _LINKS_E_CONTAS or acao not in ("substituir", "criar"):
            continue
        if rel in _ROTULOS_ARQUIVO:
            itens.append(vazio(_ROTULOS_ARQUIVO[rel]))
            continue
        try:
            atual = (base / rel).read_bytes() if acao == "substituir" else None
        except OSError:
            atual = None
        antes, depois = _json_ou_vazio(atual), _json_ou_vazio(conteudo[rel])
        if rel == _rel(config.AUTOMATION_ACCOUNTS_FILE):
            for link in LINKS:
                chave = link["chave"]
                if antes.get(chave) != depois.get(chave):
                    itens.append({"rotulo": link["rotulo"], "antes": _host(antes.get(chave)), "depois": _host(depois.get(chave))})
            for conta in CONTAS:
                chaves = [chave for chave, _ in conta["chaves"]] + ([conta["outlook"][0]] if conta["outlook"] else [])
                if any(antes.get(chave) != depois.get(chave) for chave in chaves):
                    itens.append(vazio(conta["rotulo"]))
        else:  # config/cliente.json
            itens += [vazio(rotulo) for chave, rotulo in _ROTULOS_CLIENTE if antes.get(chave) != depois.get(chave)]
    return itens


def previa(services: PacoteLocalServices, arquivo: str) -> Dict[str, Any]:
    caminho = _caminho_pacote(_pasta_em_uso(services), arquivo)
    pacote = validar_pacote(services, caminho)
    base = services.base_dir()
    atuais = _hashes_atuais(base, _rels_do_pacote(pacote["manifesto"]))
    acoes = _acoes(pacote["manifesto"], atuais)
    return {
        "arquivo": arquivo,
        "tipo": pacote["manifesto"]["tipo"],
        "versao_app": pacote["manifesto"]["versao_app"],
        "criado_em": pacote["manifesto"]["criado_em"],
        "itens": [{"caminho": rel, "acao": acao} for rel, acao in acoes],
        "totais": _totais(acoes),
        "muda_links": any(rel in _LINKS_E_CONTAS and acao in ("substituir", "criar") for rel, acao in acoes),
        "links_alterados": _links_alterados(services.base_dir(), pacote["conteudo"], acoes),
        "invalidos": [PurePosixPath(rel).name for rel in pacote["manifesto"]["invalidos"]],
        "preview_token": _token(pacote["sha256"], atuais),
    }


def _conferir_preparado(esperado: bytes) -> Callable[[Path], None]:
    def conferir(temporario: Path) -> None:
        if temporario.read_bytes() != esperado:
            raise WorkbookSafetyError("O arquivo preparado difere do pacote validado.")
    return conferir


def restaurar(services: PacoteLocalServices, arquivo: str, preview_token: str, confirmado: bool) -> Dict[str, Any]:
    if confirmado is not True:
        raise DomainError("Confirme a restauração para continuar.", status_code=422)
    pasta = _pasta_em_uso(services)
    caminho = _caminho_pacote(pasta, arquivo)
    base = services.base_dir()
    with ExitStack() as guardas:
        admissao = services.upload_admission()
        if not admissao.acquire(blocking=False):
            raise _recusa_restauracao("uma importação está em andamento")
        guardas.callback(admissao.release)
        # Liga antes de olhar a automação: uma rotina que comece depois disso é recusada pelo próprio runner.
        RESTAURANDO.set()
        guardas.callback(RESTAURANDO.clear)
        for trava in services.travas_importacao():
            if not guardas.enter_context(trava):
                raise _recusa_restauracao("uma importação está em andamento")
        if services.automacao_em_andamento():
            raise _recusa_restauracao("uma automação está em execução")
        if services.transacao_pendente():
            raise _recusa_restauracao("há uma gravação pendente para conferir em .transactions")

        pacote = validar_pacote(services, caminho)
        rels = _rels_do_pacote(pacote["manifesto"])
        atuais = _hashes_atuais(base, rels)
        if not hmac.compare_digest(preview_token, _token(pacote["sha256"], atuais)):
            raise _recusa_restauracao("o estado mudou desde a prévia; abra a prévia de novo")
        acoes = _acoes(pacote["manifesto"], atuais)
        totais = _totais(acoes)
        if not (totais["substituir"] or totais["criar"] or totais["apagar"]):
            raise DomainError("Este pacote já corresponde ao estado atual.", status_code=409)

        erro_interno: Optional[BaseException] = None
        gravado = False
        desfazer: Optional[Dict[str, Any]] = None
        try:
            criar_em_pasta = [base / rel for rel, acao in acoes if acao == "criar" and _pasta_de(rel)]
            alvos = [*(base / rel for rel in ALLOWLIST), *criar_em_pasta, services.arquivo_config()]
            with services.inventory_state_transaction(alvos) as transacao:
                try:
                    if _hashes_atuais(base, rels) != atuais:
                        raise _recusa_restauracao("o estado mudou desde a prévia; abra a prévia de novo")
                    # Só a allowlist: nada de pasta é trocado nem apagado, então o desfazer não precisa dela.
                    desfazer = _gravar_pacote(services, pasta, "desfazer", list(ALLOWLIST))
                    try:
                        sha_desfazer = hashlib.sha256(desfazer["dados"]).hexdigest()
                        _validar_bytes(services, desfazer["dados"], desfazer["arquivo"], frozenset({sha_desfazer}))
                    except DomainError as error:
                        (pasta / desfazer["arquivo"]).unlink(missing_ok=True)
                        raise _recusa_restauracao(
                            f"o pacote de desfazer do estado atual não passou na conferência ({error.detail})"
                        ) from None
                    # Registro do desfazer na mesma transação: se a restauração voltar atrás, ele volta junto.
                    registro = _ler_config(services)
                    transacao.stage_bytes(
                        services.arquivo_config(),
                        _config_bytes(registro.get("pasta"), [*_desfazer_conhecidos(registro), sha_desfazer]),
                        lambda temporario: json.loads(temporario.read_text(encoding="utf-8")),
                    )
                    for rel, acao in acoes:
                        if acao in ("criar", "substituir"):
                            dados = pacote["conteudo"][rel]
                            transacao.stage_bytes(base / rel, dados, _conferir_preparado(dados))
                        elif acao == "apagar":
                            transacao.stage_delete(base / rel)
                    if services.automacao_em_andamento():  # rotina iniciada fora do site durante a preparação
                        raise _recusa_restauracao("uma automação está em execução")
                    transacao.apply()
                    estado = services.load_database(transaction_locked=True, publish=False)
                    if not isinstance(estado, dict):
                        # Sem cadastro, ou desfazer que devolve o cadastro ou o InvAll já inválidos antes: o site fica sem
                        # equipamentos, como estava antes da restauração original. Fora isso, volta atrás.
                        planilhas_invalidas = set(pacote["manifesto"]["invalidos"]) & set(_PAPEIS)
                        if (base / _rel(config.DETAILS_UPLOAD_FILE)).is_file() and not planilhas_invalidas:
                            raise RuntimeError("O conjunto restaurado não pôde ser carregado pelo site.")
                        estado = services.estado_vazio()
                    transacao.commit()
                    gravado = True
                    services.publish_database_state(estado)  # dentro da transação, como history_restore
                except BaseException as error:
                    erro_interno = error
                    raise
        except Exception as error:
            if gravado:
                _falhou(pacote["sha256"], error)
                raise DomainError(
                    "A restauração foi gravada, mas o site não recarregou os dados; reinicie o app.", status_code=500,
                ) from None
            if erro_interno is not None and error is not erro_interno:
                _falhou(pacote["sha256"], error)
                raise _sem_recuperacao() from None  # a volta automática (rollback) também falhou
            if desfazer is not None:  # nada mudou: o desfazer do estado atual não serve para nada
                (pasta / desfazer["arquivo"]).unlink(missing_ok=True)
            if isinstance(error, DomainError):
                raise
            _falhou(pacote["sha256"], error)
            if isinstance(error, FileBusyError):
                raise _recusa_restauracao("arquivos ocupados; tente de novo em instantes") from None
            if isinstance(error, TransactionConflictError):
                if erro_interno is None:
                    raise _recusa_restauracao("há uma gravação pendente para conferir em .transactions") from None
                raise _recusa_restauracao("o estado mudou desde a prévia; abra a prévia de novo") from None
            raise DomainError(MSG_FALHA, status_code=500) from None

    assert desfazer is not None
    resultado = {
        "substituidos": totais["substituir"], "criados": totais["criar"], "apagados": totais["apagar"],
        "mantidos": totais["manter"], "pacote_desfazer": desfazer["arquivo"],
    }
    logger.info(
        "pacote_local: restaurado (substituidos=%d, criados=%d, apagados=%d, mantidos=%d, sha256=%s)",
        resultado["substituidos"], resultado["criados"], resultado["apagados"], resultado["mantidos"], pacote["sha256"],
    )
    return resultado


def _falhou(sha256_pacote: str, error: BaseException) -> None:
    logger.warning("pacote_local: restauração falhou (sha256=%s, erro=%s)", sha256_pacote, type(error).__name__)


def _sem_recuperacao() -> DomainError:
    """A gravação falhou e a volta automática também: nunca dizer que os arquivos foram recuperados."""
    return DomainError(
        "Falha ao restaurar e a recuperação automática não terminou; confira a pasta .transactions antes de usar o app.",
        status_code=500,
    )

