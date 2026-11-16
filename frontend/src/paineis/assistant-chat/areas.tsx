import { dataLocalHoje, metaConversa, metaLembrete, tituloConversa, type ConversaResumo, type Lembrete } from "./assistente-puro";
import { BotaoVoltar, Icone, InfoTip } from "./comuns";
import { acoes, type Estado } from "./estado";

const voltar = () => acoes.voltarConversaAssistente();

export function AreaInstrucoes({ e }: { e: Estado }) {
  return (
    <section id="assistente-instrucoes" className="ck-assist__instrucoes" aria-labelledby="assistente-instrucoes-titulo" hidden={!e.instrucoesAberta}>
      <BotaoVoltar aoClicar={voltar} />
      <h3 className="ck-det__titulo">
        <span id="assistente-instrucoes-titulo">Instruções permanentes</span>{" "}
        <InfoTip idDica="tip-assistente-instrucoes" rotulo="Instruções permanentes">
          Preferências, não regras de segurança: o cartão de confirmação e a ocultação de dados pessoais continuam valendo. Valem na próxima mensagem.
        </InfoTip>
      </h3>
      <label className="ck-campo ck-assist__campo">
        <span className="ck-campo__rotulo">Regras e preferências para o Assistente</span>
        <textarea
          id="assistente-instrucoes-texto" className="ck-entrada" rows={4} maxLength={4000} placeholder="Ex.: Sempre responda em tabela."
          aria-describedby="tip-assistente-instrucoes assistente-instrucoes-contador" disabled={e.instrucoesDesabilitado}
          onInput={() => acoes.contarInstrucoesAssistente()}
        />
      </label>
      <div className="ck-assist__acoes">
        <span id="assistente-instrucoes-contador" className="ck-assist__contador">{e.instrucoesContador}</span>
        <div className="ck-grupo-botoes">
          <button
            type="button" id="assistente-instrucoes-limpar" className="ck-btn ck-btn--secundario ck-btn--sm" title="Apaga as instruções salvas"
            disabled={e.instrucoesDesabilitado} onClick={() => void acoes.limparInstrucoesAssistente()}
          >
            Limpar
          </button>
          <button
            type="button" id="assistente-instrucoes-salvar" className="ck-btn ck-btn--primario ck-btn--sm" disabled={e.instrucoesDesabilitado}
            onClick={() => void acoes.salvarInstrucoesAssistente()}
          >
            Salvar
          </button>
        </div>
      </div>
      <p id="assistente-instrucoes-status" className="ck-assist__contador" role="status" aria-live="polite">{e.instrucoesStatus}</p>
      <div className="ck-assist__busca">
        <div className="flex items-center gap-1">
          <label className="ck-assist__interruptor" htmlFor="assistente-busca-web">
            <input
              type="checkbox" role="switch" id="assistente-busca-web" aria-label="Busca na web" aria-describedby="assistente-busca-web-aviso"
              checked={e.buscaWebMarcada} disabled={e.buscaWebDesabilitada} onChange={() => void acoes.alternarBuscaWebAssistente()}
            />
            <span>Busca na web</span>
          </label>
          <InfoTip idDica="tip-assistente-busca-web" rotulo="Busca na web">
            Desligada por padrão. Ligada, o Assistente pode pesquisar na internet só informação genérica (até 200 caracteres); dados do cadastro (série, hostname, nome, e-mail, telefone, CPF) são recusados antes de sair.
          </InfoTip>
        </div>
        <p id="assistente-busca-web-aviso" className="ck-assist__aviso" role="status" aria-live="polite">{e.buscaWebAviso}</p>
        <p id="assistente-busca-web-status" className="ck-assist__contador" role="status" aria-live="polite">{e.buscaWebStatus}</p>
      </div>
    </section>
  );
}

function ItemLembrete({ nota, hoje, apagando }: { nota: Lembrete; hoje: string; apagando: boolean }) {
  const id = String(nota.id);
  const texto = String(nota.texto ?? "");
  const concluida = nota.concluida === true;
  const meta = metaLembrete(nota, hoje);
  const verbo = concluida ? "Reabrir" : "Concluir";
  return (
    <li className={`ck-assist__lembrete${concluida ? " ck-assist__lembrete--feito" : ""}`} data-lembrete-id={id}>
      <span className="ck-assist__anexo-texto">
        <span className="ck-assist__lembrete-texto">{texto}</span>
        {meta ? <span className="ck-assist__anexo-meta">{meta}</span> : null}
      </span>
      <span className="ck-assist__lembrete-acoes">
        {apagando ? (
          <>
            <span className="ck-assist__anexo-meta">Apagar este lembrete?</span>
            <button type="button" className="ck-btn ck-btn--primario ck-btn--sm" aria-label={`Confirmar: apagar lembrete ${texto}`} onClick={() => void acoes.apagarLembreteAssistente(id)}>
              Apagar
            </button>
            <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" onClick={() => acoes.cancelarApagarLembreteAssistente(id)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" aria-label={`${verbo}: ${texto}`} onClick={() => void acoes.marcarLembreteAssistente(id)}>
              {verbo}
            </button>
            <button
              type="button" className="ck-btn ck-btn--fantasma ck-btn--sm ck-btn--icone" title="Apagar lembrete" aria-label={`Apagar lembrete: ${texto}`}
              onClick={() => acoes.pedirApagarLembreteAssistente(id)}
            >
              <Icone id="i-trash" />
            </button>
          </>
        )}
      </span>
    </li>
  );
}

export function AreaLembretes({ e }: { e: Estado }) {
  const hoje = dataLocalHoje();
  return (
    <section id="assistente-lembretes" className="ck-assist__instrucoes ck-assist__lembretes" aria-labelledby="assistente-lembretes-titulo" hidden={!e.lembretesAberta}>
      <BotaoVoltar aoClicar={voltar} />
      <h3 id="assistente-lembretes-titulo" className="ck-det__titulo" tabIndex={-1}>
        {"Lembretes e notas "}
        <InfoTip idDica="tip-lembretes" rotulo="Lembretes e notas">
          {'Memória do Assistente: peça no chat "me lembre de…" ou "anote que…". Não há alarme nem aviso automático; confira esta lista quando precisar.'}
        </InfoTip>
      </h3>
      <ul id="assistente-lembretes-lista" className="ck-assist__lembretes-lista" aria-labelledby="assistente-lembretes-titulo" hidden={e.lembretesListaOculta}>
        {e.lembretes.map(nota => (
          <ItemLembrete key={String(nota.id)} nota={nota} hoje={hoje} apagando={String(nota.id) === e.lembreteApagando} />
        ))}
      </ul>
      <p id="assistente-lembretes-vazio" className="ck-assist__contador" hidden={e.lembretesVazioOculto}>Nenhum lembrete guardado.</p>
      <p id="assistente-lembretes-status" className="ck-assist__contador" role="status" aria-live="polite">{e.lembretesStatus}</p>
    </section>
  );
}

function ItemConversa({ conversa, apagando }: { conversa: ConversaResumo; apagando: boolean }) {
  const id = String(conversa.id);
  const titulo = tituloConversa(conversa);
  return (
    <li className="ck-assist__lembrete" data-conversa-id={id}>
      <span className="ck-assist__anexo-texto">
        <button type="button" className="ck-assist__lembrete-texto" onClick={() => void acoes.abrirConversaHistoricoAssistente(id)}>{titulo}</button>
        <span className="ck-assist__anexo-meta">{metaConversa(conversa)}</span>
      </span>
      <span className="ck-assist__lembrete-acoes">
        {apagando ? (
          <>
            <span className="ck-assist__anexo-meta">Apagar esta conversa?</span>
            <button type="button" className="ck-btn ck-btn--primario ck-btn--sm" aria-label={`Confirmar: apagar conversa ${titulo}`} onClick={() => void acoes.apagarConversaHistoricoAssistente(id)}>
              Apagar
            </button>
            <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" onClick={() => acoes.cancelarApagarConversaHistoricoAssistente(id)}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button
              type="button" className="ck-btn ck-btn--fantasma ck-btn--sm ck-btn--icone" title="Exportar PDF" aria-label={`Exportar PDF: ${titulo}`}
              onClick={() => void acoes.exportarPdfHistoricoAssistente(id)}
            >
              <Icone id="i-download" />
            </button>
            <button
              type="button" className="ck-btn ck-btn--fantasma ck-btn--sm ck-btn--icone" title="Apagar conversa" aria-label={`Apagar conversa: ${titulo}`}
              onClick={() => acoes.pedirApagarConversaHistoricoAssistente(id)}
            >
              <Icone id="i-trash" />
            </button>
          </>
        )}
      </span>
    </li>
  );
}

export function AreaHistorico({ e }: { e: Estado }) {
  return (
    <section id="assistente-historico" className="ck-assist__instrucoes ck-assist__historico" aria-labelledby="assistente-historico-titulo" hidden={!e.historicoAberto}>
      <BotaoVoltar id="assistente-historico-voltar" aoClicar={voltar} />
      <h3 id="assistente-historico-titulo" className="ck-det__titulo" tabIndex={-1}>
        {"Histórico de conversas "}
        <InfoTip idDica="tip-historico" rotulo="Histórico de conversas">
          Só leitura. Guarda neste computador o texto das conversas, sem CPF, e-mail, telefone, senha nem nomes (aparecem como [PESSOA_n]). Anexos e relatórios não são guardados. Até 50 conversas; as mais antigas saem sozinhas.
        </InfoTip>
      </h3>
      <ul id="assistente-historico-lista" className="ck-assist__lembretes-lista" aria-labelledby="assistente-historico-titulo" hidden={e.historicoListaOculta}>
        {e.historico.map(conversa => (
          <ItemConversa key={String(conversa.id)} conversa={conversa} apagando={String(conversa.id) === e.historicoApagando} />
        ))}
      </ul>
      <p id="assistente-historico-vazio" className="ck-assist__contador" hidden={e.historicoVazioOculto}>Nenhuma conversa guardada.</p>
      <button
        type="button" id="assistente-historico-lista-voltar" className="ck-btn ck-btn--secundario ck-btn--sm ck-assist__voltar"
        hidden={e.listaVoltarOculto} onClick={() => acoes.fecharConversaHistoricoAssistente()}
      >
        Ver todas as conversas
      </button>
      <button
        type="button" id="assistente-historico-exportar" className="ck-btn ck-btn--primario ck-btn--sm ck-assist__voltar"
        hidden={e.exportarOculto} onClick={() => void acoes.exportarPdfHistoricoAssistente()}
      >
        Exportar PDF
      </button>
      <div id="assistente-historico-leitura" className="ck-assist__historico-leitura" role="region" aria-label="Conversa guardada" tabIndex={0} hidden={e.leituraOculta}>
        {e.leituraItens.map((item, indice) => (
          <div key={indice} className={`ck-assist__msg ck-assist__msg--${item.autor}`}>
            <span className="ck-sr">{item.autor === "usuario" ? "Você:" : "Assistente:"}</span>
            <p className="ck-assist__texto">{item.texto}</p>
          </div>
        ))}
      </div>
      <p id="assistente-historico-status" className="ck-assist__contador" role="status" aria-live="polite">{e.historicoStatus}</p>
    </section>
  );
}
