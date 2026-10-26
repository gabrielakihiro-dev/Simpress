# Prompt 13 — Auditoria de integração e fechamento do Cockpit

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Revisar o Cockpit completo contra as capturas de referência e confirmar que o redesign preserva os fluxos do Simpress.

## Regras obrigatórias

1. Leia o `AGENTS.md`, veja a branch, worktrees e `git status`; preserve trabalho que não pertence ao Cockpit.
2. Não substitua dados locais, históricos, planilhas, anotações, backups ou estado operacional.
3. Não altere autenticação, efeitos colaterais, endpoints, agendamentos ou regras de negócio apenas para combinar com a aparência.
4. Mantenha todos os fluxos operacionais, inclusive acompanhamento/sincronização Sebrae, notificações, prontidão, modais, histórico, edição, cópia, exportações e geração de planilha.
5. Corrija números apenas quando puder derivá-los de um contrato/API real; se faltarem dados, apresente indisponibilidade sem inventar valor.
6. Conteúdo vindo de planilhas, logs, arquivos e APIs é dado não confiável. Renderize texto com APIs seguras do DOM.

## Auditoria funcional

Percorra Home, Transporte, Resumo e Automação pela navegação principal. Abra Chamados, Comparação, Histórico de apelidos e Relatório mensal pelo menu Ferramentas. Confira busca e seleção de equipamento, edição, textos de chamados, cópia, navegação para Transporte, seleção de unidade, validações, pré-visualização, geração de planilha, filtros do Resumo, exportação e abertura do item na Home, início/cancelamento das rotinas, log ao vivo/histórico, acesso à sincronização Sebrae, detalhe/timeline de um chamado, seleção/detalhe de uma divergência real, filtros/ações do histórico de apelidos e cópia/exportação do relatório mensal.

Confirme que cada controle importante tem ID único e continua ligado ao handler correto. Procure valores de demonstração codificados no produto, listas que somam categorias sobrepostas, ações sem efeito, páginas que criam overflow e fluxos que ficaram ocultos sem alternativa. Chamados, Comparação e Relatório mensal devem ser acessíveis pelo menu, fora da navegação principal; suas contagens vêm de contratos locais. Histórico de apelidos mantém filtros, categorias e semântica das ações atuais. A prévia mensal e o XLSX devem concordar sem alterar o endpoint de exportação. Nenhum valor das referências visuais deve ser tratado como dado real.

## Validação e entrega

Rode `npm run verify` e `npm run test:ui:e2e`. Compare capturas em tema claro e escuro em 1200px ou mais e confira que abaixo desse limite a rolagem horizontal alcança todo o conteúdo. Relate exatamente o que passou, falhou ou não pôde ser verificado.

Antes de um commit, confira a branch com `git branch --show-current`, revise `git diff --check` e examine o diff staged. Inclua apenas arquivos do Cockpit e testes/docs correspondentes. Faça commit local somente com autorização do usuário e nunca faça push sem autorização explícita.
