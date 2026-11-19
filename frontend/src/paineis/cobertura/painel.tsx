// Painel Cobertura (F10) no layout novo: barra de busca e tipo, alertas, aviso de reserva, necessidades, bento de quatro cartões,
// formulários e folhas. Ids, ARIA e regras de escrita vêm do painel anterior; a regra de cada item fica em ./modelo.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type InputHTMLAttributes } from "react";
import { CartaoBento } from "../../componentes/cartao-bento";
import { FolhaInferior } from "../../componentes/folha-inferior";
import { IconeLucide } from "../../componentes/icone-lucide";
import { PilulaSubaba } from "../../componentes/pilula-subaba";
import { desfazerReserva, disponibilidade, reservar, tentarDeNovo } from "./acoes";
import { Botao, Grupo } from "./componentes";
import { assinar, escrever, ler, semRepetir } from "./estado";
import {
  Cab, Cartoes, conteudoDaFolha, ICONES, ListaDisponiveis, ListaNecessidades, montarVisao, OPCOES_TIPO, tituloDaFolha,
  type Contexto, type Folha, type Tipo,
} from "./listas";
import * as modelo from "./modelo";
import { casos, type Aba, type Registro } from "./tipos";

const OPCOES_CHIP: readonly { valor: Aba; rotulo: string }[] = [
  { valor: "necessidades", rotulo: "Necessidades" }, { valor: "disponiveis", rotulo: "Disponíveis" }, { valor: "reservas", rotulo: "Reservas" },
  { valor: "movimento", rotulo: "Em movimento" }, { valor: "devolucoes", rotulo: "Devoluções" },
];

const valor = (form: HTMLFormElement, nome: string) => String(new FormData(form).get(nome) || "").trim();

function CampoForm({ rotulo, bloqueado, ...entrada }: { rotulo: string; bloqueado: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="ck-campo">
      <span className="ck-campo__rotulo">{rotulo}</span>
      <input className="ck-entrada" disabled={bloqueado} {...entrada} />
    </label>
  );
}

async function registrarNecessidade(event: FormEvent<HTMLFormElement>, aoRegistrar?: () => void) {
  event.preventDefault();
  const form = event.currentTarget;
  await semRepetir(form, async () => {
    const ok = await escrever("POST /api/cobertura/demandas", { corpo: {
      data: valor(form, "data"), cidade: valor(form, "cidade"), quantidade: Number(valor(form, "quantidade")) || 1,
      perfil: valor(form, "perfil"), monitor: Boolean((form.elements.namedItem("monitor") as HTMLInputElement | null)?.checked), observacao: valor(form, "observacao"),
    } }, "Necessidade registrada.");
    if (ok) {
      form.reset();
      aoRegistrar?.();
    }
  });
}

async function registrarDisponibilidade(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  const botao = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
  await semRepetir(form, async () => {
    const serie = valor(form, "serie");
    const atual: Registro | undefined = casos(ler().dados, "disponibilidade")[modelo.chaveSerie(serie)];
    const ok = await disponibilidade(serie, (botao?.value || "disponivel") as Parameters<typeof disponibilidade>[1], atual?.rev, valor(form, "cidade"));
    if (ok) form.reset();
  });
}

async function registrarDevolucao(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  await semRepetir(form, async () => {
    const corpo: { serie: string; data_prevista: string; observacao: string; cidade?: string } = { serie: valor(form, "serie"), data_prevista: valor(form, "data_prevista"), observacao: valor(form, "observacao") };
    if (valor(form, "cidade")) corpo.cidade = valor(form, "cidade");
    const ok = await escrever("POST /api/cobertura/devolucoes", { corpo }, "Devolução registrada.");
    if (ok) form.reset();
  });
}

interface Aviso { texto: string; reserva?: Registro; versao: number }

export function PainelCobertura() {
  const { dados, alertas, status, ocupado, bloqueado, versao } = useSyncExternalStore(assinar, ler);
  const [busca, setBusca] = useState("");
  const [tipo, setTipo] = useState<Tipo>("todos");
  const [chip, setChip] = useState<Aba>("disponiveis");
  const [folha, setFolha] = useState<Folha | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [par, setPar] = useState(0);
  const visao = useMemo(() => montarVisao(dados, busca, tipo), [dados, busca, tipo]);
  const carregado = dados !== null;
  const escrita = !bloqueado;
  // Aviso de reserva sem relógio: vale até a próxima releitura dos dados (qualquer outra gravação ou atualização).
  const avisoVisivel = aviso && aviso.versao === versao ? aviso : null;

  async function reservarComAviso(acao: Registro, vaga: Registro) {
    const reserva = await reservar(acao, vaga);
    if (reserva && acao.tipo === "reservar") {
      setAviso({ texto: `${reserva.serie || vaga.serie || acao.corpo?.serie} reservado`, reserva, versao: ler().versao });
    }
    return reserva;
  }

  async function desfazer(reserva: Registro) {
    const ok = await desfazerReserva(reserva);
    if (ok) setAviso({ texto: `${reserva.serie} voltou para Disponíveis`, versao: ler().versao });
  }

  const ctx: Contexto = { escrita, abrir: setFolha, aoReservar: reservarComAviso };
  const fecharFolha = () => setFolha(null);

  // Só o tipo refaz as listas com um fade curto (duas animações iguais alternadas reiniciam o efeito); a busca filtra a cada tecla, sem fade.
  const mudarBusca = (texto: string) => setBusca(texto);
  const mudarTipo = (novo: Tipo) => { setTipo(novo); setPar(n => n + 1); };

  // A folha mostra sempre o item atual da releitura; se o item saiu da lista, ela fecha.
  const conteudo = folha && folha.tipo !== "necessidade" ? conteudoDaFolha(folha, dados, visao, fecharFolha) : null;
  const folhaAberta = folha !== null && (folha.tipo === "necessidade" || conteudo !== null);
  const itemSumiu = folha !== null && folha.tipo !== "necessidade" && conteudo === null;
  useEffect(() => {
    if (itemSumiu) setFolha(null);
  }, [itemSumiu]);
  useEffect(() => {
    if (bloqueado) setFolha(null);
  }, [bloqueado]);
  // A folha não sobrevive ao painel: F1 a F9 e Voltar escondem a seção `#cockpit-tool-panels`, trocar de ferramenta esconde este painel; nos dois casos ela fecha.
  useEffect(() => {
    const raizes = ['[data-cockpit-tool-panel="cobertura"]', "#cockpit-tool-panels"].map(seletor => document.querySelector<HTMLElement>(seletor));
    const observador = new MutationObserver(() => { if (raizes.some(raiz => raiz?.hidden)) setFolha(null); });
    raizes.forEach(raiz => { if (raiz) observador.observe(raiz, { attributes: true, attributeFilter: ["hidden"] }); });
    return () => observador.disconnect();
  }, []);

  // Esc e Tab entre a folha e a janela de confirmação global: a folha escuta o document em fase de borbulhamento e,
  // sozinha, fecharia junto com a confirmação (Esc) ou roubaria o foco de dentro dela (Tab).
  const ignorarEsc = useRef(false);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (!document.querySelector('[data-cockpit-tool-panel="cobertura"] .nl-folha')) return;
      const janela = document.querySelector<HTMLElement>('[data-accessible-modal="true"]:not(.hidden)');
      if (e.key === "Escape") {
        if (janela) {
          ignorarEsc.current = true;
          setTimeout(() => { ignorarEsc.current = false; });
        } else {
          e.preventDefault(); // a folha é a camada de cima: o Esc do painel (Voltar) não sai junto
        }
        return;
      }
      if (e.key !== "Tab" || !janela) return;
      const voltar = e.shiftKey;
      const antes = document.activeElement;
      setTimeout(() => {
        if (!janela.isConnected || janela.classList.contains("hidden") || janela.contains(document.activeElement)) return;
        const focaveis = Array.from(janela.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])"));
        if (!focaveis.length) return;
        const i = antes instanceof HTMLElement ? focaveis.indexOf(antes) : -1;
        const alvo = i < 0 ? focaveis[voltar ? focaveis.length - 1 : 0] : focaveis[(i + (voltar ? focaveis.length - 1 : 1)) % focaveis.length];
        alvo?.focus();
      });
    };
    document.addEventListener("keydown", tecla, true);
    return () => document.removeEventListener("keydown", tecla, true);
  }, []);
  const aoFecharFolha = () => { if (!ignorarEsc.current) setFolha(null); };

  // Se a folha fechou e o botão que a abriu saiu da página, o foco vai para o título do painel, nunca para o body.
  const tinhaFolha = useRef(false);
  useEffect(() => {
    if (tinhaFolha.current && !folha) {
      setTimeout(() => {
        const ativo = document.activeElement;
        if (!ativo || ativo === document.body) document.getElementById("cobertura-heading")?.focus();
      });
    }
    tinhaFolha.current = folha !== null;
  }, [folha]);

  const fade = par === 0 ? "" : par % 2 ? " nl-f10-fa" : " nl-f10-fb";
  const oculto = (aba: Aba) => (chip === aba ? "" : " cob__oculto-cel");

  return (
    <>
      <h2 id="cobertura-heading" className="sr-only" tabIndex={-1}>Cobertura de equipamentos</h2>
      <p id="cobertura-status" className="sr-only" role="status" aria-live="polite" data-tipo={status.tipo}>{status.texto}</p>
      <div className="cob__barra">
        <label className="cob__busca">
          <IconeLucide nome="search" />
          <input type="search" className="ck-entrada" aria-label="Buscar na Cobertura" autoComplete="off" value={busca} onChange={event => mudarBusca(event.target.value)} />
        </label>
        <div className="cob__tipo">
          <PilulaSubaba rotulo="Tipo de equipamento" opcoes={OPCOES_TIPO} valor={tipo} aoMudar={mudarTipo} />
        </div>
        <span className="cob__espaco" aria-hidden="true" />
        {escrita ? (
          <button type="button" className="ck-btn ck-btn--primario cob__novo" onClick={() => setFolha({ tipo: "necessidade" })}>
            <IconeLucide nome="plus" />
            Registrar necessidade
          </button>
        ) : null}
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
      <div className="cob__avisos" role="status" aria-live="polite">
        {avisoVisivel ? (
          <div key={avisoVisivel.texto} className="cob__aviso">
            <span>{avisoVisivel.texto}</span>
            {escrita && avisoVisivel.reserva?.id ? <Botao rotulo="Desfazer" variante="fantasma" aoClicar={() => desfazer(avisoVisivel.reserva as Registro)} /> : null}
          </div>
        ) : null}
      </div>
      <div className="cob__chips">
        <PilulaSubaba rotulo="Lista de equipamentos" opcoes={OPCOES_CHIP} valor={chip} aoMudar={setChip} />
      </div>
      <div className={`cob__conteudo${fade}`}>
        <section className={`cob__sec${oculto("necessidades")}`} aria-labelledby="cobertura-h-necessidades">
          <div className="cob__cab-sec">
            <h2 id="cobertura-h-necessidades" className="cob__h2">Necessidades</h2>
            <span className="cob__n" data-cobertura-n="necessidades">{String(visao.vagas.length)}</span>
          </div>
          <ListaNecessidades visao={visao} ctx={ctx} ocupado={ocupado} carregado={carregado} />
        </section>
        <div className="cob__bento">
          <Cartoes visao={visao} ctx={ctx} ocupado={ocupado} carregado={carregado} chip={chip} />
        </div>
      </div>
      <section className="cob__forms" aria-label="Registros">
        <CartaoBento tom="esmeralda" atraso={0} className="cob__cartao">
          <Cab titulo="Disponíveis" icone={ICONES.disponiveis} />
          <form id="cobertura-form-disponibilidade" className="cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={registrarDisponibilidade}>
            <CampoForm rotulo="Série" bloqueado={bloqueado} type="text" name="serie" className="ck-entrada cob__serie" required autoComplete="off" />
            <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" autoComplete="off" />
            <Grupo classe="cob__acoes">
              <button type="submit" className="ck-btn ck-btn--primario" value="disponivel" disabled={bloqueado}>Confirmar disponível</button>
              <button type="submit" className="ck-btn ck-btn--secundario" value="em_manutencao" disabled={bloqueado}>Marcar manutenção</button>
              <button type="submit" className="ck-btn ck-btn--fantasma" value="indisponivel" disabled={bloqueado}>Marcar indisponível</button>
            </Grupo>
          </form>
        </CartaoBento>
        <CartaoBento tom="ciano" atraso={1} className="cob__cartao cob__cartao--indigo">
          <Cab titulo="Reservas e Em movimento" icone={ICONES.reservas} />
          <p className="cob__nota">Sem formulário.</p>
        </CartaoBento>
        <CartaoBento tom="ambar" atraso={2} className="cob__cartao">
          <Cab titulo="Devoluções" icone={ICONES.devolucoes} />
          <form id="cobertura-form-devolucao" className="cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={registrarDevolucao}>
            <CampoForm rotulo="Série" bloqueado={bloqueado} type="text" name="serie" className="ck-entrada cob__serie" required autoComplete="off" />
            <CampoForm rotulo="Data prevista" bloqueado={bloqueado} type="date" name="data_prevista" required />
            <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" autoComplete="off" />
            <CampoForm rotulo="Observação" bloqueado={bloqueado} type="text" name="observacao" maxLength={500} autoComplete="off" />
            <Grupo classe="cob__acoes">
              <button type="submit" className="ck-btn ck-btn--primario" disabled={bloqueado}>Registrar devolução</button>
            </Grupo>
          </form>
        </CartaoBento>
        <CartaoBento tom="esmeralda" atraso={3} className="cob__cartao cob__largo">
          <Cab titulo="Lista de disponíveis" icone={ICONES.disponiveis} n={visao.lista.length} />
          <ListaDisponiveis visao={visao} ctx={ctx} carregado={carregado} />
        </CartaoBento>
      </section>
      <FolhaInferior aberta={folhaAberta} titulo={folha ? tituloDaFolha(folha) : ""} aoFechar={aoFecharFolha}>
        {folha?.tipo === "necessidade" ? (
          <form id="cobertura-form-necessidade" className="cob__form" data-cobertura-escrita="" hidden={bloqueado} onSubmit={event => registrarNecessidade(event, fecharFolha)}>
            <CampoForm rotulo="Data" bloqueado={bloqueado} type="date" name="data" required />
            <CampoForm rotulo="Cidade" bloqueado={bloqueado} type="text" name="cidade" required autoComplete="off" />
            <CampoForm rotulo="Quantidade" bloqueado={bloqueado} type="number" name="quantidade" min={1} max={50} defaultValue={1} required />
            <CampoForm rotulo="Perfil" bloqueado={bloqueado} type="text" name="perfil" maxLength={80} autoComplete="off" />
            <label className="ck-campo cob__check">
              <input type="checkbox" name="monitor" disabled={bloqueado} />
              <span className="ck-campo__rotulo">Monitor</span>
            </label>
            <CampoForm rotulo="Observação" bloqueado={bloqueado} type="text" name="observacao" maxLength={500} autoComplete="off" />
            <Grupo classe="cob__acoes">
              <button type="submit" className="ck-btn ck-btn--primario" disabled={bloqueado}>Registrar necessidade</button>
            </Grupo>
          </form>
        ) : conteudo}
      </FolhaInferior>
    </>
  );
}
