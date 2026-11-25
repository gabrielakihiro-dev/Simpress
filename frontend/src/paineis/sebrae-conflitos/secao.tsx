// Conflitos de edição do Dashboard (Chamados, F5), layout C do canvas aprovado (24/11/2026): lista de conflitos e, ao lado
// (uma coluna abaixo de 1200px), o resumo do que vai para o SharePoint. Mesmos IDs, ARIA e textos da seção antiga em JS puro
// (antigo frontend/src/legado/features/sebrae-conflitos.js até a migração do G1); o React desenha só os filhos da seção.
import { useSyncExternalStore } from "react";
import {
  AVISO_SO_SHAREPOINT, OPCOES, aceitaSite, assinar, consequencia, escolher, escolhasParaEnviar, faltam, ler, rotuloCurto,
  salvarEReenviar, textoDoConflito, valorDaOpcao,
} from "./estado";

export function SecaoConflitos() {
  const atual = useSyncExternalStore(assinar, ler);
  const { conflitos, escolhas, ocupado, status } = atual;
  const validas = escolhasParaEnviar(conflitos, escolhas);
  const desligado = ocupado || !conflitos.length || faltam(atual) > 0;

  return (
    <>
      <div className="sebrae-conflitos__cabecalho">
        <div className="ck-rotulo-info">
          <svg className="ck-ico sebrae-conflitos__icone" aria-hidden="true" focusable="false"><use href="#i-alerta"></use></svg>
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
      </div>
      <div className="sebrae-conflitos__corpo">
        <div id="sebrae-conflitos-lista" className="sebrae-conflitos__lista">
          {conflitos.map((conflito, indice) => (
            <fieldset key={conflito.id} className="sebrae-conflito" role="group" data-conflito-id={conflito.id}>
              <legend className="sebrae-conflito__texto">{textoDoConflito(conflito)}</legend>
              <dl className="sebrae-conflito__dados">
                <dt>Título</dt>
                <dd>{conflito.titulo || "—"}</dd>
                <dt>Solicitante</dt>
                <dd>{conflito.solicitante || "—"}</dd>
              </dl>
              <div className="sebrae-conflito__opcoes">
                {OPCOES.filter(opcao => opcao.valor !== "site" || aceitaSite(conflito)).map(opcao => {
                  const id = `sebrae-conflito-${indice}-${opcao.valor}`;
                  const valor = valorDaOpcao(conflito, opcao.valor);
                  const marcada = escolhas[conflito.id] === opcao.valor;
                  return (
                    // O valor fica fora do <label>: o nome do rádio é só o rótulo; o ::after do label cobre a caixa inteira.
                    <div key={opcao.valor} className={`sebrae-conflito__opcao${marcada ? " sebrae-conflito__opcao--escolhida" : ""}`}>
                      <label htmlFor={id}>
                        <input
                          type="radio"
                          name={`sebrae-conflito-${indice}`}
                          id={id}
                          value={opcao.valor}
                          checked={marcada}
                          aria-describedby={valor ? `${id}-valor` : undefined}
                          onChange={() => escolher(conflito.id, opcao.valor)}
                        />
                        {` ${opcao.rotulo}`}
                      </label>
                      {valor && <span id={`${id}-valor`} className="sebrae-conflito__valor">{valor}</span>}
                    </div>
                  );
                })}
              </div>
              {!aceitaSite(conflito) && <p className="sebrae-conflito__aviso">{AVISO_SO_SHAREPOINT}</p>}
            </fieldset>
          ))}
        </div>
        <aside className="sebrae-conflitos__resumo" aria-labelledby="sebrae-conflitos-resumo-titulo">
          <strong id="sebrae-conflitos-resumo-titulo" className="sebrae-conflitos__resumo-titulo">O que vai para o SharePoint</strong>
          <ul id="sebrae-conflitos-resumo" className="sebrae-conflitos__consequencias">
            {conflitos.map(conflito => (
              <li key={conflito.id} data-escolhido={validas[conflito.id] ? "sim" : "nao"}>
                <span className="sebrae-conflitos__chamado">{rotuloCurto(conflito)}</span>: {consequencia(conflito, validas[conflito.id])}.
              </li>
            ))}
          </ul>
          <p className="sebrae-conflitos__arquivo">
            Arquivo: <strong>Dashboard Operacional_SEBRAE.xlsx</strong>. Antes de substituir, o site cria a cópia de backup (Copy). O resto do arquivo não muda.
          </p>
          <div className="sebrae-conflitos__acoes">
            <button type="button" id="btn-sebrae-conflitos-enviar" className="ck-btn ck-btn--primario" disabled={desligado} onClick={() => { void salvarEReenviar(); }}>
              Salvar escolhas e reenviar
            </button>
            <p id="sebrae-conflitos-status" className="ck-cartao__meta" role="status" aria-live="polite">{status}</p>
          </div>
        </aside>
      </div>
    </>
  );
}
