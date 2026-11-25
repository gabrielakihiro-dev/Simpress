// Estado dos conflitos de edição do Dashboard (Chamados, F5), fora do componente: a aplicação chama
// carregarConflitosSebrae pela ponte (sebrae-dashboard.js, depois de carregar os novos chamados).
// Invariante de envio: o POST só sai no clique em "Salvar escolhas e reenviar", com enviar: true e a
// versao_importacao da lista na tela; nunca manda "site" onde o servidor não aceita (aceita_site false).
import { apiFetch, type ApiFetchError } from "../../api";

const URL_CONFLITOS = "/api/sebrae/dashboard/conflitos";
const URL_ESTADO_AUTOMACAO = "/api/automacao/estado";
const INTERVALO_MS = 3000;
const TENTATIVAS_MAX = 300; // ~15 min: a rotina enviar espera o SharePoint
const LIMITE_VALOR = 300;
const PRAZO_CONSULTA_MS = 15000; // sem prazo, um GET pendurado deixaria o painel "ocupado" até recarregar a página

export const OPCOES = [
  { valor: "sharepoint", rotulo: "Manter o do SharePoint" },
  { valor: "site", rotulo: "Usar o do site" },
] as const;
export const AVISO_SO_SHAREPOINT = "Sem número UTIC único para achar a linha no SharePoint: só dá para manter o valor do SharePoint.";

export interface Conflito {
  id: string;
  tipo?: string;
  chamado?: string;
  coluna?: string;
  sharepoint?: unknown;
  site?: unknown;
  aceita_site?: boolean;
  titulo?: string; // coluna G do chamado na base importada, já mascarada pelo servidor (vazio quando não dá para achar a linha)
  solicitante?: string; // coluna I (NOME USUARIO), idem
}
type Escolhas = Record<string, unknown>;

// Ações das features de frontend/src/aplicacao, que app.ts publica em window.
const app = window as unknown as {
  showToast?: (mensagem: string, tipo: string) => void;
  atualizarEstadoAutomacao?: () => void;
  carregarNovosSebrae?: () => void;
};

/** aceita_site false: a linha de destino é incerta e o servidor recusa "site" (conflito sem a chave aceita os dois). */
export const aceitaSite = (conflito: Conflito) => conflito.aceita_site !== false;

/** Valor da célula como aparece na tela: cortado se longo, "(vazio)" se em branco; entre aspas no meio de uma frase. */
export function valorVisivel(valor: unknown, aspas = true): string {
  const texto = String(valor ?? "");
  if (!texto.trim()) return "(vazio)";
  const cortado = texto.length > LIMITE_VALOR ? `${texto.slice(0, LIMITE_VALOR)}…` : texto;
  return aspas ? `"${cortado}"` : cortado;
}

const apagada = (conflito: Conflito) => conflito.tipo === "linha_apagada";

/** Legenda do grupo: o chamado e o que mudou (os valores ficam junto de cada opção). */
export function textoDoConflito(conflito: Conflito): string {
  const chamado = conflito.chamado || "—";
  return apagada(conflito) ? `${chamado} · linha apagada no SharePoint, editada no site` : `${chamado} · coluna ${conflito.coluna || "—"}`;
}

/** Chamado (e coluna) numa linha do resumo: vários conflitos do mesmo chamado se distinguem pela coluna. */
export const rotuloCurto = (conflito: Conflito) => (apagada(conflito) ? conflito.chamado || "—" : `${conflito.chamado || "—"} · ${conflito.coluna || "—"}`);

/** Valor de um lado junto da opção; linha apagada não tem (o "site" dela junta várias colunas). */
export function valorDaOpcao(conflito: Conflito, opcao: string): string {
  if (apagada(conflito)) return "";
  return valorVisivel(opcao === "site" ? conflito.site : conflito.sharepoint, false);
}

/** O que acontece no SharePoint com a escolha válida (a de escolhasParaEnviar); sem ela, "falta escolher". */
export function consequencia(conflito: Conflito, escolha: string | undefined): string {
  if (escolha !== "sharepoint" && escolha !== "site") return "falta escolher";
  if (apagada(conflito)) return escolha === "site" ? "a linha volta com os dados do site" : "a linha continua apagada";
  return escolha === "site" ? `vira ${valorVisivel(conflito.site)}` : `fica ${valorVisivel(conflito.sharepoint)}`;
}

/** Só os ids da lista atual com escolha válida vão no POST (nunca "site" onde não é aceito). */
export function escolhasParaEnviar(conflitos: Conflito[], escolhas: Escolhas): Record<string, string> {
  const corpo: Record<string, string> = {};
  conflitos.forEach(conflito => {
    const valor = escolhas[conflito.id];
    if (OPCOES.some(opcao => opcao.valor === valor) && (valor !== "site" || aceitaSite(conflito))) corpo[conflito.id] = valor as string;
  });
  return corpo;
}

export interface Estado {
  conflitos: Conflito[];
  escolhas: Escolhas;
  versao: string;
  ocupado: boolean;
  status: string;
}

let estado: Estado = { conflitos: [], escolhas: {}, versao: "", ocupado: false, status: "" };
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

export const faltam = (atual: Estado) => atual.conflitos.length - Object.keys(escolhasParaEnviar(atual.conflitos, atual.escolhas)).length;

// O aviso "O envio parou de novo…" não pode ser apagado pela releitura da lista que o próprio fim do envio
// dispara (carregarNovosSebrae → carregarConflitosSebrae); sai na próxima escolha, no próximo envio ou com a lista vazia.
let avisoFixo = false;

// Como o atualizarBotao antigo: fora de um envio, o status mostra quantas células faltam escolher.
function recontar() {
  if (estado.ocupado || avisoFixo) return;
  const n = faltam(estado);
  mudar({ status: n > 0 ? `Escolha uma opção em cada célula (faltam ${n}).` : "" });
}

export function escolher(id: string, valor: string) {
  avisoFixo = false;
  mudar({ escolhas: { ...estado.escolhas, [id]: valor } });
  recontar();
}

function listaDe(corpo: unknown): Conflito[] {
  const lista = (corpo as { conflitos?: unknown } | null)?.conflitos;
  return (Array.isArray(lista) ? lista : []).filter((item): item is Conflito => Boolean(item) && typeof item.id === "string");
}

function aplicar(corpo: unknown) {
  const dados = (corpo && typeof corpo === "object" ? corpo : {}) as { escolhas?: unknown; versao_importacao?: unknown };
  const conflitos = listaDe(corpo);
  const ids = new Set(conflitos.map(item => item.id));
  const doServidor = dados.escolhas && typeof dados.escolhas === "object" ? (dados.escolhas as Escolhas) : {};
  const locais = Object.fromEntries(Object.entries(estado.escolhas).filter(([id]) => ids.has(id)));
  mudar({
    conflitos,
    versao: typeof dados.versao_importacao === "string" ? dados.versao_importacao : "",
    escolhas: { ...doServidor, ...locais }, // a escolha ainda não salva de quem está na tela vale mais que a gravada
  });
  if (!conflitos.length) avisoFixo = false;
  recontar();
}

let consulta = 0;

// Só a consulta mais recente atualiza a tela, mas todas devolvem a lista que leram (null sem resposta ou com prazo
// vencido): quem decide por ela (terminarEnvio) não pode ler a lista velha da tela quando outra consulta tomou a vez.
async function consultarConflitos(): Promise<Conflito[] | null> {
  const minha = ++consulta;
  // AbortController e não AbortSignal.timeout: o prazo vira AbortError, que o apiFetch não trata como servidor offline.
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), PRAZO_CONSULTA_MS);
  try {
    const corpo = await apiFetch(URL_CONFLITOS, {
      errorMessage: "Não foi possível consultar os conflitos do Dashboard.",
      signal: controle.signal,
    });
    if (minha === consulta) aplicar(corpo);
    return listaDe(corpo);
  } catch {
    return null; // sem lista nova: mantém a anterior
  } finally {
    clearTimeout(prazo);
  }
}

// Chamado pela aplicação (ponte) e depois de cada envio. Nunca rejeita: sem a lista, a tela fica como
// estava; o aviso do SharePoint e o painel de Automação seguem valendo.
export async function carregarConflitosSebrae(): Promise<void> {
  await consultarConflitos();
}

let acompanhamento = 0;
let relogio: ReturnType<typeof setTimeout> | undefined;

async function terminarEnvio(ultima: { status?: string } | null | undefined) {
  // ocupado até a lista nova chegar: com a lista velha na tela, um clique mandaria o POST de novo.
  const restam = ((await consultarConflitos()) ?? estado.conflitos).length > 0; // sem resposta: a lista da tela
  avisoFixo = restam;
  mudar({ ocupado: false });
  recontar();
  app.carregarNovosSebrae?.(); // atualiza o aviso do SharePoint e a lista de chamados
  if (restam) {
    mudar({ status: "O envio parou de novo e ainda há conflitos. Confira a lista e escolha outra vez." });
    return;
  }
  if (ultima?.status === "concluido") app.showToast?.("Conflitos resolvidos e Dashboard enviado ao SharePoint.", "success");
  else app.showToast?.("O envio terminou sem concluir. Veja o resultado na Automação.", "error");
}

/** Consulta a automação até a rotina acabar e recarrega a lista: ela esvazia quando o envio passou. */
function acompanharEnvio() {
  acompanhamento += 1;
  clearTimeout(relogio);
  const minha = acompanhamento;
  let tentativas = 0;
  const passo = async () => {
    if (minha !== acompanhamento) return;
    let dados: { estado?: string; ultima?: { status?: string } | null } | null = null;
    try {
      dados = await apiFetch(URL_ESTADO_AUTOMACAO, { errorMessage: "Não foi possível consultar a automação." });
    } catch {
      dados = null; // falha de rede: tenta de novo até o limite
    }
    if (minha !== acompanhamento) return;
    tentativas += 1;
    if ((dados && dados.estado !== "em_andamento") || tentativas >= TENTATIVAS_MAX) {
      await terminarEnvio(dados?.ultima);
      return;
    }
    relogio = setTimeout(passo, INTERVALO_MS);
  };
  relogio = setTimeout(passo, INTERVALO_MS);
}

export async function salvarEReenviar() {
  const escolhas = escolhasParaEnviar(estado.conflitos, estado.escolhas);
  if (estado.ocupado || !Object.keys(escolhas).length) return;
  avisoFixo = false;
  mudar({ ocupado: true, status: "Salvando as escolhas…" });
  try {
    const corpo = await apiFetch<{ enviar?: { iniciado?: boolean; motivo?: string } }>(URL_CONFLITOS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ escolhas, enviar: true, versao_importacao: estado.versao }),
      errorMessage: "Não foi possível salvar as escolhas.",
    });
    if (corpo?.enviar?.iniciado) {
      mudar({ status: "Escolhas salvas. Reenviando ao SharePoint…" });
      app.atualizarEstadoAutomacao?.(); // mostra a rotina enviar e o Cancelar execução sem esperar a próxima consulta
      acompanharEnvio();
      return;
    }
    mudar({ ocupado: false, status: `Escolhas salvas, mas o envio não começou: ${corpo?.enviar?.motivo || "motivo não informado"}` });
  } catch (erro) {
    const falha = erro as ApiFetchError;
    mudar({ ocupado: false });
    recontar();
    if (falha.status === 422 || falha.status === 409) await carregarConflitosSebrae(); // a lista ou a versao_importacao mudou no servidor
    mudar({ status: falha.message }); // depois do recarregamento, que refaz a contagem
    app.showToast?.(falha.message, "error");
  }
}
