import { useLayoutEffect, useRef } from "react";
import { resumirFerramentas } from "./assistente-puro";
import { Icone } from "./comuns";
import { acoes, baixarRelatorioAssistente, copiarResposta, type Estado, type Mensagem } from "./estado";

// Todo texto vindo do usuário ou do Assistente entra como texto do React (nunca como HTML); só links http/https abrem.
function MensagemItem({ mensagem }: { mensagem: Mensagem }) {
  return (
    <div className={`ck-assist__msg ck-assist__msg--${mensagem.autor}`}>
      <span className="ck-sr">{mensagem.autor === "usuario" ? "Você:" : "Assistente:"}</span>
      <p className="ck-assist__texto">{mensagem.texto}</p>
      {mensagem.ferramentas.length ? <p className="ck-assist__ferramentas">{resumirFerramentas(mensagem.ferramentas)}</p> : null}
      {mensagem.temArquivos ? (
        <div className="ck-assist__arquivos">
          {mensagem.arquivos.map(arquivo => (
            <button key={arquivo.id} type="button" className="ck-btn ck-btn--secundario ck-assist__arquivo" title={arquivo.titulo || undefined} onClick={() => baixarRelatorioAssistente(arquivo)}>
              {`Baixar ${arquivo.nome}`}
            </button>
          ))}
        </div>
      ) : null}
      {mensagem.temBuscas ? (
        <div className="ck-assist__buscas">
          {mensagem.buscas.map((busca, indice) => (
            <section key={indice} className="ck-assist__busca-card" aria-label="Resultado da busca na web (fonte externa)">
              <p className="ck-assist__busca-titulo">{busca.titulo}</p>
              {busca.resumo ? <p className="ck-assist__busca-resumo">{busca.resumo}</p> : null}
              {busca.fontes.length ? (
                <ul className="ck-assist__busca-fontes">
                  {busca.fontes.map((fonte, posicao) => (
                    <li key={posicao}>
                      {fonte.href ? <a href={fonte.href} target="_blank" rel="noopener noreferrer">{fonte.texto}</a> : <span>{fonte.texto}</span>}
                      {fonte.dominio ? <span className="ck-assist__busca-dominio">{` (${fonte.dominio})`}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
      {mensagem.copiar ? (
        <div className="ck-assist__arquivos">
          <button type="button" className="ck-btn ck-btn--secundario ck-assist__arquivo" onClick={() => void copiarResposta(mensagem.texto)}>
            Copiar texto
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function Mensagens({ e }: { e: Estado }) {
  const lista = useRef<HTMLDivElement>(null);
  // Mensagem nova: rola até o fim, como o código antigo fazia ao acrescentar.
  useLayoutEffect(() => {
    if (lista.current) lista.current.scrollTop = lista.current.scrollHeight;
  }, [e.mensagens]);
  return (
    <div id="assistente-mensagens" ref={lista} className="ck-assist__lista" role="region" aria-label="Mensagens da conversa" aria-busy={e.mensagensOcupadas} tabIndex={0}>
      {e.mensagens.map(mensagem => <MensagemItem key={mensagem.id} mensagem={mensagem} />)}
    </div>
  );
}

const ATALHOS = [
  { icone: "i-search", titulo: "Buscar equipamento", descricao: "Por série ou hostname", texto: "Buscar o equipamento com a série ou o hostname " },
  { icone: "i-ticket", titulo: "Status de chamado", descricao: "Andamento de um chamado", texto: "Qual o andamento do chamado " },
  { icone: "i-alerta", titulo: "Divergências de OS", descricao: "O que não bate entre as fontes", texto: "Quais divergências de OS existem entre as fontes?" },
  { icone: "i-pin", titulo: "Cobertura", descricao: "Equipamentos por unidade", texto: "Como está a cobertura de equipamentos por unidade?" },
  { icone: "i-clipboard", titulo: "Lembretes", descricao: "O que você pediu para guardar", texto: "" },
  { icone: "i-pencil", titulo: "Instruções", descricao: "Como o Assistente deve responder", texto: "" },
] as const;

function aoClicarAtalho(icone: string, texto: string) {
  if (texto) acoes.preencherAtalhoAssistente(texto);
  else if (icone === "i-clipboard") void acoes.alternarLembretesAssistente();
  else void acoes.alternarInstrucoesAssistente();
}

export function BoasVindas() {
  return (
    <div className="ck-assist__boas-vindas">
      <span className="ck-assist__orbe" aria-hidden="true" />
      <p className="ck-assist__saudacao">Olá! Como posso ajudar?</p>
      <p className="ck-assist__subtitulo">Escolha um atalho ou escreva sua pergunta.</p>
      <div className="ck-assist__atalhos" role="group" aria-label="Atalhos do Assistente">
        {ATALHOS.map(atalho => (
          <button key={atalho.icone} type="button" className="ck-assist__atalho" onClick={() => aoClicarAtalho(atalho.icone, atalho.texto)}>
            <span className="ck-assist__atalho-ic" aria-hidden="true"><Icone id={atalho.icone} classe="ck-ico" oculto={false} /></span>
            <span className="ck-assist__atalho-corpo">
              <span className="ck-assist__atalho-titulo">{atalho.titulo}</span>{" "}
              <span className="ck-assist__atalho-desc">{atalho.descricao}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pendente({ e }: { e: Estado }) {
  return (
    <div id="assistente-pendente" className="ck-assist__pendente" role="group" aria-labelledby="assistente-pendente-titulo" aria-describedby="assistente-pendente-descricao" tabIndex={-1} hidden={e.pendenteOculto}>
      <p id="assistente-pendente-titulo" className="ck-det__titulo">Confirmação necessária</p>
      <p id="assistente-pendente-descricao" className="ck-assist__texto">{e.pendenteDescricao}</p>
      <div className="ck-grupo-botoes">
        <button type="button" id="assistente-confirmar" className="ck-btn ck-btn--primario ck-btn--sm" disabled={e.decidirDesabilitado} onClick={() => void acoes.confirmarPendenteAssistente()}>
          Confirmar e executar
        </button>
        <button type="button" id="assistente-cancelar" className="ck-btn ck-btn--secundario ck-btn--sm" aria-keyshortcuts="Escape" disabled={e.decidirDesabilitado} onClick={() => void acoes.cancelarPendenteAssistente()}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
