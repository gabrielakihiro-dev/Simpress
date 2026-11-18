// Conteúdo da seção Catálogo de unidades ([data-cockpit-tool-panel="unidades"]). A <section> fica no partial
// (frontend/partials/cockpit-tool-panels.html) porque o roteador do Cockpit liga e desliga o hidden dela.
// Novo layout (NL-Catalogo, visual B): resumo em linha, busca com destaque e grade de cartões, sem tela de detalhe.
// Os botões mantêm os data-on-* do HTML antigo: o action-dispatcher chama a ação em window, que passa pela ponte.
import { useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { buscarUnidade, editarUnidade } from "./acoes";
import { assinar, filtrarUnidades, ler, nomeUnidade, normalizar, trechosBusca, type Unidade } from "./estado";

const formatarQuantidade = (valor: number) => new Intl.NumberFormat("pt-BR").format(valor);

function Icone({ href }: { href: string }) {
  return <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href={href} /></svg>;
}

// Lápis ao fim do CNPJ: abre o formulário preenchido com o foco no campo CNPJ.
function CnpjComLapis({ unidade }: { unidade: Unidade }) {
  const cnpj = unidade.cnpj ? <span className="ck-mono">{unidade.cnpj}</span> : <span className="nlc-fraco">—</span>;
  // Sem id numérico o formulário não acha a unidade: mostra só o CNPJ.
  if (unidade.id === null || unidade.id === undefined || !Number.isFinite(Number(unidade.id))) {
    return <span className="nlc-cnpj">{cnpj}</span>;
  }
  const rotulo = `Editar CNPJ da unidade ${unidade.cidade || nomeUnidade(unidade)}`;
  return (
    <span className="nlc-cnpj">
      {cnpj}
      <button className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm nlc-lapis" type="button" title={rotulo} aria-label={rotulo}
        onClick={() => editarUnidade(Number(unidade.id), "form-unidade-cnpj")}>
        <Icone href="#i-pencil" />
      </button>
    </span>
  );
}

function Cartao({ unidade, busca, atraso }: { unidade: Unidade; busca: string; atraso: number }) {
  const local = [unidade.cidade, unidade.uf].filter(Boolean).join("/") || "—";
  return (
    <li className={unidade.is_sede ? "nlc-cartao nlc-cartao--sede" : "nlc-cartao"} style={{ animationDelay: `${atraso}ms` }}>
      <div className="nlc-cartao__lin">
        <b className="nlc-cartao__nome">
          {trechosBusca(nomeUnidade(unidade), busca).map((t, i) => (t.achou ? <mark key={i}>{t.texto}</mark> : t.texto))}
        </b>
        {unidade.is_sede ? <span className="ck-badge nlc-sede" data-status="ok">SEDE</span> : null}
      </div>
      <span className="nlc-k">{local}</span>
      <CnpjComLapis unidade={unidade} />
    </li>
  );
}

function Formulario() {
  const form = useSyncExternalStore(assinar, () => ler().form);
  return (
    <div id="form-nova-unidade" className={form.aberto ? "ckp-secao nlc-form" : "hidden ckp-secao nlc-form"} key={form.revisao}>
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
  const { fase, lista, busca } = estado;
  const campoBusca = useRef<HTMLInputElement>(null);
  const visiveis = filtrarUnidades(lista, busca);
  const kpis: [string, number][] = fase === "ok" ? [
    ["Unidades", lista.length], ["Cidades", new Set(lista.map(u => normalizar(u.cidade)).filter(Boolean)).size],
    ["Com CNPJ", lista.filter(u => u.cnpj).length],
  ] : [];
  const status = fase === "ok" ? `${visiveis.length} de ${lista.length}` : fase === "erro" ? estado.erro : "Carregando…";
  const limparBusca = () => {
    buscarUnidade("");
    campoBusca.current?.focus();
  };
  // Esc com texto limpa a busca; vazio, segue para o Cockpit fechar o painel (ele ignora evento já tratado).
  const teclaBusca = (evento: KeyboardEvent<HTMLInputElement>) => {
    if (evento.key !== "Escape" || !busca) return;
    evento.preventDefault();
    buscarUnidade("");
  };

  let corpo = null;
  if (fase === "carregando" || fase === "erro") corpo = <p className="nlc-vazio">{status}</p>;
  else if (fase === "ok" && !visiveis.length) {
    corpo = (
      <p className="nlc-vazio">
        <Icone href="#i-search" />
        <span>{lista.length ? "Nenhuma unidade corresponde à busca." : "O catálogo não contém unidades."}</span>
      </p>
    );
  } else if (fase === "ok") {
    corpo = (
      <ul className="nlc-grade" aria-label="Unidades">
        {visiveis.map(({ unidade, chave }, i) => <Cartao key={chave} unidade={unidade} busca={busca} atraso={Math.min(i, 8) * 30} />)}
      </ul>
    );
  }

  return (
    <div className="nlc">
      <h2 id="cockpit-units-heading" className="sr-only">Catálogo de unidades</h2>
      <div className="nlc-resumo">
        <div id="cockpit-units-kpis" className="nlc-resumo__nums" role="group" aria-label="Resumo do catálogo">
          {kpis.map(([rotulo, valor]) => (
            <div className="ck-kpi nlc-kpi" key={rotulo}><strong className="ck-kpi__valor">{formatarQuantidade(valor)}</strong><span className="ck-kpi__rotulo">{rotulo}</span></div>
          ))}
        </div>
        <button type="button" id="cockpit-units-new" className="ck-btn ck-btn--primario ck-btn--sm" data-on-click="toggleFormNovaUnidade" data-args="[true]"><Icone href="#i-plus" />Nova unidade</button>
      </div>
      <div className="nlc-barra">
        <div className={busca ? "nlc-busca nlc-busca--cheia" : "nlc-busca"}>
          <Icone href="#i-search" />
          <input ref={campoBusca} className="nlc-busca__inp" id="cockpit-units-search" type="search" autoComplete="off" aria-label="Buscar unidade"
            placeholder="Nome, cidade ou CNPJ" value={busca} onChange={evento => buscarUnidade(evento.currentTarget.value)} onKeyDown={teclaBusca} />
          {busca ? (
            <button type="button" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm nlc-busca__x" aria-label="Limpar busca" title="Limpar busca" onClick={limparBusca}>
              <Icone href="#i-x" />
            </button>
          ) : null}
        </div>
        <span id="cockpit-units-status" className={busca ? "nlc-status nlc-status--filtro" : "nlc-status"} role="status" aria-live="polite">{status}</span>
      </div>
      <div id="cockpit-units-list" className="nlc-lista">
        <div id="cockpit-units-list-body">{corpo}</div>
      </div>
      <Formulario />
    </div>
  );
}
