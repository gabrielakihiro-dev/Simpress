# Consulta compacta das execuções da Automação

## Comportamento aprovado para implementação

- Preservar os registros existentes e os controles de iniciar/cancelar.
- Últimas execuções: 5 linhas por página por padrão; opções 5, 10 e 20; paginação com total e anterior/próxima. Filtrar o período pela data de início local e, como complemento, por rotina e status. Filtros dentro de uma área recolhível. Filtros recolhidos continuam ativos e são resumidos junto à contagem.
- Andamento: modo ao vivo por padrão, com altura fixa e no máximo 200 linhas visíveis (opções 100, 200 e 500). Consulta de logs anteriores pela data e execução, sem misturar arquivos. Abertura de uma execução pela linha do histórico. Voltar ao vivo por ação explícita; uma atualização de estado nunca troca o log histórico que está sendo consultado.
- Ambos os painéis: recolher conteúdo e ampliar para a área disponível, com restauração e Escape; manter foco e nomes acessíveis, sem bloquear os botões de cancelamento. Apenas um painel ampliado por vez.
- Datas inicial/final inclusivas, validação de período invertido e estado vazio claro. Seleção de uma execução continua disponível mesmo que outra rotina comece.
- Consultas de histórico e logs somente de leitura. O log é identificado por execução conhecida; nomes arbitrários, caminhos relativos e symlinks externos são recusados. Respostas limitadas e sem cache.
- Preservar temas claro/escuro, tabela no desktop, cartões no celular, navegação por teclado e anúncios acessíveis sem reler logs históricos a cada polling.

## Validação

Testar limites, paginação, períodos inclusivos, falhas de consulta, restauração do painel, Escape, foco, seleção histórica durante polling, conteúdo tratado como texto e caminhos rejeitados. Conferir prints antes/depois nos dois temas em desktop e celular. Executar a verificação completa e os testes de interface. Não gerar novas exportações reais para validar consultas e layout.

## Sugestões para evolução

A prioridade indica a ordem recomendada; a complexidade é uma estimativa de implementação. As conclusões vêm da inspeção do código e dos testes locais, não de medições de produção. Estas sugestões não habilitam agendamento nem novas execuções.

1. **Nível operacional — pré-checagem das fontes. Prioridade alta; complexidade média; confiança alta.** Antes da primeira exportação, conferir Chrome, sessões do Oracle/UX/Endpoint, contrato e disponibilidade das pastas. Hoje as fontes são percorridas em sequência em `rodar_rotina_os` e `rodar_rotina_inventarios`; uma sessão expirada na segunda fonte pode interromper um par já iniciado. Mostrar cada requisito como disponível ou exigindo ação humana. O login permanece com o usuário.
2. **Nível de observabilidade — etapa atual e duração. Prioridade alta; complexidade baixa a média; confiança alta.** Gravar eventos estruturados de início/fim por etapa junto ao log textual: login, busca, exportação, preparo, importação e confirmação. Exibir a etapa e o tempo decorrido, distinguindo espera de login de espera do importador. Hoje o painel interpreta frases livres e o histórico só tem a duração total. O resultado esperado é um diagnóstico mais preciso, sem prometer percentuais ou tempos de conclusão que o script não mede.
3. **Nível de rastreabilidade — ID compartilhado da execução. Prioridade alta; complexidade média; confiança alta.** O site e o script devem gravar o mesmo identificador, gerado ao iniciar a execução. Hoje `SAME_RUN_SECONDS` associa os resumos pela rotina e por uma janela de dez segundos em `ChromeAutomationRunner.history`. Um ID comum torna a associação determinística mesmo em falhas rápidas ou execuções próximas e melhora a conferência entre log, lote e captura. Requer compatibilidade com os registros legados, que continuam disponíveis.
4. **Nível de suporte — diagnóstico local por execução. Prioridade média; complexidade média; confiança alta.** Permitir salvar um pacote com resumo, etapas, códigos e recibos da execução selecionada. Remover credenciais, parâmetros sensíveis, usuários e conteúdo operacional do material de diagnóstico. A captura de erro deve ser opcional porque pode conter dados pessoais. Compartilhamento sempre manual, sem enviar arquivos automaticamente.
5. **Nível de recuperação — retomada depois dos downloads. Prioridade média; complexidade alta; confiança média.** Quando os dois arquivos originais já estiverem completos, oferecer retomada explícita do preparo/importação, validando origem, horário, SHA-256 e recibo de idempotência. Os manifestos e `_resultado.json` já fornecem parte dessa evidência. Exige projetar o comportamento de lotes incompletos, falhas e cancelamento. Uma falha ou bloqueio de exportação continua sem repetição automática de cliques.
6. **Nível de autonomia — agendamento assistido. Prioridade posterior; complexidade alta; confiança média.** Somente depois de consolidar pré-checagem, sessões e recuperação. O SSO, o contrato selecionado e eventuais bloqueios de download continuam exigindo supervisão. Se implementado futuramente, deve ter execução única, estado visível, cancelamento e nenhuma tentativa de contornar bloqueios. Não foi configurado neste trabalho.

**Ordem recomendada:** pré-checagem, etapas com duração e ID comum primeiro, diagnóstico local em seguida e retomada segura depois. São melhorias diretamente ligadas às falhas observadas e aproveitam os contratos locais existentes.

## Correções de integridade

Os fixtures de inventário passaram a redirecionar `MANUAL_USERS_FILE` para sua própria raiz temporária. O teste de observabilidade também usa um arquivo sintético independente dos usuários locais. A proteção que impede uma transação de escrever fora da raiz foi preservada. A falha entre processos não se reproduziu nas 15 disputas adicionais; o resultado do processo agora inclui a mensagem do erro, além do código, para tornar uma eventual recorrência diagnosticável. A revalidação exata dos 23 testes anteriores terminou com sucesso, sem desabilitar testes.

O fixture Playwright aceita `SIMPRESS_UI_FIXTURE_PORT` (8765 por padrão), permitindo portas independentes quando há vários worktrees em teste. As capturas antes/depois ficam em `logs/prints-automacao/`, fora do Git. Não houve exportação real adicional nesta alteração de consulta e layout.


## Validação final — 20/10/2026

- Os 23 testes que falharam antes passaram na revalidação exata.
- As 15 disputas adicionais entre processos passaram. O teste de liberação de locks passou dez vezes no OneDrive. Sua aquisição continua limitada a 0,5 s; apenas a espera de conclusão e limpeza da thread do fixture foi ajustada para comportar a latência do Windows sob carga.
- `npm run verify` aprovado no checkout isolado desta alteração: 685 casos Python (um ignorado pela indisponibilidade de criação de symlink no Windows), 215 testes JavaScript, sintaxe, TypeScript, mypy gradual/estrito e busca de credenciais.
- Playwright: 14 cenários da Automação aprovados, nos projetos desktop e mobile; temas claro/escuro, auditoria de acessibilidade, paginação, datas inclusivas/invertidas, estado vazio, recolher/ampliar, Escape/foco, limites do log e resposta histórica atrasada. Os dois cenários de polling foram repetidos após o ajuste que evita reanunciar o mesmo estado.
- Conferência na instância real em `http://127.0.0.1:8000/`: filtro de 20/10 com rotina OS e status Concluído retornou duas execuções, o log de 16:27 abriu corretamente e o retorno ao vivo funcionou. A interface foi deixada compacta, sem filtros aplicados, com cinco execuções por página.
- Os trechos da Automação foram integrados ao checkout principal preservando as demais alterações locais. Os arquivos próprios desta alteração foram comparados com o checkout de verificação. Nenhum commit ou push foi realizado.

Os relatórios ficam em `logs/automacao-historico-20261020/` e os oito prints antes/depois em `logs/prints-automacao/`, fora do Git. A validação integral refere-se ao código deste trabalho no checkout isolado; as alterações de outros trabalhos presentes no principal foram preservadas.
