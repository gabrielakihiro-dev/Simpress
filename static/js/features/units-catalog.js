/** SEBRAE units catalog: loads the destination units and keeps the register/edit form of the Catálogo de unidades panel. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).unitsCatalog = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUnitsCatalog(context) {
  "use strict";
  const { app, appState } = context;
  const { pluralize } = context.dom;

  // Load SEBRAE units catalog from API
  async function carregarUnidades() {
    try {
      const res = await fetch("/api/unidades");
      if (res.ok) {
        appState.unidadesList = await res.json();
        const select = document.getElementById("select-unidade-destino");
        const selectedUnitId = select.value;
        select.innerHTML = '<option value="">Selecione a filial</option>';

        appState.unidadesList.forEach(u => {
          const opt = document.createElement("option");
          opt.value = u.id;
          opt.textContent = u.label || `${u.cidade} - ${u.endereco} (${u.cnpj})`;
          select.appendChild(opt);
        });

        const selectedUnit = appState.unidadesList.find(unit => String(unit.id) === String(selectedUnitId));
        if (selectedUnit) {
          select.value = selectedUnit.id;
          app.handleUnidadeDestinoChange(selectedUnit.id, false);
        } else if (selectedUnitId) {
          select.value = "";
          document.getElementById("entrega-cnpj").value = "";
          document.getElementById("entrega-endereco").value = "";
          app.preencherRepresentanteRegional("entrega", "");
        }
        app.atualizarEstadoCopiaCnpjEntrega();
        app.atualizarChipsUnidade?.();

        const countEl = document.getElementById("filiais-count");
        if (countEl) countEl.textContent = `${appState.unidadesList.length} ${pluralize(appState.unidadesList.length, "filial catalogada", "filiais catalogadas")}`;
      }
    } catch (err) {
      console.error("Falha ao carregar unidades:", err);
      app.showToast("Não foi possível carregar o catálogo de unidades. Recarregue a página e tente de novo.", "error");
    }
  }

  // O catálogo mora no painel "unidades" do Cockpit; a Home e os atalhos antigos continuam chamando este nome.
  async function abrirModalGerenciarUnidades() {
    const search = document.getElementById("cockpit-units-search");
    if (search) search.value = "";
    await app.abrirPainelCockpit("unidades");
    // Home pede "Cadastrar" quando não há regional: abre o formulário vazio.
    if (!appState.unidadesList.length) app.toggleFormNovaUnidade(true);
  }

  async function copiarDadoUnidade(valor, campo) {
    const texto = String(valor || "").trim();
    if (!texto) {
      app.showToast(`${campo} não informado para esta unidade.`, "warning");
      return;
    }

    try {
      await app.copiarTextoParaAreaTransferencia(texto);
      app.showToast(campo === "CNPJ" ? "CNPJ copiado" : "CEP Copiado", "success");
    } catch (err) {
      app.showToast(`Não foi possível copiar o ${campo}.`, "error");
    }
  }

  function toggleFormNovaUnidade(show = null) {
    const form = document.getElementById("form-nova-unidade");
    const isHidden = form.classList.contains("hidden");
    const shouldShow = show !== null ? show : isHidden;

    if (shouldShow) {
      document.getElementById("form-unidade-id").value = "";
      document.getElementById("form-unidade-cidade").value = "";
      document.getElementById("form-unidade-endereco").value = "";
      document.getElementById("form-unidade-cep").value = "";
      document.getElementById("form-unidade-cnpj").value = "";
      document.getElementById("form-unidade-titulo").textContent = "Cadastrar Nova Unidade / Filial";
      form.classList.remove("hidden");
      document.getElementById("form-unidade-cidade").focus();
    } else {
      // Sem isso o foco se perde quando o formulário some com um botão dele em foco.
      if (form.contains(document.activeElement)) document.getElementById("cockpit-units-new")?.focus();
      form.classList.add("hidden");
    }
  }

  function editarUnidade(id, focoId = "form-unidade-endereco") {
    const unit = appState.unidadesList.find(u => u.id === id);
    if (!unit) return;

    document.getElementById("form-unidade-id").value = unit.id;
    document.getElementById("form-unidade-cidade").value = unit.cidade || "";
    document.getElementById("form-unidade-endereco").value = unit.endereco || "";
    document.getElementById("form-unidade-cep").value = unit.cep || "";
    document.getElementById("form-unidade-cnpj").value = unit.cnpj || "";
    document.getElementById("form-unidade-titulo").textContent = `Editar Unidade: ${unit.cidade}`;

    document.getElementById("form-nova-unidade").classList.remove("hidden");
    document.getElementById(focoId).focus();
  }

  async function salvarUnidadeForm() {
    const cidade = document.getElementById("form-unidade-cidade").value.trim();
    const endereco = document.getElementById("form-unidade-endereco").value.trim();
    const cep = document.getElementById("form-unidade-cep").value.trim();
    const cnpj = document.getElementById("form-unidade-cnpj").value.trim();
    const idVal = document.getElementById("form-unidade-id").value;

    if (!cidade || !endereco || !cnpj) {
      app.showToast("Cidade, endereço e CNPJ são campos obrigatórios.", "warning");
      return;
    }

    const payload = {
      id: idVal ? parseInt(idVal) : null,
      cidade: cidade,
      endereco: endereco,
      uf: "PR",
      cep: cep,
      cnpj: cnpj
    };

    try {
      const data = await app.apiFetch("/api/unidade/salvar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        errorMessage: "Erro ao salvar unidade.",
      });
      await app.carregarUnidades();
      // A lista do painel é independente de appState.unidadesList.
      await app.recarregarUnidadesCockpit?.();
      app.toggleFormNovaUnidade(false);
      app.showToast(data.mensagem || "Unidade salva com sucesso!", "success");

    } catch (err) {
      console.error("Erro ao salvar unidade:", err);
      app.showToast(err.message, "error");
    }
  }

  return {
    carregarUnidades, abrirModalGerenciarUnidades, copiarDadoUnidade, editarUnidade,
    toggleFormNovaUnidade, salvarUnidadeForm,
  };
});
