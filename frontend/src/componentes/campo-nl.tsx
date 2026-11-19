import { useId, type InputHTMLAttributes } from "react";

// NL-Base-Formulario (v43, nl-campo-rotulo-fix): rótulo fixo acima do campo; nada fica sobre o valor.
// Com erro, a borda fica vermelha e a mensagem fica ligada ao campo por aria-describedby.
export function CampoNl({
  rotulo,
  erro,
  className = "",
  ...props
}: { rotulo: string; erro?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder">) {
  const id = useId();
  const idErro = `${id}-erro`;
  return (
    <div className={`nl-campo ${className}`.trim()} data-erro={erro ? "" : undefined}>
      <label className="nl-campo__rot" htmlFor={id}>{rotulo}</label>
      <input
        {...props}
        id={id}
        className="nl-campo__inp"
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? idErro : undefined}
      />
      {erro ? <span id={idErro} className="nl-campo__erro">{erro}</span> : null}
    </div>
  );
}
