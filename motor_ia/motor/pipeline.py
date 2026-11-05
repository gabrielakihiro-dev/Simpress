"""Fase 1: pipeline mínimo real — triagem (determinística) -> plano -> código -> harness ->
(se falhar) correção, até `max_loop_iterations` -> juiz (só se crítica; por padrão o harness decide).
"""

import json
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from pydantic import BaseModel, ValidationError

from . import usage_log
from .circuit_breaker import CircuitBreaker, CircuitBreakerError
from .config import MotorConfig, OpenRouterError
from .harness import ResultadoHarness, preparar_sandbox, rodar_harness
from .llm_adapter import ResultadoChamada
from .schemas import CodigoSaida, PlanoSaida

# (modelo, mensagens, max_tokens, temperatura) -> ResultadoChamada; produção injeta
# `functools.partial(chamar_modelo, settings, config)`, testes injetam um fake.
Chamador = Callable[[str, List[Dict[str, Any]], int, float], ResultadoChamada]

PALAVRAS_CRITICAS = ("senha", "produção", "producao", "pagamento", "excluir", "deletar", "drop table")


class MissaoError(Exception):
    pass


@dataclass(frozen=True)
class TriagemResultado:
    critica: bool
    motivo: str


def triar(tarefa: str) -> TriagemResultado:
    """Triagem determinística, sem LLM (dossiê: roteador calculava e ignorava o resultado)."""
    baixa = tarefa.lower()
    for palavra in PALAVRAS_CRITICAS:
        if palavra in baixa:
            return TriagemResultado(critica=True, motivo=f"tarefa contém '{palavra}'")
    return TriagemResultado(critica=False, motivo="sem palavra crítica")


@dataclass
class ResultadoMissao:
    ok: bool
    missao_id: str
    motivo: str
    iteracoes: int
    arquivo_escrito: Optional[Path] = None
    custo_usd: float = 0.0


def _chamar_com_schema(
    chamador: Chamador,
    log_path: Path,
    missao_id: str,
    etapa: str,
    modelo: str,
    mensagens: List[Dict[str, Any]],
    max_tokens: int,
    temperatura: float,
    schema: type[BaseModel],
    breaker: CircuitBreaker,
) -> BaseModel:
    """1 chamada; se o JSON não validar o schema, 1 retry com o erro anexado; depois falha limpa."""
    for tentativa in range(2):
        resultado = chamador(modelo, mensagens, max_tokens, temperatura)
        usage_log.registrar(log_path, missao_id, etapa, resultado)
        breaker.registrar_custo(resultado.custo_usd)
        try:
            return schema.model_validate_json(resultado.conteudo)
        except ValidationError as erro:
            if tentativa == 1:
                raise MissaoError(f"JSON de '{etapa}' não passou no schema após retry: {erro}") from erro
            mensagens = mensagens + [
                {"role": "assistant", "content": resultado.conteudo},
                {"role": "user", "content": f"JSON inválido: {erro}. Responda só com o JSON corrigido."},
            ]
    raise MissaoError(f"Falha inesperada em '{etapa}'.")  # inalcançável; satisfaz o checker de tipos


def executar_missao(
    tarefa: str,
    config: MotorConfig,
    chamador: Chamador,
    log_path: Path,
    sandbox_dir: Optional[Path] = None,
) -> ResultadoMissao:
    missao_id = uuid.uuid4().hex[:12]
    sandbox_dir = preparar_sandbox(sandbox_dir or config.sandbox_dir)
    breaker = CircuitBreaker(limites=config.limites, log_path=log_path)
    triagem = triar(tarefa)

    try:
        plano = _chamar_com_schema(
            chamador, log_path, missao_id, "plano", config.modelos.planejador,
            [
                {"role": "system", "content": 'Responda só com JSON: {"passos": ["..."], "arquivo_alvo": "..."}.'},
                {"role": "user", "content": tarefa},
            ],
            config.chamada.max_tokens_plano, config.chamada.temperatura, PlanoSaida, breaker,
        )

        mensagens_codigo: List[Dict[str, Any]] = [
            {"role": "system", "content": (
                'Responda só com JSON: {"arquivo": "...", "conteudo": "..."}. '
                '"arquivo" tem que começar com "test_" e terminar em ".py"; "conteudo" tem que '
                'ter pelo menos uma função "test_..." que o pytest colete e rode de verdade.'
            )},
            {"role": "user", "content": f"Tarefa: {tarefa}\nPlano: {plano.passos}\nArquivo alvo: {plano.arquivo_alvo}"},
        ]

        ultimo_harness: Optional[ResultadoHarness] = None
        for iteracao in range(1, config.limites.max_loop_iterations + 1):
            sandbox_dir = preparar_sandbox(sandbox_dir)  # sandbox limpo a cada tentativa: arquivo da rodada anterior não some sem querer

            codigo = _chamar_com_schema(
                chamador, log_path, missao_id, f"codigo_{iteracao}", config.modelos.codificador,
                mensagens_codigo, config.chamada.max_tokens_codigo, config.chamada.temperatura, CodigoSaida, breaker,
            )

            resultado_harness = rodar_harness(sandbox_dir, codigo.arquivo, codigo.conteudo)
            ultimo_harness = resultado_harness

            if resultado_harness.ok:
                if triagem.critica:
                    aprovado, motivo_juiz = _chamar_juiz(chamador, log_path, missao_id, config, tarefa, codigo, breaker)
                    if not aprovado:
                        return ResultadoMissao(
                            ok=False, missao_id=missao_id, motivo=f"Juiz reprovou: {motivo_juiz}", iteracoes=iteracao,
                            arquivo_escrito=resultado_harness.caminho_escrito, custo_usd=breaker.custo_missao_usd,
                        )
                return ResultadoMissao(
                    ok=True, missao_id=missao_id, motivo="harness ok", iteracoes=iteracao,
                    arquivo_escrito=resultado_harness.caminho_escrito, custo_usd=breaker.custo_missao_usd,
                )

            breaker.registrar_erro_harness(resultado_harness.assinatura_erro)
            mensagens_codigo = mensagens_codigo + [
                {"role": "assistant", "content": json.dumps({"arquivo": codigo.arquivo, "conteudo": codigo.conteudo}, ensure_ascii=False)},
                {"role": "user", "content": f"O harness falhou: {resultado_harness.erro}. Corrija e responda só com o JSON do código."},
            ]

        return ResultadoMissao(
            ok=False, missao_id=missao_id, iteracoes=config.limites.max_loop_iterations,
            motivo=f"Limite de {config.limites.max_loop_iterations} iterações atingido. Último erro: {ultimo_harness.erro if ultimo_harness else '?'}",
            custo_usd=breaker.custo_missao_usd,
        )
    except CircuitBreakerError as erro:
        return ResultadoMissao(ok=False, missao_id=missao_id, motivo=str(erro), iteracoes=0, custo_usd=breaker.custo_missao_usd)
    except MissaoError as erro:
        return ResultadoMissao(ok=False, missao_id=missao_id, motivo=str(erro), iteracoes=0, custo_usd=breaker.custo_missao_usd)
    except OpenRouterError as erro:
        # Falha de rede/provedor (ex.: 402 sem crédito): a missão termina limpa, não com traceback.
        return ResultadoMissao(ok=False, missao_id=missao_id, motivo=f"Erro do provedor: {erro}", iteracoes=0, custo_usd=breaker.custo_missao_usd)


def _chamar_juiz(
    chamador: Chamador, log_path: Path, missao_id: str, config: MotorConfig,
    tarefa: str, codigo: CodigoSaida, breaker: CircuitBreaker,
) -> tuple[bool, str]:
    """Juiz caro: só roda para missão marcada crítica (dossiê #9: antes rodava em toda missão).

    dossiê #2: o retorno do portão nunca era lido; aqui o veredito decide o resultado da missão.
    """
    resultado = chamador(
        config.modelos.juiz,
        [
            {"role": "system", "content": "Você é o juiz final. Responda só com 'aprovado' ou 'reprovado: <motivo>'."},
            {"role": "user", "content": f"Tarefa: {tarefa}\nArquivo: {codigo.arquivo}\nCódigo:\n{codigo.conteudo}"},
        ],
        config.chamada.max_tokens_juiz, config.chamada.temperatura,
    )
    usage_log.registrar(log_path, missao_id, "juiz", resultado)
    breaker.registrar_custo(resultado.custo_usd)
    veredito = resultado.conteudo.strip()
    return veredito.lower().startswith("aprovado"), veredito
