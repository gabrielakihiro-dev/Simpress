# Relatório de auditoria e correções do front-end

**Data:** 7 de outubro de 2026
**Escopo:** código de `static/` e interface local em funcionamento. As planilhas operacionais não foram alteradas; não enviei formulários de geração, upload ou gravação de anotações.

## 1. Resumo do estado geral

A interface está organizada em etapas de pesquisa e transferência, com painel de disponibilidade, campos identificados e ações principais acessíveis no DOM. Nas telas verificadas, o estilo segue uma linguagem visual consistente e não houve transbordamento horizontal.

Foram corrigidos riscos de perda de anotações e de descarte acidental do formulário, validação de e-mail, diferenciação de rótulos acessíveis, busca sem acentos e uso excessivo de espaço em telas pequenas. A extração de módulos melhorou alguns pontos de manutenção, mas `static/app.js` continua sendo um arquivo central extenso.

## 2. Pontos fortes

- A navegação principal expõe `tablist`, `tab` e `tabpanel`; os controles do formulário aparecem com nomes associados no DOM.
- O painel local confirmou que as quatro funções declaradas pela aplicação estavam disponíveis durante a inspeção.
- O formulário se reorganizou em uma coluna em 320×740 e 390×844, e em duas colunas em 1440×900. Os botões da barra inferior couberam nas cinco resoluções verificadas.
- Não encontrei inconsistências relevantes de paleta, cartões ou botões nas telas observadas. A interface mantém o tema escuro e diferencia as ações por cor e posição.

## 3. Problemas encontrados, por impacto

### Alto — anotações podiam ficar apenas na memória da página

Antes, o autosave mantinha o texto pendente no estado do componente e encerrava as tentativas sem recuperação após recarregar ou fechar a comparação. Uma falha prolongada podia deixar o usuário sem uma cópia local clara para recuperar.

**Correção:** `static/js/shared/history-annotation-autosave.js:67` instala um aviso de saída enquanto houver gravação pendente; `:84` persiste o rascunho no armazenamento local, tenta recuperá-lo ao reabrir, oferece nova tentativa e evita que respostas antigas substituam texto recente. A ligação com a tela está em `static/app.js:2295`. Também corrigi o caso em que o texto voltava ao valor original enquanto uma requisição estava em andamento.

**Evidência de teste:** `tests/frontend/test_history_annotation_retries.cjs` cobre persistência, aviso antes de sair, recuperação, nova tentativa e resposta obsoleta.

### Alto — “Nova transferência” podia apagar um rascunho sem perguntar

O botão de reset limpava busca, equipamento selecionado e campos preenchidos.

**Correção:** `static/app.js:1934` rastreia alterações e pede confirmação se houver dados ou busca. Cancelar mantém o valor pesquisado. O rastreador isolado está em `static/js/shared/form-draft-guard.js:6`.

**Evidência:** `tests/frontend/test_inventory_ui_flows.cjs` verifica que cancelar a confirmação preserva a busca. Na interface local, a caixa nativa apareceu; o navegador de revisão parou ao tentar fechá-la, então não considero o cancelamento validado ao vivo.

### Médio — formato de e-mail inválido podia avançar até a geração

Os campos tinham tipo de e-mail, mas a validação do front-end verificava somente se estavam vazios.

**Correção:** `static/app.js:1822` consulta a validade nativa, identifica o campo com `aria-invalid`, mostra mensagem, foca e rola até o erro; remove o estado inválido depois da correção. A resposta de erro estruturada do servidor também é convertida em texto legível.

**Evidência:** o harness de `tests/frontend/test_inventory_ui_flows.cjs` simula e-mail inválido e corrigido sem chamar a API.

### Médio — cabeçalho e barra fixa consumiam área útil em telas pequenas

No formulário a 844×390, antes do ajuste, o cabeçalho media 154 px e a barra inferior 62 px. O resumo da base ainda aparecia em telas estreitas por causa de uma regra CSS mais específica.

**Correção:** `static/app.css:423` oculta o resumo em telas móveis; `:482` compacta a paisagem curta, recolhe o status da barra fixa e distribui os controles em quatro colunas. O cabeçalho também deixa de ficar preso ao topo nessa condição.

**Evidência ao vivo:** em 844×390, cabeçalho de 115 px e barra de 62 px; em 390×844, cabeçalho de 129 px e barra de 150 px. Não houve transbordamento horizontal em 320×740, 390×844, 768×1024, 844×390 ou 1440×900.

### Médio — anotações de linhas sem série podiam ter o mesmo nome acessível

O rótulo usava “série vazia” sem diferenciar as linhas.

**Correção:** `static/app.js:2164` inclui o hostname quando a série está vazia, diferenciando esses campos para leitores de tela nos registros com hostname disponível.

### Baixo — busca de unidades dependia de acentos

Uma consulta como “maringa” não correspondia a “Maringá”.

**Correção:** a normalização sem acentos está em `static/js/shared/catalog-search-utils.js:6` e é usada por `static/app.js:3389` para cidade, endereço, CNPJ e CEP.

**Evidência:** `tests/frontend/test_catalog_search_utils.cjs` cobre busca sem acento, campos do catálogo e consulta vazia.

### Manutenção — `app.js` continua concentrando muitas funções

Extraí a busca do catálogo, o rastreador do rascunho e o controlador de autosave para módulos testáveis. As dependências são carregadas em `static/index.html:1387`.

**Limite:** o arquivo principal ainda tem mais de 3 mil linhas e concentra outros fluxos. A modularização é parcial; uma separação completa exige uma refatoração por áreas, preservando os contratos já testados.

## 4. Melhorias recomendadas, em ordem de prioridade

1. Continuar a divisão de `static/app.js` por fluxo — transferência, histórico e gestão de unidades — com testes de regressão por módulo antes de cada extração.
2. Automatizar no navegador os fluxos de formulário e autosave usando fixtures isoladas, para validar integração sem gravar em histórico ou planilhas reais.
3. Executar `npm run build:ui` no CI com as dependências do projeto instaladas; `node_modules` não estava presente neste ambiente.

## 5. O que não foi possível verificar

- Não rodei leitor de tela, auditoria WCAG automatizada ou avaliação completa de contraste; a verificação de acessibilidade se limitou à estrutura, rótulos, estados e comportamento coberto por código/testes.
- Não enviei uma transferência, upload ou anotação à API em funcionamento para evitar alterações em dados operacionais. O autosave foi exercitado com armazenamento e respostas simulados.
- A automação do navegador travou ao fechar uma caixa nativa de confirmação. A confirmação apareceu, mas o cancelamento ao vivo não foi concluído; a preservação do rascunho foi confirmada pelo teste JavaScript.
- O build Tailwind não foi executado porque `node_modules` não existe neste checkout.

## Verificações executadas

- JavaScript: `node --check` nos quatro módulos alterados/criados e **46 testes, 46 aprovados**.
- Python: `tests/run_tests.py` — **130 testes aprovados em 49,6 s**. A primeira tentativa dentro do sandbox parou porque o socket local interno do `asyncio` no Windows foi bloqueado; a suíte completa passou quando executada fora dessa restrição, em ambiente isolado de fixtures.
- Interface local: resolução reportada como disponível nas quatro funções; medidas e transbordamento horizontal conferidos nos cinco tamanhos listados acima.
- `git diff --check`: sem erros.
