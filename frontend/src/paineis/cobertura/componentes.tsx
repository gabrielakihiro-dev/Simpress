// Peças repetidas das listas da Cobertura, com o mesmo DOM e as mesmas classes do painel antigo.
import { useRef, useState, type ReactNode } from "react";

interface BotaoProps {
  rotulo: string;
  variante: "primario" | "secundario" | "fantasma" | "perigo";
  aoClicar: () => unknown;
  rotuloAcessivel?: string;
  extra?: string;
}

// O botão fica desabilitado enquanto a ação roda; se a lista foi redesenhada, o foco vai para a folha aberta (o título do painel fica atrás do véu) ou, sem folha, para o título do painel; nunca para o body.
export function Botao({ rotulo, variante, aoClicar, rotuloAcessivel, extra }: BotaoProps) {
  const [ocupado, setOcupado] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  async function clicar() {
    const folha = ref.current?.closest<HTMLElement>(".nl-folha");
    setOcupado(true);
    try {
      await aoClicar();
    } finally {
      setOcupado(false);
      setTimeout(() => {
        if (ref.current?.isConnected) return;
        if (folha?.isConnected) {
          if (!folha.hasAttribute("tabindex")) folha.tabIndex = -1;
          folha.focus();
        } else {
          document.getElementById("cobertura-heading")?.focus();
        }
      });
    }
  }
  return (
    <button
      ref={ref}
      type="button"
      className={`ck-btn ck-btn--${variante} ck-btn--sm${extra ? ` ${extra}` : ""}`}
      aria-label={rotuloAcessivel || undefined}
      disabled={ocupado}
      onClick={clicar}
    >
      {rotulo}
    </button>
  );
}

export function Selo({ texto, status }: { texto: string; status: string }) {
  return <span className="ck-badge" data-status={status}>{texto}</span>;
}

export function Campo({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <label className="ck-campo">
      <span className="ck-campo__rotulo">{rotulo}</span>
      {children}
    </label>
  );
}

export function Grupo({ classe, children }: { classe: string; children?: ReactNode }) {
  return <div className={classe}>{children}</div>;
}
