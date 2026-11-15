import { useSyncExternalStore } from "react";
import {
  assinar, conferirChamadoUX, editarProblema, editarSolicitante, executarChamadoUX, fecharChamadoUX, ler, type Solicitante,
} from "./estado";

const CAMPOS: { campo: keyof Solicitante; id: string; rotulo: string; tipo: string; max: number }[] = [
  { campo: "nome", id: "ux-solicitante-nome", rotulo: "Nome", tipo: "text", max: 200 },
  { campo: "email", id: "ux-solicitante-email", rotulo: "E-mail", tipo: "email", max: 200 },
  { campo: "telefone", id: "ux-solicitante-telefone", rotulo: "Telefone", tipo: "tel", max: 40 },
  { campo: "departamento_cargo", id: "ux-solicitante-cargo", rotulo: "Departamento/Cargo", tipo: "text", max: 200 },
];

// Mesmo HTML do modal antigo (IDs, classes e ARIA). .ck-dialogo é o primeiro filho do overlay
// #modal-chamado-ux: accessible-dialogs.js põe role=dialog e a classe modal-panel nele, por isso o className é fixo.
export function DialogoChamadoUX() {
  const s = useSyncExternalStore(assinar, ler);
  const bloqueado = s.ocupado || !s.preparado;
  const titulo = s.pronto ? "" : s.motivo;
  return (
    <div className="ck-dialogo">
      <h3 id="titulo-chamado-ux" className="text-base font-bold">Abrir chamado no UX</h3>
      <p>Série: <strong id="ux-chamado-serie">{s.serie}</strong> · Modelo: <strong id="ux-chamado-modelo">{s.modelo}</strong></p>
      <label htmlFor="ux-chamado-problema">Problema</label>
      <select id="ux-chamado-problema" className="ck-input" value={s.problema} disabled={bloqueado}
        aria-busy={s.ocupado} onChange={evento => editarProblema(evento.target.value)}>
        {s.opcoes.length > 0 && <option value="">Escolha um problema</option>}
        {s.opcoes.map(opcao => <option key={opcao} value={opcao}>{opcao}</option>)}
      </select>
      <fieldset id="ux-chamado-solicitante" className="ux-chamado-solicitante" disabled={bloqueado}>
        <legend className="font-bold">Solicitante</legend>
        {CAMPOS.map(({ campo, id, rotulo, tipo, max }) => [
          <label key={id + "-rotulo"} htmlFor={id}>{rotulo}</label>,
          <input key={id} type={tipo} id={id} className="ck-input" maxLength={max} autoComplete="off"
            value={s.solicitante[campo]} onChange={evento => editarSolicitante(campo, evento.target.value)} />,
        ])}
      </fieldset>
      <p className="font-bold">Descrição</p>
      <div id="ux-chamado-descricao">{s.descricao}</div>
      <p id="ux-chamado-status" role="status">{s.status}</p>
      <p id="ux-chamado-motivo" className="font-bold" hidden={!s.motivo}>{s.motivo}</p>
      <div className="pt-4 border-t border-line-quiet flex flex-wrap justify-end gap-2">
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-chamado-fechar" onClick={fecharChamadoUX}>Fechar</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-chamado-conferido" onClick={() => void conferirChamadoUX()} hidden={!s.conferido}>Conferi no UX; preparar de novo</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-chamado-simular" onClick={() => void executarChamadoUX(false)} aria-describedby="ux-chamado-motivo" disabled={!s.pronto} title={titulo}>Simular preenchimento</button>
        <button type="button" className="ck-btn ck-btn--primario" id="ux-chamado-enviar" onClick={() => void executarChamadoUX(true)} aria-describedby="ux-chamado-motivo" disabled={!s.pronto} title={titulo}>Revisar e enviar</button>
      </div>
    </div>
  );
}
