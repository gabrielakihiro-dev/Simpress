import pytest

from motor.circuit_breaker import CircuitBreaker, CircuitBreakerError


def test_para_no_custo_acima_do_teto_da_missao(config_teste, log_path):
    breaker = CircuitBreaker(limites=config_teste.limites, log_path=log_path)
    breaker.registrar_custo(0.02)
    with pytest.raises(CircuitBreakerError, match="Custo da missão"):
        breaker.registrar_custo(0.04)  # total 0.06 > teto 0.05


def test_erro_diferente_nao_dispara_o_breaker(config_teste, log_path):
    breaker = CircuitBreaker(limites=config_teste.limites, log_path=log_path)
    breaker.registrar_erro_harness("erro_a")
    breaker.registrar_erro_harness("erro_b")  # diferente do anterior: não conta como repetição
    breaker.registrar_erro_harness("erro_c")


def test_erro_repetido_dispara_o_breaker(config_teste, log_path):
    breaker = CircuitBreaker(limites=config_teste.limites, log_path=log_path)  # repeticoes_erro_para_parar = 2
    breaker.registrar_erro_harness("mesmo_erro")
    with pytest.raises(CircuitBreakerError, match="repetido 2x"):
        breaker.registrar_erro_harness("mesmo_erro")
