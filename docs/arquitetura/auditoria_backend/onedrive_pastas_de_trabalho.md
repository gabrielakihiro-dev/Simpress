# Pastas de trabalho fora da sincronização do OneDrive

Passo 4 do [roteiro da auditoria](auditoria_backend.md#roteiro-priorizado) (13/10/2026).

## Problema

`TRANSACTION_ROOT = BASE_DIR` (`core/config.py`), e o projeto fica em `OneDrive - SEBRAE`. Por isso, os arquivos de trabalho de cada gravação ficam em pasta sincronizada:

| Artefato | Onde | Vida útil |
| --- | --- | --- |
| `.transactions/<id>/` (manifesto e cópias de recuperação) | raiz do projeto | duração da transação, ou até a recuperação |
| `.<arquivo>.<aleatório>.tmp` e `.<arquivo>.formula-cache-*.tmp` | ao lado do arquivo de destino | segundos |
| `.<arquivo>.lock` e `..atomic-transactions.lock` | ao lado do destino e na raiz | enquanto o servidor grava |

Quando o OneDrive ou o antivírus abre um desses arquivos para enviar ou verificar, `os.replace` e `unlink` falham com `PermissionError` durante 1 a 3 s. Além disso, o OneDrive envia para a nuvem arquivos que vão ser apagados em seguida e pode criar cópias com conflito (`arquivo-NOME-PC.json`).

## O que o código faz agora

`core/integrity.py` aplica backoff exponencial com jitter só a `PermissionError` em `os.replace` (`_replace_with_retries`) e `unlink` (exclusão transacional e recuperação de `.transactions`):

- Espera inicial de 0,1 s, que dobra a cada tentativa até o limite de 1,5 s. Cada espera é sorteada entre 50% e 100% do valor nominal.
- Orçamento total de 8 s (`_PERMISSION_RETRY_BUDGET`). Depois disso, a operação lança `FileBusyError` (HTTP 409), com a mesma mensagem de antes.
- Outros `OSError` mantêm as 4 tentativas e as esperas de `_RETRY_DELAYS`.
- Os locks continuam com timeout de 15 s, então quem espera por um lock tolera um backoff completo.
- A recuperação de `.transactions` também tenta de novo antes de desistir. Se o tempo acabar, propaga o `PermissionError` original, como antes.

O backoff só reduz os 409 falsos e não resolve a causa. Um arquivo aberto no Excel continua gerando 409 depois de 8 s, que é o comportamento esperado.

## Recomendação

**Mover o projeto para uma pasta local fora do OneDrive (por exemplo, `C:\Simpress`) é a opção preferida.** O OneDrive não exclui uma subpasta e mantém a cópia local ao mesmo tempo. Em "Escolher pastas", desmarcar uma subpasta **apaga** a cópia local, então não use esse recurso em `.transactions` nem em `data/`.

Restrições que valem em qualquer opção:

1. **`.transactions`, os `.tmp` e os destinos precisam ficar no mesmo volume.** A atomicidade depende de `os.replace` no mesmo diretório, e a recuperação compara hashes das cópias em `.transactions`. Não aponte só `.transactions` para outro disco.
2. **Não exclua a pasta de anotações.** `HISTORY_ANNOTATIONS_DIR` (`OneDrive…\Aplicativos\Simpress\AnotacoesHistorico` ou `SIMPRESS_ANNOTATIONS_DIR`) depende do OneDrive para compartilhar anotações entre máquinas e clones (veja `AGENTS.md`). Ela é resolvida pela variável de ambiente do OneDrive, e não pela pasta do projeto, por isso continua sincronizando mesmo com o projeto fora do OneDrive.
3. **Não apague `.transactions` à mão.** Um manifesto pendente é a única forma de desfazer uma gravação interrompida. A inicialização recupera ou entra em modo leitura (passo 3).

Se não for possível mover o projeto:

- **Tipos de arquivo ignorados (OneDrive corporativo, requer TI):** a política de grupo *"Excluir tipos específicos de arquivos do carregamento"* aceita nomes com curinga. Inclua `*.tmp` e `*.lock`. Ela age por nome de arquivo, não por pasta, e não cobre `.transactions/*/manifest.json`.
- **Antivírus (requer TI):** exclua da verificação em tempo real a pasta `.transactions` e os padrões `.*.tmp` e `.*.lock` dentro do projeto. As planilhas finais continuam sendo verificadas.
- **Pausar a sincronização** durante importações grandes.

## Possível evolução

Tornar `TRANSACTION_ROOT` configurável por variável de ambiente permitiria tirar só os dados operacionais do OneDrive. Isso exigiria mover junto `data/` (destinos e `.tmp` ficam no mesmo diretório) e migrar transações pendentes. Por isso ficou fora deste passo.
