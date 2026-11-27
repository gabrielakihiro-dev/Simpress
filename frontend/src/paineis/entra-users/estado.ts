// Estado da seção "Nomes do Microsoft Entra" (modal Atualizar planilhas), fora do componente: a aplicação
// chama carregarEstadoEntra pela ponte na inicialização, antes ou depois de o React desenhar a seção.
import { apiFetch } from "../../api";
import { baixarDaApi } from "../../comum/baixar-api";
import { lerEstado } from "../../estado-app";

interface Estado {
  status: string;
  exportar: boolean; // "Baixar XLSX compacto" só com nomes importados
  ocupado: boolean; // importação em andamento
}

interface ResumoEntra { updated_at?: string; users?: number; logins_ignorados?: number }
interface Equipamento { serial?: string }

// Ações da aplicação publicadas em window por frontend/src/aplicacao/app.ts (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  showToast(mensagem: string, tipo: string): void;
  definirEquipamentoAtual(equipamento: Equipamento): void;
  atualizarUsuarioLogadoCard(equipamento: Equipamento): void;
  carregarProntidao?(): void;
}
const app = () => window as unknown as AppAntigo;

let estado: Estado = { status: "Consultando cadastro…", exportar: false, ocupado: false };
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

const mensagem = (erro: unknown) => (erro instanceof Error ? erro.message : String(erro));

function resumoNomesEntra(data: ResumoEntra) {
  const texto = `${Number(data.users || 0).toLocaleString("pt-BR")} nomes PR importados.`;
  const ignorados = Number(data.logins_ignorados || 0);
  return ignorados > 0
    ? `${texto} ${ignorados.toLocaleString("pt-BR")} login(s) ignorado(s) por nomes conflitantes ou dados inválidos.`
    : texto;
}

export async function carregarEstadoEntra() {
  try {
    const data = await apiFetch<ResumoEntra>("/api/usuarios-entra/estado", { errorMessage: "Não foi possível consultar o cadastro Entra." });
    mudar({ status: data.updated_at ? resumoNomesEntra(data) : "Nenhum CSV do Entra importado.", exportar: Boolean(data.users) });
  } catch (erro) {
    mudar({ status: mensagem(erro) });
  }
}

export async function importarNomesEntra(evento?: { preventDefault?(): void }) {
  evento?.preventDefault?.();
  if (estado.ocupado) return;
  const input = document.getElementById("entra-csv-file") as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!input || !file) {
    app().showToast("Selecione o CSV exportado do Entra.", "warning");
    return;
  }
  mudar({ ocupado: true, status: "Validando e importando o CSV…" });
  const corpo = new FormData();
  corpo.append("file", file);
  try {
    const result = await apiFetch<ResumoEntra>("/api/usuarios-entra/importar", {
      method: "POST", body: corpo, errorMessage: "Não foi possível importar o CSV do Entra.",
    });
    mudar({ status: resumoNomesEntra(result), exportar: true });
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true })); // redesenha o seletor (frontend/src/ui/file-picker.ts)
    let refreshError: unknown = null;
    const serial = (lerEstado("currentEquipamento") as Equipamento | null)?.serial;
    if (serial) {
      const selectionRevision = lerEstado("equipamentoSelectionRevision");
      try {
        const fresh = await apiFetch<Equipamento>(`/api/equipamento/${encodeURIComponent(serial)}`);
        // Seleção trocada durante a consulta: não sobrescreve o equipamento mais novo.
        if (fresh?.serial && lerEstado("equipamentoSelectionRevision") === selectionRevision
          && (lerEstado("currentEquipamento") as Equipamento | null)?.serial === serial) {
          app().definirEquipamentoAtual(fresh);
          app().atualizarUsuarioLogadoCard(fresh);
        }
      } catch (erro) {
        refreshError = erro;
      }
    }
    if (refreshError) {
      mudar({ status: `${resumoNomesEntra(result)} Não foi possível atualizar o equipamento selecionado: ${mensagem(refreshError)}` });
      app().showToast("Nomes do Entra importados, mas não foi possível atualizar o equipamento selecionado.", "warning");
    } else {
      app().showToast("Nomes do Entra atualizados.", "success");
    }
    app().carregarProntidao?.();
  } catch (erro) {
    mudar({ status: mensagem(erro) });
    app().showToast(mensagem(erro), "error");
  } finally {
    mudar({ ocupado: false });
  }
}

// Por apiFetch (leva o X-Simpress-Sessao), sem navegar; a falha vira aviso na tela.
export async function exportarNomesEntra() {
  try {
    await baixarDaApi("/api/usuarios-entra/exportar", "Nomes_Entra_PR.xlsx", "Não foi possível baixar os nomes do Entra.");
  } catch (erro) {
    mudar({ status: mensagem(erro) });
    app().showToast(mensagem(erro), "error");
  }
}
