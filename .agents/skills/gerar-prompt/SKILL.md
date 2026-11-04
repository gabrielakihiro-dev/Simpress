---
name: gerar-prompt
description: Gerar prompt para analisar ou melhorar algo no Simpress com a seleção exata de arquivos e pastas, para economizar tokens. Use quando o usuário pedir um prompt (front-end, back-end, testes, infraestrutura ou regras de negócio).
---

# Gerar prompt

- Liste os arquivos e pastas específicos e estritamente necessários ao escopo do prompt.
- Indique o que nunca deve ser enviado: `node_modules`, `.venv`, pastas de cache, planilhas binárias de dados, arquivos compilados ou grandes que não agregam ao contexto.
- Fatie o prompt por camada, módulo ou etapa quando o contexto puder estourar cotas ou diluir a atenção do modelo.
