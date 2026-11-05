"""Uma chamada real e barata (fora da suíte de testes) para medir custo/latência de verdade.

Uso: `python scripts/chamada_real_exemplo.py` (a partir de `motor_ia/`), com o `.env` de
`Jarvis-Simpress` ou `OPENROUTER_API_KEY`/`DEEPSEEK_API_KEY` já no ambiente.
"""

import sys
from pathlib import Path

try:
    # Rede corporativa com TLS interceptado: o certifi padrão do urllib rejeita a CA
    # (falta keyUsage); o repo já lista `truststore` para isso (usa o certstore do Windows).
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

MOTOR_IA_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MOTOR_IA_DIR))

from motor import usage_log
from motor.config import OpenRouterSettings, carregar_config
from motor.llm_adapter import chamar_modelo

ENV_FILE = MOTOR_IA_DIR.parent.parent / "Jarvis-Simpress" / ".env"  # motor_ia/ está em Simpress/; Jarvis-Simpress/ é irmã de Simpress/
LOG_PATH = MOTOR_IA_DIR / "data" / "usage_log.jsonl"


def main() -> None:
    config = carregar_config()
    settings = OpenRouterSettings.load(env_file=ENV_FILE)
    if not settings.configured:
        print("Sem OPENROUTER_API_KEY/DEEPSEEK_API_KEY configurada; nada a chamar.")
        return

    modelo = config.modelos.deepseek_direto if settings.deepseek else config.modelos.planejador
    resultado = chamar_modelo(
        settings, config, modelo,
        [{"role": "user", "content": "Responda só com a palavra: ok"}],
        max_tokens=16, temperatura=0.0, missao_id="exemplo-real-01",
    )
    usage_log.registrar(LOG_PATH, "exemplo-real-01", "conexao", resultado)  # etapa própria: não é "plano" de missão nenhuma

    print(f"modelo real usado: {resultado.modelo}")
    print(f"conteúdo: {resultado.conteudo!r}")
    print(f"prompt_tokens={resultado.prompt_tokens} cached_tokens={resultado.cached_tokens} "
          f"completion_tokens={resultado.completion_tokens}")
    print(f"custo_usd={resultado.custo_usd} ({resultado.custo_origem}) latencia_s={resultado.latencia_s:.3f}")
    print(f"relatório acumulado em {LOG_PATH}:")
    print(usage_log.relatorio(LOG_PATH))


if __name__ == "__main__":
    main()
