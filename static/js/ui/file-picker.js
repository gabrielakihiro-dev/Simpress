/** Seletor de arquivo do Cockpit (label.ckp-arquivo): estado, arrastar e soltar, remover e botões [data-requer]. */
(function () {
  "use strict";

  const tamanho = bytes => bytes > 1048576
    ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  function validarRequisitos() {
    document.querySelectorAll("[data-requer]").forEach(botao => {
      const escopo = document.getElementById(botao.dataset.requer);
      if (!escopo) return;
      botao.disabled = ![...escopo.querySelectorAll("input[data-obrigatorio]")].every(input => input.files?.length);
    });
  }

  // Redesenha o rótulo a partir do input; chame após mudar input.files/value por código.
  function atualizar(rotulo) {
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

  function atualizarTodos(raiz = document) {
    raiz.querySelectorAll(".ckp-arquivo").forEach(atualizar);
  }

  document.addEventListener("change", event => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (rotulo && event.target.matches("input[type=file]")) atualizar(rotulo);
  });
  document.addEventListener("dragover", event => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (!rotulo) return;
    event.preventDefault();
    rotulo.dataset.arrastando = "true";
  });
  document.addEventListener("dragleave", event => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (rotulo) rotulo.dataset.arrastando = "false";
  });
  document.addEventListener("drop", event => {
    const rotulo = event.target.closest?.(".ckp-arquivo");
    if (!rotulo) return;
    event.preventDefault();
    rotulo.dataset.arrastando = "false";
    if (!event.dataTransfer?.files?.length) return;
    const input = rotulo.querySelector("input[type=file]");
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  document.addEventListener("click", event => {
    const remover = event.target.closest?.(".ckp-arquivo [data-remover]");
    if (!remover) return;
    event.preventDefault();
    event.stopPropagation();
    const input = remover.closest(".ckp-arquivo").querySelector("input[type=file]");
    input.value = "";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  window.SimpressFilePicker = { atualizar, atualizarTodos };
  atualizarTodos();
})();
