/// <reference types="vite/client" />
// O arranque (frontend/src/arranque/entrada.ts: utilitários, features de frontend/src/aplicacao, app.ts e melhorias de
// interface) entra primeiro: o ESM avalia as importações na ordem, então ele roda antes dos painéis (antes da react-final-3 era
// o módulo /static/app-entry.js, carregado antes deste bundle).
import "./arranque/entrada.ts";
import { modulos, type Acoes } from "./paineis";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

// Roda antes do DOMContentLoaded (módulo diferido). Painel migrado = pasta frontend/src/paineis/<painel>/ com
// montar.tsx; nenhum painel edita este arquivo. Cada montar(container) desenha o painel no elemento
// [data-react-painel="<painel>"] do partial e devolve as ações que a aplicação chama pela ponte
// (context.ponteReact em frontend/src/aplicacao/app.ts).
const registro: Record<string, Acoes> = {};
for (const [caminho, modulo] of Object.entries(modulos)) {
  const painel = caminho.split("/")[2];
  try {
    const container = document.querySelector<HTMLElement>(`[data-react-painel="${painel}"]`);
    if (!container) throw new Error(`Falta o elemento [data-react-painel="${painel}"] no HTML.`);
    registro[painel] = modulo.montar(container);
  } catch (erro) {
    // Erro dentro de montar() não derruba os outros painéis; a ponte dele rejeita com "O painel React ... não carregou."
    // Erro no topo de um montar.tsx (na importação, eager) derruba o bundle inteiro: todas as pontes rejeitam.
    console.error(erro);
  }
}
window.SimpressReact = Object.freeze(registro);
document.dispatchEvent(new CustomEvent("simpress:react-pronto"));

// Marca de vida: data-react-pronto no <html> depois do primeiro commit do React (testes e2e esperam por ela).
function MarcaDeVida() {
  useEffect(() => {
    document.documentElement.setAttribute("data-react-pronto", "");
  }, []);
  return null;
}

createRoot(document.createElement("div")).render(<MarcaDeVida />);
