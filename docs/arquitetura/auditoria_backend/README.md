# Auditoria do backend

Documentos desta pasta:

- [auditoria_backend.md](auditoria_backend.md): diagnóstico por pilar, matriz de riscos e roteiro de refatoração (13/10/2026).
- [onedrive_pastas_de_trabalho.md](onedrive_pastas_de_trabalho.md): backoff de `PermissionError` e exclusão das pastas de trabalho da sincronização do OneDrive (passo 4).
- [hierarquia_de_locks.md](hierarquia_de_locks.md): ordem global → arquivo → lock Python folha, inversões corrigidas e teste de regressão (passo 5).

Contexto anterior: [auditoria_arquitetura.md](../auditoria_arquitetura.md) e [execucao_auditoria_arquitetura.md](../execucao_auditoria_arquitetura.md).

## Situação do roteiro em 15/10/2026

Concluídos: passos 0 a 5 e 9. A configuração única de logging fica em `core/logging_setup.py`, com console e arquivo rotativo em `data/logs/simpress.log`. A middleware registra a pilha das falhas 500 sem a mensagem da exceção.

Também foram adicionados nesta rodada:
- cabeçalhos de proteção do navegador em todas as respostas;
- recusa de chamadas `/api/` marcadas pelo navegador como vindas de outro site (`Sec-Fetch-Site`);
- resposta 409 para `FileBusyError` em rotas sem mapeamento próprio. A prontidão durante uma importação deixa de virar 500.

Pendentes:
- passo 6 (anotações: separar "ilegível" de "inválido" e cachear a listagem);
- passo 7 (prontidão sem o lock global);
- passo 8 (memória do parse);
- passo 10 (extrações de `main.py`, hoje com cerca de 4.150 linhas);
- a tipagem do passo 11.
