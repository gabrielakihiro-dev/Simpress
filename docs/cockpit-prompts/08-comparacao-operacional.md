# Prompt 8 — Comparação (painel operacional)

Cole este prompt no agente de código com o repositório Simpress aberto.

## Objetivo

Preencher o painel `Comparação` preparado no Prompt 2 e aberto em `Ferramentas` (`F6`) com o layout da captura: indicadores de inventário no topo, filtros por resultado, tabela de registros à esquerda e detalhe da série selecionada à direita. Comparação não aparece como aba na navegação principal.

## Regras obrigatórias

1. Leia `AGENTS.md`, confira o estado do Git e localize os contratos atuais da comparação e do histórico antes de editar.
2. Use somente comparações já processadas e registradas localmente. Identifique no código qual resposta abastece cada indicador, filtro, coluna e detalhe; reaproveite os endpoints de leitura e os modelos existentes. Não crie uma segunda fonte de verdade nem um endpoint novo para replicar dados disponíveis.
3. Os números, séries, nomes, localidades e percentuais da captura são exemplos visuais. Calcule cada indicador a partir dos dados reais e da regra já usada pelo Simpress; se o campo ou a regra não existirem, mostre `—` ou omita o indicador.
4. Não derive `Iguais` subtraindo divergências do total quando as categorias podem se sobrepor, os registros forem incompletos ou as séries forem ambíguas. Conte séries únicas conforme o contrato existente e mantenha separado o total por fonte de `Sem correspondência`.
5. Aplique as regras oficiais atuais de comparação, incluindo as classificações de séries e localidades definidas em `AGENTS.md`. Não normalize nem regrave os valores brutos das planilhas para produzir a apresentação.
6. Preserve importação e comparação de inventários, histórico, anotações, exportação, restauração e todos os fluxos atuais. O painel é uma nova forma de consultar os mesmos eventos; não remova nem substitua modais existentes.
7. Reaproveite as ações já existentes. `Nova comparação` pode abrir o fluxo local atual de atualização/importação, sem iniciar ou confirmar uma importação automaticamente. `Exportar`, `Abrir na Home` e `Atualizar localidade` só aparecem se tiverem um handler existente, apropriado ao registro selecionado e autorizado pelo fluxo atual. Não simule sucesso nem crie escrita nova.
8. Dados de planilhas e APIs são conteúdo não confiável. Renderize-os com `textContent` ou helpers seguros; preserve IDs, `data-*`, ARIA e contratos de eventos existentes.

## Layout do painel

- Abra o painel `Comparação` pelo item `menuitem` no menu Ferramentas ou pelo atalho `F6`; feche o menu e mova o foco para o título do painel. Não o adicione ao `tablist` principal.
- No topo, mostre KPIs para `Simpress`, `Endpoint Central`, `Iguais` (e percentual), `Divergentes` (local/usuário) e `Sem correspondência`. Inclua percentuais/subtotais apenas quando o denominador e as categorias não se sobrepuserem.
- A barra de filtros oferece `Todos`, `Localidade`, `Usuário`, `Só Simpress` e `Só Endpoint`, com contagens calculadas sobre registros únicos. Se um tipo não existir na resposta, não invente linhas para completar a captura.
- A barra de filtros mostra também o horário real da comparação, `Nova comparação` e `Exportar`. `Nova comparação` abre Automação (`F4`) e não inicia uma rotina; Exportar usa o handler existente.
- A área principal usa tabela/lista à esquerda e detalhe persistente de 380–420px à direita em desktop. As colunas seguem a captura: série, modelo, local de cada fonte, usuário de cada fonte e resultado. Valores ausentes aparecem como `—` ou `Não encontrado`.
- Selecione uma linha por clique ou teclado. O painel lateral mostra a série, o modelo e uma grade de 3 colunas (campo, Simpress, Endpoint Central), com células divergentes destacadas e uma caixa `Ação sugerida`. Destaque diferenças com texto e estado semântico; cor não pode ser o único sinal.
- Mostre a origem e o horário da comparação selecionada. Ao escolher outro evento no histórico, tabela, contagens e detalhe devem se referir ao mesmo `evento_id`; por padrão, use o evento mais recente válido.
- A caixa `Ação sugerida` vem de regra existente. Ações contextuais (Atualizar localidade, Vincular/Atualizar usuário, Marcar sem agente, Contatar usuário, Cadastrar no Simpress) só podem aparecer quando o fluxo/handler atual atender ao caso; não crie endpoints nem simule sucesso. `Abrir na Home` preserva a série selecionada. Atualize a linha para Igual somente após a fonte confirmar sucesso.
- Inclua estados de carregamento, erro, histórico vazio e comparação sem detalhes. Não preencha a tabela com dados estáticos nem confunda uma comparação indisponível com zero divergências.
- Preserve a direção visual Nocturne da captura e a compatibilidade com os temas claro e escuro.

## Responsividade e acessibilidade

- Mantenha `min-width:1200px` no app. Abaixo disso, a página pode rolar horizontalmente para preservar a composição completa; não esconda fontes, filtros ou ações.
- Em desktop, mantenha lista e detalhe lado a lado, com largura de detalhe de 380–420px.
- Dê nome acessível aos filtros e à linha selecionada; preserve foco visível, navegação por teclado e `prefers-reduced-motion`.

## Integração e validação

1. Registre o mapeamento dos contratos locais usados pelos cartões, filtros, tabela, detalhe e ações. Confirme como registros ambíguos e ausências são tratados.
2. Teste comparação existente com divergência de localidade, divergência de usuário, registro presente em apenas uma fonte e registro igual apenas quando cada caso existir nos fixtures ou dados de teste do projeto.
3. Adicione testes para contagens sem sobreposição indevida, filtros, seleção e atualização do detalhe, campos ausentes, histórico vazio e ausência de ações fictícias.
4. Rode `npm run verify` e `npm run test:ui:e2e`. Confira tema claro/escuro em 1200px ou mais e rolagem horizontal acessível abaixo desse limite. Não use os valores da captura como fixture de produto.
5. Revise `git diff --check` e o diff. Faça commit local apenas se autorizado na conversa atual; não faça push sem autorização explícita.

## Relato final

Informe os arquivos alterados, o mapeamento dos dados e ações reaproveitados, indicadores que ficaram disponíveis ou indisponíveis e verificações executadas. Separe fatos confirmados de limitações dos dados atuais.


## Contratos confirmados na revisão

- `equipamentos_sincronizados` informa correspondência entre as fontes, inclusive quando há divergência de local. No painel, rotule esse indicador como **Correspondentes**, sem afirmar igualdade de campos.
- A seleção inicial ignora eventos de restauração e anotações sincronizadas sem comparação. Ao trocar versão, limpe os dados anteriores e bloqueie a exportação até a resposta atual chegar.
- Os registros exclusivos do Endpoint podem trazer o usuário em `usuario`; preserve essa informação na lista e no detalhe.
- A exportação existente agrega as atualizações do dia. O controle deve informar **Exportar comparações do dia** e explicar esse alcance.

## Desvio aprovado pelo usuário (etapa A, item 6)

`#cockpit-comparison-export` mostra `Exportar comparações do dia` (comportamento igual). `#cockpit-comparison-refresh` virou botão só ícone (`#i-refresh`, `aria-label`/`title` `Atualizar histórico`) e é o último da barra.
