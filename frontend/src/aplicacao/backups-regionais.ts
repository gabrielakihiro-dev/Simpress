/**
 * Resumo (F3), sub-aba Backups: migrada para React em frontend/src/paineis/backups-regionais/
 * (painel #resumo-painel-backups, data-react-painel="backups-regionais"). Aqui só fica o pedido do painel a cada
 * 5 min: ele atualiza todos os alertas do sino, não só Backups, e não pode depender do bundle React carregar.
 * Também guarda o último painel lido: paineis-dados (paineis.ts) lê o painel no import, às vezes antes de o bundle montar o painel,
 * e a ponte o repete (repetirPainel) quando o bundle carrega. Ninguém de fora chama este módulo; ele continua em
 * FEATURE_ORDER (frontend/src/aplicacao/app.ts).
 */
import type { Acoes, ContextoApp, Qualquer } from "./tipos.ts";

export function createBackupsRegionais(context: ContextoApp): Acoes {
  const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;

  if (typeof document !== "undefined") {
    const ultimo: Qualquer = {};
    document.addEventListener("simpress:painel-atualizado", (evento: Qualquer) => { ultimo.painel = evento.detail; });
    document.addEventListener("simpress:painel-indisponivel", () => { ultimo.indisponivel = true; });
    context.ponteReact("backups-regionais", ["repetirPainel"]).repetirPainel(ultimo)
      .catch((erro: Qualquer) => { console.error(`repetirPainel: ${erro?.message}`); });
  }

  // Cartão do sino e sub-aba ficam em dia sem ação do usuário: pede o painel a cada 5 min, só com a aba visível
  // (importações e abrir o sino já pedem atualização por conta própria).
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    window.setInterval(() => {
      if (!document.hidden) document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));
    }, INTERVALO_ATUALIZACAO_MS);
  }

  return {};
}
