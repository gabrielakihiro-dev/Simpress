import type { ReactNode } from "react";

// Cartão bento com o mesmo DOM dos painéis (ck-bento.css): a entrada escalonada usa ck-bento-d{atraso} (atraso x 80 ms).
export function CartaoBento({
  tom,
  atraso = 0,
  titulo,
  icone,
  className = "",
  children,
}: {
  tom: "ciano" | "fucsia" | "ambar" | "esmeralda";
  atraso?: number;
  titulo?: string;
  icone?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ck-bento-cartao ck-bento-secao ck-bento-d${atraso} ${className}`.trim()} data-tom={tom} data-bento-cartao="">
      <div className="ck-bento-face">
        {titulo ? (
          <div className="ck-bento-cab">
            {icone ? <span className="ck-bento-icone" aria-hidden="true">{icone}</span> : null}
            <h3 className="ck-bento-titulo">{titulo}</h3>
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}
