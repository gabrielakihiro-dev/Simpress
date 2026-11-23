// Painel Lembretes e Termos (F-ferramentas): abas Termo Entrega, Termo Devolução e Lembretes, com o mesmo DOM do painel
// antigo (ids, classes, ARIA, info-tips e textos aprovados). O estado fica em estado.ts, fora do componente, porque a
// Home preenche o termo a partir da busca de série mesmo com este painel fechado ou ainda não desenhado.
import { memo, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { IconeCalendario, IconeSprite } from "./componentes";
import { DialogoCriar, DialogoExcluir } from "./dialogos";
import { assinar, ler, type AbaPainel, type Estado } from "./estado";
import { FolhaImpressao } from "./folha";
import { adicionar, alternarPainelData, aoDigitar, atalhoData, teclaPainelData } from "./lembretes-acoes";
import { BotaoRemoverData, CampoDataHora, Concluidos, Grupos, Semana, Vistas } from "./lembretes-lista";
import { dataValida, derivarLista, hojeEm, LIMITE, proximaSegunda, rotuloAgenda, somarDias, tamanho } from "./lembretes-puro";
import { selecionarAba, teclaAba } from "./termos-acoes";
import { FormularioTermo } from "./termos-forms";
import type { NomeTermo } from "./termos-puro";

const ROTULOS_TERMO: Record<NomeTermo, string> = { entrega: "Termo Entrega", devolucao: "Termo Devolução" };

const Aba = memo(function Aba({ nome, ativa, children }: { nome: AbaPainel; ativa: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className="ck-pilula"
      role="tab"
      id={`termos-aba-${nome}`}
      aria-selected={ativa}
      tabIndex={ativa ? 0 : -1}
      aria-controls={`termos-painel-${nome}`}
      onClick={() => selecionarAba(nome)}
    >
      {children}
    </button>
  );
});

function Atalho({ id, rotulo, nome, ativo }: { id: string; rotulo: string; nome: string; ativo: boolean }) {
  return (
    <button type="button" className="lembretes__atalho" id={id} aria-pressed={ativo} onClick={() => atalhoData(nome)}>{rotulo}</button>
  );
}

// Formulário "Novo lembrete": descrição, botão de data (abre o painel de agenda), Adicionar e o erro de tamanho.
function FormNovo({ estado, hoje }: { estado: Estado; hoje: string }) {
  const { novo } = estado;
  const n = tamanho(novo.descricao.trim());
  const ativa = dataValida(novo.data);
  return (
    <form
      className="lembretes__novo"
      id="lembretes-form-novo"
      autoComplete="off"
      noValidate
      onSubmit={(e) => { e.preventDefault(); void adicionar(); }}
    >
      <label className="lembretes__rotulo" htmlFor="lembretes-novo-descricao">Descrição</label>
      <input
        type="text"
        id="lembretes-novo-descricao"
        className="ck-entrada lembretes__campo"
        placeholder="O que você precisa fazer?"
        autoComplete="off"
        aria-describedby="lembretes-novo-erro"
        aria-invalid={n > LIMITE}
        value={novo.descricao}
        onChange={(e) => aoDigitar(e.target)}
      />
      <button
        type="button"
        id="lembretes-data-botao"
        className={ativa ? "ck-btn ck-btn--secundario lembretes__data-botao lembretes__data-botao--ativa" : "ck-btn ck-btn--secundario lembretes__data-botao"}
        aria-expanded={novo.painelData}
        aria-controls="lembretes-data-painel"
        onClick={alternarPainelData}
      >
        <IconeCalendario tamanho={14} />
        <span id="lembretes-data-rotulo">{ativa ? rotuloAgenda(novo.data, novo.hora, hoje) : "Data"}</span>
      </button>
      <button type="submit" id="lembretes-adicionar" className="ck-btn ck-btn--primario" disabled={estado.adicionando || n === 0 || n > LIMITE}>
        <IconeSprite nome="plus" />
        Adicionar
      </button>
      <fieldset className="lembretes__data-painel" id="lembretes-data-painel" hidden={!novo.painelData} onKeyDown={(e) => teclaPainelData(e)}>
        <legend className="lembretes__data-legenda">Data agendada</legend>
        <div className="lembretes__atalhos">
          <Atalho id="lembretes-atalho-hoje" rotulo="Hoje" nome="hoje" ativo={ativa && novo.data === hoje} />
          <Atalho id="lembretes-atalho-amanha" rotulo="Amanhã" nome="amanha" ativo={ativa && novo.data === somarDias(hoje, 1)} />
          <Atalho id="lembretes-atalho-segunda" rotulo="Próxima segunda" nome="segunda" ativo={ativa && novo.data === proximaSegunda(hoje)} />
        </div>
        <CampoDataHora escopo="novo" tipo="data" rotulo="Data" valor={novo.data} />
        <CampoDataHora escopo="novo" tipo="hora" rotulo="Hora (opcional)" valor={novo.hora} desligado={novo.horaDesligada} />
        <BotaoRemoverData escopo="novo" />
      </fieldset>
      <p className="lembretes__erro" id="lembretes-novo-erro" role="alert" hidden={n <= LIMITE}>{`A descrição pode ter até ${LIMITE} caracteres.`}</p>
    </form>
  );
}

export function Painel() {
  const estado = useSyncExternalStore(assinar, ler);
  // O dia é recalculado a cada desenho: "Hoje" e os atrasados acompanham a virada do dia sem recarregar a página.
  const hoje = hojeEm();
  const lista = useMemo(
    () => derivarLista(estado.lembretes, hoje, estado.vista, estado.semanaAtual),
    [estado.lembretes, hoje, estado.vista, estado.semanaAtual],
  );
  const vazio = !estado.renderizado || estado.lembretes.length > 0;
  return (
    <>
      <h2 id="lembretes-heading" className="sr-only">Lembretes</h2>
      <div className="ck-pilulas termos__abas" role="tablist" aria-label="Lembretes" onKeyDown={(e) => teclaAba(e)}>
        <Aba nome="entrega" ativa={estado.aba === "entrega"}>Termo Entrega</Aba>
        <Aba nome="devolucao" ativa={estado.aba === "devolucao"}>Termo Devolução</Aba>
        <Aba nome="lembretes" ativa={estado.aba === "lembretes"}>
          Lembretes{" "}
          <span className="ck-pilula__n" id="lembretes-pendentes">{String(lista.pendentes)}</span>
          <span className="sr-only"> pendentes</span>
        </Aba>
      </div>

      {(Object.keys(ROTULOS_TERMO) as NomeTermo[]).map((termo) => (
        <div
          key={termo}
          className="termos__painel"
          role="tabpanel"
          id={`termos-painel-${termo}`}
          aria-labelledby={`termos-aba-${termo}`}
          hidden={estado.aba !== termo}
        >
          <FormularioTermo termo={termo} form={estado.termos[termo]} status={estado.status[termo]} />
        </div>
      ))}

      <div className="termos__painel lembretes__painel" role="tabpanel" id="termos-painel-lembretes" aria-labelledby="termos-aba-lembretes" hidden={estado.aba !== "lembretes"}>
        <div className="lembretes__caixa">
          {/* Novo layout: dois cartões lado a lado (formulário à esquerda, lista à direita); abaixo de 760px empilham. */}
          <div className="lembretes__grade">
            <section className="lembretes__cartao" aria-labelledby="lembretes-novo-titulo">
              <h3 className="lembretes__cartao-titulo" id="lembretes-novo-titulo">
                <span className="lembretes__cartao-ico" aria-hidden="true"><IconeSprite nome="plus" /></span>
                Novo lembrete
              </h3>
              <FormNovo estado={estado} hoje={hoje} />
            </section>
            <div className="lembretes__cartao">
              <p className="lembretes__vazio" id="lembretes-vazio" hidden={vazio}>
                <span className="lembretes__vazio-ico" aria-hidden="true"><IconeSprite nome="check" /></span>
                <span>Nenhum lembrete.</span>
              </p>
              <Vistas lista={lista} hoje={hoje} vista={estado.vista} />
              <Semana hoje={hoje} vista={estado.vista} semanaAtual={estado.semanaAtual} />
              <Grupos lista={lista} hoje={hoje} vista={estado.vista} editandoId={estado.editandoId} edicao={estado.edicao} termosAbertos={estado.termosAbertos} />
              <Concluidos lista={lista} hoje={hoje} concluidosAbertos={estado.concluidosAbertos} editandoId={estado.editandoId} edicao={estado.edicao} termosAbertos={estado.termosAbertos} />
            </div>
          </div>
        </div>
      </div>

      <DialogoExcluir texto={estado.excluirTexto} />
      <DialogoCriar texto={estado.criarTexto} enviando={estado.criarEnviando} />
      <FolhaImpressao folha={estado.folha} />
    </>
  );
}
