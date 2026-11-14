# Regras de `domains/`

Valem junto com o `AGENTS.md` da raiz; texto integral no doc de cada tema, seção "Regras movidas do AGENTS.md (10/11/2026)". `Doc: o mesmo` = doc da linha anterior.

## Sebrae e Chamados (F5)

- Chamado novo é o `UTIC-AAAA-N` ausente da coluna C do Dashboard; o Dashboard só é gravado no arquivo gerado, nunca no Excel Online nem no SharePoint (`sebrae_dashboard*.py`). Doc: `docs/operacao/sincronizar-chamados-sebrae.md`.
- Colunas Q, T, U e V da `Tabela3` são fórmulas: nunca grave valor nelas; W não se toca; C nunca é reescrita; campo em branco nunca apaga o existente (`sebrae_dashboard_gravacao.py`). Doc: o mesmo.
- Observação e destaque ficam só em `data/state/sebrae_observacoes.json`, nunca em planilha, SharePoint ou SoftExpert (`sebrae_observacoes.py`). Doc: o mesmo.
- Finalizar chamado é irreversível e só roda por pedido do usuário, um a um; descrição vazia é recusada antes de qualquer clique (`sebrae_finalizacao.py`). Doc: o mesmo.
- Sugestão de A, B e J nunca é salva sozinha; IA opcional só com `SIMPRESS_SUGESTAO_IA=1` e texto mascarado (`sebrae_categoria*.py`). Doc: o mesmo.
- Chamado encerrado vai para `data/state/sebrae_chamados_encerrados.json` sem texto nem nome; falha ao gravar bloqueia a importação (`sebrae_arquivo.py`). Doc: o mesmo.

## OS (F6)

- A marca de OS finalizada é anotação local em `data/state/os_marcas_finalizacao.json`; desfazer nunca reabre o chamado (`os_marcas_finalizacao.py`). Doc: `docs/cockpit-prompts/07-chamados-operacional.md`.
- Marca ativa ou selo `Entregue` da Simpress (com ou sem vínculo UTIC) leva a OS a `Finalizadas`; sem nenhum, `Abertas`; KPIs, triagem e `Atenção · 3+ dias` contam só `Abertas`; `Exportar Excel` leva só a sub-aba visível. Doc: o mesmo.
- Marca ativa gera vínculo UTIC automático (`origem: "finalizacao"`) na leitura de `GET /api/operacoes/chamados/vinculos-os`, prioridade manual > finalizacao > dashboard, nunca gravado em `os_chamados_vinculos.json`; `Desfazer` remove o vínculo e devolve a OS a `Abertas`, salvo com selo `Entregue` (`sebrae_vinculos.py`, `routers/operations.py`). Doc: o mesmo.
- Observação por OS fica só em `data/state/os_observacoes.json` e não entra em busca, filtros nem exportação (`os_observacoes.py`). Doc: o mesmo.
- Série sem OS vinculada some por completo da aba OS; só a exibição muda. `envio_tecnico` e `dias_aberta` são calculados na leitura, nunca gravados (`ticket_reporting.py`). Doc: o mesmo.

## Assistente (F9)

- Cada ferramenta declara se consulta ou altera; toda alteração para no cartão de confirmação montado pelo programa, uma por turno (`assistant_tools.py`, `assistant_chat.py`). Doc: `docs/cockpit-prompts/15-assistente.md`.
- A máscara de LGPD roda antes de qualquer envio ao modelo e no histórico em disco (`assistant_lgpd.py`); a chave `OPENROUTER_API_KEY` nunca vai ao front-end nem a logs. Doc: o mesmo.
- Mudança de funcionalidade mantém ferramentas, `SYSTEM_PROMPT` e testes do Assistente alinhados. Doc: o mesmo.

## Cadastro e Histórico

- Séries do Sebrae, prefixos de Curitiba e as duas leituras de MacBook vivem só em `regras_negocio.py`; quem precisa importa dali. Doc: `docs/operacao/regras-cadastro-historico.md`.
- `EquipamentosDetalhes` é a fonte oficial; `InvAll` só auxilia. Rótulos do histórico só mudam na apresentação, sem regravar valores brutos (`history_*.py`). Doc: `docs/operacao/regras-cadastro-historico.md`.
- Anotações têm id estável por evento, limite de 2.000 caracteres e se reaplicam só a linhas idênticas (`history_annotations.py`). Doc: `docs/operacao/ANOTACOES-HISTORICO.md`.

## Cobertura (F10)

- Só lê o cadastro; grava em `data/state/operacao_cobertura*.json`; a elegibilidade é recalculada dentro de cada transação (`coverage.py`, `coverage_store.py`). Doc: `docs/cockpit-prompts/16-cobertura.md`.

## Backups regionais (Resumo F3)

- Cálculo puro em `backups_regionais.py` (só Notebook; sem MacBook e séries do Sebrae; mínimo 1 em Cascavel, Londrina, Pato Branco, Maringá e Ponta Grossa); cadastro, Endpoint, Cobertura e manutenção são só leitura. Confirmação manual de 7 dias só em `data/state/backups_regionais.json` (`backups_regionais_store.py`), sem dado pessoal. `apelido` pode ser nome de pessoa: só na tela local, nunca no Assistente, toast ou log. Doc: `docs/cockpit-prompts/05-resumo-kpis.md` e `docs/arquitetura/CONTRATOS_API_BACKEND.md`.

## Transporte e representantes (F2)

- Padrão = código (`REGIONAL_REPRESENTATIVE_DEFAULTS` em `local_setup.py`: só cidades e horários, sem dado pessoal) + arquivo local `data/state/representantes_regionais_padrao.json` (dados pessoais, fora do Git; modelo em `config/representantes_regionais_padrao.exemplo.json`); só a alteração por cidade vai a `config/representantes_regionais.json`; arquivo local inválido: PUT recusado (503), nada gravado. Doc: `docs/arquitetura/CONTRATOS_API_BACKEND.md`.

## E-mail por modelo (Outlook, Home F1)

- Modelo 1 no código é genérico (sem nome de terceiro nem assinatura), mesclado com o local opcional `data/state/outlook_modelo_cabo_padrao.json` (só leitura, fora do Git; modelo em `config/outlook_modelo_cabo_padrao.exemplo.json`); ausente ou inválido vale o código, sem log de valores; única escrita: `outlook_email_modelos.json` (`outlook_mail.py`). Doc: `docs/cockpit-prompts/03-home-split-view.md`.

## UX (chamado e ticket)

- Envio real só com `enviar: true` e `confirmado: true`; `BRM551RN1Y` recusa (422 `SERIES_SEM_ENVIO_REAL`) e `SIMPRESS_UX_SEM_ENVIO=1` recusa qualquer envio real; descrição e solicitante nunca vão a log ou histórico (`ux_chamados.py`, `ux_ticket.py`); solicitante só de `data/state/ux_solicitante.json` (`SOLICITANTE_PADRAO` vazio), e sem ele o envio real é recusado antes do clique. Doc: `docs/operacao/automacao-chrome.md`.
- Depois do clique em `Finalizar` ou `Enviar`, espere o número uma vez; timeout é `incerto` e nunca se repete. Doc: o mesmo.
