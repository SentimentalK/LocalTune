/**
 * Reference-counted object URLs for cover art. Pure logic: loading, URL
 * creation and revocation are injected so the policy can be tested without a
 * browser. The cache keeps at most `limit` live URLs and never revokes one
 * that the UI still holds a reference to.
 */

export function createCoverCache({
  load,
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
  limit = 64,
} = {}) {
  /** id -> { url, refs, lastUse, pinned } */
  const entries = new Map();
  /** id -> number of acquires waiting for the in-flight load */
  const pendingRefs = new Map();
  /** id -> shared in-flight load promise */
  const pending = new Map();
  let clock = 0;
  let generation = 0;

  function evict(id) {
    const entry = entries.get(id);
    if (!entry || entry.refs > 0) return false;
    entries.delete(id);
    revokeUrl(entry.url);
    return true;
  }

  /** Drop the least recently used unreferenced entries above the limit. */
  function trim() {
    while (entries.size > limit) {
      let victim = null;
      for (const [id, entry] of entries) {
        if (entry.refs !== 0) continue;
        if (!victim || entry.lastUse < victim.lastUse) victim = { id, lastUse: entry.lastUse };
      }
      if (!victim) return;
      evict(victim.id);
    }
  }

  function settle(id, shared) {
    if (pending.get(id) === shared) pending.delete(id);
  }

  function acquire(id) {
    if (!id) return Promise.resolve(null);

    const hit = entries.get(id);
    if (hit) {
      hit.refs += 1;
      hit.lastUse = ++clock;
      return Promise.resolve(hit.url);
    }

    pendingRefs.set(id, (pendingRefs.get(id) ?? 0) + 1);
    let shared = pending.get(id);
    if (!shared) {
      const startedAt = generation;
      shared = (async () => {
        let blob = null;
        try {
          blob = await load(id);
        } catch {
          blob = null;
        }
        const held = pendingRefs.get(id) ?? 0;
        pendingRefs.delete(id);
        settle(id, shared);
        if (!(blob instanceof Blob) || startedAt !== generation || held === 0) return null;
        const url = createUrl(blob);
        if (startedAt !== generation) {
          revokeUrl(url);
          return null;
        }
        entries.set(id, { url, refs: held, lastUse: ++clock, pinned: false });
        trim();
        return url;
      })();
      pending.set(id, shared);
    }
    // `load` failures already resolve null; this keeps unexpected throws local.
    return shared.then((url) => url ?? null);
  }

  function release(id) {
    if (!id) return;
    const entry = entries.get(id);
    if (entry) {
      if (entry.refs > 0) entry.refs -= 1;
      if (entry.refs === 0) {
        if (entry.pinned || entries.size > limit) evict(id);
      }
      return;
    }
    const held = pendingRefs.get(id) ?? 0;
    if (held > 0) pendingRefs.set(id, held - 1);
  }

  function retain(ids) {
    const keep = new Set(ids ?? []);
    for (const id of Array.from(entries.keys())) {
      const entry = entries.get(id);
      entry.pinned = !keep.has(id);
      if (entry.pinned && entry.refs === 0) evict(id);
    }
  }

  function clear() {
    generation += 1;
    for (const [id, entry] of entries) {
      entries.delete(id);
      revokeUrl(entry.url);
    }
    pendingRefs.clear();
    pending.clear();
  }

  return {
    acquire,
    release,
    retain,
    clear,
    get size() {
      return entries.size;
    },
    has: (id) => entries.has(id),
  };
}
