"""State of "finalizar chamado no SoftExpert" (docs/operacao/sincronizar-chamados-sebrae.md).

Everything lives in ``data/state`` (outside Git and outside the Dashboard): the text and the optional PDF that go
into the SoftExpert form of each ticket, what happened when it was finalized, the one-shot job file that tells the
``fechar`` routine which tickets to finalize, the result of the last run and the pending copy of the Dashboard that
could not be sent to SharePoint. The site only writes these files; SoftExpert and SharePoint are reached by the
routine (scripts/sebrae_fechar.py).
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from core.errors import DomainValidationError
from core.integrity import atomic_write_bytes, atomic_write_json, lock_paths
from domains.sebrae_chamados import chave_do_numero

FUSO = ZoneInfo("America/Sao_Paulo")
FORMATO_ENCERRAMENTO = "%d/%m/%Y %H:%M"
MAX_DESCRICAO = 4000
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_NOME_PDF = 100
JOB_VALIDADE = timedelta(hours=2)  # an old job is dropped: a forgotten file must never finalize tickets by surprise
NOME_DASHBOARD = "Dashboard Operacional_SEBRAE.xlsx"

ACAO_FINALIZAR = "finalizar"
ACAO_REENVIAR = "reenviar_pendente"

STATUS_OK = "ok"
STATUS_JA_FINALIZADO = "ja_finalizado"
STATUS_NAO_ENCONTRADO = "nao_encontrado"  # fora da central de tarefas: não prova que está finalizado, então pode tentar de novo
STATUS_ERRO = "erro"
STATUS_SEM_DESCRICAO = "sem_descricao"
STATUS_PRONTO = "pronto"  # --sem-finalizar: the form was filled and checked, Finalizar was not clicked

SUGESTOES_SHAREPOINT: Tuple[str, str, str] = (
    "Confira se o login do SharePoint está ativo no Chrome de automação (porta 9333) e use \"Tentar substituir de novo\".",
    "Se continuar falhando, abra a pasta DASHBOARD SEBRAE no SharePoint, arraste a cópia pendente para lá e renomeie-a para "
    "\"Dashboard Operacional_SEBRAE.xlsx\".",
    "Antes de substituir, confira se ninguém alterou o Dashboard original no SharePoint nesse intervalo.",
)

_NOME_PDF_INVALIDO = re.compile(r"[^A-Za-z0-9._() -]")
_NOMES_RESERVADOS_WINDOWS = frozenset({"CON", "PRN", "AUX", "NUL", *(f"COM{n}" for n in range(1, 10)), *(f"LPT{n}" for n in range(1, 10))})
_CONTROLES = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def pasta_estado(existentes: Path) -> Path:
    """``data/state``, from the path of ``sebrae_dashboard_existentes.json`` the router already knows."""
    return Path(existentes).parent


def _estado(state_dir: Path) -> Path:
    return state_dir / "sebrae_finalizacao.json"


def pasta_anexos(state_dir: Path, numero: str) -> Path:
    return state_dir / "sebrae_anexos" / numero


def caminho_job(state_dir: Path) -> Path:
    return state_dir / "sebrae_fechar_job.json"


def caminho_resultado(state_dir: Path) -> Path:
    return state_dir / "sebrae_fechar_resultado.json"


def pasta_pendente(state_dir: Path) -> Path:
    return state_dir / "sebrae_dashboard_pendente"


def caminho_enviado(state_dir: Path) -> Path:
    return state_dir / "sebrae_dashboard_enviado.json"


def caminho_saida_dashboard(state_dir: Path) -> Path:
    return state_dir / "sebrae_dashboard_saida" / NOME_DASHBOARD


# ---------------------------------------------------------------------------- time

def agora_local() -> datetime:
    return datetime.now(FUSO)


def agora_iso() -> str:
    return agora_local().isoformat(timespec="seconds")


def texto_do_encerramento(momento: datetime) -> str:
    """Column R as the Dashboard shows it (``dd/MM/aaaa HH:mm``, Brasília time)."""
    return momento.astimezone(FUSO).strftime(FORMATO_ENCERRAMENTO)


# ---------------------------------------------------------------------------- validation

def validar_numero(numero: Any) -> str:
    try:
        return chave_do_numero(str(numero))
    except ValueError:
        raise DomainValidationError("Informe o número do chamado no formato UTIC-AAAA-NNNN.", status_code=422) from None


def validar_descricao(texto: Any) -> str:
    """Free text for "Detalhes do Atendimento Realizado"; line breaks stay, control characters go. Empty clears it."""
    limpo = _CONTROLES.sub("", str(texto or "").replace("\r\n", "\n").replace("\r", "\n")).strip()
    if len(limpo) > MAX_DESCRICAO:
        raise DomainValidationError(f"A descrição para finalizar aceita até {MAX_DESCRICAO} caracteres.", status_code=422)
    return limpo


def nome_seguro_pdf(nome: Any) -> str:
    """File name only (no folders), limited charset, ``.pdf`` extension; raises 422 otherwise."""
    base = re.split(r"[/\\]", str(nome or ""))[-1].strip()
    if not base.lower().endswith(".pdf"):
        raise DomainValidationError("O anexo precisa ser um arquivo .pdf.", status_code=422)
    miolo = _NOME_PDF_INVALIDO.sub("_", base[:-4]).strip(" .")
    if not miolo:
        raise DomainValidationError("O nome do anexo PDF é inválido.", status_code=422)
    if miolo.split(".")[0].strip().upper() in _NOMES_RESERVADOS_WINDOWS:  # CON.pdf abre o dispositivo, não um arquivo
        miolo = f"_{miolo}"
    return miolo[: MAX_NOME_PDF - 4] + ".pdf"


def validar_pdf(nome: Any, conteudo: bytes, limite: int = MAX_PDF_BYTES) -> str:
    """Safe file name of a PDF whose bytes are acceptable; 422/413 with a message for the user otherwise."""
    seguro = nome_seguro_pdf(nome)
    if not conteudo:
        raise DomainValidationError("O anexo PDF está vazio.", status_code=422)
    if len(conteudo) > limite:
        raise DomainValidationError(f"O anexo PDF excede o limite de {limite // (1024 * 1024)} MB.", status_code=413)
    if not conteudo.startswith(b"%PDF"):
        raise DomainValidationError("O arquivo enviado não é um PDF válido.", status_code=422)
    return seguro


# ---------------------------------------------------------------------------- per-ticket state

def _ler_json(caminho: Path) -> Optional[Dict[str, Any]]:
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return dados if isinstance(dados, dict) else None


def ler_estado(state_dir: Path) -> Dict[str, Dict[str, Any]]:
    dados = _ler_json(_estado(state_dir)) or {}
    return {str(numero): dict(item) for numero, item in dados.items() if isinstance(item, dict)}


def _alterar(state_dir: Path, numero: str, mudar: Callable[[Dict[str, Any]], object]) -> Dict[str, Any]:
    arquivo = _estado(state_dir)
    with lock_paths([arquivo]):
        todos = ler_estado(state_dir)
        item = todos.get(numero, {})
        mudar(item)
        todos[numero] = item
        atomic_write_json(arquivo, todos)
    return item


def definir_descricao(state_dir: Path, numero: str, texto: Any) -> Dict[str, Any]:
    numero = validar_numero(numero)
    descricao = validar_descricao(texto)
    return _alterar(state_dir, numero, lambda item: item.update(descricao_finalizacao=descricao, atualizado_em=agora_iso()))


def anexar_pdf(state_dir: Path, numero: str, nome: Any, conteudo: bytes, limite: int = MAX_PDF_BYTES) -> Dict[str, Any]:
    """Keeps ONE PDF per ticket under ``sebrae_anexos/<numero>/``; a new one replaces the old."""
    numero = validar_numero(numero)
    seguro = validar_pdf(nome, conteudo, limite)
    pasta = pasta_anexos(state_dir, numero)
    destino = (pasta / seguro).resolve(strict=False)
    if destino.parent != pasta.resolve(strict=False):  # belt and braces after the name filter
        raise DomainValidationError("O nome do anexo PDF é inválido.", status_code=422)
    with lock_paths([_estado(state_dir)]):
        _apagar_pasta(pasta)
        atomic_write_bytes(destino, conteudo)
        return _alterar(
            state_dir, numero, lambda item: item.update(pdf={"nome": seguro, "tamanho": len(conteudo)}, atualizado_em=agora_iso()),
        )


def remover_pdf(state_dir: Path, numero: str) -> Dict[str, Any]:
    numero = validar_numero(numero)
    with lock_paths([_estado(state_dir)]):
        _apagar_pasta(pasta_anexos(state_dir, numero))
        return _alterar(state_dir, numero, lambda item: (item.pop("pdf", None), item.update(atualizado_em=agora_iso())))


def _apagar_pasta(pasta: Path) -> None:
    if pasta.is_dir():
        shutil.rmtree(pasta, ignore_errors=True)


def dados_para_finalizar(state_dir: Path, numero: str) -> Tuple[str, Optional[Path]]:
    """Text and PDF of the ticket as stored NOW (read at run time, never taken from the job file)."""
    item = ler_estado(state_dir).get(numero, {})
    descricao = str(item.get("descricao_finalizacao") or "").strip()
    pdf = item.get("pdf")
    caminho: Optional[Path] = None
    if isinstance(pdf, dict) and pdf.get("nome"):
        candidato = pasta_anexos(state_dir, numero) / str(pdf["nome"])
        if candidato.is_file() and candidato.parent == pasta_anexos(state_dir, numero):
            caminho = candidato
    return descricao, caminho


def registrar_finalizacao(state_dir: Path, numero: str, status: str, encerrado_em: str = "") -> Dict[str, Any]:
    """Remembers the outcome; ``encerrado_em`` (``dd/MM/aaaa HH:mm``) only for a ticket this site finalized."""
    def mudar(item: Dict[str, Any]) -> None:
        item["finalizacao"] = {"status": status, "em": agora_iso(), "encerrado_em": encerrado_em}

    return _alterar(state_dir, numero, mudar)


def ja_finalizado(state_dir: Path, numero: str) -> bool:
    fin = ler_estado(state_dir).get(numero, {}).get("finalizacao")
    return isinstance(fin, dict) and fin.get("status") == STATUS_OK  # nao_encontrado e ja_finalizado antigos não bloqueiam


def encerramentos_registrados(state_dir: Path) -> Dict[str, str]:
    """``{UTIC: "dd/MM/aaaa HH:mm"}`` of every ticket this site finalized, to re-apply to a rebuilt Dashboard copy."""
    achados: Dict[str, str] = {}
    for numero, item in ler_estado(state_dir).items():
        fin = item.get("finalizacao")
        if isinstance(fin, dict) and fin.get("status") == STATUS_OK and fin.get("encerrado_em"):
            achados[numero] = str(fin["encerrado_em"])
    return achados


def publico(item: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """What the screen shows of a ticket's state."""
    item = item or {}
    pdf = item.get("pdf")
    fin = item.get("finalizacao")
    return {
        "descricao_finalizacao": str(item.get("descricao_finalizacao") or ""),
        "pdf": {"nome": str(pdf.get("nome") or ""), "tamanho": int(pdf.get("tamanho") or 0)} if isinstance(pdf, dict) else None,
        "finalizacao": {k: str(fin.get(k) or "") for k in ("status", "em", "encerrado_em")} if isinstance(fin, dict) else None,
    }


# ---------------------------------------------------------------------------- job and result

def gravar_job(
    state_dir: Path, numeros: Sequence[str], *, confirmar_final: bool = True, pulados: Sequence[Mapping[str, str]] = (),
    acao: str = ACAO_FINALIZAR,
) -> None:
    """Request for the next ``fechar`` run; the routine consumes it. ``--sem-finalizar`` can still force a dry run."""
    atomic_write_json(caminho_job(state_dir), {
        "criado_em": agora_iso(), "acao": acao, "numeros": list(numeros), "confirmar_final": bool(confirmar_final),
        "pulados": [dict(p) for p in pulados],
    })


def apagar_job(state_dir: Path) -> None:
    caminho_job(state_dir).unlink(missing_ok=True)


def _job_valido(job: Mapping[str, Any], agora: Optional[datetime]) -> bool:
    """``criado_em`` legível e com menos de ``JOB_VALIDADE``."""
    try:
        criado = datetime.fromisoformat(str(job.get("criado_em")))
    except ValueError:
        return False
    return (agora or agora_local()) - criado <= JOB_VALIDADE


def consumir_job(state_dir: Path, agora: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The job, deleted on reading; ``None`` when there is none, it is unreadable or older than ``JOB_VALIDADE``."""
    caminho = caminho_job(state_dir)
    with lock_paths([caminho]):
        job = _ler_json(caminho)
        caminho.unlink(missing_ok=True)
    if job is None or not _job_valido(job, agora):
        return None
    numeros = job.get("numeros")
    if not isinstance(numeros, list) or job.get("acao") not in (ACAO_FINALIZAR, ACAO_REENVIAR):
        return None
    return {
        "acao": job["acao"], "numeros": [str(n) for n in numeros], "confirmar_final": job.get("confirmar_final") is not False,
        "pulados": [p for p in job.get("pulados") or [] if isinstance(p, dict)],
    }


def job_pendente(state_dir: Path, agora: Optional[datetime] = None) -> bool:
    """A valid job is waiting for its routine to consume it (a second request would overwrite it)."""
    job = _ler_json(caminho_job(state_dir))
    return job is not None and _job_valido(job, agora)


def gravar_resultado(state_dir: Path, resultado: Mapping[str, Any]) -> None:
    atomic_write_json(caminho_resultado(state_dir), resultado)


def ler_resultado(state_dir: Path) -> Optional[Dict[str, Any]]:
    return _ler_json(caminho_resultado(state_dir))


# ---------------------------------------------------------------------------- SharePoint: sent hash, pending copy, notice

def gravar_enviado(state_dir: Path, sha256: str) -> None:
    """Hash of the Dashboard this site last put on SharePoint; the next ``enviar`` accepts exactly that file as "unchanged"."""
    atomic_write_json(caminho_enviado(state_dir), {"sha256": sha256, "enviado_em": agora_iso()})


def ler_enviado(state_dir: Path) -> str:
    return str((_ler_json(caminho_enviado(state_dir)) or {}).get("sha256") or "")


def nome_pendente(momento: datetime) -> str:
    return f"{Path(NOME_DASHBOARD).stem} (pendente {momento.astimezone(FUSO):%Y-%m-%d %H%M}).xlsx"


def guardar_pendente(
    state_dir: Path, origem: Path, momento: datetime, *, motivo: str, tickets: Sequence[str], copia_sharepoint: bool = False,
) -> Path:
    """Copies ``origem`` to ``sebrae_dashboard_pendente/`` with the pending name plus a JSON record of what is missing."""
    pasta = pasta_pendente(state_dir)
    destino = pasta / nome_pendente(momento)
    atomic_write_bytes(destino, Path(origem).read_bytes())
    atomic_write_json(destino.with_suffix(".json"), {
        "arquivo": destino.name, "criado_em": agora_iso(), "motivo": motivo, "chamados": list(tickets),
        "copia_sharepoint": copia_sharepoint,
    })
    return destino


def pendente_mais_recente(state_dir: Path) -> Optional[Tuple[Path, Dict[str, Any]]]:
    pasta = pasta_pendente(state_dir)
    if not pasta.is_dir():
        return None
    arquivos = sorted(pasta.glob("*.xlsx"), key=lambda p: p.name, reverse=True)  # the name starts with the date
    if not arquivos:
        return None
    return arquivos[0], _ler_json(arquivos[0].with_suffix(".json")) or {}


def marcar_copia_sharepoint(pendente: Path) -> None:
    registro = _ler_json(pendente.with_suffix(".json")) or {}
    registro["copia_sharepoint"] = True
    atomic_write_json(pendente.with_suffix(".json"), registro)


def descartar_pendente(pendente: Path) -> None:
    pendente.unlink(missing_ok=True)
    pendente.with_suffix(".json").unlink(missing_ok=True)


def descartar_pendentes(state_dir: Path) -> None:
    """Remove every pending copy: after a successful send they are all older than what is now on SharePoint."""
    achado = pendente_mais_recente(state_dir)
    while achado is not None:
        descartar_pendente(achado[0])
        achado = pendente_mais_recente(state_dir)


def aviso_sharepoint(
    falhou: bool, motivo: str = "", copia_local: str = "", copia_sharepoint: bool = False,
) -> Dict[str, Any]:
    """Notice for the screen: ``{falhou, motivo, copia_local, copia_sharepoint, sugestoes}``."""
    return {
        "falhou": falhou, "motivo": motivo, "copia_local": copia_local, "copia_sharepoint": copia_sharepoint,
        "sugestoes": list(SUGESTOES_SHAREPOINT) if falhou else [],
    }


def aviso_do_pendente(state_dir: Path) -> Optional[Dict[str, Any]]:
    """The notice again from the pending copy on disk (so it survives a restart); ``None`` when nothing is pending."""
    achado = pendente_mais_recente(state_dir)
    if achado is None:
        return None
    arquivo, registro = achado
    return aviso_sharepoint(True, str(registro.get("motivo") or ""), str(arquivo), bool(registro.get("copia_sharepoint")))
