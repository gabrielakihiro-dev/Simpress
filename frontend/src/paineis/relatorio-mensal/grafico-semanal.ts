// Gráfico "Movimento do mês" do Relatório mensal (F8, Novo layout): barras agrupadas por semana (Abertas, Concluídas,
// Encerradas), por fonte (Ambas, Oracle, Simpress). Calculado no cliente a partir de `report.os.linhas`, sem API nova.
// Sem importações e só sintaxe apagável: os testes carregam este .ts direto no Node; o DOM só é tocado em `montarMovimento`.
type Registro = Record<string, any>;

export type Fonte = "ambas" | "oracle" | "simpress";
export const FONTES: Array<{ id: Fonte; rotulo: string }> = [
  { id: "ambas", rotulo: "Ambas" }, { id: "oracle", rotulo: "Oracle" }, { id: "simpress", rotulo: "Simpress" },
];
export const SERIES = [
  { id: "abertas", rotulo: "Abertas" }, { id: "concluidas", rotulo: "Concluídas" }, { id: "encerradas", rotulo: "Encerradas" },
] as const;
export type Serie = (typeof SERIES)[number]["id"];
export type Barras = Record<Serie, number>;
export interface Semana { inicio: number; fim: number; parcial: boolean; rotulo: string; titulo: string }

const ABERTA = "Aberta no mês";
const CONCLUIDA = "Concluída no mês";
const ATRASO_BARRA_MS = 40; // entrada escalonada: cada barra espera 40 ms a mais que a anterior
const ATRASO_MAXIMO_MS = 400;
const ALTURA_PLOT = "180px";
const CHAVE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/;

const doisDigitos = (n: number) => String(n).padStart(2, "0");

export function diasDoMes(chave: string): number {
  const achado = CHAVE_MES.exec(String(chave || ""));
  return achado ? new Date(Number(achado[1]), Number(achado[2]), 0).getDate() : 0;
}

function rotuloDoIntervalo(chave: string, inicio: number, fim: number): string {
  const mes = chave.slice(5, 7);
  if (inicio === fim) return `${doisDigitos(inicio)}/${mes}`;
  return `${doisDigitos(inicio)}${fim === inicio + 1 ? " e " : " a "}${doisDigitos(fim)}/${mes}`;
}

// Blocos de 7 dias a partir do dia 1 (1 a 7, 8 a 14...). Mês parcial com data de corte dentro dele termina no corte, e o
// último bloco, se ficou mais curto que o do mês fechado, é "parcial". Corte fora do mês (ou ausente): mês inteiro.
export function semanasDoMes(chave: string, corte?: string | null, parcial = false): Semana[] {
  const dias = diasDoMes(chave);
  if (!dias) return [];
  const diaCorte = parcial && String(corte || "").slice(0, 7) === chave ? Number(String(corte).slice(8, 10)) : 0;
  const limite = diaCorte >= 1 && diaCorte < dias ? diaCorte : dias;
  const semanas: Semana[] = [];
  for (let inicio = 1; inicio <= limite; inicio += 7) {
    const fim = Math.min(inicio + 6, limite);
    const ehParcial = fim < Math.min(inicio + 6, dias);
    const rotulo = rotuloDoIntervalo(chave, inicio, fim);
    semanas.push({ inicio, fim, parcial: ehParcial, rotulo, titulo: ehParcial ? `${rotulo} (parcial)` : rotulo });
  }
  return semanas;
}

// Dia (1 a 31) de uma data da API ("2026-11-05" ou "2026-11-05T14:12:00") dentro do mês `chave`; 0 fora dele ou sem data.
function diaNoMes(valor: unknown, chave: string): number {
  const achado = /^(\d{4}-\d{2})-(\d{2})/.exec(String(valor || ""));
  return achado && achado[1] === chave ? Number(achado[2]) : 0;
}

// Abertas = criadas no mês; Concluídas = concluídas no mês; Encerradas = encerradas sem data de conclusão, pela semana de criação
// (o relatório não guarda a data do encerramento). Cada linha cai em no máximo uma semana por série.
export function contarPorSemana(linhas: Registro[], semanas: Semana[], chave: string, fonte: Fonte): Barras[] {
  const contagens: Barras[] = semanas.map(() => ({ abertas: 0, concluidas: 0, encerradas: 0 }));
  const semanaDe = (valor: unknown) => {
    const dia = diaNoMes(valor, chave);
    return dia ? semanas.findIndex(semana => dia >= semana.inicio && dia <= semana.fim) : -1;
  };
  (Array.isArray(linhas) ? linhas : []).forEach(linha => {
    if (fonte !== "ambas" && String(linha?.fonte || "").toLowerCase() !== fonte) return;
    const situacao: string[] = Array.isArray(linha?.situacao) ? linha.situacao : [];
    const criada = semanaDe(linha?.criacao);
    const concluida = semanaDe(linha?.conclusao);
    if (situacao.includes(ABERTA) && criada >= 0) contagens[criada].abertas += 1;
    if (situacao.includes(CONCLUIDA) && concluida >= 0) contagens[concluida].concluidas += 1;
    if (linha?.encerrada && !linha.conclusao && criada >= 0) contagens[criada].encerradas += 1;
  });
  return contagens;
}

// Eixo Y: topo = maior barra (mínimo 1) e marcas de 0 em 0 em passos "redondos" (1, 2, 5, 10...) com no máximo 4 intervalos.
export function eixoY(maximo: number): { topo: number; marcas: number[] } {
  const topo = Math.max(1, Math.ceil(Number(maximo) || 0));
  const passo = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find(candidato => topo / candidato <= 4) ?? 10000;
  const marcas: number[] = [];
  for (let valor = 0; valor <= topo; valor += passo) marcas.push(valor);
  return { topo, marcas };
}

const porcento = (valor: number, topo: number) => `${Math.round((valor / topo) * 1000) / 10}%`;

function resumoParaLeitor(semanas: Semana[], contagens: Barras[], nomeFonte: string): string {
  const partes = semanas.map((semana, i) => `${semana.titulo}: ${SERIES.map(serie => `${serie.rotulo} ${contagens[i][serie.id]}`).join(", ")}`);
  return `Movimento do mês por semana, ${nomeFonte}: ${partes.join("; ")}`;
}

function criar(tag: string, classe = "", texto?: string) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  if (texto !== undefined) no.textContent = texto;
  return no;
}

function desenharGrafico(os: Registro, mes: Registro, fonte: Fonte): HTMLElement {
  const chave = String(mes?.key || "");
  const semanas = semanasDoMes(chave, mes?.data_corte, Boolean(mes?.parcial));
  const grafico = criar("div", "nf8-g");
  grafico.dataset.fonte = fonte;
  if (!semanas.length) {
    grafico.append(criar("p", "ck-lista__vazio", "Sem dados semanais para este mês."));
    return grafico;
  }
  const linhas = Array.isArray(os?.linhas) ? os.linhas : [];
  const contagens = contarPorSemana(linhas, semanas, chave, fonte);
  // A escala vem de "Ambas" (a maior): trocar a fonte não muda a régua, então as barras de uma fonte se comparam com as da outra.
  const todas = contarPorSemana(linhas, semanas, chave, "ambas");
  const { topo, marcas } = eixoY(Math.max(0, ...todas.flatMap(semana => SERIES.map(serie => semana[serie.id]))));
  // Legenda = soma das barras: o total do servidor de "Encerradas" inclui OS criadas antes do mês, que não têm barra.
  const totais = Object.fromEntries(SERIES.map(serie => [serie.id, contagens.reduce((soma, semana) => soma + semana[serie.id], 0)])) as Barras;

  const legenda = criar("div", "nf8-leg");
  SERIES.forEach((serie, i) => {
    const item = criar("span");
    item.title = serie.id === "encerradas" ? "Encerradas sem data de conclusão" : serie.rotulo;
    item.append(criar("i", `nf8-sw s${i + 1}`), document.createTextNode(serie.rotulo), criar("b", "ck-num", String(totais[serie.id])));
    legenda.append(item);
  });

  const nomeFonte = fonte === "ambas" ? "Oracle e Simpress" : fonte === "oracle" ? "Oracle" : "Simpress";
  const plot = criar("div", "nf8-plot");
  plot.setAttribute("role", "img");
  plot.setAttribute("aria-label", resumoParaLeitor(semanas, contagens, nomeFonte));
  plot.style.setProperty("--h", ALTURA_PLOT);
  const eixo = criar("div", "nf8-eixo");
  marcas.forEach(valor => {
    const marca = criar("span", "", String(valor));
    marca.style.bottom = porcento(valor, topo);
    eixo.append(marca);
  });
  const area = criar("div", "nf8-area");
  marcas.filter(valor => valor > 0).forEach(valor => {
    const linha = criar("span", "nf8-lin");
    linha.style.bottom = porcento(valor, topo);
    area.append(linha);
  });
  let barra = 0;
  semanas.forEach((semana, i) => {
    const grupo = criar("div", "nf8-gr");
    SERIES.forEach((serie, s) => {
      const valor = contagens[i][serie.id];
      const no = criar("span", `nf8-b s${s + 1}`);
      no.title = `${semana.titulo} · ${serie.rotulo}: ${valor}`;
      no.style.height = porcento(valor, topo);
      no.style.animationDelay = `${Math.min(barra * ATRASO_BARRA_MS, ATRASO_MAXIMO_MS)}ms`;
      barra += 1;
      grupo.append(no);
    });
    area.append(grupo);
  });
  plot.append(eixo, area);

  const x = criar("div", "nf8-x");
  const rotulos = criar("div", "nf8-xs");
  semanas.forEach(semana => {
    const rotulo = criar("span", "", semana.rotulo);
    if (semana.parcial) rotulo.append(criar("small", "", "parcial"));
    rotulos.append(rotulo);
  });
  x.append(criar("span"), rotulos);
  grafico.append(legenda, plot, x);
  return grafico;
}

// Seletor "Fonte" (Ambas, Oracle, Simpress) e o gráfico. O seletor vai no cabeçalho do cartão; trocar a fonte redesenha só o gráfico
// (as barras entram de novo) e avisa `aoMudar` para o painel lembrar a escolha entre recargas.
export function montarMovimento(os: Registro, mes: Registro, fonteInicial: Fonte = "ambas", aoMudar?: (fonte: Fonte) => void) {
  let atual: Fonte = FONTES.some(fonte => fonte.id === fonteInicial) ? fonteInicial : "ambas";
  const seletor = criar("div", "nf8-seg");
  seletor.setAttribute("role", "group");
  seletor.setAttribute("aria-label", "Fonte");
  let grafico = desenharGrafico(os, mes, atual);
  const botoes = FONTES.map(fonte => {
    const botao = criar("button", "nf8-seg__op", fonte.rotulo) as HTMLButtonElement;
    botao.type = "button";
    botao.dataset.relFonte = fonte.id;
    botao.setAttribute("aria-pressed", String(fonte.id === atual));
    botao.addEventListener("click", () => {
      if (fonte.id === atual) return;
      atual = fonte.id;
      botoes.forEach(outro => outro.setAttribute("aria-pressed", String(outro.dataset.relFonte === atual)));
      const novo = desenharGrafico(os, mes, atual);
      grafico.replaceWith(novo);
      grafico = novo;
      aoMudar?.(atual);
    });
    return botao;
  });
  seletor.append(...botoes);
  return { seletor, grafico };
}
