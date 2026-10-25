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
        select.innerHTML = '<option value="">-- Escolha a Cidade ou Regional de Destino --</option>';

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
          <div class="text-center py-8 text-slate-500 text-xs">
            Nenhuma unidade encontrada com o termo filtrado.
          </div>
        `;
      return;
    }

    lista.forEach(u => {
      const item = document.createElement("div");
      item.className = "flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 hover:border-amber-500/30 transition text-xs";
      item.innerHTML = `
          <div class="min-w-0 flex-1">
            <div class="unit-list-identity flex items-center gap-2">
              <span class="font-bold text-white text-sm">${escapeHtml(u.cidade)}</span>
              ${u.is_sede ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">SEDE</span>' : ''}
              <span class="unit-list-cnpj text-slate-400 font-mono text-[11px]">${escapeHtml(u.cnpj)}</span>
              <button type="button" data-copy-field="CNPJ" class="p-1 rounded-md text-slate-400 hover:text-amber-200 hover:bg-slate-800 transition" title="Copiar CNPJ" aria-label="Copiar CNPJ">
                <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
              </button>
            </div>
            <p class="unit-list-address text-slate-300 mt-0.5 truncate">${escapeHtml(u.endereco)}</p>
            <div class="text-slate-500 font-mono text-[11px]">
              <div class="flex items-center gap-1.5">
                <span>CEP: ${escapeHtml(u.cep)}</span>
                <button type="button" data-copy-field="CEP" class="p-1 rounded-md text-slate-400 hover:text-amber-200 hover:bg-slate-800 transition" title="Copiar CEP" aria-label="Copiar CEP">
                  <i data-lucide="copy" class="w-3.5 h-3.5" aria-hidden="true"></i>
                </button>
              </div>
              <div>UF: ${escapeHtml(u.uf || 'PR')}</div>
            </div>
          </div>
          <div class="flex items-center gap-2 ml-3 shrink-0">
            <button
              data-action="edit"
              class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/30 text-xs font-medium flex items-center gap-1 transition"
              title="Editar dados desta unidade"
            >
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
              <span>Editar</span>
            </button>
          </div>
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
