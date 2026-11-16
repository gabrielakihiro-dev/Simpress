// Regras puras do modal "E-mail pelo Outlook" (Home F1): textos aprovados, divisão dos destinatários, troca de {nome} e
// {setor}, texto da confirmação e de cada resultado. Sem import e só com sintaxe apagável, para
// tests/frontend/test_outlook_email_ui.cjs carregar este arquivo com require() sem build.

export const ID_CABO = "cabo";
export const ATRASO_SALVAR = 800;
export const ATRASO_BUSCA = 200;
// Mesmos limites de domains/outlook_mail.py (resolver de contatos).
export const MAX_TOKENS = 50;
export const MAX_TOKEN = 200;
export const MARCADOR = { nome: "[Nome da pessoa]", setor: "[Setor]" };

// Textos aprovados (docs/planos/email-outlook-modelos.md); os marcados "espelho" repetem o que o servidor responde.
export const TEXTO = {
  pendente: "Alteração ainda não salva…",
  salvando: "Salvando…",
  salva: "Salva.",
  falhaSalvar: "Não foi possível salvar: ",
  aberto: "E-mail aberto no Outlook. Revise e envie por lá.",
  enviado: "E-mail enviado pelo Outlook.",
  copiado: "Texto copiado.",
  incerto: "Não foi possível confirmar o envio. Confira os Itens Enviados no Outlook antes de tentar de novo.",
  ultimoModelo: "Mantenha ao menos um modelo.",
  semContato: "Nenhum contato encontrado no Entra.",
  ambiguo: "Há destinatários com mais de uma opção. Escolha a pessoa certa antes de enviar.",
  marcador: "Preencha o nome da pessoa e o setor antes de enviar.", // espelho
  semPara: "Informe o destinatário no campo Para.", // espelho
  // Texto aprovado (10/11/2026): recurso genérico para falha que o servidor não explicou.
  falha: "Não foi possível concluir a operação do e-mail. Tente de novo.",
};

export type TipoAviso = "ok" | "aviso" | "erro";
export type ModoEmail = "abrir" | "enviar";
export interface Contato { nome?: string; email: string }
export interface Conta { id: string; rotulo: string; email?: string; padrao?: boolean }
export interface ErroApi { status?: number; message?: string }
export interface Resultado { texto: string; tipo: TipoAviso }

export const dividir = (texto: string): string[] => String(texto).split(";").map(pedaco => pedaco.trim()).filter(Boolean);
export const tokenFinal = (texto: string): string => String(texto).slice(String(texto).lastIndexOf(";") + 1).trim();
export const rotuloContato = (contato: Contato): string => (contato.nome ? `${contato.nome} <${contato.email}>` : contato.email);
export const rotuloConta = (conta: Conta): string => `${conta.rotulo} (${conta.email || "não configurada"})`;
// Só ";" e espaços no campo não é destinatário.
export const temDestinatario = (texto: string): boolean => texto.replace(/;/g, "").trim() !== "";

// Texto do servidor para erro HTTP; conexão perdida não tem status e só traz mensagem do navegador, então vale o recurso.
export const mensagemDeErro = (erro: ErroApi | null | undefined): string => (erro?.status && erro.message) || TEXTO.falha;

// Troca o texto depois do último ";" por "Nome <endereço>; ".
export function inserirContato(valor: string, contato: Contato): string {
  const corte = valor.lastIndexOf(";");
  return `${valor.slice(0, corte + 1)}${corte >= 0 ? " " : ""}${rotuloContato(contato)}; `;
}

// Troca cada token do mapa pelo texto resolvido, mantendo os ";" e os espaços em volta.
export function substituirTokens(valor: string, mapa: Map<string, string>): { valor: string; mudou: boolean } {
  let mudou = false;
  const pedacos = valor.split(";").map(pedaco => {
    const rotulo = mapa.get(pedaco.trim());
    if (!rotulo) return pedaco;
    mudou = true;
    return pedaco.replace(pedaco.trim(), () => rotulo);
  });
  return { valor: pedacos.join(";"), mudou };
}

// Nomes sem "@" vão para a base do Entra; mesmos limites do servidor.
export const tokensParaResolver = (valor: string): string[] =>
  [...new Set(dividir(valor).filter(token => !token.includes("@") && token.length <= MAX_TOKEN))].slice(0, MAX_TOKENS);

export const podeBuscar = (termo: string, diretorioDisponivel: boolean): boolean =>
  diretorioDisponivel && termo.length >= 2 && !termo.includes("@");

// Seta para baixo ou para cima na lista de sugestões, com volta ao outro extremo.
export function proximoAtivo(ativo: number, total: number, passo: 1 | -1): number {
  if (!total) return ativo;
  return ativo < 0 ? (passo > 0 ? 0 : total - 1) : (ativo + passo + total) % total;
}

export function substituir(texto: string, nome: string, setor: string): string {
  const valores = { nome: nome.trim() || MARCADOR.nome, setor: setor.trim() || MARCADOR.setor };
  return texto.replace(/\{(nome|setor)\}/g, (_, chave: "nome" | "setor") => valores[chave]);
}

// Verdadeiro se, depois de trocar {nome} e {setor}, ainda sobra um marcador sem preencher.
export const marcadorPendente = (assunto: string, corpo: string, nome: string, setor: string): boolean =>
  [assunto, corpo].some(campo => {
    const texto = substituir(campo, nome, setor);
    return texto.includes(MARCADOR.nome) || texto.includes(MARCADOR.setor);
  });

export function textoCopiado(assunto: string, corpo: string, nome: string, setor: string): string {
  return [substituir(assunto, nome, setor), substituir(corpo, nome, setor)].filter(Boolean).join("\n\n");
}

// Cartão de confirmação do envio real; a cláusula do Cc só aparece com Cc preenchido.
export function textoConfirmacaoEnvio(de: string, para: string, cc: string): string {
  const copia = cc.trim();
  const comCopia = temDestinatario(copia) ? `, com cópia para ${copia}` : "";
  return `O e-mail será enviado de ${de} para ${para.trim()}${comCopia}. Depois de enviado, não há como desfazer.`;
}

export function contaInicial(contas: Conta[], idDoModelo: string): string {
  return contas.some(conta => conta.id === idDoModelo) ? idDoModelo : (contas.find(conta => conta.padrao) || contas[0]).id;
}

// Resposta do POST /email. Um envio que o servidor não provou nunca aparece como enviado, nem como falha comum.
export function resultadoEmail(resposta: { status?: string; aviso?: string } | null | undefined, modo: ModoEmail): Resultado {
  const { status, aviso } = resposta || {};
  const sucesso = status === "enviado" ? TEXTO.enviado : status === "aberto" ? TEXTO.aberto : "";
  if (status === "incerto" || (!sucesso && modo === "enviar")) return { texto: aviso || TEXTO.incerto, tipo: "aviso" };
  if (!sucesso) return { texto: TEXTO.falha, tipo: "erro" };
  if (!aviso) return { texto: sucesso, tipo: "ok" };
  return { texto: status === "enviado" ? `${sucesso} ${aviso}` : aviso, tipo: "aviso" };
}

// Falha do POST /email. Sem status HTTP a resposta se perdeu: um envio real pode ter saído, então é "incerto".
export function falhaEmail(erro: ErroApi | null | undefined, modo: ModoEmail): Resultado {
  if (modo === "enviar" && !erro?.status) return { texto: TEXTO.incerto, tipo: "aviso" };
  return { texto: mensagemDeErro(erro), tipo: "erro" };
}
