import { iniciais } from "../../componentes/nl-modelo.ts";
import { listPendingFields } from "../../ui/ux-enhancements.ts";

// Novo layout do Transporte (F2): só apresentação. Quatro etapas recolhíveis, linha de progresso, checklist da
// pré-visualização e iniciais dos responsáveis. Nada aqui gera planilha, envia ou valida: a geração e as regras
// continuam no estado.ts, que só chama `abrirDoCampo` antes de focar um campo que pode estar numa etapa recolhida.
// Tudo é lido pelo id (document.getElementById), com chamadas opcionais, porque o harness de testes não tem DOM completo.

export type EstadoEtapa = "ok" | "falta" | "auto";

export interface FonteEtapas {
  serial(): string;
  modelo(): string;
  apelido(): string;
  cidadeRetirada(): string;
  cidadeEntrega(): string;
  contrato(): string;
}

type Campo = HTMLElement & { value?: string };

const ETAPAS = [1, 2, 3, 4] as const;
const SECAO: Record<number, string> = { 1: "nlt-etapa-1", 2: "ck-passo-retirada", 3: "ck-passo-entrega", 4: "nlt-etapa-4" };

// Em que etapa mora cada campo (para abrir a etapa certa antes de focar).
const ETAPA_DO_CAMPO: Record<string, number> = {
  "retirada-representante": 2, "retirada-tipo-acesso": 2, "retirada-voltagem": 2, "retirada-obs": 2,
  "retirada-contato": 2, "retirada-email": 2, "retirada-telefone": 2,
  "select-unidade-destino": 3, "entrega-representante": 3, "entrega-obs": 3,
  "entrega-contato": 3, "entrega-email": 3, "entrega-telefone": 3,
  "retirada-horario": 4, "retirada-almoco": 4, "retirada-pausa-duracao": 4,
  "entrega-horario": 4, "entrega-almoco": 4, "entrega-pausa-duracao": 4,
};

const OBRIGATORIOS_RETIRADA = ["retirada-contato", "retirada-email", "retirada-telefone", "retirada-obs"];
const OBRIGATORIOS_ENTREGA = ["select-unidade-destino", "entrega-contato", "entrega-email", "entrega-telefone", "entrega-obs"];

// Os ouvintes de clique ficam no document e valem para a única instância do formulário; duas instalações abririam e fechariam a mesma etapa.
let instalado = false;

const ROTULO_ESTADO: Record<EstadoEtapa, string> = { ok: "ok", falta: "falta", auto: "automático" };

const campo = (id: string) => document.getElementById(id) as Campo | null;
const valor = (id: string) => String(campo(id)?.value ?? "").trim();
const todosPreenchidos = (ids: string[]) => ids.every(id => valor(id));

function escrever(id: string, texto: string) {
  const alvo = campo(id);
  if (alvo) alvo.textContent = texto;
}

function marcarSelo(selo: Campo | null | undefined, estado: EstadoEtapa) {
  if (!selo) return;
  selo.dataset.estado = estado;
  selo.textContent = ROTULO_ESTADO[estado];
}

function atualizarAvatar(id: string, nome: string, papel: string) {
  const avatar = campo(id);
  if (!avatar) return;
  const rotulo = nome ? `${nome}, ${papel}` : papel;
  avatar.textContent = iniciais(nome);
  avatar.setAttribute("aria-label", rotulo);
  avatar.setAttribute("title", rotulo);
}

export function criarEtapasTransporte(fonte: FonteEtapas) {
  let atual = 1;
  let abertas = new Set<number>([1]);
  let gerado = false;
  let ultimaSerie = "";
  let contagem = { preenchidos: 0, total: 0 };

  function estadoDaEtapa(etapa: number): EstadoEtapa {
    if (etapa === 1) return fonte.serial() ? "ok" : "falta";
    if (etapa === 2) return todosPreenchidos(OBRIGATORIOS_RETIRADA) ? "ok" : "falta";
    if (etapa === 3) return todosPreenchidos(OBRIGATORIOS_ENTREGA) ? "ok" : "falta";
    return todosPreenchidos(["entrega-horario", "entrega-almoco"]) ? "auto" : "falta";
  }

  // A etapa inicial é a primeira incompleta; com tudo pronto, a Agenda (automática).
  function primeiraIncompleta(): number {
    return [1, 2, 3].find(etapa => estadoDaEtapa(etapa) === "falta") ?? 4;
  }

  function estadoDoSegmento(etapa: number): "feito" | "atual" | "pendente" {
    if (etapa === atual) return "atual";
    const estado = estadoDaEtapa(etapa);
    const anterioresProntas = [1, 2, 3].every(n => n >= etapa || estadoDaEtapa(n) === "ok");
    return estado !== "falta" && anterioresProntas ? "feito" : "pendente";
  }

  function desenharEtapas() {
    for (const etapa of ETAPAS) {
      const aberta = abertas.has(etapa);
      const estado = estadoDaEtapa(etapa);
      const secao = campo(SECAO[etapa]);
      if (secao) {
        secao.dataset.atual = String(etapa === atual);
        secao.dataset.estado = estado;
        secao.dataset.aberta = String(aberta);
      }
      campo(`nlt-gatilho-${etapa}`)?.setAttribute("aria-expanded", String(aberta));
      const corpo = campo(`nlt-corpo-${etapa}`);
      if (corpo) corpo.hidden = !aberta;
      marcarSelo(campo(`nlt-selo-${etapa}`), estado);
      const segmento = campo(`nlt-seg-${etapa}`);
      if (segmento) {
        const situacao = estadoDoSegmento(etapa);
        segmento.dataset.estado = situacao;
        if (situacao === "atual") segmento.setAttribute("aria-current", "step");
        else segmento.removeAttribute("aria-current");
      }
    }
  }

  function desenharResumos() {
    escrever("nlt-chip-serie", fonte.serial());
    escrever("nlt-chip-modelo", fonte.modelo());
    escrever("nlt-chip-apelido", fonte.apelido());
    escrever("nlt-chip-cidade", fonte.cidadeRetirada());
    escrever("nlt-chip-ret-cidade", fonte.cidadeRetirada());
    escrever("nlt-chip-ret-acesso", valor("retirada-tipo-acesso"));
    escrever("nlt-chip-ret-volt", valor("retirada-voltagem"));
    escrever("nlt-chip-ent-filial", fonte.cidadeEntrega());
    escrever("nlt-chip-ent-cnpj", valor("entrega-cnpj"));
    escrever("nlt-chip-ag-exp", valor("entrega-horario"));
    const almoco = valor("entrega-almoco");
    const pausa = valor("entrega-pausa-duracao");
    escrever("nlt-chip-ag-alm", almoco ? `almoço ${almoco}` : "");
    escrever("nlt-chip-ag-pausa", pausa ? `pausa ${pausa}` : "");
    atualizarAvatar("nlt-av-retirada", valor("retirada-contato"), "Responsável na retirada");
    atualizarAvatar("nlt-av-destino", valor("entrega-contato"), "Responsável no destino");
    atualizarAvatar("nlt-av-destino-resumo", valor("entrega-contato"), "Responsável no destino");
  }

  function desenharChecklist() {
    const itens: [string, EstadoEtapa][] = [
      ["nlt-chk-equipamento", fonte.serial() ? "ok" : "falta"],
      ["nlt-chk-retirada", todosPreenchidos(["retirada-contato", "retirada-email", "retirada-telefone"]) ? "ok" : "falta"],
      ["nlt-chk-retirada-obs", valor("retirada-obs") ? "ok" : "falta"],
      ["nlt-chk-filial", valor("select-unidade-destino") ? "ok" : "falta"],
      ["nlt-chk-destinatario", todosPreenchidos(["entrega-contato", "entrega-email", "entrega-telefone"]) ? "ok" : "falta"],
      ["nlt-chk-entrega-obs", valor("entrega-obs") ? "ok" : "falta"],
      ["nlt-chk-contrato", fonte.contrato() ? "ok" : "falta"],
      ["nlt-chk-horarios", todosPreenchidos(["entrega-horario", "entrega-almoco"]) ? "auto" : "falta"],
    ];
    for (const [id, estado] of itens) {
      const linha = campo(id);
      if (!linha) continue;
      linha.dataset.estado = estado;
      marcarSelo(linha.querySelector?.<HTMLElement>(".nlt-selo"), estado);
    }
  }

  function desenharPassos() {
    const temSerie = Boolean(fonte.serial());
    const passos = [
      temSerie ? "feito" : "atual",
      gerado ? "feito" : temSerie ? "atual" : "pendente",
      gerado ? "feito" : "pendente",
    ];
    passos.forEach((situacao, indice) => {
      const item = campo(`nlt-p3-${indice + 1}`);
      if (!item) return;
      item.dataset.estado = situacao;
      if (situacao === "atual") item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    });
  }

  function desenharBarra() {
    const { preenchidos, total } = contagem;
    const fracao = total ? Math.min(1, preenchidos / total) : 0;
    const barra = campo("nlt-barra");
    if (!barra) return;
    barra.setAttribute("aria-valuenow", String(Math.round(fracao * 100)));
    barra.style?.setProperty?.("--nlt-fracao", String(fracao));
  }

  function desenhar() {
    desenharEtapas();
    desenharResumos();
    desenharChecklist();
    desenharPassos();
    desenharBarra();
  }

  function reposicionar() {
    atual = primeiraIncompleta();
    abertas = new Set([atual]);
    desenhar();
  }

  // Chamado pela pré-visualização a cada digitação; não mexe na etapa aberta.
  function sincronizar(novaContagem?: { preenchidos: number; total: number }) {
    if (novaContagem) contagem = novaContagem;
    desenhar();
  }

  // Equipamento novo (ou removido): a etapa atual volta à primeira incompleta.
  function aoMudarEquipamento(serial: string) {
    if (serial === ultimaSerie) return sincronizar();
    ultimaSerie = serial;
    gerado = false;
    reposicionar();
  }

  function reiniciar() {
    ultimaSerie = fonte.serial();
    gerado = false;
    reposicionar();
  }

  function marcarGerado() {
    gerado = true;
    desenhar();
  }

  function alternar(etapa: number) {
    if (abertas.has(etapa)) abertas.delete(etapa);
    else abertas.add(etapa);
    desenhar();
  }

  function irPara(etapa: number, origem?: number) {
    atual = etapa;
    if (origem) abertas.delete(origem);
    abertas.add(etapa);
    desenhar();
    campo(`nlt-gatilho-${etapa}`)?.focus?.();
  }

  // Abre a etapa do campo antes de focá-lo: campo em etapa recolhida (hidden) não recebe foco.
  function abrirDoCampo(id: string) {
    const etapa = ETAPA_DO_CAMPO[id];
    if (!etapa || abertas.has(etapa)) return;
    abertas.add(etapa);
    desenhar();
  }

  function instalar() {
    if (instalado || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    instalado = true;
    document.addEventListener("click", evento => {
      const alvo = evento.target as Element | null;
      const gatilho = alvo?.closest?.<HTMLElement>(".nlt-gatilho");
      if (gatilho) return alternar(Number(gatilho.id.replace("nlt-gatilho-", "")));
      const ir = alvo?.closest?.<HTMLElement>("[data-nlt-ir]");
      if (ir) {
        const origem = Number(ir.closest?.<HTMLElement>(".nlt-etapa")?.dataset.etapa) || undefined;
        irPara(Number(ir.dataset.nltIr), origem);
      }
    });
    // "Duplicar destino" (Transferências geradas) troca a filial por fora e foca o contato logo depois: a etapa Entrega
    // precisa estar aberta nesse momento, senão o foco cai num campo escondido.
    document.addEventListener("change", evento => {
      if ((evento.target as HTMLElement | null)?.id === "select-unidade-destino") abrirDoCampo("select-unidade-destino");
    });
    // Mesmo fluxo com o destino fora do catálogo: a filial não muda, só o contato é preenchido por fora (evento `input`) e focado.
    // Ninguém digita em campo de etapa recolhida, então esse `input` só pode vir de código.
    document.addEventListener("input", evento => {
      if ((evento.target as HTMLElement | null)?.id === "entrega-contato") abrirDoCampo("entrega-contato");
    });
    // O link "N pendentes" (ux-enhancements) foca o primeiro campo pendente: a etapa dele precisa estar aberta antes.
    document.addEventListener("click", evento => {
      if (!(evento.target as Element | null)?.closest?.("#ux-pending-chip")) return;
      const primeira = listPendingFields(id => document.getElementById(id))[0];
      if (primeira?.field?.id) abrirDoCampo(primeira.field.id);
    }, true);
  }

  function iniciar() {
    instalar();
    ultimaSerie = fonte.serial();
    reposicionar();
  }

  return { iniciar, sincronizar, aoMudarEquipamento, reiniciar, marcarGerado, abrirDoCampo };
}
