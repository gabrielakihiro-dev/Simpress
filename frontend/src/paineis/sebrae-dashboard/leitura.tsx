import { useLayoutEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { chipsLeitura, type LojaLeitura } from "./leitura-loja";

// Chips da última leitura dos antigos: o esqueleto (ícones, botão, popover e os espaços do HTML) fica no partial; o React
// preenche por portal só os textos e a lista de falhas, e põe hidden e aria-expanded por efeito, com o mesmo DOM de antes.
export interface AlvosLeitura {
  grupo: HTMLElement; hora: HTMLElement; horaTexto: HTMLElement; lidos: HTMLElement; falhas: HTMLElement; botao: HTMLElement;
  botaoTexto: HTMLElement; popover: HTMLElement; lista: HTMLElement; semUtic: HTMLElement;
}

export function ChipsLeitura({ alvos, loja }: { alvos: AlvosLeitura; loja: LojaLeitura }) {
  const { resultado, falhasAbertas } = useSyncExternalStore(loja.assinar, loja.ler);
  const c = chipsLeitura(resultado);
  useLayoutEffect(() => {
    alvos.grupo.hidden = !resultado;
    alvos.hora.hidden = !c.hora;
    alvos.lidos.hidden = !c.lidos;
    alvos.falhas.hidden = !c.textoFalhas;
    alvos.semUtic.hidden = !c.semUtic;
    alvos.lista.hidden = c.falhas.length === 0;
    alvos.popover.hidden = !falhasAbertas;
    alvos.botao.setAttribute("aria-expanded", String(falhasAbertas));
  });
  return (
    <>
      {createPortal(c.hora, alvos.horaTexto)}
      {createPortal(c.lidos, alvos.lidos)}
      {createPortal(c.textoFalhas, alvos.botaoTexto)}
      {/* UTIC e motivo em dois spans: o texto continua "UTIC: motivo" para quem lê, e o CSS põe um embaixo do outro */}
      {createPortal(c.falhas.map(([numero, motivo]) => (
        <li key={numero}><span className="sebrae-falha__utic">{numero}</span>: <span className="sebrae-falha__motivo">{motivo}</span></li>
      )), alvos.lista)}
      {createPortal(c.semUtic, alvos.semUtic)}
    </>
  );
}
