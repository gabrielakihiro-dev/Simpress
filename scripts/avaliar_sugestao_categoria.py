"""Avalia a sugestão de Categoria (B) e Tipo (J) contra um Dashboard Sebrae já preenchido.

Somente leitura: abre uma cópia ``.xlsx`` do Dashboard (o arquivo nunca é alterado), faz validação cruzada
determinística (5 partes, semente fixa) e imprime apenas números agregados: nenhum texto de chamado, nome
ou descrição é mostrado. As regras de texto (DESLIGAMENTO, NOVO USUÁRIO, INSTALAÇÃO, PERIFÉRICO, ENDPOINT CENTER
e J) foram desenhadas olhando estes mesmos dados, então a precisão delas é otimista; só o Naive Bayes é
validado de verdade (treino e teste separados).

Uso:
    python scripts/avaliar_sugestao_categoria.py CAMINHO.xlsx [--semente 42] [--partes 5]
"""

from __future__ import annotations

import argparse
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from domains import sebrae_categoria as cat  # noqa: E402
from domains.assistant_lgpd import e_solicitante_sistema  # noqa: E402
from domains.sebrae_dashboard_gravacao import ler_listas  # noqa: E402

LIMIARES = (0.0, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)


def _pct(parte: int, total: int) -> str:
    return f"{100 * parte / total:5.1f}% ({parte}/{total})" if total else "  n/a (0/0)"


def _previsoes(linhas: Sequence[cat.Linha], nomes: Any, opcoes: Sequence[str], semente: int, partes: int) -> List[Dict[str, Any]]:
    ordem = list(range(len(linhas)))
    random.Random(semente).shuffle(ordem)
    parte_de = {indice: posicao % partes for posicao, indice in enumerate(ordem)}
    registros: List[Dict[str, Any]] = []
    for parte in range(partes):
        treino = [cat.documento_da_linha(linhas[i], nomes) for i in sorted(parte_de) if parte_de[i] != parte]
        indice = cat.treinar(treino)
        for i in sorted(parte_de):
            if parte_de[i] != parte:
                continue
            linha = linhas[i]
            texto = cat.texto_normalizado(linha.titulo, linha.descricao, linha.atendimento)
            palavras = cat.tokens(texto)
            registros.append({
                "linha": linha, "indice": indice, "texto": texto,
                "b": cat.normalizar(linha.b), "j": cat.normalizar(linha.j),
                "regra_b": cat.regra_categoria(texto, opcoes), "prob_b": cat.pontuar(indice["b"], palavras, opcoes),
                "regra_j": cat.regra_tipo(texto), "prob_j": cat.pontuar(indice["j"], palavras, cat.TIPOS),
                "mapa": indice["mapa_b_j"],
            })
    return registros


def _melhor(probabilidades: Dict[str, float]) -> Optional[tuple[str, float]]:
    return max(probabilidades.items(), key=lambda par: par[1]) if probabilidades else None


def _etapa_b(registro: Dict[str, Any], limite: float, opcoes: Sequence[str]) -> tuple[Optional[str], str]:
    """``(categoria, etapa)`` da cascata de B: etapa ``regra``, ``nb`` ou ``outro``."""
    if registro["regra_b"]:
        return str(registro["regra_b"]), "regra"
    melhor = _melhor(registro["prob_b"])
    if melhor and melhor[1] >= limite:
        return melhor[0], "nb"
    return cat._opcao(opcoes, "OUTRO"), "outro"


def _categoria_em_cascata(registro: Dict[str, Any], limite: float, opcoes: Sequence[str]) -> Optional[str]:
    return _etapa_b(registro, limite, opcoes)[0]


def avaliar_b(registros: List[Dict[str, Any]], opcoes: Sequence[str]) -> None:
    com_b = [r for r in registros if r["b"]]
    novas = {cat.normalizar(n) for n in cat.CATEGORIAS_NOVAS}
    print(f"\n== Categoria (B): {len(com_b)} chamados com B preenchido (de {len(registros)}) ==")

    print("Regras (precisão; só as de rótulos que existem na lista):")
    por_regra: Dict[str, List[Dict[str, Any]]] = {}
    for r in com_b:
        if r["regra_b"]:
            por_regra.setdefault(str(r["regra_b"]), []).append(r)
    for rotulo, _ in cat.REGRAS_B:
        exata = cat._opcao(opcoes, rotulo)
        grupo = por_regra.get(exata or "", [])
        if cat.normalizar(rotulo) in novas:
            verdadeiros = Counter(r["b"] or "(vazio)" for r in grupo)
            resumo = ", ".join(f"{nome.upper()} {n}" for nome, n in verdadeiros.most_common()) or "nenhum"
            print(f"  {rotulo:<16} casou em {len(grupo):3d} chamados (categoria nova, sem precisão); B real: {resumo}")
        else:
            acertos = sum(1 for r in grupo if r["b"] == cat.normalizar(rotulo))
            print(f"  {rotulo:<16} precisão {_pct(acertos, len(grupo))}")
    todas = [r for g in por_regra.values() for r in g]
    existentes = [r for r in todas if cat.normalizar(r["regra_b"]) not in novas]
    acertos = sum(1 for r in existentes if r["b"] == cat.normalizar(r["regra_b"]))
    print(f"  todas as regras de categorias existentes: cobertura {_pct(len(existentes), len(com_b))}, precisão {_pct(acertos, len(existentes))}")

    print("Naive Bayes sozinho (sem regras), por limite de probabilidade:")
    for limite in LIMIARES:
        cobertos = [r for r in com_b if (m := _melhor(r["prob_b"])) and m[1] >= limite]
        acertos = sum(1 for r in cobertos if cat.normalizar(_melhor(r["prob_b"])[0]) == r["b"])  # type: ignore[index]
        print(f"  limite {limite:.2f}: cobertura {_pct(len(cobertos), len(com_b))}, precisão {_pct(acertos, len(cobertos))}")
    todos = [r for r in com_b if r["prob_b"]]
    acertos = sum(1 for r in todos if cat.normalizar(_melhor(r["prob_b"])[0]) == r["b"])  # type: ignore[index]
    print(f"  sem limite (sempre responde): acerto {_pct(acertos, len(todos))}")

    print("Cascata completa (regras, Naive Bayes, OUTRO); categorias novas ficam fora do acerto:")
    for limite in LIMIARES:
        etapas: Counter[str] = Counter()
        certos: Counter[str] = Counter()
        novas_previstas = 0
        for r in com_b:
            previsto, etapa = _etapa_b(r, limite, opcoes)
            if previsto is None:
                etapas["sem_sugestao"] += 1
                continue
            if cat.normalizar(previsto) in novas:
                novas_previstas += 1
                continue
            etapas[etapa] += 1
            if cat.normalizar(previsto) == r["b"]:
                certos[etapa] += 1
        avaliados = sum(etapas.values())
        total_certos = sum(certos.values())
        marca = " <- LIMITE_NB atual" if abs(limite - cat.LIMITE_NB) < 1e-9 else ""
        print(
            f"  limite {limite:.2f}: acerto {_pct(total_certos, avaliados)}; regra {_pct(certos['regra'], etapas['regra'])}, "
            f"NB {_pct(certos['nb'], etapas['nb'])}, OUTRO {_pct(certos['outro'], etapas['outro'])}; "
            f"novas previstas {novas_previstas}{marca}"
        )


def avaliar_j(registros: List[Dict[str, Any]], opcoes: Sequence[str], limite: float) -> None:
    com_j = [r for r in registros if r["j"] in {cat.normalizar(t) for t in cat.TIPOS}]
    print(f"\n== Tipo (J): {len(com_j)} chamados com J preenchido (de {len(registros)}) ==")
    verdade = lambda r: next(t for t in cat.TIPOS if cat.normalizar(t) == r["j"])  # noqa: E731
    sol = cat.SOLICITACAO

    print("Regras de texto, por etapa (precisão):")
    for etapa in ("explicito", "incidente"):
        grupo = [r for r in com_j if r["regra_j"] and r["regra_j"][0] == etapa]
        acertos = sum(1 for r in grupo if r["regra_j"][1] == verdade(r))
        print(f"  {etapa:<10} cobertura {_pct(len(grupo), len(com_j))}, precisão {_pct(acertos, len(grupo))}")
    sem_regra = [r for r in com_j if not r["regra_j"]]
    print(f"  sem regra de texto: {len(sem_regra)} chamados vão para a etapa final")

    base = sum(1 for r in com_j if verdade(r) == sol)
    print(f"(d) baseline sempre SOLICITAÇÃO: acerto {_pct(base, len(com_j))}")

    nb = [r for r in com_j if r["prob_j"]]
    acertos = sum(1 for r in nb if _melhor(r["prob_j"])[0] == verdade(r))  # type: ignore[index]
    print(f"(b) Naive Bayes direto: acerto {_pct(acertos, len(nb))}")

    def via_mapa(r: Dict[str, Any]) -> Optional[str]:
        previsto = _categoria_em_cascata(r, limite, opcoes)
        return r["mapa"].get(cat._chave_rotulo(previsto)) if previsto else None

    cobertos = [r for r in com_j if via_mapa(r)]
    acertos = sum(1 for r in cobertos if via_mapa(r) == verdade(r))
    com_reserva = sum(1 for r in com_j if (via_mapa(r) or sol) == verdade(r))
    print(
        f"(a) J pela B prevista e pelo mapa B->J: cobertura {_pct(len(cobertos), len(com_j))}, precisão {_pct(acertos, len(cobertos))}; "
        f"acerto geral com reserva SOLICITAÇÃO {_pct(com_reserva, len(com_j))}"
    )

    def cascata(r: Dict[str, Any], etapa_final: str) -> Optional[str]:
        if r["regra_j"]:
            return str(r["regra_j"][1])
        if etapa_final == "mapa":
            do_mapa = via_mapa(r)
            if do_mapa:
                return str(do_mapa)
        melhor = _melhor(r["prob_j"])
        return melhor[0] if melhor else None

    for etapa_final in ("nb", "mapa"):
        previstos = [(r, cascata(r, etapa_final)) for r in com_j]
        respondidos = [(r, p) for r, p in previstos if p]
        acertos = sum(1 for r, p in respondidos if p == verdade(r))
        marca = " <- ETAPA_FINAL_J atual" if etapa_final == cat.ETAPA_FINAL_J else ""
        print(f"(c) cascata regras + {'Naive Bayes' if etapa_final == 'nb' else 'mapa B->J (reserva NB)'}: acerto {_pct(acertos, len(respondidos))}{marca}")

    print("Só nos chamados que chegam à etapa final (sem regra de texto):")
    resto = [r for r in sem_regra if r["j"] in {cat.normalizar(t) for t in cat.TIPOS}]
    for nome, escolher in (
        ("Naive Bayes", lambda r: (_melhor(r["prob_j"]) or (None,))[0]),
        ("mapa B->J (reserva NB)", lambda r: via_mapa(r) or (_melhor(r["prob_j"]) or (None,))[0]),
        ("sempre SOLICITAÇÃO", lambda r: sol),
    ):
        acertos = sum(1 for r in resto if escolher(r) == verdade(r))
        print(f"  {nome:<24} {_pct(acertos, len(resto))}")


def verificar_consistencia(registros: List[Dict[str, Any]], opcoes: Sequence[str]) -> None:
    """A avaliação refaz a cascata por conta própria; aqui confere se o módulo dá a mesma resposta."""
    divergencias = 0
    for r in registros:
        linha: cat.Linha = r["linha"]
        if cat.sugerir(linha.titulo, linha.descricao, linha.atendimento, linha.solicitante, opcoes, r["indice"]) != _categoria_em_cascata(r, cat.LIMITE_NB, opcoes):
            divergencias += 1
        if cat.sugerir_tipo(linha.titulo, linha.descricao, linha.atendimento, linha.solicitante, r["indice"]) != (
            r["regra_j"][1] if r["regra_j"] else (_melhor(r["prob_j"]) or (None, 0))[0]
        ) and cat.ETAPA_FINAL_J == "nb":
            divergencias += 1
    print(f"\nDivergências entre esta avaliação e o módulo (LIMITE_NB e ETAPA_FINAL_J atuais): {divergencias}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("planilha", type=Path, help="cópia .xlsx do Dashboard Sebrae (só leitura)")
    ap.add_argument("--semente", type=int, default=42)
    ap.add_argument("--partes", type=int, default=5)
    args = ap.parse_args(argv)

    conteudo = args.planilha.read_bytes()
    linhas, nomes = cat.ler_linhas(conteudo)
    total = len(linhas)
    linhas = [linha for linha in linhas if not e_solicitante_sistema(linha.solicitante)]
    lista_b = ler_listas(conteudo).get("B") or sorted({linha.b for linha in linhas if linha.b})
    opcoes = list(lista_b) + [n for n in cat.CATEGORIAS_NOVAS if cat.normalizar(n) not in {cat.normalizar(o) for o in lista_b}]
    print(f"Chamados lidos: {total}; sem os do solicitante de sistema: {len(linhas)}; opções de B: {len(lista_b)} da lista + {len(opcoes) - len(lista_b)} novas")
    print(f"Validação cruzada: {args.partes} partes, semente {args.semente}; LIMITE_NB={cat.LIMITE_NB}; ETAPA_FINAL_J={cat.ETAPA_FINAL_J}")

    registros = _previsoes(linhas, nomes, opcoes, args.semente, args.partes)
    avaliar_b(registros, opcoes)
    avaliar_j(registros, opcoes, cat.LIMITE_NB)
    verificar_consistencia(registros, opcoes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
