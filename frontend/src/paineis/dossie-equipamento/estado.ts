// Estado do diálogo "Dossiê do equipamento" (Home F1), fora do componente: a aplicação chama as ações pela
// ponte (frontend/src/aplicacao/equipment-dossier.ts). Só leitura: GET /api/equipamento/{série}/dossie.
// A seleção (currentEquipamento, equipamentoSelectionRevision) é da aplicação: lida por lerEstado na hora de cada
// conferência, nunca copiada.
import { flushSync } from "react-dom";
import { apiFetch, isAbortError } from "../../api";
import { lerEstado } from "../../estado-app";

const MODAL = "modal-dossie-equipamento";
export const VAZIO = "—";
// Textos aprovados (docs/cockpit-prompts/03-home-split-view.md, "Dossiê do equipamento").
export const TEXTO = {
  carregando: "Carregando dossiê…",
  erro: "Não foi possível carregar o dossiê. Tente de novo.",
  importacoes: "Importações disponíveis: ",
  semMudancas: "Sem mudanças registradas.",
  verOs: "Ver OS",
};
// Só reserva: o servidor manda esses mesmos textos em `os.mensagem`.
const MENSAGEM_ESTADO: Record<string, string> = {
  sem_base: "Sem base importada",
  sem_registros: "Sem registros para esta série",
  indisponivel: "Fonte indisponível",
};
const FONTES: Record<string, string> = { simpress: "Simpress", oracle: "Oracle" };
export const COLUNAS = ["OS", "Fonte", "Status", "Fila", "Dias aberta", "UTIC"];

// Funções da aplicação publicadas em window (frontend/src/aplicacao/app.ts, publish).
interface AppAntigo {
  abrirModalAcessivel(modalId: string, focoInicial: string, acaoFechar: string): void;
  fecharModalAcessivel(modalId: string): void;
  abrirChamadoDaOs?(linhas: unknown[], serie: string, os: string): unknown;
  formatarHorarioHistorico?(valor: unknown): string;
}
const app = window as unknown as AppAntigo;

type Registro = Record<string, unknown>;
const objeto = (valor: unknown): Registro => (valor && typeof valor === "object" ? (valor as Registro) : {});
const lista = (valor: unknown): Registro[] => (Array.isArray(valor) ? valor.map(objeto) : []);
const texto = (valor: unknown) => String(valor ?? "").trim();
const ouVazio = (valor: unknown) => texto(valor) || VAZIO;
// String(): o formatador devolve a entrada crua quando não a entende; um objeto derrubaria o desenho do React.
const formatarData = (valor: unknown) => String(app.formatarHorarioHistorico ? app.formatarHorarioHistorico(valor) : texto(valor));
// Só chaves próprias: "constructor" ou "toString" vindos do servidor não devolvem funções do protótipo.
const doMapa = (mapa: Record<string, string>, chave: unknown) => (Object.hasOwn(mapa, String(chave)) ? mapa[String(chave)] : "");
// Mesmo formato da linha do tempo da aba OS (cockpit-tool-panels.js, timelineValue): listas com ", ", vazio é "(vazio)".
const valorMudanca = (valor: unknown) => (Array.isArray(valor) ? valor.filter(Boolean).join(", ") : String(valor ?? "")) || "(vazio)";

export interface Linha {
  serie: string; // a aba OS acha a linha pela série como a importação gravou, que pode diferir da do cadastro
  numero: string;
  fonte: string;
  status: string;
  fila: string;
  dias: string;
  utic: { chamado: string; origem: string } | null;
}
export interface Evento { quando: string; datetime: string; tipo: string; mudancas: string[] }
export interface Corpo {
  mensagem: string; // estado diferente de "ok": só a mensagem aparece
  importacoes: string;
  observada: string;
  linhas: Linha[];
  historico: { titulo: string; eventos: Evento[] } | null;
}
export interface Estado {
  serie: string;
  modelo: string;
  status: string; // "" esconde a linha de status
  corpo: Corpo | null; // null esconde a seção de OS e chamados
}

let estado: Estado = { serie: "", modelo: "", status: "", corpo: null };
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

function montarCorpo(os: Registro, serieAberta: string): Corpo {
  if (os.estado !== "ok") {
    const mensagem = texto(os.mensagem) || doMapa(MENSAGEM_ESTADO, os.estado) || TEXTO.erro;
    return { mensagem, importacoes: "", observada: "", linhas: [], historico: null };
  }
  const linhas = lista(os.ordens).map(ordem => {
    const utic = objeto(ordem.utic);
    return {
      serie: texto(ordem.serie) || serieAberta,
      numero: texto(ordem.os),
      fonte: doMapa(FONTES, ordem.fonte) || ouVazio(ordem.fonte),
      status: ouVazio(ordem.status),
      fila: ouVazio(ordem.fila),
      dias: Number.isInteger(ordem.dias_aberta) ? String(ordem.dias_aberta) : VAZIO,
      utic: texto(utic.chamado) ? { chamado: texto(utic.chamado), origem: texto(utic.origem) } : null,
    };
  });
  const historico = objeto(os.historico);
  return {
    mensagem: "",
    importacoes: `${TEXTO.importacoes}${Number(os.total_importacoes) || 0}`,
    observada: texto(os.ultima_vez_observada_em) ? `Última vez observada em ${formatarData(os.ultima_vez_observada_em)}.` : "",
    linhas,
    historico: {
      titulo: texto(historico.titulo),
      eventos: lista(historico.eventos).map(evento => ({
        quando: formatarData(evento.atualizado_em),
        datetime: texto(evento.atualizado_em),
        tipo: ouVazio(evento.tipo),
        mudancas: lista(evento.mudancas).map(mudanca =>
          `${texto(mudanca.campo) || "Campo"}: ${valorMudanca(mudanca.anterior)} → ${valorMudanca(mudanca.atual)}`),
      })),
    },
  };
}

let aberto = false;
let geracao = 0; // muda a cada abrir, fechar e troca de série: respostas atrasadas de uma sessão antiga são descartadas
let controle: AbortController | null = null; // AbortController do pedido em andamento
let serieAberta = "";
let revisaoAberta = 0;

const serieSelecionada = () => texto(objeto(lerEstado("currentEquipamento")).serial);

// Chamado por definirEquipamentoAtual (pela ponte, que já ligou ou desligou o botão "Ver dossiê"):
// fecha o diálogo quando a série muda debaixo dele.
export function atualizarDossieEquipamento(equipamento: unknown) {
  if (!aberto) return;
  if (texto(objeto(equipamento).serial) === serieAberta) revisaoAberta = lerEstado("equipamentoSelectionRevision"); // mesma série reaplicada
  else fecharDossieEquipamento();
}

export async function abrirDossieEquipamento(): Promise<void> {
  const equipamento = objeto(lerEstado("currentEquipamento"));
  const serie = texto(equipamento.serial);
  if (!serie || aberto) return;
  aberto = true;
  const minha = ++geracao;
  serieAberta = serie;
  revisaoAberta = lerEstado("equipamentoSelectionRevision");
  controle?.abort();
  const meu = controle = new AbortController();
  // O diálogo abre já com "Carregando dossiê…" desenhado: o foco inicial e o rótulo dependem do DOM pronto.
  flushSync(() => mudar({ serie, modelo: texto(equipamento.modelo), status: TEXTO.carregando, corpo: null }));
  app.abrirModalAcessivel(MODAL, "#dossie-fechar", "fecharDossieEquipamento");
  // Mesma série e mesma revisão da seleção de quando o diálogo abriu.
  const vigente = () => aberto && geracao === minha
    && serieSelecionada() === serie && lerEstado("equipamentoSelectionRevision") === revisaoAberta;
  // Verdadeiro quando a resposta (ou o erro) já não é desta tela; seleção que mudou sem aviso também fecha o diálogo.
  const obsoleta = () => {
    if (vigente()) return false;
    if (aberto && geracao === minha) fecharDossieEquipamento();
    return true;
  };
  try {
    const dados = objeto(await apiFetch<unknown>(`/api/equipamento/${encodeURIComponent(serie)}/dossie`, {
      signal: meu.signal, errorMessage: TEXTO.erro,
    }));
    if (obsoleta()) return;
    if (!dados.os || typeof dados.os !== "object") throw new Error(TEXTO.erro);
    mudar({
      serie: texto(dados.serie) || estado.serie,
      modelo: texto(dados.modelo) || estado.modelo,
      status: "",
      corpo: montarCorpo(objeto(dados.os), serieAberta),
    });
  } catch (erro) {
    if (isAbortError(erro)) return;
    if (obsoleta()) return;
    mudar({ status: TEXTO.erro, corpo: null });
  }
}

// Fechar e Esc. O pedido em andamento é cancelado; o foco volta para "Ver dossiê" (diálogo acessível).
export function fecharDossieEquipamento() {
  if (!aberto) return;
  aberto = false;
  geracao += 1;
  controle?.abort();
  controle = null;
  app.fecharModalAcessivel(MODAL);
}

// Botão "Ver OS" de uma linha: fecha o dossiê e abre a OS na aba Chamados.
export function verOs(linha: Linha) {
  fecharDossieEquipamento();
  void app.abrirChamadoDaOs?.([], linha.serie, linha.numero);
}
