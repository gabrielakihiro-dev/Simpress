# Manual do usuário — Simpress

Este manual é para quem **usa** o Simpress no dia a dia. Não é preciso saber programar. Cada tarefa traz os passos, o que você deve ver na tela e como confirmar que deu certo.

O Simpress é um site que roda **somente no seu computador** (Windows). Os dados ficam em arquivos na pasta do projeto; nada é enviado para a nuvem.

## Sumário

1. [Instalar](#1-instalar)
2. [Iniciar o sistema](#2-iniciar-o-sistema)
3. [Conhecer a tela](#3-conhecer-a-tela)
4. [Atualizar a base EquipamentosDetalhes](#4-atualizar-a-base-equipamentosdetalhes)
5. [Comparar os inventários](#5-comparar-os-inventários)
6. [Gerar uma transferência](#6-gerar-uma-transferência)
7. [Importar OS (tela ou pasta `entrada_chamados`)](#7-importar-os-tela-ou-pasta-entrada_chamados)
8. [Restaurar um backup](#8-restaurar-um-backup)
9. [Os 5 erros mais comuns](#9-os-5-erros-mais-comuns)

---

## 1. Instalar

**O que você precisa**

- Windows 10 ou superior.
- Python 3.12 ou superior instalado (baixe em python.org; na instalação, marque **Add Python to PATH**).
- Internet apenas na **primeira** execução, para baixar as dependências.
- Acesso ao repositório privado do projeto no GitHub.

**Passos**

1. Abra o PowerShell, vá à pasta onde quer guardar o projeto e rode:

   ```powershell
   git clone https://github.com/gabrielakihiro-dev/Simpress.git
   cd Simpress
   ```

2. Não é preciso instalar mais nada à mão: o `iniciar_servidor.bat` prepara tudo na primeira vez (veja a seção 2).

**Como confirmar:** existe uma pasta `Simpress` com o arquivo `iniciar_servidor.bat` dentro.

**Arquivos que você precisa fornecer** (não vêm no repositório, por conterem dados reais):

| Arquivo | Onde fica | Para quê |
| --- | --- | --- |
| Inventário Simpress (`EquipamentosDetalhes`) | enviado pela tela (seção 4) | Busca, transferência, exportação |
| Inventário do Endpoint (`InvAllComputersSummary`) | enviado pela tela (seção 4) | Hostname e comparação |
| `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` | `data/planilhas_entrada` (já vem no projeto) | Gerar transferência |
| `EquipamentosDetalhes-exportacao.xlsx` | pasta `modelos` | Botão **Exportar Excel** |

Sem algum desses arquivos o sistema abre normalmente; só as funções que dependem dele ficam indisponíveis.

## 2. Iniciar o sistema

1. Na pasta do projeto, dê dois cliques em **`iniciar_servidor.bat`** (ou, no PowerShell, `.\iniciar_servidor.bat`).
2. Na **primeira vez**, aguarde: o programa cria o ambiente (`.venv`) e baixa as dependências. Pode levar alguns minutos.
3. Se aparecer **"Há uma versão nova (v1.1.0). Atualizar agora? (S/N)"** (com o número da versão nova), leia logo acima o resumo do que mudou e digite `S` e Enter para atualizar, ou `N` para continuar com a versão atual. Só aparecem versões publicadas e testadas; mudanças ainda em teste não são oferecidas. A atualização é opcional e não mexe nos seus dados (`data/`). Se o sistema não puder atualizar (sem internet, alterações locais, nenhuma versão publicada, etc.), ele mostra o motivo e abre normalmente com a versão atual; se avisar que as dependências mudaram, aguarde a reinstalação. O histórico de versões fica no arquivo `CHANGELOG.md`, na pasta do projeto.
4. Quando o terminal mostrar a linha **`Site: http://127.0.0.1:8000`**, abra esse endereço no navegador. Se a porta 8000 estiver ocupada, o iniciador usa outra (entre 8001 e 8099) e mostra o endereço correto no terminal — use o que aparecer lá.
5. **Deixe a janela preta (terminal) aberta** enquanto usa o sistema. Para encerrar, volte a ela e pressione `Ctrl+C`.

**Como confirmar:** a página do Simpress carrega no navegador. Se o Simpress já estava aberto, o iniciador apenas abre a instância existente, sem iniciar uma segunda cópia.

**Primeiro acesso:** a base começa vazia, com a mensagem **Base ainda não importada**. Isso é esperado; siga a seção 4.

## 3. Conhecer a tela

Menu lateral:

- **Home** — pesquisa de equipamentos.
- **Transporte** — formulário de retirada e entrega (geração da planilha de transferência).
- **Nova transferência** — limpa o formulário para começar outra.
- **Ferramentas:** **Chamados**, **Atualizar planilhas**, **Exportar Excel** e, em **Históricos e Análises**, **Histórico planilhas**, **Evolução das atualizações**, **Histórico de alterações** e **Catálogo de unidades**.

Para pesquisar: na **Home**, digite série, apelido/hostname, modelo, cidade ou nome do usuário e pressione `Enter` (ou clique em **Buscar Equipamento**). A lista rápida mostra até 15 resultados; **Mostrar mais** abre a pesquisa completa, com filtros de categoria (**Notebooks**, **MacBooks**, **Monitores**, **Fones**) e cidade.

## 4. Atualizar a base EquipamentosDetalhes

A base oficial de equipamentos é o `EquipamentosDetalhes` mais recente que você receber. Ela fica salva em `data/planilhas_entrada/EquipamentosDetalhes_atual.xlsx`. Cada atualização **substitui** a base anterior (não soma linhas de versões antigas), e o sistema guarda um backup automático do que estava ativo.

**Por que o ZIP:** a exportação do UX Simpress costuma vir como um arquivo `.zip` com uma única planilha `.xlsx` dentro. Você pode enviar o ZIP direto; o sistema lê a planilha interna e a grava como `EquipamentosDetalhes_atual.xlsx`. Não é preciso extrair à mão.

**Passos pela tela (recomendado)**

1. Tenha em mãos os dois arquivos: o `.xlsx` do **Endpoint** (`InvAllComputersSummary`) e o `.xlsx` ou `.zip` da **Simpress** (`EquipamentosDetalhes`, exportação completa de 50 colunas).
2. Clique em **Atualizar planilhas** no menu lateral.
3. Em **1. Endpoint**, clique em **Escolher arquivo** e selecione o `.xlsx` do Endpoint.
4. Em **2. Simpress**, clique em **Escolher arquivo** e selecione o ZIP (ou `.xlsx`) da Simpress.
5. Clique em **Pré-visualizar impacto**. Confira as contagens de séries novas, removidas e duplicadas. A prévia vale por 10 minutos; se passar disso ou os arquivos mudarem, refaça.
6. Se estiver certo, clique em **Confirmar substituição**.

Sempre envie **os dois** arquivos, mesmo na primeira vez. Cada arquivo pode ter até 60 MB.

**Como confirmar que deu certo**

- A tela de resultado da comparação abre (veja a seção 5).
- O contador de equipamentos no cabeçalho reflete o novo total.
- Em **Histórico planilhas** aparece uma nova atualização com a data de agora.
- Pesquise na **Home** uma série que só existe no arquivo novo e confirme que ela aparece.

**Se a base não bater com o esperado:** o total vem sempre do `EquipamentosDetalhes` enviado — o `InvAll` (Endpoint) não acrescenta equipamentos à base. Séries vazias ou duplicadas aparecem sinalizadas no resultado.

**Alternativa por pasta:** com o servidor ligado, é possível colocar o par de arquivos em `data/state/entrada_automatica/pendentes/<nome-do-lote>/` (subpastas `endpoint` e `simpress`, um `.xlsx` em cada). Em cerca de 20 segundos o sistema processa o lote e o move para `processadas` (ou para `falhas`, com o motivo em `_resultado.json`). Use um nome de lote novo a cada vez. Para a maioria dos casos, a tela é mais simples.

## 5. Comparar os inventários

A comparação acontece **automaticamente** a cada atualização (seção 4). Para rever uma comparação antiga, abra **Histórico planilhas** (em **Históricos e Análises**).

O resultado traz, entre outras seções:

- **Linhas mantidas para conferência**;
- **Sem acesso há 7 dias ou mais** (notebooks do Endpoint sem verificação com êxito);
- **Equipamentos sem correspondência por fonte**, separados em **Endpoint** e **Simpress**;
- **Localidade divergente**;
- **Duplicidades e correspondências ambíguas**;
- **Séries sem local definido**.

**Como ler**

- "No Endpoint" e "na Simpress" indicam em qual fonte a informação foi encontrada ou falta.
- Cada linha tem um campo de **anotação** (até 2.000 caracteres). Ele salva sozinho e é incluído nas exportações. Use-o para registrar o que já foi verificado.
- Notebooks próprios do Sebrae e hostnames de Curitiba já são tratados pelo sistema e não aparecem como erro; você não precisa fazer nada.

**Exportar o resultado:** use o botão de exportar no resultado da comparação, ou, em **Histórico planilhas**, escolha a data no seletor *Selecionar a data do histórico para exportar* e clique no botão de exportação. A confirmação exata é **Planilha Exportada com Sucesso!**.

**Comparar duas atualizações:** **Evolução das atualizações** (em **Históricos e Análises**) mostra o que é novo, contínuo e resolvido entre uma atualização anterior e outra.

**Exportar Excel** (menu lateral) é outra coisa: baixa o modelo de exportação com `Apelido` e `IdCliente` atualizados. Se ele só conseguir exportar parte das séries, a notificação diz o motivo.

## 6. Gerar uma transferência

1. Na **Home**, pesquise o equipamento e selecione-o. Confira os dados do cartão (modelo, série, localidade).
2. Abra manualmente a aba **Transporte** no menu lateral.
3. Revise **origem** (retirada) e **destino** (entrega): CNPJ, endereço e contatos. O **Catálogo de unidades** ajuda a preencher.
4. Preencha todos os campos obrigatórios: série; CNPJ e endereço de retirada e entrega; nome, e-mail e telefone do contato de retirada; observações da retirada; nome, e-mail e telefone do destinatário; horário, almoço e observações da entrega (e a duração da pausa, se o escritório fechar para o almoço). Botões como **+ Substituição** inserem observações prontas.
5. Clique em **Gerar Planilha** no rodapé. O arquivo é baixado pelo navegador.
6. Abra a planilha baixada e confira os dados antes de encaminhá-la.

**Como confirmar:** o navegador baixa um `.xlsx` e aparece a confirmação **Planilha Exportada com Sucesso!**. As planilhas já geradas ficam listadas em **Transferências geradas** (botão na própria aba **Transporte**).

Se **Gerar Planilha** não funcionar, confira se o modelo `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` está em `data/planilhas_entrada` e se a base foi atualizada (seção 4).

**Textos prontos para chamados:** na **Home**, depois de pesquisar o equipamento, o botão de textos para chamados manuais mostra modelos editáveis. Use **Copiar** para levar o texto ao chamado.

## 7. Importar OS (tela ou pasta `entrada_chamados`)

Esta rotina relaciona o Excel **Acompanhamento de Pedidos** (Simpress) com o Excel **Gestão de Solicitações** (Oracle) pelo número de série. Há dois caminhos: o **formulário na tela** (mais simples para uso manual) e a **pasta local** (usada na rotina automatizada de OS). Os dois chegam ao mesmo histórico.

### Opção A — pela tela

1. Abra **Chamados** (aba superior, atalho `F5`), clique em **Importar e gerenciar** e, no bloco **Importação e versões** que se abre na própria tela, use os dois campos de arquivo.
2. Em **Simpress · Acompanhamento de Pedidos**, clique em **Escolher arquivo** e selecione o `.xlsx` (ou ZIP com uma única planilha `.xlsx`).
3. Em **Oracle · Gestão de Solicitações**, clique em **Escolher arquivo** e selecione o `.xlsx`.
4. Clique em **Importar planilhas** (até 60 MB por arquivo).

**Como confirmar:** aparecem a mensagem "Planilhas importadas. As OS foram relacionadas pela série." e o aviso "Acompanhamento de chamados atualizado."; o bloco se fecha, a tabela de OS passa a mostrar a nova versão e o seletor de versões, as fontes importadas e os botões **Exportar Excel** e **Excluir importações antigas** ficam no mesmo bloco. Se faltar um dos arquivos, a tela pede "Selecione as duas planilhas para importar."

### Opção B — pela pasta local

1. Exporte as duas planilhas (UX Simpress, contrato 16467, e Oracle) e guarde-as em um lugar conhecido. Se uma exportação for bloqueada pelo site, não tente contornar: peça ao responsável.
2. Abra a pasta `data/state/entrada_chamados`.
3. **Copie** a pasta `modelo_lote` para dentro de `pendentes` e renomeie a cópia com um nome **único**, por exemplo `2026-10-10_os-simpress`.
4. Coloque **um** arquivo `.xlsx` em cada subpasta:
   - `simpress` → Acompanhamento de Pedidos;
   - `oracle` → Gestão de Solicitações.

   Resultado esperado:

   ```text
   data/state/entrada_chamados/pendentes/2026-10-10_os-simpress/
   ├── simpress/Acompanhamento_de_pedidos.xlsx
   └── oracle/Gestao_de_Solicitacoes.xlsx
   ```

5. Com o Simpress ligado, aguarde cerca de 20 segundos. O sistema confere os arquivos duas vezes, importa e move o lote inteiro para `processadas`.
6. Se o Simpress estiver desligado, rode uma vez na pasta do projeto:

   ```powershell
   .\.venv\Scripts\python.exe scripts\process_ticket_inbox.py
   ```

**Como confirmar**

- O lote sumiu de `pendentes` e apareceu em `data/state/entrada_chamados/processadas/<nome-do-lote>/`.
- O arquivo `_resultado.json` desse lote contém `"status": "concluido"`.
- Em **Chamados**, o bloco **Importação e versões** passa a listar uma nova versão. Séries com OS diferentes entre as duas fontes ficam marcadas para conferência.

**Se der errado:** o lote vai para `falhas`, com o motivo em `_resultado.json`. Nada é apagado. Corrija a causa e crie um lote com **outro nome**; um lote já registrado não é importado de novo.

Cada subpasta precisa ter exatamente um `.xlsx` (até 60 MB). Os arquivos de origem não são alterados.

## 8. Restaurar um backup

Antes de cada atualização (seção 4) o sistema guarda uma cópia dos dois inventários que estavam ativos, em `data/planilhas_entrada/_backups/`. Os backups são guardados por **60 dias**.

**Passos**

1. Abra **Histórico planilhas** (em **Históricos e Análises**).
2. Localize a atualização que você quer desfazer. Só aparece o botão **Restaurar versão anterior** quando existe backup completo e válido dos dois inventários.
3. Clique em **Restaurar versão anterior**. Abre a janela **Restaurar inventários?** com nomes, datas e contagens dos arquivos que serão trocados.
4. Leia e, se estiver certo, clique em **Restaurar**. (Em caso de dúvida, cancele; nada muda.)

**Como confirmar**

- O histórico ganha um novo registro da restauração.
- O total de equipamentos volta ao valor anterior.
- O botão da restauração passa a mostrar **Desfazer restauração**, que reverte o procedimento.

**Cuidados**

- A restauração também guarda o conjunto que estava ativo, por isso é possível desfazê-la.
- Não apague a pasta `.transactions`: ela guarda recuperações pendentes.
- Backups ficam só neste computador. Faça uma cópia externa de `data/` se precisar de proteção contra perda da máquina ou depois dos 60 dias.
- Se não houver botão de restaurar, o backup está ausente ou inválido. Não copie arquivos à mão por cima da base sem pedir ajuda.

## 9. Os 5 erros mais comuns

### 1. O `iniciar_servidor.bat` diz que não encontrou Python 3.12 ou superior

- **Causa:** Python ausente ou antigo, ou sem **Add Python to PATH**.
- **Solução:** instale Python 3.12+ marcando **Add Python to PATH** e rode o `.bat` de novo.
- **Verificação:** a janela mostra `Site: http://127.0.0.1:...`.

### 2. A página não abre, ou abre outra porta

- **Causa:** a janela do terminal foi fechada, ou a porta 8000 já estava ocupada.
- **Solução:** rode o `.bat` novamente e use o endereço exato que aparece no terminal. Mantenha o terminal aberto.
- **Verificação:** o site responde no endereço do terminal.

### 3. Aparece "Base ainda não importada", a busca não acha nada ou mostra dados antigos

- **Causa:** a base ainda não foi enviada, ou um arquivo foi trocado à mão na pasta.
- **Solução:** faça a seção 4 pela tela **Atualizar planilhas**. Se você substituiu arquivos manualmente em `data/planilhas_entrada`, **reinicie o servidor** (Ctrl+C e rode o `.bat`).
- **Verificação:** o contador do cabeçalho mostra o total esperado e a série buscada aparece.

### 4. A planilha é recusada ao atualizar ("arquivo inválido", cabeçalhos ausentes, aba ambígua)

- **Causa:** arquivo corrompido, acima de 60 MB, com cabeçalhos fora do padrão, com mais de uma aba compatível, ou ZIP com mais de uma planilha, com senha ou vazio.
- **Solução:** use a exportação completa original (Simpress com 50 colunas; Endpoint com nome do computador e número de série). Deixe só a aba correta no arquivo e o ZIP com exatamente um `.xlsx`.
- **Verificação:** **Pré-visualizar impacto** mostra as contagens em vez de erro.

### 5. "Arquivo em uso" / "ocupado", ou "Falha interna do servidor"

- **Causa (em uso):** a planilha está aberta no Excel ou sendo sincronizada pelo OneDrive.
- **Solução:** feche o arquivo no Excel, aguarde a sincronização e tente de novo. Nada foi alterado.
- **Causa (falha interna):** erro inesperado do sistema.
- **Solução:** abra `data/logs/simpress.log` e envie as últimas linhas a quem mantém o sistema. O log não guarda o conteúdo das planilhas.
- **Verificação:** a ação é concluída na segunda tentativa.

Outros problemas e detalhes técnicos: veja a tabela **Solução de problemas** no [README](../../README.md) e o [Primeiro acesso](PRIMEIRO_ACESSO.md).

---

## Regras para lembrar

- Os dados em `data/` e `modelos/` são **locais e confidenciais**. Não os envie por e-mail nem os coloque no Git.
- Sempre confirme as contagens na **pré-visualização** antes de **Confirmar substituição**.
- Para rotinas que dependem de outro site (UX Simpress, Oracle, Endpoint Central), faça login você mesmo; se algum bloqueio impedir a exportação, avise o responsável em vez de insistir.
