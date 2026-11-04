# Formato do relatório HTML

A revisão de arquitetura vira um único arquivo HTML autocontido, gravado **fora do repositório**. Tailwind e Mermaid vêm por CDN. O Mermaid cuida de diagramas em forma de grafo; divs e SVG inline cuidam dos visuais mais editoriais (diagramas de massa, cortes transversais). Misture os dois: se tudo for Mermaid, o relatório fica genérico.

## Onde gravar

- Pasta temporária do sistema: `$env:TEMP` (PowerShell) ou `%TEMP%`. Grave em `<TEMP>\revisao-arquitetura-<AAAAMMDD-HHMMSS>.html`, para cada execução ter um arquivo novo.
- A pasta `TEMP/` da raiz do projeto está dentro do workspace e não serve: nada deste relatório entra no repositório.
- Abra com `Start-Process <caminho>` e informe o caminho absoluto completo.

## Estrutura

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Revisão de arquitetura do Simpress</title>
    <script src="https://cdn.tailwindcss.com/3.4.17"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict" });
    </script>
    <style>
      /* camada pequena para o que o Tailwind não cobre bem: linhas tracejadas de seam etc. */
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidatos" class="space-y-10">...</section>
      <section id="recomendacao-principal">...</section>
    </main>
  </body>
</html>
```

Texto vindo de arquivos do repositório entra no HTML escapado (`&lt;`, `&gt;`, `&amp;`): é dado, nunca marcação.

## Cabeçalho

Nome do repositório, data e uma legenda compacta: caixa sólida = módulo, linha tracejada = seam, seta vermelha = vazamento, caixa grossa e escura = módulo profundo. Sem parágrafo de introdução: vá direto aos candidatos.

## Cartão de candidato

Os diagramas carregam o peso. A prosa é esparsa, simples e usa os termos de `VOCABULARIO-DESIGN.md` sem cerimônia. Cada candidato é um `<article>`:

- **Título**: curto, nomeia o aprofundamento (por exemplo, "Reunir o pipeline de importação de inventário").
- **Selos**: força da recomendação (`Forte` em verde, `Vale explorar` em âmbar, `Especulativo` em cinza) e a categoria de dependência (`em processo`, `substituível local`, `ports & adapters`, `mock`).
- **Arquivos**: lista monoespaçada (`font-mono text-sm`) com caminhos reais do Simpress.
- **Diagrama antes / depois**: o centro do cartão, em duas colunas lado a lado (padrões abaixo).
- **Problema**: uma frase. O que dói.
- **Solução**: uma frase. O que muda.
- **Ganhos**: marcadores de até 6 palavras, nomeando o ganho em termos do vocabulário: "localidade: bugs se concentram num módulo", "alavancagem: uma interface, N chamadores", "interface encolhe; implementação absorve os wrappers". "Mais fácil de manter" e "código mais limpo" não nomeiam ganho algum.
- **Aviso de ADR ou refatoração** (se couber): uma linha em caixa âmbar, por exemplo "contradiz o ADR 0007, mas vale reabrir porque...". Só mostre quando o atrito justificar reabrir; não liste toda refatoração teórica que um ADR proíbe.

Se o diagrama precisa de um parágrafo para ser entendido, redesenhe o diagrama.

## Padrões de diagrama

Escolha o que serve ao candidato e varie: a variedade faz parte do ponto.

- **Grafo Mermaid** (dependências e fluxo de chamadas): `flowchart` ou `graph` quando o ponto é "X chama Y chama Z, e olhe a bagunça". Envolva num cartão estilizado com Tailwind; use `classDef` para pintar de vermelho as arestas de vazamento e de escuro o módulo profundo. Diagramas de sequência servem para "antes: 6 idas e vindas; depois: 1".

```html
<div class="rounded-lg border border-slate-200 bg-white p-4">
  <pre class="mermaid">
    flowchart LR
      A[router] --> B[domains/modulo_a]
      B --> C[core/integrity]
      C -.vazamento.-> D[scripts/sebrae_softexpert]
      classDef leak stroke:#dc2626,stroke-width:2px;
      class C,D leak
  </pre>
</div>
```

- **Caixas e setas feitas à mão** (quando o layout do Mermaid atrapalha): módulos como `<div>` com borda e rótulo; setas como `<line>` ou `<path>` em SVG inline sobre um contêiner relativo. Ideal para o "depois" como um módulo profundo de borda grossa com os internos em cinza.
- **Corte transversal** (camadas rasas): faixas horizontais (`h-12 border-l-4`) mostrando as camadas por onde a chamada passa. Antes: 6 camadas finas que não fazem nada. Depois: 1 faixa grossa com a responsabilidade consolidada.
- **Diagrama de massa** ("interface tão larga quanto a implementação"): dois retângulos por módulo, um para a superfície da interface e outro para a implementação. Antes: quase da mesma altura (raso). Depois: interface curta, implementação alta (profundo).
- **Colapso do grafo de chamadas**: antes, uma árvore de chamadas em caixas aninhadas; depois, a mesma árvore dentro de uma só caixa, com as chamadas agora internas esmaecidas.

## Estilo

- Editorial, não painel corporativo. Bastante espaço em branco; serifa opcional nos títulos (`font-serif` combina com stone/slate).
- Cor com parcimônia: um destaque (verde ou índigo), vermelho para vazamento, âmbar para avisos.
- Diagramas com cerca de 320 px de altura, para o antes/depois caber lado a lado sem rolagem.
- Rótulos de módulo em `text-xs uppercase tracking-wider`, para parecerem esquema e não interface.
- Os únicos scripts são o CDN do Tailwind e o import ESM do Mermaid. No resto, o relatório é estático.
- Em tela estreita, as duas colunas do antes/depois empilham (`grid-cols-1 md:grid-cols-2`).

## Recomendação principal

Um cartão maior: nome do candidato, uma frase sobre o porquê e um link de âncora para o cartão. Nada além disso.

## Tom

Português simples e conciso, com os substantivos e verbos de arquitetura vindos de `VOCABULARIO-DESIGN.md`: módulo, interface, implementação, profundidade, profundo, raso, seam, adapter, alavancagem, localidade. Quando quiser dizer módulo, interface ou seam, use esse termo e não componente, serviço, unidade, API, assinatura, fronteira, camada ou wrapper.

Frases que servem: "O módulo de importação é raso: a interface quase iguala a implementação."; "A regra de preço vaza pelo seam."; "Aprofundar: uma interface, um lugar para testar."; "Dois adapters justificam o seam: HTTP em produção, memória nos testes."

Vá direto ao ponto. Se uma frase pode ser marcador, vire marcador; se um marcador pode sair, saia.

Adaptado de mattpocock/skills (MIT, © 2026 Matt Pocock).
