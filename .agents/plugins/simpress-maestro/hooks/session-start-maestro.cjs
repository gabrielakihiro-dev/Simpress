#!/usr/bin/env node
// Hook SessionStart do Antigravity (plano AI Pro): injeta uma unica vez por sessao
// as regras de esforco/modelo (Hydrogen, Neon e Carbon; sem Flash nem 3.1 Pro),
// delegacao Maestro, /swarm, revisao pre-PR, abertura automatica de #PR e #CI.
"use strict";

function buildOutput() {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage:
            "Simpress Maestro (AI Pro — use exclusivamente Hydrogen, Neon e Carbon): " +
            "1) No inicio de toda sessao nova (exceto subagente ou se o usuario ja especificou), " +
            "classifique a complexidade e pergunte via ask_question o par Esforco/Modelo: " +
            "Low — Hydrogen, Medium — Hydrogen, High — Hydrogen, High — Neon, xHigh — Carbon, " +
            "colocando a recomendada primeiro com '(Recommended)'. " +
            "2) Resolva tarefas de 1 arquivo/busca/comando direto; para tarefas maiores, delegue com invoke_subagent(..., Model='inherit') " +
            "ou via /swarm (swarm-simpress) escolhendo exclusivamente Hydrogen (Low: batedor, leitor-logs, conferente-glossario, auditor-dependencias, testador-acessibilidade; " +
            "Medium/High para execucoes diretas como Sonnet: executor, testador, testador-e2e, depurador, front-react, refatorador, documentador, segunda-opiniao), " +
            "Neon (Medium/High para /advisor antes de concluir, sintese, arquitetura e seguranca; High: revisor, implementador, auditor-seguranca, 1a passagem do arquiteto) " +
            "e Carbon (High/xHigh para arquiteto/impasse somente quando o Neon nao resolver). " +
            "3) Ponytail /review obrigatorio antes de abrir #PR: passe o diff pela revisao (Neon Medium para mudanca enxuta ou Neon High para complexa/critica via revisor) e corrija 'Corrigir antes'. " +
            "4) Em entregas prontas e verificadas (npm run verify verde) em branch de worktree, " +
            "faca commit, push e abra #PR automaticamente (gh pr create) sem pedir, acompanhe a #CI da #PR ate ficar verde, " +
            "faca o merge (gh pr merge) respeitando a fila numerica (gh pr list --state open) e depois git pull na main do checkout principal.",
        },
      },
    ],
  };
}

function main() {
  process.stdin.resume();
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify(buildOutput()) + "\n");
  });
}

if (require.main === module) main();

module.exports = { buildOutput };
