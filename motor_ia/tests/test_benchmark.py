import json

import pytest
from fakes import fake_chamador

from motor import benchmark
from motor.benchmark import TAREFAS_FIXAS, calcular_metricas, metricas_baseline, metricas_pipeline, rodar_benchmark, rodar_pipeline, resolver_baseline

# Implementação de referência (correta) de cada uma das 12 tarefas fixas, usada só pra
# provar que o teste oculto de cada tarefa (import, nomes, casos de borda) está certo —
# sem isso, um erro de digitação no teste oculto de uma tarefa nunca testada (ex.: typo no
# nome do parâmetro) só apareceria numa rodada real, pagando a ETAPA B.
_SOLUCOES_REFERENCIA = {
    "soma": "def soma(a, b):\n    return a + b\n",
    "fatorial": (
        "def fatorial(n):\n    resultado = 1\n    for i in range(2, n + 1):\n        resultado *= i\n    return resultado\n"
    ),
    "eh_primo": (
        "def eh_primo(n):\n"
        "    if n < 2:\n        return False\n"
        "    for i in range(2, int(n ** 0.5) + 1):\n        if n % i == 0:\n            return False\n"
        "    return True\n"
    ),
    "inverter_string": "def inverter_string(texto):\n    return texto[::-1]\n",
    "contar_vogais": "def contar_vogais(texto):\n    return sum(1 for c in texto.lower() if c in 'aeiou')\n",
    "remover_duplicados": (
        "def remover_duplicados(lista):\n"
        "    vistos = set()\n    resultado = []\n"
        "    for item in lista:\n"
        "        if item not in vistos:\n            vistos.add(item)\n            resultado.append(item)\n"
        "    return resultado\n"
    ),
    "mediana": (
        "def mediana(numeros):\n"
        "    if not numeros:\n        raise ValueError('lista vazia')\n"
        "    ordenado = sorted(numeros)\n    n = len(ordenado)\n    meio = n // 2\n"
        "    if n % 2 == 0:\n        return (ordenado[meio - 1] + ordenado[meio]) / 2\n"
        "    return ordenado[meio]\n"
    ),
    "validar_cpf_formato": (
        "import re\n\n\n"
        "def validar_cpf_formato(texto):\n    return bool(re.fullmatch(r'\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}', texto))\n"
    ),
    "fibonacci": (
        "def fibonacci(n):\n"
        "    seq = []\n    a, b = 0, 1\n"
        "    for _ in range(n):\n        seq.append(a)\n        a, b = b, a + b\n"
        "    return seq\n"
    ),
    "apagar_senha": (
        "def apagar_senha(usuario):\n    copia = dict(usuario)\n    copia.pop('senha', None)\n    return copia\n"
    ),
    "excluir_item_lista": (
        "def excluir_item_lista(lista, valor):\n"
        "    nova = list(lista)\n    if valor in nova:\n        nova.remove(valor)\n    return nova\n"
    ),
    "calculadora": (
        "class Calculadora:\n"
        "    def somar(self, a, b):\n        return a + b\n\n"
        "    def subtrair(self, a, b):\n        return a - b\n\n"
        "    def multiplicar(self, a, b):\n        return a * b\n\n"
        "    def dividir(self, a, b):\n"
        "        if b == 0:\n            raise ValueError('divisão por zero')\n"
        "        return a / b\n"
    ),
}

PLANO = json.dumps({"passos": ["escrever teste"], "arquivo_alvo": "test_soma.py"})
CODIGO_SOMA_OK = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": "def soma(a, b):\n    return a + b\n\n\ndef test_soma():\n    assert soma(2, 3) == 5\n",
})
CODIGO_VAZIO_TRAPACA = json.dumps({
    "arquivo": "test_trapaca.py",
    "conteudo": "def test_trapaca():\n    assert True\n",
})
TAREFA_SOMA = next(t for t in TAREFAS_FIXAS if t.id == "soma")


def test_tarefas_fixas_sanidade():
    assert len(TAREFAS_FIXAS) == 12
    assert len({t.id for t in TAREFAS_FIXAS}) == 12
    for tarefa in TAREFAS_FIXAS:
        assert "from solucao import" in tarefa.teste_aceitacao
        assert tarefa.descricao.strip()


@pytest.mark.parametrize("tarefa", TAREFAS_FIXAS, ids=[t.id for t in TAREFAS_FIXAS])
def test_teste_oculto_aceita_solucao_de_referencia_de_cada_tarefa(tarefa, tmp_path):
    """Roda, sem chamar nenhum modelo, o teste oculto de CADA uma das 12 tarefas contra uma
    implementação de referência correta — prova que o teste oculto em si (imports, nomes,
    casos de borda) está certo pras 10 tarefas que nenhum outro teste aqui exercita."""
    solucao = _SOLUCOES_REFERENCIA[tarefa.id]
    assert benchmark._validar_aceitacao(solucao, tarefa.teste_aceitacao, tmp_path / tarefa.id)


def test_pipeline_aprova_solucao_correta(config_teste, log_path):
    chamador = fake_chamador([PLANO, CODIGO_SOMA_OK])
    resultado = rodar_pipeline(TAREFA_SOMA, config_teste, chamador, log_path, config_teste.sandbox_dir)
    assert resultado.ok is True
    assert resultado.ok_proprio is True


def test_baseline_aprova_solucao_correta(config_teste, log_path):
    chamador = fake_chamador([CODIGO_SOMA_OK])
    resultado = resolver_baseline(TAREFA_SOMA, config_teste, chamador, log_path, config_teste.sandbox_dir)
    assert resultado.ok is True
    assert resultado.ok_proprio is True
    assert resultado.iteracoes == 1


def test_teste_oculto_pega_trapaca_do_proprio_teste(config_teste, log_path):
    """O modelo escreve um teste vazio (`assert True`) sem implementar `soma`: o harness do
    próprio braço passa (ok_proprio=True), mas o teste oculto (que importa `soma` de verdade)
    reprova — é esse mecanismo que torna o benchmark honesto."""
    chamador = fake_chamador([PLANO, CODIGO_VAZIO_TRAPACA])
    resultado = rodar_pipeline(TAREFA_SOMA, config_teste, chamador, log_path, config_teste.sandbox_dir)
    assert resultado.ok_proprio is True
    assert resultado.ok is False


def test_baseline_schema_invalido_nao_quebra_metricas(config_teste, log_path):
    chamador = fake_chamador(["não é json", "ainda não é json"])
    resultado = resolver_baseline(TAREFA_SOMA, config_teste, chamador, log_path, config_teste.sandbox_dir)
    assert resultado.ok is False
    assert resultado.iteracoes == 0

    metricas = calcular_metricas([resultado], log_path)
    assert metricas.n_tarefas == 1
    assert metricas.aprovadas == 0
    assert metricas.taxa_sucesso == 0.0
    assert metricas.custo_por_tarefa_aprovada is None


def test_metricas_agregam_custo_sucesso_iteracoes_cache(config_teste, tmp_path):
    log_pipeline = tmp_path / "log_pipeline.jsonl"
    log_baseline = tmp_path / "log_baseline.jsonl"
    sandbox_dir = tmp_path / "sandbox_benchmark"
    tarefas = [t for t in TAREFAS_FIXAS if t.id in ("soma", "fatorial")]

    codigo_fatorial_ok = json.dumps({
        "arquivo": "test_fatorial.py",
        "conteudo": (
            "def fatorial(n):\n    return 1 if n <= 1 else n * fatorial(n - 1)\n\n\n"
            "def test_fatorial():\n    assert fatorial(5) == 120\n"
        ),
    })
    chamador_pipeline = fake_chamador([PLANO, CODIGO_SOMA_OK, PLANO, codigo_fatorial_ok], cached_tokens=20)
    chamador_baseline = fake_chamador([CODIGO_SOMA_OK, codigo_fatorial_ok], cached_tokens=20)

    resultados = rodar_benchmark(tarefas, config_teste, chamador_pipeline, chamador_baseline, log_pipeline, log_baseline, sandbox_dir)
    assert len(resultados) == 2

    m_pipeline = metricas_pipeline(resultados, log_pipeline)
    m_baseline = metricas_baseline(resultados, log_baseline)

    assert m_pipeline.n_tarefas == 2
    assert m_pipeline.aprovadas == 2
    assert m_pipeline.taxa_sucesso == 1.0
    assert m_pipeline.custo_por_tarefa_aprovada is not None
    assert m_pipeline.iteracoes_media == 1.0
    assert m_pipeline.latencia_media_tarefa_s > 0
    assert all(taxa > 0 for taxa in m_pipeline.cache_hit_por_etapa.values())

    assert m_baseline.n_tarefas == 2
    assert m_baseline.aprovadas == 2
    assert m_baseline.custo_total_usd > 0


def test_pipeline_e_baseline_comparaveis_na_mesma_tarefa(config_teste, log_path, tmp_path):
    log_baseline = tmp_path / "log_baseline.jsonl"
    chamador_pipeline = fake_chamador([PLANO, CODIGO_SOMA_OK])
    chamador_baseline = fake_chamador([CODIGO_SOMA_OK])

    resultado_pipeline = rodar_pipeline(TAREFA_SOMA, config_teste, chamador_pipeline, log_path, config_teste.sandbox_dir)
    resultado_baseline = resolver_baseline(TAREFA_SOMA, config_teste, chamador_baseline, log_baseline, config_teste.sandbox_dir)

    assert resultado_pipeline.ok is True
    assert resultado_baseline.ok is True
    assert resultado_pipeline.missao_id != resultado_baseline.missao_id
    assert isinstance(resultado_pipeline.custo_usd, float)
    assert isinstance(resultado_baseline.custo_usd, float)
