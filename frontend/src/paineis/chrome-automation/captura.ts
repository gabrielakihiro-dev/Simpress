// Diálogo "Ampliar captura" da falha de uma execução. Fica fora do React de propósito: o <dialog> é criado uma vez
// no <body> (ids automacao-captura-*) e reaproveitado, como no módulo antigo.
// url: endereço blob: já carregado por componentes.tsx (um <img src=/api/...> não leva o X-Simpress-Sessao).
export interface Captura { nome: string; url: string }

function criar<K extends keyof HTMLElementTagNameMap>(tag: K, classe: string, texto = ""): HTMLElementTagNameMap[K] {
  const elemento = document.createElement(tag);
  if (classe) elemento.className = classe;
  elemento.textContent = texto;
  return elemento;
}

const origens = new WeakMap<HTMLDialogElement, HTMLElement | null>();

export function abrirCapturaAutomacao(captura: Captura, descricao: string, mensagem: string | undefined, origem: HTMLElement | null) {
  let dialogo = document.getElementById("automacao-captura-dialogo") as HTMLDialogElement | null;
  if (!dialogo) {
    const novo = document.createElement("dialog");
    dialogo = novo;
    novo.id = "automacao-captura-dialogo";
    novo.className = "automation-capture-dialog";
    novo.setAttribute("aria-labelledby", "automacao-captura-titulo");
    const titulo = criar("h3", "automation-capture-title");
    titulo.id = "automacao-captura-titulo";
    const fechar = criar("button", "btn btn-secondary", "Fechar");
    fechar.type = "button";
    fechar.id = "automacao-captura-fechar";
    fechar.addEventListener("click", () => novo.close());
    const cabecalho = criar("div", "automation-capture-header");
    cabecalho.append(titulo, fechar);
    const imagem = document.createElement("img");
    imagem.id = "automacao-captura-imagem";
    imagem.className = "automation-capture-full";
    const mensagemEl = criar("p", "automation-capture-message");
    mensagemEl.id = "automacao-captura-mensagem";
    novo.append(cabecalho, imagem, mensagemEl);
    // Clicar no fundo (o próprio <dialog>) fecha, como o Escape.
    novo.addEventListener("click", evento => { if (evento.target === novo) novo.close(); });
    novo.addEventListener("close", () => {
      const anterior = origens.get(novo);
      origens.set(novo, null);
      if (anterior && anterior.isConnected) anterior.focus();
    });
    document.body.appendChild(novo);
  }
  origens.set(dialogo, origem || null);
  (document.getElementById("automacao-captura-titulo") as HTMLElement).textContent = captura.nome;
  const imagem = document.getElementById("automacao-captura-imagem") as HTMLImageElement;
  imagem.src = captura.url;
  imagem.alt = descricao;
  const mensagemEl = document.getElementById("automacao-captura-mensagem") as HTMLElement;
  mensagemEl.textContent = mensagem || "";
  mensagemEl.hidden = !mensagem;
  if (typeof dialogo.showModal === "function") dialogo.showModal();
  else dialogo.setAttribute("open", "");
  document.getElementById("automacao-captura-fechar")?.focus();
}
