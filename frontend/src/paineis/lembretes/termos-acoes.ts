// Ações dos termos de entrega e devolução: abas, leitura do formulário, PDF pela janela de impressão, limpar e
// preencher (pelo lembrete e pela busca de série da Home). Os campos têm dado pessoal: nada vai para log nem storage.
import { urlDeBlobDaApi } from "../../comum/baixar-api";
import { avisar as avisarToast, formVazio, interno, ler, mudar, mudarAgora, porId, type AbaPainel, type FormTermo } from "./estado";
import { TERMOS, termosDadosDoLembrete, termosLimparParte, termosNomeArquivo, type DadosTermo, type NomeTermo } from "./termos-puro";
import { appAntigo, type EventoTecla, type Registro } from "./tipos";

export const ORDEM_ABAS: readonly AbaPainel[] = ["entrega", "devolucao", "lembretes"];
export const AVISO_SEM_NOME = "Preencha o número de série e o nome do colaborador.";
export const URL_ASSINATURA = "/api/assinatura-tecnico";
const TEMPO_ASSINATURA_MS = 3000;

export const ehTermo = (valor: unknown): valor is NomeTermo => Object.hasOwn(TERMOS, valor as PropertyKey);

// Mensagem de estado do termo (role=status); erro = true marca data-tipo="erro".
export function avisarTermo(termo: string, texto: string, erro?: boolean) {
  if (!ehTermo(termo)) return;
  const { status } = ler();
  mudar({ status: { ...status, [termo]: erro ? { texto, tipo: "erro" } : { texto } } });
}

export function selecionarAba(termo: string) {
  if (!ORDEM_ABAS.includes(termo as AbaPainel)) return;
  mudar({ aba: termo as AbaPainel });
}

export function teclaAba(evento: EventoTecla) {
  const aba = (evento?.target as Element | null)?.closest?.('[role="tab"]');
  if (!aba) return;
  const atual = ORDEM_ABAS.findIndex(nome => aba.id === `termos-aba-${nome}`);
  if (atual < 0) return;
  const total = ORDEM_ABAS.length;
  const destino = ({ ArrowRight: (atual + 1) % total, ArrowLeft: (atual + total - 1) % total, Home: 0, End: total - 1 } as Record<string, number>)[evento.key];
  if (destino === undefined) return;
  evento.preventDefault();
  mudarAgora({ aba: ORDEM_ABAS[destino] });
  porId(`termos-aba-${ORDEM_ABAS[destino]}`)?.focus();
}

export const idItem = (termo: NomeTermo, indice: number, resposta: "sim" | "nao") =>
  `termos-${termo}-item-${String(indice + 1).padStart(2, "0")}-${resposta}`;

// Os rádios Sim/Não não são controlados pelo React: a marca vive no DOM, como no painel antigo, e é lida daqui no
// momento da ação. Sem o formulário na página (painel ainda não desenhado), vale o último valor do estado.
export function lerItens(termo: NomeTermo): string[] {
  const { itens } = ler().termos[termo];
  return TERMOS[termo].itens.map((_, i) => {
    const sim = porId(idItem(termo, i, "sim")) as HTMLInputElement | null;
    const nao = porId(idItem(termo, i, "nao")) as HTMLInputElement | null;
    if (!sim || !nao) return itens[i] ?? "";
    return sim.checked ? "sim" : nao.checked ? "nao" : "";
  });
}

// Valores crus do formulário (sem trim), no formato que o PDF e o lembrete usam.
export function lerDados(termo: NomeTermo): DadosTermo {
  const form = ler().termos[termo];
  const itens = lerItens(termo);
  return {
    termo,
    campos: { ...form.campos },
    itens: TERMOS[termo].itens.map((rotulo, i) => ({ rotulo, resposta: itens[i] })),
    obs: form.obs,
  };
}

// Lê o termo da tela. O nome do arquivo é sempre "SÉRIE - Nome completo": sem uma das partes, mostra o aviso e devolve null.
// Gerar PDF e Criar lembrete usam o mesmo teste.
export function lerValidado(termo: string): DadosTermo | null {
  if (!ehTermo(termo)) return null;
  const dados = lerDados(termo);
  if (!termosLimparParte(dados.campos[TERMOS[termo].campoSerie], true) || !termosLimparParte(dados.campos.nome)) {
    avisarTermo(termo, AVISO_SEM_NOME, true);
    return null;
  }
  return dados;
}

// Carrega a assinatura numa <img> fora da página; qualquer falha (404, 422, imagem inválida, tempo) devolve null
// e o PDF sai como antes, com a linha em branco. Vem como blob: um <img src=/api/...> não leva o X-Simpress-Sessao.
async function carregarAssinatura(): Promise<HTMLImageElement | null> {
  const img = document.createElement("img");
  img.className = "tp__assinatura-img";
  img.alt = "";
  const controle = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  try {
    const limite = new Promise<never>((_, rejeitar) => { relogio = setTimeout(rejeitar, TEMPO_ASSINATURA_MS); });
    const carga = async () => {
      img.src = await urlDeBlobDaApi(URL_ASSINATURA, controle.signal);
      // Chegou depois dos 3 s: a impressão já seguiu sem a imagem, então só libera o blob.
      if (controle.signal.aborted) return liberarAssinatura(img);
      await img.decode();
    };
    await Promise.race([carga(), limite]);
    return img;
  } catch {
    controle.abort();
    liberarAssinatura(img);
    return null;
  } finally {
    clearTimeout(relogio);
  }
}

function liberarAssinatura(img: HTMLImageElement | null) {
  if (img?.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
}

// lerAgora é chamado antes e depois da espera pela assinatura; aoFalhar recebe a mensagem de erro.
async function imprimirTermo(termo: string, lerAgora: () => DadosTermo | null, aoFalhar: (texto: string) => void) {
  const alvo = porId("termos-impressao");
  if (!alvo || !ehTermo(termo) || interno.pdfPendente) return;
  if (!lerAgora()) return;
  const pedido = (interno.pdfPendente = { termo });
  const assinatura = await carregarAssinatura();
  if (interno.pdfPendente !== pedido) return liberarAssinatura(assinatura);
  interno.pdfPendente = null;
  const dados = lerAgora();
  if (!dados) return liberarAssinatura(assinatura);
  const serie = dados.campos[TERMOS[termo].campoSerie];
  interno.encerrarImpressao?.();
  const tituloOriginal = document.title;
  const encerrar = () => {
    window.removeEventListener("afterprint", encerrar);
    document.documentElement.classList.remove("termos-imprimindo");
    mudarAgora({ folha: null });
    alvo.hidden = true;
    document.title = tituloOriginal;
    liberarAssinatura(assinatura);
    if (interno.encerrarImpressao === encerrar) interno.encerrarImpressao = null;
  };
  interno.encerrarImpressao = encerrar;
  mudarAgora({ folha: { dados, assinatura } });
  // O [hidden] !important do Tailwind (em @layer) vence o CSS de impressão; por isso o atributo sai.
  alvo.hidden = false;
  document.title = termosNomeArquivo(serie, dados.campos.nome);
  document.documentElement.classList.add("termos-imprimindo");
  window.addEventListener("afterprint", encerrar);
  try {
    window.print();
  } catch {
    encerrar();
    aoFalhar("Não foi possível abrir a janela de impressão.");
  }
}

export function gerarPdf(termo: string): Promise<void> {
  // Relê depois da espera: o formulário pode ter mudado (edição ou busca de série na Home).
  const lerAgora = () => {
    const dados = lerValidado(termo);
    if (dados) avisarTermo(termo, "");
    return dados;
  };
  return imprimirTermo(termo, lerAgora, texto => avisarTermo(termo, texto, true));
}

// PDF a partir dos dados salvos no lembrete: não lê nem muda o formulário do termo; erro vira toast.
export function gerarPdfDoLembrete(origem: unknown, salvo: unknown): Promise<void> {
  const dados = termosDadosDoLembrete(origem, salvo);
  if (!dados) return Promise.resolve();
  return imprimirTermo(dados.termo, () => dados, texto => avisarToast(texto, "error"));
}

// Rádio só conta se diferir do padrão (Sim marcado no termo novo).
const temConteudo = (form: FormTermo, itens: string[]) =>
  itens.some(resposta => resposta !== "sim") || form.obs.trim() !== "" || Object.values(form.campos).some(valor => valor.trim() !== "");

const focarPrimeiroCampo = (termo: string) => document.querySelector<HTMLElement>(`#termos-form-${termo} input`)?.focus();

// Preenche o termo de origem com os dados do lembrete para editar; confirma antes se já houver algo digitado.
export async function preencherDoLembrete(origem: unknown, salvo: unknown): Promise<boolean> {
  const dados = termosDadosDoLembrete(origem, salvo);
  if (!dados || !ehTermo(dados.termo)) return false;
  const termo = dados.termo;
  if (temConteudo(ler().termos[termo], lerItens(termo))) {
    const confirmou = await appAntigo().confirmarAcao?.({
      titulo: "Substituir o termo?",
      mensagem: "Os campos do termo serão trocados pelos dados do lembrete.",
      confirmar: "Substituir",
      cancelar: "Cancelar",
    });
    if (confirmou !== true) return false;
  }
  if (interno.pdfPendente?.termo === termo) interno.pdfPendente = null;
  const { termos, status } = ler();
  // serieHome fica: a mesma série na Home não deve sobrescrever o que veio do lembrete.
  const form: FormTermo = {
    campos: { ...dados.campos },
    // Valor salvo prevalece sobre o padrão Sim; item salvo sem resposta fica sem marca.
    itens: dados.itens.map(item => String(item.resposta)),
    versaoItens: termos[termo].versaoItens + 1,
    obs: dados.obs,
    preenchidoHome: [],
    serieHome: termos[termo].serieHome,
  };
  mudarAgora({
    termos: { ...termos, [termo]: form },
    status: { ...status, [termo]: { texto: "Termo preenchido com os dados do lembrete." } },
    aba: termo,
  });
  focarPrimeiroCampo(termo);
  return true;
}

export async function limpar(termo: string): Promise<void> {
  if (!ehTermo(termo)) return;
  const confirmou = await appAntigo().confirmarAcao?.({
    titulo: "Limpar o termo?",
    mensagem: "Todos os campos do termo serão apagados. Nada foi guardado em outro lugar.",
    confirmar: "Limpar",
    cancelar: "Cancelar",
  });
  if (confirmou !== true) return;
  if (interno.pdfPendente?.termo === termo) interno.pdfPendente = null;
  const { termos, status } = ler();
  mudarAgora({ termos: { ...termos, [termo]: { ...formVazio(termo), versaoItens: termos[termo].versaoItens + 1 } }, status: { ...status, [termo]: { texto: "" } } });
  interno.encerrarImpressao?.();
  focarPrimeiroCampo(termo);
}

// Campos que a busca de série da Home preenche em cada termo; o resto o usuário digita.
const PREENCHIMENTO_HOME: Record<NomeTermo, Record<string, string>> = {
  entrega: { nome: "nome_pessoa", modelo_entregue: "modelo", serie_entregue: "serial" },
  devolucao: { nome: "nome_pessoa", modelo: "modelo", serie: "serial" },
};

// Chamado pela Home a cada equipamento exibido, com o painel aberto, fechado ou ainda não desenhado. Só age quando a
// série muda (salvar a edição cadastral reexibe a mesma série e não pode desfazer o que o usuário mudou). Valor vazio
// só apaga o que a própria Home tinha posto, para não perder o que o usuário digitou à mão.
export function preencherDoEquipamento(eq: Registro | null | undefined): void {
  const serial = String(eq?.serial ?? "").trim();
  if (!eq || !serial) return;
  const termos = { ...ler().termos };
  let mudou = false;
  (Object.keys(PREENCHIMENTO_HOME) as NomeTermo[]).forEach(termo => {
    const form = termos[termo];
    if (form.serieHome === serial) return;
    const campos = { ...form.campos };
    let marcados = [...form.preenchidoHome];
    Object.entries(PREENCHIMENTO_HOME[termo]).forEach(([campo, chave]) => {
      const valor = String(eq[chave] ?? "").trim();
      if (valor) {
        campos[campo] = valor;
        if (!marcados.includes(campo)) marcados.push(campo);
      } else if (marcados.includes(campo)) {
        campos[campo] = "";
        marcados = marcados.filter(nome => nome !== campo);
      }
    });
    // Item 02 Notebook: o equipamento buscado é o notebook do termo.
    const itens = lerItens(termo);
    itens[1] = "sim";
    termos[termo] = { ...form, campos, itens, versaoItens: form.versaoItens + 1, preenchidoHome: marcados, serieHome: serial };
    mudou = true;
  });
  if (mudou) mudar({ termos });
}
