// Assinatura por nome em SVG inline (prévia da Configuração local e folha do Termo). O viewBox representa a área livre
// acima da linha do bloco; o CSS (static/styles/ck-termos.css, .tp__assinatura-texto) o apoia sobre a linha e ele escala
// junto com o bloco (zoom da prévia e impressão). Sem clip: tudo cabe no viewBox pela medida (assinatura-medida.ts).
import { AREA, FAMILIAS, type EstiloTexto, textoDaAssinatura, type MedidaAssinatura } from "./assinatura-medida";

export function AssinaturaTexto({ nome, estilo, medida }: { nome: string; estilo: EstiloTexto; medida: MedidaAssinatura }) {
  return (
    <svg className="tp__assinatura-texto" viewBox={`0 ${-AREA.subida} ${AREA.largura} ${AREA.subida + AREA.descida}`}
      aria-hidden="true" focusable="false" data-estilo={estilo} data-tamanho={medida.tamanho} data-x={medida.x} data-y={medida.y}>
      <text x={medida.x} y={medida.y} fontFamily={`"${FAMILIAS[estilo]}"`} fontWeight={400} fontSize={medida.tamanho}
        fill="currentColor" textRendering="geometricPrecision">{textoDaAssinatura(nome, estilo)}</text>
    </svg>
  );
}
