"""Modo sombra: o modelo local sugere o tipo de cada chamado lido, sem influenciar a rotina.

Ligado por ``"modo_sombra": true`` em ``data/state/sebrae_config.json``. Cada chamado lido pela rotina
recebe uma sugestão do modelo (Ollama em ``localhost``) e vira uma linha em
``data/state/sebrae_sombra.jsonl`` (fora do Git). Nada vai para o Dashboard. Depois, ``main`` compara
o caderno com uma cópia ``.xlsx`` do Dashboard baixada pelo usuário (coluna I como gabarito) e aplica
os critérios da Fase 0.

Uso da avaliação:
    python scripts/sebrae_sombra.py --planilha CAMINHO.xlsx
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from domains.sebrae_agendamento import FUSO  # noqa: E402
from domains.sebrae_chamados import (  # noqa: E402
    MOTIVO_SEM_TIPO,
    MOTIVO_TIPO_CONFLITANTE,
    ChamadoSoftExpert,
    Decisao,
    descricao_do_chamado,
    extrair_numeros,
)
from scripts import avaliar_classificacao_local as av  # noqa: E402

CADERNO = ROOT / "data" / "state" / "sebrae_sombra.jsonl"
INDISPONIVEL = "indisponivel"
MODELO = "qwen3:8b"
URL = "http://localhost:11434"
# Dentro da rotina não dá para esperar 300 s por chamado: após uma falha, o resto da execução fica sem sugestão.
TIMEOUT_S = 60.0


def criar_observador(
    caderno: Path = CADERNO,
    chamar: Optional[av.Chamador] = None,
    modelo: str = MODELO,
    agora: Callable[[], datetime] = lambda: datetime.now(FUSO),
) -> Callable[[ChamadoSoftExpert, Decisao], None]:
    """Observador para ``sincronizar(observar=...)``; acrescenta uma linha ao caderno por chamado."""
    chamar = chamar or av.chamador_ollama(URL, timeout=TIMEOUT_S)
    disponivel = True

    def observar(chamado: ChamadoSoftExpert, decisao: Decisao) -> None:
        nonlocal disponivel
        descricao = descricao_do_chamado(chamado)
        inicio = time.perf_counter()
        sugestao = INDISPONIVEL
        if disponivel and descricao:
            try:
                sugestao = av.interpretar_resposta(chamar(av.corpo_da_chamada(modelo, descricao)))
            except (OSError, KeyError, ValueError):
                disponivel = False
        registro = {
            "data": agora().isoformat(timespec="seconds"),
            "numero": decisao.numero,
            "descricao": descricao,
            "regra": decisao.tipo or None,
            "motivo": decisao.motivo,
            "modelo": modelo,
            "sugestao": sugestao,
            "segundos": round(time.perf_counter() - inicio, 3),
        }
        caderno.parent.mkdir(parents=True, exist_ok=True)
        with caderno.open("a", encoding="utf-8") as arquivo:
            arquivo.write(json.dumps(registro, ensure_ascii=False) + "\n")

    return observar


def ler_caderno(caderno: Path) -> List[Dict[str, Any]]:
    """Linhas do caderno; uma linha corrompida é pulada. O registro mais recente de cada número vale."""
    registros: Dict[str, Dict[str, Any]] = {}
    for linha in caderno.read_text(encoding="utf-8").splitlines():
        try:
            registro = json.loads(linha)
        except ValueError:
            continue
        if isinstance(registro, dict) and registro.get("numero"):
            registros[registro["numero"]] = registro
    return list(registros.values())


def cruzar(registros: List[Dict[str, Any]], linhas_dashboard: List[tuple[Any, Any, Any]]) -> List[Dict[str, Any]]:
    """Resultados no formato de ``av.resumir``: só chamados com sugestão e com tipo já no Dashboard."""
    gabarito: Dict[str, str] = {}
    for numero_bruto, _descricao, tipo_bruto in linhas_dashboard:
        numeros, tipo = extrair_numeros(numero_bruto), av.normalizar_tipo(tipo_bruto)
        if len(numeros) == 1 and tipo:
            gabarito.setdefault(numeros[0], tipo)
    resultados = []
    for registro in registros:
        esperado = gabarito.get(registro["numero"])
        if esperado is None or registro.get("sugestao") == INDISPONIVEL:
            continue
        if registro.get("regra"):
            grupo = av.GRUPO_B
        elif registro.get("motivo") in (MOTIVO_SEM_TIPO, MOTIVO_TIPO_CONFLITANTE):
            grupo = av.GRUPO_A
        else:
            continue
        resultados.append({"numero": registro["numero"], "grupo": grupo, "esperado": esperado,
                           "regra": registro.get("regra"), "modelo": registro["sugestao"],
                           "segundos": registro.get("segundos", 0)})
    return resultados


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Avalia o caderno do modo sombra contra uma cópia do Dashboard.")
    parser.add_argument("--planilha", type=Path, required=True)
    parser.add_argument("--aba", default="CHAMADOS")
    parser.add_argument("--caderno", type=Path, default=CADERNO)
    parser.add_argument("--saida", type=Path, default=ROOT / "data" / "state" / "avaliacao_ia" / "sombra")
    args = parser.parse_args(argv)
    for caminho in (args.planilha, args.caderno):
        if not caminho.is_file():
            print(f"Arquivo não encontrado: {caminho}", file=sys.stderr)
            return 2
    registros = ler_caderno(args.caderno)
    resultados = cruzar(registros, av.ler_planilha(args.planilha, args.aba))
    resumo = av.resumir(resultados)
    meta = {"modelo": MODELO, "planilha": str(args.planilha), "aba": args.aba,
            "excluidas": {"sem_gabarito_ou_sem_sugestao": len(registros) - len(resultados)}}
    args.saida.mkdir(parents=True, exist_ok=True)
    (args.saida / "relatorio.json").write_text(
        json.dumps({"meta": meta, "resumo": resumo, "resultados": resultados}, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.saida / "relatorio.md").write_text(av.relatorio_markdown(meta, resumo, resultados), encoding="utf-8")
    print(f"{len(resultados)} chamado(s) avaliados. Veredito: {resumo['veredito']['situacao']}. Relatório em {args.saida}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
