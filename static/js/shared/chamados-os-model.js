// Pareamento chamado × OS (regra espelhada por chamados_com_os_sebrae do Assistente; o painel "Chamados × OS" saiu em 08/11/2026), sem DOM nem rede: junta os chamados em aberto do F5 (GET /api/sebrae/novos) que têm OS
// com a OS no relatório do F6 (GET /api/operacoes/chamados). Só leitura; nada é gravado.
(function (root, factory) {
  const busca = typeof module === "object" && module.exports ? require("./catalog-search-utils.js") : root.SimpressCatalogSearch;
  const api = factory(busca);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressChamadosOsModel = api;
})(typeof window !== "undefined" ? window : globalThis, function createChamadosOsModel(busca) {
  "use strict";

  const lista = valor => (Array.isArray(valor) ? valor : []);
  const texto = valor => String(valor ?? "").trim();
  // Mesmas normalizações de serialKey/orderKey em static/js/ui/data-panels.js.
  const serialKey = valor => String(valor || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const orderKey = valor => String(valor || "").replace(/\s+/g, "").toUpperCase();
  // Mesmo critério do selo `OS` do cartão do F5 (seloOs em sebrae-dashboard.js).
  const temOs = os => Boolean(os) && os !== "—";

  /** Chamados como o F5 os lista (novos primeiro), já com a OS do selo `OS`. */
  function chamadosComOs(sebrae) {
    // Novos e Antigos excluem quem está em importado.finalizados (status `ok`): emAberto em sebrae-dashboard.js:2272.
    const finalizados = new Set(lista(sebrae?.importado?.finalizados).map(item => item?.numero));
    const novos = lista(sebrae?.novos?.formulario).map(item => ({
      chave: item?.numero, numero: texto(item?.numero), titulo: texto(item?.linha?.G), situacao: "novo",
      abertura: item?.linha?.P ?? "", serie: texto(item?.linha?.K), os: texto(item?.linha?.E),
    }));
    const antigos = lista(sebrae?.importado?.abertos).map(item => {
      const leitura = item?.leitura_softexpert || null;
      const chave = item?.numero;
      return {
        chave, numero: String(chave ?? "").startsWith("linha:") ? texto(item?.chamado) : texto(chave),
        titulo: texto(item?.titulo) || texto(leitura?.titulo), situacao: "antigo",
        abertura: texto(leitura?.habilitada_em), // antigo não traz P: o F5 mostra "Habilitada em" da leitura (dadosAntigo)
        serie: texto(item?.automaticos?.K || item?.automaticos_sugeridos?.K),
        os: texto(item?.automaticos?.E || item?.automaticos_sugeridos?.E),
      };
    });
    return [...novos, ...antigos].filter(item => item.chave != null && !finalizados.has(item.chave) && temOs(item.os));
  }

  function tipoVinculo(itens, chamado) {
    const iguais = itens.filter(item => texto(item?.chamado).toUpperCase() === texto(chamado.numero).toUpperCase()
      && serialKey(item?.serie) === serialKey(chamado.serie) && orderKey(item?.os) === orderKey(chamado.os));
    if (!iguais.length) return "";
    // Sem origem = digitado à mão (vale sobre qualquer outro); "finalizacao" = marca de OS finalizada; qualquer outra origem segue como "dashboard".
    if (iguais.some(item => !item?.origem)) return "manual";
    return iguais.some(item => item.origem === "finalizacao") ? "finalizacao" : "dashboard";
  }

  function montarParesChamadoOs(entrada) {
    const { sebrae, relatorio, vinculos } = entrada || {};
    const registros = new Map();
    const seriesPorOs = new Map();
    lista(relatorio?.chamados).forEach(registro => {
      const chave = serialKey(registro?.serie);
      if (!chave) return;
      if (!registros.has(chave)) registros.set(chave, registro);
      [...lista(registro?.oracle).map(item => item?.ordem_servico), ...lista(registro?.simpress?.ordens_servico)].forEach(os => {
        const ordem = orderKey(os);
        if (ordem) seriesPorOs.set(ordem, (seriesPorOs.get(ordem) || new Set()).add(chave));
      });
    });
    const itensVinculo = Array.isArray(vinculos) ? vinculos : lista(vinculos?.vinculos);
    return chamadosComOs(sebrae).map(chamado => {
      const alvo = orderKey(chamado.os);
      const chaveSerie = serialKey(chamado.serie);
      // MacBook: a outra grafia (com/sem `S` inicial) só quando a série exata não existe no relatório.
      const porSerie = registros.get(chaveSerie)
        || (chaveSerie && registros.get(chaveSerie.startsWith("S") ? chaveSerie.slice(1) : `S${chaveSerie}`)) || null;
      // Sem série (ou série fora do relatório), liga pela OS só se ela está em uma única série; série achada sem a OS é divergência real.
      const seriesDaOs = porSerie ? null : seriesPorOs.get(alvo);
      const doSerie = porSerie || (seriesDaOs?.size === 1 ? registros.get([...seriesDaOs][0]) : null);
      const oracle = lista(doSerie?.oracle).filter(item => orderKey(item?.ordem_servico) === alvo);
      const osSimpress = lista(doSerie?.simpress?.ordens_servico).find(os => orderKey(os) === alvo);
      const naSimpress = osSimpress !== undefined;
      const fontes = [...(oracle.length ? ["oracle"] : []), ...(naSimpress ? ["simpress"] : [])];
      const encontrada = fontes.length > 0;
      return {
        ...chamado,
        encontrada,
        fontes,
        statusOracle: oracle.map(item => [item.status, item.sub_status].filter(Boolean).join(" · ")).filter(Boolean).join(" / "),
        // status da Simpress é por série; só aparece quando a OS está lá, para não mostrar o de outra OS
        statusSimpress: naSimpress ? lista(doSerie?.simpress?.status).filter(Boolean).join(" / ") : "",
        relacao: encontrada ? texto(doSerie?.relacao) : "",
        registro: encontrada ? doSerie : null,
        // Grafia do relatório (como na linha da F6), para o link da OS achar a linha mesmo com K/E escritos de outro jeito.
        serieRelatorio: encontrada ? texto(doSerie?.serie) : "",
        osRelatorio: encontrada ? texto(naSimpress ? osSimpress : oracle[0]?.ordem_servico) : "",
        vinculo: tipoVinculo(itensVinculo, chamado),
      };
    });
  }

  function filtrarParesChamadoOs(pares, termo) {
    const alvo = busca.normalizeSearchText(termo);
    if (!alvo) return lista(pares);
    return lista(pares).filter(par => [par?.numero, par?.serie, par?.os].some(valor => busca.normalizeSearchText(valor).includes(alvo)));
  }

  // ----- marca de OS finalizada (GET /api/operacoes/chamados/marcas-finalizacao): só apresentação, nada é gravado aqui -----
  const SELOS = Object.freeze({ site: "Chamado finalizado", outro_tecnico: "Finalizado por outro técnico" });
  const MOTIVOS_MARCA = Object.freeze({
    saiu_do_dashboard: "Saiu da lista de abertos do Dashboard sem finalização pelo site.",
    nao_encontrado_softexpert: "Não encontrado no SoftExpert na última leitura.",
  });
  const EVENTOS_MARCA = Object.freeze({ marcada: "Marcada", desfeita: "Desfeita", refeita: "Refeita", conferida: "Conferida" });
  const ORIGENS_EVENTO = Object.freeze({ auto: "automática", manual: "manual" });

  // Mesma chave de osObsKey (data-panels.js) e de chave_os (domains/os_observacoes.py): série e OS normalizadas.
  const chaveMarca = (serie, os) => JSON.stringify([serialKey(serie), orderKey(os)]);

  /** Marcas agrupadas pela chave série+OS (várias marcas por OS quando há mais de um chamado), na ordem recebida. */
  function marcasPorOs(marcas) {
    const mapa = new Map();
    lista(marcas).filter(marca => marca && typeof marca === "object").forEach(marca => {
      const chave = chaveMarca(marca.serie, marca.os);
      mapa.set(chave, [...(mapa.get(chave) || []), marca]);
    });
    return mapa;
  }

  // ISO do servidor -> dd/mm/aaaa às HH:MM (mesmo recorte do aviso de divergências no sino); texto que não é ISO segue como veio.
  function formatarDataHora(iso) {
    const partes = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(texto(iso));
    return partes ? `${partes[3]}/${partes[2]}/${partes[1]} às ${partes[4]}:${partes[5]}` : texto(iso);
  }

  // ISO do servidor -> dd/mm/aaaa, só o recorte do texto (new Date mudaria o dia pelo fuso); texto que não é ISO segue como veio.
  function formatarData(iso) {
    const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto(iso));
    return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : texto(iso);
  }

  /** O que a linha da F6 mostra de uma marca: selo (só se ativa), dica, motivo, quais botões valem e o histórico em texto. */
  function descreverMarca(marca) {
    const outro = marca?.origem === "outro_tecnico";
    const ativa = Boolean(marca?.ativa);
    const aConferir = ativa && outro && !texto(marca?.conferido_em);
    return {
      ativa,
      selo: ativa ? SELOS[outro ? "outro_tecnico" : "site"] : "",
      dica: aConferir ? "Conferir no SoftExpert" : "",
      motivo: ativa && outro ? MOTIVOS_MARCA[marca?.motivo] || "" : "",
      podeDesfazer: ativa,
      podeRefazer: !ativa,
      podeConferir: aConferir,
      historico: lista(marca?.historico).map(evento => `${formatarDataHora(evento?.em)} · ${EVENTOS_MARCA[evento?.acao] || texto(evento?.acao)}`
        + ` (${ORIGENS_EVENTO[evento?.origem] || texto(evento?.origem)})`),
    };
  }

  // ----- referências em texto livre (Lembretes): UTIC-AAAA-N e número de OS viram link para a janela Chamado × OS -----
  // Chamado como no Assistente (UTIC-\d{4}-\d{1,24}); OS = exatamente 7 dígitos (31/31 no relatório do F6, 14/14 nos vínculos).
  // shortcut: OS fixa em 7 dígitos; ampliar a regex se o formato mudar.
  const REFERENCIA = /UTIC-\d{4}-\d{1,24}|\d{7}/gi;
  const PALAVRA = /[\p{L}\p{N}_-]/u;
  const ehDigito = carac => /\d/.test(carac || "");

  /** Divide o texto em trechos `{ texto }` e referências `{ tipo: "chamado"|"os", numero, texto }`; juntar os `texto` devolve o original. */
  function referenciasNoTexto(entrada) {
    const original = String(entrada ?? "");
    const partes = [];
    const juntar = trecho => {
      if (!trecho) return;
      const ultimo = partes[partes.length - 1];
      if (ultimo && !ultimo.tipo) ultimo.texto += trecho;
      else partes.push({ texto: trecho });
    };
    let cursor = 0;
    for (const achado of original.matchAll(REFERENCIA)) {
      const inicio = achado.index;
      const fim = inicio + achado[0].length;
      const chamado = /^U/i.test(achado[0]);
      // Colada a letra, dígito ou hífen não é referência (parte de outro número). Na OS, "/" também recusa (data) e "." ou ","
      // só recusam entre dígitos (valor, data); no fim de frase ("OS 1234567.") a pontuação não cola.
      const colada = (carac, alem) => PALAVRA.test(carac) || (!chamado && (carac === "/" || ((carac === "." || carac === ",") && ehDigito(alem))));
      if (colada(original[inicio - 1] || "", original[inicio - 2]) || colada(original[fim] || "", original[fim + 1])) continue;
      juntar(original.slice(cursor, inicio));
      partes.push({ tipo: chamado ? "chamado" : "os", numero: chamado ? achado[0].toUpperCase() : achado[0], texto: achado[0] });
      cursor = fim;
    }
    juntar(original.slice(cursor));
    return partes;
  }

  // Mesma prioridade do F6 (prioridadeVinculo em data-panels.js): sem origem = manual > finalizacao > dashboard.
  const prioridadeVinculo = item => (item?.origem === "dashboard" ? 2 : item?.origem === "finalizacao" ? 1 : 0);
  const chamadoDoVinculo = item => texto(item?.chamado).toUpperCase() || (item?.numero ? `UTIC-${item.ano}-${item.numero}` : "");

  /** Só os vínculos da melhor prioridade entre os que passam no filtro. */
  function melhoresVinculos(vinculos, filtro) {
    const itens = (Array.isArray(vinculos) ? vinculos : lista(vinculos?.vinculos)).filter(item => item && filtro(item));
    if (!itens.length) return [];
    const melhor = Math.min(...itens.map(prioridadeVinculo));
    return itens.filter(item => prioridadeVinculo(item) === melhor);
  }

  // null (nada), `{ [campo], serie }` (um só valor) ou `{ ambiguo: [...] }` (mais de um valor distinto; nunca escolhe).
  // Série só quando todos os itens do valor concordam; senão fica vazia e a janela liga pela OS (soEssaOs).
  function unicoOuAmbiguo(itens, campo, chave) {
    const grupos = new Map();
    itens.forEach(item => grupos.set(chave(item[campo]), [...(grupos.get(chave(item[campo])) || []), item]));
    if (!grupos.size) return null;
    if (grupos.size > 1) return { ambiguo: [...grupos.values()].map(grupo => grupo[0][campo]).sort() };
    const [grupo] = grupos.values();
    const series = new Set(grupo.map(item => serialKey(item.serie)).filter(Boolean));
    return { [campo]: grupo[0][campo], serie: series.size === 1 ? grupo.find(item => serialKey(item.serie)).serie : "" };
  }

  /**
   * Chamado ligado à OS: vínculos (manual > finalizacao > dashboard) e, sem vínculo, o F5 (abertos, sem finalizados). Casa a OS exata.
   * @param {unknown} os
   * @param {{ vinculos?: any, sebrae?: any }} [fontes]
   */
  function chamadoDaOs(os, { vinculos, sebrae } = {}) {
    const alvo = orderKey(os);
    if (!alvo) return null;
    const dosVinculos = melhoresVinculos(vinculos, item => orderKey(item.os) === alvo && chamadoDoVinculo(item))
      .map(item => ({ chamado: chamadoDoVinculo(item), serie: texto(item.serie) }));
    const itens = dosVinculos.length ? dosVinculos
      : chamadosComOs(sebrae).filter(item => orderKey(item.os) === alvo && item.numero).map(item => ({ chamado: item.numero.toUpperCase(), serie: item.serie }));
    return unicoOuAmbiguo(itens, "chamado", valor => valor);
  }

  /**
   * OS ligada ao chamado pelos vínculos (manual > finalizacao > dashboard); a OS do cartão do F5 é decidida por quem chama.
   * @param {unknown} chamado
   * @param {{ vinculos?: any }} [fontes]
   */
  function osDoChamado(chamado, { vinculos } = {}) {
    const alvo = texto(chamado).toUpperCase();
    if (!alvo) return null;
    const itens = melhoresVinculos(vinculos, item => chamadoDoVinculo(item) === alvo && texto(item.os))
      .map(item => ({ os: texto(item.os), serie: texto(item.serie) }));
    return unicoOuAmbiguo(itens, "os", orderKey);
  }

  return Object.freeze({
    montarParesChamadoOs, filtrarParesChamadoOs, chaveMarca, marcasPorOs, descreverMarca, formatarDataHora, formatarData,
    referenciasNoTexto, chamadoDaOs, osDoChamado,
  });
});
