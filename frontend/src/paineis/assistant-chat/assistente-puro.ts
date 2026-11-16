// Regras puras do Assistente (F9): textos aprovados, limites, prazo do envio, filtros do que o servidor devolve (arquivos,
// fontes da busca na web, contexto do chamado UX), formatação de datas e tamanhos, WAV da gravação e números do globo.
// Sem import e só com sintaxe apagável, para tests/frontend/test_assistant_chat_ui.cjs carregar este arquivo com require() sem build.

export const LIMITE = 4000;
// O servidor permite uma leitura do Endpoint por mensagem e o modelo tem 90 s; o prazo do navegador é maior para a resposta de
// erro do servidor chegar antes de abortarmos.
export const PRAZO_ENVIO_MS = 600000;
export const LIMITE_ANEXO_BYTES = 10 * 1024 * 1024;
export const TAXA_WAV = 16000;
export const LIMITE_SEGUNDOS = 120;
export const LIMITE_CONTEXTO_UX = 8000;
export const CHAVE_VOZ = "simpress:assistente-voz";

export const DESLIGADO = "Assistente desligado. Configure a chave em Prontidão da base > Configuração local.";
export const PENDENTE_SEM_DESCRICAO = "Há uma ação aguardando sua confirmação.";
export const MSG_PRAZO = "O Assistente demorou demais para responder. Se havia uma ação pendente, confira o cartão antes de tentar de novo.";
export const MSG_CANCELADO = "Envio cancelado. Se o Assistente ainda estiver terminando, aguarde alguns segundos antes de enviar de novo.";
export const MSG_CONVERSA_OCUPADA = "O Assistente ainda está terminando a resposta anterior. Aguarde alguns segundos e tente de novo.";
export const MSG_FALHA_ENVIO = "Não foi possível falar com o Assistente.";
export const AVISO_BUSCA_WEB = "Busca na web ligada: a pergunta de pesquisa sai do computador (vai ao OpenRouter e ao provedor de busca). Só texto genérico; dados do cadastro são recusados antes de sair.";

export const ROTULO_TIPO: Record<string, string> = { pdf: "PDF", docx: "Word", imagem: "Imagem" };

export interface ErroApi { status?: number; name?: string; message?: string }

export interface DadosArquivo { id?: unknown; nome?: unknown; tamanho?: unknown }
export interface ArquivoValido { id: string; nome: string; titulo: string }

export interface DadosFonte { titulo?: unknown; dominio?: unknown; url?: unknown }
export interface DadosBusca { consulta?: unknown; resumo?: unknown; fontes?: unknown }
export interface FonteValida { texto: string; href: string; dominio: string }
export interface BuscaValida { titulo: string; resumo: string; fontes: FonteValida[] }

export interface Lembrete { id: unknown; texto?: unknown; concluida?: unknown; prazo?: unknown; criada_em?: unknown }
export interface ConversaResumo { id: unknown; titulo?: unknown; atualizada_em?: unknown; mensagens?: unknown }

export const tamanhoLegivel = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;

export function dataBrasileira(iso: unknown): string {
  const [ano, mes, dia] = String(iso).slice(0, 10).split("-");
  return dia && mes && ano ? `${dia}/${mes}/${ano}` : String(iso);
}

export function dataHoraConversa(conversa: { atualizada_em?: unknown }): string {
  const quando = String(conversa.atualizada_em || "");
  return quando ? `${dataBrasileira(quando)} ${quando.slice(11, 16)}` : "";
}

export function dataLocalHoje(agora: Date = new Date()): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}`;
}

export const prazoVencido = (prazo: unknown, concluida: boolean, hoje: string): boolean => !concluida && String(prazo) < hoje;

export function metaLembrete(nota: Lembrete, hoje: string): string {
  const concluida = nota.concluida === true;
  const partes: string[] = [];
  if (nota.prazo) partes.push(`Prazo ${dataBrasileira(nota.prazo)}${prazoVencido(nota.prazo, concluida, hoje) ? " (vencido)" : ""}`);
  if (concluida) partes.push("Concluído");
  if (nota.criada_em) partes.push(`Criado em ${dataBrasileira(nota.criada_em)}`);
  return partes.join(" · ");
}

export const tituloConversa = (conversa: { titulo?: unknown }): string => String(conversa.titulo || "Conversa sem título");

export const metaConversa = (conversa: ConversaResumo): string => {
  const partes: string[] = [];
  if (conversa.atualizada_em) partes.push(dataHoraConversa(conversa));
  partes.push(`${Number(conversa.mensagens) || 0} mensagens`);
  return partes.join(" · ");
};

export function metaAnexo(anexo: { tipo?: unknown; tamanho?: unknown; paginas?: unknown }): string {
  const partes = [ROTULO_TIPO[String(anexo.tipo)] || "Arquivo", tamanhoLegivel(Number(anexo.tamanho) || 0)];
  if (anexo.tipo !== "imagem" && Number(anexo.paginas) > 1) partes.push(`${anexo.paginas} páginas de texto`);
  return partes.join(" · ");
}

export const contador = (tamanho: number): string => `${tamanho} / ${LIMITE}`;

// Até 2 ferramentas: a lista simples. Com mais (consultas encadeadas), a contagem e cada nome uma vez, com "×n" quando repetido.
export function resumirFerramentas(ferramentas: string[]): string {
  if (ferramentas.length <= 2) return `Ferramentas: ${ferramentas.join(", ")}`;
  const contagem = new Map<string, number>();
  ferramentas.forEach(nome => contagem.set(nome, (contagem.get(nome) || 0) + 1));
  const nomes = [...contagem].map(([nome, vezes]) => (vezes > 1 ? `${nome} ×${vezes}` : nome));
  return `Ferramentas (${ferramentas.length} chamadas): ${nomes.join(", ")}`;
}

// Relatórios gerados: o servidor devolve só id/nome/tamanho; o link aponta sempre para a rota fixa de download (id validado).
export function arquivosValidos(arquivos: DadosArquivo[]): ArquivoValido[] {
  const saida: ArquivoValido[] = [];
  for (const arquivo of arquivos) {
    const id = String(arquivo?.id ?? "");
    const nome = String(arquivo?.nome ?? "").trim();
    if (!/^[0-9a-f]{16}$/.test(id) || !nome) continue;
    const bytes = Number(arquivo.tamanho);
    saida.push({ id, nome, titulo: bytes > 0 ? `${nome} (${tamanhoLegivel(bytes)})` : "" });
  }
  return saida;
}

// Busca na web: consulta, resumo e fontes vêm montados pelo servidor; só links http/https viram link (href vazio = sem link).
export function buscasValidas(buscas: DadosBusca[]): BuscaValida[] {
  const saida: BuscaValida[] = [];
  for (const busca of buscas) {
    const resumo = String(busca?.resumo ?? "").trim();
    const fontes: DadosFonte[] = Array.isArray(busca?.fontes) ? busca.fontes : [];
    if (!resumo && !fontes.length) continue;
    saida.push({
      titulo: `Fonte externa · busca na web: ${String(busca?.consulta ?? "")}`,
      resumo,
      fontes: fontes.map(fonte => {
        const titulo = String(fonte?.titulo ?? "").trim();
        const dominio = String(fonte?.dominio ?? "").trim();
        const url = String(fonte?.url ?? "");
        const link = /^https?:\/\//i.test(url);
        return { texto: titulo || dominio || (link ? url : "Fonte sem link"), href: link ? url : "", dominio };
      }),
    });
  }
  return saida;
}

export function contextoUX(contexto?: { serial?: unknown; descricao?: string } | null): { contexto_ux: unknown } | Record<string, never> {
  return contexto?.serial && String(contexto.descricao ?? "").length <= LIMITE_CONTEXTO_UX ? { contexto_ux: contexto } : {};
}

// Prazo e cancelamento: o motivo guardado no envio escolhe o texto do status.
export const mensagemDeAborto = (motivo: string): string => (motivo === "prazo" ? MSG_PRAZO : MSG_CANCELADO);

export interface ResultadoErroEnvio { texto: string; offline: boolean; oferecerNovamente: boolean }
export function resultadoErroEnvio(erro: ErroApi | null | undefined, motivo: string): ResultadoErroEnvio {
  const offline = erro?.status === 503;
  if (erro?.name === "AbortError") return { texto: mensagemDeAborto(motivo), offline, oferecerNovamente: false };
  // O servidor mantém a conversa travada até terminar a rodada anterior.
  if (erro?.status === 409) return { texto: MSG_CONVERSA_OCUPADA, offline, oferecerNovamente: false };
  return { texto: erro?.message || MSG_FALHA_ENVIO, offline, oferecerNovamente: offline };
}

// Não perde o texto digitado quando o envio falha: devolve ao campo só se ele continua vazio.
export const textoDevolvido = (textoParaDevolver: string, valorAtual: string): string | null =>
  textoParaDevolver && !valorAtual ? textoParaDevolver : null;

export const textoStatusPronto = (modelo: string): string => (modelo ? `Assistente pronto · ${modelo}` : "Assistente pronto.");

export const rotuloGravacao = (gravando: boolean, transcrevendo: boolean, segundos: number): string => {
  if (gravando) return `Parar (${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")})`;
  return transcrevendo ? "Transcrevendo…" : "Gravar áudio";
};

export type EstadoGlobo = "parado" | "ouvindo" | "pensando" | "falando";

export function estadoDoGlobo(s: { gravando: boolean; ocupado: boolean; transcrevendo: boolean; falando: boolean }): EstadoGlobo {
  if (s.gravando) return "ouvindo";
  if (s.ocupado || s.transcrevendo) return "pensando";
  return s.falando ? "falando" : "parado";
}

export const VELOCIDADE_GLOBO: Record<EstadoGlobo, number> = { parado: 0.4, ouvindo: 0.9, pensando: 3, falando: 1.4 };

export function nivelDoGlobo(estado: EstadoGlobo, t: number, microfone: number): number {
  switch (estado) {
    case "ouvindo": return microfone;
    case "pensando": return 0.12 + 0.08 * Math.sin(t * 5);
    case "falando": return 0.28 + 0.2 * Math.abs(Math.sin(t * 9));
    default: return 0.04 * Math.sin(t * 1.6);
  }
}

// PCM 16 bits, 16 kHz, mono: o formato que o servidor aceita em /api/assistente/audio.
export function paraWav(amostras: ArrayLike<number>): ArrayBuffer {
  const dados = new DataView(new ArrayBuffer(44 + amostras.length * 2));
  const texto = (posicao: number, valor: string) => [...valor].forEach((letra, i) => dados.setUint8(posicao + i, letra.charCodeAt(0)));
  texto(0, "RIFF");
  dados.setUint32(4, 36 + amostras.length * 2, true);
  texto(8, "WAVEfmt ");
  dados.setUint32(16, 16, true);
  dados.setUint16(20, 1, true);
  dados.setUint16(22, 1, true);
  dados.setUint32(24, TAXA_WAV, true);
  dados.setUint32(28, TAXA_WAV * 2, true);
  dados.setUint16(32, 2, true);
  dados.setUint16(34, 16, true);
  texto(36, "data");
  dados.setUint32(40, amostras.length * 2, true);
  for (let i = 0; i < amostras.length; i += 1) dados.setInt16(44 + i * 2, Math.max(-1, Math.min(1, amostras[i])) * 0x7fff, true);
  return dados.buffer;
}
