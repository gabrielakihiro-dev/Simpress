/** Recent equipment lookups shown on Home: the last few series, kept per browser in localStorage. */
export const STORAGE_KEY = "simpress:recent-equipment";
export const LIMIT = 5;

export type RecentEntry = { serial: string; apelido: string; cidade: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Qualquer = any;

export function normalizeEntry(equipment: Qualquer): RecentEntry | null {
  const serial = String(equipment?.serial ?? "").trim().toUpperCase();
  if (!serial) return null;
  return {
    serial,
    apelido: String(equipment?.apelido ?? "").trim(),
    cidade: String(equipment?.cidade ?? equipment?.retirada_cidade ?? "").trim(),
  };
}

// Valid entries only, one per series (first wins), at most `limit`.
export function sanitizeList(list: unknown, limit: number = LIMIT): RecentEntry[] {
  const seen = new Set<string>();
  const entries: RecentEntry[] = [];
  for (const item of Array.isArray(list) ? list : []) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.serial)) continue;
    seen.add(entry.serial);
    entries.push(entry);
    if (entries.length >= limit) break;
  }
  return entries;
}

// Most recent first; a series already in the list moves to the top with its newest data.
export function pushRecentEquipment(list: unknown, equipment: Qualquer, limit: number = LIMIT): RecentEntry[] {
  const entry = normalizeEntry(equipment);
  const rest = sanitizeList(list, Infinity);
  if (!entry) return rest.slice(0, limit);
  return [entry, ...rest.filter(item => item.serial !== entry.serial)].slice(0, limit);
}

export function describeEntry(entry: RecentEntry): string {
  // Starts with the visible series so speech input matches the button text.
  return [
    entry.serial,
    entry.apelido ? `apelido ${entry.apelido}` : "sem apelido",
    entry.cidade ? `cidade ${entry.cidade}` : "cidade não informada",
  ].join(", ") + ". Abrir resultado";
}

// `getStorage` may throw or return null (private mode, blocked storage); the list then lives in memory only.
export function createStore(getStorage: () => Qualquer, key: string = STORAGE_KEY) {
  let memory: RecentEntry[] = [];
  const storage = () => {
    try { return getStorage() || null; } catch (error) { return null; }
  };

  function read(): RecentEntry[] {
    const target = storage();
    if (!target) return memory.slice();
    try {
      return sanitizeList(JSON.parse(target.getItem(key) || "[]"));
    } catch (error) {
      return memory.slice();
    }
  }

  function write(list: unknown): RecentEntry[] {
    memory = sanitizeList(list);
    try { storage()?.setItem(key, JSON.stringify(memory)); } catch (error) { /* optional */ }
    return memory.slice();
  }

  return {
    read,
    add: (equipment: Qualquer) => write(pushRecentEquipment(read(), equipment)),
    clear(): RecentEntry[] {
      memory = [];
      try { storage()?.removeItem(key); } catch (error) { /* optional */ }
      return [];
    },
  };
}

// Ponte temporária: sai na react-final-3, quando app.js virar TS.
if (typeof window !== "undefined") {
  window.SimpressRecentEquipment = Object.freeze({
    STORAGE_KEY, LIMIT, normalizeEntry, sanitizeList, pushRecentEquipment, describeEntry, createStore,
  });
}
