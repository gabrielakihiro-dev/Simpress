"""State and rows of the Dashboard-import flow (docs/operacao/sincronizar-chamados-sebrae.md, "Tela no site").

Two small JSON files in ``data/state`` (outside Git): the ticket numbers already logged in the imported
Dashboard, and the new tickets read from SoftExpert (CPF and passwords already masked). The site shows a
form per new ticket and returns the rows to paste. Beside the first file sits a copy of the imported ``.xlsx``:
"Atualizar Dashboard" writes into a COPY of it (domains/sebrae_dashboard_gravacao.py); the original is never touched.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from domains import sebrae_cruzamento, sebrae_vinculos
from domains.sebrae_chamados import ChamadoSoftExpert, mascarar_cpfs
from domains.sebrae_dashboard import (
    CRUZ_AUSENTE,
    CRUZ_UNICO,
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
    historico: Path


def caminhos_padrao(state_dir: Path) -> Caminhos:
    return Caminhos(
        state_dir / "sebrae_dashboard_existentes.json", state_dir / "sebrae_novos.json",
        state_dir / "sebrae_historico.json",
    )


def caminho_planilha(caminhos: Caminhos) -> Path:
    """Copy of the imported Dashboard, next to the file that lists its ticket numbers."""
    return caminhos.existentes.with_name("sebrae_dashboard_importado.xlsx")


def caminho_saida(caminhos: Caminhos, nome: str) -> Path:
    """Last file produced by "Atualizar Dashboard"; the ``enviar`` routine uploads this one, never a file from Downloads."""
    return caminhos.existentes.with_name("sebrae_dashboard_saida") / nome


def caminho_arquivo(caminhos: Caminhos) -> Path:
    """Archive of the tickets that left the open list (domains/sebrae_arquivo.py), next to the import state."""
    return caminhos.existentes.with_name("sebrae_chamados_encerrados.json")


def _gravar(caminho: Path, dados: Mapping[str, Any]) -> None:
    _gravar_bytes(caminho, json.dumps(dados, ensure_ascii=False, indent=1).encode("utf-8"))


def _gravar_bytes(caminho: Path, conteudo: bytes) -> None:
    caminho.parent.mkdir(parents=True, exist_ok=True)
    descritor, temporario = tempfile.mkstemp(dir=caminho.parent, suffix=".tmp")
    try:
        with os.fdopen(descritor, "wb") as arquivo:
            arquivo.write(conteudo)
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

def salvar_existentes(
    caminho: Path,
    numeros: Iterable[str],
    arquivo: str,
    importado_em: str = "",
    sha256: str = "",
    listas: Optional[Mapping[str, Sequence[str]]] = None,
    abertos: Sequence[Mapping[str, Any]] = (),
) -> int:
    """``sha256``/``listas``/``abertos`` describe the stored copy (see ``salvar_planilha``): the hash guards the
    copy, ``listas`` feeds the A and B selects, ``abertos`` are the old tickets that can still be edited."""
    ordenados = sorted(set(numeros))
    # names stay (the match by name needs them); CPF and passwords never reach the file
    seguros = [{**a, **{k: _seguro(a[k]) for k in ("titulo", "descricao", "usuario") if k in a}} for a in abertos]
    _gravar(caminho, {
        "arquivo": arquivo[:200], "importado_em": importado_em or agora_iso(), "numeros": ordenados,
        "sha256": sha256, "listas": {k: list(v) for k, v in (listas or {}).items()}, "abertos": seguros,
    })
    return len(ordenados)


def ler_existentes(caminho: Path) -> Optional[Dict[str, Any]]:
    dados = _ler(caminho)
    if dados is None or not isinstance(dados.get("numeros"), list):
        return None
    listas = dados.get("listas")
    abertos = dados.get("abertos")
    listas = listas if isinstance(listas, dict) else {}
    abertos = abertos if isinstance(abertos, list) else []
    return {"arquivo": str(dados.get("arquivo") or ""), "importado_em": str(dados.get("importado_em") or ""),
            "numeros": frozenset(str(n) for n in dados["numeros"]), "sha256": str(dados.get("sha256") or ""),
            "listas": {str(k): [str(i) for i in v] for k, v in listas.items() if isinstance(v, list)},
            "abertos": [a for a in abertos if isinstance(a, dict)]}


def salvar_planilha(caminho: Path, conteudo: bytes) -> str:
    """Stores the imported Dashboard (atomic) and returns its SHA-256."""
    _gravar_bytes(caminho, conteudo)
    return hashlib.sha256(conteudo).hexdigest()


def ler_planilha(caminho: Path, sha256: str) -> Optional[bytes]:
    """The stored copy, or ``None`` when it is missing or no longer matches the hash saved at import."""
    try:
        conteudo = caminho.read_bytes()
    except OSError:
        return None
    return conteudo if sha256 and hashlib.sha256(conteudo).hexdigest() == sha256 else None


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

def _cruzar(
    chamado: ChamadoSoftExpert, registros: Sequence[Mapping[str, Any]], relatorio: Optional[Mapping[str, Any]],
    vinculos: Sequence[Mapping[str, Any]] = (),
) -> Tuple[Cruzamento, str]:
    outra = sebrae_cruzamento.outra_pessoa(chamado.descricao, chamado.solicitante, registros)
    cruzamento = cruzar_por_nome(chamado.solicitante, registros) if registros and not outra else Cruzamento(CRUZ_AUSENTE)
    # a manual link of the ticket table wins over the OS of the serial
    os_ = sebrae_vinculos.os_do_chamado(vinculos, chamado.numero) or (
        sebrae_cruzamento.os_da_serie(relatorio, cruzamento.serie) if cruzamento.serie else "")
    return cruzamento, os_


def formulario(
    chamados: Sequence[ChamadoSoftExpert],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
    vinculos: Sequence[Mapping[str, Any]] = (),
) -> List[Dict[str, Any]]:
    """One item per new ticket: the automatic columns, the cross-reference status and its candidate count."""
    itens = []
    for chamado in chamados:
        cruzamento, os_ = _cruzar(chamado, registros, relatorio, vinculos)
        itens.append({
            "numero": chamado.numero,
            "linha": montar_linha(chamado, cruzamento, os_),
            "cruzamento": {"status": cruzamento.status, "candidatos": cruzamento.candidatos},
            "outra_pessoa": sebrae_cruzamento.outra_pessoa(chamado.descricao, chamado.solicitante, registros),
        })
    return itens


def preenchimentos(
    abertos: Sequence[Mapping[str, Any]],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
    vinculos: Sequence[Mapping[str, Any]] = (),
) -> Dict[str, Dict[str, str]]:
    """E, K, L and N still empty in old open tickets: the unique equipment of the name in column I gives K, L and N;
    E is the latest OS of the serial the row has or just got. K, L and N are never mixed with a different serial
    already in the row. A manual ``vinculos`` entry of the row's UTIC gives E first, even without a serial. ``abertos`` are ``ChamadoAberto.como_dict()`` items; keys of the result are their ``numero``.
    shortcut: serials compare as upper-case text (no MacBook ``S`` prefix rule), upgrade if one row misses a fill because of it."""
    resultado: Dict[str, Dict[str, str]] = {}
    for item in abertos:
        atuais = {letra: str(valor or "").strip() for letra, valor in (item.get("automaticos") or {}).items()}
        usuario = str(item.get("usuario") or "")
        para_outra_pessoa = bool(sebrae_cruzamento.outra_pessoa(item.get("descricao"), usuario, registros))
        # opened for someone else: no equipment by name (the user fills it by hand); a serial the row already has still gives E
        cruzamento = cruzar_por_nome(usuario, registros) if usuario and registros and not para_outra_pessoa else Cruzamento(CRUZ_AUSENTE)
        serie_atual = atuais.get("K", "")
        coerente = cruzamento.status == CRUZ_UNICO and (not serie_atual or serie_atual.upper() == cruzamento.serie.strip().upper())
        novos = {"K": cruzamento.serie, "L": cruzamento.modelo, "N": cruzamento.cidade} if coerente else {}
        serie = serie_atual or (cruzamento.serie if coerente else "")
        os_vinculada = sebrae_vinculos.os_do_chamado(vinculos, str(item.get("numero") or ""))
        if os_vinculada:
            novos["E"] = os_vinculada
        elif serie:
            novos["E"] = sebrae_cruzamento.os_da_serie(relatorio, serie)
        faltam = {letra: _texto_de_celula(valor) for letra, valor in novos.items() if valor and not atuais.get(letra)}
        if faltam:
            resultado[str(item.get("numero") or "")] = faltam
    return resultado


def validar_manuais(manuais: Mapping[str, Any], exigir: bool = True) -> Dict[str, str]:
    """Columns A, B, D, J, R and S as the Dashboard stores them; raises ``ManuaisInvalidos`` with a user message.
    With ``exigir=False`` (Atualizar Dashboard) A, D and J may stay blank; a filled D or J is still restricted."""
    def texto(letra: str) -> str:
        valor = " ".join(str(manuais.get(letra) or "").split())
        if len(valor) > MAX_CAMPO_MANUAL:
            raise ManuaisInvalidos(f"A coluna {letra} aceita até {MAX_CAMPO_MANUAL} caracteres.")
        return _texto_de_celula(valor)

    resultado = {letra: texto(letra) for letra in "ABS"}
    if exigir and not resultado["A"]:
        raise ManuaisInvalidos("Informe o RESPONSÁVEL (coluna A).")
    status = " ".join(str(manuais.get("D") or "").split()).upper()
    if status not in (STATUS_ABERTO, STATUS_FINALIZADO) and (exigir or status):
        raise ManuaisInvalidos("Escolha o STATUS CHAMADO (coluna D): EM ABERTO ou FINALIZADO.")
    tipo = " ".join(str(manuais.get("J") or "").split()).upper()
    if tipo not in TIPOS_CHAMADO and (exigir or tipo):
        raise ManuaisInvalidos("Escolha o TIPO DO CHAMADO (coluna J): INCIDENTE ou SOLICITAÇÃO.")
    encerramento = " ".join(str(manuais.get("R") or "").split())
    if encerramento:
        try:
            datetime.strptime(encerramento, _FORMATO_ENCERRAMENTO)
        except ValueError:
            raise ManuaisInvalidos("DT ENCERRAMENTO (coluna R) deve ser dd/MM/aaaa HH:mm.") from None
    return {**resultado, "D": status, "J": tipo, "R": encerramento}


def validar_listas(manuais: Mapping[str, str], listas: Mapping[str, Sequence[str]], atuais: Optional[Mapping[str, str]] = None) -> None:
    """A and B must come from the LISTAS sheet read at import. An old ticket may keep an off-list value it already has."""
    for letra in "AB":
        valor, opcoes = str(manuais.get(letra) or ""), listas.get(letra) or ()
        if valor and opcoes and valor not in opcoes and valor != str((atuais or {}).get(letra) or ""):
            raise ManuaisInvalidos(f"A coluna {letra} só aceita os valores da lista do Dashboard (aba LISTAS).")


def linhas_completas(
    chamados: Sequence[ChamadoSoftExpert],
    manuais_por_numero: Mapping[str, Mapping[str, Any]],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
    listas: Optional[Mapping[str, Sequence[str]]] = None,
    exigir: bool = True,
    vinculos: Sequence[Mapping[str, Any]] = (),
) -> List[Dict[str, str]]:
    """Full rows (automatic plus manual columns), in the order of ``chamados``. With ``exigir`` every ticket needs
    valid A, D and J; without it (Atualizar Dashboard) blanks pass and a ticket missing from ``manuais_por_numero`` is blank."""
    if not chamados:
        raise ManuaisInvalidos("Não há chamados novos para exportar.")
    linhas: List[Dict[str, str]] = []
    for chamado in chamados:
        if exigir and chamado.numero not in manuais_por_numero:
            raise ManuaisInvalidos(f"Preencha os campos manuais do {chamado.numero}.")
        try:
            manuais = validar_manuais(manuais_por_numero.get(chamado.numero) or {}, exigir)
            validar_listas(manuais, listas or {})
        except ManuaisInvalidos as erro:
            raise ManuaisInvalidos(f"{chamado.numero}: {erro}") from None
        cruzamento, os_ = _cruzar(chamado, registros, relatorio, vinculos)
        linhas.append({**montar_linha(chamado, cruzamento, os_), **manuais})
    return linhas


def exportar(
    chamados: Sequence[ChamadoSoftExpert],
    manuais_por_numero: Mapping[str, Mapping[str, Any]],
    registros: Sequence[Mapping[str, Any]],
    relatorio: Optional[Mapping[str, Any]],
    listas: Optional[Mapping[str, Sequence[str]]] = None,
    vinculos: Sequence[Mapping[str, Any]] = (),
) -> Dict[str, Any]:
    """Rows A:P and R:S to paste, in the order of ``chamados``. Every ticket needs valid manual fields."""
    linhas = linhas_completas(chamados, manuais_por_numero, registros, relatorio, listas, vinculos=vinculos)
    bloco_ap, bloco_rs = linhas_para_colar(linhas)
    return {"quantidade": len(linhas), "bloco_a_p": bloco_ap, "bloco_r_s": bloco_rs, "mensagem": MENSAGEM_EXPORTADA}
