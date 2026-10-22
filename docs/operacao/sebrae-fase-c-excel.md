# Fase C — Excel Online (levantamento e implementação)

Parte da rotina **Sincronizar chamados Sebrae** (`docs/operacao/sincronizar-chamados-sebrae.md`). Esta fase entrega a camada que lê a coluna C e grava os chamados na aba `CHAMADOS` do Dashboard Operacional_SEBRAE pela **interface do Excel Online** (Chrome de automação, CDP 9333), sem API, Graph nem tokens.

## Situação

| Item | Estado |
| --- | --- |
| Regras de gravação (`AdaptadorExcel`), diário, validações, testes com grade falsa | Implementado e testado em memória |
| Implementação Playwright (`ExcelOnlinePlaywright`) | Escrita, **nunca executada contra o Excel real**: seletores e a leitura da coluna C são hipóteses |
| Levantamento com o Excel autenticado | **Pendente — precisa de sessão assistida com o usuário** (roteiro abaixo) |

**Conclusão provisória sobre a leitura da coluna C:** é viável *se* as verificações V1 a V4 passarem. O desenho não confia em suposições: toda leitura é rejeitada quando o número de linhas copiadas é menor que a última linha usada (Ctrl+End). Se V1 ou V3 falharem, a rotina **não grava** (risco de duplicidade) e a decisão volta ao usuário (por exemplo, integração oficial autorizada pela TI). Nada disso foi executado no Excel real nesta fase.

## Como a leitura funciona (hipótese a validar)

1. Caixa de Nome → `A1`, `Ctrl+End` → última linha usada `N` (lida da Caixa de Nome).
2. Caixa de Nome → `C1:C{N}`, `Ctrl+C`, leitura da área de transferência (`navigator.clipboard.readText`, permissão concedida pelo CDP). Um texto sentinela é colocado antes, para detectar cópia que não chegou.
3. O texto (colunas por tabulação, células com quebra entre aspas) vira `{linha: valor}`. Linhas copiadas = linhas do texto.
4. **Invariante de completude:** `linhas copiadas >= N`. Com filtro ativo o Excel copia só as linhas visíveis, então a contagem fica menor e a leitura é rejeitada.
5. Nesse caso (e só nesse), abre uma **exibição de folha temporária** (Exibir → Exibições de Folha → Nova), que não mexe no filtro compartilhado, copia de novo e **sai da exibição no `finally`**. Se não conseguir sair, levanta `FiltroNaoRestauradoErro` e a rotina para.
6. Números `UTIC-AAAA-NNNN` saem de `domains.sebrae_chamados.numeros_do_dashboard` (valores compostos como `27371 / UTIC-2026-0094` incluídos).

Linhas ocultas manualmente são copiadas junto com a seleção; só as linhas filtradas ficam de fora. O invariante cobre os dois casos.

## Linha preparada e disponível

- Ponto de partida: a linha seguinte à **última com qualquer valor** na coluna C (o histórico antigo nunca é preenchido nem reaproveitado).
- Candidata, até `LIMITE_BUSCA_LINHAS` (40) abaixo: C, F, G, I, N, P e Q vazias e sem fórmula, linha não oculta, e **fórmula presente em cada coluna de `colunas_formula`**. Quais são essas colunas só se sabe com o Dashboard aberto (V5); o parâmetro é obrigatório no construtor.
- A leitura que escolhe a linha é a última antes da primeira escrita. Antes de **cada** célula, ela é lida de novo: se alguém a ocupou, a gravação para como `parcial` e nada é sobrescrito.

## Digitação sem autoformatação

- Caixa de Nome → célula (a seleção é conferida: se o endereço não bate, nada é digitado), `F2`, `keyboard.insert_text` (sem teclas), `Delete` (remove a sugestão de preenchimento automático) e `Enter`.
- Textos que começam com `=`, `+`, `-`, `@` ou que parecem número/data (`00123`, `12/05`) recebem o apóstrofo de texto; a releitura aceita a célula com ou sem o apóstrofo exibido.
- **Q** não recebe prefixo: `dd/MM/yyyy HH:mm` precisa virar data/hora. A releitura compara datas (`21/10/2026 09:15:00` equivale a `21/10/2026 09:15`). Se a célula ficar como texto (locale do Excel diferente) é preciso detectar em V6.
- Quebras de linha da descrição (F): preservadas com `Alt+Enter`. Se V7 falhar, use `quebras_como_espaco=True`.

## Gravação, releitura e diário

Ordem de `gravar_chamado(linha)`:

1. Valida as sete colunas (formato, `Sebrae`, `PR`, data, tamanho).
2. `garantir_sessao`: login Microsoft/SharePoint ou aviso de sessão expirada → `sessao_expirada` (pendência de login; nunca "concluído"); confere o título do arquivo e a aba `CHAMADOS`.
3. Se o diário tem uma intenção aberta para o número, relê o Dashboard e **retoma** (ver abaixo).
4. Relê a coluna C inteira; número presente → `duplicado`, nada é gravado.
5. Escolhe a linha, registra a intenção no diário e escreve **C primeiro**, depois F, G, I, N, P, Q; cada célula é conferida vazia antes e relida depois.
6. Relê as sete colunas e compara com o extraído → `divergente` se diferir.
7. Espera o indicador **Salvo** estável → `nao_salvo` se não aparecer.
8. Só então `gravado` (`incluido = True`) e o diário fecha a intenção.

Situações: `gravado`, `recuperado`, `duplicado`, `invalido`, `abandonado` (seguem a execução) e `parcial`, `divergente`, `nao_salvo`, `sessao_expirada`, `leitura_incompleta`, `filtro_nao_restaurado`, `sem_linha_preparada`, `interrompido` (`interrompe_execucao = True`: a Fase E para e avisa).

**Diário** (`data/state/sebrae_excel_diario.json`, fora do Git, único escritor, gravação atômica): `intencoes` abertas (número, linha, valores, estado, `confirmados`, `pendentes`, detalhe) e `historico` (últimas 100). Diário ilegível interrompe sem gravar.

**Retomada** (`recuperar_pendencias()` no início da execução, ou o próprio `gravar_chamado` do mesmo número): após queda, cancelamento ou `nao_salvo`, a execução seguinte relê o Dashboard antes de qualquer escrita:

- número na coluna C **na linha da intenção** → compara as sete células; só as **vazias** são completadas; célula com conteúdo diferente → `divergente`, nada é sobrescrito;
- número em **outra** linha → `duplicado`, intenção encerrada;
- número em lugar nenhum → linha vazia: `abandonada`, e o chamado segue o fluxo normal; linha ocupada por outra pessoa: intenção encerrada e linha preservada.

Chamados já na coluna C ficam como duplicados na triagem, por isso a retomada é feita pelo diário e não pela triagem.

## Roteiro assistido (sessão com o Excel real logado)

Executar com o usuário, **numa cópia do Dashboard** (ou na aba `CHAMADOS` fora do horário, sem gravar) e sem alterar o Dashboard real. Registrar o resultado de cada item aqui.

| # | Verificação | Como | Critério |
| --- | --- | --- | --- |
| V0 | Estrutura da página | Abrir o Dashboard no Chrome de automação; inspecionar iframe da grade (`WacFrame_Excel_*`), Caixa de Nome, barra de fórmulas, abas, indicador "Salvo", título da aba | Confirmar/ajustar `Seletores`, `arquivo_esperado` e o idioma (pt-BR/en-US) |
| V1 | Cópia e leitura da área de transferência | `Ctrl+End`, `C1:C{N}`, `Ctrl+C`; ler `navigator.clipboard.readText()`; testar também o botão Copiar da faixa | Texto com `N` linhas; se `Ctrl+C` por CDP não copiar, descobrir qual gesto funciona. **Se nenhum funcionar: PARAR** |
| V2 | Tabela ou área pré-formatada | Conferir se a aba é Tabela do Excel ou tem linhas com fórmulas até certo ponto; quais colunas têm fórmula (`colunas_formula`) | Linhas livres abaixo dos dados já trazem as fórmulas (senão a regra "linha preparada" precisa de decisão) |
| V3 | Filtro ativo | Com um filtro aplicado, repetir V1 | Contagem menor que `N` (comprova que o invariante detecta linhas filtradas) |
| V4 | Exibição temporária | Exibir → Exibições de Folha → Nova; copiar; Sair; Excluir | Todas as linhas aparecem, o filtro compartilhado não muda, e o fluxo de saída é confiável. Se não for: PARAR e decidir (ex.: usuário remove o filtro, ou integração oficial) |
| V5 | Linha livre | Procurar a primeira linha com C vazia; ler a barra de fórmulas das colunas de fórmula | Fórmula começa com `=`; lista de colunas definida; linha filtrada/oculta é detectável |
| V6 | Digitação e Q | Em uma linha de teste: `F2` + `insert_text` + `Delete` + `Enter` para texto, `=X`, `00123`, `PR` (com autocompletar) e `21/10/2026 09:15` | Valor igual ao enviado; Q vira data/hora (formato de número da célula = data); descobrir como `celula_e_data` lê isso |
| V7 | Quebra de linha | Descrição com 3 linhas via `Alt+Enter` | A barra mostra `\n`; senão usar `quebras_como_espaco` |
| V8 | Indicador Salvo | Gravar uma célula e observar "Salvando…" → "Salvo" | Texto/seletor do indicador; tempo típico |
| V9 | Sessão expirada | Observar a tela de login e o aviso de sessão expirada | URL/texto que `url_de_login` e `texto_de_sessao_expirada` precisam reconhecer |
| V10 | Edição simultânea | Segundo usuário/abas editando a mesma linha | Presença de diálogos de conflito/"alguém está editando" |

## O que a Fase E precisa ligar

- Abrir o Dashboard em aba nova (URL do SharePoint), esperar login (`aguardar_login` com `url_de_login`), criar `ExcelOnlinePlaywright(page, colunas_formula=…)`.
- Início da execução: `recuperar_pendencias()` (pare se `interrompe_execucao`); depois `ler_numeros_coluna_c()` para a triagem.
- Por chamado incluir: `gravar_chamado(decisao.linha)`; contar incluídos por `resultado.incluido`; `login_necessario` → `ResumoExecucao.login_necessario`; `interrompe_execucao` → parar e registrar `detalhe`, `confirmados` e `pendentes`.
- Cancelamento (`RotinaCancelada`) só entre chamados; ele não é engolido pelo adaptador.

## Riscos conhecidos

- A leitura por área de transferência e a exibição temporária são hipóteses (V1, V4); sem elas a rotina para em vez de arriscar duplicidade.
- Linhas ocultas por filtro **abaixo** dos dados não são detectadas pelo adaptador Playwright (`LinhaLida.oculta` é sempre `False`); o V5 define como detectá-las.
- Duplicidade criada por outra pessoa nos segundos entre a releitura da coluna C e a gravação não é detectável pela interface; a janela é curta e a releitura final não a cobre.
- Seletores e idioma do Excel Online mudam sem aviso; a falha esperada é parar com `interrompido`/`leitura_incompleta`, nunca gravar.
