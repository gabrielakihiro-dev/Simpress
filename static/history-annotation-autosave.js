(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoryAnnotationAutosave = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  const DEFAULT_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);
  const pendingAnnotationKeys = new Set();
  const annotationRevisions = new Map();
  const unloadGuardWindows = new WeakSet();

  function getErrorMessage(detail, fallback = "Não foi possível salvar a anotação.") {
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map(item => typeof item === "string" ? item : item?.msg)
        .filter(message => typeof message === "string" && message.trim());
      if (messages.length) return messages.join(" ");
    }
    if (detail && typeof detail === "object") {
      if (typeof detail.message === "string" && detail.message.trim()) return detail.message;
      if (typeof detail.msg === "string" && detail.msg.trim()) return detail.msg;
    }
    return fallback;
  }

  function isRetryableError(error) {
    if (error?.name === "AbortError") return false;
    const status = Number(error?.status);
    return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function requestWithRetries(send, options = {}) {
    const retryDelays = options.retryDelays || DEFAULT_RETRY_DELAYS_MS;
    const isCurrent = options.isCurrent || (() => true);
    const sleep = options.sleep || (delay => new Promise(resolve => setTimeout(resolve, delay)));
    const onRetry = options.onRetry || (() => {});

    for (let retries = 0; ; retries += 1) {
      if (!isCurrent()) return { stale: true };
      try {
        const response = await send();
        if (!isCurrent()) return { stale: true };
        if (!response?.ok) {
          let data = {};
          if (typeof response?.json === "function") {
            try {
              data = await response.json();
            } catch (error) {
              data = {};
            }
          }
          const failure = new Error(getErrorMessage(data.detail));
          failure.status = response?.status;
          throw failure;
        }
        return { stale: false, response };
      } catch (error) {
        if (!isCurrent()) return { stale: true };
        if (!isRetryableError(error) || retries >= retryDelays.length) throw error;
        const attempt = retries + 1;
        onRetry(attempt, error);
        await sleep(retryDelays[retries]);
      }
    }
  }

  function installPendingNavigationGuard(windowObject = root) {
    if (!windowObject?.addEventListener || unloadGuardWindows.has(windowObject)) return;
    unloadGuardWindows.add(windowObject);
    windowObject.addEventListener("beforeunload", event => {
      if (!pendingAnnotationKeys.size) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  function createDraftStorageKey(eventId, itemId) {
    return "simpress:historico-anotacao:"
      + encodeURIComponent(eventId)
      + ":"
      + encodeURIComponent(itemId);
  }

  function readAnnotationVersion(textarea) {
    try {
      return JSON.parse(textarea.dataset.annotationVersion || "null");
    } catch (error) {
      return null;
    }
  }

  function createRevisionId() {
    if (typeof root.crypto?.randomUUID === "function") return root.crypto.randomUUID().replace(/-/g, "");
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function attachAnnotationAutosave({
    textarea,
    status,
    retryButton,
    eventId,
    itemId,
    send,
    retryOptions = {},
    storage,
    windowObject = root,
  }) {
    const key = createDraftStorageKey(eventId, itemId);
    installPendingNavigationGuard(windowObject);
    let draftStorage = storage;
    if (draftStorage === undefined) {
      try {
        draftStorage = windowObject.localStorage;
      } catch (error) {
        draftStorage = null;
      }
    }
    let revision = (annotationRevisions.get(key) || 0) + 1;
    annotationRevisions.set(key, revision);
    let dirty = false;
    let saving = false;
    let timer = null;
    let version = readAnnotationVersion(textarea);
    let conflicted = Boolean(version?.anotacao_conflito);
    let resolvingConflict = false;
    let conflictPanel = null;
    let requestAttempt = null;
    let draftBases = null;

    const updateVersion = data => {
      if (!Array.isArray(data?.anotacao_revisoes)) return;
      version = data;
      textarea.dataset.annotationVersion = JSON.stringify(data);
      conflicted = Boolean(data.anotacao_conflito);
      resolvingConflict = false;
      renderConflict();
    };
    const renderConflict = () => {
      conflictPanel?.remove();
      conflictPanel = null;
      textarea.readOnly = conflicted;
      if (!conflicted || !textarea.ownerDocument) return;
      const doc = textarea.ownerDocument;
      conflictPanel = doc.createElement("div");
      conflictPanel.className = "mt-2 space-y-2 text-xs text-amber-200";
      conflictPanel.setAttribute("role", "group");
      conflictPanel.setAttribute("aria-label", "Resolver conflito de anotação");
      const notice = doc.createElement("p");
      notice.textContent = "Conflito de anotação. As versões foram preservadas. Escolha ou componha um texto e confirme a resolução.";
      conflictPanel.append(notice);
      for (const candidate of version.anotacao_conflitos || []) {
        const text = doc.createElement("p");
        text.className = "whitespace-pre-wrap break-words";
        text.textContent = candidate.anotacao || "(Anotação vazia)";
        const choose = doc.createElement("button");
        choose.type = "button";
        choose.className = "rounded border border-slate-600 px-2 py-1";
        choose.textContent = "Usar esta versão";
        choose.addEventListener("click", () => { textarea.value = candidate.anotacao; });
        conflictPanel.append(text, choose);
      }
      const compose = doc.createElement("button");
      compose.type = "button";
      compose.className = "rounded border border-slate-600 px-2 py-1";
      compose.textContent = "Editar texto para resolução";
      compose.addEventListener("click", () => { textarea.readOnly = false; textarea.focus(); });
      const resolve = doc.createElement("button");
      resolve.type = "button";
      resolve.className = "rounded border border-amber-400 px-2 py-1";
      resolve.textContent = "Resolver conflito com este texto";
      resolve.disabled = Boolean(version.anotacao_bases_ausentes?.length || version.anotacao_integridade_invalida);
      resolve.addEventListener("click", () => {
        conflicted = false;
        resolvingConflict = true;
        draftBases = [...version.anotacao_revisoes];
        onInput();
        scheduleSave(0);
      });
      if (version.anotacao_integridade_invalida) notice.textContent += " Há arquivos de revisão inconsistentes; preserve-os para análise.";
      else if (resolve.disabled) notice.textContent += " Aguarde a chegada das revisões-base pela sincronização e reabra o resultado.";
      conflictPanel.append(compose, resolve);
      textarea.parentElement.append(conflictPanel);
      setStatus("Conflito de anotação; resolução necessária", "text-amber-300");
    };

    const setPending = pending => {
      textarea.dataset.annotationPending = String(pending);
      if (pending) pendingAnnotationKeys.add(key);
      else pendingAnnotationKeys.delete(key);
    };
    const setStatus = (message, colorClass, canRetry = false) => {
      status.textContent = message;
      status.className = "mt-1 text-[10px] " + colorClass;
      if (retryButton) {
        retryButton.hidden = !canRetry;
        retryButton.disabled = saving;
      }
    };
    const persistDraft = value => {
      try {
        const saved = version ? JSON.stringify({
          format: "simpress-annotation-draft-v2", text: value,
          bases: draftBases ?? version.anotacao_revisoes ?? [],
          attempt: requestAttempt, resolveConflict: resolvingConflict,
        }) : value;
        draftStorage?.setItem(key, saved);
      } catch (error) {
        return false;
      }
      return true;
    };
    const removeDraft = () => {
      try {
        draftStorage?.removeItem(key);
      } catch (error) {
        return false;
      }
      return true;
    };
    const scheduleSave = delay => {
      windowObject.clearTimeout(timer);
      timer = windowObject.setTimeout(() => {
        timer = null;
        void saveAnnotation();
      }, delay);
    };

    async function saveAnnotation() {
      version = readAnnotationVersion(textarea) || version;
      conflicted = Boolean(version?.anotacao_conflito) && !resolvingConflict;
      if (saving || !dirty || conflicted) return;
      const annotation = textarea.value;
      const requestRevision = revision;
      const baseRevisions = draftBases ?? version?.anotacao_revisoes ?? [];
      const resolveConflict = resolvingConflict;
      const attemptKey = JSON.stringify([annotation, baseRevisions, resolveConflict]);
      if (!requestAttempt || requestAttempt.key !== attemptKey) {
        requestAttempt = { key: attemptKey, id: version ? createRevisionId() : undefined };
      }
      const revisionId = requestAttempt.id;
      persistDraft(annotation);
      saving = true;
      setStatus("Salvando...", "text-cyan-300");
      if (retryButton) retryButton.disabled = true;

      try {
        const result = await requestWithRetries(
          async () => {
            const response = await send({
              eventId,
              itemId,
              annotation,
              storageKey: key,
              revisionId, baseRevisions, resolveConflict,
            });
            // Even an obsolete UI request may have published a causal revision.
            if (response?.ok && response.clone) {
              updateVersion(await response.clone().json());
            }
            return response;
          },
          {
            ...retryOptions,
            isCurrent: () => annotationRevisions.get(key) === requestRevision
              && textarea.value === annotation,
            onRetry: attempt => setStatus(
              "Falha temporária. Tentando salvar novamente (" + attempt + "/3)...",
              "text-amber-300"
            ),
          }
        );
        if (conflicted) {
          dirty = true;
          persistDraft(textarea.value);
          setPending(true);
          setStatus("Conflito de anotação; versões preservadas", "text-amber-300");
          return;
        }
        if (result.stale) {
          if (annotationRevisions.get(key) !== revision) return;
          dirty = textarea.value !== annotation;
          if (!dirty) removeDraft();
          setPending(dirty);
          setStatus(
            dirty ? "Salvando alteração mais recente..." : "Salvo automaticamente",
            dirty ? "text-cyan-300" : "text-emerald-300"
          );
          return;
        }

        let responseData = {};
        if (typeof result.response?.json === "function") {
          try {
            responseData = await result.response.json();
          } catch (error) {
            responseData = {};
          }
        }
        updateVersion(responseData);
        if (conflicted) {
          dirty = true;
          persistDraft(textarea.value);
          setPending(true);
          setStatus("Conflito de anotação; versões preservadas", "text-amber-300");
          return;
        }
        const synchronizationPending = responseData?.sincronizacao === "pendente";
        const savedOnThisDevice = responseData?.sincronizacao === "local";
        dirty = textarea.value !== annotation
          || annotationRevisions.get(key) !== requestRevision;
        if (!dirty) {
          draftBases = null;
          removeDraft();
        } else if (version) {
          // A newer local edit may include the revision just acknowledged by this request.
          draftBases = [...version.anotacao_revisoes];
          persistDraft(textarea.value);
        }
        setPending(dirty);
        setStatus(
          dirty
            ? "Salvando..."
            : synchronizationPending
              ? "Salvo neste dispositivo; sincronização pendente"
              : savedOnThisDevice
                ? "Salvo neste dispositivo"
                : "Salvo automaticamente",
          dirty
            ? "text-cyan-300"
            : synchronizationPending
              ? "text-amber-300"
              : "text-emerald-300",
          !dirty && synchronizationPending
        );
      } catch (error) {
        dirty = true;
        setPending(true);
        setStatus(
          error.status ? error.message : "Falha de conexão após três tentativas. Tente novamente.",
          "text-rose-300",
          true
        );
      } finally {
        saving = false;
        if (retryButton) retryButton.disabled = false;
        if (dirty && textarea.value !== annotation) scheduleSave(0);
      }
    }

    const onInput = () => {
      if (!dirty) draftBases = version ? [...version.anotacao_revisoes] : null;
      revision += 1;
      annotationRevisions.set(key, revision);
      dirty = true;
      setPending(true);
      persistDraft(textarea.value);
      setStatus("Pendente de salvamento...", "text-slate-400");
      scheduleSave(500);
    };
    const onBlur = () => scheduleSave(0);
    const onRetry = () => {
      if (!dirty) {
        dirty = true;
        setPending(true);
        persistDraft(textarea.value);
      }
      scheduleSave(0);
    };
    const onVersionChange = () => updateVersion(readAnnotationVersion(textarea));

    textarea.addEventListener("input", onInput);
    textarea.addEventListener("blur", onBlur);
    textarea.addEventListener("annotationversionchange", onVersionChange);
    retryButton?.addEventListener("click", onRetry);

    try {
      const savedDraft = draftStorage?.getItem(key);
      if (typeof savedDraft === "string") {
        textarea.value = savedDraft;
        if (version) {
          // Plain legacy drafts have no causal basis. Keep them independent of newer notes.
          draftBases = [];
          try {
            const recovered = JSON.parse(savedDraft);
            if (recovered?.format === "simpress-annotation-draft-v2"
                && typeof recovered.text === "string" && Array.isArray(recovered.bases)
                && recovered.bases.every(id => typeof id === "string")) {
              textarea.value = recovered.text;
              draftBases = recovered.bases;
              if (/^[a-f0-9]{32}$/.test(recovered.attempt?.id)) requestAttempt = recovered.attempt;
              resolvingConflict = recovered.resolveConflict === true;
            }
          } catch (error) { /* A legacy draft remains plain text. */ }
        }
        dirty = true;
        revision += 1;
        annotationRevisions.set(key, revision);
        setPending(true);
        setStatus("Rascunho recuperado. Tentando salvar...", "text-amber-300");
        scheduleSave(0);
      } else {
        setPending(false);
      }
    } catch (error) {
      setPending(false);
    }
    renderConflict();

    return {
      dispose() {
        windowObject.clearTimeout(timer);
        textarea.removeEventListener("input", onInput);
        textarea.removeEventListener("blur", onBlur);
        textarea.removeEventListener("annotationversionchange", onVersionChange);
        retryButton?.removeEventListener("click", onRetry);
        conflictPanel?.remove();
      },
    };
  }

  return {
    DEFAULT_RETRY_DELAYS_MS,
    attachAnnotationAutosave,
    createDraftStorageKey,
    getErrorMessage,
    installPendingNavigationGuard,
    isRetryableError,
    requestWithRetries,
    readAnnotationVersion,
  };
});
