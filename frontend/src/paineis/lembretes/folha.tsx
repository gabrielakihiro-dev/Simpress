// Folha de impressão do termo (Gerar PDF): o mesmo DOM de antes, desenhada dentro de #termos-impressao (que fica em
// static/index.html). React só escreve texto, então nada digitado vira HTML. Os dados têm dado pessoal: não vão para log.
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AssinaturaFolha } from "../../componentes/assinatura-medida";
import { AssinaturaTexto } from "../../componentes/assinatura-texto";
import type { Folha } from "./estado";
import { termosFormatarData, type DadosTermo } from "./termos-puro";

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="tp__secao">
      <h2 className="tp__secao-titulo">{titulo}</h2>
      {children}
    </section>
  );
}

function CampoFolha({ rotulo, valor, cheio }: { rotulo: string; valor: string | undefined; cheio?: boolean }) {
  return (
    <div className={cheio ? "tp__campo tp__campo--cheio" : "tp__campo"}>
      <span className="tp__rotulo">{`${rotulo}:`}</span>
      <span>{valor ?? ""}</span>
    </div>
  );
}

// respostas (opcional): "sim" ou "nao" por linha; só colore a borda da coluna Sim / Não (data-resposta), o texto não muda.
function Tabela({ cabecalhos, linhas, classes = [], respostas }: { cabecalhos: string[]; linhas: (string | undefined)[][]; classes?: string[]; respostas?: string[] }) {
  return (
    <table className="tp__tabela">
      <thead>
        <tr>{cabecalhos.map((texto, i) => <th key={texto} scope="col" className={classes[i] || undefined}>{texto}</th>)}</tr>
      </thead>
      <tbody>
        {linhas.map((celulas, linha) => (
          <tr key={linha}>
            {celulas.map((texto, i) => (i === 0
              ? <th key={i} scope="row">{texto}</th>
              : <td key={i} className={classes[i] || undefined} data-resposta={respostas?.[linha] || undefined}>{texto}</td>))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const marcas = (resposta: string) => `${resposta === "sim" ? "[X]" : "[ ]"} Sim   ${resposta === "nao" ? "[X]" : "[ ]"} Não`;

// A assinatura já veio pronta (termos-acoes.ts): a imagem decodificada do desenho ou o nome medido; entra no início do lado
// do técnico, acima do rótulo. Entrar por aqui evita pedi-la de novo e imprimir antes de ela carregar. O lado do colaborador
// fica em branco.
function Assinatura({ texto, assinatura }: { texto: string; assinatura?: AssinaturaFolha | null }) {
  const imagem = assinatura?.tipo === "desenho" ? assinatura.imagem : null;
  return (
    <div
      className="tp__assinatura"
      ref={(no) => {
        if (no && imagem && !no.contains(imagem)) no.prepend(imagem);
      }}
    >
      {assinatura?.tipo === "texto" && <AssinaturaTexto nome={assinatura.nome} estilo={assinatura.estilo} medida={assinatura.medida} />}
      {texto}
    </div>
  );
}

export function FolhaTermo({ dados, assinatura }: { dados: DadosTermo; assinatura: AssinaturaFolha | null }) {
  const c = dados.campos;
  const entrega = dados.termo === "entrega";
  // Mesma estrutura nos dois termos; a devolução muda só os textos e a cor de destaque (tp--devolucao).
  return (
    <article className={entrega ? "tp" : "tp tp--devolucao"}>
      <header className="tp__cab">
        <div className="tp__org">SEBRAE/PR</div>
        <div className="tp__marca">Interno</div>
        <h1 className="tp__titulo">{entrega ? "Termo de Entrega" : "Termo de Devolução de Equipamentos"}</h1>
      </header>
      <Secao titulo="Dados do colaborador">
        <div className="tp__campos">
          <CampoFolha rotulo="Nome do colaborador" valor={c.nome} cheio />
          <CampoFolha rotulo={entrega ? "Unidade / Departamento" : "Unidade"} valor={c.unidade} />
          <CampoFolha rotulo={entrega ? "Data da entrega / troca" : "Data"} valor={termosFormatarData(c.data)} />
          {/* A devolução não tem a tabela de identificação: modelo e série ficam nos dados do colaborador. */}
          {!entrega && <CampoFolha rotulo="Modelo do computador" valor={c.modelo} />}
          {!entrega && <CampoFolha rotulo="Número de série" valor={c.serie} />}
        </div>
      </Secao>
      {entrega && (
        <Secao titulo="Identificação do equipamento">
          <Tabela
            cabecalhos={["Campo", "Equipamento anterior", "Equipamento entregue"]}
            linhas={[
              ["Modelo do computador", c.modelo_anterior, c.modelo_entregue],
              ["Número de série / Service Tag", c.serie_anterior, c.serie_entregue],
            ]}
          />
        </Secao>
      )}
      <Secao titulo={entrega ? "Equipamentos e acessórios entregues" : "Equipamentos e acessórios devolvidos"}>
        <p className="tp__dica">{`Assinale Sim ou Não para cada item apresentado no ato da ${entrega ? "entrega" : "devolução"}.`}</p>
        <Tabela
          cabecalhos={["Equipamento / Acessório", "Sim / Não"]}
          linhas={dados.itens.map((item) => [item.rotulo, marcas(String(item.resposta))])}
          classes={["", "tp__marcas"]}
          respostas={dados.itens.map((item) => String(item.resposta))}
        />
      </Secao>
      <Secao titulo="Observações">
        <div className="tp__obs">{dados.obs}</div>
      </Secao>
      <Secao titulo={entrega ? "Validação do recebimento" : "Validação da devolução"}>
        <p className="tp__texto">
          {entrega
            ? "Declaro que conferi as informações deste termo e recebi os equipamentos e acessórios assinalados acima."
            : "Declaro que conferi as informações deste termo e devolvi os equipamentos e acessórios assinalados acima."}
        </p>
      </Secao>
      <div className="tp__assinaturas">
        <Assinatura texto="Assinatura do colaborador" />
        <Assinatura texto={entrega ? "Assinatura do técnico responsável" : "Assinatura do Técnico"} assinatura={assinatura} />
      </div>
    </article>
  );
}

export function FolhaImpressao({ folha }: { folha: Folha | null }) {
  const alvo = document.getElementById("termos-impressao");
  if (!folha || !alvo) return null;
  return createPortal(<FolhaTermo dados={folha.dados} assinatura={folha.assinatura} />, alvo);
}
