// Mini-lista do histórico no cartão "Chamados novos do SoftExpert". Mesmas classes e textos da versão antiga
// em JS puro (antigo frontend/src/legado/features/sebrae-historico.js até a migração do G1); o React desenha só os filhos do host.
import { useSyncExternalStore } from "react";
import { assinar, dataHora, ler, resumoEntrada, rotuloTipo, textoRepeticoes } from "./estado";

export function ResumoHistorico() {
  const estado = useSyncExternalStore(assinar, ler);
  if (!estado) return null;
  if ("erro" in estado) return <p className="ck-campo__ajuda">{estado.erro}</p>;
  if (!estado.itens.length) return <p className="ck-campo__ajuda">Nenhuma importação registrada ainda.</p>;
  return (
    <>
      <p className="ck-campo__rotulo">Últimos registros do histórico</p>
      <ul className="sebrae-historico-mini">
        {estado.itens.map((item, indice) => (
          <li key={indice}>
            <span className="sebrae-historico-mini__quando">{dataHora(item.em)}</span>
            <span className="ck-badge" data-status={item.tipo === "busca" ? "alerta" : undefined}>{rotuloTipo(item.tipo)}</span>
            <span className="sebrae-historico-mini__texto">{[resumoEntrada(item), textoRepeticoes(item)].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
