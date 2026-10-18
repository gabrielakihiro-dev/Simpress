# Medição do parse de planilhas (achados M3/N7)

Data: 17/10/2026. Escopo: somente medição e recomendação, sem alteração de código de produção. Referência: `docs/arquitetura/auditoria_tecnica_2026-10-17.md` (M3/N7).

## Resumo

- O custo do parse é **linear no número de células** e dominado pelo próprio `openpyxl`: ~0,6 ms por linha de 50 colunas só para iterar (`iter_rows`), sem montar nada.
- Hoje o código monta **um `dict` por linha com as 50 colunas**. Isso custa ~4 MB de memória por mil linhas e ~50% de tempo a mais que a iteração pura.
- No volume real (~1,4 mil linhas) o parse leva ~1 s e +2 MB. **Não há problema de desempenho hoje.** O problema é só o teto: os limites atuais permitem ~200 mil linhas × 50 colunas, que levariam ~3 min e ~0,9 GB.
- Recomendação: **fazer (b) agora** (reduzir limites, mudança de constantes e testes) e **deixar (a) para quando houver necessidade medida**, porque (a) corta ~80% da memória, mas só ~20% do tempo.

## Método

- Planilhas sintéticas geradas por `gen.py` (no scratchpad da sessão, fora do repositório) com `openpyxl` em modo `write_only`: uma aba `EquipamentosDetalhes`, 50 colunas (inclui `NumeroSerie`, `Apelido`, `Modelo`, `Cidade`, `CNPJ Instalacao`, `Tipo` e 44 colunas genéricas com texto, números, datas e vazios), números de série únicos. Nenhum arquivo de `data/` foi lido, copiado ou alterado.
- Cada medição roda **em um processo Python novo** (`run.py`), para que o pico de memória de uma não contamine a outra. O pico é o `PeakWorkingSetSize` do Windows (`GetProcessMemoryInfo`); o tempo é `time.perf_counter()` só em volta da operação (sem o import).
- Cada medição foi repetida 3 vezes (1,4 mil e 10 mil linhas) ou 2 vezes (70 mil e 140 mil); a tabela mostra a mediana. Dados brutos: `b6_resultados_brutos.txt` na pasta de notas compartilhada da sessão.
- Ambiente: Windows 11, Python 3.12.14 da `.venv` do projeto, `openpyxl` 3.1.5, a mesma versão do `requirements.txt`. Os módulos medidos foram importados do próprio repositório (`domains/uploaded_workbooks.py`, `core/xlsx_safety.py`).
- Cenários:
  - `validate`: `validate_xlsx` sozinho (varredura SAX de todas as abas, `core/xlsx_safety.py`).
  - `raw_openpyxl`: piso teórico, `load_workbook(read_only=True)` e `iter_rows` sem montar registros.
  - `upload` (`tables_bytes`): caminho de upload (`read_bytes` + `read_workbook_tables` + `select_upload_table`, que inclui `validate_xlsx`).
  - `arquivo local` (`details_path`): `find_details_sheet` + `read_details_sheet_records`, usado sobre `EquipamentosDetalhes_atual.xlsx` na comparação (lê o cabeçalho de cada aba, depois a aba toda).
  - `protótipo (a)`: uma passada, só as 5 colunas usadas, linhas como tuplas. É um protótipo de medição, não uma implementação.

## Resultados (mediana; pico = memória total do processo, Δ = pico menos ~60 MB do interpretador com os módulos importados)

| Linhas × colunas | Arquivo (ZIP / descompactado) | validate | piso openpyxl | **upload (hoje)** | **arquivo local (hoje)** | protótipo (a) |
|---|---|---|---|---|---|---|
| 1.400 × 50 | 0,4 MB / 3 MB | 0,2 s, Δ0 | 0,7 s, Δ0 | **1,1 s, 62 MB (Δ2)** | **1,3 s, 61 MB (Δ1)** | 0,7 s, Δ0 |
| 10.000 × 50 | 3 MB / 24 MB | 1,2 s, Δ0 | 5,5 s, Δ0 | **6,3 s, 96 MB (Δ36)** | **7,9 s, 93 MB (Δ33)** | 6,7 s, Δ0 |
| 70.000 × 50 | 22 MB / 171 MB | 9,3 s, Δ17 | 45,7 s, Δ3 | **68,7 s, 339 MB (Δ278)** | **78,1 s, 316 MB (Δ256)** | 53,6 s, 91 MB (Δ30) |
| 140.000 × 50 | 43 MB / 345 MB | 20,8 s, Δ37 | 81,3 s, Δ10 | **92,5 s, 621 MB (Δ560)** | **128,5 s, 575 MB (Δ515)** | 72,2 s, 121 MB (Δ60) |

Leitura rápida:

- Tempo: ~0,65 ms/linha no upload e ~0,9 ms/linha no arquivo local (esse caminho abre o arquivo duas vezes, uma para achar a aba e outra para ler). Variação entre repetições de até ~15% (outras sessões usavam a máquina ao mesmo tempo).
- Memória: ~4 MB por mil linhas (≈ 80 bytes por célula em `dict` + valores). Extrapolação linear para o teto atual de 200 mil linhas × 50 colunas (10 M células): **~800 a 900 MB e ~3 a 4 min**, o que confere com o README ("mais de dois minutos e cerca de 900 MB").
- O validador (`validate_xlsx`) é barato: ~10% do tempo do parse e memória quase constante (sem `dict`s).
- Neste conjunto sintético, o limite de 512 MB descompactados só seria atingido perto de ~210 mil linhas; o limite de 10 M células (200 mil linhas × 50 colunas) chega antes. O README fala de ~140 mil linhas para 512 MB com dados reais, que têm texto mais longo que o sintético.

## Opções

### (a) Passada única, materializando só a aba e as colunas usadas

O que muda: ler somente a aba escolhida (hoje `find_details_sheet` e `read_details_sheet_records` abrem o arquivo duas vezes, e `read_workbook_tables` materializa **todas** as abas não vazias) e guardar apenas as colunas consumidas pela comparação (hoje todas as 50).

Ganho medido no protótipo (70 mil / 140 mil linhas):

| | Hoje (upload) | Protótipo | Ganho |
|---|---|---|---|
| Pico de memória | 339 / 621 MB | 91 / 121 MB | **−73% / −80%** (Δ: −89% / −89%) |
| Tempo | 68,7 / 92,5 s | 53,6 / 72,2 s | **−22% / −22%** |

O ganho de tempo é limitado porque o `openpyxl` ainda precisa interpretar as 50 colunas de cada linha (o piso é 45,7 s / 81,3 s). Para reduzir o tempo de forma relevante seria preciso um leitor que pule o XML das colunas não usadas, o que é uma troca de parser e foge do escopo desta medição. Em arquivo único o ganho do caminho local seria maior (evita a segunda abertura: 128 → ~72 s em 140 mil linhas).

Riscos:

- Médio. As colunas "usadas" não estão num único lugar: `_record_value` em `domains/inventory_comparison.py` aceita vários aliases, o Endpoint usa outras colunas, a validação exige `DETAILS_COMPLETE_SOURCE_COLUMN_COUNT == 50` e o CNPJ de instalação, e o `column_count` e `headers` precisam continuar refletindo a planilha inteira. Seria preciso mapear todos os consumidores de `records` (comparação, histórico, exportação, anotações) antes de cortar colunas.
- `__excel_row_number__` e a mensagem de erro por cabeçalho repetido/ambíguo devem permanecer idênticos (contrato de API).
- Exige testes novos de paridade (mesmo resultado de comparação antes e depois) e `npm run verify` completo.
- Esforço: dias, contra minutos de (b).

### (b) Reduzir os limites de `core/config.py` (linhas 42 a 47) ao nível medido

O volume real é ~1,4 mil linhas × 50 colunas (70 mil células, ~1 s, +2 MB). Proposta com folga de cerca de 40 a 50 vezes:

| Constante | Atual | Proposta |
|---|---|---|
| `MAX_XLSX_WORKSHEET_ROWS` | 250.000 | 70.000 |
| `MAX_XLSX_TOTAL_CELLS` (e `MAX_XLSX_TOTAL_MERGED_CELLS`, que a herda) | 10.000.000 | 3.500.000 (70 mil × 50) |
| `MAX_XLSX_UNCOMPRESSED_BYTES` | 512 MB | 192 MB (medido: 171 MB para 70 mil linhas) |
| `MAX_UPLOAD_BYTES` | 60 MB | manter (22 MB para 70 mil linhas) |

Ganho no pior caso admitido: de ~900 MB e 3 a 4 min para **~340 MB e ~70 s** (uma redução de ~60% na memória e ~65% no tempo do pior caso). Nada muda para o uso normal.

Riscos:

- Baixo. Mudança de constantes; as mensagens de erro (HTTP 413) já usam os valores configurados. Os textos que citam "cerca de 140 mil linhas" em `core/xlsx_safety.py` e no README precisam ser atualizados junto, e os testes que dependem dos limites antigos, ajustados.
- Planilhas legítimas maiores que 70 mil linhas passam a ser recusadas. Com 1,4 mil linhas hoje, isso exigiria o cadastro crescer ~50 vezes; o limite pode ser subido de novo por constante.
- O limite de colunas (16.384) não é o gargalo e pode ficar como está. Planilhas largas (mais de 50 colunas) são limitadas pelo teto de células.

## Recomendação

1. **Adotar (b)** em um PR pequeno: reduz o pior caso sem tocar na lógica de leitura nem nos contratos de API.
2. **Adiar (a)** enquanto o volume real ficar abaixo de ~10 mil linhas (parse < 7 s e < 40 MB). Reavaliar se o cadastro passar de ~30 mil linhas ou se o servidor local passar a processar vários uploads em paralelo (`MAX_CONCURRENT_WORKBOOK_PARSERS` é 1).
3. Se (a) for feita, começar pela parte barata e segura: ler **uma só aba** (a escolhida) e abrir o arquivo **uma vez** no caminho local; só depois cortar colunas.

## Limitações

- Dados **sintéticos**: texto curto e uniforme. Planilhas reais têm cadeias mais longas e mais variadas, então a memória real por linha pode ser maior (o README estimou ~140 mil linhas em 512 MB, contra ~210 mil aqui). Use os números como ordem de grandeza e proporção, não como valor absoluto.
- Só foi medido `EquipamentosDetalhes` (50 colunas, uma aba). A planilha do Endpoint (menos colunas, outro layout) e planilhas com várias abas não foram medidas; no upload todas as abas não vazias são materializadas, então o custo cresce com cada aba extra.
- Foram medidos apenas o parse e a validação. Não entram a montagem da comparação em si, a serialização do histórico, o buffer multipart do FastAPI nem a exportação.
- Máquina compartilhada com outras sessões ativas durante a medição (variação de ~15%); poucas repetições (2 a 3). Um único ambiente (Windows 11, Python 3.12.14, `openpyxl` 3.1.5). Não houve perfil de CPU nem `tracemalloc`; o pico é o do processo, que inclui o interpretador e os módulos (~60 MB).
- O protótipo (a) é só de medição: não preserva `__excel_row_number__`, nem as regras de cabeçalho; seu ganho real dependerá da lista final de colunas.
- Nada foi verificado no navegador nem na suíte completa (`npm run verify`), porque não houve alteração de código.
