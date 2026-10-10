# Entrada automática de planilhas

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
