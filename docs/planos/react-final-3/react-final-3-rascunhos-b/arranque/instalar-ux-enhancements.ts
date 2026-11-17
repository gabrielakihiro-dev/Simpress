// Liga as melhorias de interface (frontend/src/ui/ux-enhancements.ts) na página; carrega depois de app.ts.
import { install } from "../ui/ux-enhancements.ts";

if (window.document) install(window);
