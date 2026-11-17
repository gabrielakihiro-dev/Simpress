// Conflitos de edição do Dashboard (Chamados, F5). Mesmos IDs, ARIA, classes e textos da seção antiga em JS
// puro (frontend/src/legado/features/sebrae-conflitos.js até a migração do G1); o React desenha só os filhos da seção.
import { useSyncExternalStore } from "react";
import { AVISO_SO_SHAREPOINT, OPCOES, aceitaSite, assinar, escolher, faltam, ler, salvarEReenviar, textoDoConflito } from "./estado";

export function SecaoConflitos() {
  const atual = useSyncExternalStore(assinar, ler);
  const { conflitos, escolhas, ocupado, status } = atual;
  const desligado = ocupado || !conflitos.length || faltam(atual) > 0;

  return (
    <>
      <div className="ck-rotulo-info">
        <strong id="sebrae-conflitos-titulo" className="sebrae-conflitos__titulo">Conflitos de edição no Dashboard</strong>
        <span className="info-tip">
          <button type="button" className="info-tip-trigger" aria-label="Sobre os conflitos de edição" aria-describedby="sebrae-conflitos-dica">
            <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info"></use></svg>
          </button>
          <span id="sebrae-conflitos-dica" role="tooltip" className="info-tip-text">
            Estas células mudaram no SharePoint e também no site. Escolha qual valor manter em cada uma e reenvie.
          </span>
        </span>
      </div>
      <p className="ck-campo__ajuda">Nada foi enviado.</p>
      <div id="sebrae-conflitos-lista" className="sebrae-conflitos__lista">
        {conflitos.map((conflito, indice) => (
          <fieldset key={conflito.id} className="sebrae-conflito" role="group" data-conflito-id={conflito.id}>
            <legend className="sebrae-conflito__texto">{textoDoConflito(conflito)}</legend>
            <div className="sebrae-conflito__opcoes">
              {OPCOES.filter(opcao => opcao.valor !== "site" || aceitaSite(conflito)).map(opcao => (
                <label key={opcao.valor} className="sebrae-conflito__opcao">
                  <input
                    type="radio"
                    name={`sebrae-conflito-${indice}`}
                    id={`sebrae-conflito-${indice}-${opcao.valor}`}
                    value={opcao.valor}
                    checked={escolhas[conflito.id] === opcao.valor}
                    onChange={() => escolher(conflito.id, opcao.valor)}
                  />
                  {` ${opcao.rotulo}`}
                </label>
              ))}
            </div>
            {!aceitaSite(conflito) && <p className="sebrae-conflito__aviso">{AVISO_SO_SHAREPOINT}</p>}
          </fieldset>
        ))}
      </div>
      <div className="sebrae-conflitos__acoes">
        <button type="button" id="btn-sebrae-conflitos-enviar" className="ck-btn ck-btn--primario" disabled={desligado} onClick={() => { void salvarEReenviar(); }}>
          Salvar escolhas e reenviar
        </button>
        <p id="sebrae-conflitos-status" className="ck-cartao__meta" role="status" aria-live="polite">{status}</p>
      </div>
    </>
  );
}
