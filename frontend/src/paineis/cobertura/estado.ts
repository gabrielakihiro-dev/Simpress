// Estado da Cobertura (F10), fora do componente: a aplicação chama carregarCobertura pela ponte
// antes ou depois de o React desenhar o painel. Toda leitura e escrita passa por apiRota (rotas tipadas).
import { apiRota, type ApiFetchError, type OpcoesRota } from "../../api";
import type { Rotas } from "../../api-tipos.gerado";
import { pendenciaSemVinculo } from "../historico-transferencias/vinculo";
import * as modelo from "./modelo";
import { appAntigo, type Aba, type Dados, type Registro } from "./tipos";

export interface Estado {
  dados: Dados | null;
  alertas: Registro[];
  contagens: Record<string, number>;
  status: { texto: string; tipo?: "info" | "erro" };
  ocupado: boolean; // aria-busy só nos painéis e nos alertas, nunca no ancestral de #cobertura-status (aria-live)
  bloqueado: boolean; // sem dados lidos: formulários de escrita escondidos e desabilitados
  aba: Aba;
  versao: number; // muda a cada leitura bem-sucedida: recria as listas, como o replaceChildren antigo
}

let estado: Estado = {
  dados: null,
  alertas: [],
  contagens: {},
  status: { texto: "Abra o painel para carregar a cobertura." },
  ocupado: false,
  bloqueado: false,
  aba: "necessidades",
  versao: 0,
};
const ouvintes = new Set<() => void>();
export function mudar(parcial: Partial<Estado>) {
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

export function avisar(texto: string, tipo?: string) {
  mudar({ status: { texto, tipo: tipo === "error" ? "erro" : "info" } });
  appAntigo().showToast?.(texto, tipo);
}

interface Resposta { ok: boolean; status: number; corpo: Registro | null }

// Falha de rede vira status 0 ("Sem resposta do servidor local"). Resposta 2xx vale como sucesso mesmo com corpo
// vazio ou ilegível (a escrita pode ter sido gravada): vem sem corpo e a lista é relida, como no código antigo.
async function requisitar<R extends keyof Rotas>(rota: R, opcoes: OpcoesRota<R>): Promise<Resposta> {
  try {
    const resposta = await apiRota(rota, { ...opcoes, responseType: "response" });
    let lido: Registro | null = null;
    try {
      lido = JSON.parse(await resposta.text());
    } catch {
      // corpo vazio ou ilegível: segue sem corpo
    }
    const vazio = !lido || typeof lido !== "object" || Object.keys(lido).length === 0;
    return { ok: true, status: resposta.status, corpo: vazio ? null : lido };
  } catch (erro) {
    const { status, data } = erro as Partial<ApiFetchError>;
    if (typeof status !== "number") return { ok: false, status: 0, corpo: null };
    return { ok: false, status, corpo: (data as Registro | null | undefined) ?? null };
  }
}

// Toda escrita leva o rev do registro; 404, 409 e 503 recarregam antes de mostrar a mensagem do servidor.
export async function escrever<R extends keyof Rotas>(rota: R, opcoes: OpcoesRota<R>, sucesso?: string): Promise<Registro | null> {
  if (!estado.dados) {
    avisar("A cobertura não está carregada; nada foi gravado.", "error");
    return null;
  }
  const r = await requisitar(rota, opcoes);
  if (r.ok) {
    await carregarCobertura();
    if (sucesso) avisar(sucesso, "success");
    return r.corpo || {};
  }
  if (r.status === 404 || r.status === 409 || r.status === 503) await carregarCobertura();
  avisar(modelo.mensagemErro(r.corpo, r.status), "error");
  return null;
}

// Duplo clique ou Enter repetido: o segundo envio do mesmo formulário é ignorado até o primeiro POST terminar.
const emVoo = new WeakSet<object>();
export async function semRepetir(form: object, acao: () => Promise<unknown>): Promise<void> {
  if (emVoo.has(form)) return;
  emVoo.add(form);
  try {
    await acao();
  } finally {
    emVoo.delete(form);
  }
}

let fila: Promise<unknown> = Promise.resolve();
let carregouAlgumaVez = false;

// Leituras em fila: a releitura pedida depois de uma escrita nunca reaproveita uma leitura iniciada antes dela.
export function carregarCobertura(): Promise<boolean> {
  const vez = fila.then(lerCobertura);
  fila = vez.catch(() => false);
  return vez;
}

async function lerCobertura(): Promise<boolean> {
  mudar({ status: { texto: "Carregando…", tipo: "info" }, ocupado: true });
  try {
    const r = await requisitar("GET /api/cobertura", {});
    carregouAlgumaVez = true;
    if (!r.ok || !r.corpo) {
      mudar({
        dados: null, alertas: [], contagens: {}, bloqueado: true,
        status: { texto: modelo.mensagemErro(r.corpo, r.status), tipo: "erro" },
      });
      return false;
    }
    const dados = r.corpo;
    const pendencias = pendenciaSemVinculo();
    mudar({
      dados, bloqueado: false,
      alertas: modelo.alertas(dados, pendencias),
      contagens: modelo.contagensAbas(dados),
      versao: estado.versao + 1,
      status: { texto: `Cobertura atualizada em ${modelo.formatarData(dados.hoje)}.`, tipo: "info" },
    });
    return true;
  } finally {
    mudar({ ocupado: false });
  }
}

// ../historico-transferencias/vinculo.ts avisa (simpress:cobertura-atualizada) quando uma planilha de Transporte é vinculada; só relê se a tela já foi aberta.
export function aoAtualizar() {
  if (carregouAlgumaVez) void carregarCobertura();
}
