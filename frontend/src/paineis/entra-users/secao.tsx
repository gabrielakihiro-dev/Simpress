import { useSyncExternalStore } from "react";
import { assinar, exportarNomesEntra, importarNomesEntra, ler } from "./estado";

// Mesmo HTML da seção antiga (IDs, classes e ARIA). O seletor de arquivo (label.ckp-arquivo) continua com
// static/js/ui/file-picker.js, que troca nome, meta e data-estado direto no DOM: aqui eles ficam fixos.
export function SecaoEntra() {
  const { status, exportar, ocupado } = useSyncExternalStore(assinar, ler);
  return (
    <>
      <div className="ckp-secao__cab"><span className="ckp-arquivo__ico" data-ckp="icone-22"><svg className="ck-ico ck-ico--xs" aria-hidden="true"><use href="#i-users"></use></svg></span><div className="ckp-secao__textos"><h3 className="ckp-secao__titulo"><span id="entra-import-title">Nomes do Microsoft Entra <span className="ckp-opcional">· opcional</span></span>{" "}<span className="info-tip"><button type="button" className="info-tip-trigger" aria-label="Sobre Nomes do Microsoft Entra" aria-describedby="tip-entra-nomes"><svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info"></use></svg></button><span id="tip-entra-nomes" role="tooltip" className="info-tip-text">CSV exportado do Entra. Somente contas @pr.sebrae.com.br são usadas; os inventários acima não são alterados.</span></span></h3></div></div>
      <form className="ckp-secao__corpo" onSubmit={importarNomesEntra}>
        <label className="ckp-arquivo" data-estado="vazio">
          <input id="entra-csv-file" type="file" accept=".csv,text/csv" />
          <span className="ckp-arquivo__ico"><svg className="ck-ico ck-ico--vazio" aria-hidden="true"><use href="#i-upload"></use></svg><svg className="ck-ico ck-ico--cheio" aria-hidden="true"><use href="#i-file-check"></use></svg></span>
          <span className="ckp-arquivo__textos"><span className="ckp-arquivo__nome" id="entra-csv-name" data-vazio="Escolher CSV ou arrastar aqui">Escolher CSV ou arrastar aqui</span><span className="ckp-arquivo__meta" data-vazio=".csv do Microsoft Entra">.csv do Microsoft Entra</span></span>
          <span className="ckp-arquivo__acoes"><button type="button" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" data-remover="" aria-label="Remover arquivo"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-x"></use></svg></button><span className="ck-btn ck-btn--secundario ck-btn--sm ckp-arquivo__trocar">Escolher</span></span>
        </label>
        <p id="entra-import-status" className="ckp-secao__desc" role="status" aria-live="polite">{status}</p>
        <div className="ckp-linha ckp-linha--fim">
          <button type="button" id="btn-exportar-nomes-entra" className="ck-btn ck-btn--fantasma ck-btn--sm" onClick={exportarNomesEntra} disabled={!exportar}><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-download"></use></svg>Baixar XLSX compacto</button>
          <button type="submit" id="btn-importar-nomes-entra" className="ck-btn ck-btn--secundario ck-btn--sm" disabled={ocupado} aria-busy={ocupado || undefined}>Importar nomes</button>
        </div>
      </form>
    </>
  );
}
