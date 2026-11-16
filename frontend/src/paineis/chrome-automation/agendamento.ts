// Agendamento do Dashboard: os controles ficam no cartão Sebrae, que é HTML estático (outro grupo da migração).
// Por isso este arquivo lê e escreve esses nós por id, como o módulo antigo fazia.
import { avisarErro, consultarAutomacao } from "./consulta";
import { formatarHora } from "./regras-puro";

interface Agendamento {
  ativo: boolean;
  intervalo_minutos?: number;
  proxima_execucao?: string | null;
  aviso?: string;
  bloqueio?: string;
  ultimo_disparo?: { resultado?: string } | null;
}

// Último estado confirmado pelo servidor; restaura os controles se o PUT falhar.
const confirmado = { ativo: false, intervalo: 30 };

const elementos = () => ({
  controle: document.getElementById("dashboard-agendamento-ativo") as HTMLInputElement | null,
  intervalo: document.getElementById("dashboard-agendamento-intervalo") as HTMLSelectElement | null,
  texto: document.getElementById("dashboard-agendamento-status"),
});

export async function carregarAgendamentoDashboard(): Promise<void> {
  const { controle, intervalo, texto } = elementos();
  if (!controle || !intervalo || !texto) return;
  try {
    const dados = await consultarAutomacao<Agendamento>("/api/automacao/dashboard/agendamento", { errorMessage: "Não foi possível consultar o agendamento." });
    confirmado.ativo = dados.ativo;
    confirmado.intervalo = dados.intervalo_minutos || 30;
    controle.checked = confirmado.ativo;
    intervalo.value = String(confirmado.intervalo);
    texto.textContent = (dados.ativo ? `Ativo. Próxima tentativa: ${formatarHora(dados.proxima_execucao)}.` : "Pausado.")
      + ` ${dados.aviso}` + (dados.bloqueio ? ` ${dados.bloqueio}` : "") + (dados.ultimo_disparo ? ` Última tentativa: ${dados.ultimo_disparo.resultado}.` : "");
  } catch (erro) {
    texto.textContent = (erro as Error).message;
  }
}

export async function alterarAgendamentoDashboard(): Promise<void> {
  const { controle, intervalo } = elementos();
  if (!controle || !intervalo) return;
  const ativo = controle.checked;
  const intervaloMinutos = Number(intervalo.value);
  controle.disabled = intervalo.disabled = true;
  try {
    await consultarAutomacao("/api/automacao/dashboard/agendamento", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ativo, intervalo_minutos: intervaloMinutos }),
      errorMessage: "Não foi possível alterar o agendamento.",
    });
  } catch (erro) {
    controle.checked = confirmado.ativo;
    intervalo.value = String(confirmado.intervalo);
    avisarErro(erro);
  } finally {
    controle.disabled = intervalo.disabled = false;
    await carregarAgendamentoDashboard();
  }
}
