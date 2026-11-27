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
  semEventos: "Sem eventos para esta série.",
  tudo: "Tudo",
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
// Só dia (dd/mm/aaaa): evento com `so_data`. Entrada ilegível volta crua.
const formatarDia = (valor: unknown) => {
  const dia = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto(valor));
  return dia ? `${dia[3]}/${dia[2]}/${dia[1]}` : texto(valor);
};
// Só chaves próprias: "constructor" ou "toString" vindos do servidor não devolvem funções do protótipo.
const doMapa = (mapa: Record<string, string>, chave: unknown) => (Object.hasOwn(mapa, String(chave)) ? mapa[String(chave)] : "");
// Tipos da linha do tempo, na ordem fixa do contrato (também a ordem de `indisponiveis`).
const ROTULOS_TIPO: Record<string, string> = {
  apelido_usuario: "Apelido e usuário", transferencia: "Transferências", os: "OS", sebrae: "Chamados Sebrae", cobertura: "Cobertura",
};
const TIPOS = Object.keys(ROTULOS_TIPO);
export const FILTRO_TUDO = "tudo";

export interface Linha {
  serie: string; // a aba OS acha a linha pela série como a importação gravou, que pode diferir da do cadastro
  numero: string;
  fonte: string;
  status: string;
  fila: string;
  dias: string;
  utic: { chamado: string; origem: string } | null;
}
export interface EventoLinha { quando: string; datetime: string; tipo: string; rotulo: string; titulo: string; detalhes: string[] }
export interface LinhaDoTempo {
  eventos: EventoLinha[];
  contagens: { tipo: string; rotulo: string; total: number }[]; // só tipos com eventos, na ordem do contrato
  indisponivel: string; // "" esconde o aviso
  limite: string; // "" esconde o aviso
}
export interface Corpo {
  mensagem: string; // estado diferente de "ok": só a mensagem aparece
  importacoes: string;
  observada: string;
  linhas: Linha[];
}
export interface Estado {
  serie: string;
  modelo: string;
  status: string; // "" esconde a linha de status
  corpo: Corpo | null; // null esconde a seção de OS e chamados
  linha: LinhaDoTempo | null; // null esconde a linha do tempo
  filtro: string; // FILTRO_TUDO ou um tipo; volta a "tudo" a cada abertura
}

let estado: Estado = { serie: "", modelo: "", status: "", corpo: null, linha: null, filtro: FILTRO_TUDO };
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
    return { mensagem, importacoes: "", observada: "", linhas: [] };
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
  return {
    mensagem: "",
    importacoes: `${TEXTO.importacoes}${Number(os.total_importacoes) || 0}`,
    observada: texto(os.ultima_vez_observada_em) ? `Última vez observada em ${formatarData(os.ultima_vez_observada_em)}.` : "",
    linhas,
  };
}

const avisoIndisponivel = (tipos: Iterable<string>) => {
  const lista = TIPOS.filter(tipo => new Set(tipos).has(tipo)).map(tipo => ROTULOS_TIPO[tipo]);
  return lista.length ? `Fonte indisponível: ${lista.join(", ")}.` : "";
};

// Ausente ou inválida: só o aviso (todas as fontes), nunca derruba a seção de OS.
function montarLinha(bruta: unknown): LinhaDoTempo {
  if (!bruta || typeof bruta !== "object") return { eventos: [], contagens: [], indisponivel: avisoIndisponivel(TIPOS), limite: "" };
  const dados = objeto(bruta);
  const eventos = lista(dados.eventos).map(evento => {
    const tipo = texto(evento.tipo);
    const soData = evento.so_data === true;
    return {
      quando: soData ? formatarDia(evento.quando) : formatarData(evento.quando),
      datetime: texto(evento.quando),
      tipo,
      rotulo: doMapa(ROTULOS_TIPO, tipo) || ouVazio(tipo),
      titulo: ouVazio(evento.titulo),
      detalhes: (Array.isArray(evento.detalhes) ? evento.detalhes : []).map(texto).filter(Boolean),
    };
  });
  const contagens = TIPOS.map(tipo => ({ tipo, rotulo: ROTULOS_TIPO[tipo], total: eventos.filter(e => e.tipo === tipo).length }))
    .filter(c => c.total > 0);
  const indisponiveis = (Array.isArray(dados.indisponiveis) ? dados.indisponiveis : []).map(String);
  const total = Number(dados.total);
  const limite = Number(dados.limite);
  return {
    eventos, contagens, indisponivel: avisoIndisponivel(indisponiveis),
    limite: Number.isInteger(total) && Number.isInteger(limite) && total > limite ? `Mostrando os ${limite} eventos mais recentes de ${total}.` : "",
  };
}

export function escolherFiltro(filtro: string) { mudar({ filtro }); }

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
  flushSync(() => mudar({ serie, modelo: texto(equipamento.modelo), status: TEXTO.carregando, corpo: null, linha: null, filtro: FILTRO_TUDO }));
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
      linha: montarLinha(dados.linha_do_tempo),
    });
  } catch (erro) {
    if (isAbortError(erro)) return;
    if (obsoleta()) return;
    mudar({ status: TEXTO.erro, corpo: null, linha: null });
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
