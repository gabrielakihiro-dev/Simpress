// Painel Cobertura (F10): status, alertas, abas e formulários. Mesmo DOM, ids, ARIA e classes do HTML antigo.
import { useSyncExternalStore, type FormEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { disponibilidade, tentarDeNovo } from "./acoes";
import { Botao } from "./componentes";
import { assinar, escrever, ler, mudar, semRepetir } from "./estado";
import { Devolucoes, Disponiveis, Movimento, Necessidades, Reservas } from "./listas";
import * as modelo from "./modelo";
import { ABAS, casos, type Aba, type Registro } from "./tipos";

const ROTULOS: Record<Aba, string> = {
  necessidades: "Necessidades", disponiveis: "Disponíveis", reservas: "Reservas", movimento: "Em movimento", devolucoes: "Devoluções",
};

const valor = (form: HTMLFormElement, nome: string) => String(new FormData(form).get(nome) || "").trim();

function CampoForm({ rotulo, bloqueado, ...entrada }: { rotulo: string; bloqueado: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="ck-campo">
      <span className="ck-campo__rotulo">{rotulo}</span>
      <input className="ck-entrada" disabled={bloqueado} {...entrada} />
    </label>
  );
}

function PainelAba({ nome, aba, ocupado, children }: { nome: Aba; aba: Aba; ocupado: boolean; children: ReactNode }) {
  return (
    <div
      id={`cobertura-painel-${nome}`}
      className="cob__painel"
      role="tabpanel"
      aria-labelledby={`cobertura-aba-${nome}`}
      tabIndex={0}
      hidden={aba !== nome}
      aria-busy={ocupado ? "true" : undefined}
    >
      {children}
    </div>
  );
}

async function registrarNecessidade(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  await semRepetir(form, async () => {
    const ok = await escrever("/api/cobertura/demandas", {
      data: valor(form, "data"), cidade: valor(form, "cidade"), quantidade: Number(valor(form, "quantidade")) || 1,
      perfil: valor(form, "perfil"), monitor: Boolean((form.elements.namedItem("monitor") as HTMLInputElement | null)?.checked), observacao: valor(form, "observacao"),
    }, "Necessidade registrada.");
    if (ok) form.reset();
  });
}

async function registrarDisponibilidade(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  const botao = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
  await semRepetir(form, async () => {
    const serie = valor(form, "serie");
    const atual: Registro | undefined = casos(ler().dados, "disponibilidade")[modelo.chaveSerie(serie)];
    const ok = await disponibilidade(serie, botao?.value || "disponivel", atual?.rev, valor(form, "cidade"));
    if (ok) form.reset();
  });
}

async function registrarDevolucao(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  await semRepetir(form, async () => {
    const corpo: Registro = { serie: valor(form, "serie"), data_prevista: valor(form, "data_prevista"), observacao: valor(form, "observacao") };
    if (valor(form, "cidade")) corpo.cidade = valor(form, "cidade");
    const ok = await escrever("/api/cobertura/devolucoes", corpo, "Devolução registrada.");
    if (ok) form.reset();
  });
}

function teclarNaAba(event: KeyboardEvent<HTMLButtonElement>, nome: Aba) {
  const i = ABAS.indexOf(nome);
  const destino = ({ ArrowRight: (i + 1) % ABAS.length, ArrowLeft: (i - 1 + ABAS.length) % ABAS.length, Home: 0, End: ABAS.length - 1 } as Record<string, number>)[event.key];
  if (destino === undefined) return;
  event.preventDefault();
  mudar({ aba: ABAS[destino] });
  document.getElementById(`cobertura-aba-${ABAS[destino]}`)?.focus();
}

export function PainelCobertura() {
  const { dados, alertas, contagens, status, ocupado, bloqueado, aba, versao } = useSyncExternalStore(assinar, ler);
  return (
    <>
      <h2 id="cobertura-heading" className="sr-only">Cobertura de equipamentos</h2>
      <div className="ck-barra-ferr">
        <p id="cobertura-status" className="ck-barra-ferr__nota" role="status" aria-live="polite" data-tipo={status.tipo}>{status.texto}</p>
      </div>
      <div id="cobertura-alertas" className="cob__alertas" aria-busy={ocupado ? "true" : undefined}>
        {alertas.map(alerta => (
          <div key={`${alerta.tipo}-${alerta.movimentacaoId ?? ""}`} className="ck-aviso" data-gravidade={alerta.gravidade} data-cobertura-alerta={alerta.tipo}>
            <span className="ck-aviso__icone">
              <svg className="ck-ico" aria-hidden="true" focusable="false"><use href={alerta.tipo === "sem_vinculo" ? "#i-link" : "#i-alerta"} /></svg>
            </span>
            <div className="ck-aviso__topo"><p className="ck-aviso__titulo">{alerta.texto}</p></div>
            {alerta.detalhe && alerta.detalhe !== alerta.texto ? <p className="ck-aviso__texto">{alerta.detalhe}</p> : null}
            {alerta.tipo === "sem_vinculo" ? (
              <>
                <p className="ck-aviso__texto">{`Série ${alerta.serie}`}</p>
                <Botao rotulo="Tentar vincular de novo" variante="secundario" extra="ck-aviso__acao" aoClicar={() => tentarDeNovo(alerta.movimentacaoId)} rotuloAcessivel={`Tentar vincular de novo — série ${alerta.serie}`} />
              </>
            ) : null}
          </div>
        ))}
      </div>
      <div className="ck-pilulas cob__abas" role="tablist" aria-label="Cobertura">
        {ABAS.map(nome => (
          <button
            key={nome}
            type="button"
            className="ck-pilula"
            role="tab"
            id={`cobertura-aba-${nome}`}
            aria-selected={aba === nome}
            aria-controls={`cobertura-painel-${nome}`}
            data-cobertura-aba={nome}
            tabIndex={aba === nome ? 0 : -1}
            onClick={() => mudar({ aba: nome })}
            onKeyDown={event => teclarNaAba(event, nome)}
          >
            {ROTULOS[nome]}{" "}<span className="ck-pilula__n" data-cobertura-n={nome}>{String(contagens[nome] ?? 0)}</span>
          </button>
        ))}
      </div>
      <PainelAba nome="necessidades" aba={aba} ocupado={ocupado}>
        <form id="cobertura-form-necessidade" className="ck-barra-ferr cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={registrarNecessidade}>
          <CampoForm rotulo="Data" bloqueado={bloqueado} type="date" name="data" required />
          <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" required autoComplete="off" />
          <CampoForm rotulo="Quantidade" bloqueado={bloqueado} type="number" name="quantidade" min={1} max={50} defaultValue={1} required />
          <CampoForm rotulo="Perfil" bloqueado={bloqueado} type="text" name="perfil" maxLength={80} autoComplete="off" />
          <label className="ck-campo cob__check">
            <input type="checkbox" name="monitor" disabled={bloqueado} />
            <span className="ck-campo__rotulo">Monitor</span>
          </label>
          <CampoForm rotulo="Observação" bloqueado={bloqueado} type="text" name="observacao" maxLength={500} autoComplete="off" />
          <button type="submit" className="ck-btn ck-btn--primario" disabled={bloqueado}>Registrar necessidade</button>
        </form>
        <div id="cobertura-lista-necessidades" className="cob__lista">{dados ? <Necessidades key={versao} dados={dados} /> : null}</div>
      </PainelAba>
      <PainelAba nome="disponiveis" aba={aba} ocupado={ocupado}>
        <form id="cobertura-form-disponibilidade" className="ck-barra-ferr cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={registrarDisponibilidade}>
          <CampoForm rotulo="Série" bloqueado={bloqueado} type="text" name="serie" required autoComplete="off" />
          <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" autoComplete="off" />
          <button type="submit" className="ck-btn ck-btn--primario" value="disponivel" disabled={bloqueado}>Confirmar disponível</button>
          <button type="submit" className="ck-btn ck-btn--secundario" value="em_manutencao" disabled={bloqueado}>Marcar manutenção</button>
          <button type="submit" className="ck-btn ck-btn--fantasma" value="indisponivel" disabled={bloqueado}>Marcar indisponível</button>
        </form>
        <div id="cobertura-lista-disponiveis" className="cob__lista">{dados ? <Disponiveis key={versao} dados={dados} /> : null}</div>
      </PainelAba>
      <PainelAba nome="reservas" aba={aba} ocupado={ocupado}>
        <div id="cobertura-lista-reservas" className="cob__lista">{dados ? <Reservas key={versao} dados={dados} /> : null}</div>
      </PainelAba>
      <PainelAba nome="movimento" aba={aba} ocupado={ocupado}>
        <div id="cobertura-lista-movimento" className="cob__lista">{dados ? <Movimento key={versao} dados={dados} /> : null}</div>
      </PainelAba>
      <PainelAba nome="devolucoes" aba={aba} ocupado={ocupado}>
        <form id="cobertura-form-devolucao" className="ck-barra-ferr cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={registrarDevolucao}>
          <CampoForm rotulo="Série" bloqueado={bloqueado} type="text" name="serie" required autoComplete="off" />
          <CampoForm rotulo="Data prevista" bloqueado={bloqueado} type="date" name="data_prevista" required />
          <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" autoComplete="off" />
          <CampoForm rotulo="Observação" bloqueado={bloqueado} type="text" name="observacao" maxLength={500} autoComplete="off" />
          <button type="submit" className="ck-btn ck-btn--primario" disabled={bloqueado}>Registrar devolução</button>
        </form>
        <div id="cobertura-lista-devolucoes" className="cob__lista">{dados ? <Devolucoes key={versao} dados={dados} /> : null}</div>
      </PainelAba>
    </>
  );
}
