"""Uma missão real de ponta a ponta (fora da suíte de testes), pelo pipeline da Fase 1.

Uso: `python scripts/missao_real_exemplo.py` (a partir de `motor_ia/`), com o `.env` de
`Jarvis-Simpress` já preenchido (OPENROUTER_API_KEY). Gasta de verdade, mas pouco: o teto por
missão em settings.toml é US$ 0,05.
"""

import functools
import sys
from pathlib import Path

try:
    # Mesma rede corporativa com TLS interceptado do script de exemplo anterior.
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

MOTOR_IA_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MOTOR_IA_DIR))

from motor import usage_log
from motor.config import OpenRouterSettings, carregar_config
from motor.llm_adapter import chamar_modelo
from motor.pipeline import executar_missao

ENV_FILE = MOTOR_IA_DIR.parent.parent / "Jarvis-Simpress" / ".env"  # motor_ia/ está em Simpress/; Jarvis-Simpress/ é irmã de Simpress/
LOG_PATH = MOTOR_IA_DIR / "data" / "usage_log.jsonl"


def main() -> None:
    config = carregar_config()
    settings = OpenRouterSettings.load(env_file=ENV_FILE)
    if not settings.configured:
        print("Sem OPENROUTER_API_KEY/DEEPSEEK_API_KEY configurada; nada a chamar.")
        return

    chamador = functools.partial(chamar_modelo, settings, config)
    resultado = executar_missao(
        "Crie a função soma(a, b) que retorna a + b, com um teste que verifica soma(2, 3) == 5.",
        config, chamador, LOG_PATH,
    )

    print(f"missao_id={resultado.missao_id} ok={resultado.ok} iteracoes={resultado.iteracoes}")
    print(f"motivo: {resultado.motivo}")
    print(f"custo_usd da missão: {resultado.custo_usd}")
    if resultado.arquivo_escrito:
        print(f"arquivo escrito: {resultado.arquivo_escrito}")
    print("relatório acumulado:")
    print(usage_log.relatorio(LOG_PATH))


if __name__ == "__main__":
    main()
