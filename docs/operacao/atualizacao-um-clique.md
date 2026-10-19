# Atualização com um clique no `iniciar_servidor.bat`

Especificação da verificação de versão nova feita pelo inicializador. A lógica fica em `scripts/check_update.py` (somente biblioteca padrão, testável) e o `.bat` apenas a chama. Como numerar e publicar versões está em [Versionamento](../guias/versionamento.md).

## Objetivo

Ao iniciar o Simpress, avisar o operador quando houver uma **versão publicada** mais nova que a instalada e permitir atualizar com uma resposta `S`, sem riscos para os dados locais. Versão publicada é uma tag `vX.Y.Z` no `origin` criada em um commit do `main` com CI verde. Commits novos no `main` sem tag **nunca** são oferecidos, para que um `main` temporariamente quebrado não chegue ao operador. A atualização é sempre opcional; qualquer problema resulta em "não atualizar" e o servidor inicia normalmente com a versão atual.

## Versões

- Só contam tags exatamente no formato `vMAJOR.MINOR.PATCH` (por exemplo `v1.0.0`, `v1.10.2`). Pré-versões (`v2.0.0-rc1`), tags sem `v` e outros nomes são ignorados.
- As tags são lidas do `origin` (`git ls-remote --tags origin "v*"`), e não das tags locais; uma tag criada só na máquina do operador nunca é oferecida.
- A comparação é numérica (`v1.10.0` é maior que `v1.9.0`). Para tags anotadas, vale o commit apontado pela tag.
- **Versão instalada:** a maior tag do `origin` cujo commit já está no histórico do `HEAD`. Se nenhuma estiver, a instalação é tratada como "nenhuma versão publicada".
- **Versão oferecida:** a maior tag do `origin`.

## Fluxo

1. O `.bat` define o Python de preparação (o da `.venv` ou o do sistema) e chama `scripts/check_update.py --project-root <pasta>` **antes** de preparar o ambiente.
2. O script verifica, nesta ordem, e para no primeiro motivo de não atualizar:
   1. verificação desativada por `SIMPRESS_VERIFICAR_ATUALIZACAO=0`;
   2. Git disponível no `PATH`;
   3. pasta é um repositório Git;
   4. branch atual é `main` (não HEAD destacado nem outro branch);
   5. `git ls-remote --tags origin "v*"` concluído (sem rede, sem remoto ou tempo esgotado → não atualiza);
   6. existe ao menos uma tag `vX.Y.Z` no `origin` (sem nenhuma, explica que nenhuma versão foi publicada e que commits sem tag não são oferecidos);
   7. `git fetch --no-tags origin main` concluído;
   8. a maior tag é mais nova que a versão instalada;
   9. o commit da tag está no histórico de `origin/main` (tag criada em outro branch é ignorada);
   10. o `HEAD` está no histórico da tag (commits locais próprios ou histórico divergente impedem o fast-forward);
   11. não há alterações locais **rastreadas** (arquivos não rastreados e `data/` não contam e nunca são tocados).
3. Se tudo estiver certo, mostra `Versão nova disponível: vX.Y.Z (instalada: vA.B.C).` e o trecho do `CHANGELOG.md` **do commit da tag** com as seções de todas as versões depois da instalada até a nova (até 40 linhas; a seção `[Não lançado]` não aparece). Depois pergunta: `Há uma versão nova (vX.Y.Z). Atualizar agora? (S/N)`. Só `S`/`SIM` (sem diferenciar maiúsculas) atualiza; qualquer outra resposta, Enter vazio ou entrada indisponível mantém a versão atual.
4. Atualiza somente com `git merge --ff-only <commit da tag>`: avança o `main` local até a tag, sem criar commit de merge e sem passar dela, mesmo que o `origin/main` já tenha commits mais novos.
5. Depois do fast-forward:
   - se `requirements.txt` mudou, avisa que as dependências serão reinstaladas; o `bootstrap_environment.py`, que roda em seguida, detecta a mudança pelo hash e reinstala na `.venv`;
   - se o próprio `iniciar_servidor.bat` mudou, o script sai com código `3` e o `.bat` se reinicia uma única vez (`call "%~f0"`) para não continuar lendo um arquivo alterado no meio da execução. A segunda execução não verifica atualização de novo.
6. O `.bat` segue o fluxo existente: preparar ambiente, migração, limpeza, porta e servidor.

Proibido em qualquer caso: `reset`, `clean`, `stash` (automático ou não), `checkout` de arquivos, `--force`, `pull`, merge que não seja `--ff-only`, rebase e criação de tags. O Git roda com `GIT_TERMINAL_PROMPT=0` para nunca ficar esperando senha.

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
| Nenhuma tag | `Nenhuma versão publicada foi encontrada no servidor (tag no formato v1.2.3).` + `A atualização automática só oferece versões testadas e publicadas com tag; commits novos sem tag não são oferecidos.` |
| Já atualizado | `Você já está na versão mais recente (vX.Y.Z).` |
| Tag fora do main | `A versão vX.Y.Z não está no histórico de origin/main; a atualização foi ignorada.` |
| Divergente | `A versão local tem commits que não estão na versão vX.Y.Z; a atualização automática não é possível.` |
| Alterações rastreadas | `Há uma versão nova (vX.Y.Z), mas existem alterações locais em arquivos do projeto:` + lista |
| Versão nova | `Versão nova disponível: vX.Y.Z (instalada: vA.B.C).` + `O que mudou (trecho do CHANGELOG.md):` + seções |
| Sem notas | `O CHANGELOG.md não tem notas para a versão vX.Y.Z.` (a pergunta aparece mesmo assim) |
| Recusada | `Atualização adiada. Iniciando com a versão atual.` |
| Fast-forward falhou | `A atualização não foi aplicada (o fast-forward para vX.Y.Z falhou):` + saída do Git |
| Sucesso | `Atualização concluída: Simpress vX.Y.Z.` |
| Dependências | `O requirements.txt mudou; as dependências serão reinstaladas a seguir.` |
| `.bat` mudou | `O inicializador foi atualizado e será reiniciado.` |

Toda mensagem de não atualização termina com `Iniciando com a versão atual.`, exceto "Já atualizado", "Desativada", "Sem Git" e "Não é repositório".

## Configuração

- `SIMPRESS_VERIFICAR_ATUALIZACAO=0` (ou `nao`, `false`, `off`) desativa a verificação. Para deixar permanente no Windows: `setx SIMPRESS_VERIFICAR_ATUALIZACAO 0`.
- `SIMPRESS_ATUALIZACAO_TIMEOUT` define o limite em segundos do `git ls-remote`, do `git fetch` e do fast-forward (padrão 60).

## Critérios de aceite

- Com uma tag mais nova no `origin/main`, `main` limpo e resposta `S`, o `main` local avança até o commit da tag (e não além) e o servidor inicia com a versão nova.
- Antes da pergunta, aparecem a versão nova, a instalada e as notas do `CHANGELOG.md` de cada versão pulada.
- Commits novos no `main` sem tag não geram oferta de atualização.
- Sem nenhuma tag `vX.Y.Z` no `origin`, nada muda e o motivo é explicado.
- Tags fora do formato, tags só locais e tags fora do `origin/main` são ignoradas.
- Com resposta `N`, Enter ou entrada fechada, nada muda no repositório.
- Com alterações rastreadas, outro branch, HEAD destacado, histórico divergente, fast-forward recusado, sem Git, sem rede ou fora de repositório, nada muda, o motivo aparece em português e o servidor inicia.
- Arquivos não rastreados e `data/` permanecem intactos em todos os casos.
- Mudança em `requirements.txt` é avisada e reinstalada pelo bootstrap.
- Os casos acima têm testes automatizados em `tests/test_check_update.py`, com repositórios Git temporários reais (origem local com tags, sem rede) e com um executor simulado para falta de Git e tempo esgotado.
- Não é testado automaticamente: o `.bat` real contra o GitHub (exigiria uma tag publicada de verdade).
