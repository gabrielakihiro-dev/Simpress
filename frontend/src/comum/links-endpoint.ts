// Links do Endpoint Central (modal Atualizar planilhas e Comparação), marcados com data-endpoint-tela. /api/* exige o
// X-Simpress-Sessao, que um <a href> não leva: o clique pede a URL externa ao servidor (TELAS_ENDPOINT em
// routers/configuracao_local.py, lida a cada clique, então vale sem reiniciar) e abre numa aba nova.
import { apiRota } from "../api.ts";

const toast = (mensagem: string) => (window as unknown as { showToast?: (m: string, t: string) => void }).showToast?.(mensagem, "error");

// Fora do navegador (testes em Node) não há document.
if (typeof document !== "undefined") document.addEventListener("click", evento => {
  const link = (evento.target as Element | null)?.closest?.("[data-endpoint-tela]");
  if (!link || typeof (link as HTMLElement).dataset !== "object") return;
  evento.preventDefault();
  apiRota("GET /api/config/local/endpoint/{tela}", { caminho: { tela: (link as HTMLElement).dataset.endpointTela || "" }, errorMessage: "Não foi possível abrir o Endpoint Central." })
    .then(({ url }) => {
      // Só endereço http(s) externo; o back já troca link inválido pelo padrão.
      if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
      else toast("Não foi possível abrir o Endpoint Central.");
    })
    .catch((erro: unknown) => toast(erro instanceof Error ? erro.message : String(erro)));
});
