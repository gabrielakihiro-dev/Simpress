# Vocabulário de design

Projete **módulos profundos**: muito comportamento atrás de uma interface pequena, posto num seam limpo e testável por essa interface. Use estes termos exatamente; o termo em inglês entre parênteses é o guia quando a tradução soar ambígua. Não troque por "componente", "serviço", "API" nem "fronteira": a consistência da linguagem é o ponto.

## Glossário

- **Módulo** (*module*): qualquer coisa com interface e implementação. Independe de escala: função, classe, pacote ou fatia que atravessa camadas. Evite: unidade, componente, serviço.
- **Interface** (*interface*): tudo que o chamador precisa saber para usar o módulo corretamente: a assinatura de tipos, mas também invariantes, ordem de chamadas, modos de erro, configuração exigida e características de desempenho. Evite: API, assinatura (estreitos demais).
- **Implementação** (*implementation*): o que há dentro do módulo, seu corpo de código. Difere de **adapter**: um adapter pequeno pode ter implementação grande (um repositório SQL) e um adapter grande pode ter implementação pequena (um *fake* em memória). Diga "adapter" quando o assunto for o seam; "implementação" nos demais casos.
- **Profundidade** (*depth*): alavancagem na interface, isto é, quanto comportamento um chamador (ou teste) exercita por unidade de interface que precisa aprender. Módulo **profundo** (*deep*): muito comportamento atrás de interface pequena. Módulo **raso** (*shallow*): interface quase tão complexa quanto a implementação.
- **Seam** (*seam*, Michael Feathers): ponto em que dá para mudar o comportamento sem editar ali; o *lugar* onde a interface do módulo mora. Onde pôr o seam é uma decisão própria, distinta do que fica atrás dele. Evite: fronteira (sobrecarregada pelo *bounded context* do DDD).
- **Adapter** (*adapter*): coisa concreta que satisfaz uma interface num seam. Descreve o *papel* (que vaga preenche), não a substância (o que tem dentro).
- **Alavancagem** (*leverage*): o que os chamadores ganham com a profundidade. Mais capacidade por unidade de interface aprendida; uma implementação rende em N chamadores e M testes.
- **Localidade** (*locality*): o que os mantenedores ganham com a profundidade. Mudança, bugs, conhecimento e verificação se concentram num só lugar em vez de se espalhar pelos chamadores. Corrige-se uma vez, corrige-se em todos.

## Profundo contra raso

Módulo **profundo**: interface pequena (poucos métodos, parâmetros simples) e implementação grande que esconde a complexidade. Módulo **raso** (evite): interface grande e implementação fina que só repassa chamadas.

Ao desenhar uma interface, pergunte: dá para reduzir o número de métodos? Dá para simplificar os parâmetros? Dá para esconder mais complexidade lá dentro?

## Princípios

- **Profundidade é propriedade da interface, não da implementação.** Um módulo profundo pode ser composto internamente por partes pequenas, substituíveis e simuláveis; elas só não fazem parte da interface. O módulo pode ter **seams internos** (privados à implementação, usados pelos próprios testes) além do **seam externo** na interface.
- **Teste de remoção** (*deletion test*). Imagine apagar o módulo. Se a complexidade some, ele era só repasse. Se a complexidade reaparece espalhada por N chamadores, ele se pagava.
- **A interface é a superfície de teste.** Chamadores e testes cruzam o mesmo seam. Se você quer testar *além* da interface, o módulo provavelmente tem a forma errada.
- **Um adapter é um seam hipotético; dois adapters são um seam real.** Só introduza seam quando algo realmente varia através dele.

## Projetar para testabilidade

1. **Receba dependências, não as crie.** Testável: `processar_pedido(pedido, gateway)`. Difícil de testar: `processar_pedido(pedido)` que instancia o gateway por dentro.
2. **Devolva resultados, não produza efeitos colaterais.** Testável: `calcular_desconto(carrinho) -> Desconto`. Difícil de testar: `aplicar_desconto(carrinho) -> None` que altera o total.
3. **Superfície pequena.** Menos métodos pedem menos testes; menos parâmetros simplificam a montagem do teste.

## Relações

- Um **módulo** tem exatamente uma **interface**.
- **Profundidade** é propriedade do **módulo**, medida contra a sua **interface**.
- O **seam** é onde a **interface** do **módulo** mora; um **adapter** fica no **seam** e satisfaz a **interface**.
- **Profundidade** produz **alavancagem** para os chamadores e **localidade** para os mantenedores.

## Enquadramentos rejeitados

- **Profundidade como razão entre linhas de implementação e de interface** (Ousterhout): premia encher a implementação. Aqui, profundidade é alavancagem.
- **"Interface" como a palavra-chave `interface` do TypeScript ou os métodos públicos de uma classe**: estreito demais; a interface inclui todo fato que o chamador precisa conhecer.
- **"Fronteira"**: sobrecarregada pelo *bounded context* do DDD. Diga **seam** ou **interface**.

## Explorar interfaces alternativas

Para desenhar a interface de um módulo aprofundado, peça a subagentes sucessivos (um de cada vez, conforme o `AGENTS.md`) que projetem a interface de formas radicalmente diferentes e compare por profundidade, localidade e posição do seam ("design it twice").

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
