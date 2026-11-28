# Regras de `scripts/`

Rotinas e automação do Chrome. Valem junto com o `AGENTS.md` da raiz; texto integral no doc indicado, sob "Regras movidas do AGENTS.md (10/11/2026)".

## Chrome de automação

- Toda rotina usa o Chrome CDP 9333 e a trava `data/state/automacao_chrome.lock`; nenhuma automação fecha abas anteriores nem o Chrome por ociosidade (`SIMPRESS_CHROME_OCIOSO_S`, desligado por padrão). Doc: `docs/operacao/automacao-chrome.md`.
- Porta CDP 9333 sem autenticação: risco aceito (decisão do usuário, 25/11/2026); nunca use `--remote-allow-origins` (`tests/test_cdp_sem_remote_allow_origins.py`); reavalie se a máquina tiver outros usuários. Doc: `docs/operacao/automacao-chrome.md`, seção "Porta CDP 9333".
- Login, senha e MFA são do usuário; a rotina espera o login. A rotina `login` nunca digita senha nem o código do autenticador (doc acima, seção "Rotina `login`").
- Clique acidental: se a página sair do lugar, volte ao mesmo link com `goto`, nunca `reload` no Oracle e no UX, e retome até 3 vezes (doc acima, seção "Clique acidental").
- Cliques irreversíveis (`Salvar edições`, `Enviar` do chamado UX, `Finalizar` e `Enviar` do anexo, `Replace`, `Conectar`, `Duplicata`) nunca se repetem e só rodam depois de `aguardar_estabilidade_pre_clique`.
- "pare" ou "cancelar" interrompe a rotina; presa 10 s depois do pedido, o vigia da trava encerra o driver do Playwright: todo `sync_playwright` sob a trava chama `registrar_driver`; depois de clique irreversível, só o cancelamento cooperativo. Download bloqueado não se contorna: só arquivo manual que o usuário identificar.

## Endpoint

- PowerShell no Endpoint insere o comando e NUNCA envia Enter (só `locator.fill()` em `#remotePowershellInputField`); comando vazio, com mais de 2000 caracteres ou com caractere de controle é rejeitado; o retorno traz `enter_enviado: false`; o log guarda só tamanho e modo, nunca o texto. Doc: `docs/operacao/automacao-chrome.md`.
- Consulta ao vivo lê só `Usuário do último logon` do equipamento selecionado; sem escrita no Endpoint.
- `staged_computers_endpoint.py` só lê, em aba própria, e o resultado vira só anotação da linha. Doc: `docs/operacao/alertas-os-divergencias.md`.

## SharePoint e SoftExpert

- `enviar` guarda cópia `Duplicata` antes de sobrepor, recusa `Keep both`, não faz `Retry` em `Save Conflict` e confirma pelo aviso de envio concluído ou, sem ele e sem andamento, baixando de novo e comparando os valores (25/11/2026). Espera pelo Dashboard aberto no Excel: até 15 min, sem `Retry`, retomada só com os mesmos valores em todas as abas, fora das tabelas dinâmicas (27/11/2026). Doc: `docs/operacao/sincronizar-chamados-sebrae.md`.
- SoftExpert é só leitura; a única escrita é `finalizar_chamado` em `sebrae_softexpert.py`, a pedido do usuário, com `Finalizar` e o `Enviar` do anexo liberados só dentro dela.
- `fechar`, `enviar`, `antigos` e `ux_apelidos` ficam fora de `ROTINAS_VALIDAS`.

## Rotinas de OS e inventário

- OS e inventário entram só pela pasta local (`data/state/entrada_chamados`, `data/state/entrada_automatica`), sem formulários, API nem HTTP; a conclusão é o `_resultado.json` com `status: concluido`. Skills: `.claude/skills/rotina-os-chamados`, `.claude/skills/rotina-exportar-planilhas`.
- Contas de login (Microsoft, SoftExpert, Endpoint Central): `docs/operacao/automacao-chrome.md`.

## Verificação

- Novo módulo no escopo do `mypy` ou novo alvo de `compileall`: altere a lista em `scripts/verify.cjs`; arquivos `.js` e `tests/frontend/test_*.cjs` são descobertos sozinhos. Doc: `docs/desenvolvimento/regras-agentes.md`.
