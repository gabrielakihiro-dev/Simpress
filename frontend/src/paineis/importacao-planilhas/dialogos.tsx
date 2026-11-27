import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconeLucide } from "../../componentes/icone-lucide";
import { InfoTip } from "../../componentes/info-tip";
import { assinar, definirExportarHistorico, ler } from "./estado";

// Conteúdo dos dois modais de importação, com o mesmo DOM do markup antigo (IDs, classes, ARIA, data-*). Os overlays
// #modal-atualizar-planilhas e #modal-importar-modelo ficam no partial (frontend/partials/modais.html) e recebem o
// <section class="ckp-dialogo"> por portal como primeiro filho: ui/accessible-dialogs.ts põe role=dialog, aria-modal e
// modal-panel nele ao abrir, por isso o className é constante.
// Botões mantêm só data-on-click: o despachante global chama as ações pela ponte (onClick React dispararia duas vezes).

interface Props { cascaAtualizar: HTMLElement; cascaModelo: HTMLElement; limparPrevia: () => void }

// ui/file-picker.ts reescreve nome, meta, "Escolher/Trocar", title, data-estado e data-pronta a cada change: todos saem
// constantes aqui, para o React nunca reconciliar. O input não é controlado (o File vive nele; as ações o leem pelo id).
function SeletorArquivo({ idInput, accept, idNome, nomeVazio, metaVazio, disabled, aoMudar }: {
  idInput: string; accept: string; idNome: string; nomeVazio: string; metaVazio: string; disabled?: boolean; aoMudar?: () => void;
}) {
  return (
    <label className="ckp-arquivo" data-estado="vazio">
      <input id={idInput} type="file" accept={accept} data-obrigatorio="" disabled={disabled} onChange={aoMudar} />
      <span className="ckp-arquivo__ico"><svg className="ck-ico ck-ico--vazio" aria-hidden="true"><use href="#i-upload" /></svg><svg className="ck-ico ck-ico--cheio" aria-hidden="true"><use href="#i-file-check" /></svg></span>
      <span className="ckp-arquivo__textos"><span className="ckp-arquivo__nome" id={idNome} data-vazio={nomeVazio} title="">{nomeVazio}</span><span className="ckp-arquivo__meta" data-vazio={metaVazio}>{metaVazio}</span></span>
      <span className="ckp-arquivo__acoes"><button type="button" className="ck-btn ck-btn--fantasma ck-btn--icone ck-btn--sm" data-remover="" aria-label="Remover arquivo"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-x" /></svg></button><span className="ck-btn ck-btn--secundario ck-btn--sm ckp-arquivo__trocar">Escolher</span></span>
    </label>
  );
}

function Secao({ numero, titulo, fim, idDica, dica, children }: { numero: string; titulo: string; fim?: boolean; idDica: string; dica: string; children: ReactNode }) {
  return (
    <section className="ckp-secao" data-pronta="false">
      <div className="ckp-secao__cab"><span className="ckp-secao__num"><span>{numero}</span><svg className="ck-ico" aria-hidden="true"><use href="#i-check" /></svg></span><div className="ckp-secao__textos"><h3 className="ckp-secao__titulo">{titulo} <InfoTip rotulo={`Sobre ${titulo}`} idDica={idDica} fim={fim}>{dica}</InfoTip></h3></div></div>
      <div className="ckp-secao__corpo">{children}</div>
    </section>
  );
}

function DialogoAtualizar({ casca, limparPrevia }: { casca: HTMLElement; limparPrevia: () => void }) {
  const s = useSyncExternalStore(assinar, ler);
  const corpoArquivos = useRef<HTMLDivElement>(null);
  const previa = useRef<HTMLParagraphElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const impacto = s.etapa === "impacto";
  const previaOcupada = s.ocupado?.botao === "previa";
  const confirmarOcupado = s.ocupado?.botao === "confirmar";
  const ocupado = s.ocupado !== null;

  // #esc-inv-entra (seção do painel entra-users) fica estática no partial: a dica cita o domínio do Entra, proibido em
  // frontend/src (tests/test_maintenance_contracts.py). Aqui o mesmo nó vai para o fim do corpo "arquivos", onde sempre esteve.
  // Os filhos React desse corpo são estáticos, para o React nunca reordenar nem remover o nó adotado.
  useLayoutEffect(() => {
    const entra = casca.querySelector("#esc-inv-entra");
    if (entra) corpoArquivos.current?.appendChild(entra);
  }, [casca]);

  // aria-busy fica no overlay (fora do React), como no código antigo.
  useLayoutEffect(() => {
    if (ocupado) casca.setAttribute("aria-busy", "true");
    else casca.removeAttribute("aria-busy");
  }, [casca, ocupado]);

  useEffect(() => { if (s.previa.texto) previa.current?.scrollIntoView?.({ block: "nearest" }); }, [s.previa]);
  useEffect(() => { if (s.status.erro) status.current?.scrollIntoView?.({ block: "nearest" }); }, [s.status]);

  const spinner = (mensagem: string) => <><IconeLucide nome="loader-2" className="w-3.5 h-3.5 animate-spin" /><span>{mensagem}</span></>;

  return (
    <section className="ckp-dialogo">
      <header className="ckp-cab">
        <span className="ckp-cab__icone"><svg className="ck-ico" aria-hidden="true"><use href="#i-sheet" /></svg></span>
        <div className="ckp-cab__textos">
          <span className="ckp-cab__kicker">Inventários</span>
          <h2 className="ckp-cab__titulo">Atualizar planilhas <InfoTip rotulo="Sobre Atualizar planilhas" idDica="tip-atualizar-planilhas">Envie os dois arquivos para atualizar o cadastro. Endereço e localidade acompanham a Simpress; apelidos alterados manualmente continuam prioritários e divergências aparecem no histórico.</InfoTip></h2>
        </div>
        <div className="ckp-cab__acoes">
          <nav className="ckp-sistemas" aria-label="Acessar sistemas de origem das planilhas">
            <a className="ckp-sistema" href="#" data-endpoint-tela="computadores" aria-label="Abrir inventário de computadores do Endpoint Central"><svg className="ck-ico ck-ico--xs" aria-hidden="true"><use href="#i-external" /></svg>Endpoint</a>
            <a className="ckp-sistema" href="https://ux.simpress.com.br/MeusEquipamentos/Index" target="_blank" rel="noopener noreferrer" aria-label="Abrir Meus Equipamentos da Simpress"><svg className="ck-ico ck-ico--xs" aria-hidden="true"><use href="#i-external" /></svg>Simpress</a>
          </nav>
          <button type="button" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm" data-on-click="fecharModalAtualizarPlanilhas" aria-label="Fechar (Esc)"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-x" /></svg></button>
        </div>
      </header>

      <div className="ckp-corpo" data-so-etapa="arquivos" hidden={impacto} ref={corpoArquivos}>
        <div className="ckp-par-fontes" id="esc-inv-arquivos">
          <Secao numero="1" titulo="Endpoint" idDica="tip-secao-endpoint" dica="Precisa ter nome do computador e rótulo de serviço/número de série.">
            <SeletorArquivo idInput="upload-endpoint-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" idNome="upload-endpoint-name"
              nomeVazio="Escolher arquivo ou arrastar aqui" metaVazio=".xlsx · até 60 MB" disabled={ocupado} aoMudar={limparPrevia} />
          </Secao>
          <Secao numero="2" titulo="Simpress" fim idDica="tip-secao-simpress" dica="Inventário completo de 50 colunas, incluindo o CNPJ de instalação.">
            <SeletorArquivo idInput="upload-details-file" accept=".xlsx,.zip,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" idNome="upload-details-name"
              nomeVazio="Escolher arquivo ou arrastar aqui" metaVazio=".xlsx ou ZIP com uma única planilha · até 60 MB" disabled={ocupado} aoMudar={limparPrevia} />
          </Secao>
        </div>

        <div className="ckp-nota">
          <input id="auto-export-history-after-update" type="checkbox" checked={s.exportarHistorico} disabled={confirmarOcupado}
            onChange={evento => definirExportarHistorico(evento.currentTarget.checked)} />
          <span className="ck-rotulo-info"><label htmlFor="auto-export-history-after-update"><strong>Baixar o Histórico de Planilhas automaticamente.</strong></label><InfoTip rotulo="Sobre o download automático" idDica="auto-export-history-dica">Após cada atualização, exporta os registros e as anotações do dia. Esta preferência fica salva neste navegador.</InfoTip></span>
        </div>
      </div>

      <div className="ckp-corpo" data-so-etapa="impacto" hidden={!impacto}>
        <div className="ckp-nota" data-status="ok"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-ok" /></svg><p id="upload-planilhas-preview" ref={previa} className={s.previa.classe} role="status" aria-live="polite" aria-atomic="true">{s.previa.texto}</p></div>
      </div>

      <footer className="ckp-rodape">
        {/* Aviso de impacto atrás do ⓘ, no hover e no foco por teclado (Novo layout, nota n_janelas_planilhas, etapas 1 e 2). */}
        <span id="upload-impacto-aviso" className="info-tip nl-impacto"><button type="button" className="info-tip-trigger" aria-label="Sobre o impacto" aria-describedby="tip-upload-impacto"><svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg>Impacto</button><span id="tip-upload-impacto" role="tooltip" className="info-tip-text">Ao confirmar, as duas bases ativas serão substituídas pelos arquivos selecionados. Séries ausentes de cada arquivo novo serão removidas daquela fonte; confira as contagens por fonte antes de confirmar.</span></span>
        <p id="upload-planilhas-status" ref={status} className="ckp-rodape__status" role={s.status.role} aria-live={s.status.aoVivo} aria-atomic="true">{s.status.texto}</p>
        <span className="ck-espaco"></span>
        <button type="button" className="ck-btn ck-btn--fantasma" data-on-click="fecharModalAtualizarPlanilhas">Cancelar</button>
        <button type="button" id="btn-voltar-planilhas" className={impacto ? "ck-btn ck-btn--fantasma" : "ck-btn ck-btn--fantasma hidden"} data-on-click="limparPreviaUploadPlanilhas"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-arrow-left" /></svg>Voltar</button>
        <button type="button" id="btn-previsualizar-planilhas" className={impacto ? "ck-btn ck-btn--primario hidden" : "ck-btn ck-btn--primario"} data-on-click="previsualizarPlanilhas"
          disabled={previaOcupada} aria-busy={previaOcupada ? "true" : undefined}>
          {previaOcupada ? spinner(s.ocupado?.mensagem ?? "") : <><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-refresh" /></svg>Pré-visualizar impacto</>}
        </button>
        <button type="button" id="btn-confirmar-planilhas" className={impacto ? "ck-btn ck-btn--primario" : "ck-btn ck-btn--primario hidden"} data-on-click="enviarPlanilhas"
          disabled={confirmarOcupado} aria-busy={confirmarOcupado ? "true" : undefined}>
          {confirmarOcupado ? spinner(s.ocupado?.mensagem ?? "") : <><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-check" /></svg>Confirmar substituição</>}
        </button>
      </footer>
    </section>
  );
}

function DialogoModelo({ casca }: { casca: HTMLElement }) {
  const modelo = useSyncExternalStore(assinar, () => ler().modelo);
  const transferencia = modelo.tipo === "transferencia";

  // data-tipo e aria-busy ficam no overlay (fora do React), como no código antigo; as ações leem o tipo do estado.
  useLayoutEffect(() => {
    if (modelo.tipo !== undefined) casca.dataset.tipo = modelo.tipo;
  }, [casca, modelo.tipo]);
  useLayoutEffect(() => {
    if (modelo.ocupado) casca.setAttribute("aria-busy", "true");
    else casca.removeAttribute("aria-busy");
  }, [casca, modelo.ocupado]);

  const titulo = modelo.tipo === undefined ? "Importar arquivos" : transferencia ? "Arquivos para transferência" : "Arquivos para exportação";
  const descricao = modelo.tipo === undefined ? "" : (transferencia
    ? "A base Simpress + Endpoint é compartilhada. Se necessário, atualize-a no painel de disponibilidade; aqui, importe o modelo oficial de transferência da Simpress."
    : "Importe a planilha do modelo de exportação que atualiza os apelidos/hostnames.")
    + " Ao substituir um modelo importado, uma cópia anterior é guardada nos backups locais. O modelo de transferência incluído no projeto é preservado.";

  return (
    <section className="ckp-dialogo ckp-dialogo--estreito">
      <header className="ckp-cab">
        <span className="ckp-cab__icone"><svg className="ck-ico" aria-hidden="true"><use href="#i-download" /></svg></span>
        <div className="ckp-cab__textos">
          <span className="ckp-cab__kicker">Modelo .xlsx</span>
          <h2 className="ckp-cab__titulo"><span id="titulo-importar-modelo">{titulo}</span> <span className="info-tip info-tip--bloco"><button type="button" className="info-tip-trigger" aria-label="Sobre Importar arquivos" aria-describedby="descricao-importar-modelo"><svg className="ck-ico ck-ico--sm" aria-hidden="true" focusable="false"><use href="#i-info" /></svg></button><span id="descricao-importar-modelo" role="tooltip" className="info-tip-text">{descricao}</span></span></h2>
        </div>
        <div className="ckp-cab__acoes"><button type="button" className="ck-btn ck-btn--icone ck-btn--fantasma ck-btn--sm" data-on-click="fecharImportacaoModelo" aria-label="Fechar importação de modelo"><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-x" /></svg></button></div>
      </header>
      <div className="ckp-corpo" id="esc-modelo">
        <SeletorArquivo idInput="arquivo-modelo-local" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" idNome="nome-arquivo-modelo-local"
          nomeVazio="Escolher modelo ou arrastar aqui" metaVazio="Modelo .xlsx · até 60 MB" />
      </div>
      <footer className="ckp-rodape">
        <p id="status-modelo-local" className="ckp-rodape__status" role={modelo.alerta ? "alert" : "status"} aria-live="polite" aria-atomic="true">{modelo.status}</p>
        <span className="ck-espaco"></span>
        <button type="button" className="ck-btn ck-btn--fantasma" data-on-click="fecharImportacaoModelo">Cancelar</button>
        <button id="btn-importar-modelo" type="button" className="ck-btn ck-btn--primario" data-on-click="enviarModeloLocal" disabled={modelo.ocupado}><svg className="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-upload" /></svg>Importar</button>
      </footer>
    </section>
  );
}

export function DialogosImportacao({ cascaAtualizar, cascaModelo, limparPrevia }: Props) {
  return (
    <>
      {createPortal(<DialogoAtualizar casca={cascaAtualizar} limparPrevia={limparPrevia} />, cascaAtualizar)}
      {createPortal(<DialogoModelo casca={cascaModelo} />, cascaModelo)}
    </>
  );
}
