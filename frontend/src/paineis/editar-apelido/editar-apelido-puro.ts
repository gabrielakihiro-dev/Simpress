// Regras puras do modal "Editar apelido" (Home F1). Sem import e só com sintaxe apagável, para os testes de
// tests/frontend carregarem este arquivo com require() direto do Node, sem build.
// Vieram de frontend/src/aplicacao/pontes.ts; os textos são os aprovados em docs/cockpit-prompts/11-modais-ajustes-finais.md.

export const TEXTO = {
  semEquipamento: "Pesquise um equipamento antes de editar o apelido.",
  salvar: "Salvar apelido",
  salvando: "Salvando...",
  sucesso: "Apelido salvo para pesquisas e exportações do Excel.",
  erroApi: "Falha ao salvar o apelido.",
};

export interface Payload {
  serial: string;
  apelido: string;
}

type Registro = Record<string, unknown>;
const objeto = (valor: unknown): Registro => (valor && typeof valor === "object" ? (valor as Registro) : {});
const texto = (valor: unknown) => String(valor || "");

export const serialDo = (equipamento: unknown) => texto(objeto(equipamento).serial);

// Campos ao abrir: o apelido atual e a linha "Série: ..." abaixo do campo.
export function camposDoApelido(equipamento: unknown): { apelido: string; contexto: string } {
  return { apelido: texto(objeto(equipamento).apelido), contexto: `Série: ${serialDo(equipamento)}` };
}

export const montarPayload = (serial: string, apelido: string): Payload => ({ serial, apelido: apelido.trim() });

// Resposta tardia: só mexe no cartão se a seleção não mudou (mesma revisão) e a série continua a mesma (sem
// diferenciar maiúsculas de minúsculas).
export function seguiuSelecionado(revisaoAoSalvar: number, revisaoAgora: number, serialAoSalvar: string, equipamentoAgora: unknown): boolean {
  return revisaoAoSalvar === revisaoAgora && serialDo(equipamentoAgora).toUpperCase() === serialAoSalvar.toUpperCase();
}

// Resposta de POST /api/equipamento/atualizar-apelido: o equipamento já com o apelido gravado.
export const lerEquipamento = (dados: unknown): unknown => objeto(dados).equipamento;
