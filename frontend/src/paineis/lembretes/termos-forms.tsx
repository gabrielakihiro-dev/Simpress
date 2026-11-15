// Formulários dos termos de entrega e devolução, com o mesmo DOM do painel antigo. Os campos têm dado pessoal:
// ficam só no estado do painel (campos de texto controlados; os rádios Sim/Não guardam a marca no DOM), nunca em log nem em storage.
import { useLayoutEffect, useRef } from "react";
import { InfoTip } from "./componentes";
import { ler, mudar, type FormTermo, type StatusTermo } from "./estado";
import { criarDoTermo, verLembretes } from "./lembretes-acoes";
import { gerarPdf, idItem, limpar } from "./termos-acoes";
import { TERMOS, type NomeTermo } from "./termos-puro";

interface DefCampo {
  nome: string;
  rotulo: string;
  tipo?: "date";
}

const CAMPOS_COLABORADOR: Record<NomeTermo, DefCampo[]> = {
  entrega: [
    { nome: "nome", rotulo: "Nome do colaborador" },
    { nome: "unidade", rotulo: "Unidade / Departamento" },
    { nome: "data", rotulo: "Data da entrega / troca", tipo: "date" },
  ],
  devolucao: [
    { nome: "nome", rotulo: "Nome do colaborador" },
    { nome: "unidade", rotulo: "Unidade" },
    { nome: "data", rotulo: "Data", tipo: "date" },
    { nome: "modelo", rotulo: "Modelo do computador" },
    { nome: "serie", rotulo: "Número de série" },
  ],
};

// Linhas da tabela "Identificação do equipamento" (só na entrega).
const LINHAS_EQUIPAMENTO = [
  { rotulo: "Modelo do computador", anterior: "modelo_anterior", entregue: "modelo_entregue" },
  { rotulo: "Número de série / Service Tag", anterior: "serie_anterior", entregue: "serie_entregue" },
];

const idDoCampo = (termo: NomeTermo, nome: string) => `termos-${termo}-${nome.replace(/_/g, "-")}`;

function mudarForm(termo: NomeTermo, atualizar: (form: FormTermo) => FormTermo) {
  const { termos } = ler();
  mudar({ termos: { ...termos, [termo]: atualizar(termos[termo]) } });
}

// Grava sempre o valor do navegador: data digitada pela metade chega como "" e o React não a sobrescreve.
const mudarCampo = (termo: NomeTermo, nome: string, valor: string) =>
  mudarForm(termo, (form) => ({ ...form, campos: { ...form.campos, [nome]: valor } }));
const mudarObs = (termo: NomeTermo, valor: string) => mudarForm(termo, (form) => ({ ...form, obs: valor }));
const marcarItem = (termo: NomeTermo, indice: number, resposta: string) =>
  mudarForm(termo, (form) => ({ ...form, itens: form.itens.map((atual, i) => (i === indice ? resposta : atual)) }));

interface CampoProps {
  termo: NomeTermo;
  form: FormTermo;
  nome: string;
}

function marcaHome(form: FormTermo, nome: string) {
  return form.preenchidoHome.includes(nome) ? "1" : undefined;
}

function CampoTermo({ termo, form, def }: Omit<CampoProps, "nome"> & { def: DefCampo }) {
  return (
    <label className="ck-campo">
      <span className="ck-campo__rotulo">{def.rotulo}</span>
      <input
        type={def.tipo ?? "text"}
        id={idDoCampo(termo, def.nome)}
        name={def.nome}
        className="ck-entrada"
        autoComplete="off"
        value={form.campos[def.nome] ?? ""}
        data-preenchido-home={marcaHome(form, def.nome)}
        onChange={(e) => mudarCampo(termo, def.nome, e.target.value)}
      />
    </label>
  );
}

function CelulaEquipamento({ termo, form, nome, rotuloColuna, rotuloLinha }: CampoProps & { rotuloColuna: string; rotuloLinha: string }) {
  const id = idDoCampo(termo, nome);
  return (
    <td data-rotulo={rotuloColuna}>
      <label className="sr-only" htmlFor={id}>{`${rotuloLinha}, ${rotuloColuna.toLowerCase()}`}</label>
      <input
        type="text"
        id={id}
        name={nome}
        className="ck-entrada"
        autoComplete="off"
        value={form.campos[nome] ?? ""}
        data-preenchido-home={marcaHome(form, nome)}
        onChange={(e) => mudarCampo(termo, nome, e.target.value)}
      />
    </td>
  );
}

function TabelaEquipamento({ termo, form }: Omit<CampoProps, "nome">) {
  return (
    <fieldset className="termos__grupo">
      <legend>Identificação do equipamento</legend>
      <table className="termos__tabela">
        <thead><tr><th scope="col">Campo</th><th scope="col">Equipamento anterior</th><th scope="col">Equipamento entregue</th></tr></thead>
        <tbody>
          {LINHAS_EQUIPAMENTO.map((linha) => (
            <tr key={linha.anterior}>
              <th scope="row">{linha.rotulo}</th>
              <CelulaEquipamento termo={termo} form={form} nome={linha.anterior} rotuloColuna="Equipamento anterior" rotuloLinha={linha.rotulo} />
              <CelulaEquipamento termo={termo} form={form} nome={linha.entregue} rotuloColuna="Equipamento entregue" rotuloLinha={linha.rotulo} />
            </tr>
          ))}
        </tbody>
      </table>
    </fieldset>
  );
}

function TabelaItens({ termo, form }: Omit<CampoProps, "nome">) {
  const entrega = termo === "entrega";
  const corpo = useRef<HTMLTableSectionElement>(null);
  // Rádios não controlados: o navegador guarda a marca, e as ações leem do DOM (lerItens). O código só reescreve a
  // marca quando muda os itens por conta própria (versaoItens sobe), e no primeiro desenho.
  useLayoutEffect(() => {
    corpo.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((radio) => {
      radio.checked = form.itens[Number(radio.name.slice("item-".length)) - 1] === radio.value;
    });
  }, [form.versaoItens]);
  return (
    <table className="termos__tabela">
      <thead className={entrega ? "sr-only" : undefined}><tr><th scope="col">Equipamento / Acessório</th><th scope="col">Sim / Não</th></tr></thead>
      <tbody ref={corpo}>
        {TERMOS[termo].itens.map((rotulo, i) => {
          const n = String(i + 1).padStart(2, "0");
          return (
            <tr key={n}>
              <th scope="row">{rotulo}</th>
              <td>
                <div className="termos__sn" role="radiogroup" aria-label={rotulo}>
                  <label>
                    <input type="radio" id={idItem(termo, i, "sim")} name={`item-${n}`} value="sim" onChange={() => marcarItem(termo, i, "sim")} />
                    {" Sim"}
                  </label>
                  <label>
                    <input type="radio" id={idItem(termo, i, "nao")} name={`item-${n}`} value="nao" onChange={() => marcarItem(termo, i, "nao")} />
                    {" Não"}
                  </label>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Observacoes({ termo, form }: Omit<CampoProps, "nome">) {
  const id = `termos-${termo}-obs`;
  const entrega = termo === "entrega";
  return (
    <>
      <label className="sr-only" htmlFor={id}>Observações</label>
      <textarea
        id={id}
        name="obs"
        className="ck-entrada termos__obs"
        rows={4}
        aria-describedby={entrega ? "termos-entrega-obs-dica" : undefined}
        value={form.obs}
        onChange={(e) => mudarObs(termo, e.target.value)}
      />
    </>
  );
}

function Acoes({ termo, status }: { termo: NomeTermo; status: StatusTermo }) {
  return (
    <div className="termos__acoes">
      <button type="button" className="ck-btn ck-btn--primario" onClick={() => { void gerarPdf(termo); }}>Gerar PDF</button>
      <InfoTip rotulo="Sobre o PDF" idDica={`termos-pdf-dica-${termo}`}>Na janela que abrir, escolha Salvar como PDF e a pasta.</InfoTip>
      <button type="button" className="ck-btn ck-btn--secundario" onClick={() => criarDoTermo(termo)}>Criar lembrete</button>
      <button type="button" className="ck-btn ck-btn--secundario" onClick={() => { void limpar(termo); }}>Limpar</button>
      <p className="termos__estado" id={`termos-status-${termo}`} role="status" aria-live="polite" data-tipo={status.tipo}>
        {status.texto}
        {status.verLembrete !== undefined && (
          <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm lembretes__ver" onClick={() => verLembretes(status.verLembrete as string | number)}>
            Ver em Lembretes
          </button>
        )}
      </p>
    </div>
  );
}

export function FormularioTermo({ termo, form, status }: { termo: NomeTermo; form: FormTermo; status: StatusTermo }) {
  const entrega = termo === "entrega";
  return (
    <form
      className="termos__form"
      id={`termos-form-${termo}`}
      autoComplete="off"
      noValidate
      data-serie-home={form.serieHome ?? undefined}
      onSubmit={(e) => e.preventDefault()}
    >
      <fieldset className="termos__grupo">
        <legend>Dados do colaborador</legend>
        <div className="termos__campos">
          {CAMPOS_COLABORADOR[termo].map((def) => <CampoTermo key={def.nome} termo={termo} form={form} def={def} />)}
        </div>
      </fieldset>
      {entrega && <TabelaEquipamento termo={termo} form={form} />}
      {entrega ? (
        <fieldset className="termos__grupo" aria-labelledby="termos-entrega-itens-leg">
          <legend>
            <span id="termos-entrega-itens-leg">Equipamentos e acessórios entregues</span>
            <InfoTip rotulo="Sobre os itens entregues" idDica="termos-entrega-itens-dica">Assinale Sim ou Não para cada item apresentado no ato da entrega.</InfoTip>
          </legend>
          <TabelaItens termo={termo} form={form} />
        </fieldset>
      ) : (
        <fieldset className="termos__grupo">
          <legend className="sr-only">Equipamentos devolvidos</legend>
          <TabelaItens termo={termo} form={form} />
        </fieldset>
      )}
      {entrega ? (
        <fieldset className="termos__grupo" aria-labelledby="termos-entrega-obs-leg">
          <legend>
            <span id="termos-entrega-obs-leg">Observações</span>
            <InfoTip rotulo="Sobre as observações" idDica="termos-entrega-obs-dica">Registre avarias no equipamento anterior ou itens pendentes.</InfoTip>
          </legend>
          <Observacoes termo={termo} form={form} />
        </fieldset>
      ) : (
        <fieldset className="termos__grupo">
          <legend>Observações</legend>
          <Observacoes termo={termo} form={form} />
        </fieldset>
      )}
      <Acoes termo={termo} status={status} />
    </form>
  );
}
