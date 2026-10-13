# Idempotência na atualização local de inventário

O POST `/api/planilhas/atualizar` aceita uma única `Idempotency-Key` com 1 a 128 caracteres ASCII dentre letras, números, ponto, hífen, dois-pontos e sublinhado (`[A-Za-z0-9._:-]`). Chave ausente mantém o comportamento existente; importações automáticas continuam identificadas pelo `lote_id` próprio.

A identidade do pedido é o SHA-256 dos bytes que serão gravados, enquadrados pelo papel fixo de cada fonte: `endpoint` e `detalhes`. Nomes de arquivo e ordem das partes multipart não participam do hash. Para um ZIP Simpress, são usados os bytes do XLSX validado e extraído, que são os bytes aplicados ao inventário.

Os arquivos ativos, backups, histórico, pendências de anotação e comprovante da chave são confirmados na mesma transação recuperável. O comprovante fica em `data/state/inventory_update_idempotency.json` e guarda a chave, o hash e a resposta confirmada. Uma repetição com chave e hash iguais recebe essa resposta. A mesma chave com hash diferente recebe HTTP 409. Se a transação não confirmar, o comprovante não é gravado e a tentativa pode ser repetida; se a confirmação ocorrer e a resposta se perder, o comprovante permite recuperar o resultado após reiniciar o processo.

São retidos os **256 comprovantes confirmados mais recentes**, em ordem FIFO de confirmação. Não há expiração por data: quando uma chave sai dessa janela, uma repetição dela é tratada como uma operação nova e pode criar outro evento e backup. A proteção após reinício vale enquanto o comprovante permanecer nessa janela.
