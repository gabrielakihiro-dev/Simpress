import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import {
  assinar, confirmarEnderecoTicketUX, conferirTicketUX, editarChamadoInterno, editarRegistro, editarSolicitante, escolherEndereco,
  executarTicketUX, fecharTicketUX, ler, prepararNovamenteTicketUX, type CampoSolicitante,
} from "./estado";
import { ENDERECO, PLACEHOLDER, REGISTRO_MAX, rotuloCancelar } from "./regras-puro";

const CAMPOS: { campo: CampoSolicitante; id: string; rotulo: string; tipo: string; max: number }[] = [
  { campo: "nome", id: "ux-ticket-nome", rotulo: "Nome", tipo: "text", max: 100 },
  { campo: "email", id: "ux-ticket-email", rotulo: "E-mail", tipo: "email", max: 100 },
  { campo: "telefone", id: "ux-ticket-telefone", rotulo: "Contato", tipo: "tel", max: 40 },
];

// Mesmo HTML do modal antigo (IDs, classes e ARIA). .ck-dialogo é o primeiro filho do overlay
// #modal-ticket-ux: accessible-dialogs.ts põe role=dialog e a classe modal-panel nele, por isso o className é fixo.
export function DialogoTicketUX() {
  const s = useSyncExternalStore(assinar, ler);
  const endereco = s.tipo === ENDERECO;
  const editavel = s.temSessao && !s.ocupado;
  const titulo = s.pronto ? "" : s.motivo;
  const registro = useRef<HTMLTextAreaElement>(null);
  const invalido = s.existe && PLACEHOLDER.test(s.registro);
  // Sem lista de dependências de propósito: o ui-motion.ts tira aria-invalid a cada digitação e, como no módulo antigo, toda atualização o repõe.
  useLayoutEffect(() => { registro.current?.setAttribute("aria-invalid", String(invalido)); });
  return (
    <div className="ck-dialogo">
      <h3 id="titulo-ticket-ux" className="text-base font-bold">{endereco ? "Gerar ticket no UX" : "Alterar Endereço no UX"}</h3>
      <p id="ux-ticket-status" role="status" aria-live="polite"><strong id="ux-ticket-estado">{s.estadoTitulo}</strong><span id="ux-ticket-status-detalhe">{s.estadoDetalhe}</span></p>
      <p id="ux-ticket-erro" className="ux-ticket-erro" role="alert" hidden={!s.erro}>{s.erro}</p>
      <p id="ux-ticket-ultimo-envio" className="ux-ticket-aviso" hidden={!s.avisoUltimoEnvio}>{s.avisoUltimoEnvio}</p>
      <dl className="ux-ticket-resumo">
        <dt>Série</dt><dd id="ux-ticket-serie">{s.resumo.serie}</dd>
        <dt>Modelo</dt><dd id="ux-ticket-modelo">{s.resumo.modelo}</dd>
        <dt hidden={endereco}>Endereço escolhido</dt><dd id="ux-ticket-endereco" hidden={endereco}>{s.resumo.endereco}</dd>
        <dt hidden={endereco}>CNPJ de Instalação</dt><dd id="ux-ticket-cnpj-instalacao" hidden={endereco}>{s.resumo.cnpjInstalacao}</dd>
        <dt hidden={endereco}>CNPJ de Faturamento</dt><dd id="ux-ticket-cnpj-faturamento" hidden={endereco}>{s.resumo.cnpjFaturamento}</dd>
        <dt hidden={endereco}>Anexo</dt><dd id="ux-ticket-anexo" hidden={endereco}>{s.resumo.anexo}</dd>
      </dl>
      <fieldset id="ux-ticket-enderecos" className="ux-ticket-enderecos" hidden={!s.ambiguo} disabled={!editavel}>
        <legend className="font-bold">Escolha o endereço</legend>
        <div id="ux-ticket-enderecos-lista" className="ux-ticket-enderecos__lista">
          {s.opcoes.map((texto, indice) => (
            <label key={indice} className="ux-ticket-opcao">
              <input type="radio" name="ux-ticket-endereco" id={"ux-ticket-endereco-" + indice} value={texto}
                checked={s.enderecoEscolhido === texto} onChange={() => escolherEndereco(texto)} />
              {" " + texto}
            </label>
          ))}
        </div>
        <p id="ux-ticket-enderecos-vazio" hidden={!s.ambiguo || s.opcoes.length > 0}>O UX não listou nenhum endereço para este CEP. Cadastre o endereço em Meus Endereços no UX e use Preparar novamente.</p>
        <div className="flex justify-end">
          <button type="button" className="ck-btn ck-btn--secundario" id="ux-ticket-confirmar-endereco" onClick={() => void confirmarEnderecoTicketUX()}
            disabled={!editavel || !s.enderecoEscolhido}>Confirmar endereço</button>
        </div>
      </fieldset>
      <fieldset id="ux-ticket-formulario" className="ux-ticket-formulario" aria-busy={s.ocupado}
        disabled={!s.existe || (s.ocupado && !s.preparando) || s.concluido}>
        <legend className="sr-only">Dados do ticket</legend>
        <label htmlFor="ux-ticket-registro" className="font-bold">Registro</label>
        <textarea id="ux-ticket-registro" className="ck-input ux-ticket-registro" rows={10} maxLength={REGISTRO_MAX}
          aria-describedby="ux-ticket-registro-contador"
          ref={registro} value={s.registro} onChange={evento => editarRegistro(evento.target.value)} />
        <p id="ux-ticket-registro-contador" className="ux-ticket-contador">{s.registro.length + "/" + REGISTRO_MAX}</p>
        <div id="ux-ticket-solicitante" className="ux-chamado-solicitante" role="group" aria-labelledby="ux-ticket-solicitante-titulo">
          <p id="ux-ticket-solicitante-titulo" className="font-bold ux-chamado-solicitante__titulo">Solicitante</p>
          {CAMPOS.map(({ campo, id, rotulo, tipo, max }) => [
            <label key={id + "-rotulo"} htmlFor={id}>{rotulo}</label>,
            <input key={id} type={tipo} id={id} className="ck-input" maxLength={max} autoComplete="off"
              value={s[campo]} onChange={evento => editarSolicitante(campo, evento.target.value)} />,
          ])}
          <label htmlFor="ux-ticket-chamado-interno" hidden={endereco}>Nº de chamado interno</label>
          <input type="text" id="ux-ticket-chamado-interno" className="ck-input" maxLength={10} autoComplete="off" placeholder="Opcional"
            hidden={endereco} value={s.chamadoInterno} onChange={evento => editarChamadoInterno(evento.target.value)} />
        </div>
      </fieldset>
      <p id="ux-ticket-motivo" className="ux-ticket-aviso" hidden={!s.motivo}>{s.motivo}</p>
      <div className="pt-4 border-t border-line-quiet flex flex-wrap justify-end gap-2">
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-ticket-cancelar" onClick={() => fecharTicketUX()}
          disabled={s.enviando}>{rotuloCancelar(s.temSessao, s.ocupado, s.enviando)}</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-ticket-preparar" onClick={() => void prepararNovamenteTicketUX()}
          hidden={s.ocupado || !s.falha || s.incerto}>Preparar novamente</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-ticket-conferido" onClick={() => void conferirTicketUX()}
          hidden={s.ocupado || !s.incerto}>Conferi no UX; preparar de novo</button>
        <button type="button" className="ck-btn ck-btn--secundario" id="ux-ticket-simular" onClick={() => void executarTicketUX(false)}
          aria-describedby="ux-ticket-motivo" disabled={!s.pronto} title={titulo}>Simular preenchimento</button>
        <button type="button" className="ck-btn ck-btn--primario" id="ux-ticket-finalizar" onClick={() => void executarTicketUX(true)}
          aria-describedby="ux-ticket-motivo" disabled={!s.pronto} title={titulo}>Revisar e finalizar</button>
      </div>
    </div>
  );
}
