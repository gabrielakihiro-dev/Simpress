"""Fake do chamador de modelo: respostas programadas, sem rede e sem custo real."""

from typing import Any, Callable, Dict, List

from motor.llm_adapter import ResultadoChamada


def fake_chamador(respostas: List[str], custo_usd: float = 0.0001, cached_tokens: int = 0) -> Callable:
    """Devolve um `Chamador` que responde, em ordem, com os textos de `respostas` (um por chamada)."""
    fila = list(respostas)

    def _chamador(modelo: str, mensagens: List[Dict[str, Any]], max_tokens: int, temperatura: float, missao_id: str = "") -> ResultadoChamada:
        if not fila:
            raise AssertionError("fake_chamador: mais chamadas do que respostas programadas")
        conteudo = fila.pop(0)
        return ResultadoChamada(
            modelo=modelo,
            conteudo=conteudo,
            prompt_tokens=100,
            cached_tokens=cached_tokens,
            completion_tokens=50,
            custo_usd=custo_usd,
            custo_origem="estimated",
            latencia_s=0.001,
        )

    return _chamador
