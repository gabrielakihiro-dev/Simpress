// Regras puras do Relatório mensal (sem DOM nem API), testáveis no Node.
export const MES_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function mesAtual(hoje: Date = new Date()): string {
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

// AAAA-MM válido que não está no futuro (a comparação de texto vale porque o formato é fixo).
export function mesValido(mes: string, hoje: Date = new Date()): boolean {
  return MES_PATTERN.test(mes) && mes <= mesAtual(hoje);
}

// Nome do arquivo do Content-Disposition; sem ele, Relatorio-mensal-<mês>.xlsx.
export function nomeArquivoRelatorio(disposition: string, mes: string): string {
  const match = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
  return match && match[1] ? match[1].replace(/['"]/g, "") : `Relatorio-mensal-${mes}.xlsx`;
}
