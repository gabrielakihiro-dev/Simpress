// Regras puras do painel Sebrae (F5), sem DOM, rede nem estado.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Qualquer = any;

export const CAMPOS_AUTOMATICOS = Object.freeze([
  ["C", "Chamado"], ["P", "Abertura"], ["I", "Solicitante"], ["K", "Série"], ["L", "Modelo"], ["N", "Cidade"], ["E", "OS"],
]);
export const CAMPOS_PREENCHIDOS = Object.freeze([["K", "Série"], ["L", "Modelo"], ["N", "Cidade"], ["E", "OS"]]); // do antigo: vazios são preenchidos pelo site
export const STATUS_CHAMADO = Object.freeze(["EM ABERTO", "FINALIZADO"]);
export const STATUS_FINALIZADO = "FINALIZADO"; // sugestão do Status (D) em todo chamado do F5
export const TIPOS_CHAMADO = Object.freeze(["INCIDENTE", "SOLICITAÇÃO"]);
export const PADROES_MANUAIS = Object.freeze({ D: "EM ABERTO", S: "DISPONIBILIDADE" }); // Status e Tipo SLA habituais dos novos; o usuário pode trocar ou apagar
// Chamados criados pela API: classificação habitual (A, B, J) mais os padrões de todos; a descrição "Revisado." entra uma vez só (secaoFinalizar)
export const PADROES_API_SEBRAE = Object.freeze({ A: "CLIENTE", B: "OUTRO", D: "EM ABERTO", J: "INCIDENTE", S: "DISPONIBILIDADE" });
export const DESCRICAO_API_SEBRAE = "Revisado.";
export const SOLICITANTE_API_SEBRAE = "api sebrae"; // mesma comparação de SOLICITANTE_SEM_EMAIL (scripts/sebrae_softexpert.py): sem acento, maiúsculas e espaços extras

export function ehApiSebrae(solicitante: Qualquer): boolean {
  const limpo = String(solicitante || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return limpo === SOLICITANTE_API_SEBRAE;
}

/** Padrões de um chamado novo; recebe o solicitante (coluna I) ou o item do formulário. */
export function padroesManuais(origem: Qualquer): Readonly<Record<string, string>> {
  const solicitante = origem && typeof origem === "object" ? origem.linha?.I : origem;
  return ehApiSebrae(solicitante) ? PADROES_API_SEBRAE : PADROES_MANUAIS;
}
export const AVISO_CRUZAMENTO = Object.freeze({
  ausente: "Série, modelo e cidade vazios: nenhum equipamento encontrado para este solicitante.",
  ambiguo: "Série, modelo e cidade vazios: mais de um equipamento encontrado para este solicitante.",
});

/** Aviso de descrição que cita mais de uma pessoa: nada foi preenchido pelo nome, o usuário preenche série, modelo, cidade e OS. */
export function avisoOutraPessoa(item: Qualquer): string {
  return item.outra_pessoa ? `A descrição cita mais de uma pessoa (${item.outra_pessoa} e outra): série, modelo, cidade e OS não foram preenchidos; preencha à mão.` : "";
}

/** Nota de chamado ligado ao equipamento pelo nome citado na descrição, e não pelo solicitante. */
export function avisoNomeDaDescricao(item: Qualquer): string {
  return item.nome_da_descricao ? `Equipamento procurado pelo nome citado na descrição (${item.nome_da_descricao}), não pelo solicitante.` : "";
}

/** "2026-10-28T14:30" (campo datetime-local) → "28/10/2026 14:30", o formato da coluna R. */
export function formatarEncerramento(valor: Qualquer): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(valor || ""));
  return partes ? `${partes[3]}/${partes[2]}/${partes[1]} ${partes[4]}` : "";
}

/** "28/10/2026 14:30" (como o Dashboard guarda a coluna R) → "2026-10-28T14:30" (campo datetime-local). Só a data dá "": nenhuma hora inventada. */
export function encerramentoParaCampo(texto: Qualquer): string {
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(texto || "").trim());
  if (!partes) return "";
  const [, dia, mes, ano, hora, minuto] = partes;
  const data = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));
  const real = data.getUTCDate() === Number(dia) && data.getUTCMonth() === Number(mes) - 1 && Number(ano) >= 2000 && Number(hora) < 24 && Number(minuto) < 60;
  return real ? `${ano}-${mes}-${dia}T${hora}:${minuto}` : ""; // data impossível: "" (o servidor recusaria com 422)
}

/** Botão "Agora" do R (pedido do usuário, 27/11/2026): data e hora do relógio deste computador no formato do campo datetime-local. Só roda no clique. */
export function encerramentoAgora(agora: Date = new Date()): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-${dois(agora.getDate())}T${dois(agora.getHours())}:${dois(agora.getMinutes())}`;
}

export const MAX_TITULO = 300; // mesmo limite de ChamadoManual.G no servidor (routers/sebrae_dashboard.py)
const LIMITE_H_LIDO = 2000; // a coluna H lida do Dashboard chega cortada aqui (LIMITE_H_LIDO em domains/sebrae_dashboard_gravacao.py)

/** Uma linha, sem espaços repetidos: a forma em que o servidor grava e lê G e H (`" ".join(texto.split())`). */
function umaLinha(texto: Qualquer): string {
  return String(texto ?? "").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * A descrição editada no lápis já é a coluna H lida do Dashboard? Mesma regra do servidor (`h_ja_gravado`): uma linha, sem o apóstrofo
 * protetor (a célula não o guarda) e, se o H lido tem LIMITE_H_LIDO caracteres (foi cortado), só o começo precisa bater.
 * Sem isso, editar com Enter ou espaço duplo deixaria "1 com alteração" para sempre depois de reimportar o Dashboard.
 */
export function descricaoJaNoDashboard(editada: Qualquer, lida: Qualquer): boolean {
  const novo = umaLinha(editada).replace(/^'(?=[=+\-@])/, "");
  const cortada = String(lida ?? "").length >= LIMITE_H_LIDO; // medido antes de aparar: o corte pode terminar num espaço
  const atual = umaLinha(lida);
  return novo === atual || (cortada && novo.startsWith(atual));
}

/**
 * Só os campos que o usuário mudou e não deixou em branco: em branco nunca apaga o que já está no Dashboard.
 * G (título) vai junto, comparado com o título que o cartão mostra (`item.titulo`); o título editado só chega à coluna G da cópia do Dashboard.
 */
export function payloadEdicoes(abertos: Qualquer, edicoes: Qualquer): Qualquer[] {
  return (abertos || []).flatMap((item: Qualquer) => {
    const editado = edicoes?.[item.numero];
    if (!editado) return [];
    const mudou: Qualquer = {};
    ["A", "B", "D", "J", "R", "S"].forEach(letra => {
      if (!(letra in editado)) return;
      const novo = letra === "R" ? formatarEncerramento(editado.R) : String(editado[letra] || "").trim();
      if (novo && novo !== String(item.valores?.[letra] || "").trim()) mudou[letra] = novo;
    });
    if ("G" in editado) {
      const titulo = String(editado.G || "").trim();
      if (titulo && umaLinha(titulo) !== umaLinha(item.titulo)) mudou.G = titulo; // o servidor grava G em uma linha: espaço duplo sozinho não é mudança
    }
    return Object.keys(mudou).length ? [{ numero: item.numero, ...mudou }] : [];
  });
}

/** Chave "linha:27" (sem UTIC único) aparece como o texto da coluna C e a linha da planilha. */
export function tituloAntigo(item: Qualquer): string {
  const linha = /^linha:(\d+)$/.exec(String(item.numero || ""));
  return linha ? `${item.chamado || "Sem chamado"} (linha ${linha[1]})` : item.chamado || item.numero;
}

/** O que mostrar do antigo: o Dashboard manda; título e solicitante vazios usam a leitura do SoftExpert (botão Ler chamados antigos). */
export function dadosAntigo(item: Qualquer): Qualquer {
  const leitura = item.leitura_softexpert || null;
  const texto = (valor: Qualquer) => String(valor ?? "").trim();
  return {
    lido: Boolean(leitura), naoEncontrado: !leitura && item.nao_encontrado_softexpert === true,
    titulo: texto(item.titulo) || texto(leitura?.titulo),
    solicitante: texto(item.usuario) || texto(leitura?.solicitante),
    // a descrição editada no lápis vem primeiro: o Dashboard (H) só muda quando "Atualizar Dashboard" a grava
    descricao: texto(item.softexpert?.descricao_editada) || texto(item.descricao) || texto(leitura?.descricao), atendimento: texto(leitura?.atendimento), abertura: texto(leitura?.habilitada_em),
  };
}

export const AJUDA_ENCERRAMENTO = "Obrigatório ao finalizar o chamado";

/**
 * R válido vindo do campo datetime-local ou do texto gravado no Dashboard, sempre com data e hora ("dd/MM/aaaa HH:mm"); mesmo formato
 * que o servidor aceita (`encerramento_valido`, que normaliza os zeros). "" quando vazio, fora do formato ou só com a data
 * (R antigo digitado sem hora: a coluna R só é gravada com a hora, então ele precisa ser redigitado).
 */
export function encerramentoInformado(valor: Qualquer): string {
  const texto = umaLinha(valor);
  return formatarEncerramento(texto) || (/^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}$/.test(texto) ? texto : "");
}

/** Ajuda do R gravado só com a data: o campo começa vazio (sem hora inventada) e a data antiga continua à vista. */
export function ajudaEncerramentoSemHora(gravado: Qualquer): string {
  const texto = umaLinha(gravado);
  return texto && !encerramentoInformado(texto) ? `Informe também a hora (gravado: ${texto}).` : "";
}

/**
 * DT ENCERRAMENTO (R) é obrigatório em todo chamado (novo ou antigo) com Status (D) FINALIZADO (digitado ou gravado) e sem R gravado:
 * regra do usuário de 24/11/2026, a data é sempre digitada, nunca a hora atual. Espelha a recusa 422 do servidor em Atualizar Dashboard.
 */
export function encerramentoObrigatorio(item: Qualquer, edicao: Qualquer): boolean {
  if (!item) return false;
  const efetivo = (letra: string) => String(edicao?.[letra] ?? "").trim() || String(item.valores?.[letra] ?? "").trim();
  return efetivo("D") === "FINALIZADO" && !encerramentoInformado(item.valores?.R);
}

/** Números dos chamados (antigos e, se passados, novos) com R obrigatório e ainda sem uma data válida no campo (é o que bloqueia Atualizar). */
export function pendenciasEncerramento(abertos: Qualquer, edicoes: Qualquer, formulario: Qualquer[] = [], valores: Qualquer = {}): Qualquer[] {
  const faltando = (lista: Qualquer, digitados: Qualquer) => (lista || [])
    .filter((item: Qualquer) => encerramentoObrigatorio(item, digitados?.[item.numero]) && !formatarEncerramento(digitados?.[item.numero]?.R))
    .map((item: Qualquer) => item.numero);
  return [...faltando(abertos, edicoes), ...faltando(formulario, valores)];
}

/** Mensagem de R faltando; no singular é a mesma frase que o servidor devolve em 422. */
export function avisoEncerramento(numeros: Qualquer[]): string {
  return numeros.length === 1
    ? `Informe a DT ENCERRAMENTO (coluna R) do chamado ${numeros[0]} antes de finalizar.`
    : `Informe a DT ENCERRAMENTO (coluna R) dos chamados ${numeros.join(", ")} antes de finalizar.`;
}

/** Texto da leitura dos antigos: andamento (X de Y), resultado ou interrupção. `anteriorEm` ignora o resultado da execução anterior. */
export function resumoLeituraAntigos(resultado: Qualquer, emAndamento: Qualquer, quando: string = "", anteriorEm: Qualquer = null): string {
  const contar = (lista: Qualquer) => Object.keys(lista || {}).length;
  const numero = resultado?.numero; // leitura de um só ("Conferir este chamado")
  if (emAndamento && numero && resultado.em !== anteriorEm) return `Conferindo ${numero} no SoftExpert… Para parar, use Cancelar execução.`;
  if (!emAndamento && numero) {
    const de = `Conferência de ${numero}${quando ? ` de ${quando}` : ""}`;
    if (!resultado.concluido) return `${de} interrompida.`;
    if ((resultado.lidos || []).includes(numero)) return `${de}: encontrado no SoftExpert e lido de novo.`;
    if ((resultado.nao_encontrados || []).includes(numero)) return `${de}: não encontrado no SoftExpert. Em Finalizar no SoftExpert, marque “registrar como finalizado por outro técnico”.`;
    return `${de}: não foi possível ler (${(resultado.falhas || {})[numero] || "veja o log"}).`;
  }
  if (emAndamento) {
    const atual = resultado && resultado.em !== anteriorEm ? resultado : null;
    const feitos = atual ? (atual.lidos || []).length + contar(atual.falhas) : 0;
    return `Lendo chamados antigos no SoftExpert…${atual?.total ? ` ${feitos} de ${atual.total}.` : ""} Para parar, use Cancelar execução.`;
  }
  if (!resultado) return "";
  const extras = ([
    [resultado.ja_lidos, "já lido(s) antes"], [resultado.sem_utic, "sem UTIC (não dá para ler)"],
  ] as Qualquer[][]).filter(([n]) => n > 0).map(([n, texto]) => `, ${n} ${texto}`).join("");
  const inicio = `Leitura dos antigos${resultado.concluido ? "" : " interrompida"}${quando ? ` de ${quando}` : ""}`;
  return `${inicio}: ${(resultado.lidos || []).length} lido(s), ${contar(resultado.falhas)} com falha${extras}.${resultado.concluido ? "" : " Ler de novo continua de onde parou."}`;
}

/** Quantos antigos em aberto o site preencheria (Série, Modelo, Cidade ou OS vazios). */
export function totalPreenchimentos(abertos: Qualquer): number {
  return (abertos || []).filter((item: Qualquer) => Object.keys(item.automaticos_sugeridos || {}).length > 0).length;
}

/** G (título) só vai se o usuário digitou algo: sem isso o servidor mantém o título do SoftExpert. */
export function linhaChamado(item: Qualquer, v: Qualquer): Qualquer {
  const linha: Qualquer = { numero: item.numero, A: v.A || "", B: v.B || "", D: v.D || "", J: v.J || "", R: formatarEncerramento(v.R), S: v.S || "" };
  const titulo = String(v.G ?? "").trim();
  if (titulo) linha.G = titulo;
  return linha;
}

/** Atualizar Dashboard grava TODOS os chamados novos, mesmo sem A, D e J (vazios viram ""). */
export function payloadAtualizacao(formulario: Qualquer[], valores: Qualquer): Qualquer[] {
  return formulario.map(item => linhaChamado(item, valores[item.numero] || {}));
}

export const MAX_DESCRICAO = 4000;
export const NUMERO_UTIC = /^UTIC-\d{4}-\d+$/i;
export const INTERVALO_FECHAR_MS = 1500;
export const STATUS_OUTRO_TECNICO = "finalizado_outro_tecnico"; // fora da central, com D=FINALIZADO e R do usuário (regra de 12/11/2026)
export const STATUS_DESFEITOS: readonly string[] = Object.freeze(["ok", STATUS_OUTRO_TECNICO]); // nada mais a fazer no SoftExpert (ja_finalizado, nao_encontrado e incerto não bloqueiam: espelha ja_finalizado() do backend)
export const ROTULOS_RESULTADO: Readonly<Record<string, string>> = Object.freeze({
  ok: "Finalizado no SoftExpert", [STATUS_OUTRO_TECNICO]: "Finalizado por outro técnico (confirmado por você): Dashboard atualizado com a DT ENCERRAMENTO informada", ja_finalizado: "Já estava finalizado no SoftExpert", erro: "Erro ao finalizar",
  sem_descricao: "Sem descrição para finalizar", sem_encerramento: "Sem DT ENCERRAMENTO (R)", nao_encontrado: "Não encontrado na central de tarefas", pronto: "Formulário conferido; Finalizar não foi clicado",
  // Finalizar clicado sem confirmação (26/11/2026): pedir de novo só confere a central de tarefas, nunca clica de novo
  incerto: "Finalizar clicado, resultado não confirmado",
});
export const MOTIVOS_PULADO: Readonly<Record<string, string>> = Object.freeze({
  sem_descricao: "sem descrição para finalizar", sem_encerramento: "sem DT ENCERRAMENTO (R)", ja_finalizado: "já finalizado no SoftExpert", sem_numero: "sem número UTIC",
});

export function formatarTamanho(bytes: Qualquer): string {
  const n = Number(bytes) || 0;
  const num = (valor: number, un: string) => `${valor.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${un}`;
  if (n < 1024) return `${n} B`;
  return n < 1024 * 1024 ? num(n / 1024, "KB") : num(n / (1024 * 1024), "MB");
}

export function textoResultado(item: Qualquer): string {
  const base = ROTULOS_RESULTADO[item?.status] || "Sem resultado";
  const extra = STATUS_DESFEITOS.includes(item?.status) && item.encerrado_em ? ` (encerrado em ${item.encerrado_em})` : "";
  const mensagem = ["erro", "nao_encontrado", "incerto"].includes(item?.status) && item.mensagem ? `: ${item.mensagem}` : "";
  // o PDF já enviado num pedido anterior não sobe de novo (26/11/2026): a tela diz isso também no "ok"
  const pdf = item?.pdf_nao_reenviado === true && !mensagem ? ". O PDF já tinha sido enviado num pedido anterior e não foi enviado de novo; confira o anexo no SoftExpert." : "";
  return `${base}${extra}${mensagem}${pdf}`;
}

export function textoPulado(pulado: Qualquer): string {
  return `${pulado?.numero}: não será finalizado no SoftExpert (${MOTIVOS_PULADO[pulado?.motivo] || pulado?.motivo || "motivo não informado"}).`;
}

/** Botão por chamado: precisa de descrição, nenhuma rotina rodando e o chamado ainda não finalizado. */
export function podeFinalizar(descricao: Qualquer, finalizacao: Qualquer, emAndamento: Qualquer): boolean {
  return String(descricao || "").trim() !== "" && !emAndamento && !STATUS_DESFEITOS.includes(finalizacao?.status);
}

/** Rótulos dos campos que precisam estar preenchidos para finalizar (B e S ficam opcionais; R é a DT ENCERRAMENTO digitada, regra de 24/11/2026). */
export const ROTULOS_FALTA = Object.freeze({ A: "Responsável (A)", J: "Tipo do chamado (J)", R: "DT ENCERRAMENTO (R)" });

/** O que falta preencher antes de finalizar no SoftExpert: A, J, Status (D) em FINALIZADO, a DT ENCERRAMENTO (R) e a descrição. */
export function camposFaltando(valores: Qualquer, descricao: Qualquer): string[] {
  const vazio = (valor: Qualquer) => String(valor || "").trim() === "";
  const faltas: string[] = [];
  if (vazio(valores?.A)) faltas.push(ROTULOS_FALTA.A);
  const status = String(valores?.D || "").trim().toUpperCase();
  if (status !== "FINALIZADO") faltas.push(status ? "Status (D) em FINALIZADO (está EM ABERTO)" : "Status (D) em FINALIZADO");
  if (vazio(valores?.J)) faltas.push(ROTULOS_FALTA.J);
  if (!encerramentoInformado(valores?.R)) faltas.push(ROTULOS_FALTA.R);
  if (vazio(descricao)) faltas.push("Descrição para Finalizar o Chamado");
  return faltas;
}

/** Bloco laranja do diálogo de Finalizar para chamado antigo NÃO encontrado no SoftExpert (decisão de 25/11/2026): mostra A, B, D e R e pede a caixa
 * "registrar como finalizado por outro técnico". A caixa fica bloqueada (`bloqueio`) se A, B, D=FINALIZADO ou R válida faltar, como no 422 do servidor. */
export function blocoOutroTecnico(numero: string, valores: Qualquer) {
  const texto = (valor: Qualquer) => String(valor ?? "").trim();
  const faltas: string[] = [];
  if (!texto(valores?.A)) faltas.push("A (Cliente/Simpress)");
  if (!texto(valores?.B)) faltas.push("B (Categoria)");
  if (texto(valores?.D).toUpperCase() !== "FINALIZADO") faltas.push("D (FINALIZADO)");
  const encerramento = encerramentoInformado(valores?.R);
  if (!encerramento) faltas.push("R (DT ENCERRAMENTO)");
  const lista = faltas.length > 1 ? `${faltas.slice(0, -1).join(", ")} e ${faltas[faltas.length - 1]}` : faltas[0];
  return {
    id: numero,
    titulo: "Este chamado não foi encontrado na última leitura do SoftExpert",
    texto: "Confira os campos que vão ao Dashboard e ao SharePoint se ele também não for encontrado agora:",
    linhas: [["A · Cliente/Simpress", texto(valores?.A)], ["B · Categoria", texto(valores?.B)], ["D · Situação", texto(valores?.D)], ["R · DT ENCERRAMENTO", encerramento]],
    caixa: "Se o SoftExpert não encontrar o chamado, registrar como finalizado por outro técnico",
    ajudaDesmarcada: "Sem marcar: se achar, finaliza normalmente. Se não achar, fica “não encontrado”, D e R não vão ao SharePoint, e você pode tentar de novo.",
    ajudaMarcada: "Marcado: se não achar, fica “finalizado por outro técnico” e A, B, D e R vão ao Dashboard e ao SharePoint.",
    bloqueio: faltas.length ? `Preencha ${lista} no cartão para poder confirmar.` : "",
  };
}

/** Chamados que o usuário marcou com D = FINALIZADO nesta atualização (formulários novos e edições dos antigos). */
export function marcadosFinalizado(abertos: Qualquer, edicoes: Qualquer, formulario: Qualquer[] = [], valores: Qualquer = {}): Qualquer[] {
  return [
    ...payloadEdicoes(abertos, edicoes),
    ...payloadAtualizacao(formulario, valores),
  ].filter(e => String(e.D || "").toUpperCase() === "FINALIZADO");
}

/** O que "Atualizar Dashboard" finalizaria de verdade: D virando FINALIZADO, número UTIC, com descrição, ainda não finalizado. */
export function candidatosFinalizar(abertos: Qualquer, edicoes: Qualquer, soft: Qualquer, formulario: Qualquer[] = [], valores: Qualquer = {}): Qualquer[] {
  return marcadosFinalizado(abertos, edicoes, formulario, valores)
    .filter(e => NUMERO_UTIC.test(e.numero))
    .map(e => e.numero)
    .filter(numero => podeFinalizar(soft?.[numero]?.descricao, soft?.[numero]?.finalizacao, false));
}

/** Os marcados FINALIZADO que `candidatosFinalizar` deixa de fora, com o motivo (mesmos códigos de `MOTIVOS_PULADO`), sem repetir chamado. */
export function excluidosFinalizar(abertos: Qualquer, edicoes: Qualquer, soft: Qualquer, formulario: Qualquer[] = [], valores: Qualquer = {}): Qualquer[] {
  const vistos = new Set();
  const excluidos: Qualquer[] = [];
  for (const { numero } of marcadosFinalizado(abertos, edicoes, formulario, valores)) {
    if (vistos.has(numero)) continue;
    vistos.add(numero);
    let motivo = "";
    if (!NUMERO_UTIC.test(numero)) motivo = "sem_numero";
    else if (String(soft?.[numero]?.descricao || "").trim() === "") motivo = "sem_descricao";
    else if (!podeFinalizar(soft[numero].descricao, soft[numero].finalizacao, false)) motivo = "ja_finalizado";
    if (motivo) excluidos.push({ numero, motivo });
  }
  return excluidos;
}

/** Aviso visível dos FINALIZADO que ficam de fora da finalização no SoftExpert ("" quando não há nenhum). */
export function avisoExcluidosFinalizar(excluidos: Qualquer): string {
  if (!excluidos?.length) return "";
  return `Não serão finalizados no SoftExpert: ${excluidos.map((e: Qualquer) => `${e.numero} (${MOTIVOS_PULADO[e.motivo] || e.motivo})`).join("; ")}.`;
}

export const MOTIVO_SEM_FINALIZACAO = "nenhum chamado foi finalizado no SoftExpert";

/** Texto e tipo do aviso depois de Atualizar Dashboard: o servidor diz se finalizou (fechar) ou só enviou (enviar) ao SharePoint. */
export function resultadoEnvioAtualizacao(dados: Qualquer): { texto: string; tipo: string } {
  if (dados?.fechar?.iniciado) return { texto: "Dashboard atualizado. Finalizando no SoftExpert; o envio ao SharePoint só acontece se algum chamado for finalizado.", tipo: "success" };
  if (dados?.enviar?.iniciado) return { texto: "Dashboard atualizado. Enviando ao SharePoint…", tipo: "success" };
  const motivo = String(dados?.enviar?.motivo || "").trim().replace(/\.$/, "");
  // Sem finalização no SoftExpert, "Enviar ao SharePoint" gravaria D FINALIZADO sem finalizar (marca falsa de outro técnico): não sugere o envio.
  if (motivo === MOTIVO_SEM_FINALIZACAO) return { texto: `Dashboard atualizado, mas não foi enviado ao SharePoint: ${motivo}. Confira o SoftExpert antes de enviar.`, tipo: "warning" };
  if (motivo) return { texto: `Dashboard atualizado, mas não foi enviado ao SharePoint: ${motivo}. Use Enviar ao SharePoint.`, tipo: "warning" };
  return { texto: "Dashboard atualizado. Use Enviar ao SharePoint para sobrepor o arquivo.", tipo: "success" };
}

export function resumoResultado(resultado: Qualquer): string {
  const lista: Qualquer[] = resultado?.resultados || [];
  if (!lista.length) return resultado?.cancelado ? "Finalização cancelada." : "Finalização terminada sem resultado por chamado.";
  const contar = (status: string) => lista.filter(r => r.status === status).length;
  const partes = ([
    [contar("ok"), "finalizado(s)"], [contar(STATUS_OUTRO_TECNICO), "finalizado(s) por outro técnico"], [contar("ja_finalizado"), "já finalizado(s)"], [contar("erro"), "com erro"],
    [contar("incerto"), "incerto(s): confira no SoftExpert"], [contar("nao_encontrado"), "não encontrado(s)"],
    [contar("sem_descricao"), "sem descrição"], [contar("sem_encerramento"), "sem DT ENCERRAMENTO (R)"], [contar("pronto"), "só conferido(s)"],
  ] as Qualquer[][]).filter(([n]) => n > 0).map(([n, texto]) => `${n} ${texto}`);
  return `${resultado.cancelado ? "Finalização cancelada" : "Finalização no SoftExpert terminada"}: ${partes.join(", ")}.`;
}

export function resumoInicio(fechar: Qualquer): string {
  const pulados = fechar?.pulados || [];
  if (fechar?.iniciado) {
    const total = (fechar.numeros || []).length;
    return `Finalizando ${total} chamado(s) no SoftExpert…${pulados.length ? ` ${pulados.length} pulado(s).` : ""}`;
  }
  const motivo = fechar?.motivo ? `Nenhum chamado foi finalizado no SoftExpert: ${fechar.motivo}` : "Nenhum chamado foi finalizado no SoftExpert.";
  return pulados.length ? `${motivo} ${pulados.length} pulado(s).` : motivo;
}

// ---- Rascunho automático: o que o usuário seleciona fica no navegador, sem precisar de "Atualizar Dashboard" ----

export const CHAVE_RASCUNHO = "simpress:sebrae-rascunho";
export const NUMERO_RASCUNHO = /^(?:UTIC-\d{4}-\d+|linha:\d+)$/i; // também barra chaves como "__proto__" vindas do armazenamento

/** O rascunho vem do navegador: só números e letras conhecidos, textos curtos. */
export function limparValoresRascunho(bruto: Qualquer): Qualquer {
  const saida: Qualquer = {};
  if (!bruto || typeof bruto !== "object") return saida;
  Object.entries(bruto).forEach(([numero, campos]: [string, Qualquer]) => {
    if (!NUMERO_RASCUNHO.test(numero) || !campos || typeof campos !== "object") return;
    const limpos: Qualquer = {};
    ["A", "B", "D", "J", "R", "S"].forEach(letra => {
      if (typeof campos[letra] === "string" && campos[letra].length <= 80) limpos[letra] = campos[letra];
    });
    if (typeof campos.G === "string" && campos.G.length <= MAX_TITULO) limpos.G = campos.G; // título (G): texto livre, limite próprio
    if (Object.keys(limpos).length) saida[numero] = limpos;
  });
  return saida;
}

export const PREFIXO_CAMPO = `${CHAVE_RASCUNHO}:campo:`;

/**
 * Uma chave fixa por campo: a última gravação vence e o armazenamento não cresce a cada tecla.
 * `linha:<n>` só vale na importação em que nasceu, por isso leva a versão na chave (uma aba antiga não sobrescreve a nova).
 * shortcut: chaves de chamados UTIC já finalizados ficam até o "Descartar rascunho" (uma por campo); limpar por chamado se isso crescer.
 */
function chaveCampo(importadoEm: Qualquer, numero: Qualquer, campo: Qualquer): string {
  return NUMERO_UTIC.test(String(numero)) ? `${PREFIXO_CAMPO}${numero}:${campo}` : `${PREFIXO_CAMPO}${importadoEm}:${numero}:${campo}`;
}

/** Eventos separados por campo evitam que uma aba substitua o rascunho inteiro de outra. */
export function lerRascunho(armazenamento: Qualquer, importadoEm: Qualquer): Qualquer {
  const vazio: Qualquer = { valores: {}, edicoes: {}, salvoEm: "" };
  if (!importadoEm) return vazio;
  try {
    let bruto: Qualquer = null;
    try { bruto = JSON.parse(armazenamento?.getItem(CHAVE_RASCUNHO) || "null"); } catch (_erro) { /* registros por campo ainda podem ser lidos */ }
    const migrar = (campos: Qualquer) => Object.fromEntries(Object.entries(limparValoresRascunho(campos))
      .filter(([numero]) => bruto?.importado_em === importadoEm || NUMERO_UTIC.test(numero)));
    const saida: Qualquer = { valores: migrar(bruto?.valores), edicoes: migrar(bruto?.edicoes), salvoEm: String(bruto?.salvo_em || ""), origens: {} };
    ["valores", "edicoes"].forEach(tipo => Object.entries(saida[tipo]).forEach(([numero, campos]: [string, Qualquer]) => {
      saida.origens[numero] = { ...saida.origens[numero], ...Object.fromEntries(Object.keys(campos).map(campo => [campo, bruto?.importado_em])) };
    }));
    const registros: Qualquer[] = [];
    for (let i = 0; i < (armazenamento?.length || 0); i++) {
      const chave = armazenamento.key(i);
      if (!chave?.startsWith(PREFIXO_CAMPO)) continue;
      try {
        const registro = JSON.parse(armazenamento.getItem(chave));
        if (!registro || typeof registro.em !== "string") continue;
        registros.push({ ...registro, chave });
      } catch (_erro) { /* um registro danificado não oculta os demais */ }
    }
    registros.sort((a, b) => a.em.localeCompare(b.em) || (Number(a.instante) || 0) - (Number(b.instante) || 0) || a.chave.localeCompare(b.chave));
    const apagar: string[] = [];
    const grupos = new Map<string, Qualquer[]>(); // chave fixa -> registros válidos, do mais antigo ao mais novo
    registros.forEach(registro => {
      if (registro.importado_em !== importadoEm && !NUMERO_UTIC.test(registro.numero)) { apagar.push(registro.chave); return; }
      const campos = limparValoresRascunho({ [registro.numero]: { [registro.campo]: registro.valor } });
      if (!campos[registro.numero]) { apagar.push(registro.chave); return; } // nunca é lido: apagar não perde nada
      const fixa = chaveCampo(registro.importado_em, registro.numero, registro.campo);
      if (!grupos.has(fixa)) grupos.set(fixa, []);
      grupos.get(fixa)!.push(registro);
      const alvo = registro.alvo === "antigo" ? "edicoes" : "valores";
      // Um chamado pode ter passado de novo para antigo na reimportação.
      ["valores", "edicoes"].forEach(tipo => {
        if (saida[tipo][registro.numero]) delete saida[tipo][registro.numero][registro.campo];
      });
      saida[alvo][registro.numero] = { ...saida[alvo][registro.numero], ...campos[registro.numero] };
      saida.origens[registro.numero] = { ...saida.origens[registro.numero], [registro.campo]: registro.importado_em };
      saida.salvoEm = registro.em;
    });
    limparRegistrosCampo(armazenamento, apagar, grupos);
    return saida;
  } catch (_erro) { return vazio; }
}

/**
 * Apaga registros de outra importação sem UTIC e migra as chaves antigas (uma por tecla, com data) para a chave fixa.
 * Com a cota cheia, as perdedoras saem antes da gravação; a antiga vencedora só sai depois que a nova foi gravada.
 * Uma falha aqui nunca esconde o rascunho já lido.
 */
function limparRegistrosCampo(armazenamento: Qualquer, apagar: string[], grupos: Map<string, Qualquer[]>): void {
  const remover = (chave: string) => { try { armazenamento.removeItem(chave); } catch (_erro) { /* fica para a próxima leitura */ } };
  apagar.forEach(remover);
  grupos.forEach((lista, fixa) => {
    const vencedor = lista[lista.length - 1];
    lista.slice(0, -1).forEach(registro => { if (registro.chave !== fixa) remover(registro.chave); });
    if (vencedor.chave === fixa) return;
    try {
      const valor = { ...vencedor };
      delete valor.chave;
      armazenamento.setItem(fixa, JSON.stringify(valor));
    } catch (_erro) { return; } // sem espaço: a chave antiga continua e é lida de novo
    remover(vencedor.chave);
  });
}

export function gravarCampoRascunho(armazenamento: Qualquer, importadoEm: Qualquer, numero: Qualquer, campo: Qualquer, valor: Qualquer, alvo: Qualquer): boolean {
  if (!armazenamento || !importadoEm) return false;
  try {
    const em = new Date().toISOString();
    armazenamento.setItem(chaveCampo(importadoEm, numero, campo), JSON.stringify({ importado_em: importadoEm, numero, campo, valor, alvo, em, instante: performance.timeOrigin + performance.now() }));
    return true;
  } catch (_erro) { return false; }
}

/** `true` só se gravou; sem armazenamento (janela privada, cota cheia) a tela segue funcionando sem rascunho. */
export function gravarRascunho(armazenamento: Qualquer, importadoEm: Qualquer, valores: Qualquer, edicoes: Qualquer): boolean {
  if (!importadoEm || !armazenamento) return false;
  try {
    armazenamento.setItem(CHAVE_RASCUNHO, JSON.stringify({ importado_em: importadoEm, salvo_em: new Date().toISOString(), valores, edicoes }));
    return true;
  } catch (_erro) {
    return false;
  }
}

export function apagarRascunho(armazenamento: Qualquer): void {
  try {
    const chaves: string[] = [];
    for (let i = 0; i < (armazenamento?.length || 0); i++) {
      const chave = armazenamento.key(i);
      if (chave?.startsWith(PREFIXO_CAMPO)) chaves.push(chave);
    }
    chaves.forEach(chave => armazenamento.removeItem(chave));
    armazenamento?.removeItem(CHAVE_RASCUNHO);
  } catch (_erro) {
    // sem armazenamento não há rascunho a apagar
  }
}

/** Só o que ainda vale: chamados novos que continuam no formulário e campos de antigos ainda vazios no Dashboard (D sempre pode ir a FINALIZADO). */
export function aplicarRascunho(rascunho: Qualquer, formulario: Qualquer, abertos: Qualquer, importadoEm: Qualquer = ""): Qualquer {
  const novos = new Set((formulario || []).map((item: Qualquer) => item.numero));
  const conhecidos = new Set([...novos, ...(abertos || []).map((item: Qualquer) => item.numero)]);
  const valores: Qualquer = {};
  const conflitos: string[] = [];
  novos.forEach(numero => {
    const antigos = rascunho.edicoes[numero as string] || {};
    const recentes = rascunho.valores[numero as string] || {};
    const campos: Qualquer = {};
    new Set([...Object.keys(antigos), ...Object.keys(recentes)]).forEach(letra => {
      if (letra in antigos && letra in recentes && antigos[letra] !== recentes[letra]) {
        conflitos.push(`${numero} (${letra}): rascunho antigo ${antigos[letra]}; rascunho novo ${recentes[letra]}`);
      } else campos[letra] = recentes[letra] ?? antigos[letra];
    });
    if (Object.keys(campos).length) valores[numero as string] = campos;
  });
  const edicoes: Qualquer = {};
  (abertos || []).forEach((item: Qualquer) => {
    const campos = { ...rascunho.valores[item.numero], ...rascunho.edicoes[item.numero] };
    if (!campos) return;
    // R gravado só com a data conta como vazio: o campo fica editável e o R digitado com a hora não pode sumir ao recarregar
    const livres = Object.fromEntries(Object.entries(campos).filter(([letra, _valor]) => !String(item.valores?.[letra] || "").trim() || (letra === "R" && !encerramentoInformado(item.valores?.R)) || (letra === "D" && Boolean(importadoEm) && rascunho.origens?.[item.numero]?.D === importadoEm)));
    if (Object.keys(livres).length) edicoes[item.numero] = livres;
  });
  (abertos || []).forEach((item: Qualquer) => {
    const campos = { ...rascunho.valores[item.numero], ...rascunho.edicoes[item.numero] };
    Object.entries(campos).forEach(([letra, valor]) => {
      const atual = letra === "R" ? encerramentoParaCampo(item.valores?.R) : String(item.valores?.[letra] || "");
      if (atual.trim() && atual !== valor && !(letra === "D" && Boolean(importadoEm) && rascunho.origens?.[item.numero]?.D === importadoEm)) conflitos.push(`${item.numero} (${letra}): rascunho ${valor}; Dashboard ${atual}`);
    });
  });
  const pendentes = Object.entries({ ...rascunho.valores, ...rascunho.edicoes }).filter(([numero]) => !conhecidos.has(numero));
  return { valores, edicoes, conflitos, pendentes, restaurado: Object.keys(valores).length + Object.keys(edicoes).length > 0, salvoEm: rascunho.salvoEm };
}

// Publicação em window, lida por frontend/src/aplicacao/app.ts e por paineis/sebrae-dashboard/montar.tsx.
if (typeof window !== "undefined") {
  window.SimpressSebraeDashboardModel = Object.freeze({
    CAMPOS_AUTOMATICOS, CAMPOS_PREENCHIDOS, STATUS_CHAMADO, STATUS_FINALIZADO, TIPOS_CHAMADO, PADROES_MANUAIS, PADROES_API_SEBRAE, DESCRICAO_API_SEBRAE, SOLICITANTE_API_SEBRAE,
    ehApiSebrae, padroesManuais, AVISO_CRUZAMENTO, avisoOutraPessoa, avisoNomeDaDescricao, formatarEncerramento, encerramentoParaCampo, encerramentoAgora, payloadEdicoes, descricaoJaNoDashboard,
    tituloAntigo, dadosAntigo, AJUDA_ENCERRAMENTO, encerramentoInformado, ajudaEncerramentoSemHora, encerramentoObrigatorio, pendenciasEncerramento, avisoEncerramento,
    resumoLeituraAntigos, totalPreenchimentos, linhaChamado, payloadAtualizacao,
    MAX_TITULO, MAX_DESCRICAO, NUMERO_UTIC, INTERVALO_FECHAR_MS, STATUS_DESFEITOS, STATUS_OUTRO_TECNICO, ROTULOS_RESULTADO, MOTIVOS_PULADO, formatarTamanho, textoResultado, textoPulado, podeFinalizar,
    ROTULOS_FALTA, camposFaltando, blocoOutroTecnico, marcadosFinalizado, candidatosFinalizar, excluidosFinalizar, avisoExcluidosFinalizar, MOTIVO_SEM_FINALIZACAO,
    resultadoEnvioAtualizacao, resumoResultado, resumoInicio,
    CHAVE_RASCUNHO, NUMERO_RASCUNHO, limparValoresRascunho, PREFIXO_CAMPO, lerRascunho, gravarCampoRascunho, gravarRascunho, apagarRascunho, aplicarRascunho,
  });
}
