import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { PainelChamados, type Alvos } from "./painel";
import {
  assinar, atualizarChamadosAbertosHome, excluirImportacoesAntigasChamadosCockpit, exportarChamadosCockpit, ler,
  selecionarVersaoChamadosCockpit, sincronizarGestaoChamadosCockpit, type Estado,
} from "./estado";

function elemento(id: string): HTMLElement {
  const achado = document.getElementById(id);
  if (!achado) throw new Error(`Falta o elemento #${id} no HTML do painel Chamados.`);
  return achado;
}

// Chamado por frontend/src/main.tsx com a div.ckp-recolher__corpo de "Importação e versões" (data-react-painel="cockpit-chamados").
// O código antigo (frontend/src/legado/features/cockpit-chamados.js) chama as ações pela ponte; abrirGestaoChamadosCockpit e
// abrirChamadoSebraeNoF5 ficam lá, em DOM puro e síncronas.
export function montar(container: HTMLElement) {
  const alvos: Alvos = {
    versao: elemento("cockpit-tickets-manage-version"),
    contagemHome: elemento("home-open-tickets-count"),
    corpoHome: elemento("home-open-tickets-body"),
  };
  // O portal só acrescenta filhos: tira o "Nenhuma importação" estático antes, para o React ser o único dono do texto.
  alvos.versao.replaceChildren();

  // Fora do container, no HTML do Cockpit: o botão Exportar Excel (habilitado e com texto de espera) e o aria-busy da
  // lista da Home. Atributo não vem de portal, e aria-busy precisa mudar junto com o conteúdo, por isso síncrono.
  const exportar = document.getElementById("cockpit-tickets-export") as HTMLButtonElement | null;
  const sincronizarFora = ({ exportando, versao, home }: Estado) => {
    if (exportar) {
      exportar.disabled = exportando || !versao;
      const texto = exportando ? "Preparando Excel…" : "Exportar Excel";
      if (exportar.textContent !== texto) exportar.textContent = texto;
    }
    if (home.tipo !== "inicial") alvos.corpoHome.setAttribute("aria-busy", home.tipo === "carregando" ? "true" : "false");
  };
  assinar(() => sincronizarFora(ler()));
  sincronizarFora(ler());

  // flushSync: os campos de arquivo existem já na volta de montar (abrirGestaoChamadosCockpit foca o primeiro).
  const raiz = createRoot(container);
  flushSync(() => raiz.render(<PainelChamados alvos={alvos} />));

  return {
    sincronizarGestaoChamadosCockpit, selecionarVersaoChamadosCockpit, excluirImportacoesAntigasChamadosCockpit,
    exportarChamadosCockpit, atualizarChamadosAbertosHome,
  };
}
