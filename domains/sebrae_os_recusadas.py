"""OS que o usuário recusou, manteve ou mandou remover da E de um chamado do F5, guardadas só no computador.

Uma OS recusada para um chamado nunca mais é sugerida nem trocada sozinha para ele (``sebrae_os_nova``).
O registro vive em ``data/state/sebrae_os_recusadas.json`` (``{"version": 1, "recusadas": {numero: [os, ...]}}``, mais as
chaves opcionais ``mantidas`` e ``removidas`` no mesmo formato), não leva nome, texto nem dado pessoal e nunca vai ao SoftExpert,
ao Dashboard ou ao SharePoint.

- ``mantidas`` (decisão de 18/11/2026): o usuário clicou Manter; a OS na E não volta a ser apontada como "sem relação".
- ``removidas``: o usuário clicou Remover; a OS também entra em ``recusadas`` e a gravação do Dashboard limpa só a E que
  ainda for exatamente essa OS (``sebrae_dashboard_gravacao.atualizar``, ``limpar_e``).
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from core.errors import DomainBusyError, DomainValidationError
from core.integrity import FileBusyError, atomic_write_json, lock_paths
from domains.sebrae_observacoes import numero_observacao_valido, validar_numero_observacao
from domains.sebrae_vinculos import _os_chave

logger = logging.getLogger(__name__)
MAX_OS = 32
OCUPADO = "O registro de OS recusadas está ocupado no momento (aberto em outro programa ou travado). Tente novamente em instantes."
_PADRAO_OS = re.compile(rf"^[A-Z0-9-]{{1,{MAX_OS}}}$")
_LISTAS = ("recusadas", "mantidas", "removidas")  # ``recusadas`` é obrigatória; as outras só existem depois do primeiro Manter/Remover


def caminho_recusadas(state_dir: Path) -> Path:
    """Caminho do arquivo JSON das OS recusadas dentro do diretório de estado."""
    return Path(state_dir) / "sebrae_os_recusadas.json"


def validar_os(os_: Any) -> str:
    """OS na mesma chave do cruzamento (``_os_chave``: sem espaços, maiúsculas); letras, números e hífen, até 32 caracteres."""
    valor = _os_chave(os_)
    if not _PADRAO_OS.match(valor):
        raise DomainValidationError(f"Informe a OS só com letras, números e hífen, até {MAX_OS} caracteres.", status_code=422)
    return valor


def _carregar(state_dir: Path) -> Dict[str, Any]:
    """Documento inteiro com a estrutura conferida (``{}`` sem arquivo); nunca altera o disco."""
    arquivo = caminho_recusadas(state_dir)
    try:
        dados = json.loads(arquivo.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (PermissionError, FileBusyError) as error:  # Windows: arquivo travado ou aberto em outro programa
        raise DomainBusyError(OCUPADO) from error
    except (OSError, ValueError) as error:
        raise DomainBusyError(
            "O registro de OS recusadas está ilegível e foi preservado. Restaure uma cópia válida antes de continuar."
        ) from error
    if not isinstance(dados, dict) or dados.get("version") != 1 or not isinstance(dados.get("recusadas"), dict) or any(
        not isinstance(lista, list) or any(not isinstance(os_, str) for os_ in lista)
        for nome in _LISTAS if nome in dados
        for lista in (dados[nome].values() if isinstance(dados[nome], dict) else (None,))
    ):
        raise DomainBusyError(
            "O registro de OS recusadas tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de continuar."
        )
    return dados


def _lista(state_dir: Path, nome: str) -> Dict[str, List[str]]:
    """``{numero do chamado: [OS]}`` de uma das listas; chave fora de ``UTIC-AAAA-N``/``linha:N`` (JSON editado à mão) fica de fora."""
    return {
        numero: [os_ for os_ in lista if os_.strip()]
        for numero, lista in (_carregar(state_dir).get(nome) or {}).items() if numero_observacao_valido(numero)
    }


def ler(state_dir: Path) -> Dict[str, List[str]]:
    """``{numero do chamado: [OS recusadas]}``."""
    return _lista(state_dir, "recusadas")


def mantidas(state_dir: Path) -> Dict[str, List[str]]:
    """``{numero do chamado: [OS que o usuário mandou manter na E]}``."""
    return _lista(state_dir, "mantidas")


def removidas(state_dir: Path) -> Dict[str, List[str]]:
    """``{numero do chamado: [OS que o usuário mandou remover da E]}``; só estas autorizam limpar a E na gravação."""
    return _lista(state_dir, "removidas")


def ler_ou_none(state_dir: Path) -> Optional[Dict[str, List[str]]]:
    """``ler`` estrito para quem GRAVA (marcas e congelamento de OS): registro ilegível devolve ``None``.

    Quem recebe ``None`` não aplica troca por chave forte (``vinculos_derivados(chave_forte=False)``), porque sem as recusas
    uma OS já recusada poderia voltar a valer. O log leva só o tipo do erro, nunca número de chamado nem OS."""
    try:
        return ler(state_dir)
    except DomainBusyError as erro:
        logger.warning("Registro de OS recusadas indisponível (%s).", type(erro.__cause__ or erro).__name__)
        return None


def ler_ou_vazio(state_dir: Path) -> Dict[str, List[str]]:
    """``ler`` para quem só lê (telas e vínculos derivados): registro ilegível vale como "nenhuma recusa", sem derrubar a tela."""
    return ler_ou_none(state_dir) or {}


def _registrar(state_dir: Path, listas: Sequence[str], numero: str, os_: Any) -> Dict[str, str]:
    """Soma a OS às ``listas`` do chamado numa só leitura e gravação sob trava, preservando o resto do arquivo; repetir não duplica."""
    chave, ordem = validar_numero_observacao(numero), validar_os(os_)
    arquivo = caminho_recusadas(state_dir)
    try:
        with lock_paths([arquivo]):
            documento = _carregar(state_dir) or {"version": 1, "recusadas": {}}
            mudou = False
            for nome in listas:
                lista = (documento.get(nome) or {}).get(chave) or []
                if ordem not in {_os_chave(o) for o in lista}:
                    documento[nome] = {**(documento.get(nome) or {}), chave: [*lista, ordem]}
                    mudou = True
            if mudou:
                arquivo.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(arquivo, documento)
    except (PermissionError, FileBusyError) as error:
        raise DomainBusyError(OCUPADO) from error
    return {"numero": chave, "os": ordem}


def recusar(state_dir: Path, numero: str, os_: Any) -> Dict[str, str]:
    """Grava, sob trava, que a OS não vale para o chamado; repetir a mesma recusa não duplica. Devolve ``{numero, os}``."""
    return _registrar(state_dir, ("recusadas",), numero, os_)


def manter(state_dir: Path, numero: str, os_: Any) -> Dict[str, str]:
    """Grava que o usuário quer manter a OS na E do chamado (some o aviso "sem relação"). Devolve ``{numero, os}``."""
    return _registrar(state_dir, ("mantidas",), numero, os_)


def remover(state_dir: Path, numero: str, os_: Any) -> Dict[str, str]:
    """Recusa a OS para o chamado e marca a E para ser limpa, tudo numa só gravação. Devolve ``{numero, os}``."""
    return _registrar(state_dir, ("recusadas", "removidas"), numero, os_)
