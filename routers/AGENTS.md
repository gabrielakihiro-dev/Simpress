# Regras de `routers/`

Contratos HTTP. Valem junto com o `AGENTS.md` da raiz; rotas, campos e códigos estão em `docs/arquitetura/CONTRATOS_API_BACKEND.md`, que tem a seção "Regras movidas do AGENTS.md (10/11/2026)".

- Sessão: `/api/*` exige o cookie `simpress_sessao_<porta>` (`GET /bootstrap?t=<segredo>`); sem ele, 401. Clientes internos usam `cabecalho_cookie` e `ler_segredo` de `security/sessao_local.py`. Doc: `docs/arquitetura/CONTRATOS_API_BACKEND.md`.
- Ações irreversíveis exigem `confirmado: true` (ex.: `POST /api/sebrae/finalizar-softexpert`); sem ele, 422 e nada dispara. Envio real ao UX exige também `enviar: true`. Doc: o mesmo.
- `POST /api/sebrae/dashboard/atualizar` e `POST /api/sebrae/finalizar-softexpert` exigem `versao_importacao` igual à da tela; ausente ou antiga: 409. Doc: `docs/operacao/automacao-chrome.md`, seção "Agendamento do Dashboard".
- Códigos: 409 para trava ocupada ou conflito, 422 para entrada inválida ou recusa de regra, 503 para recurso indisponível (`chrome_indisponivel`, registro ilegível). Doc: `docs/arquitetura/CONTRATOS_API_BACKEND.md`.
- Rotas Sebrae (`sebrae_dashboard.py`): só leitura dos dados locais, salvo as gravações descritas no doc; o Assistente nunca dispara `enviar`. Doc: `docs/operacao/sincronizar-chamados-sebrae.md`.
- Rotas UX (`ux_chamados.py`, `ux_ticket.py`): sessão opaca de 30 min, trava compartilhada do Chrome e histórico fora do Git; nada de descrição ou solicitante em log. Doc: `docs/operacao/automacao-chrome.md`.
- Rotas de OS (`operations.py`): marca de finalização, observação e vínculo gravam só em `data/state`; `GET` nunca grava. Doc: `docs/cockpit-prompts/07-chamados-operacional.md`.
- Mudou rota, campo ou código de status: atualize o doc de contratos no mesmo trabalho (há teste em `tests/test_api_contract_doc.py`). Doc: `docs/arquitetura/CONTRATOS_API_BACKEND.md`.
