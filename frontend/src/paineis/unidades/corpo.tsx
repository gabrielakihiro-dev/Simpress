// Conteúdo da seção Catálogo de unidades ([data-cockpit-tool-panel="unidades"]). A <section> fica no partial
// (frontend/partials/cockpit-tool-panels.html) porque o roteador do Cockpit liga e desliga o hidden dela.
// Os botões mantêm os data-on-* do HTML antigo: o action-dispatcher chama a ação em window, que passa pela ponte.
import { useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { buscarUnidade, copiarDadoUnidade, editarUnidade, selecionarUnidade, unidadeSelecionada } from "./acoes";
import { assinar, filtrarUnidades, ler, nomeUnidade, normalizar, type Unidade } from "./estado";

const formatarQuantidade = (valor: number) => new Intl.NumberFormat("pt-BR").format(valor);

function Icone({ href }: { href: string }) {
  return <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href={href} /></svg>;
}

function Sede() {
  return <span className="ck-badge" data-status="ok">SEDE</span>;
}

// Lápis ao fim do CNPJ: abre o formulário preenchido com o foco no campo CNPJ.
function CnpjComLapis({ unidade }: { unidade: Unidade }) {
  // Sem id numérico o formulário não acha a unidade: mostra só o CNPJ.
  if (unidade.id === null || unidade.id === undefined || !Number.isFinite(Number(unidade.id))) {
    return <span className="ck-det__linha"><span>{unidade.cnpj || "—"}</span></span>;
  }
  const rotulo = `Editar CNPJ da unidade ${unidade.cidade || nomeUnidade(unidade)}`;
  return (
    <span className="ck-det__linha">
      <span>{unidade.cnpj || "—"}</span>
      <button className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm" type="button" title={rotulo} aria-label={rotulo}
        onClick={() => editarUnidade(Number(unidade.id), "form-unidade-cnpj")}>
        <Icone href="#i-pencil" /><span className="ck-sr">{rotulo}</span>
      </button>
    </span>
  );
}

function LinhaVazia({ texto }: { texto: string }) {
  return <tr><td className="ck-lista__vazio" colSpan={3}>{texto}</td></tr>;
}

// Linha selecionável por clique, Enter ou Espaço; botões dentro dela (o lápis) tratam o teclado sozinhos.
function Linha({ unidade, chave, selecionada }: { unidade: Unidade; chave: string; selecionada: boolean }) {
  const teclado = (evento: KeyboardEvent<HTMLTableRowElement>) => {
    if (evento.target !== evento.currentTarget || (evento.key !== "Enter" && evento.key !== " ")) return;
    evento.preventDefault();
    selecionarUnidade(chave);
  };
  return (
    <tr tabIndex={0} aria-selected={selecionada} onClick={() => selecionarUnidade(chave)} onKeyDown={teclado}>
      <td data-label="Unidade"><span className="ck-det__linha">{nomeUnidade(unidade)}{unidade.is_sede ? <Sede /> : null}</span></td>
      <td data-label="Cidade">{unidade.cidade || "—"}</td>
      <td data-label="CNPJ"><CnpjComLapis unidade={unidade} /></td>
    </tr>
  );
}

// A ordem dos pares (e das colunas da lista) é usada pelo CSS do painel (nth-child em ck-cockpit.css): mude os dois juntos.
function Pares({ unidade }: { unidade?: Unidade }) {
  const pares: [string, ReactNode][] = unidade ? [
    ["Cidade", unidade.cidade], ["UF", unidade.uf], ["Endereço", unidade.endereco], ["CEP", unidade.cep],
    ["CNPJ", <CnpjComLapis unidade={unidade} />],
  ] : [];
  return (
    <dl className="ck-pares ck-det__corpo" id="cockpit-units-detail-pares">
      {pares.map(([rotulo, valor]) => (
        <div className="ck-par" key={rotulo}><dt>{rotulo}</dt><dd>{valor === null || valor === undefined || valor === "" ? "—" : valor}</dd></div>
      ))}
    </dl>
  );
}

function Formulario() {
  const form = useSyncExternalStore(assinar, () => ler().form);
  return (
    <div id="form-nova-unidade" className={form.aberto ? "ckp-secao" : "hidden ckp-secao"} key={form.revisao}>
      <h3 className="ckp-secao__titulo" id="form-unidade-titulo">{form.titulo}</h3>
      <input type="hidden" id="form-unidade-id" defaultValue={form.id} />
      <div className="ckp-form">
        <label className="ck-campo"><span className="ck-campo__rotulo">Cidade</span><input type="text" id="form-unidade-cidade" className="ck-entrada" placeholder="Ex: Paranaguá" defaultValue={form.cidade} /></label>
        <label className="ck-campo"><span className="ck-campo__rotulo">CEP</span><input type="text" id="form-unidade-cep" className="ck-entrada ck-mono" placeholder="83203-000" defaultValue={form.cep} /></label>
        <label className="ck-campo"><span className="ck-campo__rotulo">CNPJ</span><input type="text" id="form-unidade-cnpj" className="ck-entrada ck-mono" placeholder="CNPJ da instalação / filial" defaultValue={form.cnpj} /></label>
        <label className="ck-campo ckp-span"><span className="ck-campo__rotulo">Endereço</span><input type="text" id="form-unidade-endereco" className="ck-entrada" placeholder="Ex: Rua Princesa Isabel, 100" defaultValue={form.endereco} /></label>
        <div className="ckp-linha ckp-linha--fim ckp-span">
          <button type="button" data-on-click="toggleFormNovaUnidade" data-args="[false]" className="ck-btn ck-btn--fantasma">Cancelar</button>
          <button type="button" id="btn-salvar-unidade" data-on-click="salvarUnidadeForm" className="ck-btn ck-btn--primario"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-check" /></svg>Salvar</button>
        </div>
      </div>
    </div>
  );
}

export function CorpoUnidades() {
  const estado = useSyncExternalStore(assinar, ler);
  const { fase, lista, busca, selecionada } = estado;
  const visiveis = filtrarUnidades(lista, busca);
  const detalhe = unidadeSelecionada();
  const kpis: [string, number][] = fase === "ok" ? [
    ["Unidades", lista.length], ["Cidades", new Set(lista.map(u => normalizar(u.cidade)).filter(Boolean)).size],
    ["Com CNPJ", lista.filter(u => u.cnpj).length],
  ] : [];
  const status = fase === "ok" ? `${visiveis.length} de ${lista.length} ${lista.length === 1 ? "unidade" : "unidades"}`
    : fase === "erro" ? estado.erro : "Carregando…";
  let corpoTabela: ReactNode = null;
  if (fase === "carregando" || fase === "erro") corpoTabela = <LinhaVazia texto={status} />;
  else if (fase === "ok" && !visiveis.length) corpoTabela = <LinhaVazia texto={lista.length ? "Nenhuma unidade corresponde à busca." : "O catálogo não contém unidades."} />;
  else if (fase === "ok") corpoTabela = visiveis.map(({ unidade, chave }) => <Linha key={chave} unidade={unidade} chave={chave} selecionada={chave === selecionada} />);

  return (
    <>
      <h2 id="cockpit-units-heading" className="sr-only">Catálogo de unidades</h2>
      <div id="cockpit-units-kpis" className="ck-kpis" role="group" aria-label="Resumo do catálogo">
        {kpis.map(([rotulo, valor]) => (
          <div className="ck-kpi" key={rotulo}><span className="ck-kpi__rotulo">{rotulo}</span><strong className="ck-kpi__valor">{formatarQuantidade(valor)}</strong></div>
        ))}
      </div>
      <div className="ck-barra-ferr">
        <label className="ck-campo"><span className="ck-campo__rotulo">Buscar unidade</span><input className="ck-entrada ck-entrada--sm" id="cockpit-units-search" type="search" autoComplete="off" placeholder="Nome, cidade ou CNPJ" value={busca} onChange={evento => buscarUnidade(evento.currentTarget.value)} /></label>
        <span id="cockpit-units-status" className="ck-barra-ferr__nota" role="status" aria-live="polite">{status}</span>
        <span className="ck-espaco"></span>
        <button type="button" id="cockpit-units-new" className="ck-btn ck-btn--secundario ck-btn--sm" data-on-click="toggleFormNovaUnidade" data-args="[true]"><Icone href="#i-plus" />Nova unidade</button>
      </div>
      <Formulario />
      <div className="ck-dividido">
        <div className="ck-dividido__lista">
          <table className="ck-tabela ck-tabela--cards" id="cockpit-units-list">
            <thead><tr><th scope="col">Unidade</th><th scope="col">Cidade</th><th scope="col">CNPJ</th></tr></thead>
            <tbody id="cockpit-units-list-body">{corpoTabela}</tbody>
          </table>
        </div>
        <aside className="ck-dividido__detalhe" id="cockpit-units-detail" aria-label="Detalhes da unidade selecionada">
          <div className="ck-det__cab">
            <div className="ck-det__linha"><span className="ck-det__titulo" id="cockpit-units-detail-title">{detalhe ? nomeUnidade(detalhe) : "—"}</span><span id="cockpit-units-detail-badge">{detalhe?.is_sede ? <Sede /> : null}</span></div>
            <span className="ck-det__sub" id="cockpit-units-detail-sub">{detalhe ? ([detalhe.cidade, detalhe.uf].filter(Boolean).join("/") || "Cidade não informada") : "Selecione uma unidade."}</span>
          </div>
          <Pares unidade={detalhe} />
          <div className="ck-det__rodape">
            <button type="button" id="cockpit-units-copy-cnpj" className="ck-btn ck-btn--secundario ck-btn--sm" disabled={!detalhe} onClick={() => copiarDadoUnidade(unidadeSelecionada()?.cnpj, "CNPJ")}>Copiar CNPJ</button>
            <button type="button" id="cockpit-units-copy-cep" className="ck-btn ck-btn--secundario ck-btn--sm" disabled={!detalhe} onClick={() => copiarDadoUnidade(unidadeSelecionada()?.cep, "CEP")}>Copiar CEP</button>
          </div>
        </aside>
      </div>
    </>
  );
}
