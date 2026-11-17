// Monta o contexto, publica as ações das features e inicia a página (frontend/src/aplicacao/app.ts).
// Fica num módulo próprio para a ordem de entrada.ts decidir quando isso roda; os testes chamam iniciar() direto.
import { iniciar } from "../aplicacao/app.ts";

iniciar(window);
