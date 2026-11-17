import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import {
  abrirEmailNoOutlook, assinar, copiarTextoEmail, duplicarModeloEmail, editarCampo, editarEnvio, enviarEmailPeloOutlook, enterSalva,
  escolherModelo, escolherOpcao, excluirModeloEmail, fecharEmailOutlook, inserir, ler, novoModeloEmail, restaurarModeloEmail,
  sairDoCombo, salvarAgora, teclaCombo, type CampoCombo,
} from "./estado";
import { TEXTO, rotuloConta, rotuloContato } from "./regras-puro";

function DicaInfo({ rotulo, idDica, children }: { rotulo: string; idDica: string; children: ReactNode }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-trigger" aria-label={rotulo} aria-describedby={idDica}>
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg>
      </button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}

// Para e Cc: campo de texto com lista de sugestões do Entra (combobox ARIA) e a caixa "qual pessoa?".
function CampoContato({ campo, rotulo }: { campo: CampoCombo; rotulo: string }) {
  const s = useSyncExternalStore(assinar, ler);
  const combo = s.combos[campo];
  const idAtivo = combo.aberta && combo.itens[combo.ativo] ? `email-${campo}-opcao-${combo.ativo}` : undefined;
  useLayoutEffect(() => {
    if (idAtivo) document.getElementById(idAtivo)?.scrollIntoView?.({ block: "nearest" });
  }, [idAtivo]);
  return (
    <div className="ck-campo email-outlook__combo">
      <label className="ck-campo__rotulo" id={`email-${campo}-rotulo`} htmlFor={`email-${campo}`}>{rotulo}</label>
      <input type="text" id={`email-${campo}`} className="ck-entrada" role="combobox" aria-autocomplete="list" aria-expanded={combo.aberta}
        aria-controls={`email-${campo}-lista`} aria-activedescendant={idAtivo} autoComplete="off" spellCheck={false} maxLength={1000}
        disabled={!s.pronto} value={s[campo]} onChange={evento => editarCampo(campo, evento.target.value)}
        onKeyDown={evento => teclaCombo(campo, evento)} onBlur={() => sairDoCombo(campo)} />
      <ul id={`email-${campo}-lista`} className="email-outlook__lista" role="listbox" aria-labelledby={`email-${campo}-rotulo`}
        hidden={!combo.aberta}>
        {combo.aberta && combo.itens.map((contato, indice) => (
          // O mousedown não tira o foco do campo; sem isso o clique seria precedido de um blur.
          <li key={indice} id={`email-${campo}-opcao-${indice}`} className="email-outlook__opcao" role="option" aria-selected={indice === combo.ativo}
            onMouseDown={evento => evento.preventDefault()} onClick={() => inserir(campo, contato)}>{rotuloContato(contato)}</li>
        ))}
        {combo.aberta && !combo.itens.length && <li className="email-outlook__opcao" role="option" aria-disabled="true">{TEXTO.semContato}</li>}
      </ul>
      <div id={`email-${campo}-opcoes`} className="email-outlook__opcoes" hidden={!combo.ambiguos.length}>
        {combo.ambiguos.map(item => (
          <div key={item.token} className="email-outlook__pergunta">
            <p>{`Escolha o destinatário certo para "${item.token}":`}</p>
            <div className="email-outlook__botoes">
              {item.opcoes.map((contato, indice) => (
                <button key={indice} type="button" className="ck-btn ck-btn--secundario ck-btn--sm"
                  onClick={() => escolherOpcao(campo, item.token, contato)}>{rotuloContato(contato)}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Mesmo HTML do modal antigo (IDs, classes e ARIA). .ck-dialogo é o primeiro filho do overlay #modal-email-outlook:
// accessible-dialogs.ts põe role=dialog e a classe modal-panel nele, por isso o className é fixo.
export function DialogoEmailOutlook() {
  const s = useSyncExternalStore(assinar, ler);
  const livre = !s.pronto; // campos livres seguem editáveis durante uma ação; os controles de ação não
  const travado = !s.pronto || s.ocupado;
  return (
    <div className="ck-dialogo email-outlook">
      <h3 className="text-base font-bold">
        <span id="titulo-email-outlook">E-mail pelo Outlook</span>{" "}
        <DicaInfo rotulo="Sobre E-mail pelo Outlook" idDica="email-ajuda-autosave">As alterações no modelo são salvas automaticamente.</DicaInfo>
      </h3>
      <p id="email-aviso-diretorio" className="email-outlook__aviso" role="status" hidden={!s.semDiretorio}>A base do Microsoft Entra não foi importada; digite o e-mail completo.</p>
      <div className="email-outlook__modelo">
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="email-modelo">Modelo</label>
          <select id="email-modelo" className="ck-entrada" disabled={travado} value={s.modeloSelecionado}
            onChange={evento => escolherModelo(evento.target.value)}>
            {s.modelos.map(modelo => <option key={modelo.id} value={modelo.id}>{modelo.nome}</option>)}
          </select>
        </div>
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="email-modelo-nome">Nome do modelo</label>
          <input type="text" id="email-modelo-nome" className="ck-entrada" maxLength={80} autoComplete="off" disabled={livre}
            value={s.nome} onChange={evento => editarCampo("nome", evento.target.value)} onKeyDown={enterSalva} onBlur={salvarAgora} />
        </div>
      </div>
      <div className="ck-grupo-botoes">
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="email-modelo-novo" disabled={travado}
          onClick={() => void novoModeloEmail()}>Novo modelo</button>
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="email-modelo-duplicar" disabled={travado}
          onClick={() => void duplicarModeloEmail()}>Duplicar modelo</button>
        <button type="button" className="ck-btn ck-btn--perigo ck-btn--sm" id="email-modelo-excluir" disabled={travado}
          onClick={() => void excluirModeloEmail()}>Excluir modelo</button>
        <button type="button" className="ck-btn ck-btn--secundario ck-btn--sm" id="email-modelo-restaurar" hidden={!s.restaurarVisivel}
          disabled={travado} onClick={() => void restaurarModeloEmail()}>Restaurar padrão</button>
      </div>
      <div className="ck-campo">
        <label className="ck-campo__rotulo" htmlFor="email-conta">Enviar de</label>
        <select id="email-conta" className="ck-entrada" disabled={livre} value={s.conta} onChange={evento => editarCampo("conta", evento.target.value)}>
          {s.contas.map(conta => <option key={conta.id} value={conta.id}>{rotuloConta(conta)}</option>)}
        </select>
      </div>
      <CampoContato campo="para" rotulo="Para" />
      <CampoContato campo="cc" rotulo="Cc" />
      <div className="ck-campo">
        <label className="ck-campo__rotulo" htmlFor="email-assunto">Assunto</label>
        <input type="text" id="email-assunto" className="ck-entrada" maxLength={200} autoComplete="off" aria-describedby="email-ajuda-marcadores"
          disabled={livre} value={s.assunto} onChange={evento => editarCampo("assunto", evento.target.value)} onKeyDown={enterSalva} onBlur={salvarAgora} />
      </div>
      <div className="ck-campo">
        <span className="ck-rotulo-info">
          <label className="ck-campo__rotulo" htmlFor="email-corpo">Mensagem</label>
          <DicaInfo rotulo="Sobre os marcadores" idDica="email-ajuda-marcadores">{"Use {nome} e {setor} no assunto ou na mensagem para preencher com os campos Nome da pessoa e Setor."}</DicaInfo>
        </span>
        <textarea id="email-corpo" className="ck-entrada email-outlook__corpo" rows={6} maxLength={4000} aria-describedby="email-ajuda-marcadores"
          disabled={livre} value={s.corpo} onChange={evento => editarCampo("corpo", evento.target.value)} onBlur={salvarAgora} />
      </div>
      <div className="email-outlook__envio">
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="email-nome-pessoa">Nome da pessoa</label>
          <input type="text" id="email-nome-pessoa" className="ck-entrada" maxLength={200} autoComplete="off" disabled={livre}
            value={s.nomePessoa} onChange={evento => editarEnvio("nomePessoa", evento.target.value)} />
        </div>
        <div className="ck-campo">
          <label className="ck-campo__rotulo" htmlFor="email-setor">Setor</label>
          <input type="text" id="email-setor" className="ck-entrada" maxLength={200} autoComplete="off" disabled={livre}
            value={s.setor} onChange={evento => editarEnvio("setor", evento.target.value)} />
        </div>
      </div>
      <p id="email-autosave-status" className="email-outlook__autosave" role="status" aria-live="polite" data-estado={s.autosaveErro ? "erro" : ""}>{s.autosave}</p>
      <p id="email-status" className="email-outlook__status" role="status" aria-live="polite" hidden={!s.status} data-tipo={s.statusTipo}>{s.status}</p>
      <div className="pt-4 border-t border-line-quiet flex flex-wrap justify-end gap-2">
        <button type="button" className="ck-btn ck-btn--secundario" id="email-cancelar" onClick={() => void fecharEmailOutlook()}>Cancelar</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="email-copiar" disabled={travado} onClick={() => void copiarTextoEmail()}>Copiar Texto</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="email-abrir" disabled={travado} onClick={() => void abrirEmailNoOutlook()}>Abrir no Outlook</button>
        <button type="button" className="ck-btn ck-btn--primario" id="email-enviar" disabled={travado} onClick={() => void enviarEmailPeloOutlook()}>Enviar pelo Outlook</button>
      </div>
    </div>
  );
}
