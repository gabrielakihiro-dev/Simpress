/** Seletor de arquivo do Cockpit (label.ckp-arquivo): estado, arrastar e soltar, remover e botões [data-requer]. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Qualquer = any;

const tamanho = (bytes: number): string => bytes > 1048576
  ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function validarRequisitos(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-requer]").forEach(botao => {
    const escopo = document.getElementById(botao.dataset.requer as string);
    if (!escopo) return;
    botao.disabled = ![...escopo.querySelectorAll<HTMLInputElement>("input[data-obrigatorio]")].every(input => input.files?.length);
  });
}

// Redesenha o rótulo a partir do input; chame após mudar input.files/value por código.
export function atualizar(rotulo: Qualquer): void {
  const input = rotulo.querySelector("input[type=file]");
  const nome = rotulo.querySelector(".ckp-arquivo__nome");
  const meta = rotulo.querySelector(".ckp-arquivo__meta");
  const trocar = rotulo.querySelector(".ckp-arquivo__trocar");
  const arquivo = input.files?.[0];
  rotulo.dataset.estado = arquivo ? "selecionado" : "vazio";
  nome.textContent = arquivo ? arquivo.name : nome.dataset.vazio;
  nome.title = arquivo ? arquivo.name : "";
  meta.textContent = arquivo ? `${tamanho(arquivo.size)} · pronto para importar` : meta.dataset.vazio;
  if (trocar) trocar.textContent = arquivo ? "Trocar" : "Escolher";
  const secao = rotulo.closest(".ckp-secao");
  if (secao) secao.dataset.pronta = String(Boolean(arquivo));
  validarRequisitos();
}

export function atualizarTodos(raiz: Qualquer = document): void {
  raiz.querySelectorAll(".ckp-arquivo").forEach(atualizar);
}

// Efeitos no carregamento, como no arquivo antigo: ouvintes delegados no document e a ponte window.SimpressFilePicker.
if (typeof window !== "undefined") {
  document.addEventListener("change", (event: Qualquer) => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (rotulo && event.target.matches("input[type=file]")) atualizar(rotulo);
  });
  document.addEventListener("dragover", (event: Qualquer) => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (!rotulo) return;
    event.preventDefault();
    rotulo.dataset.arrastando = "true";
  });
  document.addEventListener("dragleave", (event: Qualquer) => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (rotulo) rotulo.dataset.arrastando = "false";
  });
  document.addEventListener("drop", (event: Qualquer) => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (!rotulo) return;
    event.preventDefault();
    rotulo.dataset.arrastando = "false";
    if (!event.dataTransfer?.files?.length) return;
    const input = rotulo.querySelector("input[type=file]");
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  document.addEventListener("click", (event: Qualquer) => {
    const remover = event.target.closest?.(".ckp-arquivo [data-remover]");
    if (!remover) return;
    event.preventDefault();
    event.stopPropagation();
    const input = remover.closest(".ckp-arquivo").querySelector("input[type=file]");
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Ponte temporária: sai na react-final-3, quando app.js virar TS.
  window.SimpressFilePicker = { atualizar, atualizarTodos };
  atualizarTodos();
}
