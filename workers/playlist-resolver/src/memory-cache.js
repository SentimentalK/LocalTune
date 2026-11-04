// In-memory replacement for the Workers Cache API, for the Node runtime.
// Entries are LRU-ordered by Map insertion and expire after ttlMs.

/**
 * @param {{
 *   maxEntries?: number,
 *   ttlMs?: number,
 *   now?: () => number,
 * }} options
 */
export function createMemoryCache({ maxEntries = 200, ttlMs = 600_000, now = Date.now } = {}) {
  const entries = new Map();

  return {
    async match(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Promote to the most-recently-used position.
      entries.delete(key);
      entries.set(key, entry);
      return new Response(entry.body, {
        status: entry.status,
        statusText: entry.statusText,
        headers: entry.headers,
      });
    },

    async put(key, response) {
      try {
        const body = await response.clone().text();
        entries.delete(key);
        entries.set(key, {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body,
          expiresAt: now() + ttlMs,
        });
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          entries.delete(oldest);
        }
      } catch {
        // Storing is best effort: an unreadable body must not fail the caller.
      }
    },

    get size() {
      return entries.size;
    },
  };
}
