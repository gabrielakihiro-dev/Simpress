// Formulários dos termos de entrega e devolução, com o mesmo DOM do painel antigo. Os campos têm dado pessoal:
// ficam só no estado do painel (campos de texto controlados; os rádios Sim/Não guardam a marca no DOM), nunca em log nem em storage.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { IconeSprite, InfoTip } from "./componentes";
import { avisar, ler, mudar, type FormTermo, type StatusTermo } from "./estado";
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

// Cartão do formulário: o título é a legend do fieldset (a ⓘ e o contador ficam dentro dela); o ícone é só enfeite.
function Cartao({ icone, titulo, children }: { icone: string; titulo: string; children: ReactNode }) {
  return (
    <fieldset className="termos__grupo">
      <legend><span className="termos__ico" aria-hidden="true"><IconeSprite nome={icone} /></span>{titulo}</legend>
      {children}
    </fieldset>
  );
}

function TabelaEquipamento({ termo, form }: Omit<CampoProps, "nome">) {
  return (
    <Cartao icone="laptop" titulo="Identificação do equipamento">
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
    </Cartao>
  );
}

// Contagem do cartão de itens e da prévia: sempre calculada do estado (marcados / total), nunca fixa.
const contarItens = (form: FormTermo) => form.itens.filter((resposta) => resposta === "sim" || resposta === "nao").length;
const contarCampos = (termo: NomeTermo, form: FormTermo) => TERMOS[termo].campos.filter((nome) => (form.campos[nome] ?? "").trim() !== "").length;

function GradeItens({ termo, form }: Omit<CampoProps, "nome">) {
  const grade = useRef<HTMLDivElement>(null);
  // Rádios não controlados: o navegador guarda a marca, e as ações leem do DOM (lerItens). O código só reescreve a
  // marca quando muda os itens por conta própria (versaoItens sobe), e no primeiro desenho.
  useLayoutEffect(() => {
    grade.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((radio) => {
      radio.checked = form.itens[Number(radio.name.slice("item-".length)) - 1] === radio.value;
    });
  }, [form.versaoItens]);
  return (
    <div className="termos__itens" ref={grade}>
      {TERMOS[termo].itens.map((rotulo, i) => {
        const n = String(i + 1).padStart(2, "0");
        return (
          <div className="termos__item" key={n}>
            <span className="termos__item-nome">{rotulo}</span>
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
          </div>
        );
      })}
    </div>
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

// Erros e sucessos curtos vão para o toast. O status continua no DOM (leitor de tela e testes) e só mostra o botão
// Ver em Lembretes. Efeito colateral aceito: o leitor de tela pode anunciar a mesma frase duas vezes (status e toast).
function Acoes({ termo, status }: { termo: NomeTermo; status: StatusTermo }) {
  const primeiroDesenho = useRef(true);
  const ultimoAviso = useRef({ texto: "", em: 0 });
  useEffect(() => {
    if (primeiroDesenho.current) {
      primeiroDesenho.current = false;
      return;
    }
    if (!status.texto) return;
    // Mesmo texto de novo dentro da vida do aviso (cerca de 6 s): não empilha outro. No celular o aviso cobre os botões de baixo,
    // e vários iguais empilhados cobririam mais; o status acima já foi atualizado.
    const agora = Date.now();
    if (ultimoAviso.current.texto === status.texto && agora - ultimoAviso.current.em < 6000) return;
    ultimoAviso.current = { texto: status.texto, em: agora };
    avisar(status.texto, status.tipo === "erro" ? "error" : "success");
  }, [status]);
  const comBotao = status.verLembrete !== undefined;
  return (
    <div className="termos__acoes">
      <div className="termos__gerar">
        <button type="button" className="ck-btn ck-btn--primario" onClick={() => { void gerarPdf(termo); }}>Gerar PDF</button>
        <InfoTip rotulo="Sobre o PDF" idDica={`termos-pdf-dica-${termo}`}>Na janela que abrir, escolha Salvar como PDF e a pasta.</InfoTip>
      </div>
      <button type="button" className="ck-btn ck-btn--secundario" onClick={() => criarDoTermo(termo)}>Criar lembrete</button>
      <button type="button" className="ck-btn ck-btn--secundario" onClick={() => { void limpar(termo); }}>Limpar</button>
      <p className={comBotao ? "termos__estado" : "termos__estado sr-only"} id={`termos-status-${termo}`} role="status" aria-live="polite" data-tipo={status.tipo}>
        <span className={comBotao ? "sr-only" : undefined}>{status.texto}</span>
        {comBotao && (
          <button type="button" className="ck-btn ck-btn--fantasma ck-btn--sm lembretes__ver" onClick={() => verLembretes(status.verLembrete as string | number)}>
            Ver em Lembretes
          </button>
        )}
      </p>
    </div>
  );
}

// Prévia do PDF: folha miniatura só com barras e marcas, desenhada do estado do formulário (valor preenchido = barra
// escura, vazio = barra clara). Não mostra nenhum texto digitado, então não leva dado pessoal; fica fora do leitor de tela.
function FolhaPrevia({ termo, form }: { termo: NomeTermo; form: FormTermo }) {
  const obsCheia = form.obs.trim() !== "" ? "1" : undefined;
  return (
    <div className="termos__folha" data-termo={termo} aria-hidden="true">
      <i className="termos__barra termos__barra--titulo" />
      <div className="termos__folha-linhas">
        {TERMOS[termo].campos.map((nome) => (
          <i key={nome} className="termos__barra" data-cheio={(form.campos[nome] ?? "").trim() !== "" ? "1" : undefined} />
        ))}
      </div>
      <div className="termos__folha-linhas">
        {form.itens.map((resposta, i) => (
          <div key={i} className="termos__folha-item">
            <i className="termos__folha-marca" data-resposta={resposta || undefined} />
            <i className="termos__barra" />
          </div>
        ))}
      </div>
      <div className="termos__folha-linhas">
        <i className="termos__barra" data-cheio={obsCheia} />
        <i className="termos__barra" data-cheio={obsCheia} />
      </div>
    </div>
  );
}

function Previa({ termo, form, status }: { termo: NomeTermo; form: FormTermo; status: StatusTermo }) {
  const total = TERMOS[termo].campos.length + TERMOS[termo].itens.length;
  const feitos = contarCampos(termo, form) + contarItens(form);
  return (
    <section className="termos__previa" aria-labelledby={`termos-previa-${termo}-titulo`}>
      <h3 className="termos__previa-titulo" id={`termos-previa-${termo}-titulo`}>
        <span className="termos__ico" aria-hidden="true"><IconeSprite nome="file-check" /></span>
        Prévia do PDF
        <span className="termos__chip" aria-hidden="true">{`${feitos}/${total}`}</span>
      </h3>
      <div className="termos__trilho" aria-hidden="true"><i style={{ width: `${Math.round((feitos / total) * 100)}%` }} /></div>
      <FolhaPrevia termo={termo} form={form} />
      <Acoes termo={termo} status={status} />
    </section>
  );
}

export function FormularioTermo({ termo, form, status }: { termo: NomeTermo; form: FormTermo; status: StatusTermo }) {
  const entrega = termo === "entrega";
  const campos = CAMPOS_COLABORADOR[termo];
  // Devolução: nome, unidade e data na primeira linha; modelo e série na segunda. Entrega: uma linha só.
  const linhas = entrega ? [campos] : [campos.slice(0, 3), campos.slice(3)];
  const chipItens = <span className="termos__chip" aria-hidden="true">{`${contarItens(form)}/${TERMOS[termo].itens.length}`}</span>;
  return (
    <form
      className="termos__form"
      id={`termos-form-${termo}`}
      autoComplete="off"
      noValidate
      data-serie-home={form.serieHome ?? undefined}
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="termos__grade">
        <div className="termos__esq">
          <Cartao icone="user" titulo="Dados do colaborador">
            {linhas.map((linha, i) => (
              <div key={i} className="termos__campos">
                {linha.map((def) => <CampoTermo key={def.nome} termo={termo} form={form} def={def} />)}
              </div>
            ))}
          </Cartao>
          {entrega && <TabelaEquipamento termo={termo} form={form} />}
          {entrega ? (
            <fieldset className="termos__grupo" aria-labelledby="termos-entrega-itens-leg">
              <legend>
                <span className="termos__ico" aria-hidden="true"><IconeSprite nome="clipboard" /></span>
                <span id="termos-entrega-itens-leg">Equipamentos e acessórios entregues</span>
                <InfoTip rotulo="Sobre os itens entregues" idDica="termos-entrega-itens-dica">Assinale Sim ou Não para cada item apresentado no ato da entrega.</InfoTip>
                {chipItens}
              </legend>
              <GradeItens termo={termo} form={form} />
            </fieldset>
          ) : (
            <fieldset className="termos__grupo">
              <legend>
                <span className="termos__ico" aria-hidden="true"><IconeSprite nome="clipboard" /></span>
                Equipamentos e acessórios devolvidos
                {chipItens}
              </legend>
              <GradeItens termo={termo} form={form} />
            </fieldset>
          )}
          {entrega ? (
            <fieldset className="termos__grupo" aria-labelledby="termos-entrega-obs-leg">
              <legend>
                <span className="termos__ico" aria-hidden="true"><IconeSprite nome="text" /></span>
                <span id="termos-entrega-obs-leg">Observações</span>
                <InfoTip rotulo="Sobre as observações" idDica="termos-entrega-obs-dica">Registre avarias no equipamento anterior ou itens pendentes.</InfoTip>
              </legend>
              <Observacoes termo={termo} form={form} />
            </fieldset>
          ) : (
            <Cartao icone="text" titulo="Observações">
              <Observacoes termo={termo} form={form} />
            </Cartao>
          )}
        </div>
        <Previa termo={termo} form={form} status={status} />
      </div>
    </form>
  );
}
