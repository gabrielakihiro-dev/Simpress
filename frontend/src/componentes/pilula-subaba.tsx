import { useLayoutEffect, useRef } from "react";

// Sub-abas em pílula do Novo layout: a marca desliza até o botão ativo (posição medida, sem animar largura em CSS).
export function PilulaSubaba<T extends string>({
  rotulo,
  opcoes,
  valor,
  aoMudar,
}: {
  rotulo: string;
  opcoes: readonly { valor: T; rotulo: string }[];
  valor: T;
  aoMudar: (valor: T) => void;
}) {
  const grupo = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = grupo.current;
    if (!el) return;
    // Mede de novo quando a largura muda (fonte carregada, janela redimensionada).
    const medir = () => {
      const ativo = el.querySelector<HTMLButtonElement>('.nl-subaba[aria-pressed="true"]');
      if (!ativo) return;
      el.style.setProperty("--nl-x", `${ativo.offsetLeft}px`);
      el.style.setProperty("--nl-w", `${ativo.offsetWidth}px`);
      el.dataset.pronta = "";
    };
    medir();
    const obs = new ResizeObserver(medir);
    obs.observe(el);
    return () => obs.disconnect();
  }, [valor, opcoes]);

  return (
    <div ref={grupo} className="nl-subabas" role="group" aria-label={rotulo}>
      <span className="nl-subabas__marca" aria-hidden="true" />
      {opcoes.map((o) => (
        <button key={o.valor} type="button" className="nl-subaba" aria-pressed={o.valor === valor} onClick={() => aoMudar(o.valor)}>
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
