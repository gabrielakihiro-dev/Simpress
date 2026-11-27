# 20. Saúde local (Prontidão da base)

Aprovado pelo usuário em 26/11/2026. Contrato da API em `docs/arquitetura/CONTRATOS_API_BACKEND.md` (seção "Saúde local"); ferramenta do Assistente em `docs/cockpit-prompts/15-assistente.md`; configuração das contas em `docs/cockpit-prompts/19-configuracao-local.md`.

## Objetivo

Mostrar, num só lugar, o espaço usado pelo Simpress neste computador, a situação dos arquivos de estado e os temporários que podem ser limpos com segurança. Tudo é local: nada sai do computador sem o usuário baixar o pacote de diagnóstico.

## Onde fica

- Item fixo **Saúde local** no painel **Prontidão da base**, com o botão **Abrir** (`aria-label` `Abrir saúde local`). O item não tem selo de estado (nem "Em dia", nem "Pendente"); `/api/prontidao` não muda.
- Código: `frontend/src/paineis/saude-local/` (React), item em `frontend/src/paineis/indicadores-home/estado.ts`, rotas em `routers/saude_local.py`, regras em `domains/saude_local.py`, limpeza em `core/limpeza_temporarios.py` (o CLI `scripts/cleanup_local_temps.py` usa a mesma lógica).
- Diálogo `modal-saude-local` em `frontend/partials/modais.html`, no molde de `modal-configuracao-local`.

## Textos da tela (exatos)

- Cabeçalho: kicker `Prontidão da base`; título `Saúde local`; subtítulo `Espaço usado, arquivos de estado e limpeza de temporários deste computador. Nada sai daqui sem você baixar.`; botão de fechar `Fechar saúde local (Esc)`; rodapé `Fechar`.
- Disco: `<x> livres` e `de <y> no disco da pasta data`, com selo `Folga` ou `Pouco espaço` (menos de 10% livre).
- Áreas (tabela no computador, cartões abaixo de 768 px): `Backups das planilhas`, `Logs`, `Lotes processados`, `Pacotes locais`, `Quarentena` (com a linha `temporários em quarentena e cópias de arquivo corrompido`).
- Arquivos de estado, situações: `Íntegro`, `Inválido`, `Vazio`, `Ilegível`, `Grande demais para validar`. Linhas extras: `Outros arquivos` e `Cópias de arquivo corrompido`.
- Transações: `Limpo` ou `Pendente`.
- Limpeza: botão `Ver prévia`; selo `Prévia — nada foi alterado`; botões `Remover` e `Mover para a quarentena` (são as ações de cada item); botão `Limpar temporários` (só habilitado com itens na prévia).
- Confirmação (alertdialog): título `Limpar temporários?`; botões `Cancelar` (foco inicial) e `Limpar agora`.
- Resultado: `Limpeza concluída.` com os números reais. Sem itens: `Nenhum temporário para limpar.`
- Recusas (mensagem do 409 e, abaixo, uma segunda linha por código): ver a tabela de recusas.
- Erros: `Não foi possível ler a saúde local.` e `Não foi possível gerar o pacote de diagnóstico.`
- Pacote de diagnóstico: botão `Baixar pacote de diagnóstico`; listas `Vai no pacote` e `Nunca vai`.

## Limpeza: o que remove, o que quarentena e o que nunca toca

A prévia é sempre a primeira etapa. Ela não grava nada (pode criar um arquivo `.lock` vazio, por isso é um POST). A aplicação refaz a análise do zero e não usa token: vale o que estiver no disco no momento do clique.

| Ação | O que atinge | Regra |
|---|---|---|
| `remover` | Temporários idênticos a um arquivo já gravado (cópia duplicada) | Só com mais de 24 horas |
| `quarentena` | Cópias diferentes do arquivo gravado | Com mais de 7 dias; vai para uma pasta `.temp-quarantine` (nada é apagado de imediato) |

Áreas varridas: `data/planilhas_entrada`, `data/state` e os modelos. Na varredura, links e junções são ignorados e cada candidato precisa ficar dentro da própria raiz da área.

Nunca toca:

- as planilhas e modelos válidos, os históricos e as anotações;
- o conteúdo dos arquivos de estado (`data/state/*.json` são só lidos para a Saúde local, e a limpeza não os altera);
- a pasta `.transactions` e as transações pendentes: a limpeza nunca recupera transação (com entrada pendente, recusa);
- os arquivos `.atomic-transactions`;
- os logs, os backups de planilha e os lotes processados (são só medidos);
- o `config/`, exceto a leitura de caminhos.

Os itens da prévia mostram o caminho relativo à raiz da área, com CPF mascarado. A aplicação devolve a lista real do que foi feito.

## Recusas (409) e códigos

A limpeza não roda quando há risco de conflito. A mensagem é exata; a segunda linha orienta.

| Código | Mensagem exata | Segunda linha |
|---|---|---|
| `chrome` | `Limpeza recusada: uma automação está usando o Chrome.` | `Espere a automação terminar e tente de novo.` |
| `importacao` | `Limpeza recusada: há uma importação em andamento.` | `Espere a importação terminar e tente de novo.` |
| `transacoes` | `Limpeza recusada: há transações pendentes.` | `Reinicie o servidor local para recuperar as gravações interrompidas.` |
| `migracao` | `Limpeza recusada: há uma migração de dados em andamento.` | `Espere a migração terminar e tente de novo.` |
| `limpeza_em_andamento` | `Limpeza recusada: outra limpeza já está em andamento.` | `Aguarde e veja a prévia de novo.` |

- Aplicar sem `confirmado: true` devolve 422 e nada muda.
- Erro de sistema de arquivos inesperado devolve 503.
- Os códigos que checam importação olham as pastas `processando/` das três entradas (automática de inventário, automática de chamado e a entrada de planilhas); a migração olha as pastas `.upload-staging-*`.

## Pacote de diagnóstico

`GET /api/saude-local/diagnostico` baixa um arquivo `diagnostico-simpress-AAAAMMDD-HHMMSS.json`. Ele é montado em memória e não fica gravado no servidor.

- Vai no pacote: versão do Simpress, do Python e do sistema (`platform.system()` e `release`); situação de cada fonte da Prontidão (só o estado, e `available`/`state` das funções); tamanho e quantidade por área, espaço livre; situação dos arquivos de estado e tipo de erro (nome da classe); situação das transações (limpo/pendente e quantidade).
- Nunca vai: nomes, e-mails, CPF, telefones; séries, hostnames, chamados; conteúdo de planilha, JSON ou log; caminhos de pasta e nome do usuário do Windows; senhas e chaves; a prévia e os itens da limpeza; os textos de motivo (`reason`), `missing_files` e `configuracao_local`.

## Assistente (F9)

A ferramenta `obter_saude_local` é só leitura: devolve o `GET /api/saude-local`. Nunca chama a prévia nem a limpeza. Regras no doc 15.

## Tela pequena

- A partir de 768 px: tabelas (`TabelaNl`) com as áreas, os arquivos de estado e a prévia.
- Abaixo de 768 px: os mesmos dados em cartões (ponto de virada do componente `TabelaNl`); abaixo de 640 px, as colunas duplas e o bloco do disco ficam empilhados. Sem rolagem horizontal da página.
- Faixa de 320 px a 2560 px, claro e escuro, tokens `nl-base` (`--nl-raio-cartao` 24, `--nl-raio-tabela` 16, `--nl-raio-controle` 12).
- Movimento (contrato `docs/ui-motion/contrato-bento.md`): véu de 220 ms, linhas e selos de 200 ms, barras de 700 ms; só com `prefers-reduced-motion: no-preference`.

## Foco e teclado

- Ao abrir, o foco vai ao título. Ao fechar, volta ao botão **Abrir**.
- `Esc` fecha o diálogo; se a confirmação estiver aberta, `Esc` fecha só a confirmação.
- O diálogo de confirmação tem foco inicial em `Cancelar`.

## Termos aprovados

Se qualquer texto acima mudar, propague para a interface, a validação e os testes (`tests/test_local_temp_cleanup.py` e os testes de front de Saúde local).
</content>
