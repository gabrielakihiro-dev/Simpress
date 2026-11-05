import dataclasses
import json

import pytest

from motor.pipeline import MissaoError, decidir_juiz, executar_missao
from fakes import fake_chamador

PLANO = json.dumps({"passos": ["somar dois números"], "arquivo_alvo": "test_soma.py"})
CODIGO_GRANDE = json.dumps({
    "arquivo": "test_soma.py",
    "conteudo": (
        "def soma(a, b):\n"
        "    return a + b\n"
        "\n"
        "\n"
        "def test_soma_inteiros():\n"
        "    assert soma(1, 2) == 3\n"
    ),
})


def _config_com_limite_pequeno(config_teste):
    # config_teste.limites.limite_linhas_grande (padrão 100) é alto de propósito pra não
    # confundir os outros testes do pipeline; aqui baixamos só pra testar a rota "grande".
    limites = dataclasses.replace(config_teste.limites, limite_linhas_grande=5)
    return dataclasses.replace(config_teste, limites=limites)


def test_tarefa_grande_sem_palavra_critica_ainda_assim_aciona_juiz(config_teste, log_path):
    # CODIGO_GRANDE tem 6 linhas, >= limite_linhas_grande=5, e a tarefa não contém nenhuma
    # PALAVRA_CRITICA.
    config = _config_com_limite_pequeno(config_teste)
    chamador = fake_chamador([PLANO, CODIGO_GRANDE, "aprovado"])

    resultado = executar_missao("Crie uma função de soma com teste.", config, chamador, log_path)

    assert resultado.ok is True
    from motor import usage_log
    assert usage_log.relatorio(log_path)["por_etapa"]["juiz"]["chamadas"] == 1


def test_tipo_sem_rota_conhecida_e_erro_explicito():
    with pytest.raises(MissaoError, match="sem rota conhecida"):
        decidir_juiz("tipo_inexistente")


def test_juiz_recebe_diff_testes_e_lint_na_mensagem(config_teste, log_path):
    config = _config_com_limite_pequeno(config_teste)
    respostas = [PLANO, CODIGO_GRANDE, "aprovado"]
    chamadas = []

    def chamador(modelo, mensagens, max_tokens, temperatura, missao_id):
        chamadas.append((modelo, mensagens))
        from motor.llm_adapter import ResultadoChamada
        return ResultadoChamada(
            modelo=modelo, conteudo=respostas.pop(0), prompt_tokens=100, cached_tokens=0,
            completion_tokens=10, custo_usd=0.0001, custo_origem="estimated", latencia_s=0.001,
        )

    resultado = executar_missao("Crie uma função de soma com teste.", config, chamador, log_path)

    assert resultado.ok is True
    _, mensagens_juiz = chamadas[-1]
    conteudo_user = mensagens_juiz[1]["content"]
    assert "Diff do código gerado" in conteudo_user
    assert "Saída do pytest" in conteudo_user
    assert "Saída do ruff" in conteudo_user
    # 1ª iteração: sem versão anterior, o diff cai no fallback documentado (código completo).
    assert "sem código anterior para diff" in conteudo_user
    assert "passed" in conteudo_user
    # ruff ausente no ambiente de teste não pode virar "achado de lint" (caminho local vazando).
    assert "No module named" not in conteudo_user


CODIGO_FALHA = json.dumps({
    "arquivo": "test_senha.py",
    "conteudo": "def test_senha():\n    assert False\n",
})
CODIGO_OK_SENHA = json.dumps({
    "arquivo": "test_senha.py",
    "conteudo": "def test_senha():\n    assert True\n",
})


def test_juiz_recebe_diff_e_codigo_completo_na_2a_iteracao(config_teste, log_path):
    # tarefa crítica (palavra "senha"): juiz roda mesmo com código pequeno. 1ª tentativa falha
    # no harness, 2ª passa; o juiz tem que ver o diff contra a tentativa anterior E o código
    # final completo (dossiê Fase 2: perder o código completo ao trocar por diff é regressão).
    respostas = [PLANO, CODIGO_FALHA, CODIGO_OK_SENHA, "aprovado"]
    chamadas = []

    def chamador(modelo, mensagens, max_tokens, temperatura, missao_id):
        chamadas.append((modelo, mensagens))
        from motor.llm_adapter import ResultadoChamada
        return ResultadoChamada(
            modelo=modelo, conteudo=respostas.pop(0), prompt_tokens=100, cached_tokens=0,
            completion_tokens=10, custo_usd=0.0001, custo_origem="estimated", latencia_s=0.001,
        )

    resultado = executar_missao("Troque a senha do usuário.", config_teste, chamador, log_path)

    assert resultado.ok is True
    _, mensagens_juiz = chamadas[-1]
    conteudo_user = mensagens_juiz[1]["content"]
    assert "@@" in conteudo_user  # marcador de diff unificado contra a tentativa anterior
    assert "def test_senha():\n    assert True" in conteudo_user  # código final completo, não só o diff
