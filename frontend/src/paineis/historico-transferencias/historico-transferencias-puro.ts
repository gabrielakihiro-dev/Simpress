// Regras puras do histórico de transferências (sem DOM nem rede): textos, rota, destino a duplicar e mensagens de falha.

export const ENDPOINT = "/api/historico-transferencias";

export interface OpcaoUnidade { value: string; text: string | null }
export type Payload = Record<string, unknown>;
export interface ItemHistorico {
  serial?: string;
  criado_em?: string;
  retirada_cidade?: string;
  entrega_cidade?: string;
  entrega_contato?: string;
  entrega_obs?: string;
  nome_pessoa?: string;
  payload?: Payload;
}

// Campos de entrega restaurados por "Duplicar destino"; o equipamento (série) sempre vem de uma nova pesquisa.
export const DUPLICATE_FIELDS = Object.freeze<[string, string][]>([
  ["entrega-contato", "entrega_contato"],
  ["entrega-email", "entrega_email"],
  ["entrega-telefone", "entrega_telefone"],
  ["entrega-horario", "entrega_horario"],
  ["entrega-almoco", "entrega_almoco"],
  ["entrega-pausa-duracao", "entrega_pausa_duracao"],
  ["entrega-obs", "entrega_obs"],
]);

export function formatDateTime(iso?: unknown): string {
  const date = new Date(iso as string);
  if (Number.isNaN(date.getTime())) return String(iso || "—");
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function routeLabel(item: ItemHistorico): string {
  return `${item.retirada_cidade || "Origem não informada"} → ${item.entrega_cidade || "Destino não informado"}`;
}

// Rótulos de unidade terminam em "(CNPJ)"; a rua desempata unidades que dividem o mesmo CNPJ.
export function findUnitOption(options: OpcaoUnidade[], payload?: Payload | null): OpcaoUnidade | null {
  const cnpj = String(payload?.entrega_cnpj || "").trim();
  if (!cnpj) return null;
  const candidates = options.filter(option => option.value && String(option.text).includes(`(${cnpj})`));
  if (candidates.length <= 1) return candidates[0] || null;
  const street = String(payload?.entrega_endereco || "").split(" - ")[0].trim().toLowerCase();
  return candidates.find(option => street && String(option.text).toLowerCase().includes(street)) || candidates[0];
}

export function duplicateValues(payload?: Payload | null): [string, string][] {
  return DUPLICATE_FIELDS.map(([fieldId, key]) => [fieldId, String(payload?.[key] ?? "")]);
}

export function describeFailure(status: number): string {
  if (status === 501) return "O histórico de transferências não está disponível neste modo de armazenamento.";
  if (status === 503) return "O arquivo local do histórico está ilegível; os dados foram preservados. Verifique data/state/historico_transferencias.json.";
  return "Não foi possível carregar o histórico de transferências.";
}
