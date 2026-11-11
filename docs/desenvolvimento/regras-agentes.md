# Regras gerais para agentes (detalhe)

Regras movidas do `AGENTS.md` da raiz em 10/11/2026, sem alteração de texto. O resumo continua no `AGENTS.md`; aqui fica o detalhe.


## Regras movidas do AGENTS.md (10/11/2026)

Texto integral das seções que ficavam no `AGENTS.md` da raiz até 10/11/2026. O resumo e o índice continuam no `AGENTS.md`.

### Introdução do AGENTS.md antigo

> Texto histórico. Hoje a fonte das regras gerais é o `AGENTS.md` da raiz; as de domínio ficam nos `AGENTS.md` de pasta e nos docs do Índice. Seções citadas abaixo como "acima" (ex.: "Rótulos do Histórico de Planilhas", "Ticket de Atualização Cadastral no UX", `Assistente (OpenRouter)`) estão agora em `docs/operacao/regras-cadastro-historico.md`, `docs/operacao/automacao-chrome.md` e `docs/cockpit-prompts/15-assistente.md`.

Este arquivo é a fonte única das regras para agentes (Claude Code, Codex e Cursor). `CLAUDE.md` e `.cursor/rules/*.mdc` apenas apontam para cá; altere as regras somente aqui.

Vocabulário do domínio: consulte o `GLOSSARY.md` (definições; as regras continuam neste arquivo).

### Textos aprovados da interface

- A confirmação de exportação bem-sucedida usa o texto exato `Planilha Exportada com Sucesso!`, sem contagens ou explicações adicionais.
- Os nomes visíveis das fontes são `No Endpoint` e `na Simpress`, respeitando as variações definidas em "Rótulos do Histórico de Planilhas".
- Ao mudar um termo aprovado, propague-o para interface, validação e testes.
- Transporte (F2, 07/11/2026): o modal se chama `Gerar ticket no UX` e os botões de envio são `Simular preenchimento` e `Revisar e finalizar` (detalhes em "Ticket de Atualização Cadastral no UX").
- Pesquisa da Home sem resultado: o autocompletar mostra `Você quis dizer <usuário mais próximo>?` (campo `sugestao`); `Enter` na barra (`#input-serial`) ou `Buscar Equipamento` leva sempre à Home (F1) antes de pesquisar (04/11/2026, pedido do usuário); só navegação, sem escrita.
- Home (02/11/2026): com um só caractere na busca, mantenha `Digite ao menos 2 caracteres para filtrar a lista.` mesmo se uma resposta antiga chegar depois; `aria-selected` acompanha só o equipamento carregado. As ações `Sem acesso`/`Divergente` ficam em `#home-equipment-actions`; tudo é consulta/navegação, sem escrita em dados locais ou sistemas externos. Detalhes em `docs/cockpit-prompts/03-home-split-view.md`.

### Documentação de mudanças em qualquer aba

Vale para todas as abas do site (Home, Transporte, Resumo, Automação e as que vierem). Ao mudar uma aba (tela, comportamento, rotina, endpoint, texto aprovado, dado gravado ou regra de segurança), faça no mesmo trabalho:

- Atualizar o `.md` da aba: em `AGENTS.md` (regra) e no documento específico em `docs/` (ex.: `docs/operacao/*.md`; contratos de API em `docs/arquitetura/CONTRATOS_API_BACKEND.md`). Se a aba não tiver documento, criar um.
- Manter a integração coerente: backend, front-end (`static/js/features/`), testes (Python, `tests/frontend`, `tests/e2e`) e rótulos aprovados, que se propagam para interface, validação e testes.
- Regra permanente do usuário (03/11/2026): toda mudança de funcionalidade deve manter o assistente de IA alinhado (ferramentas, descrições, cartão de confirmação, máscara de dados e `Assistente (OpenRouter)` acima) e testado de verdade: além dos testes unitários com cliente falso, peça a mudança ao assistente real no servidor local e confira o resultado na tela.
- Registrar o que a mudança escreve ou apaga em sistemas externos ou em dados locais, e a autorização do usuário com a data. Escrita nova em SoftExpert, SharePoint ou outro sistema externo não entra sem autorização explícita.
- No relatório final, informar quais `.md` foram atualizados.

### Auditorias somente leitura

Não altere arquivos, dados operacionais, dependências nem o estado do Git. Passos e formato do relatório (falhas confirmadas × melhorias, evidências, impacto, gravidade, certeza, áreas revisadas, limitações): skill `.claude/skills/auditoria-somente-leitura`.

### Explicações para leigo

O usuário é leigo em back-end e front-end, mas conhece Git: em comandos Git, seja sucinto e mantenha o que o comando altera e o destino quando houver risco (push, force, reset). Em análises, auditorias, revisões e instruções sobre o código:

- Comece pelo resumo em português simples; deixe o detalhe técnico (arquivo, linha, código) para depois. Defina cada termo técnico na primeira vez que aparecer e dê um exemplo concreto, do dia a dia ou do projeto.
- Antes de implementar uma mudança autorizada, diga objetivo, motivo, áreas afetadas, comportamento esperado e como vai verificar; se o pedido já autoriza a mudança, prossiga sem pedir confirmação de novo.
- Para cada comando, diga o que faz, se altera algo (arquivos, dados, Git) e como saber se deu certo; para cada recomendação, o que acontece com e sem ela.
- Caminhos, comandos e mensagens de erro exatos ficam em blocos de código.
- Depois de uma alteração, relate o que mudou (arquivo e trecho), por quê, o efeito prático, as verificações executadas com resultados e o que não foi verificado ou segue incerto.

### Geração de prompts e economia de tokens

Quando o usuário pedir um prompt para analisar ou melhorar algo no sistema, siga a skill `.claude/skills/gerar-prompt` (seleção exata de arquivos e pastas, o que nunca enviar, fatiamento por camada).

### Verificação

- Antes de concluir uma mudança, rode `npm run verify` (ou `node scripts/verify.cjs`). Ele executa as mesmas checagens do CI: testes Python, `node --test`, `node --check`, `compileall`, `mypy` gradual e busca de credenciais. Usa o Python da `.venv` quando existir; para outro interpretador, defina `PYTHON`.
- Para mudanças de interface, rode também `npm run test:ui:e2e`.
- Ao incluir um módulo no escopo do `mypy` ou um alvo novo de `compileall`, altere a lista em `scripts/verify.cjs`; arquivos JavaScript e testes em `tests/frontend/test_*.cjs` são descobertos automaticamente.
- Evidência por critério: ao dar algo como pronto, cada critério de aceite vem numa linha `AC: <critério> — PROVEN BY <evidência>` (saída de `npm run verify` ou de um teste focado, comando, verificação no navegador). Critério sem evidência conta como não verificado.
- Teto de correção: no máximo 3 ciclos de correção sobre a mesma falha (teste, revisão ou CI). Depois disso, pare e devolva ao usuário o que foi tentado e o que ainda falha.
- Verificação vaga: se o pedido disser só "verifique que funciona", antes de executar escreva no início da resposta as 4 definições: o que é observável, qual mecanismo prova (teste, `node scripts/verify.cjs`, navegador), qual o escopo e o que fazer se falhar.

### Delegação em subagentes

- Conduza trabalho grande com subagentes sucessivos, um papel por vez, na sequência análise → implementação → revisão independente quando fizer sentido. Aguarde cada etapa terminar antes de iniciar a próxima e não paralelize etapas que dependam umas das outras ou que toquem os mesmos arquivos.
- Escolha o subagente pelo papel, não pelo nome do modelo:

| Papel | Claude Code (plugin `model-super-power`) | Codex | Antigravity |
|---|---|---|---|
| Análise: buscar e ler em volume | `model-super-power:batedor` (Haiku 5.5, sem Bash) ou `Explore` | GPT-6 Luna, esforço `max` | Subagente `research` ou `batedor` (`Model: flash_lite`, sem write tools) |
| Implementação decidida | `model-super-power:executor` (Sonnet 5.5) | GPT-6.1 Sol | Subagente `executor` (`Model: flash`) ou `self` |
| Revisão independente | `model-super-power:revisor` (Opus 5.5) | GPT-6.1 Terra | Subagente `revisor` (`Model: pro`) |
| Segunda opinião sobre texto ou plano | `model-super-power:segunda-opiniao` (Sonnet 4.6) | GPT-6 Luna, esforço `max` | Subagente `segunda-opiniao` (`Model: flash` ou `pro`) |
| Arquitetura ou estratégia cara de errar (raramente) | `model-super-power:arquiteto` (Fable 5.1) | GPT-6.1 Terra | Subagente `arquiteto` (`Model: pro`) |

- Se o plugin não estiver instalado no Claude Code, use o agente embutido de função equivalente.
- O agente principal define o escopo, integra os resultados e verifica o estado final; faz na própria conversa o que for pequeno (um arquivo, uma busca, um comando, uma edição). No Antigravity, o maestro dispara subagentes via `invoke_subagent` com o `Model` correspondente e `Workspace: branch` quando isolamento for necessário. Cada subagente recebe só o seu bloco e entrega só a conclusão. Evite `fork`, que herda o contexto todo.
- Trabalho independente que termina em algo próprio (branch, PR) vai para uma sessão separada, em seu próprio worktree.
- Compactação que atrapalha o fluxo (regra do usuário, 09/11/2026): se a conversa compactar e perder o fio (resumo incompleto, passo repetido ou esquecido, contexto trocado), não insista nela. Abra uma sessão nova com brief completo (tarefa, restrições, estado atual, worktree e branch, commits feitos, próximo passo) e continue o trabalho lá; a conversa antiga só acompanha e confere o resultado.
- Plano enxuto: cada passo traz Objetivo, Arquivos, Critérios de aceite e Verificar (o comando ou a checagem que prova o critério, por exemplo `npm run verify`). Sem código pronto no plano, exceto assinaturas e contratos entre arquivos. Quando houver risco de sair do escopo, o passo traz também Proibidos: os arquivos que ele não pode tocar. Plano acima de ~150 linhas é dividido em blocos. O pedido do agente principal ao executor segue o mesmo formato.
- Dúvida de design: a sessão que executa um plano, ao encontrar dúvida de design que muda o plano, pergunta à sessão que escreveu o plano (no Claude Code, por `SendMessage`), em vez de decidir sozinha ou alterar o plano.
- Arquivo do plano: quando salvo, fica dentro do worktree e da branch da própria sessão, nunca numa pasta compartilhada entre sessões.

#### Maestro no Codex

- Esta seção adapta para Codex o maestro do [Claude Code Super Power](https://github.com/johnnyhelder/claude-code-super-power). O plugin e os comandos `/super-power:*` do repositório são exclusivos do Claude Code e não são carregados pelo Codex.
- Use a skill local `$maestro-superpower` para aplicar o fluxo de orquestração e as preferências de modelo no Codex. O modelo preferido para a conversa principal é GPT-6.1 Sol, com esforço médio, alto ou extra high conforme a complexidade; a skill não troca o modelo da sessão.
- A conversa principal atua como maestro: define o escopo, toma as decisões, coordena subagentes, integra o trabalho e faz a verificação final.
- Para trabalho grande, use subagentes sucessivos com os papéis e modelos Codex da tabela acima, na sequência análise → implementação → revisão independente quando fizer sentido. Aguarde uma etapa terminar antes de iniciar a próxima.
- Faça diretamente tarefas pequenas (um arquivo, uma busca, um comando ou uma edição curta). Ao delegar, forneça apenas o contexto necessário e peça uma conclusão objetiva; não delegue decisões nem a comunicação final com o usuário.

#### Regras de Monitoramento, Merge e CI (Antigravity)

- **Ordem Numérica Rigorosa de #PR (NUNCA fure a ordem):** Siga sempre e rigorosamente a ordem crescente de numeração das #PRs (ex.: #166 antes de #167, #168, etc.). **NUNCA faça o merge de uma #PR sem antes ter feito o das anteriores de numeração menor**, mesmo que a PR de numeração maior já esteja com checks verdes ou não possua checks. PRs de numeração maior devem aguardar na fila até que todas as PRs anteriores tenham sido aprovadas e mescladas.
- **Merge estritamente sequencial (NUNCA ao mesmo tempo):** Nunca efetue o merge de mais de um PR simultaneamente ou em sequência imediata. Havendo múltiplos PRs aprovados, mescle rigorosamente **um por vez**, sempre respeitando a ordem numérica.
- **Aguarde o ciclo completo na `main` antes do próximo merge:** Após mesclar um PR (`gh pr merge <numero> --merge`), capture o commit gerado (`mergeCommit`) e aguarde **100% da CI disparada na `main`** (`verify 3.12`, `verify 3.14` e `ui-browser`) concluir verde com sucesso antes de efetuar o merge de qualquer outro PR. Isso impede cancelamento de jobs, divergência de commits e erros na `origin/main`.
- **`git pull` obrigatório a cada #PR:** Assim que a CI na `main` do commit de merge for concluída com sucesso, execute imediatamente `git checkout main && git pull` no repositório local. Sincronize a `main` após **cada #PR**, e não apenas ao final de tudo.

### Git

- Autorização para commit não autoriza push. Confirme destino e autorização e informe claramente se houve commit, push e sincronização com o remoto.
- Depois de abrir ou atualizar um PR, verifique sempre a CI e informe o resultado (aprovada, falhou ou pendente). Se não for possível ler a CI (por exemplo, `gh` sem login), diga isso explicitamente em vez de supor que passou.
- Revise o que vai para o commit; não reescreva histórico nem inclua dados operacionais ou confidenciais.
- Identifique branches e worktrees reais antes de integrar trabalho. Não use `reset --hard`, `git clean` ou force push sem autorização.
- Cada agente (Claude Code, Codex e Cursor) trabalha no próprio git worktree e não troca o branch do checkout principal. Antes de cada commit, confira o branch atual com `git branch --show-current`.
- Ao remover um worktree com junction de `node_modules`, apague o junction com `cmd /c rmdir node_modules` antes de `git worktree remove`, para não apagar o `node_modules` do checkout principal.

## Playwright MCP

- O Playwright MCP é um servidor MCP que deixa o Claude Code controlar um navegador e devolver o código Playwright de cada ação, para virar teste depois.
- Config em `.mcp.json` (servidor `playwright`, `@playwright/mcp@0.0.85`): Chrome instalado, perfil em memória (`--isolated`), headless, `--allowed-origins` só na porta 8765 (`127.0.0.1` e `localhost`) e saídas sem nome explícito em `.claude/prints/mcp` (um `filename` informado é resolvido a partir da raiz do worktree). Em `.claude/settings.json`, `enabledMcpjsonServers` habilita o servidor e `permissions.deny` bloqueia `mcp__playwright__browser_run_code_unsafe` (executa JS arbitrário) e `mcp__playwright__browser_file_upload` (enviaria arquivos de `data/` à página).
- O servidor só carrega em sessão nova do Claude Code (reiniciar a sessão depois de mudar `.mcp.json` ou `settings.json`).
- Como usar: suba o `ui-fixture` e peça "use a skill playwright-teste" (fluxo em `.claude/skills/playwright-teste`).
- LGPD: aponte só para a fixture em `127.0.0.1:8765`, nunca para o app real; os snapshots do navegador vão ao modelo e poderiam levar dado pessoal.
