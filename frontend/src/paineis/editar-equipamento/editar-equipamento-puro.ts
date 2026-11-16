// Regras puras do modal "Atualizar / Cadastrar equipamento" (Home F1). Sem import e só com sintaxe apagável, para os
// testes de tests/frontend carregarem este arquivo com require() direto do Node, sem build.
// Vieram de static/js/features/equipment-editor.js; os textos são os aprovados em docs/cockpit-prompts/11-modais-ajustes-finais.md.

export const TEXTO = {
  tituloInicial: "Atualizar Dados do Equipamento",
  tituloEditar: "Atualizar Cadastro do Equipamento",
  tituloNovo: "Cadastrar Novo Equipamento",
  badgeNovo: "NOVO",
  semEquipamento: "Pesquise um equipamento antes de editar.",
  serialObrigatorio: "O número de série é obrigatório.",
  salvar: "Salvar no Site e na Planilha",
  salvando: "Salvando no Excel...",
  erroApi: "Falha ao salvar equipamento.",
};

export const TIPO_PADRAO = "Notebook";
export const TIPOS: readonly string[] = ["Notebook", "Micro Computador", "Headsets", "Monitor", "Impressora", "Outro"];

// Campos do formulário: o que o diálogo mostra e o que a pessoa digita.
export interface Campos {
  titulo: string;
  badge: string;
  serial: string;
  somenteLeitura: boolean;
  modelo: string;
  tipo: string;
  apelido: string;
  idCliente: string;
  apelidoOculto: boolean;
}

export interface Payload {
  serial: string;
  novo: boolean;
  modelo: string;
  tipo: string;
  apelido: string;
  idCliente: string;
}

type Registro = Record<string, unknown>;
const objeto = (valor: unknown): Registro => (valor && typeof valor === "object" ? (valor as Registro) : {});
const texto = (valor: unknown) => String(valor || "");

export const normalizarSerial = (valor: string) => valor.trim().toUpperCase();

// Editar o equipamento selecionado: série travada, campo de apelido escondido (o apelido muda pelo botão do cartão).
export function camposDoEquipamento(equipamento: unknown): Campos {
  const atual = objeto(equipamento);
  return {
    titulo: TEXTO.tituloEditar,
    badge: texto(atual.serial),
    serial: texto(atual.serial),
    somenteLeitura: true,
    modelo: texto(atual.modelo),
    tipo: texto(atual.tipo) || TIPO_PADRAO,
    apelido: texto(atual.apelido),
    idCliente: texto(atual.idCliente),
    apelidoOculto: true,
  };
}

// Cadastrar série nova: começa com o texto pesquisado na Home em maiúsculas.
export function camposDeNovoSerial(serial: string): Campos {
  return {
    titulo: TEXTO.tituloNovo,
    badge: serial ? serial.toUpperCase() : TEXTO.badgeNovo,
    serial: (serial || "").toUpperCase(),
    somenteLeitura: false,
    modelo: "",
    tipo: TIPO_PADRAO,
    apelido: "",
    idCliente: "",
    apelidoOculto: false,
  };
}

// Mesma ordem de chaves do pedido antigo. Se a série é a do equipamento selecionado, vale o apelido dele e não o do
// campo (que fica escondido ao editar e é ignorado também ao cadastrar a mesma série).
export function montarPayload(campos: Pick<Campos, "serial" | "somenteLeitura" | "modelo" | "tipo" | "apelido" | "idCliente">, equipamentoAtual: unknown): Payload {
  const serial = normalizarSerial(campos.serial);
  const atual = objeto(equipamentoAtual);
  return {
    serial,
    novo: !campos.somenteLeitura,
    modelo: campos.modelo.trim(),
    tipo: campos.tipo,
    apelido: atual.serial === serial ? texto(atual.apelido) : campos.apelido.trim(),
    idCliente: campos.idCliente.trim(),
  };
}

// Resposta tardia: só mexe no cartão se a seleção não mudou desde o clique em salvar.
export const seguiuSelecionado = (revisaoAoSalvar: number, revisaoAgora: number) => revisaoAoSalvar === revisaoAgora;

// Resposta de POST /api/equipamento/salvar: mensagem do servidor (ou a padrão) e o equipamento já gravado.
export function lerResposta(dados: unknown, serial: string): { mensagem: string; equipamento: unknown } {
  const resposta = objeto(dados);
  return { mensagem: texto(resposta.mensagem) || `Equipamento ${serial} salvo com sucesso!`, equipamento: resposta.equipamento };
}
