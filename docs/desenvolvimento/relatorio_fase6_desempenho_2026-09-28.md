# Fase 6 — Medição de desempenho e otimização baseada em evidências

Data da execução: 28/09/2026

## Escopo e integridade

- A captura inicial do Git, antes das alterações desta fase, estava na branch `main`: 26 exclusões staged, 7 arquivos rastreados modificados e 7 arquivos não rastreados. O estado existente foi preservado; `main.py` já aparecia como modificado nessa captura.
- Nenhuma planilha operacional, histórico, cópia de segurança ou arquivo exportado foi alterado. Não houve commit, push, migração ou instalação de dependência.
- A etapa de leitura usou os dois arquivos ativos somente para seleção, leitura e validação em memória. A saída guardou apenas rótulos neutros, dimensões, contagens de células, tamanhos e tempos; valores de células não foram incluídos.
- As etapas de comparação, cache, interface e gravação usaram dados fictícios determinísticos. Os arquivos auxiliares foram mantidos em um diretório temporário exclusivo dentro do projeto e removidos ao final.

## Ambiente

- Windows, build 26200, arquitetura AMD64; 12 processadores lógicos.
- Memória física reportada: 16.855.916.544 bytes. Havia aproximadamente 2,48 GB disponíveis no momento da captura.
- CPython 3.14.7 64-bit; openpyxl 3.1.5, pandas 3.0.6, NumPy 2.5.3, FastAPI 0.141.1, Starlette 1.7.0 e Uvicorn 0.54.0.
- Não foram instalados pacotes para a medição.

## Método

Cada etapa separou a primeira observação, executou um aquecimento e coletou 20 repetições. Os tempos usam `perf_counter_ns`, relógio monotônico; a tabela apresenta mediana, p95 e intervalo das repetições. A primeira observação não representa uma leitura fria garantida: o cache do sistema operacional não foi limpo.

O pico do working set do processo foi amostrado a cada 5 ms durante as repetições. O pico do alocador Python foi coletado em uma operação adicional com `tracemalloc`; portanto, essa memória é uma medida separada do tempo. Para a interface, a API do navegador expôs o heap JavaScript, mas não o RSS do processo.

### Entradas

Na leitura dos arquivos ativos, `entrada_A` tinha 228.321 bytes compactados, 2.385.740 bytes descompactados e dimensão 1.365 × 50; `entrada_B` tinha 50.347 bytes compactados, 520.493 bytes descompactados e dimensão 681 × 11.

As demais etapas usaram fixtures sintéticas com semente `20260928`: 1.364 registros de detalhes (1.365 × 50), 680 registros de endpoint (681 × 11) e um modelo de exportação com 1.364 registros (1.365 × 17). Os tamanhos compactados foram, respectivamente, 284.177, 44.487 e 127.249 bytes. O modelo sintético foi cerca de 31% maior em bytes compactados que o modelo ativo inspecionado; os fixtures de detalhes ficaram cerca de 24% maiores, e o fixture de endpoint cerca de 12% menor. Assim, as medições sintéticas aproximam a escala, mas não reproduzem exatamente a compressibilidade de cada arquivo ativo.

## Resultados

| Etapa | Primeira observação | Mediana | p95 | Intervalo das 20 repetições |
|---|---:|---:|---:|---:|
| 1. Selecionar, ler e validar os dois arquivos ativos | 310,4 ms | 318,7 ms | 353,6 ms | 314,8–370,2 ms |
| 2. Comparar os dois arquivos sintéticos | 69,8 ms | 71,6 ms | 85,0 ms | 68,8–111,0 ms |
| 3. Recarregar cache — antes da otimização | 832,3 ms | 823,6 ms | 887,8 ms | 812,5–887,9 ms |
| 3. Recarregar cache — depois da otimização | 774,4 ms | 788,3 ms | 853,9 ms | 761,9–874,2 ms |
| 4. Renderizar o modal da interface, 2.124 linhas | 121,1 ms | 220,5 ms | 276,2 ms | 162,4–510,6 ms |
| 5. Gravar e validar a cópia sintética do Excel | 430,3 ms | 432,2 ms | 477,7 ms | 393,9–495,5 ms |

O pico adicional de working set foi 5,7 MiB na etapa 1, 3,0 MiB na etapa 2, 10,6 MiB antes e 10,0 MiB depois na etapa 3, e 35,6 MiB na etapa 5. Os picos adicionais de alocação Python foram 4,2 MiB, 4,8 MiB, 6,9 MiB antes e depois na etapa 3, e 18,3 MiB na etapa 5. Na etapa 4, o heap JavaScript cresceu 2,5 MiB; o RSS não estava disponível.

Na comparação sintética, o resultado contou 764 registros ausentes no endpoint, 80 ausentes em detalhes e 680 séries sem mapeamento; não houve divergência de local ou ambiguidade. Esse é o estágio puro de comparação: ele não executa a rota de atualização que publica o total carregado ou as mudanças de apelido. Para exercitar a tabela da interface, o fixture visual acrescentou 600 alterações fictícias de apelido, totalizando 2.124 linhas renderizadas.

## Gargalo e otimização aplicada

A análise com `cProfile` apontou duas leituras do endpoint durante `load_database`: a carga do cache já criava o índice para associar os equipamentos; em seguida, a contagem de alterações de apelido relia a mesma planilha ao montar os apelidos de exportação. O perfil foi usado para localizar chamadas, não para cronometrar, pois sua instrumentação aumenta o tempo absoluto.

`get_export_aliases` e `count_export_alias_changes` agora aceitam o índice já carregado. A recarga passa esse índice à contagem; chamadas existentes que não passam o parâmetro continuam lendo os arquivos como antes. Com os mesmos fixtures e protocolo, a mediana da etapa caiu de 823,6 ms para 788,3 ms (35,3 ms, ou 4,3%); o p95 caiu 33,9 ms (3,8%). O pico de working set ficou 0,6 MiB menor, enquanto o pico de alocação Python permaneceu praticamente igual.

## Validação e limites

- A suíte existente `tests/run_tests.py` executou 29 testes com fixtures; todos passaram. O executor bloqueia leitura de planilhas operacionais durante a importação dos testes.
- A etapa de exportação reabriu o arquivo sintético e confirmou a célula autorizada, fórmula, estilo, nome da aba e dimensões; o validador de round-trip também passou.
- A etapa visual mediu a abertura do modal, cálculo de layout e um frame. As respostas de API foram simuladas localmente e imediatas; quatro chamadas mock foram observadas, sem tentativas de escrita. Os recursos CDN foram removidos para isolar a renderização local. O resultado não mede espera de rede, execução do servidor real, fontes externas nem pintura visual completa; por isso a etapa é parcial.
- A primeira observação pode ter sido afetada por cache do sistema operacional. Um arquivo de entrada também emitiu um aviso de ausência de estilo padrão durante a leitura, mas a validação terminou.

## Recomendação de arquitetura

Manter FastAPI, arquivos Excel e cache em memória para o volume observado. A comparação ficou abaixo de 100 ms na mediana, a recarga do cache ficou abaixo de 0,8 s após remover a leitura duplicada e a gravação validada do modelo ficou em aproximadamente 0,43 s. Essas medições não mostram pressão que justifique trocar o armazenamento atual por banco de dados. A interface merece uma medição visual completa se a lista renderizada crescer, porque este ensaio isolou DOM e layout e não cobriu rede nem pintura final.
