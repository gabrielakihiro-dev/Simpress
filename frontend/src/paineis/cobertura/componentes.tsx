// Peças repetidas das listas da Cobertura, com o mesmo DOM e as mesmas classes do painel antigo.
import { isValidElement, useRef, useState, type ReactNode } from "react";

interface BotaoProps {
  rotulo: string;
  variante: "primario" | "secundario" | "fantasma" | "perigo";
  aoClicar: () => unknown;
  rotuloAcessivel?: string;
  extra?: string;
}

// O botão fica desabilitado enquanto a ação roda; se a lista foi redesenhada, o foco volta para o painel da aba, nunca para o body.
export function Botao({ rotulo, variante, aoClicar, rotuloAcessivel, extra }: BotaoProps) {
  const [ocupado, setOcupado] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  async function clicar() {
    setOcupado(true);
    try {
      await aoClicar();
    } finally {
      setOcupado(false);
      setTimeout(() => {
        if (!ref.current?.isConnected) document.querySelector<HTMLElement>(".cob__painel:not([hidden])")?.focus();
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

// Célula vazia mostra "—"; elementos React entram como estão.
const textoDaCelula = (conteudo: unknown): ReactNode =>
  isValidElement(conteudo) ? conteudo : conteudo === undefined || conteudo === null || conteudo === "" ? "—" : String(conteudo);

export function Tabela({ rotulo, colunas, linhas, vazio }: { rotulo: string; colunas: string[]; linhas: unknown[][]; vazio: string }) {
  if (!linhas.length) return <p className="cob__vazio">{vazio}</p>;
  return (
    <table className="ck-tabela ck-tabela--cards cob__tabela" aria-label={rotulo}>
      <thead>
        <tr>{colunas.map(coluna => <th key={coluna} scope="col">{coluna}</th>)}</tr>
      </thead>
      <tbody>
        {linhas.map((celulas, n) => (
          <tr key={n}>
            {celulas.map((conteudo, i) => (
              <td key={i} data-label={colunas[i]} className={i === celulas.length - 1 ? "ck-td--largo" : undefined}>
                {textoDaCelula(conteudo)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
