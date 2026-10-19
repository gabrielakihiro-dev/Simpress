# Relatório mensal automático

Objetivo: guardar, uma vez por mês e sem ação do usuário, o relatório mensal do contrato (ver `relatorio-mensal.md`) do mês que acabou de fechar.

## Como funciona

- Roda dentro do próprio servidor local (worker iniciado no `lifespan` de `main.py`). Não usa o Agendador de Tarefas do Windows nem serviços externos.
- 30 s depois que o servidor sobe (tempo para as importações automáticas da inicialização), e depois a cada hora, o servidor verifica se existe `data/relatorios_mensais/Relatorio-mensal-AAAA-MM.xlsx` do **mês anterior** ao dia atual.
- Se o arquivo não existir, gera o relatório com o mesmo conteúdo do botão `Relatório mensal` (`GET /api/relatorio-mensal?mes=AAAA-MM`) e o grava pelo fluxo transacional de `core/integrity.py` (`AtomicFileTransaction`, com validação do XLSX antes da troca).
- Se o arquivo já existir, nada é feito: um relatório salvo nunca é substituído. Assim cada mês é gerado uma única vez, mesmo com o servidor reiniciado várias vezes ou ligado durante a virada do mês.
- Só o mês anterior é gerado; meses mais antigos sem arquivo não são preenchidos retroativamente (o inventário reflete a base atual, então um relatório retroativo não seria uma fotografia daquele mês).

## Quando adia

A geração fica para a próxima verificação (sem gravar nada) quando:

- a base oficial `EquipamentosDetalhes` não está carregada;
- o histórico de chamados está ilegível;
- o servidor está em modo somente leitura por um journal de transação divergente;
- o arquivo está bloqueado por outro processo ou a gravação falha (aviso no log, arquivos preservados).

## Arquivos

- Pasta: `data/relatorios_mensais/` (fora do Git, por conter dados operacionais).
- Nome: `Relatorio-mensal-AAAA-MM.xlsx`, igual ao do download manual.
- Para gerar de novo um mês, apague o arquivo dele: a próxima verificação (até 1 h, ou ao reiniciar) cria outro.
- O log registra `Relatório mensal de AAAA-MM gerado automaticamente em <arquivo>.`

## Critérios de aceite

1. Com o servidor iniciado em 19/10/2026 e a base carregada, `Relatorio-mensal-2026-09.xlsx` é criado uma vez; reinícios seguintes não o alteram.
2. Em 01/11/2026 é criado `Relatorio-mensal-2026-10.xlsx`, mantendo o de setembro.
3. Sem a base oficial, nada é gravado e a geração acontece quando a base for carregada.
4. Janeiro gera o relatório de dezembro do ano anterior.
5. `npm run verify` passa; nenhum relatório gerado entra no Git.
