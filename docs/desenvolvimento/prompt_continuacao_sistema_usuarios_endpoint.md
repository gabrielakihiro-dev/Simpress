# Prompt: continuar a verificação de usuários (Sistema > Usuários no Endpoint Central)

Use este prompt numa máquina **sem o Netskope** (o DLP do notebook corporativo bloqueia o envio ao Claude do conteúdo do Endpoint Central). Cole o bloco abaixo no Claude Code, no Codex ou no Antigravity, num worktree novo criado a partir do branch `claude/verificar-usuarios-endpoint` (ou da `main`, se ele já tiver sido integrado).

```
Contexto do projeto
Repositório Simpress (FastAPI local + front-end JS). Leia AGENTS.md antes de tudo e siga-o. Trabalhe no seu próprio git worktree/branch; não troque o branch do checkout principal e não faça push sem autorização.

Problema em aberto (resolva PRIMEIRO, antes do P8)
No teste ao vivo de 21/10/2026, a rotina parou na 1ª pendência com "[FALHA] A grade do Endpoint não confirmou o filtro da coluna 'numero de serie' em 60 s" (a trava funcionou: nada foi decidido). A grade ficou em "0 - 0 de"/"Nenhum dado disponível" com o filtro de série preenchido, embora a mesma série, digitada à mão (clique no campo, digitar, Enter), retorne 1 linha.
- Suspeita: campo.fill() troca o valor do input sem disparar o que o componente Ember usa para guardar o texto do filtro, e o Enter pesquisa com o valor antigo/vazio. Compare fill() com click() + type(delay) + Enter, e com limpar via Ctrl+A/Backspace.
- Outra hipótese: o filtro aplicado antes da grade terminar de carregar (spinner .page-loader-wrapper/.spinner).
- Corrija aplicar_filtro em scripts/verificar_usuarios_endpoint.py, mantendo a confirmação (valor no campo + linhas que contêm o valor, ou grade vazia confirmada) e o RotinaErro quando não confirmar.
- Teste com: SIMPRESS_PORT=8050 python scripts/automacao_rotinas_chrome.py --rotina usuarios (servidor de teste; ver "Regras"). Na 1ª pendência da cópia de teste, o usuário esperado aparece em "Usuários logados": o resultado esperado é "manter".
- Depois, teste o botão "Verificar usuários" na aba Automação do servidor de teste.

O que já existe (no branch)
- scripts/verificar_usuarios_endpoint.py: rotina "Verificar usuários" (botão na aba Automação, --rotina usuarios e fim de Inventários/Ambas).
  - Usa o Chrome de automação da porta 9333 (garantir_chrome/aguardar_login de scripts/automacao_rotinas_chrome.py). O login é sempre do usuário; nunca digite credenciais.
  - Recebe o módulo de automação em execução: verificar_usuarios_endpoint(context, automacao). Não importe scripts.automacao_rotinas_chrome de novo dentro do módulo (duplicaria RotinaCancelada e o controle de cancelamento).
  - Grade "Todos os computadores" (ember-table, sem <table>): cabeçalhos .ember-table-header-cell, linhas .ember-table-table-row (sem .ember-table-header-row), células .ember-table-cell, filtros input.search-text-box abertos pela lupa button[id$='_searchButton'] e aplicados só com Enter. Colunas e filtros são associados pela posição x do cabeçalho (a ordem muda entre as visões).
  - aplicar_filtro só aceita a grade quando o campo mantém o valor e as linhas batem com ele ("0 - 0 de"/"Nenhum dado disponível" quando vazia); sem confirmação levanta RotinaErro e nada é decidido.
  - pesquisar_computador_endpoint: série → série sem "S" (MacBook) → hostname, com correspondência exata e limpeza do filtro após cada tentativa.
  - escolher_usuario_lista: "Usuários logados" pode ter vários nomes separados por vírgula; ignora NA/N/A/--/-, Administrador, Convidado, DefaultAccount, WDAGUtilityAccount e root.
  - avaliar_decisao(..., sistema_consultado=False): hoje, com "Usuários logados" vazio, a pendência fica PENDENTE com a anotação "Sistema > Usuários não consultado".
  - Decide por POST /api/usuarios/pendencias/{id}/decidir e anota a linha de "Mudanças de usuário logado" por PUT /api/historico-comparacoes/{evento}/anotacoes/{anotacao_id} (localizar_linha_anotacao casa pelo pendencia_id).
  - No fim, a aba do Endpoint fica aberta com a grade filtrada pelo hostname da última pendência.
- tests/test_automacao_usuarios.py cobre tudo isso com Playwright mockado.

Objetivo: implementar o passo P8 (detalhe do computador)
Quando a única linha encontrada tiver "Usuários logados" vazio:
1. Clique no link do nome do computador (a.anchor-text da célula da coluna "Nome do computador", href #/uems/inventory/computers/<id>). Ele abre o detalhe na MESMA aba (SPA), em #/uems/inventory/computers/<id>/summary.
2. Abra a aba "Sistema" e, dentro dela, "Usuários". Inspecione a página logado (read_page/DOM) e use seletores estáveis; nada de coordenadas. Não clique em "Gerar relatório" nem em "Ações".
3. Leia os nomes da tabela de usuários de cima para baixo e escolha com escolher_usuario_sistema (primeira linha válida, ignorando contas internas e vazios). Associe a coluna pelo título do cabeçalho, como na grade.
4. Volte para a grade (page.goto(ENDPOINT_URL), selecionar_todos_computadores, confirmar_modo_todos, preparar_grade) antes da próxima pendência, inclusive em caso de erro (try/finally).
5. Chame avaliar_decisao com fonte="Sistema" e sistema_consultado=True. Com isso volta a valer a tabela de decisão original:
   | Situação                                      | usuario_ausente      | substituicao_manual  |
   | Mesmo usuário                                 | manter               | permitir             |
   | Outro usuário válido                          | anotar e deixar pendente (as duas)          |
   | Sem usuário válido em Sistema > Usuários      | remover + [AVISO]    | recusar + [AVISO]    |
   | Computador não achado (série e hostname)      | remover + [AVISO]    | recusar + [AVISO]    |
6. Se a aba Sistema/Usuários não carregar ou o detalhe não abrir, levante RotinaErro (não decida "sem usuário válido" com uma leitura não confirmada) e respeite o cancelamento ("pare"/"cancelar") nas esperas.
7. Mantenha o comportamento final: a aba do Endpoint fica aberta com a pesquisa do hostname da última pendência.

Regras
- Só navegação pelo navegador no Endpoint Central; não use API/HTTP direto a ele e não altere permissões do Chrome.
- Se a página bloquear ou travar, não contorne e não repita cliques às cegas.
- Não edite planilhas, históricos nem data/state à mão.
- Para testar ao vivo sem tocar nos dados reais, rode um servidor do worktree numa porta própria (SIMPRESS_PORT=8050) com uma cópia de data/planilhas_entrada e data/state e SIMPRESS_ANNOTATIONS_DIR apontando para uma pasta temporária (assim as anotações de teste não vão para a pasta compartilhada do OneDrive). Rode: SIMPRESS_PORT=8050 python scripts/automacao_rotinas_chrome.py --rotina usuarios

Testes e verificação
- Acrescente em tests/test_automacao_usuarios.py: leitura de Sistema > Usuários mockada (primeira linha válida, só contas internas → sem usuário), volta à grade mesmo com erro, e a decisão com sistema_consultado=True.
- Teste ao vivo com um computador cuja coluna "Usuários logados" esteja NA/--.
- Rode npm run verify e npm run test:ui:e2e.
- Ao final: commit no seu branch (confira git branch --show-current), sem push. Informe o branch, os arquivos alterados e a saída dos testes.
```
