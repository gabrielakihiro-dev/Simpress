// Regras puras dos termos de entrega e devolução. Sem import e só com sintaxe apagável, para os testes de
// tests/frontend carregarem este arquivo com require() direto do Node, sem build.

export type NomeTermo = "entrega" | "devolucao";
export type Resposta = "sim" | "nao" | "";

export interface DefinicaoTermo {
  itens: readonly string[];
  campos: readonly string[];
  campoSerie: string;
}

export interface ItemTermo {
  rotulo: string;
  resposta: Resposta | string;
}

export interface DadosTermo {
  termo: string;
  campos: Record<string, string>;
  itens: ItemTermo[];
  obs: string;
}

export interface SecaoTermo {
  titulo: string;
  campos?: [string, string][];
  texto?: string;
}

export const ITENS_ENTREGA = [
  "01 Mochila", "02 Notebook", "03 Teclado", "04 Mouse", "05 Hub USB", "06 Suporte notebook",
  "07 Headset (modelo 8225 ou 3220)", "08 Case headset", "09 Mousepad", "10 Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 Cabo de Segurança",
] as const;
export const ITENS_DEVOLUCAO = [
  "1 - Mochila", "2 - Notebook", "3 - Teclado", "4 - Mouse", "5 - Hub USB", "6 - Suporte notebook",
  "7 - Headset", "8 - Case headset (modelo 8225)", "9 - Mousepad", "10 - Monitor (HDMI / DisplayPort / Cabo de força / USB)", "11 - Cabo de Segurança",
] as const;
export const CAMPOS_ENTREGA = ["nome", "unidade", "data", "modelo_anterior", "modelo_entregue", "serie_anterior", "serie_entregue"] as const;
export const CAMPOS_DEVOLUCAO = ["nome", "unidade", "data", "modelo", "serie"] as const;
export const TERMOS: Record<NomeTermo, DefinicaoTermo> = {
  entrega: { itens: ITENS_ENTREGA, campos: CAMPOS_ENTREGA, campoSerie: "serie_entregue" },
  devolucao: { itens: ITENS_DEVOLUCAO, campos: CAMPOS_DEVOLUCAO, campoSerie: "serie" },
};
export const LIMITE_PARTE = 100;

// Fatia o texto em vez de usar new Date: o fuso não pode deslocar o dia.
export function termosFormatarData(valor: unknown): string {
  const texto = String(valor ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : texto;
}

export function termosLimparParte(valor: unknown, maiusculas = false): string {
  let texto = String(valor ?? "").normalize("NFC").replace(/\s+/g, " ").replace(/[^\p{L}\p{N} -]/gu, "").replace(/ {2,}/g, " ").trim();
  if (maiusculas) texto = texto.toUpperCase();
  texto = texto.slice(0, LIMITE_PARTE).trim();
  return /^[\s-]*$/.test(texto) ? "" : texto;
}

// Nome sugerido do arquivo (título da página durante a impressão): "<série> - <nome>"; vazio se não houver nenhum dos dois.
export function termosNomeArquivo(serie: unknown, nome: unknown): string {
  return [termosLimparParte(serie, true), termosLimparParte(nome)].filter(Boolean).join(" - ");
}

// Dados salvos num lembrete ({campos, itens: ["sim"|"nao"|""], obs}) no mesmo formato que o formulário produz;
// os rótulos vêm daqui, nunca do arquivo. Formato estranho devolve null (o lembrete não mostra o bloco).
export function termosDadosDoLembrete(origem: unknown, salvo: unknown): DadosTermo | null {
  const t = Object.hasOwn(TERMOS, origem as PropertyKey) ? TERMOS[origem as NomeTermo] : null;
  const s = salvo as { campos?: Record<string, unknown>; itens?: unknown[]; obs?: unknown } | null | undefined;
  if (!t || !s || typeof s !== "object" || !s.campos || typeof s.campos !== "object" || !Array.isArray(s.itens)) return null;
  const texto = (v: unknown) => (typeof v === "string" ? v : "");
  const campos: Record<string, string> = {};
  t.campos.forEach((nome) => { campos[nome] = texto(s.campos?.[nome]); });
  const itens = t.itens.map((rotulo, i) => ({ rotulo, resposta: s.itens?.[i] === "sim" || s.itens?.[i] === "nao" ? String(s.itens[i]) : "" }));
  return { termo: String(origem), campos, itens, obs: texto(s.obs) };
}

// Seções do bloco "Dados do termo" do lembrete, com os títulos e rótulos do formulário; vazio vira "—".
export function termosSecoesLembrete(origem: unknown, salvo: unknown): SecaoTermo[] | null {
  const dados = termosDadosDoLembrete(origem, salvo);
  if (!dados) return null;
  const c = dados.campos;
  const entrega = origem === "entrega";
  const v = (texto: string) => (String(texto).trim() ? texto : "—");
  const colaborador: [string, string][] = [
    ["Nome do colaborador", v(c.nome)],
    [entrega ? "Unidade / Departamento" : "Unidade", v(c.unidade)],
    [entrega ? "Data da entrega / troca" : "Data", v(termosFormatarData(c.data))],
  ];
  if (!entrega) colaborador.push(["Modelo do computador", v(c.modelo)], ["Número de série", v(c.serie)]);
  const secoes: SecaoTermo[] = [{ titulo: "Dados do colaborador", campos: colaborador }];
  if (entrega) {
    secoes.push({ titulo: "Identificação do equipamento", campos: [
      ["Modelo do computador, equipamento anterior", v(c.modelo_anterior)],
      ["Modelo do computador, equipamento entregue", v(c.modelo_entregue)],
      ["Número de série / Service Tag, equipamento anterior", v(c.serie_anterior)],
      ["Número de série / Service Tag, equipamento entregue", v(c.serie_entregue)],
    ] });
  }
  const resposta: Record<string, string> = { sim: "Sim", nao: "Não", "": "—" };
  secoes.push(
    { titulo: entrega ? "Equipamentos e acessórios entregues" : "Equipamentos e acessórios devolvidos",
      campos: dados.itens.map((item): [string, string] => [item.rotulo, resposta[item.resposta]]) },
    { titulo: "Observações", texto: v(dados.obs) },
  );
  return secoes;
}

// Tira controles e espaços repetidos: o backend recusa qualquer caractere de controle (categoria Cc).
export const limparTexto = (texto: unknown): string => String(texto ?? "").replace(/[\p{Cc}\s]+/gu, " ").trim();

// Monta a descrição do lembrete a partir dos dados do termo. Partes vazias ficam de fora e nada é cortado.
export function montarDescricaoTermo(termo: string, dados?: Partial<DadosTermo> | null): string {
  const entrada = termo === "entrega";
  const c: Record<string, string> = dados?.campos ?? {};
  const v = (nome: string) => limparTexto(c[nome]);
  const equipamento = (modelo: string, serie: string) => [modelo, serie && `série ${serie}`].filter(Boolean).join(", ");
  const recebido = equipamento(v(entrada ? "modelo_entregue" : "modelo"), v(entrada ? "serie_entregue" : "serie"));
  const unidade = v("unidade");
  const data = limparTexto(termosFormatarData(c.data));
  const itens = (dados?.itens ?? []).filter((i) => i.resposta === "sim").map((i) => limparTexto(i.rotulo));
  const anterior = entrada ? equipamento(v("modelo_anterior"), v("serie_anterior")) : "";
  const obs = limparTexto(dados?.obs);
  const abertura = `${entrada ? "Entrada" : "Saída"}: ${v("nome")}${unidade ? ` (${unidade})` : ""}`;
  return limparTexto([
    `${abertura}${recebido ? ` ${entrada ? "recebeu" : "devolveu"} ${recebido}` : ""}${data ? ` em ${data}` : ""}.`,
    itens.length && `Itens: ${itens.join(", ")}.`,
    anterior && `Anterior: ${anterior}.`,
    obs && `Obs.: ${obs}`,
  ].filter(Boolean).join(" "));
}
