import { useEffect, useId, useRef, type ReactNode } from "react";

// Folha do Novo layout: gaveta à direita no desktop, folha que sobe de baixo no celular.
// Esc ou clique no véu fecham; o foco entra na folha ao abrir e volta para quem a abriu ao fechar.
export function FolhaInferior({
  aberta,
  titulo,
  aoFechar,
  children,
}: {
  aberta: boolean;
  titulo: string;
  aoFechar: () => void;
  children: ReactNode;
}) {
  const idTitulo = useId();
  const folha = useRef<HTMLDivElement>(null);
  // aoFechar em ref: um pai que recria a função a cada render não rouba o foco de volta para a folha.
  const fechar = useRef(aoFechar);
  fechar.current = aoFechar;

  useEffect(() => {
    if (!aberta) return;
    const anterior = document.activeElement as HTMLElement | null;
    folha.current?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar.current();
      if (e.key !== "Tab" || !folha.current) return;
      // aria-modal: o Tab dá a volta dentro da folha, sem cair na página de trás.
      const focaveis = folha.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (!primeiro || !ultimo) return;
      const ativo = document.activeElement;
      if (e.shiftKey && (ativo === primeiro || ativo === folha.current)) {
        e.preventDefault();
        ultimo.focus();
      } else if (!e.shiftKey && (ativo === ultimo || !folha.current.contains(ativo))) {
        e.preventDefault();
        primeiro.focus();
      }
    };
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("keydown", tecla);
      anterior?.focus?.();
    };
  }, [aberta]);

  if (!aberta) return null;
  return (
    <>
      <div className="nl-veu" aria-hidden="true" onClick={aoFechar} />
      <div ref={folha} className="nl-folha" role="dialog" aria-modal="true" aria-labelledby={idTitulo} tabIndex={-1}>
        <div className="nl-folha__cab">
          <h2 id={idTitulo} className="nl-folha__titulo">{titulo}</h2>
          <button type="button" className="nl-folha__fechar" aria-label="Fechar" onClick={aoFechar}>
            <svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-x" /></svg>
          </button>
        </div>
        <div className="nl-folha__corpo">{children}</div>
      </div>
    </>
  );
}
