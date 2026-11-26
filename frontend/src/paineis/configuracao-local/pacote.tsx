// Seção "Pacote local" do modal Configuração local. Contrato: docs/cockpit-prompts/19-configuracao-local.md (spec 26/11/2026).
// Estado local da seção (não do store do modal): só ela usa.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api";

// Tipos mínimos pelo contrato; trocar por api-tipos.gerado.d.ts depois de `python scripts/gerar_tipos_api.py`.
type Acao = "substituir" | "criar" | "igual" | "manter" | "apagar";
interface Pacote { arquivo: string; tipo: "exportacao" | "desfazer"; criado_em: string; tamanho_bytes: number }
interface Lista { pasta: string; pasta_padrao: boolean; pacotes: Pacote[]; erro_pasta?: string | null }
interface Previa {
  arquivo: string; tipo: string; versao_app: string; criado_em: string;
  itens: { caminho: string; acao: Acao }[];
  totais: Record<Acao, number>; muda_links: boolean; preview_token: string;
}
interface Resultado { pacote_desfazer: string }

const BASE = "/api/pacote-local";
const JSON_H = { "Content-Type": "application/json" };
const JA_IGUAL = "Este pacote já corresponde ao estado atual.";
const FALHA_RESTAURAR = "Falha ao restaurar. Os arquivos anteriores foram recuperados.";
const ROTULO_ACAO: Record<Acao, string> = { substituir: "Substituir", criar: "Criar", igual: "Igual", manter: "Manter", apagar: "Apagar" };
const FORMATO = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function data(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : FORMATO.format(d).replace(",", "");
}
function tamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}
const mensagem = (e: unknown, padrao: string) => (e as Error)?.message || padrao;
const toast = (texto: string) => (window as unknown as { showToast?: (m: string, t: string) => void }).showToast?.(texto, "success");

interface Props { visivel: boolean; revisao: number; Cabecalho: React.ComponentType<{ secao: string; titulo: string; desc: string }> }

export function SecaoPacoteLocal({ visivel, revisao, Cabecalho }: Props) {
  const [lista, setLista] = useState<Lista | null>(null);
  const [pasta, setPasta] = useState("");
  const [erroPasta, setErroPasta] = useState("");
  const [erro, setErro] = useState("");
  const [ok, setOk] = useState("");
  const [ocupado, setOcupado] = useState<"" | "pasta" | "exportar" | "previa" | "restaurar">("");
  const [previa, setPrevia] = useState<Previa | null>(null);
  const [mostrarTodos, setMostrarTodos] = useState(false);
  const [jaIgual, setJaIgual] = useState(false);
  const [recusa, setRecusa] = useState("");
  const [concluido, setConcluido] = useState(false);
  const tituloPrevia = useRef<HTMLHeadingElement>(null);
  const mensagemRef = useRef<HTMLParagraphElement>(null);

  const aplicar = (l: Lista) => { setLista(l); setPasta(l.pasta_padrao ? "" : l.pasta); setErroPasta(l.erro_pasta || ""); };

  // Recarrega a lista a cada abertura do modal.
  useEffect(() => {
    if (!visivel) return;
    setPrevia(null); setErro(""); setOk(""); setConcluido(false);
    apiFetch<Lista>(BASE, { errorMessage: "Não foi possível ler os pacotes." }).then(aplicar).catch(e => setErro(mensagem(e, "Não foi possível ler os pacotes.")));
  }, [visivel, revisao]);

  useEffect(() => { if (previa) tituloPrevia.current?.focus(); }, [previa]);
  useEffect(() => { if (erro || ok || recusa) mensagemRef.current?.focus(); }, [erro, ok, recusa]);

  async function salvarPasta(e: React.FormEvent) {
    e.preventDefault();
    setOcupado("pasta"); setErroPasta("");
    try {
      aplicar(await apiFetch<Lista>(`${BASE}/pasta`, { method: "PUT", headers: JSON_H, body: JSON.stringify({ pasta: pasta.trim() }), errorMessage: "Não foi possível salvar a pasta." }));
    } catch (err) { setErroPasta(mensagem(err, "Não foi possível salvar a pasta.")); } finally { setOcupado(""); }
  }

  async function exportar() {
    setOcupado("exportar"); setErro(""); setOk(""); setConcluido(false);
    try {
      const r = await apiFetch<{ arquivo: string }>(`${BASE}/exportar`, { method: "POST", errorMessage: "Não foi possível exportar o pacote." });
      const texto = `Pacote exportado: ${r.arquivo}`;
      setOk(texto); toast(texto);
      aplicar(await apiFetch<Lista>(BASE));
    } catch (err) { setErro(mensagem(err, "Não foi possível exportar o pacote.")); } finally { setOcupado(""); }
  }

  async function abrirPrevia(arquivo: string) {
    setOcupado("previa"); setErro(""); setOk(""); setRecusa(""); setJaIgual(false); setMostrarTodos(false); setConcluido(false); setPrevia(null);
    try {
      setPrevia(await apiFetch<Previa>(`${BASE}/${encodeURIComponent(arquivo)}/previa`, { errorMessage: "Pacote recusado: não foi possível ler o pacote." }));
    } catch (err) {
      const m = mensagem(err, "Pacote recusado: não foi possível ler o pacote.");
      setErro(m);
    } finally { setOcupado(""); }
  }

  // Único lugar que envia confirmado: true.
  async function confirmar() {
    if (!previa) return;
    setOcupado("restaurar"); setRecusa(""); setErro("");
    try {
      const r = await apiFetch<Resultado>(`${BASE}/${encodeURIComponent(previa.arquivo)}/restaurar`, {
        method: "POST", headers: JSON_H, body: JSON.stringify({ preview_token: previa.preview_token, confirmado: true }), errorMessage: FALHA_RESTAURAR,
      });
      setPrevia(null); setConcluido(true); setOk(`Restauração concluída. Pacote de desfazer: ${r.pacote_desfazer}`);
    } catch (err) {
      const m = mensagem(err, FALHA_RESTAURAR);
      if (m.includes(JA_IGUAL)) setJaIgual(true);
      setRecusa(m);
    } finally { setOcupado(""); }
  }

  const itens = previa ? previa.itens.filter(i => mostrarTodos || i.acao === "substituir" || i.acao === "criar" || i.acao === "apagar") : [];
  const contagens = previa ? (["substituir", "criar", "igual", "manter", "apagar"] as Acao[]).filter(a => a !== "apagar" || previa.totais.apagar > 0) : [];
  const mensagemAtiva = erro || recusa || ok;

  return (
    <section id="cfg-local-secao-pacote" className={visivel ? "ckp-secao" : "ckp-secao hidden"} aria-labelledby="cfg-local-titulo-pacote"
      aria-busy={ocupado === "restaurar" ? "true" : undefined}>
      <Cabecalho secao="pacote" titulo="Pacote local" desc="Guarda configurações, históricos e planilhas atuais num arquivo .zip nesta máquina. Chaves de IA e senhas ficam de fora." />
      <div className="ckp-secao__corpo">
        <p className="ckp-pacote__aviso" id="cfg-local-pacote-aviso" data-status="alerta">Contém dados pessoais; não compartilhe.</p>

        <form className="ck-campo" id="cfg-local-pacote-form-pasta" onSubmit={salvarPasta} noValidate>
          <label className="ck-campo__rotulo" htmlFor="cfg-local-pacote-pasta">Pasta do pacote</label>
          <div className="ck-campo__linha">
            <input className="ck-entrada" id="cfg-local-pacote-pasta" type="text" autoComplete="off" spellCheck="false" value={pasta}
              onChange={e => setPasta(e.target.value)} aria-describedby="cfg-local-pacote-pasta-ajuda cfg-local-pacote-pasta-erro"
              aria-invalid={erroPasta ? "true" : undefined} />
            <button type="submit" id="cfg-local-pacote-salvar-pasta" className="ck-btn ck-btn--primario ck-btn--sm ckp-pacote__btn" disabled={Boolean(ocupado)}>Salvar pasta</button>
          </div>
          <span className="ckp-meta" id="cfg-local-pacote-pasta-ajuda">Vazio = padrão data/pacotes_locais/. Só pasta deste computador (sem OneDrive, rede ou unidade removível).</span>
          <p id="cfg-local-pacote-pasta-erro" className="ckp-secao__status" role="alert" data-status="erro" hidden={!erroPasta}>{erroPasta}</p>
          {lista ? <span className="ckp-meta" id="cfg-local-pacote-pasta-atual">Pasta: {lista.pasta}</span> : null}
        </form>

        <div className="ckp-linha">
          <button type="button" id="cfg-local-pacote-exportar" className="ck-btn ck-btn--primario ck-btn--sm ckp-pacote__btn" onClick={exportar} disabled={Boolean(ocupado)}>
            {ocupado === "exportar" ? "Exportando…" : "Exportar pacote"}
          </button>
        </div>

        <p id="cfg-local-pacote-mensagem" ref={mensagemRef} tabIndex={-1} className="ckp-secao__status" role={erro || recusa ? "alert" : "status"}
          aria-live="polite" aria-atomic="true" data-status={erro || recusa ? "erro" : ok ? "ok" : undefined} hidden={!mensagemAtiva}>{mensagemAtiva}</p>
        {concluido ? (
          <div className="ckp-linha"><button type="button" id="cfg-local-pacote-recarregar" className="ck-btn ck-btn--secundario ck-btn--sm ckp-pacote__btn" onClick={() => window.location.reload()}>Recarregar página</button></div>
        ) : null}

        {lista && !lista.pacotes.length ? (
          <p className="ckp-meta" id="cfg-local-pacote-vazio">Nenhum pacote na pasta. Exporte um pacote ou copie um .zip para a pasta.</p>
        ) : null}
        {lista?.pacotes.length ? (
          <div className="ckp-pacote__caixa">
            <table className="ckp-pacote__tabela" id="cfg-local-pacote-lista">
              <thead><tr><th scope="col">Arquivo</th><th scope="col">Tipo</th><th scope="col">Criado em</th><th scope="col">Tamanho</th><th scope="col"><span className="ui-sr-only">Ação</span></th></tr></thead>
              <tbody>
                {lista.pacotes.map(p => (
                  <tr key={p.arquivo} data-arquivo={p.arquivo}>
                    <td data-rotulo="Arquivo" className="ckp-pacote__nome">{p.arquivo}</td>
                    <td data-rotulo="Tipo">{p.tipo === "desfazer" ? "Desfazer" : "Exportação"}</td>
                    <td data-rotulo="Criado em">{data(p.criado_em)}</td>
                    <td data-rotulo="Tamanho">{tamanho(p.tamanho_bytes)}</td>
                    <td className="ckp-pacote__acao"><button type="button" className="ck-btn ck-btn--secundario ck-btn--sm ckp-pacote__btn" data-pacote-restaurar={p.arquivo}
                      aria-label={`Restaurar ${p.arquivo}`} onClick={() => abrirPrevia(p.arquivo)} disabled={Boolean(ocupado)}>Restaurar…</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {previa ? (
          <div className="ckp-pacote__previa" id="cfg-local-pacote-previa" role="region" aria-labelledby="cfg-local-pacote-previa-titulo">
            <h4 className="ckp-secao__titulo" id="cfg-local-pacote-previa-titulo" ref={tituloPrevia} tabIndex={-1}>Prévia da restauração</h4>
            <p className="ckp-meta" id="cfg-local-pacote-previa-resumo">{previa.arquivo} · criado em {data(previa.criado_em)} · versão {previa.versao_app}</p>
            <ul className="ckp-pacote__totais" id="cfg-local-pacote-previa-totais">
              {contagens.map(a => <li key={a} data-acao={a}>{ROTULO_ACAO[a]}: <strong>{previa.totais[a]}</strong></li>)}
            </ul>
            <ul className="ckp-pacote__itens" id="cfg-local-pacote-previa-itens">
              {itens.map(i => <li key={i.caminho} data-acao={i.acao}><span>{i.caminho}</span><span className="ckp-pacote__acao-rotulo">{ROTULO_ACAO[i.acao]}</span></li>)}
            </ul>
            {!mostrarTodos ? (
              <button type="button" id="cfg-local-pacote-mostrar-todos" className="ck-btn ck-btn--secundario ck-btn--sm ckp-pacote__btn" onClick={() => setMostrarTodos(true)}>Mostrar todos (Igual e Manter)</button>
            ) : null}
            {previa.muda_links ? <p className="ckp-pacote__aviso" id="cfg-local-pacote-previa-links" data-status="alerta">Atenção: este pacote muda links e contas das automações. Confira antes de confirmar.</p> : null}
            <p className="ckp-meta">Antes de restaurar, um pacote de desfazer do estado atual é criado automaticamente.</p>
            <div className="ckp-linha">
              {!jaIgual ? (
                <button type="button" id="cfg-local-pacote-confirmar" className="ck-btn ck-btn--perigo ck-btn--sm ckp-pacote__btn" onClick={confirmar} disabled={Boolean(ocupado)}>
                  {ocupado === "restaurar" ? "Restaurando…" : "Confirmar restauração"}
                </button>
              ) : null}
              <button type="button" id="cfg-local-pacote-cancelar" className="ck-btn ck-btn--secundario ck-btn--sm ckp-pacote__btn" onClick={() => { setPrevia(null); setRecusa(""); }} disabled={ocupado === "restaurar"}>Cancelar</button>
            </div>
          </div>
        ) : null}

        <details className="ckp-pacote__detalhes" id="cfg-local-pacote-detalhes">
          <summary>O que entra e o que fica de fora</summary>
          <p><strong>Entra:</strong> Configurações (config/), planilhas atuais (cadastro, InvAll, modelo de transferência), apelidos, unidades, usuários manuais, históricos, relatório de chamados e OS, cobertura, lembretes, observações de OS e Sebrae.</p>
          <p><strong>Fica de fora:</strong> .env e chaves de IA, senha do chamado, sessão, perfil do Chrome, .transactions, marcas de cliques irreversíveis (envios e finalizações), travas e caixas de entrada.</p>
        </details>
      </div>
    </section>
  );
}
