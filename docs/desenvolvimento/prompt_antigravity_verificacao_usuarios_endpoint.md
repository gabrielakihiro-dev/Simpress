# Prompt para o Antigravity: verificação de usuários no Endpoint Central

Prompt para o Antigravity implementar uma etapa da aba Automação. A etapa confere no Endpoint Central as pendências de usuário do resultado da atualização das planilhas e as resolve sozinha.

## Regra de decisão

| Situação no Endpoint | `usuario_ausente` (usuário sumiu) | `substituicao_manual` (usuário novo vindo do Endpoint) |
|---|---|---|
| Mesmo usuário em "Usuários logados" ou como mais recente em Sistema > Usuários | `manter` | `permitir` |
| Computador achado, mas outro usuário válido | anotar e deixar pendente | anotar e deixar pendente |
| Computador achado, nenhum usuário válido após todos os passos | `remover` + aviso | `recusar` + aviso |
| Computador não achado nem pela série nem pelo hostname | `remover` + aviso | `recusar` + aviso |

## Prompt (colar no Antigravity)

```
Contexto do projeto
Repositório Simpress (FastAPI local + front-end JS). Leia AGENTS.md antes de tudo e siga-o. Trabalhe no seu próprio git worktree/branch; não troque o branch do checkout principal, não faça push sem autorização.

Objetivo
Criar uma etapa automática, passo a passo, que confere no Endpoint Central as pendências de usuário geradas pela atualização das planilhas e as resolve com a mesma API dos botões "Manter usuário"/"Confirmar remoção". Ela deve funcionar como as rotinas que já existem na aba Automação.

O que já existe (reutilize; não crie um segundo mecanismo)
- Script: scripts/automacao_rotinas_chrome.py
  - garantir_chrome / conectar: Chrome de automação na porta CDP 9333, perfil ~/.chrome-automation, --restore-last-session. Use o MESMO Chrome e a MESMA porta 9333.
  - aguardar_login + endpoint_logado: o login é sempre feito pelo usuário; nunca digite credenciais. Mantenha os marcadores "AÇÃO NECESSÁRIA: faça o login" / "Login detectado".
  - ENDPOINT_URL = https://centralendpoint.pr.sebrae.com.br/webclient#/uems/inventory/computers
  - rodar_rotina_inventarios (UX → Endpoint → importação), sinal de cancelamento, lock e logs por execução.
- Backend da aba: routers/automation.py (POST /api/automacao/executar {rotina}) e domains/chrome_automation.py (ScriptContract, ChromeAutomationRunner).
- Front da aba: static/index.html (#tab-panel-automacao, botões os/inventarios/ambas/login) e static/js/features/chrome-automation.js (iniciarRotinaAutomacao).
- Pendências: domains/user_holds.py (plan_holds, resolve_hold; tipos usuario_ausente e substituicao_manual)
  - GET  /api/usuarios/pendencias
  - POST /api/usuarios/pendencias/{id}/decidir  {"decisao": "manter"|"remover"|"permitir"|"recusar"}  (routers/aliases.py)
  - Um 409 significa pendência desatualizada: registre e siga para a próxima, sem forçar.
- Anotações por linha: PUT /api/historico-comparacoes/{evento_id}/anotacoes/{item_id} com {"anotacao": "..."} (routers/inventory_history.py).
  - A categoria mudancas_usuarios já aceita anotação.
  - O item_id é o anotacao_id da linha no evento do histórico (services.comparison_annotation_item_id).
  - Limite de 2.000 caracteres.

O que implementar
1. Nova rotina "usuarios" no script (--rotina usuarios), no ScriptContract/routers (rotinas aceitas) e um botão "Verificar usuários" na aba Automação. Preserve IDs, ARIA, data-* e os temas claro/escuro.
2. Chamar a mesma verificação no FIM de rodar_rotina_inventarios, depois que o _resultado.json confirmar a importação (vale também para "ambas").
3. A rotina lê as pendências abertas via GET /api/usuarios/pendencias e processa, uma por vez, as dos tipos usuario_ausente e substituicao_manual.

Passo a passo no Endpoint Central (para cada pendência)
P1. Abra ENDPOINT_URL numa aba do Chrome 9333; se pedir login, aguarde o usuário (aguardar_login).
P2. Clique em "Todos os computadores".
P3. Clique na lupa (ícone de pesquisa à direita, acima da tabela) para abrir os filtros por coluna.
P4. Digite a SÉRIE da pendência no filtro da coluna "Rótulo de serviço/número de série" (ex.: BRJ0000TST) e aguarde a tabela atualizar.
    Para MacBook, se não houver resultado, tente a série sem o "S" inicial (regra do AGENTS.md; só aceite resultado único).
P5. Sem resultado: limpe esse filtro e digite o HOSTNAME no filtro "Nome do computador" (ex.: PRNOTETST001).
P6. Ainda sem resultado → "computador não encontrado". Mais de uma linha → "ambíguo": anote e deixe pendente.
P7. Com UMA linha: leia a coluna "Usuários logados". Considere vazio quando for "NA", "N/A", "--" ou em branco.
    - Se tiver nome, use-o como usuário encontrado (fonte: lista).
P8. Se estiver vazio: clique no nome do computador (link azul ao lado do ícone de tela verde) → aba "Sistema" → "Usuários".
    - Ignore Administrador, Convidado, DefaultAccount e WDAGUtilityAccount (sem diferenciar maiúsculas).
    - O usuário encontrado é a PRIMEIRA linha válida, de cima para baixo (fonte: aba Sistema).
    - Não clique em "Gerar relatório" nem em "Ações".
P9. Compare o usuário encontrado com o usuário da pendência sem diferenciar maiúsculas/minúsculas e sem domínio (PR-SEBRAE\jteste = jteste).

Decisão
- usuario_ausente (usuário anterior sumiu):
  - mesmo usuário encontrado                        → decidir "manter"
  - outro usuário válido                            → não decidir; anotar "Endpoint mostra <usuário> (<fonte>)"
  - computador achado sem usuário válido            → decidir "remover" + AVISO
  - computador não encontrado (série e hostname)    → decidir "remover" + AVISO
- substituicao_manual (usuário novo vindo do Endpoint): mesma regra
  - usuário novo confirmado     → "permitir"
  - outro usuário               → anotar e deixar pendente
  - sem usuário / computador não encontrado → "recusar" + AVISO
- Em toda pendência, grave na anotação da linha: data/hora, série, hostname, filtro que achou, fonte (lista ou Sistema), usuário lido e decisão.

Avisos para o usuário
- Toda remoção/recusa automática gera uma linha "[AVISO] Verificar usuários: <série> <hostname> — <motivo> — removido automaticamente" no Andamento da aba Automação e entra no resumo final.
- O motivo é "computador não encontrado" ou "sem usuário válido".
- Assim o usuário consegue revisar se o passo a passo falhou.
- Resumo final no log: total verificado, mantidos, removidos, pendentes com anotação, ambíguos e erros.

Regras
- Só navegação pelo navegador (nada de API do Endpoint Central nem HTTP direto a ele); não altere permissões do Chrome.
- Se a página bloquear ou travar, não contorne e não repita cliques às cegas: registre [FALHA] na pendência e siga.
- Respeite o sinal de cancelamento entre pendências ("pare"/"cancelar").
- Não edite planilhas, históricos nem data/state à mão: toda mudança passa pela API de pendências e pela de anotações.
- Seletores: prefira texto/atributos estáveis (inspecione a página com o usuário logado). Não use coordenadas.

Testes e verificação
- Testes Python com Playwright mockado ou funções puras para:
  - escolha do usuário (filtro de contas internas, primeira linha válida, NA/N/A/--, domínio)
  - tabela de decisão
  - série com/sem "S"
  - tratamento de 409
- Teste do front para o botão novo.
- Rode npm run verify e npm run test:ui:e2e.
- Teste manual: pendência real (ex.: BRJ0000TST / PRNOTETST001 / jteste) → resultado esperado "manter".
- Ao final: commit no seu branch, sem push. Informe o branch, os arquivos alterados e a saída dos testes.
```
