// Nomes de mês do Relatório mensal (F8), sem DOM nem importação (os testes carregam este .ts direto no Node).
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const CHAVE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function capitalizar(texto: string): string {
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : texto;
}

// "novembro" a partir de AAAA-MM; vazio quando a chave é inválida.
export function nomeDoMes(chave: string): string {
  const achado = CHAVE_MES.exec(String(chave || ""));
  return achado ? MESES[Number(achado[2]) - 1] : "";
}

// "novembro de 2026": usa o rótulo do servidor (`mes.label`) e, se faltar ou vier em formato de data (AAAA-MM), monta pela chave.
export function mesPorExtenso(chave: string, rotulo?: string): string {
  const texto = String(rotulo || "").trim();
  if (texto && !/^\d{4}-\d{2}/.test(texto)) return texto;
  const achado = CHAVE_MES.exec(String(chave || ""));
  return achado ? `${MESES[Number(achado[2]) - 1]} de ${achado[1]}` : "mês selecionado";
}
