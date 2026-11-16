import type { ReactNode } from "react";

// Dica "i" ao lado de um título ou campo, com o mesmo DOM do markup antigo (testada em tests/e2e/info-tips-todos.spec.cjs).
// `fim` alinha o balão pela direita (classe info-tip--end), para dicas perto da borda do diálogo.
export function InfoTip({ rotulo, idDica, fim = false, children }: { rotulo: string; idDica: string; fim?: boolean; children: ReactNode }) {
  return (
    <span className={fim ? "info-tip info-tip--end" : "info-tip"}>
      <button type="button" className="info-tip-trigger" aria-label={rotulo} aria-describedby={idDica}>
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg>
      </button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}
