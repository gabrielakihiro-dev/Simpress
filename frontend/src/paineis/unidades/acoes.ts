// Ações do Catálogo de unidades, chamadas pela ponte (frontend/src/aplicacao/pontes.ts), pelo roteador
// do Cockpit (recarregarUnidadesCockpit) e pelos data-on-* do corpo.
import { flushSync } from "react-dom";
import { apiFetch } from "../../api";
import { gravarEstado, lerEstado } from "../../estado-app";
import { ler, mudar, mudarForm, type Unidade } from "./estado";

// Funções da aplicação publicadas em window por frontend/src/aplicacao/app.ts.
interface AppLegado {
  showToast(mensagem: string, tipo: string): void;
  abrirPainelCockpit(painel: string): Promise<void>;
  copiarTextoParaAreaTransferencia(texto: string): Promise<void>;
  handleUnidadeDestinoChange(id: unknown, manual: boolean): void;
  preencherRepresentanteRegional(tipo: string, valor: string): void;
  atualizarEstadoCopiaCnpjEntrega(): void;
  atualizarChipsUnidade?: () => void;
  pluralize(quantidade: number, singular: string, plural: string): string;
}
const app = () => window as unknown as AppLegado;
const el = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T | null;
// appState.unidadesList é da aplicação: lido na hora, nunca copiado.
const catalogo = () => lerEstado("unidadesList") as Unidade[];

// Catálogo do Transporte: grava appState.unidadesList e atualiza o seletor de filial e o contador da Home.
// Escreve por id no DOM do Transporte (frontend/src/paineis/transporte/), que é outro painel.
export async function carregarUnidades(): Promise<void> {
  try {
    const unidades = await apiFetch<Unidade[]>("/api/unidades", { errorMessage: "Falha ao consultar o catálogo de unidades." });
    gravarEstado("unidadesList", unidades);
    const select = el<HTMLSelectElement>("select-unidade-destino");
    if (select) {
      const anterior = select.value;
      select.innerHTML = '<option value="">Selecione a filial</option>';
      unidades.forEach(u => {
        const opcao = document.createElement("option");
        opcao.value = String(u.id);
        opcao.textContent = u.label || `${u.cidade} - ${u.endereco} (${u.cnpj})`;
        select.appendChild(opcao);
      });
      const atual = unidades.find(u => String(u.id) === String(anterior));
      if (atual) {
        select.value = String(atual.id);
        app().handleUnidadeDestinoChange(atual.id, false);
      } else if (anterior) {
        select.value = "";
        const cnpj = el("entrega-cnpj");
        const endereco = el("entrega-endereco");
        if (cnpj) cnpj.value = "";
        if (endereco) endereco.value = "";
        app().preencherRepresentanteRegional("entrega", "");
      }
      app().atualizarEstadoCopiaCnpjEntrega();
      app().atualizarChipsUnidade?.();
    }
    const contador = el<HTMLElement>("filiais-count");
    if (contador) contador.textContent = `${unidades.length} ${app().pluralize(unidades.length, "filial catalogada", "filiais catalogadas")}`;
  } catch (erro) {
    console.error("Falha ao carregar unidades:", erro);
    app().showToast("Não foi possível carregar o catálogo de unidades. Recarregue a página e tente de novo.", "error");
  }
}

let pedido = 0;

// Lista do painel (independente de appState.unidadesList); só o pedido mais novo desenha.
export async function recarregarUnidadesCockpit(): Promise<void> {
  const atual = ++pedido;
  mudar({ fase: "carregando", erro: "" });
  try {
    const dados = await apiFetch<unknown>("/api/unidades", { errorMessage: "Não foi possível carregar o catálogo de unidades." });
    if (atual !== pedido) return;
    mudar({ fase: "ok", lista: Array.isArray(dados) ? dados as Unidade[] : [] });
  } catch (erro) {
    if (atual !== pedido) return;
    mudar({ fase: "erro", erro: (erro as Error).message || "Não foi possível carregar as unidades." });
  }
}

export function buscarUnidade(busca: string): void {
  mudar({ busca });
}

// O catálogo mora no painel "unidades" do Cockpit; a Home e os atalhos antigos continuam chamando este nome.
export async function abrirModalGerenciarUnidades(): Promise<void> {
  mudar({ busca: "" });
  await app().abrirPainelCockpit("unidades");
  // Home pede "Cadastrar" quando não há regional: abre o formulário vazio.
  if (!catalogo().length) toggleFormNovaUnidade(true);
}

export async function copiarDadoUnidade(valor: unknown, campo: string): Promise<void> {
  const texto = String(valor || "").trim();
  if (!texto) {
    app().showToast(`${campo} não informado para esta unidade.`, "warning");
    return;
  }
  try {
    await app().copiarTextoParaAreaTransferencia(texto);
    app().showToast(campo === "CNPJ" ? "CNPJ copiado" : "CEP Copiado", "success");
  } catch {
    app().showToast(`Não foi possível copiar o ${campo}.`, "error");
  }
}

export function toggleFormNovaUnidade(show: boolean | null = null): void {
  const { form } = ler();
  if (show ?? !form.aberto) {
    // Desenha antes do foco: os campos voltam vazios.
    flushSync(() => mudarForm({
      aberto: true, titulo: "Cadastrar Nova Unidade / Filial",
      id: "", cidade: "", cep: "", cnpj: "", endereco: "", revisao: form.revisao + 1,
    }));
    el("form-unidade-cidade")?.focus();
  } else {
    // Sem isso o foco se perde quando o formulário some com um botão dele em foco.
    if (el<HTMLElement>("form-nova-unidade")?.contains(document.activeElement)) el<HTMLElement>("cockpit-units-new")?.focus();
    mudarForm({ aberto: false });
  }
}

export function editarUnidade(id: unknown, focoId = "form-unidade-endereco"): void {
  const unidade = catalogo().find(u => u.id === id);
  if (!unidade) return;
  flushSync(() => mudarForm({
    aberto: true, titulo: `Editar Unidade: ${unidade.cidade}`,
    id: String(unidade.id), cidade: unidade.cidade || "", cep: unidade.cep || "", cnpj: unidade.cnpj || "",
    endereco: unidade.endereco || "", revisao: ler().form.revisao + 1,
  }));
  el<HTMLElement>(focoId)?.focus();
}

let salvandoUnidade = false; // duplo clique ou Enter repetido não envia a mesma gravação duas vezes

export async function salvarUnidadeForm(): Promise<void> {
  if (salvandoUnidade) return;
  const valor = (id: string) => (el(id)?.value || "").trim();
  const cidade = valor("form-unidade-cidade");
  const endereco = valor("form-unidade-endereco");
  const cep = valor("form-unidade-cep");
  const cnpj = valor("form-unidade-cnpj");
  const id = el("form-unidade-id")?.value || "";
  if (!cidade || !endereco || !cnpj) {
    app().showToast("Cidade, endereço e CNPJ são campos obrigatórios.", "warning");
    return;
  }
  salvandoUnidade = true;
  try {
    const dados = await apiFetch<{ mensagem?: string }>("/api/unidade/salvar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id ? parseInt(id, 10) : null, cidade, endereco, uf: "PR", cep, cnpj }),
      errorMessage: "Erro ao salvar unidade.",
    });
    await carregarUnidades();
    await recarregarUnidadesCockpit();
    toggleFormNovaUnidade(false);
    app().showToast(dados.mensagem || "Unidade salva com sucesso!", "success");
  } catch (erro) {
    console.error("Erro ao salvar unidade:", erro);
    app().showToast((erro as Error).message, "error");
  } finally {
    salvandoUnidade = false;
  }
}
