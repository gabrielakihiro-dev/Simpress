// Peças repetidas do painel Lembretes e Termos, com o mesmo DOM e as mesmas classes do painel antigo.
import type { ReactNode } from "react";

// Dica "i" ao lado de um título ou botão (testada em tests/e2e/info-tips-ferramentas.spec.cjs).
export function InfoTip({ rotulo, idDica, children }: { rotulo: string; idDica: string; children: ReactNode }) {
  return (
    <span className="info-tip">
      <button type="button" className="info-tip-trigger" aria-label={rotulo} aria-describedby={idDica}>
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg>
      </button>
      <span id={idDica} role="tooltip" className="info-tip-text">{children}</span>
    </span>
  );
}

// Ícone do sprite do index.html (#i-<nome>).
export function IconeSprite({ nome, classe = "ck-ico" }: { nome: string; classe?: string }) {
  return <svg className={classe} aria-hidden="true"><use href={`#i-${nome}`} /></svg>;
}

// Calendário, mais e fechar: o sprite não traz estes desenhos; SVG próprio só com currentColor.
function Desenho({ tamanho, children }: { tamanho: number; children: ReactNode }) {
  return (
    <svg
      className="lembretes__ico"
      width={tamanho}
      height={tamanho}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconeCalendario = ({ tamanho }: { tamanho: number }) => (
  <Desenho tamanho={tamanho}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></Desenho>
);
export const IconeMais = ({ tamanho }: { tamanho: number }) => <Desenho tamanho={tamanho}><path d="M12 5v14M5 12h14" /></Desenho>;
export const IconeFechar = ({ tamanho }: { tamanho: number }) => <Desenho tamanho={tamanho}><path d="M18 6 6 18M6 6l12 12" /></Desenho>;
