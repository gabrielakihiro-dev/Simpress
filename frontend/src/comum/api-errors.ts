type ApiErrorItem = Record<string, unknown> & { msg?: unknown; message?: unknown; detail?: unknown };

function readableMessage(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object") return "";

  const candidate = value as ApiErrorItem;
  for (const key of ["msg", "message", "detail"]) {
    const message = candidate[key];
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "";
}

export function format(detail: unknown, fallback: string): string {
  const entries = Array.isArray(detail) ? detail : [detail];
  const messages = entries.map(readableMessage).filter(Boolean);
  return messages.length ? [...new Set(messages)].join("; ") : fallback;
}

export function create(detail: unknown, fallback: string): Error {
  return new Error(format(detail, fallback));
}

// Ponte temporária: sai na react-final-3, quando app.js virar TS.
if (typeof window !== "undefined") window.SimpressApiErrors = { create, format };
