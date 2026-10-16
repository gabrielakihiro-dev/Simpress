# Entrada automática de chamados

O importador cria as pastas operacionais (`pendentes`, `processando`, `processadas` e `falhas`) ao iniciar o servidor local em modo de arquivos. Para preparar um lote, copie `modelo_lote` para `pendentes`, dê à cópia um nome exclusivo e coloque um `.xlsx` em cada subpasta: `simpress` para **Acompanhamento de Pedidos** e `oracle` para **Gestão de Solicitações**.

Exemplo no PowerShell, a partir da raiz do projeto:

```powershell
$raiz = "data\state\entrada_chamados"
$lote = "2026-10-10_os-simpress"
Copy-Item -Recurse "$raiz\modelo_lote" "$raiz\pendentes\$lote"
Copy-Item "C:\caminho\Acompanhamento_de_pedidos.xlsx" "$raiz\pendentes\$lote\simpress\"
Copy-Item "C:\caminho\Gestao_de_Solicitacoes.xlsx" "$raiz\pendentes\$lote\oracle\"
```

O lote precisa ter um nome exclusivo. O importador espera que os dois arquivos permaneçam estáveis em duas verificações consecutivas e então usa a mesma reconciliação, validação, histórico e anotação da importação pela tela, sem tráfego HTTP. Cada subpasta deve conter exatamente um `.xlsx`, com até 60 MB. O lote importado é movido inteiro para `processadas`; recusas vão para `falhas` com `_resultado.json`. Os arquivos não são apagados e os lotes processados permanecem no disco para auditoria.

Com o servidor em execução, o processamento ocorre automaticamente em até cerca de 20 segundos. Para processar imediatamente ou quando o servidor não estiver ativo, execute `& .\.venv\Scripts\python.exe scripts\process_ticket_inbox.py` na raiz do projeto. O comando usa a mesma rotina local e não envia requisições HTTP.

Lotes interrompidos em `processando` são recuperados na inicialização. O identificador é gravado junto ao histórico para impedir reimportação após uma interrupção. Para usar outra raiz, defina `SIMPRESS_TICKET_IMPORT_INBOX_DIR` antes de iniciar o servidor. A entrada é local ao modo de arquivos e não inicia no backend PostgreSQL.
