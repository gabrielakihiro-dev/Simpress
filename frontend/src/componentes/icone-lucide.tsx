import { createElement } from "react";
import { Check, Cpu, LoaderCircle, Plus, Search, SquarePen, X, type IconNode } from "lucide";

// Ícone lucide desenhado pelo React: o mesmo <svg> que lucide.createIcons() gera no lugar de <i data-lucide="...">.
// Sem data-lucide de propósito: o createIcons({ root: modal }) de abrirModalAcessivel trocaria este <svg> por outro.
// Nomes são os do markup antigo; "edit" e "loader-2" são os nomes antigos de SquarePen e LoaderCircle e a classe
// gerada continua lucide-edit e lucide-loader-2.
const NOS = {
  x: X,
  search: Search,
  plus: Plus,
  check: Check,
  edit: SquarePen,
  cpu: Cpu,
  "loader-2": LoaderCircle,
} satisfies Record<string, IconNode>;

export type NomeIcone = keyof typeof NOS;

export function IconeLucide({ nome, className }: { nome: NomeIcone; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ? `lucide lucide-${nome} ${className}` : `lucide lucide-${nome}`}
    >
      {NOS[nome].map(([tag, atributos], indice) => createElement(tag, { key: indice, ...atributos }))}
    </svg>
  );
}
