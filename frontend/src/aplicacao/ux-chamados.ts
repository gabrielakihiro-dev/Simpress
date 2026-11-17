/**
 * Modal "Abrir chamado no UX" (Home): prepara uma sessão, depois simula ou envia com confirmação.
 * Migrado para React no Dia 2 (G4): o modal vive em frontend/src/paineis/ux-chamados/.
 * Este módulo é só a ponte que mantém as ações publicadas para o código antigo.
 */
import { registrarRejeicoes } from "./pontes.ts";
import type { Acoes, ContextoApp } from "./tipos.ts";

export function createUxChamados(context: ContextoApp): Acoes {
  const ponte = context.ponteReact("ux-chamados", [
    "abrirChamadoUX", "fecharChamadoUX", "atualizarProblemaChamadoUX", "conferirChamadoUX", "executarChamadoUX",
  ]);

  // Quem chama (data-on-*, fechar do modal, troca de equipamento) não trata erro: como no módulo antigo, nunca rejeita.
  const registrada = registrarRejeicoes(ponte);

  // O Assistente lê o contexto sem await (assistant-chat.ts): continua síncrono; antes de o React montar, undefined.
  const contextoChamadoUX = () => window.SimpressReact?.["ux-chamados"]?.contextoChamadoUX();

  return { ...registrada, contextoChamadoUX };
}
