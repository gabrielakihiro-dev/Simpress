"""Backups regionais: confirmações manuais de backup por série e cidade (``data/state/backups_regionais.json``).

- Registro novo ("Confirmar Backup", sem prazo): ``serie``, ``cidade``, ``confirmado_em``, ``tipo`` e ``usuario_ref``.
  Vale até ser desfeito ou cair por regra (cidade ou usuário mudou). Repetir com o mesmo ``usuario_ref`` não muda nada.
- Registro antigo de 7 dias (``serie``, ``cidade``, ``confirmado_em``, ``expira_em``): continua lido e vale até
  ``expira_em``; ``podar`` o remove depois da retenção. Nada é migrado; as duas formas podem coexistir (esquema 1).
- ``decisoes`` (opcional, no topo): memória do Manter/Excluir quando aparece usuário novo num notebook com apelido
  manual; lista de ``{serie, cidade, decisao: "manter"|"excluir", decidido_em}``, sem usuário nem ref. ``podar`` aplica
  a mesma retenção; arquivo sem a chave continua válido.
- LGPD: ``usuario_ref`` é pseudônimo (``sha256:`` do usuário normalizado, sem segredo, reversível por dicionário),
  não anonimização. Fica só neste arquivo; nunca em ``/api/painel``, resposta de rota, Assistente, toast ou log.
- Arquivo ilegível nunca é sobrescrito: a leitura levanta ``EstadoIlegivel`` (503) e a gravação aborta.
- A gravação não usa lock Python: ``AtomicFileTransaction`` já serializa os escritores (threads e processos).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

from core.integrity import AtomicFileTransaction, FileBusyError, FileTransactionError, TransactionConflictError
from domains.regras_negocio import normalize_reference_value

ESQUEMA = 1
PRAZO_DIAS = 7
# Confirmação expirada fica mais este tempo (a tela mostra "Antes: expirou"); depois sai na próxima gravação.
RETENCAO_DIAS = PRAZO_DIAS
TIPO_BACKUP = "backup"
CAMPOS_7_DIAS = ("serie", "cidade", "confirmado_em", "expira_em")
CAMPOS_BACKUP = ("serie", "cidade", "confirmado_em", "tipo", "usuario_ref")
DECISOES = ("manter", "excluir")
CAMPOS_DECISAO = ("serie", "cidade", "decisao", "decidido_em")
_USUARIO_REF = re.compile(r"sha256:[0-9a-f]{64}")

Estado = Dict[str, Any]
Registro = Dict[str, str]


class EstadoIlegivel(ValueError):
    """O arquivo existe, mas não é um estado válido; ele é preservado como está."""


def estado_vazio() -> Estado:
    return {"esquema": ESQUEMA, "confirmacoes": []}


def _data_iso_valida(valor: Any) -> bool:
    if not isinstance(valor, str):
        return False
    try:
        datetime.fromisoformat(valor)
    except ValueError:
        return False
    return True


def _registro_valido(registro: Any) -> bool:
    if not isinstance(registro, dict):
        return False
    if not all(isinstance(registro.get(c), str) and registro[c].strip() for c in ("serie", "cidade")):
        return False
    if set(registro) == set(CAMPOS_7_DIAS):
        return all(_data_iso_valida(registro[c]) for c in ("confirmado_em", "expira_em"))
    if set(registro) == set(CAMPOS_BACKUP):
        ref = registro["usuario_ref"]
        return (
            _data_iso_valida(registro["confirmado_em"])
            and registro["tipo"] == TIPO_BACKUP
            and isinstance(ref, str)
            and (ref == "" or _USUARIO_REF.fullmatch(ref) is not None)
        )
    return False


def _decisao_valida(decisao: Any) -> bool:
    return (
        isinstance(decisao, dict)
        and set(decisao) == set(CAMPOS_DECISAO)
        and all(isinstance(decisao[c], str) and decisao[c].strip() for c in ("serie", "cidade"))
        and decisao["decisao"] in DECISOES
        and _data_iso_valida(decisao["decidido_em"])
    )


def _com_decisoes(estado: Estado, confirmacoes: Any, decisoes: Any) -> Estado:
    """Estado novo; ``decisoes`` só entra se o original já tinha a chave ou há decisões a gravar."""
    novo: Estado = {"esquema": ESQUEMA, "confirmacoes": list(confirmacoes)}
    if decisoes or "decisoes" in estado:
        novo["decisoes"] = list(decisoes or [])
    return novo


def validar_estado(valor: Any, nome: str = "backups_regionais.json") -> Estado:
    """Validação estrita: esquema conhecido, nenhuma chave desconhecida e registros com os campos de uma das duas formas."""
    if not isinstance(valor, dict):
        raise EstadoIlegivel(f"'{nome}' precisa conter um objeto.")
    if type(valor.get("esquema")) is not int or valor["esquema"] != ESQUEMA:  # recusa true e 1.0
        raise EstadoIlegivel(f"'{nome}' tem um esquema desconhecido ({valor.get('esquema')!r}).")
    desconhecidas = set(valor) - {"esquema", "confirmacoes", "decisoes"}
    if desconhecidas:
        raise EstadoIlegivel(f"'{nome}' tem chaves desconhecidas: {', '.join(sorted(desconhecidas))}.")
    confirmacoes = valor.get("confirmacoes", [])
    if not isinstance(confirmacoes, list):
        raise EstadoIlegivel(f"'confirmacoes' de '{nome}' precisa ser uma lista.")
    for indice, registro in enumerate(confirmacoes):
        if not _registro_valido(registro):
            raise EstadoIlegivel(f"A confirmação {indice} de '{nome}' é inválida.")
    decisoes = valor.get("decisoes")
    if decisoes is not None:
        if not isinstance(decisoes, list):
            raise EstadoIlegivel(f"'decisoes' de '{nome}' precisa ser uma lista.")
        for indice, decisao in enumerate(decisoes):
            if not _decisao_valida(decisao):
                raise EstadoIlegivel(f"A decisão {indice} de '{nome}' é inválida.")
    estado: Estado = {"esquema": ESQUEMA, "confirmacoes": list(confirmacoes)}
    if decisoes is not None:
        estado["decisoes"] = list(decisoes)
    return estado


def _mesma(registro: Registro, serie: str, cidade: str) -> bool:
    return (
        normalize_reference_value(registro["serie"]) == normalize_reference_value(serie)
        and normalize_reference_value(registro["cidade"]) == normalize_reference_value(cidade)
    )


def _vigente(registro: Registro, agora: datetime) -> bool:
    if registro.get("tipo") == TIPO_BACKUP:
        return True
    expira = datetime.fromisoformat(registro["expira_em"])
    if expira.tzinfo is None:
        expira = expira.replace(tzinfo=agora.tzinfo)
    return agora < expira


def _data_com_fuso(texto: str, agora: datetime) -> datetime:
    data = datetime.fromisoformat(texto)
    return data.replace(tzinfo=agora.tzinfo) if data.tzinfo is None else data


def podar(estado: Estado, agora: datetime) -> Estado:
    """Tira as confirmações expiradas há mais de ``RETENCAO_DIAS``; a recém-expirada fica para a nota "Antes: expirou".

    Só roda dentro da transação de escrita (confirmar e desfazer): o GET nunca grava.
    """
    limite = agora - timedelta(days=RETENCAO_DIAS)
    decisoes = [d for d in estado.get("decisoes", []) if _data_com_fuso(d["decidido_em"], agora) >= limite]
    return _com_decisoes(estado, [r for r in estado["confirmacoes"] if _vigente(r, limite)], decisoes)


def confirmar(
    estado: Estado, serie: str, cidade: str, agora: datetime, usuario_ref: str,
) -> Tuple[Estado, Registro, bool]:
    """``(novo_estado, registro, repetido)``; só o mesmo ``usuario_ref`` num registro novo é repetido.

    Registro antigo de 7 dias ou ``usuario_ref`` diferente é substituído pelo registro novo.
    """
    if agora.tzinfo is None or agora.utcoffset() is None:
        raise ValueError("agora precisa ter fuso horário")
    if usuario_ref != "" and _USUARIO_REF.fullmatch(usuario_ref) is None:
        raise ValueError("usuario_ref inválido")
    existente = next((r for r in estado["confirmacoes"] if _mesma(r, serie, cidade)), None)
    if existente is not None and existente.get("tipo") == TIPO_BACKUP and existente["usuario_ref"] == usuario_ref:
        return podar(estado, agora), existente, True
    registro: Registro = {
        "serie": serie,
        "cidade": cidade,
        "confirmado_em": agora.isoformat(timespec="seconds"),
        "tipo": TIPO_BACKUP,
        "usuario_ref": usuario_ref,
    }
    restantes = [r for r in estado["confirmacoes"] if not _mesma(r, serie, cidade)]
    return podar(_com_decisoes(estado, [*restantes, registro], estado.get("decisoes")), agora), registro, False


def desfazer(
    estado: Estado, serie: str, cidade: str, agora: Optional[datetime] = None,
) -> Tuple[Estado, Optional[Registro]]:
    """``(novo_estado, registro_removido | None)``; desfazer o que não existe não é erro.

    Com ``agora``, poda as expiradas antigas depois de remover (o ``removido`` não muda por causa da poda).
    """
    removido = next((r for r in estado["confirmacoes"] if _mesma(r, serie, cidade)), None)
    novo = _com_decisoes(
        estado, [r for r in estado["confirmacoes"] if not _mesma(r, serie, cidade)], estado.get("decisoes"),
    )
    return (novo if agora is None else podar(novo, agora)), removido


def registrar_decisao(estado: Estado, serie: str, cidade: str, decisao: str, agora: datetime) -> Estado:
    """Grava a decisão (``manter`` ou ``excluir``) da série naquela cidade; a mais recente substitui a anterior."""
    if agora.tzinfo is None or agora.utcoffset() is None:
        raise ValueError("agora precisa ter fuso horário")
    if decisao not in DECISOES:
        raise ValueError("decisao inválida")
    restantes = [d for d in estado.get("decisoes", []) if not _mesma(d, serie, cidade)]
    registro = {"serie": serie, "cidade": cidade, "decisao": decisao, "decidido_em": agora.isoformat(timespec="seconds")}
    return podar(_com_decisoes(estado, estado["confirmacoes"], [*restantes, registro]), agora)


class BackupsRegionaisStore:
    def __init__(self, arquivo: Path, transaction_root: Path) -> None:
        self.arquivo = Path(arquivo)
        self.transaction_root = Path(transaction_root)

    def ler(self) -> Estado:
        """Sem arquivo: estado vazio. Conteúdo inválido: ``EstadoIlegivel``. Outro ``OSError`` (arquivo preso,
        permissão passageira) sobe como está: não é "ilegível" e quem chama decide (409 na rota, aviso no painel)."""
        try:
            texto = self.arquivo.read_text(encoding="utf-8")
        except FileNotFoundError:
            return estado_vazio()
        except UnicodeError as error:
            raise EstadoIlegivel(f"'{self.arquivo.name}' está ilegível; os dados foram preservados.") from error
        try:
            bruto = json.loads(texto)
        except ValueError as error:
            raise EstadoIlegivel(f"'{self.arquivo.name}' está ilegível; os dados foram preservados.") from error
        return validar_estado(bruto, self.arquivo.name)

    def escrever(self, operacao: Callable[[Estado], Tuple[Estado, Any]]) -> Any:
        """Relê o estado dentro da transação e aplica ``operacao``; ``EstadoIlegivel`` desfaz sem gravar.

        ``FileBusyError`` (arquivo ocupado ou erro de disco passageiro na leitura) e ``FileTransactionError``
        (leitura ou gravação) sobem para o router.
        """
        resultado: Dict[str, Any] = {}
        # Leitura prévia: erro de disco passageiro (antivírus, sincronização) vira "ocupado" (409), não falha de gravação.
        # shortcut: a transação relê logo depois; um erro que surja só nesse intervalo ainda sobe como FileTransactionError (500).
        try:
            self.ler()
        except EstadoIlegivel:
            pass  # a releitura dentro da transação levanta o mesmo erro, com o caminho de sempre (503)
        except OSError as error:
            raise FileBusyError(type(error).__name__) from error

        def atualizar(atual: Any) -> Estado:
            novo, resultado["valor"] = operacao(validar_estado(atual, self.arquivo.name))
            return novo

        with AtomicFileTransaction(self.transaction_root, [self.arquivo]) as transacao:
            transacao.update_json(self.arquivo, atualizar, estado_vazio())
            transacao.commit()
        return resultado["valor"]


def eh_ilegivel(error: BaseException) -> bool:
    """``FileTransactionError`` de leitura (JSON inválido) ou estado inválido: 503, nunca 500."""
    if isinstance(error, EstadoIlegivel):
        return True
    if isinstance(error, TransactionConflictError):  # rollback falhou: há transação pendente, não é "nada gravado"
        return False
    return isinstance(error, FileTransactionError) and isinstance(error.__cause__, (ValueError, UnicodeError))
