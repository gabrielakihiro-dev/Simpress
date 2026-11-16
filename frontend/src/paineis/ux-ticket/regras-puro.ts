// Regras puras do modal "Gerar ticket no UX" (Transporte F2): quando Simular e Finalizar ficam bloqueados, o texto
// da confirmação e o que preenche o solicitante. Sem import e só com sintaxe apagável, para
// tests/frontend/test_transporte_ux_ticket.cjs carregar este arquivo com require() sem build.

export const REGISTRO_MAX = 2500;
export const INTERNO_MAX = 10;
// Mesmo padrão de PLACEHOLDER em domains/ux_chamados.py: mantenha os dois iguais.
export const PLACEHOLDER = /\[[^\]\n]*\]|:[ \t]*$/m;
// Mesmos valores de TIPO_ATUALIZACAO / TIPO_ENDERECO em domains/ux_ticket.py.
export const ATUALIZACAO = "atualizacao";
export const ENDERECO = "endereco";
export type TipoTicket = "atualizacao" | "endereco";

export interface EntradaMotivo {
  existe: boolean; // há um pedido vigente (modal aberto por Transporte ou Alterar Endereço)
  enviando: boolean;
  ocupado: boolean;
  temSessao: boolean;
  concluido: boolean;
  ehEndereco: boolean;
  temEnderecoEscolhido: boolean;
  registro: string;
  nome: string;
  email: string;
  telefone: string;
  chamadoInterno: string;
}

// Vazio = Simular e Finalizar liberados (ou ocupado, quando o botão já fica travado pelo próprio andamento).
export function motivoBloqueio(e: EntradaMotivo): string {
  if (!e.existe) return "Use Transporte ou Alterar Endereço para preparar o ticket.";
  if (e.enviando) return "Envio em andamento: aguarde o resultado do UX.";
  if (e.ocupado) return "";
  if (!e.temSessao) {
    if (e.concluido) return "Esta sessão do UX já foi usada. Use Transporte ou Alterar Endereço de novo se precisar de outro ticket.";
    return "Simulação e finalização indisponíveis: a sessão do UX não está preparada. Use Preparar novamente.";
  }
  if (!e.ehEndereco && !e.temEnderecoEscolhido) return "Escolha e confirme o endereço para liberar a simulação e a finalização.";
  const registro = e.registro.trim();
  if (!registro) return "Preencha o Registro.";
  if (registro.length > REGISTRO_MAX) return "O Registro passa de " + REGISTRO_MAX + " caracteres.";
  if (PLACEHOLDER.test(registro)) return "Complete as linhas do Registro que terminam com “:” ou têm campos entre colchetes.";
  const nome = e.nome.trim();
  const email = e.email.trim();
  if (!nome || !email || !e.telefone.trim()) return "Preencha Nome, E-mail e Contato do solicitante.";
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return "Informe um E-mail válido para o solicitante.";
  if (!e.ehEndereco && e.chamadoInterno.trim().length > INTERNO_MAX) return "O Nº de chamado interno aceita até " + INTERNO_MAX + " caracteres.";
  return "";
}

export interface EntradaConfirmacao {
  serial: string;
  ehEndereco: boolean;
  endereco: string;
  nome: string;
  email: string;
  telefone: string;
  chamadoInterno: string;
  descricao: string;
}

// Texto do cartão "Finalizar ticket no UX": o que o usuário lê antes do envio real.
export function textoConfirmacao(e: EntradaConfirmacao): string {
  return "Série: " + e.serial + (e.ehEndereco ? "\nIncidente: Transporte · Transferência Fisica de Equipamentos" : "\nEndereço: " + e.endereco)
    + "\nSolicitante: " + e.nome + " · " + e.email + " · " + e.telefone
    + (e.chamadoInterno ? "\nNº de chamado interno: " + e.chamadoInterno : "") + "\n\n" + e.descricao;
}

// "Cancelar" enquanto há sessão no UX ou algo em andamento que ainda dá para cancelar; senão "Fechar".
export function rotuloCancelar(temSessao: boolean, ocupado: boolean, enviando: boolean): string {
  return temSessao || (ocupado && !enviando) ? "Cancelar" : "Fechar";
}

// CEP da unidade de entrega escolhida no select de Transporte, buscada pelo id na lista de unidades.
export function cepDaEntrega(unidades: unknown[] | null | undefined, valor: unknown): string {
  const unidade = (unidades || []).find(item => String((item as { id?: unknown } | null)?.id) === String(valor)) as { cep?: unknown } | undefined;
  return String(unidade?.cep || "").trim();
}

export const cepTemOitoDigitos = (cep: string): boolean => cep.replace(/\D/g, "").length === 8;

// O valor do servidor só entra em campo vazio ou ainda igual ao solicitante padrão, nunca sobre o que o usuário digitou.
export function mesclarSolicitante(atual: string, padrao: string | undefined, servidor: string | undefined): string {
  const valor = atual.trim();
  return (!valor || valor === padrao) && servidor ? servidor : atual;
}

// O solicitante padrão preenche só o campo ainda vazio.
export function preencherVazio(atual: string, padrao: string | undefined): string {
  return !atual.trim() && padrao ? padrao : atual;
}

export function textoUltimoEnvio(ultimo: { ticket?: unknown; data?: unknown } | null | undefined): string {
  if (!ultimo?.ticket) return "";
  const data = new Date(ultimo.data as string);
  const quando = Number.isNaN(data.getTime()) ? "" : " em " + data.toLocaleDateString("pt-BR");
  return "Atenção: já há um ticket enviado para esta série (nº " + String(ultimo.ticket) + quando + "). Confira no UX antes de prosseguir.";
}

export const valorOuTraco = (valor: unknown): string => (valor ? String(valor) : "—");
