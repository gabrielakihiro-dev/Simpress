(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoryAnnotationAutosave = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
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
        draftStorage?.setItem(key, value);
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
      if (saving || !dirty) return;
      const annotation = textarea.value;
      const requestRevision = revision;
      saving = true;
      setStatus("Salvando...", "text-cyan-300");
      if (retryButton) retryButton.disabled = true;

      try {
        const result = await requestWithRetries(
          () => send({
            eventId,
            itemId,
            annotation,
            storageKey: key,
          }),
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

        dirty = textarea.value !== annotation
          || annotationRevisions.get(key) !== requestRevision;
        if (!dirty) removeDraft();
        setPending(dirty);
        setStatus(
          dirty ? "Salvando..." : "Salvo automaticamente",
          dirty ? "text-cyan-300" : "text-emerald-300"
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
      revision += 1;
      annotationRevisions.set(key, revision);
      dirty = true;
      setPending(true);
      persistDraft(textarea.value);
      setStatus("Pendente de salvamento...", "text-slate-400");
      scheduleSave(500);
    };
    const onBlur = () => scheduleSave(0);
    const onRetry = () => scheduleSave(0);

    textarea.addEventListener("input", onInput);
    textarea.addEventListener("blur", onBlur);
    retryButton?.addEventListener("click", onRetry);

    try {
      const savedDraft = draftStorage?.getItem(key);
      if (typeof savedDraft === "string") {
        textarea.value = savedDraft;
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

    return {
      dispose() {
        windowObject.clearTimeout(timer);
        textarea.removeEventListener("input", onInput);
        textarea.removeEventListener("blur", onBlur);
        retryButton?.removeEventListener("click", onRetry);
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
  };
});
