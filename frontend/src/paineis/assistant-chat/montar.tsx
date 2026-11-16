import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { acoes, iniciar } from "./estado";
import { Painel } from "./painel";

// Monta o painel sob a <section id="assistente-widget"> e devolve as ações que a ponte (static/js/features/assistant-chat.js) expõe.
export function montar(container: HTMLElement) {
  const root = createRoot(container);
  flushSync(() => root.render(<Painel />));
  iniciar(container);
  return { ...acoes };
}
