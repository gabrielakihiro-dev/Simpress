// Ações do modal Configuração local, chamadas pela ponte (frontend/src/aplicacao/pontes.ts) e pelos
// data-on-* do corpo. Os valores digitados são lidos do DOM na hora de salvar, como no código antigo.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import { erroDoNome, normalizarNome } from "../../componentes/assinatura-medida";
import { ler, mudar, mudarStatus, novaRevisao, type Cliente, type ConfigAssinatura, type EstadoChave, type Leitura, type Secao } from "./estado";

// Funções da aplicação publicadas em window por frontend/src/aplicacao/app.ts.
interface AppLegado {
  abrirModalAcessivel(id: string, foco: string, fechar: string): void;
  fecharModalAcessivel(id: string): void;
  showToast(mensagem: string, tipo: string): void;
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string }): Promise<boolean>;
  carregarProntidao?: () => void;
  carregarConfiguracaoTransferencia?: () => void;
  abrirConfiguracaoContatoOrigem?: unknown;
}
const app = () => window as unknown as AppLegado;

const MODAL_ID = "modal-configuracao-local";
const BOTAO_ID = "btn-configuracao-local";
const FORMATO_CNPJ = /^\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/;
const CABECALHO_JSON = { "Content-Type": "application/json" };
// As chaves não vêm da API como lista: o servidor só devolve o estado de cada uma pelo identificador.
export const ESTILOS_ASSINATURA = [
  { valor: "desenho", rotulo: "Desenho atual" },
  { valor: "digitada", rotulo: "Digitada" },
  { valor: "great-vibes", rotulo: "Great Vibes" },
  { valor: "dancing-script", rotulo: "Dancing Script" },
  { valor: "allura", rotulo: "Allura" },
  { valor: "alex-brush", rotulo: "Alex Brush" },
  { valor: "sacramento", rotulo: "Sacramento" },
];
export const CHAVES_IA = [
  { id: "openrouter", nome: "OpenRouter", ajuda: "Usada pelo Assistente quando não há chave do DeepSeek." },
  { id: "deepseek", nome: "DeepSeek", ajuda: "Se preenchida, vale no lugar do OpenRouter." },
];

let abrindo = false;

const el = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T | null;

function statusContas(leitura: Leitura): void {
  mudarStatus("contas", leitura.contas_arquivo_invalido ? "O arquivo de contas está inválido. Ao salvar, ele é regravado." : "",
    leitura.contas_arquivo_invalido ? "erro" : "");
}

function statusCliente(): void {
  const { cliente, leitura } = ler();
  if (!cliente) mudarStatus("cliente", "Não foi possível ler os dados atuais. Preencha os campos e salve.", "erro");
  else if (leitura?.cliente?.arquivo_invalido) mudarStatus("cliente", "O arquivo do cliente está inválido. Ao salvar, ele é regravado.", "erro");
  else mudarStatus("cliente", "");
}

function statusAssinatura(): void {
  if (!ler().assinatura) mudarStatus("assinatura", "Não foi possível ler a assinatura atual. Preencha os campos e salve.", "erro");
  else mudarStatus("assinatura", "");
}

function alvoDoFoco(): string {
  const { leitura } = ler();
  const conta = leitura?.contas.find(item => !item.somente_leitura);
  if (conta) return `#cfg-local-conta-${conta.id}`;
  const link = leitura?.links.find(item => !item.somente_leitura);
  if (link) return `#cfg-local-link-${link.chave}`;
  return leitura ? "#cfg-local-contrato" : ".ckp-cab__acoes .ck-btn";
}

export async function abrirConfiguracaoLocal(): Promise<void> {
  if (abrindo || ler().ocupado) return;
  abrindo = true;
  try {
    try {
      const [leitura, cliente, assinatura] = await Promise.all([
        apiFetch<Leitura>("/api/config/local", { errorMessage: "Não foi possível ler a configuração local." }),
        apiFetch<Cliente>("/api/config/cliente").catch(() => null),
        apiFetch<ConfigAssinatura>("/api/assinatura-tecnico/config").catch(() => null),
      ]);
      // Desenha antes de abrir: abrirModalAcessivel procura o campo do foco no DOM.
      flushSync(() => {
        mudar({
          leitura, cliente, assinatura, carga: "", cargaErro: false, aberto: true,
          atalhos: typeof app().abrirConfiguracaoContatoOrigem === "function",
          revisao: novaRevisao("contas", "links", "cliente", "assinatura", "chaves"),
        });
        statusContas(leitura);
        statusCliente();
        statusAssinatura();
        // Contas e cliente têm aviso próprio; as outras seções começam sem recado antigo.
        mudarStatus("links", "");
        mudarStatus("assistente", "");
      });
    } catch (error) {
      flushSync(() => mudar({
        leitura: null, aberto: false, cargaErro: true,
        carga: (error as Error).message || "Não foi possível ler a configuração local.",
      }));
    }
    app().abrirModalAcessivel(MODAL_ID, alvoDoFoco(), "fecharConfiguracaoLocal");
  } finally {
    abrindo = false;
  }
}

export function fecharConfiguracaoLocal(): void {
  if (ler().ocupado) return;
  app().fecharModalAcessivel(MODAL_ID);
  // O painel de prontidão se redesenha (foco da janela, 45 s, salvamento) e pode ter trocado o botão.
  requestAnimationFrame(() => el(BOTAO_ID)?.focus());
}

class ErroDeCampo extends Error {
  constructor(mensagem: string, readonly campo: HTMLElement) {
    super(mensagem);
  }
}

// Uma gravação por vez; o botão da seção e os das outras seções ficam desligados enquanto espera.
async function salvarSecao(secao: Secao, tarefa: () => Promise<string>): Promise<void> {
  if (ler().ocupado || !ler().leitura) return;
  const modal = el<HTMLElement>(MODAL_ID);
  mudar({ ocupado: true });
  modal?.setAttribute("aria-busy", "true");
  mudarStatus(secao, "Salvando…");
  try {
    const mensagem = await tarefa();
    mudarStatus(secao, mensagem, "ok");
    app().showToast(mensagem, "success");
    app().carregarProntidao?.();
  } catch (error) {
    mudarStatus(secao, (error as Error).message || "Não foi possível salvar.", "erro");
    if (error instanceof ErroDeCampo) error.campo.focus();
  } finally {
    mudar({ ocupado: false });
    modal?.removeAttribute("aria-busy");
  }
}

// Os dois grupos (contas e links) vão no mesmo PUT; o grupo que não está sendo salvo vai em branco e fica como está.
function corpoContas(leitura: Leitura, { contas = false, links = false }): Record<string, unknown> {
  const corpo: Record<string, unknown> = {};
  const corpoLinks: Record<string, string> = {};
  corpo.links = corpoLinks;
  leitura.contas.forEach(conta => {
    const input = el(`cfg-local-conta-${conta.id}`);
    corpo[conta.id] = contas && input && !input.readOnly ? input.value.trim() : "";
    if (typeof conta.usar_no_outlook === "boolean") {
      corpo[conta.id.replace("conta_", "usar_no_outlook_")] = Boolean(el(`cfg-local-outlook-${conta.id}`)?.checked);
    }
  });
  if (links) {
    leitura.links.forEach(link => {
      const input = el(`cfg-local-link-${link.chave}`);
      if (input && !input.readOnly) corpoLinks[link.chave] = input.value.trim();
    });
  }
  return corpo;
}

async function gravarContasELinks(grupos: { contas?: boolean; links?: boolean }, mensagem: string, grupo: "contas" | "links") {
  const leitura = await apiFetch<Leitura>("/api/config/local/contas", {
    method: "PUT",
    headers: CABECALHO_JSON,
    body: JSON.stringify(corpoContas(ler().leitura as Leitura, grupos)),
    errorMessage: "Não foi possível salvar a configuração local.",
  });
  mudar({ leitura, revisao: novaRevisao(grupo) });
  if (grupo === "contas") statusContas(leitura);
  return mensagem;
}

export function salvarContasConfiguracaoLocal(): Promise<void> {
  return salvarSecao("contas", () => gravarContasELinks({ contas: true }, "Contas salvas.", "contas"));
}

export function salvarLinksConfiguracaoLocal(): Promise<void> {
  return salvarSecao("links", () => gravarContasELinks({ links: true }, "Links salvos.", "links"));
}

export function salvarClienteConfiguracaoLocal(): Promise<void> {
  return salvarSecao("cliente", async () => {
    const contrato = el("cfg-local-contrato") as HTMLInputElement;
    const cnpj = el("cfg-local-cnpj") as HTMLInputElement;
    const series = el<HTMLTextAreaElement>("cfg-local-series") as HTMLTextAreaElement;
    // Valor vindo do ambiente fica fora do arquivo local: o servidor mantém o do ambiente na frente.
    if (!contrato.readOnly && !/^\d{1,12}$/.test(contrato.value.trim())) {
      throw new ErroDeCampo('Informe o "Contrato" só com números (até 12 dígitos).', contrato);
    }
    if (!cnpj.readOnly && !FORMATO_CNPJ.test(cnpj.value.trim())) {
      throw new ErroDeCampo('Informe o "CNPJ de faturamento" no formato 00.000.000/0000-00.', cnpj);
    }
    const cliente = await apiFetch<Cliente>("/api/config/cliente", {
      method: "PUT",
      headers: CABECALHO_JSON,
      body: JSON.stringify({
        contrato: contrato.readOnly ? "" : contrato.value.trim(),
        cnpj_faturamento: cnpj.readOnly ? "" : cnpj.value.trim(),
        // null mantém a lista guardada (também quando o ambiente a fornece).
        series_sebrae_fora: series.readOnly ? null : series.value.split(/[\s,;]+/).filter(Boolean),
      }),
      errorMessage: "Não foi possível salvar os dados do cliente.",
    });
    mudar({ cliente, revisao: novaRevisao("cliente") });
    statusCliente();
    app().carregarConfiguracaoTransferencia?.();
    return "Dados do cliente salvos.";
  });
}

export function salvarAssinaturaConfiguracaoLocal(): Promise<void> {
  return salvarSecao("assinatura", async () => {
    const campoNome = el("cfg-local-assinatura-nome") as HTMLInputElement;
    const estilo = document.querySelector<HTMLInputElement>('input[name="cfg-local-assinatura-estilo"]:checked')?.value ?? "desenho";
    // O servidor é a autoridade; aqui só se evita a ida e volta com a mesma regra.
    const nome = normalizarNome(campoNome.value);
    const erro = erroDoNome(nome) || (estilo !== "desenho" && !nome ? "Informe o nome para esse estilo de assinatura." : "");
    if (erro) throw new ErroDeCampo(erro, campoNome);
    const gravado = await apiFetch<ConfigAssinatura>("/api/assinatura-tecnico/config", {
      method: "PUT",
      headers: CABECALHO_JSON,
      body: JSON.stringify({ estilo, nome }),
      errorMessage: "Não foi possível salvar a assinatura do técnico.",
    });
    mudar({ assinatura: gravado, revisao: novaRevisao("assinatura") });
    statusAssinatura();
    return "Assinatura do técnico salva.";
  });
}

// A chave digitada sai do campo em qualquer desfecho: depois de enviada, ela não fica na tela.
function limparCamposDeChave(): void {
  CHAVES_IA.forEach(({ id }) => {
    const input = el(`cfg-local-chave-${id}`);
    if (input) input.value = "";
  });
}

function gravarAssistente(assistente: Record<string, EstadoChave>): void {
  mudar({ leitura: { ...(ler().leitura as Leitura), assistente }, revisao: novaRevisao("chaves") });
}

export function salvarAssistenteConfiguracaoLocal(): Promise<void> {
  return salvarSecao("assistente", async () => {
    const corpo: Record<string, string> = {};
    CHAVES_IA.forEach(({ id }) => {
      const input = el(`cfg-local-chave-${id}`);
      const valor = input && !input.readOnly ? input.value.trim() : "";
      if (valor) corpo[`${id}_api_key`] = valor;
    });
    if (!Object.keys(corpo).length) return "Nenhuma chave nova digitada. As chaves atuais foram mantidas.";
    let assistente: Record<string, EstadoChave>;
    try {
      assistente = await apiFetch<Record<string, EstadoChave>>("/api/config/local/assistente", {
        method: "PUT",
        headers: CABECALHO_JSON,
        body: JSON.stringify(corpo),
        errorMessage: "Não foi possível salvar a chave.",
      });
    } finally {
      limparCamposDeChave();
    }
    gravarAssistente(assistente);
    return "Chave salva.";
  });
}

export async function removerChaveAssistenteConfiguracaoLocal(id: string): Promise<void> {
  const chave = CHAVES_IA.find(item => item.id === id);
  if (!chave || ler().ocupado) return;
  const confirmou = await app().confirmarAcao({
    titulo: "Remover chave?",
    mensagem: `Remover a chave do ${chave.nome}? O Assistente com IA pode parar de responder até você informar outra chave.`,
    confirmar: "Remover chave",
  });
  if (!confirmou) return;
  await salvarSecao("assistente", async () => {
    const assistente = await apiFetch<Record<string, EstadoChave>>(`/api/config/local/assistente/${chave.id}`, {
      method: "DELETE",
      errorMessage: "Não foi possível remover a chave.",
    });
    // O campo é recriado: precisa estar no DOM antes do foco.
    flushSync(() => gravarAssistente(assistente));
    el(`cfg-local-chave-${chave.id}`)?.focus();
    return `Chave do ${chave.nome} removida.`;
  });
}
