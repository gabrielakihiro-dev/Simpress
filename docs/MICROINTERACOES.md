# Microinterações da interface

Implementadas em 08/10/2026, em JavaScript puro, sem dependências adicionais.

## Organização

- `static/ui-motion.js`: API reutilizável de animação, cancelamento, carregamento e validação.
- `static/ui-motion.css`: tokens de duração/easing, feedback de controles e skeletons.
- `static/app.js`: integração com os fluxos reais e manutenção do gerenciamento de foco dos modais.

| Interação | Comportamento |
| --- | --- |
| Home ↔ Transporte | Entrada com deslocamento de 8 px e fade em 220 ms. A troca de estado é imediata. |
| Modais | Entrada em 220 ms; fechamento em 180 ms. O fechamento desabilita a interação imediatamente. |
| Drawers | Preset horizontal de 24 px, ativado por `data-motion="drawer"` no overlay. A aplicação atual usa modais; nenhum novo drawer foi acrescentado ao produto. |
| Botões | Pressão de 1 px e transições explícitas em 160 ms. Botões desabilitados não se deslocam. |
| Inputs | Transição de borda e feedback de validação em 160 ms; indicação acessível com `aria-invalid`. |
| Notificações | Entrada em 220 ms e saída em 180 ms, mantendo os anúncios acessíveis. |
| Carregamento | Skeleton na consulta de equipamento, pesquisa completa/paginação e nos dois históricos. Aparece após 150 ms, evitando flashes em respostas rápidas. |

O shimmer usa um ciclo de 1.500 ms para manter o carregamento discreto. Esse ciclo não aumenta o tempo de resposta nem atrasa a exibição de dados. Não há animação individual das linhas de tabelas extensas.

## Exemplos de uso

```js
const motion = window.SimpressMotion;

// Depois de tornar o painel visível, sem esperar pela animação:
motion.reveal(panel, "page");

// Carregamento que não remove resultados já exibidos:
const stopLoading = motion.startLoading(list, "Carregando resultados…", { rows: 3 });
try {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Falha ao carregar resultados.");
  const data = await response.json();
  stopLoading();
  renderResults(data);
} finally {
  stopLoading(); // Idempotente; cobre falhas e cancelamentos.
}
```

No Simpress, use `abrirModalAcessivel` e `fecharModalAcessivel` para abrir e fechar os diálogos: elas cuidam de rótulos, foco inicial, Escape, Tab e retorno de foco, além de chamar o módulo visual. A API de movimento sozinha não substitui esse gerenciamento de acessibilidade.

O módulo cancela a animação anterior do mesmo elemento. Reabrir um overlay durante a saída cancela o fechamento pendente. Um carregamento antigo não remove o skeleton nem o estado ocupado de um carregamento mais recente.

## Performance e acessibilidade

- Animações de entrada, saída e shimmer usam apenas `transform` e `opacity`.
- Não há leituras de geometria, reflow forçado ou JavaScript executado a cada frame no módulo.
- Não há `will-change` permanente. Efeitos e referências das animações são liberados ao terminar ou cancelar.
- As propriedades CSS de transição são explícitas, inclusive nos controles existentes com `transition-all`.
- `prefers-reduced-motion` desativa o movimento e o shimmer. Alterar a preferência durante uma saída também finaliza o fechamento.
- Navegadores sem Web Animations continuam abrindo e fechando os componentes imediatamente.

Essas escolhas favorecem composição fluida e o objetivo de 60 FPS. Não foi realizado profiling com trace de frames/GPU; não se afirma uma taxa fixa em todos os equipamentos.

## Verificação de usabilidade

| Cenário | Resultado |
| --- | --- |
| Troca de abas com clique e seta esquerda | Seleção, painel e foco corretos. |
| Busca real e troca para Transporte | Equipamento e série preservados. |
| Busca vazia | Aviso acessível e foco na pesquisa. |
| Abrir histórico e consultar resultado | Novo modal recebe foco; o histórico anterior fecha. |
| Modal de atualização: Shift+Tab e Escape | Foco permanece dentro do diálogo; ao fechar, retorna ao acionador. |
| Resposta lenta com dados fictícios | Skeleton visível e botão ocupado. |
| HTTP 503 simulado | Mensagem de erro exibida, botão liberado e skeleton removido. |
| Limpar durante a requisição | Campo vazio, botão liberado e carregamento cancelado. |
| Layout de 390 px e 1.366 px | Sem overflow horizontal na página nos estados verificados. |
| Console no aplicativo real | Nenhum erro da aplicação nos fluxos verificados; mensagens de extensão do Chrome foram desconsideradas. |

Os testes no navegador foram verificações técnicas de fluxos; não constituem pesquisa com usuários ou avaliação por leitor de tela. Nenhum inventário, anotação ou cadastro operacional foi modificado pelos testes de interface.

Validação automatizada concluída: **65 testes JavaScript e 139 testes Python, todos aprovados**. Os 12 testes novos de movimento cobrem reabertura rápida, saída única, troca de preferência de movimento, fallback, entradas consecutivas, drawer, skeletons, resultados paginados e validação de campos.

```powershell
node --test tests/*.cjs
.\.venv\Scripts\python.exe tests/run_tests.py
```

Para reproduzir os cenários lentos usando o front-end real com dados fictícios:

```powershell
.\.venv\Scripts\python.exe tests/serve_ui_motion_preview.py
```

Abra `http://127.0.0.1:8765/`. Pesquise `LENTO` para uma resposta de dois segundos ou `FALHA` para simular HTTP 503. O servidor serve somente os assets da interface e respostas GET fictícias; rejeita operações de escrita e não importa o backend operacional.

![Skeleton da consulta com dados fictícios](ui-motion/carregamento-desktop.png)
