import { useSyncExternalStore } from "react";
import { assinar, exportarNomesEntra, ler } from "./estado";

// Mesmo HTML do corpo da seção antiga (IDs, classes e ARIA), desenhado dentro do <form> de frontend/partials/modais.html,
// que guarda também o cabeçalho. O seletor de arquivo (label.ckp-arquivo) continua com frontend/src/legado/ui/file-picker.js, que troca nome, meta e data-estado direto no DOM: aqui eles ficam fixos.
export function SecaoEntra() {
  const { status, exportar, ocupado } = useSyncExternalStore(assinar, ler);
  return (
    <>
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
    </>
  );
}
