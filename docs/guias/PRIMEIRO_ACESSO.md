# Primeiro acesso após clonar

Estas instruções se aplicam ao modo padrão de arquivos locais.

1. Depois do `git clone`, execute `iniciar_servidor.bat`. O inicializador prepara o ambiente e inicia o servidor mesmo sem os inventários operacionais.
2. Acesse o endereço informado pelo inicializador, normalmente `http://localhost:8000`. Clonar o repositório, sozinho, não inicia o servidor. Se a porta estiver ocupada, o inicializador pode informar outra porta.
3. O painel de disponibilidade abre automaticamente quando há pendências. A base começa com zero equipamentos e a mensagem **Base ainda não importada**.
4. Use os botões de importação em **Funções**. Após cada importação, os indicadores e a disponibilidade são atualizados sem reiniciar o servidor.

## Arquivos por função

| Função | O que importar |
| --- | --- |
| Consulta de equipamentos | O par de inventários Simpress e Endpoint |
| Comparação e atualização | O mesmo par de inventários |
| Geração de transferência | Inventários e modelo com o layout oficial de transferência |
| Exportação de equipamentos | Inventários e modelo com colunas de série e apelido e o mesmo conjunto de séries da base ativa |
| Chamados (`Importar e gerenciar`) | O par de exportações de chamados Simpress e Oracle |

O inventário Simpress aceita `.xlsx` ou o ZIP original com exatamente uma planilha `.xlsx`. Envie a exportação completa de 50 colunas, incluindo o CNPJ de instalação. O Endpoint aceita `.xlsx`. Os dois inventários são obrigatórios também na primeira carga. Cada envio de inventário ou modelo e a planilha extraída do ZIP podem ter até 60 MB; chamados também aceitam até 60 MB por arquivo.

O ZIP é lido em memória, sem extrair caminhos para o computador. Arquivos com senha, múltiplas planilhas candidatas, caminhos inválidos ou conteúdo acima dos limites são recusados. A planilha interna passa pela mesma validação do envio direto em XLSX.

## Disponibilidade e substituições

- **Aguardando importação**: faltam arquivos necessários. Os catálogos e históricos locais podem começar vazios.
- **Arquivo inválido**: o arquivo existe, mas a estrutura, o layout ou uma dependência não atende à função. Confira o detalhe em **Arquivos locais**.
- **Disponível**: os arquivos foram validados e as dependências estão prontas. A transferência também precisa da base carregada e de localidades catalogadas.

Os botões continuam acessíveis nos detalhes depois da configuração, permitindo substituir arquivos. O painel começa recolhido quando todas as funções estão disponíveis; atualizar o status respeita a abertura ou o fechamento escolhido pelo usuário.

O modelo de transferência versionado continua intacto. Uma importação pela tela cria a preferência local em `data/planilhas_entrada/_modelos/transferencia.xlsx`; quando existe, esse modelo passa a ser usado na geração. O modelo de exportação fica em `modelos/EquipamentosDetalhes-exportacao.xlsx`.

Substituições dos modelos importados guardam a cópia anterior em `data/planilhas_entrada/_backups/modelos/`. A gravação usa uma transação recuperável. Um envio inválido ou uma falha de gravação preserva o arquivo anterior. Os modelos operacionais e backups ficam fora do Git. Para restaurar uma cópia, selecione o arquivo do backup no mesmo importador de modelo.

Chamados passam a ficar disponíveis após uma importação válida, inclusive quando os arquivos não contêm chamados. Não é necessário importar JSON de histórico ou de catálogos para começar. As regras existentes de histórico, anotações e sincronização continuam em uso.

## Testes

Os testes de primeiro acesso em `tests/test_first_access.py` usam arquivos sintéticos e caminhos temporários, incluindo os dois serviços de entrada automática e as anotações compartilhadas. Os testes de navegador em `tests/e2e/first-access.spec.cjs` usam o frontend real e respostas fictícias para conferir os botões, os estados, o comportamento em celular e a acessibilidade. A validação e a gravação reais são exercitadas pelos testes Python, incluindo as rotas HTTP quando a dependência opcional `httpx` está instalada.
