# Simpress — Transferência e Inventário de Equipamentos

Aplicação web local para consultar equipamentos, preparar transferências Simpress, comparar inventários e exportar uma planilha de equipamentos atualizada. O servidor usa FastAPI; a interface e os dados operacionais ficam no computador em que o projeto está instalado.

## Recursos

- Interface Cockpit com as abas **Home** (F1), **Transporte** (F2) e **Automação** (F4), o botão **Resumo** (F3, ativos por regional com filtro por categoria e comparação das bases, aberto como painel de ferramenta), mais o menu **Ferramentas** com os painéis de chamados, históricos e relatório mensal, e o chat flutuante do assistente (ícone no topbar).
- Painel **Cobertura** (F10, menu Ferramentas): necessidades de equipamento por data e cidade, séries disponíveis, reservas com kit, movimentações e devoluções, com o Transporte (F2) preenchido para o operador gerar a planilha. Grava só no estado local; o assistente consulta os mesmos números (`listar_cobertura`).
- Busca por número de série, apelido/hostname, modelo, cidade, usuário logado ou nome da pessoa (vindo do Microsoft Entra). A busca completa pode ser filtrada por categoria, cidade e usuário (**Sem usuário**/**Com usuário**); sem resultado, a busca sugere `Você quis dizer <usuário>?`.
- Na Home, **Consultar no Endpoint** lê ao vivo o usuário do último logon do equipamento selecionado, e **Controle remoto** abre a conexão remota do Endpoint Central para ele, sempre por clique do usuário.
- Geração e download da planilha oficial de transferência a partir do modelo local.
- Aba **OS** (F6) com a tabela de ordens de serviço por série (Fonte, Série, OS, Usuário, Hostname, Chamado e Descrição), que relaciona as exportações Simpress e Oracle, marca divergências e permite vincular cada OS a um chamado `UTIC-<ano>-<número>`.
- Usuário logado informado à mão quando o Endpoint não o traz, com pendências de confirmação quando uma nova planilha muda ou remove esse usuário.
- Alertas no painel inicial (base desatualizada, OS paradas, divergências novas) e relatório mensal, gerado também automaticamente no início de cada mês.
- Automação pelo Chrome (`executar_automacao.bat` ou aba **Automação**) para as rotinas de OS (Oracle + UX), inventários (UX + Endpoint Central) e chamados novos do Sebrae (Dashboard + SoftExpert), com a opção **Repetir a cada** (30 minutos, 1h, 1h30 ou 2h) para **Baixar, importar e buscar**.
- Aba **Chamados** (F5) com os chamados novos, antigos em aberto e finalizados do Sebrae: classificação manual, edição local da descrição, cópia atualizada do Dashboard, envio ao SharePoint e finalização individual no SoftExpert, sempre por ação do usuário.
- Importação dos nomes do Microsoft Entra (CSV) para mostrar o nome da pessoa ao lado do login, sem alterar a base oficial de equipamentos.
- Importação automática desse par de planilhas por lotes em pastas locais, com validação, histórico, proteção contra reimportação e recibos de processamento.
- Textos prontos para solicitações de transporte, kit de teclado e mouse e defeitos, com opções para copiar o texto e abrir os links correspondentes.
- Edição de apelidos e de outros campos permitidos do equipamento, com histórico e opção de desfazer alterações de apelido.
- Comparação e atualização conjunta dos inventários Endpoint e Simpress, com histórico, backups locais e prévia de restauração.
- Central de pendências e comparação entre atualizações.
- Exportação de `Apelido` e, quando disponível, `IdCliente` para um modelo Excel local; a mesma planilha é enviada em seguida ao UX Simpress pela rotina `ux_apelidos`, que salva os apelidos/id do contrato 16467.
- Catálogo de unidades, endereços, CNPJ e CEP, incluindo unidades personalizadas.
- Chat flutuante do assistente (ícone no topbar, F9) com IA própria: o servidor local chama o OpenRouter (ou, opcionalmente, o DeepSeek) com a chave do arquivo `.env` (copie `.env.example`); não depende do Jarvis nem de outro processo. Aceita anexos e áudio, guarda conversas, notas e instruções localmente e pode buscar na web quando você liga essa opção. Alterações de dados só rodam depois da sua confirmação. Veja [Assistente (F9)](#assistente-f9).
- Menu **Ferramentas** > **Lembretes**: lembretes com data opcional, gravados só em `data/state/lembretes.json`, e os formulários **Termo Entrega** e **Termo Devolução**, que geram o PDF pelo navegador sem gravar nada no servidor. Veja [Termos](docs/cockpit-prompts/17-termos.md) e [Lembretes](docs/cockpit-prompts/18-lembretes.md).
- Sub-aba **Backups** do **Resumo** (F3): notebooks de backup livres nas regionais prioritárias; **Confirmar disponível por 7 dias** grava só série, cidade e datas em `data/state/backups_regionais.json`.
- **Abrir chamado no UX** (cartão do equipamento na Home) e o ticket UX gerado depois do **Transporte** (F2) preenchem o portal UX Simpress pelo Chrome de automação. O envio real exige confirmação, a série de teste `BRM551RN1Y` nunca é enviada e `SIMPRESS_UX_SEM_ENVIO=1` recusa qualquer envio real.
- **Enviar e-mail** (Home, grupo **Outros** do cartão do equipamento) abre ou envia e-mails por modelo pelo Outlook clássico, só por clique. O envio real pede confirmação e `SIMPRESS_OUTLOOK_SEM_ENVIO=1` o recusa. Veja [Home](docs/cockpit-prompts/03-home-split-view.md).

As mudanças ainda sem versão publicada estão na seção **[Não lançado]** do [CHANGELOG](CHANGELOG.md).

## Requisitos

- Windows 10 ou superior.
- Python 3.12 ou superior.
- O servidor usa os arquivos locais já compilados da interface. Node.js e npm são necessários para reconstruir esses arquivos, executar os testes JavaScript e rodar a verificação completa (`npm run verify`).
- Não é necessário ter acesso à internet para abrir a aplicação e carregar a interface. Os links para os sistemas de chamados da Simpress abrem páginas externas; o assistente (OpenRouter ou DeepSeek) e as rotinas de automação pelo Chrome precisam de internet.
- Google Chrome instalado, só para as rotinas de automação.

O repositório é privado; a conta usada para cloná-lo precisa ter acesso.

## Instalação

Clone o projeto ou abra o PowerShell na pasta existente:

```powershell
git clone https://github.com/gabrielakihiro-dev/Simpress.git
cd Simpress
```

### Primeira vez em uma máquina nova

Execute `instalar_primeira_vez.bat` (duplo clique ou `.\instalar_primeira_vez.bat`). Ele instala o Python 3.12 pelo `winget` se faltar, cria `.venv`, instala as dependências fixadas (inclusive o Playwright), baixa o Chromium do Playwright, confere o Google Chrome usado pela automação (`executar_automacao.bat`) e verifica as pastas de `data/`. Instala também o ripgrep (`rg`) pelo `winget`, se faltar, usado pelo `rtk rg` dos agentes, e o RTK (`winget install rtk-ai.rtk`, que condensa as saídas dos comandos), ambos opcionais; abra um terminal novo depois. O instalador não ativa o hook do RTK no Claude Code: para isso, rode uma vez `rtk init -g`. Instala ainda o graphify (`uv tool install graphifyy`, ou `pip install --user` sem o `uv`), opcional, que gera o grafo de conhecimento do projeto; para registrar a skill no Claude Code rode uma vez `graphify install` e, para criar o grafo, `/graphify .` (a extração de documentos consome tokens; nada disso é feito pelo instalador). Se o Node.js estiver instalado, também roda `npm ci` e baixa o Chromium dos testes de interface (`npm run test:ui:e2e`); sem Node.js, o servidor e a automação funcionam normalmente. Sincroniza também as skills dos agentes (inclusive `monitoramento-pr-ci`) em `~/.claude/skills` e `~/.gemini/config/skills`. Se o comando `claude` estiver no PATH e o plugin `model-super-power` ainda não estiver instalado, instala-o no Claude Code, no escopo do usuário (`claude plugin install model-super-power --marketplace johnnyhelder/claude-model-super-power`, que altera `~/.claude`); ele traz os subagentes da tabela "Delegação em subagentes" do `AGENTS.md`. Plugin já instalado não é atualizado. Sem o comando `claude` (só o app desktop), rode no Claude Code `/plugin install model-super-power --marketplace johnnyhelder/claude-model-super-power`. Requer internet, pode ser repetido com segurança e, ao final, oferece iniciar o servidor. No uso diário, abra apenas `iniciar_servidor.bat`.

### Inicializador do servidor

O inicializador `iniciar_servidor.bat` prepara automaticamente o ambiente na primeira execução: cria `.venv` e instala as dependências fixadas. Isso requer Python 3.12 ou superior e conexão com a internet na primeira instalação. Nas próximas inicializações, a instalação só se repete quando os arquivos de dependências mudarem.

Se o `pip` estiver ausente na `.venv`, o inicializador tenta recuperá-lo automaticamente com `ensurepip` e reinstala as dependências. A recuperação do `pip` usa os arquivos incluídos no Python; a instalação das dependências requer internet.

Para preparar o ambiente manualmente — por exemplo, se for iniciar o servidor diretamente pelo Python — use Python 3.12 ou superior. No Windows, use o Python Launcher:

```powershell
py -3 -m venv .venv
```

Se o comando `py` não estiver instalado, use `python` — confirme que aponta para Python 3.12 ou superior:

```powershell
python -m venv .venv
```

Confira a versão do ambiente:

```powershell
.\.venv\Scripts\python.exe --version
```

Instale as dependências fixadas pelo projeto:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Esse arquivo inclui o `playwright` (usado só pela automação do Chrome em `executar_automacao.bat`); não é necessário baixar navegadores, pois a automação usa o Google Chrome instalado. Se o pacote faltar, a rotina avisa em português e mostra esse mesmo comando de instalação.

No VS Code, o interpretador configurado para este workspace é `.venv\Scripts\python.exe`. Se necessário, selecione esse caminho manualmente.

## Planilhas e arquivos locais

Os caminhos são relativos à pasta do projeto e estão definidos em [core/config.py](core/config.py). Dados operacionais ficam em `data/`, e o modelo de exportação continua em `modelos/`. O arquivo `.env` da raiz (fora do Git) só é lido pelo assistente, para `OPENROUTER_API_KEY`, os modelos opcionais e, se quiser usar o DeepSeek, `DEEPSEEK_API_KEY` e `DEEPSEEK_MODEL`; sem ele, o restante da aplicação funciona normalmente e o painel do assistente mostra o aviso de assistente desligado. Para criá-lo, copie o modelo:

```powershell
Copy-Item .env.example .env
```

Na primeira inicialização após atualizar uma instalação existente, o inicializador move os arquivos das pastas antigas para `data/`. A migração primeiro tenta concluir recuperações registradas em `.transactions`; se a recuperação falhar ou houver um upload temporário, ela interrompe sem mover os arquivos. Ela preserva os caminhos relativos dos backups e não sobrescreve destinos diferentes. Feche qualquer outro servidor antes de executar `scripts/migrate_local_data.py` manualmente.

Antes de iniciar o servidor, a limpeza recupera transações e considera temporários com pelo menos 24 horas. Ela remove apenas cópias com o mesmo conteúdo do arquivo de destino, enquanto mantém versões diferentes para revisão. Para visualizar o relatório sem remover nada, execute `scripts/cleanup_local_temps.py` sem `--apply`.

| Arquivo | Local | Uso |
| --- | --- | --- |
| `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` | `data/planilhas_entrada` | Modelo da planilha oficial, versionado no Git. É necessário para gerar transferências, mas sua ausência não impede o servidor de iniciar. |
| `EquipamentosDetalhes*.xlsx` | `data/planilhas_entrada` | Inventário principal da busca. Na inicialização, o sistema usa o arquivo válido mais recente. |
| `EquipamentosDetalhes_atual.xlsx` | `data/planilhas_entrada` | Destino da atualização Simpress, extraído do workbook contido no ZIP `EquipamentosDetalhes` enviado para a atualização. É a fonte oficial da composição e contagem do cadastro; não some registros da InvAll nem de snapshots anteriores. |
| `InvAllComputersSummary_atual.xlsx` | `data/planilhas_entrada` | Fonte auxiliar de hostname por série e comparação. Não adiciona equipamentos à base oficial. |
| `EquipamentosDetalhes-exportacao.xlsx` | `modelos` | Modelo local de exportação. Não é distribuído pelo Git. |
| `apelidos_modificados.json` | `data/state/apelidos_modificados` | Apelidos personalizados locais. O arquivo, temporários e bloqueios não são versionados. |
| `historico_comparacoes.json` | `data/state/historico_comparacoes` | Histórico local de comparações. O arquivo, temporários e bloqueios não são versionados. |
| `historico_chamados.json` | `data/state` | Até 50 versões importadas da relação Simpress/Oracle, com comparação, fila de atenção e exportação filtrada; o arquivo, temporários e bloqueios não são versionados. |
| `os_observacoes.json` | `data/state` | Observação do andamento por OS da aba **OS** (F6), por série e OS, com CPF mascarado e senhas omitidas; o arquivo, temporários e bloqueios não são versionados. |
| Lotes para atualização automática | `data/state/entrada_automatica` | Fila local de entrada, arquivos processados e lotes com falha; não é versionada. |
| Lotes para chamados Simpress/Oracle | `data/state/entrada_chamados` | Fila local para importar automaticamente o par de planilhas de chamados; os arquivos e resultados ficam fora do Git. |
| Catálogo de unidades e histórico de apelidos | `data/state` | Estado local da aplicação; não é distribuído pelo Git. |
| `sebrae_*.json` e `sebrae_dashboard_importado.xlsx` | `data/state` | Estado local dos chamados do Sebrae e do Dashboard importado, incluindo `sebrae_finalizacao.json` (descrições editadas e finalizações) e `sebrae_chamados_encerrados.json`; fora do Git. |
| `sebrae_dashboard_saida/`, `sebrae_backups/` e `sebrae_dashboard_pendente/` | `data/state` | Cópias geradas por **Atualizar Dashboard**, os 20 backups mais recentes baixados antes de cada envio ao SharePoint e a cópia que ficou pendente quando o envio falhou; fora do Git. |
| `dashboard_agendamento.json` | `data/state` | Estado do agendamento **Repetir a cada** (ativo, intervalo e próximo horário); fora do Git. |
| Lotes de nomes do Microsoft Entra | `data/state/entrada_usuarios_entra` | Fila local do CSV de usuários do Entra (`pendentes`, `processadas`, `falhas`, com `_resultado.json`); fora do Git. |
| `assistente_*.json` | `data/state` | Conversas (só texto mascarado), notas e lembretes, instruções permanentes e o interruptor da busca na web do assistente; fora do Git. |
| `representantes_regionais.json` | `config` | Alterações por cidade dos representantes regionais do SEBRAE/PR; fora do Git. |
| `representantes_regionais_padrao.json` | `data/state` | Nome, e-mail e telefone padrão dos 22 representantes (o código guarda só cidades e horários); fora do Git. Modelo fictício: `config/representantes_regionais_padrao.exemplo.json`. |
| `outlook_modelo_cabo_padrao.json` | `data/state` | Opcional: destinatários, assunto e corpo reais do Modelo 1 de e-mail pelo Outlook (só leitura; sem ele vale o padrão genérico do código); fora do Git. Modelo fictício: `config/outlook_modelo_cabo_padrao.exemplo.json`. |
| `.env` | raiz do projeto | Chaves e modelos do assistente (OpenRouter e, opcionalmente, DeepSeek); fora do Git. Modelo em `.env.example`. |

As planilhas operacionais e o modelo de exportação precisam ser fornecidos localmente. Se estiverem ausentes, somente as funções que dependem desses arquivos ficam indisponíveis; o servidor e as demais áreas continuam acessíveis. Não coloque dados reais no repositório.

### Cabeçalhos dos inventários

Os cabeçalhos devem estar na primeira linha de uma aba com dados. O sistema normaliza espaços, acentos e pontuação e recusa cabeçalhos repetidos ou ambíguos.

- **EquipamentosDetalhes:** número de série (`NumeroSerie`, `Numero de Serie` ou `Serial`), apelido/hostname (`Apelido`, `Hostname`, `Nome do Computador` ou `ComputerName`), `Modelo` e `Cidade`.
- **Endpoint:** nome do computador (`Nome do Computador`, `ComputerName` ou `Hostname`) e número de série/rótulo de serviço (`Rotulo de Servico Numero de Serie`, `NumeroSerie`, `Numero de Serie`, `Serial` ou `ServiceTag`). Para usuário, prioriza `Usuário do último logon` e usa `Usuários logados`/`UsuarioLogado` como alternativa quando o primeiro campo estiver vazio ou indicar ausência. A coluna de último logon é obrigatória para publicar lotes pela exportação automática; planilhas antigas enviadas manualmente continuam compatíveis e usam a coluna de usuários logados. Quando a mesma série aparece em mais de uma linha, vale o usuário da linha com a `Última verificação com êxito` mais recente; sem data, com empate ou com usuário vazio na linha vencedora, a série continua ambígua.
- **Modelo de exportação:** precisa ter colunas de número de série e `Apelido`. A coluna `IdCliente` é atualizada quando existe nos dois arquivos.

Para escolher a aba automaticamente, o arquivo enviado deve conter somente uma aba que corresponda aos cabeçalhos exigidos para aquele inventário. Se mais de uma aba for compatível, a atualização é recusada para evitar comparar a tabela errada.

Quando o CNPJ da unidade de instalação estiver disponível em `CNPJ Instalacao` ou `CNPJ de Instalacao`, esse valor pode ser usado. O CNPJ de faturamento não é usado como substituto.

### Contato padrão da retirada

O contato de retirada (nome, e-mail e celular) é dado pessoal e não fica no código. Cada campo é lido nesta ordem:

1. variável de ambiente (`SIMPRESS_TRANSFER_ORIGIN_CONTACT`, `SIMPRESS_TRANSFER_ORIGIN_EMAIL`, `SIMPRESS_TRANSFER_ORIGIN_PHONE`);
2. arquivo local `config/contato_origem.json`, ignorado pelo Git;
3. vazio.

Sem dados, a aba **Transporte** mostra um aviso com o botão **Configurar contato de origem**, que grava `config/contato_origem.json` sem reiniciar o servidor. Para criar o arquivo manualmente, copie o exemplo com dados fictícios e edite os valores:

```powershell
Copy-Item config\contato_origem.exemplo.json config\contato_origem.json
```

Os 22 representantes regionais do SEBRAE/PR têm o padrão no backend (a tela os carrega da API): o código guarda só as cidades e os horários, e nome, e-mail e telefone vêm do arquivo local `data/state/representantes_regionais_padrao.json` (fora do Git; copie `config/representantes_regionais_padrao.exemplo.json` e preencha; sem o arquivo, a lista mostra `Não definido ainda`); o botão **Editar** (Retirada e Entrega) grava só as alterações por cidade em `config/representantes_regionais.json`, local e ignorado pelo Git, sem reiniciar o servidor. **Restaurar padrão** no modal remove a alteração da cidade. O assistente (F9) também consulta, altera e restaura essas cidades, com cartão de confirmação.

As variáveis de ambiente têm prioridade sobre o arquivo. Defina-as no PowerShell antes de iniciar o servidor; reinicie o processo depois de alterá-las.

```powershell
$env:SIMPRESS_TRANSFER_ORIGIN_CONTACT = "Nome do contato"
$env:SIMPRESS_TRANSFER_ORIGIN_EMAIL = "contato@empresa.com"
$env:SIMPRESS_TRANSFER_ORIGIN_PHONE = "(41) 00000-0000"
```

### Variáveis de ambiente

Todas são opcionais. Defina-as no PowerShell antes de iniciar o servidor ou as rotinas; reinicie o processo depois de alterá-las.

| Variável | Efeito |
| --- | --- |
| `SIMPRESS_PORT` | Porta do servidor ao rodar `python main.py` (padrão `8000`). O `iniciar_servidor.bat` ignora o valor definido e usa a porta livre que escolher entre `8000` e `8099`. |
| `SIMPRESS_NAO_ABRIR_NAVEGADOR=1` | Não abre o navegador quando o servidor termina de iniciar. |
| `SIMPRESS_ENABLE_DOCS=1` | Liga `/docs`, `/redoc` e `/openapi.json` (desligados por padrão). |
| `SIMPRESS_VERIFICAR_ATUALIZACAO=0` | Desliga a oferta de atualização do inicializador. |
| `SIMPRESS_CHROME_PORT` e `SIMPRESS_CHROME_PROFILE` | Porta CDP (padrão `9333`) e pasta do perfil (padrão `%USERPROFILE%\.chrome-automation`) do Chrome de automação. |
| `SIMPRESS_DASHBOARD_EMAIL` e `SIMPRESS_SOFTEXPERT_EMAIL` | Contas escolhidas pelas rotinas nos logins Microsoft (Oracle, UX e Dashboard) e no SoftExpert. |
| `SIMPRESS_ENDPOINT_USUARIO` | Usuário preenchido pela rotina no login local do Endpoint Central (a senha continua com você). |
| `SIMPRESS_CHROME_OCIOSO_S` | Segundos sem rotina até fechar o Chrome de automação. Sem a variável, ou com `0`, o Chrome fica aberto. |
| `SIMPRESS_IMPORT_INBOX_DIR` e `SIMPRESS_TICKET_IMPORT_INBOX_DIR` | Pastas das filas de importação automática de inventários e de chamados, no lugar de `data/state/entrada_automatica` e `data/state/entrada_chamados`. |
| `SIMPRESS_SUGESTAO_IA=1` | Liga a sugestão por IA de categoria e tipo dos chamados do Sebrae que as regras locais deixaram como `OUTRO`. O texto vai mascarado ao OpenRouter; só vale definida no processo, não no `.env`. |
| `SIMPRESS_ATUALIZACAO_TIMEOUT` | Tempo máximo, em segundos, da verificação de atualização do inicializador (padrão `60`). |
| `SIMPRESS_ANNOTATIONS_DIR` | Pasta das anotações do histórico, no lugar da escolhida automaticamente (relativa à pasta do projeto ou absoluta). |
| `SIMPRESS_UX_SEM_ENVIO=1` | Recusa qualquer envio real ao UX; a simulação continua. |
| `SIMPRESS_OUTLOOK_SEM_ENVIO=1` | Recusa o envio real pelo Outlook; **Abrir no Outlook** continua. |
| `SIMPRESS_TRANSFER_ORIGIN_*` | Contato padrão da retirada (veja acima). |

## Iniciar e abrir a aplicação

Execute:

```powershell
.\iniciar_servidor.bat
```

Antes de preparar o ambiente, o inicializador verifica se há uma **versão publicada** mais nova que a instalada, isto é, uma tag `vX.Y.Z` no `origin` que esteja no histórico de `origin/main`. Commits novos no `main` sem tag não são oferecidos. Se houver, mostra a versão e o trecho correspondente do [CHANGELOG](CHANGELOG.md) e pergunta `Há uma versão nova (vX.Y.Z). Atualizar agora? (S/N)`. A atualização é opcional e só faz fast-forward até o commit da tag (`git merge --ff-only`); ela é recusada, com o motivo em português, quando não existe nenhuma tag publicada, há alterações locais em arquivos rastreados, o branch não é `main`, o histórico divergiu, o fast-forward falha ou não há Git ou rede. Nesses casos o servidor inicia com a versão atual. O processo nunca usa `reset`, `clean`, `stash` nem `--force`, e não toca em `data/` nem em arquivos não rastreados. Se `requirements.txt` mudar, as dependências são reinstaladas na `.venv` logo em seguida; se o próprio `.bat` mudar, ele se reinicia uma vez. Para desativar a verificação, defina `SIMPRESS_VERIFICAR_ATUALIZACAO=0` (permanente: `setx SIMPRESS_VERIFICAR_ATUALIZACAO 0`). Detalhes em [Atualização com um clique](docs/operacao/atualizacao-um-clique.md).

O inicializador cria ou atualiza o ambiente `.venv` quando necessário, executa a migração e a recuperação/limpeza seguras dos dados locais e abre o servidor. A prontidão das funções é informativa e a ausência de planilhas ou modelos locais não impede o startup. Para iniciar sem o arquivo `.bat`, prepare manualmente o ambiente como descrito em **Instalação** e use:

```powershell
.\.venv\Scripts\python.exe scripts\migrate_local_data.py
.\.venv\Scripts\python.exe scripts\cleanup_local_temps.py --apply
.\.venv\Scripts\python.exe main.py
```

O navegador abre sozinho com a sessão local (`/bootstrap`). Digitar o endereço à mão dá 401 em `/api/*`, porque a sessão local muda a cada início do servidor.

- Aplicação (porta padrão): <http://127.0.0.1:8000>
- Documentação interativa da API: desligada por padrão. Para desenvolvimento, defina `$env:SIMPRESS_ENABLE_DOCS = "1"` antes de iniciar e abra <http://127.0.0.1:8000/docs>.

Se o iniciador escolher outra porta, use o endereço que ele mostrar no terminal.

O iniciador usa `127.0.0.1:8000` quando disponível. Se outra aplicação ocupar essa porta, ele escolhe uma porta livre entre `8001` e `8099`; se o Simpress já estiver ativo nesse intervalo, abre a instância existente em vez de iniciar outra. O servidor continua restrito ao computador local. Para encerrar uma instância, volte à janela que a iniciou e pressione `Ctrl+C`.

Na inicialização, o terminal e a aplicação mostram quais arquivos locais estão disponíveis e quais funções dependem deles. O painel **Ver detalhes de arquivos e funções** informa o impacto de cada ausência; **Atualizar status** repete a verificação. Esse botão verifica disponibilidade e formato do arquivo, mas não recarrega os equipamentos na memória. Para carregar arquivos alterados manualmente, reinicie o servidor; no uso normal, atualize os inventários pela própria aplicação.

| Função | Dependências principais |
| --- | --- |
| Busca de equipamentos | Um `EquipamentosDetalhes*.xlsx` válido e os catálogos locais. |
| Geração de transferência | Modelo `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx`. |
| Comparação/atualização | Inventários Endpoint e Simpress enviados no fluxo. |
| Exportação Excel | Inventário principal válido e `modelos/EquipamentosDetalhes-exportacao.xlsx`. |

## Como usar

### Pesquisar equipamento

Na aba **Home**, pesquise por série, apelido/hostname, modelo, cidade, login ou nome da pessoa. Pressione `Enter` ou clique em **Buscar Equipamento**; de qualquer outra aba, isso leva primeiro à **Home** (F1) e depois pesquisa. A lista rápida mostra até 15 resultados; **Mostrar mais** abre a pesquisa completa, que apresenta o total e carrega até 50 resultados por vez com **Carregar mais**. Quando nada é encontrado, o autocompletar sugere `Você quis dizer <usuário mais próximo>?`.

Na pesquisa completa, combine os filtros de categoria, cidade e **Usuário** (**Sem usuário** e **Com usuário**). As categorias são **Notebooks**, **MacBooks**, **Monitores** e **Fones**. A classificação considera o tipo e o modelo da planilha; por exemplo, monitores também são identificados pelo modelo e MacBooks aparecem separados dos outros notebooks.

Com um equipamento selecionado na Home:

- **Consultar no Endpoint** consulta só aquela série no Endpoint Central, pelo Chrome de automação (porta `9333`), e mostra exatamente o `Usuário do último logon`; se a série não existir lá, aparece `Equipamento não encontrado no Endpoint`. É só leitura: nada é gravado no Endpoint, nas planilhas nem nos históricos. O login é manual, e a aba usada é reaproveitada na consulta seguinte.
- **Controle remoto**, ao lado, abre a mesma aba, escolhe `Controle remoto` na linha do equipamento, informa o motivo `acesso` e clica em `Conectar`; a janela do controle remoto fica aberta para você. É a única ação do Simpress que inicia uma conexão externa, e só acontece pelo seu clique ou por um pedido ao assistente confirmado no cartão.
- O cartão **Chamados abertos** mostra as OS do Oracle e também os chamados da aba **Chamados** (F5) ainda não finalizados para a mesma série, com o botão **Ver na aba Chamados (F5)**. Se a consulta do Sebrae falhar, as OS do Oracle continuam na tela com o aviso de consulta parcial.
- Quando o login do Endpoint corresponde a uma única conta do Microsoft Entra importada, o cartão mostra o nome da pessoa ao lado do login (veja [Nomes do Microsoft Entra](#nomes-do-microsoft-entra)).

### Gerar transferência

1. Pesquise o equipamento na aba **Home** e confira os dados encontrados.
2. Abra manualmente a aba **Transporte** (F2).
3. Revise a origem e o destino, incluindo CNPJ, endereço e contatos. O catálogo de unidades pode ajudar a preencher os dados.
4. Preencha os campos obrigatórios e clique em **Transporte** (antigo **Gerar Planilha**) no rodapé. Para só alterar o endereço no UX, use **Alterar Endereço** (série e endereços bastam, sem planilha).
5. Abra o arquivo baixado e confira os dados antes de encaminhá-lo.

Para gerar a planilha, são obrigatórios: série do equipamento; CNPJ e endereço de retirada e entrega; nome, e-mail e telefone do contato de retirada; observações da retirada; nome, e-mail e telefone do destinatário; horário, almoço e observações da entrega. A duração da pausa da unidade de entrega também é obrigatória, exceto quando o horário de almoço indica que o escritório não fecha. O arquivo é preparado para download e não fica guardado como arquivo permanente pelo servidor.

Na aba **OS** (F6; abaixo de 1200 px, pelo menu **Ferramentas**), confira a relação entre o Excel **Acompanhamento de Pedidos** da Simpress e o Excel **Gestão de Solicitações** do Oracle. A tabela **Ordens de serviço por série** relaciona as linhas pelo número de série e mostra Fonte, Série, OS, Usuário, Hostname, Chamado e Descrição; o andamento abre como linha expansível. Série sem OS vinculada, nem na Simpress nem no Oracle, não aparece na aba (nem nas contagens, nem no filtro). Use o filtro **Relação** (Todas, Divergentes, Conferidas, Só Simpress, Só Oracle) e o campo de busca por série ou OS para filtrar. Quando as fontes tiverem OS diferentes para a mesma série, o registro é marcado para conferência.

Na coluna **Chamado**, cada OS tem um único campo para o número depois do prefixo `UTIC-<ano>-`; **Salvar** (**Atualizar** quando já há vínculo) grava o vínculo, que precisa ter só números; **Remover vínculo** o apaga. Na aba **Transporte**, **OS deste equipamento** abre a aba **OS** já filtrada pela série pesquisada. Para executar a importação operacional, use a fila local de pastas descrita a seguir; ela não depende do envio de arquivos pelo navegador nem de uma chamada HTTP.

Na aba **Home**, **Mostrar textos para chamados** apresenta textos editáveis relacionados ao equipamento. Use **Copiar** para levar o texto ao chamado; os botões **Link** abrem os sistemas externos correspondentes.

#### Importar chamados pela pasta do projeto

Para executar uma OS, use a fila local em vez do formulário web ou de uma rota HTTP/HTTPS. Crie um lote com identificador exclusivo em `data/state/entrada_chamados/pendentes` e coloque exatamente um arquivo `.xlsx` em cada subpasta `simpress` e `oracle`. Preserve os arquivos de origem; o importador verifica se o par permaneceu estável em duas leituras, valida e reconcilia os workbooks, registra um novo evento no histórico de chamados e move o lote completo para `processadas`. Lotes recusados ficam em `falhas` com `_resultado.json`; nada é apagado. Lotes interrompidos são recuperados na inicialização, e um lote já registrado não é importado novamente.

```text
data/state/entrada_chamados/pendentes/2026-10-10_os-simpress/
├── simpress/
│   └── Acompanhamento_de_pedidos.xlsx
└── oracle/
    └── Gestao_de_Solicitacoes.xlsx
```

O servidor verifica a pasta a cada 10 segundos; com ele ativo, a importação começa após duas verificações estáveis (cerca de 20 segundos). Confirme `status: concluido` em `processadas/<lote>/_resultado.json` e a nova versão no histórico visual. Se o servidor não estiver ativo, processe uma vez pela rotina local:

```powershell
.\.venv\Scripts\python.exe scripts\process_ticket_inbox.py
```

O comando usa a mesma validação sem enviar requisições HTTP. Se o site estiver aberto, ele percebe em até 10 segundos as planilhas trocadas pelo comando e recarrega a base sozinho. Consulte `data/state/entrada_chamados/README.md` para ver o modelo de lote e um exemplo no PowerShell. A variável `SIMPRESS_TICKET_IMPORT_INBOX_DIR` permite definir outra raiz local. A fila funciona no modo de arquivos; não inclui os lotes operacionais no Git.

### Comparar e atualizar inventários

O **Resumo** (F3) abre com o cartão **Ativos por regional**: filtros por categoria (**Todos**, **Notebooks**, **MacBooks**, **Monitores**, **Fones**, cada um com sua contagem), todas as regionais visíveis por padrão e o botão **Ver menos** para recolher às 8 maiores (**Ver todas as N regionais** mostra todas de novo). A antiga tabela **Total de ativos** saiu; a lista completa de equipamentos fica na Home.

Use **Pendências** para revisar e anotar as linhas da atualização mais recente; o painel **Evolução das atualizações** foi removido da interface em 31/10/2026 (o alerta **Divergências novas** da Home continua e seu botão **Ver evolução** abre o **Resumo**).

1. Abra **Atualizar planilhas**: no **Resumo** (F3), seção Comparação, clique em **Nova comparação**; também abrem o mesmo fluxo o botão **Importar** da Home e o botão **Atualizar base** do alerta de base desatualizada.
2. Selecione um arquivo `.xlsx` do **Endpoint** e um `.xlsx` ou `.zip` do **Simpress**.
3. Clique em **Pré-visualizar impacto** e confira as contagens de séries novas, removidas e duplicadas antes de **Confirmar substituição**. A prévia vale por dez minutos e precisa ser refeita se os arquivos ou a base ativa mudarem.
4. Cada atualização substitui integralmente os dois inventários ativos pelos arquivos validados; séries ausentes no novo relatório deixam de compor a base carregada. Após confirmar, confira ausências em cada fonte, notebooks sem verificação com êxito há 7 dias ou mais, divergências de local, correspondências ambíguas, mudanças de hostname e casos que precisam de revisão.
5. Em **Comparação**, clique em **Histórico e ações completas** para rever comparações e, se houver um backup completo válido, pré-visualize os arquivos e datas antes de restaurar.

A prévia também funciona na primeira importação, quando ainda não há inventário local. O processamento automático pela pasta de entrada mantém seu fluxo próprio.

No resultado da comparação:

- **Mudanças de usuário logado** lista os casos em que o novo Endpoint informa um usuário onde havia um usuário digitado à mão, ou deixa de informar um usuário que existia. Nada muda sozinho: o usuário atual continua valendo até você decidir.
- Em uma duplicidade do Endpoint (a mesma série com dois hostnames), **Remover mais antigo** descarta o hostname mais antigo, depois da confirmação; o outro passa a valer na base e nas próximas exportações. A planilha do Endpoint não é alterada, e **Desfazer** devolve a duplicidade.

#### Nomes do Microsoft Entra

Em **Atualizar planilhas**, uma seção própria aceita o CSV de usuários exportado do Microsoft Entra. A tela mostra quantas contas `@pr.sebrae.com.br` válidas foram importadas e a data da última atualização, e oferece o XLSX compacto com as colunas **Login** e **Display Name**. O nome da pessoa só aparece quando o login corresponde a uma única conta; logins repetidos com nomes diferentes ficam de fora e são contados como ignorados. O CSV também pode entrar pela fila local `data/state/entrada_usuarios_entra/pendentes/<lote>/`, que segue o mesmo padrão de `processadas`, `falhas` e `_resultado.json`. A importação não altera a base oficial de equipamentos. Detalhes em [Nomes do Microsoft Entra](docs/operacao/nomes-entra-ui.md).

#### Processar atualizações pela pasta de entrada

Para preparar automaticamente o par recém-exportado de Downloads, registre o horário de início **antes** das exportações e execute o preparador depois de acionar os dois downloads:

```powershell
$inicioInventarios = (Get-Date).ToString("o")
# Exporte UX Simpress (contrato 16467) e Endpoint Central no Chrome.
& .\.venv\Scripts\python.exe scripts\prepare_inventory_downloads.py --since $inicioInventarios
```

O preparador seleciona o download mais recente de cada fonte posterior ao horário informado: `InvAllComputersSummary*.xlsx` ou `.zip` para Endpoint e `EquipamentosDetalhes*.xlsx` ou `.zip` para Simpress. Um ZIP precisa conter exatamente um XLSX. Os originais permanecem em Downloads; a cópia do par completo é publicada de uma só vez na fila, com `_origem.json` contendo nomes, datas e hashes SHA-256. Sem os dois arquivos recentes, nenhum lote é publicado. Repetir o comando com o mesmo horário e par retorna o lote existente, inclusive se estiver em `falhas`, sem criar outra atualização.

Se o servidor estiver parado, processe a fila diretamente, sem upload HTTP:

```powershell
& .\.venv\Scripts\python.exe scripts\process_inventory_inbox.py
```

O comando usa o importador e a transação existentes. Confira `processadas/<lote>/_resultado.json` com `status: concluido` e o evento com `importacao_automatica_id` no histórico; a contagem do comando também inclui lotes arquivados por falha e não substitui o recibo. Prefira o importador do servidor quando ele estiver ativo, para manter seus dados em memória atualizados. A sincronização das anotações continua usando a pasta compartilhada já configurada e sua fila de pendências; os comandos não publicam planilhas em serviços externos.

Procedimento de exportação e importação: [Exportações de planilhas — UX Simpress + Endpoint Central](https://app.notion.com/p/Exporta-es-de-planilhas-UX-Simpress-Endpoint-Central-3f5922a10077801f99e2e26a4fee14b9). Acione cada exportação uma vez e prossiga; confira Downloads depois das duas ações. Autenticação de dois fatores e bloqueios do navegador podem exigir intervenção do usuário.

Com o servidor local em execução, também é possível colocar os dois arquivos em um lote na pasta `data/state/entrada_automatica/pendentes`. O sistema verifica a fila a cada 10 segundos e usa a mesma validação, comparação, backups, histórico e transação da atualização manual.

Crie uma pasta de lote com nome exclusivo e esta estrutura. Os nomes dos arquivos `.xlsx` podem ser os originais:

```text
data/state/entrada_automatica/pendentes/2026-10-09_lote-001/
├── endpoint/
│   └── InvAllComputersSummary.xlsx
├── simpress/
│   └── EquipamentosDetalhes.xlsx
```

Copie um arquivo para cada pasta de origem. Assim que os dois `.xlsx` aparecerem e permanecerem estáveis em duas verificações consecutivas, o importador processará o lote; cada pasta deve conter exatamente um `.xlsx` e cada arquivo respeitar o limite de 60 MB. Depois do processamento, o lote completo vai para `processadas`; arquivos recusados vão para `falhas`, junto de `_resultado.json` com o motivo. Nada é apagado. Lotes em `processando` são recuperados na inicialização, e um lote que já consta no histórico não é aplicado novamente.

Exemplo no PowerShell, substituindo os caminhos e o nome do lote:

```powershell
$lote = "data\state\entrada_automatica\pendentes\2026-10-09_lote-001"
New-Item -ItemType Directory -Force "$lote\endpoint", "$lote\simpress"
Copy-Item "C:\caminho\InvAllComputersSummary.xlsx" "$lote\endpoint\"
Copy-Item "C:\caminho\EquipamentosDetalhes.xlsx" "$lote\simpress\"
```

Para usar outra pasta como raiz, defina `SIMPRESS_IMPORT_INBOX_DIR` antes de iniciar o servidor. O caminho pode ser absoluto ou relativo à pasta do projeto; dentro dele, use as mesmas subpastas `pendentes`, `processando`, `processadas` e `falhas`. O importador é local ao servidor. Para reenviar um lote com falha, corrija a causa e crie uma pasta com outro nome exclusivo.

O sistema cria cópias dos inventários anteriores antes de substituí-los. A restauração também salva o conjunto que está ativo naquele momento e registra a operação no histórico, permitindo desfazê-la se esse backup também for completo e válido.

A cada atualização, o histórico identifica notebooks do Endpoint cuja coluna **Última verificação com êxito** indica 7 dias ou mais sem verificação. O resultado inclui hostname/apelido, série, data, dias decorridos e linha de origem; valores vazios ou inválidos nessa coluna não são contados como inatividade confirmada.

### Apelidos, edição e precedência das fontes

Um apelido alterado manualmente fica associado ao número de série e prevalece nas pesquisas, no formulário e na exportação. Sem alteração manual, um hostname único do Endpoint prevalece sobre o apelido de EquipamentosDetalhes. Quando uma associação do Endpoint não é única, o sistema a apresenta para revisão em vez de escolher uma linha arbitrariamente.

O **Histórico** registra alterações manuais de apelido e permite desfazer a alteração mais recente quando os dados ainda correspondem ao evento. O histórico da **Comparação** (**Histórico e ações completas**) também mostra diferenças entre apelidos manuais e os valores das duas fontes; para cada série, é possível manter o apelido manual ou remover o override. Endereço e localidade vêm de EquipamentosDetalhes e não são alterados manualmente pelo formulário de edição.

### Exportar equipamentos

**Exportar Excel** baixa uma cópia do modelo local atualizada com os dados do inventário principal. O sistema processa somente séries com correspondência única, atualiza células graváveis de `Apelido` e, quando a coluna existe nos dois arquivos, `IdCliente`. Fórmulas não são sobrescritas; as demais abas e formatações do modelo são preservadas. Se a exportação for parcial, a notificação informa os motivos e exemplos para conferência. Desde 31/10/2026 o botão **Exportar Excel** fica na barra da seção **Comparação** do **Resumo** (ao lado de **Exportar**, que baixa só o resultado da comparação) e some quando não há alterações exportáveis; ele não está mais no menu **Ferramentas**.

Depois do download, o mesmo clique envia a planilha ao UX Simpress (rotina `ux_apelidos`, no Chrome de automação): a rotina confirma o contrato `16467 - SERV DE APOIO AS MICRO E PEQ EMP DO PARANA SEBRAE PR`, carrega o arquivo e clica **uma única vez** em **Salvar edições**. Só os apelidos/id desse contrato são gravados no UX. `Planilha Exportada com Sucesso!` confirma apenas o download; o início, a falha e a conclusão do envio ao UX aparecem como mensagens separadas no **Resumo** e na **Automação**. Se o clique em **Salvar edições** acontecer e a confirmação não chegar, o resultado fica incerto: confira manualmente no UX, porque a rotina nunca repete o envio sozinha. O login é manual e a rotina pode ser cancelada como as demais. Detalhes em [Automação pelo Chrome](docs/operacao/automacao-chrome.md).

### Catálogo de unidades e acessibilidade

O **Catálogo de Unidades** permite consultar unidades e manter unidades personalizadas. O painel mostra o selo **SEDE** na lista e no detalhe (que traz cidade, UF, endereço, CEP e CNPJ da unidade selecionada); os botões **Copiar CNPJ** e **Copiar CEP** copiam os valores e a interface informa sucesso ou falha. **Nova unidade** abre o formulário dentro do próprio painel, e o lápis ao lado do CNPJ (na lista e no detalhe) abre a unidade para editar, com o foco no campo CNPJ. Desde 31/10/2026 não existe mais o modal "Gerenciar unidades" nem o botão "Fluxo completo".

A barra superior tem **Home** (F1), **Transporte** (F2), **Resumo** (F3, abre o painel de ferramenta com os ativos por regional, filtráveis por categoria, e a Comparação), **Automação** (F4), **Chamados** (F5, o antigo painel Chamados Sebrae) e **OS** (F6, o antigo painel Chamados com a tabela de ordens de serviço). Abaixo de 1200 px, **Chamados** e **OS** saem da barra e aparecem no menu **Ferramentas**. O menu **Ferramentas** agrupa os painéis (**Histórico de apelidos** F7, **Relatório mensal** F8, além de **Chamados** e **OS** em telas menores) e o catálogo (**Catálogo de unidades**). Cada aba da barra mostra, bem pequeno e centralizado embaixo do nome, o atalho F1 a F6 (sem aumentar a altura da barra; escondido abaixo de 768 px e entre 1200 e 1289 px, onde não cabe). Com um painel de ferramenta aberto, o cabeçalho (título, atalho e **Voltar**) fica fixo e só o conteúdo abaixo rola. O assistente abre com F9. Desde 31/10/2026 o menu não tem mais **Atualizar planilhas** nem **Exportar Excel** (este agora fica na seção **Comparação** do **Resumo**). O painel **Histórico de apelidos** (F7) concentra o histórico de alterações, com filtros e as ações de restaurar e excluir; a janela **Histórico de alterações** foi removida. O F7 não exibe eventos de séries iniciadas por `VMWARE` ou `GOOGLECLOUD` (máquinas virtuais do próprio Sebrae); o filtro vale só para a exibição e nada é apagado do histórico.

A aba **Home** concentra a busca por série, apelido/hostname, modelo, cidade ou usuário. A lista de equipamentos tem os filtros **Todos**, **Sem usuário**, **7+ dias** e **Divergentes**; o selo **Sem usuário** de um notebook ou MacBook leva à seção **Sem usuário** do **Resumo**, que lista os notebooks sem usuário do Endpoint nem manual mesmo sem comparação salva. Após selecionar um equipamento, a tela permanece nela; abra **Transporte** manualmente para preencher a transferência e acessar a barra de ações, fixa na base da tela.

No cartão do equipamento pesquisado, os atalhos compactos copiam o CEP e o CNPJ de instalação da localidade de retirada, além do CNPJ de faturamento fixo. Na aba **Transporte**, o atalho **CNPJ Inst.** só é habilitado após escolher um destino; a confirmação da cópia identifica a cidade selecionada. O rodapé inclui **Copiar Série** para copiar a série pesquisada.

Use **Pular para o conteúdo principal** para ignorar o cabeçalho. Na lista rápida, `↑` e `↓` navegam, `Enter` seleciona ou abre os resultados completos e `Esc` fecha. Na pesquisa completa, refine por categoria e cidade ou carregue mais resultados. Diálogos mantêm o foco dentro do conteúdo enquanto estão abertos, fecham com `Esc` e devolvem o foco ao controle que os abriu. Mensagens de carregamento, sucesso, vazio e erro são anunciadas às tecnologias assistivas. Tabelas largas podem ser percorridas horizontalmente e a interface se adapta a telas menores e à preferência por movimento reduzido.

### Automação pelo Chrome

As rotinas abrem um Chrome de automação com perfil próprio na porta local `9333`, que fica aberto entre as execuções para manter os logins. Acione-as pela aba **Automação** (**Rotina de OS**, **Inventários**, **Rotina Completa**, **Verificar usuários**) ou pelo menu de `executar_automacao.bat`; **Abrir Chrome para login** só abre Endpoint Central, UX Simpress e Oracle para você entrar antes das rotinas, sem digitar senha nem código do autenticador, e **Cancelar execução** interrompe a rotina em andamento (o Chrome continua aberto). Na tela de conta da Microsoft, a rotina escolhe a conta de `SIMPRESS_DASHBOARD_EMAIL` em todos os logins Microsoft (Oracle, UX e Dashboard), exceto no SoftExpert, que usa a conta de `SIMPRESS_SOFTEXPERT_EMAIL`. No login local do Endpoint Central, preenche o usuário de `SIMPRESS_ENDPOINT_USUARIO`. Sem as variáveis, valem as contas padrão de `scripts/automacao_rotinas_chrome.py`. Se houver um botão `SSO`, clica nele uma vez antes. Senha e MFA continuam com o usuário: a rotina espera o login. Os arquivos exportados entram pelas filas locais descritas acima. Detalhes em [Automação pelo Chrome](docs/operacao/automacao-chrome.md).

### Chamados novos do Sebrae

Na aba **Automação**, **Chamados novos do SoftExpert** importa o `.xlsx` do Dashboard Operacional_SEBRAE (aba `CHAMADOS`, coluna C) e a rotina `sebrae` lê no SoftExpert os chamados que ainda não estão nele. **Baixar, importar e buscar** (rotina `dashboard`) baixa o Dashboard da pasta `DASHBOARD SEBRAE` (`Mais ações › Baixar`), importa e busca de uma vez. O painel **Chamados** (F5) mostra um formulário por chamado novo, exporta as linhas para colar e, em **Atualizar Dashboard**, baixa `Dashboard Operacional_SEBRAE.xlsx`; **Enviar ao SharePoint** (rotina `enviar`) faz uma `Duplicata` do arquivo da pasta `DASHBOARD SEBRAE`, confere se ele não mudou desde a importação, guarda um backup local e só então o sobrepõe (`Replace`).

**Repetir a cada** liga o agendamento de **Baixar, importar e buscar** no intervalo escolhido ao lado: 30 minutos (padrão), 1h, 1h30 ou 2h. Trocar o intervalo com o agendamento ligado reinicia a contagem a partir daquele momento. Ele vem pausado, só roda com o servidor ligado, reaproveita o login manual do Chrome e pula a tentativa quando há uma cópia gerada ainda não enviada; não envia nada ao SharePoint nem finaliza chamados.

O painel **Chamados** (F5) separa os chamados nas sub-abas **Novos**, **Antigos**, **Destaques** e **Finalizados** (abre em Novos; a lupa **Filtrar chamados** procura nas quatro). Cada cartão tem três partes: **Solicitação** (somente leitura), **Classificação operacional** (colunas A, B, D, J, R e S, preenchidas à mão) e **Finalização no SoftExpert**. Também no painel:

- **Ler chamados antigos**, no topo, lê no SoftExpert os chamados antigos ainda em aberto, sem gravar nada.
- **Chamado × OS**: clicar no número da OS no cartão do chamado (ou, na aba **OS**, no UTIC de uma OS vinculada) abre uma janela com o chamado ao lado da OS da aba **OS**. Só consulta: não grava nada.
- O lápis no bloco **Descrição** edita o texto do chamado (até 4.000 caracteres), com **Salvar**, **Cancelar** e **Restaurar original**. O texto fica só no site, em `data/state/sebrae_finalizacao.json`; no chamado novo, ele vira a coluna H no próximo **Atualizar Dashboard**.
- Chamados do solicitante `API SEBRAE` já vêm com A `CLIENTE`, B `OUTRO`, D `EM ABERTO`, J `INCIDENTE` e a descrição para finalizar `Revisado.`.
- As seleções ficam como rascunho no navegador até **Descartar rascunho**.
- Um chamado do Dashboard e uma OS com a mesma série se ligam sozinhos (vínculo `Automático · Dashboard` na aba **OS**); o vínculo manual sempre vence e casos ambíguos não são ligados.

O que o site grava fora do computador, sempre por ação sua:

- **Enviar ao SharePoint** (rotina `enviar`) sobrepõe o Dashboard da pasta `DASHBOARD SEBRAE` com as salvaguardas acima.
- **Finalizar no SoftExpert** encerra no SoftExpert um único chamado que você marcou como `FINALIZADO`, com a descrição informada e, se quiser, um PDF anexado. Finalizar é irreversível e pede confirmação. Em **Atualizar Dashboard**, o diálogo oferece **Atualizar e finalizar** ou **Atualizar sem finalizar**; só a primeira opção finaliza. Desde 09/11/2026 **Atualizar e finalizar** (e o clique sem chamado a finalizar) também inicia o envio ao SharePoint pela rotina `enviar`, com as mesmas salvaguardas; **Atualizar sem finalizar**, Esc e fechar o diálogo só atualizam e baixam, sem enviar. Se o envio não iniciar, a tela avisa e **Enviar ao SharePoint** continua disponível. Depois de finalizar, a rotina `fechar` grava as colunas R (data e hora do encerramento) e D `FINALIZADO` e roda a `enviar`. Se o envio falhar, a cópia fica em `data/state/sebrae_dashboard_pendente/` e o painel oferece **Tentar substituir de novo**.
- Fora isso, no SoftExpert a rotina só lê chamados; a outra escrita aceita é a confirmação de associar o chamado ao seu usuário, que o SoftExpert pede ao abrir o formulário.

Atualizar e finalizar exigem que a tela esteja na mesma versão da importação; se o Dashboard foi reimportado no meio do caminho, o servidor recusa (409) sem gerar cópia nem finalizar. Chamados que saem da lista de abertos ficam em `data/state/sebrae_chamados_encerrados.json`. CPFs e senhas são mascarados antes de guardar ou exportar qualquer texto de chamado. Regras de colunas e detalhes em [Sincronizar chamados do Sebrae](docs/operacao/sincronizar-chamados-sebrae.md).

### Assistente (F9)

O assistente é um chat flutuante no canto inferior direito: abre e fecha pelo ícone de robô à direita do sino de notificações, na barra superior, ou com F9. O servidor local chama o OpenRouter direto, com a chave `OPENROUTER_API_KEY` do `.env` (veja [Planilhas e arquivos locais](#planilhas-e-arquivos-locais)); a chave nunca vai para a interface, os logs ou as respostas da API. Os modelos padrão podem ser trocados por `MODELO_PRINCIPAL`, `MODELO_FALLBACK` e `MODELO_AUDIO` no `.env`.

Opcionalmente, com `DEEPSEEK_API_KEY` no `.env`, o texto da conversa vai direto ao DeepSeek, com o modelo `DEEPSEEK_MODEL` (padrão `deepseek-flash`). Nesse modo não há modelo reserva nem `data_collection: deny`, e a mensagem de voz continua exigindo `OPENROUTER_API_KEY`.

- O assistente consulta as rotas do próprio Simpress. Toda alteração de dados para antes e mostra um cartão de confirmação, com texto montado pelo programa; no máximo uma alteração por mensagem.
- Saem do computador o texto da conversa e o resultado das consultas (no OpenRouter, com `data_collection: deny`), o áudio gravado e as imagens anexadas (ambos sem máscara) e, só com o interruptor **Busca na web** ligado, a pesquisa já mascarada, enviada à Exa. Antes do envio de texto, CPFs são mascarados, nomes de pessoas viram marcadores `[PESSOA_n]` (restaurados só na tela; nomes com 2 ou mais palavras mantêm o primeiro nome visível, como `Marina [PESSOA_n]`, e a busca na web e o histórico em disco usam a máscara inteira) e e-mails e telefones são removidos, assim como senhas escritas como `senha: valor` ou `senha=valor`. A busca na web vem desligada.
- Perguntas compostas podem juntar várias consultas na mesma resposta, até 8 idas ao modelo e 12 consultas; ao passar do limite, o assistente para e diz o que conseguiu consultar.
- **Anexar** aceita PDF, `.docx`, PNG ou JPEG (até 10 MB; imagens até 4 MB; até 5 por conversa). O texto de PDF e `.docx` é mascarado antes do envio; arquivos `.doc` são recusados.
- **Gravar áudio** grava até 120 segundos (`Esc` cancela) e transcreve a fala para a caixa de mensagem, para você revisar antes de enviar. O áudio sai do computador sem máscara e não é guardado. **Voz** lê as respostas em voz alta com a voz instalada no computador.
- **Instruções** guarda preferências de resposta (até 4.000 caracteres) em `data/state/assistente_instrucoes.json`. **Lembretes** guarda notas e lembretes (até 200, de 500 caracteres) em `data/state/assistente_notas.json`; não há alarme.
- As conversas ficam em `data/state/assistente_conversas.json`, só com o texto já mascarado. O histórico abre em modo leitura e cada conversa pode sair em **Exportar PDF**.
- O assistente gera relatórios em `.xlsx` ou `.docx` (resumo mensal, totais do inventário, última comparação, divergências por localidade, chamados do Sebrae em aberto e pendências), baixados pelo link `Baixar <nome>`; ficam só na memória por 30 minutos. Também monta rascunhos de e-mail ou texto, sem enviar nada, e explica divergências ou compara períodos.
- Pelo chat, com cartão de confirmação, é possível rodar as rotinas do Chrome (inclusive chamados do Sebrae e Dashboard), cancelar a rotina atual, ler os chamados antigos, editar a descrição de um chamado, finalizar um chamado individual no SoftExpert, abrir o controle remoto, ativar ou pausar o agendamento do Dashboard e alterar representantes regionais. Consultar um equipamento no Endpoint é só leitura e não pede cartão. O assistente não envia ao SharePoint, não atualiza a cópia local do Dashboard e não finaliza em lote.
- Uma conversa por vez: uma segunda mensagem simultânea recebe a resposta 409.

Detalhes em [Assistente](docs/cockpit-prompts/15-assistente.md).

## Limites de planilhas

Cada arquivo enviado pode ter até **60 MB**. Para manter a leitura previsível, cada arquivo também pode ter até **128 abas**, **70.000 linhas por aba** e **3.500.000 de posições usadas no total**. O pacote XLSX descompactado é limitado a 192 MB. Os limites foram calibrados pela medição de outubro de 2026 (`docs/arquitetura/medicao_parse_2026-10.md`): a exportação completa da Simpress, com 50 colunas, cabe com cerca de 70 mil linhas, cerca de 50 vezes o volume atual (~1,4 mil linhas). Na medição, 70 mil linhas sintéticas ocuparam 171 MB descompactados; dados reais com textos mais longos podem atingir os 192 MB um pouco antes. Planilhas com mais de 50 colunas são limitadas pelo total de posições. Perto desse teto, a leitura leva cerca de 70 segundos e pode usar cerca de 340 MB de memória. Os limites se aplicam aos arquivos enviados e às planilhas locais processadas.

Arquivos precisam ser `.xlsx` válidos. Planilhas vazias, corrompidas, com cabeçalhos ausentes/ambíguos ou sem linhas utilizáveis podem ser recusadas. Se duas abas de um arquivo forem compatíveis com o mesmo tipo de inventário, selecione ou prepare um arquivo que contenha apenas a aba correta.

## Histórico, backups e recuperação

- Os backups de atualizações ficam em `data/planilhas_entrada/_backups/<data-hora>-<identificador>/`, separados em Endpoint e Simpress. Um backup incompleto ou inválido não pode ser restaurado pelo histórico.
- O histórico de comparações fica em `data/state/historico_comparacoes/historico_comparacoes.json`; os arquivos temporários e de bloqueio usados nas gravações ficam nessa mesma pasta.
- Históricos de apelidos, comparações e backups vencem após **60 dias**. A limpeza automática ocorre na inicialização e após atualizações de planilhas ou gravações de apelido. Backups antigos sem referência no histórico também podem ser removidos.
- A comparação fixada é preservada. Registros com data inválida são mantidos porque não há um prazo confiável para removê-los.
- Backups e históricos são locais; eles não são enviados à nuvem. Faça uma cópia externa das pastas e arquivos locais se precisar mantê-los além do prazo de retenção ou recuperá-los após perda do computador.
- Gravações relacionadas usam arquivos temporários validados, bloqueios e transações. Se uma operação for interrompida, o sistema tenta recuperar o estado na próxima inicialização.
- `.transactions` contém informações de recuperação pendente. Não apague essa pasta enquanto houver uma recuperação pendente.

Se uma cópia antiga estiver ausente ou inválida, confira manualmente os arquivos ativos e a pasta de backup antes de qualquer substituição. A restauração pelo histórico exige os dois inventários válidos e mostra os nomes, as datas e as contagens antes da confirmação.

## Solução de problemas

| Situação | O que conferir |
| --- | --- |
| O inicializador informa que não encontrou Python 3.12 ou superior | Instale Python 3.12 ou superior e execute o inicializador novamente. |
| A geração de transferência está indisponível | Confira o modelo `(MODELO) - TRANSFERENCIA SIMPRESS.xlsx` em `data/planilhas_entrada`; a ausência dele não impede iniciar o servidor. |
| O servidor iniciou, mas algumas funções estão indisponíveis | Confira o painel de prontidão e forneça localmente os arquivos listados para as funções necessárias. |
| A migração não consegue concluir uma recuperação ou encontra upload em andamento | Preserve os arquivos indicados. Confira `.transactions`; aguarde o upload terminar e execute a migração novamente quando a operação estiver resolvida. |
| A migração informa que já existe um arquivo diferente no destino | Compare os dois arquivos e resolva o conflito manualmente antes de repetir `scripts/migrate_local_data.py`. A migração não substitui nenhum deles. |
| A busca não encontra equipamentos ou escolheu dados antigos | Confira os cabeçalhos e a data de modificação dos arquivos `EquipamentosDetalhes*.xlsx` em `data/planilhas_entrada`. O sistema seleciona o mais recente que contém uma aba válida. Reinicie após substituir um arquivo manualmente. |
| Atualização ou comparação está indisponível | Envie os dois inventários `.xlsx` pelo fluxo **Atualizar planilhas** (**Resumo** (F3) › **Nova comparação**) e confira se cada um tem uma única aba com os cabeçalhos exigidos. |
| A exportação está indisponível | Confira `modelos/EquipamentosDetalhes-exportacao.xlsx` e se ele contém as colunas de série e `Apelido`. |
| Não é possível restaurar uma atualização | O histórico precisa ter o backup dos dois inventários, e ambos devem passar novamente pela validação. |
| O painel de status continua desatualizado | Clique em **Atualizar status** para repetir a verificação; para carregar dados de inventário substituídos manualmente, reinicie o servidor. |
| Uma ação mostrou “Falha interna do servidor” | Consulte `data/logs/simpress.log` (ou `simpress.log.1` a `.5`, os anteriores). O registro mostra a rota e o ponto do código da falha, sem o conteúdo das planilhas. |
| A interface informa que um arquivo está em uso ou ocupado | Feche a planilha no Excel ou aguarde a sincronização do OneDrive e tente de novo. A resposta 409 não altera nenhum arquivo. |
| Uma chamada a `/api/` retorna 401 | Falta o cookie da sessão local neste navegador. Abra a aplicação pelo `iniciar_servidor.bat`, que passa por `/bootstrap` e cria o cookie. Depois de reiniciar o servidor, abra de novo pelo inicializador: o segredo da sessão muda a cada início. |
| Uma chamada a `/api/` feita de outra página ou porta retorna 403 | É esperado: a API aceita só chamadas da própria interface ou de endereços digitados no navegador. Use a interface em `http://127.0.0.1:<porta>`. |
| O inicializador não oferece a atualização | Leia o motivo mostrado no terminal: a atualização só é oferecida quando existe uma tag `vX.Y.Z` mais nova publicada no `origin/main` (veja [Versionamento](docs/guias/versionamento.md)), no branch `main`, sem alterações locais rastreadas (`git status`), com rede e sem `SIMPRESS_VERIFICAR_ATUALIZACAO=0`. |
| O visual continua antigo após `git pull` | Confirme a branch com `git switch main` e atualize com `git pull --ff-only origin main`. Encerre o servidor anterior e execute `iniciar_servidor.bat` da pasta atualizada. Recarregue com `Ctrl+F5` uma vez. As páginas passam a usar URLs de CSS e JavaScript vinculadas ao conteúdo dos arquivos para evitar versões antigas no cache. |

## Desenvolvimento

### RTK automático no Codex (Windows)

Após instalar RTK e o Codex CLI, configure uma única vez nesta máquina:

```powershell
npm.cmd run setup:rtk:codex
```

O configurador atualiza apenas a integração global do RTK: habilita hooks, confia no hash atual do comando exato `rtk hook codex`, preserva os outros hooks e instruções e permite gravar em `%LOCALAPPDATA%\rtk`. Também instala uma regra global para o agente usar `rtk` automaticamente em comandos compatíveis, inclusive dentro de `functions.exec`. Isso cobre a [limitação relatada na ponte de execução do desktop](https://github.com/rtk-ai/rtk/issues/4489). O Codex exige [confiança na definição do hook](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks); apenas criar `hooks.json` não o ativa.

Abra um novo chat após configurar. Não é necessário repetir a configuração nem pedir para executar RTK em cada conversa. A regra vale para comandos compatíveis e mantém o comando original como alternativa quando necessário. A configuração da máquina permanece fora do Git.

O configurador também define `shell_environment_policy.set.CLAUDE_CONFIG_DIR` quando ausente: o RTK consulta esse diretório mesmo no modo Codex, e usuários isolados do sandbox legado podem não ter uma pasta de usuário registrada. Valores personalizados são preservados. Se houver “acesso negado” ao executar os binários instalados pelo `winget`, confira a permissão de leitura e execução do grupo `CodexSandboxUsers` nas pastas específicas do RTK e ripgrep. Esse ajuste de ACL é local e não é feito pelo configurador.

Para conferir a configuração sem alterá-la e testar comandos curtos/longos em sandbox, incluindo a persistência das métricas em outro runtime:

```powershell
node scripts/configure_rtk_codex.cjs --check
npm.cmd run test:rtk:codex
rtk gain --project --format json
```

Esses diagnósticos carregam o runtime local do Codex; não iniciam agentes nem consultam um modelo. As contagens do RTK são estimativas de tokens de saídas do terminal. A execução do configurador exige autorização para alterar os arquivos globais em `~/.codex/`.

### Reconstruir os arquivos da interface

Os arquivos distribuídos em `static/vendor` são servidos localmente. Depois de alterar fontes, ícones ou estilos utilitários, reconstrua-os com Node.js e npm:

```powershell
npm ci
npm run build:ui
```

O servidor Python usa os arquivos gerados e não precisa de um processo Node.js em execução.

### Executar testes

Suíte Python:

```powershell
.\.venv\Scripts\python.exe -B tests\run_tests.py
```

Testes da interface JavaScript:

```powershell
node --test "tests/frontend/*.cjs"
```

Verificação completa em um comando (testes Python, `node --test`, `node --check`, tipos TypeScript, `compileall`, `mypy` e a busca de credenciais em arquivos versionados, com resumo `OK`/`FALHA` por etapa):

```powershell
npm run verify
```

Testes da interface no navegador (Playwright):

```powershell
npm run test:ui:e2e
```

O executor Python usa dados fictícios em uma pasta temporária, bloqueia a leitura das planilhas operacionais durante a descoberta dos testes e isola os testes de transação. Não use planilhas de produção como fixtures ou destinos.

## Estrutura do projeto

```text
main.py                              Aplicação FastAPI, inicialização e rotas principais
core/config.py                       Caminhos locais, limites e padrões de configuração
core/integrity.py                        Bloqueios, transações e recuperação de arquivos
core/xlsx_safety.py                      Validação estrutural e limites de pacotes XLSX
core/openpyxl_compat.py                  Compatibilidade com arquivos lidos/escritos por openpyxl
core/logging_setup.py                    Logs do servidor no console e em data/logs/simpress.log
core/errors.py                           Erros de domínio com o status HTTP, sem depender da camada HTTP
domains/regras_negocio.py           Fonte única das regras de hostname, série do Sebrae e MacBook
domains/inventory_state.py          Estado em memória do inventário ativo (EquipamentosDetalhes)
domains/history_restore.py          Restauração de backups registrados no histórico de comparação
domains/alias_changes.py            Salvar, restaurar e desfazer o apelido manual de um equipamento
domains/equipment_edit.py           Edição de equipamentos na planilha ativa
domains/equipment_export.py         Exportação de equipamentos no modelo fixo
domains/coverage*.py                Cobertura de equipamentos (F10): regras e estado local
domains/backups_regionais*.py       Backups regionais do Resumo (F3): regras e confirmações locais
domains/lembretes.py                Lembretes (Ferramentas), gravados em data/state/lembretes.json
domains/outlook_mail.py             E-mails por modelo pelo Outlook clássico (com outlook_mail.ps1)
domains/ux_*.py                     Chamado e ticket UX pelo Chrome de automação
domains/inventory_comparison.py     Normalização e regras de comparação de inventários
domains/inventory_update.py         Validação, atualização e histórico de inventários
domains/ticket_inbox.py             Entrada estável, validação e arquivamento de lotes Simpress/Oracle
domains/equipment_search.py         Normalização, categorização e indexação de equipamentos
domains/effective_alias.py          Precedência do apelido: manual, hostname do Endpoint, Simpress
domains/uploaded_workbooks.py       Leitura e validação das planilhas enviadas
domains/readiness.py                Painel de prontidão dos arquivos locais
domains/history_annotations.py      Anotações do histórico de planilhas
domains/assistant_*.py              Assistente: OpenRouter, ferramentas, máscara LGPD e conversa
domains/sebrae_*.py                 Chamados novos do Sebrae: Dashboard, SoftExpert, cruzamento e cópia atualizada
domains/chrome_automation.py        Disparo e acompanhamento das rotinas do Chrome de automação
domains/monthly_report.py           Relatório mensal de operações
domains/endpoint_lookup.py          Consulta ao vivo no Endpoint e controle remoto pelo Chrome de automação
domains/endpoint_removals.py        Hostnames duplicados do Endpoint descartados e restaurados
domains/entra_users.py              Nomes do Microsoft Entra (domains/entra_inbox.py: pasta de entrada)
domains/dashboard_agendamento.py    Agendamento "Repetir a cada" (30 min, 1h, 1h30, 2h) do Dashboard do Sebrae
domains/local_setup.py              Importação validada dos modelos locais, com backup
security/local_requests.py          Acesso só local, cabeçalhos de segurança e limites de envio
security/sessao_local.py            Sessão local por início do servidor (cookie exigido em /api/*)
security/limite_taxa.py             Limite por minuto nas rotas que gastam créditos ou abrem o Chrome
security/network.py                 Política de conexão da aplicação local
routers/transfers.py                Validação e geração da planilha de transferência
routers/inventory_history.py        Histórico, resolução e restauração de inventários
routers/equipment_search.py         Rotas de busca e estatísticas de equipamentos
routers/system.py                    Rotas de status e configuração do sistema
routers/units.py                     Rotas e esquema do catálogo de unidades
routers/operations.py                Chamados Simpress/Oracle e vínculos UTIC por OS
routers/assistant.py                 Rotas /api/assistente/* do chat do assistente (F9)
routers/automation.py                Rotas da aba Automação
routers/sebrae_dashboard.py          Importação do Dashboard e chamados novos do Sebrae
routers/inventory_update.py          Prévia, atualização e recarga dos inventários
routers/aliases.py                   Apelidos manuais e histórico de alterações
routers/dashboard.py                 Resumo somente leitura do painel da Home
routers/endpoint_lookup.py           Consultar no Endpoint e Controle remoto
routers/endpoint_removals.py         Hostnames duplicados do Endpoint removidos/restaurados
routers/entra_users.py               Importação e exportação dos nomes do Microsoft Entra
routers/local_setup.py               Importação dos modelos locais
routers/monthly_report.py            Relatório mensal (F8)
routers/transfer_history.py          Histórico local das transferências geradas
routers/frontend.py                  Política de cache das páginas e arquivos da interface
routers/equipment.py                 Leitura, edição e exportação de um equipamento
routers/coverage.py                  Cobertura de equipamentos (F10)
routers/backups_regionais.py         Backups regionais do Resumo (F3)
routers/lembretes.py                 Lembretes (Ferramentas)
routers/assinatura_tecnico.py        Assinatura do técnico nos PDFs dos Termos, só leitura
routers/outlook_mail.py              E-mails por modelo pelo Outlook
routers/ux_chamados.py / ux_ticket.py  Chamado e ticket UX
frontend/partials/                   Partes do static/index.html, montadas pelo servidor
static/                              Interface web, scripts e arquivos locais de estilo/fonte/ícone
static/js/features/                  Módulos da interface por funcionalidade
motor_ia/                            Pipeline experimental isolado, com testes próprios fora do npm run verify
scripts/build/copy_ui_assets.cjs           Cópia dos recursos locais para a interface
scripts/build/lucide-subset.cjs            Recorte dos ícones Lucide usados pela interface
scripts/bootstrap_environment.py     Criação do ambiente virtual e instalação das dependências fixadas
scripts/select_server_port.py        Reaproveita o servidor em execução ou escolhe uma porta livre
scripts/process_inventory_inbox.py   Processamento local da pasta de entrada dos inventários
scripts/migrate_local_data.py        Migração segura dos dados locais para data/
scripts/cleanup_local_temps.py       Limpeza conservadora de arquivos temporários locais
scripts/process_ticket_inbox.py      Processamento local imediato da fila de chamados Simpress/Oracle
scripts/automacao_rotinas_chrome.py  Rotinas do Chrome de automação (OS, inventários, Sebrae, Dashboard)
scripts/sebrae_leitura.py            Leitura no SoftExpert dos chamados que o Dashboard ainda não tem
scripts/sebrae_softexpert.py         Acesso ao SoftExpert usado pelas rotinas do Sebrae
scripts/sebrae_fechar.py             Finalização no SoftExpert dos chamados marcados FINALIZADO
scripts/sebrae_rotina.py             Liga a leitura do SoftExpert e o Excel Online à rotina do Sebrae
scripts/sebrae_excel.py              Camada de Excel Online da rotina "Sincronizar chamados Sebrae"
scripts/sebrae_sombra.py             Modo sombra: o modelo local sugere o tipo, sem influenciar a rotina
scripts/staged_computers_endpoint.py Procura no Endpoint Central os hostnames que sumiram do Endpoint
scripts/avisos_windows.py            Avisos do Windows (notificação) da automação das rotinas
scripts/verificar_usuarios_endpoint.py  Conferência das pendências de usuário logado no Endpoint
scripts/prepare_*_downloads.py       Publicação de downloads recentes nas pastas de entrada
scripts/check_update.py              Oferta de atualização para a tag publicada mais nova
scripts/check_secrets.py             Busca de credenciais em arquivos versionados
scripts/verify.cjs                   Verificação completa (npm run verify)
data/planilhas_entrada/               Modelo de transferência e planilhas locais
data/planilhas_entrada/_backups/      Cópias locais anteriores dos inventários
data/state/                           Estado e históricos locais, ignorados pelo Git
data/state/entrada_chamados/          Modelo e instruções versionados; lotes e recibos operacionais ignorados pelo Git
modelos/                              Modelo local de exportação de equipamentos
data/logs/                            Registros locais do servidor, ignorados pelo Git
docs/                                 Guias, operação, arquitetura, especificações do Cockpit e planos
tests/                                Testes Python e JavaScript
requirements.txt                     Dependências Python fixadas
package.json / package-lock.json     Dependências de desenvolvimento da interface
iniciar_servidor.bat                  Inicializador local para Windows
instalar_primeira_vez.bat             Instalação completa em uma máquina nova
executar_automacao.bat                Menu das rotinas do Chrome de automação
.env.example                          Modelo do .env do assistente (OpenRouter ou DeepSeek)
GLOSSARY.md                           Termos usados no projeto
```

## Índice da documentação

- [Manual do usuário](docs/guias/manual_usuario.md) (para operadores, sem linguagem técnica)
- [Glossário](GLOSSARY.md)
- [Contratos da API do backend](docs/arquitetura/CONTRATOS_API_BACKEND.md)
- [Nomes do Microsoft Entra](docs/operacao/nomes-entra-ui.md)
- [Assistente](docs/cockpit-prompts/15-assistente.md)
- [Cobertura de equipamentos](docs/cockpit-prompts/16-cobertura.md)
- [Home: e-mail pelo Outlook e chamado no UX](docs/cockpit-prompts/03-home-split-view.md)
- [Termos de entrega e devolução](docs/cockpit-prompts/17-termos.md)
- [Lembretes](docs/cockpit-prompts/18-lembretes.md)
- [Regras de cadastro e histórico](docs/operacao/regras-cadastro-historico.md)
- [Plano dos e-mails por modelo pelo Outlook](docs/planos/email-outlook-modelos.md)
- [Regras para agentes de desenvolvimento](docs/desenvolvimento/regras-agentes.md)
- [Relatório final da reorganização e refatoração](docs/desenvolvimento/relatorio-refatoracao-2026-10-12.md)
- [Revisão e correções pós integração](docs/desenvolvimento/revisao-refatoracao-frontend-2026-10-12.md)
- [Arquitetura e plano da refatoração](docs/arquitetura/analise-refatoracao-frontend.md)
- [Primeiro acesso](docs/guias/PRIMEIRO_ACESSO.md)
- [Versionamento e publicação de versões](docs/guias/versionamento.md)
- [Changelog](CHANGELOG.md)
- [Anotações do histórico](docs/operacao/ANOTACOES-HISTORICO.md)
- [Idempotência dos inventários](docs/operacao/idempotencia-atualizacao-inventario.md)
- [Atualização com um clique](docs/operacao/atualizacao-um-clique.md)
- [Automação pelo Chrome](docs/operacao/automacao-chrome.md)
- [Sincronizar chamados do Sebrae](docs/operacao/sincronizar-chamados-sebrae.md)
- [Relatório mensal](docs/operacao/relatorio-mensal.md)
- [Alertas de OS e divergências](docs/operacao/alertas-os-divergencias.md)
- [Especificações do Cockpit](docs/cockpit-prompts/README.md)
- [Microinterações e acessibilidade](docs/desenvolvimento/MICROINTERACOES.md)
- [Arquitetura e auditoria](docs/arquitetura/auditoria_arquitetura.md)
- [Auditoria do backend e situação do roteiro](docs/arquitetura/auditoria_backend/README.md)
- [Auditoria técnica de 17/10/2026](docs/arquitetura/auditoria_tecnica_2026-10-17.md)
- [Auditoria do backend de 13/11/2026](docs/arquitetura/auditoria_backend/auditoria_backend_2026-11-13.md)

As entradas `static/index.html`, `static/app.js` e `static/app.css` conservam os caminhos atuais e as alterações locais. Fontes de estilo ficam em `static/styles`, JavaScript em `static/js/{shared,ui,features}`, testes Node em `tests/frontend` e o servidor de fixtures em `tests/support`. A configuração e a segurança dos workbooks ficam em `core`; domínios, rotas e segurança conservam seus limites. Os scripts Python mantêm seus comandos públicos usados pelo inicializador e pelas filas locais.

## Dados e privacidade

O servidor atende somente `127.0.0.1` em uma porta local entre `8000` e `8099`. Os dados são persistidos em arquivos Excel/JSON locais, com acesso direto à aplicação no próprio computador. A documentação `/docs` só fica disponível com `SIMPRESS_ENABLE_DOCS=1`, e o log de acesso do servidor fica desligado para não registrar buscas por série ou hostname. Mensagens de exceção não entram no log, porque podem conter caminhos com o nome do usuário do Windows; as séries citadas no log aparecem como uma referência curta (`ref-...`). As páginas usam uma política de conteúdo que só permite scripts do próprio servidor, e todas as respostas trazem cabeçalhos que impedem a exibição dentro de outros sites. A API recusa chamadas que o navegador identifica como vindas de outro site. Toda chamada a `/api/` exige o cookie `simpress_sessao_<porta>` (`HttpOnly`, `SameSite=Strict`), criado ao abrir `/bootstrap?t=<segredo>`; o segredo muda a cada início do servidor e fica gravado em `%LOCALAPPDATA%\Simpress\sessao_<porta>.txt`. O navegador também o guarda no cookie e no histórico (o link `/bootstrap`). Sem o cookie, a resposta é 401.

Planilhas operacionais, backups, logs, exportações, históricos, apelidos e unidades personalizadas ficam no computador local e são ignorados pelo Git. O modelo vazio de transferência permanece versionado. Inclua os dados locais em uma rotina de backup apropriada se precisar preservá-los; não force a inclusão deles em commits nem compartilhe cópias com dados operacionais.

Algumas ações gravam ou enviam dados para fora do computador, sempre a partir de um clique seu (ou do cartão de confirmação do assistente):

- **Enviar ao SharePoint**: envia a cópia atualizada do Dashboard do Sebrae.
- **Finalizar no SoftExpert**: finaliza o chamado no SoftExpert, de forma irreversível; a rotina `fechar` também atualiza o Dashboard e o envia.
- Sincronização com o UX Simpress na exportação de equipamentos: grava apelidos no contrato 16467.
- **Controle remoto**: abre uma conexão com o computador escolhido pelo Endpoint Central.
- **Abrir chamado no UX** e ticket UX: enviam o chamado ou o ticket ao UX Simpress, só com confirmação (`SIMPRESS_UX_SEM_ENVIO=1` recusa o envio real).
- **Enviar pelo Outlook**: envia o e-mail do modelo pela conta do Outlook, só com confirmação (`SIMPRESS_OUTLOOK_SEM_ENVIO=1` recusa o envio real).
- Assistente (F9): envia texto, imagens e áudio ao OpenRouter ou ao DeepSeek e, com **Busca na web** ligada, a pesquisa à Exa (veja [Assistente (F9)](#assistente-f9)).

Arquivos operacionais que já foram versionados continuam recuperáveis no histórico Git local. As regras atuais de `.gitignore` impedem novos rastreamentos, mas não reescrevem o histórico existente.
