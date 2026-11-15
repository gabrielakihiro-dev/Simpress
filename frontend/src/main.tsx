/// <reference types="vite/client" />
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

// Roda depois de /static/app-entry.js (os dois são módulos diferidos, nessa ordem no HTML) e antes do
// DOMContentLoaded. Painel migrado = pasta frontend/src/paineis/<painel>/ com montar.tsx; nenhum painel
// edita este arquivo. Cada montar(container) desenha o painel no elemento [data-react-painel="<painel>"]
// do partial e devolve as ações que o código antigo chama pela ponte (context.ponteReact em static/app.js).
type Acoes = Record<string, (...args: never[]) => unknown>;
interface ModuloPainel {
  montar(container: HTMLElement): Acoes;
}

const modulos = import.meta.glob<ModuloPainel>("./paineis/*/montar.tsx", { eager: true });
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
