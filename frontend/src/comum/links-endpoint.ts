// Links do Endpoint Central (modal Atualizar planilhas e Comparação), marcados com data-endpoint-tela. /api/* exige o
// X-Simpress-Sessao, que um <a href> não leva: o clique pede a URL externa ao servidor (TELAS_ENDPOINT em
// routers/configuracao_local.py, lida a cada clique, então vale sem reiniciar) e a abre numa aba nova.
import { apiRota } from "../api.ts";

const FALHA = "Não foi possível abrir o Endpoint Central.";
const toast = (mensagem: string) => (window as unknown as { showToast?: (m: string, t: string) => void }).showToast?.(mensagem, "error");

export function abrirLinkEndpoint(evento: MouseEvent) {
  const link = (evento.target as Element | null)?.closest?.("[data-endpoint-tela]");
  if (!link || typeof (link as HTMLElement).dataset !== "object") return;
  evento.preventDefault();
  // A aba abre já no clique: depois do await o navegador pode tratá-la como pop-up e bloquear (servidor lento, Safari).
  const aba = window.open("", "_blank");
  if (!aba) return toast(FALHA);
  aba.opener = null;
  apiRota("GET /api/config/local/endpoint/{tela}", { caminho: { tela: (link as HTMLElement).dataset.endpointTela || "" }, errorMessage: FALHA })
    .then(({ url }) => {
      // Só endereço http(s) externo; o back já troca link inválido pelo padrão.
      if (/^https?:\/\//i.test(url)) return aba.location.replace(url);
      aba.close();
      toast(FALHA);
    })
    .catch((erro: unknown) => {
      aba.close();
      toast(erro instanceof Error ? erro.message : String(erro));
    });
}

// Fora do navegador (testes em Node) não há document. O clique do meio também passa por aqui: sem isso abriria /# do Simpress.
if (typeof document !== "undefined") {
  document.addEventListener("click", abrirLinkEndpoint);
  document.addEventListener("auxclick", evento => { if (evento.button === 1) abrirLinkEndpoint(evento); });
}
