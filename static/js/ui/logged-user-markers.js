/** Logged user shown next to a series (Histórico de Planilhas rows, ticket cards), with the Home rule. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory;
  else root.SimpressLoggedUserMarkers = factory;
})(typeof window !== "undefined" ? window : globalThis, function createLoggedUserMarkers(context) {
  "use strict";
  const { app, appState } = context;
  const { escapeHtml } = context.dom;

  // "2026-10-20T09:15:00-03:00" -> "20/10/2026", read as written so the time zone never shifts the day.
  const dataInformada = valor => {
    const partes = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor || "").trim());
    return partes ? `${partes[3]}/${partes[2]}/${partes[1]}` : "";
  };
  // Manual users saved before the date was recorded have none.
  const tituloManual = informadoEm => {
    const data = dataInformada(informadoEm);
    return data ? `Informado manualmente em ${data}` : "Informado manualmente (data não registrada)";
  };
  // A series repeated in the Endpoint: its users are shown, none is chosen as the logged user.
  const textoAmbiguo = candidatos => {
    const lista = (Array.isArray(candidatos) ? candidatos : []).map(item => String(item || "").trim()).filter(Boolean);
    return lista.length ? `Endpoint ambíguo: ${lista.join(" / ")}` : "";
  };
  const TITULO_AMBIGUO = "A série aparece em mais de uma linha do Endpoint; nenhum usuário foi escolhido automaticamente.";

  // Empty placeholder filled by conectar(); a row without a series gets none. `sugestao` is a manual user
  // archived when the Endpoint informed one: it only pre-fills the field, and nothing is saved until confirmed.
  const marcador = (serie, { sugestao = "" } = {}) => String(serie || "").trim()
    ? `<span class="logged-user" data-logged-user data-logged-user-serie="${escapeHtml(String(serie).trim())}"${String(sugestao || "").trim()
      ? ` data-logged-user-sugestao="${escapeHtml(String(sugestao).trim())}"`
      : ""}></span>`
    : "";

  // The Endpoint user wins and a manual user (M) fills the gap. Equipment in the Simpress base without a
  // user gets a field; the value saved here is the same one the Home search uses.
  function conectar(container) {
    if (typeof container?.querySelectorAll !== "function") return;
    const marcadores = () => Array.from(container.querySelectorAll("[data-logged-user]"));
    const series = [...new Set(marcadores().map(item => item.dataset.loggedUserSerie).filter(Boolean))];
    if (!series.length) return;
    const usuarios = {};

    const mostrar = serie => {
      const info = usuarios[serie] || {};
      marcadores().filter(item => item.dataset.loggedUserSerie === serie).forEach(item => {
        const usuario = String(info.usuario || "").trim();
        const editavel = Boolean(info.serial_cadastro);
        const manual = info.origem === "manual";
        const ambiguo = textoAmbiguo(info.candidatos);
        const avisoAmbiguo = ambiguo
          ? `<span class="logged-user-ambiguous" data-logged-user-ambiguous title="${escapeHtml(TITULO_AMBIGUO)}">${escapeHtml(ambiguo)}</span>`
          : "";
        if (usuario) {
          const titulo = manual ? tituloManual(info.informado_em) : "";
          item.innerHTML = `<span class="logged-user-row"><span data-logged-user-value${titulo ? ` title="${escapeHtml(titulo)}"` : ""}>Usuário: ${escapeHtml(usuario)}${manual
            ? ` (M)<span class="sr-only">, ${escapeHtml(titulo.toLowerCase())}</span>`
            : ""}</span>${manual && editavel
            ? `<button type="button" class="btn btn-tertiary equipment-user-button" data-logged-user-edit title="Alterar o usuário informado manualmente">Editar</button>`
            : ""}</span>${avisoAmbiguo}`;
        } else if (editavel) {
          const sugestao = String(item.dataset.loggedUserSugestao || "").trim();
          item.innerHTML = `${avisoAmbiguo}${sugestao
            ? `<span class="logged-user-hint" data-logged-user-archived>Manual arquivado: ${escapeHtml(sugestao)}. Confirme para restaurar.</span>`
            : ""}${formularioUsuario(serie, sugestao, sugestao ? "Restaurar manual" : "Salvar usuário")}`;
        } else if (ambiguo) {
          item.innerHTML = avisoAmbiguo;
        } else {
          item.textContent = "Sem usuário no Endpoint";
        }
        item.querySelector("[data-logged-user-edit]")?.addEventListener("click", () => {
          item.innerHTML = avisoAmbiguo + formularioUsuario(serie, usuario);
          conectarFormulario(item, serie);
          item.querySelector("input")?.select();
        });
        conectarFormulario(item, serie);
      });
    };

    const formularioUsuario = (serie, valor, rotuloBotao = "Salvar usuário") => `
      <form class="logged-user-form" data-logged-user-form autocomplete="off">
        <input type="text" maxlength="160" class="equipment-user-input" value="${escapeHtml(valor)}" placeholder="Digite o usuário" aria-label="${escapeHtml(`Usuário logado da série ${serie}`)}">
        <button type="submit" class="btn btn-secondary equipment-user-button">${escapeHtml(rotuloBotao)}</button>
      </form>`;

    const conectarFormulario = (item, serie) => {
      const form = item.querySelector("[data-logged-user-form]");
      if (!form) return;
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const campo = form.querySelector("input");
        const botao = form.querySelector("button");
        const usuario = campo.value.trim();
        if (!usuario) {
          app.showToast("Digite o usuário antes de salvar.", "warning");
          campo.focus();
          return;
        }
        const serialCadastro = usuarios[serie]?.serial_cadastro;
        botao.disabled = true;
        botao.setAttribute("aria-busy", "true");
        try {
          const data = await app.apiFetch("/api/equipamento/atualizar-usuario", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ serial: serialCadastro, usuario }),
            errorMessage: "Falha ao salvar o usuário.",
          });
          const equipamento = data.equipamento || {};
          // Every copy of the same equipment (desktop table, mobile card, other sections) shows the new user.
          Object.keys(usuarios).filter(chave => usuarios[chave]?.serial_cadastro === serialCadastro).forEach(chave => {
            usuarios[chave] = {
              ...usuarios[chave],
              usuario: equipamento.usuarios_logados || "",
              origem: equipamento.usuarios_logados_origem || "",
              informado_em: equipamento.usuarios_logados_informado_em || "",
              candidatos: equipamento.usuarios_logados_candidatos || usuarios[chave]?.candidatos || [],
            };
            mostrar(chave);
          });
          if (appState.currentEquipamento && appState.currentEquipamento.serial === equipamento.serial) {
            app.definirEquipamentoAtual(equipamento);
            app.atualizarUsuarioLogadoCard?.(appState.currentEquipamento);
          }
          app.showToast("Usuário salvo e registrado no histórico de alterações.", "success");
        } catch (error) {
          console.error("Erro ao salvar usuário logado:", error);
          app.showToast(error.message || "Falha ao salvar o usuário.", "error");
          botao.disabled = false;
          botao.removeAttribute("aria-busy");
        }
      });
    };

    app.apiFetch("/api/equipamentos/usuarios-logados", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ series }),
      errorMessage: "Não foi possível consultar os usuários logados.",
    })
      .then(data => {
        Object.assign(usuarios, data?.usuarios || {});
        series.forEach(mostrar);
      })
      .catch(error => console.error("Erro ao consultar usuários logados:", error));
  }

  return { marcador, conectar, tituloManual, textoAmbiguo, TITULO_AMBIGUO };
});
