// Painel "Chamados × OS", sem DOM nem rede: junta os chamados em aberto do F5 (GET /api/sebrae/novos) que têm OS
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
    lista(relatorio?.chamados).forEach(registro => {
      const chave = serialKey(registro?.serie);
      if (chave && !registros.has(chave)) registros.set(chave, registro);
    });
    const itensVinculo = Array.isArray(vinculos) ? vinculos : lista(vinculos?.vinculos);
    return chamadosComOs(sebrae).map(chamado => {
      const alvo = orderKey(chamado.os);
      const chaveSerie = serialKey(chamado.serie);
      // MacBook: a outra grafia (com/sem `S` inicial) só quando a série exata não existe no relatório.
      const doSerie = registros.get(chaveSerie)
        || (chaveSerie && registros.get(chaveSerie.startsWith("S") ? chaveSerie.slice(1) : `S${chaveSerie}`)) || null;
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

  return Object.freeze({ montarParesChamadoOs, filtrarParesChamadoOs });
});
