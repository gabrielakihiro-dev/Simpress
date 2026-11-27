# Fase E — execução controlada (removida em 26/11/2026)

A orquestração (`domains/sebrae_orquestracao.py`), a ligação (`scripts/sebrae_rotina.py`) e o roteiro de execução real do fluxo antigo foram removidos em 26/11/2026. `--rotina sebrae` roda `sebrae_leitura` (só leitura do SoftExpert). `data/state/sebrae_config.json` e o diário do Excel deixaram de ser lidos. Ver `docs/operacao/sincronizar-chamados-sebrae.md`, seção "Fluxo antigo removido".
