// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Qualquer = any;

export function createRequestGate() {
  let sequence = 0;
  let controller: AbortController | null = null;

  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      sequence += 1;
      return { id: sequence, signal: controller.signal };
    },
    invalidate() {
      controller?.abort();
      controller = null;
      sequence += 1;
      return sequence;
    },
    isCurrent(id: number): boolean {
      return id === sequence;
    },
  };
}

export function serialForTransfer(selectedEquipment: Qualquer, inputValue: unknown): string {
  const serial = String(selectedEquipment?.serial || "").trim().toUpperCase();
  const query = String(inputValue || "").trim().toUpperCase();
  return serial && serial === query ? serial : "";
}

export function isCurrentQuery(
  gate: { isCurrent: (id: number) => boolean },
  requestId: number,
  currentValue: unknown,
  requestedValue: unknown,
): boolean {
  return gate.isCurrent(requestId)
    && String(currentValue || "").trim().toUpperCase() === String(requestedValue || "").trim().toUpperCase();
}

export async function refreshSelectionAfterInventoryReplacement({
  requestGate,
  serial,
  invalidateSearches,
  clearSelection,
  fetchEquipment,
  applyEquipment,
}: {
  requestGate: Qualquer;
  serial: unknown;
  invalidateSearches?: () => void;
  clearSelection?: (keepInput: boolean) => void;
  fetchEquipment: (serial: string, options: { signal: AbortSignal }) => Promise<Qualquer>;
  applyEquipment: (data: Qualquer) => Qualquer;
}): Promise<string> {
  const selectedSerial = String(serial || "").trim().toUpperCase();
  invalidateSearches?.();
  clearSelection?.(false);
  if (!selectedSerial) return "cleared";

  const request = requestGate.begin();
  const clearUnverifiedSelection = () => clearSelection?.(true);
  try {
    const response = await fetchEquipment(selectedSerial, { signal: request.signal });
    if (!requestGate.isCurrent(request.id)) return "stale";
    if (response.status === 404) {
      clearUnverifiedSelection();
      return "missing";
    }
    if (!response.ok) {
      clearUnverifiedSelection();
      return "unavailable";
    }

    const equipment = await response.json();
    if (!requestGate.isCurrent(request.id)) return "stale";
    if (serialForTransfer(equipment, selectedSerial) !== selectedSerial) {
      clearUnverifiedSelection();
      return "missing";
    }

    applyEquipment?.(equipment);
    return "updated";
  } catch (error: Qualquer) {
    if (!requestGate.isCurrent(request.id)) return "stale";
    clearUnverifiedSelection();
    if (error?.status === 404) return "missing";
    return error?.name === "AbortError" ? "stale" : "unavailable";
  }
}

export function formatBrazilPhone(value: unknown): string {
  const original = String(value || "").trim();
  if (!original) return "";

  const extension = original.match(/(?:ramal|ram\.?|ext\.?|x)\s*[:.]?\s*(\d+)\s*$/i);
  if (/[A-Za-zÀ-ÿ]/.test(original) && !extension) return original;

  const phonePart = extension ? original.slice(0, extension.index) : original;
  let digits = phonePart.replace(/\D/g, "");
  const hasPlusPrefix = /^\s*\+55/.test(phonePart);
  const hasZeroPrefix = /^\s*0055/.test(phonePart);
  const hasBarePrefix = !hasPlusPrefix && !hasZeroPrefix && digits.startsWith("55");
  if (hasPlusPrefix) {
    if (digits.length !== 12 && digits.length !== 13) return original;
    digits = digits.slice(2);
  } else if (hasZeroPrefix) {
    if (digits.length !== 14 && digits.length !== 15) return original;
    digits = digits.slice(4);
  } else if (hasBarePrefix && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }

  if (digits.length < 3 || digits.length > 11) return original;

  const areaCode = digits.slice(0, 2);
  const subscriber = digits.slice(2);
  let formattedSubscriber: string;
  if (subscriber.length === 9) {
    formattedSubscriber = `${subscriber.slice(0, 5)}-${subscriber.slice(5)}`;
  } else if (subscriber.length === 8) {
    formattedSubscriber = `${subscriber.slice(0, 4)}-${subscriber.slice(4)}`;
  } else if (subscriber.length > 5) {
    formattedSubscriber = `${subscriber.slice(0, 5)}-${subscriber.slice(5)}`;
  } else {
    formattedSubscriber = subscriber;
  }

  let formatted = `(${areaCode}) ${formattedSubscriber}`;
  const extensionDigits = extension ? extension[1] : "";
  if (extensionDigits) formatted += ` Ramal: ${extensionDigits}`;
  return formatted;
}

// Ponte temporária: sai na react-final-3, quando app.js virar TS.
if (typeof window !== "undefined") {
  window.SimpressTransferUtils = {
    createRequestGate,
    formatBrazilPhone,
    isCurrentQuery,
    refreshSelectionAfterInventoryReplacement,
    serialForTransfer,
  };
}
