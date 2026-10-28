"""State and rows of the Dashboard-import flow (docs/operacao/sincronizar-chamados-sebrae.md, "Tela no site").

Two small JSON files in ``data/state`` (outside Git): the ticket numbers already logged in the imported
Dashboard, and the new tickets read from SoftExpert (CPF and passwords already masked). The site shows a
form per new ticket and returns the rows to paste; nothing is ever written to the Dashboard.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from domains import sebrae_cruzamento
from domains.sebrae_chamados import ChamadoSoftExpert, mascarar_cpfs
from domains.sebrae_dashboard import (
    CRUZ_AUSENTE,
    Cruzamento,
    _texto_de_celula,
    cruzar_por_nome,
    linhas_para_colar,
    montar_linha,
    omitir_credenciais,
)

STATUS_ABERTO = "EM ABERTO"
STATUS_FINALIZADO = "FINALIZADO"
TIPOS_CHAMADO = ("INCIDENTE", "SOLICITAÇÃO")
MAX_CAMPO_MANUAL = 80
_FORMATO_ENCERRAMENTO = "%d/%m/%Y %H:%M"
MENSAGEM_EXPORTADA = "Planilha Exportada com Sucesso!"


class ManuaisInvalidos(ValueError):
    """A manual field is missing or has a value the Dashboard does not accept; the message is for the user."""


@dataclass(frozen=True)
class Caminhos:
    existentes: Path
    novos: Path


def caminhos_padrao(state_dir: Path) -> Caminhos:
    return Caminhos(state_dir / "sebrae_dashboard_existentes.json", state_dir / "sebrae_novos.json")


def _gravar(caminho: Path, dados: Mapping[str, Any]) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    descritor, temporario = tempfile.mkstemp(dir=caminho.parent, suffix=".tmp")
    try:
        with os.fdopen(descritor, "w", encoding="utf-8") as arquivo:
            json.dump(dados, arquivo, ensure_ascii=False, indent=1)
        os.replace(temporario, caminho)
    except BaseException:
        try:
            os.unlink(temporario)
        except OSError:
            pass
        raise


def _ler(caminho: Path) -> Optional[Dict[str, Any]]:
    try:
        dados = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return dados if isinstance(dados, dict) else None


def agora_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------- imported Dashboard

def salvar_existentes(caminho: Path, numeros: Iterable[str], arquivo: str, importado_em: str = "") -> int:
    ordenados = sorted(set(numeros))
    _gravar(caminho, {"arquivo": arquivo[:200], "importado_em": importado_em or agora_iso(), "numeros": ordenados})
    return len(ordenados)


def ler_existentes(caminho: Path) -> Optional[Dict[str, Any]]:
    dados = _ler(caminho)
    if dados is None or not isinstance(dados.get("numeros"), list):
        return None
    return {"arquivo": str(dados.get("arquivo") or ""), "importado_em": str(dados.get("importado_em") or ""),
            "numeros": frozenset(str(n) for n in dados["numeros"])}


# ---------------------------------------------------------------------------- new tickets (read from SoftExpert)

def _seguro(texto: Any) -> str:
    return mascarar_cpfs(omitir_credenciais(texto))


def salvar_novos(
    caminho: Path,
    chamados: Sequence[ChamadoSoftExpert],
    pendentes: Sequence[Tuple[str, str]],
    ignorados: int,
    erros: Mapping[str, str],
    lidos_em: str = "",
) -> None:
    _gravar(caminho, {
        "lidos_em": lidos_em or agora_iso(),
        "ignorados": int(ignorados),
        "pendentes": [{"numero": n, "motivo": m} for n, m in pendentes],
        "erros": {str(n): str(m)[:200] for n, m in erros.items()},
        "chamados": [
            {
                "numero": c.numero, "titulo": _seguro(c.titulo), "descricao": _seguro(c.descricao),
                "solicitante": _seguro(c.solicitante), "habilitada_em": c.habilitada_em,
                "atendimento": _seguro(c.detalhes_atendimento_realizado),
            }
            for c in chamados
        ],
    })


def ler_novos(caminho: Path, ja_lancados: Iterable[str] = ()) -> Optional[Dict[str, Any]]:
    """New tickets minus those the Dashboard already has (a re-import hides what the user pasted)."""
    dados = _ler(caminho)
    if dados is None or not isinstance(dados.get("chamados"), list):
        return None
    lancados = set(ja_lancados)
    chamados = [
        ChamadoSoftExpert(
            numero=str(item.get("numero") or ""), titulo=str(item.get("titulo") or ""),
            descricao=str(item.get("descricao") or ""), solicitante=str(item.get("solicitante") or ""),
            habilitada_em=str(item.get("habilitada_em") or ""),
            detalhes_atendimento_realizado=str(item.get("atendimento") or ""),
        )
        for item in dados["chamados"]
        if isinstance(item, dict) and str(item.get("numero") or "") not in lancados
    ]
    pendentes = [p for p in dados.get("pendentes") or [] if isinstance(p, dict) and p.get("numero") not in lancados]
    return {"lidos_em": str(dados.get("lidos_em") or ""), "ignorados": int(dados.get("ignorados") or 0),
            "pendentes": pendentes, "erros": dados.get("erros") or {}, "chamados": chamados}


# ---------------------------------------------------------------------------- rows

def _cruzar(chamado: ChamadoSoftExpert, registros: Sequence[Mapping[str, Any]], relatorio: Optional[Mapping[str, Any]]) -> Tuple[Cruzamento, str]:
    cruzamento = cruzar_por_nome(chamado.solicitante, registros) if registros else Cruzamento(CRUZ_AUSENTE)
    os_ = sebrae_cruzamento.os_da_serie(relatorio, cruzamento.serie) if cruzamento.serie else ""
    return cruzamento, os_


def formulario(
    chamados: Sequence[ChamadoSoftExpert],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    """One item per new ticket: the automatic columns, the cross-reference status and its candidate count."""
    itens = []
    for chamado in chamados:
        cruzamento, os_ = _cruzar(chamado, registros, relatorio)
        itens.append({
            "numero": chamado.numero,
            "linha": montar_linha(chamado, cruzamento, os_),
            "cruzamento": {"status": cruzamento.status, "candidatos": cruzamento.candidatos},
        })
    return itens


def validar_manuais(manuais: Mapping[str, Any]) -> Dict[str, str]:
    """Columns A, B, D, J, R and S as the Dashboard stores them; raises ``ManuaisInvalidos`` with a user message."""
    def texto(letra: str) -> str:
        valor = " ".join(str(manuais.get(letra) or "").split())
        if len(valor) > MAX_CAMPO_MANUAL:
            raise ManuaisInvalidos(f"A coluna {letra} aceita até {MAX_CAMPO_MANUAL} caracteres.")
        return _texto_de_celula(valor)

    resultado = {letra: texto(letra) for letra in "ABS"}
    if not resultado["A"]:
        raise ManuaisInvalidos("Informe o RESPONSÁVEL (coluna A).")
    status = " ".join(str(manuais.get("D") or "").split()).upper()
    if status not in (STATUS_ABERTO, STATUS_FINALIZADO):
        raise ManuaisInvalidos("Escolha o STATUS CHAMADO (coluna D): EM ABERTO ou FINALIZADO.")
    tipo = " ".join(str(manuais.get("J") or "").split()).upper()
    if tipo not in TIPOS_CHAMADO:
        raise ManuaisInvalidos("Escolha o TIPO DO CHAMADO (coluna J): INCIDENTE ou SOLICITAÇÃO.")
    encerramento = " ".join(str(manuais.get("R") or "").split())
    if encerramento:
        try:
            datetime.strptime(encerramento, _FORMATO_ENCERRAMENTO)
        except ValueError:
            raise ManuaisInvalidos("DT ENCERRAMENTO (coluna R) deve ser dd/MM/aaaa HH:mm.") from None
    return {**resultado, "D": status, "J": tipo, "R": encerramento}


def exportar(
    chamados: Sequence[ChamadoSoftExpert],
    manuais_por_numero: Mapping[str, Mapping[str, Any]],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Rows A:P and R:S to paste, in the order of ``chamados``. Every ticket needs valid manual fields."""
    if not chamados:
        raise ManuaisInvalidos("Não há chamados novos para exportar.")
    linhas: List[Dict[str, str]] = []
    for chamado in chamados:
        if chamado.numero not in manuais_por_numero:
            raise ManuaisInvalidos(f"Preencha os campos manuais do {chamado.numero}.")
        try:
            manuais = validar_manuais(manuais_por_numero[chamado.numero])
        except ManuaisInvalidos as erro:
            raise ManuaisInvalidos(f"{chamado.numero}: {erro}") from None
        cruzamento, os_ = _cruzar(chamado, registros, relatorio)
        linhas.append({**montar_linha(chamado, cruzamento, os_), **manuais})
    bloco_ap, bloco_rs = linhas_para_colar(linhas)
    return {"quantidade": len(linhas), "bloco_a_p": bloco_ap, "bloco_r_s": bloco_rs, "mensagem": MENSAGEM_EXPORTADA}
