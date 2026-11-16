// Assistente: conversa com a IA do Simpress (OpenRouter, chamada pelo servidor local) pelas rotas /api/assistente/*, no chat flutuante (F9).
// A lógica é a do módulo antigo: os valores (ocupado, pendente, online, listas, gravação, voz) ficam em variáveis do módulo, lidas
// na hora; o objeto "estado" é só o que a tela mostra e é trocado por inteiro a cada mudança (useSyncExternalStore compara por
// identidade). "ocupado" trava no mesmo instante do clique, sem esperar o React desenhar: o clique duplo em "Confirmar e executar"
// nunca envia duas vezes. Todo texto vindo do usuário ou do Assistente entra como texto (nunca como HTML). Nada de dado pessoal em log.
import { flushSync } from "react-dom";
import { apiFetch, type ApiFetchOptions } from "../../api";
import {
  AVISO_BUSCA_WEB, CHAVE_VOZ, DESLIGADO, LIMITE, LIMITE_ANEXO_BYTES, LIMITE_SEGUNDOS, MSG_FALHA_ENVIO, PENDENTE_SEM_DESCRICAO, PRAZO_ENVIO_MS,
  TAXA_WAV, VELOCIDADE_GLOBO, arquivosValidos, buscasValidas, contador, contextoUX, dataHoraConversa, estadoDoGlobo, nivelDoGlobo, paraWav,
  resultadoErroEnvio, rotuloGravacao, textoDevolvido, textoStatusPronto, tituloConversa,
  type ArquivoValido, type BuscaValida, type ConversaResumo, type DadosArquivo, type DadosBusca, type ErroApi, type EstadoGlobo, type Lembrete,
} from "./assistente-puro";

const JSON_HEADERS = { "Content-Type": "application/json" };
const ULTIMO_BOTAO = ".ck-assist__lembrete-acoes button:last-child";

export type Modo = "" | "normal" | "minimizado" | "maximizado";

export interface Anexo { id: unknown; nome?: unknown; tipo?: unknown; tamanho?: unknown; paginas?: unknown; aviso?: unknown }
export interface Mensagem {
  id: number;
  autor: "usuario" | "assistente";
  texto: string;
  ferramentas: string[];
  temArquivos: boolean; // o servidor mandou a lista (mesmo sem nenhum arquivo válido): a caixa aparece
  arquivos: ArquivoValido[];
  temBuscas: boolean;
  buscas: BuscaValida[];
  copiar: boolean; // rascunho de e-mail/texto: botão "Copiar texto"
}
export interface ItemLeitura { autor: "usuario" | "assistente"; texto: string }

interface DadosMensagemHistorico { papel?: unknown; texto?: unknown }
interface ConversaAberta { id?: unknown; titulo?: unknown; atualizada_em?: unknown; mensagens?: unknown }

export interface Estado {
  aberto: boolean;
  modo: Modo;
  status: string;
  tentarOculto: boolean;
  anuncio: string;
  globo: EstadoGlobo;
  textoDesabilitado: boolean;
  enviarDesabilitado: boolean;
  anexarDesabilitado: boolean;
  gravarDesabilitado: boolean;
  novaDesabilitada: boolean;
  decidirDesabilitado: boolean;
  anexosBotoesDesabilitados: boolean;
  mensagensOcupadas: boolean;
  cancelarEnvioOculto: boolean;
  gravando: boolean;
  rotuloGravar: string;
  vozPressionada: boolean;
  vozDesabilitada: boolean;
  contador: string;
  mensagens: Mensagem[];
  pendenteDescricao: string;
  pendenteOculto: boolean;
  anexos: Anexo[];
  anexosListaOculta: boolean;
  anexosAvisoOculto: boolean;
  anexosStatus: string;
  instrucoesAberta: boolean;
  instrucoesDesabilitado: boolean;
  instrucoesContador: string;
  instrucoesStatus: string;
  buscaWebMarcada: boolean;
  buscaWebDesabilitada: boolean;
  buscaWebAviso: string;
  buscaWebStatus: string;
  lembretesAberta: boolean;
  lembretes: Lembrete[];
  lembreteApagando: string;
  lembretesListaOculta: boolean;
  lembretesVazioOculto: boolean;
  lembretesStatus: string;
  historicoAberto: boolean;
  historico: ConversaResumo[];
  historicoApagando: string;
  historicoListaOculta: boolean;
  historicoVazioOculto: boolean;
  historicoStatus: string;
  lateralListaOculta: boolean;
  lateralVazioOculto: boolean;
  leituraItens: ItemLeitura[];
  leituraOculta: boolean;
  listaVoltarOculto: boolean;
  exportarOculto: boolean;
}

// Funções de outros módulos do código antigo, publicadas em window (fora de frontend/types/globais.d.ts).
interface AppAntigo {
  contextoChamadoUX?: () => { serial?: unknown; descricao?: string } | null | undefined;
  carregarRepresentantesRegionais?: (refazerFormularios: boolean) => unknown;
}
const app = () => window as unknown as AppAntigo;

// Os valores iniciais são os do HTML antigo (nada desabilitado, tudo fechado).
let estado: Estado = {
  aberto: false, modo: "", status: "Verificando o Assistente…", tentarOculto: true, anuncio: "", globo: "parado",
  textoDesabilitado: false, enviarDesabilitado: false, anexarDesabilitado: false, gravarDesabilitado: false, novaDesabilitada: false,
  decidirDesabilitado: false, anexosBotoesDesabilitados: false, mensagensOcupadas: false, cancelarEnvioOculto: true,
  gravando: false, rotuloGravar: "Gravar áudio", vozPressionada: false, vozDesabilitada: false, contador: contador(0),
  mensagens: [], pendenteDescricao: "", pendenteOculto: true,
  anexos: [], anexosListaOculta: true, anexosAvisoOculto: true, anexosStatus: "",
  instrucoesAberta: false, instrucoesDesabilitado: false, instrucoesContador: contador(0), instrucoesStatus: "",
  buscaWebMarcada: false, buscaWebDesabilitada: true, buscaWebAviso: "", buscaWebStatus: "",
  lembretesAberta: false, lembretes: [], lembreteApagando: "", lembretesListaOculta: true, lembretesVazioOculto: true, lembretesStatus: "",
  historicoAberto: false, historico: [], historicoApagando: "", historicoListaOculta: true, historicoVazioOculto: true, historicoStatus: "",
  lateralListaOculta: true, lateralVazioOculto: false, leituraItens: [], leituraOculta: true, listaVoltarOculto: true, exportarOculto: true,
};
const ouvintes = new Set<() => void>();
function mudar(parcial: Partial<Estado>) {
  const igual = (Object.keys(parcial) as (keyof Estado)[]).every(chave => Object.is(estado[chave], parcial[chave]));
  if (igual) return;
  estado = { ...estado, ...parcial };
  ouvintes.forEach(ouvinte => ouvinte());
}
export function assinar(ouvinte: () => void) {
  ouvintes.add(ouvinte);
  return () => { ouvintes.delete(ouvinte); };
}
export const ler = () => estado;

let widget: HTMLElement | null = null;
let online = false;
let modelo = "";
let ocupado = false;
let pendente = false;
let envioAtual: { controle: AbortController; motivo: string } | null = null;
let instrucoesCarregadas = false;
let instrucoesOcupadas = false;
let buscaWebCarregada = false;
let buscaWebOcupada = false;
let lembretes: Lembrete[] = [];
let lembretesOcupados = false;
let lembreteApagando = "";
let historico: ConversaResumo[] = [];
let historicoApagando = "";
let historicoOcupado = false;
let conversaAberta: ConversaAberta | null = null;
let anexos: Anexo[] = [];
let anexando = false;
let mensagens: Mensagem[] = [];
let proximaMensagem = 0;
let gravando = false;
let transcrevendo = false;
let cancelado = false;
let gravador: MediaRecorder | null = null;
let fluxo: MediaStream | null = null;
let pedacos: Blob[] = [];
let temporizador: ReturnType<typeof setInterval> | undefined;
let inicioGravacao = 0;
let vozLigada = false;
let falando = false;
let sequenciaFala = 0;
let contextoAudio: AudioContext | null = null;
let analisador: AnalyserNode | null = null;
let amostrasNivel: Uint8Array<ArrayBuffer> | null = null;
let nivelMicrofone = 0;
let quadro = 0;
let giro = 0;
let ultimoQuadro = 0;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// O React desenha no fim do evento; antes de focar por id, descarrega o que está pendente (campo habilitado, área visível).
function focar(id: string) {
  flushSync(() => {});
  const elemento = document.getElementById(id);
  elemento?.focus();
  return elemento;
}

function chamar<T>(url: string, erro: string, init: RequestInit = {}) {
  const opcoes: ApiFetchOptions & { responseType?: "json" } = { ...init, errorMessage: erro };
  return apiFetch<T>(url, opcoes);
}
const enviarJson = (metodo: string, dados: unknown): RequestInit => ({ method: metodo, headers: JSON_HEADERS, body: JSON.stringify(dados) });

const painelVisivel = () => estado.aberto;

// ---------------------------------------------------------------- status

function mostrarStatus(texto: string, oferecerNovaTentativa = false) {
  mudar({ status: texto, tentarOculto: !oferecerNovaTentativa });
}
const statusPronto = () => mostrarStatus(textoStatusPronto(modelo));
const mostrarStatusAnexos = (texto: string) => mudar({ anexosStatus: texto });
const mostrarStatusInstrucoes = (texto: string) => mudar({ instrucoesStatus: texto });
const mostrarStatusBuscaWeb = (texto: string) => mudar({ buscaWebStatus: texto });
const mostrarStatusLembretes = (texto: string) => mudar({ lembretesStatus: texto });
const mostrarStatusHistorico = (texto: string) => mudar({ historicoStatus: texto });

function atualizarControles() {
  const bloqueado = !online || ocupado || pendente;
  const segundos = Math.floor((Date.now() - inicioGravacao) / 1000);
  const semEnvio = bloqueado || gravando || transcrevendo || anexando;
  mudar({
    textoDesabilitado: bloqueado || transcrevendo,
    enviarDesabilitado: semEnvio,
    anexarDesabilitado: semEnvio,
    anexosBotoesDesabilitados: ocupado || anexando,
    // Durante a gravação o botão continua ativo: é ele que para.
    gravarDesabilitado: !gravando && (bloqueado || transcrevendo),
    gravando,
    // Sem rótulo visível: o tempo de gravação vai no tooltip e o estado aparece no ícone (parar) e na cor.
    rotuloGravar: rotuloGravacao(gravando, transcrevendo, segundos),
    novaDesabilitada: ocupado,
    decidirDesabilitado: ocupado,
    mensagensOcupadas: ocupado,
    cancelarEnvioOculto: !ocupado,
  });
  atualizarGlobo();
}

// ---------------------------------------------------------------- globo e voz

// Globo e voz: o globo mostra o estado (parado, ouvindo, pensando, falando); a fala usa uma voz em português instalada no computador (nada sai dele).
const movimentoReduzido = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

function lerPreferenciaVoz() {
  try { return window.localStorage.getItem(CHAVE_VOZ) === "true"; } catch { return false; }
}
function guardarPreferenciaVoz() {
  try { window.localStorage.setItem(CHAVE_VOZ, String(vozLigada)); } catch { /* sem armazenamento: vale só nesta sessão */ }
}

// Só voz local: as vozes "online" do navegador enviariam o texto das respostas para fora do computador.
function vozPortuguesa() {
  const locais = (window.speechSynthesis?.getVoices?.() || []).filter(voz => voz.localService && /^pt/i.test(voz.lang));
  return locais.find(voz => /br/i.test(voz.lang)) || locais[0] || null;
}

function atualizarVoz() {
  const vozDesabilitada = !window.speechSynthesis;
  mudar({ vozDesabilitada, vozPressionada: vozLigada && !vozDesabilitada });
}

function pararFala() {
  sequenciaFala += 1;
  window.speechSynthesis?.cancel();
  falando = false;
  atualizarGlobo();
}

function falar(texto: string) {
  const sintese = window.speechSynthesis;
  // resposta que chega com o chat fechado não fala
  if (!vozLigada || !sintese || !texto.trim() || !painelVisivel()) return;
  const voz = vozPortuguesa();
  if (!voz) {
    mostrarStatus("Não há voz em português instalada neste computador. Instale uma nos idiomas do Windows.");
    return;
  }
  sintese.cancel();
  const id = ++sequenciaFala;
  // shortcut: trechos de até 200 caracteres porque o Chrome corta falas longas; sem pausa inteligente, melhorar se incomodar.
  const trechos = (texto.match(/[^.!?\n]{1,200}[.!?]*/g) || []).map(trecho => trecho.trim()).filter(Boolean);
  trechos.forEach((trecho, indice) => {
    const fala = new SpeechSynthesisUtterance(trecho);
    fala.voice = voz;
    fala.lang = voz.lang;
    if (indice === 0) fala.onstart = () => { if (id === sequenciaFala) { falando = true; atualizarGlobo(); } };
    if (indice === trechos.length - 1) fala.onend = fala.onerror = () => { if (id === sequenciaFala) { falando = false; atualizarGlobo(); } };
    sintese.speak(fala);
  });
}

function alternarVozAssistente() {
  vozLigada = !vozLigada;
  guardarPreferenciaVoz();
  if (vozLigada) {
    if (!vozPortuguesa()) mostrarStatus("Voz ligada, mas não há voz em português instalada neste computador.");
  } else pararFala();
  atualizarVoz();
}

function lerNivelMicrofone() {
  if (!analisador || !amostrasNivel) { nivelMicrofone = 0; return; }
  analisador.getByteTimeDomainData(amostrasNivel);
  let soma = 0;
  for (const amostra of amostrasNivel) soma += ((amostra - 128) / 128) ** 2;
  nivelMicrofone += (Math.min(1, Math.sqrt(soma / amostrasNivel.length) * 4) - nivelMicrofone) * 0.3;
}

// Globo de arame (contorno, meridianos que giram e paralelos) na cor de destaque do tema; o raio acompanha o volume ou o ritmo do estado.
function desenharGlobo(agora: number) {
  const tela = document.getElementById("assistente-globo") as HTMLCanvasElement | null;
  const g = tela?.getContext("2d");
  if (!tela || !g) return;
  const globo = estado.globo;
  const parado = movimentoReduzido();
  const t = parado ? 0 : agora / 1000;
  const velocidade = VELOCIDADE_GLOBO[globo];
  giro += parado ? 0 : Math.min(0.1, (agora - ultimoQuadro) / 1000) * velocidade;
  ultimoQuadro = agora;
  const nivel = nivelDoGlobo(globo, t, nivelMicrofone);
  const lado = tela.width;
  const centro = lado / 2;
  const raio = centro * 0.6 * (1 + nivel * 0.5);
  const traco = (rx: number, ry: number, y = 0) => {
    g.beginPath();
    g.ellipse(centro, centro + y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, 2 * Math.PI);
    g.stroke();
  };
  g.clearRect(0, 0, lado, lado);
  g.fillStyle = g.strokeStyle = getComputedStyle(tela).color;
  g.lineWidth = lado / 40;
  g.globalAlpha = 0.06 + nivel * 0.2;
  g.beginPath();
  g.arc(centro, centro, raio * 1.4, 0, 2 * Math.PI);
  g.fill();
  g.beginPath();
  g.arc(centro, centro, raio * 1.18, 0, 2 * Math.PI);
  g.fill();
  g.globalAlpha = 0.95;
  traco(raio, raio);
  g.globalAlpha = 0.6;
  for (let i = 0; i < 3; i += 1) traco(raio * Math.abs(Math.cos(giro + (i * Math.PI) / 3)), raio);
  g.globalAlpha = 0.45;
  traco(raio, raio * 0.25);
  for (const y of [-0.55, 0.55]) {
    const meia = Math.sqrt(1 - y * y) * raio;
    traco(meia, meia * 0.25, y * raio);
  }
  g.globalAlpha = 0.9;
  g.beginPath();
  g.arc(centro, centro, raio * 0.16 * (1 + nivel), 0, 2 * Math.PI);
  g.fill();
  g.globalAlpha = 1;
}

function animarGlobo(agora: number) {
  quadro = 0;
  if (!painelVisivel()) { pararFala(); return; }
  lerNivelMicrofone();
  desenharGlobo(agora);
  if (!movimentoReduzido()) quadro = requestAnimationFrame(animarGlobo);
}

// Com movimento reduzido o globo não anima: só é redesenhado (parado) quando o estado muda.
function atualizarGlobo() {
  mudar({ globo: estadoDoGlobo({ gravando, ocupado, transcrevendo, falando }) });
  if (!painelVisivel()) return;
  if (movimentoReduzido()) desenharGlobo(0);
  else if (!quadro) quadro = requestAnimationFrame(animarGlobo);
}

// ---------------------------------------------------------------- mensagens e resposta

function adicionarMensagem(autor: "usuario" | "assistente", texto: string, ferramentas: string[] = [], arquivos: DadosArquivo[] = [], buscas: DadosBusca[] = []) {
  proximaMensagem += 1;
  mensagens = [...mensagens, {
    id: proximaMensagem, autor, texto, ferramentas,
    temArquivos: arquivos.length > 0, arquivos: arquivosValidos(arquivos),
    temBuscas: buscas.length > 0, buscas: buscasValidas(buscas),
    copiar: ferramentas.includes("montar_rascunho") && Boolean(texto),
  }];
  mudar({ mensagens });
}

// Rascunho de e-mail/texto: nada é enviado; o botão só copia o texto da resposta (já com os nomes restaurados) para a área de transferência.
async function copiarTexto(texto: string) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    const campo = document.createElement("textarea");
    campo.value = texto;
    campo.setAttribute("readonly", "");
    campo.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.append(campo);
    campo.select();
    try { return document.execCommand("copy"); } catch { return false; } finally { campo.remove(); }
  }
}

export async function copiarResposta(texto: string) {
  mostrarStatus((await copiarTexto(texto)) ? "Texto copiado." : "Não foi possível copiar. Selecione o texto da resposta e copie manualmente.");
}

function mostrarPendente(descricao: string | null) {
  pendente = descricao !== null;
  mudar({ pendenteDescricao: descricao ?? "", pendenteOculto: !pendente });
}

function focarProximo() {
  if (!painelVisivel()) return;
  if (pendente) focar("assistente-pendente");
  else if (online) focar("assistente-texto");
}

interface RespostaMensagem {
  texto?: unknown;
  ferramentas?: unknown;
  arquivos?: unknown;
  busca_web?: unknown;
  // Reserva caso o estado traga a pendência sem a descrição da ação.
  pendente?: { descricao?: unknown } | null;
}

function mostrarResposta(dados: RespostaMensagem | null) {
  const texto = String(dados?.texto ?? "");
  const brutoFerramentas = dados?.ferramentas;
  const ferramentas = Array.isArray(brutoFerramentas) ? brutoFerramentas.map(String).filter(Boolean) : [];
  const brutoArquivos = dados?.arquivos;
  const arquivos: DadosArquivo[] = Array.isArray(brutoArquivos) ? brutoArquivos : [];
  const brutoBuscas = dados?.busca_web;
  const buscas: DadosBusca[] = Array.isArray(brutoBuscas) ? brutoBuscas : [];
  if (texto || ferramentas.length || arquivos.length || buscas.length) adicionarMensagem("assistente", texto, ferramentas, arquivos, buscas);
  mudar({ anuncio: texto });
  if (estado.lembretesAberta && ferramentas.some(nome => nome.includes("lembrete"))) void carregarLembretes();
  if (ferramentas.some(nome => nome.endsWith("_representante_regional"))) void app().carregarRepresentantesRegionais?.(true);
  mostrarPendente(dados?.pendente ? String(dados.pendente.descricao ?? "") || PENDENTE_SEM_DESCRICAO : null);
  statusPronto();
  falar(texto);
}

// O servidor permite uma leitura do Endpoint por mensagem e o modelo tem 90 s; o prazo do navegador é maior para a resposta de
// erro do servidor chegar antes de abortarmos.
async function enviarAoAssistente(url: string, corpo: unknown, textoParaDevolver = "") {
  pararFala();
  ocupado = true;
  const envio = { controle: new AbortController(), motivo: "" };
  const prazo = setTimeout(() => { envio.motivo = "prazo"; envio.controle.abort(); }, PRAZO_ENVIO_MS);
  envioAtual = envio;
  mostrarStatus("Pensando…");
  atualizarControles();
  try {
    const dados = await chamar<RespostaMensagem | null>(url, MSG_FALHA_ENVIO, { ...enviarJson("POST", corpo), signal: envio.controle.signal });
    mostrarResposta(dados);
    atualizarConversasLateral();
  } catch (e) {
    const resultado = resultadoErroEnvio(e as ErroApi, envio.motivo);
    if (resultado.offline) online = false;
    mostrarStatus(resultado.texto, resultado.oferecerNovamente);
    // Não perde o texto digitado quando o envio falha.
    const campo = el<HTMLTextAreaElement>("assistente-texto");
    const devolvido = textoDevolvido(textoParaDevolver, campo.value);
    if (devolvido !== null) { campo.value = devolvido; contarMensagemAssistente(); }
  } finally {
    clearTimeout(prazo);
    envioAtual = null;
    ocupado = false;
    atualizarControles();
    focarProximo();
  }
}

function cancelarEnvioAssistente() {
  if (!envioAtual) return;
  envioAtual.motivo = "cancelado";
  envioAtual.controle.abort();
}

const contextoUXLocal = () => contextoUX(app().contextoChamadoUX?.());

function enviarMensagemAssistente() {
  if (!online || ocupado || pendente || gravando || transcrevendo || anexando) return;
  const campo = el<HTMLTextAreaElement>("assistente-texto");
  const texto = campo.value.trim();
  if (!texto) { focar("assistente-texto"); return; }
  if (texto.length > LIMITE) { mostrarStatus(`A mensagem passa de ${LIMITE} caracteres.`); return; }
  adicionarMensagem("usuario", texto);
  campo.value = "";
  contarMensagemAssistente();
  return enviarAoAssistente("/api/assistente/mensagem", { texto, ...contextoUXLocal() }, texto);
}

function responderPendente(confirmado: boolean) {
  if (!pendente || ocupado) return;
  adicionarMensagem("usuario", confirmado ? "Confirmar e executar" : "Cancelar");
  return enviarAoAssistente("/api/assistente/confirmar", { confirmado, ...contextoUXLocal() });
}

const confirmarPendenteAssistente = () => responderPendente(true);
const cancelarPendenteAssistente = () => responderPendente(false);

async function novaConversaAssistente() {
  if (ocupado) return;
  pararFala();
  try {
    await chamar("/api/assistente/limpar", "Não foi possível iniciar uma nova conversa.", { method: "POST" });
    mensagens = [];
    mudar({ mensagens, anuncio: "" });
    mostrarPendente(null);
    anexos = [];
    mostrarStatusAnexos("");
    desenharAnexos();
    if (online) statusPronto();
    atualizarConversasLateral();
  } catch (e) {
    mostrarStatus((e as ErroApi).message || "Não foi possível iniciar uma nova conversa.");
  }
  atualizarControles();
  focarProximo();
}

function contarMensagemAssistente() {
  mudar({ contador: contador(el<HTMLTextAreaElement>("assistente-texto").value.length) });
}

// Cartões da tela inicial: só preenchem a caixa de mensagem; quem envia é o usuário.
function preencherAtalhoAssistente(texto: string) {
  const campo = el<HTMLTextAreaElement>("assistente-texto");
  campo.value = String(texto);
  contarMensagemAssistente();
  focar("assistente-texto");
  campo.setSelectionRange(campo.value.length, campo.value.length);
}

// ---------------------------------------------------------------- anexos

// Anexos: o servidor guarda só em memória (30 min, apagados em "Nova conversa"); aqui fica a lista para mostrar.
// Nome do arquivo e textos vêm de fora: entram só como texto.
function desenharAnexos() {
  mudar({ anexos: [...anexos], anexosListaOculta: !anexos.length, anexosAvisoOculto: !anexos.some(anexo => anexo.tipo === "imagem") });
  atualizarControles();
}

async function carregarAnexos() {
  try {
    const dados = await chamar<{ anexos?: unknown } | null>("/api/assistente/anexos", "Não foi possível carregar os anexos.");
    const lista = dados?.anexos;
    anexos = Array.isArray(lista) ? lista : [];
  } catch {
    anexos = [];
  }
  desenharAnexos();
}

async function enviarAnexo(arquivo: File) {
  if (arquivo.size > LIMITE_ANEXO_BYTES) {
    mostrarStatusAnexos(`${arquivo.name}: o arquivo é grande demais. O limite é ${LIMITE_ANEXO_BYTES / (1024 * 1024)} MB.`);
    return;
  }
  mostrarStatusAnexos(`Enviando ${arquivo.name}…`);
  try {
    const anexo = await chamar<Anexo>("/api/assistente/anexo", "Não foi possível anexar o arquivo.", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Nome-Arquivo": encodeURIComponent(arquivo.name) },
      body: arquivo,
    });
    anexos = [...anexos, anexo];
    mostrarStatusAnexos(anexo.aviso ? `${String(anexo.nome)} anexado, mas: ${String(anexo.aviso)}` : `${String(anexo.nome)} anexado.`);
  } catch (e) {
    const erro = e as ErroApi;
    if (erro.status === 503) online = false;
    mostrarStatusAnexos(`${arquivo.name}: ${erro.status ? erro.message : "Não foi possível anexar o arquivo."}`);
  }
}

async function anexarArquivoAssistente(evento?: { target: EventTarget | null }) {
  const campo = evento?.target as HTMLInputElement | null | undefined;
  const arquivos = [...(campo?.files || [])];
  if (campo) campo.value = ""; // permite escolher o mesmo arquivo de novo
  if (!arquivos.length || !online || ocupado || pendente || anexando) return;
  anexando = true;
  atualizarControles();
  for (const arquivo of arquivos) await enviarAnexo(arquivo);
  anexando = false;
  desenharAnexos();
  focar("assistente-anexar");
}

async function removerAnexoAssistente(id: string) {
  if (ocupado || anexando) return;
  anexando = true;
  atualizarControles();
  try {
    await chamar(`/api/assistente/anexo/${encodeURIComponent(id)}`, "Não foi possível remover o anexo.", { method: "DELETE" });
    anexos = anexos.filter(anexo => anexo.id !== id);
    mostrarStatusAnexos("Anexo removido.");
  } catch (e) {
    const erro = e as ErroApi;
    if (erro.status === 404) anexos = anexos.filter(anexo => anexo.id !== id); // já expirou no servidor
    mostrarStatusAnexos(erro.status === 404 ? "O anexo já tinha sido removido." : erro.message || "Não foi possível remover o anexo.");
  }
  anexando = false;
  desenharAnexos();
  focar("assistente-anexar");
}

// ---------------------------------------------------------------- instruções permanentes e busca na web

// Instruções permanentes: texto do usuário guardado no servidor; só edita depois de carregar, para um erro de leitura nunca apagar o salvo.
function atualizarInstrucoes() {
  mudar({ instrucoesDesabilitado: !instrucoesCarregadas || instrucoesOcupadas });
}

function contarInstrucoesAssistente() {
  mudar({ instrucoesContador: contador(el<HTMLTextAreaElement>("assistente-instrucoes-texto").value.length) });
}

async function carregarInstrucoes() {
  instrucoesOcupadas = true;
  atualizarInstrucoes();
  mostrarStatusInstrucoes("Carregando as instruções…");
  const campo = el<HTMLTextAreaElement>("assistente-instrucoes-texto");
  try {
    const dados = await chamar<{ texto?: unknown } | null>("/api/assistente/instrucoes", "Não foi possível carregar as instruções.");
    campo.value = String(dados?.texto ?? "");
    instrucoesCarregadas = true;
    mostrarStatusInstrucoes("");
  } catch (e) {
    mostrarStatusInstrucoes(`${(e as ErroApi).message || "Não foi possível carregar as instruções."} Feche e abra de novo para tentar outra vez.`);
  }
  instrucoesOcupadas = false;
  contarInstrucoesAssistente();
  atualizarInstrucoes();
  if (instrucoesCarregadas) focar("assistente-instrucoes-texto");
}

async function guardarInstrucoes(texto: string, aviso: (salvo: string) => string) {
  if (!instrucoesCarregadas || instrucoesOcupadas) return;
  if (texto.length > LIMITE) { mostrarStatusInstrucoes(`As instruções passam de ${LIMITE} caracteres.`); return; }
  instrucoesOcupadas = true;
  atualizarInstrucoes();
  mostrarStatusInstrucoes("Salvando…");
  const campo = el<HTMLTextAreaElement>("assistente-instrucoes-texto");
  try {
    const dados = await chamar<{ texto?: unknown } | null>("/api/assistente/instrucoes", "Não foi possível salvar as instruções.", enviarJson("PUT", { texto }));
    campo.value = String(dados?.texto ?? texto);
    mostrarStatusInstrucoes(aviso(campo.value));
  } catch (e) {
    mostrarStatusInstrucoes((e as ErroApi).message || "Não foi possível salvar as instruções.");
  }
  instrucoesOcupadas = false;
  contarInstrucoesAssistente();
  atualizarInstrucoes();
  focar("assistente-instrucoes-texto");
}

const salvarInstrucoesAssistente = () =>
  guardarInstrucoes(el<HTMLTextAreaElement>("assistente-instrucoes-texto").value, salvo => (salvo ? "Instruções salvas. Valem a partir da próxima mensagem." : "Instruções removidas."));
const limparInstrucoesAssistente = () => guardarInstrucoes("", () => "Instruções removidas.");

// Busca na web: interruptor guardado no servidor (desligado por padrão); o card de fonte vem pronto do servidor.
function mostrarBuscaWeb(ativa: unknown) {
  mudar({
    buscaWebMarcada: ativa === true,
    buscaWebDesabilitada: !buscaWebCarregada || buscaWebOcupada,
    buscaWebAviso: ativa === true ? AVISO_BUSCA_WEB : "",
  });
}

async function carregarBuscaWeb() {
  buscaWebOcupada = true;
  mostrarBuscaWeb(false);
  try {
    const dados = await chamar<{ ativa?: unknown } | null>("/api/assistente/busca-web", "Não foi possível ler o estado da busca na web.");
    buscaWebCarregada = true;
    buscaWebOcupada = false;
    mostrarBuscaWeb(dados?.ativa);
  } catch (e) {
    buscaWebOcupada = false;
    mostrarStatusBuscaWeb(`${(e as ErroApi).message || "Não foi possível ler o estado da busca na web."} A busca fica desligada.`);
    mostrarBuscaWeb(false);
  }
}

async function alternarBuscaWebAssistente() {
  if (!buscaWebCarregada || buscaWebOcupada) return;
  const ativa = !estado.buscaWebMarcada;
  buscaWebOcupada = true;
  mudar({ buscaWebMarcada: ativa, buscaWebDesabilitada: true });
  try {
    const dados = await chamar<{ ativa?: unknown } | null>("/api/assistente/busca-web", "Não foi possível mudar a busca na web.", enviarJson("PUT", { ativa }));
    buscaWebOcupada = false;
    mostrarBuscaWeb(dados?.ativa);
    mostrarStatusBuscaWeb(dados?.ativa === true ? "Busca na web ligada." : "Busca na web desligada. Vale já na próxima rodada.");
  } catch (e) {
    buscaWebOcupada = false;
    mostrarBuscaWeb(!ativa);
    mostrarStatusBuscaWeb((e as ErroApi).message || "Não foi possível mudar a busca na web.");
  }
  focar("assistente-busca-web");
}

async function alternarInstrucoesAssistente() {
  const abrir = !estado.instrucoesAberta;
  if (abrir) {
    fecharLembretes();
    fecharHistorico();
  }
  mudar({ instrucoesAberta: abrir });
  if (!abrir) { focar("assistente-instrucoes-botao"); return; }
  void carregarBuscaWeb();
  if (!instrucoesCarregadas) return carregarInstrucoes();
  focar("assistente-instrucoes-texto");
}

// ---------------------------------------------------------------- lembretes e notas

// Lembretes e notas: guardados no servidor (data/state); aqui a lista para mostrar, concluir e apagar (o Assistente cria pelo chat).
function fecharLembretes() {
  lembreteApagando = "";
  mudar({ lembretesAberta: false });
}

function desenharLembretes() {
  mudar({ lembretes: [...lembretes], lembreteApagando, lembretesListaOculta: !lembretes.length, lembretesVazioOculto: lembretes.length > 0 });
}

function focarLembrete(id: string, seletor: string) {
  flushSync(() => {});
  const item = [...(document.getElementById("assistente-lembretes-lista")?.children ?? [])].find(li => (li as HTMLElement).dataset.lembreteId === id);
  ((item?.querySelector(seletor) as HTMLElement | null) || document.getElementById("assistente-lembretes-titulo"))?.focus();
}

async function carregarLembretes() {
  lembretesOcupados = true;
  try {
    const dados = await chamar<{ notas?: unknown } | null>("/api/assistente/notas", "Não foi possível carregar os lembretes.");
    const lista = dados?.notas;
    lembretes = Array.isArray(lista) ? lista : [];
    return true;
  } catch (e) {
    mostrarStatusLembretes((e as ErroApi).message || "Não foi possível carregar os lembretes.");
    return false;
  } finally {
    lembretesOcupados = false;
    desenharLembretes();
  }
}

async function alternarLembretesAssistente() {
  if (estado.lembretesAberta) {
    fecharLembretes();
    focar("assistente-lembretes-botao");
    return;
  }
  mudar({ instrucoesAberta: false });
  fecharHistorico();
  mudar({ lembretesAberta: true });
  mostrarStatusLembretes("Carregando os lembretes…");
  if (await carregarLembretes()) mostrarStatusLembretes("");
  focar("assistente-lembretes-titulo");
}

async function alterarLembrete(id: string, requisicao: RequestInit, erro: string, sucesso: string) {
  if (lembretesOcupados) return;
  lembretesOcupados = true;
  mostrarStatusLembretes("");
  let mensagem = sucesso;
  try {
    await chamar(`/api/assistente/notas/${encodeURIComponent(id)}`, erro, requisicao);
  } catch (e) {
    const falha = e as ErroApi;
    mensagem = falha.status === 404 ? "Esse lembrete não existe mais." : falha.message || erro;
  }
  lembretesOcupados = false;
  lembreteApagando = "";
  if (await carregarLembretes()) mostrarStatusLembretes(mensagem);
  focarLembrete(id, "button");
}

function marcarLembreteAssistente(id: string) {
  const nota = lembretes.find(item => String(item.id) === id);
  if (!nota) return;
  const concluir = nota.concluida !== true;
  return alterarLembrete(id, enviarJson("PATCH", { concluida: concluir }), "Não foi possível alterar o lembrete.", concluir ? "Lembrete concluído." : "Lembrete reaberto.");
}

function pedirApagarLembreteAssistente(id: string) {
  if (lembretesOcupados) return;
  lembreteApagando = id;
  mostrarStatusLembretes("");
  desenharLembretes();
  focarLembrete(id, ULTIMO_BOTAO);
}

function cancelarApagarLembreteAssistente(id: string) {
  lembreteApagando = "";
  desenharLembretes();
  focarLembrete(id, ULTIMO_BOTAO);
}

const apagarLembreteAssistente = (id: string) =>
  alterarLembrete(id, { method: "DELETE" }, "Não foi possível apagar o lembrete.", "Lembrete apagado.");

// ---------------------------------------------------------------- histórico de conversas

// Histórico: só leitura; o servidor guarda o texto já mascarado (sem CPF, e-mail, telefone, senha nem nomes).
// Concluir/reabrir e apagar são ações do próprio usuário nesta área: gravam direto, sem cartão (o cartão vale para o Assistente).
function fecharHistorico() {
  historicoApagando = "";
  mudar({ historicoAberto: false });
  mostrarListaHistorico();
}

function mostrarListaHistorico() {
  conversaAberta = null;
  mudar({ leituraOculta: true, listaVoltarOculto: true, exportarOculto: true });
  desenharHistorico();
}

function desenharHistorico() {
  const aberta = Boolean(conversaAberta);
  // Lateral do expandido (só o CSS a mostra, a partir de 900px): mesmo array `historico`; só lista e abre (exportar e apagar ficam no painel).
  mudar({
    historico: [...historico],
    historicoApagando,
    historicoListaOculta: !historico.length || aberta,
    historicoVazioOculto: historico.length > 0 || aberta,
    lateralListaOculta: !historico.length,
    lateralVazioOculto: historico.length > 0,
  });
}

// Recarrega a lista da lateral depois de conversa nova ou mensagem, só quando ela está à mostra.
function atualizarConversasLateral() {
  if (estado.modo === "maximizado" && !historicoOcupado) void carregarHistorico();
}

function focarConversaHistorico(id: string, seletor: string) {
  flushSync(() => {});
  const item = [...(document.getElementById("assistente-historico-lista")?.children ?? [])].find(li => (li as HTMLElement).dataset.conversaId === id);
  ((item?.querySelector(seletor) as HTMLElement | null) || document.getElementById("assistente-historico-titulo"))?.focus();
}

async function carregarHistorico() {
  historicoOcupado = true;
  try {
    const dados = await chamar<{ conversas?: unknown } | null>("/api/assistente/conversas", "Não foi possível carregar o histórico.");
    const lista = dados?.conversas;
    historico = Array.isArray(lista) ? lista : [];
    return true;
  } catch (e) {
    mostrarStatusHistorico((e as ErroApi).message || "Não foi possível carregar o histórico.");
    return false;
  } finally {
    historicoOcupado = false;
    desenharHistorico();
  }
}

async function alternarHistoricoAssistente() {
  if (estado.historicoAberto) {
    fecharHistorico();
    focar("assistente-historico-botao");
    return;
  }
  mostrarPainelHistorico();
  mostrarListaHistorico();
  mostrarStatusHistorico("Carregando o histórico…");
  if (await carregarHistorico()) mostrarStatusHistorico("");
  focar("assistente-historico-titulo");
}

function mostrarPainelHistorico() {
  mudar({ instrucoesAberta: false });
  fecharLembretes();
  mudar({ historicoAberto: true });
}

// Clique na lateral: abre o painel do histórico (se fechado) e a conversa em modo leitura, pelo fluxo de sempre.
async function abrirConversaLateralAssistente(id: string) {
  if (historicoOcupado) return;
  mostrarPainelHistorico();
  await abrirConversaHistoricoAssistente(id);
}

async function buscarConversaHistorico(id: string): Promise<ConversaAberta | null> {
  mostrarStatusHistorico("");
  try {
    return await chamar<ConversaAberta>(`/api/assistente/conversas/${encodeURIComponent(id)}`, "Não foi possível abrir a conversa.");
  } catch (e) {
    const erro = e as ErroApi;
    mostrarStatusHistorico(erro.status === 404 ? "Essa conversa não existe mais." : erro.message || "Não foi possível abrir a conversa.");
    if (erro.status === 404) await carregarHistorico();
    return null;
  }
}

const mensagensDaConversa = (conversa: ConversaAberta): DadosMensagemHistorico[] => (Array.isArray(conversa.mensagens) ? conversa.mensagens : []);

async function abrirConversaHistoricoAssistente(id: string) {
  if (historicoOcupado) return;
  const conversa = await buscarConversaHistorico(id);
  if (!conversa) return;
  conversaAberta = conversa;
  const leituraItens = mensagensDaConversa(conversa).map((mensagem): ItemLeitura => ({
    autor: mensagem?.papel === "usuario" ? "usuario" : "assistente",
    texto: String(mensagem?.texto ?? ""),
  }));
  mudar({ leituraItens, historicoListaOculta: true, historicoVazioOculto: true, leituraOculta: false, listaVoltarOculto: false, exportarOculto: false });
  flushSync(() => {});
  const leitura = document.getElementById("assistente-historico-leitura");
  if (leitura) {
    leitura.scrollTop = 0;
    leitura.focus();
  }
}

function fecharConversaHistoricoAssistente() {
  mostrarListaHistorico();
  focar("assistente-historico-titulo");
}

function pedirApagarConversaHistoricoAssistente(id: string) {
  if (historicoOcupado) return;
  historicoApagando = id;
  mostrarStatusHistorico("");
  desenharHistorico();
  focarConversaHistorico(id, ULTIMO_BOTAO);
}

function cancelarApagarConversaHistoricoAssistente(id: string) {
  historicoApagando = "";
  desenharHistorico();
  focarConversaHistorico(id, ULTIMO_BOTAO);
}

async function apagarConversaHistoricoAssistente(id: string) {
  if (historicoOcupado) return;
  historicoOcupado = true;
  let mensagem = "Conversa apagada.";
  try {
    await chamar(`/api/assistente/conversas/${encodeURIComponent(id)}`, "Não foi possível apagar a conversa.", { method: "DELETE" });
  } catch (e) {
    const erro = e as ErroApi;
    mensagem = erro.status === 404 ? "Essa conversa não existe mais." : erro.message || "Não foi possível apagar a conversa.";
  }
  historicoOcupado = false;
  historicoApagando = "";
  if (await carregarHistorico()) mostrarStatusHistorico(mensagem);
  focar("assistente-historico-titulo");
}

// PDF: documento isolado num iframe (estilo Cockpit em assistente-pdf.css) e impressão do navegador ("Salvar como PDF"); nada sai do computador.
async function exportarPdfHistoricoAssistente(id?: unknown) {
  if (historicoOcupado) return;
  const conversa = typeof id === "string" && id !== conversaAberta?.id ? await buscarConversaHistorico(id) : conversaAberta;
  if (!conversa) return;
  const quando = String(conversa.atualizada_em || "");
  const dataHora = dataHoraConversa(conversa);
  const titulo = tituloConversa(conversa);
  const itens = mensagensDaConversa(conversa);
  document.querySelectorAll("iframe[data-assistente-pdf]").forEach(antigo => antigo.remove());
  const moldura = document.createElement("iframe");
  moldura.dataset.assistentePdf = "";
  moldura.setAttribute("aria-hidden", "true");
  moldura.tabIndex = -1;
  moldura.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.append(moldura);
  const doc = moldura.contentDocument as Document;
  doc.open();
  doc.write('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title></title></head><body></body></html>');
  doc.close();
  doc.title = `Simpress - Assistente - ${titulo.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 40)}${quando ? ` - ${quando.slice(0, 10)}` : ""}`;
  for (const href of ["/static/vendor/fonts.css", "/static/styles/assistente-pdf.css"]) {
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    doc.head.append(link);
  }
  const criar = (tag: string, classe: string, texto: string) => {
    const elemento = doc.createElement(tag);
    elemento.className = classe;
    elemento.textContent = texto;
    return elemento;
  };
  const pagina = doc.createElement("main");
  pagina.className = "pdf";
  const cab = doc.createElement("header");
  cab.className = "pdf__cab";
  const meta = doc.createElement("ul");
  meta.className = "pdf__meta";
  for (const texto of [dataHora && `Atualizada em ${dataHora}`, `${itens.length} mensagens`]) {
    if (!texto) continue;
    const li = doc.createElement("li");
    li.textContent = texto;
    meta.append(li);
  }
  cab.append(criar("p", "pdf__marca", "Simpress · Assistente"), criar("h1", "pdf__titulo", titulo), meta);
  const lista = doc.createElement("div");
  lista.className = "pdf__msgs";
  for (const mensagem of itens) {
    const usuario = mensagem?.papel === "usuario";
    const caixa = doc.createElement("section");
    caixa.className = `pdf__msg pdf__msg--${usuario ? "usuario" : "assistente"}`;
    caixa.append(criar("p", "pdf__autor", usuario ? "Você" : "Assistente"), criar("p", "pdf__texto", String(mensagem?.texto ?? "")));
    lista.append(caixa);
  }
  pagina.append(cab, lista, criar("footer", "pdf__rodape", "Gerado no Simpress · dados pessoais já mascarados no histórico"));
  doc.body.append(pagina);
  await Promise.all([...doc.querySelectorAll("link")].map(link => new Promise(resolve => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
  })));
  await doc.fonts?.ready;
  mostrarStatusHistorico("Abrindo a impressão: escolha “Salvar como PDF”.");
  const janela = moldura.contentWindow as Window;
  janela.addEventListener("afterprint", () => moldura.remove(), { once: true });
  janela.focus();
  janela.print();
}

// ---------------------------------------------------------------- gravação de voz

// Mensagem de voz: o navegador grava, converte para WAV mono de 16 kHz e o servidor devolve só o texto.
async function gravacaoParaWav(blob: Blob) {
  const contexto = new AudioContext();
  let audio: AudioBuffer;
  try {
    audio = await contexto.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void contexto.close();
  }
  // O OfflineAudioContext já converte para mono e reamostra para 16 kHz.
  const saida = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * TAXA_WAV)), TAXA_WAV);
  const fonte = saida.createBufferSource();
  fonte.buffer = audio;
  fonte.connect(saida.destination);
  fonte.start();
  const pronto = await saida.startRendering();
  return paraWav(pronto.getChannelData(0).subarray(0, LIMITE_SEGUNDOS * TAXA_WAV));
}

async function transcreverGravacao(blob: Blob) {
  transcrevendo = true;
  mostrarStatus("Transcrevendo…");
  atualizarControles();
  try {
    const wav = await gravacaoParaWav(blob);
    const dados = await chamar<{ texto?: unknown } | null>("/api/assistente/audio", "Não foi possível transcrever o áudio.", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    const texto = String(dados?.texto ?? "").trim();
    if (!texto) mostrarStatus("Não ouvi nenhuma fala. Tente gravar de novo.");
    else {
      const campo = el<HTMLTextAreaElement>("assistente-texto");
      campo.value = (campo.value.trim() ? `${campo.value.trimEnd()} ${texto}` : texto).slice(0, LIMITE);
      contarMensagemAssistente();
      mostrarStatus("Áudio transcrito. Revise o texto e envie.");
    }
  } catch (e) {
    const erro = e as ErroApi;
    if (erro.status === 503) online = false;
    mostrarStatus(erro.status ? erro.message || "Não foi possível processar o áudio gravado." : "Não foi possível processar o áudio gravado.", erro.status === 503);
  } finally {
    transcrevendo = false;
    atualizarControles();
    focarProximo();
  }
}

function encerrarGravacao() {
  clearInterval(temporizador);
  fluxo?.getTracks().forEach(faixa => faixa.stop());
  fluxo = null;
  void contextoAudio?.close();
  contextoAudio = null;
  analisador = null;
  gravador = null;
  gravando = false;
}

function aoParar() {
  const blob = new Blob(pedacos, { type: gravador?.mimeType || "audio/webm" });
  pedacos = [];
  encerrarGravacao();
  if (cancelado || !blob.size) {
    if (online) statusPronto();
    atualizarControles();
    focarProximo();
    return;
  }
  void transcreverGravacao(blob);
}

function pararGravacao() {
  if (gravador?.state === "recording") gravador.stop();
}

function cancelarGravacao() {
  cancelado = true;
  pararGravacao();
}

function tiqueGravacao() {
  if (!painelVisivel()) cancelarGravacao();
  else if (Date.now() - inicioGravacao >= LIMITE_SEGUNDOS * 1000) pararGravacao();
  else atualizarControles();
}

async function iniciarGravacao() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    mostrarStatus("Este navegador não permite gravar áudio.");
    return;
  }
  pararFala(); // para o microfone não captar a própria voz do Assistente
  gravando = true; // bloqueia novo clique enquanto o navegador pede permissão
  cancelado = false;
  inicioGravacao = Date.now();
  atualizarControles();
  try {
    fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    gravando = false;
    mostrarStatus("Não consegui usar o microfone. Libere o acesso nas permissões do navegador.");
    atualizarControles();
    return;
  }
  // Esc ou fechar o painel enquanto o navegador pedia permissão: não começa a gravar.
  if (cancelado || !painelVisivel()) {
    encerrarGravacao();
    if (online) statusPronto();
    atualizarControles();
    return;
  }
  try {
    contextoAudio = new AudioContext();
    analisador = contextoAudio.createAnalyser();
    analisador.fftSize = 256;
    amostrasNivel = new Uint8Array(analisador.fftSize);
    contextoAudio.createMediaStreamSource(fluxo).connect(analisador);
  } catch {
    analisador = null; // sem medidor o globo só respira; a gravação segue
  }
  pedacos = [];
  gravador = new MediaRecorder(fluxo);
  gravador.ondataavailable = evento => { if (evento.data.size) pedacos.push(evento.data); };
  gravador.onstop = aoParar;
  inicioGravacao = Date.now();
  gravador.start();
  temporizador = setInterval(tiqueGravacao, 250);
  mostrarStatus(`Gravando… fale e clique em Parar (máximo ${LIMITE_SEGUNDOS} s). Esc cancela.`);
  atualizarControles();
}

function alternarGravacaoAssistente() {
  if (gravando) return pararGravacao();
  if (!online || ocupado || pendente || transcrevendo) return;
  return iniciarGravacao();
}

// ---------------------------------------------------------------- abrir, fechar e tamanho do chat

async function carregarAssistente() {
  window.speechSynthesis?.getVoices?.(); // o Chrome só carrega a lista de vozes na primeira consulta
  atualizarVoz();
  if (ocupado) return;
  mostrarStatus("Verificando o Assistente…", !estado.tentarOculto);
  try {
    const dados = await chamar<{ online?: unknown; modelo?: unknown; aguardando_confirmacao?: unknown; pendente?: { descricao?: unknown } | null } | null>(
      "/api/assistente/estado", "Não foi possível verificar o Assistente.");
    online = Boolean(dados?.online);
    modelo = String(dados?.modelo ?? "");
    if (online) statusPronto();
    else mostrarStatus(DESLIGADO, true);
    if (online) await carregarAnexos();
    // a lista do servidor vale também depois de recarregar a página
    if (online && dados?.aguardando_confirmacao) mostrarPendente(String(dados?.pendente?.descricao ?? "") || PENDENTE_SEM_DESCRICAO);
    else if (online && !dados?.aguardando_confirmacao && pendente) mostrarPendente(null);
  } catch (e) {
    online = false;
    mostrarStatus((e as ErroApi).message || DESLIGADO, true);
  }
  atualizarControles();
  const foco = document.activeElement;
  if (pendente || !foco || !widget?.contains(foco) || foco === document.getElementById("assistente-tentar")) focarProximo();
}

// Abre ou fecha o chat flutuante (ícone do topbar, F9, botão X e Esc).
function alternarAssistente() {
  if (!estado.aberto) {
    mudar({ aberto: true });
    // Tamanho do chat: "normal", "minimizado" (só a barra de título) ou "maximizado" (tela toda). Reabrir o chat volta ao normal.
    if (estado.modo && estado.modo !== "normal") definirModo("normal");
    atualizarGlobo();
    focarProximo();
    void carregarAssistente();
    return;
  }
  pararFala();
  if (gravando) cancelarGravacao();
  const focoDentro = Boolean(widget?.contains(document.activeElement));
  mudar({ aberto: false });
  if (focoDentro) document.getElementById("btn-assistente")?.focus();
}

function definirModo(modo: "normal" | "minimizado" | "maximizado") {
  const minimizado = modo === "minimizado";
  mudar({ modo });
  atualizarConversasLateral();
  // O conteúdo some ao minimizar: o foco vai para o botão, para não ficar preso num campo oculto.
  const botaoMin = document.getElementById("assistente-minimizar");
  if (minimizado && widget?.contains(document.activeElement) && document.activeElement !== botaoMin) botaoMin?.focus();
  else if (!minimizado) focarProximo();
}

const minimizarAssistente = () => definirModo(estado.modo === "minimizado" ? "normal" : "minimizado");
const maximizarAssistente = () => definirModo(estado.modo === "maximizado" ? "normal" : "maximizado");

// Fecha Instruções, Lembretes e Histórico e mostra a conversa de novo.
function voltarConversaAssistente() {
  mudar({ instrucoesAberta: false });
  fecharLembretes();
  fecharHistorico();
  focarProximo();
}

// Enter envia e Shift+Enter quebra a linha; com ação pendente, Esc cancela a ação; sem nada em andamento, Esc fecha o chat.
function teclaAssistente(evento: KeyboardEvent) {
  if (evento.key === "Escape") {
    evento.preventDefault();
    if (gravando) cancelarGravacao();
    else if (lembreteApagando) cancelarApagarLembreteAssistente(lembreteApagando);
    else if (pendente && !ocupado) void cancelarPendenteAssistente();
    else alternarAssistente();
    return;
  }
  if (evento.key === "Enter" && !evento.shiftKey && !evento.isComposing && (evento.target as HTMLElement | null)?.id === "assistente-texto") {
    evento.preventDefault();
    void enviarMensagemAssistente();
  }
}

// O contêiner (a <section> do index.html) guarda hidden e data-modo, e o botão do topbar guarda aria-expanded: nada disso é desenhado
// pelo React, para o chat abrir e fechar na hora, antes de qualquer render.
export function iniciar(alvo: HTMLElement) {
  widget = alvo;
  vozLigada = lerPreferenciaVoz();
  assinar(() => {
    alvo.hidden = !estado.aberto;
    if (estado.modo) alvo.dataset.modo = estado.modo;
    else delete alvo.dataset.modo;
    document.getElementById("btn-assistente")?.setAttribute("aria-expanded", String(estado.aberto));
  });
  alvo.addEventListener("keydown", teclaAssistente);
}

export const acoes = {
  carregarAssistente, alternarAssistente, minimizarAssistente, maximizarAssistente, voltarConversaAssistente, enviarMensagemAssistente,
  confirmarPendenteAssistente, cancelarPendenteAssistente, cancelarEnvioAssistente, novaConversaAssistente, contarMensagemAssistente,
  preencherAtalhoAssistente, teclaAssistente, alternarGravacaoAssistente, alternarVozAssistente, alternarInstrucoesAssistente,
  alternarBuscaWebAssistente, contarInstrucoesAssistente, salvarInstrucoesAssistente, limparInstrucoesAssistente, anexarArquivoAssistente,
  removerAnexoAssistente, alternarHistoricoAssistente, abrirConversaHistoricoAssistente, abrirConversaLateralAssistente,
  fecharConversaHistoricoAssistente, exportarPdfHistoricoAssistente, pedirApagarConversaHistoricoAssistente,
  cancelarApagarConversaHistoricoAssistente, apagarConversaHistoricoAssistente, alternarLembretesAssistente, marcarLembreteAssistente,
  pedirApagarLembreteAssistente, cancelarApagarLembreteAssistente, apagarLembreteAssistente,
};
