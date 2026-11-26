// Regras locais do histórico usadas pelo painel antigo e pelo React.
export interface EventoHistorico {
  id: string;
  serial?: string;
  tipo?: string;
  acao?: string;
}

export type CategoriaEvento = "apelido" | "endereco" | "usuario" | "aviso_endpoint";

export interface AcoesEventoHistorico {
  desfazer: boolean;
  excluir: boolean;
  rotuloExcluir: "Excluir aviso" | "Restaurar e excluir";
}

export function categoriaEvento(evento: EventoHistorico): CategoriaEvento {
  if (evento.tipo === "endereco" || evento.tipo === "usuario" || evento.tipo === "aviso_endpoint") return evento.tipo;
  return "apelido";
}

// A API entrega os registros do mais recente ao mais antigo.
export function ultimoRegistroPorCampo(eventos: readonly EventoHistorico[]): Map<string, string> {
  const ultimaPorCampo = new Map<string, string>();
  eventos.forEach(evento => {
    const serial = String(evento.serial || "").toUpperCase();
    const categoria = categoriaEvento(evento);
    const tipoCampo = categoria === "aviso_endpoint" ? `aviso:${evento.id}` : categoria;
    const chaveCampo = `${serial}:${tipoCampo}`;
    if (serial && !ultimaPorCampo.has(chaveCampo)) ultimaPorCampo.set(chaveCampo, evento.id);
  });
  return ultimaPorCampo;
}

export function acoesEventoHistorico(
  evento: EventoHistorico,
  eventos: readonly EventoHistorico[],
  ultimaPorCampo = ultimoRegistroPorCampo(eventos),
): AcoesEventoHistorico {
  const serial = String(evento.serial || "").toUpperCase();
  const categoria = categoriaEvento(evento);
  const ehAviso = categoria === "aviso_endpoint";
  const ehEndereco = categoria === "endereco";
  const chaveCampo = `${serial}:${ehAviso ? `aviso:${evento.id}` : categoria}`;
  // Evento automático da importação: o back-end recusa desfazer e restaurar (409).
  const automatico = evento.acao === "hostname_backup";
  const ehUltimoCampo = !automatico && Boolean(serial) && ultimaPorCampo.get(chaveCampo) === evento.id;
  return {
    desfazer: ehUltimoCampo && !ehEndereco && !ehAviso,
    excluir: ehUltimoCampo && !ehEndereco,
    rotuloExcluir: ehAviso ? "Excluir aviso" : "Restaurar e excluir",
  };
}
