# Auditoria de arquitetura e qualidade de código

**Projeto:** Simpress
**Data da análise:** 8 de outubro de 2026
**Escopo:** leitura do código atual, sem refatorar a aplicação.

## Diagnóstico geral

O projeto tem boas proteções para dados operacionais, mas a evolução deixou responsabilidades e dependências concentradas demais. A prioridade é corrigir inconsistências entre disco, memória e anotações sincronizadas; depois, reorganizar os módulos.

Pontos fortes observados:

- Transações de arquivos com recuperação, validação e proteção contra alterações concorrentes.
- Preservação de fórmulas e componentes dos arquivos XLSX.
- Validação de entradas com Pydantic.
- Busca com valores previamente normalizados e ordenação determinística.
- Testes para corrupção de arquivos, duplicidades, revisões de equipamentos e anotações.

A estrutura de `routers/` e `domains/` é um avanço, mas a separação ainda é parcial: vários módulos dependem do `main.py` inteiro, acessam seu estado global e combinam regras, persistência e apresentação.

## Pontos críticos

### 1. Alta — Uma edição pode persistir e ainda retornar erro, deixando a memória desatualizada

**Arquivo:** `main.py`, função `save_equipment_to_excel`.

O código confirma a transação antes de terminar a construção do equipamento atualizado. Depois do `commit()`, ainda lê apelidos, consulta o Endpoint e reconstrói o índice de busca.

**Reproduzido com dados fictícios:** ao injetar uma exceção na consulta posterior, a planilha ficou com “Modelo depois”, o cache manteve “Modelo antes” e a chamada levantou erro.

**Impacto:** o usuário pode tentar novamente uma operação já gravada, enquanto consultas continuam mostrando dados antigos.

**Correção:** preparar e validar todo o próximo estado antes do commit. Depois da confirmação, publicar esse estado com uma operação mínima, sem novas leituras ou processamento.

### 2. Alta — Histórico local e anotações compartilhadas podem divergir

**Arquivo:** `routers/inventory_history.py`, rota de salvamento de anotação.

A rota grava primeiro o histórico local e depois o registro compartilhado. As gravações são independentes. Se a segunda falhar, a primeira permanece confirmada; na releitura, o registro compartilhado existente prevalece.

**Reproduzido:** a rota retornou `503`, o histórico local guardou “Depois” e a consulta seguinte exibiu “Antes”.

**Impacto:** uma anotação nova pode parecer perdida, com resultados diferentes entre a máquina atual e os clones.

**Correção:** registrar a anotação e uma pendência de sincronização na mesma transação local. A sincronização precisa ser idempotente e distinguir explicitamente “salvo localmente” de “sincronizado”. Uma cópia compartilhada antiga não deve sobrescrever silenciosamente uma atualização local pendente.

### 3. Alta — A restauração publica estado antes da confirmação da transação

**Arquivo:** `routers/inventory_history.py`, fluxo de restauração.

Após aplicar os arquivos, a restauração chama `load_database(transaction_locked=True)` com publicação habilitada. A confirmação do histórico e o `commit()` acontecem depois.

O mecanismo de rollback recupera o cache quando há falha, mas outra requisição pode consultar o estado provisório durante esse intervalo.

**Impacto:** exposição temporária de dados que ainda podem ser revertidos. É um risco identificado pelo fluxo; não reproduzi a concorrência completa da rota.

**Correção:** usar preparação sem publicação e publicar somente após confirmar arquivos e histórico.

### 4. Média — A separação de módulos mantém acoplamento ao módulo principal

**Arquivos:** `main.py`, montagem dos routers; `routers/equipment_search.py`.

O padrão `create_*_router(sys.modules[__name__])` fornece acesso a funções privadas, caches, locks, configurações e até bibliotecas como `ctx.json` e `ctx.hashlib`.

Isso funciona como um localizador de serviços: as dependências ficam escondidas e sem contrato explícito. Nos testes, essa característica aparece na necessidade de substituir muitos atributos de `main`.

**Impacto:** mudanças pequenas podem quebrar consumidores distantes; testes exigem configuração extensa; a tipagem oferece menos proteção.

**Correção:** receber funções ou serviços específicos e tipados. O `main.py` deve montar a aplicação, configurar dependências e registrar rotas.

### 5. Média — Funções grandes misturam responsabilidades diferentes

Trechos representativos:

- `main.py`: carregamento da base, 305 linhas.
- `domains/inventory_comparison.py`: comparação de planilhas, 400 linhas.
- `routers/inventory_history.py`: exportação do histórico, 277 linhas.
- `static/app.js`: modal de comparação reúne preparação dos dados, HTML, rótulos, eventos e autosave.

O tamanho sozinho não caracteriza erro. O problema é combinar etapas com motivos diferentes para mudar.

**Impacto:** revisão difícil, alterações com alcance imprevisível e testes que precisam exercitar fluxos inteiros para validar uma regra pequena.

**Correção:** separar leitura, normalização, comparação, preparação de estado e apresentação. A comparação usa estruturas adequadas para resolver correspondências; preserve esse algoritmo ao decompor a função.

### 6. Média — A manutenção de arquivos bloqueia uma rota assíncrona

**Arquivo:** `main.py`, rota `atualizar_planilhas`.

O processamento principal é enviado para uma thread, mas `prune_expired_histories()` é chamado diretamente depois do `await`. Essa função executa transações, acessos ao disco e exclusões de diretórios.

**Impacto:** bloqueio do loop de eventos enquanto a retenção trabalha, especialmente com arquivos ocupados ou armazenamento lento.

**Correção:** executar essa etapa fora do loop de eventos. A duração real desse bloqueio não foi medida nesta análise.

### 7. Média — O CI deixa testes relevantes da interface fora da execução

**Arquivo:** `.github/workflows/ci.yml`.

O CI executa dois arquivos JavaScript, totalizando 29 testes. Outros quatro arquivos contêm 23 testes de autosave, recuperação de rascunhos, repetição de requisições e busca no catálogo.

**Impacto:** regressões nessas funcionalidades podem passar pelo CI.

**Correção:** executar todos os arquivos de teste JavaScript e verificar a sintaxe dos módulos auxiliares.

### 8. Média — O tratamento de erros preserva mensagens amigáveis, mas perde evidência técnica

**Arquivos:** `domains/inventory_update.py` e `routers/inventory_history.py`.

Há capturas amplas de `Exception` que imprimem uma mensagem genérica, usam `continue` ou levantam uma nova exceção com `from None`.

Algumas permitem corretamente continuar lendo dados durante uma falha de sincronização. O problema é não registrar a causa e a operação afetada.

**Impacto:** dificuldade para distinguir indisponibilidade temporária, corrupção, erro de programação e falha após commit.

**Correção:** capturar erros esperados especificamente e registrar exceções inesperadas com traceback, operação e identificador do evento, sem expor conteúdo sensível.

### 9. Baixa — A listagem do histórico faz trabalho proporcional ao conteúdo completo

**Arquivo:** `routers/inventory_history.py`, rota de listagem.

Para entregar resumos, a rota carrega o histórico inteiro, lê os registros compartilhados e transforma os detalhes de cada comparação. A leitura também pode disparar migração de anotações legadas.

**Impacto:** custo crescente por consulta e efeitos de escrita escondidos em uma operação de leitura. Não há medição que permita classificá-lo como gargalo atual.

**Correção:** separar migração de consulta, gerar resumos sem transformar todas as linhas e medir antes de introduzir cache adicional.

## Refatoração prática

Os exemplos abaixo ilustram mudanças propostas; não foram aplicados.

### A. Dependência explícita no router

Antes, o router recebe todo o contexto:

```python
def create_equipment_search_router(ctx):
    router = APIRouter()

    @router.get("/api/buscar")
    def buscar_seriais(q: str = Query(..., min_length=2)):
        return ctx._buscar_equipamentos_por_termo(q)[:15]

    return router
```

Depois, recebe apenas a operação necessária:

```python
from typing import Any, Callable

from fastapi import APIRouter, Query

EquipmentSearch = Callable[[str], list[dict[str, Any]]]


def create_equipment_search_router(
    search: EquipmentSearch,
) -> APIRouter:
    router = APIRouter()

    @router.get("/api/buscar")
    def buscar_seriais(q: str = Query(..., min_length=2)):
        return search(q)[:15]

    return router
```

Isso torna a dependência visível e permite testar a rota fornecendo uma função simples, sem substituir atributos do módulo principal.

### B. Preparação antes da publicação

Antes, a restauração publica dados ainda provisórios:

```python
transaction.apply()

if not ctx.load_database(transaction_locked=True):
    raise RuntimeError("O conjunto restaurado não pôde ser carregado.")

# Construção e gravação do histórico...
transaction.commit()
```

Depois, a sequência deve ser:

```python
transaction.apply()

prepared_state = ctx.load_database(
    transaction_locked=True,
    publish=False,
)
if not isinstance(prepared_state, dict):
    raise ctx.FileTransactionError(
        "O conjunto restaurado não pôde ser carregado."
    )

# Preparar também o índice de busca e gravar o histórico.
transaction.commit()

# Publicar o estado completo já validado.
ctx.publish_database_state(prepared_state)
```

Para completar essa refatoração, `publish_database_state()` também precisa mudar: hoje ainda reconstrói o índice. A publicação ideal limita-se a trocar a referência de um estado completo, preparado previamente.

### C. Retenção fora do loop de eventos

Antes:

```python
result = await update_inventory_files(
    endpoint_file,
    details_file,
    context=sys.modules[__name__],
)
prune_expired_histories()
return result
```

Depois, preservando a política de não invalidar uma atualização confirmada quando a retenção falha:

```python
import asyncio
import logging

logger = logging.getLogger(__name__)

result = await update_inventory_files(
    endpoint_file,
    details_file,
    context=sys.modules[__name__],
)

try:
    await asyncio.to_thread(prune_expired_histories)
except Exception:
    logger.exception(
        "Falha na retenção após atualização confirmada."
    )

return result
```

## Checklist de próximos passos

1. **Corrigir a consistência das gravações:** preparar estado antes do commit, publicar depois e tratar pendências de sincronização das anotações.
2. **Adicionar testes das falhas reproduzidas:** erro após commit, divergência local/compartilhada e leitura concorrente durante restauração.
3. **Completar a validação automática:** incluir os 23 testes JavaScript ausentes e investigar a interrupção da suíte Python.
4. **Substituir o contexto global gradualmente:** começar pelos routers menores, usando dependências específicas e contratos tipados.
5. **Decompor os fluxos maiores:** separar persistência, regras e apresentação, preservando fórmulas, identificadores, rótulos e dados brutos.
6. **Melhorar diagnóstico e desempenho:** registrar causas das falhas, retirar retenção do loop de eventos e medir listagem do histórico antes de otimizar.

Recomendo uma refatoração incremental na arquitetura atual. Os problemas encontrados podem ser resolvidos preservando o armazenamento em arquivos e as proteções já existentes.

## Validação realizada

- Testes de interface: 29 testes do fluxo principal e 23 testes auxiliares, total de 52 testes JavaScript aprovados.
- Testes Python focados: 19 testes aprovados.
- Suíte Python completa: execução interrompida por falta de progresso em um teste de transferência; o resultado geral é inconclusivo.
- Reprodução dos dois problemas de consistência: ambos confirmados com dados fictícios.
- Nenhuma alteração no código da aplicação ou nos dados operacionais durante a auditoria.
