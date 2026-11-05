"""Fase 0: registro de uso por chamada em JSONL e relatório de custo/cache hit por modelo e etapa."""

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterator, Optional

from .llm_adapter import ResultadoChamada


@dataclass(frozen=True)
class RegistroUso:
    timestamp: float
    missao_id: str
    etapa: str
    modelo: str
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    custo_usd: float
    custo_origem: str
    latencia_s: float


def registrar(caminho: Path, missao_id: str, etapa: str, resultado: ResultadoChamada) -> RegistroUso:
    registro = RegistroUso(
        timestamp=time.time(),
        missao_id=missao_id,
        etapa=etapa,
        modelo=resultado.modelo,
        prompt_tokens=resultado.prompt_tokens,
        cached_tokens=resultado.cached_tokens,
        completion_tokens=resultado.completion_tokens,
        custo_usd=resultado.custo_usd,
        custo_origem=resultado.custo_origem,
        latencia_s=resultado.latencia_s,
    )
    caminho.parent.mkdir(parents=True, exist_ok=True)
    with caminho.open("a", encoding="utf-8") as arquivo:
        arquivo.write(json.dumps(asdict(registro), ensure_ascii=False) + "\n")
    return registro


def ler_registros(caminho: Path) -> Iterator[Dict]:
    if not caminho.exists():
        return
    with caminho.open(encoding="utf-8") as arquivo:
        for linha in arquivo:
            linha = linha.strip()
            if linha:
                yield json.loads(linha)


def custo_hoje_usd(caminho: Path, agora: Optional[float] = None) -> float:
    """Soma o custo dos registros com timestamp no dia UTC corrente.

    shortcut: usa o dia em UTC (não o fuso America/Sao_Paulo); ajustar se o teto diário
    precisar bater exatamente com a meia-noite local.
    """
    agora = time.time() if agora is None else agora
    inicio_dia = agora - (agora % 86400)
    return sum(r["custo_usd"] for r in ler_registros(caminho) if r["timestamp"] >= inicio_dia)


def _grupo_vazio() -> Dict:
    return {"custo_usd": 0.0, "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "chamadas": 0}


def relatorio(caminho: Path) -> Dict[str, Dict[str, Dict]]:
    """Agrupa os registros por modelo e por etapa: custo total e taxa de cache hit."""
    por_modelo: Dict[str, Dict] = {}
    por_etapa: Dict[str, Dict] = {}
    for registro in ler_registros(caminho):
        for grupo, chave in ((por_modelo, registro["modelo"]), (por_etapa, registro["etapa"])):
            dados = grupo.setdefault(chave, _grupo_vazio())
            dados["custo_usd"] += registro["custo_usd"]
            dados["prompt_tokens"] += registro["prompt_tokens"]
            dados["cached_tokens"] += registro["cached_tokens"]
            dados["completion_tokens"] += registro["completion_tokens"]
            dados["chamadas"] += 1

    for grupo in (por_modelo, por_etapa):
        for dados in grupo.values():
            dados["cache_hit_rate"] = (dados["cached_tokens"] / dados["prompt_tokens"]) if dados["prompt_tokens"] else 0.0

    return {"por_modelo": por_modelo, "por_etapa": por_etapa}
