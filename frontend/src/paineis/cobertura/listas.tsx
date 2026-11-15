// As cinco listas da Cobertura (necessidades, disponíveis, reservas, em movimento, devoluções).
// Regra de vaga, kit e ações vem de window.SimpressCoverageModel; aqui só desenho.
import { useRef, useState } from "react";
import {
  acaoDevolucao, alterarKit, cancelarDevolucao, cancelarEReabrirVaga, cancelarMovimentacao, cancelarNecessidade, cancelarReserva,
  disponibilidade, entregarSemTransporte, mudarEstado, prepararTransporte, renovarReserva, reservar, resolverDivergencia, vincularHistorico,
} from "./acoes";
import { Botao, Campo, Grupo, Selo, Tabela } from "./componentes";
import { casos, modelo, type Dados, type Registro } from "./tipos";

interface Props { dados: Dados }

export function Necessidades({ dados }: Props) {
  const m = modelo();
  const demandas = casos(dados, "demandas");
  const linhas = (dados.vagas || []).map(vaga => {
    const demanda = demandas[vaga.demanda_id] || {};
    const acao = m.acaoDaVaga(vaga);
    return [
      `${vaga.indice}/${demanda.quantidade || vaga.indice}`,
      vaga.cidade,
      m.formatarData(vaga.data),
      `${vaga.perfil || "—"}${vaga.monitor ? " + monitor" : ""}`,
      <Grupo key="situacao" classe="cob__selos">
        {m.selosDaVaga(vaga).map((selo: { texto: string; status: string }, n: number) => <Selo key={n} {...selo} />)}
        {vaga.motivo ? <span className="cob__nota">{vaga.motivo}</span> : null}
      </Grupo>,
      vaga.serie,
      <Grupo key="acoes" classe="cob__acoes">
        {acao ? <Botao rotulo={acao.rotulo} variante="primario" aoClicar={() => reservar(acao)} rotuloAcessivel={`${acao.rotulo} — ${vaga.serie || ""} para ${vaga.cidade}`} /> : null}
        {vaga.indice === 1 && demanda.estado === "aberta"
          ? <Botao rotulo="Cancelar necessidade" variante="perigo" aoClicar={() => cancelarNecessidade(demanda)} rotuloAcessivel={`Cancelar necessidade de ${demanda.cidade}`} />
          : null}
      </Grupo>,
    ];
  });
  return <Tabela rotulo="Necessidades" colunas={["Necessidade", "Cidade", "Data", "Perfil", "Situação", "Série", "Ações"]} linhas={linhas} vazio="Nenhuma necessidade aberta." />;
}

export function Disponiveis({ dados }: Props) {
  const m = modelo();
  const bloqueios = new Map<string, string>((dados.bloqueios || []).map(b => [m.chaveSerie(b.serie), b.motivo]));
  const sinais = new Map<string, string>((dados.sinais || []).map(s => [m.chaveSerie(s.serie), s.sinal]));
  const registros = Object.values(casos(dados, "disponibilidade")).sort((a, b) => String(a.serie).localeCompare(String(b.serie)));
  const linhas = registros.map(reg => {
    const estado = reg.estado_efetivo || reg.estado;
    const tipo = estado === "disponivel" ? "ok" : estado === "a_confirmar" ? "alerta" : "erro";
    const chave = m.chaveSerie(reg.serie);
    const nota = [bloqueios.has(chave) ? m.textoBloqueio(bloqueios.get(chave)) : "", sinais.get(chave) || ""].filter(Boolean).join(" · ");
    return [
      reg.serie,
      reg.cidade,
      <Selo key="situacao" texto={m.DISPONIBILIDADE[estado] || estado} status={tipo} />,
      m.formatarData(reg.valida_ate),
      nota,
      <Grupo key="acoes" classe="cob__acoes">
        <Botao rotulo="Confirmar disponível" variante="secundario" aoClicar={() => disponibilidade(reg.serie, "disponivel", reg.rev)} rotuloAcessivel={`Confirmar disponível — ${reg.serie}`} />
        <Botao rotulo="Marcar manutenção" variante="fantasma" aoClicar={() => disponibilidade(reg.serie, "em_manutencao", reg.rev)} rotuloAcessivel={`Marcar manutenção — ${reg.serie}`} />
        <Botao rotulo="Marcar indisponível" variante="fantasma" aoClicar={() => disponibilidade(reg.serie, "indisponivel", reg.rev)} rotuloAcessivel={`Marcar indisponível — ${reg.serie}`} />
      </Grupo>,
    ];
  });
  return <Tabela rotulo="Disponíveis" colunas={["Série", "Cidade", "Situação", "Válida até", "Observação", "Ações"]} linhas={linhas} vazio="Nenhuma máquina registrada." />;
}

// O kit inteiro espera a releitura: outro clique antes dela iria com o rev velho e voltaria 409.
function Kit({ reserva }: { reserva: Registro }) {
  const [ocupado, setOcupado] = useState(false);
  return (
    <fieldset className="cob__kit" disabled={ocupado}>
      <legend className="sr-only">{`Kit da série ${reserva.serie}`}</legend>
      {modelo().itensKit(reserva).map(({ item, rotulo, marcado }: { item: string; rotulo: string; marcado: boolean }) => (
        <label key={item} className="cob__check">
          <input
            className="ck-entrada"
            type="checkbox"
            defaultChecked={marcado}
            onChange={async event => {
              const caixa = event.currentTarget;
              const novo = caixa.checked;
              setOcupado(true);
              const ok = await alterarKit(reserva, item, novo);
              if (!ok && caixa.isConnected) { caixa.checked = !novo; setOcupado(false); }
            }}
          />
          <span>{rotulo}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function Reservas({ dados }: Props) {
  const m = modelo();
  const demandas = casos(dados, "demandas");
  const disponibilidades = casos(dados, "disponibilidade");
  const linhas = m.reservasAbertas(dados).map((reserva: Registro) => {
    const demanda = demandas[reserva.demanda_id] || {};
    const disponivel = disponibilidades[m.chaveSerie(reserva.serie)];
    const acoes: string[] = m.acoesDaReserva(reserva, demanda, disponivel);
    return [
      reserva.serie,
      `${demanda.cidade || "—"} · ${m.formatarData(demanda.data)}`,
      <Grupo key="situacao" classe="cob__selos">
        <Selo texto={m.ESTADO_RESERVA[reserva.estado] || reserva.estado} status={reserva.estado === "ativa" ? "ok" : "alerta"} />
        {reserva.kit_pronto ? <Selo texto="Kit pronto" status="ok" /> : null}
        {reserva.vencida ? <Selo texto="Reserva vencida" status="alerta" /> : null}
      </Grupo>,
      m.formatarData(reserva.valida_ate),
      <Kit key="kit" reserva={reserva} />,
      <Grupo key="acoes" classe="cob__acoes">
        {acoes.map(acao => {
          if (acao === "renovar") return <Botao key={acao} rotulo="Renovar reserva" variante="secundario" aoClicar={() => renovarReserva(reserva)} rotuloAcessivel={`Renovar reserva — ${reserva.serie}`} />;
          if (acao === "cancelar") return <Botao key={acao} rotulo="Cancelar reserva" variante="perigo" aoClicar={() => cancelarReserva(reserva)} rotuloAcessivel={`Cancelar reserva — ${reserva.serie}`} />;
          if (acao === "preparar") return <Botao key={acao} rotulo="Preparar Transporte" variante="primario" aoClicar={() => prepararTransporte(reserva, demanda)} rotuloAcessivel={`Preparar Transporte — ${reserva.serie}`} />;
          if (acao === "local") return <Botao key={acao} rotulo="Entregar sem Transporte" variante="secundario" aoClicar={() => entregarSemTransporte(reserva)} rotuloAcessivel={`Entregar sem Transporte — ${reserva.serie}`} />;
          return null;
        })}
      </Grupo>,
    ];
  });
  return <Tabela rotulo="Reservas" colunas={["Série", "Necessidade", "Situação", "Válida até", "Kit", "Ações"]} linhas={linhas} vazio="Nenhuma reserva aberta." />;
}

function Vincular({ mov }: { mov: Registro }) {
  const [aberto, setAberto] = useState(false);
  const candidatos: Registro[] = Array.isArray(mov.candidatos_historico) ? mov.candidatos_historico : [];
  return (
    <>
      <Botao rotulo="Vincular transferência já gerada" variante="secundario" aoClicar={() => setAberto(true)} rotuloAcessivel={`Vincular transferência já gerada — ${mov.serie}`} />
      <div className="cob__sub">
        {!aberto ? null : !candidatos.length
          ? <p className="cob__nota">Nenhuma planilha gerada para esta série e destino depois da preparação. Gere a planilha de novo no Transporte.</p>
          : candidatos.map(c => {
            const quando = new Date(String(c.criado_em));
            const texto = `${Number.isNaN(quando.getTime()) ? c.criado_em : quando.toLocaleString("pt-BR")} · ${c.retirada_cidade || "—"} → ${c.entrega_cidade || "—"}`;
            return (
              <Grupo key={c.id} classe="cob__candidato">
                <span>{texto}</span>
                <Botao rotulo="Vincular esta planilha" variante="primario" aoClicar={() => vincularHistorico(mov, c.id)} rotuloAcessivel={`Vincular esta planilha — ${texto}`} />
              </Grupo>
            );
          })}
      </div>
    </>
  );
}

function Recebimento({ mov, hoje }: { mov: Registro; hoje?: string }) {
  const caixa = useRef<HTMLDivElement>(null);
  const campo = (nome: string) => caixa.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${nome}"]`)?.value ?? "";
  const recebimento = () => ({ recebido_por: campo("recebido_por").trim(), data: campo("data"), comprovante: campo("comprovante").trim() || null });
  return (
    <div ref={caixa} className="cob__sub cob__receber">
      <Campo rotulo="Recebido por"><input className="ck-entrada" type="text" name="recebido_por" maxLength={120} autoComplete="off" required /></Campo>
      <Campo rotulo="Data do recebimento"><input className="ck-entrada" type="date" name="data" defaultValue={hoje || ""} required /></Campo>
      <Campo rotulo="Comprovante (opcional)"><input className="ck-entrada" type="text" name="comprovante" maxLength={500} autoComplete="off" /></Campo>
      <Botao rotulo="Confirmar recebimento" variante="primario" aoClicar={() => mudarEstado(mov, "recebida", recebimento(), "Recebimento registrado.")} rotuloAcessivel={`Confirmar recebimento — ${mov.serie}`} />
      <Campo rotulo="Tipo da divergência">
        <select className="ck-entrada" name="tipo">
          {modelo().TIPOS_DIVERGENCIA.map(([valor, rotulo]: [string, string]) => <option key={valor} value={valor}>{rotulo}</option>)}
        </select>
      </Campo>
      <Campo rotulo="Descrição"><input className="ck-entrada" type="text" name="descricao" maxLength={500} autoComplete="off" /></Campo>
      <Campo rotulo="Série recebida"><input className="ck-entrada" type="text" name="serie_recebida" maxLength={60} autoComplete="off" /></Campo>
      <Botao
        rotulo="Registrar divergência"
        variante="secundario"
        aoClicar={() => mudarEstado(mov, "recebida_com_divergencia", {
          ...recebimento(),
          divergencia: { tipo: campo("tipo"), descricao: campo("descricao").trim(), serie_recebida: campo("serie_recebida").trim() || null },
        }, "Divergência registrada.")}
        rotuloAcessivel={`Registrar divergência — ${mov.serie}`}
      />
    </div>
  );
}

function Resolver({ mov }: { mov: Registro }) {
  const serie = useRef<HTMLInputElement>(null);
  return (
    <>
      <Campo rotulo="Série recebida">
        <input ref={serie} className="ck-entrada" type="text" name="serie_recebida" maxLength={60} autoComplete="off" defaultValue={mov.divergencia?.serie_recebida || ""} />
      </Campo>
      <Botao rotulo="Aceitar e encerrar" variante="primario" aoClicar={() => resolverDivergencia(mov, { resolucao: "aceitar" }, "Divergência aceita.")} rotuloAcessivel={`Aceitar e encerrar — ${mov.serie}`} />
      <Botao
        rotulo="Corrigir série recebida"
        variante="secundario"
        aoClicar={() => resolverDivergencia(mov, { resolucao: "corrigir", serie_recebida: (serie.current?.value ?? "").trim() }, "Série recebida corrigida.")}
        rotuloAcessivel={`Corrigir série recebida — ${mov.serie}`}
      />
      <Botao rotulo="Cancelar e reabrir vaga" variante="perigo" aoClicar={() => cancelarEReabrirVaga(mov)} rotuloAcessivel={`Cancelar e reabrir vaga — ${mov.serie}`} />
    </>
  );
}

function AcoesMovimentacao({ mov, hoje }: { mov: Registro; hoje?: string }) {
  const acoes: string[] = modelo().acoesDaMovimentacao(mov);
  return (
    <Grupo classe="cob__acoes">
      {acoes.map(acao => {
        if (acao === "vincular") return <Vincular key={acao} mov={mov} />;
        if (acao === "coletada") return <Botao key={acao} rotulo="Marcar coletada" variante="secundario" aoClicar={() => mudarEstado(mov, "coletada", {}, "Movimentação coletada.")} rotuloAcessivel={`Marcar coletada — ${mov.serie}`} />;
        if (acao === "em_transito") return <Botao key={acao} rotulo="Marcar em trânsito" variante="secundario" aoClicar={() => mudarEstado(mov, "em_transito", {}, "Movimentação em trânsito.")} rotuloAcessivel={`Marcar em trânsito — ${mov.serie}`} />;
        if (acao === "receber") return <Recebimento key={acao} mov={mov} hoje={hoje} />;
        if (acao === "cancelar") return <Botao key={acao} rotulo="Cancelar movimentação" variante="perigo" aoClicar={() => cancelarMovimentacao(mov)} rotuloAcessivel={`Cancelar movimentação — ${mov.serie}`} />;
        if (acao === "resolver") return <Resolver key={acao} mov={mov} />;
        return null;
      })}
    </Grupo>
  );
}

export function Movimento({ dados }: Props) {
  const m = modelo();
  const movs: Registro[] = m.movimentacoesAbertas(dados).sort((a: Registro, b: Registro) => String(a.criada_em).localeCompare(String(b.criada_em)));
  const linhas = movs.map(mov => {
    const tipoDivergencia = mov.divergencia
      ? (m.TIPOS_DIVERGENCIA.find(([v]: [string]) => v === mov.divergencia.tipo) || [])[1] || mov.divergencia.tipo
      : "";
    return [
      mov.serie,
      mov.destino_cidade,
      mov.tipo === "local" ? "Sem Transporte" : "Transporte",
      <Grupo key="estado" classe="cob__selos">
        <Selo texto={m.ESTADO_MOVIMENTACAO[mov.estado] || mov.estado} status={mov.estado === "recebida_com_divergencia" ? "erro" : "info"} />
        {mov.divergencia
          ? <span className="cob__nota">{[tipoDivergencia, mov.divergencia.descricao, mov.divergencia.serie_recebida].filter(Boolean).join(" · ")}</span>
          : null}
      </Grupo>,
      <AcoesMovimentacao key="acoes" mov={mov} hoje={dados.hoje} />,
    ];
  });
  return <Tabela rotulo="Em movimento" colunas={["Série", "Destino", "Tipo", "Estado", "Ações"]} linhas={linhas} vazio="Nenhuma movimentação aberta." />;
}

function AcoesDevolucao({ dev }: { dev: Registro }) {
  const novaData = useRef<HTMLInputElement>(null);
  return (
    <Grupo classe="cob__acoes">
      <Campo rotulo="Nova data prevista">
        <input ref={novaData} className="ck-entrada" type="date" name="data_prevista" defaultValue={dev.data_prevista || ""} />
      </Campo>
      <Botao rotulo="Reprogramar devolução" variante="secundario" aoClicar={() => acaoDevolucao(dev, "reprogramar", { data_prevista: novaData.current?.value ?? "" }, "Devolução reprogramada.")} rotuloAcessivel={`Reprogramar devolução — ${dev.serie}`} />
      <Botao rotulo="Receber devolução" variante="primario" aoClicar={() => acaoDevolucao(dev, "receber", {}, "Devolução recebida.")} rotuloAcessivel={`Receber devolução — ${dev.serie}`} />
      <Botao rotulo="Cancelar devolução" variante="perigo" aoClicar={() => cancelarDevolucao(dev)} rotuloAcessivel={`Cancelar devolução — ${dev.serie}`} />
    </Grupo>
  );
}

export function Devolucoes({ dados }: Props) {
  const m = modelo();
  const linhas = m.devolucoesAbertas(dados).map((dev: Registro) => {
    const situacao = dev.situacao || dev.estado;
    return [
      dev.serie,
      m.formatarData(dev.data_prevista),
      dev.cidade,
      <Selo key="situacao" texto={m.SITUACAO_DEVOLUCAO[situacao] || situacao} status={situacao === "atrasada" ? "erro" : "info"} />,
      <AcoesDevolucao key="acoes" dev={dev} />,
    ];
  });
  return <Tabela rotulo="Devoluções" colunas={["Série", "Data prevista", "Cidade", "Situação", "Ações"]} linhas={linhas} vazio="Nenhuma devolução prevista." />;
}
