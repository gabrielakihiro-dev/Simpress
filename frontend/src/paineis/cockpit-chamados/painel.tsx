import { memo, useRef, useSyncExternalStore, type FormEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  rotuloChamadosSebrae, rotuloContagemHome, rotuloImportacao, statusDoChamado, textoChamadoSebrae,
  type ChamadoSebrae,
} from "./cockpit-chamados-puro";
import {
  abrirChamadoNoF5, abrirOsEmChamados, assinar, excluirImportacoesAntigasChamadosCockpit, formatarHorario, importarPlanilhas,
  ler, selecionarVersaoChamadosCockpit, verNaAbaChamados, type AbertoHome, type Home,
} from "./estado";

export interface Alvos {
  /** Meta do resumo "Importação e versões" (fora do container). */
  versao: HTMLElement;
  /** Contagem e corpo da lista de chamados abertos do cartão da Home (fora do container). */
  contagemHome: HTMLElement;
  corpoHome: HTMLElement;
}

const Icone = ({ nome, classe = "ck-ico ck-ico--sm" }: { nome: string; classe?: string }) => (
  <svg className={classe} aria-hidden="true"><use href={`#${nome}`} /></svg>
);

function InfoTip({ rotulo, idDica, children }: { rotulo: string; idDica: string; children: string }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-trigger" aria-label={rotulo} aria-describedby={idDica}>
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg>
      </button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}

interface CampoArquivoProps {
  entrada: RefObject<HTMLInputElement | null>;
  idEntrada: string;
  idNome: string;
  nome: string;
  aceita: string;
  descritoPor?: string;
  textoVazio: string;
}

// Só props primitivas e estáticas: o file-picker.ts troca estado, nome, tamanho e "Escolher/Trocar" direto no DOM,
// e este componente nunca é redesenhado, então o React não desfaz o que ele fez.
const CampoArquivo = memo(function CampoArquivo({ entrada, idEntrada, idNome, nome, aceita, descritoPor, textoVazio }: CampoArquivoProps) {
  return (
    <label className="ckp-arquivo" data-estado="vazio">
      <input id={idEntrada} name={nome} type="file" accept={aceita} aria-describedby={descritoPor} data-obrigatorio="" ref={entrada} />
      <span className="ckp-arquivo__ico"><Icone nome="i-upload" classe="ck-ico ck-ico--vazio" /><Icone nome="i-file-check" classe="ck-ico ck-ico--cheio" /></span>
      <span className="ckp-arquivo__textos">
        <span className="ckp-arquivo__nome" id={idNome} data-vazio="Escolher arquivo">Escolher arquivo</span>
        <span className="ckp-arquivo__meta" data-vazio={textoVazio}>{textoVazio}</span>
      </span>
      <span className="ckp-arquivo__acoes">
        <button type="button" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" data-remover="" aria-label="Remover arquivo"><Icone nome="i-x" /></button>
        <span className="ck-btn ck-btn--secundario ck-btn--sm ckp-arquivo__trocar">Escolher</span>
      </span>
    </label>
  );
});

function ChamadoAberto({ ticket, serie }: { ticket: AbertoHome; serie: string }) {
  const ordem = ticket.ordem_servico;
  return (
    <li className="ck-aberto">
      {ordem
        ? (
          <button type="button" className="ck-aberto__numero ck-aberto__link" aria-label={`Abrir a OS ${ordem} da série ${serie} em Chamados`} onClick={() => abrirOsEmChamados(serie, ordem)}>
            {String(ordem)}
          </button>
        )
        : <strong className="ck-aberto__numero">Sem OS</strong>}
      <span className="ck-badge">{statusDoChamado(ticket)}</span>
      <p className="ck-aberto__titulo">{ticket.fila || "Fila não informada"}</p>
      <p className="ck-aberto__meta">{ticket.nome_filial || ticket.cidade || "Unidade não informada"}</p>
      <p className="ck-aberto__meta">{ticket.idade}</p>
    </li>
  );
}

function ChamadosSebrae({ chamados }: { chamados: ChamadoSebrae[] }) {
  return (
    <div className="ck-abertos__sebrae">
      <p className="ck-abertos__rotulo">{rotuloChamadosSebrae(chamados.length)}</p>
      {chamados.map((item, indice) => {
        const texto = textoChamadoSebrae(item);
        return (
          <button key={`${item.chave}-${indice}`} type="button" className="ck-aberto__meta ck-aberto__link" aria-label={`Abrir na aba Chamados (F5): ${texto}`} onClick={() => { void abrirChamadoNoF5(item.chave); }}>
            {texto}
          </button>
        );
      })}
      <button type="button" className="ck-abertos__ver" onClick={() => verNaAbaChamados()}>Ver na aba Chamados (F5)</button>
    </div>
  );
}

function CorpoHome({ home }: { home: Home }) {
  if (home.tipo === "inicial") return null;
  if (home.tipo === "carregando") return <p className="ck-abertos__vazio">Carregando chamados…</p>;
  if (home.tipo === "erro") return <p className="ck-abertos__vazio" role="alert">{home.mensagem}</p>;
  const { abertos, sebrae, serie, falhaSebrae } = home;
  if (!abertos.length && !sebrae.length && !falhaSebrae) return <p className="ck-abertos__vazio">Nenhum chamado aberto para esta série.</p>;
  return (
    <>
      {abertos.length > 0 && (
        <ul className="ck-abertos">
          {abertos.map((ticket, indice) => <ChamadoAberto key={`${ticket.ordem_servico ?? ""}-${indice}`} ticket={ticket} serie={serie} />)}
        </ul>
      )}
      {sebrae.length > 0 && <ChamadosSebrae chamados={sebrae} />}
      {falhaSebrae && <p className="ck-abertos__vazio" role="alert">Não foi possível consultar os chamados do Sebrae. Os resultados do Oracle foram preservados.</p>}
    </>
  );
}

const contagemHome = (home: Home) => (home.tipo === "lista" ? rotuloContagemHome(home.abertos.length + home.sebrae.length, home.falhaSebrae) : "");

// Corpo de "Importação e versões" (Cockpit, Chamados) e, por portais, os três elementos de fora do container que o
// módulo antigo escrevia: meta do resumo e contagem + lista de chamados abertos da Home.
export function PainelChamados({ alvos }: { alvos: Alvos }) {
  const estado = useSyncExternalStore(assinar, ler);
  const entradaSimpress = useRef<HTMLInputElement>(null);
  const entradaOracle = useRef<HTMLInputElement>(null);
  const { historico, versao, importando, excluindo } = estado;

  const limparCampos = () => {
    for (const entrada of [entradaSimpress.current, entradaOracle.current]) {
      if (!entrada) continue;
      entrada.value = "";
      entrada.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  const aoEnviar = (evento: FormEvent<HTMLFormElement>) => {
    evento.preventDefault();
    void importarPlanilhas(entradaSimpress.current?.files?.[0], entradaOracle.current?.files?.[0], limparCampos);
  };

  return (
    <>
      <nav className="ckp-sistemas" aria-label="Abrir sistemas">
        <a className="ckp-sistema" href="https://simpress.custhelp.com/AgentWeb/" target="_blank" rel="noopener noreferrer" aria-label="Abrir portal Oracle AgentWeb"><Icone nome="i-external" classe="ck-ico ck-ico--xs" />Oracle</a>
        <a className="ckp-sistema" href="https://ux.simpress.com.br/equipamentos/acompanhamento" target="_blank" rel="noopener noreferrer" aria-label="Abrir acompanhamento de chamados Simpress"><Icone nome="i-external" classe="ck-ico ck-ico--xs" />Simpress</a>
      </nav>
      <form id="cockpit-tickets-form" className="ckp-importar" aria-busy={importando ? "true" : undefined} onSubmit={aoEnviar}>
        <div className="ckp-campo">
          <span className="ckp-rotulo">Simpress · Acompanhamento de Pedidos{" "}
            <InfoTip rotulo="Sobre arquivos de chamados" idDica="cockpit-tickets-files-tip">Cada arquivo pode ter até 60 MB. Simpress aceita .xlsx ou ZIP com uma única planilha .xlsx.</InfoTip>
          </span>
          <CampoArquivo
            entrada={entradaSimpress} idEntrada="cockpit-tickets-file-simpress" idNome="cockpit-tickets-file-simpress-name" nome="simpress_file"
            aceita=".xlsx,.zip,application/zip,application/x-zip-compressed,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            descritoPor="cockpit-tickets-files-tip" textoVazio=".xlsx ou ZIP com uma planilha"
          />
        </div>
        <div className="ckp-campo">
          <span className="ckp-rotulo">Oracle · Gestão de Solicitações</span>
          <CampoArquivo
            entrada={entradaOracle} idEntrada="cockpit-tickets-file-oracle" idNome="cockpit-tickets-file-oracle-name" nome="oracle_file"
            aceita=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" textoVazio=".xlsx"
          />
        </div>
        <button id="cockpit-tickets-import" type="submit" className="ck-btn ck-btn--primario" disabled={importando}>
          {importando ? "Importando…" : <><Icone nome="i-upload" />Importar planilhas</>}
        </button>
        <p id="cockpit-tickets-import-status" className="ckp-secao__desc ckp-importar__status" role="status" aria-live="polite">{estado.statusImportacao}</p>
      </form>
      <p id="cockpit-tickets-sources" className="ckp-secao__desc">{estado.fontes}</p>
      <div className="ckp-versao">
        <div className="ckp-campo">
          <span className="ckp-rotulo"><label htmlFor="cockpit-tickets-version">Versão em uso</label>{" "}
            <InfoTip rotulo="Sobre a versão" idDica="cockpit-tickets-version-hint">A versão escolhida vale para Exportar Excel. A tabela mostra sempre a importação mais recente.</InfoTip>
          </span>
          <select id="cockpit-tickets-version" className="ck-entrada" aria-describedby="cockpit-tickets-version-hint" value={versao} disabled={historico.length === 0} onChange={evento => selecionarVersaoChamadosCockpit(evento.target.value)}>
            <option value="">Nenhuma importação</option>
            {historico.map((evento, indice) => <option key={`${evento.id || ""}-${indice}`} value={evento.id || ""}>{rotuloImportacao(evento, formatarHorario)}</option>)}
          </select>
        </div>
        <button type="button" id="cockpit-tickets-delete-old" className="ck-btn ck-btn--perigo" disabled={excluindo || historico.length <= 1} onClick={() => { void excluirImportacoesAntigasChamadosCockpit(); }}>
          {excluindo ? "Excluindo…" : <><Icone nome="i-trash" />Excluir importações antigas</>}
        </button>
      </div>
      {createPortal(estado.textoGestao, alvos.versao)}
      {createPortal(contagemHome(estado.home), alvos.contagemHome)}
      {createPortal(<CorpoHome home={estado.home} />, alvos.corpoHome)}
    </>
  );
}
