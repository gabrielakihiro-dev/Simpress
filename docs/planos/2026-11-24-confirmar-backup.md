# Confirmar Backup (Resumo F3, sub-aba Backups) — plano de implementação

> **Para agentes:** execute com superpowers:subagent-driven-development (executor por tarefa, revisor no fim). Passos com `- [ ]`.

**Objetivo:** trocar o botão `Confirmar disponível por 7 dias` dos candidatos por `Confirmar Backup`, que conta o equipamento como backup da regional sem prazo e perde efeito quando o Endpoint mostra outro usuário logado naquela série.

**Arquitetura:** reaproveita a rota `POST /api/backups-regionais/confirmar`, o estado `data/state/backups_regionais.json` (`domains/backups_regionais_store.py`) e o cálculo puro `build_backups_regionais` (`domains/backups_regionais.py`). O registro novo guarda uma referência (hash) do usuário do Endpoint no momento da confirmação; o cálculo compara com o usuário atual.

**Stack:** FastAPI + pytest; React/Vite em `frontend/src/paineis/backups-regionais/`; Playwright `tests/e2e/backups-regionais.spec.cjs`.

**Pedido do usuário (24/11/2026):** "nessa parte de 'Conferir possível backup' tenha um botão ao invés de confirmar disponível por 7 dias [...] Confirmar Backup - Aí se eu clicar nesse botão, ele reconheça como backup. [...] caso haja alteração no Endpoint de um outro usuário logar ou mudar o usuário [...] O usuário logado do Endpoint ligado ao número de série vai sobrepor essa regra e sumir da sub-aba de backups."

## Decisões

1. **Registro novo** (sem prazo): `{"serie", "cidade", "confirmado_em", "tipo": "backup", "usuario_ref"}`. `usuario_ref` = `""` (sem usuário no Endpoint) ou `"sha256:" + hexdigest(normalizado)`.
2. **Registros antigos de 7 dias** (`{serie, cidade, confirmado_em, expira_em}`, sem `tipo`): continuam lidos e valem até `expira_em`, como hoje; `podar()` os remove depois da retenção. Nada é migrado. `esquema` continua `1`; o validador aceita as duas formas de registro (e mistura delas).
3. **Usuário do Endpoint na confirmação:** a rota lê com `endpoint_user_for_serial` (mesma função do cálculo), sem olhar a data de verificação. Nenhum campo de usuário entra no payload (`extra=forbid` continua).
4. **Endpoint indisponível ao confirmar:** recusa 409 `endpoint_indisponivel` (foto vazia confundiria "desconhecido" com "sem usuário"); no front, o botão fica desabilitado quando o candidato tem motivo `fonte_endpoint_indisponivel`.
5. **Quando a confirmação nova cai** (ordem): `cidade_mudou` → `usuario_vigente` (só usuário manual ou trava ativa) → `usuario_mudou` → `bloqueio`. `usuario_mudou` = Endpoint disponível, série presente, usuário atual **não vazio** e `usuario_ref(atual) != usuario_ref` gravado. Usuário atual vazio ou série ausente do Endpoint não derruba (sem prova de troca).
6. **Mesmo usuário com verificação recente:** para série com confirmação nova vigente e mesmo `usuario_ref`, a parte "Endpoint recente com usuário" de `usuario_vigente` não exclui. Usuário manual e trava ativa continuam excluindo.
7. **Onde aparece a confirmação caída por `usuario_mudou`:** em `excluidos`, `motivo: "usuario_mudou"`, com `confirmacao: {"estado": "invalidada", "motivo": "usuario_mudou"}`. Some de Backups e de Candidatos.
8. **Repetir:** confirmação nova com o mesmo `usuario_ref` → `repetido: true`, nada muda. Registro antigo de 7 dias ou `usuario_ref` diferente → substituído pelo novo.
9. **Desfazer:** a rota `POST /api/backups-regionais/desfazer` e o botão `Desfazer` atuais ficam; valem para os dois tipos, inclusive no item excluído com confirmação invalidada.
10. **LGPD:** `usuario_ref` é pseudônimo (hash sem segredo, reversível por dicionário), não anonimização. Fica só em `data/state/backups_regionais.json`; nunca no `/api/painel`, resposta de rota, Assistente, toast ou log. Docs dizem isso.

## Pergunta aberta ao usuário (não bloqueia)

- Técnico logando como `Administrador` para configurar o backup deve derrubar a confirmação? Este plano **não** trata admin de forma especial (a regra de Administrador da outra sessão mora em `domains/regras_negocio.py`; não copiar). Registrar a pergunta no resumo final.

## Restrições globais

- Texto do botão exato: `Confirmar Backup`. Toast: `Backup confirmado: <série>` (nunca apelido: pode ser nome de pessoa).
- Nada de dado pessoal em log; `apelido` só na tela local.
- Cálculo continua puro; cadastro, Endpoint, Cobertura e manutenção só leitura.
- Rota/resposta mudou de forma: rodar `python scripts/gerar_tipos_api.py` antes do verify.
- Notebook fraco: specs e2e um por vez, nada em paralelo; pular `test_real_playwright_*` no verify se travar.
- Outra sessão (regra Backup+Cidade/Administrador nas divergências) mexe em `domains/regras_negocio.py` e talvez em `_marca_do_item`; não mexer nesses pontos. Conflito em merge: resolver preservando as duas regras.

## Foco da revisão

1. Arquivo real esquema 1 só com registros antigos → abre sem 503 e continua valendo até `expira_em`.
2. Grafia diferente do mesmo usuário (`SEBRAE\Fulano` vs `fulano`, espaços) → mesmo `usuario_ref`, confirmação não cai.
3. Série confirmada some do Endpoint (planilha nova sem ela) → confirmação continua vigente.
4. `usuario_ref` não aparece em `/api/painel`, em `listar_backups_regionais` do Assistente nem na resposta de `confirmar`.
5. Endpoint indisponível → `confirmar` 409, nada gravado; botão desabilitado.

---

### Tarefa 1: estado aceita o registro novo (store)

**Arquivos:** `domains/backups_regionais_store.py`, `tests/test_backups_regionais.py` (parte do store).

**Interfaces produzidas:**
- `TIPO_BACKUP = "backup"`; `CAMPOS_7_DIAS = ("serie", "cidade", "confirmado_em", "expira_em")`; `CAMPOS_BACKUP = ("serie", "cidade", "confirmado_em", "tipo", "usuario_ref")`.
- `validar_estado(valor, nome) -> Estado`: cada registro tem exatamente `CAMPOS_7_DIAS` (datas ISO válidas) ou exatamente `CAMPOS_BACKUP` (`tipo == "backup"`, `usuario_ref` str vazia ou `sha256:` + 64 hex).
- `_vigente(registro, agora) -> bool`: registro `tipo == "backup"` é sempre `True`.
- `confirmar(estado, serie, cidade, agora, usuario_ref: str) -> Tuple[Estado, Registro, bool]` (decisão 8).
- `desfazer` sem mudança de assinatura.

- [ ] Testes que falham: `test_estado_misto_valido` (um antigo + um novo passa); `test_registro_backup_com_campo_extra_ilegivel`; `test_usuario_ref_invalido_ilegivel` (`"fulano"` cru recusado); `test_confirmar_grava_tipo_backup_sem_expira`; `test_confirmar_repetido_mesmo_ref` (`repetido is True`, estado igual); `test_confirmar_substitui_ref_diferente`; `test_confirmar_substitui_registro_7_dias`; `test_podar_mantem_backup_e_remove_7_dias_antigo`; `test_arquivo_esquema1_real_le_sem_erro` (fixture JSON só com registros antigos, como o arquivo de hoje).
- [ ] Rodar `python -m pytest tests/test_backups_regionais.py -q -k "estado or confirmar or podar or esquema"` → falha.
- [ ] Implementar; atualizar docstring do módulo (decisão 10).
- [ ] Rodar de novo → passa. Commit `feat(backups): registro Confirmar Backup sem prazo no estado`.

### Tarefa 2: cálculo usa o usuário da confirmação

**Arquivos:** `domains/backups_regionais.py`, `tests/test_backups_regionais.py`.

**Interfaces produzidas:**
- `normalizar_usuario_endpoint(valor: Any) -> str`: `strip`, tira prefixo até a última `\`, tira sufixo a partir de `@`, `casefold`.
- `usuario_ref(valor: Any) -> str`: `""` se normalizado vazio; senão `"sha256:" + hashlib.sha256(normalizado.encode("utf-8")).hexdigest()`.
- `_confirmacoes_por_serie` passa a guardar `tipo` (`"backup"` ou `"7_dias"`) e `usuario_ref`; registro novo tem `expira = None` sem virar "expirada".
- `_confirmacao_da_serie`: a do tipo `backup` conta como validade máxima na ordenação.
- Payload: `confirmacao` vigente = `{"estado": "vigente", "tipo": "backup" | "7_dias", "expira_em": iso | None}`; item de `backups` com origem confirmação nova tem `confirmado_ate: None`. Nenhum `usuario_ref` no payload.

- [ ] Testes que falham (usar `AGORA` e endpoint sintético do arquivo):
  - `test_confirmar_backup_conta_sem_prazo` — 30 dias depois continua em `backups`, `origem == "confirmacao"`, `confirmacao["tipo"] == "backup"`.
  - `test_usuario_mudou_exclui` — gravado com ref de `"joao"`, Endpoint atual `"maria"` → em `excluidos`, `motivo == "usuario_mudou"`, `confirmacao == {"estado": "invalidada", "motivo": "usuario_mudou"}`.
  - `test_mesmo_usuario_recente_continua_backup` — gravado com `"joao"` (verificação antiga), Endpoint re-verifica hoje com `"SEBRAE\\Joao "` → continua em `backups`.
  - `test_sem_usuario_e_aparece_usuario_exclui` — ref `""`, Endpoint atual `"maria"` → `usuario_mudou`.
  - `test_usuario_atual_vazio_nao_derruba` e `test_serie_sumiu_do_endpoint_nao_derruba` → continua em `backups`.
  - `test_usuario_manual_e_trava_continuam_excluindo` — `usuario_vigente` mesmo com ref igual.
  - `test_confirmacao_7_dias_antiga_continua_expirando` — comportamento atual intacto.
  - `test_payload_sem_usuario_ref` — `"usuario_ref"` e `"sha256:"` ausentes de `json.dumps(resultado)`.
- [ ] Rodar `python -m pytest tests/test_backups_regionais.py -q` → falha.
- [ ] Implementar decisões 5, 6 e 7 no loop de `build_backups_regionais` (bloco das linhas ~188–258): calcular `endpoint_recente_com_usuario` separado; `usuario_vigente = manual or trava_ativa or (endpoint_recente_com_usuario and not mesma_ref_confirmada)`.
- [ ] Rodar → passa (todo o arquivo). Commit `feat(backups): Confirmar Backup cai quando o usuário do Endpoint muda`.

### Tarefa 3: rota grava a foto do usuário

**Arquivos:** `routers/backups_regionais.py` (rota `confirmar`, ~146–169), `tests/test_backups_regionais_router.py`, `frontend/src/api-tipos.gerado.d.ts` (gerado), `docs/arquitetura/CONTRATOS_API_BACKEND.md` (~353).

**Interfaces:** consome `usuario_ref` e `endpoint_user_for_serial` (Tarefa 2) e `confirmar(..., usuario_ref)` (Tarefa 1). Resposta: `{"confirmacao": {"serie", "cidade", "confirmado_em", "tipo"}, "repetido": bool}`; erro novo 409 `{"codigo": "endpoint_indisponivel"}` (seguir o formato de erro já usado na rota).

- [ ] Testes que falham: `test_confirmar_grava_ref_do_usuario_endpoint` (arquivo gravado tem `usuario_ref == usuario_ref("joao")`, resposta sem `usuario_ref`); `test_confirmar_endpoint_indisponivel_409_nada_gravado`; `test_confirmar_sem_usuario_grava_ref_vazio`; `test_payload_com_usuario_recusado_422` (campo extra).
- [ ] Rodar `python -m pytest tests/test_backups_regionais_router.py -q` → falha. Implementar. Rodar → passa.
- [ ] `python scripts/gerar_tipos_api.py` e `python scripts/gerar_tipos_api.py --check` → ok. Atualizar o contrato no doc.
- [ ] Commit `feat(backups): rota confirmar grava referência do usuário do Endpoint`.

### Tarefa 4: interface e textos

**Arquivos:** `frontend/src/paineis/backups-regionais/painel.tsx` (~67–69, ~106), `frontend/src/paineis/backups-regionais/montar.tsx` (~117–124), textos de motivo de confirmação invalidada (achar onde `cidade_mudou` vira texto no front), `tests/frontend/test_backups_regionais*.cjs`, `tests/e2e/backups-regionais.spec.cjs`, `tests/e2e/react-g5.spec.cjs:53`, fixture e2e em `tests/support/serve_ui_motion_preview.py` (abrir antes: é dela que vêm as séries `TSTBK*`).

- [ ] Botão `Confirmar Backup` (aria-label `Confirmar <série> como backup de <cidade>`), desabilitado com motivo `fonte_endpoint_indisponivel`. Toast `Backup confirmado: <série>`.
- [ ] Item de Backups com `confirmacao.tipo == "backup"`: mostrar `Confirmado como backup` no lugar de "confirmado até"; tipo `7_dias` mostra como hoje.
- [ ] Motivo `usuario_mudou` (excluído/invalidada): `Antes: o usuário do Endpoint mudou`.
- [ ] Fixture e2e: uma série confirmada com tipo `backup` e uma com usuário trocado (`usuario_mudou`).
- [ ] Atualizar asserções dos testes node e e2e (texto do botão, toast, item sumindo de Candidatos e aparecendo em Backups, excluído por usuário trocado, `Desfazer`).
- [ ] `npm run build` (refaz `static/dist`), depois testes node: `node --test tests/frontend/test_backups_regionais.cjs tests/frontend/test_backups_regionais_montar.cjs tests/frontend/test_alerta_backups_regionais.cjs`.
- [ ] e2e um por vez: `npx playwright test tests/e2e/backups-regionais.spec.cjs`, depois `npx playwright test tests/e2e/react-g5.spec.cjs`.
- [ ] Commit `feat(backups): botão Confirmar Backup na sub-aba Backups`.

### Tarefa 5: Assistente, docs e verificação final

**Arquivos:** `tests/test_assistant_backups.py`, `domains/AGENTS.md` (linha "Backups regionais"), `docs/cockpit-prompts/05-resumo-kpis.md:139`, `docs/cockpit-prompts/08-comparacao-operacional.md:212`, `docs/cockpit-prompts/14-cockpit-v2.md:212`, `docs/operacao/alertas-os-divergencias.md:202,216-239`, `README.md:27`.

- [ ] Teste `test_listar_backups_regionais_sem_usuario_ref` em `tests/test_assistant_backups.py` (saída da ferramenta sem `usuario_ref`/`sha256:`). Ajustar `SYSTEM_PROMPT`/descrição da ferramenta se citarem "7 dias".
- [ ] Docs: botão `Confirmar Backup`, sem prazo, cai com troca de usuário do Endpoint (decisões 5–7), desfazer, registros antigos de 7 dias, e a nota de LGPD da decisão 10. `domains/AGENTS.md`: trocar "Confirmação manual de 7 dias [...] sem dado pessoal" por texto que cite `usuario_ref` pseudônimo. Rodar `python -m pytest tests/test_rules_size.py -q`.
- [ ] `npm run verify` (pular `test_real_playwright_*` se travar) e `npm run test:ui:e2e` em background, um por vez.
- [ ] `graphify update .`
- [ ] Commit `docs(backups): Confirmar Backup e referência do usuário do Endpoint`; push; PR para `main`; Auto-fix ligado (`set_monitor`, `auto_fix: true`); não mesclar.
- [ ] Revisor (Opus) sobre o branch inteiro antes de dar como pronto.
- [ ] Resumo para leigo com `AC: <critério> — PROVEN BY <evidência>` para: botão novo; conta como backup; persiste em `data/state`; cai e some com outro usuário; mesmo usuário não derruba; registros de 7 dias antigos intactos; sem `usuario_ref` fora do arquivo; `.md` alterados; e a pergunta aberta do Administrador.
