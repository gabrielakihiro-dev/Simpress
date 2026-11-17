export function createDraftTracker() {
  const originalValues = new Map<string, string>();
  const currentValues = new Map<string, string>();

  function capture(fieldId: unknown, value: unknown): void {
    const id = String(fieldId ?? "");
    if (!id || originalValues.has(id)) return;
    const normalized = String(value ?? "");
    originalValues.set(id, normalized);
    currentValues.set(id, normalized);
  }

  function update(fieldId: unknown, value: unknown): void {
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

// Publicação em window, lida por paineis/transporte/montar.tsx.
if (typeof window !== "undefined") window.SimpressFormDraftGuard = { createDraftTracker };
