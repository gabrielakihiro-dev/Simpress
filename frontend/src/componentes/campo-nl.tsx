import { useId, type InputHTMLAttributes } from "react";

// NL-Base-Formulario: campo com rótulo que flutua (placeholder=" " faz o CSS saber se há valor).
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
      <input
        {...props}
        id={id}
        className="nl-campo__inp"
        placeholder=" "
        aria-invalid={erro ? true : undefined}
        aria-describedby={erro ? idErro : undefined}
      />
      <label className="nl-campo__rot" htmlFor={id}>{rotulo}</label>
      {erro ? <span id={idErro} className="nl-campo__erro">{erro}</span> : null}
    </div>
  );
}
