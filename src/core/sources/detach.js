/**
 * Adapter teardown when a source is removed. An OPFS import owns its copies,
 * so they are deleted with the source; a referenced folder only drops the
 * handle and leaves the user's files on disk alone.
 */
export async function detachSource(adapter) {
  if (!adapter) return;
  try {
    if (adapter.trackSource === 'opfs' && typeof adapter.clear === 'function') {
      await adapter.clear();
      return;
    }
    await adapter.forget?.();
  } catch {
    // Detaching is best effort; the removal keeps going without the handle.
  }
}
