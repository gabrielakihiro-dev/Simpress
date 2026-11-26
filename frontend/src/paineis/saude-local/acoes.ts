// Ações do modal Saúde local, chamadas pela ponte (frontend/src/aplicacao/pontes.ts) e pelos data-on-click do corpo.
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchError } from "../../api";
import { ler, mudar, formatarBytes, plural, type Aviso, type Limpeza, type SaudeLocal } from "./estado";

interface AppLegado {
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string }): Promise<boolean>;
}
const app = () => window as unknown as AppLegado;

const MODAL_ID = "modal-saude-local";
const BOTAO_ID = "btn-saude-local";
const CABECALHO_JSON = { "Content-Type": "application/json" };

// Segunda linha de cada recusa 409 (detail.codigo); a primeira é a mensagem do servidor, exata.
const SEGUNDA_LINHA: Record<string, string> = {
  chrome: "Espere a rotina terminar e tente de novo.",
  importacao: "Espere a importação terminar e tente de novo.",
  transacoes: "Reinicie o servidor local para recuperar as gravações interrompidas.",
  limpeza_em_andamento: "Aguarde e veja a prévia de novo.",
  migracao: "Espere a migração terminar e tente de novo.",
};

let abrindo = false;

function avisoDeErro(error: unknown, fallback: string): Aviso {
  const { status, detail } = error as Partial<ApiFetchError>;
  if (status === 409 && detail && typeof detail === "object") {
    const { codigo, mensagem } = detail as { codigo?: unknown; mensagem?: unknown };
    if (typeof mensagem === "string" && mensagem) {
      return { titulo: mensagem, detalhe: (typeof codigo === "string" && SEGUNDA_LINHA[codigo]) || "", tipo: "alerta" };
    }
  }
  return { titulo: fallback, detalhe: "Tente de novo; se continuar, reinicie o servidor local.", tipo: "erro" };
}

const lerSaude = () => apiFetch<SaudeLocal>("/api/saude-local", { errorMessage: "Não foi possível ler a saúde local." });

export async function abrirSaudeLocal(): Promise<void> {
  if (abrindo || ler().ocupado) return;
  abrindo = true;
  try {
    try {
      const saude = await lerSaude();
      // Desenha antes de abrir: abrirModalAcessivel procura o foco no DOM.
      flushSync(() => mudar({ saude, previa: null, resultado: null, avisoLimpeza: null, avisoDiagnostico: null, carga: "", cargaErro: false }));
    } catch {
      flushSync(() => mudar({ saude: null, cargaErro: true, carga: "Não foi possível ler a saúde local." }));
    }
    app().abrirModalAcessivel(MODAL_ID, "#titulo-saude-local", "fecharSaudeLocal");
  } finally {
    abrindo = false;
  }
}

export function fecharSaudeLocal(): void {
  app().fecharModalAcessivel(MODAL_ID);
  // A Prontidão se redesenha (foco da janela, 45 s) e pode ter trocado o botão.
  requestAnimationFrame(() => document.getElementById(BOTAO_ID)?.focus());
}

async function comTrava(tarefa: () => Promise<void>): Promise<void> {
  if (ler().ocupado) return;
  mudar({ ocupado: true });
  document.getElementById(MODAL_ID)?.setAttribute("aria-busy", "true");
  try {
    await tarefa();
  } finally {
    mudar({ ocupado: false });
    document.getElementById(MODAL_ID)?.removeAttribute("aria-busy");
  }
}

export function atualizarSaudeLocal(): Promise<void> {
  return comTrava(async () => {
    try {
      mudar({ saude: await lerSaude(), previa: null, resultado: null, avisoLimpeza: null, carga: "", cargaErro: false });
    } catch {
      mudar({ saude: null, cargaErro: true, carga: "Não foi possível ler a saúde local." });
    }
  });
}

export function previaLimpezaSaudeLocal(): Promise<void> {
  return comTrava(async () => {
    try {
      const previa = await apiFetch<Limpeza>("/api/saude-local/limpeza/previa", {
        method: "POST", headers: CABECALHO_JSON, body: "{}", errorMessage: "Não foi possível gerar a prévia da limpeza.",
      });
      mudar({ previa, resultado: null, avisoLimpeza: null });
    } catch (error) {
      mudar({ previa: null, resultado: null, avisoLimpeza: avisoDeErro(error, "Não foi possível gerar a prévia da limpeza.") });
    }
  });
}

function textoConfirmacao({ totais }: Limpeza): string {
  const partes: string[] = [];
  if (totais.remover_arquivos) partes.push(`${plural(totais.remover_arquivos, "arquivo", "arquivos")} (${formatarBytes(totais.remover_bytes)}) ${totais.remover_arquivos === 1 ? "será removido" : "serão removidos"}`);
  if (totais.quarentena_arquivos) partes.push(`${totais.quarentena_arquivos} (${formatarBytes(totais.quarentena_bytes)}) irá para a quarentena`);
  return `${partes.join(" e ")}. A regra é conferida de novo na hora; o resultado pode ser menor que a prévia.`;
}

export async function limparSaudeLocal(): Promise<void> {
  const { previa, ocupado } = ler();
  if (ocupado || !previa?.itens.length) return;
  const confirmou = await app().confirmarAcao({ titulo: "Limpar temporários?", mensagem: textoConfirmacao(previa), confirmar: "Limpar agora" });
  if (!confirmou) return;
  await comTrava(async () => {
    try {
      const resultado = await apiFetch<Limpeza>("/api/saude-local/limpeza", {
        method: "POST", headers: CABECALHO_JSON, body: JSON.stringify({ confirmado: true }), errorMessage: "Não foi possível concluir a limpeza.",
      });
      mudar({ resultado, previa: null, avisoLimpeza: null });
      // Os números por área mudaram; se a releitura falhar, o resultado da limpeza continua na tela.
      lerSaude().then(saude => mudar({ saude })).catch(() => undefined);
    } catch (error) {
      mudar({ previa: null, resultado: null, avisoLimpeza: avisoDeErro(error, "Não foi possível concluir a limpeza.") });
    }
  });
}

// O cookie de sessão só vai pelo fetch: baixa o JSON como blob e entrega por um link temporário.
export function baixarDiagnosticoSaudeLocal(): Promise<void> {
  return comTrava(async () => {
    try {
      const resposta = await apiFetch("/api/saude-local/diagnostico", { responseType: "response", errorMessage: "Não foi possível gerar o pacote de diagnóstico." });
      const nome = /filename="([\w.-]+)"/.exec(resposta.headers.get("Content-Disposition") || "")?.[1] || "diagnostico-simpress.json";
      const url = URL.createObjectURL(await resposta.blob());
      const link = Object.assign(document.createElement("a"), { href: url, download: nome });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      mudar({ avisoDiagnostico: null });
    } catch {
      mudar({ avisoDiagnostico: { titulo: "Não foi possível gerar o pacote de diagnóstico.", detalhe: "Tente de novo; se continuar, reinicie o servidor local.", tipo: "erro" } });
    }
  });
}

