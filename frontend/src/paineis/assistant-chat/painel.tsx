import { Fragment, useSyncExternalStore } from "react";
import { AreaHistorico, AreaInstrucoes, AreaLembretes } from "./areas";
import { Icone } from "./comuns";
import { assinar, acoes, ler, type Estado } from "./estado";
import { Formulario } from "./formulario";
import { BoasVindas, Mensagens, Pendente } from "./mensagens";
import { tituloConversa, dataHoraConversa } from "./assistente-puro";

function Cabecalho({ e }: { e: Estado }) {
  const minimizado = e.modo === "minimizado";
  const maximizado = e.modo === "maximizado";
  return (
    <div className="ck-assist-widget__cab">
      <div className="ck-assist__marca">
        <canvas id="assistente-globo" className="ck-assist__globo" width={112} height={112} data-estado={e.globo} aria-hidden="true" />
        <h2 id="assistente-heading" className="ck-assist-widget__titulo">Assistente</h2>
      </div>
      <div className="ck-assist-widget__acoes">
        <button
          type="button" id="assistente-historico-botao" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm"
          aria-label="Histórico de conversas" title="Histórico de conversas" aria-expanded={e.historicoAberto}
          aria-controls="assistente-historico" onClick={() => void acoes.alternarHistoricoAssistente()}
        >
          <Icone id="i-history" classe="ck-ico" />
        </button>
        <button
          type="button" id="assistente-minimizar" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm"
          aria-label={minimizado ? "Restaurar Assistente" : "Minimizar Assistente"} title={minimizado ? "Restaurar" : "Minimizar"}
          aria-expanded={!minimizado} onClick={() => acoes.minimizarAssistente()}
        >
          <Icone id={minimizado ? "i-chevron-up" : "i-minus"} classe="ck-ico" />
        </button>
        <button
          type="button" id="assistente-maximizar" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm"
          aria-label={maximizado ? "Restaurar tamanho do Assistente" : "Maximizar Assistente"} title={maximizado ? "Restaurar tamanho" : "Maximizar"}
          onClick={() => acoes.maximizarAssistente()}
        >
          <Icone id={maximizado ? "i-restaurar" : "i-maximize"} classe="ck-ico" />
        </button>
        <button
          type="button" id="assistente-fechar" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm"
          aria-label="Fechar Assistente" title="Fechar (Esc)" onClick={() => acoes.alternarAssistente()}
        >
          <Icone id="i-x" classe="ck-ico" />
        </button>
      </div>
    </div>
  );
}

function Barra({ e }: { e: Estado }) {
  return (
    <div className="ck-barra-ferr ck-assist__barra">
      <p id="assistente-status" className="ck-barra-ferr__nota ck-assist__status" role="status" aria-live="polite"><Fragment key={e.statusSeq}>{e.status}</Fragment></p>
      <button
        type="button" id="assistente-cancelar-envio" className="ck-btn ck-btn--secundario ck-btn--sm ck-assist__cancelar-envio"
        aria-label="Cancelar envio" hidden={e.cancelarEnvioOculto} onClick={() => acoes.cancelarEnvioAssistente()}
      >
        Cancelar
      </button>
      <button type="button" id="assistente-tentar" className="ck-btn ck-btn--secundario ck-btn--sm" hidden={e.tentarOculto} onClick={() => void acoes.carregarAssistente()}>
        <Icone id="i-refresh" />
        Tentar novamente
      </button>
      <button type="button" id="assistente-nova" className="ck-btn ck-btn--fantasma ck-btn--sm" disabled={e.novaDesabilitada} onClick={() => void acoes.novaConversaAssistente()}>
        <Icone id="i-plus" />
        Nova conversa
      </button>
      <nav id="assistente-lateral-conversas" className="ck-assist__conversas" aria-label="Conversas guardadas">
        <p className="ck-assist__conversas-titulo" aria-hidden="true">Conversas</p>
        <ul id="assistente-lateral-conversas-lista" className="ck-assist__conversas-lista" hidden={e.lateralListaOculta}>
          {e.historico.map(conversa => (
            <li key={String(conversa.id)}>
              <button type="button" className="ck-assist__conversa" onClick={() => void acoes.abrirConversaLateralAssistente(String(conversa.id))}>
                <span className="ck-assist__conversa-titulo">{tituloConversa(conversa)}</span>
                <span className="ck-assist__conversa-data">{dataHoraConversa(conversa)}</span>
              </button>
            </li>
          ))}
        </ul>
        <p id="assistente-lateral-conversas-vazio" className="ck-assist__conversas-vazio" hidden={e.lateralVazioOculto}>Nenhuma conversa guardada.</p>
      </nav>
      <button
        type="button" id="assistente-voz" className="ck-btn ck-btn--fantasma ck-btn--sm" aria-pressed={e.vozPressionada} disabled={e.vozDesabilitada}
        title="Ler as respostas em voz alta (voz do seu computador, nada é enviado)" onClick={() => acoes.alternarVozAssistente()}
      >
        <Icone id="i-volume" />
        Voz
      </button>
      <button
        type="button" id="assistente-instrucoes-botao" className="ck-btn ck-btn--fantasma ck-btn--sm" aria-expanded={e.instrucoesAberta}
        aria-controls="assistente-instrucoes" onClick={() => void acoes.alternarInstrucoesAssistente()}
      >
        <Icone id="i-pencil" />
        Instruções
      </button>
      <button
        type="button" id="assistente-lembretes-botao" className="ck-btn ck-btn--fantasma ck-btn--sm" aria-expanded={e.lembretesAberta}
        aria-controls="assistente-lembretes" onClick={() => void acoes.alternarLembretesAssistente()}
      >
        <Icone id="i-clipboard" />
        Lembretes
      </button>
    </div>
  );
}

// Raiz do painel: os filhos ficam direto sob a <section id="assistente-widget"> do index.html (o CSS depende dessa ordem).
export function Painel() {
  const e = useSyncExternalStore(assinar, ler);
  return (
    <>
      <Cabecalho e={e} />
      <Barra e={e} />
      <AreaInstrucoes e={e} />
      <AreaLembretes e={e} />
      <AreaHistorico e={e} />
      <Mensagens e={e} />
      <BoasVindas />
      <p id="assistente-anuncio" className="ck-sr" aria-live="polite" aria-atomic="true"><Fragment key={e.anuncioSeq}>{e.anuncio}</Fragment></p>
      <Pendente e={e} />
      <Formulario e={e} />
    </>
  );
}
