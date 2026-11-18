import { iniciais, tomDoLado, type LadoResponsavel, type TomNl } from "./nl-modelo";

// NL-Responsaveis (F5): selo do lado responsável pelo chamado; o papel vai na dica e no nome acessível.
export function SeloLado({ lado, papel = "Responsável (A)" }: { lado: LadoResponsavel; papel?: string }) {
  const tom = tomDoLado(lado);
  return (
    <span className="nl-selo-lado" data-nl-tom={tom === "indigo" ? undefined : tom} title={papel} aria-label={`${papel}: ${lado}`}>
      {lado}
    </span>
  );
}

export type Responsavel = { nome: string; papel: string; tom?: TomNl };

// NL-Responsaveis: avatares sobrepostos com iniciais; foco ou passar o mouse abre o papel de cada um.
export function SeloResponsavel({ pessoas }: { pessoas: readonly Responsavel[] }) {
  return (
    <span className="nl-avs">
      {pessoas.map((p) => (
        <span
          key={`${p.nome}-${p.papel}`}
          className="nl-av"
          role="img"
          tabIndex={0}
          aria-label={`${p.nome}, ${p.papel}`}
          title={`${p.nome}, ${p.papel}`}
          data-papel={p.papel}
          data-nl-tom={p.tom && p.tom !== "indigo" ? p.tom : undefined}
        >
          {iniciais(p.nome)}
        </span>
      ))}
    </span>
  );
}
