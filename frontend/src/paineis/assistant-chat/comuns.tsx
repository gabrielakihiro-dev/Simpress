import type { ReactNode } from "react";

// Ícone do sprite do index.html (<symbol id="i-...">); decorativo por padrão (aria-hidden), como no HTML antigo.
export function Icone({ id, classe = "ck-ico ck-ico--sm", oculto = true }: { id: string; classe?: string; oculto?: boolean }) {
  return (
    <svg className={classe} aria-hidden={oculto ? "true" : undefined} focusable="false">
      <use href={`#${id}`} />
    </svg>
  );
}

// Dica "i" do tema (ux-enhancements.js abre e fecha por delegação de eventos; não precisa registrar nada aqui).
export function InfoTip({ idDica, rotulo, children }: { idDica: string; rotulo: string; children: ReactNode }) {
  return (
    <span className="info-tip info-tip--bloco">
      <button type="button" className="info-tip-trigger" aria-label={`Sobre ${rotulo}`} aria-describedby={idDica}>
        <Icone id="i-info" />
      </button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}

export function BotaoVoltar({ id, aoClicar }: { id?: string; aoClicar: () => void }) {
  return (
    <button type="button" id={id} className="ck-btn ck-btn--fantasma ck-btn--sm ck-assist__voltar" onClick={aoClicar}>
      <Icone id="i-arrow-left" />
      Voltar à conversa
    </button>
  );
}
