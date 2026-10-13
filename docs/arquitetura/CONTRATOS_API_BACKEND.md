# Inventário dos contratos HTTP do Simpress

Mapa obtido do OpenAPI gerado em memória, handlers FastAPI, barreira do piloto e consumidores JavaScript no commit analisado. O OpenAPI lista **54 operações**: 53 rotas da API e a página /. Rotas auxiliares /login, /docs, /redoc, /openapi.json, /favicon.ico e o mount /static existem, mas não integram essa contagem.

## Como ler o mapa

- Arquivo aponta para o handler principal; serviços chamados estão no relatório da Fase 1.
- Endpoints normais exigem conexão local direta. Autenticação/CSRF dependem de SIMPRESS_AUTH_ENABLED; o padrão local é desligado. Ativada, operações de negócio exigem sessão administrativa e gravações exigem CSRF e mesma origem. Consulte security/.
- **Arquivos** significa modo padrão. **Piloto** significa PostgreSQL local opt-in: somente rotas em persistence.boundary.pilot_route_allowed atravessam a barreira. Rota fora dela retorna 501 com “Esta rota não está disponível no piloto PostgreSQL local.” Handler por si só não implica suporte ao piloto.
- Erros mostram códigos e mensagens estáveis quando úteis. Campos inválidos ou ausentes de FastAPI/Pydantic retornam 422 com detail estruturado. O middleware pode retornar 400 para Host/cabeçalho malformado, 403 para rede/Host/origem recusados, 413 para limite total, 500 com “Falha interna do servidor. Consulte os logs locais.” e 503 para corrupção JSON. Detalhes validados dinamicamente não são uma única frase imutável.
- Upload é multipart/form-data; download retorna bytes/MIME com Content-Disposition quando aplicável. Idempotency-Key não consta no schema OpenAPI: política está no middleware.

## Prontidão, pesquisa, equipamentos e unidades

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis e acesso |
| --- | --- | --- | --- | --- |
| 01 | GET /api/prontidao | Sem parâmetros. | {backend, files, functions}; cada função indica disponibilidade, estado e dependências faltantes. Estados incluem awaiting_import, invalid e disponível. | 200 também quando ainda não está pronto. Local; piloto. routers/system.py. Consumidor: static/app.js. |
| 02 | GET /api/config/transferencia | Sem parâmetros. | {retirada_contato, retirada_email, retirada_telefone} da configuração atual. | 200; local e piloto. routers/system.py; static/app.js. |
| 03 | GET /api/buscar | Query q, mínimo 2 caracteres. | Lista de até 15 equipamentos. | 422 query inválida. Piloto. routers/equipment_search.py; busca ampliada é a preferida da interface. |
| 04 | GET /api/buscar-expandida | q mínimo 2; offset ≥ 0 (0); limit 1–100 (50); categoria ≤ 40; tipo ≤ 80; cidade ≤ 120; include_filters booleano (false). | {items,total,offset,limit,has_more}; filters quando solicitado. | 422 formato/limite; categoria desconhecida é ignorada. Piloto. routers/equipment_search.py; busca, autocompletar e filtros em static/app.js. |
| 05 | GET /api/stats | Sem parâmetros. | Estatísticas mais total_equipamentos, base_importada, exportacao_disponivel/motivo, contagens de aliases e alterações exportáveis e total_unidades. | 200 mesmo sem base; indica estado/contagens. Piloto. routers/equipment_search.py; static/app.js. |
| 06 | GET /api/unidades | Sem parâmetros. | Lista de unidades. | 200; local e piloto. routers/units.py; static/app.js. |
| 07 | POST /api/unidade/salvar | JSON: cidade 1–160, endereco 1–300, cnpj 1–24 (14 dígitos), id opcional inteiro, uf 2 (PR padrão, UF válida), cep ≤ 12 (8 dígitos). | {sucesso,mensagem,unidades}. | 422 schema/dados; 409 seleção ausente/bloqueio; 500 falha de gravação/leitura. Local e piloto. routers/units.py; formulário em static/app.js. |
| 08 | GET /api/equipamento/{serial} | Path serial; busca exata case-insensitive. | Objeto do equipamento sem campos cujo nome começa por _; acrescenta revisao se disponível. | 404: “Equipamento com serial '…' não encontrado na base de dados.” Piloto. main.py; static/app.js. |
| 09 | GET /api/equipamento/apelidos-modificados | Sem parâmetros. | {total,apelidos}, mapa de overrides. | 200 no modo arquivos; **501 no piloto** (fora da allowlist). main.py. |
| 10 | POST /api/equipamento/salvar | JSON EquipamentoUpdatePayload: serial 1–128, novo false, modelo até 300, tipo até 120, apelido até 160, id_cliente até 128, revisao até 64; campos legados de endereço/localização/CEP/CNPJ seguem aceitos. Edição respeita campos enviados e revisão. | {sucesso,mensagem,equipamento,total_modificados}. | 400 série ausente; 409 revisão/duplicidade; 422 série/schema inválido; falha de persistência pelo handler global. Local e piloto. main.py; static/app.js. |
| 11 | POST /api/equipamento/atualizar-apelido | JSON {serial (1–128),apelido (até 160)}; apelido vazio remove override. | {sucesso,mensagem,equipamento,apelido_anterior,apelido_novo,salvo_no_disco,total_modificados}. | 404 equipamento; 409 concorrência; 422 schema. Local e piloto. main.py; static/app.js. |
| 12 | POST /api/equipamento/apelido/desfazer | JSON {evento_id:string}; só reverte evento mais recente compatível. | {sucesso,mensagem,equipamento,…}; a reversão fica no histórico. | 404 evento/equipamento; 409 estado divergente; 422 schema. Local e piloto. main.py; static/app.js. |
| 13 | GET /api/historico-alteracoes | Alias de histórico. | {total,eventos}, ordem temporal descendente. | 200; arquivos e piloto. main.py; interface de histórico. |
| 14 | GET /api/historico-apelidos | Alias do endpoint anterior. | Mesmo contrato {total,eventos}. | 200; arquivos e piloto. main.py. |
| 15 | DELETE /api/historico-alteracoes/{evento_id} | Remove registro e reverte alias conforme regra do evento mais recente. | {sucesso,evento_id,tipo,equipamento,mensagem}. | 404 evento/equipamento; 409 evento não elegível. Arquivos e piloto. main.py; static/app.js. |
| 16 | DELETE /api/historico-apelidos/{evento_id} | Alias da exclusão/reversão anterior. | Mesmo contrato. | 404/409 como acima. Arquivos e piloto. main.py. |
| 17 | GET /api/exportar-equipamentos | Sem parâmetros. | XLSX para download; conteúdo validado contra modelo e base ativos. | 404 base/modelo; 409 incompatibilidade, safety ou busy; 500 falha de geração. Arquivos e piloto. main.py; static/app.js. |

## Transferência e inventário

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis e acesso |
| --- | --- | --- | --- | --- |
| 18 | POST /api/gerar-planilha | JSON TransferenciaPayload: série, contrato, empresa e campos de retirada/entrega. CNPJ (14 dígitos quando preenchido), email e telefone validados. Rota exige dados de contato, endereço, horário e observações nos dois locais; pausa na entrega é exigida exceto para “escritório não fecha”. | XLSX com células editáveis preenchidas e revalidadas. | 422 campo obrigatório inválido; 500 modelo ausente/geração. Arquivos e piloto. routers/transfers.py; static/app.js. |
| 19 | POST /api/modelos/{tipo}/importar | Multipart file; tipo transferencia ou exportacao; .xlsx até 30 MiB. Valida layout/células graváveis antes da troca. | {sucesso,mensagem,arquivo}. | 400 extensão/conteúdo/layout; 404 tipo/arquivo indisponível; 409 ocupação; 413 limite; 503 parser; 500 gravação. Arquivos; 501 no piloto. routers/local_setup.py; static/app.js. |
| 20 | POST /api/planilhas/previsualizar | Multipart endpoint_file XLSX e details_file XLSX ou ZIP; até 30 MiB cada. ZIP Simpress exige exatamente uma planilha válida. | {arquivos:{endpoint:{nome,linhas},detalhes:{nome,linhas}},alteracoes,preview_token}. | 400 inválido; 409 base/lock; 413 limites; 500 inesperado. Arquivos; 501 no piloto, mesmo havendo função interna para essa prévia. main.py, domains/inventory_update.py; static/app.js. |
| 21 | POST /api/planilhas/atualizar | Multipart dos dois arquivos; preview_token opcional; header Idempotency-Key opcional (1–128 caracteres [A-Za-z0-9._:-]). | {sucesso,mensagem,comparacao,anotacoes_herdadas_enfileiradas,sincronizacao_anotacoes,stats,historico_salvo}; chave idempotente pode repetir resultado. | 400 entrada inválida; 409 preview stale, chave em conflito ou lock; 413 limite; 422 form/header; 503 parser/estado; 500 transação. Arquivos e piloto. main.py, domains/inventory_update.py; static/app.js. |
| 22 | POST /api/recarregar-base | Sem body; carrega fontes locais/configuradas. | {sucesso,arquivo_origem,total_equipamentos,total_unidades,stats,mensagem}. | 400 sem planilha válida. Arquivos e piloto. main.py. |

## Histórico de planilhas

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis e acesso |
| --- | --- | --- | --- | --- |
| 23 | GET /api/historico-comparacoes | Sem parâmetros. | {total,eventos}; metadados, resumo e indicação de possibilidade de restauração. | 200, inclusive lista vazia. Arquivos e piloto. routers/inventory_history.py; static/app.js. |
| 24 | GET /api/historico-comparacoes/exportar/excel | Query data no formato YYYY-MM-DD. | XLSX com seções detalhadas e anotação por linha. | 400 data inválida: “Selecione uma data válida para exportação.”; 404 sem evento: “Não há registros de planilhas na data selecionada.”; 422 formato. Arquivos/piloto. routers/inventory_history.py; interface. |
| 25 | GET /api/historico-comparacoes/{evento_id} | Path evento. | Visão de comparação, rótulos apresentados normalizados e anotações sobrepostas. | 404: “O resultado selecionado não existe no histórico de planilhas.” Arquivos e piloto. routers/inventory_history.py; static/app.js. |
| 26 | PUT /api/historico-comparacoes/{evento_id}/anotacoes/{item_id} | JSON anotacao até 2.000; revisao_id opcional; base_revisoes até 100; resolver_conflito false por padrão. | {sucesso,anotacao,anotacao_revisoes,flags de conflito,revisao_salva,sincronizacao}; campos variam pelo estado. | 404 evento/linha; 409 conflito não confirmado ou revisão stale; 422 schema/limite; 500/503 persistência/sync. Arquivos e piloto. routers/inventory_history.py, domains/history_annotations.py; static/app.js. |
| 27 | GET /api/historico-comparacoes/{evento_id}/restauracao | Evento com backup válido. | Metadados dos backups/arquivos atuais e preview_token ligado aos hashes/revisão. | 404 ausente; 409 incompleto/inválido/não restaurável. Arquivos e piloto. routers/inventory_history.py; static/app.js. |
| 28 | POST /api/historico-comparacoes/{evento_id}/restaurar | JSON preview_token de 64 hex; revalida token e arquivos sob lock. | {sucesso,evento:{id,tipo,horario,restauracao_de,arquivos_restaurados,desfazer_disponivel,contagens}}; cria novo evento. | 404 evento; 409 token/arquivos/concorrência; 500 recuperação. Arquivos e piloto. routers/inventory_history.py; static/app.js. |
| 29 | POST /api/historico-comparacoes/{evento_id}/apelido-manual/{serial} | JSON {acao:"manter"|"excluir"}. | {sucesso,resolucao,mensagem,equipamento,total_modificados}. | 400 ação inválida; 404 item ausente; 409 conflito/decisão stale. Arquivos e piloto. routers/inventory_history.py; static/app.js. |
| 30 | DELETE /api/historico-comparacoes/{evento_id} | Path evento; remove registro visível e registra tombstones de anotação para evitar ressurreição. | {sucesso,total,sincronizacao}. | 404 ausente; 500 gravação; 503 quando sincronização está habilitada e local falha. Arquivos e piloto. routers/inventory_history.py; static/app.js. |

## Acompanhamento de chamados

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis e acesso |
| --- | --- | --- | --- | --- |
| 31 | GET /api/operacoes/pendencias | Sem parâmetros. | {evento:null,pendencias:[]} ou evento {id,horario} e lista. | 200; arquivos e piloto. routers/operations.py; static/app.js. |
| 32 | GET /api/operacoes/evolucao | Queries obrigatórias anterior e atual; eventos distintos de inventário. | {anterior:{id,horario},atual:{id,horario},mudancas,contagens}. | 404 ausente; 422 IDs iguais ou evento de restauração. Arquivos e piloto. routers/operations.py; static/app.js. |
| 33 | GET /api/operacoes/chamados | Sem parâmetros. | Relatório {atualizado_em,fontes,resumo,chamados,historico}; vazio com listas/contagens vazias e data nula. | 200; arquivos. Não permitido pelo piloto (501). routers/operations.py; static/app.js. |
| 34 | GET /api/operacoes/chamados/historico | Sem parâmetros. | {eventos,total}, ordem descendente. | 200; arquivos; 501 piloto. routers/operations.py; interface. |
| 35 | DELETE /api/operacoes/chamados/historico/antigas | Sem body; conserva snapshot mais recente e recibos de importação. | {removidas,mantida,total}. | 409 lock; 500 gravação; 503 estado inválido; 501 piloto. routers/operations.py; static/app.js. |
| 36 | GET /api/operacoes/chamados/snapshot/{snapshot_id} | ID do snapshot. | Relatório normalizado daquela versão. | 404 ausente; 501 piloto. routers/operations.py; static/app.js. |
| 37 | GET /api/operacoes/chamados/evolucao | Queries anterior e atual, snapshots distintos. | Mudanças normalizadas entre versões. | 404 ausente; 422 snapshots iguais/inválidos; 501 piloto. routers/operations.py; static/app.js. |
| 38 | GET /api/operacoes/chamados/linha-do-tempo/{serial} | Path série; snapshot_id opcional, limita timeline àquela versão. | {serie,eventos,total}, com anotações por evento. | 404 sem histórico/versão; 501 piloto. routers/operations.py; static/app.js. |
| 39 | PUT /api/operacoes/chamados/linha-do-tempo/{event_id}/{item_id} | JSON anotacao até 2.000, revisão, bases e confirmação explícita de conflito. | {sucesso,anotacao,anotacao_revisoes,flags de conflito,sincronizacao}. | 404 snapshot/linha; 409 conflito; 422 schema; 500/503 persistência; 501 piloto. routers/operations.py; static/app.js. |
| 40 | GET /api/operacoes/chamados/exportar | Queries opcionais snapshot_id, relation, status, queue, city, provider, search e age_filter; stale_days (3) e attention_only booleano. | XLSX filtrado com timeline e anotações. | 404 snapshot; 422 query; 501 piloto. routers/operations.py; static/app.js. |
| 41 | POST /api/operacoes/chamados/importar | Multipart simpress_file XLSX/ZIP e oracle_file XLSX, até 32 MiB cada; automatic_import_id opcional. | Relatório conciliado e metadados de histórico; grava snapshot/recibo atomicamente. | 400 arquivo/coluna; 409 lote duplicado/lock; 413 limite; 422 headers/reconciliação; 503 estado; 500 gravação; 501 piloto. routers/operations.py; static/app.js/inbox. |

## Operações PostgreSQL do piloto

Todas exigem configuração explícita do piloto. Ações POST exigem perfil autenticado e CSRF quando a autenticação está ligada.

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis |
| --- | --- | --- | --- | --- |
| 42 | POST /api/piloto/modelos/{kind} | Multipart upload até 30 MiB; kind transferencia ou exportacao. | Resultado {sucesso,objeto_id} e registro idempotente. | 404 sem piloto; 413 corpo vazio/maior que 1 MiB na borda atual (embora o leitor aceite 30 MiB); 422 entrada; 409 chave/conflito. Rota aceita. persistence/routes.py, persistence/files.py. |
| 43 | POST /api/piloto/anotacoes/importar | Multipart JSON upload até 30 MiB; valida registros/fingerprint/seções. | {sucesso,conflitos,operacao_id}. | 404 sem piloto; 413 corpo acima de 1 MiB na borda; 422 registro/anotação; 409 idempotência. Rota aceita. persistence/routes.py, persistence/files.py. |
| 44 | GET /api/piloto/operacoes/{operation} | operation UUID. | id, estado, tentativas, código de erro, revisões e resultado disponíveis. | 404 ausente; rota aceita. persistence/routes.py. |
| 45 | GET /api/piloto/operacoes | Sem parâmetros; últimas 50. | {operacoes:[{id,estado,chave_idempotencia,tentativas,erro_codigo}]}. | 200; rota aceita. persistence/routes.py. |
| 46 | POST /api/piloto/retencao | Sem body. | {ocultados,objetos_removidos}. | 404 sem piloto; falha propagada por transação/storage. Rota aceita. persistence/routes.py, persistence/files.py. |
| 47 | POST /api/piloto/operacoes/{operation}/recuperar | operation UUID. | Resultado existente ou reexecução verificada/idempotente. | 404 ausência; 409 cancelada/conflito; falha de storage/transação. Rota aceita. persistence/routes.py. |
| 48 | POST /api/piloto/operacoes/{operation}/cancelar | operation UUID; só se não confirmada e sem executor ativo. | {sucesso,removidos} após limpeza sem referência. | 404 ausente; 409 confirmada/ativa/referida; falha de storage. Rota aceita. persistence/routes.py. |
| 49 | GET /api/arquivos/{oid} | oid UUID de objeto verificado. | Bytes, MIME armazenado, nome opaco UUID e Cache-Control no-store. | 404 inexistente; falha storage. Rota aceita. persistence/routes.py. |

As rotas POST 42 e 43 entram na allowlist, mas a classificação global de tamanho em main.py aplica 1 MiB a escritas /api/ exceto inventário, modelos legados e chamados. Os leitores do piloto aceitam 30 MiB. A borda retorna 413 acima de 1 MiB antes de chegar ao serviço: discrepância documentada, sem enviar carga grande nem decidir mudança de contrato nesta fase.

## Sessão autenticada e página inicial

| # | Método e caminho | Entrada/validação | Resposta de sucesso | Erros notáveis e acesso |
| --- | --- | --- | --- | --- |
| 50 | GET /api/auth/session | Cookie/sessão; cria desafio pré-login quando ativada. | Auth desligada: {enabled:false,authenticated:false}. Ligada: status e, com sessão, {enabled:true,authenticated:true,perfil,csrf_token}. | 200 sem sessão; security/routes.py; static/js/auth/auth-session.js. |
| 51 | POST /api/auth/login | JSON email 3–254, password 1–1024, Content-Type JSON, cookie/token CSRF pré-login e mesma origem. | {enabled:true,authenticated:true,perfil}; cookie opaco HTTP-only/SameSite Strict. | 403 desafio/CSRF/origem; 401 credencial; 422 Content-Type/body; 429 tentativas; 503 auth indisponível. security/routes.py; UI de login. |
| 52 | POST /api/auth/logout | Sessão autenticada e CSRF. | {sucesso:true}, revoga sessão atual. | 401 sem identidade; 403 CSRF/origem; 503 auth desligada. security/routes.py; static/js/auth/auth-session.js. |
| 53 | POST /api/auth/logout-all | Sessão autenticada e CSRF. | {sucesso:true}, revoga sessões do usuário. | Mesmas classes do logout. security/routes.py; static/js/auth/auth-session.js. |
| 54 | GET / | Sem parâmetros; serve interface versionada quando static/index.html existe. | HTML; assets apontados por hash. | Fallback JSON se HTML faltar; recusas do middleware local/autenticação. main.py. |

## Regras de compatibilidade

- Rótulos de apresentação do Histórico de Planilhas seguem as instruções locais; mantenha valores brutos e identificadores necessários à auditoria/restauração.
- Anotações: limite 2.000 caracteres; linhas próprias nas seis seções; identidade/revisão; autosave; exportação; pasta compartilhada; herdar só de linha da mesma seção com dados restantes iguais; ID independente por evento; anotação recente vazia ou duplicata conflitante bloqueia herança antiga; legadas acessíveis em clones.
- Idempotência do inventário: header opcional em arquivos, recibo retido, repetição do mesmo conteúdo; mesma chave com payload diferente conflita. A chave não pertence ao body.
- Erro inesperado retorna 500 genérico sem conteúdo sensível. PostgreSQL é piloto local e limitado pela allowlist.
- As diferenças do piloto, incluindo respostas 501, prévia não disponível, anotação simplificada como texto/revisão SQL e limite de 1 MiB no HTTP, não devem ser harmonizadas sem decisão de escopo, esquema e migração.

Para arquitetura, achados, linha de base e plano, consulte [REFATORACAO_BACKEND_FASE_1.md](REFATORACAO_BACKEND_FASE_1.md).
