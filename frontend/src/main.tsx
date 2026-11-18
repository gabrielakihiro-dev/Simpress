/// <reference types="vite/client" />
// O arranque (frontend/src/arranque/entrada.ts: utilitários, features de frontend/src/aplicacao, app.ts e melhorias de
// interface) entra primeiro: o ESM avalia as importações na ordem, então ele roda antes dos painéis (antes da react-final-3 era
// o módulo /static/app-entry.js, carregado antes deste bundle).
import "./arranque/entrada.ts";
import { modulos, modulosSobDemanda, type Acoes } from "./paineis";
import { useEffect } from "react";
import { flushSync } from "react-dom";
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

// Painéis sob demanda (lista em frontend/src/paineis.ts): a ponte chama SimpressReactSobDemanda[painel]() na primeira ação,
// que baixa o arquivo do painel, monta e devolve as ações. A montagem fica guardada (erro no montar() também, como na
// partida); só a falha ao baixar o arquivo tenta de novo na próxima ação. flushSync: a ação roda logo depois e acha o DOM do painel já desenhado, como quando ele montava na partida.
const montados = new Map<string, Promise<Acoes>>();
const sobDemanda: Record<string, () => Promise<Acoes>> = {};
for (const [caminho, carregar] of Object.entries(modulosSobDemanda)) {
  const painel = caminho.split("/")[2];
  sobDemanda[painel] = () => {
    if (!montados.has(painel)) {
      const montagem = carregar()
        .catch(erro => { montados.delete(painel); throw erro; })
        .then(modulo => {
          const container = document.querySelector<HTMLElement>(`[data-react-painel="${painel}"]`);
          if (!container) throw new Error(`Falta o elemento [data-react-painel="${painel}"] no HTML.`);
          let acoes: Acoes = {};
          flushSync(() => { acoes = modulo.montar(container); });
          return acoes;
        });
      montagem.catch(erro => console.error(erro));
      montados.set(painel, montagem);
    }
    return montados.get(painel) as Promise<Acoes>;
  };
}
window.SimpressReactSobDemanda = Object.freeze(sobDemanda);
document.dispatchEvent(new CustomEvent("simpress:react-pronto"));

// Marca de vida: data-react-pronto no <html> depois do primeiro commit do React (testes e2e esperam por ela).
function MarcaDeVida() {
  useEffect(() => {
    document.documentElement.setAttribute("data-react-pronto", "");
  }, []);
  return null;
}

createRoot(document.createElement("div")).render(<MarcaDeVida />);
