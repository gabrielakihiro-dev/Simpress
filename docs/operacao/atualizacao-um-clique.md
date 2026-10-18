# Atualização com um clique no `iniciar_servidor.bat`

Especificação da verificação de versão nova feita pelo inicializador. A lógica fica em `scripts/check_update.py` (somente biblioteca padrão, testável) e o `.bat` apenas a chama.

## Objetivo

Ao iniciar o Simpress, avisar o operador quando houver uma versão nova em `origin/main` e permitir atualizar com uma resposta `S`, sem riscos para os dados locais. A atualização é sempre opcional; qualquer problema resulta em "não atualizar" e o servidor inicia normalmente com a versão atual.

## Fluxo

1. O `.bat` define o Python de preparação (o da `.venv` ou o do sistema) e chama `scripts/check_update.py --project-root <pasta>` **antes** de preparar o ambiente.
2. O script verifica, nesta ordem, e para no primeiro motivo de não atualizar:
   1. verificação desativada por `SIMPRESS_VERIFICAR_ATUALIZACAO=0`;
   2. Git disponível no `PATH`;
   3. pasta é um repositório Git;
   4. branch atual é `main` (não HEAD destacado nem outro branch);
   5. `git fetch origin main` concluído (sem rede, sem remoto ou tempo esgotado → não atualiza);
   6. existe commit novo em `origin/main` que ainda não está no `HEAD`;
   7. o `HEAD` não tem commits próprios que não estão em `origin/main` (histórico divergente impede fast-forward);
   8. não há alterações locais **rastreadas** (arquivos não rastreados e `data/` não contam e nunca são tocados).
3. Se tudo estiver certo, mostra os commits novos (até 10) e pergunta: `Há uma versão nova. Atualizar agora? (S/N)`. Só `S`/`SIM` (sem diferenciar maiúsculas) atualiza; qualquer outra resposta, Enter vazio ou entrada indisponível mantém a versão atual.
4. Atualiza somente com `git pull --ff-only origin main`.
5. Depois do pull:
   - se `requirements.txt` mudou, avisa que as dependências serão reinstaladas; o `bootstrap_environment.py`, que roda em seguida, detecta a mudança pelo hash e reinstala na `.venv`;
   - se o próprio `iniciar_servidor.bat` mudou, o script sai com código `3` e o `.bat` se reinicia uma única vez (`call "%~f0"`) para não continuar lendo um arquivo alterado no meio da execução. A segunda execução não verifica atualização de novo.
6. O `.bat` segue o fluxo existente: preparar ambiente, migração, limpeza, porta e servidor.

Proibido em qualquer caso: `reset`, `clean`, `stash` (automático ou não), `checkout` de arquivos, `--force`, merge ou rebase. O Git roda com `GIT_TERMINAL_PROMPT=0` para nunca ficar esperando senha.

## Códigos de saída do script

| Código | Significado | Ação do `.bat` |
| --- | --- | --- |
| 0 | Nada a fazer, atualização recusada/impossível ou atualização concluída | Segue normalmente |
| 3 | Atualizado e o `iniciar_servidor.bat` mudou | Reinicia o `.bat` uma vez |
| outro | Erro inesperado do próprio script | Segue normalmente |

## Mensagens

| Situação | Mensagem (resumo) |
| --- | --- |
| Desativada | `Verificação de atualização desativada (SIMPRESS_VERIFICAR_ATUALIZACAO=0).` |
| Sem Git | `Git não encontrado; a verificação de atualização foi ignorada.` |
| Não é repositório | `Esta pasta não é um repositório Git; a verificação de atualização foi ignorada.` |
| Outro branch | `Atualização automática disponível só no branch main (atual: X).` |
| HEAD destacado | `Não há branch ativo (HEAD destacado); a atualização foi ignorada.` |
| Sem rede/remoto | `Não foi possível consultar o servidor Git (sem rede ou sem acesso ao origin).` |
| Já atualizado | `Você já está na versão mais recente.` |
| Divergente | `A versão local tem commits que não estão em origin/main; a atualização automática não é possível.` |
| Alterações rastreadas | `Há uma versão nova, mas existem alterações locais em arquivos do projeto:` + lista |
| Recusada | `Atualização adiada. Iniciando com a versão atual.` |
| Fast-forward falhou | `A atualização não foi aplicada (git pull --ff-only falhou):` + saída do Git |
| Sucesso | `Atualização concluída.` |
| Dependências | `O requirements.txt mudou; as dependências serão reinstaladas a seguir.` |
| `.bat` mudou | `O inicializador foi atualizado e será reiniciado.` |

Toda mensagem de não atualização termina com `Iniciando com a versão atual.`

## Configuração

- `SIMPRESS_VERIFICAR_ATUALIZACAO=0` (ou `nao`, `false`, `off`) desativa a verificação. Para deixar permanente no Windows: `setx SIMPRESS_VERIFICAR_ATUALIZACAO 0`.
- `SIMPRESS_ATUALIZACAO_TIMEOUT` define o limite em segundos do `git fetch` e do `git pull` (padrão 60).

## Critérios de aceite

- Com versão nova, `main` limpo e resposta `S`, o pull fast-forward é aplicado e o servidor inicia com a versão nova.
- Com resposta `N`, Enter ou entrada fechada, nada muda no repositório.
- Com alterações rastreadas, outro branch, HEAD destacado, histórico divergente, sem Git, sem rede ou fora de repositório, nada muda, o motivo aparece em português e o servidor inicia.
- Arquivos não rastreados e `data/` permanecem intactos em todos os casos.
- Mudança em `requirements.txt` é avisada e reinstalada pelo bootstrap.
- Os casos acima têm testes automatizados em `tests/test_check_update.py`, com repositórios Git temporários reais (origem local, sem rede) e com um executor simulado para falta de Git.
- Não é testado automaticamente: o `.bat` real contra o GitHub (exigiria um pull de verdade).
