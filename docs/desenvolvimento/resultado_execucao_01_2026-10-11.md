# Resultado da Execução 01 — Revisões de anotações

Data: 11/10/2026. Implementação local, limitada à Execução 01 do roteiro de correções.

## Comportamento implementado

- Cada edição recebe uma revisão imutável, identificada separadamente da linha e do evento, com suas revisões-base.
- A leitura combina arquivos compartilhados e pendências locais por relações causais. Relógios e ordem de chegada não escolhem uma anotação vencedora.
- Edições concorrentes permanecem como alternativas. A interface exige confirmação explícita para resolver o conflito e aceita texto vazio. Bases ausentes ou revisões inconsistentes impedem a confirmação pela interface.
- A publicação é idempotente. A baixa da pendência exige verificar a revisão publicada e não remove uma pendência diferente criada durante a sincronização.
- Histórico de Planilhas e anotações da linha do tempo de chamados usam o mesmo protocolo. Os editores da Central de Pendências e da evolução recebem as bases correspondentes ao texto exibido.
- Registros legados continuam legíveis. A migração cria cópias determinísticas, preservando os arquivos originais e as comparações brutas. Textos legados distintos sem relação causal comprovada podem exigir resolução manual.
- Rascunhos do navegador preservam bases e identificador da tentativa após falhas e recargas. Rascunhos legados sem bases são tratados como edições independentes.
- Exportações apresentam os conflitos e suas alternativas. O limite de 2.000 caracteres permanece.

## Arquivos alterados nesta execução

| Arquivo | Alteração |
| --- | --- |
| `domains/history_annotations.py` | Protocolo, publicação imutável, leitura causal, compatibilidade legada e confirmação da sincronização. |
| `routers/inventory_history.py` | Migração, fila por revisão, contratos de leitura/escrita e resolução de conflitos do histórico. |
| `routers/operations.py` | Mesmo protocolo para chamados e metadados nos eventos apresentados. |
| `main.py` | Conexão dos editores operacionais à visualização com bases de revisão. |
| `domains/inventory_update.py` | Consumo das revisões compartilhadas e bloqueio da herança de anotações em conflito. |
| `domains/history_export.py` | Representação de conflitos nas anotações exportadas. |
| `domains/ticket_reporting.py` | Representação de conflitos nas anotações da linha do tempo exportada. |
| `static/js/shared/history-annotation-autosave.js` | Identificação das tentativas, bases, recuperação de rascunhos e controles explícitos de conflito. |
| `static/app.js` | Metadados nos três tipos de editor e envio das revisões-base. |
| `tests/test_annotation_revisions.py` | Novos testes de concorrência, migração, publicação e contratos das rotas. |
| `tests/frontend/test_annotation_version_ui.cjs` | Novos testes de conflito, rascunhos e repetição da tentativa. |
| `tests/test_operations.py` | Atualização das edições sequenciais para informar a base observada. |
| `tests/test_integrity_workflows.py` | Adequação das expectativas ao protocolo imutável. |
| `.github/workflows/ci.yml` | Inclusão dos novos testes JavaScript no comando da CI. |
| `docs/operacao/ANOTACOES-HISTORICO.md` | Documentação do protocolo e do uso entre dispositivos. |
| `docs/desenvolvimento/resultado_execucao_01_2026-10-11.md` | Este relatório. |

Alterações preexistentes no checkout foram preservadas. Nenhum commit ou push foi realizado.

## Validação realizada

- **60 testes Python aprovados:** 21 novos testes de revisões, mais testes de operações, relatórios de chamados, limpeza do histórico de chamados e oito testes focados de anotações/histórico dos fluxos de integridade. Executados com arquivos e raízes temporárias; leituras de planilhas operacionais foram bloqueadas durante a importação dos módulos.
- **98 testes JavaScript aprovados:** `node --test tests/test_*.cjs`, incluindo seis novos testes do protocolo na interface.
- **Chrome real, componente isolado:** conflito com duas alternativas, texto contendo HTML sem criar elementos executáveis, escolha de anotação vazia sem envio automático e resolução explícita com as duas bases. Requisição simulada; nenhum servidor operacional utilizado.
- **mypy aprovado em seis módulos:** `domains/history_annotations.py`, `domains/history_export.py`, `domains/inventory_update.py`, `domains/ticket_reporting.py`, `routers/inventory_history.py` e `routers/operations.py`.
- Verificação sintática dos dois arquivos JavaScript alterados e `git diff --check` aprovados.

A checagem de tipos incluindo `main.py` apontou a ausência preexistente de anotação em `_READINESS_VALIDATION_CACHE`, aproximadamente na linha 619. Esse ponto foi conferido no código de `HEAD` e não foi alterado nesta execução.

## Limites e cuidados para uso

A migração não foi executada sobre os dados operacionais nesta sessão; seu comportamento foi validado em fixtures. O servidor operacional não foi reiniciado. Atualize o código em todos os notebooks antes de retomar edições compartilhadas: clientes antigos não informam bases e podem produzir conflitos.

A confirmação da sincronização comprova a publicação e releitura na pasta configurada deste computador. A entrega real pelo OneDrive, entre computadores, e integrações PostgreSQL/Storage não foram verificadas. Os testes não substituem uma validação completa dos fluxos da aplicação no navegador.

Os arquivos de revisão conservam a relação entre as versões; não os apague manualmente. O protocolo preserva as versões observadas e recebidas, mas não recupera conteúdo que já tenha sido perdido por sobrescritas anteriores à atualização.

As Execuções 02 a 14 não foram iniciadas. Em particular, a falsa confirmação do autosave da Execução 03, a centralização completa da herança da Execução 06 e a fila transacional das anotações herdadas da Execução 07 continuam com seu escopo próprio.
