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
    return iguais.some(item => !item?.origem) ? "manual" : "dashboard";
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

  return Object.freeze({ montarParesChamadoOs, filtrarParesChamadoOs, chaveMarca, marcasPorOs, descreverMarca, formatarDataHora });
});
