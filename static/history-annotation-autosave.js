(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HistoryAnnotationAutosave = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DEFAULT_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000]);

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
          const failure = new Error(data.detail || "Não foi possível salvar a anotação.");
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

  return { DEFAULT_RETRY_DELAYS_MS, isRetryableError, requestWithRetries };
});
