import type { ApiFetchError, ApiFetchOptions } from "../../api";
import { criarRenderizadorResultado, type ContextoRenderizador } from "./renderizador";
import { escreverNumeroCartao } from "./numeros-bento";

// Resultado da aba Comparação: renderização, anotações com autosave, filtros, abas do Resumo e decisões
// de apelido manual, hostname duplicado e pendência de usuário. Só sintaxe apagável (sem enum/namespace):
// os testes carregam este .ts direto no Node. O estado (cache, filtros, observadores) vive só dentro da fábrica.
interface ItemComAnotacao {
  anotacao_id?: unknown;
  anotacao?: unknown;
  anotacao_revisoes?: unknown[];
  anotacao_conflito?: unknown;
  anotacao_conflitos?: unknown[];
  anotacao_bases_ausentes?: unknown[];
  anotacao_integridade_invalida?: unknown;
}
interface DivergenciaApelidoManual {
  serie?: string;
  resolucao?: string;
}
export interface Comparacao {
  evento_id?: string | number;
  horario_comparacao?: string;
  arquivos_enviados?: { endpoint?: string; detalhes?: string };
  somente_anotacoes_sincronizadas?: boolean;
  divergencias_apelidos_manuais?: DivergenciaApelidoManual[];
}
export interface SemUsuario {
  estado: string;
  items: unknown[];
  total?: number;
}
export interface AlvoNavegacao {
  section?: string;
  itemId?: string;
  serial?: string;
  hostname?: string;
  category?: string;
  // Realce curto da linha achada (clique no sino); o padrão dos chips da Home não realça.
  destacar?: boolean;
}
interface TipoResumo {
  valor: string;
  rotulo: string;
}
interface AppResultado {
  confirmarAcao(opcoes: { titulo: string; mensagem: string; confirmar: string; destrutiva?: boolean }): Promise<boolean>;
  showToast(mensagem: string, tipo: string): unknown;
  atualizarIndicadoresPosSalvamento(): unknown;
  definirEquipamentoAtual(equipamento: unknown): unknown;
  exibirEquipamento(equipamento: unknown): unknown;
}
interface PedidoAnotacao {
  eventId: string | number;
  itemId: string | number;
  annotation: string;
  revisionId?: string;
  baseRevisions: unknown[];
  resolveConflict: boolean;
}
interface OpcoesAutosave {
  textarea: HTMLTextAreaElement;
  status: Element | null;
  retryButton: Element | null;
  eventId: string | number | undefined;
  itemId: string | undefined;
  send(pedido: PedidoAnotacao): Promise<unknown>;
}
export interface ContextoResultadoComparacao {
  app: AppResultado & ContextoRenderizador["app"];
  appState: { currentEquipamento?: { serial?: unknown } | null };
  motion: { reveal(elemento: Element): void } | null | undefined;
  dom: ContextoRenderizador["dom"];
  historyFormat: ContextoRenderizador["historyFormat"];
  loggedUserMarkers: ContextoRenderizador["loggedUserMarkers"] & { conectar(raiz: HTMLElement): void };
  annotationAutosave: { attachAnnotationAutosave(opcoes: OpcoesAutosave): unknown };
  apiFetch<T = unknown>(url: string, options?: ApiFetchOptions): Promise<T>;
}
interface EstadoResumo {
  aba: string;
  busca: string;
  soAnotadas: boolean;
  tipo: string;
}
interface TextoDecisao {
  titulo: string;
  mensagem: string;
  confirmar: string;
  resultado: string;
  destrutiva?: boolean;
}

const ehErroApi = (erro: unknown): erro is ApiFetchError => erro instanceof Error
  && "status" in erro && typeof erro.status === "number";
const mensagemDoErro = (erro: unknown): string | undefined => (erro as { message?: string } | null)?.message;

export function criarResultadoComparacao(context: ContextoResultadoComparacao) {
  "use strict";
  const { app, appState, motion } = context;
  const { escapeHtml } = context.dom;
  const renderer = criarRenderizadorResultado(context);

  let comparisonAnnotationSyncObservers: MutationObserver[] = [];

  // PUT do autosave pelo apiFetch (evento simpress:servidor-offline, mesmo erro da API). A sincronização das
  // anotações espera uma resposta com ok/status/json: o erro HTTP volta nesse formato (409 não repete, 5xx repete)
  // e a falha de rede passa intacta, sem status, para a repetição automática do autosave.
  async function enviarAnotacao(
    { eventId, itemId, annotation, revisionId, baseRevisions, resolveConflict }: PedidoAnotacao,
  ): Promise<unknown> {
    try {
      return await context.apiFetch<Response>(
        `/api/historico-comparacoes/${encodeURIComponent(eventId)}/anotacoes/${encodeURIComponent(itemId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anotacao: annotation, revisao_id: revisionId, base_revisoes: baseRevisions, resolver_conflito: resolveConflict }),
          responseType: "response",
        },
      );
    } catch (erro) {
      if (!ehErroApi(erro)) throw erro;
      return { ok: false, status: erro.status, json: async () => erro.data };
    }
  }

  // Renders the result inside the Comparação tab (#comparacao-planilhas-conteudo); the tab must already be open.
  // semUsuario ({estado, items}) is the optional inventory read from carregarSemUsuarioResumo; without it the section is omitted.
  function renderizarResultadoComparacao(
    comparison: Comparacao,
    navigationTarget: AlvoNavegacao | null = null,
    semUsuario: SemUsuario | null = null,
  ): void {
    const listas = { ...renderer.listasComparacao(comparison), semUsuario };
    const colunas = renderer.criarColunasAnotacao(comparison);
    // Novo layout (18/11/2026): o texto das fontes (#comparacao-planilhas-fontes) saiu do Resumo; o elemento fica oculto.

    desconectarObservadoresAnotacoes();
    const content = document.getElementById("comparacao-planilhas-conteudo")!;
    content.innerHTML = comparison.somente_anotacoes_sincronizadas
      ? renderer.conteudoAnotacoesSincronizadas(comparison, colunas)
      : renderer.conteudoResultadoComparacao(comparison, listas, colunas);
    content.dataset.estado = "pronto";
    const avisos = document.getElementById("comparacao-planilhas-avisos");
    if (avisos) avisos.innerHTML = comparison.somente_anotacoes_sincronizadas ? "" : renderer.avisoHistoricoComparacao(comparison);
    const navigationHeading = navigationTarget?.section
      ? encontrarTituloSecaoComparacao(content, navigationTarget.section)
      : null;
    if (navigationHeading) {
      navigationHeading.setAttribute("data-comparison-navigation-heading", "");
      if (!navigationHeading.hasAttribute("tabindex")) navigationHeading.setAttribute("tabindex", "-1");
    }
    conectarAcoesApelidosManuais(comparison, listas.divergenciasApelidosManuais);
    conectarRemocaoHostnames();
    conectarDecisoesPendenciasUsuario();
    // Logged user under each hostname, with the Home rule.
    context.loggedUserMarkers.conectar(content);
    conectarAnotacoesComparacao(comparison);
    conectarFiltrosHistoricoComparacao(content);
    conectarCartoesResumoComparacao();
    // Números, anel e traços dos cartões bento partem do zero (bento.ts).
    globalThis.SimpressBento?.animarDentro(content);
    if (navigationTarget) requestAnimationFrame(() => navegarParaLinhaComparacao(navigationTarget));
    // Ordenação e "Copiar tabela" (data-panels.js) entram nas tabelas recém-montadas.
    document.dispatchEvent(new CustomEvent("simpress:tabelas-renderizadas"));
  }

  // No saved comparison: the empty message is already in the content area; adds only the "Sem usuário" section below it.
  function renderizarSemUsuarioSemComparacao(semUsuario: SemUsuario, navigationTarget: AlvoNavegacao | null = null): void {
    const content = document.getElementById("comparacao-planilhas-conteudo")!;
    content.insertAdjacentHTML("beforeend", renderer.secaoSemUsuario(semUsuario));
    if (navigationTarget) requestAnimationFrame(() => navegarParaLinhaComparacao(navigationTarget));
    document.dispatchEvent(new CustomEvent("simpress:tabelas-renderizadas"));
  }

  const SEM_USUARIO_PAGINA = 100;
  const SEM_USUARIO_MAX_PAGINAS = 20;
  // Successful reads are reused between event selections; invalidated when the Comparação panel opens or inventories change.
  let semUsuarioCache: SemUsuario | null = null;
  let semUsuarioGeracao = 0;
  // Inventário trocado ou restaurado: o Resumo (F3) recarrega na próxima abertura (ferramentas-cockpit).
  function invalidarSemUsuarioResumo(): void {
    semUsuarioCache = null;
    semUsuarioGeracao += 1;
    if (typeof document !== "undefined") document.dispatchEvent?.(new CustomEvent("simpress:resumo-desatualizado"));
  }

  // Notebooks without a logged user in the current inventory (same rule and endpoint as the Home chip).
  // Never throws: a failure becomes {estado: "erro"} so the rest of the Resumo still renders.
  // Past the page cap it returns {estado: "limite", items, total} with what was read, not an error.
  async function carregarSemUsuarioResumo(): Promise<SemUsuario> {
    if (semUsuarioCache) return semUsuarioCache;
    const geracao = semUsuarioGeracao;
    const guardar = (resultado: SemUsuario): SemUsuario => {
      if (geracao === semUsuarioGeracao) semUsuarioCache = resultado;
      return resultado;
    };
    const items: unknown[] = [];
    let total: number | undefined;
    try {
      for (let pagina = 0; pagina < SEM_USUARIO_MAX_PAGINAS; pagina += 1) {
        const params = new URLSearchParams({
          listar_todos: "true", usuario: "sem", limit: String(SEM_USUARIO_PAGINA), offset: String(pagina * SEM_USUARIO_PAGINA),
        });
        const data = await context.apiFetch<{ items?: unknown[]; total?: unknown; has_more?: unknown } | null>(
          `/api/buscar-expandida?${params}`, { errorMessage: "Não foi possível consultar os notebooks sem usuário." },
        );
        items.push(...(Array.isArray(data?.items) ? data.items : []));
        if (Number.isSafeInteger(data?.total)) total = data?.total as number;
        if (data?.has_more !== true) return guardar({ estado: "ok", items });
      }
      return guardar({ estado: "limite", items, total });
    } catch (error) {
      return { estado: "erro", items: [] };
    }
  }

  function conectarAcoesApelidosManuais(comparison: Comparacao, divergenciasApelidosManuais: DivergenciaApelidoManual[]): void {
    document.querySelectorAll<HTMLButtonElement>("[data-manual-alias-action]").forEach(button => {
      button.addEventListener("click", () => {
        const item = divergenciasApelidosManuais[Number(button.dataset.manualAliasIndex)];
        if (item) resolverDivergenciaApelidoManual(comparison, item, button.dataset.manualAliasAction, button);
      });
    });
  }

  const chaveHostname = (serie: unknown, hostname: unknown): string =>
    `${String(serie || "").replace(/[^A-Z0-9]/gi, "").toUpperCase()}|${String(hostname || "").replace(/[^A-Z0-9]/gi, "").toUpperCase()}`;

  // The same hostname can be listed in the desktop table and in its mobile card; every copy is kept in step.
  function mostrarEstadoHostname(chave: string, removido: boolean): void {
    document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-hostname-item]").forEach(item => {
      if (chaveHostname(item.dataset.hostnameSerie, item.dataset.hostnameNome) !== chave) return;
      const remover = item.querySelector<HTMLElement>("[data-hostname-remove]");
      const aviso = item.querySelector<HTMLElement>("[data-hostname-removed]");
      const restaurar = item.querySelector<HTMLElement>("[data-hostname-restore]");
      if (remover) remover.hidden = removido;
      if (aviso) aviso.hidden = !removido;
      if (restaurar) restaurar.hidden = !removido;
      item.classList.toggle("opacity-60", removido);
    });
  }

  // "Remover mais antigo" removes the old computer in Endpoint Central (Chrome de automação) and only then records
  // the pair locally. "Desfazer" only undoes the local record; the removal in Endpoint Central stays.
  function conectarRemocaoHostnames(): void {
    const botoes = document.querySelectorAll<HTMLButtonElement>(
      "#comparacao-planilhas-conteudo [data-hostname-remove], #comparacao-planilhas-conteudo [data-hostname-restore]"
    );
    if (!botoes.length) return;
    // Pending pairs come from the server (incerto, or removed in Endpoint Central without the local record): the button
    // turns into "Gravar só no cockpit" and only the local route is called, so the irreversible click never repeats.
    const marcarPendente = (chave: string): void => {
      document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-hostname-item]").forEach(item => {
        if (chaveHostname(item.dataset.hostnameSerie, item.dataset.hostnameNome) !== chave) return;
        item.dataset.hostnamePendente = "1";
        const remover = item.querySelector<HTMLElement>("[data-hostname-remove]");
        if (!remover) return;
        remover.textContent = "Gravar só no cockpit";
        remover.title = "A remoção no Endpoint Central ficou pendente: confira lá; se o computador sumiu, grave só no cockpit";
        remover.setAttribute("aria-label", `Gravar só no cockpit a remoção de ${item.dataset.hostnameNome || ""}`);
      });
    };
    const atualizarMarcas = (): Promise<void> => context.apiFetch<{
      removidos?: { serie?: string; hostname?: string }[]; pendentes?: { serie?: string; hostname?: string }[];
    } | null>("/api/endpoint/hostnames-removidos", { errorMessage: "Não foi possível consultar os hostnames removidos." })
      .then(data => {
        // Rows removed earlier open already marked, so a second click is never offered.
        (data?.removidos || []).forEach(entry => mostrarEstadoHostname(chaveHostname(entry.serie, entry.hostname), true));
        (data?.pendentes || []).forEach(entry => marcarPendente(chaveHostname(entry.serie, entry.hostname)));
      })
      .catch(error => console.error("Erro ao consultar hostnames removidos:", error));
    const alterar = async (botao: HTMLButtonElement, restaurar: boolean): Promise<void> => {
      const item = botao.closest<HTMLElement>("[data-hostname-item]");
      const serie = item?.dataset.hostnameSerie || "";
      const hostname = item?.dataset.hostnameNome || "";
      const chave = chaveHostname(serie, hostname);
      const local = restaurar || item?.dataset.hostnamePendente === "1";
      if (!restaurar && !(await app.confirmarAcao(local ? {
        titulo: "Gravar só no cockpit?",
        mensagem: `A remoção de ${hostname} no Endpoint Central ficou pendente. Confira no Endpoint: se o computador sumiu de lá, grave só no cockpit (o Endpoint não é acionado de novo).`,
        confirmar: "Gravar no cockpit",
      } : {
        titulo: "Remover no Endpoint Central?",
        mensagem: `Remover o computador ${hostname} (série ${serie || "sem série"}) no Endpoint Central? Isso não se desfaz pelo cockpit. Depois da remoção, o outro hostname passa a valer na base e nas próximas exportações.`,
        confirmar: "Remover no Endpoint",
      }))) return;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        if (local) {
          const data = await context.apiFetch<{ mensagem?: string }>(
            `/api/endpoint/hostnames-removidos${restaurar ? "/restaurar" : ""}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ serie, hostname }),
              errorMessage: restaurar ? "Não foi possível desfazer a remoção." : "Não foi possível gravar a remoção.",
            }
          );
          if (item) delete item.dataset.hostnamePendente;
          mostrarEstadoHostname(chave, !restaurar);
          app.atualizarIndicadoresPosSalvamento();
          app.showToast(data.mensagem || (restaurar ? "Hostname restaurado." : "Hostname removido."), "success");
          return;
        }
        app.showToast("Removendo no Endpoint Central pelo Chrome de automação; faça o login se ele pedir.", "info");
        const data = await context.apiFetch<{ resultado?: string; gravado_local?: boolean; mensagem?: string }>(
          "/api/endpoint/hostnames-removidos/remover-no-endpoint",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serie, hostname, confirmado: true }),
            errorMessage: "Não foi possível remover no Endpoint Central.",
          }
        );
        if (data.resultado === "removido" && data.gravado_local) {
          mostrarEstadoHostname(chave, true);
          app.atualizarIndicadoresPosSalvamento();
          app.showToast(data.mensagem || "Computador removido no Endpoint Central.", "success");
        } else {
          void atualizarMarcas();
          app.showToast(data.mensagem || "O computador não foi removido no Endpoint Central.", data.resultado === "incerto" || data.resultado === "removido" ? "warning" : "error");
        }
      } catch (error) {
        console.error("Erro ao alterar hostname duplicado do Endpoint:", error);
        if (!local) void atualizarMarcas(); // 409 de par pendente: o botão passa a gravar só no cockpit
        app.showToast(mensagemDoErro(error) || "Não foi possível concluir a operação.", "error");
      } finally {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
      }
    };
    botoes.forEach(botao => botao.addEventListener("click", () => alterar(botao, botao.hasAttribute("data-hostname-restore"))));
    void atualizarMarcas();
  }

  const TEXTOS_DECISAO_PENDENCIA: Record<string, TextoDecisao | undefined> = {
    permitir: { titulo: "Permitir a substituição?", mensagem: "O usuário do Endpoint passa a valer e o usuário manual é arquivado no histórico de alterações (dá para desfazer lá).", confirmar: "Permitir substituição", resultado: "Substituição permitida" },
    recusar: { titulo: "Manter o usuário manual?", mensagem: "O usuário manual continua valendo e este usuário do Endpoint não será perguntado de novo. Se o Endpoint informar outro usuário, você será avisado.", confirmar: "Manter usuário manual", resultado: "Usuário manual mantido", destrutiva: false },
    remover: { titulo: "Confirmar a remoção do usuário?", mensagem: "Confirma que o usuário realmente deixou de existir? Ele deixa de aparecer na base; um usuário manual arquivado antes volta a valer, se houver.", confirmar: "Confirmar remoção", resultado: "Usuário removido" },
    manter: { titulo: "Manter o usuário?", mensagem: "O usuário continua valendo mesmo sem constar no Endpoint e não será perguntado de novo enquanto o Endpoint não informar outro.", confirmar: "Manter usuário", resultado: "Usuário mantido", destrutiva: false },
  };

  function mostrarEstadoPendenciaUsuario(id: string | undefined, resultado: string): void {
    document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-user-hold]").forEach(bloco => {
      if (bloco.dataset.userHold !== id) return;
      bloco.querySelectorAll<HTMLElement>("[data-user-hold-action]").forEach(botao => { botao.hidden = true; });
      const status = bloco.querySelector<HTMLElement>("[data-user-hold-status]");
      if (status) {
        status.textContent = resultado;
        status.hidden = false;
      }
    });
  }

  // Decides a pending logged-user hold. Nothing changed until now: the current user kept applying.
  function conectarDecisoesPendenciasUsuario(): void {
    const botoes = document.querySelectorAll<HTMLButtonElement>("#comparacao-planilhas-conteudo [data-user-hold-action]");
    if (!botoes.length) return;
    botoes.forEach(botao => botao.addEventListener("click", async () => {
      const id = botao.closest<HTMLElement>("[data-user-hold]")?.dataset.userHold || "";
      const decisao = botao.dataset.userHoldAction;
      const texto = decisao ? TEXTOS_DECISAO_PENDENCIA[decisao] : undefined;
      if (!id || !texto) return;
      if (!(await app.confirmarAcao({
        titulo: texto.titulo, mensagem: texto.mensagem, confirmar: texto.confirmar, destrutiva: texto.destrutiva !== false,
      }))) return;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      try {
        const data = await context.apiFetch<{ mensagem?: string }>(`/api/usuarios/pendencias/${encodeURIComponent(id)}/decidir`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decisao }),
          errorMessage: "Não foi possível registrar a decisão.",
        });
        mostrarEstadoPendenciaUsuario(id, texto.resultado);
        app.atualizarIndicadoresPosSalvamento();
        app.showToast(data.mensagem || `${texto.resultado}.`, "success");
      } catch (error) {
        console.error("Erro ao decidir pendência de usuário:", error);
        app.showToast(mensagemDoErro(error) || "Não foi possível concluir a operação.", "error");
      } finally {
        botao.disabled = false;
        botao.removeAttribute("aria-busy");
      }
    }));
    // Holds decided earlier (here or in another window) open already answered.
    context.apiFetch<{ pendencias?: { id?: string; estado?: string }[] } | null>(
      "/api/usuarios/pendencias", { errorMessage: "Não foi possível consultar as pendências de usuário." },
    )
      .then(data => {
        const aguardando = new Set((data?.pendencias || []).filter(item => item.estado === "pendente").map(item => item.id));
        document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-user-hold]").forEach(bloco => {
          if (!aguardando.has(bloco.dataset.userHold)) mostrarEstadoPendenciaUsuario(bloco.dataset.userHold, "Decisão já registrada");
        });
      })
      .catch(error => console.error("Erro ao consultar pendências de usuário:", error));
  }

  // Autosaves every annotation field; a row listed in more than one section keeps its copies in sync.
  function conectarAnotacoesComparacao(comparison: Comparacao): void {
    const annotationsById = new Map<string, HTMLTextAreaElement[]>();
    document.querySelectorAll<HTMLTextAreaElement>("[data-comparison-annotation]").forEach(textarea => {
      const itemId = textarea.dataset.annotationId;
      const status = textarea.parentElement!.querySelector("[data-annotation-status]");
      const retryButton = textarea.parentElement!.querySelector("[data-annotation-retry]");
      context.annotationAutosave.attachAnnotationAutosave({
        textarea,
        status,
        retryButton,
        eventId: comparison.evento_id,
        itemId,
        send: enviarAnotacao,
      });
      if (itemId) {
        if (!annotationsById.has(itemId)) annotationsById.set(itemId, []);
        annotationsById.get(itemId)!.push(textarea);
      }
    });
    annotationsById.forEach(textareas => sincronizarCopiasAnotacao(textareas));
  }

  function sincronizarCopiasAnotacao(textareas: HTMLTextAreaElement[]): void {
    const syncState = (source: HTMLTextAreaElement, target: HTMLTextAreaElement): void => {
      if (target.value !== source.value) target.value = source.value;
      if (target.dataset.annotationVersion !== source.dataset.annotationVersion) {
        target.dataset.annotationVersion = source.dataset.annotationVersion;
        target.dispatchEvent(new Event("annotationversionchange"));
      }
      const sourceStatus = source.parentElement!.querySelector("[data-annotation-status]");
      const targetStatus = target.parentElement!.querySelector("[data-annotation-status]");
      if (sourceStatus && targetStatus) {
        if (targetStatus.textContent !== sourceStatus.textContent) targetStatus.textContent = sourceStatus.textContent;
        if (targetStatus.className !== sourceStatus.className) targetStatus.className = sourceStatus.className;
      }
      const sourceRetry = source.parentElement!.querySelector<HTMLButtonElement>("[data-annotation-retry]");
      const targetRetry = target.parentElement!.querySelector<HTMLButtonElement>("[data-annotation-retry]");
      if (sourceRetry && targetRetry) {
        targetRetry.hidden = sourceRetry.hidden;
        targetRetry.disabled = sourceRetry.disabled;
      }
    };

    textareas.forEach(source => {
      source.addEventListener("input", () => {
        textareas.forEach(target => {
          if (target !== source) syncState(source, target);
        });
      });
      const status = source.parentElement!.querySelector("[data-annotation-status]");
      if (status && textareas.length > 1) {
        const observer = new MutationObserver(() => {
          textareas.forEach(target => {
            if (target !== source) syncState(source, target);
          });
        });
        observer.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
        comparisonAnnotationSyncObservers.push(observer);
      }
    });
  }

  function desconectarObservadoresAnotacoes(): void {
    comparisonAnnotationSyncObservers.forEach(observer => observer.disconnect());
    comparisonAnnotationSyncObservers = [];
  }

  const ABAS_RESUMO = renderer.RESUMO_ABAS.map(aba => aba.chave);
  const ESTADO_RESUMO_INICIAL: EstadoResumo = { aba: "visao-geral", busca: "", soAnotadas: false, tipo: "" };
  const estadoResumo: EstadoResumo = { ...ESTADO_RESUMO_INICIAL };
  // Set by conectarFiltrosHistoricoComparacao for the content currently on screen; null when there is none.
  let atualizarResumo: (() => void) | null = null;
  // Sem comparação na tela (vazio, carregando ou erro): as abas que só filtram a comparação ficam desabilitadas.
  let semComparacao = true;
  // Novo layout (18/11/2026): bento acima das sub-abas, que abriam em Divergências. Atualizado em 23/11/2026 (pedido do usuário):
  // a barra de sub-abas sobe para o topo e a primeira aba, "Visão Geral", guarda o bento e é a aba padrão.
  // Sem comparação só "Visão Geral", "Divergências" (mensagem de vazio) e "Backups" (não dependem dela) ficam habilitadas.
  const ABAS_SEM_COMPARACAO = ["visao-geral", "divergencias", "backups"];
  const ABA_PADRAO = "visao-geral";
  const abaDesabilitada = (chave: string): boolean => semComparacao && !ABAS_SEM_COMPARACAO.includes(chave) && chave !== estadoResumo.aba;

  const elementoAbaResumo = (chave: string): HTMLElement | null => document.getElementById(`resumo-aba-${chave}`);

  function aplicarAbaResumo(): void {
    const painelAtivo = ABAS_RESUMO.includes(estadoResumo.aba) ? estadoResumo.aba : ABA_PADRAO;
    ABAS_RESUMO.forEach(chave => {
      const botao = elementoAbaResumo(chave);
      if (!botao) return;
      const ativa = chave === painelAtivo;
      botao.setAttribute("aria-selected", String(ativa));
      botao.tabIndex = ativa ? 0 : -1;
      if (abaDesabilitada(chave)) botao.setAttribute("aria-disabled", "true");
      else botao.removeAttribute("aria-disabled");
    });
    document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-resumo-painel]").forEach(painel => {
      painel.hidden = painel.dataset.resumoPainel !== painelAtivo;
    });
    // Um painel por vez. "Visão Geral" mostra o bento (#resumo-painel-visao-geral) e, abaixo dele, só o que vale sem comparação
    // (mensagem de vazio, erro ou "Carregando" e a seção "Sem usuário"), porque não há painéis [data-resumo-painel] para mostrar.
    // Com comparação, a Visão Geral esconde as listas; as outras abas escondem o bento.
    // "Backups" não depende da comparação: o painel fixo fica fora do conteúdo recriado e, com ele aberto,
    // o conteúdo inteiro (filtros e mensagem de vazio) sai de cena. "Ativos por regional" é cartão do bento.
    const naVisaoGeral = painelAtivo === "visao-geral";
    const bento = document.getElementById("resumo-painel-visao-geral");
    if (bento) bento.hidden = !naVisaoGeral;
    const escondeListas = naVisaoGeral && !semComparacao;
    const listas = document.getElementById("resumo-paineis-lista");
    if (listas) listas.hidden = escondeListas;
    const noBackups = painelAtivo === "backups";
    const painelBackups = document.getElementById("resumo-painel-backups");
    if (painelBackups) painelBackups.hidden = !noBackups;
    const conteudo = document.getElementById("comparacao-planilhas-conteudo");
    if (conteudo) conteudo.hidden = noBackups || escondeListas;
  }

  // Tab change keeps the search and the "só anotadas" choice; the type belongs to one tab, so it is cleared.
  function selecionarAbaResumo(chave: string, { foco = false }: { foco?: boolean } = {}): void {
    if (!ABAS_RESUMO.includes(chave) || abaDesabilitada(chave)) return;
    const mudou = chave !== estadoResumo.aba;
    if (mudou) estadoResumo.tipo = "";
    estadoResumo.aba = chave;
    aplicarAbaResumo();
    atualizarResumo?.();
    if (foco) elementoAbaResumo(chave)?.focus();
    // Clique na sub-aba repete contagem, anel e barras do painel aberto (contrato bento), Backups incluído.
    const painelAberto = document.getElementById(`resumo-painel-${chave}`);
    if (painelAberto) {
      painelAberto.querySelectorAll<HTMLElement>("[data-sem-entrada]").forEach(cartao => { delete cartao.dataset.semEntrada; });
      globalThis.SimpressBento?.animarDentro?.(painelAberto);
    }
    // Pede dados novos só na chegada à aba (openPanel seleciona duas vezes e não pode gerar dois refresh).
    if (mudou && chave === "backups") document.dispatchEvent(new CustomEvent("simpress:atualizar-notificacoes"));
  }

  // Números dos cartões do bento que vêm da comparação (Ativos e Backups vêm do painel: bento-resumo.ts). Sem comparação: "—".
  const CARTOES_DA_COMPARACAO = ["divergencias", "apelidos", "usuarios", "sem-acesso"];
  function limparNumerosCartoes(): void {
    CARTOES_DA_COMPARACAO.forEach(chave => escreverNumeroCartao(chave, null));
  }

  // "Ver lista →" dos cartões: abre a sub-aba (a barra fica no topo do Resumo, então rola ao topo dela) e põe o foco na aba; "Ativos" vai ao cartão "Ativos por regional".
  function conectarCartoesBento(): void {
    const topo = document.querySelector<HTMLElement>(".nf3-topo");
    if (!topo || topo.dataset.nf3Conectado === "true") return;
    topo.dataset.nf3Conectado = "true";
    topo.addEventListener("click", event => {
      const botao = (event.target as HTMLElement).closest<HTMLElement>("[data-nf3-ver]");
      if (!botao) return;
      const reduzido = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const comportamento: ScrollBehavior = reduzido ? "auto" : "smooth";
      const chave = botao.dataset.nf3Ver || "";
      if (chave === "ativos") {
        const regionais = document.getElementById("resumo-ativos-secao");
        regionais?.scrollIntoView({ behavior: comportamento, block: "start" });
        regionais?.focus({ preventScroll: true });
        return;
      }
      if (abaDesabilitada(chave)) return; // sem comparação a aba não abre: não rola nem foca uma aba desabilitada
      selecionarAbaResumo(chave);
      document.querySelector<HTMLElement>(".nf3-sub--abas")?.scrollIntoView({ behavior: comportamento, block: "start" });
      elementoAbaResumo(chave)?.focus({ preventScroll: true });
    });
  }

  function conectarAbasResumo(): void {
    conectarCartoesBento();
    const lista = document.querySelector<HTMLElement>(".resumo-abas");
    if (!lista || lista.dataset.resumoConectado === "true") return;
    lista.dataset.resumoConectado = "true";
    lista.addEventListener("click", event => {
      const botao = (event.target as HTMLElement).closest<HTMLElement>("[data-resumo-aba]");
      if (botao) selecionarAbaResumo(botao.id.replace("resumo-aba-", ""));
    });
    lista.addEventListener("keydown", event => {
      const botao = (event.target as HTMLElement).closest<HTMLElement>("[data-resumo-aba]");
      if (!botao) return;
      // Setas, Home e End andam só pelas abas habilitadas.
      const habilitadas = ABAS_RESUMO.filter(chave => !abaDesabilitada(chave));
      const indice = habilitadas.indexOf(botao.id.replace("resumo-aba-", ""));
      // Foco numa aba desabilitada (clique): a seta direita vai à primeira habilitada e a esquerda à última.
      const destinos: Record<string, number | undefined> = {
        ArrowRight: indice + 1, ArrowLeft: (indice < 0 ? habilitadas.length : indice) - 1, Home: 0, End: habilitadas.length - 1,
      };
      const destino = destinos[event.key];
      if (destino === undefined || !habilitadas.length) return;
      event.preventDefault();
      selecionarAbaResumo(habilitadas[(destino + habilitadas.length) % habilitadas.length], { foco: true });
    });
  }

  function escreverContagemAba(chave: string, total: number | null, filtrando: boolean): void {
    const selo = document.getElementById(`resumo-${chave}-contagem`);
    const botao = elementoAbaResumo(chave);
    if (selo) selo.textContent = total === null ? "—" : total.toLocaleString("pt-BR");
    if (botao) botao.setAttribute("aria-label", renderer.rotuloContagemAba(chave, total, filtrando));
  }

  // Back to the empty state: tab "Visão Geral" (default; the alert and row navigation pick their tab explicitly), no filters, zeroed counters, no notice from the previous result.
  // "Backups" não é da comparação: a aba aberta continua aberta e o selo dela (escrito pelo painel React frontend/src/paineis/backups-regionais/) não é zerado.
  // `abaPedida` (opcional): aba que a abertura do painel já pediu (alerta, sino, série); vale se estiver habilitada sem comparação,
  // para o Resumo não piscar a Visão Geral antes de a aba pedida voltar depois do render (23/11/2026).
  function limparAbasResumo(abaPedida?: string): void {
    const abaAtual = estadoResumo.aba;
    Object.assign(estadoResumo, ESTADO_RESUMO_INICIAL);
    if (abaAtual === "backups") estadoResumo.aba = "backups";
    if (abaPedida && ABAS_SEM_COMPARACAO.includes(abaPedida)) estadoResumo.aba = abaPedida;
    atualizarResumo = null;
    semComparacao = true;
    desconectarObservadoresAnotacoes();
    ABAS_RESUMO.filter(chave => chave !== "backups" && chave !== "visao-geral").forEach(chave => escreverContagemAba(chave, 0, false));
    limparNumerosCartoes();
    const avisos = document.getElementById("comparacao-planilhas-avisos");
    if (avisos) avisos.innerHTML = "";
    const barra = document.querySelector<HTMLElement>(".resumo-abas-barra");
    if (barra) barra.hidden = false;
    conectarAbasResumo();
    aplicarAbaResumo();
  }

  function conectarFiltrosHistoricoComparacao(content: HTMLElement | null): void {
    atualizarResumo = null;
    if (!content) return;
    conectarAbasResumo();
    const paineis = typeof content.querySelectorAll === "function" ? [...content.querySelectorAll<HTMLElement>("[data-resumo-painel]")] : [];
    const comPaineis = paineis.length > 0;
    semComparacao = !comPaineis;
    if (!comPaineis) limparNumerosCartoes();
    // A barra fica sempre visível: a aba Backups existe com ou sem comparação.
    const barraAbas = document.querySelector<HTMLElement>(".resumo-abas-barra");
    if (barraAbas) barraAbas.hidden = false;
    aplicarAbaResumo();

    const filterBar = content.querySelector<HTMLElement>("[data-history-filter-bar]");
    if (!filterBar && !comPaineis) return;
    const searchInput = filterBar?.querySelector<HTMLInputElement>("[data-history-filter-search]") || null;
    const categorySelect = filterBar?.querySelector<HTMLSelectElement>("[data-history-filter-category]") || null;
    const annotatedOnly = filterBar?.querySelector<HTMLInputElement>("[data-history-filter-annotated]") || null;
    const status = filterBar?.querySelector<HTMLElement>("[data-history-filter-count]") || null;
    const canonicalize = renderer.canonicalizarCategoriaResumo;
    const rotulosCategoria = renderer.ROTULOS_CATEGORIA_RESUMO;
    const normalizeText = (value: unknown): string => String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("pt-BR");
    const setHidden = (element: HTMLElement, hidden: boolean): void => {
      element.hidden = hidden;
      element.classList.toggle("hidden", hidden);
    };
    const seletorLinha = "tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]";
    const informativa = (linha: HTMLElement): boolean => Boolean(linha.closest("[data-resumo-informativo]"));
    const hasAnnotation = (row: HTMLElement): boolean => [...row.querySelectorAll<HTMLTextAreaElement>("[data-comparison-annotation]")].some(textarea => {
      if (textarea.value.trim()) return true;
      try {
        const version = JSON.parse(textarea.dataset.annotationVersion || "null");
        return Boolean(version?.anotacao_conflito || version?.anotacao_integridade_invalida);
      } catch (error) {
        return false;
      }
    });

    if (searchInput) searchInput.value = estadoResumo.busca;
    if (annotatedOnly) annotatedOnly.checked = estadoResumo.soAnotadas;
    let abaDoSeletor: string | null = null;

    // Type options follow the active tab and only list what the tab really has.
    const popularTipos = (chave: string, linhasDaAba: HTMLElement[]): void => {
      if (!categorySelect || abaDoSeletor === chave) return;
      abaDoSeletor = chave;
      const presentes = [...new Set(linhasDaAba.filter(linha => !informativa(linha))
        .map(linha => canonicalize(linha.dataset.comparisonCategory)).filter(Boolean))];
      const tipos = comPaineis
        ? renderer.tiposDaAba(chave, presentes)
        : presentes.map(valor => ({ valor, rotulo: rotulosCategoria[valor] || valor }))
          .sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR"));
      categorySelect.replaceChildren(new Option("Todos os tipos", ""));
      tipos.forEach(tipo => categorySelect.add(new Option(tipo.rotulo, tipo.valor)));
      estadoResumo.tipo = tipos.some(tipo => tipo.valor === estadoResumo.tipo) ? estadoResumo.tipo : "";
      categorySelect.value = estadoResumo.tipo;
    };

    const updateFilters = (): void => {
      const chaveAba = comPaineis ? estadoResumo.aba : "";
      const painelAtivo = comPaineis ? paineis.find(painel => painel.dataset.resumoPainel === chaveAba) : null;
      const todasLinhas = [...content.querySelectorAll<HTMLElement>(seletorLinha)];
      popularTipos(chaveAba, painelAtivo ? [...painelAtivo.querySelectorAll<HTMLElement>("tr[data-comparison-category]")] : todasLinhas);

      const query = normalizeText(estadoResumo.busca.trim());
      const onlyAnnotated = estadoResumo.soAnotadas;
      const categoriasDoTipo = comPaineis
        ? renderer.categoriasDoTipo(chaveAba, estadoResumo.tipo)
        : (estadoResumo.tipo ? [estadoResumo.tipo] : null);
      const filtersActive = Boolean(query || categoriasDoTipo || onlyAnnotated);

      todasLinhas.forEach(row => {
        const category = canonicalize(row.dataset.comparisonCategory);
        const annotationPresent = hasAnnotation(row);
        const annotationText = [...row.querySelectorAll<HTMLTextAreaElement>("[data-comparison-annotation]")]
          .map(textarea => textarea.value)
          .join(" ");
        const searchable = normalizeText(`${row.textContent} ${annotationText} ${rotulosCategoria[category] || category}`);
        // The type filter only applies to the active tab and never to the informational "atualizados" section.
        const doTipo = !categoriasDoTipo || informativa(row) || categoriasDoTipo.includes(category)
          || Boolean(painelAtivo && !painelAtivo.contains(row));
        const matches = doTipo
          && (!query || searchable.includes(query))
          && (!onlyAnnotated || annotationPresent);
        setHidden(row, !matches);
        row.classList.toggle("history-row-annotated", annotationPresent);
      });

      content.querySelectorAll<HTMLElement>("[data-history-filter-group]").forEach(group => {
        const groupRows = [...group.querySelectorAll<HTMLElement>(seletorLinha)];
        setHidden(group, filtersActive && (groupRows.length === 0 || groupRows.every(row => row.hidden)));
      });
      content.querySelectorAll<HTMLElement>("[data-history-filter-section]").forEach(section => {
        // Nos cartões do Bloco 2 os grupos ficam dentro de .ck-bento-face.
        const groups = [...section.querySelectorAll<HTMLElement>(":scope > [data-history-filter-group], :scope > .ck-bento-face > [data-history-filter-group]")];
        setHidden(section, filtersActive && (!groups.length || groups.every(group => group.hidden)));
      });

      const linhasVisiveis = (painel: HTMLElement): HTMLElement[] => [...painel.querySelectorAll<HTMLElement>("tr[data-comparison-category]")]
        .filter(row => !informativa(row) && !row.hidden);
      paineis.forEach(painel => {
        const chave = painel.dataset.resumoPainel;
        if (chave === undefined) return;
        const todas = [...painel.querySelectorAll<HTMLElement>("tr[data-comparison-category]")].filter(row => !informativa(row));
        const listaAusente = Boolean(painel.querySelector("[data-resumo-lista-ausente]")) && todas.length === 0;
        const total = listaAusente ? null : linhasVisiveis(painel).length;
        escreverContagemAba(chave, total, filtersActive);
        // O cartão do bento mostra o total do resultado, sem o filtro de busca (o selo da sub-aba é que acompanha o filtro).
        if (CARTOES_DA_COMPARACAO.includes(chave)) escreverNumeroCartao(chave, listaAusente ? null : todas.length);
        const vazio = painel.querySelector<HTMLElement>("[data-resumo-vazio]");
        if (vazio) vazio.hidden = !(total === 0 && !filtersActive);
      });

      if (filterBar) {
        // A barra acompanha a sub-aba aberta: logo depois dos contadores dela (ou no topo, se não houver).
        if (painelAtivo) {
          const faixa = painelAtivo.querySelector(":scope > .resumo-cartoes");
          if (faixa ? faixa.nextElementSibling !== filterBar : painelAtivo.firstElementChild !== filterBar) {
            if (faixa) faixa.after(filterBar);
            else painelAtivo.prepend(filterBar);
          }
        }
        setHidden(filterBar, false);
        const visiveis = painelAtivo
          ? linhasVisiveis(painelAtivo).length
          : todasLinhas.filter(row => row.tagName === "TR" && !informativa(row) && !row.hidden).length;
        if (status) {
          status.textContent = visiveis
            ? renderer.textoContadorResumo(visiveis, filtersActive)
            : filtersActive ? renderer.textoSemResultado(estadoResumo.busca.trim())
              : (renderer.TEXTO_VAZIO_ABA[chaveAba] || "Nenhuma linha de divergência neste resultado.");
        }
      }
    };
    atualizarResumo = updateFilters;

    searchInput?.addEventListener("input", () => { estadoResumo.busca = searchInput.value; updateFilters(); });
    categorySelect?.addEventListener("change", () => { estadoResumo.tipo = categorySelect.value; updateFilters(); });
    annotatedOnly?.addEventListener("change", () => { estadoResumo.soAnotadas = annotatedOnly.checked; updateFilters(); });
    content.querySelectorAll<HTMLTextAreaElement>("[data-comparison-annotation]").forEach(textarea => {
      textarea.addEventListener("input", updateFilters);
      textarea.addEventListener("annotationversionchange", updateFilters);
    });
    const annotationVersionObserver = new MutationObserver(updateFilters);
    annotationVersionObserver.observe(content, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-annotation-version"],
    });
    comparisonAnnotationSyncObservers.push(annotationVersionObserver);
    updateFilters();
  }

  function normalizarIdentificadorLinhaComparacao(value: unknown): string {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  }

  // incluirOcultos: acha o grupo mesmo dentro de uma sub-aba oculta (para saber qual aba abrir antes de navegar).
  function encontrarGrupoSecaoComparacao(
    content: HTMLElement, sectionKey: unknown, { incluirOcultos = false }: { incluirOcultos?: boolean } = {},
  ): HTMLElement | undefined {
    const target = String(sectionKey || "").trim();
    const normalizedTarget = normalizarIdentificadorLinhaComparacao(target);
    return [...content.querySelectorAll<HTMLElement>("[data-history-filter-group]")].find(candidate => {
      if (!incluirOcultos && !candidate.getClientRects().length) return false;
      if (candidate.dataset.historyFilterGroup === target) return true;
      const section = candidate.closest("[data-history-filter-section]");
      const headings = [candidate.querySelector("h5"), section?.querySelector("h4")]
        .filter((heading): heading is HTMLHeadingElement => Boolean(heading))
        .map(heading => normalizarIdentificadorLinhaComparacao(heading.textContent));
      return headings.includes(normalizedTarget);
    });
  }

  function encontrarTituloSecaoComparacao(content: HTMLElement, sectionKey: unknown): HTMLElement | null {
    const group = encontrarGrupoSecaoComparacao(content, sectionKey);
    if (!group) return null;
    const section = group.closest("[data-history-filter-section]");
    return group.querySelector<HTMLElement>("h5") || section?.querySelector<HTMLElement>("h4") || group.querySelector<HTMLElement>("h4");
  }

  const PRIORIDADE_CATEGORIAS_SERIE = ["divergencias_local", "ausentes_no_endpoint", "divergencias_usuario", "ausentes_em_detalhes"];

  function acharLinhaComparacao(rows: HTMLElement[], target: AlvoNavegacao): HTMLElement | null {
    let row: HTMLElement | null | undefined = target.itemId ? rows.find(candidate => candidate.dataset.comparisonItemId === target.itemId) : null;
    if (row) return row;
    const serial = normalizarIdentificadorLinhaComparacao(target.serial);
    const hostname = normalizarIdentificadorLinhaComparacao(target.hostname);
    const matches = rows.filter(candidate => {
      const sameSerial = serial && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonSerial) === serial;
      const sameHostname = hostname && normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonHostname) === hostname;
      return sameSerial ? (!hostname || sameHostname) : (!serial && sameHostname);
    });
    // Sem categoria (Home): mesma prioridade das divergências listadas lá, não a primeira seção da página.
    const priority = (candidate: HTMLElement): number => {
      const index = PRIORIDADE_CATEGORIAS_SERIE.indexOf(candidate.dataset.comparisonCategory as string);
      return index < 0 ? PRIORIDADE_CATEGORIAS_SERIE.length : index;
    };
    row = target.category ? matches[0] : matches.reduce<HTMLElement | null>((best, candidate) => (!best || priority(candidate) < priority(best) ? candidate : best), null);
    // Endpoint MacBook serial lacks the leading "S" of EquipamentosDetalhes; accepted only when unambiguous.
    if (!row && serial && !target.category) {
      const equivalents = rows.filter(candidate => {
        const other = normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonSerial);
        return other && (other === `S${serial}` || `S${other}` === serial);
      });
      if (new Set(equivalents.map(candidate => normalizarIdentificadorLinhaComparacao(candidate.dataset.comparisonSerial))).size === 1) row = equivalents[0];
    }
    return row || null;
  }

  function navegarParaLinhaComparacao(target: AlvoNavegacao | null | undefined): void {
    const content = document.getElementById("comparacao-planilhas-conteudo");
    if (!content) return;
    if (target?.section) {
      const aba = encontrarGrupoSecaoComparacao(content, target.section, { incluirOcultos: true })?.closest<HTMLElement>("[data-resumo-painel]")?.dataset.resumoPainel;
      if (aba) selecionarAbaResumo(aba);
      const group = encontrarGrupoSecaoComparacao(content, target.section);
      if (!group) return;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      // Include the section title when the section holds only this group, and stop well below the sticky filter bar.
      const section = group.closest<HTMLElement>("[data-history-filter-section]");
      const anchor = section && section.querySelectorAll("[data-history-filter-group]").length === 1 ? section : group;
      const bar = content.querySelector<HTMLElement>("[data-history-filter-bar]");
      anchor.style.scrollMarginTop = `${(bar && getComputedStyle(bar).position === "sticky" ? bar.offsetHeight : 0) + 32}px`;
      anchor.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
      const heading = (section || group.closest("[data-history-filter-section]") || group).querySelector<HTMLElement>("h4");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
      motion?.reveal(group);
      return;
    }
    if (!target?.category && !target?.serial && !target?.hostname) return;
    const linhasDe = (categoria: string | undefined): HTMLElement[] => [...content.querySelectorAll<HTMLElement>("tr[data-comparison-category], .comparison-mobile-card[data-comparison-category]")]
      .filter(candidate => !categoria || candidate.dataset.comparisonCategory === categoria);
    // Procura em todas as linhas, inclusive as de sub-abas ocultas: a aba só se abre depois de achar a linha.
    // The Home category may not hold the row in this event (e.g. a divergence listed under another key): retry by serial/hostname alone.
    const achada = acharLinhaComparacao(linhasDe(target.category), target)
      || (target.category ? acharLinhaComparacao(linhasDe(""), { ...target, category: "" }) : null);
    if (!achada) {
      // Linha não encontrada: o usuário vê a lista (Divergências), como antes da Visão Geral, e não o bento (23/11/2026).
      // Com categoria pedida, a aba dela (ex.: "apelidos" para registros_ambiguos); sem ela, Divergências.
      const abaFallback = (target.category && renderer.abaDaCategoria(target.category)) || "divergencias";
      if (!abaDesabilitada(abaFallback)) selecionarAbaResumo(abaFallback);
      return;
    }
    const categoria = achada.dataset.comparisonCategory;
    const aba = renderer.abaDaCategoria(categoria) || achada.closest<HTMLElement>("[data-resumo-painel]")?.dataset.resumoPainel;
    if (aba && !abaDesabilitada(aba)) selecionarAbaResumo(aba);
    // Sem comparação a aba da lista (ex.: "Usuários") está desabilitada e a linha ("Sem usuário") não mora em painel de aba:
    // "Divergências" mostra o conteúdo, então a linha fica alcançável de qualquer aba (23/11/2026).
    else if (!achada.closest("[data-resumo-painel]")) selecionarAbaResumo("divergencias");
    // Com a aba aberta, o gêmeo visível da linha (tr no desktop, cartão no mobile).
    const row = acharLinhaComparacao(linhasDe(categoria).filter(candidate => candidate.getClientRects().length > 0), {
      itemId: achada.dataset.comparisonItemId, serial: achada.dataset.comparisonSerial, hostname: achada.dataset.comparisonHostname, category: categoria,
    });
    if (!row) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    motion?.reveal(row);
    if (target.destacar) {
      row.classList.add("ck-linha-destaque");
      setTimeout(() => row.classList.remove("ck-linha-destaque"), 1500);
    }
  }

  async function resolverDivergenciaApelidoManual(
    comparison: Comparacao, item: DivergenciaApelidoManual, acao: string | undefined, botao: HTMLButtonElement,
  ): Promise<void> {
    if (!comparison.evento_id || !item.serie) {
      app.showToast("Este registro não permite resolver a divergência.", "error");
      return;
    }
    if (acao === "excluir" && !(await app.confirmarAcao({
      titulo: "Remover alteração manual?",
      mensagem: `Remover a alteração manual da série ${item.serie}? O apelido voltará ao hostname da fonte no endpoint, se preenchido, ou ao valor cadastrado na Simpress.`,
      confirmar: "Remover alteração",
    }))) return;

    const row = botao.closest<HTMLElement>("[data-manual-alias-row]");
    const rowIndex = row?.dataset.manualAliasRow;
    const matchingRows = rowIndex === undefined
      ? [row].filter((candidate): candidate is HTMLElement => Boolean(candidate))
      : [...document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-manual-alias-row]")]
        .filter(candidate => candidate.dataset.manualAliasRow === rowIndex);
    const actionAreas = matchingRows
      .map(candidate => candidate.querySelector<HTMLElement>("[data-manual-alias-actions]"))
      .filter((area): area is HTMLElement => Boolean(area));
    const buttons = actionAreas.length
      ? actionAreas.flatMap(actionArea => [...actionArea.querySelectorAll<HTMLButtonElement>("button")])
      : [botao];
    buttons.forEach(button => {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    });
    try {
      const data = await context.apiFetch<{ resolucao?: string; equipamento?: { serial?: unknown }; mensagem?: string }>(
        `/api/historico-comparacoes/${encodeURIComponent(comparison.evento_id)}/apelido-manual/${encodeURIComponent(item.serie)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acao }),
          errorMessage: "Não foi possível resolver a divergência.",
        }
      );

      item.resolucao = data.resolucao;
      const pendingCounter = document.getElementById("comparacao-divergencias-manuais-pendentes");
      if (pendingCounter) {
        const pendentes = (comparison.divergencias_apelidos_manuais || []).filter(
          divergence => !divergence.resolucao || divergence.resolucao === "pendente"
        ).length;
        // O contador é .ck-bento-num: só o número muda; a cor do cartão é o data-tom, fixo.
        globalThis.SimpressBento?.cancelar?.(pendingCounter); // ação no meio da contagem: o quadro seguinte não pode regravar o número antigo
        pendingCounter.textContent = String(pendentes);
        pendingCounter.dataset.bentoContar = String(pendentes);
      }
      matchingRows.forEach(candidate => {
        const status = candidate.querySelector("[data-manual-alias-status]");
        if (status) status.textContent = acao === "manter" ? "Alteração manual mantida" : "Alteração manual removida";
      });
      actionAreas.forEach(actionArea => {
        const concluido = document.createElement("span");
        concluido.className = "text-xs text-fg-muted";
        concluido.textContent = "Concluído";
        actionArea.replaceWith(concluido);
      });

      const equipment = data.equipamento;
      const currentSerial = String(appState.currentEquipamento?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      const changedSerial = String(equipment?.serial || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
      if (equipment && currentSerial && currentSerial === changedSerial) {
        app.definirEquipamentoAtual(equipment);
        app.exibirEquipamento(equipment);
      }
      app.atualizarIndicadoresPosSalvamento();
      app.showToast(data.mensagem || "Divergência registrada no histórico.", "success");
    } catch (error) {
      console.error("Erro ao resolver divergência de apelido manual:", error);
      app.showToast(mensagemDoErro(error) || "Não foi possível resolver a divergência.", "error");
      buttons.forEach(button => {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      });
    }
  }

  function conectarCartoesResumoComparacao(): void {
    document.querySelectorAll<HTMLElement>("#comparacao-planilhas-conteudo [data-comparison-section-target]").forEach(button => {
      button.addEventListener("click", () => irParaSecaoComparacao(button.dataset.comparisonSectionTarget));
    });
    document.querySelectorAll<HTMLDetailsElement>("#comparacao-planilhas-conteudo [data-user-change-details]").forEach(details => {
      const rotulo = details.querySelector("[data-user-change-toggle-label]");
      details.addEventListener("toggle", () => {
        if (rotulo) rotulo.textContent = details.open ? "Minimizar lista de usuários alterados" : "Expandir lista de usuários alterados";
      });
    });
  }

  // Scrolls the result dialog to a section title and focuses it. A section hidden by the history
  // filters can only be reached by clearing them, so every filter is reset in that case.
  function irParaSecaoComparacao(sectionId: string | undefined): boolean {
    const content = document.getElementById("comparacao-planilhas-conteudo");
    const heading = sectionId ? document.getElementById(sectionId) : null;
    if (!content || !heading || !content.contains(heading)) return false;
    const aba = heading.closest<HTMLElement>("[data-resumo-painel]")?.dataset.resumoPainel;
    if (aba) selecionarAbaResumo(aba);
    const oculta = (): boolean => Boolean(heading.closest("[hidden]"));
    if (oculta()) limparFiltrosHistoricoComparacao(content);
    if (oculta()) return false;
    const recolhida = heading.closest("section")?.querySelector<HTMLDetailsElement>("details[data-user-change-details]:not([open])");
    if (recolhida) recolhida.open = true;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const bar = content.querySelector<HTMLElement>("[data-history-filter-bar]");
    heading.style.scrollMarginTop = `${(bar && getComputedStyle(bar).position === "sticky" ? bar.offsetHeight : 0) + 16}px`;
    // Focus without scrolling; scrollIntoView then places the title just below the sticky filter bar.
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    return true;
  }

  function limparFiltrosHistoricoComparacao(content: HTMLElement): void {
    const searchInput = content.querySelector<HTMLInputElement>("[data-history-filter-search]");
    const categorySelect = content.querySelector<HTMLSelectElement>("[data-history-filter-category]");
    const annotatedOnly = content.querySelector<HTMLInputElement>("[data-history-filter-annotated]");
    if (searchInput) searchInput.value = "";
    if (categorySelect) categorySelect.value = "";
    if (annotatedOnly) annotatedOnly.checked = false;
    // The filters read estadoResumo, not the DOM: clear the state too, or tipo/só anotadas keep hiding rows.
    Object.assign(estadoResumo, { busca: "", soAnotadas: false, tipo: "" });
    if (atualizarResumo) atualizarResumo();
    else searchInput?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function atributosVersaoAnotacao(item: ItemComAnotacao): string {
    const version = {
      anotacao_revisoes: item.anotacao_revisoes || [],
      anotacao_conflito: Boolean(item.anotacao_conflito),
      anotacao_conflitos: item.anotacao_conflitos || [],
      anotacao_bases_ausentes: item.anotacao_bases_ausentes || [],
      anotacao_integridade_invalida: Boolean(item.anotacao_integridade_invalida),
    };
    return `data-annotation-version="${escapeHtml(JSON.stringify(version))}"`;
  }

  function renderizarAnotacaoOperacional(item: ItemComAnotacao | null | undefined, contexto: unknown): string {
    const itemId = String(item?.anotacao_id || "");
    if (!itemId) return "";
    return `<label class="block min-w-[220px] text-xs text-fg-subtle">Anotação sobre ${escapeHtml(contexto)}
        <textarea data-operational-annotation ${atributosVersaoAnotacao(item!)} data-annotation-id="${escapeHtml(itemId)}" rows="2" maxlength="2000" class="annotation-field mt-1 w-full" placeholder="Escreva uma anotação...">${escapeHtml(item!.anotacao || "")}</textarea>
        <span class="annotation-status mt-1${item!.anotacao ? " is-saved" : ""}" data-annotation-status aria-live="polite">${item!.anotacao ? "Salvo automaticamente" : ""}</span>
        <button type="button" class="annotation-retry mt-1" data-annotation-retry hidden aria-label="Tentar novamente a sincronização desta anotação">Tentar sincronizar novamente</button>
      </label>`;
  }

  function conectarAnotacoesOperacionais(root: ParentNode, fallbackEventId: string | number | undefined): void {
    root.querySelectorAll<HTMLTextAreaElement>("[data-operational-annotation]").forEach(textarea => {
      const eventId = textarea.dataset.eventId || fallbackEventId;
      const itemId = textarea.dataset.annotationId;
      const status = textarea.parentElement!.querySelector("[data-annotation-status]");
      const retryButton = textarea.parentElement!.querySelector("[data-annotation-retry]");
      context.annotationAutosave.attachAnnotationAutosave({
        textarea,
        status,
        retryButton,
        eventId,
        itemId,
        send: enviarAnotacao,
      });
    });
  }

  return {
    renderizarResultadoComparacao, renderizarSemUsuarioSemComparacao, carregarSemUsuarioResumo, invalidarSemUsuarioResumo, navegarParaLinhaComparacao, irParaSecaoComparacao, atributosVersaoAnotacao,
    renderizarAnotacaoOperacional, conectarAnotacoesOperacionais, selecionarAbaResumo, limparAbasResumo,
  };
}
