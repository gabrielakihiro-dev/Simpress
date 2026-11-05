from motor.harness import preparar_sandbox, rodar_harness


def test_sintaxe_invalida_e_detectada_no_codigo_real(tmp_path):
    # dossiê: o portão antigo checava uma string fixa, nunca o `resultado_codigo` de fato.
    sandbox = preparar_sandbox(tmp_path / "sandbox")
    resultado = rodar_harness(sandbox, "arquivo.py", "def f(:\n    pass\n")
    assert resultado.ok is False
    assert "Sintaxe inválida" in resultado.erro


def test_pytest_roda_de_verdade_no_sandbox(tmp_path):
    sandbox = preparar_sandbox(tmp_path / "sandbox")
    resultado = rodar_harness(sandbox, "test_ok.py", "def test_ok():\n    assert 1 == 1\n")
    assert resultado.ok is True
    assert resultado.caminho_escrito.exists()


def test_falha_de_teste_real_e_reportada(tmp_path):
    sandbox = preparar_sandbox(tmp_path / "sandbox")
    resultado = rodar_harness(sandbox, "test_falha.py", "def test_falha():\n    assert 1 == 2\n")
    assert resultado.ok is False
    assert resultado.assinatura_erro  # assinatura não vazia, usável pelo circuit breaker


def test_arquivo_sem_teste_nenhum_nao_passa_no_harness(tmp_path):
    # dossiê #4: o loop Harness->correção existia só no diagrama; nenhum teste rodava de fato.
    sandbox = preparar_sandbox(tmp_path / "sandbox")
    resultado = rodar_harness(sandbox, "soma.py", "def soma(a, b):\n    return a + b\n")
    assert resultado.ok is False
    assert "nenhum teste coletado" in resultado.erro
