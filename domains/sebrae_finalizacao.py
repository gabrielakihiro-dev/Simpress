"""State of "finalizar chamado no SoftExpert" (docs/operacao/sincronizar-chamados-sebrae.md).

Everything lives in ``data/state`` (outside Git and outside the Dashboard): the text and the optional PDF that go
into the SoftExpert form of each ticket, what happened when it was finalized, the one-shot job file that tells the
``fechar`` routine which tickets to finalize, the result of the last run and the pending copy of the Dashboard that
could not be sent to SharePoint. The site only writes these files; SoftExpert and SharePoint are reached by the
routine (scripts/sebrae_fechar.py).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from core.errors import DomainBusyError, DomainConflictError, DomainValidationError
from core.integrity import FileBusyError, FileTransactionError, atomic_write_bytes, atomic_write_json, lock_paths
from domains import sebrae_novos
from domains.sebrae_chamados import chave_do_numero, mascarar_cpfs
from domains.sebrae_dashboard import OMITIDO, omitir_credenciais

logger = logging.getLogger(__name__)

FUSO = ZoneInfo("America/Sao_Paulo")
FORMATO_ENCERRAMENTO = "%d/%m/%Y %H:%M"
MAX_DESCRICAO = 4000
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_FICHA = 64 * 1024
MAX_FINALIZADOS_NO_DASHBOARD = 100  # o painel "Chamados finalizados" mostra só os mais recentes; o estado em disco guarda todos
MAX_NOME_PDF = 100
JOB_VALIDADE = timedelta(hours=2)  # an old job is dropped: a forgotten file must never finalize tickets by surprise
NOME_DASHBOARD = "Dashboard Operacional_SEBRAE.xlsx"

ACAO_FINALIZAR = "finalizar"
ACAO_REENVIAR = "reenviar_pendente"
ACAO_REENVIAR_SNAPSHOT = "reenviar_snapshot"

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
_CHAVE_SENHA = re.compile(r"(?i)(?:senha|password|passwd|pwd)")
_NOME_PENDENTE = re.compile(
    rf"^{re.escape(Path(NOME_DASHBOARD).stem)} \(pendente "
    r"(?P<data>\d{4}-\d{2}-\d{2}) (?P<hora>\d{4}(?:\d{2})?)(?:-(?P<ordem>n\d+|[a-f0-9]{32}))?\)\.xlsx$",
)


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


def caminho_envio(state_dir: Path) -> Path:
    return state_dir / "sebrae_dashboard_envio.json"


def caminho_copia_enviada(state_dir: Path) -> Path:
    return state_dir / "sebrae_dashboard_enviado.xlsx"


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
    try:
        dados = json.loads(_estado(state_dir).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise DomainBusyError("O histórico de finalização está ilegível e foi preservado. Restaure uma cópia válida antes de alterar os chamados.") from error
    if not isinstance(dados, dict) or any(not isinstance(item, dict) for item in dados.values()):
        raise DomainBusyError("O histórico de finalização tem estrutura inválida e foi preservado. Restaure uma cópia válida antes de alterar os chamados.")
    return {str(numero): dict(item) for numero, item in dados.items()}


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


def definir_descricao_editada(state_dir: Path, numero: str, texto: Any) -> Dict[str, Any]:
    """Texto do bloco "Descrição" do cartão (F5) editado pelo usuário; vazio volta ao texto original do chamado.

    Só local: o SoftExpert não é alterado e a coluna H de uma linha que já está no Dashboard também não.
    """
    numero = validar_numero(numero)
    descricao = validar_descricao(texto)

    def mudar(item: Dict[str, Any]) -> None:
        if descricao:
            item.update(descricao_editada=descricao, descricao_editada_em=agora_iso())
        else:
            item.pop("descricao_editada", None)
            item.pop("descricao_editada_em", None)
        item["atualizado_em"] = agora_iso()

    return _alterar(state_dir, numero, mudar)


def descricoes_editadas(state_dir: Path) -> Dict[str, str]:
    """``{UTIC: texto}`` de todo chamado com a descrição editada no site."""
    return {n: str(i["descricao_editada"]) for n, i in ler_estado(state_dir).items() if str(i.get("descricao_editada") or "").strip()}


def _sanitizar_ficha(valor: Any) -> Any:
    if isinstance(valor, dict):
        resultado = {}
        chaves_comuns = {chave: _sanitizar_ficha(chave) for chave in valor if not _CHAVE_SENHA.search(str(chave))}
        reservadas = set(chaves_comuns.values())
        if len(reservadas) != len(chaves_comuns):
            raise DomainValidationError("A ficha contém chaves repetidas após ocultar dados sensíveis.", status_code=422)
        credenciais = 0
        for chave, item in valor.items():
            sensivel = bool(_CHAVE_SENHA.search(str(chave)))
            if sensivel:
                credenciais += 1
                chave_limpa = f"{OMITIDO} {credenciais}"
                while chave_limpa in reservadas:
                    credenciais += 1
                    chave_limpa = f"{OMITIDO} {credenciais}"
                reservadas.add(chave_limpa)
            else:
                chave_limpa = chaves_comuns[chave]
            resultado[chave_limpa] = OMITIDO if sensivel else _sanitizar_ficha(item)
        return resultado
    if isinstance(valor, list):
        if len(valor) == 2 and isinstance(valor[0], str) and _CHAVE_SENHA.search(valor[0]):
            rotulo = valor[0] if _CHAVE_SENHA.fullmatch(valor[0]) else OMITIDO
            return [rotulo, OMITIDO]
        return [_sanitizar_ficha(item) for item in valor]
    if isinstance(valor, str):
        limpo = mascarar_cpfs(omitir_credenciais(valor))
        return "'" + limpo if limpo.lstrip().startswith(("=", "+", "-", "@")) else limpo
    return valor


def definir_ficha(state_dir: Path, numero: str, ficha: Any) -> Dict[str, Any]:
    """Snapshot of the ticket card (what the screen showed when finalizing), kept to show it again under "Chamados finalizados".

    The screen only ever renders it as text; here it must be a small JSON object.
    """
    numero = validar_numero(numero)
    if not isinstance(ficha, dict):
        raise DomainValidationError("A ficha do chamado precisa ser um objeto.", status_code=422)
    tamanho_original = len(json.dumps(ficha, ensure_ascii=False).encode("utf-8"))
    ficha_limpa = _sanitizar_ficha(ficha)
    if max(tamanho_original, len(json.dumps(ficha_limpa, ensure_ascii=False).encode("utf-8"))) > MAX_FICHA:
        raise DomainValidationError("A ficha do chamado é grande demais.", status_code=413)
    return _alterar(state_dir, numero, lambda item: item.update(ficha=ficha_limpa, atualizado_em=agora_iso()))


def anexar_pdf(state_dir: Path, numero: str, nome: Any, conteudo: bytes, limite: int = MAX_PDF_BYTES) -> Dict[str, Any]:
    """Stages a unique version; only a committed state change retires the previous PDF."""
    numero = validar_numero(numero)
    seguro = validar_pdf(nome, conteudo, limite)
    pasta = pasta_anexos(state_dir, numero)
    with lock_paths([_estado(state_dir)]):
        anterior = _caminho_pdf(state_dir, numero, ler_estado(state_dir).get(numero, {}).get("pdf"))
        arquivo = _estado(state_dir)
        estado_anterior = arquivo.read_bytes() if arquivo.is_file() else None
        versao = uuid.uuid4().hex
        pasta_nova = pasta / versao
        try:
            atomic_write_bytes(pasta_nova / seguro, conteudo)
            item = _alterar(
                state_dir, numero,
                lambda item: item.update(pdf={"nome": seguro, "tamanho": len(conteudo), "versao": versao}, atualizado_em=agora_iso()),
            )
        except Exception:
            if estado_anterior is None:
                arquivo.unlink(missing_ok=True)
            elif not arquivo.is_file() or arquivo.read_bytes() != estado_anterior:
                atomic_write_bytes(arquivo, estado_anterior)
            _apagar_pasta(pasta_nova)
            raise
        if anterior is not None:
            try:
                if anterior.parent == pasta:
                    anterior.unlink(missing_ok=True)
                else:
                    shutil.rmtree(anterior.parent)
            except OSError as error:
                logger.warning("O novo PDF foi salvo, mas a versão anterior não pôde ser limpa (erro=%s).", type(error).__name__)
        return item


def remover_pdf(state_dir: Path, numero: str, *, somente_pendentes: bool = False) -> Dict[str, Any]:
    numero = validar_numero(numero)
    with lock_paths([_estado(state_dir)]):
        atual = ler_estado(state_dir).get(numero, {})
        if somente_pendentes and not atual.get("pdf_remocao"):
            return atual
        if atual.get("pdf_remocao") and not isinstance(atual["pdf_remocao"], list):
            raise DomainBusyError("O pedido de remoção do PDF é inválido e foi preservado. Confira os anexos manualmente.")
        def marcar(item: Dict[str, Any]) -> None:
            pendentes = list(item.get("pdf_remocao") or [])
            if not somente_pendentes and item.get("pdf"):
                pendentes.append(item.pop("pdf"))
            item.update(pdf_remocao=pendentes, atualizado_em=agora_iso())

        item = _alterar(state_dir, numero, marcar)
        try:
            for pdf in item["pdf_remocao"]:
                caminho = _caminho_pdf(state_dir, numero, pdf)
                if caminho is None:
                    raise DomainBusyError("A referência do PDF a remover é inválida; confira os anexos manualmente.")
                if isinstance(pdf, dict) and pdf.get("versao"):
                    if caminho.parent.exists():
                        shutil.rmtree(caminho.parent)
                else:
                    caminho.unlink(missing_ok=True)
        except OSError as error:
            raise DomainBusyError("A remoção do PDF está pendente. Use Tentar remover novamente; o pedido foi preservado.") from error
        return _alterar(state_dir, numero, lambda item: item.pop("pdf_remocao", None))


def _apagar_pasta(pasta: Path) -> None:
    if pasta.is_dir():
        shutil.rmtree(pasta, ignore_errors=True)


def _caminho_pdf(state_dir: Path, numero: str, pdf: Any) -> Optional[Path]:
    if not isinstance(pdf, dict) or not pdf.get("nome"):
        return None
    if re.search(r"[/\\]", str(pdf["nome"])):
        return None
    pasta = pasta_anexos(state_dir, numero)
    if pdf.get("versao"):
        if not re.fullmatch(r"[a-f0-9]{32}", str(pdf["versao"])):
            return None
        pasta /= str(pdf["versao"])
        if pasta.resolve(strict=False).parent != pasta_anexos(state_dir, numero).resolve(strict=False):
            return None
    candidato = pasta / str(pdf["nome"])
    return candidato if candidato.resolve(strict=False).parent == pasta.resolve(strict=False) else None


def dados_para_finalizar(state_dir: Path, numero: str) -> Tuple[str, Optional[Path]]:
    """Text and PDF of the ticket as stored NOW (read at run time, never taken from the job file)."""
    item = ler_estado(state_dir).get(numero, {})
    descricao = str(item.get("descricao_finalizacao") or "").strip()
    caminho = _caminho_pdf(state_dir, numero, item.get("pdf"))
    return descricao, caminho if caminho is not None and caminho.is_file() else None


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


def finalizados_no_dashboard(state_dir: Path) -> List[Dict[str, Any]]:
    """The newest ``MAX_FINALIZADOS_NO_DASHBOARD`` tickets this site finalized in SoftExpert (status ``ok``), newest first, with the card saved before finalizing.

    They leave the open lists as soon as SoftExpert confirms, whether or not the imported Dashboard shows them closed yet.
    """
    achados = []
    for numero, item in ler_estado(state_dir).items():
        fin = item.get("finalizacao")
        if isinstance(fin, dict) and fin.get("status") == STATUS_OK:
            ficha = item.get("ficha")
            pdf = item.get("pdf")
            achados.append({
                "numero": numero, "encerrado_em": str(fin.get("encerrado_em") or ""), "em": str(fin.get("em") or ""),
                "descricao": str(item.get("descricao_finalizacao") or ""), "ficha": ficha if isinstance(ficha, dict) else None,
                "pdf": str(pdf.get("nome") or "") if isinstance(pdf, dict) else "",
                **({"pdf_remocao_pendente": True} if item.get("pdf_remocao") else {}),
            })
    return sorted(achados, key=lambda a: str(a["em"]), reverse=True)[:MAX_FINALIZADOS_NO_DASHBOARD]


def publico(item: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    """What the screen shows of a ticket's state."""
    item = item or {}
    pdf = item.get("pdf")
    fin = item.get("finalizacao")
    return {
        **({"pdf_remocao_pendente": True} if item.get("pdf_remocao") else {}),
        "descricao_finalizacao": str(item.get("descricao_finalizacao") or ""),
        # False = nunca houve descrição guardada (campo ausente); texto apagado pelo usuário é "" guardado, e aí vale True
        "descricao_definida": "descricao_finalizacao" in item,
        "descricao_editada": str(item.get("descricao_editada") or ""),
        "pdf": {"nome": str(pdf.get("nome") or ""), "tamanho": int(pdf.get("tamanho") or 0)} if isinstance(pdf, dict) else None,
        "finalizacao": {k: str(fin.get(k) or "") for k in ("status", "em", "encerrado_em")} if isinstance(fin, dict) else None,
    }


# ---------------------------------------------------------------------------- job and result

def gravar_job(
    state_dir: Path, numeros: Sequence[str], *, confirmar_final: bool = True, pulados: Sequence[Mapping[str, str]] = (),
    acao: str = ACAO_FINALIZAR, envio_id: str = "", sha256: str = "",
) -> None:
    """Request for the next ``fechar`` run; the routine consumes it. ``--sem-finalizar`` can still force a dry run."""
    with lock_paths([state_dir / "sebrae_dashboard_base.guard", caminho_envio(state_dir), caminho_job(state_dir)]):
        if acao == ACAO_REENVIAR:
            exigir_envio_livre(state_dir)
        if acao == ACAO_REENVIAR_SNAPSHOT:
            validar_reenvio_snapshot(state_dir, envio_id, sha256)
            if job_pendente(state_dir):
                raise DomainConflictError("Já há um pedido aguardando a automação.")
        atomic_write_json(caminho_job(state_dir), {
            "criado_em": agora_iso(), "acao": acao, "numeros": list(numeros), "confirmar_final": bool(confirmar_final),
            "pulados": [dict(p) for p in pulados],
            **({"envio_id": envio_id, "sha256": sha256} if acao == ACAO_REENVIAR_SNAPSHOT else {}),
        })


def apagar_job(state_dir: Path) -> None:
    caminho_job(state_dir).unlink(missing_ok=True)


def _job_valido(job: Mapping[str, Any], agora: Optional[datetime]) -> bool:
    """``criado_em`` legível e com menos de ``JOB_VALIDADE``."""
    try:
        criado = datetime.fromisoformat(str(job.get("criado_em")))
        if criado.tzinfo is None:
            criado = criado.replace(tzinfo=FUSO)
        idade = (agora or agora_local()) - criado
    except (ValueError, TypeError):
        return False
    return timedelta(0) <= idade <= JOB_VALIDADE


def consumir_job(state_dir: Path, agora: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The job, deleted on reading; ``None`` when there is none, it is unreadable or older than ``JOB_VALIDADE``."""
    caminho = caminho_job(state_dir)
    with lock_paths([caminho]):
        job = _ler_json(caminho)
        caminho.unlink(missing_ok=True)
    if job is None or not _job_valido(job, agora):
        return None
    numeros = job.get("numeros")
    if not isinstance(numeros, list) or job.get("acao") not in (ACAO_FINALIZAR, ACAO_REENVIAR, ACAO_REENVIAR_SNAPSHOT):
        return None
    return {
        "acao": job["acao"], "numeros": [str(n) for n in numeros], "confirmar_final": job.get("confirmar_final") is not False,
        "pulados": [p for p in job.get("pulados") or [] if isinstance(p, dict)],
        **({"envio_id": str(job.get("envio_id") or ""), "sha256": str(job.get("sha256") or "")} if job["acao"] == ACAO_REENVIAR_SNAPSHOT else {}),
    }


def job_pendente(state_dir: Path, agora: Optional[datetime] = None) -> bool:
    """A valid job is waiting for its routine to consume it (a second request would overwrite it)."""
    job = _ler_json(caminho_job(state_dir))
    return job is not None and _job_valido(job, agora)


def gravar_resultado(state_dir: Path, resultado: Mapping[str, Any]) -> None:
    try:
        ler_envio(state_dir)  # Migrate an old cleanup notice before replacing a transient job result.
    except DomainBusyError:
        if not caminho_envio(state_dir).exists():
            raise  # Legacy-notice migration failed to write: keep the old notice instead of overwriting it.
        # The existing send record is unreadable/invalid; it stays for manual review and must not block the job result.
    atomic_write_json(caminho_resultado(state_dir), resultado)


def ler_resultado(state_dir: Path) -> Optional[Dict[str, Any]]:
    return _ler_json(caminho_resultado(state_dir))


# ---------------------------------------------------------------------------- SharePoint: sent hash, pending copy, notice


def _gravar_envio(state_dir: Path, registro: Mapping[str, Any]) -> None:
    try:
        atomic_write_json(state_dir / "sebrae_dashboard_envios" / str(registro["id"]) / "registro.json", registro)
        atomic_write_json(caminho_envio(state_dir), registro)
    except (OSError, FileBusyError, FileTransactionError) as error:
        raise DomainBusyError("Não foi possível guardar a confirmação do envio. Confira o SharePoint manualmente antes de repetir.") from error


def ler_envio(state_dir: Path) -> Optional[Dict[str, Any]]:
    with lock_paths([caminho_envio(state_dir)]):
        try:
            registro = json.loads(caminho_envio(state_dir).read_text(encoding="utf-8"))
        except FileNotFoundError:
            antigo = (ler_resultado(state_dir) or {}).get("sharepoint")
            if not isinstance(antigo, dict) or not antigo.get("limpeza_pendente"):
                return None
            registro = {"id": uuid.uuid4().hex, "status": "confirmado", "sha256": "", "legado": True, "copias": [], "limpeza_pendente": True}
            _gravar_envio(state_dir, registro)
        except (OSError, ValueError) as error:
            raise DomainBusyError("O registro de envio está ilegível. Foi preservado; confira o SharePoint manualmente antes de repetir.") from error
        if (not isinstance(registro, dict) or not re.fullmatch(r"[a-f0-9]{32}", str(registro.get("id", "")))
                or registro.get("status") not in ("preparado", "incerto", "confirmado", "concluido", "falhou")
                or not isinstance(registro.get("sha256"), str) or not isinstance(registro.get("copias"), list)
                or not isinstance(registro.get("limpeza_pendente"), bool)
                or not isinstance(registro.get("snapshot", False), bool)
                or not isinstance(registro.get("reenvio_snapshot", False), bool)
                or (registro.get("recuperacao") is not None and not isinstance(registro["recuperacao"], dict))
                or not isinstance(registro.get("resolucoes", []), list)
                or registro["limpeza_pendente"] != (registro["status"] in ("preparado", "incerto", "confirmado"))
                or not (re.fullmatch(r"[a-f0-9]{64}", registro["sha256"]) or (registro.get("legado") is True and registro["sha256"] == ""))
                or any(not isinstance(copia, dict) or not isinstance(copia.get("nome"), str)
                       or Path(copia["nome"]).name != copia["nome"] or not re.fullmatch(r"[a-f0-9]{64}", str(copia.get("sha256", "")))
                       for copia in registro["copias"])):
            raise DomainBusyError("O registro de envio tem estrutura inválida. Foi preservado; confira o SharePoint manualmente antes de repetir.")
        return registro


def envio_do_id(state_dir: Path, envio_id: str) -> Dict[str, Any]:
    registro = ler_envio(state_dir)
    if registro is None or registro["id"] != envio_id:
        raise DomainConflictError("O envio mudou. Recarregue a tela antes de continuar.")
    return registro


def snapshot_envio(state_dir: Path, envio_id: str) -> Path:
    with lock_paths([caminho_envio(state_dir)]):
        registro = envio_do_id(state_dir, envio_id)
        caminho = state_dir / "sebrae_dashboard_envios" / envio_id / NOME_DASHBOARD
        if not registro.get("snapshot"):
            raise DomainConflictError("Este envio antigo não tem cópia privada verificável. Nenhum arquivo será apagado; preserve as cópias para conferência manual.")
        try:
            conteudo = caminho.read_bytes()
        except FileNotFoundError as error:
            raise DomainConflictError("A cópia privada do envio não foi encontrada; a recuperação foi bloqueada.") from error
        except OSError as error:
            raise DomainBusyError("A cópia privada do envio não pôde ser lida; tente novamente.") from error
        if hashlib.sha256(conteudo).hexdigest() != registro["sha256"]:
            raise DomainConflictError("A cópia privada do envio foi alterada; a recuperação foi bloqueada.")
        return caminho


def conteudo_snapshot_envio(state_dir: Path, envio_id: str) -> bytes:
    with lock_paths([caminho_envio(state_dir)]):
        conteudo = snapshot_envio(state_dir, envio_id).read_bytes()
        if hashlib.sha256(conteudo).hexdigest() != envio_do_id(state_dir, envio_id)["sha256"]:
            raise DomainConflictError("A cópia privada mudou durante a leitura; a recuperação foi bloqueada.")
        return conteudo


def base_importada(state_dir: Path) -> str:
    """SHA-256 of the Dashboard the site last imported (``""`` when none): the base every output copy is built on."""
    importado = sebrae_novos.ler_existentes(sebrae_novos.caminhos_padrao(state_dir).existentes)
    return importado["sha256"] if importado else ""


def validar_reenvio_snapshot(state_dir: Path, envio_id: str, sha256: str) -> Path:
    with lock_paths([caminho_envio(state_dir)]):
        registro = envio_do_id(state_dir, envio_id)
        if (registro["status"] != "falhou" or (registro.get("recuperacao") or {}).get("acao") != "declarar_nao_enviado"
                or not re.fullmatch(r"[a-f0-9]{64}", sha256) or registro["sha256"] != sha256):
            raise DomainConflictError("Este ID/hash não está liberado por uma declaração de não enviado. Recarregue e confira esta cópia.")
        base = registro.get("base_sha256")
        if not base or base != base_importada(state_dir):
            raise DomainConflictError(
                "A cópia deste envio foi gerada antes da última importação do Dashboard; reenviá-la apagaria o que mudou no SharePoint. "
                "Use Atualizar Dashboard e Enviar ao SharePoint; a cópia deste envio continua guardada.")
        return snapshot_envio(state_dir, envio_id)


def retomar_envio_snapshot(state_dir: Path, envio_id: str, sha256: str) -> Path:
    with lock_paths([state_dir / "sebrae_dashboard_base.guard", caminho_envio(state_dir)]):
        caminho = validar_reenvio_snapshot(state_dir, envio_id, sha256)
        registro = envio_do_id(state_dir, envio_id)
        registro.update(status="preparado", limpeza_pendente=True, reenvio_snapshot=True, copias=[])
        registro["resolucoes"] = [*(registro.get("resolucoes") or []), {"acao": ACAO_REENVIAR_SNAPSHOT, "em": agora_iso()}]
        _gravar_envio(state_dir, registro)
        return caminho


def exigir_envio_livre(state_dir: Path) -> None:
    registro = ler_envio(state_dir)
    if registro and registro["status"] not in ("falhou", "concluido"):
        raise DomainConflictError("Há um envio confirmado com limpeza pendente ou um envio incerto. Confira o registro e o SharePoint manualmente antes de reenviar; nenhuma cópia foi apagada.")


def preparar_envio(state_dir: Path, conteudo: bytes, *, pendente: Optional[Path] = None) -> str:
    with lock_paths([caminho_envio(state_dir), state_dir / "sebrae_dashboard_pendente.guard"]):
        exigir_envio_livre(state_dir)
        sha = hashlib.sha256(conteudo).hexdigest()
        try:
            arquivos = _pendentes_ordenados(state_dir)
        except DomainConflictError:
            if pendente is not None:
                raise
            arquivos = []  # An independent send can proceed, but ambiguous old copies are never covered.
        if pendente is not None and (not arquivos or arquivos[0][1] != pendente or pendente.read_bytes() != conteudo):
            raise DomainConflictError("A cópia pendente mudou antes do envio. Confira a lista novamente.")
        copias = []
        for _, caminho in arquivos:
            digest = hashlib.sha256(caminho.read_bytes()).hexdigest()
            if digest == sha:
                copias.append({"nome": caminho.name, "sha256": digest})
        envio = uuid.uuid4().hex
        try:
            atomic_write_bytes(state_dir / "sebrae_dashboard_envios" / envio / NOME_DASHBOARD, conteudo)
        except (OSError, FileBusyError, FileTransactionError) as error:
            raise DomainBusyError("Não foi possível preservar a cópia privada antes do envio. Nada foi enviado.") from error
        _gravar_envio(state_dir, {
            "id": envio, "status": "preparado", "sha256": sha, "copias": copias, "limpeza_pendente": True, "snapshot": True,
            "base_sha256": base_importada(state_dir),
        })
        return envio


def marcar_envio_incerto(state_dir: Path, envio: str) -> None:
    with lock_paths([caminho_envio(state_dir)]):
        registro = ler_envio(state_dir)
        if registro is None or registro["id"] != envio or registro["status"] != "preparado":
            raise DomainConflictError("O pedido de envio mudou; nada foi enviado.")
        snapshot_envio(state_dir, envio)
        registro["status"] = "incerto"
        _gravar_envio(state_dir, registro)


def cancelar_envio_preparado(state_dir: Path, envio: str) -> None:
    with lock_paths([caminho_envio(state_dir)]):
        registro = ler_envio(state_dir)
        if registro and registro["id"] == envio and registro["status"] == "preparado":
            registro.update(status="falhou", limpeza_pendente=False)
            _gravar_envio(state_dir, registro)


def confirmar_envio(state_dir: Path, envio: str) -> None:
    with lock_paths([caminho_envio(state_dir)]):
        registro = ler_envio(state_dir)
        if registro is None or registro["id"] != envio or registro["status"] not in ("incerto", "confirmado", "concluido"):
            raise DomainConflictError("Não há confirmação confiável deste envio. Confira o SharePoint manualmente.")
        if registro["status"] == "incerto":
            registro["status"] = "confirmado"
            _gravar_envio(state_dir, registro)


def recuperar_envio(
    state_dir: Path, envio_id: str, acao: str, *, confirmacao: str = "", em_andamento: Callable[[], bool] = lambda: False,
) -> Dict[str, Any]:
    """Local operator declaration/retry; this function never uploads or creates a job."""
    if em_andamento():
        raise DomainConflictError("Aguarde a rotina em andamento antes de recuperar o envio.")
    with lock_paths([state_dir / "sebrae_dashboard_base.guard", caminho_job(state_dir), caminho_envio(state_dir), state_dir / "sebrae_dashboard_pendente.guard"]):
        if em_andamento() or job_pendente(state_dir):
            raise DomainConflictError("Aguarde a rotina em andamento antes de recuperar o envio.")
        registro = envio_do_id(state_dir, envio_id)
        if acao == "concluir_legado":
            resolvido = registro["status"] == "concluido" and (registro.get("recuperacao") or {}).get("acao") == acao
            if (registro.get("legado") is not True or registro.get("snapshot") or (registro["status"] != "confirmado" and not resolvido)
                    or confirmacao != f"CONFIRMO LEGADO CONFERIDO E ARQUIVOS PRESERVADOS {envio_id}"):
                raise DomainConflictError("Confira o legado confirmado e declare o ID e a preservação dos arquivos antes de concluir.")
            try:
                pasta = pasta_pendente(state_dir)
                if pasta.exists() and any(pasta.iterdir()):
                    raise DomainConflictError("A pasta pendente ainda contém arquivos ou subpastas. Preserve e mova todos para fora dela manualmente antes de concluir.")
            except OSError as error:
                raise DomainBusyError("Não foi possível confirmar que a pasta pendente está vazia. Nada foi alterado.") from error
            if not resolvido:
                registro.update(status="concluido", limpeza_pendente=False, recuperacao={"acao": acao, "em": agora_iso()})
                registro["resolucoes"] = [*(registro.get("resolucoes") or []), registro["recuperacao"]]
                _gravar_envio(state_dir, registro)
            return {"envio_id": envio_id, "status": "concluido", "sharepoint": aviso_do_pendente(state_dir)}
        conteudo = conteudo_snapshot_envio(state_dir, envio_id)
        if acao == "limpar":
            if registro["status"] not in ("confirmado", "concluido"):
                raise DomainConflictError("Este envio ainda exige a declaração explícita de conferência no SharePoint.")
        elif acao in ("confirmar_recebimento", "declarar_nao_enviado"):
            if registro["status"] not in ("incerto", "preparado"):
                raise DomainConflictError("Este envio já foi reconciliado. Recarregue a tela.")
            frase = "CONFIRMO APLICADO" if acao == "confirmar_recebimento" else "CONFIRMO NAO APLICADO"
            if confirmacao != f"{frase} {envio_id}":
                raise DomainConflictError("Digite a declaração completa com o ID deste envio após conferir seu conteúdo no SharePoint.")
            if acao == "confirmar_recebimento":
                gravar_enviado(state_dir, registro["sha256"], conteudo)
            registro.update(status="confirmado" if acao == "confirmar_recebimento" else "falhou", limpeza_pendente=acao == "confirmar_recebimento")
        else:
            raise DomainValidationError("A ação de recuperação é inválida.", status_code=422)
        registro["recuperacao"] = {"acao": acao, "em": agora_iso()}
        registro["resolucoes"] = [*(registro.get("resolucoes") or []), registro["recuperacao"]]
        _gravar_envio(state_dir, registro)
        if acao != "declarar_nao_enviado":
            try:
                descartar_pendentes(state_dir, envio_id=envio_id)
            except (OSError, FileBusyError, FileTransactionError) as error:
                logger.warning("Envio confirmado; limpeza pendente após recuperação (erro=%s).", type(error).__name__)
        atual = envio_do_id(state_dir, envio_id)
        return {"envio_id": envio_id, "status": atual["status"], "sharepoint": aviso_do_pendente(state_dir)}

def gravar_enviado(state_dir: Path, sha256: str, conteudo: Optional[bytes] = None) -> None:
    """Hash (and copy) of the Dashboard this site last put on SharePoint; the next ``enviar`` accepts exactly that file as "unchanged".

    The copy matters because SharePoint re-serializes the xlsx after an upload (new hash, same values): the next check compares values.
    """
    if conteudo is not None:
        atomic_write_bytes(caminho_copia_enviada(state_dir), conteudo)
    atomic_write_json(caminho_enviado(state_dir), {"sha256": sha256, "enviado_em": agora_iso()})


def ler_copia_enviada(state_dir: Path) -> Optional[bytes]:
    """The copy saved by ``gravar_enviado``, only if it still matches the recorded hash."""
    caminho = caminho_copia_enviada(state_dir)
    sha256 = ler_enviado(state_dir)
    if not sha256 or not caminho.is_file():
        return None
    conteudo = caminho.read_bytes()
    return conteudo if hashlib.sha256(conteudo).hexdigest() == sha256 else None


def ler_enviado(state_dir: Path) -> str:
    return str((_ler_json(caminho_enviado(state_dir)) or {}).get("sha256") or "")


def nome_pendente(momento: datetime, ordem_criacao: int) -> str:
    return f"{Path(NOME_DASHBOARD).stem} (pendente {momento.astimezone(FUSO):%Y-%m-%d %H%M%S}-n{ordem_criacao}).xlsx"


def _ordem_pendente(caminho: Path) -> int:
    achado = _NOME_PENDENTE.fullmatch(caminho.name)
    if achado is not None:
        ordem = achado["ordem"] or ""
        if ordem.startswith("n"):
            return int(ordem[1:])
        try:
            momento = datetime.strptime(f"{achado['data']} {achado['hora'].ljust(6, '0')}", "%Y-%m-%d %H%M%S").replace(tzinfo=FUSO)
            return int(momento.timestamp()) * 1_000_000_000
        except ValueError:
            pass
    raise DomainConflictError("Há cópias pendentes sem ordem de criação confiável. Confira-as manualmente antes de reenviar; nenhuma cópia foi apagada.")


def _pendentes_ordenados(state_dir: Path) -> List[Tuple[int, Path]]:
    arquivos = [(_ordem_pendente(caminho), caminho) for caminho in pasta_pendente(state_dir).glob("*.xlsx")]
    if len({ordem for ordem, _ in arquivos}) != len(arquivos):
        raise DomainConflictError("Há cópias pendentes com ordem de criação ambígua. Confira-as manualmente antes de reenviar; nenhuma cópia foi apagada.")
    return sorted(arquivos, key=lambda item: item[0], reverse=True)


def guardar_pendente(
    state_dir: Path, origem: Path, momento: datetime, *, motivo: str, tickets: Sequence[str], copia_sharepoint: bool = False,
) -> Path:
    """Copies ``origem`` to ``sebrae_dashboard_pendente/`` with the pending name plus a JSON record of what is missing."""
    pasta = pasta_pendente(state_dir)
    with lock_paths([state_dir / "sebrae_dashboard_pendente.guard"]):
        ordens = []
        for caminho in pasta.glob("*.xlsx"):
            try:
                ordens.append(_ordem_pendente(caminho))
            except DomainConflictError:
                pass  # Preserve an unorderable old copy without blocking storage of the new snapshot.
        ordem = max(time.time_ns(), max(ordens, default=0) + 1)
        destino = pasta / nome_pendente(momento, ordem)
        atomic_write_bytes(destino, Path(origem).read_bytes())
        atomic_write_json(destino.with_suffix(".json"), {
            "arquivo": destino.name, "criado_em": agora_iso(), "ordem_criacao": ordem, "motivo": motivo, "chamados": list(tickets),
            "copia_sharepoint": copia_sharepoint, "base_sha256": base_importada(state_dir),
        })
    return destino


def pendente_mais_recente(state_dir: Path) -> Optional[Tuple[Path, Dict[str, Any]]]:
    with lock_paths([state_dir / "sebrae_dashboard_pendente.guard"]):
        arquivos = _pendentes_ordenados(state_dir)
        if not arquivos:
            return None
        caminho = arquivos[0][1]
        return caminho, _ler_json(caminho.with_suffix(".json")) or {}


def marcar_copia_sharepoint(pendente: Path) -> None:
    registro = _ler_json(pendente.with_suffix(".json")) or {}
    registro["copia_sharepoint"] = True
    atomic_write_json(pendente.with_suffix(".json"), registro)


def descartar_pendente(pendente: Path) -> None:
    pendente.unlink(missing_ok=True)
    pendente.with_suffix(".json").unlink(missing_ok=True)


def descartar_pendentes(state_dir: Path, *, envio_id: Optional[str] = None) -> bool:
    """Only captured identities covered by a confirmed send may be removed."""
    with lock_paths([caminho_envio(state_dir), state_dir / "sebrae_dashboard_pendente.guard"]):
        registro = ler_envio(state_dir)
        if envio_id is not None:
            registro = envio_do_id(state_dir, envio_id)
        if registro and registro.get("reenvio_snapshot") and registro["status"] in ("confirmado", "concluido"):
            snapshot_envio(state_dir, registro["id"])
            pasta = pasta_pendente(state_dir)
            limpas = not pasta.exists() or not any(pasta.iterdir())
            registro.update(status="concluido" if limpas else "confirmado", limpeza_pendente=not limpas)
            _gravar_envio(state_dir, registro)
            return limpas
        try:
            arquivos = _pendentes_ordenados(state_dir)
        except DomainConflictError as error:
            logger.warning("A limpeza das cópias pendentes foi adiada: %s", error.detail)
            return False
        if not registro or registro["status"] not in ("confirmado", "concluido"):
            return not arquivos
        snapshot_envio(state_dir, registro["id"])
        cobertas = {copia["nome"]: copia["sha256"] for copia in registro["copias"]}
        for _, caminho in arquivos:
            if cobertas.get(caminho.name) == registro["sha256"] == hashlib.sha256(caminho.read_bytes()).hexdigest():
                descartar_pendente(caminho)
        limpas = not any(pasta_pendente(state_dir).glob("*.xlsx"))
        registro.update(status="concluido" if limpas else "confirmado", limpeza_pendente=not limpas)
        _gravar_envio(state_dir, registro)
        return limpas


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
    envio = ler_envio(state_dir)
    if envio and (envio["status"] not in ("falhou", "concluido") or envio.get("recuperacao")):
        snapshot = state_dir / "sebrae_dashboard_envios" / envio["id"] / NOME_DASHBOARD
        return {**aviso_sharepoint(False), "limpeza_pendente": envio["limpeza_pendente"], "incerto": envio["status"] in ("preparado", "incerto"),
                "envio_id": envio["id"], "status": envio["status"], "snapshot_disponivel": bool(envio.get("snapshot") and snapshot.is_file()),
                "sha256": envio["sha256"], "legado": envio.get("legado") is True, "pasta_pendente": str(pasta_pendente(state_dir)),
                "reenvio_confirmado": bool(envio.get("reenvio_snapshot") and envio["status"] in ("confirmado", "concluido")),
                "recuperacao": envio.get("recuperacao"), "resolucoes": envio.get("resolucoes") or []}
    try:
        achado = pendente_mais_recente(state_dir)
    except DomainConflictError as error:
        return aviso_sharepoint(True, str(error.detail))
    if achado is None:
        return None
    arquivo, registro = achado
    return aviso_sharepoint(True, str(registro.get("motivo") or ""), str(arquivo), bool(registro.get("copia_sharepoint")))
