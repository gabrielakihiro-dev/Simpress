(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressFormDraftGuard = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  function createDraftTracker() {
    const originalValues = new Map();
    const currentValues = new Map();

    function capture(fieldId, value) {
      const id = String(fieldId ?? "");
      if (!id || originalValues.has(id)) return;
      const normalized = String(value ?? "");
      originalValues.set(id, normalized);
      currentValues.set(id, normalized);
    }

    function update(fieldId, value) {
      const id = String(fieldId ?? "");
      if (!id) return;
      capture(id, value);
      currentValues.set(id, String(value ?? ""));
    }

    return {
      capture,
      update,
      isDirty: () => [...originalValues].some(([id, original]) => currentValues.get(id) !== original),
      reset: () => {
        originalValues.clear();
        currentValues.clear();
      },
    };
  }

  return { createDraftTracker };
});
