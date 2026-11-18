import { useEffect, useRef } from "react";
import { duracaoToast, type TipoToast } from "./nl-modelo";

export type AvisoToast = { id: string; tipo: TipoToast; texto: string };

// Avisos rápidos do Novo layout no canto inferior direito (no celular, largura toda). Somem sozinhos.
export function Toasts({ avisos, aoFechar }: { avisos: readonly AvisoToast[]; aoFechar: (id: string) => void }) {
  return (
    <div className="nl-toasts" role="status" aria-live="polite">
      {avisos.map((a) => <Toast key={a.id} aviso={a} aoFechar={aoFechar} />)}
    </div>
  );
}

function Toast({ aviso, aoFechar }: { aviso: AvisoToast; aoFechar: (id: string) => void }) {
  // aoFechar em ref: um pai que recria a função a cada render não reinicia o prazo do aviso.
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;
  useEffect(() => {
    const t = window.setTimeout(() => fechar.current(aviso.id), duracaoToast(aviso.tipo));
    return () => window.clearTimeout(t);
  }, [aviso.id, aviso.tipo]);

  return (
    <div className="nl-toast" data-tipo={aviso.tipo}>
      <span>{aviso.texto}</span>
      <button type="button" className="nl-toast__fechar" aria-label="Fechar aviso" onClick={() => aoFechar(aviso.id)}>
        <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
      </button>
    </div>
  );
}
