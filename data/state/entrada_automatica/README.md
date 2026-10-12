# Entrada automática de planilhas

Para preparar o par recente de Downloads sem copiar ou extrair arquivos manualmente, registre o início antes das exportações e execute depois dos dois downloads:

```powershell
$inicioInventarios = (Get-Date).ToString("o")
# Faça as duas exportações no Chrome.
& .\.venv\Scripts\python.exe scripts\prepare_inventory_downloads.py --since $inicioInventarios
```

O preparador preserva os originais, extrai um único XLSX do ZIP, registra a origem e publica o par completo na fila. Exige arquivos posteriores ao início informado. O mesmo horário e par reutilizam o lote existente. Se o servidor estiver parado, execute `& .\.venv\Scripts\python.exe scripts\process_inventory_inbox.py`. A confirmação é o recibo `processadas/<lote>/_resultado.json` com `status: concluido`, junto do evento correspondente no histórico. Lotes em `falhas` têm recibo com o motivo.

O importador cria as pastas operacionais (`pendentes`, `processando`, `processadas` e `falhas`) ao iniciar. Para preparar um lote, copie `modelo_lote` para dentro de `pendentes`, dê à cópia um nome exclusivo e coloque um arquivo `.xlsx` em cada subpasta (`endpoint` e `simpress`).

Exemplo no PowerShell, a partir da raiz do projeto:

```powershell
$raiz = "data\state\entrada_automatica"
$lote = "2026-10-09_lote-001"
Copy-Item -Recurse "$raiz\modelo_lote" "$raiz\pendentes\$lote"
Copy-Item "C:\caminho\planilha-endpoint.xlsx" "$raiz\pendentes\$lote\endpoint\"
Copy-Item "C:\caminho\planilha-simpress.xlsx" "$raiz\pendentes\$lote\simpress\"
```

O nome da pasta do lote deve ser novo a cada importação. O importador aguarda os arquivos pararem de mudar e então valida e processa o par. Não é necessário renomear as planilhas nem criar um arquivo marcador. Os arquivos operacionais dentro da entrada ficam fora do Git.
