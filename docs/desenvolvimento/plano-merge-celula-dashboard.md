# Plano: envio do Dashboard Sebrae com merge por célula

Data: 11/11/2026. Branch `claude/dashboard-merge-celula-1a44e3`. Plano aprovado antecipadamente pelo usuário.

## Problema

`conferir_dashboard_do_sharepoint` (`scripts/automacao_rotinas_chrome.py`) compara a planilha inteira do SharePoint com a importação. Qualquer célula diferente (mesmo uma que o site não ia mudar) gera `DashboardDivergente`; a rotina para e `scripts/sebrae_fechar.py` cria cópia pendente com aviso que não some.

## Abordagem: reaplicar sobre a versão nova (3-way por célula)

- `base` = cópia importada (`sebrae_novos.ler_planilha(caminho_planilha, importado.sha256)`).
- `gerado` = arquivo que o site ia enviar (saída do Atualizar, cópia pendente ou snapshot).
- `sharepoint` = arquivo baixado agora.
- Operações do site = células de `gerado` diferentes de `base`, comparadas na forma legível (`_valor_legivel`), só nas colunas de `COLUNAS_DE_DADO`. Linhas casadas pela coluna C (número UTIC), nunca pela posição.
- Por célula com operação: SP == base → aplica o valor do site; SP == site → nada; SP mudou para outro valor → conflito só dessa célula. Célula sem operação → fica como está no SP.
- O valor gravado vem do `<c>` cru de `gerado` (texto com quebra de linha e data com segundos intactos), regravado com a referência e o estilo da célula do SP. Nunca reserializar a forma legível.

## Regras invioláveis (todas as etapas)

- Q, T, U, V são fórmulas: nunca escritas. W nunca tocada. C de linha existente nunca reescrita. Valor em branco do site nunca apaga.
- Linhas do SP sem operação ficam byte a byte iguais (não passam por `_reescrever_linha`).
- Só se escreve no arquivo gerado; nada no Excel Online. `Duplicata` antes de sobrepor, `Keep both` recusado, `Save Conflict` sem Retry, cliques irreversíveis sem repetição, 409 para `versao_importacao` ausente ou antiga: tudo como hoje.
- Nada de envio real, Chrome de automação ou `data/` real. Só mocks e fixtures.
- LGPD: valores de célula só no arquivo de estado dos conflitos e na resposta da API lida pela tela. Mensagem de erro, `descrever_erro`, arquivo de resultado, logs e Assistente levam só contagem, letras de coluna e números de chamado.

## Bloco 1a: função de merge (domínio puro)

- Objetivo: `reaplicar(base, gerado, sharepoint, *, enviado=None, escolhas=None) -> ResultadoMerge` em `domains/sebrae_dashboard_gravacao.py`. Devolve `conteudo` (bytes) ou `conflitos` (lista de `{id, chamado, coluna, sharepoint, site, tipo}` com `tipo` `celula` ou `linha_apagada`). `id` = 12 primeiros hex do sha256 de `chamado|coluna|sharepoint|site`.
- Regras:
  - Ancestral por célula: `enviado` (última cópia enviada) só se vier da mesma importação (o chamador garante) e `enviado[célula] == gerado[célula]`; senão, `base`.
  - Colunas automáticas que o site não edita (E, K, L, N): base vazia e SP preenchido → mantém SP, sem conflito.
  - Linha nova (C fora da base): se o SP não tem a C → acrescenta na primeira linha livre da Tabela3 (mesma lógica de `atualizar`: estilo modal, fórmula Q). Se o SP já tem a C → merge por célula, sem duplicar.
  - Linha editada pelo site e ausente no SP → conflito `linha_apagada`. Escolha `site` reinsere a linha com os dados de `gerado`; `sharepoint` descarta as operações.
  - Linha com chave `linha:<n>` (sem UTIC) e com operação do site: se o SP difere da base nessa linha → conflito; nunca merge automático.
  - C repetida na base ou no SP com operação nessa chave → conflito.
  - Mudança estrutural (cabeçalho via `ler_coluna_c`, Tabela3 ou aba ausente) → `DashboardInvalido`, como hoje.
  - `escolhas[id]` `sharepoint` ou `site` resolve o conflito daquele id; id que não bate é ignorado.
  - Final por `_entregar(..., anteriores=C do SP, novos=C acrescentadas, categorias=True)`. A ordenação por C desfaz reordenação feita no SP (limitação a documentar).
- Arquivos: `domains/sebrae_dashboard_gravacao.py`, `tests/test_sebrae_dashboard_gravacao.py` (reusar `montar`, `linha_de_chamado`, `texto`).
- Critérios de aceite:
  1. SP editado em célula que o site não tocou → envio sai com a edição do SP e a do site.
  2. Mesma célula alterada pelos dois com valores diferentes → conflito com chamado, coluna, os dois valores; nenhum conteúdo.
  3. Os dois alteraram para o mesmo valor → sem conflito.
  4. Linha nova do site já existente no SP → sem duplicar.
  5. Linha reordenada no SP → casada pela C.
  6. Linha apagada no SP com operação do site → conflito `linha_apagada`; escolhas `site` e `sharepoint` funcionam.
  7. H com várias linhas sobrevive byte a byte; data com segundos idem.
  8. Q, T, U, V, W e C nunca alteradas; linha do SP sem operação idêntica ao byte.
  9. Escolha com id antigo não resolve conflito novo.
- Verificar: `python -m pytest tests/test_sebrae_dashboard_gravacao.py -q`.
- Proibidos: `scripts/`, `routers/`, `static/`, `frontend/`.

## Bloco 1b: rotina enviar e fechar

- Objetivo: ligar o merge ao envio.
- Mudanças:
  - Origem do conteúdo: `_gravar_atualizacao` grava ao lado da saída um JSON `{base_sha256}` da importação usada. A cópia pendente já guarda `base_sha256`. Função `base_do_conteudo(state_dir, origem)` em `domains/sebrae_finalizacao.py`. Merge só se essa base == importação atual; senão aborta como hoje (`MSG_SHAREPOINT_MUDOU`). Snapshot sem origem conhecida → aborta como hoje.
  - `gravar_enviado` grava também `base_sha256`; a cópia enviada só vira ancestral se a base bate com a importação atual.
  - `conferir_dashboard_do_sharepoint`: SP igual à importação (hash ou valores) → envia `gerado` como hoje. Senão → `reaplicar`. Conflito → `DashboardEmConflito(RotinaErro)` com contagem e colunas na mensagem; conflitos gravados em `data/state/sebrae_dashboard_conflitos.json` (`{base_sha256, sharepoint_sha256, gerado_sha256, criado_em, conflitos, escolhas}`). Sem retry em `etapa_resiliente` para esse erro.
  - Conteúdo mesclado: `substituir_conteudo_envio(state_dir, envio_id, conteudo)` (sob trava, status `preparado`) troca snapshot e `sha256`, guarda `sha256_origem`. Chamado antes de `marcar_envio_incerto`. `descartar_pendentes` aceita cópia cujo sha == `sha256` ou `sha256_origem`. `gravar_enviado` com o conteúdo mesclado.
  - `scripts/sebrae_fechar.py`: `DashboardEmConflito` não cria nem sobe cópia pendente; o aviso diz que há conflitos para escolher na tela.
  - Nova importação apaga o arquivo de conflitos. Envio concluído também.
- Arquivos: `domains/sebrae_finalizacao.py`, `scripts/automacao_rotinas_chrome.py`, `scripts/sebrae_fechar.py`, `routers/sebrae_dashboard.py` (só a gravação do JSON de origem e a limpeza na importação), testes em `tests/test_automacao_rotinas_chrome.py`, `tests/test_sebrae_finalizacao.py`, `tests/test_sebrae_fechar.py`.
- Critérios de aceite:
  1. `test_precheck_aborts_when_the_sharepoint_file_changed` vira teste de merge (passa e envia mesclado); novo teste de aborto estrutural.
  2. Cópia pendente de importação antiga + importação nova → aborta, não mescla.
  3. Cópia enviada de importação antiga não vira ancestral.
  4. Conflito → para na primeira tentativa, sem cópia pendente, conflitos no JSON, mensagem sem valores.
  5. Envio mesclado → registro com novo sha e `sha256_origem`; pendente coberta é descartada.
  6. Testes existentes de segurança do envio continuam passando.
- Verificar: `python -m pytest tests/test_automacao_rotinas_chrome.py tests/test_sebrae_finalizacao.py tests/test_sebrae_fechar.py tests/test_sebrae_finalizar_router.py -q`.
- Proibidos: `static/`, `frontend/`, `renderizarSharepoint`.

## Bloco 2: tela de conflitos e reenvio

- Objetivo: listar conflitos e escolher por célula.
- Mudanças:
  - `GET /api/sebrae/dashboard/conflitos` → `{conflitos, escolhas, criado_em}` (vazio se não há). `GET /api/sebrae/finalizar-softexpert` ganha `conflitos` (contagem).
  - `POST /api/sebrae/dashboard/conflitos` `{escolhas: {id: "sharepoint"|"site"}, enviar: bool}` grava escolhas de ids existentes (422 para id ou valor inválido) e, com `enviar`, inicia a rotina `enviar` (mesmas travas de `_enviar_apos_atualizar`).
  - Front: módulo novo `static/js/features/sebrae-conflitos.js` e partial novo incluído perto de `#sebrae-sharepoint-aviso`. Lista "Chamado X, coluna Y: SharePoint diz A, site quer B" com escolha por célula e botão de reenviar. Em `sebrae-dashboard.js`, no máximo um gancho de uma linha fora de `renderizarSharepoint`.
  - Assistente: padrão de erro novo em `domains/assistant_api.py` para a mensagem de conflito (só contagem).
- Arquivos: `routers/sebrae_dashboard.py`, `static/js/features/sebrae-conflitos.js`, `frontend/partials/` (partial novo + include), `static/index.html` se o carregamento de módulos exigir, `domains/assistant_api.py`, testes de router e de UI.
- Critérios de aceite: rotas respondem conforme contrato; escolha inválida 422; tela mostra e envia escolhas; nenhum dado pessoal em `static/**`.
- Verificar: testes de router focados, `npm run test:ui:e2e`.
- Proibidos: `renderizarSharepoint`, demais funções de `sebrae-dashboard.js`.

## Bloco 3: documentação

- `docs/operacao/sincronizar-chamados-sebrae.md`: merge por célula, o que ainda aborta (estrutura, base antiga, `linha:<n>`), conflitos, limitação da reordenação.
- `docs/arquitetura/CONTRATOS_API_BACKEND.md`: rotas novas e campo `conflitos` (passar `tests/test_api_contract_doc.py`).
- Verificar: `npm run verify`.

## Fora do escopo

- Envio real ao SharePoint (não testado; sem autorização).
- Preservar a reordenação feita no SharePoint.
