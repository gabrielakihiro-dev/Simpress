"""Fase 5: benchmark honesto — pipeline completo vs. um único modelo forte (baseline),
nas mesmas 12 tarefas fixas, com teste de aceitação OCULTO (o modelo nunca vê) além do
teste que o próprio modelo escreve.

Por quê o teste oculto: o harness (Fase 1) só verifica se o `pytest` do arquivo que o
próprio modelo escreveu passa. Um modelo podia escrever `def test_x(): assert True` e
"passar" sem resolver nada. Aqui, depois que o harness do próprio braço (pipeline ou
baseline) disser `ok`, `_validar_aceitacao` grava a implementação gerada como
`solucao.py` (nome fora do padrão `test_*`, então o teste do próprio modelo não é
coletado de novo) e roda, nesse mesmo sandbox, um `test_aceitacao.py` com casos de borda
que o modelo não viu. `ResultadoArm.ok` só é `True` se as duas coisas passarem;
`ok_proprio` guarda o resultado do harness do próprio braço, sem o teste oculto, útil pra
comparar "o modelo achou que passou" vs. "passou de verdade".

Baseline: uma única chamada (com 1 retry de schema, via `_chamar_com_schema`, igual ao
pipeline) ao modelo já configurado como juiz (`config.modelos.juiz`, hoje
`anthropic/claude-sonnet-5.5` via OpenRouter) — mesmo contrato `CodigoSaida`, mesmo
`max_tokens_codigo`, mesmo texto de tarefa, mesmo harness e mesmo teste de aceitação do
pipeline. Sem planner, sem loop de correção, sem juiz: é o "um modelo forte fazendo tudo
sozinho" do plano da Fase 5. Não é Claude Code nem Codex (assinatura, proibidos como
baseline/runtime) — é o mesmo modelo que a Fase 3 já chama como juiz, por API paga.
"""

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from . import usage_log
from .circuit_breaker import CircuitBreaker, CircuitBreakerError
from .config import MotorConfig, OpenRouterError
from .harness import preparar_sandbox, rodar_harness
from .pipeline import Chamador, MissaoError, _chamar_com_schema, executar_missao
from .schemas import CodigoSaida

# Mesmo contrato de `mensagens_codigo` em `pipeline._executar_missao` — repetido aqui (não
# importado) porque o baseline pula a etapa de plano; o contrato do JSON de saída precisa
# ser idêntico pro harness tratar os dois braços da mesma forma.
_SISTEMA_CODIGO_BASELINE = (
    'Responda só com JSON: {"arquivo": "...", "conteudo": "..."}. '
    '"arquivo" tem que começar com "test_" e terminar em ".py"; "conteudo" tem que '
    'ter pelo menos uma função "test_..." que o pytest colete e rode de verdade.'
)


@dataclass(frozen=True)
class Tarefa:
    id: str
    descricao: str
    categoria: str  # tag descritiva (trivial/unicode/excecao/critica/classe); não força a rota do roteador real
    teste_aceitacao: str  # código do teste oculto; faz `from solucao import <algo>`


@dataclass
class ResultadoArm:
    ok: bool  # aprovado: harness do próprio braço ok E teste de aceitação oculto passou
    ok_proprio: bool  # só o harness/juiz do próprio braço, sem o teste oculto
    missao_id: str
    motivo: str
    custo_usd: float
    iteracoes: int


@dataclass
class ResultadoTarefaBenchmark:
    tarefa: Tarefa
    pipeline: ResultadoArm
    baseline: ResultadoArm


@dataclass
class MetricasGrupo:
    n_tarefas: int
    aprovadas: int
    taxa_sucesso: float
    custo_total_usd: float
    custo_medio_por_tarefa: float
    custo_por_tarefa_aprovada: Optional[float]
    iteracoes_media: float
    latencia_media_tarefa_s: float
    cache_hit_por_etapa: Dict[str, float]


def _validar_aceitacao(conteudo_gerado: str, teste_aceitacao: str, sandbox_dir: Path) -> bool:
    sandbox_dir = preparar_sandbox(sandbox_dir)
    (sandbox_dir / "solucao.py").write_text(conteudo_gerado, encoding="utf-8")
    resultado = rodar_harness(sandbox_dir, "test_aceitacao.py", teste_aceitacao)
    return resultado.ok


def rodar_pipeline(tarefa: Tarefa, config: MotorConfig, chamador: Chamador, log_path: Path, sandbox_dir: Path) -> ResultadoArm:
    """Roda a tarefa pelo pipeline completo (Fases 1-4, sem alteração) e aplica o teste oculto por cima."""
    resultado = executar_missao(tarefa.descricao, config, chamador, log_path, sandbox_dir=sandbox_dir)
    conteudo = None
    if resultado.ok and resultado.arquivo_escrito is not None:
        conteudo = resultado.arquivo_escrito.read_text(encoding="utf-8")
    aprovado = resultado.ok and conteudo is not None and _validar_aceitacao(conteudo, tarefa.teste_aceitacao, sandbox_dir)
    return ResultadoArm(
        ok=aprovado, ok_proprio=resultado.ok, missao_id=resultado.missao_id,
        motivo=resultado.motivo, custo_usd=resultado.custo_usd, iteracoes=resultado.iteracoes,
    )


def resolver_baseline(tarefa: Tarefa, config: MotorConfig, chamador: Chamador, log_path: Path, sandbox_dir: Path) -> ResultadoArm:
    """Um único modelo (config.modelos.juiz) resolve a tarefa sozinho: 1 chamada (+1 retry de
    schema), sem planner, sem loop de correção, sem juiz."""
    missao_id = uuid.uuid4().hex[:12]
    breaker = CircuitBreaker(limites=config.limites, log_path=log_path)
    mensagens = [
        {"role": "system", "content": _SISTEMA_CODIGO_BASELINE},
        {"role": "user", "content": f"Tarefa: {tarefa.descricao}"},
    ]
    try:
        codigo: CodigoSaida = _chamar_com_schema(
            chamador, log_path, missao_id, "baseline", config.modelos.juiz,
            mensagens, config.chamada.max_tokens_codigo, config.chamada.temperatura, CodigoSaida, breaker,
        )
    except (CircuitBreakerError, MissaoError, OpenRouterError) as erro:
        return ResultadoArm(
            ok=False, ok_proprio=False, missao_id=missao_id, motivo=str(erro),
            custo_usd=breaker.custo_missao_usd, iteracoes=0,
        )

    sandbox_dir = preparar_sandbox(sandbox_dir)
    resultado_harness = rodar_harness(sandbox_dir, codigo.arquivo, codigo.conteudo)
    ok_proprio = resultado_harness.ok
    aprovado = ok_proprio and _validar_aceitacao(codigo.conteudo, tarefa.teste_aceitacao, sandbox_dir)
    motivo = "harness ok" if ok_proprio else resultado_harness.erro
    return ResultadoArm(
        ok=aprovado, ok_proprio=ok_proprio, missao_id=missao_id, motivo=motivo,
        custo_usd=breaker.custo_missao_usd, iteracoes=1,
    )


def rodar_benchmark(
    tarefas: List[Tarefa],
    config: MotorConfig,
    chamador_pipeline: Chamador,
    chamador_baseline: Chamador,
    log_pipeline: Path,
    log_baseline: Path,
    sandbox_dir: Path,
) -> List[ResultadoTarefaBenchmark]:
    """Log separado por braço: `usage_log.relatorio` de cada um já sai correto (sem misturar
    custo/cache hit de pipeline com o de baseline) e nada é escrito em `data/usage_log.jsonl`."""
    resultados = []
    for tarefa in tarefas:
        pipeline_res = rodar_pipeline(tarefa, config, chamador_pipeline, log_pipeline, sandbox_dir)
        baseline_res = resolver_baseline(tarefa, config, chamador_baseline, log_baseline, sandbox_dir)
        resultados.append(ResultadoTarefaBenchmark(tarefa=tarefa, pipeline=pipeline_res, baseline=baseline_res))
    return resultados


def _latencia_media_por_tarefa(log_path: Path, missao_ids: List[str]) -> float:
    """Soma `latencia_s` de todos os registros de cada `missao_id` (todas as etapas dessa
    missão) e tira a média entre as tarefas. `usage_log.relatorio` não cobre isso: ele
    agrega por modelo/etapa, não por missão."""
    if not missao_ids:
        return 0.0
    por_missao = {m: 0.0 for m in missao_ids}
    for registro in usage_log.ler_registros(log_path):
        if registro["missao_id"] in por_missao:
            por_missao[registro["missao_id"]] += registro["latencia_s"]
    return sum(por_missao.values()) / len(missao_ids)


def calcular_metricas(resultados: List[ResultadoArm], log_path: Path) -> MetricasGrupo:
    """`iteracoes == 0` acontece quando o breaker, o schema ou o provedor falham antes de
    qualquer tentativa de harness (ver `resolver_baseline`/`pipeline._executar_missao`); essas
    entradas contam como reprovadas e entram na média de iterações como 0, puxando-a para
    baixo — é a média bruta, não ajustada pra excluir essas falhas."""
    n = len(resultados)
    aprovadas = sum(1 for r in resultados if r.ok)
    custo_total = sum(r.custo_usd for r in resultados)
    custo_aprovadas = sum(r.custo_usd for r in resultados if r.ok)
    relatorio = usage_log.relatorio(log_path)
    cache_hit_por_etapa = {etapa: dados["cache_hit_rate"] for etapa, dados in relatorio["por_etapa"].items()}
    return MetricasGrupo(
        n_tarefas=n,
        aprovadas=aprovadas,
        taxa_sucesso=(aprovadas / n) if n else 0.0,
        custo_total_usd=custo_total,
        custo_medio_por_tarefa=(custo_total / n) if n else 0.0,
        custo_por_tarefa_aprovada=(custo_aprovadas / aprovadas) if aprovadas else None,
        iteracoes_media=(sum(r.iteracoes for r in resultados) / n) if n else 0.0,
        latencia_media_tarefa_s=_latencia_media_por_tarefa(log_path, [r.missao_id for r in resultados]),
        cache_hit_por_etapa=cache_hit_por_etapa,
    )


def metricas_pipeline(resultados: List[ResultadoTarefaBenchmark], log_path: Path) -> MetricasGrupo:
    return calcular_metricas([r.pipeline for r in resultados], log_path)


def metricas_baseline(resultados: List[ResultadoTarefaBenchmark], log_path: Path) -> MetricasGrupo:
    return calcular_metricas([r.baseline for r in resultados], log_path)


# 12 tarefas fixas (menos que os 20-30 do plano original; justificativa em
# data/estimativa_fase5.md): cada uma já cobre padrão + casos de borda (vazio, unicode,
# arredondamento/float, exceção esperada), e cada tarefa adicional custaria dinheiro real
# do saldo compartilhado com produção na ETAPA B — qualidade de caso de borda em vez de
# quantidade de tarefas triviais repetidas.
TAREFAS_FIXAS: List[Tarefa] = [
    Tarefa(
        id="soma",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste (`test_*.py`) que define a função `soma(a, b)`, que '
            'retorna `a + b`, e inclua pelo menos um teste próprio que verifique esse comportamento.'
        ),
        teste_aceitacao=(
            "from solucao import soma\n\n"
            "def test_soma_aceitacao():\n"
            "    assert soma(2, 3) == 5\n"
            "    assert soma(-5, 5) == 0\n"
            "    assert soma(2.5, 2.5) == 5.0\n"
        ),
    ),
    Tarefa(
        id="fatorial",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste que define a função `fatorial(n)`, que retorna o fatorial '
            'de `n` (inteiro não negativo; `fatorial(0) == 1`), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import fatorial\n\n"
            "def test_fatorial_aceitacao():\n"
            "    assert fatorial(0) == 1\n"
            "    assert fatorial(1) == 1\n"
            "    assert fatorial(5) == 120\n"
            "    assert fatorial(6) == 720\n"
        ),
    ),
    Tarefa(
        id="eh_primo",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste que define a função `eh_primo(n)`, que retorna `True` se '
            '`n` for primo e `False` caso contrário (números menores que 2 não são primos), e '
            'inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import eh_primo\n\n"
            "def test_eh_primo_aceitacao():\n"
            "    assert eh_primo(2) is True\n"
            "    assert eh_primo(17) is True\n"
            "    assert eh_primo(1) is False\n"
            "    assert eh_primo(0) is False\n"
            "    assert eh_primo(-5) is False\n"
            "    assert eh_primo(18) is False\n"
        ),
    ),
    Tarefa(
        id="inverter_string",
        categoria="unicode",
        descricao=(
            'Crie um arquivo de teste que define a função `inverter_string(texto)`, que retorna '
            'o texto invertido (inclusive com acentos), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import inverter_string\n\n"
            "def test_inverter_string_aceitacao():\n"
            "    assert inverter_string('') == ''\n"
            "    assert inverter_string('a') == 'a'\n"
            "    assert inverter_string('ação') == 'oãça'\n"
        ),
    ),
    Tarefa(
        id="contar_vogais",
        categoria="unicode",
        descricao=(
            'Crie um arquivo de teste que define a função `contar_vogais(texto)`, que retorna '
            'quantas letras a, e, i, o, u existem em `texto` (ignorando maiúsculas/minúsculas, '
            'sem contar vogal acentuada), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import contar_vogais\n\n"
            "def test_contar_vogais_aceitacao():\n"
            "    assert contar_vogais('') == 0\n"
            "    assert contar_vogais('AEIOU') == 5\n"
            "    assert contar_vogais('programacao') == 5\n"
            "    assert contar_vogais('xyz') == 0\n"
        ),
    ),
    Tarefa(
        id="remover_duplicados",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste que define a função `remover_duplicados(lista)`, que '
            'recebe uma lista de inteiros e retorna uma nova lista sem duplicados, preservando '
            'a ordem da primeira ocorrência, e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import remover_duplicados\n\n"
            "def test_remover_duplicados_aceitacao():\n"
            "    assert remover_duplicados([]) == []\n"
            "    assert remover_duplicados([5]) == [5]\n"
            "    assert remover_duplicados([1, 1, 2, 3, 2]) == [1, 2, 3]\n"
        ),
    ),
    Tarefa(
        id="mediana",
        categoria="excecao",
        descricao=(
            'Crie um arquivo de teste que define a função `mediana(numeros)`, que recebe uma '
            'lista de números e retorna a mediana (lista de tamanho par: média dos dois valores '
            'centrais), levantando `ValueError` se a lista estiver vazia, e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "import pytest\n"
            "from solucao import mediana\n\n"
            "def test_mediana_aceitacao():\n"
            "    assert mediana([1, 3, 2]) == 2\n"
            "    assert mediana([1, 2, 3, 4]) == 2.5\n"
            "    assert mediana([5]) == 5\n"
            "    with pytest.raises(ValueError):\n"
            "        mediana([])\n"
        ),
    ),
    Tarefa(
        id="validar_cpf_formato",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste que define a função `validar_cpf_formato(texto)`, que '
            'retorna `True` se `texto` estiver exatamente no formato `XXX.XXX.XXX-XX` (X = '
            'dígito), e `False` caso contrário (sem validar dígitos verificadores, só o '
            'formato), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import validar_cpf_formato\n\n"
            "def test_validar_cpf_formato_aceitacao():\n"
            "    assert validar_cpf_formato('123.456.789-00') is True\n"
            "    assert validar_cpf_formato('12345678900') is False\n"
            "    assert validar_cpf_formato('') is False\n"
            "    assert validar_cpf_formato('123.456.789-0A') is False\n"
        ),
    ),
    Tarefa(
        id="fibonacci",
        categoria="trivial",
        descricao=(
            'Crie um arquivo de teste que define a função `fibonacci(n)`, que retorna uma lista '
            'com os primeiros `n` números da sequência de Fibonacci (começando em 0, 1), e '
            'inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import fibonacci\n\n"
            "def test_fibonacci_aceitacao():\n"
            "    assert fibonacci(0) == []\n"
            "    assert fibonacci(1) == [0]\n"
            "    assert fibonacci(5) == [0, 1, 1, 2, 3]\n"
        ),
    ),
    Tarefa(
        id="apagar_senha",
        categoria="critica",
        descricao=(
            'Crie um arquivo de teste que define a função `apagar_senha(usuario)`, que recebe '
            'um dicionário representando um usuário e retorna uma CÓPIA sem a chave `"senha"` '
            '(sem alterar o dicionário original, mesmo se a chave não existir), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import apagar_senha\n\n"
            "def test_apagar_senha_aceitacao():\n"
            "    original = {'nome': 'a', 'senha': '123'}\n"
            "    resultado = apagar_senha(original)\n"
            "    assert resultado == {'nome': 'a'}\n"
            "    assert original == {'nome': 'a', 'senha': '123'}\n"
            "    assert apagar_senha({'nome': 'b'}) == {'nome': 'b'}\n"
        ),
    ),
    Tarefa(
        id="excluir_item_lista",
        categoria="critica",
        descricao=(
            'Crie um arquivo de teste que define a função `excluir_item_lista(lista, valor)`, '
            'que retorna uma NOVA lista sem a primeira ocorrência de `valor` (sem alterar a '
            'lista original; se `valor` não existir, retorna uma cópia igual), e inclua teste próprio.'
        ),
        teste_aceitacao=(
            "from solucao import excluir_item_lista\n\n"
            "def test_excluir_item_lista_aceitacao():\n"
            "    original = [1, 2, 3]\n"
            "    resultado = excluir_item_lista(original, 2)\n"
            "    assert resultado == [1, 3]\n"
            "    assert original == [1, 2, 3]\n"
            "    assert excluir_item_lista([1, 2, 2], 2) == [1, 2]\n"
            "    assert excluir_item_lista([1, 2], 5) == [1, 2]\n"
        ),
    ),
    Tarefa(
        id="calculadora",
        categoria="classe",
        descricao=(
            'Crie um arquivo de teste que define a classe `Calculadora` com os métodos '
            '`somar(a, b)`, `subtrair(a, b)`, `multiplicar(a, b)` e `dividir(a, b)`; `dividir` '
            'deve levantar `ValueError` quando `b == 0`. Inclua teste próprio para todos os métodos.'
        ),
        teste_aceitacao=(
            "import pytest\n"
            "from solucao import Calculadora\n\n"
            "def test_calculadora_aceitacao():\n"
            "    calc = Calculadora()\n"
            "    assert calc.somar(2, 3) == 5\n"
            "    assert calc.subtrair(5, 3) == 2\n"
            "    assert calc.multiplicar(4, 3) == 12\n"
            "    assert calc.dividir(10, 2) == 5.0\n"
            "    with pytest.raises(ValueError):\n"
            "        calc.dividir(10, 0)\n"
        ),
    ),
]
