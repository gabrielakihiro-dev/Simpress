> **Substituído em 28/10/2026.** O cartão descrito aqui saiu da tela Automação; a tela atual é o cartão "Chamados novos do SoftExpert" (`docs/operacao/sincronizar-chamados-sebrae.md`, seção "Tela no site"). O texto abaixo fica só como histórico.

# Sincronizar chamados Sebrae — Fase D (interface)

Especificação da interface do cartão **Sincronizar chamados Sebrae** na tela Automação. A regra de negócio, a API e o estado estão em `docs/operacao/sincronizar-chamados-sebrae.md`; este documento só descreve a tela.

## Onde fica

Aba **Automação**, logo abaixo do cartão "Automação do Chrome" e acima de Andamento (`#sebrae-painel`). Arquivos: `static/index.html`, `static/js/features/chrome-automation.js` (mesmo módulo das outras rotinas), `static/styles/ux-refinements.css`.

## Conteúdo do cartão

| Elemento | ID | Comportamento |
| --- | --- | --- |
| Texto fixo | `sebrae-regra` | "Roda de segunda a sexta, das 09h15 às 17h45, a cada 30 minutos. O computador precisa estar ligado e o servidor local da Simpress em execução." |
| Situação atual | `sebrae-estado` (`role=status`) | `Sincronizando` (rotina `sebrae` em andamento), `Aguardando` (outra rotina em andamento), `Agendamento ativo` (com a próxima execução) ou `Agendamento pausado`. |
| Aviso de login | `sebrae-login-aviso` | Visível quando `login_necessario` é verdadeiro no resumo. O banner existente (`#automacao-aviso-login`) continua cobrindo o login durante a execução. |
| Agendamento / Última / Próxima execução | `sebrae-agendamento`, `sebrae-ultima`, `sebrae-proxima` | Próxima execução só aparece com o agendamento ativo; pausado mostra "—". |
| Contadores | `sebrae-incluidos`, `sebrae-ignorados`, `sebrae-pendentes` | Incluídos, Ignorados por duplicidade e Mantidos pendentes, da última execução. |
| Executar agora | `btn-sebrae-executar` | `iniciarRotinaAutomacao("sebrae")` → `POST /api/automacao/executar {rotina: "sebrae"}`. Desabilitado enquanto qualquer rotina roda (`data-automacao-rotina`). |
| Ativar/Pausar agendamento | `btn-sebrae-agendamento` | `PUT /api/automacao/sebrae/agendamento {ativo}`; o rótulo alterna entre `Ativar agendamento` e `Pausar agendamento`. |
| Cancelar sincronização | `btn-sebrae-cancelar` | Reaproveita `cancelarRotinaAutomacao` (`POST /api/automacao/cancelar`); só habilita quando a rotina em andamento é a `sebrae`. O botão `Cancelar` do cartão principal continua cancelando qualquer rotina. |
| Aviso do agendamento | `sebrae-agendamento-aviso` | Explica que o agendamento ainda não pode ser ativado enquanto `pronta` for falso e mostra o último horário agendado quando ele foi pulado (`pulado: ocupada`) ou falhou ao iniciar. |
| Pendências | `sebrae-pendencias` | Tabela Chamado × Motivo. Códigos de motivo viram frases (`sem_indicios_de_tipo` → "Sem indícios de incidente ou de solicitação."); motivos desconhecidos aparecem como vêm. |

O filtro `#automacao-historico-rotina` ganhou a opção `sebrae` ("Sincronizar chamados Sebrae"); o histórico e o log usam o mesmo rótulo.

### Erro 409 ao ativar

Enquanto `ROTINA_PRONTA` for falso (até a Fase E), o servidor responde 409 ao ativar. A tela mostra a mensagem do servidor num aviso (`warning`), mantém o botão habilitado, não muda a situação e mantém o texto explicativo permanente em `sebrae-agendamento-aviso`.

## Notificações (sem repetição)

A tela consulta `GET /api/automacao/sebrae/resumo` ao abrir a aba, quando termina uma execução, quando muda a última execução e a cada 60 s com a aba visível. A primeira consulta só define a referência (nenhum aviso). Depois, `avisosSincronizacaoSebrae(anterior, atual)` — que espelha `deve_avisar` de `domains/sebrae_chamados.py` — gera avisos **somente** quando:

- uma execução nova inclui chamados (`success`);
- o conjunto de pendências muda e não está vazio (`warning`);
- o login passa a ser necessário (`warning`);
- uma execução nova falha com situação ou detalhes diferentes dos anteriores (`error`).

Execução nova só com duplicados, a mesma pendência, a mesma falha ou pendências que sumiram ficam em silêncio. O aviso de fim de rotina já existente (execução iniciada pelo botão) continua como estava. O toast do Windows é da rotina (script), não da tela.

## Acabamento

- Mesmos tokens `--ux-*` e estilos `.automation-*`; novos estilos `.sebrae-*` no fim do bloco de Automação, com temas claro e escuro.
- Animações: só as transições já existentes do `.automation-status` (`--motion-fast`); `prefers-reduced-motion` já as desliga.
- Telas até 40rem: fatos viram linhas rótulo/valor, contadores viram linhas e a tabela de pendências vira cartões (mesmos dados, cabeçalho oculto só visualmente); botões em duas colunas e Cancelar em linha inteira.
- IDs, ARIA e `data-*` existentes preservados; a região `role=status` só muda o texto quando ele muda, para o leitor de tela não repetir anúncios.

## Dependências do resumo (nada a pedir à Fase A)

A tela usa apenas campos que o resumo já devolve. Suposições sobre campos do script, a confirmar nas Fases B/C/E:

- `ultima_execucao.situacao`: reconhece `concluido`, `parcial`, `falha`, `cancelado`, `interrompido`, `login_necessario`, `em_andamento`; outro valor aparece como veio.
- `ultima_execucao.detalhes`: mostrado ao lado da situação apenas quando for texto.
- Códigos de motivo das pendências: os de `domains/sebrae_chamados.py` (`MOTIVO_*`, `numero_invalido`).

## Testes

- `tests/frontend/test_sebrae_sync_ui.cjs`: regras de aviso, 409, ativar/pausar e renderização do cartão.
- `tests/e2e/chrome-automation.spec.cjs`: cartão, contadores e pendências, 409, ativar/pausar com a rotina pronta, executar e cancelar, login, auditoria axe e cartões no celular nos dois temas.
- Fixture: `tests/support/serve_ui_motion_preview.py` aceita `rotina: "sebrae"` e responde às rotas fictícias de resumo e agendamento. `/__fixture_automacao?sebrae=padrao|vazio|pronta|login` escolhe o cenário (só `pronta` aceita ativar).
