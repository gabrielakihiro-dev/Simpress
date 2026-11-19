// Peças de DOM do painel F7 (Histórico de apelidos) no Novo layout: campo rótulo + valor, cabeçalho de bloco com contagem
// em selo e o botão "Carregar mais". Módulo sem importação: o painel em ferramentas-cockpit/estado.ts chama estas funções.
function criar(tag: string, classe = "", texto?: string) {
  const no = document.createElement(tag);
  if (classe) no.className = classe;
  if (texto !== undefined) no.textContent = texto;
  return no;
}

// A contagem aparece só como número dentro do selo; o complemento ("alterações", "registros") fica só para leitor de tela.
export function seloContagem(total: number, complemento: string) {
  const selo = criar("span", "ck-alias-selo-n", String(total));
  selo.append(criar("span", "sr-only", ` ${complemento}`));
  return selo;
}

// Título do bloco do detalhe; com `selo`, a contagem fica ao lado do título (fora do texto do h3).
export function cabecalhoBloco(titulo: string, selo?: HTMLElement | null) {
  const cabecalho = criar("div", "ck-alias-bloco__cab");
  cabecalho.append(criar("h3", "", titulo));
  if (selo) cabecalho.append(selo);
  return cabecalho;
}

// Campo "rótulo em cima, valor embaixo"; `acao` (ex.: botão pequeno) entra na linha do rótulo, à direita; `inteiro` ocupa a linha toda.
export function campoHistorico(rotulo: string, valor: string, opcoes: { mono?: boolean; acao?: HTMLElement | null; inteiro?: boolean } = {}) {
  const campo = criar("div", opcoes.inteiro ? "ck-alias-campo ck-alias-campo--inteiro" : "ck-alias-campo");
  const linha = criar("div", "ck-alias-campo__lin");
  linha.append(criar("span", "ck-alias-campo__rotulo", rotulo));
  if (opcoes.acao) linha.append(opcoes.acao);
  campo.append(linha, criar("span", opcoes.mono ? "ck-alias-campo__valor ck-alias-mono" : "ck-alias-campo__valor", valor));
  return campo;
}

export function gradeCampos(campos: HTMLElement[]) {
  const grade = criar("div", "ck-alias-campos");
  grade.append(...campos);
  return grade;
}

// Fica depois do último grupo da lista, fora de `.ck-ferr-item`, para a contagem de itens da lista não mudar.
export function blocoCarregarMais(aoClicar: () => void) {
  const bloco = criar("div", "ck-alias-mais");
  const botao = criar("button", "ck-btn ck-btn--secundario ck-btn--sm", "Carregar mais") as HTMLButtonElement;
  botao.type = "button";
  botao.id = "cockpit-alias-more";
  botao.addEventListener("click", aoClicar);
  bloco.append(botao);
  return bloco;
}
