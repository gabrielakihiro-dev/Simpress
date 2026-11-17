// Publica o despachante de data-on-* em window e o liga no document. Primeiro item de entrada.ts:
// as ações das features só entram na lista fechada depois, quando app.ts chama allow().
import { EVENTS, allow, dispatch, install, resolveArgs } from "../ui/action-dispatcher.ts";

window.SimpressActionDispatcher = { EVENTS, allow, dispatch, install, resolveArgs };
install(document, window);
