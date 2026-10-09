# Migração do Simpress para Supabase — Etapa 1

**Data:** 09/10/2026

**Status:** mapeamento concluído; nenhuma mudança no código ou nos dados operacionais.

## Objetivo e escopo

Mapear como o Simpress lê, grava, recupera e exporta dados para preparar as próximas etapas da migração. A inspeção cobriu configurações, inicialização do FastAPI, domínios, rotas, regras do projeto e comandos de CI.

Os nomes e a presença dos arquivos locais foram conferidos, mas o conteúdo das células das planilhas operacionais não foi aberto nem copiado para este relatório. Não foi criado projeto Supabase, não houve upload de dados e não foram feitas alterações no comportamento do aplicativo.

## Diagnóstico atual

- O servidor é FastAPI/Uvicorn. A interface é servida pelo mesmo aplicativo.
- A persistência ativa está em planilhas `.xlsx` e arquivos `.json` locais; a aplicação carrega parte dos dados em caches Python e mantém um índice de busca em memória.
- A busca da base oficial usa o arquivo válido mais recente `EquipamentosDetalhes*.xlsx`. `InvAllComputersSummary_atual.xlsx` auxilia na associação de hostname e na comparação, mas não define quais equipamentos pertencem à base oficial (`README.md`; `main.py:491-510`, `1834-1900`, `2125-2140`).
- Não foi encontrada dependência, configuração ou integração do Supabase no checkout. As dependências de execução são FastAPI, Uvicorn, pandas, openpyxl e bibliotecas auxiliares (`requirements.txt`).
- As gravações usam `AtomicFileTransaction`, bloqueios e recuperação de transações locais. A migração precisa reproduzir as garantias de consistência, não apenas mudar caminhos de arquivos (`main.py:179-205`; `integrity.py`).

## Mapa de dados e fluxos

### Inventário e cache

- **Fonte principal:** `data/planilhas_entrada/EquipamentosDetalhes*.xlsx`. O aplicativo escolhe a planilha válida mais recente e extrai campos usados pela busca, transferência e exportação: série, modelo, tipo, apelido, identificador do cliente, endereço, cidade, UF, CEP, CNPJ de instalação e dados do contrato (`main.py:491-510`, `1877-1999`).
- **Fonte auxiliar:** `data/planilhas_entrada/InvAllComputersSummary_atual.xlsx`. Alimenta a associação de hostname por série e as comparações; não deve ser usada para preencher equipamentos ausentes da base Simpress (`README.md:71-72`; `main.py:951-1008`, `2125-2140`).
- **Cache:** equipamentos, catálogo derivado de localidades e estatísticas são publicados em memória, junto com um índice de busca. O carregamento é feito na inicialização e após operações que atualizam a base (`main.py:1849-1875`, `1877-1900`). Em várias instâncias hospedadas, esses caches precisariam de invalidação ou atualização coordenada.
- **Atualização:** `/api/planilhas/atualizar` recebe os dois `.xlsx`, valida pacote e cabeçalhos, compara as fontes, cria backups, substitui as planilhas ativas, registra o evento e prepara o novo cache antes de publicá-lo (`main.py:3310-3332`; `domains/inventory_update.py:264-365`, `430-535`). O limite configurado é 30 MB por arquivo, com limites adicionais para o conteúdo descompactado (`app_config.py:18-32`).

### Edições e catálogo de unidades

- **Edição de equipamento:** salva campos permitidos na linha correspondente da planilha Simpress ativa. A série, a revisão carregada, o arquivo e a aba são verificados para evitar sobrescrever uma alteração concorrente. A gravação pode atualizar junto o arquivo JSON de apelidos manuais e o histórico; o cache é publicado após o commit local (`main.py:2449-2471`, `2513-2553`, `2655-2659`).
- **Apelidos manuais:** `data/state/apelidos_modificados/apelidos_modificados.json`, mapeados por série normalizada, têm precedência sobre apelidos vindos das planilhas. Alterações e desfazimentos também geram eventos em `data/state/historico_alteracoes.json` (`app_config.py:34-37`; `main.py:208-253`, `2904-3020`).
- **Unidades:** parte do catálogo é derivada dos endereços presentes em `EquipamentosDetalhes`; `data/state/unidades_custom.json` contém inclusões e substituições feitas pelo usuário. A rota salva o JSON e recompõe o cache de unidades (`main.py:1927-2012`, `2088-2123`; `routers/units.py:86-105`, `185-205`).

### Histórico, backups e anotações

- **Histórico de comparações:** `data/state/historico_comparacoes/historico_comparacoes.json` guarda eventos, resumo, resultado detalhado, referências aos nomes dos arquivos e ao diretório de backup (`app_config.py:37`; `domains/inventory_update.py:457-510`).
- **Backups:** `data/planilhas_entrada/_backups/<evento>/` contém cópias `.xlsx` separadas por fonte. A restauração confere hashes e validade, grava um backup do estado que será substituído, substitui os inventários e registra a restauração (`README.md:198-206`; `routers/inventory_history.py:1050-1183`).
- **Histórico de apelidos:** é um arquivo JSON separado, com eventos que podem ser removidos ou desfeitos (`app_config.py:36`; `main.py:228-253`, `2919-3020`).
- **Anotações por linha:** registros JSON identificados por evento e linha ficam em `SIMPRESS_ANNOTATIONS_DIR`, na pasta compartilhada do OneDrive quando disponível, ou em uma pasta local. Um outbox local mantém pendências; há migração de anotações legadas, sincronização periódica e suporte a clones sem histórico local (`app_config.py:51-70`; `domains/history_annotations.py:15-105`; `main.py:1399-1439`; `routers/inventory_history.py:967-1026`). Identificadores, seção, fingerprint dos dados e regra de reaproveitamento exato devem ser preservados.
- **Rascunho no navegador:** o autosave usa `localStorage` para manter temporariamente o texto de uma anotação enquanto sincroniza. Esse rascunho não é a fonte persistente; o salvamento confirmado passa pela API (`static/history-annotation-autosave.js:77-134`, `235-261`).
- **Retenção:** configuração e README indicam 60 dias para históricos e backups (`app_config.py:23`; `README.md:200`). O docstring da função de limpeza ainda diz “90-day policy” (`main.py:1715-1718`). A regra efetiva usa a constante de 60 dias. Convém confirmar a política pretendida antes de portar a retenção.

### Modelos e arquivos gerados

- O modelo de transferência fica em `data/planilhas_entrada/(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`; o modelo de exportação fica em `modelos/EquipamentosDetalhes-exportacao.xlsx` (`app_config.py:12`, `15`). Ambos são dependências de arquivos e precisam ser preservados ou movidos para armazenamento de objetos.
- As planilhas de transferência, exportação e exportação do histórico são construídas em memória (`BytesIO`) e devolvidas como download; não são gravações permanentes no servidor (`routers/transfers.py:267-281`; `main.py:3184-3229`; `routers/inventory_history.py:864-868`).

## Implicações para a migração

1. **Separar dados relacionais de arquivos de auditoria.** PostgreSQL pode guardar inventário ativo, unidades, apelidos, eventos e metadados. Storage pode preservar os XLSX originais, modelos e backups referenciados por evento. Excel continua útil como entrada, exportação e evidência histórica.
2. **Manter proveniência e identidade.** Guardar fonte, evento, horário, nome original e hash dos arquivos. Preservar séries brutas e normalizadas, duplicidades, ordem de precedência das fontes, IDs de evento/linha e fingerprints das anotações.
3. **Preservar os rótulos do histórico.** Na exibição e exportação, aplicar os rótulos contextuais definidos em `AGENTS.md` sem reescrever os valores brutos das comparações nem perder IDs de arquivo necessários à auditoria e restauração.
4. **Redesenhar operações atômicas.** A transação PostgreSQL não inclui o Storage. Upload de arquivo, atualização de registros, histórico e publicação do novo estado precisam de estado pendente/idempotência e recuperação explícita para falhas parciais.
5. **Planejar concorrência entre instâncias.** Hoje bloqueios e caches são locais ao processo/sistema de arquivos. O modelo hospedado precisa definir concorrência no banco e como as instâncias recebem alterações após atualização ou restauração.
6. **Migrar anotações sem depender do OneDrive.** A pasta compartilhada sustenta a sincronização entre clones. A nova implementação deve importar registros legados e atender clones sem histórico local usando um armazenamento central, mantendo as regras de identidade e reaplicação exata.
7. **Rever segurança antes de exposição pública.** O servidor inicia em `127.0.0.1` e o middleware valida autoridades locais de Host/Origin (`main.py:1451-1492`, `1587-1636`, `3518-3519`). Não foi encontrada autenticação de usuário nas rotas. Hospedagem pública exige listener compatível com o provedor, autenticação/autorização e configuração de acesso; as credenciais administrativas do banco não podem ir para o navegador.
8. **Definir retenção explicitamente.** Confirmar 60 ou 90 dias e decidir o ciclo de vida de anotações, arquivos de origem e backups antes de criar rotinas de expurgo na nuvem.

## Testes e verificações executados

- **JavaScript da CI:** 65 testes passaram com `node --test` nos sete arquivos listados em `.github/workflows/ci.yml`.
- **Sintaxe Python:** `compileall` passou para os módulos, rotas, scripts e testes indicados pela CI.
- **Verificação de credenciais:** `scripts/check_secrets.py` passou; nenhum padrão conhecido foi encontrado nos arquivos Git rastreados.
- **Suíte Python:** a execução no ambiente virtual começou, mas ficou sem progresso no teste `test_delivery_pause_duration_is_required_except_when_office_stays_open`; foi interrompida manualmente após mais de um minuto. Portanto, a suíte completa não está validada nesta rodada. A tentativa com o Python do sistema falhou antes da suíte por ausência de `python-multipart`; o ambiente virtual possui as dependências de execução.
- **Mypy:** não executado porque `mypy` não está instalado no ambiente virtual.
- **Playwright/E2E:** não executado porque `node_modules` não está instalado; o comando da CI requer as dependências Playwright do projeto.

Os testes usam fixtures conforme o runner Python da CI. Nenhum teste da migração ao Supabase foi criado ou executado, pois esta etapa não implementa a integração.

## Saída desta etapa

O mapa identifica cinco grupos de persistência a tratar na etapa seguinte: inventário e snapshots, edições e catálogo, históricos e backups, anotações compartilhadas e arquivos-modelo. Antes do desenho do esquema, falta resolver a retenção de 60/90 dias e fechar o modelo de autorização para usuários e instâncias da aplicação.

**Estado do repositório:** somente este documento foi adicionado. Nenhum commit ou push foi realizado.
