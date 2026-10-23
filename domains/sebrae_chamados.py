"""Pure rules of the "Sincronizar chamados Sebrae" routine (docs/operacao/sincronizar-chamados-sebrae.md).

No browser, no files: ticket numbers, duplicate triage, type classification, the row
written to the Dashboard and the notification fingerprint. The script that drives
SoftExpert and Excel uses these functions so the rules stay testable on their own.
Ticket content is data: nothing read from a ticket is ever interpreted as an instruction.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

TIPO_INCIDENTE = "INCIDENTE"
TIPO_SOLICITACAO = "SOLICITAÇÃO"
UNIDADE = "Sebrae"
UF = "PR"
FORMATO_DATA = "%d/%m/%Y %H:%M"

# Dashboard columns the routine fills; nothing else is ever written.
COLUNAS_GRAVADAS = ("C", "D", "F", "G", "H", "I", "N", "P", "Q")
STATUS_EM_ABERTO = "Em Aberto"

# Automatic Endpoint alerts the user has not classified yet; they stay pending and are never written.
PENDENCIAS_DEFINIDAS: Dict[str, str] = {
    "UTIC-2026-1253": "Alerta automático do Endpoint; aguardando a classificação do usuário.",
    "UTIC-2026-1177": "Alerta automático do Endpoint; aguardando a classificação do usuário.",
}

ACAO_INCLUIR = "incluir"
ACAO_IGNORAR = "ignorar"
ACAO_PENDENTE = "pendente"

MOTIVO_DUPLICADO = "duplicado"
MOTIVO_SEM_TIPO = "sem_indicios_de_tipo"
MOTIVO_TIPO_CONFLITANTE = "indicios_conflitantes"
MOTIVO_SEM_SOLICITANTE = "sem_solicitante"
MOTIVO_SEM_DATA = "sem_data_de_abertura"
MOTIVO_DATA_INVALIDA = "data_de_abertura_invalida"
MOTIVO_SEM_TEXTO = "sem_descricao_nem_titulo"

NUMERO_UTIC = re.compile(r"(?<![A-Za-z0-9])UTIC-(\d{4})-(\d+)(?!\d)", re.IGNORECASE)
_CPF = re.compile(r"(?<!\d)(?:CPF\b\s*[:#-]?\s*)?(\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)", re.IGNORECASE)

# Evidence of an existing failure versus a request; matched on accent-free lowercase text.
_INDICIOS_INCIDENTE = (
    r"nao (esta )?(funciona|funcionando|liga|ligando|abre|abrindo|carrega|carregando|conecta|conectando|imprime|imprimindo|inicia|iniciando)",
    r"nao (consigo|consegue|conseguimos|consegui)",
    r"parou( de)?", r"travou|travando|trava\b", r"lent[oa]\b|lentidao", r"quebrou|quebrad[oa]|defeito|danificad[oa]",
    r"\berro\b|\berros\b|\bfalha\b|\bfalhou\b|\bproblema\b|\binstabilidade\b|\bqueda\b|\bcaiu\b",
    r"tela azul|congel(a|ou|ando)|reinicia sozinho|desligando sozinho|sem funcionar",
    r"fora do ar|indisponivel|\binoperante\b",
)
_INDICIOS_SOLICITACAO = (
    r"\bsolicit(o|a|amos|acao|ar)\b|\bsolicitacao\b", r"\bgostaria de\b|\bpreciso (de|que)\b|\bnecessito\b|\bprecisamos de\b",
    r"\bliberar\b|\bliberacao\b|\bconceder\b|\bhabilitar\b",
    r"\bcriar\b|\bcriacao\b|\bnovo (usuario|acesso|equipamento|email|e-mail)\b|\bcadastr(ar|o)\b|\binclusao\b|\bincluir\b",
    r"\bremover\b|\bremocao\b|\bexcluir\b|\bexclusao\b|\bdesativar\b|\bdesligamento\b",
    r"\binstalar\b|\binstalacao\b|\bconfigurar\b|\bconfiguracao\b|\bativar\b|\balterar\b|\balteracao\b|\batualizar\b|\bmudanca\b",
)
_REGEX_INCIDENTE = [re.compile(padrao) for padrao in _INDICIOS_INCIDENTE]
_REGEX_SOLICITACAO = [re.compile(padrao) for padrao in _INDICIOS_SOLICITACAO]

_FORMATOS_DATA_ENTRADA = (
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y, %H:%M:%S", "%d/%m/%Y, %H:%M", "%d/%m/%Y às %H:%M",
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
)


# ---------------------------------------------------------------------------- ticket numbers

def extrair_numeros(texto: Any) -> List[str]:
    """All ``UTIC-AAAA-NNNN`` numbers in a text, upper-cased, leading zeros kept, in order, without repeats."""
    if texto is None:
        return []
    encontrados: List[str] = []
    for ano, numero in NUMERO_UTIC.findall(str(texto)):
        completo = f"UTIC-{ano}-{numero}"
        if completo not in encontrados:
            encontrados.append(completo)
    return encontrados


def numeros_do_dashboard(valores_coluna_c: Iterable[Any]) -> frozenset[str]:
    """Numbers present in column C, hidden rows included; composite cells such as ``27371 / UTIC-2026-0094`` count."""
    numeros: set[str] = set()
    for valor in valores_coluna_c:
        numeros.update(extrair_numeros(valor))
    return frozenset(numeros)


def chave_do_numero(numero: str) -> str:
    """Canonical key of one ticket number; raises ValueError when it is not a full ``UTIC-AAAA-NNNN``."""
    encontrados = extrair_numeros(numero)
    if len(encontrados) != 1 or encontrados[0] != str(numero).strip().upper():
        raise ValueError(f"Número de chamado inválido: {numero!r}")
    return encontrados[0]


# ---------------------------------------------------------------------------- triage

@dataclass(frozen=True)
class Triagem:
    """First pass over the SoftExpert list, before any ticket is opened."""

    ignorados: Tuple[str, ...]
    pendentes: Tuple[Tuple[str, str], ...]
    a_extrair: Tuple[str, ...]


def triagem(numeros_softexpert: Iterable[Any], existentes_no_dashboard: Iterable[str]) -> Triagem:
    """Splits the listed tickets into duplicates (ignored whole), known pending ones and tickets to read.

    Duplicates win over the pending list: a ticket already in the Dashboard is never touched.
    """
    existentes = frozenset(existentes_no_dashboard)
    ignorados: List[str] = []
    pendentes: List[Tuple[str, str]] = []
    a_extrair: List[str] = []
    vistos: set[str] = set()
    for item in numeros_softexpert:
        for numero in extrair_numeros(item):
            if numero in vistos:
                continue
            vistos.add(numero)
            if numero in existentes:
                ignorados.append(numero)
            elif numero in PENDENCIAS_DEFINIDAS:
                pendentes.append((numero, PENDENCIAS_DEFINIDAS[numero]))
            else:
                a_extrair.append(numero)
    return Triagem(tuple(ignorados), tuple(pendentes), tuple(a_extrair))


# ---------------------------------------------------------------------------- classification

def _sem_acentos(texto: str) -> str:
    decomposto = unicodedata.normalize("NFKD", texto)
    return "".join(letra for letra in decomposto if not unicodedata.combining(letra)).lower()


def classificar(descricao: str, titulo: str = "") -> Tuple[Optional[str], str]:
    """``(tipo, motivo)`` from the text actually read; ``tipo`` is None when the evidence is missing or mixed."""
    texto = _sem_acentos(f"{descricao or ''}\n{titulo or ''}")
    if not texto.strip():
        return None, MOTIVO_SEM_TEXTO
    incidente = any(regex.search(texto) for regex in _REGEX_INCIDENTE)
    solicitacao = any(regex.search(texto) for regex in _REGEX_SOLICITACAO)
    if incidente and solicitacao:
        return None, MOTIVO_TIPO_CONFLITANTE
    if incidente:
        return TIPO_INCIDENTE, ""
    if solicitacao:
        return TIPO_SOLICITACAO, ""
    return None, MOTIVO_SEM_TIPO


# ---------------------------------------------------------------------------- decision

@dataclass(frozen=True)
class ChamadoSoftExpert:
    """What the form shows; every field is untrusted text."""

    numero: str
    titulo: str = ""
    descricao: str = ""
    solicitante: str = ""
    habilitada_em: str = ""
    detalhes_atendimento_realizado: str = ""


@dataclass(frozen=True)
class Decisao:
    numero: str
    acao: str
    motivo: str = ""
    tipo: str = ""
    linha: Mapping[str, str] = field(default_factory=dict)


def interpretar_data(texto: Any) -> Optional[datetime]:
    valor = " ".join(str(texto or "").split())
    for formato in _FORMATOS_DATA_ENTRADA:
        try:
            return datetime.strptime(valor, formato)
        except ValueError:
            continue
    return None


def formatar_data_abertura(data: datetime) -> str:
    """Dashboard format of column Q: ``dd/MM/yyyy HH:mm``."""
    return data.strftime(FORMATO_DATA)


def mascarar_cpfs(texto: str) -> str:
    """Mascara CPFs pontuados ou identificados pelo rótulo; números puros exigem dígitos válidos."""
    def substituir(match: re.Match[str]) -> str:
        token = match.group(1)
        prefixo = match.group(0)[: match.start(1) - match.start()]
        if "." in token or prefixo:
            return f"{prefixo}***.***.***-**"
        digitos = token
        if len(set(digitos)) == 1:
            return match.group(0)
        primeiro = (sum(int(digitos[i]) * (10 - i) for i in range(9)) * 10) % 11
        primeiro = 0 if primeiro == 10 else primeiro
        segundo = (sum(int(digitos[i]) * (11 - i) for i in range(10)) * 10) % 11
        segundo = 0 if segundo == 10 else segundo
        if int(digitos[9]) != primeiro or int(digitos[10]) != segundo:
            return match.group(0)
        return "***.***.***-**"

    return _CPF.sub(substituir, texto)


def descricao_do_chamado(chamado: ChamadoSoftExpert) -> str:
    """Descrição do Registro; usa o título quando estiver vazia e mascara CPFs."""
    registro = (chamado.descricao or "").strip()
    titulo = (chamado.titulo or "").strip()
    return mascarar_cpfs(registro or titulo)


def detalhes_atendimento_do_chamado(chamado: ChamadoSoftExpert) -> str:
    """Texto integral do atendimento realizado, sem juntar a descrição do Registro."""
    return mascarar_cpfs((chamado.detalhes_atendimento_realizado or "").strip())


def decidir(chamado: ChamadoSoftExpert) -> Decisao:
    """Include (with the nine-column row) or leave pending with a recorded reason."""
    try:
        numero = chave_do_numero(chamado.numero)
    except ValueError:
        return Decisao(str(chamado.numero), ACAO_PENDENTE, "numero_invalido")
    if numero in PENDENCIAS_DEFINIDAS:
        return Decisao(numero, ACAO_PENDENTE, PENDENCIAS_DEFINIDAS[numero])
    descricao = descricao_do_chamado(chamado)
    atendimento = detalhes_atendimento_do_chamado(chamado)
    tipo, motivo = classificar(f"{descricao}\n{atendimento}", chamado.titulo)
    if tipo is None:
        return Decisao(numero, ACAO_PENDENTE, motivo)
    solicitante = mascarar_cpfs(" ".join((chamado.solicitante or "").split()))
    if not solicitante:
        return Decisao(numero, ACAO_PENDENTE, MOTIVO_SEM_SOLICITANTE)
    if not str(chamado.habilitada_em or "").strip():
        return Decisao(numero, ACAO_PENDENTE, MOTIVO_SEM_DATA)
    data = interpretar_data(chamado.habilitada_em)
    if data is None:
        return Decisao(numero, ACAO_PENDENTE, MOTIVO_DATA_INVALIDA)
    linha = {
        "C": numero,
        "D": STATUS_EM_ABERTO,
        "F": atendimento,
        "G": descricao,
        "H": solicitante,
        "I": tipo,
        "N": UNIDADE,
        "P": UF,
        "Q": formatar_data_abertura(data),
    }
    return Decisao(numero, ACAO_INCLUIR, "", tipo, linha)


# ---------------------------------------------------------------------------- notifications

@dataclass(frozen=True)
class ResumoExecucao:
    incluidos: int = 0
    ignorados: int = 0
    pendentes: int = 0
    login_necessario: bool = False
    falha: str = ""
    pendencias: Tuple[Tuple[str, str], ...] = ()


def impressao_digital(resumo: ResumoExecucao) -> str:
    """Stable digest of what is worth telling the user; the counts of ignored duplicates are not part of it."""
    conteudo = {
        "incluidos": resumo.incluidos > 0,
        "pendencias": sorted([list(par) for par in resumo.pendencias]),
        "login": resumo.login_necessario,
        "falha": resumo.falha.strip(),
    }
    bruto = json.dumps(conteudo, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(bruto.encode("utf-8")).hexdigest()[:16]


def deve_avisar(resumo: ResumoExecucao, ultimo_aviso: Optional[str]) -> bool:
    """Notify only when something new happened: new inclusions, changed pending set, login or failure.

    A run with nothing new and the same known pending items stays silent.
    """
    if resumo.incluidos > 0:
        return True
    possui_algo = bool(resumo.pendencias or resumo.login_necessario or resumo.falha.strip())
    if not possui_algo:
        return False
    return impressao_digital(resumo) != (ultimo_aviso or "")


def resumo_para_json(resumo: ResumoExecucao) -> Dict[str, Any]:
    return {
        "incluidos": resumo.incluidos,
        "ignorados": resumo.ignorados,
        "pendentes": resumo.pendentes,
        "login_necessario": resumo.login_necessario,
        "falha": resumo.falha,
        "pendencias": [{"numero": numero, "motivo": motivo} for numero, motivo in resumo.pendencias],
    }
