/** SEBRAE units catalog: loads the destination units and manages them in the catalog dialog. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else (root.SimpressFeatures = root.SimpressFeatures || {}).unitsCatalog = factory;
})(typeof window !== "undefined" ? window : globalThis, function createUnitsCatalog(context) {
  "use strict";
  const { app, appState, catalogSearch } = context;
  const { escapeHtml, pluralize } = context.dom;

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

  // ==========================================
  // MODAL DE GERENCIAMENTO DE REGIONAIS
  // ==========================================
  function abrirModalGerenciarUnidades() {
    document.getElementById("input-filtro-unidades").value = "";
    app.toggleFormNovaUnidade(false);
    renderListaUnidades(appState.unidadesList);
    document.getElementById("badge-total-unidades-modal").textContent = `${appState.unidadesList.length} ${pluralize(appState.unidadesList.length, "unidade")}`;
    app.abrirModalAcessivel("modal-gerenciar-unidades", "#input-filtro-unidades", "fecharModalGerenciarUnidades", "btn-catalogo-unidades");
  }

  function fecharModalGerenciarUnidades() {
    app.fecharModalAcessivel("modal-gerenciar-unidades");
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

  function renderListaUnidades(lista) {
    const container = document.getElementById("lista-unidades-container");
    container.innerHTML = "";

    if (!lista || lista.length === 0) {
      container.innerHTML = `
          <div class="ckp-vazio">Nenhuma unidade encontrada com o termo filtrado.</div>
        `;
      return;
    }

    lista.forEach(u => {
      const item = document.createElement("div");
      item.className = "ckp-regional";
      item.innerHTML = `
          <span class="ckp-regional__ico"><svg class="ck-ico ck-ico--sm" aria-hidden="true"><use href="#i-pin"></use></svg></span>
          <span class="ckp-secao__textos">
            <span class="unit-list-identity ckp-regional__nome">${escapeHtml(u.cidade)}${u.is_sede ? ' <span class="ck-badge" data-status="ok">SEDE</span>' : ''}</span>
            <span class="unit-list-address ckp-regional__meta">${escapeHtml(u.endereco)}</span>
            <span class="unit-list-cnpj ckp-regional__meta">${escapeHtml(u.cnpj)} · CEP: ${escapeHtml(u.cep)} · UF: ${escapeHtml(u.uf || 'PR')}</span>
          </span>
          <span class="ckp-linha">
            <button type="button" data-copy-field="CNPJ" class="ck-btn ck-btn--fantasma ck-btn--sm" title="Copiar CNPJ" aria-label="Copiar CNPJ">CNPJ</button>
            <button type="button" data-copy-field="CEP" class="ck-btn ck-btn--fantasma ck-btn--sm" title="Copiar CEP" aria-label="Copiar CEP">CEP</button>
            <button type="button" data-action="edit" class="ck-btn ck-btn--secundario ck-btn--sm" title="Editar dados desta unidade">Editar</button>
          </span>
        `;
      item.querySelector('[data-copy-field="CNPJ"]').addEventListener("click", () => copiarDadoUnidade(u.cnpj, "CNPJ"));
      item.querySelector('[data-copy-field="CEP"]').addEventListener("click", () => copiarDadoUnidade(u.cep, "CEP"));
      item.querySelector('[data-action="edit"]').addEventListener("click", () => editarUnidade(Number(u.id)));
      container.appendChild(item);
    });
    lucide.createIcons({ root: container });
  }

  function filtrarUnidadesModal(query) {
    const filtradas = appState.unidadesList.filter(unit => catalogSearch.matchesCatalogSearch(unit, query));
    renderListaUnidades(filtradas);
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
      form.classList.add("hidden");
    }
  }

  function editarUnidade(id) {
    const unit = appState.unidadesList.find(u => u.id === id);
    if (!unit) return;

    document.getElementById("form-unidade-id").value = unit.id;
    document.getElementById("form-unidade-cidade").value = unit.cidade || "";
    document.getElementById("form-unidade-endereco").value = unit.endereco || "";
    document.getElementById("form-unidade-cep").value = unit.cep || "";
    document.getElementById("form-unidade-cnpj").value = unit.cnpj || "";
    document.getElementById("form-unidade-titulo").textContent = `Editar Unidade: ${unit.cidade}`;

    document.getElementById("form-nova-unidade").classList.remove("hidden");
    document.getElementById("form-unidade-endereco").focus();
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
      renderListaUnidades(appState.unidadesList);
      app.toggleFormNovaUnidade(false);
      app.showToast(data.mensagem || "Unidade salva com sucesso!", "success");

    } catch (err) {
      console.error("Erro ao salvar unidade:", err);
      app.showToast(err.message, "error");
    }
  }

  return {
    carregarUnidades, abrirModalGerenciarUnidades, fecharModalGerenciarUnidades, filtrarUnidadesModal,
    toggleFormNovaUnidade, salvarUnidadeForm,
  };
});
