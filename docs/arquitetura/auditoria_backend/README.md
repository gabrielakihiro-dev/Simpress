# Auditoria do backend

Documentos desta pasta:

- [auditoria_backend.md](auditoria_backend.md): diagnóstico por pilar, matriz de riscos e roteiro de refatoração (13/10/2026).
- [auditoria_backend_2026-10-15.md](auditoria_backend_2026-10-15.md): segunda rodada (segurança local, integridade dos dados, concorrência e medição de memória), com o status atualizado dos pendentes e a situação de cada achado após as correções (seção 7).
- [auditoria_backend_2026-11-13.md](auditoria_backend_2026-11-13.md): terceira rodada, só leitura: situação de cada item anterior no código atual, métricas, achados novos e roteiro (13/11/2026).
- [onedrive_pastas_de_trabalho.md](onedrive_pastas_de_trabalho.md): backoff de `PermissionError` e exclusão das pastas de trabalho da sincronização do OneDrive (passo 4).
- [hierarquia_de_locks.md](hierarquia_de_locks.md): ordem global → arquivo → lock Python folha, inversões corrigidas e teste de regressão (passo 5).

Contexto anterior: [auditoria_arquitetura.md](../auditoria_arquitetura.md) e [execucao_auditoria_arquitetura.md](../execucao_auditoria_arquitetura.md).

## Situação do roteiro em 15/10/2026

Concluídos: passos 0 a 5 e 9. A configuração única de logging fica em `core/logging_setup.py`, com console e arquivo rotativo em `data/logs/simpress.log`. A middleware registra a pilha das falhas 500 sem a mensagem da exceção.

Também foram adicionados nesta rodada:
- cabeçalhos de proteção do navegador em todas as respostas;
- recusa de chamadas `/api/` marcadas pelo navegador como vindas de outro site (`Sec-Fetch-Site`);
- resposta 409 para `FileBusyError` em rotas sem mapeamento próprio. A prontidão durante uma importação deixa de virar 500.

Pendentes em 15/10:
- passo 6 (anotações: separar "ilegível" de "inválido" e cachear a listagem);
- passo 7 (prontidão sem o lock global);
- passo 8 (memória do parse);
- passo 10 (extrações de `main.py`);
- a tipagem do passo 11.

## Situação em 13/11/2026

Os passos 6 e 7 foram concluídos. Os passos 8, 10 e 11 seguem parciais: o `main.py` tem 2.454 linhas, mas as fábricas de router cresceram, e o mypy estrito cobre só `core/`, `domains/` e `security/` (`routers/` e `main.py` ficam no modo gradual). Detalhes e evidências em [auditoria_backend_2026-11-13.md](auditoria_backend_2026-11-13.md).
