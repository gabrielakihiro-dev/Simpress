// Diálogos do painel Lembretes (excluir e criar a partir de um termo). Quem abre e fecha é o código acessível de
// diálogos (app.abrirModalAcessivel / fecharModalAcessivel), que troca classe, role e foco no próprio DOM. Por isso as
// props do overlay e do primeiro filho são constantes: o React não pode refazer o que o código externo alterna.
import { InfoTip } from "./componentes";
import type { Estado } from "./estado";
import { aoDigitar, cancelarCriar, cancelarExclusao, confirmarCriar, confirmarExclusao } from "./lembretes-acoes";
import { LIMITE, tamanho } from "./lembretes-puro";
import { limparTexto } from "./termos-puro";

export function DialogoExcluir({ texto }: { texto: string }) {
  return (
    <div id="lembretes-confirmar" className="modal-overlay ck-veu hidden">
      <div
        className="ck-dialogo lembretes__dialogo"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lembretes-confirmar-titulo"
        aria-describedby="lembretes-confirmar-texto"
      >
        <h3 id="lembretes-confirmar-titulo">Excluir este lembrete?</h3>
        <p className="lembretes__dialogo-item" id="lembretes-confirmar-item">{texto}</p>
        <p id="lembretes-confirmar-texto">Esta ação não pode ser desfeita.</p>
        <div className="lembretes__dialogo-acoes">
          <button type="button" className="ck-btn ck-btn--secundario" id="lembretes-confirmar-cancelar" onClick={cancelarExclusao}>Cancelar</button>
          <button
            type="button"
            className="ck-btn ck-btn--secundario confirm-action-ok"
            id="lembretes-confirmar-ok"
            data-variant="danger"
            onClick={() => { void confirmarExclusao(); }}
          >
            Excluir
          </button>
        </div>
      </div>
    </div>
  );
}

export function DialogoCriar({ texto, enviando }: { texto: Estado["criarTexto"]; enviando: boolean }) {
  const n = tamanho(limparTexto(texto));
  return (
    <div id="lembretes-criar" className="modal-overlay ck-veu hidden">
      <div
        className="ck-dialogo lembretes__dialogo lembretes__dialogo--criar"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lembretes-criar-titulo"
      >
        <h3 id="lembretes-criar-titulo">Criar lembrete</h3>
        <span className="ck-rotulo-info">
          <label htmlFor="lembretes-criar-descricao">Descrição</label>
          <InfoTip rotulo="Sobre a descrição" idDica="lembretes-criar-dica">Texto montado com os dados do termo. Revise antes de criar.</InfoTip>
        </span>
        <textarea
          id="lembretes-criar-descricao"
          className="ck-entrada lembretes__criar-campo"
          rows={7}
          autoComplete="off"
          aria-describedby="lembretes-criar-dica lembretes-criar-erro"
          aria-invalid={n > LIMITE}
          value={texto}
          onChange={(e) => aoDigitar(e.target)}
        />
        <p className="lembretes__erro" id="lembretes-criar-erro" role="alert" hidden={n <= LIMITE}>{`A descrição pode ter até ${LIMITE} caracteres.`}</p>
        <div className="lembretes__dialogo-acoes">
          <button type="button" className="ck-btn ck-btn--secundario" id="lembretes-criar-cancelar" onClick={cancelarCriar}>Cancelar</button>
          <button
            type="button"
            className="ck-btn ck-btn--primario"
            id="lembretes-criar-ok"
            disabled={enviando || n === 0 || n > LIMITE}
            onClick={() => { void confirmarCriar(); }}
          >
            Criar lembrete
          </button>
        </div>
      </div>
    </div>
  );
}
