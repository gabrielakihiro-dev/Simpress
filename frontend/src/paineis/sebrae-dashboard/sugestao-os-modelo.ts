// Regras puras da "OS nova sugerida" do F5 (textos, chips, corpos de PUT). Fica fora do .tsx para que estado.ts e os testes
// em node leiam este arquivo sem transformar JSX. Contrato do servidor: `abertos[].os_nova` de GET /api/sebrae/novos.
import type { OsNova, TextosOs } from "./tipos";

export const DESCRICAO_INDISPONIVEL = "Descrição não disponível";
export const SELO_OS_NOVA = "OS nova?";
export const URL_VINCULOS_OS = "/api/operacoes/chamados/vinculos-os";

/** Só `sugestao` e `sem_os` esperam decisão; `troca` já foi feita pelo servidor e só mostra a nota verde. */
export function pedeDecisao(osNova: OsNova | null | undefined): osNova is OsNova {
  return Boolean(osNova) && osNova?.tipo !== "troca";
}

/** Campo OS do cartão aberto: "7303022 mais nova: 7400000?" ou "sem OS sugerida: 7400000?" (a OS atual é o botão que o painel já desenha). */
export function legendaCampoOs(osNova: OsNova) {
  return osNova.tipo === "sem_os"
    ? { semOs: true, legenda: "sugerida:", sugerida: `${osNova.nova.os}?` }
    : { semOs: false, legenda: "mais nova:", sugerida: `${osNova.nova.os}?` };
}

export function tituloCaixa(osNova: OsNova) {
  return osNova.tipo === "sem_os"
    ? `OS encontrada para este chamado: ${osNova.nova.os}`
    : `OS mais nova na mesma série: ${osNova.nova.os}`;
}

export function explicacaoCaixa(osNova: OsNova) {
  return osNova.tipo === "sem_os"
    ? "A série do chamado não tem OS, então a OS espera a sua decisão."
    : "O número do chamado não está na OS, então a troca espera a sua decisão.";
}

export interface ChipSinal { texto: string; ok: boolean }

/** Chips de sinais. Com chamado sem OS (`sem_os`) os sinais do solicitante vêm antes da série, como no desenho aprovado. */
export function chipsSinais(osNova: OsNova): ChipSinal[] {
  const sinais = osNova.sinais;
  const serie = { texto: sinais.mesma_serie ? "Mesma série" : "Série diferente", ok: sinais.mesma_serie };
  const assunto = { texto: sinais.assunto ? "Assunto parecido" : "Assunto diferente", ok: sinais.assunto };
  const achados: ChipSinal[] = [];
  if (sinais.numero_chamado) achados.push({ texto: "Número do chamado na OS", ok: true });
  if (sinais.nome) achados.push({ texto: "Nome do solicitante", ok: true });
  return osNova.tipo === "sem_os" ? [...achados, serie, assunto] : [serie, ...achados, assunto];
}

/** Selo do cartão de OS: "atual · 03/11/2026", "mais nova · 15/11/2026" ou "encontrada · 15/11/2026" (sem data, só o rótulo). */
export function seloOs(papel: "atual" | "mais nova" | "encontrada", texto: Pick<TextosOs, "data">) {
  return texto.data ? `${papel} · ${texto.data}` : papel;
}

export function textoOuIndisponivel(texto: string | null | undefined) {
  const limpo = (texto || "").trim();
  return limpo || DESCRICAO_INDISPONIVEL;
}

export const rotuloAceitar = (osNova: OsNova) => `Aceitar ${osNova.nova.os}`;
/** Segundo botão: "Manter M" (sugestão: fica a OS que já estava) ou "Recusar" (sem OS). */
export const rotuloRecusar = (osNova: OsNova) => (osNova.tipo === "sem_os" || !osNova.atual ? "Recusar" : `Manter ${osNova.atual.os}`);

export const notaTroca = (os: string) => `OS trocada sozinha: o número do chamado está no assunto da OS ${os}.`;
export const notaAceita = (os: string) => `OS ${os} aceita. A aba OS já mostra o vínculo.`;
export const notaRecusada = (os: string) => `OS ${os} recusada. Ela não volta a ser sugerida para este chamado.`;

export const urlOsRecusada = (numero: string) => `/api/sebrae/chamados/${encodeURIComponent(numero)}/os-recusada`;
/** Recusar e Manter gravam o mesmo par (chamado, OS nova). */
export const corpoRecusar = (osNova: OsNova) => ({ os: osNova.nova.os });
/** O servidor já entrega o corpo do vínculo pronto; só é copiado, nunca montado aqui. */
export const corpoAceitar = (osNova: OsNova) => ({ ...osNova.aceitar });
