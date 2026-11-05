"""Fase 1: pipeline mínimo real — triagem (determinística) -> plano -> código -> harness ->
(se falhar) correção, até `max_loop_iterations` -> juiz (só se crítica ou grande; por padrão
o harness decide — Fase 3 adiciona o critério de tamanho ao de palavra crítica).

Fase 2 (prompt caching): em toda lista de mensagens, a mensagem de "system" (instruções/schema,
estática) vem sempre antes da de "user" (a tarefa, dinâmica) e seu texto nunca interpola `tarefa`,
`missao_id` ou qualquer valor que mude a cada chamada — isso é o que permite ao provedor (DeepSeek,
direto ou via OpenRouter) cachear automaticamente o prefixo entre chamadas da mesma etapa.
"""

import difflib
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

# (modelo, mensagens, max_tokens, temperatura, missao_id) -> ResultadoChamada; produção injeta
# `functools.partial(chamar_modelo, settings, config)`, testes injetam um fake.
Chamador = Callable[[str, List[Dict[str, Any]], int, float, str], ResultadoChamada]

PALAVRAS_CRITICAS = ("senha", "produção", "producao", "pagamento", "excluir", "deletar", "drop table")

# Fase 3: toda classificação de missão precisa cair numa rota conhecida (True = juiz roda,
# se o harness passou; False = harness decide, sem juiz). Tipo fora deste mapa é erro
# explícito (`decidir_juiz`), nunca silêncio. Fallback por classificador barato (Haiku ou
# equivalente) pra quando a regra determinística errar demais é a próxima evolução, ainda
# não implementada nesta fase — aqui é regra pura, sem LLM.
ROTAS_JUIZ: Dict[str, bool] = {
    "critica": True,
    "grande": True,
    "normal": False,
}


class MissaoError(Exception):
    pass


@dataclass(frozen=True)
class TriagemResultado:
    critica: bool
    motivo: str


def triar(tarefa: str) -> TriagemResultado:
    """Triagem por palavra crítica, determinística e sem LLM (dossiê: roteador calculava e
    ignorava o resultado). Roda sobre o texto da tarefa, antes de existir código; a triagem
    por tamanho (`classificar_tamanho`) só é possível depois do código gerado."""
    baixa = tarefa.lower()
    for palavra in PALAVRAS_CRITICAS:
        if palavra in baixa:
            return TriagemResultado(critica=True, motivo=f"tarefa contém '{palavra}'")
    return TriagemResultado(critica=False, motivo="sem palavra crítica")


def classificar_tamanho(conteudo: str, limite_linhas: int) -> bool:
    """Mudança "grande": código gerado com `limite_linhas` linhas ou mais, determinístico."""
    return len(conteudo.splitlines()) >= limite_linhas


def classificar_rota(critica: bool, grande: bool) -> str:
    """Classificação final da missão (sempre uma das rotas conhecidas em `ROTAS_JUIZ`), usada
    só para decidir se o juiz roda."""
    if critica:
        return "critica"
    if grande:
        return "grande"
    return "normal"


def decidir_juiz(tipo: str) -> bool:
    """Toda saída do roteador precisa de rota conhecida; tipo sem rota é erro explícito."""
    try:
        return ROTAS_JUIZ[tipo]
    except KeyError:
        raise MissaoError(f"Roteador sem rota conhecida para o tipo de missão '{tipo}'.") from None


def _montar_diff_para_juiz(codigo_atual: CodigoSaida, codigo_anterior: Optional[CodigoSaida]) -> str:
    """Diff do código gerado contra a versão anterior da mesma missão (iteração de correção
    passada). Sem versão anterior (1ª iteração), não há o que diferenciar: manda o código
    completo, documentado aqui — não é o corte arbitrário de caracteres de antes."""
    if codigo_anterior is None:
        return f"(1ª versão da missão, sem código anterior para diff)\n{codigo_atual.conteudo}"
    diff = "".join(difflib.unified_diff(
        codigo_anterior.conteudo.splitlines(keepends=True),
        codigo_atual.conteudo.splitlines(keepends=True),
        fromfile=f"{codigo_anterior.arquivo} (tentativa anterior)",
        tofile=f"{codigo_atual.arquivo} (atual)",
    ))
    diff = diff or "(diff vazio: código idêntico à tentativa anterior)"
    # O juiz decide sobre o resultado final da missão, não sobre a evolução entre tentativas:
    # o diff mostra o que mudou desde a última correção, mas o código completo abaixo é o que
    # de fato é aprovado/escrito (dossiê Fase 2: o juiz via o código inteiro; a Fase 3 não pode
    # perder isso ao trocar pelo diff).
    return f"{diff}\n\nCódigo final completo:\n{codigo_atual.conteudo}"


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
        resultado = chamador(modelo, mensagens, max_tokens, temperatura, missao_id)
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
        codigo_anterior: Optional[CodigoSaida] = None
        for iteracao in range(1, config.limites.max_loop_iterations + 1):
            sandbox_dir = preparar_sandbox(sandbox_dir)  # sandbox limpo a cada tentativa: nenhum arquivo de rodada anterior sobrevive e confunde o pytest

            codigo = _chamar_com_schema(
                chamador, log_path, missao_id, f"codigo_{iteracao}", config.modelos.codificador,
                mensagens_codigo, config.chamada.max_tokens_codigo, config.chamada.temperatura, CodigoSaida, breaker,
            )

            resultado_harness = rodar_harness(sandbox_dir, codigo.arquivo, codigo.conteudo)
            ultimo_harness = resultado_harness

            if resultado_harness.ok:
                grande = classificar_tamanho(codigo.conteudo, config.limites.limite_linhas_grande)
                tipo = classificar_rota(triagem.critica, grande)
                if decidir_juiz(tipo):
                    aprovado, motivo_juiz = _chamar_juiz(
                        chamador, log_path, missao_id, config, tarefa, codigo, codigo_anterior, resultado_harness, breaker,
                    )
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
            codigo_anterior = codigo

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
    tarefa: str, codigo: CodigoSaida, codigo_anterior: Optional[CodigoSaida],
    resultado_harness: ResultadoHarness, breaker: CircuitBreaker,
) -> tuple[bool, str]:
    """Juiz caro: só roda quando o harness passou e a missão é crítica ou grande (dossiê #9:
    antes rodava em toda missão crítica, sem olhar tamanho).

    dossiê #2: o retorno do portão nunca era lido; aqui o veredito decide o resultado da missão.

    Fase 3: evidência estruturada (diff, saída real do pytest e do ruff) no lugar do corte
    arbitrário de caracteres do código.
    """
    diff = _montar_diff_para_juiz(codigo, codigo_anterior)
    evidencia = (
        f"Diff do código gerado:\n{diff}\n\n"
        f"Saída do pytest:\n{resultado_harness.saida_pytest or '(sem saída)'}\n\n"
        f"Saída do ruff:\n{resultado_harness.saida_ruff or '(sem saída)'}"
    )
    resultado = chamador(
        config.modelos.juiz,
        [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "Você é o juiz final. Responda só com 'aprovado' ou 'reprovado: <motivo>'.",
                        # Bloco de conteúdo (formato Anthropic/OpenRouter), não cabeçalho HTTP.
                        # TTL padrão de 5 min: o juiz roda no máximo 1x por missão (não há retry pro
                        # juiz), então o único reuso possível é entre missões diferentes dentro da
                        # janela de 5 min — não há como justificar aqui a escrita a 2x do TTL de 1h.
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            },
            {"role": "user", "content": f"Tarefa: {tarefa}\nArquivo: {codigo.arquivo}\n\n{evidencia}"},
        ],
        config.chamada.max_tokens_juiz, config.chamada.temperatura, missao_id,
    )
    usage_log.registrar(log_path, missao_id, "juiz", resultado)
    breaker.registrar_custo(resultado.custo_usd)
    veredito = resultado.conteudo.strip()
    return veredito.lower().startswith("aprovado"), veredito
