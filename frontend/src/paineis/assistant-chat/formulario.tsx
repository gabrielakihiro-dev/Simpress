import { metaAnexo } from "./assistente-puro";
import { Icone } from "./comuns";
import { acoes, type Estado } from "./estado";

export function Formulario({ e }: { e: Estado }) {
  return (
    <form id="assistente-form" className="ck-assist__form" autoComplete="off" onSubmit={evento => { evento.preventDefault(); void acoes.enviarMensagemAssistente(); }}>
      <input
        type="file" id="assistente-anexo-arquivo" aria-label="assistente anexo arquivo" accept=".pdf,.docx,.doc,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
        multiple hidden onChange={evento => void acoes.anexarArquivoAssistente(evento)}
      />
      <ul id="assistente-anexos" className="ck-assist__anexos" aria-label="Arquivos anexados" hidden={e.anexosListaOculta}>
        {e.anexos.map(anexo => (
          <li key={String(anexo.id)} className="ck-assist__anexo">
            <span className="ck-assist__anexo-texto">
              <span className="ck-assist__anexo-nome">{String(anexo.nome ?? "")}</span>
              <span className="ck-assist__anexo-meta">{metaAnexo(anexo)}</span>
              {anexo.aviso ? <span className="ck-assist__anexo-alerta">{String(anexo.aviso)}</span> : null}
            </span>
            <button
              type="button" className="ck-btn ck-btn--fantasma ck-btn--sm ck-btn--icone" aria-label={`Remover anexo ${String(anexo.nome ?? "")}`}
              title="Remover anexo" disabled={e.anexosBotoesDesabilitados} onClick={() => void acoes.removerAnexoAssistente(String(anexo.id))}
            >
              <Icone id="i-x" />
            </button>
          </li>
        ))}
      </ul>
      <p id="assistente-anexos-aviso" className="ck-assist__aviso" hidden={e.anexosAvisoOculto}>
        Atenção: imagens vão ao OpenRouter sem ocultar dados pessoais (CPF, nome, e-mail). Anexe só o que pode sair deste computador.
      </p>
      <p id="assistente-anexos-status" className="ck-assist__contador ck-assist__anexos-status" role="status" aria-live="polite">{e.anexosStatus}</p>
      <div className="ck-assist__pilula">
        <button
          type="button" id="assistente-anexar" className="ck-btn ck-btn--fantasma ck-assist__icone" title="Anexar arquivo (PDF, .docx, PNG ou JPEG)"
          aria-describedby="assistente-anexar-dica" disabled={e.anexarDesabilitado}
          onClick={() => document.getElementById("assistente-anexo-arquivo")?.click()}
        >
          <Icone id="i-paperclip" />
          <span className="ck-assist__icone-rotulo">Anexar</span>
        </button>
        <label className="ck-assist__campo">
          <span className="ck-sr">Mensagem</span>
          <textarea
            id="assistente-texto" className="ck-assist__entrada" rows={1} maxLength={4000} placeholder="Digite sua pergunta…"
            aria-describedby="assistente-contador assistente-texto-dica" disabled={e.textoDesabilitado}
            onInput={() => acoes.contarMensagemAssistente()}
          />
        </label>
        <button
          type="button" id="assistente-gravar" className={`ck-btn ck-btn--fantasma ck-assist__icone${e.gravando ? " ck-assist__icone--gravando" : ""}`}
          title={e.rotuloGravar} aria-describedby="assistente-gravar-dica" disabled={e.gravarDesabilitado}
          onClick={() => acoes.alternarGravacaoAssistente()}
        >
          <Icone id={e.gravando ? "i-stop" : "i-mic"} />
          <span id="assistente-gravar-rotulo" className="ck-assist__icone-rotulo">{e.rotuloGravar}</span>
        </button>
        <button type="submit" id="assistente-enviar" className="ck-btn ck-btn--primario ck-assist__icone ck-assist__enviar" title="Enviar" disabled={e.enviarDesabilitado}>
          <Icone id="i-arrow-up" />
          <span className="ck-assist__icone-rotulo">Enviar</span>
        </button>
      </div>
      <div className="ck-assist__rodape">
        <span id="assistente-contador" className="ck-assist__contador">{e.contador}</span>
        <span id="assistente-texto-dica" className="ck-sr">Enter envia; Shift+Enter quebra a linha.</span>
        <span id="assistente-anexar-dica" className="ck-sr">
          Aceita PDF, .docx, PNG e JPEG, até 5 arquivos. O texto de PDF e .docx passa pela ocultação de dados pessoais antes de ir para a IA. Os anexos são apagados em Nova conversa.
        </span>
        <span id="assistente-gravar-dica" className="ck-sr">A fala é transcrita para a caixa de mensagem; revise o texto antes de enviar. Esc cancela a gravação.</span>
      </div>
    </form>
  );
}
