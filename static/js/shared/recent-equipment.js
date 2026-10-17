/** Recent equipment lookups shown on Home: the last few series, kept per browser in localStorage. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SimpressRecentEquipment = api;
})(typeof window !== "undefined" ? window : globalThis, function createRecentEquipment() {
  "use strict";

  const STORAGE_KEY = "simpress:recent-equipment";
  const LIMIT = 5;

  function normalizeEntry(equipment) {
    const serial = String(equipment?.serial ?? "").trim().toUpperCase();
    if (!serial) return null;
    return {
      serial,
      apelido: String(equipment?.apelido ?? "").trim(),
      cidade: String(equipment?.cidade ?? equipment?.retirada_cidade ?? "").trim(),
    };
  }

  // Valid entries only, one per series (first wins), at most `limit`.
  function sanitizeList(list, limit = LIMIT) {
    const seen = new Set();
    const entries = [];
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
  function pushRecentEquipment(list, equipment, limit = LIMIT) {
    const entry = normalizeEntry(equipment);
    const rest = sanitizeList(list, Infinity);
    if (!entry) return rest.slice(0, limit);
    return [entry, ...rest.filter(item => item.serial !== entry.serial)].slice(0, limit);
  }

  function describeEntry(entry) {
    // Starts with the visible series so speech input matches the button text.
    return [
      entry.serial,
      entry.apelido ? `apelido ${entry.apelido}` : "sem apelido",
      entry.cidade ? `cidade ${entry.cidade}` : "cidade não informada",
    ].join(", ") + ". Abrir resultado";
  }

  // `getStorage` may throw or return null (private mode, blocked storage); the list then lives in memory only.
  function createStore(getStorage, key = STORAGE_KEY) {
    let memory = [];
    const storage = () => {
      try { return getStorage() || null; } catch (error) { return null; }
    };

    function read() {
      const target = storage();
      if (!target) return memory.slice();
      try {
        return sanitizeList(JSON.parse(target.getItem(key) || "[]"));
      } catch (error) {
        return memory.slice();
      }
    }

    function write(list) {
      memory = sanitizeList(list);
      try { storage()?.setItem(key, JSON.stringify(memory)); } catch (error) { /* optional */ }
      return memory.slice();
    }

    return {
      read,
      add: equipment => write(pushRecentEquipment(read(), equipment)),
      clear() {
        memory = [];
        try { storage()?.removeItem(key); } catch (error) { /* optional */ }
        return [];
      },
    };
  }

  return Object.freeze({ STORAGE_KEY, LIMIT, normalizeEntry, sanitizeList, pushRecentEquipment, describeEntry, createStore });
});
