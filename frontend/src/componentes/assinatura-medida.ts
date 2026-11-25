// Assinatura do técnico por nome (Termos e Configuração local): regras puras do nome e geometria do texto.
// A geometria usa a caixa de TINTA medida no canvas (não a largura de avanço), em unidades do viewBox do SVG
// (1 unidade = 1 mm da folha). Contrato: docs/cockpit-prompts/17-termos.md ("Assinatura do técnico").

export const FAMILIAS = {
  digitada: "Inter Variable",
  "great-vibes": "Great Vibes",
  "dancing-script": "Dancing Script",
  allura: "Allura",
  "alex-brush": "Alex Brush",
  sacramento: "Sacramento",
} as const;
export type EstiloTexto = keyof typeof FAMILIAS;

export const ehEstiloTexto = (valor: unknown): valor is EstiloTexto => typeof valor === "string" && Object.hasOwn(FAMILIAS, valor);

export interface MedidaAssinatura {
  x: number;
  y: number;
  tamanho: number;
}

export type AssinaturaFolha =
  | { tipo: "desenho"; imagem: HTMLImageElement }
  | { tipo: "texto"; nome: string; estilo: EstiloTexto; medida: MedidaAssinatura };

// Área do SVG em mm: a folga de 18 mm acima da linha, a largura do bloco (~90 mm) e a descida permitida abaixo da linha.
// A linha fica em y = 0; o que sobe é negativo.
export const AREA = { largura: 90, subida: 18, descida: 3 } as const;

const REFERENCIA_PX = 200; // medir grande: a tinta sai com precisão de subpixel
const FOLGA_LARGURA = 0.94; // canvas e <text> do SVG rasterizam um pouco diferente
const FOLGA_ALTURA = 0.97;
const FOLGA_DIGITADA = 0.03; // da própria fonte, entre a tinta mais baixa e a linha
const TAMANHO_MAXIMO = { digitada: 5, cursiva: 9 };

export const LIMITE_NOME = 80;
export const MENSAGEM_NOME = "Use até 80 caracteres: só letras, espaço, ponto, apóstrofo e hífen.";

// Mesma normalização do servidor (domains/configuracao_local.py): o servidor é a autoridade.
export function normalizarNome(valor: string): string {
  return valor.normalize("NFC").replace(/[’‘]/g, "'").split(/\s+/).filter(Boolean).join(" ");
}

/** Mensagem de erro do nome já normalizado, ou "" quando vale. */
export function erroDoNome(nome: string): string {
  if ([...nome].length > LIMITE_NOME || /[^\p{L} .'-]/u.test(nome) || (nome && !/\p{L}/u.test(nome))) return MENSAGEM_NOME;
  return "";
}

export interface Tinta {
  esq: number;
  dir: number;
  asc: number;
  desc: number;
}

const arredondar = (n: number) => Math.round(n * 1000) / 1000;

// Digitada: a tinta mais baixa do texto exato fica rente à linha. Cursiva: linha de base sobre a linha (o corpo apoia,
// as caudas passam), com a descida limitada para não cobrir o rótulo. Nome longo encolhe para caber na largura.
export function calcularMedida({ esq, dir, asc, desc }: Tinta, estilo: EstiloTexto): MedidaAssinatura | null {
  const largura = esq + dir;
  if (![esq, dir, asc, desc].every(Number.isFinite) || !(largura > 0)) return null;
  const digitada = estilo === "digitada";
  const baixo = Math.max(0, desc);
  const altura = Math.max(0, asc) + (digitada ? baixo : 0);
  // u = mm por pixel de referência; o menor limite vence.
  const limites = [
    (digitada ? TAMANHO_MAXIMO.digitada : TAMANHO_MAXIMO.cursiva) / REFERENCIA_PX,
    (AREA.largura * FOLGA_LARGURA) / largura,
    altura > 0 ? (AREA.subida * FOLGA_ALTURA) / altura : Infinity,
    !digitada && baixo > 0 ? (AREA.descida * FOLGA_ALTURA) / baixo : Infinity,
  ];
  const u = Math.min(...limites);
  const tamanho = u * REFERENCIA_PX;
  return {
    tamanho: arredondar(tamanho),
    x: arredondar(AREA.largura / 2 - ((dir - esq) / 2) * u),
    y: digitada ? arredondar(-(baixo * u + FOLGA_DIGITADA * tamanho)) : 0,
  };
}

// fonts.load resolve com [] quando nenhuma face casa, e check() devolve true nesse caso: as duas conferências são necessárias.
// Fonte que não carrega devolve null: nunca se substitui por fonte do sistema.
export async function medirAssinatura(nome: string, estilo: EstiloTexto): Promise<MedidaAssinatura | null> {
  const fonte = `400 ${REFERENCIA_PX}px "${FAMILIAS[estilo]}"`;
  const faces = await document.fonts.load(fonte, nome);
  if (!faces.length || !document.fonts.check(fonte, nome)) return null;
  const contexto = document.createElement("canvas").getContext("2d");
  if (!contexto) return null;
  contexto.font = fonte;
  contexto.textAlign = "left";
  contexto.textBaseline = "alphabetic";
  const m = contexto.measureText(nome);
  return calcularMedida({
    esq: m.actualBoundingBoxLeft, dir: m.actualBoundingBoxRight, asc: m.actualBoundingBoxAscent, desc: m.actualBoundingBoxDescent,
  }, estilo);
}
