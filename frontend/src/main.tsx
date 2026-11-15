import { useEffect } from "react";
import { createRoot } from "react-dom/client";

// Roda depois de /static/app-entry.js (os dois são módulos diferidos, nessa ordem no HTML).
// Ainda não há painel migrado: a marca de vida é renderizada num elemento fora da página,
// então a tela não muda, mas o React roda de verdade sob o CSP.
function MarcaDeVida() {
  useEffect(() => {
    document.documentElement.setAttribute("data-react-pronto", "");
  }, []);
  return null;
}

createRoot(document.createElement("div")).render(<MarcaDeVida />);
