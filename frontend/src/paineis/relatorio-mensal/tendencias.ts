// Sub-aba "Tendências" do Relatório mensal (F8): tempo médio das OS e "Sem acesso há 7 dias ou mais" nos últimos 30 ou 90 dias.
// Só leitura de GET /api/relatorio-mensal/tendencias; não depende do mês escolhido. Render puro (createElement/textContent,
// nada de innerHTML com dado). Sem importações e só sintaxe apagável: os testes carregam este .ts direto no Node.
type Registro = Record<string, any>;
type Cartao = (card: HTMLElement, tom: string, atraso: number) => HTMLElement;

export const PERIODOS = [30, 90];
const SVG = "http://www.w3.org/2000/svg";
const MENOS = "−"; // sinal de menos tipográfico

function criar(tag: string, classe = "", texto?: string) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  if (texto !== undefined) no.textContent = texto;
  return no;
}

function svg(tag: string, atributos: Record<string, string | number> = {}, texto?: string) {
  const no = document.createElementNS(SVG, tag);
  Object.entries(atributos).forEach(([nome, valor]) => no.setAttribute(nome, String(valor)));
  if (texto !== undefined) no.textContent = texto;
  return no;
}

// 12.35 -> "12,4"; vírgula decimal pt-BR, uma casa.
export const formatarDias = (valor: number) => (Math.round(valor * 10) / 10).toFixed(1).replace(".", ",");
// Singular só para 0 < |x| < 2; zero é plural ("0,0 dias").
export const unidadeDias = (valor: number) => { const a = Math.abs(Math.round(valor * 10) / 10); return a > 0 && a < 2 ? "dia" : "dias"; };
// Sinal sempre (queda com "−", alta com "+", zero sem sinal).
function comSinal(texto: string, valor: number) {
  return valor < 0 ? `${MENOS}${texto}` : valor > 0 ? `+${texto}` : texto;
}
export const dataCurta = (iso: string) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[2]}/${m[1]}` : ""; };
export const dataLonga = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : ""; };

function caixa(valor: string, rotulo: string, bom = false) {
  const no = criar("div", "nf8-tend__caixa");
  const forte = criar("b", bom ? "nf8-tend__bom" : "", valor);
  no.append(forte, criar("span", "", rotulo));
  return no;
}

function semDados(dias: number, motivo: string) {
  const no = criar("div", "nf8-tend__vazio");
  no.setAttribute("role", "status");
  no.append(criar("strong", "", `Sem dados suficientes nos últimos ${dias} dias.`), document.createTextNode(motivo));
  return no;
}

function cartaoTempo(dados: Registro, cartao: Cartao) {
  const dias = Number(dados.dias);
  const t = dados.tempo_medio_os || {};
  const no = criar("article", "ck-rel__cartao nf8-tend__cartao");
  no.id = "rel-tend-tempo";
  no.append(criar("h4", "ck-rel__cartao-titulo", "Tempo médio das OS"));
  if (!t.encerradas || t.media_dias == null) {
    no.append(semDados(dias, "Nenhuma OS Oracle encerrada com data no período."));
    return cartao(no, "ciano", 0);
  }
  const media = Number(t.media_dias);
  const anterior = t.media_dias_anterior == null ? null : Number(t.media_dias_anterior);
  no.append(criar("p", "nf8-tend__sub", `Da abertura ao encerramento · OS Oracle encerradas nos últimos ${dias} dias`));
  const num = criar("div", "nf8-tend__num");
  num.append(document.createTextNode(`${formatarDias(media)} `), criar("small", "", unidadeDias(media)));
  const caixas = criar("div", "nf8-tend__caixas");
  caixas.append(
    caixa(String(t.encerradas), "OS encerradas"),
    caixa(anterior == null ? "—" : `${formatarDias(anterior)} ${unidadeDias(anterior)}`, `${dias} dias anteriores`),
  );
  if (anterior != null) {
    const delta = Math.round((media - anterior) * 10) / 10;
    caixas.append(caixa(`${comSinal(formatarDias(Math.abs(delta)), delta)} ${unidadeDias(delta)}`, "Variação", delta < 0));
  }
  no.append(num, caixas);
  if (Number(t.encerradas_sem_data) > 0) no.append(criar("p", "nf8-tend__nota", `Encerradas sem data de conclusão ficam de fora: ${t.encerradas_sem_data}`));
  if (anterior == null) no.append(criar("p", "nf8-tend__nota", `Sem OS encerradas nos ${dias} dias anteriores para comparar.`));
  return cartao(no, "ciano", 0);
}

// Linha simples: pontos igualmente espaçados (uma marca por atualização), 3 linhas de grade (máximo, meio, mínimo).
function graficoAcesso(pontos: Registro[], rotulo: string) {
  const largura = 500, esq = 44, dir = 490, topo = 20, base = 100;
  const valores = pontos.map(p => Number(p.total));
  let max = Math.max(...valores), min = Math.min(...valores);
  if (max === min) { max += 1; min -= 1; }
  const y = (v: number) => Math.round((base - ((v - min) / (max - min)) * (base - topo)) * 10) / 10;
  const x = (i: number) => Math.round((esq + 6 + (i * (dir - esq - 12)) / (pontos.length - 1)) * 10) / 10;
  const raiz = svg("svg", { viewBox: `0 0 ${largura} 128`, width: "100%", role: "img", "aria-label": rotulo, class: "nf8-tend__svg" });
  // Com pouca amplitude o meio arredonda igual a uma ponta: só rótulos distintos (a linha de grade fica).
  const marcas = [max, (max + min) / 2, min];
  const rotulos = marcas.filter((v, i) => marcas.findIndex(o => Math.round(o) === Math.round(v)) === i);
  const grade = svg("g", { class: "nf8-tend__reticula" });
  marcas.forEach(v => grade.append(svg("line", { x1: esq, x2: dir, y1: y(v), y2: y(v) })));
  raiz.append(grade);
  rotulos.forEach(v => raiz.append(svg("text", { x: 0, y: y(v) + 4 }, String(Math.round(v)))));
  raiz.append(svg("polyline", { class: "nf8-tend__linha", points: pontos.map((_, i) => `${x(i)},${y(valores[i])}`).join(" ") }));
  valores.forEach((v, i) => raiz.append(svg("circle", { class: "nf8-tend__ponto", cx: x(i), cy: y(v), r: 3.5 })));
  raiz.append(svg("text", { x: esq, y: 124 }, dataCurta(pontos[0].data)), svg("text", { x: dir, y: 124, "text-anchor": "end" }, dataCurta(pontos[pontos.length - 1].data)));
  return raiz;
}

function cartaoAcesso(dados: Registro, cartao: Cartao) {
  const dias = Number(dados.dias);
  const s = dados.sem_acesso_7_dias || {};
  const pontos: Registro[] = Array.isArray(s.pontos) ? s.pontos : [];
  const no = criar("article", "ck-rel__cartao nf8-tend__cartao");
  no.id = "rel-tend-acesso";
  no.append(criar("h4", "ck-rel__cartao-titulo", "Sem acesso há 7 dias ou mais"));
  if (pontos.length < 2) {
    no.append(semDados(dias, "Menos de 2 atualizações de inventário no período."));
    return cartao(no, "fucsia", 1);
  }
  const primeiro = pontos[0], ultimo = pontos[pontos.length - 1];
  const delta = Number(ultimo.total) - Number(primeiro.total);
  no.append(criar("p", "nf8-tend__sub", `Uma marca por atualização de inventário nos últimos ${dias} dias`));
  const num = criar("div", "nf8-tend__num");
  num.append(document.createTextNode(`${ultimo.total} `), criar("small", "", "na última atualização"));
  const rotulo = `Sem acesso há 7 dias ou mais: de ${primeiro.total} em ${dataCurta(primeiro.data)} para ${ultimo.total} em ${dataCurta(ultimo.data)}, ${pontos.length} atualizações`;
  const caixas = criar("div", "nf8-tend__caixas");
  caixas.append(caixa(String(primeiro.total), `Primeira (${dataCurta(primeiro.data)})`), caixa(comSinal(String(Math.abs(delta)), delta), "Variação no período", delta < 0));
  no.append(num, graficoAcesso(pontos, rotulo), caixas);
  if (s.historico_desde && String(s.historico_desde) > String(dados.inicio || "")) no.append(criar("span", "nf8-tend__selo", `Histórico desde ${dataLonga(s.historico_desde)}`));
  return cartao(no, "fucsia", 1);
}

/** Cartões (ciano e fúcsia) para a resposta de /api/relatorio-mensal/tendencias. */
export function montarCorpoTendencias(dados: Registro, cartao: Cartao) {
  const grade = criar("div", "nf8-tend__grade");
  grade.append(cartaoTempo(dados, cartao), cartaoAcesso(dados, cartao));
  return grade;
}

/** Carregando (status) ou falha (alert), no lugar dos cartões. */
export function avisoTendencias(texto: string, papel: "status" | "alert") {
  const no = criar("p", "nf8-tend__aviso", texto);
  no.setAttribute("role", papel);
  return no;
}

/** Cabeçalho: título, selo e segmentado "Período" (30 | 90 dias). `aoMudar` recebe o número de dias; `aoRepetir`, o clique no período já ativo. */
export function montarCabecalhoTendencias(periodoInicial: number, aoMudar: (dias: number) => void, aoRepetir?: (dias: number) => void) {
  let atual = PERIODOS.includes(periodoInicial) ? periodoInicial : PERIODOS[0];
  const cab = criar("div", "nf8-tend__cab");
  const titulo = criar("div", "nf8-tend__titulo");
  titulo.append(criar("h3", "ck-rel__titulo", "Tendências"), criar("span", "nf8-tend__selo", "Até hoje · não muda com o mês"));
  const periodo = criar("div", "nf8-tend__periodo");
  const seletor = criar("div", "nf8-seg");
  seletor.setAttribute("role", "group");
  seletor.setAttribute("aria-label", "Período");
  const botoes = PERIODOS.map(dias => {
    const botao = criar("button", "nf8-seg__op", `${dias} dias`) as HTMLButtonElement;
    botao.type = "button";
    botao.dataset.relPeriodo = String(dias);
    botao.setAttribute("aria-pressed", String(dias === atual));
    botao.addEventListener("click", () => {
      if (dias === atual) { aoRepetir?.(dias); return; }
      atual = dias;
      botoes.forEach(outro => outro.setAttribute("aria-pressed", String(outro.dataset.relPeriodo === String(atual))));
      aoMudar(dias);
    });
    return botao;
  });
  seletor.append(...botoes);
  periodo.append(criar("span", "nf8-rotulo", "Período"), seletor);
  cab.append(titulo, periodo);
  return cab;
}
