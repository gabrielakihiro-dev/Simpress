# Regras de `domains/`

Valem junto com o `AGENTS.md` da raiz (não repetidas aqui); texto integral no doc de cada tema, seção "Regras movidas do AGENTS.md (10/11/2026)" quando houver.

## Sebrae e Chamados (F5) — doc `docs/operacao/sincronizar-chamados-sebrae.md`

- Chamado novo = `UTIC-AAAA-N` ausente da coluna C do Dashboard; o Dashboard só é gravado no arquivo gerado, nunca no Excel Online nem no SharePoint (`sebrae_dashboard*.py`).
- `Tabela3`: Q, T, U e V são fórmulas (nunca grave valor); W não se toca; C nunca é reescrita; campo em branco nunca apaga o existente, salvo `limpar_e` (a E, só por clique em Remover numa OS sem relação com o chamado, autorizado em 18/11/2026) (`sebrae_dashboard_gravacao.py`).
- Senha do chamado (exceção de LGPD autorizada em 19/11/2026): só os valores omitidos, em `data/state/sebrae_credenciais.json`; tela só no clique em `Mostrar senha`, apagada ao finalizar; nunca em log, Dashboard, histórico ou Assistente (`sebrae_credenciais.py`).
- Observação e destaque só em `data/state/sebrae_observacoes.json`, nunca em planilha, SharePoint ou SoftExpert (`sebrae_observacoes.py`).
- Finalizar é irreversível, só a pedido do usuário, um a um; descrição vazia é recusada antes de qualquer clique (`sebrae_finalizacao.py`).
- Sugestão de A, B e J nunca é salva sozinha; IA opcional só com `SIMPRESS_SUGESTAO_IA=1` e texto mascarado (`sebrae_categoria*.py`).
- Chamado encerrado vai para `data/state/sebrae_chamados_encerrados.json` sem texto nem nome; falha ao gravar bloqueia a importação (`sebrae_arquivo.py`).

## OS (F6) — doc `docs/cockpit-prompts/07-chamados-operacional.md`

- Marca de OS finalizada é anotação local em `data/state/os_marcas_finalizacao.json`; desfazer nunca reabre o chamado (`os_marcas_finalizacao.py`).
- Marca ativa ou selo `Entregue` da Simpress (com ou sem vínculo UTIC) leva a OS a `Finalizadas`, senão `Abertas`; KPIs, triagem e `Atenção · 3+ dias` contam só `Abertas`; `Exportar Excel` leva só a sub-aba visível.
- Marca ativa gera vínculo UTIC automático (`origem: "finalizacao"`) só na leitura de `GET /api/operacoes/chamados/vinculos-os`, prioridade manual > finalizacao > dashboard, nunca gravado em `os_chamados_vinculos.json`; `Desfazer` remove o vínculo e devolve a OS a `Abertas`, salvo com selo `Entregue` (`sebrae_vinculos.py`, `routers/operations.py`).
- Observação por OS só em `data/state/os_observacoes.json`, fora de busca, filtros e exportação (`os_observacoes.py`).
- Série sem OS vinculada some da aba OS (só a exibição muda); `envio_tecnico` e `dias_aberta` são calculados na leitura, nunca gravados (`ticket_reporting.py`).

## Assistente (F9) — doc `docs/cockpit-prompts/15-assistente.md`

- Cada ferramenta declara se consulta ou altera; toda alteração para no cartão de confirmação montado pelo programa, uma por turno (`assistant_tools.py`, `assistant_chat.py`).
- Máscara de LGPD antes de qualquer envio ao modelo e no histórico em disco (`assistant_lgpd.py`); `OPENROUTER_API_KEY` nunca vai ao front-end nem a logs.
- Mudança de funcionalidade mantém ferramentas, `SYSTEM_PROMPT` e testes do Assistente alinhados.

## Cadastro e Histórico — doc `docs/operacao/regras-cadastro-historico.md`

- Séries, contrato e CNPJ de faturamento vêm de `config/cliente.json` (`core/config.py`, `require_client_contract`); não os copie para o código. Rótulos do histórico só mudam na apresentação, sem regravar valores brutos (`history_*.py`).
- Anotações: id estável por evento, até 2.000 caracteres, reaplicadas só a linhas idênticas (`history_annotations.py`; doc `docs/operacao/ANOTACOES-HISTORICO.md`).

## Cobertura (F10) — doc `docs/cockpit-prompts/16-cobertura.md`

- Só lê o cadastro; grava em `data/state/operacao_cobertura*.json`; elegibilidade recalculada dentro de cada transação (`coverage.py`, `coverage_store.py`).

## Backups regionais (Resumo F3) — docs `docs/cockpit-prompts/05-resumo-kpis.md` e `docs/arquitetura/CONTRATOS_API_BACKEND.md`

- Cálculo puro em `backups_regionais.py` (só Notebook; sem MacBook e séries do Sebrae; mínimo 1 em Cascavel, Londrina, Pato Branco, Maringá e Ponta Grossa); cadastro, Endpoint, Cobertura e manutenção são só leitura. Confirmação manual de 7 dias só em `data/state/backups_regionais.json` (`backups_regionais_store.py`), sem dado pessoal. `apelido` pode ser nome de pessoa: só na tela local, nunca no Assistente, toast ou log.

## Transporte e representantes (F2) — doc `docs/arquitetura/CONTRATOS_API_BACKEND.md`

- Padrão = código (`REGIONAL_REPRESENTATIVE_DEFAULTS` em `local_setup.py`: só cidades e horários, sem dado pessoal) + arquivo local `data/state/representantes_regionais_padrao.json` (dados pessoais, fora do Git; modelo em `config/representantes_regionais_padrao.exemplo.json`); só a alteração por cidade vai a `config/representantes_regionais.json`; arquivo local inválido: PUT recusado (503), nada gravado.

## E-mail por modelo (Outlook, Home F1) — doc `docs/cockpit-prompts/03-home-split-view.md`

- Modelo 1 no código é genérico (sem nome de terceiro nem assinatura), mesclado com o local opcional `data/state/outlook_modelo_cabo_padrao.json` (só leitura, fora do Git; modelo em `config/outlook_modelo_cabo_padrao.exemplo.json`); ausente ou inválido vale o código, sem log de valores; única escrita: `outlook_email_modelos.json` (`outlook_mail.py`).

## UX (chamado e ticket) — doc `docs/operacao/automacao-chrome.md`

- Além do invariante da raiz: `BRM551RN1Y` responde 422 `SERIES_SEM_ENVIO_REAL`; descrição e solicitante nunca vão a log ou histórico (`ux_chamados.py`, `ux_ticket.py`); solicitante só de `data/state/ux_solicitante.json` (`SOLICITANTE_PADRAO` vazio) e, sem ele, o envio real é recusado antes do clique.
- Depois do clique em `Finalizar` ou `Enviar`, espere o número uma vez; timeout é `incerto` e nunca se repete.
